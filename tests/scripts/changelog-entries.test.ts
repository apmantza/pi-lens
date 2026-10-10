// flake-shape: real-process-spawn — the one-fragment-per-PR check shells out to real `git` for the PR diff; a fixture repo's own git boundary cannot be proven in-process.
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gitExecFileSync } from "../../scripts/lib/git-fixture-env.mjs";
import {
	addedChangelogFragments,
	checkChangelogFragments,
} from "../../scripts/check-changelog-fragments.mjs";
import { parseEntry } from "../../scripts/rollup-changelog.mjs";

const entriesDir = path.resolve(process.cwd(), ".changelog");

describe("changelog entry guard", () => {
	it("validates every checked-in entry file", () => {
		const files = fs
			.readdirSync(entriesDir)
			.filter((name) => name.endsWith(".md") && name !== "README.md");
		for (const file of files)
			expect(() =>
				parseEntry(fs.readFileSync(path.join(entriesDir, file), "utf8"), file),
			).not.toThrow();
	});
});

// #3795 item 2. Recurrence: fold rounds added a second `.changelog/` fragment
// to PRs that already had one (#3774, #3768), against the one-fragment-per-
// change rule. The fast-fail job validated each fragment's shape but never
// counted the PR diff's additions.
describe("one changelog fragment per PR (#3795)", () => {
	const fragment = (bullet: string) =>
		`---\nsection: Fixed\naudience: user\n---\n\n- **${bullet}** — details.\n`;
	let dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
		dirs = [];
	});
	const commit = (dir: string, message: string) => {
		gitExecFileSync(
			[
				"-c",
				"user.email=pi-lens-test@example.com",
				"-c",
				"user.name=pi-lens-test",
				"commit",
				"-qm",
				message,
			],
			{ cwd: dir },
		);
	};
	const makeRepo = () => {
		const dir = fs.mkdtempSync(
			path.join(process.cwd(), ".tmp-changelog-frag-"),
		);
		dirs.push(dir);
		gitExecFileSync(["init", "-q", "-b", "fixture-master"], {
			cwd: dir,
		});
		fs.mkdirSync(path.join(dir, ".changelog"), { recursive: true });
		fs.writeFileSync(
			path.join(dir, ".changelog", "old.md"),
			fragment("released before the branch"),
		);
		gitExecFileSync(["add", "."], { cwd: dir });
		commit(dir, "base");
		return dir;
	};
	const addFragment = (dir: string, name: string, bullet: string) => {
		fs.writeFileSync(path.join(dir, ".changelog", name), fragment(bullet));
		gitExecFileSync(["add", "."], { cwd: dir });
	};
	const gitFor = (dir: string) => (args: string[]) =>
		gitExecFileSync(args, { cwd: dir });

	it("fails and names both when the PR diff adds two fragments", () => {
		const dir = makeRepo();
		addFragment(dir, "pr-a.md", "first change");
		addFragment(dir, "pr-b.md", "second change");
		commit(dir, "head");
		const result = checkChangelogFragments({
			base: "HEAD~1",
			cwd: dir,
			git: gitFor(dir),
		});
		expect(result.valid).toBe(false);
		expect(result.message).toContain(".changelog/pr-a.md");
		expect(result.message).toContain(".changelog/pr-b.md");
	});

	it("accepts a PR diff that adds exactly one fragment", () => {
		const dir = makeRepo();
		addFragment(dir, "pr-a.md", "the only change");
		commit(dir, "head");
		const result = checkChangelogFragments({
			base: "HEAD~1",
			cwd: dir,
			git: gitFor(dir),
		});
		expect(result.valid).toBe(true);
	});

	it("rejects a new user fragment whose plain opening is short", () => {
		const dir = makeRepo();
		fs.writeFileSync(
			path.join(dir, ".changelog", "pr-a.md"),
			`---\nsection: Fixed\naudience: user\n---\n\n- ${"x".repeat(12)}\n`,
		);
		gitExecFileSync(["add", "."], { cwd: dir });
		commit(dir, "head");
		const result = checkChangelogFragments({
			base: "HEAD~1",
			cwd: dir,
			git: gitFor(dir),
		});
		expect(result.valid).toBe(false);
		expect(result.message).toContain(".changelog/pr-a.md");
		expect(result.message).toContain("plain lead length 12");
	});

	it("rejects a new user fragment whose bold lead is 101 characters", () => {
		const dir = makeRepo();
		addFragment(dir, "pr-a.md", "x".repeat(101));
		commit(dir, "head");
		const result = checkChangelogFragments({
			base: "HEAD~1",
			cwd: dir,
			git: gitFor(dir),
		});
		expect(result.valid).toBe(false);
		expect(result.message).toContain("bold lead length 101");
	});

	it("accepts a valid bold entry under an explicit section heading", () => {
		const dir = makeRepo();
		fs.writeFileSync(
			path.join(dir, ".changelog", "pr-a.md"),
			`---\nsection: Fixed\naudience: user\n---\n\n### Fixed\n\n- **short** — details.\n`,
		);
		gitExecFileSync(["add", "."], { cwd: dir });
		commit(dir, "head");
		const result = checkChangelogFragments({
			base: "HEAD~1",
			cwd: dir,
			git: gitFor(dir),
		});
		expect(result.valid).toBe(true);
	});

	it("accepts a new user fragment with a short bold lead", () => {
		const dir = makeRepo();
		addFragment(dir, "pr-a.md", "x".repeat(100));
		commit(dir, "head");
		const result = checkChangelogFragments({
			base: "HEAD~1",
			cwd: dir,
			git: gitFor(dir),
		});
		expect(result.valid).toBe(true);
	});

	it("excludes issue references from the bold lead length", () => {
		const dir = makeRepo();
		addFragment(dir, "pr-a.md", `${"x".repeat(100)} (#2608)`);
		commit(dir, "head");
		const result = checkChangelogFragments({
			base: "HEAD~1",
			cwd: dir,
			git: gitFor(dir),
		});
		expect(result.valid).toBe(true);
	});

	it("does not require a lead for a new internal fragment", () => {
		const dir = makeRepo();
		fs.writeFileSync(
			path.join(dir, ".changelog", "pr-a.md"),
			`---\nsection: Fixed\naudience: internal\n---\n\n- ${"x".repeat(150)}\n`,
		);
		gitExecFileSync(["add", "."], { cwd: dir });
		commit(dir, "head");
		const result = checkChangelogFragments({
			base: "HEAD~1",
			cwd: dir,
			git: gitFor(dir),
		});
		expect(result.valid).toBe(true);
	});

	it("accepts a PR diff that adds no fragment", () => {
		const dir = makeRepo();
		fs.writeFileSync(path.join(dir, "notes.md"), "docs\n");
		gitExecFileSync(["add", "."], { cwd: dir });
		commit(dir, "head");
		const result = checkChangelogFragments({
			base: "HEAD~1",
			cwd: dir,
			git: gitFor(dir),
		});
		expect(result.valid).toBe(true);
	});

	it("counts additions from the merge-base when the named base is ahead", () => {
		const dir = makeRepo();
		const branchPoint = String(
			gitExecFileSync(["rev-parse", "HEAD"], { cwd: dir }),
		).trim();
		fs.writeFileSync(
			path.join(dir, ".changelog", "rollup.md"),
			fragment("already rolled up"),
		);
		gitExecFileSync(["add", "."], { cwd: dir });
		commit(dir, "rollup");
		gitExecFileSync(["branch", "rollup"], { cwd: dir });
		gitExecFileSync(["checkout", "-q", branchPoint], { cwd: dir });
		addFragment(dir, "pr-a.md", "the branch change");
		commit(dir, "head");
		const result = checkChangelogFragments({
			base: "rollup",
			cwd: dir,
			git: gitFor(dir),
		});
		expect(result.valid).toBe(true);
		expect(result.fragments).toEqual([".changelog/pr-a.md"]);
	});

	it("counts fragments written but not yet committed, before push", () => {
		const dir = makeRepo();
		fs.writeFileSync(
			path.join(dir, ".changelog", "pr-a.md"),
			fragment("first change"),
		);
		fs.writeFileSync(
			path.join(dir, ".changelog", "pr-b.md"),
			fragment("second change"),
		);
		const result = checkChangelogFragments({
			base: "HEAD",
			cwd: dir,
			git: gitFor(dir),
		});
		expect(result.valid).toBe(false);
		expect(result.message).toContain(".changelog/pr-a.md");
		expect(result.message).toContain(".changelog/pr-b.md");
	});

	it("runs the default git seam against the repository at cwd", () => {
		const dir = makeRepo();
		fs.writeFileSync(
			path.join(dir, ".changelog", "pr-a.md"),
			fragment("first change"),
		);
		fs.writeFileSync(
			path.join(dir, ".changelog", "pr-b.md"),
			fragment("second change"),
		);
		// No `git` injected: this is the production default seam, which the
		// `--base` CLI path uses and the tests otherwise never touch.
		const result = checkChangelogFragments({
			base: "HEAD",
			cwd: dir,
		});
		expect(result.valid).toBe(false);
		expect(result.message).toContain(".changelog/pr-a.md");
		expect(result.message).toContain(".changelog/pr-b.md");
	});

	const cli = path.resolve(
		process.cwd(),
		"scripts/check-changelog-fragments.mjs",
	);
	const runCli = (args: string[], cwd: string) =>
		spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });
	const usage =
		"usage: node scripts/check-changelog-fragments.mjs [--base <ref> [--head <ref>]] [--cwd <dir>]";

	it("spawns the CLI in a fixture repo and fails closed on its real output", () => {
		const dir = makeRepo();
		addFragment(dir, "pr-a.md", "first change");
		addFragment(dir, "pr-b.md", "second change");
		fs.mkdirSync(path.join(dir, ".changelog", "nested"));
		fs.writeFileSync(
			path.join(dir, ".changelog", "nested", "ignored.md"),
			fragment("not a fragment"),
		);
		fs.writeFileSync(path.join(dir, ".changelog", "ignored.txt"), "ignored\n");
		// An added README is documentation, and a git-ignored scratch file is
		// not part of the change: neither is counted.
		fs.writeFileSync(
			path.join(dir, ".changelog", "README.md"),
			"# Fragments\n",
		);
		fs.writeFileSync(path.join(dir, ".gitignore"), ".changelog/scratch.md\n");
		fs.writeFileSync(
			path.join(dir, ".changelog", "scratch.md"),
			fragment("scratch"),
		);
		const result = runCli(["--base", "HEAD", "--cwd", dir], dir);
		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe(
			"PR diff adds 2 changelog fragments; keep exactly one per PR: .changelog/pr-a.md, .changelog/pr-b.md\n",
		);

		const badBase = runCli(["--base", "deadbeef", "--cwd", dir], dir);
		expect(badBase.status).toBe(1);
		expect(badBase.stderr).toBe(
			"unable to resolve changelog comparison base: deadbeef\n",
		);

		for (const args of [
			["--base", "--cwd", dir],
			["--head", "--cwd", dir],
		]) {
			const misuse = runCli(args, dir);
			expect(misuse.status).toBe(1);
			expect(misuse.stderr.trim().split(/\r?\n/)).toEqual([usage]);
		}
	});

	// Verify r3: an invalid fragment died with an uncaught stack trace. The
	// fast-fail job exists to print one readable line (#1844).
	it("prints one line for an invalid fragment, with or without --base", () => {
		const dir = makeRepo();
		fs.writeFileSync(
			path.join(dir, ".changelog", "pr-a.md"),
			"- no front matter\n",
		);
		for (const args of [
			["--cwd", dir],
			["--base", "HEAD", "--cwd", dir],
		]) {
			const result = runCli(args, dir);
			expect(result.status).toBe(1);
			expect(result.stdout).toBe("");
			const lines = result.stderr.trim().split(/\r?\n/);
			expect(lines).toHaveLength(1);
			expect(lines[0]).toMatch(/^Invalid changelog entry pr-a\.md: /);
		}
	});

	// Verify r3: the CLI's default root (no `--cwd`, as CI and pr-preflight
	// run it) was never exercised, so a wrong repo-root derivation survived.
	// The caller's cwd holds an invalid fragment the checker must not read.
	it("reads the repository's own .changelog when no --cwd is given", () => {
		const dir = makeRepo();
		fs.writeFileSync(
			path.join(dir, ".changelog", "pr-a.md"),
			"- no front matter\n",
		);
		const result = runCli([], dir);
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
		const repoFragments = fs
			.readdirSync(entriesDir)
			.filter((name) => name.endsWith(".md") && name !== "README.md");
		expect(result.stdout).toMatch(/^changelog fragments OK \((\d+) entr/);
		expect(Number(result.stdout.match(/\((\d+) entr/)?.[1])).toBe(
			repoFragments.length,
		);
	});

	// Verify r3 blocker: CI checks out the pull_request merge ref at depth 1
	// and fetches the base sha at depth 1 (ci.yml, Changelog fragment
	// fast-fail), so `git merge-base HEAD <base>` has no shared history and
	// exits 1; r3 failed every PR there. This builds that checkout: a branch
	// cut before a master rollup, merged onto the moved master.
	const mergeRefCheckout = (
		branchFiles: Record<string, string>,
		depth: "depth-1" | "full",
	) => {
		const origin = fs.mkdtempSync(
			path.join(process.cwd(), ".tmp-changelog-origin-"),
		);
		dirs.push(origin);
		const run = (args: string[], cwd = origin) =>
			String(gitExecFileSync(args, { cwd, encoding: "utf8" })).trim();
		const write = (name: string, text: string) => {
			fs.mkdirSync(path.dirname(path.join(origin, name)), { recursive: true });
			fs.writeFileSync(path.join(origin, name), text);
		};
		run(["init", "-q", "-b", "fixture-master"]);
		write(".changelog/old.md", fragment("released before the branch"));
		run(["add", "."]);
		commit(origin, "base");
		const branchPoint = run(["rev-parse", "HEAD"]);
		run(["checkout", "-q", "-b", "fixture-pr"]);
		for (const [name, text] of Object.entries(branchFiles)) write(name, text);
		run(["add", "."]);
		commit(origin, "pr");
		const headSha = run(["rev-parse", "HEAD"]);
		run(["checkout", "-q", "fixture-master"]);
		fs.rmSync(path.join(origin, ".changelog", "old.md"));
		write(".changelog/master-a.md", fragment("merged on master one"));
		write(".changelog/master-b.md", fragment("merged on master two"));
		run(["add", "-A"]);
		commit(origin, "rollup");
		const baseSha = run(["rev-parse", "HEAD"]);
		run(["checkout", "-q", "-b", "fixture-merge"]);
		run([
			"-c",
			"user.email=pi-lens-test@example.com",
			"-c",
			"user.name=pi-lens-test",
			"merge",
			"-q",
			"--no-ff",
			"-m",
			"merge",
			"fixture-pr",
		]);
		const clone = fs.mkdtempSync(
			path.join(process.cwd(), ".tmp-changelog-clone-"),
		);
		dirs.push(clone);
		const depthArgs = depth === "depth-1" ? ["--depth", "1"] : [];
		run([
			"clone",
			"-q",
			...depthArgs,
			"--branch",
			"fixture-merge",
			`file://${origin}`,
			clone,
		]);
		if (depth === "depth-1")
			run(
				["fetch", "-q", "--no-tags", "origin", baseSha, headSha, branchPoint],
				clone,
			);
		return { clone, baseSha, headSha, branchPoint };
	};

	it.each([
		[
			"no fragment",
			{ "notes.md": "docs\n" },
			0,
			"changelog fragments OK (2 entries in .changelog/)\n",
			"",
		],
		[
			"one fragment",
			{ ".changelog/pr-a.md": fragment("change") },
			0,
			"changelog fragments OK (3 entries in .changelog/)\n",
			"",
		],
		[
			"two fragments",
			{
				".changelog/pr-a.md": fragment("one"),
				".changelog/pr-b.md": fragment("two"),
			},
			1,
			"",
			"PR diff adds 2 changelog fragments; keep exactly one per PR: .changelog/pr-a.md, .changelog/pr-b.md\n",
		],
		[
			"README plus one fragment",
			{
				".changelog/README.md": "# Fragments\n",
				".changelog/pr-a.md": fragment("change"),
			},
			0,
			"changelog fragments OK (3 entries in .changelog/)\n",
			"",
		],
	] as const)(
		"counts only the PR's additions in a merged checkout: %s",
		(_state, branchFiles, status, stdout, stderr) => {
			for (const depth of ["depth-1", "full"] as const) {
				const { clone, headSha, branchPoint } = mergeRefCheckout(
					branchFiles,
					depth,
				);
				const headResult = runCli(
					["--base", branchPoint, "--head", headSha, "--cwd", clone],
					clone,
				);
				expect({
					depth,
					status: headResult.status,
					stdout: headResult.stdout,
					stderr: headResult.stderr,
				}).toEqual({ depth, status, stdout, stderr });
			}
		},
		30_000,
	);

	it("prints one line for an invalid fragment in a merged checkout", () => {
		const { clone, branchPoint, headSha } = mergeRefCheckout(
			{ ".changelog/pr-a.md": "- no front matter\n" },
			"depth-1",
		);
		const result = runCli(
			["--base", branchPoint, "--head", headSha, "--cwd", clone],
			clone,
		);
		expect(result.status).toBe(1);
		const lines = result.stderr.trim().split(/\r?\n/);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/^Invalid changelog entry pr-a\.md: /);
	});

	it("returns null when no base ref is available", () => {
		const dir = makeRepo();
		expect(addedChangelogFragments({ git: gitFor(dir), cwd: dir })).toBe(null);
	});
});
