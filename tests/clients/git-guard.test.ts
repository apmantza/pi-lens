import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	CacheManager,
	DEFAULT_MAX_AGE_MS,
} from "../../clients/cache-manager.js";
import {
	clearGitGuardTestFailure,
	evaluateGitGuard,
	isGitCommitOrPushAttempt,
	mergeGitGuardTestFailure,
	readTurnEndGuardRecord,
	retireInlineBlockerAndResyncGuard,
	retireSettledGitGuardRecord,
	syncGitGuardRecord,
	writeGitGuardRecord,
	type BlockerPartition,
	type TurnEndFindingsCache,
} from "../../clients/git-guard.js";
import type { Diagnostic } from "../../clients/dispatch/types.js";
import { formatDiagnostics } from "../../clients/dispatch/utils/format-utils.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import {
	flushLatencyLog,
	getLatencyLogPath,
	getRecentLoggedPhases,
} from "../../clients/latency-logger.js";
import { normalizeFilePath } from "../../clients/path-utils.js";
import { getProjectDataDir } from "../../clients/file-utils.js";
import { consumeTurnEndFindings } from "../../clients/runtime-context.js";
import { setupTestEnvironment } from "./test-utils.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { readNdjsonRows } from "../support/ndjson-rows.js";
import { tokenizeShellCommand } from "../../clients/bash-file-access.js";

/**
 * A blocking dispatch diagnostic, shaped as the runners emit it.
 */
function blockingDiagnostic(
	filePath: string,
	line: number,
	message: string,
): Diagnostic {
	return {
		id: `ast-grep:${path.basename(filePath)}:${line}`,
		message,
		filePath,
		line,
		severity: "error",
		semantic: "blocking",
		tool: "ast-grep",
		rule: "no-eval",
	};
}

/**
 * The inline-blocker summary PRODUCTION records, byte for byte: the pipeline
 * hands `recordInlineBlockers` `dispatchResult.blockerOutput.trim()`
 * (`clients/pipeline.ts:1916`), and `blockerOutput` is
 * `formatDiagnostics(inlineBlockers, "blocking")`
 * (`clients/dispatch/dispatcher.ts:1409`) — a `🔴 STOP` header line plus one
 * INDENTED line per diagnostic.
 *
 * #3282's detection retrospective: every case in this file used to hand-type a
 * single-line summary (`"blocker A"`), the one shape the record's provenance
 * parse accepted. The parse never matched what either writer emits, so the
 * commit gate answered `blocking_provenance_untrusted` for the rest of any
 * session that recorded a blocker, and these tests stayed green. A double that
 * is not production-faithful on the axis under test proves nothing — so the
 * fixture is now rendered by the production renderer, and cannot diverge again.
 */
function productionSummary(
	filePath: string,
	messages: readonly string[],
): string {
	return formatDiagnostics(
		messages.map((message, index) =>
			blockingDiagnostic(filePath, index + 1, message),
		),
		"blocking",
	).trim();
}

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

	// Recurrence prevented (#5648 review F1): the removed blank-collapse
	// pass turned `\<blank><newline>` and `\<CR><LF>` into a line
	// continuation, so the gate read the next line as echo's word and
	// allowed the commit. The real-bash oracle for these rows is ROWS in
	// git-guard-decoded-word.test.ts.
	it("reads the commit after an escaped blank or CR, then a newline", () => {
		for (const command of [
			"echo a \\ \ngit commit -m x",
			"echo a \\\r\ngit commit -m x",
		]) {
			expect(
				isGitCommitOrPushAttempt("bash", { command }),
				JSON.stringify(command),
			).toBe(true);
		}
	});

	it("blocks runtime blockers and preserves their details", () => {
		const runtime = new RuntimeCoordinator();
		runtime.updateGitGuardStatus(true, "blocker in src/app.ts:12");
		const env = setupTestEnvironment("pi-lens-git-guard-runtime-");
		try {
			const result = evaluateGitGuard(
				runtime,
				new CacheManager(false),
				env.tmpDir,
			);
			expect(result.block).toBe(true);
			expect(result.reason).toContain("src/app.ts");
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
			const summary = productionSummary(file, ["alpha is unsafe"]);
			runtime.recordInlineBlockers(file, summary);
			runtime.updateGitGuardStatus(true, summary);
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
			const summary = productionSummary(file, [
				"alpha is unsafe",
				"beta is unsafe",
			]);
			runtime.recordInlineBlockers(file, summary);
			runtime.updateGitGuardStatus(true, summary);
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
			const summary = productionSummary(file, ["alpha is unsafe"]);
			runtime.recordInlineBlockers(file, summary, 1, ["lsp"]);
			runtime.updateGitGuardStatus(true, summary);
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
			runtime.recordInlineBlockers(
				files[0],
				productionSummary(files[0], ["alpha is unsafe"]),
				1,
				["lsp"],
			);
			runtime.recordInlineBlockers(
				files[1],
				productionSummary(files[1], ["beta is unsafe"]),
				1,
				["lsp"],
			);
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
			runtime.recordInlineBlockers(
				file,
				productionSummary(file, ["cors-wildcard: origin is unbounded"]),
				1,
				["ast-grep"],
			);
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

	it("#4990 gap 1: a partial clean narrows the record and the remaining row still gates", () => {
		// The live shape: one server's clean verdict for a record that also holds
		// another tool's row. Before #4990 the whole record survived, so the dead
		// server coordinates kept gating and re-serving. After it, the covered
		// rows leave and the gate answers for the row nobody re-checked.
		const env = setupTestEnvironment("pi-lens-4990-git-guard-partial-");
		try {
			const file = path.join(env.tmpDir, "upstreams.ts");
			fs.writeFileSync(file, "const x = 1;\nconst y = 2;\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "session-A" });
			const cache = new CacheManager(false);
			const diagnostics: Diagnostic[] = [
				{
					id: "lsp:1",
					message: "Cannot find name 'setCached'.",
					filePath: file,
					line: 1,
					severity: "error",
					semantic: "blocking",
					tool: "lsp",
					rule: "typescript:2304",
				},
				{
					id: "oxlint:2",
					message: "no-eval is banned",
					filePath: file,
					line: 2,
					severity: "error",
					semantic: "blocking",
					tool: "oxlint",
					rule: "no-eval",
				},
			];
			runtime.recordInlineBlockers(
				file,
				formatDiagnostics(diagnostics, "blocking").trim(),
				1,
				["lsp", "oxlint"],
				[1, 2],
				undefined,
				diagnostics,
			);
			runtime.updateGitGuardStatus(true, "blockers");
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
			// The lsp row is retired, the oxlint row is not, and the gate still
			// refuses the commit for it.
			const narrowed = runtime.getInlineBlockersSnapshot();
			expect(narrowed).toHaveLength(1);
			expect(narrowed[0]?.sources).toEqual(["oxlint"]);
			expect(evaluateGitGuard(runtime, cache, env.tmpDir).block).toBe(true);

			// The all-source clean retires the rest.
			expect(
				retireInlineBlockerAndResyncGuard({
					runtime,
					cacheManager: cache,
					cwd: env.tmpDir,
					filePath: file,
					writeIndex: 3,
					coveredSources: ["lsp", "oxlint"],
					lensGuardEnabled: true,
				}),
			).toBe(true);
			expect(runtime.getInlineBlockersSnapshot()).toHaveLength(0);
			expect(evaluateGitGuard(runtime, cache, env.tmpDir).block).toBe(false);
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
			runtime.recordInlineBlockers(
				files[0],
				productionSummary(files[0], ["alpha is unsafe"]),
			);
			runtime.recordInlineBlockers(
				files[1],
				productionSummary(files[1], ["beta is unsafe"]),
			);
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
			// The per-edit writer's own expression
			// (`clients/git-guard.ts:1013`), with the production summary each
			// entry carries — so the omission below is the only thing wrong
			// with this record.
			const siblingBlockerContent = files
				.map(
					(file, index) =>
						`${file}: ${productionSummary(file, [`issue ${index + 1} is unsafe`])}`,
				)
				.join("\n");
			writeGitGuardRecord(
				cache,
				runtime,
				env.tmpDir,
				record({
					content: siblingBlockerContent,
					blockerContent: siblingBlockerContent,
					hasBlockers: true,
					affectedFiles: files,
					blockingFiles: [files[0]],
					sessionId: "session-A",
				}),
			);

			syncGitGuardRecord(runtime, cache, env.tmpDir, files[0]);

			// WHICH fail-closed answer matters: the record names a file its own
			// provenance omits, so it is not a record the gate may rewrite — it is
			// untrusted. Asserting only `block: true` let the ownership check be
			// deleted with the suite green (#3282 mutation M7), because the
			// section-ownership rule below refuses the clear on its own.
			expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toMatchObject({
				block: true,
				unknown: true,
				reason: expect.stringContaining("blocking_provenance_untrusted"),
			});
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
				const forgedBlockerContent = `${file}: ${productionSummary(file, ["alpha is unsafe"])}`;
				cache.writeCache(
					"turn-end-findings",
					record({
						content: forgedBlockerContent,
						blockerContent: forgedBlockerContent,
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

	it("#3282: a fixed multi-line blocker stops gating and latches no unknown", () => {
		// The reported defect, through the per-edit writer and the real gate. On
		// pre-fix code the SECOND `syncGitGuardRecord` of the session reads back
		// its own multi-line `blockerContent`, reads `  L1: alpha is unsafe` as a
		// file named `L1`, and returns early after
		// `markGitGuardCacheUnknown("blocking_provenance_untrusted")` — so the
		// record is never rewritten and every later commit in the session is
		// refused with a reason no re-run can clear.
		const env = setupTestEnvironment("pi-lens-git-guard-3282-multiline-");
		try {
			const file = path.join(env.tmpDir, "app.ts");
			fs.writeFileSync(file, "alpha();\nbeta();\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "session-A" });
			const cache = new CacheManager(false);
			const summary = productionSummary(file, [
				"alpha is unsafe",
				"beta is unsafe",
			]);
			expect(summary.split("\n").length).toBeGreaterThan(1);

			// Edit 1: the dispatch raises the blockers.
			runtime.recordInlineBlockers(file, summary, 1, ["ast-grep"]);
			runtime.updateGitGuardStatus(true, summary);
			syncGitGuardRecord(runtime, cache, env.tmpDir, file);
			expect(evaluateGitGuard(runtime, cache, env.tmpDir).block).toBe(true);

			// Edit 2: the same file, still blocking. This is the sync that read its
			// own record back and poisoned the session.
			runtime.recordInlineBlockers(file, summary, 2, ["ast-grep"]);
			runtime.updateGitGuardStatus(true, summary);
			syncGitGuardRecord(runtime, cache, env.tmpDir, file);
			expect(runtime.gitGuardCacheUnknownFor()).toBeUndefined();

			// Edit 3: the agent FIXED it — a clean dispatch, no marks involved.
			runtime.clearInlineBlockers(file);
			runtime.updateGitGuardStatus(false, "");
			syncGitGuardRecord(runtime, cache, env.tmpDir, file);

			expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toEqual({
				block: false,
			});
		} finally {
			env.cleanup();
		}
	});

	it("#3282: a blank line INSIDE a diagnostic message is body, not a boundary", () => {
		// `formatDiagnostics` renders a multi-line message as
		// `d.message.split("\n").join("\n  ")`
		// (`clients/dispatch/utils/format-utils.ts:21`), so a message with a blank
		// line reaches the record as a TWO-SPACE line. Only the composer's
		// zero-length `"\n\n"` part separator ends a section; treating a
		// whitespace-only line as a boundary would make the rest of the message
		// text that no blocking file owns, and re-latch the #3282 block.
		const env = setupTestEnvironment("pi-lens-git-guard-3282-blank-body-");
		try {
			const file = path.join(env.tmpDir, "app.ts");
			fs.writeFileSync(file, "alpha();\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "session-A" });
			const cache = new CacheManager(false);
			const summary = formatDiagnostics(
				[
					blockingDiagnostic(
						file,
						1,
						"alpha is unsafe\n\nuse the checked helper instead",
					),
				],
				"blocking",
			).trim();
			expect(summary).toContain("\n  \n");
			runtime.recordInlineBlockers(file, summary, 1, ["ast-grep"]);
			runtime.updateGitGuardStatus(true, summary);
			syncGitGuardRecord(runtime, cache, env.tmpDir, file);

			runtime.clearInlineBlockers(file);
			runtime.updateGitGuardStatus(false, "");
			syncGitGuardRecord(runtime, cache, env.tmpDir, file);

			expect(runtime.gitGuardCacheUnknownFor()).toBeUndefined();
			expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toEqual({
				block: false,
			});
		} finally {
			env.cleanup();
		}
	});

	it("#3282: keeps the gate closed for a blocker section no blocking file owns", () => {
		// Named recurrence for the fail-closed direction. `blockerParts` is
		// multi-lane: the trivy CRITICAL report (`clients/runtime-turn.ts:2141`),
		// knip (`:2147`), the secrets lane (`:2099`) and cascade (`:1340`) all push
		// sections that belong to NO file, and the composer joins them into
		// `blockerContent` with `"\n\n"` (`:4291`). Attributing such a section to
		// the file section beside it would let a clean dispatch of that file clear
		// a live CVE or leaked secret out of the gate.
		const env = setupTestEnvironment("pi-lens-git-guard-3282-unowned-");
		try {
			const file = path.join(env.tmpDir, "app.ts");
			fs.writeFileSync(file, "alpha();\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "session-A" });
			const cache = new CacheManager(false);
			writeGitGuardRecord(
				cache,
				runtime,
				env.tmpDir,
				record({
					content: "unowned",
					blockerContent: `Unresolved from this turn — ${file}:\n${productionSummary(file, ["alpha is unsafe"])}\n\n🔴 STOP — CRITICAL dependency CVEs (trivy, 3d old). Upgrade before shipping:\n  CVE-2026-1 (left-pad@1.0.0) — upgrade to 1.0.1 or later`,
					hasBlockers: true,
					affectedFiles: [file],
					blockingFiles: [file],
					sessionId: "session-A",
				}),
			);

			// The file dispatches clean. The CVE section is not its to clear.
			syncGitGuardRecord(runtime, cache, env.tmpDir, file);

			expect(runtime.gitGuardCacheUnknownFor()).toBe(
				"blocking_provenance_untrusted",
			);
			expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toMatchObject({
				block: true,
				unknown: true,
			});
		} finally {
			env.cleanup();
		}
	});

	it("#3282: a clean dispatch clears only the sections that are ITS file's", () => {
		// The clear is a PER-FILE authority claim — `syncGitGuardRecord` is called
		// with one `editedFilePath` from three sites — and it must not exceed the
		// file it is about. The record here is the turn-end composer's own shape
		// for a two-file turn (`clients/runtime-turn.ts:1085`, persisted at
		// `:4291`), with both files in `blockingFiles`, so it is fully trusted:
		// nothing but the ownership rule stands between a clean dispatch of `a.ts`
		// and `b.ts`'s blocker being dropped out of the gate.
		//
		// The blocker map is empty here on purpose. Today's writers keep it in step
		// with the record — every path that removes an entry resyncs, and the
		// composer rewrites the record from the surviving set — so this state is
		// not one a session reaches; the rule is pinned at the seam it belongs to
		// rather than through a caller that cannot express it.
		const env = setupTestEnvironment("pi-lens-git-guard-3282-own-section-");
		try {
			const files = ["a.ts", "b.ts"].map((name) => path.join(env.tmpDir, name));
			for (const file of files) fs.writeFileSync(file, "const x = 1;\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "session-A" });
			const cache = new CacheManager(false);
			const sections = files
				.map(
					(file, index) =>
						`Unresolved from this turn — ${file}:\n${productionSummary(file, [`issue ${index + 1} is unsafe`])}`,
				)
				.join("\n\n");
			writeGitGuardRecord(
				cache,
				runtime,
				env.tmpDir,
				record({
					content: sections,
					blockerContent: sections,
					hasBlockers: true,
					affectedFiles: files,
					blockingFiles: files,
					sessionId: "session-A",
				}),
			);

			syncGitGuardRecord(runtime, cache, env.tmpDir, files[0]);

			expect(runtime.gitGuardCacheUnknownFor()).toBeUndefined();
			const after = cache.readCache<Partial<TurnEndFindingsCache>>(
				"turn-end-findings",
				env.tmpDir,
			)?.data;
			expect(after?.blockerContent ?? "").toContain("issue 2 is unsafe");
			expect(evaluateGitGuard(runtime, cache, env.tmpDir).block).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it.each([
		["\\n", "\n"],
		["\\n\\n", "\n\n"],
	])(
		"#3282 HIGH-3287-1: all-blank blocker text (%s) cannot clear another file's record",
		(_label, blockerContent) => {
			// Round 1 shipped this fail-open: `blockerContent` that is non-empty but
			// all-blank opens no section, and round 1 read "zero sections" as
			// "nothing left to attribute", so `[].every(…)` was vacuously true and a
			// clean dispatch of an UNRELATED file deleted a record whose only named
			// blocking file was `other.ts` — the gate then answered `no_record` and
			// allowed the commit.
			//
			// ADR 0003 amendment 3 already said this: the text is attributable only
			// if its FIRST non-empty line opens a section. No line opens one here, so
			// the record is unattributed and fails closed, like any other malformed
			// record. Reviewer's probe, verbatim: `blockerContent="\n"`,
			// `blockingFiles=[<cwd>/other.ts]`, clean dispatch of `<cwd>/clean.ts`
			// observed `{cleared: true, written: false}`.
			const env = setupTestEnvironment("pi-lens-git-guard-3282-blank-content-");
			try {
				const other = path.join(env.tmpDir, "other.ts");
				const clean = path.join(env.tmpDir, "clean.ts");
				fs.writeFileSync(other, "const x = 1;\n");
				fs.writeFileSync(clean, "const y = 2;\n");
				const runtime = new RuntimeCoordinator();
				runtime.projectRoot = env.tmpDir;
				runtime.setTelemetryIdentity({ sessionId: "session-A" });
				const cache = new CacheManager(false);
				writeGitGuardRecord(
					cache,
					runtime,
					env.tmpDir,
					record({
						content: blockerContent,
						blockerContent,
						hasBlockers: true,
						affectedFiles: [other],
						blockingFiles: [other],
						sessionId: "session-A",
					}),
				);

				syncGitGuardRecord(runtime, cache, env.tmpDir, clean);

				expect(
					cache.readCache<Partial<TurnEndFindingsCache>>(
						"turn-end-findings",
						env.tmpDir,
					)?.data?.blockerContent,
				).toBe(blockerContent);
				expect(runtime.gitGuardCacheUnknownFor()).toBe(
					"blocking_provenance_untrusted",
				);
				expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toMatchObject({
					block: true,
					unknown: true,
				});
			} finally {
				env.cleanup();
			}
		},
	);

	it("#3282: a 4.2.1 record whose blocker text names no file stays untrusted", () => {
		// Old-record direction: this fix adds no field and changes no writer, so a
		// record persisted by 4.2.1 is read with the SAME verdict as before. The
		// fixture's `blockerContent` opens no section at all, so there is nothing
		// `blockingFiles` can be checked against — fail closed, exactly as today.
		const env = setupTestEnvironment("pi-lens-git-guard-3282-legacy-");
		try {
			const file = path.join(env.tmpDir, "legacy.ts");
			fs.writeFileSync(file, "alpha();\n");
			const fixture = JSON.parse(
				fs.readFileSync(
					path.join(
						import.meta.dirname,
						"../fixtures/git-guard-records/4.2.1-turn-end-findings.json",
					),
					"utf-8",
				),
			) as TurnEndFindingsCache;
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "session-A" });
			const cache = new CacheManager(false);
			writeGitGuardRecord(cache, runtime, env.tmpDir, {
				...fixture,
				sessionId: "session-A",
				affectedFiles: [file],
				blockingFiles: [file],
			});

			syncGitGuardRecord(runtime, cache, env.tmpDir, file);

			expect(runtime.gitGuardCacheUnknownFor()).toBe(
				"blocking_provenance_untrusted",
			);
			expect(evaluateGitGuard(runtime, cache, env.tmpDir).block).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("#3282 acceptance 5: clearing the record as clean clears the unknown reason", () => {
		// `clearGitGuardCacheUnknown` had exactly one caller, a successful
		// `writeGitGuardRecord` (`clients/git-guard.ts:800`). A sync that finds
		// nothing left to record takes the `clearCache` branch instead and never
		// reached it, so a reason latched earlier in the session outlived the
		// record it described and refused every commit after it.
		const env = setupTestEnvironment("pi-lens-git-guard-3282-latch-life-");
		try {
			const file = path.join(env.tmpDir, "app.ts");
			fs.writeFileSync(file, "alpha();\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "session-A" });
			const cache = new CacheManager(false);
			// A reason about the record latched earlier in the session (a write of
			// the record that failed). #4733 r2 F12: a dispatch that never answered
			// is latched per file instead, and a sync does not clear it.
			runtime.markGitGuardCacheUnknown("cache_write_failed", env.tmpDir);

			syncGitGuardRecord(runtime, cache, env.tmpDir, file);

			expect(runtime.gitGuardCacheUnknownFor()).toBeUndefined();
			expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toEqual({
				block: false,
			});
		} finally {
			env.cleanup();
		}
	});

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

/** Move the record's meta timestamp back by `ageMs` (a day: past the window). */
function ageRecord(cwd: string, ageMs = 86_400_000): void {
	const metaPath = path.join(
		getProjectDataDir(cwd),
		"cache",
		"turn-end-findings.meta.json",
	);
	fs.writeFileSync(
		metaPath,
		JSON.stringify({ timestamp: new Date(Date.now() - ageMs).toISOString() }),
	);
}

/** The stored record, read whatever its age. */
function storedData(
	cache: CacheManager,
	cwd: string,
): Partial<TurnEndFindingsCache> | undefined {
	return cache.readCache<Partial<TurnEndFindingsCache>>(
		"turn-end-findings",
		cwd,
		Number.POSITIVE_INFINITY,
	)?.data;
}

/** The turn-end composer's section shape for each file, as one record text. */
function composerSections(files: readonly string[]): string {
	return files
		.map(
			(file, index) =>
				`Unresolved from this turn — ${file}:\n${productionSummary(file, [`issue ${index + 1} is unsafe`])}`,
		)
		.join("\n\n");
}

function sessionA(cwd: string): RuntimeCoordinator {
	const runtime = new RuntimeCoordinator();
	runtime.projectRoot = cwd;
	runtime.setTelemetryIdentity({ sessionId: "session-A" });
	return runtime;
}

describe("#4725: the record's writers read it whatever its age", () => {
	it("clears this session's own day-old record once its blocked file dispatches clean", () => {
		// RECURRENCE GUARDED: #4725 F5. `cacheRecord` read through the cache's
		// freshness window, so a clean dispatch of the blocked file met "no
		// record", latched `cache_stale` and left the record in place.
		const env = setupTestEnvironment("pi-lens-git-guard-4725-own-stale-");
		try {
			const file = path.join(env.tmpDir, "a.ts");
			fs.writeFileSync(file, "const x = 1;\n");
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			const text = composerSections([file]);
			writeGitGuardRecord(
				cache,
				runtime,
				env.tmpDir,
				record({
					content: text,
					blockerContent: text,
					hasBlockers: true,
					affectedFiles: [file],
					blockingFiles: [file],
				}),
			);
			ageRecord(env.tmpDir);

			syncGitGuardRecord(runtime, cache, env.tmpDir, file);

			expect(runtime.gitGuardCacheUnknownFor()).toBeUndefined();
			expect(storedData(cache, env.tmpDir)).toBeUndefined();
			expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toEqual({
				block: false,
			});
		} finally {
			env.cleanup();
		}
	});

	it("drops a clean file's sections from another session's record, keeps it that session's, and clears it at the last one", () => {
		// RECURRENCE GUARDED: #4725 F8. A record another session wrote was never
		// cleared by anything this session did: every clean write latched
		// `session_mismatch` and returned, so the refusal had no true action.
		const env = setupTestEnvironment("pi-lens-git-guard-4725-foreign-");
		try {
			const files = ["a.ts", "b.ts"].map((name) => path.join(env.tmpDir, name));
			for (const file of files) fs.writeFileSync(file, "const x = 1;\n");
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			const text = composerSections(files);
			writeGitGuardRecord(
				cache,
				runtime,
				env.tmpDir,
				record({
					content: text,
					blockerContent: text,
					hasBlockers: true,
					affectedFiles: files,
					blockingFiles: files,
					sessionId: "an-earlier-session",
					consumed: true,
				}),
			);

			// A clean write that reached a whole-file verdict (#4733 r1 F2): only
			// such a write speaks for another session's section.
			syncGitGuardRecord(runtime, cache, env.tmpDir, files[0], "session", true);

			const after = storedData(cache, env.tmpDir);
			expect(after?.sessionId).toBe("an-earlier-session");
			expect(after?.consumed).toBe(true);
			expect(after?.blockerContent).toContain("issue 2 is unsafe");
			expect(after?.blockerContent).not.toContain("issue 1 is unsafe");
			const refusal = evaluateGitGuard(runtime, cache, env.tmpDir);
			expect(refusal).toMatchObject({ block: true, unknown: true });
			expect(refusal.reason).toContain("session_mismatch");
			expect(refusal.reason).toContain("The record names blockers in b.ts ");
			expect(refusal.reason).toContain("write each file again");

			syncGitGuardRecord(runtime, cache, env.tmpDir, files[1], "session", true);

			expect(storedData(cache, env.tmpDir)).toBeUndefined();
			expect(runtime.gitGuardCacheUnknownFor()).toBeUndefined();
			expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toEqual({
				block: false,
			});
		} finally {
			env.cleanup();
		}
	});

	it("keeps a record whose blocker names no file, and says no re-check of one file clears it", () => {
		// The fail-closed control (#4725 F7, #1561): a section no file owns, such
		// as a project scanner's report, is never cleared by a clean dispatch of
		// the file beside it. #4733 r2 F13: the record is this session's own and
		// the write is a whole-file clean verdict, so the attribution guard, not
		// the foreign-session return, is what keeps it.
		const env = setupTestEnvironment("pi-lens-git-guard-4725-unattributed-");
		try {
			const file = path.join(env.tmpDir, "legacy.ts");
			fs.writeFileSync(file, "alpha();\n");
			const fixture = JSON.parse(
				fs.readFileSync(
					path.join(
						import.meta.dirname,
						"../fixtures/git-guard-records/4.2.1-turn-end-findings.json",
					),
					"utf-8",
				),
			) as TurnEndFindingsCache;
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			writeGitGuardRecord(cache, runtime, env.tmpDir, {
				...fixture,
				sessionId: "session-A",
				affectedFiles: [file],
				blockingFiles: [file],
			});

			syncGitGuardRecord(runtime, cache, env.tmpDir, file, "session", true);

			expect(storedData(cache, env.tmpDir)?.blockerContent).toBe(
				fixture.blockerContent,
			);
			expect(evaluateGitGuard(runtime, cache, env.tmpDir).reason).toContain(
				"(blocking_provenance_untrusted)",
			);
			// Another session reading the same record is told what replaces it.
			const other = new RuntimeCoordinator();
			other.projectRoot = env.tmpDir;
			other.setTelemetryIdentity({ sessionId: "session-B" });
			const refusal = evaluateGitGuard(other, cache, env.tmpDir);
			expect(refusal).toMatchObject({ block: true, unknown: true });
			expect(refusal.reason).toContain(
				"cannot attribute to a file, so no re-check of one file clears them",
			);
			expect(refusal.reason).not.toContain("fresh session");

			// A record that makes no claim (3.8.74's `{ content }`, and the
			// `--lens-guard`-off writer's record) is not a re-check's either: a
			// settled turn end clears it (#4733 r1 F3), and the remedy says so.
			const fresh = sessionA(env.tmpDir);
			cache.writeCache(
				"turn-end-findings",
				{ content: "🔴 STOP — 1 issue(s) must be fixed:\n  L1: alpha" },
				env.tmpDir,
			);
			expect(evaluateGitGuard(fresh, cache, env.tmpDir).reason).toContain(
				"cache_malformed). The record makes no blocker claim pi-lens can check",
			);
		} finally {
			env.cleanup();
		}
	});

	it("clears this session's two-file record one clean file at a time, with no untrusted latch", () => {
		// RECURRENCE GUARDED: the per-file clear kept the cleaned file's own
		// section while dropping it from `blockingFiles`, so the next clean file's
		// lookup found a section nobody owned and latched
		// `blocking_provenance_untrusted` (the same seam #4725's foreign-record
		// clear depends on).
		const env = setupTestEnvironment("pi-lens-git-guard-4725-own-two-");
		try {
			const files = ["a.ts", "b.ts"].map((name) => path.join(env.tmpDir, name));
			for (const file of files) fs.writeFileSync(file, "const x = 1;\n");
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			const text = composerSections(files);
			writeGitGuardRecord(
				cache,
				runtime,
				env.tmpDir,
				record({
					content: text,
					blockerContent: text,
					hasBlockers: true,
					affectedFiles: files,
					blockingFiles: files,
				}),
			);

			syncGitGuardRecord(runtime, cache, env.tmpDir, files[0]);
			syncGitGuardRecord(runtime, cache, env.tmpDir, files[1]);

			expect(runtime.gitGuardCacheUnknownFor()).toBeUndefined();
			expect(storedData(cache, env.tmpDir)).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("keeps a day-old record's blocker text when a test failure joins it", () => {
		// RECURRENCE GUARDED: #4725 F6. The merge read the record through the
		// freshness window, met "no record", and wrote the test failure over the
		// blocker it carried.
		const env = setupTestEnvironment("pi-lens-git-guard-4725-merge-");
		try {
			const file = path.join(env.tmpDir, "a.ts");
			fs.writeFileSync(file, "const x = 1;\n");
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			const text = composerSections([file]);
			writeGitGuardRecord(
				cache,
				runtime,
				env.tmpDir,
				record({
					content: text,
					blockerContent: text,
					hasBlockers: true,
					affectedFiles: [file],
					blockingFiles: [file],
				}),
			);
			ageRecord(env.tmpDir);

			mergeGitGuardTestFailure(cache, env.tmpDir, runtime, "FAIL 0p/1f", [
				file,
			]);

			expect(storedData(cache, env.tmpDir)?.blockerContent).toBe(text);
		} finally {
			env.cleanup();
		}
	});

	it("retires a day-old record's test failures on a passing run", () => {
		// RECURRENCE GUARDED: #4725 F6. A passing run met "no record" through the
		// freshness window and returned, so the old failure kept the gate closed.
		const env = setupTestEnvironment("pi-lens-git-guard-4725-test-pass-");
		try {
			const file = path.join(env.tmpDir, "a.test.ts");
			fs.writeFileSync(file, "it('x', () => {});\n");
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			mergeGitGuardTestFailure(cache, env.tmpDir, runtime, "FAIL 0p/1f", [
				file,
			]);
			ageRecord(env.tmpDir);

			clearGitGuardTestFailure(cache, env.tmpDir, runtime, [file]);

			expect(storedData(cache, env.tmpDir)).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("refuses a record that says it has no blocker beside a test failure", () => {
		// The gate admits a no-blocker claim at any age (#4725), so the one form
		// left past it, a contradiction no writer produces, must fail closed
		// rather than ride the old `!hasBlockers` allow.
		const env = setupTestEnvironment("pi-lens-git-guard-4725-contradiction-");
		try {
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			cache.writeCache(
				"turn-end-findings",
				record({ content: "FAIL", hasBlockers: false, testFailures: true }),
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

	it("keeps refusing a stored value that is not a record, and names no file", () => {
		// The fail-closed control for the any-age read (#4725): a value with no
		// record shape claims nothing, so the turn end may not retire it, and
		// the refusal must not offer a re-check that cannot clear it.
		// Recurrence: reading such a value as "no record" gave it the re-check
		// remedy (and one step further, would allow the commit).
		for (const value of [null, "garbage", 7]) {
			const env = setupTestEnvironment("pi-lens-git-guard-4725-non-record-");
			try {
				const runtime = sessionA(env.tmpDir);
				const cache = new CacheManager(false);
				cache.writeCache("turn-end-findings", value, env.tmpDir);
				expect(
					cache.inspectCache("turn-end-findings", env.tmpDir),
					String(value),
				).toBe("fresh");

				expect(retireSettledGitGuardRecord(runtime, cache, env.tmpDir)).toBe(
					false,
				);
				const refusal = evaluateGitGuard(runtime, cache, env.tmpDir);
				expect(refusal, String(value)).toMatchObject({
					block: true,
					unknown: true,
				});
				expect(refusal.reason).toContain(
					"cache_malformed). The record holds blockers pi-lens cannot attribute",
				);
			} finally {
				env.cleanup();
			}
		}
	});

	it("names a write as the action for this session's own unknown state, never a fresh session", () => {
		// #4725 acceptance 3: a fresh session reads the same record, so the old
		// "or start a fresh session" named an action that clears nothing.
		const env = setupTestEnvironment("pi-lens-git-guard-4725-own-remedy-");
		try {
			const file = path.join(env.tmpDir, "a.ts");
			fs.writeFileSync(file, "const x = 1;\n");
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			// This session's own fresh record: its blockers are not "unconfirmed",
			// so the refusal must not borrow the other-session remedy.
			const text = composerSections([file]);
			writeGitGuardRecord(
				cache,
				runtime,
				env.tmpDir,
				record({
					content: text,
					blockerContent: text,
					hasBlockers: true,
					affectedFiles: [file],
					blockingFiles: [file],
				}),
			);
			runtime.markGitGuardCacheUnknown("cache_write_failed", env.tmpDir);
			const refusal = evaluateGitGuard(runtime, cache, env.tmpDir);
			expect(refusal.reason).toContain(
				"Write the affected files again so pi-lens re-checks them",
			);
			expect(refusal.reason).not.toContain("cannot confirm");
			expect(refusal.reason).not.toContain("fresh session");
		} finally {
			env.cleanup();
		}
	});

	it("caps the files a refusal names and says how many it left out, and names failing tests", () => {
		// An agent-facing list is bounded and discloses its cut (AGENTS.md
		// shape 10); a record that also holds test failures says what clears
		// them (#4725 acceptance 3).
		const env = setupTestEnvironment("pi-lens-git-guard-4725-remedy-cap-");
		try {
			const files = ["a", "b", "c", "d", "e", "f"].map((name) =>
				path.join(env.tmpDir, `${name}.ts`),
			);
			for (const file of files) fs.writeFileSync(file, "const x = 1;\n");
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			const text = composerSections(files);
			cache.writeCache(
				"turn-end-findings",
				record({
					content: text,
					blockerContent: text,
					hasBlockers: true,
					affectedFiles: files,
					blockingFiles: files,
					sessionId: "an-earlier-session",
					testFailures: true,
					testFailureContent: "FAIL 0p/1f",
					testFailureFiles: [files[0]],
				}),
				env.tmpDir,
			);
			const reason = evaluateGitGuard(runtime, cache, env.tmpDir).reason ?? "";
			expect(reason).toContain(
				"The record names blockers in a.ts, b.ts, c.ts, d.ts, e.ts and 1 more that pi-lens cannot confirm.",
			);
			expect(reason).toContain(
				"Run the failing tests again: a passing run clears them.",
			);
		} finally {
			env.cleanup();
		}
	});

	it("leaves this session's record text byte for byte when an unrelated file dispatches clean", () => {
		// The per-file clear rewrites the text only when it drops a section, so
		// a record in `syncGitGuardRecord`'s own one-newline join is not
		// re-joined by a dispatch that owns none of it.
		const env = setupTestEnvironment("pi-lens-git-guard-4725-bytes-");
		try {
			const files = ["a.ts", "b.ts", "c.ts"].map((name) =>
				path.join(env.tmpDir, name),
			);
			for (const file of files) fs.writeFileSync(file, "const x = 1;\n");
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			const text = files
				.slice(0, 2)
				.map(
					(file) => `${file}: ${productionSummary(file, ["alpha is unsafe"])}`,
				)
				.join("\n");
			writeGitGuardRecord(
				cache,
				runtime,
				env.tmpDir,
				record({
					content: text,
					blockerContent: text,
					hasBlockers: true,
					affectedFiles: files.slice(0, 2),
					blockingFiles: files.slice(0, 2),
				}),
			);

			syncGitGuardRecord(runtime, cache, env.tmpDir, files[2]);

			expect(storedData(cache, env.tmpDir)?.blockerContent).toBe(text);
		} finally {
			env.cleanup();
		}
	});

	it("retires at a settled turn end only a record that is this session's, claims no blocker, or makes no claim", () => {
		const env = setupTestEnvironment("pi-lens-git-guard-4725-retire-");
		try {
			const file = path.join(env.tmpDir, "a.ts");
			fs.writeFileSync(file, "const x = 1;\n");
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			const text = composerSections([file]);
			const blocker = record({
				content: text,
				blockerContent: text,
				hasBlockers: true,
				affectedFiles: [file],
				blockingFiles: [file],
			});
			const cells: Array<[string, unknown, boolean]> = [
				["own blocker record", blocker, true],
				[
					"own record with a test failure",
					{ ...blocker, testFailures: true },
					false,
				],
				[
					"another session's blocker record",
					{ ...blocker, sessionId: "other" },
					false,
				],
				[
					"another session's no-blocker claim",
					record({ content: "advisory", sessionId: "other" }),
					true,
				],
				[
					"a bare no-blocker claim",
					{ content: "old", hasBlockers: false },
					true,
				],
				[
					"a no-blocker claim beside blocker text",
					{ content: "x", hasBlockers: false, blockerContent: text },
					false,
				],
				// #4733 r1 F3: a record that makes no claim (only the delivery
				// fields the `--lens-guard`-off writer and 3.8.74 wrote) answers to
				// no file, so this session's settled turn end replaces it.
				["a record with no claim", { content: "legacy blocker" }, true],
				[
					"the --lens-guard-off writer's record",
					readFixtureRecord("4.4.4-guard-off-turn-end-findings.json"),
					true,
				],
				[
					"a record with no claim but a session id",
					{ content: "x", sessionId: "other" },
					false,
				],
				[
					"a record with a claim no writer makes",
					{ content: "x", hasBlockers: "yes" },
					false,
				],
				["a record with no content", { affectedFiles: [] }, false],
				["a null record", null, false],
				["an array", [], false],
			];
			const verdicts = cells.map(([label, data]) => {
				cache.writeCache("turn-end-findings", data, env.tmpDir);
				ageRecord(env.tmpDir);
				const retired = retireSettledGitGuardRecord(runtime, cache, env.tmpDir);
				const gone = !fs.existsSync(
					path.join(
						getProjectDataDir(env.tmpDir),
						"cache",
						"turn-end-findings.json",
					),
				);
				cache.clearCache("turn-end-findings", env.tmpDir);
				return [label, retired && gone];
			});
			expect(verdicts).toEqual(cells.map(([label, , want]) => [label, want]));
		} finally {
			env.cleanup();
		}
	});

	it("reads every released record shape with the verdict its claim allows, fresh and a day old", () => {
		// Fixture corpus (principles §2): one record per writer that ever wrote
		// it — 3.8.74's `{ content }` (`clients/runtime-turn.ts` at v3.8.74), the
		// 4.2.1 lens-guard blocker record, and both 4.4.4 writers (the lens-guard
		// advisory-only record, and the record written with --lens-guard off).
		// Only an explicit no-blocker claim is admitted; every other shape fails
		// closed at either age, and a clean write retires only the admitted one.
		// [fixture, admitted by the gate and a clean write, retired by a settled
		// turn end]. #4733 r1 F3: a record with no claim is retired at the turn
		// end, never admitted.
		const corpus: Array<[string, boolean, boolean]> = [
			["3.8.74-turn-end-findings.json", false, true],
			["4.2.1-turn-end-findings.json", false, false],
			["4.4.4-advisory-turn-end-findings.json", true, true],
			["4.4.4-guard-off-turn-end-findings.json", false, true],
			// #4738: the 4.4.4 lens-guard blocker record and this version's shared
			// record, both another session's, with their blocked files live.
			["4.4.4-lens-guard-blocker-turn-end-findings.json", false, false],
			["4738-carried-turn-end-findings.json", false, false],
			// #4750: the stamped record, its project-lane partition long expired.
			["4750-stamped-turn-end-findings.json", false, false],
			// #4943: the --lens-guard-off writer's record now names the session
			// it is addressed to; an address claims nothing, so it still retires.
			["4943-addressed-guard-off-turn-end-findings.json", false, true],
		];
		const env = setupTestEnvironment("pi-lens-git-guard-4725-corpus-");
		try {
			const file = path.join(env.tmpDir, "clean.ts");
			fs.writeFileSync(file, "const x = 1;\n");
			const cache = new CacheManager(false);
			const observed = corpus.flatMap(([name]) => {
				const data = boundFixture(name, env.tmpDir);
				return [false, true].map((old) => {
					const runtime = sessionA(env.tmpDir);
					cache.writeCache("turn-end-findings", data, env.tmpDir);
					if (old) ageRecord(env.tmpDir);
					const allowed = !evaluateGitGuard(runtime, cache, env.tmpDir).block;
					syncGitGuardRecord(runtime, cache, env.tmpDir, file, "session", true);
					const retired = storedData(cache, env.tmpDir) === undefined;
					cache.writeCache("turn-end-findings", data, env.tmpDir);
					if (old) ageRecord(env.tmpDir);
					const settled = retireSettledGitGuardRecord(
						sessionA(env.tmpDir),
						cache,
						env.tmpDir,
					);
					cache.clearCache("turn-end-findings", env.tmpDir);
					return [name, old ? "day-old" : "fresh", allowed, retired, settled];
				});
			});
			expect(observed).toEqual(
				corpus.flatMap(([name, admitted, settled]) =>
					["fresh", "day-old"].map((age) => [
						name,
						age,
						admitted,
						admitted,
						settled,
					]),
				),
			);
		} finally {
			env.cleanup();
		}
	});
});

/** A blocker in `blocked` and a failing `testFile`, under another session. */
function foreignBlockerAndTestRecord(
	blocked: string,
	testFile: string,
): TurnEndFindingsCache {
	const text = composerSections([blocked]);
	return record({
		content: `${text}\n\nFAIL 0p/1f`,
		blockerContent: text,
		hasBlockers: true,
		affectedFiles: [blocked, testFile],
		blockingFiles: [blocked],
		sessionId: "an-earlier-session",
		consumed: true,
		testFailures: true,
		testFailureContent: "FAIL 0p/1f",
		testFailureFiles: [testFile],
	});
}

function readFixtureRecord(name: string): unknown {
	return JSON.parse(
		fs.readFileSync(
			path.join(import.meta.dirname, "../fixtures/git-guard-records", name),
			"utf-8",
		),
	);
}

describe("#4725 r2: a writer never takes another session's record", () => {
	it("keeps another session's owner when its failing tests pass, so a clean turn end keeps its blocker", () => {
		// RECURRENCE GUARDED: #4733 r1 F1 (Greptile "Passing tests erase
		// unrelated blockers"). The passing run rewrote the record under this
		// session's id; the next clean turn end then retired it as this
		// session's own, and the commit ran with a.ts never re-checked.
		const env = setupTestEnvironment("pi-lens-git-guard-4733-clear-owner-");
		try {
			const blocked = path.join(env.tmpDir, "a.ts");
			const testFile = path.join(env.tmpDir, "b.test.ts");
			fs.writeFileSync(blocked, "debugger;\n");
			fs.writeFileSync(testFile, "it('x', () => {});\n");
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			cache.writeCache(
				"turn-end-findings",
				foreignBlockerAndTestRecord(blocked, testFile),
				env.tmpDir,
			);
			ageRecord(env.tmpDir);

			clearGitGuardTestFailure(cache, env.tmpDir, runtime, [testFile]);

			const after = storedData(cache, env.tmpDir);
			expect(after?.sessionId).toBe("an-earlier-session");
			expect(after?.testFailures).toBe(false);
			expect(retireSettledGitGuardRecord(runtime, cache, env.tmpDir)).toBe(
				false,
			);
			const refusal = evaluateGitGuard(runtime, cache, env.tmpDir);
			expect(refusal).toMatchObject({ block: true, unknown: true });
			expect(refusal.reason).toContain("The record names blockers in a.ts ");
		} finally {
			env.cleanup();
		}
	});

	it("keeps another session's owner when a test failure joins its blocker record", () => {
		// RECURRENCE GUARDED: #4733 r1 F1, the merge half: the merge stamped this
		// session's id on another session's blocker, and its passing run and a
		// clean turn end then deleted it.
		const env = setupTestEnvironment("pi-lens-git-guard-4733-merge-owner-");
		try {
			const blocked = path.join(env.tmpDir, "a.ts");
			const testFile = path.join(env.tmpDir, "b.test.ts");
			fs.writeFileSync(blocked, "debugger;\n");
			fs.writeFileSync(testFile, "it('x', () => {});\n");
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			const text = composerSections([blocked]);
			cache.writeCache(
				"turn-end-findings",
				record({
					content: text,
					blockerContent: text,
					hasBlockers: true,
					affectedFiles: [blocked],
					blockingFiles: [blocked],
					sessionId: "an-earlier-session",
				}),
				env.tmpDir,
			);
			ageRecord(env.tmpDir);

			mergeGitGuardTestFailure(cache, env.tmpDir, runtime, "FAIL 0p/1f", [
				testFile,
			]);
			expect(storedData(cache, env.tmpDir)?.sessionId).toBe(
				"an-earlier-session",
			);
			clearGitGuardTestFailure(cache, env.tmpDir, runtime, [testFile]);

			expect(storedData(cache, env.tmpDir)?.sessionId).toBe(
				"an-earlier-session",
			);
			expect(retireSettledGitGuardRecord(runtime, cache, env.tmpDir)).toBe(
				false,
			);
			expect(evaluateGitGuard(runtime, cache, env.tmpDir).block).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("stamps this session on a test failure it merges into a record that held no blocker", () => {
		// The other side of the owner rule: with no stored blocker section left
		// to speak for, the record is this session's evidence, so this session's
		// own settled turn end may judge it once its test passes.
		const env = setupTestEnvironment("pi-lens-git-guard-4733-merge-own-");
		try {
			const testFile = path.join(env.tmpDir, "b.test.ts");
			fs.writeFileSync(testFile, "it('x', () => {});\n");
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			cache.writeCache(
				"turn-end-findings",
				record({ content: "advisory", sessionId: "an-earlier-session" }),
				env.tmpDir,
			);

			mergeGitGuardTestFailure(cache, env.tmpDir, runtime, "FAIL 0p/1f", [
				testFile,
			]);

			expect(storedData(cache, env.tmpDir)?.sessionId).toBe("session-A");
		} finally {
			env.cleanup();
		}
	});

	it("keeps another session's section when the write reached no whole-file clean verdict", () => {
		// RECURRENCE GUARDED: #4733 r1 F2 (Greptile "Unanswered checks clear
		// blockers"). The trim read "this session's map has no entry for the
		// file" as "this session checked it clean", so a timed-out or
		// unanswered run dropped another session's section, and the last one
		// cleared the record (AGENTS.md shape 10: a run with no verdict
		// observes nothing).
		const env = setupTestEnvironment("pi-lens-git-guard-4733-no-verdict-");
		try {
			const file = path.join(env.tmpDir, "a.ts");
			fs.writeFileSync(file, "const x = 1;\n");
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			const text = composerSections([file]);
			cache.writeCache(
				"turn-end-findings",
				record({
					content: text,
					blockerContent: text,
					hasBlockers: true,
					affectedFiles: [file],
					blockingFiles: [file],
					sessionId: "an-earlier-session",
				}),
				env.tmpDir,
			);

			syncGitGuardRecord(runtime, cache, env.tmpDir, file);

			expect(storedData(cache, env.tmpDir)?.blockerContent).toBe(text);
			expect(evaluateGitGuard(runtime, cache, env.tmpDir).block).toBe(true);

			syncGitGuardRecord(runtime, cache, env.tmpDir, file, "session", true);

			expect(storedData(cache, env.tmpDir)).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("retires a day-old record the guard-off writer left at a settled turn end, and the commit runs", () => {
		// RECURRENCE GUARDED: #4733 r1 F3. The `--lens-guard`-off writer
		// (`clients/runtime-turn.ts`, the `else` branch) writes a record with no
		// claim. Past the delivery window nothing consumed it, so it refused
		// every guarded commit in every session: a clean write latched
		// `cache_stale` and the turn end kept it.
		const env = setupTestEnvironment("pi-lens-git-guard-4733-guard-off-");
		try {
			const file = path.join(env.tmpDir, "clean.ts");
			fs.writeFileSync(file, "const x = 1;\n");
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			cache.writeCache(
				"turn-end-findings",
				readFixtureRecord("4.4.4-guard-off-turn-end-findings.json"),
				env.tmpDir,
			);
			ageRecord(env.tmpDir);

			syncGitGuardRecord(runtime, cache, env.tmpDir, file, "session", true);
			const refusal = evaluateGitGuard(runtime, cache, env.tmpDir);
			expect(refusal).toMatchObject({ block: true, unknown: true });
			expect(refusal.reason).toContain(
				"The record makes no blocker claim pi-lens can check, so no re-check of one file clears it; a turn that ends with no blocker clears it. Then retry.",
			);

			expect(retireSettledGitGuardRecord(runtime, cache, env.tmpDir)).toBe(
				true,
			);
			expect(runtime.gitGuardCacheUnknownFor()).toBeUndefined();
			expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toEqual({
				block: false,
			});
		} finally {
			env.cleanup();
		}
	});

	it("keeps a dispatch latch through every write and delete of the record (#4733 r2 F12)", () => {
		// RECURRENCE GUARDED: #4733 r2 F12 (Greptile "Unrelated writes erase
		// failed checks"). The latch held one reason and no file, and every
		// record write or delete cleared it, so one file's crashed dispatch was
		// erased by another file's clean write and the commit ran with the
		// crashed file never re-checked.
		const env = setupTestEnvironment("pi-lens-git-guard-4733-dispatch-latch-");
		try {
			const crashed = path.join(env.tmpDir, "crashed.ts");
			const edited = path.join(env.tmpDir, "edited.ts");
			const testFile = path.join(env.tmpDir, "edited.test.ts");
			for (const file of [crashed, edited, testFile])
				fs.writeFileSync(file, "export const x = 1;\n");
			const ownSection = composerSections([edited]);
			const seed = (cache: CacheManager, data: TurnEndFindingsCache) =>
				cache.writeCache("turn-end-findings", data, env.tmpDir);
			const writers: Array<
				[string, (runtime: RuntimeCoordinator, cache: CacheManager) => void]
			> = [
				[
					"a settled turn end retires a no-blocker claim",
					(runtime, cache) => {
						seed(cache, record());
						retireSettledGitGuardRecord(runtime, cache, env.tmpDir);
					},
				],
				[
					"a write deletes a no-blocker claim",
					(runtime, cache) => {
						seed(cache, record({ sessionId: "an-earlier-session" }));
						syncGitGuardRecord(
							runtime,
							cache,
							env.tmpDir,
							edited,
							"session",
							true,
						);
					},
				],
				[
					"a whole-file clean write deletes the last section",
					(runtime, cache) => {
						seed(
							cache,
							record({
								content: ownSection,
								blockerContent: ownSection,
								blockingFiles: [edited],
								hasBlockers: true,
								affectedFiles: [edited],
							}),
						);
						syncGitGuardRecord(
							runtime,
							cache,
							env.tmpDir,
							edited,
							"session",
							true,
						);
					},
				],
				[
					"a blocker write rewrites the record",
					(runtime, cache) => {
						runtime.recordInlineBlockers(
							edited,
							productionSummary(edited, ["unsafe"]),
							1,
						);
						syncGitGuardRecord(runtime, cache, env.tmpDir, undefined);
					},
				],
				[
					"a passing run deletes the record",
					(runtime, cache) => {
						seed(
							cache,
							record({
								content: "FAIL 0p/1f",
								hasBlockers: true,
								testFailures: true,
								testFailureContent: "FAIL 0p/1f",
								testFailureFiles: [testFile],
							}),
						);
						clearGitGuardTestFailure(cache, env.tmpDir, runtime, [testFile]);
					},
				],
			];
			const kept = writers.map(([label, writer]) => {
				const runtime = sessionA(env.tmpDir);
				const cache = new CacheManager(false);
				cache.clearCache("turn-end-findings", env.tmpDir);
				runtime.markGitGuardDispatchUnanswered(crashed, "pipeline_crash");
				writer(runtime, cache);
				const refusal = evaluateGitGuard(runtime, cache, env.tmpDir);
				return [
					label,
					refusal.block === true &&
						!!refusal.reason?.includes("pipeline_crash") &&
						!!refusal.reason?.includes("pi-lens could not check crashed.ts"),
				];
			});
			expect(kept).toEqual(writers.map(([label]) => [label, true]));

			// The record's own latch is the converse: it is about the record, so
			// every one of these writers releases it (one left set refused every
			// commit after the record it described was gone).
			const released = writers.map(([label, writer]) => {
				const runtime = sessionA(env.tmpDir);
				const cache = new CacheManager(false);
				cache.clearCache("turn-end-findings", env.tmpDir);
				runtime.markGitGuardCacheUnknown("cache_write_failed", env.tmpDir);
				writer(runtime, cache);
				return [label, evaluateGitGuard(runtime, cache, env.tmpDir).unknown];
			});
			expect(released).toEqual(writers.map(([label]) => [label, undefined]));
		} finally {
			env.cleanup();
		}
	});

	it("clears each dispatch latch only with its own file's answer (#4733 r2 F12)", () => {
		// RECURRENCE GUARDED: #4733 r2 F12. One latch slot held the last reason,
		// so a second file's crash replaced the first's, and the first file's
		// answer could clear the second's.
		const env = setupTestEnvironment("pi-lens-git-guard-4733-two-latches-");
		try {
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			const first = path.join(env.tmpDir, "first.ts");
			const second = path.join(env.tmpDir, "second.ts");
			for (const file of [first, second]) fs.writeFileSync(file, "x;\n");
			runtime.markGitGuardDispatchUnanswered(first, "pipeline_crash");
			runtime.markGitGuardDispatchUnanswered(second, "pipeline_error");

			runtime.answerGitGuardDispatch(first);
			const refusal = evaluateGitGuard(runtime, cache, env.tmpDir);
			expect(refusal.block).toBe(true);
			expect(refusal.reason).toContain("(pipeline_error)");
			expect(refusal.reason).toContain("pi-lens could not check second.ts");
			// #4733 r3 F18: the decision row names the file, so two latched files
			// in one session are two distinguishable rows.
			expect(getRecentLoggedPhases(1)[0]?.metadata).toMatchObject({
				decision: "unknown",
				reasonCategory: "pipeline_error",
				file: "second.ts",
			});

			runtime.answerGitGuardDispatch(second);
			expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toEqual({
				block: false,
			});

			// A new session starts with none: an earlier session's crash is not a
			// file this one can answer unless it writes it (#4725's "start a fresh
			// session" must help).
			runtime.markGitGuardDispatchUnanswered(first, "pipeline_crash");
			runtime.resetForSession();
			expect(runtime.gitGuardUnansweredDispatches).toEqual([]);
		} finally {
			env.cleanup();
		}
	});

	it.each([
		["deleted", (file: string) => fs.rmSync(file)],
		[
			"renamed",
			(file: string) => fs.renameSync(file, file.replace(/c\.ts$/, "d.ts")),
		],
	] as const)(
		"skips a dispatch latch whose file was %s, and gates it again if the file comes back (#4733 r3 F16)",
		(_label, remove) => {
			// RECURRENCE GUARDED: #4733 r3 F16. The latch is keyed by the path its
			// dispatch ran on; once that path is gone no dispatch can answer it, and
			// the gate refused every commit for the session, telling the model to
			// write a file that no longer exists. A record's deleted affected file is
			// resolved the same way (`liveFiles`).
			const env = setupTestEnvironment("pi-lens-git-guard-4733-gone-latch-");
			try {
				const runtime = sessionA(env.tmpDir);
				const cache = new CacheManager(false);
				const crashed = path.join(env.tmpDir, "c.ts");
				fs.writeFileSync(crashed, "x;\n");
				runtime.markGitGuardDispatchUnanswered(crashed, "pipeline_crash");
				expect(evaluateGitGuard(runtime, cache, env.tmpDir).block).toBe(true);

				remove(crashed);
				expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toEqual({
					block: false,
				});

				// The bytes back at that path were never checked: the latch applies.
				fs.writeFileSync(crashed, "y;\n");
				expect(evaluateGitGuard(runtime, cache, env.tmpDir).reason).toContain(
					"pi-lens could not check c.ts",
				);
			} finally {
				env.cleanup();
			}
		},
	);

	it("names a crashed file outside the project without printing its path (#4733 r2 F12)", () => {
		// RECURRENCE GUARDED: #4733 r1 F6's rule, for the new remedy: a path
		// outside the project is not the model's to see.
		const env = setupTestEnvironment("pi-lens-git-guard-4733-outside-latch-");
		try {
			// The latch's file exists: a latch whose file is gone is skipped (F16).
			const proj = path.join(env.tmpDir, "proj");
			fs.mkdirSync(proj);
			const runtime = sessionA(proj);
			const outside = path.join(env.tmpDir, "elsewhere", "x.ts");
			fs.mkdirSync(path.dirname(outside));
			fs.writeFileSync(outside, "x;\n");
			runtime.markGitGuardDispatchUnanswered(outside, "pipeline_crash");
			const reason = evaluateGitGuard(
				runtime,
				new CacheManager(false),
				proj,
			).reason;
			expect(reason).toContain(
				"pi-lens could not check a file outside the project",
			);
			expect(reason).not.toContain("elsewhere");
		} finally {
			env.cleanup();
		}
	});

	it("releases the latch about a record when a passing run deletes that record", () => {
		// RECURRENCE GUARDED: #4733 r1 F4. The passing run (the action the
		// refusal named) deleted the record and left `session_mismatch`
		// latched, so the gate still refused, with a different remedy.
		const env = setupTestEnvironment("pi-lens-git-guard-4733-latch-");
		try {
			const other = path.join(env.tmpDir, "other.ts");
			const testFile = path.join(env.tmpDir, "b.test.ts");
			fs.writeFileSync(other, "const x = 1;\n");
			fs.writeFileSync(testFile, "it('x', () => {});\n");
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			cache.writeCache(
				"turn-end-findings",
				record({
					content: "FAIL 0p/1f",
					hasBlockers: true,
					affectedFiles: [testFile],
					sessionId: "an-earlier-session",
					testFailures: true,
					testFailureContent: "FAIL 0p/1f",
					testFailureFiles: [testFile],
				}),
				env.tmpDir,
			);
			ageRecord(env.tmpDir);
			syncGitGuardRecord(runtime, cache, env.tmpDir, other, "session", true);
			expect(runtime.gitGuardCacheUnknownFor()).toBe("session_mismatch");

			clearGitGuardTestFailure(cache, env.tmpDir, runtime, [testFile]);

			expect(storedData(cache, env.tmpDir)).toBeUndefined();
			expect(runtime.gitGuardCacheUnknownFor()).toBeUndefined();
			expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toEqual({
				block: false,
			});
		} finally {
			env.cleanup();
		}
	});

	it("names the passing run for this session's own fresh record that holds test failures", () => {
		// RECURRENCE GUARDED: #4733 r1 F5 (Sourcery "Test-failure remedy is
		// omitted"). A fresh own record returned before the test sentence, so
		// the refusal named only a write, which clears no test failure.
		const env = setupTestEnvironment("pi-lens-git-guard-4733-own-tests-");
		try {
			const testFile = path.join(env.tmpDir, "b.test.ts");
			fs.writeFileSync(testFile, "it('x', () => {});\n");
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			mergeGitGuardTestFailure(cache, env.tmpDir, runtime, "FAIL 0p/1f", [
				testFile,
			]);
			runtime.markGitGuardCacheUnknown("cache_write_failed", env.tmpDir);

			const reason = evaluateGitGuard(runtime, cache, env.tmpDir).reason ?? "";

			expect(reason).toContain(
				"Run the failing tests again: a passing run clears them.",
			);
			expect(reason).toContain("Write the affected files again");
		} finally {
			env.cleanup();
		}
	});

	it("does not print a blocker path outside the project in the refusal", () => {
		// RECURRENCE GUARDED: #4733 r1 F6. `toProjectRelativePath` returns an
		// outside path unchanged, so the model-facing refusal printed it.
		const env = setupTestEnvironment("pi-lens-git-guard-4733-outside-");
		try {
			const inside = path.join(env.tmpDir, "a.ts");
			const outside = path.join(
				path.dirname(env.tmpDir),
				"outside-4733-probe",
				"secret.ts",
			);
			fs.writeFileSync(inside, "const x = 1;\n");
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			const text = composerSections([inside, outside]);
			cache.writeCache(
				"turn-end-findings",
				record({
					content: text,
					blockerContent: text,
					hasBlockers: true,
					affectedFiles: [inside, outside],
					blockingFiles: [inside, outside],
					sessionId: "an-earlier-session",
				}),
				env.tmpDir,
			);

			const reason = evaluateGitGuard(runtime, cache, env.tmpDir).reason ?? "";

			expect(reason).toContain(
				"The record names blockers in a.ts and 1 file outside the project that pi-lens cannot confirm.",
			);
			expect(reason).not.toContain("outside-4733-probe");
		} finally {
			env.cleanup();
		}
	});

	it("refuses a no-blocker claim beside test-failure text or files", () => {
		// RECURRENCE GUARDED: #4733 r1 F7. The contradiction refusal read
		// `testFailures` and `blockerContent` only, so `hasBlockers: false`
		// beside a test failure's text or files was admitted and allowed.
		const env = setupTestEnvironment("pi-lens-git-guard-4733-claim-");
		try {
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			for (const extra of [
				{ testFailureContent: "FAIL 0p/1f" },
				{ testFailureFiles: [path.join(env.tmpDir, "b.test.ts")] },
			]) {
				cache.writeCache(
					"turn-end-findings",
					record({ content: "x", hasBlockers: false, ...extra }),
					env.tmpDir,
				);
				expect(
					evaluateGitGuard(runtime, cache, env.tmpDir),
					Object.keys(extra)[0],
				).toMatchObject({ block: true, unknown: true });
			}
		} finally {
			env.cleanup();
		}
	});
});

/** The session that wrote a record before this one. */
const EARLIER = "an-earlier-session";

/** Another session's record: one composer section per file, theirs. */
function foreignRecord(
	files: readonly string[],
	sessionId = EARLIER,
): TurnEndFindingsCache {
	const text = composerSections(files);
	return record({
		content: text,
		blockerContent: text,
		hasBlockers: true,
		affectedFiles: [...files],
		blockingFiles: [...files],
		sessionId,
		consumed: true,
	});
}

/** A blocker in `file` in this session's map, as a blocking write records it. */
function ownBlocker(runtime: RuntimeCoordinator, file: string): void {
	const summary = productionSummary(file, ["own issue is unsafe"]);
	runtime.recordInlineBlockers(file, summary);
	runtime.updateGitGuardStatus(true, summary);
}

/** This session's own fix of `file`: the map entry goes, the latch follows. */
function ownFix(runtime: RuntimeCoordinator, file: string): void {
	runtime.clearInlineBlockers(file);
	runtime.updateGitGuardStatus(false, "");
}

/** Every owner of a stored record's blocker sections, top level first. */
function owners(data: Partial<TurnEndFindingsCache> | undefined): unknown[] {
	return data
		? [
				data.sessionId,
				...(data.carriedBlockers ?? []).map((partition) => partition.sessionId),
			]
		: [];
}

/** The metadata of the newest latency phase rows named `phase`. */
function phaseRows(phase: string): Array<Record<string, unknown> | undefined> {
	return getRecentLoggedPhases()
		.filter((row) => row.phase === phase)
		.map((row) => row.metadata);
}

/** The newest latency phase row, a mark for `phaseRowsSince`. */
function latestPhaseRow(): object | undefined {
	return getRecentLoggedPhases(1)[0];
}

/**
 * The metadata of the rows named `phase` logged after `mark`, newest first.
 * The ring keeps five rows, so a mark that scrolled out reads every row: an
 * expectation of no rows then fails loudly rather than passing.
 */
function phaseRowsSince(
	phase: string,
	mark: object | undefined,
): Array<Record<string, unknown> | undefined> {
	const rows = getRecentLoggedPhases();
	const end = mark ? rows.findIndex((row) => row === mark) : -1;
	return (end === -1 ? rows : rows.slice(0, end))
		.filter((row) => row.phase === phase)
		.map((row) => row.metadata);
}

/** A project lane's report that names no file: trivy's CRITICAL CVE block. */
const TRIVY_LANE =
	"🔴 STOP — CRITICAL dependency CVEs (trivy, 1h old). Upgrade before shipping:\n  CVE-2026-0001 (pkg@1.0.0) — upgrade to 1.0.1 or later";

/** A fixture with `<PROJECT>` bound to `root`, its blocked files written live. */
function boundFixture(name: string, root: string): unknown {
	for (const file of ["src/target.ts", "src/other.ts"]) {
		fs.mkdirSync(path.join(root, "src"), { recursive: true });
		fs.writeFileSync(path.join(root, file), "debugger;\n");
	}
	return JSON.parse(
		fs
			.readFileSync(
				path.join(import.meta.dirname, "../fixtures/git-guard-records", name),
				"utf-8",
			)
			.replaceAll("<PROJECT>", root),
	);
}

describe("#4738: each session's blocker sections keep their owner", () => {
	it("keeps another session's section through this session's own blocker write and its fix, and refuses until that file is re-checked", () => {
		// RECURRENCE GUARDED: #4738. The entries branch wrote this session's map
		// as the whole record, so another session's blocker in a.ts was gone
		// once this session fixed b.ts, and the commit ran.
		const env = setupTestEnvironment("pi-lens-git-guard-4738-entries-");
		try {
			const [theirs, mine] = ["a.ts", "b.ts"].map((name) =>
				path.join(env.tmpDir, name),
			);
			for (const file of [theirs, mine]) fs.writeFileSync(file, "x;\n");
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			writeGitGuardRecord(cache, runtime, env.tmpDir, foreignRecord([theirs]));

			ownBlocker(runtime, mine);
			syncGitGuardRecord(runtime, cache, env.tmpDir, mine);

			const shared = storedData(cache, env.tmpDir);
			expect(owners(shared)).toEqual(["session-A", EARLIER]);
			expect(shared?.blockerContent).toContain("own issue is unsafe");
			expect(shared?.carriedBlockers?.[0]?.blockerContent).toBe(
				composerSections([theirs]),
			);
			// This session's new blocker is delivered, though the record it was
			// written over had been.
			expect(
				consumeTurnEndFindings(cache, env.tmpDir, runtime)?.messages?.[0]
					?.content,
			).toContain("own issue is unsafe");

			ownFix(runtime, mine);
			syncGitGuardRecord(runtime, cache, env.tmpDir, mine);

			expect(owners(storedData(cache, env.tmpDir))).toEqual([EARLIER]);
			// What is left is the other session's, already in the record: nothing
			// is delivered again (#4725's delivery rule).
			expect(
				consumeTurnEndFindings(cache, env.tmpDir, runtime),
			).toBeUndefined();
			const refusal = evaluateGitGuard(runtime, cache, env.tmpDir);
			expect(refusal).toMatchObject({ block: true, unknown: true });
			expect(refusal.reason).toContain("session_mismatch");
			expect(refusal.reason).toContain("The record names blockers in a.ts ");

			syncGitGuardRecord(runtime, cache, env.tmpDir, theirs, "session", true);

			expect(storedData(cache, env.tmpDir)).toBeUndefined();
			expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toEqual({
				block: false,
			});
		} finally {
			env.cleanup();
		}
	});

	it("drops only this session's own sections from a shared record at a settled turn end, whichever partition holds them", () => {
		// RECURRENCE GUARDED: #4738. The retire read the record's one owner: a
		// shared record under this session's id was deleted with the other
		// session's blocker in it, and one under the other's id kept this
		// session's answered sections for good.
		const env = setupTestEnvironment("pi-lens-git-guard-4738-retire-");
		try {
			const [theirs, mine] = ["a.ts", "b.ts"].map((name) =>
				path.join(env.tmpDir, name),
			);
			for (const file of [theirs, mine]) fs.writeFileSync(file, "x;\n");
			const cache = new CacheManager(false);
			const mineCarried: BlockerPartition = {
				sessionId: "session-A",
				blockerContent: composerSections([mine]),
				blockingFiles: [mine],
			};
			const theirsCarried: BlockerPartition = {
				sessionId: EARLIER,
				blockerContent: composerSections([theirs]),
				blockingFiles: [theirs],
			};
			const cells: Array<[string, TurnEndFindingsCache]> = [
				[
					"this session's record carrying theirs",
					record({
						...foreignRecord([mine], "session-A"),
						affectedFiles: [theirs, mine],
						carriedBlockers: [theirsCarried],
					}),
				],
				[
					"their record carrying this session's",
					record({
						...foreignRecord([theirs]),
						affectedFiles: [theirs, mine],
						carriedBlockers: [mineCarried],
					}),
				],
			];
			const observed = cells.map(([label, data]) => {
				const runtime = sessionA(env.tmpDir);
				writeGitGuardRecord(cache, runtime, env.tmpDir, data);
				const retired = retireSettledGitGuardRecord(runtime, cache, env.tmpDir);
				const after = storedData(cache, env.tmpDir);
				const delivered = consumeTurnEndFindings(cache, env.tmpDir, runtime);
				cache.clearCache("turn-end-findings", env.tmpDir);
				return [
					label,
					retired,
					owners(after),
					after?.blockerContent,
					phaseRows("sections_dropped")[0],
					delivered,
				];
			});
			expect(observed).toEqual(
				cells.map(([label]) => [
					label,
					false,
					[EARLIER],
					composerSections([theirs]),
					{ by: "turn_end", basis: "own_session" },
					// Nothing new to deliver: the sections kept were delivered.
					undefined,
				]),
			);
		} finally {
			env.cleanup();
		}
	});

	it("keeps a file another session still blocks on among the affected files after this session's own fix of it", () => {
		// RECURRENCE GUARDED: #4738, the affected-files trim. This session's fix
		// of a.ts took a.ts out of `affectedFiles` while the other session's a.ts
		// section stayed; with the record's other file deleted, that session's
		// gate read every affected file as resolved and ALLOWED its commit.
		const env = setupTestEnvironment("pi-lens-git-guard-4738-affected-");
		try {
			const [shared, deleted] = ["a.ts", "d.ts"].map((name) =>
				path.join(env.tmpDir, name),
			);
			for (const file of [shared, deleted]) fs.writeFileSync(file, "x;\n");
			const runtime = sessionA(env.tmpDir);
			const earlier = new RuntimeCoordinator();
			earlier.projectRoot = env.tmpDir;
			earlier.setTelemetryIdentity({ sessionId: EARLIER });
			for (const owner of [runtime, earlier]) owner.bumpFileSeq(deleted);
			const cache = new CacheManager(false);
			writeGitGuardRecord(
				cache,
				runtime,
				env.tmpDir,
				record({
					...foreignRecord([shared]),
					affectedFiles: [shared, deleted],
					carriedBlockers: [
						{
							sessionId: "session-A",
							blockerContent: composerSections([shared]),
							blockingFiles: [shared],
						},
					],
				}),
			);
			fs.rmSync(deleted);

			syncGitGuardRecord(runtime, cache, env.tmpDir, shared);

			expect(owners(storedData(cache, env.tmpDir))).toEqual([EARLIER]);
			// The other session's own gate: its a.ts section still refuses.
			expect(evaluateGitGuard(earlier, cache, env.tmpDir)).toMatchObject({
				block: true,
			});
			expect(storedData(cache, env.tmpDir)?.affectedFiles).toContain(shared);
		} finally {
			env.cleanup();
		}
	});

	it("takes this session's own fixed section out of another session's record it rides in", () => {
		// RECURRENCE GUARDED: #4738, the latch beside a carried own section. A
		// write to another session's record that took nothing of THEIRS back
		// latched `session_mismatch` and wrote nothing, so this session's own
		// fixed section stayed in the record, refusing on a blocker it answered.
		const env = setupTestEnvironment("pi-lens-git-guard-4738-own-carried-");
		try {
			const [theirs, mine] = ["a.ts", "b.ts"].map((name) =>
				path.join(env.tmpDir, name),
			);
			for (const file of [theirs, mine]) fs.writeFileSync(file, "x;\n");
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			writeGitGuardRecord(
				cache,
				runtime,
				env.tmpDir,
				record({
					...foreignRecord([theirs]),
					affectedFiles: [theirs, mine],
					carriedBlockers: [
						{
							sessionId: "session-A",
							blockerContent: composerSections([mine]),
							blockingFiles: [mine],
						},
					],
				}),
			);

			syncGitGuardRecord(runtime, cache, env.tmpDir, mine);

			const after = storedData(cache, env.tmpDir);
			expect(owners(after)).toEqual([EARLIER]);
			expect(after?.blockerContent).toBe(composerSections([theirs]));
			expect(evaluateGitGuard(runtime, cache, env.tmpDir).reason).toContain(
				"The record names blockers in a.ts ",
			);
		} finally {
			env.cleanup();
		}
	});

	it("leaves this session's own record that holds a test failure to the rule before #4738", () => {
		// RECURRENCE GUARDED: #4738, the partition retire's scope. It runs for a
		// record shared between sessions; on a record this session owns whole the
		// rule before it decides (a test failure keeps the record untouched), so
		// the partition retire must not strip its blocker text.
		const env = setupTestEnvironment("pi-lens-git-guard-4738-own-tests-");
		try {
			const mine = path.join(env.tmpDir, "b.ts");
			fs.writeFileSync(mine, "x;\n");
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			const data = record({
				...foreignRecord([mine], "session-A"),
				testFailures: true,
				testFailureContent: "FAIL 0p/1f",
			});
			writeGitGuardRecord(cache, runtime, env.tmpDir, data);

			expect(retireSettledGitGuardRecord(runtime, cache, env.tmpDir)).toBe(
				false,
			);
			expect(storedData(cache, env.tmpDir)?.blockerContent).toBe(
				data.blockerContent,
			);
		} finally {
			env.cleanup();
		}
	});

	it("keeps another session's text no file owns, byte for byte, when a settled turn end drops this session's sections", () => {
		// RECURRENCE GUARDED: #4738, the partition retire on text it cannot
		// attribute. Another session's turn end leads the record with a project
		// lane's report beside its file sections; dropping it as "nothing left"
		// deleted the record once this session's own sections left.
		const env = setupTestEnvironment("pi-lens-git-guard-4738-retire-lane-");
		try {
			const [theirs, mine] = ["a.ts", "b.ts"].map((name) =>
				path.join(env.tmpDir, name),
			);
			for (const file of [theirs, mine]) fs.writeFileSync(file, "x;\n");
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			const theirText = `${composerSections([theirs])}\n\n🔴 STOP — CRITICAL dependency CVEs (trivy, 1h old). Upgrade before shipping:\n  CVE-2026-0001 (pkg@1.0.0) — upgrade to 1.0.1 or later`;
			writeGitGuardRecord(
				cache,
				runtime,
				env.tmpDir,
				record({
					...foreignRecord([theirs]),
					content: theirText,
					blockerContent: theirText,
					affectedFiles: [theirs, mine],
					carriedBlockers: [
						{
							sessionId: "session-A",
							blockerContent: composerSections([mine]),
							blockingFiles: [mine],
						},
					],
				}),
			);

			expect(retireSettledGitGuardRecord(runtime, cache, env.tmpDir)).toBe(
				false,
			);
			const after = storedData(cache, env.tmpDir);
			expect(owners(after)).toEqual([EARLIER]);
			expect(after?.blockerContent).toBe(theirText);
		} finally {
			env.cleanup();
		}
	});

	it("drops another session's section whose file is gone, at a write and at a settled turn end", () => {
		// RECURRENCE GUARDED: #4738, the gone-file cell. Another session's
		// section answers only to a whole-file check of its file, and a deleted
		// file has none, so once writers carry it the record would refuse every
		// commit for good. A gone file is resolved, as the gate's
		// `affected_files_resolved` rule says for a record's own files.
		const env = setupTestEnvironment("pi-lens-git-guard-4738-gone-");
		try {
			const [gone, live, clean] = ["a.ts", "b.ts", "c.ts"].map((name) =>
				path.join(env.tmpDir, name),
			);
			for (const file of [gone, live, clean]) fs.writeFileSync(file, "x;\n");
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);

			writeGitGuardRecord(cache, runtime, env.tmpDir, foreignRecord([gone]));
			fs.rmSync(gone);
			syncGitGuardRecord(runtime, cache, env.tmpDir, clean, "session", true);
			expect(storedData(cache, env.tmpDir)).toBeUndefined();
			expect(runtime.gitGuardCacheUnknownFor()).toBeUndefined();
			expect(phaseRows("record_retired")[0]).toEqual({
				by: "write",
				basis: "file_gone",
			});

			fs.writeFileSync(gone, "x;\n");
			writeGitGuardRecord(
				cache,
				runtime,
				env.tmpDir,
				foreignRecord([gone, live]),
			);
			fs.rmSync(gone);
			syncGitGuardRecord(runtime, cache, env.tmpDir, clean, "session", true);
			const trimmed = storedData(cache, env.tmpDir);
			expect(owners(trimmed)).toEqual([EARLIER]);
			expect(trimmed?.blockerContent).not.toContain("issue 1 is unsafe");
			expect(trimmed?.blockerContent).toContain("issue 2 is unsafe");
			expect(phaseRows("sections_dropped")[0]).toEqual({
				by: "write",
				basis: "file_gone",
			});

			fs.writeFileSync(gone, "x;\n");
			writeGitGuardRecord(
				cache,
				runtime,
				env.tmpDir,
				foreignRecord([gone, live]),
			);
			fs.rmSync(gone);
			expect(retireSettledGitGuardRecord(runtime, cache, env.tmpDir)).toBe(
				false,
			);
			const after = storedData(cache, env.tmpDir);
			expect(owners(after)).toEqual([EARLIER]);
			expect(after?.blockerContent).not.toContain("issue 1 is unsafe");
			expect(after?.blockerContent).toContain("issue 2 is unsafe");
			expect(phaseRows("sections_dropped")[0]).toEqual({
				by: "turn_end",
				basis: "file_gone",
			});

			// RECURRENCE GUARDED: #4941 r2 (verify V1): the retire below answers
			// the project's latched record failure; with its clear deleted, 322
			// tests stayed green and every later commit was refused as unknown.
			runtime.markGitGuardCacheUnknown("cache_write_failed", env.tmpDir);
			fs.rmSync(live);
			expect(retireSettledGitGuardRecord(runtime, cache, env.tmpDir)).toBe(
				true,
			);
			expect(phaseRows("record_retired")[0]).toEqual({
				by: "turn_end",
				basis: "file_gone",
			});
			expect(evaluateGitGuard(runtime, cache, env.tmpDir).block).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("leaves a shared record holding only a test failure with its stored owner, and logs what the settled turn end dropped", () => {
		// RECURRENCE GUARDED: #4738, the partition retire's remnant. With every
		// blocker section gone the record kept its test failure under this
		// session's id, so this session's gate judged another session's record
		// as its own; and the drop that left it logged no row.
		const env = setupTestEnvironment("pi-lens-git-guard-4738-remnant-");
		try {
			const [gone, mine] = ["a.ts", "b.ts"].map((name) =>
				path.join(env.tmpDir, name),
			);
			for (const file of [gone, mine]) fs.writeFileSync(file, "x;\n");
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			writeGitGuardRecord(
				cache,
				runtime,
				env.tmpDir,
				record({
					...foreignRecord([gone]),
					affectedFiles: [gone, mine],
					testFailures: true,
					testFailureContent: "FAIL 0p/1f",
					carriedBlockers: [
						{
							sessionId: "session-A",
							blockerContent: composerSections([mine]),
							blockingFiles: [mine],
						},
					],
				}),
			);
			fs.rmSync(gone);

			expect(retireSettledGitGuardRecord(runtime, cache, env.tmpDir)).toBe(
				false,
			);

			const after = storedData(cache, env.tmpDir);
			expect(after?.sessionId).toBe(EARLIER);
			expect(after?.blockerContent).toBeUndefined();
			expect(after?.carriedBlockers).toBeUndefined();
			expect(after?.content).toBe("FAIL 0p/1f");
			expect(evaluateGitGuard(runtime, cache, env.tmpDir).reason).toContain(
				"(session_mismatch)",
			);
			expect(phaseRows("sections_dropped").slice(0, 2)).toEqual([
				{ by: "turn_end", basis: "file_gone" },
				{ by: "turn_end", basis: "own_session" },
			]);
		} finally {
			env.cleanup();
		}
	});

	it("hands the turn-end composer every other session's sections but this session's and a gone file's, keeps text no file owns whole, and logs no drop at the read", () => {
		// RECURRENCE GUARDED: #4738, the composer. Its write is this session's
		// whole evidence, so it replaced the record; what it may replace is this
		// session's partition, and nothing else. #4750: another session's text
		// no file owns (a project lane's report) was replaced too, though this
		// session's lanes had not re-checked it, and the read logged its drop
		// though no write had happened.
		const env = setupTestEnvironment("pi-lens-git-guard-4738-composer-");
		try {
			const [theirs, mine, gone] = ["a.ts", "b.ts", "g.ts"].map((name) =>
				path.join(env.tmpDir, name),
			);
			for (const file of [theirs, mine]) fs.writeFileSync(file, "x;\n");
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			const theirText = `${composerSections([theirs])}\n\n${TRIVY_LANE}`;
			writeGitGuardRecord(
				cache,
				runtime,
				env.tmpDir,
				record({
					...foreignRecord([theirs]),
					blockerContent: theirText,
					affectedFiles: [theirs, mine, gone],
					carriedBlockers: [
						{
							sessionId: "session-A",
							blockerContent: composerSections([mine]),
							blockingFiles: [mine],
						},
						{
							sessionId: "a-third-session",
							blockerContent: composerSections([gone]),
							blockingFiles: [gone],
						},
					],
				}),
			);
			const mark = latestPhaseRow();

			const { stored, carried, dropped } = readTurnEndGuardRecord(
				cache,
				runtime,
				env.tmpDir,
			);

			expect(owners(stored)).toEqual([EARLIER, "session-A", "a-third-session"]);
			// Their whole text rides, the report beside its file section included,
			// and the stamp it carries from now on starts its window.
			expect(carried).toEqual([
				{
					sessionId: EARLIER,
					blockerContent: theirText,
					blockingFiles: [theirs],
					blockerWrittenAt: expect.any(Number),
				},
			]);
			expect(dropped).toEqual({ gone: true, noFile: false });
			expect(phaseRowsSince("sections_dropped", mark)).toEqual([]);
		} finally {
			env.cleanup();
		}
	});

	it("refuses this session's own record while it carries another session's section, and names both files", () => {
		// RECURRENCE GUARDED: #4738. The gate's session check read the record's
		// one owner, so a record under this session's id judged another
		// session's carried blocker as this session's own evidence.
		const env = setupTestEnvironment("pi-lens-git-guard-4738-gate-");
		try {
			const [theirs, mine] = ["a.ts", "b.ts"].map((name) =>
				path.join(env.tmpDir, name),
			);
			for (const file of [theirs, mine]) fs.writeFileSync(file, "x;\n");
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			writeGitGuardRecord(
				cache,
				runtime,
				env.tmpDir,
				record({
					...foreignRecord([mine], "session-A"),
					consumed: false,
					affectedFiles: [theirs, mine],
					carriedBlockers: [
						{
							sessionId: EARLIER,
							blockerContent: composerSections([theirs]),
							blockingFiles: [theirs],
						},
					],
				}),
			);

			const refusal = evaluateGitGuard(runtime, cache, env.tmpDir);

			expect(refusal).toMatchObject({ block: true, unknown: true });
			expect(refusal.reason).toContain("(session_mismatch)");
			expect(refusal.reason).toContain(
				"The record names blockers in b.ts, a.ts ",
			);
		} finally {
			env.cleanup();
		}
	});

	it("refuses every carried-blocker form no writer produces", () => {
		// Fail closed on the unrecognised (principles §1): each form below is
		// admitted by no writer, so the gate reads it as no record at all.
		const env = setupTestEnvironment("pi-lens-git-guard-4738-malformed-");
		try {
			const file = path.join(env.tmpDir, "a.ts");
			fs.writeFileSync(file, "x;\n");
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			const partition = {
				sessionId: EARLIER,
				blockerContent: composerSections([file]),
				blockingFiles: [file],
			};
			const own = foreignRecord([file], "session-A");
			const forms: Array<[string, Record<string, unknown>]> = [
				["an empty list", { ...own, carriedBlockers: [] }],
				["not a list", { ...own, carriedBlockers: partition }],
				[
					"the record's own owner",
					{
						...own,
						carriedBlockers: [{ ...partition, sessionId: "session-A" }],
					},
				],
				[
					"a duplicate owner",
					{ ...own, carriedBlockers: [partition, partition] },
				],
				[
					"no text",
					{ ...own, carriedBlockers: [{ ...partition, blockerContent: "" }] },
				],
				[
					"files not a list",
					{ ...own, carriedBlockers: [{ ...partition, blockingFiles: file }] },
				],
				[
					"an owner not a string",
					{ ...own, carriedBlockers: [{ ...partition, sessionId: 7 }] },
				],
				[
					"no top-level section",
					{ ...own, blockerContent: "", carriedBlockers: [partition] },
				],
				[
					"one file not a string",
					{
						...own,
						carriedBlockers: [{ ...partition, blockingFiles: [file, 7] }],
					},
				],
				["a null partition", { ...own, carriedBlockers: [null] }],
				[
					// The gate ALLOWS on a no-blocker claim before any shape check, so
					// a carried section must void the claim, not only the shape.
					"a no-blocker claim beside a carried section",
					{
						...own,
						content: "",
						blockerContent: "",
						blockingFiles: [],
						hasBlockers: false,
						carriedBlockers: [partition],
					},
				],
			];
			const observed = forms.map(([label, data]) => {
				cache.writeCache("turn-end-findings", data, env.tmpDir);
				return [label, evaluateGitGuard(runtime, cache, env.tmpDir).reason];
			});
			expect(observed).toEqual(
				forms.map(([label]) => [
					label,
					expect.stringContaining("(cache_malformed)"),
				]),
			);
		} finally {
			env.cleanup();
		}
	});

	it("keeps another session's carried sections through a test failure and its passing run", () => {
		// RECURRENCE GUARDED: #4738. The test-failure merge rebuilt the record
		// from its top-level fields, so a carried partition would be lost.
		const env = setupTestEnvironment("pi-lens-git-guard-4738-tests-");
		try {
			const [theirs, mine] = ["a.ts", "b.ts"].map((name) =>
				path.join(env.tmpDir, name),
			);
			const testFile = path.join(env.tmpDir, "c.test.ts");
			for (const file of [theirs, mine, testFile])
				fs.writeFileSync(file, "x;\n");
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			const theirsCarried: BlockerPartition = {
				sessionId: EARLIER,
				blockerContent: composerSections([theirs]),
				blockingFiles: [theirs],
			};
			writeGitGuardRecord(
				cache,
				runtime,
				env.tmpDir,
				record({
					...foreignRecord([mine], "session-A"),
					affectedFiles: [theirs, mine],
					carriedBlockers: [theirsCarried],
				}),
			);

			mergeGitGuardTestFailure(cache, env.tmpDir, runtime, "FAIL 0p/1f", [
				testFile,
			]);
			expect(storedData(cache, env.tmpDir)?.carriedBlockers).toEqual([
				theirsCarried,
			]);

			clearGitGuardTestFailure(cache, env.tmpDir, runtime, [testFile]);
			expect(storedData(cache, env.tmpDir)?.carriedBlockers).toEqual([
				theirsCarried,
			]);
		} finally {
			env.cleanup();
		}
	});

	it("keeps a carried section's file affected through a passing test run, so its owner's gate still checks it", () => {
		// RECURRENCE GUARDED: #4738, the test-clear writer's affected files. It
		// kept only the top level's blocking files, so the carried a.ts left
		// `affectedFiles`; once this session fixed its own b.ts and the still
		// failing test file was deleted, the other session's gate read every
		// affected file as resolved and ALLOWED with its a.ts blocker standing.
		const env = setupTestEnvironment("pi-lens-git-guard-4738-tests-affected-");
		try {
			const [theirs, mine, passing, failing] = [
				"a.ts",
				"b.ts",
				"c.test.ts",
				"d.test.ts",
			].map((name) => path.join(env.tmpDir, name));
			for (const file of [theirs, mine, passing, failing])
				fs.writeFileSync(file, "x;\n");
			const runtime = sessionA(env.tmpDir);
			const earlier = new RuntimeCoordinator();
			earlier.projectRoot = env.tmpDir;
			earlier.setTelemetryIdentity({ sessionId: EARLIER });
			for (const owner of [runtime, earlier]) owner.bumpFileSeq(failing);
			const cache = new CacheManager(false);
			writeGitGuardRecord(
				cache,
				runtime,
				env.tmpDir,
				record({
					...foreignRecord([mine], "session-A"),
					affectedFiles: [theirs, mine],
					carriedBlockers: [
						{
							sessionId: EARLIER,
							blockerContent: composerSections([theirs]),
							blockingFiles: [theirs],
						},
					],
				}),
			);
			mergeGitGuardTestFailure(cache, env.tmpDir, runtime, "FAIL 0p/2f", [
				passing,
				failing,
			]);
			clearGitGuardTestFailure(cache, env.tmpDir, runtime, [passing]);
			ownFix(runtime, mine);
			syncGitGuardRecord(runtime, cache, env.tmpDir, mine);
			fs.rmSync(failing);

			expect(owners(storedData(cache, env.tmpDir))).toEqual([EARLIER]);
			expect(evaluateGitGuard(earlier, cache, env.tmpDir)).toMatchObject({
				block: true,
			});
		} finally {
			env.cleanup();
		}
	});

	it("reads every released record shape as one owner's sections, and this version's as each owner's", () => {
		// Fixture corpus (principles §2), the old-record read rule: a record with
		// no `carriedBlockers` (every shape released before #4738) is one
		// partition owned by its `sessionId`, so another session's composer
		// carries a released record's sections under that id. #4750: text no file
		// owns (4.2.1's) is carried too, its window starting at that first carry,
		// for a released record bears no write stamp. The 4.4.4 lens-guard record
		// and the #4738 shared record were written by the production writers in
		// the #4738 tier-2 run, the #4750 stamped one by this version's composer
		// (`turn-end-cap-consumed-state.test.ts`, the dedupe cell), their project
		// path made `<PROJECT>`.
		const corpus: Array<[string, string[]]> = [
			["3.8.74-turn-end-findings.json", []],
			["4.2.1-turn-end-findings.json", ["v4-2-1-session"]],
			["4.4.4-advisory-turn-end-findings.json", []],
			["4.4.4-guard-off-turn-end-findings.json", []],
			["4.4.4-lens-guard-blocker-turn-end-findings.json", ["v4-4-4-session"]],
			[
				"4738-carried-turn-end-findings.json",
				["v4738-second-session", "v4738-first-session"],
			],
			// Its first session's CVE report names no file, and the clock is set
			// past its window (`readStampedFixtureAt`): only the second session's
			// file section is carried.
			["4750-stamped-turn-end-findings.json", ["v4750-second-session"]],
		];
		const env = setupTestEnvironment("pi-lens-git-guard-4738-corpus-");
		try {
			const cache = new CacheManager(false);
			const observed = corpus.map(([name]) => {
				const read = () => {
					const runtime = sessionA(env.tmpDir);
					const { carried } = readTurnEndGuardRecord(
						cache,
						runtime,
						env.tmpDir,
					);
					const verdict = evaluateGitGuard(runtime, cache, env.tmpDir);
					return [
						name,
						carried.map((partition) => partition.sessionId),
						verdict.block,
					];
				};
				if (name === STAMPED_FIXTURE)
					return readStampedFixtureAt(
						cache,
						env.tmpDir,
						DEFAULT_MAX_AGE_MS + 60_000,
						read,
					);
				cache.writeCache(
					"turn-end-findings",
					boundFixture(name, env.tmpDir),
					env.tmpDir,
				);
				return read();
			});
			expect(observed).toEqual(
				corpus.map(([name, carried]) => [
					name,
					carried,
					// Only the advisory record claims no blocker.
					!name.includes("advisory"),
				]),
			);
		} finally {
			env.cleanup();
		}
	});
});

const STAMPED_FIXTURE = "4750-stamped-turn-end-findings.json";

/**
 * Store the stamped fixture and run `read` with the clock frozen at its
 * first session's stamp plus `sinceStamp` (#4762 review F1): the fixture's
 * stamps are real times, so a read at the machine's own clock would carry its
 * report before 2026-10-22T20:20Z and drop it after.
 */
function readStampedFixtureAt<T>(
	cache: CacheManager,
	cwd: string,
	sinceStamp: number,
	read: () => T,
): T {
	const data = boundFixture(STAMPED_FIXTURE, cwd) as TurnEndFindingsCache;
	const stamp = data.carriedBlockers?.[0]?.blockerWrittenAt ?? Number.NaN;
	expect(Number.isFinite(stamp)).toBe(true);
	vi.useFakeTimers({ toFake: ["Date"], now: stamp + sinceStamp });
	try {
		cache.writeCache("turn-end-findings", data, cwd);
		return read();
	} finally {
		vi.useRealTimers();
	}
}

/**
 * The metadata of the `phase` rows the real latency sink saved for `cwd`, in
 * write order. The worker's `PI_LENS_HOME` is the test setup's per-worker
 * directory, so the file is this test file's own.
 */
async function savedRows(cwd: string, phase: string): Promise<unknown[]> {
	await flushLatencyLog();
	const read = readNdjsonRows(getLatencyLogPath());
	// A corrupt line would hide a row the claim counts, so it reds here with the count.
	expect(read.skipped, "unparseable latency.log lines").toBe(0);
	const key = normalizeFilePath(cwd);
	return read.rows
		.filter((row) => row.phase === phase && row.filePath === key)
		.map((row) => row.metadata);
}

/** Older than the gate's freshness window, by a minute. */
const EXPIRED = (): number => Date.now() - 31 * 60_000;

/** Another session's partition: TRIVY_LANE beside `files`' sections. */
function laneRecord(
	files: readonly string[],
	blockerWrittenAt: number | undefined,
): TurnEndFindingsCache {
	const text = [composerSections(files), TRIVY_LANE]
		.filter(Boolean)
		.join("\n\n");
	return record({
		content: text,
		blockerContent: text,
		hasBlockers: true,
		affectedFiles: [...files],
		blockingFiles: [...files],
		sessionId: EARLIER,
		blockerWrittenAt,
		consumed: true,
	});
}

/** A session other than A and EARLIER, reading the record at its turn end. */
function thirdSession(cwd: string): RuntimeCoordinator {
	const runtime = new RuntimeCoordinator();
	runtime.projectRoot = cwd;
	runtime.setTelemetryIdentity({ sessionId: "a-third-session" });
	return runtime;
}

describe("#4750: another session's text no file owns expires by its own write stamp", () => {
	it("carries the stamped fixture's lane report inside its window and drops it after, whatever the machine's date", () => {
		// RECURRENCE GUARDED: #4762 review F1. The corpus row read the fixture at
		// the machine's clock, so its verdict changed at 2026-10-22T20:20Z.
		const env = setupTestEnvironment("pi-lens-git-guard-4750-fixture-clock-");
		try {
			const cache = new CacheManager(false);
			const carriedAt = (sinceStamp: number): unknown =>
				readStampedFixtureAt(cache, env.tmpDir, sinceStamp, () => {
					const { carried, dropped } = readTurnEndGuardRecord(
						cache,
						sessionA(env.tmpDir),
						env.tmpDir,
					);
					return [carried.map((partition) => partition.sessionId), dropped];
				});

			expect([
				carriedAt(60_000),
				carriedAt(DEFAULT_MAX_AGE_MS),
				carriedAt(DEFAULT_MAX_AGE_MS + 1),
			]).toEqual([
				[
					["v4750-second-session", "v4750-first-session"],
					{ gone: false, noFile: false },
				],
				[
					["v4750-second-session", "v4750-first-session"],
					{ gone: false, noFile: false },
				],
				[["v4750-second-session"], { gone: false, noFile: true }],
			]);
		} finally {
			env.cleanup();
		}
	});

	it("hands the composer an expired partition's file sections only, and logs nothing at the read", () => {
		// RECURRENCE GUARDED: #4750. The expiry arm: once the owner's stamp is
		// past the window, its text no file owns is dropped and reported to the
		// writer, while a section of a live file stays the owner's.
		const env = setupTestEnvironment("pi-lens-git-guard-4750-expired-read-");
		try {
			const theirs = path.join(env.tmpDir, "a.ts");
			fs.writeFileSync(theirs, "x;\n");
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			const writtenAt = EXPIRED();
			writeGitGuardRecord(
				cache,
				runtime,
				env.tmpDir,
				laneRecord([theirs], writtenAt),
			);
			const mark = latestPhaseRow();

			const { carried, dropped } = readTurnEndGuardRecord(
				cache,
				runtime,
				env.tmpDir,
			);

			expect(carried).toEqual([
				{
					sessionId: EARLIER,
					blockerContent: composerSections([theirs]),
					blockingFiles: [theirs],
					blockerWrittenAt: writtenAt,
				},
			]);
			expect(dropped).toEqual({ gone: false, noFile: true });
			expect(phaseRowsSince("sections_dropped", mark)).toEqual([]);
		} finally {
			env.cleanup();
		}
	});

	it("a settled turn end drops another session's expired text no file owns, keeps its live file section, and logs one row", () => {
		// RECURRENCE GUARDED: #4750. The settled turn end kept another session's
		// text no file owns forever: no file to re-check, and no expiry.
		const env = setupTestEnvironment("pi-lens-git-guard-4750-settled-");
		try {
			const theirs = path.join(env.tmpDir, "a.ts");
			fs.writeFileSync(theirs, "x;\n");
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			writeGitGuardRecord(
				cache,
				runtime,
				env.tmpDir,
				laneRecord([theirs], EXPIRED()),
			);
			const mark = latestPhaseRow();

			expect(retireSettledGitGuardRecord(runtime, cache, env.tmpDir)).toBe(
				false,
			);

			const stored = storedData(cache, env.tmpDir);
			expect(owners(stored)).toEqual([EARLIER]);
			expect(stored?.blockerContent).toBe(composerSections([theirs]));
			expect(phaseRowsSince("sections_dropped", mark)).toEqual([
				{ by: "turn_end", basis: "no_file" },
			]);
			expect(phaseRowsSince("record_retired", mark)).toEqual([]);
		} finally {
			env.cleanup();
		}
	});

	it("keeps the owner's stamp through every writer that does not rewrite its partition", () => {
		// RECURRENCE GUARDED: #4750. A writer that rebuilt the record without the
		// stamp would hand the next turn end an unstamped partition, which then
		// restarts its window: an expired report would never leave.
		const env = setupTestEnvironment("pi-lens-git-guard-4750-stamp-");
		try {
			const [mine, testFile] = ["b.ts", "b.test.ts"].map((name) =>
				path.join(env.tmpDir, name),
			);
			for (const file of [mine, testFile]) fs.writeFileSync(file, "x;\n");
			const cache = new CacheManager(false);
			const expiredLane = (): void => {
				writeGitGuardRecord(
					cache,
					sessionA(env.tmpDir),
					env.tmpDir,
					laneRecord([], EXPIRED()),
				);
			};
			const expiredAtNextTurnEnd = (): unknown => {
				const { carried, dropped } = readTurnEndGuardRecord(
					cache,
					thirdSession(env.tmpDir),
					env.tmpDir,
				);
				return [
					carried.map((partition) => partition.sessionId),
					dropped.noFile,
				];
			};
			const observed: unknown[] = [];

			// This session's own blocker write carries theirs, then its fix leaves
			// theirs at the top again. (Theirs at the top, a write latches
			// `blocking_provenance_untrusted` and writes nothing.)
			const ownText = composerSections([mine]);
			writeGitGuardRecord(
				cache,
				sessionA(env.tmpDir),
				env.tmpDir,
				record({
					content: ownText,
					blockerContent: ownText,
					hasBlockers: true,
					affectedFiles: [mine],
					blockingFiles: [mine],
					blockerWrittenAt: Date.now(),
					carriedBlockers: [
						{
							sessionId: EARLIER,
							blockerContent: TRIVY_LANE,
							blockingFiles: [],
							blockerWrittenAt: EXPIRED(),
						},
					],
				}),
			);
			const runtime = sessionA(env.tmpDir);
			ownBlocker(runtime, mine);
			syncGitGuardRecord(runtime, cache, env.tmpDir, mine);
			observed.push(["blocker write", owners(storedData(cache, env.tmpDir))]);
			observed.push(["blocker write", expiredAtNextTurnEnd()]);
			ownFix(runtime, mine);
			syncGitGuardRecord(runtime, cache, env.tmpDir, mine);
			observed.push(["own fix", owners(storedData(cache, env.tmpDir))]);
			observed.push(["own fix", expiredAtNextTurnEnd()]);
			// A failing test run, then the passing one.
			expiredLane();
			mergeGitGuardTestFailure(
				cache,
				env.tmpDir,
				sessionA(env.tmpDir),
				"FAIL 0p/1f",
				[testFile],
			);
			observed.push(["failing test", expiredAtNextTurnEnd()]);
			clearGitGuardTestFailure(cache, env.tmpDir, sessionA(env.tmpDir), [
				testFile,
			]);
			observed.push(["passing test", expiredAtNextTurnEnd()]);
			// The context hook's delivery.
			expiredLane();
			cache.writeCache(
				"turn-end-findings",
				{ ...storedData(cache, env.tmpDir), consumed: false },
				env.tmpDir,
			);
			consumeTurnEndFindings(cache, env.tmpDir, sessionA(env.tmpDir));
			observed.push(["delivery", expiredAtNextTurnEnd()]);

			const gone = [[], true];
			expect(observed).toEqual([
				["blocker write", ["session-A", EARLIER]],
				["blocker write", [["session-A"], true]],
				["own fix", [EARLIER]],
				["own fix", gone],
				["failing test", gone],
				["passing test", gone],
				["delivery", gone],
			]);
		} finally {
			env.cleanup();
		}
	});

	it("a settled turn end that drops this session's partition leaves the next owner's own stamp at the top", () => {
		// RECURRENCE GUARDED: #4750. The settled rewrite spreads the stored
		// record, so without the next owner's stamp the top would keep this
		// session's later one, and the other session's report would outlive its
		// window by the gap between the two writes.
		const env = setupTestEnvironment("pi-lens-git-guard-4750-settled-stamp-");
		try {
			const mine = path.join(env.tmpDir, "b.ts");
			fs.writeFileSync(mine, "x;\n");
			const cache = new CacheManager(false);
			const runtime = sessionA(env.tmpDir);
			const theirStamp = Date.now() - 20 * 60_000;
			const ownText = composerSections([mine]);
			writeGitGuardRecord(
				cache,
				runtime,
				env.tmpDir,
				record({
					content: ownText,
					blockerContent: ownText,
					hasBlockers: true,
					affectedFiles: [mine],
					blockingFiles: [mine],
					blockerWrittenAt: Date.now(),
					carriedBlockers: [
						{
							sessionId: EARLIER,
							blockerContent: TRIVY_LANE,
							blockingFiles: [],
							blockerWrittenAt: theirStamp,
						},
					],
				}),
			);

			retireSettledGitGuardRecord(runtime, cache, env.tmpDir);

			const stored = storedData(cache, env.tmpDir);
			expect([owners(stored), stored?.blockerWrittenAt]).toEqual([
				[EARLIER],
				theirStamp,
			]);
		} finally {
			env.cleanup();
		}
	});

	it("expires a released record's text no file owns under read-only turn ends alone", () => {
		// RECURRENCE GUARDED: #4762 r3 (CodeRabbit). A settled turn end stamped
		// an unstamped partition in memory only and wrote nothing when nothing
		// dropped, so under read-only turn ends the stamp restarted at every read,
		// the report never aged, and the gate refused `session_mismatch` forever.
		const env = setupTestEnvironment("pi-lens-git-guard-4750-legacy-ro-");
		const start = Date.now();
		vi.useFakeTimers({ toFake: ["Date"], now: start });
		try {
			const cache = new CacheManager(false);
			const runtime = sessionA(env.tmpDir);
			writeGitGuardRecord(
				cache,
				runtime,
				env.tmpDir,
				laneRecord([], undefined),
			);
			const mark = latestPhaseRow();

			// The first read-only turn end keeps it and starts its window.
			expect(retireSettledGitGuardRecord(runtime, cache, env.tmpDir)).toBe(
				false,
			);
			const first = storedData(cache, env.tmpDir);
			expect([owners(first), first?.blockerWrittenAt]).toEqual([
				[EARLIER],
				start,
			]);
			expect(phaseRowsSince("sections_dropped", mark)).toEqual([]);
			// Read-only turn ends inside the window keep it, stamp unchanged.
			vi.setSystemTime(start + DEFAULT_MAX_AGE_MS);
			expect(retireSettledGitGuardRecord(runtime, cache, env.tmpDir)).toBe(
				false,
			);
			expect(storedData(cache, env.tmpDir)?.blockerWrittenAt).toBe(start);
			expect(evaluateGitGuard(runtime, cache, env.tmpDir).reason).toContain(
				"(session_mismatch)",
			);
			// Past the window, the next one retires it, and the commit runs.
			vi.setSystemTime(start + DEFAULT_MAX_AGE_MS + 60_000);
			expect(retireSettledGitGuardRecord(runtime, cache, env.tmpDir)).toBe(
				true,
			);
			expect(storedData(cache, env.tmpDir)).toBeUndefined();
			expect(phaseRowsSince("record_retired", mark)).toEqual([
				{ by: "turn_end", basis: "no_file" },
			]);
			expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toEqual({
				block: false,
			});
		} finally {
			vi.useRealTimers();
			env.cleanup();
		}
	});

	it("expires an unstamped carried partition under read-only turn ends alone", () => {
		// RECURRENCE GUARDED: #4762 r3 (CodeRabbit), the carried slot. A record
		// written between #4738 and #4750 carries partitions with no stamp; the
		// first read-only turn end must write each one's stamp, not only the
		// top's, or that report never expires.
		const env = setupTestEnvironment("pi-lens-git-guard-4750-legacy-carried-");
		const start = Date.now();
		vi.useFakeTimers({ toFake: ["Date"], now: start });
		try {
			const theirs = path.join(env.tmpDir, "a.ts");
			fs.writeFileSync(theirs, "x;\n");
			const cache = new CacheManager(false);
			const runtime = sessionA(env.tmpDir);
			const fileText = composerSections([theirs]);
			writeGitGuardRecord(
				cache,
				runtime,
				env.tmpDir,
				record({
					content: fileText,
					blockerContent: fileText,
					hasBlockers: true,
					affectedFiles: [theirs],
					blockingFiles: [theirs],
					sessionId: "a-third-session",
					carriedBlockers: [
						{
							sessionId: EARLIER,
							blockerContent: TRIVY_LANE,
							blockingFiles: [],
						},
					],
				}),
			);

			retireSettledGitGuardRecord(runtime, cache, env.tmpDir);
			expect(
				storedData(cache, env.tmpDir)?.carriedBlockers?.map((partition) => [
					partition.sessionId,
					partition.blockerWrittenAt,
				]),
			).toEqual([[EARLIER, start]]);
			vi.setSystemTime(start + DEFAULT_MAX_AGE_MS + 60_000);
			const mark = latestPhaseRow();
			retireSettledGitGuardRecord(runtime, cache, env.tmpDir);

			const stored = storedData(cache, env.tmpDir);
			expect([owners(stored), stored?.blockerContent]).toEqual([
				["a-third-session"],
				fileText,
			]);
			expect(phaseRowsSince("sections_dropped", mark)).toEqual([
				{ by: "turn_end", basis: "no_file" },
			]);
		} finally {
			vi.useRealTimers();
			env.cleanup();
		}
	});

	it("saves no drop row to the real latency sink at the read, and one per drop at the write", async () => {
		// RECURRENCE GUARDED: #4762 r3 (Greptile). The read logged
		// `sections_dropped` (#4750); the in-memory phase list proves the call,
		// not the saved row a maintainer reads to learn why a blocker went.
		const env = setupTestEnvironment("pi-lens-git-guard-4750-sink-");
		vi.stubEnv("PI_LENS_TEST_MODE", "0");
		try {
			const [shared, alone] = ["shared", "alone"].map((name) => {
				const dir = path.join(env.tmpDir, name);
				fs.mkdirSync(dir);
				return dir;
			});
			const theirs = path.join(shared, "a.ts");
			fs.writeFileSync(theirs, "x;\n");
			const cache = new CacheManager(false);
			// `shared`: an expired report beside a live file section.
			writeGitGuardRecord(
				cache,
				sessionA(shared),
				shared,
				laneRecord([theirs], EXPIRED()),
			);
			readTurnEndGuardRecord(cache, sessionA(shared), shared);
			const atRead = await savedRows(shared, "sections_dropped");
			retireSettledGitGuardRecord(sessionA(shared), cache, shared);
			// `alone`: an expired report and nothing else.
			writeGitGuardRecord(
				cache,
				sessionA(alone),
				alone,
				laneRecord([], EXPIRED()),
			);
			retireSettledGitGuardRecord(sessionA(alone), cache, alone);

			expect({
				atRead,
				dropped: await savedRows(shared, "sections_dropped"),
				retired: await savedRows(alone, "record_retired"),
				retiredShared: await savedRows(shared, "record_retired"),
			}).toEqual({
				atRead: [],
				dropped: [{ by: "turn_end", basis: "no_file" }],
				retired: [{ by: "turn_end", basis: "no_file" }],
				retiredShared: [],
			});
		} finally {
			vi.unstubAllEnvs();
			env.cleanup();
		}
	});

	it("refuses a record whose write stamp is not a number, at the top or carried", () => {
		// RECURRENCE GUARDED: #4750. A stamp no age can be computed from would
		// read as never past the window, so a corrupt record would keep text no
		// file owns forever; it is not a record, and the gate fails closed.
		const env = setupTestEnvironment("pi-lens-git-guard-4750-bad-stamp-");
		try {
			const cache = new CacheManager(false);
			const runtime = sessionA(env.tmpDir);
			const verdicts = [
				{ ...laneRecord([], undefined), blockerWrittenAt: "soon" },
				{
					...laneRecord([], Date.now()),
					carriedBlockers: [
						{
							sessionId: "a-third-session",
							blockerContent: TRIVY_LANE,
							blockingFiles: [],
							blockerWrittenAt: null,
						},
					],
				},
				laneRecord([], Date.now()),
			].map((data) => {
				cache.writeCache("turn-end-findings", data, env.tmpDir);
				return evaluateGitGuard(runtime, cache, env.tmpDir).reason?.match(
					/\((\w+)\)/,
				)?.[1];
			});

			expect(verdicts).toEqual([
				"cache_malformed",
				"cache_malformed",
				"session_mismatch",
			]);
		} finally {
			env.cleanup();
		}
	});

	it("tells the asking session what clears text no file owns, apart from a value that is not a record", () => {
		// RECURRENCE GUARDED: #4750. The remedy said this session's next turn end
		// replaces another session's text no file owns, which #4750 makes false.
		const env = setupTestEnvironment("pi-lens-git-guard-4750-remedy-");
		try {
			const cache = new CacheManager(false);
			const runtime = sessionA(env.tmpDir);
			const reasons = [
				laneRecord([], Date.now()),
				{ content: "🔴 STOP", hasBlockers: "yes" },
			].map((data) => {
				cache.writeCache("turn-end-findings", data, env.tmpDir);
				return evaluateGitGuard(runtime, cache, env.tmpDir).reason ?? "";
			});

			expect(reasons[0]).toContain(
				"the session that wrote them replaces them at its next turn end, and once 30 minutes pass without that session rewriting them, a turn end of any session drops them. Then retry.",
			);
			expect(reasons[0]).not.toContain("this session's next turn-end findings");
			expect(reasons[1]).toContain(
				"cannot attribute to a file, so no re-check of one file clears them; this session's next turn-end findings replace it. Then retry.",
			);
		} finally {
			env.cleanup();
		}
	});
});

describe("#4921: a turn end's own partition is its turn session's", () => {
	// A concurrent in-process subagent shares the primary's coordinator, so
	// `runtime.telemetrySessionId` is the primary's during the subagent's turn.
	const SUBAGENT = "subagent-session";

	function twoPartitionRecord(dir: string): { mine: string; theirs: string } {
		const [mine, theirs] = ["primary.ts", "subagent.ts"].map((name) =>
			path.join(dir, name),
		);
		for (const file of [mine, theirs]) fs.writeFileSync(file, "x;\n");
		return { mine, theirs };
	}

	it("carries the primary's section, not the subagent's own, into the subagent's turn-end rewrite", () => {
		// RECURRENCE GUARDED: #4921. Read with the coordinator's id, the
		// subagent's composer carried its own section and replaced the
		// primary's with its own blockers.
		const env = setupTestEnvironment("pi-lens-git-guard-4921-carry-");
		try {
			const { mine, theirs } = twoPartitionRecord(env.tmpDir);
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			writeGitGuardRecord(
				cache,
				runtime,
				env.tmpDir,
				record({
					...foreignRecord([mine], "session-A"),
					carriedBlockers: [
						{
							sessionId: SUBAGENT,
							blockerContent: composerSections([theirs]),
							blockingFiles: [theirs],
						},
					],
				}),
			);
			const { carried } = readTurnEndGuardRecord(
				cache,
				runtime,
				env.tmpDir,
				SUBAGENT,
			);
			expect(carried.map((partition) => partition.sessionId)).toEqual([
				"session-A",
			]);
		} finally {
			env.cleanup();
		}
	});

	it("retires the subagent's own section, not the primary's, at the subagent's settled turn end", () => {
		// RECURRENCE GUARDED: #4921. Settled with the coordinator's id, the
		// subagent's turn end dropped the primary's section and kept its own.
		const env = setupTestEnvironment("pi-lens-git-guard-4921-settle-");
		try {
			const { mine, theirs } = twoPartitionRecord(env.tmpDir);
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			writeGitGuardRecord(
				cache,
				runtime,
				env.tmpDir,
				record({
					...foreignRecord([mine], "session-A"),
					carriedBlockers: [
						{
							sessionId: SUBAGENT,
							blockerContent: composerSections([theirs]),
							blockingFiles: [theirs],
						},
					],
				}),
			);
			retireSettledGitGuardRecord(runtime, cache, env.tmpDir, SUBAGENT);
			expect(owners(storedData(cache, env.tmpDir))).toEqual(["session-A"]);
		} finally {
			env.cleanup();
		}
	});

	it("files a subagent write's sync under its own blockers only, leaving the primary's section the primary's", () => {
		// RECURRENCE GUARDED: #4921 at the write seam. Built from every record
		// in the shared map, the subagent's section also listed the primary's
		// file, so after the primary fixed it the subagent's section still
		// refused the commit over it until the subagent's turn ended.
		const env = setupTestEnvironment("pi-lens-git-guard-4921-sync-");
		try {
			const { mine, theirs } = twoPartitionRecord(env.tmpDir);
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			const mineSummary = productionSummary(mine, ["primary blocker"]);
			runtime.recordInlineBlockers(mine, mineSummary);
			runtime.updateGitGuardStatus(true, mineSummary);
			syncGitGuardRecord(runtime, cache, env.tmpDir, mine);
			const theirsSummary = productionSummary(theirs, ["subagent blocker"]);
			runtime.recordInlineBlockers(
				theirs,
				theirsSummary,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				SUBAGENT,
			);
			runtime.updateGitGuardStatus(true, theirsSummary);
			syncGitGuardRecord(
				runtime,
				cache,
				env.tmpDir,
				theirs,
				"session",
				false,
				SUBAGENT,
			);
			const data = storedData(cache, env.tmpDir);
			const sectionOf = (id: string) =>
				[
					{ sessionId: data?.sessionId, blockingFiles: data?.blockingFiles },
					...(data?.carriedBlockers ?? []),
				].find((partition) => partition.sessionId === id)?.blockingFiles;
			expect(sectionOf("session-A")).toEqual([mine]);
			expect(sectionOf(SUBAGENT)).toEqual([theirs]);
		} finally {
			env.cleanup();
		}
	});

	it("drops the subagent's own section when a confirmed-clean check retires its blocker", () => {
		// RECURRENCE GUARDED: #4921 at the lens_diagnostics retire. Resynced as
		// the coordinator, the retire left the subagent's section of the
		// retired file standing, so its commit stayed refused until its turn end.
		const env = setupTestEnvironment("pi-lens-git-guard-4921-retire-");
		try {
			const { theirs } = twoPartitionRecord(env.tmpDir);
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			const summary = productionSummary(theirs, ["subagent blocker"]);
			runtime.recordInlineBlockers(
				theirs,
				summary,
				undefined,
				["tsc"],
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				SUBAGENT,
			);
			runtime.updateGitGuardStatus(true, summary);
			syncGitGuardRecord(
				runtime,
				cache,
				env.tmpDir,
				theirs,
				"session",
				false,
				SUBAGENT,
			);
			expect(owners(storedData(cache, env.tmpDir))).toEqual([SUBAGENT]);
			expect(
				retireInlineBlockerAndResyncGuard({
					runtime,
					cacheManager: cache,
					cwd: env.tmpDir,
					filePath: theirs,
					coveredSources: ["tsc"],
					lensGuardEnabled: true,
				}),
			).toBe(true);
			expect(storedData(cache, env.tmpDir)).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("names the subagent's own record's remedy as its own, not another session's", () => {
		// RECURRENCE GUARDED: #4921 in the refusal text. Read against the
		// coordinator's id, a latched refusal of the subagent's commit told it
		// to wait out another session's record that is its own.
		const env = setupTestEnvironment("pi-lens-git-guard-4921-remedy-");
		try {
			const { theirs } = twoPartitionRecord(env.tmpDir);
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			writeGitGuardRecord(
				cache,
				runtime,
				env.tmpDir,
				foreignRecord([theirs], SUBAGENT),
			);
			runtime.markGitGuardCacheUnknown("cache_stale", env.tmpDir);
			const foreignRemedy = "The record names blockers in subagent.ts";
			expect(evaluateGitGuard(runtime, cache, env.tmpDir).reason).toContain(
				foreignRemedy,
			);
			expect(
				evaluateGitGuard(runtime, cache, env.tmpDir, "pi", SUBAGENT).reason,
			).not.toContain(foreignRemedy);
		} finally {
			env.cleanup();
		}
	});

	it("leaves the primary's record and the latch alone when a subagent writes a clean file", () => {
		// RECURRENCE GUARDED: #4921 review r1 F1 (probe P5). Judged by the
		// writing session, the subagent's clean write latched the process-wide
		// `session_mismatch` on the primary's record, so the primary's commit
		// refusal said "blocker state is unknown" instead of naming its blocker.
		const env = setupTestEnvironment("pi-lens-git-guard-4921-clean-write-");
		resetDegradationLedger();
		try {
			const { mine, theirs } = twoPartitionRecord(env.tmpDir);
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			ownBlocker(runtime, mine);
			syncGitGuardRecord(runtime, cache, env.tmpDir, mine);
			const before = storedData(cache, env.tmpDir);
			for (let write = 0; write < 2; write += 1)
				syncGitGuardRecord(
					runtime,
					cache,
					env.tmpDir,
					theirs,
					"session",
					false,
					SUBAGENT,
				);
			expect(runtime.gitGuardCacheUnknownFor()).toBeUndefined();
			expect(storedData(cache, env.tmpDir)).toEqual(before);
			const refusal = evaluateGitGuard(runtime, cache, env.tmpDir);
			expect(refusal.block).toBe(true);
			expect(refusal.reason).toContain("unresolved blockers must be fixed");
			expect(refusal.reason).not.toContain("session_mismatch");
			// One record per writing session, not one per write.
			const row = getDegradationSummary().find(
				(group) => group.kind === "git-guard-non-owner-write",
			);
			expect(row?.count).toBe(1);
			expect(row?.latestReasons[0]?.subject).toBe(SUBAGENT);
		} finally {
			resetDegradationLedger();
			env.cleanup();
		}
	});

	it("lets the subagent judge a record only it owns at its own commit", () => {
		// RECURRENCE GUARDED: #4921 at the commit gate. Compared with the
		// coordinator's id, the subagent's own record read `session_mismatch`
		// and refused its commit although the record's only file was deleted.
		const env = setupTestEnvironment("pi-lens-git-guard-4921-gate-");
		try {
			const { theirs } = twoPartitionRecord(env.tmpDir);
			const runtime = sessionA(env.tmpDir);
			const cache = new CacheManager(false);
			cache.writeCache(
				"turn-end-findings",
				record({
					content: "blocker",
					hasBlockers: true,
					affectedFiles: [theirs],
					sessionId: SUBAGENT,
					fileSeqByPath: { [theirs.replace(/\\/g, "/")]: 0 },
				}),
				env.tmpDir,
			);
			fs.unlinkSync(theirs);
			expect(evaluateGitGuard(runtime, cache, env.tmpDir).reason).toContain(
				"session_mismatch",
			);
			expect(
				evaluateGitGuard(runtime, cache, env.tmpDir, "pi", SUBAGENT).block,
			).toBe(false);
		} finally {
			env.cleanup();
		}
	});
});

describe("#4943: the turn-end delivery slot answers to the session it is addressed to", () => {
	/** What `session`'s request receives from the slot, and the record after. */
	function readAs(
		cache: CacheManager,
		cwd: string,
		runtime: RuntimeCoordinator,
		session: string | undefined,
	): { delivered: string | undefined; after: string } {
		const delivered = consumeTurnEndFindings(cache, cwd, runtime, session)
			?.messages[0]?.content;
		return { delivered, after: JSON.stringify(storedData(cache, cwd)) };
	}

	it("leaves a record another session owns and no turn end addressed to that owner's request", () => {
		// RECURRENCE GUARDED: #4943 R1. The context hook consumed whatever the
		// slot held; a record a commit-gate writer (or a released writer) left
		// with no addressee names its owner, and only the owner takes it.
		const env = setupTestEnvironment("pi-lens-git-guard-4943-owner-");
		try {
			const theirs = path.join(env.tmpDir, "a.ts");
			fs.writeFileSync(theirs, "x;\n");
			const cache = new CacheManager(false);
			const runtime = sessionA(env.tmpDir);
			writeGitGuardRecord(cache, runtime, env.tmpDir, {
				...foreignRecord([theirs]),
				consumed: false,
			});
			const before = JSON.stringify(storedData(cache, env.tmpDir));

			expect(readAs(cache, env.tmpDir, runtime, "session-A")).toEqual({
				delivered: undefined,
				after: before,
			});
			expect(readAs(cache, env.tmpDir, runtime, EARLIER).delivered).toContain(
				composerSections([theirs]),
			);
		} finally {
			env.cleanup();
		}
	});

	it("addresses the owner once a settled turn end rewrites the composer's message as the owner's blocker text", () => {
		// RECURRENCE GUARDED: #4943 R1, the settled partition retire. It keeps
		// the stored fields and replaces `content` with the remaining owner's
		// sections; a composer's address kept beside them would hand session
		// A the other session's blocker as its own message.
		const env = setupTestEnvironment("pi-lens-git-guard-4943-retire-");
		try {
			const [theirs, mine] = ["a.ts", "b.ts"].map((name) =>
				path.join(env.tmpDir, name),
			);
			for (const file of [theirs, mine]) fs.writeFileSync(file, "x;\n");
			const cache = new CacheManager(false);
			const runtime = sessionA(env.tmpDir);
			const own = foreignRecord([mine], "session-A");
			writeGitGuardRecord(cache, runtime, env.tmpDir, {
				...own,
				affectedFiles: [theirs, mine],
				carriedBlockers: [
					{
						sessionId: EARLIER,
						blockerContent: composerSections([theirs]),
						blockingFiles: [theirs],
					},
				],
				consumed: false,
				deliverTo: "session-A",
			});

			expect(retireSettledGitGuardRecord(runtime, cache, env.tmpDir)).toBe(
				false,
			);
			const rewritten = JSON.stringify(storedData(cache, env.tmpDir));
			expect(readAs(cache, env.tmpDir, runtime, "session-A")).toEqual({
				delivered: undefined,
				after: rewritten,
			});
			expect(readAs(cache, env.tmpDir, runtime, EARLIER).delivered).toContain(
				composerSections([theirs]),
			);
		} finally {
			env.cleanup();
		}
	});

	it("addresses the owner once a passing test run rewrites the composer's message as the owner's blocker text", () => {
		// RECURRENCE GUARDED: #4943 R1, the test-failure clear. Session A's turn
		// end composed its own message over a record that leads with another
		// session's blocker; the passing run keeps the stored fields and leaves
		// only that blocker's text, which is the owner's.
		const env = setupTestEnvironment("pi-lens-git-guard-4943-tests-");
		try {
			const theirs = path.join(env.tmpDir, "a.ts");
			const testFile = path.join(env.tmpDir, "a.test.ts");
			for (const file of [theirs, testFile]) fs.writeFileSync(file, "x;\n");
			const cache = new CacheManager(false);
			const runtime = sessionA(env.tmpDir);
			const owned = foreignRecord([theirs]);
			writeGitGuardRecord(cache, runtime, env.tmpDir, {
				...owned,
				content: "session A's advisory",
				affectedFiles: [theirs, testFile],
				testFailures: true,
				testFailureContent: "a.test.ts failed",
				testFailureFiles: [testFile],
				consumed: false,
				deliverTo: "session-A",
			});

			clearGitGuardTestFailure(cache, env.tmpDir, runtime, [testFile]);
			const rewritten = JSON.stringify(storedData(cache, env.tmpDir));
			expect(readAs(cache, env.tmpDir, runtime, "session-A")).toEqual({
				delivered: undefined,
				after: rewritten,
			});
			expect(readAs(cache, env.tmpDir, runtime, EARLIER).delivered).toContain(
				composerSections([theirs]),
			);
		} finally {
			env.cleanup();
		}
	});

	it("hands a reader that names no session an addressed message, and any reader one no session is named on", () => {
		// A caller that passes no reader identity takes every message (the
		// contract the MCP host relied on before #4943 R2 gave it an address).
		// A record that names no session (3.8.74's `{ content }`) goes to
		// whoever asks, as before.
		const env = setupTestEnvironment("pi-lens-git-guard-4943-unkeyed-");
		try {
			const cache = new CacheManager(false);
			const runtime = sessionA(env.tmpDir);
			cache.writeCache(
				"turn-end-findings",
				{ content: "staged for the earlier one", deliverTo: EARLIER },
				env.tmpDir,
			);
			expect(readAs(cache, env.tmpDir, runtime, undefined).delivered).toContain(
				"staged for the earlier one",
			);
			cache.writeCache(
				"turn-end-findings",
				{ content: "addressed to no one" },
				env.tmpDir,
			);
			expect(
				readAs(cache, env.tmpDir, runtime, "session-A").delivered,
			).toContain("addressed to no one");
		} finally {
			env.cleanup();
		}
	});
});
