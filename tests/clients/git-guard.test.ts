import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import {
	clearGitGuardTestFailure,
	evaluateGitGuard,
	isGitCommitOrPushAttempt,
	mergeGitGuardTestFailure,
	retireInlineBlockerAndResyncGuard,
	syncGitGuardRecord,
	writeGitGuardRecord,
	type TurnEndFindingsCache,
} from "../../clients/git-guard.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { getProjectDataDir } from "../../clients/file-utils.js";
import { setupTestEnvironment } from "./test-utils.js";
import { tokenizeShellCommand } from "../../clients/bash-file-access.js";

function record(
	overrides: Partial<TurnEndFindingsCache> = {},
): TurnEndFindingsCache {
	return {
		content: "",
		hasBlockers: false,
		affectedFiles: [],
		sessionId: "session-A",
		projectSeqStart: 0,
		projectSeqEnd: 0,
		fileSeqByPath: {},
		fileContentHashes: {},
		...overrides,
	};
}

describe("git-guard", () => {
	it("detects actual git commands through wrappers and options", () => {
		expect(
			isGitCommitOrPushAttempt("bash", { command: 'git commit -m "x"' }),
		).toBe(true);
		expect(
			isGitCommitOrPushAttempt("bash", { command: "git push origin main" }),
		).toBe(true);
		expect(
			isGitCommitOrPushAttempt("bash", {
				command: "npm test && git -C repo commit -m x",
			}),
		).toBe(true);
		expect(
			isGitCommitOrPushAttempt("bash", {
				command: "git --no-pager push origin main",
			}),
		).toBe(true);
		expect(
			isGitCommitOrPushAttempt("bash", { command: "git --help commit" }),
		).toBe(false);
		expect(
			isGitCommitOrPushAttempt("bash", {
				command: "git -c user.name=x commit -m x",
			}),
		).toBe(true);
		expect(
			isGitCommitOrPushAttempt("bash", { command: "GIT_DIR=.git git push" }),
		).toBe(true);
		expect(
			isGitCommitOrPushAttempt("bash", { command: "", cmd: "git commit -m x" }),
		).toBe(true);
		expect(
			isGitCommitOrPushAttempt("bash", { command: "sh -c 'git commit -m x'" }),
		).toBe(true);
		expect(
			isGitCommitOrPushAttempt("bash", {
				command: 'bash -lc "git push origin main"',
			}),
		).toBe(true);
		expect(
			isGitCommitOrPushAttempt("bash", {
				command: 'cmd /c "git.exe commit -m x"',
			}),
		).toBe(true);
		expect(
			isGitCommitOrPushAttempt("bash", {
				cmd: 'powershell -Command "git.cmd push"',
			}),
		).toBe(true);
		expect(
			isGitCommitOrPushAttempt("bash", { command: "# git commit -m x" }),
		).toBe(false);
		expect(
			isGitCommitOrPushAttempt("bash", { command: 'echo "git commit -m x"' }),
		).toBe(false);
		expect(
			isGitCommitOrPushAttempt("bash", { command: "printf 'git push'" }),
		).toBe(false);
		expect(
			isGitCommitOrPushAttempt("write", { command: "git commit -m x" }),
		).toBe(false);
	});

	it("detects wrapper commands when the shell joins unquoted argv", () => {
		expect(
			isGitCommitOrPushAttempt("bash", { command: "cmd /c git commit -m x" }),
		).toBe(true);
		expect(
			isGitCommitOrPushAttempt("bash", {
				command: "powershell -Command git push origin main",
			}),
		).toBe(true);
	});

	it("blocks executable and path-qualified wrapper launchers", () => {
		for (const command of [
			"cmd.exe /c git push",
			"cmd.exe /S /C git push",
			"C:\\Windows\\System32\\cmd.exe /c git push",
			"POWERSHELL.EXE -c git push",
			"C:\\Windows\\System32\\powershell.com -Command git push",
			"sh.exe -c git push",
			"bash.com -c git push",
			"C:\\tools\\env.bat FOO=bar git push",
			"xargs.cmd git push",
		]) {
			expect(isGitCommitOrPushAttempt("bash", { command }), command).toBe(true);
		}
	});

	it("blocks shell escapes embedded in a guarded git verb", () => {
		for (const command of [
			"git pu\\sh",
			"git pu`sh",
			"git pu^sh",
			"git${IFS}push",
			"git$IFS$9push",
			"git ${IFS}pu^sh",
			"git$IFS$1push",
		]) {
			expect(isGitCommitOrPushAttempt("bash", { command }), command).toBe(true);
		}
		for (const command of [
			"git$IFS push",
			"git${IFS%x}push",
			"git$IFS$9push",
			"sh -c 'git$IFS$9push'",
		]) {
			expect(isGitCommitOrPushAttempt("bash", { command }), command).toBe(true);
		}
		expect(
			isGitCommitOrPushAttempt("bash", {
				command: 'git commit -m "$IFS is a var"',
			}),
		).toBe(true);
		expect(
			isGitCommitOrPushAttempt("bash", {
				command: 'git add -m "$IFS is a var"',
			}),
		).toBe(false);
		expect(
			isGitCommitOrPushAttempt("bash", { command: "git add C:\\proj\\a.ts" }),
		).toBe(false);
	});

	it("fails closed for recognized and unknown command-string wrappers", () => {
		for (const command of [
			"busybox sh -c 'git push'",
			"toybox sh -c 'git commit'",
			"nix-shell -p git --run 'git push'",
			'someunknownwrapper -c "git push"',
			'weird --command "git push"',
			'weird -e "git push"',
			'weird /R "git push"',
			"weirdwrapper git push",
		]) {
			expect(isGitCommitOrPushAttempt("bash", { command }), command).toBe(true);
		}
		expect(
			isGitCommitOrPushAttempt("bash", { command: 'myprog -c "echo hi"' }),
		).toBe(false);
		expect(
			isGitCommitOrPushAttempt("bash", { command: "myprog git push" }),
		).toBe(true);
		expect(
			isGitCommitOrPushAttempt("bash", {
				command: 'myprog -c "echo git push"',
			}),
		).toBe(false);
	});

	// #2007 R1 (regression, caught in review): the shared-checkout guard added
	// a post-verb `--help`/`-h` suppression to the classifier both gates now
	// share. Applied to THIS gate it was a hole, because `-h` is a legal
	// option VALUE. Verified against real git 2.55 in a scratch repo:
	// `git commit -m -h` exits 0 and the log subject reads `-h`, and
	// `git push --repo -h` reaches the push path rather than printing help.
	// A gate that fails closed must never be talked out of a match by a token
	// that might be a value.
	it("still matches when -h is an option VALUE, not a help request", () => {
		for (const command of [
			"git commit -m -h",
			"git commit -F -h",
			"git commit --file -h",
			"git commit -c -h",
			"git commit --reuse-message -h",
			"git push --repo -h",
			"git push --receive-pack -h",
			"git push --exec -h",
		]) {
			expect(isGitCommitOrPushAttempt("bash", { command }), command).toBe(true);
		}
	});

	it("keeps failing closed on an explicit post-verb help flag", () => {
		// Not a value here, but this gate does not get to decide that: the
		// pre-#2007 classifier matched these, and a commit gate that can be
		// switched off by appending a flag is not a gate.
		for (const command of [
			"git commit --help",
			"git commit -h",
			"git push --help",
			"git push -h",
		]) {
			expect(isGitCommitOrPushAttempt("bash", { command }), command).toBe(true);
		}
	});

	it("does not treat literal git text as an indirect operation", () => {
		for (const command of [
			'echo "remember to git push later"',
			'grep "git push" file',
			'docker run -c "echo hi"',
			'myprog --run "build"',
		]) {
			expect(isGitCommitOrPushAttempt("bash", { command }), command).toBe(
				false,
			);
		}
		expect(isGitCommitOrPushAttempt("bash", { command: "git push" })).toBe(
			true,
		);
		expect(
			isGitCommitOrPushAttempt("bash", {
				command: 'git commit -m "prep for git push"',
			}),
		).toBe(true);
	});

	it("blocks guarded verbs executed by shell substitutions, including text consumers", () => {
		for (const command of [
			"echo $(git push)",
			'printf "%s" "$(git push)"',
			"grep -f <(git push) x",
			"echo `git push`",
			"cat >(git push)",
			"echo $(git$IFS$9push)",
		]) {
			expect(isGitCommitOrPushAttempt("bash", { command }), command).toBe(true);
		}
	});

	it("allows plain text that only mentions guarded verbs", () => {
		for (const command of [
			'echo "remember to git push later"',
			'grep "git push" file.txt',
			"echo git push",
			'docker run -c "echo hi"',
		]) {
			expect(isGitCommitOrPushAttempt("bash", { command }), command).toBe(
				false,
			);
		}
	});

	it("detects launcher prefixes, shell keywords, combined flags, and continuations", () => {
		const continued = "git \\" + "\ncommit -m x";
		expect(tokenizeShellCommand(continued)[0]?.tokens).toEqual([
			"git",
			"commit",
			"-m",
			"x",
		]);
		for (const command of [
			"env FOO=bar git commit -m x",
			"exec git push origin main",
			"command git commit -m x",
			"nohup git push origin main",
			"nice git commit -m x",
			"xargs git push origin main",
			"if true; then git commit -m x; fi",
			"for x in one; do git push origin main; done",
			"sh -ec 'git commit -m x'",
			"bash -euc 'git push origin main'",
			continued,
		]) {
			expect(isGitCommitOrPushAttempt("bash", { command }), command).toBe(true);
		}
	});

	it("blocks runtime blockers and preserves their details", () => {
		const runtime = {
			gitGuardHasBlockers: true,
			gitGuardSummary: "blocker in src/app.ts:12",
		};
		const env = setupTestEnvironment("pi-lens-git-guard-runtime-");
		try {
			const result = evaluateGitGuard(
				runtime as any,
				new CacheManager(false),
				env.tmpDir,
			);
			expect(result.block).toBe(true);
			expect(result.reason).toContain("src/app.ts");
			expect(result.reason).toContain("Run lens_diagnostics mode=all");
			expect(
				evaluateGitGuard(
					runtime as any,
					new CacheManager(false),
					env.tmpDir,
					"mcp",
				).reason,
			).toContain("Run pilens_diagnostics mode=all");
		} finally {
			env.cleanup();
		}
	});

	it("allows advisory-only structured records", () => {
		const env = setupTestEnvironment("pi-lens-git-guard-advisory-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "session-A" });
			const cache = new CacheManager(false);
			cache.writeCache(
				"turn-end-findings",
				record({ content: "style advisory" }),
				env.tmpDir,
			);
			expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toEqual({
				block: false,
			});
		} finally {
			env.cleanup();
		}
	});

	it("treats malformed, stale, and cross-session state as unknown/block", () => {
		const env = setupTestEnvironment("pi-lens-git-guard-unknown-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "session-A" });
			const cache = new CacheManager(false);
			cache.writeCache(
				"turn-end-findings",
				{ content: "old shape" },
				env.tmpDir,
			);
			expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toMatchObject({
				block: true,
				unknown: true,
			});
			cache.writeCache(
				"turn-end-findings",
				record({ content: "blocker", hasBlockers: true, sessionId: "other" }),
				env.tmpDir,
			);
			expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toMatchObject({
				block: true,
				unknown: true,
			});
			const metaPath = path.join(
				getProjectDataDir(env.tmpDir),
				"cache",
				"turn-end-findings.meta.json",
			);
			const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
			meta.timestamp = new Date(0).toISOString();
			fs.writeFileSync(metaPath, JSON.stringify(meta));
			expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toMatchObject({
				block: true,
				unknown: true,
			});
		} finally {
			env.cleanup();
		}
	});

	it("blocks structured test failures", () => {
		const env = setupTestEnvironment("pi-lens-git-guard-tests-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "session-A" });
			const cache = new CacheManager(false);
			cache.writeCache(
				"turn-end-findings",
				record({
					content: "FAIL 1p/1f",
					hasBlockers: true,
					testFailures: true,
				}),
				env.tmpDir,
			);
			expect(evaluateGitGuard(runtime, cache, env.tmpDir).block).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("aggregates per-file blockers instead of latest-file-wins", () => {
		const env = setupTestEnvironment("pi-lens-git-guard-aggregate-");
		try {
			const runtime = new RuntimeCoordinator();
			const file = path.join(env.tmpDir, "a.ts");
			fs.writeFileSync(file, "const x = 1;\n");
			runtime.recordInlineBlockers(file, "blocker A");
			runtime.updateGitGuardStatus(true, "blocker A");
			runtime.clearInlineBlockers(path.join(env.tmpDir, "b.ts"));
			runtime.updateGitGuardStatus(false, "clean B");
			expect(runtime.gitGuardHasBlockers).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("does not block when the only affected file was deleted", () => {
		const env = setupTestEnvironment("pi-lens-git-guard-deleted-");
		try {
			const file = path.join(env.tmpDir, "deleted.ts");
			fs.writeFileSync(file, "const x = 1;\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "session-A" });
			const cache = new CacheManager(false);
			cache.writeCache(
				"turn-end-findings",
				record({
					content: "blocker",
					hasBlockers: true,
					affectedFiles: [file],
					fileSeqByPath: { [file.replace(/\\/g, "/")]: 0 },
				}),
				env.tmpDir,
			);
			fs.unlinkSync(file);
			expect(evaluateGitGuard(runtime, cache, env.tmpDir).block).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("rejects an external content change even when sequence is unchanged", () => {
		const env = setupTestEnvironment("pi-lens-git-guard-content-");
		try {
			const file = path.join(env.tmpDir, "changed.ts");
			fs.writeFileSync(file, "const before = 1;\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "session-A" });
			const cache = new CacheManager(false);
			writeGitGuardRecord(
				cache,
				runtime,
				env.tmpDir,
				record({
					content: "blocker",
					hasBlockers: true,
					affectedFiles: [file],
					blockingFiles: [file],
				}),
			);
			fs.writeFileSync(file, "const after = 2;\n");
			expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toMatchObject({
				block: true,
				unknown: true,
			});
		} finally {
			env.cleanup();
		}
	});

	it("clears only the test failure that passed", () => {
		const env = setupTestEnvironment("pi-lens-git-guard-test-clear-");
		try {
			const files = ["a.test.ts", "b.test.ts"].map((name) =>
				path.join(env.tmpDir, name),
			);
			for (const file of files) fs.writeFileSync(file, "test();\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "session-A" });
			const cache = new CacheManager(false);
			mergeGitGuardTestFailure(
				cache,
				env.tmpDir,
				runtime,
				"two failures",
				files,
			);
			clearGitGuardTestFailure(cache, env.tmpDir, runtime, [files[0]]);
			expect(evaluateGitGuard(runtime, cache, env.tmpDir).block).toBe(true);
			clearGitGuardTestFailure(cache, env.tmpDir, runtime, [files[1]]);
			expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toEqual({
				block: false,
			});
		} finally {
			env.cleanup();
		}
	});

	it("recovers a stale inline blocker after its file reconciles clean", () => {
		const env = setupTestEnvironment("pi-lens-git-guard-stale-inline-");
		try {
			const file = path.join(env.tmpDir, "cleaned.ts");
			fs.writeFileSync(file, "const x = 1;\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "session-A" });
			const cache = new CacheManager(false);
			runtime.recordInlineBlockers(file, "blocker");
			runtime.updateGitGuardStatus(true, "blocker");
			syncGitGuardRecord(runtime, cache, env.tmpDir, file);

			runtime.clearInlineBlockers(file);
			runtime.updateGitGuardStatus(false, "clean");
			syncGitGuardRecord(runtime, cache, env.tmpDir, file);

			expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toEqual({
				block: false,
			});
		} finally {
			env.cleanup();
		}
	});

	it("#1561 F2: retiring the last blocker unblocks the commit with no manual gate call", () => {
		// The round-1 probe. `evaluateGitGuard` short-circuits on the
		// `gitGuardHasBlockers` LATCH before it reads the persisted record, and
		// the retire touched neither — so a "retired" blocker still blocked the
		// commit and was quoted back as the reason. Nothing below calls
		// `updateGitGuardStatus`/`syncGitGuardRecord` by hand after the retire;
		// that is the whole point.
		const env = setupTestEnvironment("pi-lens-git-guard-retire-");
		try {
			const file = path.join(env.tmpDir, "cleaned.ts");
			fs.writeFileSync(file, "const x = 1;\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "session-A" });
			const cache = new CacheManager(false);
			runtime.recordInlineBlockers(file, "blocker", 1, ["lsp"]);
			runtime.updateGitGuardStatus(true, "blocker");
			syncGitGuardRecord(runtime, cache, env.tmpDir, file);
			expect(evaluateGitGuard(runtime, cache, env.tmpDir).block).toBe(true);

			expect(
				retireInlineBlockerAndResyncGuard({
					runtime,
					cacheManager: cache,
					cwd: env.tmpDir,
					filePath: file,
					writeIndex: 2,
					coveredSources: ["lsp"],
					lensGuardEnabled: true,
				}),
			).toBe(true);

			expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toEqual({
				block: false,
			});
		} finally {
			env.cleanup();
		}
	});

	it("#1561 F2: retiring ONE blocker still leaves a sibling file's blocker gating", () => {
		// The latch recompute must not become a blanket "clear the gate".
		const env = setupTestEnvironment("pi-lens-git-guard-retire-sibling-");
		try {
			const files = ["a.ts", "b.ts"].map((name) => path.join(env.tmpDir, name));
			for (const file of files) fs.writeFileSync(file, "const x = 1;\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "session-A" });
			const cache = new CacheManager(false);
			runtime.recordInlineBlockers(files[0], "blocker A", 1, ["lsp"]);
			runtime.recordInlineBlockers(files[1], "blocker B", 1, ["lsp"]);
			runtime.updateGitGuardStatus(true, "blockers");
			syncGitGuardRecord(runtime, cache, env.tmpDir, files[0]);

			expect(
				retireInlineBlockerAndResyncGuard({
					runtime,
					cacheManager: cache,
					cwd: env.tmpDir,
					filePath: files[0],
					writeIndex: 2,
					coveredSources: ["lsp"],
					lensGuardEnabled: true,
				}),
			).toBe(true);

			expect(evaluateGitGuard(runtime, cache, env.tmpDir).block).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("#1561 F1: an ast-grep-origin blocker keeps gating after an LSP-only clean", () => {
		// The security case: a `cors-wildcard` / `no-commented-credentials`
		// finding must not become committable because a language server said the
		// file was fine.
		const env = setupTestEnvironment("pi-lens-git-guard-retire-source-");
		try {
			const file = path.join(env.tmpDir, "app.ts");
			fs.writeFileSync(file, "const x = 1;\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "session-A" });
			const cache = new CacheManager(false);
			runtime.recordInlineBlockers(file, "🔴 STOP cors-wildcard", 1, [
				"ast-grep",
			]);
			runtime.updateGitGuardStatus(true, "blocker");
			syncGitGuardRecord(runtime, cache, env.tmpDir, file);

			expect(
				retireInlineBlockerAndResyncGuard({
					runtime,
					cacheManager: cache,
					cwd: env.tmpDir,
					filePath: file,
					writeIndex: 2,
					coveredSources: ["lsp"],
					lensGuardEnabled: true,
				}),
			).toBe(false);

			expect(evaluateGitGuard(runtime, cache, env.tmpDir).block).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("still enforces a blocker for another file during per-file recovery", () => {
		const env = setupTestEnvironment("pi-lens-git-guard-stale-sibling-");
		try {
			const files = ["a.ts", "b.ts"].map((name) => path.join(env.tmpDir, name));
			for (const file of files) fs.writeFileSync(file, "const x = 1;\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "session-A" });
			const cache = new CacheManager(false);
			runtime.recordInlineBlockers(files[0], "blocker A");
			runtime.recordInlineBlockers(files[1], "blocker B");
			runtime.updateGitGuardStatus(true, "blockers");
			syncGitGuardRecord(runtime, cache, env.tmpDir, files[0]);

			runtime.clearInlineBlockers(files[0]);
			runtime.updateGitGuardStatus(false, "clean A");
			syncGitGuardRecord(runtime, cache, env.tmpDir, files[0]);

			expect(evaluateGitGuard(runtime, cache, env.tmpDir).block).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("fails closed when persisted blocker provenance omits a represented sibling", () => {
		const env = setupTestEnvironment(
			"pi-lens-git-guard-incomplete-provenance-",
		);
		try {
			const files = ["a.ts", "b.ts"].map((name) => path.join(env.tmpDir, name));
			for (const file of files) fs.writeFileSync(file, "const x = 1;\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "session-A" });
			const cache = new CacheManager(false);
			writeGitGuardRecord(
				cache,
				runtime,
				env.tmpDir,
				record({
					content: `${files[0]}: blocker A\n${files[1]}: blocker B`,
					blockerContent: `${files[0]}: blocker A\n${files[1]}: blocker B`,
					hasBlockers: true,
					affectedFiles: files,
					blockingFiles: [files[0]],
					sessionId: "session-A",
				}),
			);

			syncGitGuardRecord(runtime, cache, env.tmpDir, files[0]);

			expect(evaluateGitGuard(runtime, cache, env.tmpDir).block).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it.each([123, null])(
		"fails closed for forged blocking provenance (%s)",
		(forged) => {
			const env = setupTestEnvironment("pi-lens-git-guard-forged-provenance-");
			try {
				const file = path.join(env.tmpDir, "a.ts");
				fs.writeFileSync(file, "const x = 1;\n");
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				runtime.setTelemetryIdentity({ sessionId: "session-A" });
				const cache = new CacheManager(false);
				cache.writeCache(
					"turn-end-findings",
					record({
						content: `${file}: blocker`,
						blockerContent: `${file}: blocker`,
						hasBlockers: true,
						affectedFiles: [file],
						blockingFiles: [forged as unknown as string],
						sessionId: "session-A",
					}),
					env.tmpDir,
				);

				syncGitGuardRecord(runtime, cache, env.tmpDir, file);

				expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toMatchObject({
					block: true,
				});
			} finally {
				env.cleanup();
			}
		},
	);

	it("allows a missing record and blocks an old unstructured record", () => {
		const env = setupTestEnvironment("pi-lens-git-guard-empty-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const cache = new CacheManager(false);
			expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toEqual({
				block: false,
			});
			cache.writeCache(
				"turn-end-findings",
				{ content: "legacy blocker" },
				env.tmpDir,
			);
			expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toMatchObject({
				block: true,
				unknown: true,
			});
		} finally {
			env.cleanup();
		}
	});
});
