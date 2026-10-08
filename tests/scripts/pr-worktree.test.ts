// flake-shape: real-process-spawn — the subject IS the script's own process
// entry: a real `git` fixture's worktree registry, the real on-disk
// `node_modules` symlink, and the real exit code decide open/close; an
// in-process double restates none of those command boundaries.
/**
 * Tests for scripts/pr-worktree.mjs (#3723).
 *
 * The dangerous half of `close` is the decision — unlink only a symlink,
 * refuse a real directory, never touch the link target — and that decision
 * lives in scripts/lib/pr-worktree.mjs so it is provable without a
 * filesystem. These cases drive BOTH layers: the pure planner directly, and
 * the real CLI entry against a throwaway git fixture (no network; the `gh`
 * lookup is injected through `PI_LENS_GH_JSON`).
 *
 * The close guard is the #3173 / #2704 class: a `git worktree remove` on a
 * symlinked `node_modules` follows the link into the shared install on the
 * platforms where it bites, so `close` unlinks the symlink itself and refuses
 * a real directory rather than deleting it recursively.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	classifyNodeModules,
	deriveClosePlan,
	deriveOpenPlan,
	nestedDestinationError,
	worktreeBranchName,
} from "../../scripts/lib/pr-worktree.mjs";
import { run } from "../../scripts/pr-worktree.mjs";
import { gitFixtureEnv } from "../support/git-fixture-env.js";

const CLI = path.resolve(__dirname, "../../scripts/pr-worktree.mjs");
const GIT = process.platform === "win32" ? "git.exe" : "/usr/bin/git";

const createdRoots: string[] = [];

afterEach(() => {
	for (const dir of createdRoots.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

interface Fixture {
	root: string;
	repo: string;
	origin: string;
	worktreesRoot: string;
	head: string;
	/** Tip of `refs/pull/9002/head`: a commit no branch on origin contains. */
	prOnlyHead: string;
	git: (args: string[], cwd?: string) => string;
}

function makeFixture(): Fixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-pr-worktree-"));
	createdRoots.push(root);
	const repo = path.join(root, "main");
	const origin = path.join(root, "origin.git");
	const worktreesRoot = path.join(root, "worktrees");
	fs.mkdirSync(repo, { recursive: true });
	const git = (args: string[], cwd = repo) =>
		execFileSync(GIT, args, {
			cwd,
			env: gitFixtureEnv(root),
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	git(["init", "-q", "-b", "master"]);
	git(["config", "user.email", "test@example.com"]);
	git(["config", "user.name", "pi-lens test"]);
	fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
	fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules\n");
	git(["add", "."]);
	git(["commit", "-qm", "init"]);
	// The main checkout's shared install, present before any open symlinks it.
	fs.mkdirSync(path.join(repo, "node_modules"), { recursive: true });
	fs.writeFileSync(
		path.join(repo, "node_modules", "shared-sentinel.txt"),
		"shared install\n",
	);
	git(["init", "-q", "--bare", "-b", "master", origin], root);
	git(["remote", "add", "origin", origin]);
	git(["push", "-q", "-u", "origin", "master"]);
	const head = git(["rev-parse", "HEAD"]).trim();
	// GitHub's pull/<n>/{head,merge} refs, mirrored into the throwaway origin
	// so the fetch path is exercised with no network.
	git(["-C", origin, "update-ref", "refs/pull/9001/head", head]);
	git(["-C", origin, "update-ref", "refs/pull/9001/merge", head]);
	// A PR whose head lives ONLY under refs/pull (no branch on origin holds it),
	// as a real PR head does after `open` fetches just `pull/<n>/head`.
	git(["checkout", "-q", "-b", "pr9002"]);
	fs.writeFileSync(path.join(repo, "pr.txt"), "pr only\n");
	git(["add", "pr.txt"]);
	git(["commit", "-qm", "pr only commit"]);
	const prOnlyHead = git(["rev-parse", "HEAD"]).trim();
	git(["push", "-q", "origin", "pr9002:refs/pull/9002/head"]);
	git(["checkout", "-q", "master"]);
	git(["branch", "-q", "-D", "pr9002"]);
	return { root, repo, origin, worktreesRoot, head, prOnlyHead, git };
}

function runCli(
	fixture: Fixture,
	args: string[],
	extraEnv: Record<string, string> = {},
	cwd: string = fixture.repo,
): string {
	return execFileSync(process.execPath, [CLI, ...args], {
		cwd,
		env: {
			...gitFixtureEnv(fixture.root),
			PI_LENS_WORKTREES_ROOT: fixture.worktreesRoot,
			...extraEnv,
		},
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 60_000,
	});
}

function runCliResult(
	fixture: Fixture,
	args: string[],
	extraEnv: Record<string, string> = {},
	cwd: string = fixture.repo,
): { status: number; stdout: string; stderr: string } {
	try {
		return {
			status: 0,
			stdout: runCli(fixture, args, extraEnv, cwd),
			stderr: "",
		};
	} catch (error) {
		const failure = error as {
			status?: number;
			stdout?: string;
			stderr?: string;
		};
		return {
			status: failure.status ?? 1,
			stdout: failure.stdout ?? "",
			stderr: failure.stderr ?? "",
		};
	}
}

const PR_HEAD_JSON = JSON.stringify({
	headRefName: "fix/thing",
	headRepositoryOwner: { login: "apmantza" },
	isCrossRepository: false,
});

/** `gitExec` for `run()`: the real git, pinned to the fixture's env. */
function fixtureGitExec(fixture: Fixture) {
	return (args: string[], options: { cwd?: string } = {}) =>
		execFileSync(GIT, args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			env: gitFixtureEnv(fixture.root),
			...options,
		});
}

function fixtureRun(
	fixture: Fixture,
	argv: string[],
	options: {
		cwd?: string;
		ghExec?: (args: string[]) => string;
		gitExec?: (args: string[], options?: { cwd?: string }) => string;
	} = {},
) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const status = run({
		argv,
		cwd: options.cwd ?? fixture.repo,
		env: {
			...gitFixtureEnv(fixture.root),
			PI_LENS_WORKTREES_ROOT: fixture.worktreesRoot,
		} as NodeJS.ProcessEnv,
		gitExec: options.gitExec ?? fixtureGitExec(fixture),
		ghExec: options.ghExec,
		stdout: (message) => stdout.push(message),
		stderr: (message) => stderr.push(message),
	});
	return { status, stdout, stderr };
}

/**
 * Make the main checkout's `node_modules` a SYMLINK to an outside directory
 * (as a shared install often is), so a close that reaches the main checkout
 * has a link to wrongly unlink.
 */
function linkMainNodeModules(fixture: Fixture): string {
	const shared = path.join(fixture.root, "shared-install");
	fs.mkdirSync(shared, { recursive: true });
	fs.writeFileSync(path.join(shared, "sentinel.txt"), "shared\n");
	const link = path.join(fixture.repo, "node_modules");
	fs.rmSync(link, { recursive: true, force: true });
	fs.symlinkSync(shared, link);
	return shared;
}

function expectLinkIntact(link: string, target: string): void {
	expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
	expect(fs.readlinkSync(link)).toBe(target);
	expect(fs.existsSync(path.join(target, "sentinel.txt"))).toBe(true);
}

/** A tree `open` linked to the fixture's real main install is still linked. */
function expectOpenLinkIntact(worktree: string): void {
	const link = path.join(worktree, "node_modules");
	expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
	expect(fs.existsSync(path.join(link, "shared-sentinel.txt"))).toBe(true);
}

/** A registered worktree at `worktree` whose node_modules links to `target`. */
function addLinkedWorktree(
	fixture: Fixture,
	worktree: string,
	branch: string,
	target: string,
): void {
	fixture.git(["worktree", "add", "-b", branch, worktree]);
	fs.symlinkSync(target, path.join(worktree, "node_modules"));
}

const WORKTREES_ROOT = path.join(path.sep, "trees");
const WT = path.join(WORKTREES_ROOT, "review-1");

function closeInput(
	override: Partial<Parameters<typeof deriveClosePlan>[0]> = {},
) {
	return {
		worktreePath: WT,
		worktreesRoot: WORKTREES_ROOT,
		mainRoot: path.join(path.sep, "main"),
		registered: true,
		dirty: false,
		detachedCommits: [] as string[],
		detachedCheckFailed: false,
		nodeModulesKind: "missing" as const,
		branchExists: true,
		branchUnpushed: false,
		...override,
	};
}

describe("pr-worktree planner (pure)", () => {
	it("classifies a missing, symlinked, and real node_modules distinctly", () => {
		expect(classifyNodeModules(null)).toBe("missing");
		expect(
			classifyNodeModules({
				isSymbolicLink: () => true,
				isDirectory: () => false,
			}),
		).toBe("symlink");
		expect(
			classifyNodeModules({
				isSymbolicLink: () => false,
				isDirectory: () => true,
			}),
		).toBe("directory");
	});

	it("refuses close on a real directory and unlinks only a symlink", () => {
		const refused = deriveClosePlan(
			closeInput({ nodeModulesKind: "directory" }),
		);
		expect(refused.ok).toBe(false);
		const allowed = deriveClosePlan(closeInput({ nodeModulesKind: "symlink" }));
		expect(allowed).toMatchObject({
			ok: true,
			unlinkNodeModules: true,
			branchToDelete: "pr-worktree/review-1",
		});
	});

	// Recurrence: #2704 / #3173 (a close reaching a tree it must never touch)
	// and PR #3730 r1 S1/T2/T3 -- each rail is a distinct refusal, decided
	// BEFORE the CLI performs any unlink.
	it("refuses each close rail with its own reason before anything is unlinked", () => {
		const rails: [string, Partial<ReturnType<typeof closeInput>>, RegExp][] = [
			["unregistered", { registered: false }, /not a registered worktree/],
			["main checkout", { mainRoot: WT }, /main checkout/],
			[
				"outside root",
				{ worktreesRoot: path.join("/other", "root") },
				/outside/,
			],
			["worktrees root itself", { worktreesRoot: WT }, /outside/],
			["parent of the root", { worktreePath: path.sep }, /outside/],
			["dirty", { dirty: true }, /uncommitted|untracked/],
			[
				"detached commits",
				{ detachedCommits: ["abc1234 lost work"] },
				/detached HEAD[^]*abc1234 lost work[^]*git switch -c <name>/,
			],
			[
				"detached check failed",
				{ detachedCheckFailed: true },
				/could not verify/,
			],
		];
		for (const [label, override, reason] of rails) {
			const plan = deriveClosePlan(
				closeInput({ nodeModulesKind: "symlink", ...override }),
			);
			expect(plan.ok, label).toBe(false);
			expect((plan as { error: string }).error, label).toMatch(reason);
		}
	});

	it("keeps a branch with unpushed commits and says so", () => {
		const plan = deriveClosePlan(closeInput({ branchUnpushed: true }));
		expect(plan).toMatchObject({ ok: true, branchToDelete: null });
		expect((plan as { branchKept: string }).branchKept).toContain(
			"pr-worktree/review-1",
		);
		expect(
			deriveClosePlan(closeInput({ branchUnpushed: false })),
		).toMatchObject({ ok: true, branchToDelete: "pr-worktree/review-1" });
	});

	it("derives PR-head, PR-merge, and branch open plans", () => {
		expect(
			deriveOpenPlan({
				target: "9001",
				mode: "head",
				name: null,
				worktreesRoot: "w",
				prHead: { headRefName: "fix/thing" },
			}),
		).toMatchObject({
			ok: true,
			name: "pr-9001-fix-thing",
			branch: "pr-worktree/pr-9001-fix-thing",
			fetchRefspec: "pull/9001/head",
		});
		expect(
			deriveOpenPlan({
				target: "9001",
				mode: "merge",
				name: "review-2",
				worktreesRoot: "w",
			}),
		).toMatchObject({
			ok: true,
			name: "review-2",
			fetchRefspec: "pull/9001/merge",
		});
		expect(
			deriveOpenPlan({
				target: "fix/other",
				mode: null,
				name: null,
				worktreesRoot: "w",
			}),
		).toMatchObject({
			ok: true,
			name: "fix-other",
			branch: null,
			fetchRefspec: null,
			commitish: "fix/other",
		});
		expect(worktreeBranchName(path.join("w", "review-2"))).toBe(
			"pr-worktree/review-2",
		);
	});
});

describe("pr-worktree CLI open", () => {
	it("prints the absolute path, checks out the PR head, and links the shared install", () => {
		const fixture = makeFixture();
		const stdout = runCli(
			fixture,
			["open", "9001", "--head", "--name", "review-1"],
			{ PI_LENS_GH_JSON: PR_HEAD_JSON },
		);
		const worktree = path.join(fixture.worktreesRoot, "review-1");
		expect(stdout.trim()).toBe(worktree);
		expect(fs.existsSync(worktree)).toBe(true);
		const link = path.join(worktree, "node_modules");
		expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
		expect(fs.readlinkSync(link)).toBe(path.join(fixture.repo, "node_modules"));
		expect(
			fixture.git(["show-ref", "--verify", "refs/heads/pr-worktree/review-1"]),
		).toContain("refs/heads/pr-worktree/review-1");
	});

	it("opens a PR merge ref through pull/<n>/merge", () => {
		const fixture = makeFixture();
		const stdout = runCli(
			fixture,
			["open", "9001", "--merge", "--name", "merge-1"],
			{ PI_LENS_GH_JSON: PR_HEAD_JSON },
		);
		const worktree = path.join(fixture.worktreesRoot, "merge-1");
		expect(stdout.trim()).toBe(worktree);
		expect(fs.existsSync(worktree)).toBe(true);
		expect(
			fixture.git(["show-ref", "--verify", "refs/heads/pr-worktree/merge-1"]),
		).toContain("refs/heads/pr-worktree/merge-1");
	});
});

// Recurrence: #3978 / #3981 -- HOME pinned under the source checkout (the
// sanctioned probe-home isolation) made the default review root a directory
// INSIDE that checkout, so a second registered tree doubled test discovery.
describe("pr-worktree nested-destination rail (pure)", () => {
	const refuse = (
		destination: string,
		checkouts: string[],
		pathApi: typeof path = path,
	) =>
		nestedDestinationError({
			destination,
			checkouts,
			mainCheckout: checkouts[0],
			pathApi,
		});

	it("refuses a destination at or inside a checkout and names both plus the override", () => {
		const nested = refuse("/a/main/.probe-home/home/Desktop/wt/r1", [
			"/a/main",
		]);
		expect(nested).toBe(
			"refusing /a/main/.probe-home/home/Desktop/wt/r1: it is at or inside the registered checkout /a/main, " +
				"where test and governance discovery would walk it as part of that checkout; " +
				"set PI_LENS_WORKTREES_ROOT to a directory outside every checkout",
		);
		expect(refuse("/a/main", ["/a/main"])).toContain("PI_LENS_WORKTREES_ROOT");
		expect(refuse("/a/main/..x/r1", ["/a/main"])).not.toBeNull();
	});

	it("refuses when any registered checkout holds the destination", () => {
		expect(refuse("/a/linked/wt/r1", ["/a/main", "/a/linked"])).toContain(
			"/a/linked",
		);
	});

	// Recurrence: PR #3998 review F1 -- equality with a NON-main registered row
	// (a name already open, or registered with its directory gone) read as
	// nested and hid git's own "already exists" / "prune" answer.
	it("refuses equality only against the main checkout, containment against every row", () => {
		expect(refuse("/a/linked", ["/a/main", "/a/linked"])).toBeNull();
		expect(refuse("/a/linked/r1", ["/a/main", "/a/linked"])).toContain(
			"/a/linked",
		);
		expect(refuse("/a/main", ["/a/main", "/a/linked"])).toContain("/a/main");
	});

	it("allows a destination outside every checkout, including a sibling that shares a name prefix", () => {
		expect(refuse("/a/main-worktrees/r1", ["/a/main"])).toBeNull();
		expect(refuse("/a/..x/r1", ["/a/main"])).toBeNull();
		expect(refuse("/a/trees/r2", ["/a/main", "/a/trees/r1"])).toBeNull();
		expect(refuse("/a", ["/a/main"])).toBeNull();
	});

	it("decides win32 paths with win32 semantics", () => {
		const win = path.win32;
		expect(
			refuse("C:\\repo\\.probe-home\\home\\wt\\r1", ["C:\\repo"], win),
		).not.toBeNull();
		expect(refuse("c:\\REPO\\wt\\r1", ["C:\\repo"], win)).not.toBeNull();
		expect(refuse("C:\\repo-wt\\r1", ["C:\\repo"], win)).toBeNull();
		expect(refuse("D:\\wt\\r1", ["C:\\repo"], win)).toBeNull();
	});
});

describe("pr-worktree CLI open nested-destination rail", () => {
	function pinnedHome(home: string): Record<string, string> {
		fs.mkdirSync(home, { recursive: true });
		return { HOME: home, USERPROFILE: home, PI_LENS_WORKTREES_ROOT: "" };
	}

	function openNamed(
		fixture: Fixture,
		env: Record<string, string>,
		name = "review-1",
		cwd = fixture.repo,
	) {
		return runCliResult(fixture, ["open", "9001", "--name", name], env, cwd);
	}

	/** No worktree was registered, no review branch made, and nothing fetched. */
	function expectNothingCreated(fixture: Fixture, registered = 1): void {
		const rows = fixture
			.git(["worktree", "list", "--porcelain"])
			.split("\n")
			.filter((line) => line.startsWith("worktree "));
		expect(rows).toHaveLength(registered);
		expect(fixture.git(["branch", "--list", "pr-worktree/*"]).trim()).toBe("");
		const gitDir = path.join(fixture.repo, ".git");
		expect(fs.existsSync(path.join(gitDir, "FETCH_HEAD"))).toBe(false);
		expect(
			fs.existsSync(path.join(gitDir, "worktrees", "linked", "FETCH_HEAD")),
		).toBe(false);
	}

	it("refuses the default root when HOME is pinned under the source checkout", () => {
		const fixture = makeFixture();
		const home = path.join(fixture.repo, ".probe-home", "home");
		const result = openNamed(fixture, pinnedHome(home));
		const nested = path.join(
			fs.realpathSync(home),
			"Desktop",
			"pi-lens-worktrees",
			"review-1",
		);

		expect(result.status).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain(`refusing ${nested}: `);
		expect(result.stderr).toContain(fs.realpathSync(fixture.repo));
		expect(result.stderr).toContain("PI_LENS_WORKTREES_ROOT");
		expect(fs.existsSync(path.join(home, "Desktop"))).toBe(false);
		expectNothingCreated(fixture);
	});

	it("refuses an explicit root inside the source checkout", () => {
		const fixture = makeFixture();
		const result = openNamed(fixture, {
			PI_LENS_WORKTREES_ROOT: path.join(fixture.repo, "inner", "trees"),
		});

		expect(result.status).toBe(2);
		expect(result.stderr).toContain("PI_LENS_WORKTREES_ROOT");
		expect(fs.existsSync(path.join(fixture.repo, "inner"))).toBe(false);
		expectNothingCreated(fixture);
	});

	it("refuses a destination that is the source checkout itself", () => {
		const fixture = makeFixture();
		const result = openNamed(
			fixture,
			{ PI_LENS_WORKTREES_ROOT: fixture.root },
			"main",
		);

		expect(result.status).toBe(2);
		expect(result.stderr).toContain(fs.realpathSync(fixture.repo));
		expectNothingCreated(fixture);
	});

	it("refuses a HOME that is a symlink into the source checkout", () => {
		const fixture = makeFixture();
		const real = path.join(fixture.repo, ".probe-home", "home");
		fs.mkdirSync(real, { recursive: true });
		const alias = path.join(fixture.root, "home-alias");
		fs.symlinkSync(real, alias, "junction");
		const result = openNamed(fixture, pinnedHome(alias));

		expect(result.status).toBe(2);
		expect(result.stderr).toContain(
			path.join(fs.realpathSync(real), "Desktop", "pi-lens-worktrees"),
		);
		expect(fs.existsSync(path.join(real, "Desktop"))).toBe(false);
		expectNothingCreated(fixture);
	});

	it("refuses when run from a linked worktree whose HOME sits under the main checkout", () => {
		const fixture = makeFixture();
		const linked = path.join(fixture.root, "linked");
		fixture.git(["worktree", "add", "-b", "linked-branch", linked]);
		const home = path.join(fixture.repo, ".probe-home", "home");
		const result = openNamed(fixture, pinnedHome(home), "review-1", linked);

		expect(result.status).toBe(2);
		expect(result.stderr).toContain(fs.realpathSync(fixture.repo));
		expect(fs.existsSync(path.join(home, "Desktop"))).toBe(false);
		expectNothingCreated(fixture, 2);
	});

	// Recurrence: PR #3998 review F1 -- re-opening a registered name exited 2
	// with the "nested" text and steered the worker to the env override instead
	// of git's "already exists" / "prune" answer.
	it("leaves a reopened registered name to git instead of calling it nested", () => {
		const fixture = makeFixture();
		const env = { PI_LENS_WORKTREES_ROOT: fixture.worktreesRoot };
		expect(openNamed(fixture, env, "r1").status).toBe(0);

		const again = openNamed(fixture, env, "r1");
		expect(again.status).toBe(1);
		expect(again.stderr).toContain("failed to create worktree");
		expect(again.stderr).toContain("already exists");
		expect(again.stderr).not.toContain("refusing");
	});

	it("leaves a registered name whose directory is gone to git's prune answer", () => {
		const fixture = makeFixture();
		const env = { PI_LENS_WORKTREES_ROOT: fixture.worktreesRoot };
		expect(openNamed(fixture, env, "r1").status).toBe(0);
		fs.rmSync(path.join(fixture.worktreesRoot, "r1"), {
			recursive: true,
			force: true,
		});

		const again = openNamed(fixture, env, "r1");
		expect(again.status).toBe(1);
		expect(again.stderr).toContain("failed to create worktree");
		expect(again.stderr).not.toContain("refusing");
	});

	// Recurrence: PR #3998 review F2 -- a `bare` row from the registry was judged
	// as a checkout, so the "worktrees inside a bare repository" layout was refused.
	it("opens a destination under a bare repository's directory", () => {
		const fixture = makeFixture();
		const bare = path.join(fixture.root, "bare.git");
		fixture.git(["clone", "-q", "--bare", fixture.origin, bare], fixture.root);
		const linked = path.join(fixture.root, "lw");
		fixture.git(["worktree", "add", linked, "master"], bare);
		const root = path.join(bare, "wts");
		const result = openNamed(
			fixture,
			{ PI_LENS_WORKTREES_ROOT: root },
			"r1",
			linked,
		);

		expect(result.stderr).not.toContain("refusing");
		expect(result.status).toBe(0);
		expect(fs.existsSync(path.join(root, "r1"))).toBe(true);
	});

	it("opens under a default root whose HOME is outside every checkout", () => {
		const fixture = makeFixture();
		const home = path.join(fixture.root, "home");
		const result = openNamed(fixture, pinnedHome(home));
		const worktree = path.join(
			home,
			"Desktop",
			"pi-lens-worktrees",
			"review-1",
		);

		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe(worktree);
		expect(fs.existsSync(worktree)).toBe(true);
	});

	it("opens beside the source when the root only shares its name prefix, and opens a second tree beside the first", () => {
		const fixture = makeFixture();
		const root = path.join(fixture.root, "main-worktrees");
		const env = { PI_LENS_WORKTREES_ROOT: root };

		expect(openNamed(fixture, env, "review-1").status).toBe(0);
		expect(openNamed(fixture, env, "review-2").status).toBe(0);
		expect(fs.existsSync(path.join(root, "review-1"))).toBe(true);
		expect(fs.existsSync(path.join(root, "review-2"))).toBe(true);
	});

	it("judges a relative root against the directory git creates it from, not the caller's cwd", () => {
		const fixture = makeFixture();
		const sub = path.join(fixture.repo, "sub");
		fs.mkdirSync(sub);
		// git runs from the repo root, so ".." is the fixture root (outside the
		// source); resolved from `sub` it would wrongly read as the repo itself.
		const result = openNamed(
			fixture,
			{ PI_LENS_WORKTREES_ROOT: ".." },
			"rel-1",
			sub,
		);

		expect(result.status).toBe(0);
		expect(fs.existsSync(path.join(fixture.root, "rel-1"))).toBe(true);
	});

	// Recurrence: PR #3998 review F3 -- `mkdirSync` resolved a relative root
	// against the process cwd while git and the guard resolve it from the repo
	// root, leaving an empty directory inside the source for a run from a
	// subdirectory.
	it("creates a relative root where git resolves it, not inside the source", () => {
		const fixture = makeFixture();
		const sub = path.join(fixture.repo, "sub");
		fs.mkdirSync(sub);
		const result = openNamed(
			fixture,
			{ PI_LENS_WORKTREES_ROOT: "../root" },
			"rel-2",
			sub,
		);

		expect(result.status).toBe(0);
		expect(fs.existsSync(path.join(fixture.root, "root", "rel-2"))).toBe(true);
		expect(fs.existsSync(path.join(fixture.repo, "root"))).toBe(false);
	});
});

// #4044 (2026-10-07): a lane's `npm ci` emptied the main checkout's shared
// install and the first signal was a worker's complaint a minute later.
// Recurrence these cases catch: an emptied or missing install that `open` (the
// step every lane and review starts with) reports nothing about. The count goes
// to stderr so the path `open` prints on stdout stays machine-readable.
describe("pr-worktree CLI open reports the main install (#4044)", () => {
	const openArgv = ["open", "9001", "--head", "--name", "count-1"];
	const ghExec = () => PR_HEAD_JSON;

	it("prints the entry count on stderr and keeps stdout a bare path", () => {
		const fixture = makeFixture();
		const result = fixtureRun(fixture, openArgv, { ghExec });
		expect(result.status).toBe(0);
		expect(result.stdout).toEqual([
			path.join(fixture.worktreesRoot, "count-1"),
		]);
		expect(result.stderr).toEqual(["main node_modules: 1 entries"]);
	});

	it("warns EMPTY when the install holds nothing but npm's hidden lockfile", () => {
		const fixture = makeFixture();
		const nm = path.join(fixture.repo, "node_modules");
		fs.rmSync(path.join(nm, "shared-sentinel.txt"));
		fs.writeFileSync(path.join(nm, ".package-lock.json"), "{}\n");
		const result = fixtureRun(fixture, openArgv, { ghExec });
		expect(result.status).toBe(0);
		expect(result.stderr.join("\n")).toContain(
			"WARNING: main node_modules is EMPTY",
		);
		expect(result.stderr.join("\n")).toContain("#4044");
	});

	it("says absent when the main checkout has no node_modules at all", () => {
		const fixture = makeFixture();
		fs.rmSync(path.join(fixture.repo, "node_modules"), { recursive: true });
		const result = fixtureRun(fixture, openArgv, { ghExec });
		expect(result.status).toBe(0);
		expect(result.stderr.join("\n")).toContain("main node_modules: absent");
	});
});

describe("pr-worktree CLI close", () => {
	it("unlinks a symlinked node_modules and leaves the link target untouched", () => {
		const fixture = makeFixture();
		const target = path.join(fixture.root, "link-target");
		fs.mkdirSync(path.join(target, "deep"), { recursive: true });
		fs.writeFileSync(path.join(target, "deep", "sentinel.txt"), "keep\n");
		const worktree = path.join(fixture.worktreesRoot, "review-2");
		fixture.git(["worktree", "add", "-b", "pr-worktree/review-2", worktree]);
		fs.symlinkSync(target, path.join(worktree, "node_modules"));

		const result = runCliResult(fixture, ["close", worktree]);

		expect(result.status).toBe(0);
		expect(fs.existsSync(worktree)).toBe(false);
		expect(
			fs.readFileSync(path.join(target, "deep", "sentinel.txt"), "utf8"),
		).toBe("keep\n");
		expect(() =>
			fixture.git(["show-ref", "--verify", "refs/heads/pr-worktree/review-2"]),
		).toThrow();
	});

	it("refuses a real node_modules directory and leaves the worktree registered", () => {
		const fixture = makeFixture();
		const worktree = path.join(fixture.worktreesRoot, "review-3");
		fixture.git(["worktree", "add", "-b", "pr-worktree/review-3", worktree]);
		fs.mkdirSync(path.join(worktree, "node_modules"), { recursive: true });
		fs.writeFileSync(path.join(worktree, "node_modules", "keep.txt"), "copy\n");

		const result = runCliResult(fixture, ["close", worktree]);

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("refusing");
		expect(fs.existsSync(worktree)).toBe(true);
		expect(
			fs.readFileSync(path.join(worktree, "node_modules", "keep.txt"), "utf8"),
		).toBe("copy\n");
		expect(fixture.git(["worktree", "list", "--porcelain"])).toContain(
			path.resolve(worktree),
		);
	});

	it("unlinks node_modules BEFORE git worktree remove (the #3173 ordering guard)", () => {
		const fixture = makeFixture();
		const worktree = path.join(fixture.worktreesRoot, "review-4");
		fixture.git(["worktree", "add", "-b", "pr-worktree/review-4", worktree]);
		fs.symlinkSync(
			path.join(fixture.repo, "node_modules"),
			path.join(worktree, "node_modules"),
		);
		let nodeModulesPresentAtRemove = true;
		const gitExec = (args: string[], options: { cwd?: string } = {}) => {
			if (args[0] === "worktree" && args[1] === "remove") {
				nodeModulesPresentAtRemove = fs.existsSync(
					path.join(worktree, "node_modules"),
				);
			}
			return fixtureGitExec(fixture)(args, options);
		};
		const status = run({
			argv: ["close", worktree],
			cwd: fixture.repo,
			env: {
				...gitFixtureEnv(fixture.root),
				PI_LENS_WORKTREES_ROOT: fixture.worktreesRoot,
			} as NodeJS.ProcessEnv,
			gitExec,
			stdout: () => {},
			stderr: () => {},
		});

		expect(status).toBe(0);
		expect(nodeModulesPresentAtRemove).toBe(false);
	});
});

describe("pr-worktree CLI close rails", () => {
	// Recurrence: PR #3730 r1 S1 -- `close <main>` unlinked the MAIN checkout's
	// own node_modules symlink before git refused, emptying the shared install
	// path the whole tool exists to protect.
	it("refuses the main checkout and leaves its node_modules symlink untouched", () => {
		const fixture = makeFixture();
		const shared = linkMainNodeModules(fixture);
		const result = runCliResult(fixture, ["close", fixture.repo]);
		expectLinkIntact(path.join(fixture.repo, "node_modules"), shared);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("main checkout");
		expect(fs.existsSync(path.join(fixture.repo, "README.md"))).toBe(true);
	});

	// Recurrence: PR #3730 r1 S1 -- any registered worktree anywhere (plegma,
	// .claude/worktrees) was closable; only trees under the review root are ours.
	it("refuses a registered worktree outside the worktrees root", () => {
		const fixture = makeFixture();
		const shared = linkMainNodeModules(fixture);
		const elsewhere = path.join(fixture.root, "elsewhere", "o1");
		addLinkedWorktree(fixture, elsewhere, "pr-worktree/o1", shared);

		const result = runCliResult(fixture, ["close", elsewhere]);

		expectLinkIntact(path.join(elsewhere, "node_modules"), shared);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("outside");
		expect(fixture.git(["worktree", "list", "--porcelain"])).toContain(
			elsewhere,
		);
		expect(
			fixture.git(["show-ref", "--verify", "refs/heads/pr-worktree/o1"]),
		).toContain("pr-worktree/o1");
	});

	// Recurrence: PR #3730 r1 T2 -- the registration check was the only thing
	// stopping `close <any dir>` from unlinking that directory's node_modules
	// symlink, and deleting it left the suite green. The directory sits INSIDE
	// the root so no other rail can be what refuses it.
	it("refuses a directory that is not a registered worktree without unlinking", () => {
		const fixture = makeFixture();
		const shared = linkMainNodeModules(fixture);
		const project = path.join(fixture.worktreesRoot, "someproject");
		fs.mkdirSync(project, { recursive: true });
		fs.symlinkSync(shared, path.join(project, "node_modules"));

		const result = runCliResult(fixture, ["close", project]);

		expectLinkIntact(path.join(project, "node_modules"), shared);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("not a registered worktree");
	});

	// Recurrence: PR #3730 r1 T3 -- a dirty tree had its node_modules unlinked
	// and THEN git refused, leaving a half-closed tree.
	it("refuses a dirty worktree before unlinking node_modules", () => {
		const fixture = makeFixture();
		const shared = linkMainNodeModules(fixture);
		const worktree = path.join(fixture.worktreesRoot, "dirty-1");
		addLinkedWorktree(fixture, worktree, "pr-worktree/dirty-1", shared);
		fs.writeFileSync(path.join(worktree, "scratch.txt"), "uncommitted\n");

		const result = runCliResult(fixture, ["close", worktree]);

		expectLinkIntact(path.join(worktree, "node_modules"), shared);
		expect(result.status).toBe(1);
		expect(result.stderr).toMatch(/uncommitted|untracked/);
		expect(fs.existsSync(path.join(worktree, "scratch.txt"))).toBe(true);
		expect(
			fixture.git(["show-ref", "--verify", "refs/heads/pr-worktree/dirty-1"]),
		).toContain("pr-worktree/dirty-1");
	});

	// Recurrence: PR #3730 verify r2 R12 -- canonicalising the root and the
	// target was untested: a worktrees root reached through a symlink (macOS
	// /tmp, a linked ~/Desktop) must still accept its own trees.
	it("accepts a worktree reached through a symlinked worktrees root", () => {
		const fixture = makeFixture();
		const worktree = path.join(fixture.worktreesRoot, "sym-1");
		fixture.git(["worktree", "add", "-b", "pr-worktree/sym-1", worktree]);
		const linkRoot = path.join(fixture.root, "linked-root");
		fs.symlinkSync(fixture.worktreesRoot, linkRoot);

		const result = runCliResult(
			fixture,
			["close", path.join(linkRoot, "sym-1")],
			{ PI_LENS_WORKTREES_ROOT: linkRoot },
		);

		expect(result.status).toBe(0);
		expect(fs.existsSync(worktree)).toBe(false);
	});

	// Recurrence: PR #3730 r1 S2 -- a relative target resolved against the repo
	// toplevel, not the caller's cwd.
	it("resolves a relative close target against the caller's cwd", () => {
		const fixture = makeFixture();
		const worktree = path.join(fixture.worktreesRoot, "rel-1");
		fixture.git(["worktree", "add", "-b", "pr-worktree/rel-1", worktree]);
		const sub = path.join(fixture.repo, "sub");
		fs.mkdirSync(sub);

		const result = fixtureRun(fixture, ["close", "../../worktrees/rel-1"], {
			cwd: sub,
		});

		expect(result.stderr).toEqual([]);
		expect(result.status).toBe(0);
		expect(fs.existsSync(worktree)).toBe(false);
	});
});

describe("pr-worktree CLI close branch safety", () => {
	function openPrOnly(fixture: Fixture, name: string): string {
		runCli(fixture, ["open", "9002", "--head", "--name", name], {
			PI_LENS_GH_JSON: PR_HEAD_JSON,
		});
		return path.join(fixture.worktreesRoot, name);
	}

	// Recurrence: PR #3730 r1 T3 -- `git branch -D` ran unconditionally, so a
	// trailing commit made in the tree became unreachable (fsck-only).
	it("keeps a branch holding a commit no remote has and prints a hint", () => {
		const fixture = makeFixture();
		const worktree = openPrOnly(fixture, "trail-1");
		fs.writeFileSync(path.join(worktree, "fix.txt"), "trailing\n");
		fixture.git(["add", "fix.txt"], worktree);
		fixture.git(["commit", "-qm", "trailing commit"], worktree);
		const tip = fixture.git(["rev-parse", "HEAD"], worktree).trim();

		const result = fixtureRun(fixture, ["close", worktree]);

		expect(result.status).toBe(0);
		expect(fs.existsSync(worktree)).toBe(false);
		expect(result.stderr.join("\n")).toContain("pr-worktree/trail-1");
		expect(fixture.git(["rev-parse", "pr-worktree/trail-1"]).trim()).toBe(tip);
	});

	// The inverse: a PR head that only ever lived under refs/pull is NOT
	// "unpushed" -- keeping it would leave one stale branch per review.
	it("deletes the branch of an untouched PR-head tree", () => {
		const fixture = makeFixture();
		const worktree = openPrOnly(fixture, "clean-1");
		expect(fixture.git(["rev-parse", "pr-worktree/clean-1"]).trim()).toBe(
			fixture.prOnlyHead,
		);

		const result = fixtureRun(fixture, ["close", worktree]);

		expect(result.status).toBe(0);
		expect(result.stderr).toEqual([]);
		expect(fs.existsSync(worktree)).toBe(false);
		expect(() =>
			fixture.git(["show-ref", "--verify", "refs/heads/pr-worktree/clean-1"]),
		).toThrow();
	});

	// Recurrence: the guard's own failure direction -- if git cannot say whether
	// commits are pushed, the branch must be KEPT (deleting is the irreversible
	// side), never treated as pushed.
	it("keeps the branch when it cannot tell whether commits are pushed", () => {
		const fixture = makeFixture();
		const worktree = openPrOnly(fixture, "unsure-1");
		const gitExec = (args: string[], options: { cwd?: string } = {}) => {
			if (args[0] === "rev-list") throw new Error("simulated rev-list failure");
			return fixtureGitExec(fixture)(args, options);
		};

		const result = fixtureRun(fixture, ["close", worktree], { gitExec });

		expect(result.status).toBe(0);
		expect(fs.existsSync(worktree)).toBe(false);
		expect(fixture.git(["rev-parse", "pr-worktree/unsure-1"]).trim()).toBe(
			fixture.prOnlyHead,
		);
	});

	it("deletes the branch once its trailing commit is on a remote", () => {
		const fixture = makeFixture();
		const worktree = openPrOnly(fixture, "pushed-1");
		fs.writeFileSync(path.join(worktree, "fix.txt"), "trailing\n");
		fixture.git(["add", "fix.txt"], worktree);
		fixture.git(["commit", "-qm", "trailing commit"], worktree);
		fixture.git(
			["push", "-q", "origin", "HEAD:refs/heads/pr9002-fix"],
			worktree,
		);

		const result = runCliResult(fixture, ["close", worktree]);

		expect(result.status).toBe(0);
		expect(() =>
			fixture.git(["show-ref", "--verify", "refs/heads/pr-worktree/pushed-1"]),
		).toThrow();
	});
});

describe("pr-worktree CLI arguments and lookup", () => {
	it("rejects an unknown short flag instead of treating it as a commitish", () => {
		const fixture = makeFixture();
		const calls: string[][] = [];
		const gitExec = (args: string[], options: { cwd?: string } = {}) => {
			calls.push(args);
			return fixtureGitExec(fixture)(args, options);
		};
		const result = fixtureRun(fixture, ["open", "9001", "-x"], { gitExec });
		expect(result.status).toBe(2);
		expect(result.stderr.join("\n")).toContain("unknown option -x");
		expect(calls.filter((args) => args[0] === "worktree")).toEqual([]);
	});

	// Recurrence: PR #3730 r1 S3 -- a numeric open always paid a `gh` round trip
	// (and its network failure mode) even when --merge or --name made the
	// headRefName unused.
	it("calls gh only when the head branch name is needed", () => {
		const fixture = makeFixture();
		const ghCalls: string[][] = [];
		const ghExec = (args: string[]) => {
			ghCalls.push(args);
			return PR_HEAD_JSON;
		};
		expect(
			fixtureRun(fixture, ["open", "9001", "--merge"], { ghExec }).status,
		).toBe(0);
		expect(
			fixtureRun(fixture, ["open", "9001", "--name", "named-1"], { ghExec })
				.status,
		).toBe(0);
		expect(ghCalls).toEqual([]);
		const result = fixtureRun(fixture, ["open", "9001", "--head"], { ghExec });
		expect(result.status).toBe(0);
		expect(ghCalls).toEqual([["pr", "view", "9001", "--json", "headRefName"]]);
	});

	// Fail closed: with no registry to judge against, open must not guess the
	// destination is clear and go on to fetch and add.
	it("stops before the fetch when the worktree registry cannot be read", () => {
		const fixture = makeFixture();
		const calls: string[][] = [];
		const gitExec = (args: string[], options: { cwd?: string } = {}) => {
			calls.push(args);
			if (args[0] === "worktree" && args[1] === "list") {
				throw new Error("registry unreadable");
			}
			return fixtureGitExec(fixture)(args, options);
		};
		const result = fixtureRun(fixture, ["open", "9001", "--name", "r1"], {
			gitExec,
		});
		expect(result.status).toBe(1);
		expect(result.stderr.join("\n")).toContain(
			"failed to list worktrees: registry unreadable",
		);
		expect(calls.map((args) => args[0])).not.toContain("fetch");
		expect(fs.existsSync(path.join(fixture.worktreesRoot, "r1"))).toBe(false);
	});
});

describe("pr-worktree CLI close detached HEAD", () => {
	// Recurrence: PR #3730 verify r2 residual -- close checked only the
	// `pr-worktree/<dir>` branch, so a commit made on a DETACHED HEAD inside the
	// tree (no ref) became unreachable (fsck: 3 objects) with no warning.
	function openDetached(fixture: Fixture, name: string): string {
		runCli(fixture, ["open", "9002", "--head", "--name", name], {
			PI_LENS_GH_JSON: PR_HEAD_JSON,
		});
		const worktree = path.join(fixture.worktreesRoot, name);
		fixture.git(["checkout", "-q", "--detach"], worktree);
		expectOpenLinkIntact(worktree);
		return worktree;
	}

	function unreachable(fixture: Fixture): string[] {
		return fixture
			.git(["fsck", "--unreachable", "--no-reflogs"])
			.split("\n")
			.filter((line) => line.startsWith("unreachable"));
	}

	it("refuses a detached-HEAD commit no remote has and leaves everything in place", () => {
		const fixture = makeFixture();
		const worktree = openDetached(fixture, "det-1");
		fs.writeFileSync(path.join(worktree, "lost.txt"), "detached\n");
		fixture.git(["add", "lost.txt"], worktree);
		fixture.git(["commit", "-qm", "detached work"], worktree);

		const result = fixtureRun(fixture, ["close", worktree]);

		expectOpenLinkIntact(worktree);
		expect(result.status).toBe(1);
		const stderr = result.stderr.join("\n");
		expect(stderr).toContain("detached work");
		expect(stderr).toContain("git switch -c <name>");
		expect(fixture.git(["worktree", "list", "--porcelain"])).toContain(
			worktree,
		);
		expect(unreachable(fixture)).toEqual([]);
	});

	it("closes a detached tree that holds only the PR head it was opened at", () => {
		const fixture = makeFixture();
		const worktree = openDetached(fixture, "det-2");

		const result = fixtureRun(fixture, ["close", worktree]);

		expect(result.stderr).toEqual([]);
		expect(result.status).toBe(0);
		expect(fs.existsSync(worktree)).toBe(false);
	});

	it("closes a detached tree whose commit is on a remote", () => {
		const fixture = makeFixture();
		const worktree = openDetached(fixture, "det-3");
		fs.writeFileSync(path.join(worktree, "kept.txt"), "pushed\n");
		fixture.git(["add", "kept.txt"], worktree);
		fixture.git(["commit", "-qm", "pushed work"], worktree);
		fixture.git(["push", "-q", "origin", "HEAD:refs/heads/det-3"], worktree);

		const result = fixtureRun(fixture, ["close", worktree]);

		expect(result.stderr).toEqual([]);
		expect(result.status).toBe(0);
		expect(fs.existsSync(worktree)).toBe(false);
	});

	it("refuses a detached tree when git cannot list its commits", () => {
		const fixture = makeFixture();
		const worktree = openDetached(fixture, "det-4");
		const gitExec = (args: string[], options: { cwd?: string } = {}) => {
			if (args[0] === "rev-list" && args.includes("HEAD"))
				throw new Error("simulated rev-list failure");
			return fixtureGitExec(fixture)(args, options);
		};

		const result = fixtureRun(fixture, ["close", worktree], { gitExec });

		expectOpenLinkIntact(worktree);
		expect(result.status).toBe(1);
		expect(result.stderr.join("\n")).toContain("could not verify");
		expect(fs.existsSync(worktree)).toBe(true);
	});
});
