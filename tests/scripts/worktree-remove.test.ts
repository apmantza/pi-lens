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
import { spawnSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../../scripts/worktree-remove.mjs";
import { gitExecFileSync } from "../support/git-fixture-env.js";

const SCRIPT = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"scripts",
	"worktree-remove.mjs",
);

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

function makeFixture(ignoreNodeModules = true): Fixture {
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
	writeFileSync(
		join(main, ".gitignore"),
		ignoreNodeModules ? "node_modules\n" : "# nothing ignored\n",
	);
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

	// Recurrence: the unlink is the helper's own step, not git's. With
	// node_modules not ignored, the symlink is an untracked file and plain
	// `git worktree remove` refuses; only the unlink makes the removal pass.
	it("unlinks the symlink itself when git alone would refuse over it", () => {
		const f = makeFixture(false);
		symlinkSync(f.shared, join(f.linked, "node_modules"));
		expect(() => gitIn(f.main, ["worktree", "remove", f.linked])).toThrow();
		expect(registered(f, f.linked)).toBe(true);
		const r = remove([f.linked], f.main);
		expect(r.err).toBe("");
		expect(r.code).toBe(0);
		expect(registered(f, f.linked)).toBe(false);
		expect(readFileSync(join(f.shared, "sentinel.txt"), "utf8")).toBe(
			"shared install\n",
		);
	});

	// Recurrence: PR #5115 review F2 -- the unlink ran before git could refuse a
	// dirty or locked tree, so a refused remove left the lane without its
	// node_modules link. A refused remove must leave the tree as it found it.
	it("leaves the node_modules symlink in place when git refuses a dirty tree", () => {
		const f = makeFixture(false);
		symlinkSync(f.shared, join(f.linked, "node_modules"));
		writeFileSync(join(f.linked, "dirty.txt"), "uncommitted\n");
		const r = remove([f.linked], f.main);
		expect(r.code).toBe(1);
		expect(registered(f, f.linked)).toBe(true);
		expect(lstatSync(join(f.linked, "node_modules")).isSymbolicLink()).toBe(
			true,
		);
		expect(readlinkSync(join(f.linked, "node_modules"))).toBe(f.shared);
	});

	it("leaves the node_modules symlink in place when git refuses a locked tree", () => {
		const f = makeFixture(false);
		symlinkSync(f.shared, join(f.linked, "node_modules"));
		gitIn(f.main, ["worktree", "lock", f.linked]);
		const r = remove([f.linked], f.main);
		expect(r.code).toBe(1);
		expect(registered(f, f.linked)).toBe(true);
		expect(readlinkSync(join(f.linked, "node_modules"))).toBe(f.shared);
	});

	// Recurrence: PR #5115 verify r2 L1 -- the restore must run only for a link
	// the helper unlinked; a refused remove with no node_modules must not try
	// to re-create one (or print a restore failure).
	it("does not attempt a restore when a refused tree had no node_modules", () => {
		const f = makeFixture(false);
		writeFileSync(join(f.linked, "dirty.txt"), "uncommitted\n");
		const r = remove([f.linked], f.main);
		expect(r.code).toBe(1);
		expect(r.err).toContain("failed to remove worktree");
		expect(r.err).not.toContain("restore");
		expect(existsSync(join(f.linked, "node_modules"))).toBe(false);
	});

	// Recurrence: PR #5115 verify r2 L2 -- a restore that fails must say so, or
	// the lane loses its link silently. git's refusal is injected together with
	// a regular file at the link's path, so re-creating the link fails (EEXIST).
	it("reports a failed restore on stderr and still exits 1", () => {
		const f = makeFixture(false);
		const nodeModules = join(f.linked, "node_modules");
		symlinkSync(f.shared, nodeModules);
		const err: string[] = [];
		const code = run({
			argv: [f.linked],
			cwd: f.main,
			gitExec: (args, options) => {
				if (args[0] === "worktree" && args[1] === "remove") {
					writeFileSync(nodeModules, "in the way\n");
					throw new Error("refused");
				}
				return String(
					gitExecFileSync("git", args, {
						cwd: options?.cwd,
						encoding: "utf8",
						stdio: "pipe",
					}),
				);
			},
			stdout: () => {},
			stderr: (m) => err.push(m),
		});
		expect(code).toBe(1);
		expect(err.join("\n")).toContain("failed to restore node_modules");
		expect(err.join("\n")).toContain(f.shared);
	});

	// Recurrence: PR #5115 Greptile G2 -- path.resolve collapsed `..` before the
	// symlink was followed, so `away/lnk/../wt` selected the registered tree at
	// `away/wt` (and --force destroyed its work) instead of the physical
	// `deep/wt` the kernel and git mean (AGENTS.md shape 1).
	it("resolves `..` after a symlink, not before it", () => {
		const f = makeFixture(false);
		const away = join(f.root, "away");
		const deep = join(f.root, "deep");
		mkdirSync(away);
		mkdirSync(join(deep, "sub"), { recursive: true });
		symlinkSync(join(deep, "sub"), join(away, "lnk"));
		const wrong = join(away, "wt");
		const right = join(deep, "wt");
		gitIn(f.main, ["worktree", "add", "-q", "--detach", wrong]);
		gitIn(f.main, ["worktree", "add", "-q", "--detach", right]);
		writeFileSync(join(wrong, "work.txt"), "uncommitted\n");
		const r = remove([`${join(away, "lnk")}/../wt`, "--force"], f.main);
		expect(r.err).toBe("");
		expect(r.code).toBe(0);
		expect(existsSync(right)).toBe(false);
		expect(existsSync(join(wrong, "work.txt"))).toBe(true);
		expect(registered(f, realpathSync(wrong))).toBe(true);
	});

	it("refuses a path that does not exist and says so", () => {
		const f = makeFixture();
		const r = remove([join(f.root, "missing")], f.main);
		expect(r.code).toBe(1);
		expect(r.err).toContain("does not exist");
	});

	// Recurrence: PR #5115 verify r4 F5 -- `"$WT"` with WT unset reached the
	// helper as "", resolved to the cwd and removed the CURRENT linked worktree.
	it.each([[""], ["  "], ["\t"]])(
		"exits 2 with usage for the empty path %j and keeps the tree",
		(arg) => {
			const f = makeFixture();
			const r = remove([arg], f.linked);
			expect(r.code).toBe(2);
			expect(r.err).toContain("usage: node scripts/worktree-remove.mjs");
			expect(registered(f, f.linked)).toBe(true);
			expect(existsSync(f.linked)).toBe(true);
		},
	);

	it("accepts `.` as the current worktree", () => {
		const f = makeFixture();
		const r = remove(["."], f.linked);
		expect(r.code).toBe(0);
		expect(existsSync(f.linked)).toBe(false);
	});

	// Recurrence: PR #5115 verify r4 LOW -- a record must OPEN with `worktree `.
	// A lock reason carrying a fake `worktree <path>` (after a newline, or as a
	// substring that slices to a real path) must not register a plain directory.
	it.each([
		["a newline line", (plain: string) => `x\nworktree ${plain}`],
		["a substring", (plain: string) => `zz${plain}`],
	])("ignores a fake record in a lock reason (%s)", (_name, reason) => {
		const f = makeFixture();
		const plain = join(f.main, "a worktree b");
		mkdirSync(plain);
		gitIn(f.main, ["worktree", "lock", "--reason", reason(plain), f.linked]);
		const r = remove([plain], f.main);
		expect(r.code).toBe(1);
		expect(r.err).toContain("not a registered git worktree");
		expect(existsSync(plain)).toBe(true);
	});

	// Recurrence: PR #5115 Greptile G3 -- a newline-split, trimmed listing could
	// not match a registered path holding a newline or a trailing space.
	it.each([["new\nline"], ["trailing "]])(
		"removes a registered worktree whose name is %j",
		(name) => {
			const f = makeFixture();
			const odd = join(f.root, name);
			gitIn(f.main, ["worktree", "add", "-q", "--detach", odd]);
			const r = remove([odd], f.main);
			expect(r.err).toBe("");
			expect(r.code).toBe(0);
			expect(existsSync(odd)).toBe(false);
		},
	);

	// Recurrence: PR #5115 review F3 -- deleting `if (ENTRY) main()` left every
	// in-process test green while the CLI exited 0 and did nothing.
	it("runs as a CLI: no argument prints usage and exits 2", () => {
		const r = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("usage: node scripts/worktree-remove.mjs");
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
