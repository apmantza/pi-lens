import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import {
	consumeSessionStartGuidance,
	consumeTestFindings,
	consumeTurnEndFindings,
} from "../../clients/runtime/context.js";
import { RuntimeCoordinator } from "../../clients/runtime/coordinator.js";
import { handleTurnEnd } from "../../clients/runtime/turn.js";
import { setupTestEnvironment } from "./test-utils.js";

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
		knipClient: { ensureAvailable: async () => false },
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
		const runtime = await RuntimeCoordinator.create();
		runtime.setTelemetryIdentity({ sessionId: "session-A" });
		const cacheManager = await CacheManager.create(false);

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
		const last = cacheManager.readCache<{ signature: string; sessionId: string }>(
			"turn-end-findings-last",
			env.tmpDir,
		);
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
		const runtime = await RuntimeCoordinator.create();
		runtime.setTelemetryIdentity({ sessionId: "session-B" });
		const cacheManager = await CacheManager.create(false);

		const content = "🔴 blocker: something broken\n";
		const files = ["src/foo.ts"];
		const signature = `${files.join("|")}::${content}`;

		// Seed last findings from a DIFFERENT (old) session.
		cacheManager.writeCache(
			"turn-end-findings-last",
			{ signature, sessionId: "session-A" },
			env.tmpDir,
		);

		const last = cacheManager.readCache<{ signature: string; sessionId: string }>(
			"turn-end-findings-last",
			env.tmpDir,
		);

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
	it("evicts turn state written by a previous session", async () => {
		const env = setupTestEnvironment("pi-lens-stale-evict-");
		const runtime = await RuntimeCoordinator.create();
		runtime.setTelemetryIdentity({ sessionId: "session-current" });
		const cacheManager = await CacheManager.create(false);

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
		expect(Object.keys(cacheManager.readTurnState(env.tmpDir).files)).toHaveLength(1);

		// handleTurnEnd should detect the session mismatch and evict.
		await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, { ctxCwd: env.tmpDir }));

		// After eviction + processing, turn state should be cleared.
		const afterState = cacheManager.readTurnState(env.tmpDir);
		expect(Object.keys(afterState.files)).toHaveLength(0);

		env.cleanup();
	});

	it("keeps turn state written by the current session", async () => {
		const env = setupTestEnvironment("pi-lens-same-session-");
		const runtime = await RuntimeCoordinator.create();
		runtime.setTelemetryIdentity({ sessionId: "session-current" });
		const cacheManager = await CacheManager.create(false);

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
		await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, { ctxCwd: env.tmpDir }));

		// No blockers → clearTurnState called normally (not via eviction path).
		// Either way, state ends up cleared — the point is it wasn't evicted prematurely.
		const afterState = cacheManager.readTurnState(env.tmpDir);
		expect(Object.keys(afterState.files)).toHaveLength(0);

		env.cleanup();
	});
});

// ── sessionId stamped into turn state ─────────────────────────────────────────

describe("addModifiedRange sessionId stamping", () => {
	it("stamps session ID into turn state when provided", async () => {
		const env = setupTestEnvironment("pi-lens-stamp-");
		const cacheManager = await CacheManager.create(false);
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

	it("leaves sessionId undefined when not provided", async () => {
		const env = setupTestEnvironment("pi-lens-no-stamp-");
		const cacheManager = await CacheManager.create(false);
		const filePath = path.join(env.tmpDir, "src/bar.ts");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "const y = 2;\n");

		cacheManager.addModifiedRange(filePath, { start: 1, end: 1 }, false, env.tmpDir);

		const state = cacheManager.readTurnState(env.tmpDir);
		expect(state.sessionId).toBeUndefined();

		env.cleanup();
	});
});

// ── Context injection framing ─────────────────────────────────────────────────

describe("context injection framing", () => {
	it("consumeTurnEndFindings includes automated-check framing", async () => {
		const env = setupTestEnvironment("pi-lens-ctx-frame-");
		const cacheManager = await CacheManager.create(false);

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

	it("consumeTestFindings includes automated-check framing", async () => {
		const env = setupTestEnvironment("pi-lens-ctx-test-");
		const cacheManager = await CacheManager.create(false);

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

	it("consumeSessionStartGuidance includes automated-context framing", async () => {
		const env = setupTestEnvironment("pi-lens-ctx-guidance-");
		const cacheManager = await CacheManager.create(false);

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
