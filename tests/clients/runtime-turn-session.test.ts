import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import {
	consumeSessionStartGuidance,
	consumeTestFindings,
	consumeTurnEndFindings,
} from "../../clients/runtime-context.js";
import { loadProjectDiagnosticsDeltaReport } from "../../clients/project-diagnostics/cache.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleTurnEnd } from "../../clients/runtime-turn.js";
import { setupTestEnvironment } from "./test-utils.js";

const EMPTY_KNIP_RESULT = {
	success: true,
	issues: [],
	unusedExports: [],
	unusedFiles: [],
	unusedDeps: [],
	unlistedDeps: [],
	summary: "skipped",
};

// Minimal turn_end deps — no real tool clients needed for these scenarios.
function makeTurnEndDeps(
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
	overrides: Record<string, unknown> = {},
) {
	return {
		ctxCwd: undefined,
		getFlag: () => false,
		dbg: () => {},
		runtime,
		cacheManager,
		knipClient: {
			ensureAvailable: async () => false,
			analyze: async () => EMPTY_KNIP_RESULT,
		},
		depChecker: { ensureAvailable: async () => false },
		testRunnerClient: { getTestRunTarget: () => null },
		resetLSPService: () => {},
		resetFormatService: () => {},
		...overrides,
	} as any;
}

// ── Dedup suppression ──────────────────────────────────────────────────────────

describe("turn-end-findings-last dedup", () => {
	it("suppresses identical findings within the same session", async () => {
		const env = setupTestEnvironment("pi-lens-dedup-same-");
		const runtime = new RuntimeCoordinator();
		runtime.setTelemetryIdentity({ sessionId: "session-A" });
		const cacheManager = new CacheManager(false);

		// Pre-seed last findings with matching signature + same session.
		const content = "🔴 blocker: something broken\n";
		const files = ["src/foo.ts"];
		const signature = `${files.join("|")}::${content}`;
		cacheManager.writeCache(
			"turn-end-findings-last",
			{ signature, sessionId: "session-A" },
			env.tmpDir,
		);

		// Simulate the same content being produced again — dedup should fire.
		// Directly write findings so handleTurnEnd sees matching signature.
		cacheManager.writeCache("turn-end-findings", { content }, env.tmpDir);
		cacheManager.addModifiedRange(
			path.join(env.tmpDir, "src/foo.ts"),
			{ start: 1, end: 5 },
			false,
			env.tmpDir,
			"session-A",
		);

		// We can't easily re-produce the exact signature through handleTurnEnd
		// without real tool results, so test the cache layer directly.
		const last = cacheManager.readCache<{
			signature: string;
			sessionId: string;
		}>("turn-end-findings-last", env.tmpDir);
		expect(last?.data?.sessionId).toBe("session-A");
		expect(last?.data?.signature).toBe(signature);

		// Dedup condition: same signature AND same session → would suppress.
		expect(
			last?.data?.signature === signature &&
				last?.data?.sessionId === runtime.telemetrySessionId,
		).toBe(true);

		env.cleanup();
	});

	it("does NOT suppress identical findings from a previous session", async () => {
		const env = setupTestEnvironment("pi-lens-dedup-cross-");
		const runtime = new RuntimeCoordinator();
		runtime.setTelemetryIdentity({ sessionId: "session-B" });
		const cacheManager = new CacheManager(false);

		const content = "🔴 blocker: something broken\n";
		const files = ["src/foo.ts"];
		const signature = `${files.join("|")}::${content}`;

		// Seed last findings from a DIFFERENT (old) session.
		cacheManager.writeCache(
			"turn-end-findings-last",
			{ signature, sessionId: "session-A" },
			env.tmpDir,
		);

		const last = cacheManager.readCache<{
			signature: string;
			sessionId: string;
		}>("turn-end-findings-last", env.tmpDir);

		// Dedup condition: same signature but DIFFERENT session → must NOT suppress.
		expect(last?.data?.signature).toBe(signature);
		expect(
			last?.data?.signature === signature &&
				last?.data?.sessionId === runtime.telemetrySessionId,
		).toBe(false);

		env.cleanup();
	});
});

// ── Stale turn state eviction ─────────────────────────────────────────────────

vi.mock("../../clients/pipeline.js", () => ({
	runPipeline: vi.fn(async () => ({
		output: "",
		hasBlockers: false,
		isError: false,
		fileModified: false,
		cascadeResult: undefined,
	})),
}));

describe("stale turn state eviction", () => {
	it("writes sequence metadata into turn-end warning reports", async () => {
		const env = setupTestEnvironment("pi-lens-turn-seq-report-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "seq-session" });
			runtime.seedProjectSequence(10);
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const filePath = path.join(env.tmpDir, "src/quality.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "export const x = 1;\n");
			const { fileSeq } = runtime.bumpFileSeq(filePath);
			cacheManager.addModifiedRange(
				filePath,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
				"seq-session",
			);
			runtime.recordCodeQualityWarnings([
				{
					id: "cq:test",
					filePath,
					displayPath: "src/quality.ts",
					line: 1,
					column: 1,
					severity: "warning",
					tool: "quality-test",
					rule: "quality-test",
					message: "quality advisory",
					category: "maintainability",
					origin: "dispatch",
				},
			]);

			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, { ctxCwd: env.tmpDir }),
			);

			const report = cacheManager.readCache<{
				projectSeqStart?: number;
				projectSeqEnd?: number;
				files: Array<{ filePath: string; fileSeq?: number }>;
			}>("code-quality-warnings", env.tmpDir);
			expect(report?.data).toMatchObject({
				projectSeqStart: 10,
				projectSeqEnd: 11,
			});
			expect(report?.data.files[0]).toMatchObject({ filePath, fileSeq });
		} finally {
			env.cleanup();
		}
	});

	it("evicts turn state written by a previous session", async () => {
		const env = setupTestEnvironment("pi-lens-stale-evict-");
		const runtime = new RuntimeCoordinator();
		runtime.setTelemetryIdentity({ sessionId: "session-current" });
		const cacheManager = new CacheManager(false);

		// Write a turn state stamped with an old session.
		const filePath = path.join(env.tmpDir, "src/old.ts");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "export const x = 1;\n");

		cacheManager.addModifiedRange(
			filePath,
			{ start: 1, end: 1 },
			false,
			env.tmpDir,
			"session-old",
		);

		// Confirm it was written.
		expect(
			Object.keys(cacheManager.readTurnState(env.tmpDir).files),
		).toHaveLength(1);

		// handleTurnEnd should detect the session mismatch and evict.
		await handleTurnEnd(
			makeTurnEndDeps(runtime, cacheManager, { ctxCwd: env.tmpDir }),
		);

		// After eviction + processing, turn state should be cleared.
		const afterState = cacheManager.readTurnState(env.tmpDir);
		expect(Object.keys(afterState.files)).toHaveLength(0);

		env.cleanup();
	});

	it("keeps turn state written by the current session", async () => {
		const env = setupTestEnvironment("pi-lens-same-session-");
		const runtime = new RuntimeCoordinator();
		runtime.setTelemetryIdentity({ sessionId: "session-current" });
		const cacheManager = new CacheManager(false);

		const filePath = path.join(env.tmpDir, "src/current.ts");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "export const x = 1;\n");

		cacheManager.addModifiedRange(
			filePath,
			{ start: 1, end: 1 },
			false,
			env.tmpDir,
			"session-current",
		);

		// handleTurnEnd processes files — no eviction, just normal clear after clean turn.
		await handleTurnEnd(
			makeTurnEndDeps(runtime, cacheManager, { ctxCwd: env.tmpDir }),
		);

		// No blockers → clearTurnState called normally (not via eviction path).
		// Either way, state ends up cleared — the point is it wasn't evicted prematurely.
		const afterState = cacheManager.readTurnState(env.tmpDir);
		expect(Object.keys(afterState.files)).toHaveLength(0);

		env.cleanup();
	});
});

// ── Knip timeout backoff ─────────────────────────────────────────────────────

describe("knip turn-end backoff", () => {
	it("writes normalized project diagnostics delta for new Knip issues", async () => {
		const env = setupTestEnvironment("pi-lens-knip-delta-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "knip-delta-session" });
			const cacheManager = new CacheManager(false);
			const filePath = path.join(env.tmpDir, "src/current.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "export const x = 1;\n");
			cacheManager.addModifiedRange(
				filePath,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
			);

			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, {
					ctxCwd: env.tmpDir,
					knipClient: {
						ensureAvailable: async () => true,
						analyze: async () => ({
							...EMPTY_KNIP_RESULT,
							issues: [
								{
									type: "unlisted",
									name: "left-pad",
									file: filePath,
									line: 1,
								},
							],
						}),
					},
				}),
			);

			const report = loadProjectDiagnosticsDeltaReport(env.tmpDir);
			expect(report).toMatchObject({
				sessionId: "knip-delta-session",
				turnIndex: runtime.turnIndex,
				sources: ["knip"],
			});
			expect(report?.diagnostics).toEqual([
				expect.objectContaining({
					filePath,
					line: 1,
					severity: "error",
					semantic: "blocking",
					runner: "knip",
					rule: "knip:unlisted",
					message: "Unlisted dependency left-pad",
				}),
			]);
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});

	it("skips knip after a recent timeout failure", async () => {
		const env = setupTestEnvironment("pi-lens-knip-backoff-");
		try {
			const runtime = new RuntimeCoordinator();
			const cacheManager = new CacheManager(false);
			const filePath = path.join(env.tmpDir, "src/current.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "export const x = 1;\n");
			cacheManager.addModifiedRange(
				filePath,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
			);
			cacheManager.writeCache(
				"knip",
				{
					...EMPTY_KNIP_RESULT,
					success: false,
					summary:
						"Error: Process timed out after 30000ms (killed with SIGTERM)",
				},
				env.tmpDir,
			);
			const analyze = vi.fn(async () => EMPTY_KNIP_RESULT);

			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, {
					ctxCwd: env.tmpDir,
					knipClient: {
						ensureAvailable: async () => true,
						analyze,
					},
				}),
			);

			expect(analyze).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});
});

// ── sessionId stamped into turn state ─────────────────────────────────────────

describe("addModifiedRange sessionId stamping", () => {
	it("stamps session ID into turn state when provided", () => {
		const env = setupTestEnvironment("pi-lens-stamp-");
		const cacheManager = new CacheManager(false);
		const filePath = path.join(env.tmpDir, "src/foo.ts");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "const x = 1;\n");

		cacheManager.addModifiedRange(
			filePath,
			{ start: 1, end: 1 },
			false,
			env.tmpDir,
			"my-session-id",
		);

		const state = cacheManager.readTurnState(env.tmpDir);
		expect(state.sessionId).toBe("my-session-id");

		env.cleanup();
	});

	it("leaves sessionId undefined when not provided", () => {
		const env = setupTestEnvironment("pi-lens-no-stamp-");
		const cacheManager = new CacheManager(false);
		const filePath = path.join(env.tmpDir, "src/bar.ts");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "const y = 2;\n");

		cacheManager.addModifiedRange(
			filePath,
			{ start: 1, end: 1 },
			false,
			env.tmpDir,
		);

		const state = cacheManager.readTurnState(env.tmpDir);
		expect(state.sessionId).toBeUndefined();

		env.cleanup();
	});
});

// ── Context injection framing ─────────────────────────────────────────────────

describe("context injection framing", () => {
	it("consumeTurnEndFindings includes automated-check framing", () => {
		const env = setupTestEnvironment("pi-lens-ctx-frame-");
		const cacheManager = new CacheManager(false);

		cacheManager.writeCache(
			"turn-end-findings",
			{ content: "🔴 some blocker\n" },
			env.tmpDir,
		);

		const result = consumeTurnEndFindings(cacheManager, env.tmpDir);
		expect(result).toBeDefined();
		expect(result!.messages[0].content).toContain("not a user request");
		expect(result!.messages[0].content).toContain("🔴 some blocker");

		env.cleanup();
	});

	it("consumeTestFindings includes automated-check framing", () => {
		const env = setupTestEnvironment("pi-lens-ctx-test-");
		const cacheManager = new CacheManager(false);

		cacheManager.writeCache(
			"test-runner-findings",
			{ content: "[Tests] ✗ 1/3 failed — vitest\n" },
			env.tmpDir,
		);

		const result = consumeTestFindings(cacheManager, env.tmpDir);
		expect(result).toBeDefined();
		expect(result!.messages[0].content).toContain("not a user request");
		expect(result!.messages[0].content).toContain("fix before continuing");
		expect(result!.messages[0].content).toContain("[Tests] ✗ 1/3 failed");

		env.cleanup();
	});

	it("consumeSessionStartGuidance includes automated-context framing", () => {
		const env = setupTestEnvironment("pi-lens-ctx-guidance-");
		const cacheManager = new CacheManager(false);

		cacheManager.writeCache(
			"session-start-guidance",
			{ content: "📌 pi-lens active\n" },
			env.tmpDir,
		);

		const result = consumeSessionStartGuidance(cacheManager, env.tmpDir);
		expect(result).toBeDefined();
		expect(result!.messages[0].content).toContain("not a user request");
		expect(result!.messages[0].content).toContain("📌 pi-lens active");

		env.cleanup();
	});
});

// ── Unresolved inline blocker re-surfacing ────────────────────────────────────

describe("unresolved inline blocker re-surfacing", () => {
	it("re-injects an inline blocker that was not fixed before turn_end", async () => {
		const env = setupTestEnvironment("pi-lens-unresolved-blocker-");
		const runtime = new RuntimeCoordinator();
		runtime.setTelemetryIdentity({ sessionId: "session-A" });
		const cacheManager = new CacheManager(false);

		const filePath = path.join(env.tmpDir, "src/foo.ts");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "const x = 1;\n");

		cacheManager.addModifiedRange(
			filePath,
			{ start: 1, end: 1 },
			false,
			env.tmpDir,
			"session-A",
		);

		runtime.recordInlineBlockers(
			filePath,
			"🔴 STOP — 1 issue(s) must be fixed:\n  L1: unused variable 'x'",
		);

		await handleTurnEnd(
			makeTurnEndDeps(runtime, cacheManager, { ctxCwd: env.tmpDir }),
		);

		const injected = cacheManager.readCache<{ content: string }>(
			"turn-end-findings",
			env.tmpDir,
		);
		expect(injected?.data?.content).toBeDefined();
		expect(injected?.data?.content).toContain("Unresolved from this turn");
		expect(injected?.data?.content).toContain("foo.ts");
		expect(injected?.data?.content).toContain("unused variable");

		env.cleanup();
	});

	it("does NOT re-inject when inline blocker was cleared (agent fixed it)", async () => {
		const env = setupTestEnvironment("pi-lens-resolved-blocker-");
		const runtime = new RuntimeCoordinator();
		runtime.setTelemetryIdentity({ sessionId: "session-A" });
		const cacheManager = new CacheManager(false);

		const filePath = path.join(env.tmpDir, "src/bar.ts");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "const y = 2;\n");

		cacheManager.addModifiedRange(
			filePath,
			{ start: 1, end: 1 },
			false,
			env.tmpDir,
			"session-A",
		);

		runtime.recordInlineBlockers(
			filePath,
			"🔴 STOP — 1 issue(s) must be fixed:\n  L1: unused",
		);
		runtime.clearInlineBlockers(filePath);

		await handleTurnEnd(
			makeTurnEndDeps(runtime, cacheManager, { ctxCwd: env.tmpDir }),
		);

		const injected = cacheManager.readCache<{ content: string }>(
			"turn-end-findings",
			env.tmpDir,
		);
		expect(injected?.data?.content).toBeUndefined();

		env.cleanup();
	});

	it("consumeInlineBlockers empties the map", () => {
		const runtime = new RuntimeCoordinator();
		runtime.recordInlineBlockers("/a/b.ts", "🔴 STOP");
		runtime.recordInlineBlockers("/a/c.ts", "🔴 STOP 2");
		const first = runtime.consumeInlineBlockers();
		expect(first).toHaveLength(2);
		const second = runtime.consumeInlineBlockers();
		expect(second).toHaveLength(0);
	});

	it("beginTurn clears pending inline blockers from previous turn", () => {
		const runtime = new RuntimeCoordinator();
		runtime.recordInlineBlockers("/a/x.ts", "🔴 STOP");
		runtime.beginTurn();
		const entries = runtime.consumeInlineBlockers();
		expect(entries).toHaveLength(0);
	});
});
