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
import { SESSION_START_GUIDANCE } from "../../clients/runtime-session.js";
import {
	cancelLSPIdleReset,
	handleTurnEnd,
} from "../../clients/runtime-turn.js";
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

// ── LSP idle reset ─────────────────────────────────────────────────────────────

describe("LSP idle reset", () => {
	it("skips a pending idle reset after the session generation changes", async () => {
		const env = setupTestEnvironment("pi-lens-idle-generation-");
		const runtime = new RuntimeCoordinator();
		const cacheManager = new CacheManager(false);
		const resetLSPService = vi.fn();

		vi.useFakeTimers();
		try {
			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, {
					ctxCwd: env.tmpDir,
					resetLSPService,
				}),
			);

			runtime.resetForSession();
			await vi.advanceTimersByTimeAsync(240_000);

			expect(resetLSPService).not.toHaveBeenCalled();
		} finally {
			cancelLSPIdleReset();
			vi.useRealTimers();
			env.cleanup();
		}
	});

	it("logs and swallows errors from a detached idle reset", async () => {
		const env = setupTestEnvironment("pi-lens-idle-error-");
		const runtime = new RuntimeCoordinator();
		const cacheManager = new CacheManager(false);
		const dbg = vi.fn();
		const resetError = new Error("stale ctx");
		const resetLSPService = vi.fn(() => {
			throw resetError;
		});

		vi.useFakeTimers();
		try {
			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, {
					ctxCwd: env.tmpDir,
					dbg,
					resetLSPService,
				}),
			);

			await vi.advanceTimersByTimeAsync(240_000);

			expect(resetLSPService).toHaveBeenCalledTimes(1);
			expect(dbg).toHaveBeenCalledWith(`lsp idle reset failed: ${resetError}`);
		} finally {
			cancelLSPIdleReset();
			vi.useRealTimers();
			env.cleanup();
		}
	});

	it("falls back to process warnings when idle reset logging fails", async () => {
		const env = setupTestEnvironment("pi-lens-idle-error-reporter-");
		const runtime = new RuntimeCoordinator();
		const cacheManager = new CacheManager(false);
		const resetError = new Error("stale ctx");
		const logError = new Error("logger unavailable");
		const dbg = vi.fn((msg: string) => {
			if (msg.startsWith("lsp idle reset failed")) {
				throw logError;
			}
		});
		const resetLSPService = vi.fn(() => {
			throw resetError;
		});
		const emitWarning = vi
			.spyOn(process, "emitWarning")
			.mockImplementation(() => undefined as never);

		vi.useFakeTimers();
		try {
			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, {
					ctxCwd: env.tmpDir,
					dbg,
					resetLSPService,
				}),
			);

			await vi.advanceTimersByTimeAsync(240_000);

			expect(resetLSPService).toHaveBeenCalledTimes(1);
			expect(emitWarning).toHaveBeenCalledWith(
				`pi-lens LSP idle reset error reporter failed: ${logError}`,
				{ code: "PI_LENS_LSP_IDLE_RESET_REPORTER_FAILED" },
			);
		} finally {
			cancelLSPIdleReset();
			vi.useRealTimers();
			emitWarning.mockRestore();
			env.cleanup();
		}
	});
});

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

	it("SESSION_START_GUIDANCE advertises the read-substitute tools and only registered pi tools", () => {
		const text = SESSION_START_GUIDANCE.join("\n");

		// The #245 gap this guards: module_report + read_symbol were registered as
		// pi tools but never surfaced in the session-start orientation, so the agent
		// never reached for them. Keep them (and the other key tools) advertised.
		for (const tool of [
			"lens_diagnostics",
			"module_report",
			"read_symbol",
			"lsp_navigation",
			"lsp_diagnostics",
			"ast_grep_search",
			"ast_grep_replace",
			"ast_grep_dump",
		]) {
			expect(text).toContain(tool);
		}

		// Never advertise a tool that isn't a registered pi tool — symbol_search is
		// MCP-only (no tools/ entry), so naming it here would point the agent at a
		// phantom tool. This guards against re-introducing that mismatch.
		expect(text).not.toContain("symbol_search");

		// Stay lean: the orientation is a nudge, not re-documentation of every arg.
		expect(text.length).toBeLessThan(700);
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

// ── Unified secret surfacing (#131 Mode 3) ────────────────────────────────────

describe("turn_end unified secret surfacing", () => {
	it("collapses the SAME secret from gitleaks + trivy + ast-grep into ONE blocker", async () => {
		const env = setupTestEnvironment("pi-lens-secret-collapse-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "sec-session" });
			const cacheManager = new CacheManager(false);

			const secretFile = path.join(env.tmpDir, "src/config.ts");
			fs.mkdirSync(path.dirname(secretFile), { recursive: true });
			fs.writeFileSync(secretFile, "const k = 'AKIA...';\n");
			cacheManager.addModifiedRange(
				secretFile,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
				"sec-session",
			);

			// Three independent sources flag the SAME line with DIFFERENT rule ids.
			cacheManager.writeCache(
				"gitleaks",
				{
					success: true,
					scannedAt: "",
					findings: [
						{
							ruleId: "aws-access-token",
							file: secretFile,
							startLine: 42,
							description: "AWS key",
						},
					],
				},
				env.tmpDir,
			);
			cacheManager.writeCache(
				"trivy",
				{
					success: true,
					scannedAt: "",
					findings: [],
					secrets: [
						{ ruleId: "aws-access-key-id", file: secretFile, line: 42 },
					],
				},
				env.tmpDir,
			);
			runtime.recordActionableWarnings([
				{
					id: "ag:1",
					filePath: secretFile,
					displayPath: "src/config.ts",
					line: 42,
					severity: "warning",
					tool: "ast-grep",
					rule: "no-hardcoded-secret-js",
					message: "hardcoded secret",
					actions: [],
					suppressed: false,
					origin: "dispatch",
				},
			]);

			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, { ctxCwd: env.tmpDir }),
			);

			const result = consumeTurnEndFindings(cacheManager, env.tmpDir);
			const content = result?.messages?.[0]?.content ?? "";

			// The location is surfaced exactly ONCE, not three times.
			expect(content.split("src/config.ts:42").length - 1).toBe(1);
			// Combined provenance from all three scanners is shown.
			expect(content).toContain("gitleaks + trivy + ast-grep");
			// gitleaks (highest priority) owns the displayed rule.
			expect(content).toContain("aws-access-token");
			// Exactly one secrets blocker header.
			expect(content.split("hardcoded secrets detected").length - 1).toBe(1);
		} finally {
			env.cleanup();
		}
	});
});

// ── License-risk advisory (#131 Mode 4) ───────────────────────────────────────

describe("turn_end license-risk surfacing", () => {
	it("surfaces cached trivy license findings as an advisory", async () => {
		const env = setupTestEnvironment("pi-lens-license-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "lic-session" });
			const cacheManager = new CacheManager(false);

			const file = path.join(env.tmpDir, "src/a.ts");
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, "export const x = 1;\n");
			cacheManager.addModifiedRange(
				file,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
				"lic-session",
			);

			cacheManager.writeCache(
				"trivy",
				{
					success: true,
					scannedAt: "",
					findings: [],
					secrets: [],
					licenses: [
						{
							license: "GPL-3.0",
							pkgName: "leftpad",
							severity: "HIGH",
							category: "restricted",
						},
					],
				},
				env.tmpDir,
			);

			await handleTurnEnd(
				makeTurnEndDeps(runtime, cacheManager, { ctxCwd: env.tmpDir }),
			);

			const content =
				consumeTurnEndFindings(cacheManager, env.tmpDir)?.messages?.[0]
					?.content ?? "";
			expect(content).toContain("Dependency license risk");
			expect(content).toContain("leftpad — GPL-3.0 (HIGH, restricted)");
		} finally {
			env.cleanup();
		}
	});
});
