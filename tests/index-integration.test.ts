import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CacheManager } from "../clients/cache-manager.js";
import { getEffectiveLspIdleResetMs } from "../clients/runtime-turn.js";
import { createPiMock, makeCtx, makeStaleCtx } from "./support/pi-mock.js";
import { removeTempDirSync } from "./clients/test-utils.js";
import { makeLspServiceDouble } from "./support/lsp-service-double.js";
// #2146: process-scope state (the primary-session registration, the instance
// registry's mutation tail) now lives on `globalThis`, so `vi.resetModules()`
// no longer clears it — that is the fix, not a regression. This suite gives
// every case a cold extension graph, so it must reset the process state too.
import { _resetProcessSingletonsForTests } from "../clients/process-singletons.js";

const r6Mocks = vi.hoisted(() => ({
	incrementDegradationCount: vi.fn(),
}));

// This suite predates the consolidated harness and is written against the
// legacy `{ pi, handlers, commands }` shape. Adapt the canonical createPiMock
// to that shape so there is a single mock recorder (the old tests/support/
// mock-pi.ts is removed), and preserve the default flags these tests assume.
// Call sites can move to the native createPiMock API (getHandlers/emit)
// opportunistically (#171).
// Each test does `vi.resetModules()` + `await import("../index.js")`, so every
// case cold-evaluates the WHOLE extension dependency graph. That's inherently
// heavy, and under full-suite parallel-transform contention the first/most
// complex case (the session_start closure test) can exceed a tight per-test
// budget — it passes in ~3s isolated but was flaking at 15s under load. This is
// a time-budget issue, not a hang, so give these import-bound integration tests
// generous headroom; a genuine deadlock still fails, just later.
const INTEGRATION_TIMEOUT_MS = 45_000;

type IntegrationHook = (event: unknown, ctx: unknown) => unknown;
function createMockPi(overrides: Record<string, boolean> = {}) {
	const mock = createPiMock({
		"lens-lsp": true,
		"no-lsp": false,
		"lens-guard": false,
		...overrides,
	});
	return {
		mock,
		pi: mock.asExtensionAPI(),
		// #484: raw mock recordings not on the ExtensionAPI type surface
		// (sentMessages, messageRenderers) — exposed directly for tests that
		// assert on pi.sendMessage/registerMessageRenderer calls.
		sentMessages: mock.sentMessages,
		messageRenderers: mock.messageRenderers,
		handlers: new Proxy({} as Record<string, IntegrationHook[]>, {
			get: (_target, prop) =>
				typeof prop === "string" ? mock.handlers.get(prop) : undefined,
		}),
		commands: {
			// Legacy call sites invoke handlers as `handler(event, ctx)` with loose
			// args; expose that signature (the adapter is the compatibility layer).
			get: (name: string) =>
				mock.getCommand(name) as
					| {
							handler?: (args: unknown, ctx: unknown) => unknown;
							description?: string;
					  }
					| undefined,
		},
		tools: mock.tools,
		async trigger(event: string, ev: unknown, ctx: unknown = {}) {
			const results: unknown[] = [];
			for (const handler of mock.getHandlers(event)) {
				results.push(await handler(ev, ctx));
			}
			return results;
		},
	};
}

// Mock read-guard for integration tests to avoid dynamic require issues
vi.mock("../clients/read-guard.js", () => ({
	ReadGuard: class MockReadGuard {
		isNewFile() {
			return false;
		}
		checkEdit() {
			return { action: "allow" };
		}
		recordRead() {}
		recordWritten() {}
		noteCreatedFile() {}
		getReadHistory() {
			return [];
		}
		getEditHistory() {
			return [];
		}
		addExemption() {}
		getSummary() {
			return {
				totalEdits: 0,
				totalBlocks: 0,
				byReason: {},
				byFile: {},
				lspExpansionsHelped: 0,
			};
		}
	},
	createReadGuard: () =>
		new (class MockReadGuard {
			isNewFile() {
				return false;
			}
			checkEdit() {
				return { action: "allow" };
			}
			recordRead() {}
			recordWritten() {}
			noteCreatedFile() {}
			getReadHistory() {
				return [];
			}
			getEditHistory() {
				return [];
			}
			addExemption() {}
			getSummary() {
				return {
					totalEdits: 0,
					totalBlocks: 0,
					byReason: {},
					byFile: {},
					lspExpansionsHelped: 0,
				};
			}
		})(),
}));

describe("index.ts integration", () => {
	let tmpDir: string;
	let originalStartupMode: string | undefined;

	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		_resetProcessSingletonsForTests();
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-index-int-"));
		originalStartupMode = process.env.PI_LENS_STARTUP_MODE;
		process.env.PI_LENS_STARTUP_MODE = "quick";
	});

	afterEach(() => {
		removeTempDirSync(tmpDir);
		if (originalStartupMode === undefined)
			delete process.env.PI_LENS_STARTUP_MODE;
		else process.env.PI_LENS_STARTUP_MODE = originalStartupMode;
		vi.restoreAllMocks();
	});

	it(
		"session_start handler passes working ensureTool closure into handleSessionStart",
		async () => {
			const ensureToolMock = vi.fn(async (name: string) => `/mock/${name}`);
			const handleSessionStartMock = vi.fn(
				async (deps: {
					ensureTool: (name: string) => Promise<string | undefined>;
				}) => {
					await expect(
						deps.ensureTool("typescript-language-server"),
					).resolves.toBe("/mock/typescript-language-server");
				},
			);

			vi.doMock("../clients/bootstrap.js", async () => {
				const { bootstrapSeamMock } =
					await import("./support/bootstrap-mock.js");
				return bootstrapSeamMock(async () => ({
					metricsClient: { reset: () => {} },
					todoScanner: {},
					biomeClient: { isAvailable: () => false },
					ruffClient: { isAvailable: () => false },
					knipClient: {
						isAvailable: () => false,
						analyze: async () => ({
							success: false,
							summary: "unavailable",
							issues: [],
						}),
					},
					jscpdClient: { isAvailable: () => false },
					depChecker: { isAvailable: () => false },
					testRunnerClient: { detectRunner: () => null },
					goClient: { isGoAvailableAsync: async () => false },
					rustClient: { isAvailableAsync: async () => false },
					agentBehaviorClient: {
						recordToolCall: () => {},
						formatWarnings: () => "",
					},
					complexityClient: {
						isSupportedFile: () => false,
						analyzeFile: () => null,
					},
				}));
			});
			vi.doMock("../clients/runtime-session.js", () => ({
				handleSessionStart: handleSessionStartMock,
			}));
			vi.doMock("../clients/installer/index.js", () => ({
				ensureTool: ensureToolMock,
			}));

			const { default: registerExtension } = await import("../index.js");
			const { pi, handlers } = createMockPi();
			registerExtension(pi as any);

			const sessionStart = handlers.session_start?.[0];
			expect(sessionStart).toBeTypeOf("function");

			await sessionStart?.({}, { cwd: tmpDir, ui: { notify: vi.fn() } });

			expect(handleSessionStartMock).toHaveBeenCalledTimes(1);
			expect(ensureToolMock).toHaveBeenCalledWith("typescript-language-server");
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"session_shutdown uses fast LSP reset so teardown does not wait on graceful shutdown",
		async () => {
			const resetLSPService = vi.fn();
			vi.doMock("../clients/lsp/index.js", () => ({
				getLSPService: () => makeLspServiceDouble(),
				resetLSPService,
			}));

			const { default: registerExtension } = await import("../index.js");
			const { pi, handlers } = createMockPi();
			registerExtension(pi as any);

			const shutdown = handlers.session_shutdown?.[0];
			expect(shutdown).toBeTypeOf("function");
			shutdown?.({ reason: "quit" }, { cwd: tmpDir });
			// processExiting:true is required alongside fast — at session_shutdown the
			// event loop is closing, so killProcessTree must terminate via the held
			// handle instead of spawning taskkill (Windows libuv abort, #234 / caf2ee8).
			expect(resetLSPService).toHaveBeenCalledWith({
				fast: true,
				processExiting: true,
				reason: "session_shutdown",
			});
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"session_shutdown dumps active handles AFTER LSP teardown (#1123 item 4)",
		async () => {
			// #1097 lesson: "what survives IS the leak" — the dump must run after
			// resetLSPService, not before, or it would report handles teardown was
			// about to close as still-alive noise.
			const order: string[] = [];
			const resetLSPService = vi.fn(() => {
				order.push("reset_lsp_service");
			});
			vi.doMock("../clients/lsp/index.js", () => ({
				getLSPService: () => makeLspServiceDouble(),
				resetLSPService,
			}));
			vi.doMock("../clients/debug-handles.js", () => ({
				dumpActiveHandles: (label: string) => {
					order.push(`dump:${label}`);
				},
			}));

			const { default: registerExtension } = await import("../index.js");
			const { pi, handlers } = createMockPi();
			registerExtension(pi as any);

			const shutdown = handlers.session_shutdown?.[0];
			expect(shutdown).toBeTypeOf("function");
			shutdown?.({ reason: "quit" }, { cwd: tmpDir });

			expect(order).toEqual(["reset_lsp_service", "dump:session_shutdown"]);
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"session_shutdown emits the bus-event session-end rollup (S2d gap 5, #1432 review)",
		async () => {
			vi.doMock("../clients/lsp/index.js", () => ({
				getLSPService: () => makeLspServiceDouble(),
				resetLSPService: vi.fn(),
			}));
			const emitBusEventRollupAtSessionEnd = vi.fn();
			vi.doMock("../clients/bus-events-logger.js", async (importActual) => {
				const actual =
					await importActual<
						typeof import("../clients/bus-events-logger.js")
					>();
				return { ...actual, emitBusEventRollupAtSessionEnd };
			});

			const { default: registerExtension } = await import("../index.js");
			const { pi, handlers } = createMockPi();
			registerExtension(pi as any);

			const shutdown = handlers.session_shutdown?.[0];
			expect(shutdown).toBeTypeOf("function");
			shutdown?.({ reason: "quit" }, { cwd: tmpDir });

			expect(emitBusEventRollupAtSessionEnd).toHaveBeenCalledTimes(1);
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"session_start resets the verified-attribution tally through the event",
		async () => {
			const telemetry =
				await import("../clients/path-attribution-telemetry.js");
			telemetry.recordVerifiedPathAttributionGuess();
			const { default: registerExtension } = await import("../index.js");
			const { pi, handlers } = createMockPi();
			registerExtension(pi as any);
			await handlers.session_start?.[0]?.(
				{},
				makeCtx({ cwd: tmpDir, sessionId: "primary" }),
			);
			expect(telemetry.getVerifiedPathAttributionGuessCount()).toBe(0);
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"primary session_shutdown emits one rollup and clears it, while zero stays silent",
		async () => {
			const logLatency = vi.fn();
			vi.doMock("../clients/latency-logger.js", async (importActual) => ({
				...(await importActual<
					typeof import("../clients/latency-logger.js")
				>()),
				logLatency,
			}));
			const telemetry =
				await import("../clients/path-attribution-telemetry.js");
			const { default: registerExtension } = await import("../index.js");
			const { pi, handlers } = createMockPi();
			registerExtension(pi as any);
			const shutdown = handlers.session_shutdown?.[0];
			telemetry.recordVerifiedPathAttributionGuess();
			shutdown?.({}, makeCtx({ cwd: tmpDir, sessionId: "primary" }));
			const rollups = () =>
				logLatency.mock.calls.filter(
					([row]) =>
						(row as { phase?: string }).phase ===
						"path_attribution_verified_rollup",
				);
			expect(rollups()).toHaveLength(1);
			expect(rollups()[0][0]).toEqual(
				expect.objectContaining({ phase: "path_attribution_verified_rollup" }),
			);
			expect(telemetry.getVerifiedPathAttributionGuessCount()).toBe(0);
			logLatency.mockClear();
			shutdown?.({}, makeCtx({ cwd: tmpDir, sessionId: "primary" }));
			expect(rollups()).toHaveLength(0);
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"secondary session_shutdown does not consume the primary tally",
		async () => {
			const logLatency = vi.fn();
			vi.doMock("../clients/latency-logger.js", async (importActual) => ({
				...(await importActual<
					typeof import("../clients/latency-logger.js")
				>()),
				logLatency,
			}));
			const telemetry =
				await import("../clients/path-attribution-telemetry.js");
			const { default: registerExtension } = await import("../index.js");
			const primary = createPiMock({
				"lens-lsp": true,
				"no-lsp": false,
				"lens-guard": false,
			});
			registerExtension(primary.asExtensionAPI());
			await primary.emit(
				"session_start",
				{},
				makeCtx({ cwd: tmpDir, sessionId: "primary" }),
			);
			telemetry.recordVerifiedPathAttributionGuess();
			const lspServer = await import("../clients/lsp/server.js");
			lspServer._markDirectLspCommandUnavailableForTests(
				"secondary-must-not-reset",
			);
			const secondary = createPiMock({
				"lens-lsp": true,
				"no-lsp": false,
				"lens-guard": false,
			});
			registerExtension(secondary.asExtensionAPI());
			await secondary.emit(
				"session_start",
				{},
				makeCtx({ cwd: tmpDir, sessionId: "secondary" }),
			);
			expect(telemetry.getVerifiedPathAttributionGuessCount()).toBe(1);
			expect(
				lspServer.isDirectLspCommandTemporarilyUnavailable(
					"secondary-must-not-reset",
				),
			).toBe(true);
			await secondary.emit(
				"session_shutdown",
				{},
				makeCtx({ cwd: tmpDir, sessionId: "secondary" }),
			);
			expect(
				logLatency.mock.calls.filter(
					([row]) =>
						(row as { phase?: string }).phase ===
						"path_attribution_verified_rollup",
				),
			).toHaveLength(0);
			expect(telemetry.getVerifiedPathAttributionGuessCount()).toBe(1);
			await primary.emit(
				"session_shutdown",
				{},
				makeCtx({ cwd: tmpDir, sessionId: "primary" }),
			);
			expect(
				logLatency.mock.calls.filter(
					([row]) =>
						(row as { phase?: string }).phase ===
						"path_attribution_verified_rollup",
				),
			).toHaveLength(1);
			expect(telemetry.getVerifiedPathAttributionGuessCount()).toBe(0);
		},
		INTEGRATION_TIMEOUT_MS,
	);

	// #2249: the declined-bind rollup. Same primary-only reset/emit placement
	// as the verified-attribution tally above, but process-singleton backed
	// (AGENTS.md catalog shape 25) rather than a module-scope `let`, and the
	// counter is driven by the REAL decideSessionStart decline path rather
	// than a manual record call, so these also exercise the production wiring
	// end to end.
	it(
		"a NEW primary's session_start clears a stale rollup left by a crashed prior primary",
		async () => {
			const logLatency = vi.fn();
			vi.doMock("../clients/latency-logger.js", async (importActual) => ({
				...(await importActual<
					typeof import("../clients/latency-logger.js")
				>()),
				logLatency,
			}));
			const observability =
				await import("../clients/session-start-observability.js");
			// Simulates a prior primary session that logged a decline and then
			// never reached session_shutdown (crash/forced kill) — the counters
			// are process-wide (globalThis-backed) state that outlives it.
			observability.logConcurrentSessionBind({
				secondaryCount: 1,
				sameCwd: true,
				classification: "concurrent-secondary",
			});
			const { default: registerExtension } = await import("../index.js");
			const { pi, handlers } = createMockPi();
			registerExtension(pi as any);
			await handlers.session_start?.[0]?.(
				{},
				makeCtx({ cwd: tmpDir, sessionId: "primary" }),
			);
			expect(observability.getConcurrentSessionBindRollupCounts()).toEqual({
				"concurrent-secondary": 0,
				"secondary-root": 0,
				unclassified: 0,
			});
			// #2312 review F1: the crashed prior primary never reached
			// session_shutdown, so its tally would otherwise be silently
			// discarded by the reset above instead of summarized. The fresh
			// primary's session_start must emit the stale tally before
			// clearing it — exactly one row, not zero and not more.
			const rollups = logLatency.mock.calls.filter(
				([row]) =>
					(row as { phase?: string }).phase ===
					"concurrent_session_bind_rollup",
			);
			expect(rollups).toHaveLength(1);
			expect(rollups[0][0]).toEqual(
				expect.objectContaining({
					phase: "concurrent_session_bind_rollup",
					metadata: {
						"concurrent-secondary": 1,
						"secondary-root": 0,
						unclassified: 0,
					},
				}),
			);
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"primary session_shutdown emits one concurrent-session-bind rollup and clears it, while zero stays silent",
		async () => {
			const logLatency = vi.fn();
			vi.doMock("../clients/latency-logger.js", async (importActual) => ({
				...(await importActual<
					typeof import("../clients/latency-logger.js")
				>()),
				logLatency,
			}));
			const observability =
				await import("../clients/session-start-observability.js");
			const { default: registerExtension } = await import("../index.js");
			const { pi, handlers } = createMockPi();
			registerExtension(pi as any);
			const shutdown = handlers.session_shutdown?.[0];
			observability.logConcurrentSessionBind({
				secondaryCount: 1,
				sameCwd: true,
				classification: "concurrent-secondary",
			});
			shutdown?.({}, makeCtx({ cwd: tmpDir, sessionId: "primary" }));
			const rollups = () =>
				logLatency.mock.calls.filter(
					([row]) =>
						(row as { phase?: string }).phase ===
						"concurrent_session_bind_rollup",
				);
			expect(rollups()).toHaveLength(1);
			expect(rollups()[0][0]).toEqual(
				expect.objectContaining({
					phase: "concurrent_session_bind_rollup",
					metadata: {
						"concurrent-secondary": 1,
						"secondary-root": 0,
						unclassified: 0,
					},
				}),
			);
			expect(observability.getConcurrentSessionBindRollupCounts()).toEqual({
				"concurrent-secondary": 0,
				"secondary-root": 0,
				unclassified: 0,
			});
			logLatency.mockClear();
			shutdown?.({}, makeCtx({ cwd: tmpDir, sessionId: "primary" }));
			expect(rollups()).toHaveLength(0);
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"secondary session_shutdown does not consume the primary rollup tally",
		async () => {
			const logLatency = vi.fn();
			vi.doMock("../clients/latency-logger.js", async (importActual) => ({
				...(await importActual<
					typeof import("../clients/latency-logger.js")
				>()),
				logLatency,
			}));
			const observability =
				await import("../clients/session-start-observability.js");
			const { default: registerExtension } = await import("../index.js");
			const primary = createMockPi();
			registerExtension(primary.pi as any);
			await primary.trigger(
				"session_start",
				{},
				makeCtx({ cwd: tmpDir, sessionId: "primary" }),
			);

			const secondary = createMockPi();
			registerExtension(secondary.pi as any);
			// Same cwd, still-live primary ctx, different session id —
			// decideSessionStart classifies this concurrent-secondary and
			// index.ts's session_start handler declines the full start, which is
			// what actually calls logConcurrentSessionBind (real production path,
			// not a manual record call).
			await secondary.trigger(
				"session_start",
				{},
				makeCtx({ cwd: tmpDir, sessionId: "secondary" }),
			);
			expect(observability.getConcurrentSessionBindRollupCounts()).toEqual({
				"concurrent-secondary": 1,
				"secondary-root": 0,
				unclassified: 0,
			});

			const rollups = () =>
				logLatency.mock.calls.filter(
					([row]) =>
						(row as { phase?: string }).phase ===
						"concurrent_session_bind_rollup",
				);

			await secondary.trigger(
				"session_shutdown",
				{},
				makeCtx({ cwd: tmpDir, sessionId: "secondary" }),
			);
			expect(rollups()).toHaveLength(0);
			expect(observability.getConcurrentSessionBindRollupCounts()).toEqual({
				"concurrent-secondary": 1,
				"secondary-root": 0,
				unclassified: 0,
			});

			await primary.trigger(
				"session_shutdown",
				{},
				makeCtx({ cwd: tmpDir, sessionId: "primary" }),
			);
			expect(rollups()).toHaveLength(1);
			expect(observability.getConcurrentSessionBindRollupCounts()).toEqual({
				"concurrent-secondary": 0,
				"secondary-root": 0,
				unclassified: 0,
			});
		},
		INTEGRATION_TIMEOUT_MS,
	);

	// #1910: the tier-3 cascade outstanding-touch registry (clients/lsp/
	// cascade-tier.ts) is process-shared runtime state, same #473 shape as the
	// active-tool set and the direct-LSP latch above. A concurrently-live
	// secondary's session_start must not wipe the still-live primary's
	// outstanding touches out from under it.
	it(
		"primary session_start clears the cascade tier-3 registry, a concurrent secondary's does not",
		async () => {
			// The earlier "session_start handler passes working ensureTool closure
			// into handleSessionStart" case in this file `vi.doMock`s
			// runtime-session.js and never `vi.doUnmock`s it (only line ~1584, in a
			// different describe block, ever does) — `vi.doMock` registrations
			// outlive `vi.resetModules()`, so without this explicit unmock this test
			// would run against that STUBBED handleSessionStart (a no-op) whenever
			// it happens to execute after that one, and pass for the wrong reason
			// (nothing ever resets anything). This test needs the REAL handler.
			// Same leak, second module: the same earlier test also `vi.doMock`s
			// installer/index.js with a partial export set (missing
			// `resetPathWalkMemo`, which `resetDispatchAvailabilityState` — reached
			// from `handleSessionStart` — needs) and never unmocks it either.
			vi.doUnmock("../clients/runtime-session.js");
			vi.doUnmock("../clients/installer/index.js");
			const { default: registerExtension } = await import("../index.js");
			const cascadeTier = await import("../clients/lsp/cascade-tier.js");
			cascadeTier._resetOutstandingCascadeTouchesForTests();

			const primary = createMockPi();
			registerExtension(primary.pi as any);
			await primary.trigger(
				"session_start",
				{},
				makeCtx({ cwd: tmpDir, sessionId: "primary" }),
			);

			// Seed a touch the still-live primary is tracking.
			cascadeTier.recordOutstandingCascadeTouch({
				filePath: `${tmpDir}/neighbor.ts`,
				serverId: "typescript",
				touchedAt: Date.now(),
			});
			expect(
				cascadeTier._getOutstandingCascadeTouchesForTests().length,
			).toBeGreaterThan(0);

			// A concurrently-live secondary binds in the same process (the #473
			// shape) — its session_start must return at the concurrent-secondary
			// guard, above the reset block, and leave the primary's touch alone.
			const secondary = createMockPi();
			registerExtension(secondary.pi as any);
			await secondary.trigger(
				"session_start",
				{},
				makeCtx({ cwd: tmpDir, sessionId: "secondary" }),
			);
			expect(
				cascadeTier._getOutstandingCascadeTouchesForTests().length,
			).toBeGreaterThan(0);

			// A genuine primary session replacement, by contrast, DOES clear it —
			// the whole point of #1910 wiring the reset into handleSessionStart.
			await primary.trigger(
				"session_start",
				{},
				makeCtx({ cwd: tmpDir, sessionId: "primary" }),
			);
			expect(cascadeTier._getOutstandingCascadeTouchesForTests()).toEqual([]);
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"agent_settled dumps active handles AFTER quiet-window work is scheduled (#1123 item 4)",
		async () => {
			// #1097's leak (a stray ref'd timer) only surfaces once whatever
			// agent_settled itself queues is already in flight, so the dump must
			// fire after runQuietWindow is invoked, not before.
			const order: string[] = [];
			vi.doMock("../clients/lsp/index.js", () => ({
				getLSPService: () => makeLspServiceDouble(),
				resetLSPService: vi.fn(),
			}));
			vi.doMock("../clients/quiet-window.js", () => ({
				registerQuietWindowTask: () => {},
				registerBuiltinQuietWindowTasks: () => {},
				runQuietWindow: async () => {
					order.push("quiet_window_scheduled");
				},
			}));
			vi.doMock("../clients/debug-handles.js", () => ({
				dumpActiveHandles: (label: string) => {
					order.push(`dump:${label}`);
				},
			}));

			const { default: registerExtension } = await import("../index.js");
			const { pi, handlers } = createMockPi();
			registerExtension(pi as any);

			const settled = handlers.agent_settled?.[0];
			expect(settled).toBeTypeOf("function");
			await settled?.({}, { cwd: tmpDir });
			// runQuietWindow is kicked off unawaited (fire-and-forget by design);
			// drain the microtask queue before asserting.
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(order).toEqual(["quiet_window_scheduled", "dump:agent_settled"]);
		},
		INTEGRATION_TIMEOUT_MS,
	);

	describe("#1654 deferred-mutation drain runs at agent_settled, not agent_end", () => {
		function mockDrainDeps(handleAgentEndMock: ReturnType<typeof vi.fn>) {
			vi.doMock("../clients/lsp/index.js", () => ({
				getLSPService: () => makeLspServiceDouble(),
				resetLSPService: vi.fn(),
			}));
			vi.doMock("../clients/quiet-window.js", () => ({
				registerQuietWindowTask: () => {},
				registerBuiltinQuietWindowTasks: () => {},
				runQuietWindow: async () => {},
			}));
			vi.doMock("../clients/runtime-agent-end.js", () => ({
				handleAgentEnd: handleAgentEndMock,
			}));
		}

		it(
			"agent_end alone (a run about to retry) does NOT drain — pi never exposes willRetry on this event",
			async () => {
				const handleAgentEndMock = vi.fn(async () => undefined);
				mockDrainDeps(handleAgentEndMock);

				const { default: registerExtension } = await import("../index.js");
				const { pi, handlers } = createMockPi();
				registerExtension(pi as any);

				const agentEnd = handlers.agent_end?.[0];
				expect(agentEnd).toBeTypeOf("function");
				// Simulates pi's auto-retry / overflow-compaction path: agent_end
				// fires, but this run is NOT settled — no agent_settled follows yet.
				await agentEnd?.({ messages: [] }, { cwd: tmpDir });

				expect(handleAgentEndMock).not.toHaveBeenCalled();
			},
			INTEGRATION_TIMEOUT_MS,
		);

		it(
			"agent_settled drains once the whole run (incl. retries) has fully settled",
			async () => {
				const handleAgentEndMock = vi.fn(async () => undefined);
				mockDrainDeps(handleAgentEndMock);

				const { default: registerExtension } = await import("../index.js");
				const { pi, handlers } = createMockPi();
				registerExtension(pi as any);

				// The retry loop plays out entirely between agent_end and
				// agent_settled with no extension-visible signal in between — only
				// agent_settled tells pi-lens the run is genuinely done.
				const agentEnd = handlers.agent_end?.[0];
				await agentEnd?.({ messages: [] }, { cwd: tmpDir });
				expect(handleAgentEndMock).not.toHaveBeenCalled();

				const settled = handlers.agent_settled?.[0];
				expect(settled).toBeTypeOf("function");
				await settled?.({}, { cwd: tmpDir });

				expect(handleAgentEndMock).toHaveBeenCalledTimes(1);
			},
			INTEGRATION_TIMEOUT_MS,
		);

		it(
			"session_shutdown does NOT drain (review round 1, F2) — a run that dies without settling strands until the next session's staleness claim, by design",
			async () => {
				const handleAgentEndMock = vi.fn(async () => undefined);
				mockDrainDeps(handleAgentEndMock);

				const { default: registerExtension } = await import("../index.js");
				const { pi, handlers } = createMockPi();
				registerExtension(pi as any);

				// A run ends (agent_end fires) but the session is torn down before
				// agent_settled ever gets a chance to fire — e.g. a session kill.
				// `agent_settled` is documented to fire on completion, on an aborted
				// run, AND on a throw (the SDK's finally block) — the only way to
				// miss it is the process dying outright, which no session_shutdown
				// handler can help with either (the process is gone first). A
				// session_shutdown-based net was tried and dropped: it fired
				// unawaited ahead of the LSP-fleet teardown right below it,
				// formatting on a dying loop the adjacent teardown comment says must
				// not spawn on, with near-zero real coverage.
				const agentEnd = handlers.agent_end?.[0];
				await agentEnd?.({ messages: [] }, { cwd: tmpDir });
				expect(handleAgentEndMock).not.toHaveBeenCalled();

				const shutdown = handlers.session_shutdown?.[0];
				expect(shutdown).toBeTypeOf("function");
				shutdown?.({ reason: "quit" }, { cwd: tmpDir });
				await new Promise((resolve) => setTimeout(resolve, 0));

				expect(handleAgentEndMock).not.toHaveBeenCalled();
			},
			INTEGRATION_TIMEOUT_MS,
		);

		it(
			"agent_settled sets the ambient abort signal around the drain (F1) — an ESC-aborted run must requeue, not format",
			async () => {
				// #197 / F1: handleAgentEnd's abort/requeue branches
				// (clients/runtime-agent-end.ts) read the ambient signal via
				// `getAmbientAbortSignal()`, a module-level value set by
				// `setAmbientAbortSignal` — not a parameter on the event. If the
				// `agent_settled` wiring doesn't set it from `ctx.signal` before
				// calling the drain, an ESC-aborted run FORMATS every queued file
				// instead of requeuing it (an inversion of the #1642 harm this
				// issue exists to fix), and the abort/requeue branches become
				// production-unreachable (their own unit tests only pass because
				// they hand-set the signal directly).
				const seenAbortedFlags: Array<boolean | undefined> = [];
				const handleAgentEndMock = vi.fn(async () => {
					const { getAmbientAbortSignal } =
						await import("../clients/safe-spawn.js");
					seenAbortedFlags.push(getAmbientAbortSignal()?.aborted);
				});
				mockDrainDeps(handleAgentEndMock);

				const { default: registerExtension } = await import("../index.js");
				const { getAmbientAbortSignal } =
					await import("../clients/safe-spawn.js");
				const { pi, handlers } = createMockPi();
				registerExtension(pi as any);

				const controller = new AbortController();
				controller.abort();

				const settled = handlers.agent_settled?.[0];
				expect(settled).toBeTypeOf("function");
				await settled?.({}, { cwd: tmpDir, signal: controller.signal });

				expect(handleAgentEndMock).toHaveBeenCalledTimes(1);
				// The drain saw the run's real abort state while it ran...
				expect(seenAbortedFlags).toEqual([true]);
				// ...and the ambient signal is cleared afterward, so it can't leak
				// into unrelated later work (matches agent_end/turn_end's own
				// finally-block clear).
				expect(getAmbientAbortSignal()).toBeUndefined();
			},
			INTEGRATION_TIMEOUT_MS,
		);

		it(
			"agent_settled resolves (does not crash with extension_error) when the ctx has gone stale after a session replacement (#1924)",
			async () => {
				// #1924: a session replace/reload (ctx.newSession/fork/switchSession/
				// reload) invalidates the captured ctx mid-run. The next
				// `agent_settled` firing hands the handler a ctx whose every
				// property getter throws the SDK's stale-ctx signature. Pre-fix,
				// `setAmbientAbortSignal(ctx?.signal)` ran with no enclosing
				// try/catch, so that throw propagated straight out of the async
				// handler and the host logged an `extension_error`. Post-fix, the
				// whole body is wrapped and `isStaleExtensionCtxError` degrades it
				// to a no-op.
				const handleAgentEndMock = vi.fn(async () => undefined);
				mockDrainDeps(handleAgentEndMock);

				const { default: registerExtension } = await import("../index.js");
				const { getAmbientAbortSignal } =
					await import("../clients/safe-spawn.js");
				const { pi, handlers } = createMockPi();
				registerExtension(pi as any);

				const STALE_MSG =
					"This extension ctx is stale after session replacement or reload";
				const staleCtx = {};
				for (const prop of ["signal", "cwd", "ui", "sessionManager"]) {
					Object.defineProperty(staleCtx, prop, {
						enumerable: true,
						get() {
							throw new Error(STALE_MSG);
						},
					});
				}

				const settled = handlers.agent_settled?.[0];
				expect(settled).toBeTypeOf("function");
				await expect(settled?.({}, staleCtx)).resolves.toBeUndefined();
				expect(getAmbientAbortSignal()).toBeUndefined();
			},
			INTEGRATION_TIMEOUT_MS,
		);
	});

	it(
		"idle LSP reset repaints the footer to Inactive (detached 240s timer)",
		async () => {
			// The idle reset releases the warm servers from a detached timer with no pi
			// event in flight; without the wrapped reset the footer would keep showing a
			// stale "LSP Active" until the next turn. Assert the timer firing repaints it.
			let aliveIds: string[] = ["typescript"];
			const resetLSPService = vi.fn(() => {
				aliveIds = [];
			});
			vi.doMock("../clients/lsp/index.js", () => ({
				getLSPService: () =>
					makeLspServiceDouble({
						getAliveClientCount: () => aliveIds.length,
						getAliveServerIds: () => aliveIds,
					}),
				resetLSPService,
			}));
			vi.doMock("../clients/bootstrap.js", async () => {
				const { bootstrapSeamMock } =
					await import("./support/bootstrap-mock.js");
				return bootstrapSeamMock(async () => ({
					knipClient: {
						isAvailable: () => false,
						analyze: async () => ({
							success: false,
							summary: "unavailable",
							issues: [],
						}),
					},
					depChecker: { isAvailable: () => false },
					testRunnerClient: { detectRunner: () => null },
				}));
			});

			const { default: registerExtension } = await import("../index.js");
			const { pi, handlers } = createMockPi({ "no-lsp": false });
			registerExtension(pi as any);

			const turnEnd = handlers.turn_end?.[0];
			expect(turnEnd).toBeTypeOf("function");

			const statusUpdates: Array<[string, string | undefined]> = [];
			const ctx = {
				cwd: tmpDir,
				ui: {
					notify: vi.fn(),
					setStatus: (id: string, text: string | undefined) =>
						statusUpdates.push([id, text]),
					// identity theme so the asserted strings are the raw labels
					theme: { fg: (_c: string, s: string) => s },
				},
			};
			const lspStatuses = () =>
				statusUpdates.filter(([id]) => id === "pi-lens-lsp").map(([, t]) => t);

			vi.useFakeTimers();
			try {
				// turn_end with no modified files → schedules the 240s idle reset and
				// repaints the footer to the live state ("Active"), without resetting yet.
				await turnEnd?.({}, ctx);
				expect(lspStatuses().at(-1)).toBe("LSP Active: typescript");
				expect(resetLSPService).not.toHaveBeenCalled();

				// Full idle delay elapses (no further turns) → the detached timer fires
				// the wrapped reset, which releases the servers AND repaints to
				// "Inactive". #1618: derived, so assert against the real computed value.
				await vi.advanceTimersByTimeAsync(getEffectiveLspIdleResetMs());
				expect(resetLSPService).toHaveBeenCalledTimes(1);
				expect(lspStatuses().at(-1)).toBe("LSP Inactive");
			} finally {
				vi.useRealTimers();
			}
		},
		INTEGRATION_TIMEOUT_MS,
	);

	// #1016: pi-lens injects ephemeral turn-end findings via the `context` event.
	// The findings are spliced in IMMEDIATELY BEFORE the final message rather than
	// prepended at index 0, so messages[0] stays byte-stable across turns and the
	// prompt-cache prefix on prefix-caching providers (Anthropic/Bedrock) survives.
	// The real user prompt stays as the trailing message (cache breakpoint), and the
	// existing transcript is never dropped (fe0ed5da: never emit empty input).
	async function loadContextHandler() {
		const { default: registerExtension } = await import("../index.js");
		const { pi, handlers } = createMockPi();
		registerExtension(pi as any);
		const context = handlers.context?.[0];
		expect(context).toBeTypeOf("function");
		return context as IntegrationHook;
	}
	const injectedMatcher = expect.objectContaining({
		role: "user",
		content: expect.stringContaining(
			"[pi-lens automated context — not a user request]",
		),
	});

	it(
		"context handler injects guidance immediately before the final user prompt",
		async () => {
			const context = await loadContextHandler();

			const cacheManager = new CacheManager(false);
			cacheManager.writeCache(
				"session-start-guidance",
				{ content: "Use pi-lens tools when useful." },
				tmpDir,
			);

			// A realistic multi-turn transcript: assistant + prior user turns precede
			// the current user prompt. (With a single-message transcript the old
			// prepend and the new before-final placement coincide, so a multi-message
			// transcript is required to actually exercise the #1016 change.)
			const firstUser = { role: "user", content: "Start the task" };
			const assistant = { role: "assistant", content: "On it." };
			const finalUser = { role: "user", content: "Fix the bug" };
			const existing = [firstUser, assistant, finalUser];

			const result = (await context(
				{ messages: existing },
				{ cwd: tmpDir },
			)) as { messages: Array<{ role: string; content: unknown }> };

			// Full expected ordering: prior turns, then injected block, then the final
			// user prompt — [firstUser, assistant, <injected>, finalUser].
			expect(result).toEqual({
				messages: [firstUser, assistant, injectedMatcher, finalUser],
			});

			// (1) #1016 index-0 stability: messages[0] is untouched. This is the
			// property that FAILS on the old prepend code (injected findings landed at
			// index 0), and it is the actual prompt-cache win.
			expect(result.messages[0]).toEqual(firstUser);

			// (2) Final message unchanged: same role + content as the incoming prompt.
			const last = result.messages[result.messages.length - 1];
			expect(last).toEqual(finalUser);
			expect(last.role).toBe("user");

			// (3) Injected block sits at length - 2, immediately before the final msg.
			expect(result.messages[result.messages.length - 2]).toEqual(
				injectedMatcher,
			);

			// (5) Non-empty input preserved (fe0ed5da): every existing message survives.
			expect(result.messages).toHaveLength(existing.length + 1);
			for (const msg of existing) {
				expect(result.messages).toContainEqual(msg);
			}
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"context injection keeps the prior-conversation prefix byte-identical across turns (#1016 cache win)",
		async () => {
			const firstUser = { role: "user", content: "Start the task" };
			const assistant = { role: "assistant", content: "On it." };
			const finalUser = { role: "user", content: "Fix the bug" };
			const baseTranscript = () => [
				{ ...firstUser },
				{ ...assistant },
				{ ...finalUser },
			];

			// Turn A
			const contextA = await loadContextHandler();
			new CacheManager(false).writeCache(
				"session-start-guidance",
				{ content: "Finding A" },
				tmpDir,
			);
			const resultA = (await contextA(
				{ messages: baseTranscript() },
				{ cwd: tmpDir },
			)) as { messages: Array<{ role: string; content: unknown }> };

			// Turn B — same base transcript, different injected finding. Fresh module
			// registration to mirror a second independent turn.
			vi.resetModules();
			const contextB = await loadContextHandler();
			new CacheManager(false).writeCache(
				"session-start-guidance",
				{ content: "Completely different Finding B" },
				tmpDir,
			);
			const resultB = (await contextB(
				{ messages: baseTranscript() },
				{ cwd: tmpDir },
			)) as { messages: Array<{ role: string; content: unknown }> };

			// The prior conversation prefix (everything up to but excluding the
			// injection point at length - 2) is identical between the two turns — this
			// is exactly what a prefix-caching provider reuses.
			const prefixA = resultA.messages.slice(0, resultA.messages.length - 2);
			const prefixB = resultB.messages.slice(0, resultB.messages.length - 2);
			expect(prefixA).toEqual(prefixB);
			expect(prefixA).toEqual([firstUser, assistant]);

			// They diverge only at the injection slot.
			expect(resultA.messages[resultA.messages.length - 2]).not.toEqual(
				resultB.messages[resultB.messages.length - 2],
			);
			// ...and reconverge on the trailing user prompt.
			expect(resultA.messages[resultA.messages.length - 1]).toEqual(finalUser);
			expect(resultB.messages[resultB.messages.length - 1]).toEqual(finalUser);
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"context handler falls back to prepend for an empty transcript (fe0ed5da: never empty input)",
		async () => {
			const context = await loadContextHandler();
			new CacheManager(false).writeCache(
				"session-start-guidance",
				{ content: "Use pi-lens tools when useful." },
				tmpDir,
			);

			const result = (await context({ messages: [] }, { cwd: tmpDir })) as {
				messages: Array<{ role: string; content: unknown }>;
			};

			// Degenerate case: no trailing message to sit before, so we emit just the
			// injected block (identical to pre-#1016 behavior) — never empty input.
			expect(result.messages.length).toBeGreaterThan(0);
			expect(result.messages[0]).toEqual(injectedMatcher);
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"context handler appends (does NOT splice before) a trailing tool_result so tool_use/tool_result adjacency survives mid-loop (#1016 guard)",
		async () => {
			const context = await loadContextHandler();
			new CacheManager(false).writeCache(
				"session-start-guidance",
				{ content: "Use pi-lens tools when useful." },
				tmpDir,
			);

			// Mid-agentic-loop continuation: the tail is an assistant `tool_use` block
			// immediately followed by the matching `user` `tool_result`. The `context`
			// event fires on this call too, and splicing an injected `user` message
			// BETWEEN them yields a 400 ("tool_use ids were found without tool_result
			// blocks") on Anthropic/Bedrock/OpenAI. The injected findings must therefore
			// be APPENDED after the tool_result, never inserted before it.
			const firstUser = { role: "user", content: "Start the task" };
			const toolUse = {
				role: "assistant",
				content: [{ type: "tool_use", id: "tu_1", name: "read", input: {} }],
			};
			const toolResult = {
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }],
			};
			const existing = [firstUser, toolUse, toolResult];

			const result = (await context(
				{ messages: existing },
				{ cwd: tmpDir },
			)) as { messages: Array<{ role: string; content: unknown }> };

			// tool_result stays IMMEDIATELY after its tool_use — nothing spliced between.
			const toolUseIdx = result.messages.findIndex((m) => m === toolUse);
			expect(toolUseIdx).toBeGreaterThanOrEqual(0);
			expect(result.messages[toolUseIdx + 1]).toBe(toolResult);

			// The findings are appended AFTER the whole transcript, not before the tail.
			expect(result.messages.slice(0, existing.length)).toEqual(existing);
			expect(result.messages[result.messages.length - 1]).toEqual(
				injectedMatcher,
			);

			// index-0 stability still holds (cache prefix preserved).
			expect(result.messages[0]).toEqual(firstUser);
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"context handler is a no-op when there is nothing to inject",
		async () => {
			const context = await loadContextHandler();
			// No cache written → nothing to inject → handler returns undefined (no
			// override), so a non-injecting turn is byte-identical to no handler.
			const finalUser = { role: "user", content: "Fix the bug" };
			const result = await context({ messages: [finalUser] }, { cwd: tmpDir });
			expect(result).toBeUndefined();
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"tool_call records full-file reads from read.path with full line coverage",
		async () => {
			const recordRead = vi.fn();
			const mockReadGuard = {
				recordRead,
				getReadHistory: () => [],
				isNewFile: () => false,
				noteCreatedFile: () => {},
				recordWritten: () => {},
				checkEdit: () => ({ action: "allow" as const }),
			};
			const sourceFile = path.join(tmpDir, "src", "full-read.ts");
			fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
			fs.writeFileSync(sourceFile, "one\ntwo\nthree\nfour\nfive\n");

			vi.doMock("../clients/runtime-coordinator.js", () => ({
				RuntimeCoordinator: class {
					projectRoot = tmpDir;
					turnIndex = 0;
					complexityBaselines = new Map();
					cachedExports = new Map();
					readGuard = mockReadGuard;
					shouldWarmLspOnRead() {
						return true;
					}
					markLspReadWarmStarted() {}
					markLspReadWarmCompleted() {}
					clearLspReadWarmState() {}
					nextWriteIndex() {
						return 1;
					}
					peekWriteIndex() {
						return 1;
					}
					beginTurn() {}
					resetForSession() {}
					setTelemetryIdentity() {}
					telemetrySessionId = "test-session";
				},
			}));
			vi.doMock("../clients/bootstrap.js", async () => {
				const { bootstrapSeamMock } =
					await import("./support/bootstrap-mock.js");
				return bootstrapSeamMock(async () => ({
					metricsClient: { reset: () => {} },
					todoScanner: {},
					biomeClient: { isAvailable: () => false },
					ruffClient: { isAvailable: () => false },
					knipClient: {
						isAvailable: () => false,
						analyze: async () => ({
							success: false,
							summary: "unavailable",
							issues: [],
						}),
					},
					jscpdClient: { isAvailable: () => false },
					depChecker: { isAvailable: () => false },
					testRunnerClient: { detectRunner: () => null },
					goClient: { isGoAvailableAsync: async () => false },
					rustClient: { isAvailableAsync: async () => false },
					agentBehaviorClient: {
						recordToolCall: () => {},
						formatWarnings: () => "",
					},
					complexityClient: {
						isSupportedFile: () => false,
						analyzeFile: () => null,
					},
				}));
			});

			const { default: registerExtension } = await import("../index.js");
			const { pi, handlers } = createMockPi({ "no-lsp": true });
			registerExtension(pi as any);

			const toolCall = handlers.tool_call?.[0];
			expect(toolCall).toBeTypeOf("function");

			await toolCall?.(
				{
					toolName: "read",
					input: {
						path: sourceFile,
					},
				},
				{ cwd: tmpDir },
			);

			expect(recordRead).toHaveBeenCalledTimes(1);
			expect(recordRead).toHaveBeenCalledWith(
				expect.objectContaining({
					filePath: sourceFile,
					requestedOffset: 1,
					requestedLimit: 6,
					effectiveOffset: 1,
					effectiveLimit: 6,
				}),
			);
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"tool_call auto-patches safe indentation-only oldText before read-guard edit checks",
		async () => {
			const checkEdit = vi.fn(() => ({ action: "allow" as const }));
			const sourceFile = path.join(tmpDir, "src", "indent-edit.ts");
			fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
			fs.writeFileSync(sourceFile, "function foo() {\n\treturn 1;\n}\n");

			vi.doMock("../clients/runtime-coordinator.js", () => ({
				RuntimeCoordinator: class {
					projectRoot = tmpDir;
					turnIndex = 0;
					complexityBaselines = new Map();
					cachedExports = new Map();
					readGuard = {
						recordRead: () => {},
						getReadHistory: () => [],
						isNewFile: () => false,
						noteCreatedFile: () => {},
						recordWritten: () => {},
						checkEdit,
					};
					shouldWarmLspOnRead() {
						return false;
					}
					markLspReadWarmStarted() {}
					markLspReadWarmCompleted() {}
					clearLspReadWarmState() {}
					nextWriteIndex() {
						return 1;
					}
					peekWriteIndex() {
						return 1;
					}
					beginTurn() {}
					resetForSession() {}
					setTelemetryIdentity() {}
					telemetrySessionId = "test-session";
				},
			}));
			vi.doMock("../clients/bootstrap.js", async () => {
				const { bootstrapSeamMock } =
					await import("./support/bootstrap-mock.js");
				return bootstrapSeamMock(async () => ({
					metricsClient: { reset: () => {} },
					todoScanner: {},
					biomeClient: { isAvailable: () => false },
					ruffClient: { isAvailable: () => false },
					knipClient: {
						isAvailable: () => false,
						analyze: async () => ({
							success: false,
							summary: "unavailable",
							issues: [],
						}),
					},
					jscpdClient: { isAvailable: () => false },
					depChecker: { isAvailable: () => false },
					testRunnerClient: { detectRunner: () => null },
					goClient: { isGoAvailableAsync: async () => false },
					rustClient: { isAvailableAsync: async () => false },
					agentBehaviorClient: {
						recordToolCall: () => {},
						formatWarnings: () => "",
					},
					complexityClient: {
						isSupportedFile: () => false,
						analyzeFile: () => null,
					},
				}));
			});

			const { default: registerExtension } = await import("../index.js");
			const { pi, handlers } = createMockPi({ "no-lsp": true });
			registerExtension(pi as any);

			const toolCall = handlers.tool_call?.[0];
			expect(toolCall).toBeTypeOf("function");

			const event = {
				toolName: "edit",
				input: {
					path: sourceFile,
					edits: [
						{
							oldText: "function foo() {\n    return 1;\n}",
							newText: "function foo() {\n    return 2;\n}",
						},
					],
				},
			};
			const result = await toolCall?.(event, { cwd: tmpDir });

			expect(result).toBeUndefined();
			expect(event.input.edits[0].oldText).toBe(
				"function foo() {\n\treturn 1;\n}",
			);
			expect(event.input.edits[0].newText).toBe(
				"function foo() {\n\treturn 2;\n}",
			);
			expect(checkEdit).toHaveBeenCalled();
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"tool_call auto-patches all safe indentation-only oldText entries in multi-edit calls",
		async () => {
			const checkEdit = vi.fn(() => ({ action: "allow" as const }));
			const sourceFile = path.join(tmpDir, "src", "indent-multi-edit.ts");
			fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
			fs.writeFileSync(
				sourceFile,
				"function foo() {\n\treturn 1;\n}\n\nfunction bar() {\n\treturn 2;\n}\n",
			);

			vi.doMock("../clients/runtime-coordinator.js", () => ({
				RuntimeCoordinator: class {
					projectRoot = tmpDir;
					turnIndex = 0;
					complexityBaselines = new Map();
					cachedExports = new Map();
					readGuard = {
						recordRead: () => {},
						getReadHistory: () => [],
						isNewFile: () => false,
						noteCreatedFile: () => {},
						recordWritten: () => {},
						checkEdit,
					};
					shouldWarmLspOnRead() {
						return false;
					}
					markLspReadWarmStarted() {}
					markLspReadWarmCompleted() {}
					clearLspReadWarmState() {}
					nextWriteIndex() {
						return 1;
					}
					peekWriteIndex() {
						return 1;
					}
					beginTurn() {}
					resetForSession() {}
					setTelemetryIdentity() {}
					telemetrySessionId = "test-session";
				},
			}));
			vi.doMock("../clients/bootstrap.js", async () => {
				const { bootstrapSeamMock } =
					await import("./support/bootstrap-mock.js");
				return bootstrapSeamMock(async () => ({
					metricsClient: { reset: () => {} },
					todoScanner: {},
					biomeClient: { isAvailable: () => false },
					ruffClient: { isAvailable: () => false },
					knipClient: {
						isAvailable: () => false,
						analyze: async () => ({
							success: false,
							summary: "unavailable",
							issues: [],
						}),
					},
					jscpdClient: { isAvailable: () => false },
					depChecker: { isAvailable: () => false },
					testRunnerClient: { detectRunner: () => null },
					goClient: { isGoAvailableAsync: async () => false },
					rustClient: { isAvailableAsync: async () => false },
					agentBehaviorClient: {
						recordToolCall: () => {},
						formatWarnings: () => "",
					},
					complexityClient: {
						isSupportedFile: () => false,
						analyzeFile: () => null,
					},
				}));
			});

			const { default: registerExtension } = await import("../index.js");
			const { pi, handlers } = createMockPi({ "no-lsp": true });
			registerExtension(pi as any);

			const toolCall = handlers.tool_call?.[0];
			expect(toolCall).toBeTypeOf("function");

			const event = {
				toolName: "edit",
				input: {
					path: sourceFile,
					edits: [
						{
							oldText: "function foo() {\n    return 1;\n}",
							newText: "function foo() {\n    return 10;\n}",
						},
						{
							oldText: "function bar() {\n    return 2;\n}",
							newText: "function bar() {\n    return 20;\n}",
						},
					],
				},
			};
			const result = await toolCall?.(event, { cwd: tmpDir });

			expect(result).toBeUndefined();
			expect(event.input.edits[0].oldText).toBe(
				"function foo() {\n\treturn 1;\n}",
			);
			expect(event.input.edits[1].oldText).toBe(
				"function bar() {\n\treturn 2;\n}",
			);
			expect(event.input.edits[0].newText).toBe(
				"function foo() {\n\treturn 10;\n}",
			);
			expect(event.input.edits[1].newText).toBe(
				"function bar() {\n\treturn 20;\n}",
			);
			expect(checkEdit).toHaveBeenCalled();
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"tool_call only warms LSP on the first read until warm state is cleared",
		async () => {
			const touchFileMock = vi.fn().mockResolvedValue([]);
			const shouldWarmLspOnRead = vi
				.fn()
				.mockReturnValueOnce(true)
				.mockReturnValueOnce(false)
				.mockReturnValueOnce(true);
			const markLspReadWarmStarted = vi.fn();
			const markLspReadWarmCompleted = vi.fn();
			const clearLspReadWarmState = vi.fn();
			const sourceFile = path.join(tmpDir, "src", "warm-read.ts");
			fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
			fs.writeFileSync(sourceFile, "export const value = 1;\n");

			vi.doMock("../clients/runtime-coordinator.js", () => ({
				RuntimeCoordinator: class {
					projectRoot = tmpDir;
					turnIndex = 0;
					complexityBaselines = new Map();
					cachedExports = new Map();
					readGuard = {
						recordRead: () => {},
						getReadHistory: () => [],
						isNewFile: () => false,
						noteCreatedFile: () => {},
						recordWritten: () => {},
						checkEdit: () => ({ action: "allow" as const }),
					};
					shouldWarmLspOnRead = shouldWarmLspOnRead;
					markLspReadWarmStarted = markLspReadWarmStarted;
					markLspReadWarmCompleted = markLspReadWarmCompleted;
					clearLspReadWarmState = clearLspReadWarmState;
					nextWriteIndex() {
						return 1;
					}
					peekWriteIndex() {
						return 1;
					}
					beginTurn() {}
					resetForSession() {}
					setTelemetryIdentity() {}
					telemetrySessionId = "test-session";
				},
			}));
			vi.doMock("../clients/bootstrap.js", async () => {
				const { bootstrapSeamMock } =
					await import("./support/bootstrap-mock.js");
				return bootstrapSeamMock(async () => ({
					metricsClient: { reset: () => {} },
					todoScanner: {},
					biomeClient: { isAvailable: () => false },
					ruffClient: { isAvailable: () => false },
					knipClient: {
						isAvailable: () => false,
						analyze: async () => ({
							success: false,
							summary: "unavailable",
							issues: [],
						}),
					},
					jscpdClient: { isAvailable: () => false },
					depChecker: { isAvailable: () => false },
					testRunnerClient: { detectRunner: () => null },
					goClient: { isGoAvailableAsync: async () => false },
					rustClient: { isAvailableAsync: async () => false },
					agentBehaviorClient: {
						recordToolCall: () => {},
						formatWarnings: () => "",
					},
					complexityClient: {
						isSupportedFile: () => false,
						analyzeFile: () => null,
					},
				}));
			});
			vi.doMock("../clients/lsp/index.js", async () => ({
				getLSPService: () => makeLspServiceDouble({ touchFile: touchFileMock }),
				resetLSPService: () => {},
			}));

			const { default: registerExtension } = await import("../index.js");
			const { pi, handlers } = createMockPi({ "no-lsp": false });
			registerExtension(pi as any);

			const toolCall = handlers.tool_call?.[0];
			expect(toolCall).toBeTypeOf("function");

			for (let i = 0; i < 3; i += 1) {
				await toolCall?.(
					{
						toolName: "read",
						input: {
							path: sourceFile,
						},
					},
					{ cwd: tmpDir },
				);
				await Promise.resolve();
			}

			expect(shouldWarmLspOnRead).toHaveBeenCalledTimes(3);
			expect(touchFileMock).toHaveBeenCalledTimes(2);
			expect(markLspReadWarmStarted).toHaveBeenCalledTimes(2);
			expect(markLspReadWarmCompleted).toHaveBeenCalledTimes(2);
			expect(clearLspReadWarmState).not.toHaveBeenCalled();
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"tool_call does not warm LSP for unknown non-code file kinds",
		async () => {
			const touchFileMock = vi.fn().mockResolvedValue(undefined);
			const shouldWarmLspOnRead = vi.fn();
			const notesFile = path.join(tmpDir, "notes", "stderr.txt");
			fs.mkdirSync(path.dirname(notesFile), { recursive: true });
			fs.writeFileSync(notesFile, "plain text\n");

			vi.doMock("../clients/runtime-coordinator.js", () => ({
				RuntimeCoordinator: class {
					projectRoot = tmpDir;
					turnIndex = 0;
					complexityBaselines = new Map();
					cachedExports = new Map();
					readGuard = {
						recordRead: () => {},
						getReadHistory: () => [],
						isNewFile: () => false,
						noteCreatedFile: () => {},
						recordWritten: () => {},
						checkEdit: () => ({ action: "allow" as const }),
					};
					shouldWarmLspOnRead = shouldWarmLspOnRead;
					markLspReadWarmStarted() {}
					markLspReadWarmCompleted() {}
					clearLspReadWarmState() {}
					nextWriteIndex() {
						return 1;
					}
					peekWriteIndex() {
						return 1;
					}
					beginTurn() {}
					resetForSession() {}
					setTelemetryIdentity() {}
					telemetrySessionId = "test-session";
				},
			}));
			vi.doMock("../clients/bootstrap.js", async () => {
				const { bootstrapSeamMock } =
					await import("./support/bootstrap-mock.js");
				return bootstrapSeamMock(async () => ({
					metricsClient: { reset: () => {} },
					todoScanner: {},
					biomeClient: { isAvailable: () => false },
					ruffClient: { isAvailable: () => false },
					knipClient: {
						isAvailable: () => false,
						analyze: async () => ({
							success: false,
							summary: "unavailable",
							issues: [],
						}),
					},
					jscpdClient: { isAvailable: () => false },
					depChecker: { isAvailable: () => false },
					testRunnerClient: { detectRunner: () => null },
					goClient: { isGoAvailableAsync: async () => false },
					rustClient: { isAvailableAsync: async () => false },
					agentBehaviorClient: {
						recordToolCall: () => {},
						formatWarnings: () => "",
					},
					complexityClient: {
						isSupportedFile: () => false,
						analyzeFile: () => null,
					},
				}));
			});
			vi.doMock("../clients/lsp/index.js", async () => ({
				getLSPService: () => makeLspServiceDouble({ touchFile: touchFileMock }),
				resetLSPService: () => {},
			}));

			const { default: registerExtension } = await import("../index.js");
			const { pi, handlers } = createMockPi({ "no-lsp": false });
			registerExtension(pi as any);

			const toolCall = handlers.tool_call?.[0];
			expect(toolCall).toBeTypeOf("function");

			await toolCall?.(
				{
					toolName: "read",
					input: {
						path: notesFile,
					},
				},
				{ cwd: tmpDir },
			);
			await Promise.resolve();

			expect(shouldWarmLspOnRead).not.toHaveBeenCalled();
			expect(touchFileMock).not.toHaveBeenCalled();
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"tool_call does not warm LSP for internal support artifacts",
		async () => {
			const touchFileMock = vi.fn().mockResolvedValue(undefined);
			const shouldWarmLspOnRead = vi.fn();
			const turnStateFile = path.join(tmpDir, ".pi-lens", "turn-state.json");
			fs.mkdirSync(path.dirname(turnStateFile), { recursive: true });
			fs.writeFileSync(turnStateFile, '{"files":{}}\n');

			vi.doMock("../clients/runtime-coordinator.js", () => ({
				RuntimeCoordinator: class {
					projectRoot = tmpDir;
					turnIndex = 0;
					complexityBaselines = new Map();
					cachedExports = new Map();
					readGuard = {
						recordRead: () => {},
						getReadHistory: () => [],
						isNewFile: () => false,
						noteCreatedFile: () => {},
						recordWritten: () => {},
						checkEdit: () => ({ action: "allow" as const }),
					};
					shouldWarmLspOnRead = shouldWarmLspOnRead;
					markLspReadWarmStarted() {}
					markLspReadWarmCompleted() {}
					clearLspReadWarmState() {}
					nextWriteIndex() {
						return 1;
					}
					peekWriteIndex() {
						return 1;
					}
					beginTurn() {}
					resetForSession() {}
					setTelemetryIdentity() {}
					telemetrySessionId = "test-session";
				},
			}));
			vi.doMock("../clients/bootstrap.js", async () => {
				const { bootstrapSeamMock } =
					await import("./support/bootstrap-mock.js");
				return bootstrapSeamMock(async () => ({
					metricsClient: { reset: () => {} },
					todoScanner: {},
					biomeClient: { isAvailable: () => false },
					ruffClient: { isAvailable: () => false },
					knipClient: {
						isAvailable: () => false,
						analyze: async () => ({
							success: false,
							summary: "unavailable",
							issues: [],
						}),
					},
					jscpdClient: { isAvailable: () => false },
					depChecker: { isAvailable: () => false },
					testRunnerClient: { detectRunner: () => null },
					goClient: { isGoAvailableAsync: async () => false },
					rustClient: { isAvailableAsync: async () => false },
					agentBehaviorClient: {
						recordToolCall: () => {},
						formatWarnings: () => "",
					},
					complexityClient: {
						isSupportedFile: () => false,
						analyzeFile: () => null,
					},
				}));
			});
			vi.doMock("../clients/lsp/index.js", async () => ({
				getLSPService: () => makeLspServiceDouble({ touchFile: touchFileMock }),
				resetLSPService: () => {},
			}));

			const { default: registerExtension } = await import("../index.js");
			const { pi, handlers } = createMockPi({ "no-lsp": false });
			registerExtension(pi as any);

			const toolCall = handlers.tool_call?.[0];
			expect(toolCall).toBeTypeOf("function");

			await toolCall?.(
				{
					toolName: "read",
					input: {
						path: turnStateFile,
					},
				},
				{ cwd: tmpDir },
			);
			await Promise.resolve();

			expect(shouldWarmLspOnRead).not.toHaveBeenCalled();
			expect(touchFileMock).not.toHaveBeenCalled();
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"lens-health command reports crash, latency, diagnostics, and slop telemetry",
		async () => {
			vi.doMock("../clients/runtime-coordinator.js", () => ({
				RuntimeCoordinator: class {
					projectRoot = tmpDir;
					getCrashEntries() {
						return [[path.join(tmpDir, "src", "boom.ts"), 3]];
					}
					beginTurn() {}
					resetForSession() {}
					complexityBaselines = new Map();
					projectRulesScan = { hasCustomRules: false, rules: [] };
					cachedExports = new Map();
					errorDebtBaseline = null;
					sessionStartedAt = Date.now() - 5 * 60_000;
					readGuard = {
						isNewFile: () => false,
						noteCreatedFile: () => {},
						recordWritten: () => {},
						checkEdit: () => ({ action: "allow" }),
						recordRead: () => {},
					};
				},
			}));
			vi.doMock("../clients/lsp/index.js", () => ({
				getLSPService: () =>
					makeLspServiceDouble({
						getAliveClientCount: () => 1,
						getAliveServerIds: () => ["typescript"],
						getStatus: () => [
							{ serverId: "typescript", root: tmpDir, connected: true },
						],
					}),
				resetLSPService: () => {},
			}));
			vi.doMock("../clients/dispatch/integration.js", async () => ({
				getDispatchSlopScoreLine: () => "Slop score: 12/100",
				getLatencyReports: () => [
					{
						filePath: path.join(tmpDir, "src", "boom.ts"),
						totalDurationMs: 321,
						totalDiagnostics: 4,
						runners: [
							{ runnerId: "lsp", durationMs: 200, status: "failed" },
							{ runnerId: "tree-sitter", durationMs: 90, status: "succeeded" },
							{ runnerId: "eslint", durationMs: 31, status: "succeeded" },
						],
					},
				],
				getCascadeSessionStats: () => ({
					runs: 5,
					diagnosticsSurfaced: 3,
					coldSnapshotTouches: 2,
				}),
				resetDispatchBaselines: () => {},
			}));
			vi.doMock("../clients/diagnostic-tracker.js", async () => ({
				getDiagnosticTracker: () => ({
					reset: () => {},
					getStats: () => ({
						totalShown: 8,
						totalAutoFixed: 2,
						totalAgentFixed: 1,
						totalUnresolved: 5,
						repeatOffenders: [
							{
								filePath: path.join(tmpDir, "src", "boom.ts"),
								line: 7,
								ruleId: "no-debugger",
								count: 3,
							},
						],
						topViolations: [
							{
								ruleId: "no-console",
								count: 6,
								samplePaths: [path.join(tmpDir, "src", "boom.ts")],
							},
						],
					}),
				}),
			}));
			vi.doMock("../clients/bootstrap.js", async () => {
				const { bootstrapSeamMock } =
					await import("./support/bootstrap-mock.js");
				return bootstrapSeamMock(async () => ({
					metricsClient: { reset: () => {} },
					todoScanner: {},
					biomeClient: { isAvailable: () => false },
					ruffClient: { isAvailable: () => false },
					knipClient: {
						isAvailable: () => false,
						analyze: async () => ({
							success: false,
							summary: "unavailable",
							issues: [],
						}),
					},
					jscpdClient: { isAvailable: () => false },
					depChecker: { isAvailable: () => false },
					testRunnerClient: { detectRunner: () => null },
					goClient: { isGoAvailableAsync: async () => false },
					rustClient: { isAvailableAsync: async () => false },
					agentBehaviorClient: {
						recordToolCall: () => {},
						formatWarnings: () => "",
					},
					complexityClient: {
						isSupportedFile: () => false,
						analyzeFile: () => null,
					},
				}));
			});

			const { default: registerExtension } = await import("../index.js");
			const { pi, commands } = createMockPi();
			registerExtension(pi as any);

			const notify = vi.fn();
			const lensHealth = commands.get("lens-health");
			expect(lensHealth?.handler).toBeTypeOf("function");

			await lensHealth?.handler?.({}, { ui: { notify } });

			expect(notify).toHaveBeenCalledTimes(1);
			const [message, level] = notify.mock.calls[0];
			expect(level).toBe("info");
			expect(message).toContain("🩺 PI-LENS HEALTH");
			expect(message).toContain("Pipeline crashes (session): 3");
			expect(message).toContain("Top crash files:");
			expect(message).toContain("boom.ts: 3");
			expect(message).toContain(
				"Last dispatch: boom.ts (321ms, 4 diagnostics)",
			);
			expect(message).toContain("lsp: 200ms (failed)");
			expect(message).toContain("Diagnostics shown: 8");
			expect(message).toContain("Auto-fixed: 2");
			expect(message).toContain("Agent-fixed: 1");
			expect(message).toContain("Unresolved carryover: 5");
			expect(message).toContain("Repeat offenders:");
			expect(message).toContain("boom.ts:7 no-debugger (3x)");
			expect(message).toContain("Top noisy rules:");
			expect(message).toContain("no-console: 6 (e.g. src/boom.ts)");
			expect(message).toContain("Slop score: 12/100");
			expect(message).toContain("Session started:");
			expect(message).toContain("LSP servers:");
			expect(message).toContain("✓ typescript");
			expect(message).toContain("Cascade runs: 5");
			expect(message).toContain("Cascade diagnostics surfaced: 3");
			expect(message).toContain("Cold-snapshot touches: 2");
		},
		INTEGRATION_TIMEOUT_MS,
	);
});

describe("#484 turn-summary emit at the agent_settled quiet window", () => {
	let tmpDir: string;
	let originalStartupMode: string | undefined;
	// Recorded quiet-window task registrations (from the stub below). The
	// real scheduler (clients/quiet-window.ts) is exercised by its own suite;
	// here we only need "index.ts registered the task" + "running the task
	// chain at settle produces the emission".
	let quietTasks: Array<{
		name: string;
		fn: (context?: {
			runtime: unknown;
			cwd?: string;
			sessionId?: string;
			ownerId?: string;
		}) => Promise<void> | void;
	}>;
	let handleTurnEndHook:
		| ((deps: {
				onTestRunnerComplete?: (args: any) => void;
				runtime: any;
				ctxCwd?: string;
				sessionId?: string;
		  }) => void)
		| undefined;

	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		// This suite needs the REAL RuntimeCoordinator (setTelemetryIdentity,
		// turnSummary, etc.) — an earlier describe block in this file
		// (`vi.doMock("../clients/runtime-coordinator.js", ...)`) persists past
		// its own test via vitest's module registry, surviving vi.resetModules().
		// Explicitly unmock (doUnmock, NOT the hoisted vi.unmock) so this
		// suite's behavior does not depend on file run order.
		vi.doUnmock("../clients/runtime-coordinator.js");
		vi.doUnmock("../clients/installer/index.js");
		vi.doUnmock("../clients/runtime-session.js");
		vi.doUnmock("../clients/lsp/index.js");
		quietTasks = [];
		handleTurnEndHook = undefined;
		_resetProcessSingletonsForTests();
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-turn-summary-"));
		originalStartupMode = process.env.PI_LENS_STARTUP_MODE;
		process.env.PI_LENS_STARTUP_MODE = "quick";
	});

	afterEach(() => {
		removeTempDirSync(tmpDir);
		if (originalStartupMode === undefined)
			delete process.env.PI_LENS_STARTUP_MODE;
		else process.env.PI_LENS_STARTUP_MODE = originalStartupMode;
		vi.restoreAllMocks();
	});

	function mockSuiteDeps() {
		vi.doMock("../clients/bootstrap.js", async () => {
			const { bootstrapSeamMock } = await import("./support/bootstrap-mock.js");
			return bootstrapSeamMock(async () => ({
				metricsClient: { reset: () => {} },
				todoScanner: {},
				biomeClient: { isAvailable: () => false },
				ruffClient: { isAvailable: () => false },
				knipClient: { isAvailable: () => false },
				jscpdClient: { isAvailable: () => false },
				depChecker: { isAvailable: () => false },
				testRunnerClient: { detectRunner: () => null },
				goClient: { isGoAvailableAsync: async () => false },
				rustClient: { isAvailableAsync: async () => false },
				agentBehaviorClient: {
					recordToolCall: () => [],
					formatWarnings: () => "",
				},
				complexityClient: {
					isSupportedFile: () => false,
					analyzeFile: () => null,
				},
			}));
		});
		// handleTurnEnd is a heavyweight, separately-tested pass
		// (knip/madge/tests/actionable warnings — clients/runtime-turn.ts,
		// exercised by its own suite). Stub it to a no-op so this suite
		// exercises only the #484 seam (collector → quiet-window emit) without
		// depending on that machinery or its real-filesystem/timer effects.
		vi.doMock("../clients/runtime-turn.js", () => ({
			handleTurnEnd: vi.fn(async (deps: any) => {
				handleTurnEndHook?.(deps);
			}),
			cancelLSPIdleReset: vi.fn(),
		}));
		// Light quiet-window stub: record registrations, run them in order on
		// runQuietWindow (the real scheduler has its own suite; #484 only
		// needs the registration + the task's behavior). Builtins are elided —
		// they'd drag real cascade/heartbeat machinery into this test.
		vi.doMock("../clients/quiet-window.js", () => ({
			registerQuietWindowTask: (
				name: string,
				fn: (context?: {
					runtime: unknown;
					cwd?: string;
					sessionId?: string;
					ownerId?: string;
				}) => Promise<void> | void,
			) => {
				quietTasks.push({ name, fn });
			},
			registerBuiltinQuietWindowTasks: () => {},
			runQuietWindow: async (deps: {
				runtime: unknown;
				cwd?: string;
				sessionId?: string;
				ownerId?: string;
			}) => {
				for (const task of quietTasks) {
					try {
						await task.fn(deps);
					} catch {
						// mirror the real scheduler: task failures are isolated
					}
				}
			},
			isQuietWindowEnabled: () => true,
		}));
	}

	const workingPipelineResult = () => ({
		output: "✓ no blockers",
		hasBlockers: false,
		isError: false,
		fileModified: true,
		diagnostics: [
			{
				id: "d1",
				message: "unused var",
				filePath: path.join(tmpDir, "src", "app.ts"),
				line: 4,
				severity: "warning",
				semantic: "warning",
				tool: "eslint",
				rule: "no-unused-vars",
			},
		],
		formattersUsed: ["prettier"],
		fixedCount: 1,
		autofixTools: ["ruff:1"],
	});

	async function driveEditThenTurnEnd(
		handlers: ReturnType<typeof createMockPi>["handlers"],
		filePath: string,
	) {
		// runtime.projectRoot is only set at session_start (handleSessionStart);
		// without firing it first, the tool_result handler's workspaceRoot falls
		// back to process.cwd() and treats tmpDir as an external/vendor path.
		const sessionStart = handlers.session_start?.[0];
		expect(sessionStart).toBeTypeOf("function");
		await sessionStart?.({}, { cwd: tmpDir, ui: { notify: vi.fn() } });

		const turnStart = handlers.turn_start?.[0];
		expect(turnStart).toBeTypeOf("function");
		await turnStart?.({}, { cwd: tmpDir });

		const toolResult = handlers.tool_result?.[0];
		expect(toolResult).toBeTypeOf("function");
		await toolResult?.(
			{
				toolName: "edit",
				input: { path: filePath },
				details: { diff: "+  1 export const x = 1;" },
				content: [{ type: "text", text: "base" }],
			},
			{ cwd: tmpDir, ui: { notify: vi.fn() }, signal: undefined },
		);

		const turnEnd = handlers.turn_end?.[0];
		expect(turnEnd).toBeTypeOf("function");
		await turnEnd?.(
			{},
			{
				cwd: tmpDir,
				ui: {
					notify: vi.fn(),
					setStatus: () => {},
					theme: { fg: (_c: string, s: string) => s },
				},
			},
		);
	}

	async function fireAgentSettled(
		handlers: ReturnType<typeof createMockPi>["handlers"],
	) {
		const settled = handlers.agent_settled?.[0];
		expect(settled).toBeTypeOf("function");
		await settled?.({}, { cwd: tmpDir, isIdle: () => true });
		// index.ts kicks runQuietWindow off unawaited (fire-and-forget by
		// design — the SDK awaits the handler); drain the microtask queue so
		// the stub's task chain completes before assertions.
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	it(
		"registers the turn_summary_emit quiet-window task",
		async () => {
			mockSuiteDeps();
			const { default: registerExtension } = await import("../index.js");
			const { pi } = createMockPi();
			registerExtension(pi as any);

			expect(quietTasks.map((t) => t.name)).toContain("turn_summary_emit");
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"does not add test-runner failures to a later model context",
		async () => {
			mockSuiteDeps();
			const cache = new CacheManager(false);
			cache.writeCache(
				"test-runner-findings",
				{ content: "FAIL test/app.test.ts:1" },
				tmpDir,
			);

			const { default: registerExtension } = await import("../index.js");
			const { pi, mock } = createMockPi();
			registerExtension(pi as any);

			const result = await mock.emit(
				"context",
				{ messages: [{ role: "user", content: "continue" }] },
				{ cwd: tmpDir },
			);
			expect(result).toBeUndefined();
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"delivers staged test failures once through a non-context custom entry",
		async () => {
			mockSuiteDeps();
			const cache = new CacheManager(false);
			cache.writeCache(
				"test-runner-findings",
				{ content: "FAIL test/app.test.ts:1", testRunGeneration: 1 },
				tmpDir,
			);
			const filePath = path.join(tmpDir, "src", "app.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "export const x = 1;\n");
			handleTurnEndHook = (deps) =>
				deps.onTestRunnerComplete?.({
					cwd: tmpDir,
					sessionId: deps.runtime.telemetrySessionId,
					generation: 1,
					targetCount: 1,
					hasFindings: true,
				});

			const { default: registerExtension } = await import("../index.js");
			const { pi, mock, handlers, sentMessages } = createMockPi();
			registerExtension(pi as any);
			await driveEditThenTurnEnd(handlers, filePath);

			await fireAgentSettled(handlers);

			expect(mock.appendedEntries).toHaveLength(1);
			expect(mock.appendedEntries[0]).toMatchObject({
				customType: "pilens:test-runner-findings",
				data: { content: expect.stringContaining("FAIL") },
			});
			expect(sentMessages).toHaveLength(0);
			expect(mock.entryRenderers.has("pilens:test-runner-findings")).toBe(true);
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"keeps primary and concurrent secondary test delivery on their owning activation",
		async () => {
			mockSuiteDeps();
			vi.doMock("../clients/runtime-session.js", () => ({
				handleSessionStart: vi.fn(async () => {}),
			}));
			handleTurnEndHook = (deps) =>
				deps.onTestRunnerComplete?.({
					cwd: deps.ctxCwd ?? tmpDir,
					sessionId: deps.sessionId ?? "unknown",
					generation: 1,
					targetCount: deps.sessionId === "secondary-delivery" ? 22 : 11,
					hasFindings: true,
				});
			new CacheManager(false).writeCache(
				"test-runner-findings",
				{ content: "FAIL cross-session.test.ts:1", testRunGeneration: 1 },
				tmpDir,
			);

			const { default: registerExtension } = await import("../index.js");
			const primary = createMockPi();
			registerExtension(primary.pi as any);
			await primary.trigger(
				"session_start",
				{},
				makeCtx({ cwd: tmpDir, sessionId: "primary-delivery" }),
			);
			const secondary = createMockPi();
			registerExtension(secondary.pi as any);
			await secondary.trigger(
				"session_start",
				{},
				makeCtx({ cwd: tmpDir, sessionId: "secondary-delivery" }),
			);

			await primary.trigger(
				"turn_end",
				{},
				makeCtx({ cwd: tmpDir, sessionId: "primary-delivery" }),
			);
			await secondary.trigger(
				"turn_end",
				{},
				makeCtx({ cwd: tmpDir, sessionId: "secondary-delivery" }),
			);
			await primary.trigger(
				"agent_settled",
				{},
				makeCtx({ cwd: tmpDir, sessionId: "primary-delivery" }),
			);
			await secondary.trigger(
				"agent_settled",
				{},
				makeCtx({ cwd: tmpDir, sessionId: "secondary-delivery" }),
			);

			expect(primary.mock.appendedEntries).toHaveLength(1);
			expect(secondary.mock.appendedEntries).toHaveLength(1);
			expect(primary.mock.appendedEntries[0]?.data).toMatchObject({
				sessionId: "primary-delivery",
				targetCount: 11,
			});
			expect(secondary.mock.appendedEntries[0]?.data).toMatchObject({
				sessionId: "secondary-delivery",
				targetCount: 22,
			});
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"emits nothing at turn_end; exactly one entry at agent_settled, surviving an intervening turn_start",
		async () => {
			vi.doMock("../clients/pipeline.js", () => ({
				runPipeline: vi.fn(async () => workingPipelineResult()),
			}));
			mockSuiteDeps();

			const filePath = path.join(tmpDir, "src", "app.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "export const x = 1;\n");

			const { default: registerExtension } = await import("../index.js");
			const { pi, handlers, sentMessages } = createMockPi({
				"lens-turn-summary": true,
			});
			registerExtension(pi as any);

			await driveEditThenTurnEnd(handlers, filePath);
			// A sendMessage during the run would steer a streaming session — the
			// turn_end path must NOT emit.
			expect(sentMessages).toHaveLength(0);

			// A NEW turn begins before the run settles (multi-turn run): the
			// collector must survive beginTurn (per-RUN grain, not per-turn).
			const turnStart = handlers.turn_start?.[0];
			await turnStart?.({}, { cwd: tmpDir });

			await fireAgentSettled(handlers);

			expect(sentMessages).toHaveLength(1);
			const sent = sentMessages[0];
			expect(sent.customType).toBe("pilens:turn-summary");
			expect(sent.display).toBe(true);
			// The model-visible part is `content` — it must stay a single short
			// line (a CustomMessageEntry participates in LLM context; details do
			// not reach the model).
			expect(typeof sent.content).toBe("string");
			expect(sent.content).toContain("pi-lens:");
			expect((sent.content as string).includes("\n")).toBe(false);
			expect(sent.details).toMatchObject({
				version: 1,
				counts: {
					diagnostics: 1,
					autofixes: 1,
					formats: 1,
					byTool: {
						diagnostic: { eslint: 1 },
						autofix: { ruff: 1 },
						format: { prettier: 1 },
					},
				},
			});
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"consumes the collection exactly once — a second agent_settled emits nothing more",
		async () => {
			vi.doMock("../clients/pipeline.js", () => ({
				runPipeline: vi.fn(async () => workingPipelineResult()),
			}));
			mockSuiteDeps();

			const filePath = path.join(tmpDir, "src", "app.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "export const x = 1;\n");

			const { default: registerExtension } = await import("../index.js");
			const { pi, handlers, sentMessages } = createMockPi({
				"lens-turn-summary": true,
			});
			registerExtension(pi as any);

			await driveEditThenTurnEnd(handlers, filePath);
			await fireAgentSettled(handlers);
			expect(sentMessages).toHaveLength(1);

			await fireAgentSettled(handlers);
			expect(sentMessages).toHaveLength(1);
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"emits nothing at agent_settled when the run's collection is empty, even when opted in",
		async () => {
			vi.doMock("../clients/pipeline.js", () => ({
				runPipeline: vi.fn(async () => ({
					output: "✓ no blockers",
					hasBlockers: false,
					isError: false,
					fileModified: false,
				})),
			}));
			mockSuiteDeps();

			const filePath = path.join(tmpDir, "src", "app.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "export const x = 1;\n");

			const { default: registerExtension } = await import("../index.js");
			const { pi, handlers, sentMessages } = createMockPi({
				"lens-turn-summary": true,
			});
			registerExtension(pi as any);

			await driveEditThenTurnEnd(handlers, filePath);
			await fireAgentSettled(handlers);

			expect(sentMessages).toHaveLength(0);
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"does not emit or collect when lens-turn-summary is off (default off-by-default)",
		async () => {
			vi.doMock("../clients/pipeline.js", () => ({
				runPipeline: vi.fn(async () => workingPipelineResult()),
			}));
			mockSuiteDeps();

			const filePath = path.join(tmpDir, "src", "app.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "export const x = 1;\n");

			const { default: registerExtension } = await import("../index.js");
			// lens-turn-summary NOT set → getFlag resolves to its registered
			// default (false) via createPiMock's registerFlag seeding.
			const { pi, handlers, sentMessages } = createMockPi();
			registerExtension(pi as any);

			await driveEditThenTurnEnd(handlers, filePath);
			await fireAgentSettled(handlers);

			expect(sentMessages).toHaveLength(0);
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"registers the pilens:turn-summary message renderer (feature-detected)",
		async () => {
			mockSuiteDeps();
			const { default: registerExtension } = await import("../index.js");
			const { pi, messageRenderers } = createMockPi();
			registerExtension(pi as any);

			expect(messageRenderers.has("pilens:turn-summary")).toBe(true);
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"never throws when the host lacks sendMessage/registerMessageRenderer (feature-detect no-op)",
		async () => {
			vi.doMock("../clients/pipeline.js", () => ({
				runPipeline: vi.fn(async () => workingPipelineResult()),
			}));
			mockSuiteDeps();

			const filePath = path.join(tmpDir, "src", "app.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "export const x = 1;\n");

			const { default: registerExtension } = await import("../index.js");
			const { pi, handlers } = createMockPi({ "lens-turn-summary": true });
			// Simulate an older host lacking both APIs entirely — registerExtension
			// feature-detects registerMessageRenderer at setup time, and the
			// quiet-window task feature-detects sendMessage at emit time.
			delete (pi as unknown as Record<string, unknown>).sendMessage;
			delete (pi as unknown as Record<string, unknown>).registerMessageRenderer;
			registerExtension(pi as any);

			await driveEditThenTurnEnd(handlers, filePath);
			await expect(fireAgentSettled(handlers)).resolves.not.toThrow();
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"no-ops (does not fail the quiet-window task) when the captured pi ctx has gone stale",
		async () => {
			vi.doMock("../clients/pipeline.js", () => ({
				runPipeline: vi.fn(async () => workingPipelineResult()),
			}));
			mockSuiteDeps();

			const filePath = path.join(tmpDir, "src", "app.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "export const x = 1;\n");

			const { default: registerExtension } = await import("../index.js");
			const { pi, handlers, sentMessages } = createMockPi({
				"lens-turn-summary": true,
			});
			registerExtension(pi as any);

			// Populate the run's collector so the task would proceed past isEmpty()
			// on a live ctx — proving the guard added by the fix, not an empty-run
			// early return, is what makes this a no-op.
			await driveEditThenTurnEnd(handlers, filePath);

			// Simulate the SDK invalidating the captured pi after a session
			// replacement/reload (newSession/fork/switchSession/reload): from then on
			// every `pi.*` call throws the stale-ctx guard. The turn_summary_emit task
			// hits pi.getFlag (via getLensFlag) FIRST — outside the sendMessage
			// try/catch — so pre-fix that throw propagated out of the task and the
			// real scheduler logged it 55× in live dogfood as `task
			// "turn_summary_emit" failed` (the log's most frequent error).
			const STALE_MSG =
				"This extension ctx is stale after session replacement or reload. " +
				"Do not use a captured pi or command ctx after ctx.newSession(), " +
				"ctx.fork(), ctx.switchSession(), or ctx.reload().";
			(pi as unknown as Record<string, unknown>).getFlag = () => {
				throw new Error(STALE_MSG);
			};

			const task = quietTasks.find((t) => t.name === "turn_summary_emit");
			expect(task).toBeDefined();
			// Run the task directly: the suite's runQuietWindow stub swallows task
			// throws (mirroring the real scheduler), so driving fireAgentSettled would
			// hide the regression. Awaiting the task itself surfaces it — pre-fix this
			// rejects with the stale-ctx Error; post-fix it resolves to a no-op.
			await expect((async () => task?.fn())()).resolves.toBeUndefined();
			// Nothing is emitted into the replaced session.
			expect(sentMessages).toHaveLength(0);
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"session shutdown summarizes and clears each cache-observability role locally (#1996)",
		async () => {
			const order: string[] = [];
			const emitCacheUsageSummaryAtSessionEnd = vi.fn(
				(sessionId: string, role: string) => {
					order.push(`summary:${sessionId}:${role}`);
				},
			);
			const clearCachePrefixSession = vi.fn(
				(sessionId: string, role: string) => {
					order.push(`clear:${sessionId}:${role}`);
				},
			);
			vi.doMock("../clients/cache-observability.js", async (importActual) => ({
				...(await importActual<
					typeof import("../clients/cache-observability.js")
				>()),
				emitCacheUsageSummaryAtSessionEnd,
				clearCachePrefixSession,
			}));

			const { default: registerExtension } = await import("../index.js");
			const primary = createMockPi();
			registerExtension(primary.pi as any);
			await primary.trigger(
				"session_start",
				{},
				makeCtx({ cwd: tmpDir, sessionId: "primary-cache" }),
			);

			const secondary = createMockPi();
			registerExtension(secondary.pi as any);
			await secondary.trigger(
				"session_start",
				{},
				makeCtx({ cwd: tmpDir, sessionId: "secondary-cache" }),
			);
			await secondary.trigger(
				"session_shutdown",
				{},
				makeCtx({ cwd: tmpDir, sessionId: "secondary-cache" }),
			);
			expect(emitCacheUsageSummaryAtSessionEnd).toHaveBeenCalledWith(
				"secondary-cache",
				"concurrent-secondary",
			);
			expect(clearCachePrefixSession).toHaveBeenCalledWith(
				"secondary-cache",
				"concurrent-secondary",
			);
			expect(order).toEqual([
				"summary:secondary-cache:concurrent-secondary",
				"clear:secondary-cache:concurrent-secondary",
			]);

			await primary.trigger(
				"session_shutdown",
				{},
				makeCtx({ cwd: tmpDir, sessionId: "primary-cache" }),
			);
			expect(emitCacheUsageSummaryAtSessionEnd).toHaveBeenCalledWith(
				"primary-cache",
				"primary",
			);
			expect(clearCachePrefixSession).toHaveBeenCalledWith(
				"primary-cache",
				"primary",
			);
			expect(order).toEqual([
				"summary:secondary-cache:concurrent-secondary",
				"clear:secondary-cache:concurrent-secondary",
				"summary:primary-cache:primary",
				"clear:primary-cache:primary",
			]);
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"a missing-id secondary keeps its activation-owned role through context, usage, and shutdown (#1996 review)",
		async () => {
			const observeCacheContext = vi.fn();
			const observeCachePrefix = vi.fn();
			const logCacheUsage = vi.fn();
			const emitCacheUsageSummaryAtSessionEnd = vi.fn();
			const clearCachePrefixSession = vi.fn();
			vi.doMock("../clients/cache-observability.js", async (importActual) => ({
				...(await importActual<
					typeof import("../clients/cache-observability.js")
				>()),
				observeCacheContext,
				observeCachePrefix,
				logCacheUsage,
				emitCacheUsageSummaryAtSessionEnd,
				clearCachePrefixSession,
			}));
			const resetLSPService = vi.fn();
			vi.doMock("../clients/lsp/index.js", () => ({
				getLSPService: () => makeLspServiceDouble(),
				resetLSPService,
			}));

			const { default: registerExtension } = await import("../index.js");
			const primary = createMockPi();
			registerExtension(primary.pi as any);
			await primary.trigger(
				"session_start",
				{},
				makeCtx({ cwd: tmpDir, sessionId: "primary-cache" }),
			);

			const secondary = createMockPi();
			registerExtension(secondary.pi as any);
			const secondaryCtx = makeCtx({ cwd: tmpDir, sessionId: undefined });
			await secondary.trigger("session_start", {}, secondaryCtx);
			resetLSPService.mockClear();
			await secondary.trigger(
				"context",
				{ messages: [{ role: "user", content: "prompt" }] },
				secondaryCtx,
			);
			await secondary.trigger(
				"message_end",
				{
					message: {
						role: "assistant",
						provider: "provider",
						model: "model",
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
					},
				},
				secondaryCtx,
			);
			await secondary.trigger("session_shutdown", {}, secondaryCtx);

			expect(observeCacheContext).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionId: undefined,
					sessionRole: "concurrent-secondary",
				}),
			);
			expect(logCacheUsage).toHaveBeenCalledWith(
				expect.anything(),
				expect.any(Function),
				expect.objectContaining({
					sessionId: undefined,
					sessionRole: "concurrent-secondary",
				}),
			);
			expect(emitCacheUsageSummaryAtSessionEnd).toHaveBeenCalledWith(
				undefined,
				"concurrent-secondary",
			);
			expect(clearCachePrefixSession).toHaveBeenCalledWith(
				undefined,
				"concurrent-secondary",
			);
			expect(resetLSPService).not.toHaveBeenCalled();
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"message_end on a stale ctx records the attribution degrade without skipping the cache_usage row (#1956)",
		async () => {
			const logCacheUsage = vi.fn();
			vi.doMock("../clients/cache-observability.js", async (importActual) => ({
				...(await importActual<
					typeof import("../clients/cache-observability.js")
				>()),
				logCacheUsage,
			}));
			const resetLSPService = vi.fn();
			vi.doMock("../clients/lsp/index.js", () => ({
				getLSPService: () => makeLspServiceDouble(),
				resetLSPService,
			}));

			const { default: registerExtension } = await import("../index.js");
			const primary = createMockPi();
			registerExtension(primary.pi as any);

			// A stale ctx (session replaced/reloaded): `getStableSessionId`
			// returns undefined, `probeCtxActive` confirms staleness, and the
			// handler must BOTH keep writing the cache_usage row AND record the
			// attribution degrade in the ledger.
			await primary.trigger(
				"message_end",
				{
					message: {
						role: "assistant",
						provider: "provider",
						model: "model",
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
					},
				},
				makeStaleCtx(),
			);

			// The row keeps writing — this is a degrade, not a skip.
			expect(logCacheUsage).toHaveBeenCalledWith(
				expect.anything(),
				expect.any(Function),
				expect.objectContaining({ sessionId: undefined }),
			);

			// The attribution loss is recorded: the same degradation-ledger
			// instance index.ts writes through must now carry the group, keyed
			// by event name so aggregation answers WHICH handler lost its id.
			const { getDegradationSummary } =
				await import("../clients/degradation-ledger.js");
			const group = getDegradationSummary().find(
				(g) => g.kind === "cache-usage-attribution-stale",
			);
			expect(group).toBeDefined();
			expect(group?.count).toBe(1);
			expect(group?.latestReasons[0].subject).toBe("message_end");
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"message_end does not record attribution degradation for a live ctx",
		async () => {
			const logCacheUsage = vi.fn();
			vi.doMock("../clients/cache-observability.js", async (importActual) => ({
				...(await importActual<
					typeof import("../clients/cache-observability.js")
				>()),
				logCacheUsage,
			}));
			const { default: registerExtension } = await import("../index.js");
			const primary = createMockPi();
			registerExtension(primary.pi as any);
			await primary.trigger(
				"message_end",
				{ message: { role: "assistant" } },
				makeCtx(),
			);
			const { getDegradationSummary } =
				await import("../clients/degradation-ledger.js");
			expect(logCacheUsage).toHaveBeenCalledOnce();
			expect(
				getDegradationSummary().find(
					(group) => group.kind === "cache-usage-attribution-stale",
				),
			).toBeUndefined();
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"message_end does not record attribution degradation for an inconclusive ctx",
		async () => {
			const logCacheUsage = vi.fn();
			vi.doMock("../clients/cache-observability.js", async (importActual) => ({
				...(await importActual<
					typeof import("../clients/cache-observability.js")
				>()),
				logCacheUsage,
			}));
			const { default: registerExtension } = await import("../index.js");
			const primary = createMockPi();
			registerExtension(primary.pi as any);
			await primary.trigger(
				"message_end",
				{ message: { role: "assistant" } },
				{ cwd: "/x" },
			);
			const { getDegradationSummary } =
				await import("../clients/degradation-ledger.js");
			expect(logCacheUsage).toHaveBeenCalledOnce();
			expect(
				getDegradationSummary().find(
					(group) => group.kind === "cache-usage-attribution-stale",
				),
			).toBeUndefined();
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"message_end stale attribution uses the last live ctx session, not the replacement",
		async () => {
			const logCacheUsage = vi.fn();
			const incrementDegradationCount = vi.fn();
			vi.doMock("../clients/cache-observability.js", async (importActual) => ({
				...(await importActual<
					typeof import("../clients/cache-observability.js")
				>()),
				logCacheUsage,
			}));
			vi.doMock("../clients/degradation-ledger.js", async (importActual) => ({
				...(await importActual<
					typeof import("../clients/degradation-ledger.js")
				>()),
				incrementDegradationCount,
			}));
			const { default: registerExtension } = await import("../index.js");
			const { registerPrimarySession } =
				await import("../clients/session-lifecycle.js");
			const primary = createMockPi();
			registerExtension(primary.pi as any);
			registerPrimarySession({}, "session-one");
			const liveCtx = makeCtx({ sessionId: "session-one" });
			await primary.trigger(
				"message_end",
				{ message: { role: "assistant" } },
				liveCtx,
			);
			registerPrimarySession({}, "session-two");
			await primary.trigger(
				"message_end",
				{ message: { role: "assistant" } },
				makeStaleCtx(),
			);
			expect(incrementDegradationCount).toHaveBeenCalledWith(
				expect.objectContaining({ metadata: { sessionId: "session-one" } }),
			);
			expect(incrementDegradationCount).toHaveBeenCalledTimes(1);
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"message_end stale attribution survives the real session_start rotation",
		async () => {
			const logCacheUsage = vi.fn();
			r6Mocks.incrementDegradationCount.mockClear();
			vi.doMock("../clients/cache-observability.js", async (importActual) => ({
				...(await importActual<
					typeof import("../clients/cache-observability.js")
				>()),
				logCacheUsage,
			}));
			vi.doMock("../clients/degradation-ledger.js", async (importActual) => ({
				...(await importActual<
					typeof import("../clients/degradation-ledger.js")
				>()),
				incrementDegradationCount: r6Mocks.incrementDegradationCount,
			}));
			vi.doMock("../clients/lsp/index.js", () => ({
				getLSPService: () => makeLspServiceDouble(),
				resetLSPService: vi.fn(),
			}));

			const { default: registerExtension } = await import("../index.js");
			const primary = createMockPi();
			registerExtension(primary.pi as any);
			const sessionA = makeCtx({ cwd: tmpDir, sessionId: "SESSION-A" });
			await primary.trigger("session_start", {}, sessionA);
			await primary.trigger(
				"message_end",
				{ message: { role: "assistant" } },
				sessionA,
			);

			// The real session-start guard sees the replaced A context as stale, so
			// B is a primary replacement and handleSessionStart performs its reset.
			(sessionA.isIdle as () => unknown) = () => {
				throw new Error("stale after session replacement");
			};
			const sessionB = makeCtx({ cwd: tmpDir, sessionId: "SESSION-B" });
			await primary.trigger("session_start", {}, sessionB);
			await primary.trigger(
				"message_end",
				{ message: { role: "assistant" } },
				makeStaleCtx(),
			);

			expect(r6Mocks.incrementDegradationCount).toHaveBeenCalledWith(
				expect.objectContaining({
					metadata: { sessionId: "SESSION-A" },
				}),
			);
			expect(r6Mocks.incrementDegradationCount).toHaveBeenCalledTimes(1);
			expect(logCacheUsage).toHaveBeenCalledTimes(2);
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"message_end still writes cache_usage when ledger counting throws",
		async () => {
			const logCacheUsage = vi.fn();
			vi.doMock("../clients/cache-observability.js", async (importActual) => ({
				...(await importActual<
					typeof import("../clients/cache-observability.js")
				>()),
				logCacheUsage,
			}));
			vi.doMock("../clients/degradation-ledger.js", async (importActual) => ({
				...(await importActual<
					typeof import("../clients/degradation-ledger.js")
				>()),
				incrementDegradationCount: vi.fn(() => {
					throw new Error("ledger unavailable");
				}),
			}));
			const { default: registerExtension } = await import("../index.js");
			const primary = createMockPi();
			registerExtension(primary.pi as any);
			await primary.trigger(
				"message_end",
				{ message: { role: "assistant", usage: { input: 1, output: 1 } } },
				makeStaleCtx(),
			);
			expect(logCacheUsage).toHaveBeenCalledOnce();
		},
		INTEGRATION_TIMEOUT_MS,
	);
});
