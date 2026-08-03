import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import {
	clearGitGuardTestFailure,
	evaluateGitGuard,
	isGitCommitOrPushAttempt,
	mergeGitGuardTestFailure,
	writeGitGuardRecord,
	type TurnEndFindingsCache,
} from "../../clients/git-guard.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { getProjectDataDir } from "../../clients/file-utils.js";
import { setupTestEnvironment } from "./test-utils.js";

function record(overrides: Partial<TurnEndFindingsCache> = {}): TurnEndFindingsCache {
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
		expect(isGitCommitOrPushAttempt("bash", { command: "git commit -m \"x\"" })).toBe(true);
		expect(isGitCommitOrPushAttempt("bash", { command: "git push origin main" })).toBe(true);
		expect(isGitCommitOrPushAttempt("bash", { command: "npm test && git -C repo commit -m x" })).toBe(true);
		expect(isGitCommitOrPushAttempt("bash", { command: "git --no-pager push origin main" })).toBe(true);
		expect(isGitCommitOrPushAttempt("bash", { command: "git --help commit" })).toBe(false);
		expect(isGitCommitOrPushAttempt("bash", { command: "git -c user.name=x commit -m x" })).toBe(true);
		expect(isGitCommitOrPushAttempt("bash", { command: "GIT_DIR=.git git push" })).toBe(true);
		expect(isGitCommitOrPushAttempt("bash", { command: "" , cmd: "git commit -m x" })).toBe(true);
		expect(isGitCommitOrPushAttempt("bash", { command: "sh -c 'git commit -m x'" })).toBe(true);
		expect(isGitCommitOrPushAttempt("bash", { command: "bash -lc \"git push origin main\"" })).toBe(true);
		expect(isGitCommitOrPushAttempt("bash", { command: "cmd /c \"git.exe commit -m x\"" })).toBe(true);
		expect(isGitCommitOrPushAttempt("bash", { cmd: "powershell -Command \"git.cmd push\"" })).toBe(true);
		expect(isGitCommitOrPushAttempt("bash", { command: "# git commit -m x" })).toBe(false);
		expect(isGitCommitOrPushAttempt("bash", { command: "echo \"git commit -m x\"" })).toBe(false);
		expect(isGitCommitOrPushAttempt("bash", { command: "printf 'git push'" })).toBe(false);
		expect(isGitCommitOrPushAttempt("write", { command: "git commit -m x" })).toBe(false);
	});

	it("blocks runtime blockers and preserves their details", () => {
		const runtime = { gitGuardHasBlockers: true, gitGuardSummary: "blocker in src/app.ts:12" };
		const env = setupTestEnvironment("pi-lens-git-guard-runtime-");
		try {
			const result = evaluateGitGuard(runtime as any, new CacheManager(false), env.tmpDir);
			expect(result.block).toBe(true);
			expect(result.reason).toContain("src/app.ts");
		} finally { env.cleanup(); }
	});

	it("allows advisory-only structured records", () => {
		const env = setupTestEnvironment("pi-lens-git-guard-advisory-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "session-A" });
			const cache = new CacheManager(false);
			cache.writeCache("turn-end-findings", record({ content: "style advisory" }), env.tmpDir);
			expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toEqual({ block: false });
		} finally { env.cleanup(); }
	});

	it("treats malformed, stale, and cross-session state as unknown/block", () => {
		const env = setupTestEnvironment("pi-lens-git-guard-unknown-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "session-A" });
			const cache = new CacheManager(false);
			cache.writeCache("turn-end-findings", { content: "old shape" }, env.tmpDir);
			expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toMatchObject({ block: true, unknown: true });
			cache.writeCache("turn-end-findings", record({ content: "blocker", hasBlockers: true, sessionId: "other" }), env.tmpDir);
			expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toMatchObject({ block: true, unknown: true });
			const metaPath = path.join(getProjectDataDir(env.tmpDir), "cache", "turn-end-findings.meta.json");
			const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
			meta.timestamp = new Date(0).toISOString();
			fs.writeFileSync(metaPath, JSON.stringify(meta));
			expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toMatchObject({ block: true, unknown: true });
		} finally { env.cleanup(); }
	});

	it("blocks structured test failures", () => {
		const env = setupTestEnvironment("pi-lens-git-guard-tests-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "session-A" });
			const cache = new CacheManager(false);
			cache.writeCache("turn-end-findings", record({ content: "FAIL 1p/1f", hasBlockers: true, testFailures: true }), env.tmpDir);
			expect(evaluateGitGuard(runtime, cache, env.tmpDir).block).toBe(true);
		} finally { env.cleanup(); }
	});

	it("aggregates per-file blockers instead of latest-file-wins", () => {
		const runtime = new RuntimeCoordinator();
		runtime.recordInlineBlockers("/workspace/a.ts", "blocker A");
		runtime.updateGitGuardStatus(true, "blocker A");
		runtime.clearInlineBlockers("/workspace/b.ts");
		runtime.updateGitGuardStatus(false, "clean B");
		expect(runtime.gitGuardHasBlockers).toBe(true);
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
			cache.writeCache("turn-end-findings", record({ content: "blocker", hasBlockers: true, affectedFiles: [file], fileSeqByPath: { [file.replace(/\\/g, "/")]: 0 } }), env.tmpDir);
			fs.unlinkSync(file);
			expect(evaluateGitGuard(runtime, cache, env.tmpDir).block).toBe(false);
		} finally { env.cleanup(); }
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
			writeGitGuardRecord(cache, runtime, env.tmpDir, record({
				content: "blocker",
				hasBlockers: true,
				affectedFiles: [file],
				blockingFiles: [file],
			}));
			fs.writeFileSync(file, "const after = 2;\n");
			expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toMatchObject({ block: true, unknown: true });
		} finally { env.cleanup(); }
	});

	it("clears only the test failure that passed", () => {
		const env = setupTestEnvironment("pi-lens-git-guard-test-clear-");
		try {
			const files = ["a.test.ts", "b.test.ts"].map((name) => path.join(env.tmpDir, name));
			for (const file of files) fs.writeFileSync(file, "test();\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "session-A" });
			const cache = new CacheManager(false);
			mergeGitGuardTestFailure(cache, env.tmpDir, runtime, "two failures", files);
			clearGitGuardTestFailure(cache, env.tmpDir, runtime, [files[0]]);
			expect(evaluateGitGuard(runtime, cache, env.tmpDir).block).toBe(true);
			clearGitGuardTestFailure(cache, env.tmpDir, runtime, [files[1]]);
			expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toEqual({ block: false });
		} finally { env.cleanup(); }
	});

	it("allows a missing record and blocks an old unstructured record", () => {
		const env = setupTestEnvironment("pi-lens-git-guard-empty-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const cache = new CacheManager(false);
			expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toEqual({ block: false });
			cache.writeCache("turn-end-findings", { content: "legacy blocker" }, env.tmpDir);
			expect(evaluateGitGuard(runtime, cache, env.tmpDir)).toMatchObject({ block: true, unknown: true });
		} finally { env.cleanup(); }
	});
});
