/**
 * #4941: the commit gate judges the working tree being committed.
 *
 * RECURRENCE GUARDED (file level): the gate's blocker state was one
 * process-wide latch (`_gitGuardHasBlockers`, `_gitGuardSummary`) beside two
 * more process-wide latches (`_gitGuardCacheUnknownReason`,
 * `_gitGuardUnansweredDispatches`) and a scan of every record's suppression
 * verdict, so a commit in repository B was refused for a blocker, a stored
 * record or an unanswered dispatch in repository A (census C3, tier 2:
 * `tests/index-4941-commit-gate-by-repo.test.ts`). These cases pin each reader
 * and, in `resolveCommitScope`, the one question that decides which tree a
 * command targets, with a real `RuntimeCoordinator` and git checkouts.
 * A form the scope does not read must judge EVERY blocker
 * (AGENTS.md: gates fail closed), so most rows below are refusals to scope.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import { getRecentLoggedPhases } from "../../clients/latency-logger.js";
import {
	evaluateGitGuard,
	resolveCommitScope,
} from "../../clients/git-guard.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { setupTestEnvironment } from "./test-utils.js";

/**
 * A git checkout (real path) holding `src/<name>.ts` for each name. Only the
 * `.git/HEAD` marker `resolveGitCheckout` reads is written: the gate reads
 * files and spawns nothing, so neither does the fixture.
 */
function repo(root: string, name: string, files: string[] = ["a"]): string {
	const dir = path.join(fs.realpathSync.native(root), name);
	fs.mkdirSync(path.join(dir, "src"), { recursive: true });
	for (const file of files) {
		fs.writeFileSync(
			path.join(dir, "src", `${file}.ts`),
			"export const x = 1;\n",
		);
	}
	fs.mkdirSync(path.join(dir, ".git"));
	fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
	return dir;
}

/** A linked worktree of `main`, laid out as `git worktree add` leaves it. */
function linkedWorktree(main: string, at: string): string {
	const admin = path.join(main, ".git", "worktrees", path.basename(at));
	fs.mkdirSync(admin, { recursive: true });
	fs.writeFileSync(path.join(admin, "HEAD"), "ref: refs/heads/linked\n");
	fs.writeFileSync(path.join(admin, "commondir"), "../..\n");
	fs.mkdirSync(path.join(at, "src"), { recursive: true });
	fs.writeFileSync(path.join(at, "src", "a.ts"), "export const x = 1;\n");
	fs.writeFileSync(path.join(at, ".git"), `gitdir: ${admin}\n`);
	return at;
}

const COMMIT = { toolName: "bash", input: { command: "git commit -m wip" } };

function commit(command: string) {
	return { toolName: "bash", input: { command } };
}

/** The blocker a write records, with the verdict `tool_result` latches. */
function blockerIn(runtime: RuntimeCoordinator, file: string, summary: string) {
	const bytes = fs.readFileSync(file);
	runtime.recordInlineBlockers(file, summary, undefined, ["tsc"], [1], {
		size: bytes.byteLength,
		sha256: createHash("sha256").update(bytes).digest("hex"),
	});
	runtime.updateGitGuardStatus(true, summary, file);
}

function verdictOf(
	runtime: RuntimeCoordinator,
	cwd: string,
	invocation: { toolName: string; input: unknown } | undefined,
) {
	return evaluateGitGuard(
		runtime,
		new CacheManager(false),
		cwd,
		"pi",
		undefined,
		invocation,
	);
}

describe("#4941: the commit gate's blocker state is read per working tree", () => {
	it("refuses a commit in the repository with the blocker, names its summary, and allows another repository", () => {
		// RECURRENCE GUARDED: #4941: the latch refused repository B for A's blocker.
		const env = setupTestEnvironment("pi-lens-4941-latch-");
		try {
			const repoA = repo(env.tmpDir, "a");
			const repoB = repo(env.tmpDir, "b");
			const runtime = new RuntimeCoordinator();
			blockerIn(runtime, path.join(repoA, "src", "a.ts"), "blocker in A");
			const inA = verdictOf(runtime, repoA, COMMIT);
			expect(inA.block).toBe(true);
			expect(inA.reason).toContain("blocker in A");
			// The decision row says whether the refusal was this tree's own.
			expect(getRecentLoggedPhases(1)[0]?.metadata).toMatchObject({
				decision: "blocked",
				reasonCategory: "runtime_blockers",
				scoped: true,
			});
			expect(verdictOf(runtime, repoB, COMMIT)).toEqual({ block: false });
			// A form the scope does not read is judged by every blocker.
			expect(verdictOf(runtime, repoB, undefined).block).toBe(true);
			expect(getRecentLoggedPhases(1)[0]?.metadata).toMatchObject({
				decision: "blocked",
				reasonCategory: "runtime_blockers",
				scoped: false,
			});
		} finally {
			env.cleanup();
		}
	});

	it("names only the committed repository's blocker when both hold one", () => {
		// RECURRENCE GUARDED: #4941: the refusal's summary named a foreign file.
		const env = setupTestEnvironment("pi-lens-4941-summary-");
		try {
			const repoA = repo(env.tmpDir, "a");
			const repoB = repo(env.tmpDir, "b");
			const runtime = new RuntimeCoordinator();
			blockerIn(runtime, path.join(repoA, "src", "a.ts"), "blocker in A");
			blockerIn(runtime, path.join(repoB, "src", "a.ts"), "blocker in B");
			const inB = verdictOf(runtime, repoB, COMMIT);
			expect(inB.reason).toContain("blocker in B");
			expect(inB.reason).not.toContain("blocker in A");
		} finally {
			env.cleanup();
		}
	});

	it("scopes a retargeted commit (git -C) to the repository it names", () => {
		// RECURRENCE GUARDED: #4941: keying by the session's cwd would let
		// `git -C <repo-with-blocker> commit` run from a clean repository.
		const env = setupTestEnvironment("pi-lens-4941-dash-c-");
		try {
			const repoA = repo(env.tmpDir, "a");
			const repoB = repo(env.tmpDir, "b");
			const runtime = new RuntimeCoordinator();
			blockerIn(runtime, path.join(repoA, "src", "a.ts"), "blocker in A");
			expect(
				verdictOf(runtime, repoB, commit(`git -C ${repoA} commit -m wip`))
					.block,
			).toBe(true);
			expect(
				verdictOf(runtime, repoA, commit(`git -C ${repoB} commit -m wip`)),
			).toEqual({ block: false });
		} finally {
			env.cleanup();
		}
	});

	it("scopes a verdict that names its file, and keeps one that names none a blocker for every tree", () => {
		// RECURRENCE GUARDED: #4941: the latest write's own verdict
		// (`updateGitGuardStatus(true, …)`) is counted beside the records. One
		// that names its file belongs to that file's tree; one that names none
		// (a fail-closed default for a caller that cannot say) belongs to no
		// tree to exclude, whichever directory the command targets.
		const env = setupTestEnvironment("pi-lens-4941-verdict-");
		try {
			const repoA = repo(env.tmpDir, "a");
			const repoB = repo(env.tmpDir, "b");
			const named = new RuntimeCoordinator();
			named.updateGitGuardStatus(
				true,
				"verdict in A",
				path.join(repoA, "src", "a.ts"),
			);
			expect(verdictOf(named, repoA, COMMIT).block).toBe(true);
			expect(verdictOf(named, repoB, COMMIT)).toEqual({ block: false });
			const unnamed = new RuntimeCoordinator();
			unnamed.updateGitGuardStatus(true, "a verdict with no file");
			expect(verdictOf(unnamed, repoB, COMMIT).block).toBe(true);
			expect(
				verdictOf(unnamed, repoA, commit(`git -C ${repoB} commit -m wip`))
					.block,
			).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("scopes a stale suppression verdict to its own repository", () => {
		// RECURRENCE GUARDED: #4941: `firstExpiredSuppressionVerdict` scanned
		// every record, so A's moved-on suppression refused B's commit.
		const env = setupTestEnvironment("pi-lens-4941-stale-");
		try {
			const repoA = repo(env.tmpDir, "a");
			const repoB = repo(env.tmpDir, "b");
			const runtime = new RuntimeCoordinator();
			const file = path.join(repoA, "src", "a.ts");
			blockerIn(runtime, file, "blocker in A");
			runtime.applyInlineBlockerPolicyVerdicts([file]);
			runtime.updateGitGuardStatus(false, "");
			fs.writeFileSync(file, "export const x = 2;\n");
			const inA = verdictOf(runtime, repoA, COMMIT);
			expect(inA.block).toBe(true);
			expect(inA.reason).toContain("inline_policy_stale");
			expect(verdictOf(runtime, repoB, COMMIT)).toEqual({ block: false });
		} finally {
			env.cleanup();
		}
	});

	it("scopes a dispatch that never answered to its own repository", () => {
		// RECURRENCE GUARDED: #4941: `gitGuardUnansweredDispatches.find` read
		// the whole process, so A's crashed dispatch refused B's commit.
		const env = setupTestEnvironment("pi-lens-4941-unanswered-");
		try {
			const repoA = repo(env.tmpDir, "a");
			const repoB = repo(env.tmpDir, "b");
			const runtime = new RuntimeCoordinator();
			runtime.markGitGuardDispatchUnanswered(
				path.join(repoA, "src", "a.ts"),
				"pipeline_crash",
			);
			const inA = verdictOf(runtime, repoA, COMMIT);
			expect(inA.block).toBe(true);
			expect(inA.reason).toContain("pipeline_crash");
			expect(verdictOf(runtime, repoB, COMMIT)).toEqual({ block: false });
		} finally {
			env.cleanup();
		}
	});

	it("scopes a latched record failure to the project it is about", () => {
		// RECURRENCE GUARDED: #4941: `gitGuardCacheUnknownReason` was one slot
		// for the process, so A's failed record write refused B's commit.
		const env = setupTestEnvironment("pi-lens-4941-cache-unknown-");
		try {
			const repoA = repo(env.tmpDir, "a");
			const repoB = repo(env.tmpDir, "b");
			const runtime = new RuntimeCoordinator();
			runtime.markGitGuardCacheUnknown("cache_write_failed", repoA);
			expect(verdictOf(runtime, repoA, COMMIT).block).toBe(true);
			expect(verdictOf(runtime, repoB, COMMIT)).toEqual({ block: false });
			// A form the scope does not read is judged by every project's reason.
			expect(
				verdictOf(runtime, repoB, commit(`cd ${repoA} && git commit -m wip`))
					.block,
			).toBe(true);
			expect(
				verdictOf(runtime, repoB, commit(`git -C ${repoA} commit -m wip`))
					.block,
			).toBe(true);
		} finally {
			env.cleanup();
		}
	});
});

describe("#4941 r2: the record-failure latch is one record per repository", () => {
	it("counts a latch about a project outside every checkout for each repository's commit", () => {
		// RECURRENCE GUARDED: #4941 r2 (CodeRabbit): a latch about a workspace
		// root that is no checkout was "not in" either repository below it, so
		// both scoped commits skipped it and the missing record let them through.
		const env = setupTestEnvironment("pi-lens-4941-latch-unplaced-");
		try {
			const repoA = repo(env.tmpDir, "a");
			const repoB = repo(env.tmpDir, "b");
			const workspace = fs.realpathSync.native(env.tmpDir);
			const runtime = new RuntimeCoordinator();
			runtime.markGitGuardCacheUnknown("cache_write_failed", workspace);
			expect(verdictOf(runtime, repoA, COMMIT).block).toBe(true);
			expect(
				verdictOf(runtime, repoA, commit(`git -C ${repoB} commit -m wip`))
					.block,
			).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("keeps repository A's latched record failure when only B's record is marked or cleared", () => {
		// RECURRENCE GUARDED: #4941 r2 F1: the read was scoped but the store was
		// one slot, so B's failed write replaced A's uncertainty and any
		// repository's successful write cleared it; a commit in A then went from
		// refused to allowed with A's record still unconfirmed.
		const env = setupTestEnvironment("pi-lens-4941-latch-store-");
		try {
			const repoA = repo(env.tmpDir, "a");
			const repoB = repo(env.tmpDir, "b");
			const runtime = new RuntimeCoordinator();
			runtime.markGitGuardCacheUnknown("cache_write_failed", repoA);
			runtime.markGitGuardCacheUnknown("cache_corrupt", repoB);
			expect(verdictOf(runtime, repoA, COMMIT).block).toBe(true);
			expect(verdictOf(runtime, repoB, COMMIT).block).toBe(true);
			runtime.clearGitGuardCacheUnknown(repoB);
			expect(verdictOf(runtime, repoA, COMMIT).block).toBe(true);
			expect(verdictOf(runtime, repoB, COMMIT)).toEqual({ block: false });
			runtime.clearGitGuardCacheUnknown(repoA);
			expect(verdictOf(runtime, repoA, COMMIT)).toEqual({ block: false });
			// A record about one project replaces only that project's reason.
			runtime.markGitGuardCacheUnknown("cache_write_failed", repoA);
			runtime.markGitGuardCacheUnknown("cache_stale", repoA);
			expect(runtime.gitGuardCacheUnknownFor()).toBe("cache_stale");
			runtime.clearGitGuardCacheUnknown(repoA);
			expect(runtime.gitGuardCacheUnknownFor()).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});
});

describe("#4941: resolveCommitScope reads only forms it can place in a tree", () => {
	function scopeOf(command: string, cwd: string) {
		return resolveCommitScope("bash", { command }, cwd);
	}

	it("places a plain commit, push or chained commit in the repository of the cwd", () => {
		const env = setupTestEnvironment("pi-lens-4941-scope-plain-");
		try {
			const repoA = repo(env.tmpDir, "a");
			const repoB = repo(env.tmpDir, "b");
			const inA = path.join(repoA, "src", "a.ts");
			const inB = path.join(repoB, "src", "a.ts");
			for (const command of [
				"git commit -m wip",
				"git push origin main",
				'git commit -m "wip"; echo done',
				"git add -A && git commit -m wip",
				"git status\ngit commit -m wip",
				`git commit -m "$(cat <<'EOF'\nmessage\nEOF\n)"`,
			]) {
				const scope = scopeOf(command, repoA);
				expect(scope?.contains(inA), command).toBe(true);
				expect(scope?.contains(inB), command).toBe(false);
			}
		} finally {
			env.cleanup();
		}
	});

	it("places the directory a git -C names, and a subdirectory in its repository", () => {
		const env = setupTestEnvironment("pi-lens-4941-scope-c-");
		try {
			const repoA = repo(env.tmpDir, "a");
			const repoB = repo(env.tmpDir, "b");
			const viaDashC = scopeOf(`git -C ${repoB} commit -m wip`, repoA);
			expect(viaDashC?.contains(path.join(repoB, "src", "a.ts"))).toBe(true);
			expect(viaDashC?.contains(path.join(repoA, "src", "a.ts"))).toBe(false);
			const relative = scopeOf("git -C ../b commit -m wip", repoA);
			expect(relative?.contains(path.join(repoB, "src", "a.ts"))).toBe(true);
			const fromSubdirectory = scopeOf(
				"git commit -m wip",
				path.join(repoA, "src"),
			);
			expect(fromSubdirectory?.contains(path.join(repoA, "src", "a.ts"))).toBe(
				true,
			);
			// A file that no longer exists still belongs to the tree above it.
			expect(
				fromSubdirectory?.contains(
					path.join(repoA, "src", "deleted", "gone.ts"),
				),
			).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("leaves every other form unscoped, so the gate judges every blocker", () => {
		// RECURRENCE GUARDED: #4941's fail-closed side. Each row moves the
		// commit's directory or environment, or hides where it goes, in a way a
		// scope read from the cwd would miss: `cd B && git commit` from a clean
		// repository would commit over B's blocker. #5638: `git rev-parse
		// --show-toplevel` names the work tree, not the repository whose git dir
		// the commit lands in, so the `--git-dir`, `GIT_DIR` and `--work-tree`
		// rows must stay unscoped: a scope taken from rev-parse would exempt the
		// repository committed into.
		const env = setupTestEnvironment("pi-lens-4941-scope-open-");
		try {
			const repoA = repo(env.tmpDir, "a");
			const repoB = repo(env.tmpDir, "b");
			const notARepo = path.join(fs.realpathSync.native(env.tmpDir), "plain");
			fs.mkdirSync(notARepo, { recursive: true });
			for (const command of [
				`cd ${repoB} && git commit -m wip`,
				`(cd ${repoB}; git commit -m wip)`,
				`pushd ${repoB} && git commit -m wip`,
				`export GIT_DIR=${repoB}/.git; git commit -m wip`,
				`GIT_DIR=${repoB}/.git git commit -m wip`,
				`git --git-dir=${repoB}/.git commit -m wip`,
				`git --git-dir ${repoB}/.git commit -m wip`,
				`git --work-tree=${repoB} commit -m wip`,
				`git -c core.worktree=${repoB} commit -m wip`,
				`git -C${repoB} commit -m wip`,
				'git -C "$target" commit -m wip',
				"git -C ~/nowhere commit -m wip",
				`git -C ${path.join(repoB, "missing")} commit -m wip`,
				"npm test && git commit -m wip",
				"git commit -m wip 2>&1 | tail -3",
				'bash -c "git commit -m wip"',
				"xargs git commit -m wip",
				"env FOO=1 git commit -m wip",
				`git commit -m "$(cd ${repoB} && git commit -m inner)"`,
				"$GIT commit -m wip",
				"git status",
				"echo hello",
			]) {
				expect(scopeOf(command, repoA), command).toBeUndefined();
			}
			expect(scopeOf("git commit -m wip", notARepo)).toBeUndefined();
			// A target a stat fails on (ELOOP here; EACCES likewise, but only for a
			// non-root user) is unscoped, not a throw that skips the gate
			// (CodeRabbit on #4952: `statSync` throws for all but ENOENT).
			const loop = path.join(fs.realpathSync.native(env.tmpDir), "loop");
			fs.symlinkSync(`${loop}-b`, loop);
			fs.symlinkSync(loop, `${loop}-b`);
			expect(scopeOf(`git -C ${loop} commit -m wip`, repoA)).toBeUndefined();
			// One target in a tree and one not: the scope cannot name both.
			expect(
				scopeOf(`git -C ${notARepo} commit -m wip; git commit -m wip`, repoA),
			).toBeUndefined();
			expect(
				resolveCommitScope("write", { command: "git commit" }, repoA),
			).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("counts a checkout nested inside the committed tree, but not a linked worktree of it", () => {
		// RECURRENCE GUARDED: #4941 r2 F2: a blocker under `A/vendor/lib` whose
		// nearest `.git` is a nested checkout resolved to that nested root, so
		// the commit in A (which stages the same bytes when the file is tracked)
		// was allowed with the blocker live.
		const env = setupTestEnvironment("pi-lens-4941-scope-nested-");
		try {
			const main = repo(env.tmpDir, "main");
			const nested = repo(main, path.join("vendor", "lib"));
			const linked = linkedWorktree(
				main,
				path.join(main, ".claude", "worktrees", "w1"),
			);
			const fromMain = scopeOf("git commit -m wip", main);
			expect(fromMain?.contains(path.join(nested, "src", "a.ts"))).toBe(true);
			expect(fromMain?.contains(path.join(linked, "src", "a.ts"))).toBe(false);
			// The nested checkout's own commit does not count its parent's files.
			const fromNested = scopeOf("git commit -m wip", nested);
			expect(fromNested?.contains(path.join(main, "src", "a.ts"))).toBe(false);
			const runtime = new RuntimeCoordinator();
			blockerIn(runtime, path.join(nested, "src", "a.ts"), "nested blocker");
			expect(verdictOf(runtime, main, COMMIT).block).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("leaves a command unscoped when the process environment retargets git", () => {
		// RECURRENCE GUARDED: #4941 r2 F3: an inherited GIT_DIR or GIT_WORK_TREE
		// moves git without appearing in the command, so a scope read from the
		// cwd named the wrong tree and exempted the blockers of the tree git
		// committed into.
		const env = setupTestEnvironment("pi-lens-4941-scope-env-");
		try {
			const repoA = repo(env.tmpDir, "a");
			const repoB = repo(env.tmpDir, "b");
			expect(scopeOf("git commit -m wip", repoB)).toBeDefined();
			for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"]) {
				vi.stubEnv(name, name === "GIT_DIR" ? `${repoA}/.git` : repoA);
				try {
					expect(scopeOf("git commit -m wip", repoB), name).toBeUndefined();
				} finally {
					vi.unstubAllEnvs();
				}
			}
			vi.stubEnv("GIT_DIR", "");
			try {
				expect(scopeOf("git commit -m wip", repoB)).toBeDefined();
			} finally {
				vi.unstubAllEnvs();
			}
		} finally {
			env.cleanup();
		}
	});

	it("trusts only a bare git or a known system path as the git executable", () => {
		// RECURRENCE GUARDED: #4941 r2 F4: any path whose basename was `git`
		// (`/tmp/evil/git`, `./git`, `git.cmd`) was scoped by the cwd, though a
		// wrapper under that name can retarget before it execs git.
		const env = setupTestEnvironment("pi-lens-4941-scope-exe-");
		try {
			const repoA = repo(env.tmpDir, "a");
			for (const command of [
				"git commit -m wip",
				"/usr/bin/git commit -m wip",
				"/usr/local/bin/git push",
			]) {
				expect(scopeOf(command, repoA), command).toBeDefined();
			}
			for (const command of [
				"/tmp/evil/git commit -m wip",
				"./git commit -m wip",
				"git.cmd commit -m wip",
				"~/bin/git commit -m wip",
				`${repoA}/git commit -m wip`,
			]) {
				expect(scopeOf(command, repoA), command).toBeUndefined();
			}
		} finally {
			env.cleanup();
		}
	});

	it("leaves a tilde operand of -C unscoped, even when a directory of that literal name exists", () => {
		// RECURRENCE GUARDED: #4941 r2 F5: bash expands `~` to $HOME, while the
		// scope resolved the literal `<cwd>/~/r` and named that tree.
		const env = setupTestEnvironment("pi-lens-4941-scope-tilde-");
		try {
			repo(env.tmpDir, path.join("~", "r"));
			const cwd = fs.realpathSync.native(env.tmpDir);
			expect(scopeOf("git -C ~/r commit -m wip", cwd)).toBeUndefined();
			expect(scopeOf("git -C ./~/r commit -m wip", cwd)).toBeDefined();
		} finally {
			env.cleanup();
		}
	});

	it("tells a linked worktree from the checkout it sits in", () => {
		// RECURRENCE GUARDED: #4941: this repository keeps agent worktrees under
		// `.claude/worktrees/`, a path inside the main checkout that shares no
		// working file with it; containment would gate the wrong tree.
		const env = setupTestEnvironment("pi-lens-4941-scope-worktree-");
		try {
			const main = repo(env.tmpDir, "main");
			const linked = linkedWorktree(
				main,
				path.join(main, ".claude", "worktrees", "w1"),
			);
			const inMain = path.join(main, "src", "a.ts");
			const inLinked = path.join(linked, "src", "a.ts");
			const fromLinked = scopeOf("git commit -m wip", linked);
			expect(fromLinked?.contains(inLinked)).toBe(true);
			expect(fromLinked?.contains(inMain)).toBe(false);
			const fromMain = scopeOf("git commit -m wip", main);
			expect(fromMain?.contains(inMain)).toBe(true);
			expect(fromMain?.contains(inLinked)).toBe(false);
		} finally {
			env.cleanup();
		}
	});
});
