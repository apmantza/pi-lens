import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import { resetDegradationLedger } from "../../clients/degradation-ledger.js";
import { getProjectDataDir } from "../../clients/file-utils.js";
import { handleAgentEnd } from "../../clients/runtime-agent-end.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleToolCall } from "../../clients/runtime-tool-call.js";
import { handleToolResult } from "../../clients/runtime-tool-result.js";
import { handleTurnEnd } from "../../clients/runtime-turn.js";
import { setAmbientAbortSignal } from "../../clients/safe-spawn.js";
import { gatedPromise } from "../support/fault-injection.js";

// Controllable bootstrap seam: the shared double's loader is fixed, so this
// file carries its own factory with the same export keys plus a shutdown
// latch (M9/M10 need the fail-open null) and an analyzeFile spy (M7).
const bootstrapCtl = vi.hoisted(() => ({
	shutdown: false,
	analyzeFile: vi.fn(async () => undefined),
}));

vi.mock("../../clients/bootstrap.js", async () => {
	const { bootstrapSeamMock } = await import("../support/bootstrap-mock.js");
	const mock = bootstrapSeamMock(async () => ({
		complexityClient: {
			isSupportedFile: () => true,
			analyzeFile: (...args: unknown[]) =>
				(bootstrapCtl.analyzeFile as (...a: unknown[]) => Promise<unknown>)(
					...args,
				),
		},
		biomeClient: {},
		ruffClient: {},
		metricsClient: {},
		agentBehaviorClient: {
			recordToolCall: () => [],
			formatWarnings: () => "",
		},
	}));
	return {
		...mock,
		requestBootstrapClients: async (options?: { signal?: AbortSignal }) => {
			if (options?.signal?.aborted) return null;
			if (bootstrapCtl.shutdown) {
				const resident = mock.peekBootstrapClients();
				if (resident === null) return null;
			}
			return mock.requestBootstrapClients(options);
		},
	};
});

const runPipelineMock = vi.fn();
vi.mock("../../clients/pipeline.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/pipeline.js")>();
	return { ...actual, runPipeline: (...args: unknown[]) => runPipelineMock(...args) };
});

function makeTmpDir(prefix: string): { dir: string; cleanup: () => void } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	return {
		dir,
		cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
	};
}

function backdateTurnState(cwd: string, ageMs: number): void {
	const statePath = path.join(getProjectDataDir(cwd), "turn-state.json");
	const state = JSON.parse(fs.readFileSync(statePath, "utf-8")) as {
		lastUpdated?: string;
	};
	state.lastUpdated = new Date(Date.now() - ageMs).toISOString();
	fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

const stubKnip = () => ({
	ensureAvailable: async () => false,
	analyze: async () => ({ success: true, issues: [] }),
});
const stubDepChecker = (onBatch?: (files: string[]) => void) => ({
	ensureAvailable: async () => true,
	checkFilesBatch: async (files: string[]) => {
		onBatch?.(files);
		return { results: new Map() };
	},
});

describe("#2939 slice-2 guard pins through the real clients", () => {
	beforeEach(async () => {
		resetDegradationLedger();
		setAmbientAbortSignal(undefined);
		bootstrapCtl.shutdown = false;
		bootstrapCtl.analyzeFile.mockClear();
		runPipelineMock.mockReset();
		const bootstrap = await import("../../clients/bootstrap.js");
		bootstrap.resetAnalyzerBootstrapSessionState();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		setAmbientAbortSignal(undefined);
	});

	it("M4 retains a newer turn worklist when the turn advanced mid-dispatch", async () => {
		// The turn-index check in clearOwnedTurnState: a turn that advanced
		// while turn_end was in flight must keep its worklist. The racing
		// turn is simulated inside the first turn-state read: the dispatch
		// captures turnIndexAtDispatch before it, advances after it.
		const { dir, cleanup } = makeTmpDir("pi-lens-m4-turn-index-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = dir;
			const seedFile = path.join(dir, "seed.ts");
			fs.writeFileSync(seedFile, "export const seed = 1;\n");
			const realCache = new CacheManager(false);
			// Ownerless worklist that predates this session, so the gate
			// reaches the turn-index check instead of the owned fast path.
			realCache.addModifiedRange(seedFile, { start: 1, end: 1 }, false, dir);
			backdateTurnState(dir, 10 * 60 * 1000);

			const newerFile = path.join(dir, "newer.ts");
			fs.writeFileSync(newerFile, "export const newer = 1;\n");
			const earlyClears: number[] = [];
			let phase: "early" | "late" = "early";
			class InterleavingCache extends CacheManager {
				private firstRead = true;
				override readTurnState(cwd: string) {
					const before = super.readTurnState(cwd);
					if (this.firstRead) {
						this.firstRead = false;
						// The racing turn: advances the index, then writes its
						// own ownerless entry and backdates it so the gate
						// still reads "available" for it.
						runtime.beginTurn();
						realCache.addModifiedRange(
							newerFile,
							{ start: 1, end: 1 },
							false,
							dir,
						);
						backdateTurnState(dir, 10 * 60 * 1000);
					}
					return before;
				}
				override clearTurnState(cwd: string, owner?: never) {
					if (phase === "early") earlyClears.push(runtime.turnIndex);
					return super.clearTurnState(cwd, owner);
				}
			}
			const cacheManager = new InterleavingCache(false) as unknown as CacheManager;

			const dbg: string[] = [];
			await handleTurnEnd({
				ctxCwd: dir,
				getFlag: () => false,
				dbg: (msg: string) => dbg.push(msg),
				runtime,
				cacheManager,
				knipClient: stubKnip() as never,
				deadCodeClients: [],
				depChecker: stubDepChecker(() => {
					phase = "late";
				}) as never,
				testRunnerClient: { getTestRunTarget: () => null },
				resetLSPService: () => {},
				resetFormatService: () => {},
			} as never);

			// No clear ran before the pipeline touched a client: the newer
			// turn's worklist survived the dispatch that started earlier.
			expect(earlyClears).toEqual([]);
			expect(
				dbg.some((line) => line.includes("retaining newer turn state")),
			).toBe(true);
		} finally {
			cleanup();
		}
	});

	it("M9 refuses to dispatch when analyzer bootstrap fails open", async () => {
		// ensureToolResultClients' `if (!clients) return false`: a null
		// bootstrap must end the tool_result early, never dispatch without
		// clients. Must run before any test in this file loads the seam.
		const { dir, cleanup } = makeTmpDir("pi-lens-m9-bootstrap-null-");
		try {
			bootstrapCtl.shutdown = true;
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = dir;
			const filePath = path.join(dir, "edit.ts");
			fs.writeFileSync(filePath, "export const x = 1;\n");
			const result = await handleToolResult({
				event: {
					toolName: "edit",
					input: {
						path: filePath,
						oldText: "export const x = 1;",
						newText: "export const x = 2;",
					},
					content: [{ type: "text", text: "ok" }],
				},
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager: new CacheManager(false),
				resetLSPService: () => {},
				readGuard: runtime.readGuard,
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as never);
			expect(result).toBeUndefined();
			// The discriminator: the dispatch pipeline was never reached.
			expect(runPipelineMock).not.toHaveBeenCalled();
		} finally {
			cleanup();
		}
	});

	it("M10 returns past a wedged pipeline once the analysis budget elapses", async () => {
		// The `pipeline-analysis` bound plus `if (!dispatchOutcome) return;`:
		// a dispatch that never settles must end the tool_result instead of
		// hanging it. Fake timers stand in for the 10 s edit budget.
		vi.useFakeTimers();
		const { dir, cleanup } = makeTmpDir("pi-lens-m10-pipeline-bound-");
		try {
			const gate = gatedPromise<never>();
			runPipelineMock.mockReturnValue(gate.promise);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = dir;
			const filePath = path.join(dir, "wedged.ts");
			fs.writeFileSync(filePath, "export const x = 1;\n");
			let settled = false;
			const pending = handleToolResult({
				event: {
					toolName: "edit",
					input: {
						path: filePath,
						oldText: "export const x = 1;",
						newText: "export const x = 2;",
					},
					content: [{ type: "text", text: "ok" }],
				},
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager: new CacheManager(false),
				resetLSPService: () => {},
				readGuard: runtime.readGuard,
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as never).then(
				(value) => {
					settled = true;
					return value;
				},
				(error) => {
					settled = true;
					throw error;
				},
			);
			// The dispatch was reached and wedged; the budget ends it.
			await vi.advanceTimersByTimeAsync(10_000);
			await pending;
			expect(settled).toBe(true);
			expect(runPipelineMock).toHaveBeenCalledTimes(1);
			expect(gate.settled()).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("M7 threads the live tool_call signal into the complexity baseline demand", async () => {
		// `signal: deps.ctx.signal` (#2523 AC4): an aborted turn must
		// release the analyzer demand instead of loading the graph for
		// nobody. The discriminator is whether analyzeFile runs.
		const { dir, cleanup } = makeTmpDir("pi-lens-m7-toolcall-signal-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = dir;
			const filePath = path.join(dir, "signal.ts");
			fs.writeFileSync(filePath, "export const x = 1;\n");
			const controller = new AbortController();
			controller.abort();
			await handleToolCall({
				event: {
					toolName: "read",
					input: { path: filePath },
				},
				ctx: { cwd: dir, signal: controller.signal },
				lensEnabled: true,
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager: new CacheManager(false),
				ensureLSPConfigInitialized: async () => {},
				updateLspStatus: () => {},
				resetLSPService: () => {},
			} as never);
			expect(bootstrapCtl.analyzeFile).not.toHaveBeenCalled();

			// Twin: a live signal still baselines, so the path is not
			// vacuously skipped.
			bootstrapCtl.analyzeFile.mockClear();
			await handleToolCall({
				event: {
					toolName: "read",
					input: { path: filePath },
				},
				ctx: { cwd: dir, signal: new AbortController().signal },
				lensEnabled: true,
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager: new CacheManager(false),
				ensureLSPConfigInitialized: async () => {},
				updateLspStatus: () => {},
				resetLSPService: () => {},
			} as never);
			expect(bootstrapCtl.analyzeFile).toHaveBeenCalledTimes(1);
		} finally {
			cleanup();
		}
	});

	it("M12 honors the explicit agent_end signal ahead of the ambient one", async () => {
		// `signal ?? getAmbientAbortSignal()`: the caller's own abort must
		// stop the drain even when the ambient slot is empty.
		const { dir, cleanup } = makeTmpDir("pi-lens-m12-agent-end-signal-");
		try {
			setAmbientAbortSignal(undefined);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = dir;
			const filePath = path.join(dir, "abort.ts");
			fs.writeFileSync(filePath, "const x=1\n");
			runtime.deferFormat(filePath, dir, "write", dir);
			const formatFile = vi.fn(async () => ({
				filePath,
				formatters: [],
				anyChanged: false,
				allSucceeded: true,
			}));
			const controller = new AbortController();
			controller.abort();
			await handleAgentEnd({
				signal: controller.signal,
				ctxCwd: dir,
				getFlag: () => false,
				notify: () => {},
				dbg: () => {},
				runtime,
				cacheManager: { addModifiedRange: vi.fn() } as never,
				getFormatService: () =>
					({
						recordRead: () => {},
						formatFile,
					}) as never,
			});
			// The discriminator: no formatter ran, and the record is still
			// queued for the next drain instead of being consumed.
			expect(formatFile).not.toHaveBeenCalled();
			expect(runtime.pendingDeferredFormatCount).toBe(1);
		} finally {
			cleanup();
		}
	});

	it("W2 requeues deferred format work past the agent_settled bound", async () => {
		// Restoring `if (!result) continue;` must drop the record: a
		// formatter that exceeds the bound is requeued, not lost. Fake
		// timers stand in for the 10 s agent_settled budget.
		vi.useFakeTimers();
		const { dir, cleanup } = makeTmpDir("pi-lens-w2-agent-settled-requeue-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = dir;
			const filePath = path.join(dir, "slow.ts");
			fs.writeFileSync(filePath, "const x=1\n");
			runtime.deferFormat(filePath, dir, "write", dir);
			const gate = gatedPromise<never>();
			const summary = await (async () => {
				const pending = handleAgentEnd({
					ctxCwd: dir,
					getFlag: () => false,
					notify: () => {},
					dbg: () => {},
					runtime,
					cacheManager: { addModifiedRange: vi.fn() } as never,
					getFormatService: () =>
						({
							recordRead: () => {},
							formatFile: () => gate.promise,
						}) as never,
				});
				await vi.advanceTimersByTimeAsync(10_000);
				// The drain yields through setImmediate between bookkeeping
				// steps after the bound fires; flush it too.
				await vi.advanceTimersByTimeAsync(100);
				return pending;
			})();
			expect(summary?.failed).toHaveLength(1);
			expect(summary?.failed[0]?.errors[0]).toMatch(/agent_settled budget/);
			// The discriminator: the record survived for the next drain.
			expect(runtime.pendingDeferredFormatCount).toBe(1);
			expect(gate.settled()).toBe(false);
		} finally {
			cleanup();
		}
	});
});
