// flake-shape: real-process-spawn — the subject is the helper's decision over
// a real git fixture: the worktree registry, the on-disk node_modules
// symlink-or-directory state and the unlink-before-remove ordering decide the
// run; an in-process double of `git worktree list/remove` restates none of
// them.
/**
 * Tests for scripts/worktree-remove.mjs (#5111).
 *
 * Recurrence: 215 of 456 guard-bash refusals in 14 days (#3995 slice B) were
 * `git worktree remove` over a symlinked `node_modules`, answered with an
 * `rm` and a retry. The helper is that sequence in one step; the dangerous
 * halves are "unlink only the link, never its target" (#3173, #2704) and
 * "refuse a real node_modules directory" (never `rm -rf`).
 */
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../../scripts/worktree-remove.mjs";
import { gitExecFileSync } from "../support/git-fixture-env.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

interface Fixture {
	root: string;
	main: string;
	linked: string;
	/** a directory holding the "shared install" the linked tree's symlink targets */
	shared: string;
}

function makeFixture(): Fixture {
	const root = mkdtempSync(join(tmpdir(), "pi-lens-worktree-remove-"));
	roots.push(root);
	const main = join(root, "main");
	const linked = join(root, "linked");
	const shared = join(main, "node_modules");
	mkdirSync(main);
	const git = (args: string[], cwd = main) =>
		gitExecFileSync("git", args, {
			cwd,
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "pi-lens test",
				GIT_AUTHOR_EMAIL: "test@example.com",
				GIT_COMMITTER_NAME: "pi-lens test",
				GIT_COMMITTER_EMAIL: "test@example.com",
			},
		});
	git(["init", "-q"]);
	writeFileSync(join(main, "README.md"), "fixture\n");
	writeFileSync(join(main, ".gitignore"), "node_modules\n");
	git(["add", "README.md", ".gitignore"]);
	git(["commit", "-q", "-m", "seed"]);
	mkdirSync(shared);
	writeFileSync(join(shared, "sentinel.txt"), "shared install\n");
	git(["worktree", "add", "-q", linked]);
	return { root, main, linked, shared };
}

function gitIn(cwd: string, args: string[]): string {
	return String(
		gitExecFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }),
	);
}

function remove(argv: string[], cwd: string) {
	const out: string[] = [];
	const err: string[] = [];
	const code = run({
		argv,
		cwd,
		gitExec: (args, options) =>
			String(
				gitExecFileSync("git", args, {
					cwd: options?.cwd,
					encoding: "utf8",
					stdio: "pipe",
				}),
			),
		stdout: (m) => out.push(m),
		stderr: (m) => err.push(m),
	});
	return { code, out: out.join("\n"), err: err.join("\n") };
}

function registered(fixture: Fixture, path: string): boolean {
	return gitIn(fixture.main, ["worktree", "list", "--porcelain"])
		.split("\n")
		.some((line) => line === `worktree ${path}`);
}

describe("scripts/worktree-remove.mjs (#5111)", () => {
	it("unlinks a node_modules symlink, leaves its target, removes the worktree", () => {
		const f = makeFixture();
		symlinkSync(f.shared, join(f.linked, "node_modules"));
		const r = remove([f.linked], f.main);
		expect(r.err).toBe("");
		expect(r.code).toBe(0);
		expect(existsSync(f.linked)).toBe(false);
		expect(registered(f, f.linked)).toBe(false);
		// the #3173 harm: the shared install survives the removal
		expect(readFileSync(join(f.shared, "sentinel.txt"), "utf8")).toBe(
			"shared install\n",
		);
	});

	it("refuses a real node_modules directory and removes nothing", () => {
		const f = makeFixture();
		mkdirSync(join(f.linked, "node_modules"));
		writeFileSync(join(f.linked, "node_modules", "own.txt"), "own copy\n");
		const r = remove([f.linked], f.main);
		expect(r.code).toBe(1);
		expect(r.err).toContain("real directory");
		expect(registered(f, f.linked)).toBe(true);
		expect(
			readFileSync(join(f.linked, "node_modules", "own.txt"), "utf8"),
		).toBe("own copy\n");
	});

	it("removes a worktree that has no node_modules", () => {
		const f = makeFixture();
		const r = remove([f.linked], f.main);
		expect(r.code).toBe(0);
		expect(existsSync(f.linked)).toBe(false);
	});

	it("resolves a relative path against the caller's cwd", () => {
		const f = makeFixture();
		symlinkSync(f.shared, join(f.linked, "node_modules"));
		const r = remove(["../linked"], f.main);
		expect(r.code).toBe(0);
		expect(existsSync(f.linked)).toBe(false);
	});

	it("refuses the main checkout", () => {
		const f = makeFixture();
		const r = remove([f.main], f.linked);
		expect(r.code).toBe(1);
		expect(r.err).toContain("main checkout");
		expect(existsSync(join(f.main, ".git"))).toBe(true);
		expect(readFileSync(join(f.shared, "sentinel.txt"), "utf8")).toBe(
			"shared install\n",
		);
	});

	it("refuses a plain directory inside the repo and one outside any repo", () => {
		const f = makeFixture();
		const inside = join(f.main, "sub");
		mkdirSync(inside);
		const outside = join(f.root, "plain");
		mkdirSync(outside);
		const a = remove([inside], f.main);
		expect(a.code).toBe(1);
		expect(a.err).toContain("not a registered git worktree");
		const b = remove([outside], f.main);
		expect(b.code).toBe(1);
		expect(existsSync(inside)).toBe(true);
		expect(existsSync(outside)).toBe(true);
	});

	it("passes --force to git only when the caller does", () => {
		const f = makeFixture();
		writeFileSync(join(f.linked, "dirty.txt"), "uncommitted\n");
		const refused = remove([f.linked], f.main);
		expect(refused.code).toBe(1);
		expect(registered(f, f.linked)).toBe(true);
		const forced = remove([f.linked, "--force"], f.main);
		expect(forced.code).toBe(0);
		expect(existsSync(f.linked)).toBe(false);
	});

	it("never unlinks the symlink when a refusal comes before it (main checkout)", () => {
		const f = makeFixture();
		// a symlink in the MAIN checkout's own tree must survive a refused call
		const decoy = join(f.root, "decoy");
		mkdirSync(decoy);
		rmSync(f.shared, { recursive: true });
		symlinkSync(decoy, f.shared);
		const r = remove([f.main], f.main);
		expect(r.code).toBe(1);
		expect(lstatSync(f.shared).isSymbolicLink()).toBe(true);
	});

	it.each([
		[[]],
		[["a", "b"]],
		[["--force"]],
		[["a", "--forcee"]],
		[["-f", "a"]],
	])("exits 2 with usage for argv %j", (argv) => {
		const f = makeFixture();
		const r = remove(argv, f.main);
		expect(r.code).toBe(2);
		expect(r.err).toContain("usage: node scripts/worktree-remove.mjs");
	});
});
