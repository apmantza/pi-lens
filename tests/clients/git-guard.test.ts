import { describe, expect, it } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import {
	evaluateGitGuard,
	isGitCommitOrPushAttempt,
} from "../../clients/git-guard.js";
import { setupTestEnvironment } from "./test-utils.js";

describe("git-guard", () => {
	it("detects git commit/push attempts from bash tool calls", () => {
		expect(
			isGitCommitOrPushAttempt("bash", { command: "git commit -m \"x\"" }),
		).toBe(true);
		expect(isGitCommitOrPushAttempt("bash", { command: "git push origin main" })).toBe(
			true,
		);
		expect(
			isGitCommitOrPushAttempt("bash", { command: "npm test && git commit -m x" }),
		).toBe(true);
		expect(isGitCommitOrPushAttempt("bash", { command: "npm test" })).toBe(false);
		expect(
			isGitCommitOrPushAttempt("write", { command: "git commit -m x" }),
		).toBe(false);
	});

	it("blocks commit when unresolved blockers exist in runtime status", () => {
		const runtime = {
			gitGuardHasBlockers: true,
			gitGuardSummary: "🔴 blocker in src/app.ts:12",
		};
		const env = setupTestEnvironment("pi-lens-git-guard-");
		try {
			const cacheManager = new CacheManager(false);
			const result = evaluateGitGuard(runtime as any, cacheManager, env.tmpDir);
			expect(result.block).toBe(true);
			expect(result.reason).toContain("COMMIT BLOCKED");
			expect(result.reason).toContain("src/app.ts");
		} finally {
			env.cleanup();
		}
	});

	it("blocks commit when turn-end blockers are pending in cache", () => {
		const runtime = { gitGuardHasBlockers: false, gitGuardSummary: "" };
		const env = setupTestEnvironment("pi-lens-git-guard-");
		try {
			const cacheManager = new CacheManager(false);
			cacheManager.writeCache(
				"turn-end-findings",
				{ content: "🔴 duplicate code in modified files" },
				env.tmpDir,
			);
			const result = evaluateGitGuard(runtime as any, cacheManager, env.tmpDir);
			expect(result.block).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("allows commit when no blockers are pending", () => {
		const runtime = { gitGuardHasBlockers: false, gitGuardSummary: "" };
		const env = setupTestEnvironment("pi-lens-git-guard-");
		try {
			const cacheManager = new CacheManager(false);
			const result = evaluateGitGuard(runtime as any, cacheManager, env.tmpDir);
			expect(result).toEqual({ block: false });
		} finally {
			env.cleanup();
		}
	});
});
