// flake-shape: service-double — #4485: turn_end's registry peek reads the client an outstanding touch holds; a real server cannot be made to publish between the compute and turn_end on demand
// flake-shape: in-process-mock — the freshness gate writes its rows through logLatency; turn_end logs more phases after the gate than the five the getRecentLoggedPhases ring keeps, and test mode skips the file sink, so a passed-through spy is the only reader (#4495 round 3)
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import type { CascadeResult } from "../../clients/cascade-types.js";
import type { Diagnostic } from "../../clients/dispatch/types.js";
import { consumeTurnEndFindings } from "../../clients/runtime-context.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleTurnEnd } from "../../clients/runtime-turn.js";
import { setupTestEnvironment } from "./test-utils.js";

// R2 (#1443 follow-up): logCascade no-ops under isTestMode(), so asserting the
// "superseded_by_later_write" drop is logged with the honest per-file
// `changedFiles` list requires spying on it directly.
const logCascadeMock = vi.fn();
vi.mock("../../clients/cascade-logger.js", () => ({
	logCascade: (...args: unknown[]) => logCascadeMock(...args),
	flushCascadeLog: vi.fn().mockResolvedValue(undefined),
	getCascadeLogPath: vi.fn().mockReturnValue("/tmp/cascade.log"),
}));

// #4495 round 3 (R2-3): the shared freshness gate's own rows name a
// demotion; the cascade's pending gate drops or announces instead, so it runs
// quiet and writes its own row. Spied and passed through.
const logLatencyMock = vi.hoisted(() => vi.fn());
vi.mock("../../clients/latency-logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/latency-logger.js")>();
	return {
		...actual,
		logLatency: (entry: Parameters<typeof actual.logLatency>[0]) => {
			logLatencyMock(entry);
			actual.logLatency(entry);
		},
	};
});

const EMPTY_KNIP_RESULT = {
	success: true,
	issues: [],
	unusedExports: [],
	unusedFiles: [],
	unusedDeps: [],
	unlistedDeps: [],
	summary: "skipped",
};

function diagnostic(filePath: string, message: string, line = 1): Diagnostic {
	return {
		id: `lsp:test:${line}`,
		message,
		filePath,
		line,
		column: 1,
		severity: "error",
		semantic: "blocking",
		tool: "lsp",
		rule: "cascade:test",
	};
}

function cascade(
	primary: string,
	neighbor: string,
	message: string,
): CascadeResult {
	const neighborBase = path.basename(neighbor);
	return {
		filePath: primary,
		impact: {
			filePath: primary,
			changedSymbols: [],
			directImporters: [neighbor],
			directCallers: [],
			neighborFiles: [neighbor],
			riskFlags: [],
		},
		neighbors: [
			{
				filePath: neighbor,
				reason: "imports",
				diagnostics: [diagnostic(neighbor, message)],
				lspTouched: false,
			},
		],
		formatted: `Cascade errors in 1 dependent file\n${neighborBase}: ${message}`,
	};
}

// The pending neighbour-error record (#4487) is module state that every
// turn_end here writes; no test hands its entries to the next.
afterEach(async () => {
	const { resetCascadePendingNeighbors } =
		await import("../../clients/cascade-format.js");
	resetCascadePendingNeighbors();
});

describe("cascade turn-end merge", () => {
	it("deduplicates cascade diagnostics by neighbor file with last writer winning", async () => {
		const env = setupTestEnvironment("cascade-turn-merge-");
		try {
			const runtime = new RuntimeCoordinator();
			const cacheManager = new CacheManager(false);
			const primaryA = path.join(env.tmpDir, "a.ts");
			const primaryB = path.join(env.tmpDir, "b.ts");
			const sharedNeighbor = path.join(env.tmpDir, "shared.ts");
			fs.writeFileSync(primaryA, "export const a = 1;\n");
			fs.writeFileSync(primaryB, "export const b = 1;\n");
			fs.writeFileSync(sharedNeighbor, "export const shared = 1;\n");

			cacheManager.addModifiedRange(
				primaryA,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
			);
			cacheManager.addModifiedRange(
				primaryB,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
			);

			runtime.appendCascadeRun({
				filePath: primaryA,
				result: cascade(primaryA, sharedNeighbor, "old error"),
				neighborCount: 1,
				diagnosticCount: 1,
			});
			runtime.appendCascadeRun({
				filePath: primaryB,
				result: cascade(primaryB, sharedNeighbor, "new error"),
				neighborCount: 1,
				diagnosticCount: 1,
			});

			await handleTurnEnd({
				ctxCwd: env.tmpDir,
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager,
				knipClient: {
					ensureAvailable: async () => false,
					analyze: async () => EMPTY_KNIP_RESULT,
				},
				deadCodeClients: [],
				depChecker: { ensureAvailable: async () => false },
				testRunnerClient: { getTestRunTarget: () => null },
				resetLSPService: () => {},
				resetFormatService: () => {},
			} as any);

			const findings = consumeTurnEndFindings(cacheManager, env.tmpDir);
			const content = findings?.messages[0]?.content ?? "";
			expect(content).toContain("Cascade errors in 1 dependent file");
			expect(content).toContain("shared.ts");
			expect(content).toContain("new error");
			expect(content).not.toContain("old error");
		} finally {
			env.cleanup();
		}
	});

	// #1443: a high-fan-out cascade compute that misses the turn-end settle cap is
	// re-parked by `settleCascadeRuns` for the NEXT turn_end — and used to be
	// discarded there, because the origin filter demanded `originTurn ===
	// turnIndex` and a late run is by definition from an earlier turn. `projectSeq`
	// (unchanged here — no later write) is the actual supersede signal.
	it("merges a compute that resolved after the settle cap on the following turn_end (#1443)", async () => {
		const env = setupTestEnvironment("cascade-late-settle-");
		// Keep the settle cap short — this test is about what happens AFTER it
		// lapses, not about the 5s default.
		const prevSettleWait = process.env.PI_LENS_CASCADE_SETTLE_WAIT_MS;
		process.env.PI_LENS_CASCADE_SETTLE_WAIT_MS = "0";
		try {
			const runtime = new RuntimeCoordinator();
			const cacheManager = new CacheManager(false);
			const primary = path.join(env.tmpDir, "logger.ts");
			const neighbor = path.join(env.tmpDir, "consumer.ts");
			fs.writeFileSync(primary, "export const log = 1;\n");
			fs.writeFileSync(neighbor, "import { log } from './logger';\n");
			cacheManager.addModifiedRange(
				primary,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
			);

			const turnEnd = async () =>
				await handleTurnEnd({
					ctxCwd: env.tmpDir,
					getFlag: () => false,
					dbg: () => {},
					runtime,
					cacheManager,
					knipClient: {
						ensureAvailable: async () => false,
						analyze: async () => EMPTY_KNIP_RESULT,
					},
					deadCodeClients: [],
					depChecker: { ensureAvailable: async () => false },
					testRunnerClient: { getTestRunTarget: () => null },
					resetLSPService: () => {},
					resetFormatService: () => {},
				} as any);

			// Turn 1: the 38-neighbour compute is still running at the cap.
			runtime.beginTurn();
			let release!: (
				r: import("../../clients/cascade-types.js").CascadeRun,
			) => void;
			runtime.appendCascadePromise(
				new Promise((res) => {
					release = res;
				}),
				runtime.captureSessionGeneration(),
				"edit.ts",
			);
			await turnEnd();
			consumeTurnEndFindings(cacheManager, env.tmpDir);

			// It lands moments later, stamped with the turn that launched it.
			release({
				filePath: primary,
				origin: { turnSeq: runtime.turnIndex, projectSeq: runtime.projectSeq },
				result: cascade(primary, neighbor, "late high-fanout error"),
				neighborCount: 1,
				diagnosticCount: 1,
			});

			// Turn 2: no write superseded it, so it must be merged, not discarded.
			runtime.beginTurn();
			cacheManager.addModifiedRange(
				primary,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
			);
			await turnEnd();
			const content =
				consumeTurnEndFindings(cacheManager, env.tmpDir)?.messages[0]
					?.content ?? "";
			expect(content).toContain("consumer.ts");
			expect(content).toContain("late high-fanout error");
		} finally {
			if (prevSettleWait === undefined) {
				delete process.env.PI_LENS_CASCADE_SETTLE_WAIT_MS;
			} else {
				process.env.PI_LENS_CASCADE_SETTLE_WAIT_MS = prevSettleWait;
			}
			env.cleanup();
		}
	});

	// #1443/#1444 END TO END: a native-TS7 neighbour's diagnostics arrive by pull
	// AFTER the cascade touch budget, so the quiet-window reconcile appends its
	// CascadeRun only once the turn that launched it has already consumed its
	// runs. The finding must therefore surface in the FOLLOWING turn_end.
	// Pre-fix, `beginTurn` wiped `_cascadeRuns` at turn_start and the run was
	// deleted one step before the message that would have carried it — computed,
	// formatted, appended, and silently dropped.
	it("surfaces a late native-TS7 neighbour error in the FOLLOWING turn_end (#1443)", async () => {
		const env = setupTestEnvironment("cascade-carry-over-");
		const {
			_resetOutstandingCascadeTouchesForTests,
			recordOutstandingCascadeTouch,
			reconcileOutstandingCascadeTouches,
		} = await import("../../clients/lsp/cascade-tier.js");
		const { buildResolvedFoundCascadeRun } =
			await import("../../clients/cascade-format.js");
		const { normalizeMapKey } = await import("../../clients/path-utils.js");
		_resetOutstandingCascadeTouchesForTests();
		try {
			const runtime = new RuntimeCoordinator();
			const cacheManager = new CacheManager(false);
			const primary = path.join(env.tmpDir, "primary.ts");
			const neighbor = path.join(env.tmpDir, "neighbor.ts");
			const later = path.join(env.tmpDir, "later.ts");
			fs.writeFileSync(primary, "export const x = 1;\n");
			fs.writeFileSync(neighbor, "import { x } from './primary';\n");
			fs.writeFileSync(later, "export const y = 2;\n");

			const turnEnd = async () =>
				await handleTurnEnd({
					ctxCwd: env.tmpDir,
					getFlag: () => false,
					dbg: () => {},
					runtime,
					cacheManager,
					knipClient: {
						ensureAvailable: async () => false,
						analyze: async () => EMPTY_KNIP_RESULT,
					},
					deadCodeClients: [],
					depChecker: { ensureAvailable: async () => false },
					testRunnerClient: { getTestRunTarget: () => null },
					resetLSPService: () => {},
					resetFormatService: () => {},
				} as any);

			// --- Turn 1: the edit that launched the cascade. Its native-TS7
			// neighbour touch skipped the in-lane wait, so turn_end says nothing.
			runtime.beginTurn();
			cacheManager.addModifiedRange(
				primary,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
			);
			await turnEnd();
			expect(
				consumeTurnEndFindings(cacheManager, env.tmpDir)?.messages[0]
					?.content ?? "",
			).not.toContain("neighbor.ts");

			// --- Quiet window after turn 1: the pull result finally lands.
			const touchedAt = Date.now() - 50;
			recordOutstandingCascadeTouch({
				filePath: neighbor,
				serverId: "typescript",
				touchedAt,
			});
			const outcomes = await reconcileOutstandingCascadeTouches({
				getWarmClientForFile: async () => ({
					client: {
						serverId: "typescript",
						getAllDiagnostics: () =>
							new Map([
								[
									normalizeMapKey(neighbor),
									{
										ts: Date.now(),
										diags: [
											{
												severity: 1,
												message: "late native TS7 error",
												range: {
													start: { line: 0, character: 0 },
													end: { line: 0, character: 1 },
												},
											},
										],
									},
								],
							]),
					},
				}),
			} as any);
			expect(outcomes[0]?.outcome).toBe("resolved-found");
			const run = buildResolvedFoundCascadeRun(env.tmpDir, {
				filePath: neighbor,
				diagnostics: outcomes[0]?.diagnostics ?? [],
			});
			expect(run).toBeDefined();
			// This is exactly what index.ts's onResolvedFound callback does.
			if (run) runtime.appendCascadeRun(run);

			// --- Turn 2: a new turn_start (which used to wipe the run) and a new
			// edit. The carried finding must reach the agent here.
			runtime.beginTurn();
			cacheManager.addModifiedRange(
				later,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
			);
			await turnEnd();
			const content =
				consumeTurnEndFindings(cacheManager, env.tmpDir)?.messages[0]
					?.content ?? "";
			expect(content).toContain("neighbor.ts");
			expect(content).toContain("late native TS7 error");

			// --- Turn 3: consumed once, never replayed.
			runtime.beginTurn();
			cacheManager.addModifiedRange(
				later,
				{ start: 2, end: 2 },
				false,
				env.tmpDir,
			);
			await turnEnd();
			expect(
				consumeTurnEndFindings(cacheManager, env.tmpDir)?.messages[0]
					?.content ?? "",
			).not.toContain("late native TS7 error");
		} finally {
			_resetOutstandingCascadeTouchesForTests();
			env.cleanup();
		}
	});

	// R1 (#1443 follow-up): a read-only turn — the agent answers a question and
	// touches no files — must NOT burn the one-turn carry allowance on a run
	// that never got a chance to reach a drain. Pre-fix, the files-empty early
	// return in `handleTurnEnd` skipped `consumeCascadeRuns` entirely, so the
	// EDIT turn that follows the read-only turn saw `beginTurn` stamp
	// `carriedTurns` past the bound and drop the run before that turn's
	// turn_end ever ran — the carry was consumed by a turn that could not have
	// delivered it either way.
	it("returns promptly from a read-only turn when only a PENDING run exists (F1)", async () => {
		const env = setupTestEnvironment("pi-lens-cascade-f1-pending-");
		try {
			const runtime = new RuntimeCoordinator();
			const cacheManager = new CacheManager(false);
			// A compute that never settles: the peek must NOT route the
			// read-only turn into the settle-cap wait for it.
			runtime.appendCascadePromise(
				new Promise(() => {}),
				runtime.captureSessionGeneration(),
				"edit.ts",
			);
			expect(runtime.hasCascadeRuns()).toBe(false);
			runtime.beginTurn();
			const startedAt = Date.now();
			await handleTurnEnd({
				ctxCwd: env.tmpDir,
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager,
				knipClient: {
					ensureAvailable: async () => false,
					analyze: async () => EMPTY_KNIP_RESULT,
				},
				deadCodeClients: [],
				depChecker: { ensureAvailable: async () => false },
				testRunnerClient: { getTestRunTarget: () => null },
				resetLSPService: () => {},
				resetFormatService: () => {},
			} as any);
			// The early-return path must be taken: no settle-cap wait.
			expect(Date.now() - startedAt).toBeLessThan(1000);
		} finally {
			env.cleanup();
		}
	});

	it("delivers a carried cascade finding across edit -> read-only -> edit turns (#1443 R1)", async () => {
		const env = setupTestEnvironment("cascade-readonly-carry-");
		try {
			const runtime = new RuntimeCoordinator();
			const cacheManager = new CacheManager(false);
			const primary = path.join(env.tmpDir, "primary.ts");
			const neighbor = path.join(env.tmpDir, "neighbor.ts");
			const later = path.join(env.tmpDir, "later.ts");
			fs.writeFileSync(primary, "export const x = 1;\n");
			fs.writeFileSync(neighbor, "import { x } from './primary';\n");
			fs.writeFileSync(later, "export const y = 2;\n");

			const turnEnd = async () =>
				await handleTurnEnd({
					ctxCwd: env.tmpDir,
					getFlag: () => false,
					dbg: () => {},
					runtime,
					cacheManager,
					knipClient: {
						ensureAvailable: async () => false,
						analyze: async () => EMPTY_KNIP_RESULT,
					},
					deadCodeClients: [],
					depChecker: { ensureAvailable: async () => false },
					testRunnerClient: { getTestRunTarget: () => null },
					resetLSPService: () => {},
					resetFormatService: () => {},
				} as any);

			// --- Turn 1 (edit): the write's cascade compute misses this turn's
			// settle cap; the quiet-window reconcile appends the CascadeRun only
			// AFTER this turn_end already ran (mirrors the reconcile path in the
			// test above, simplified to a direct appendCascadeRun stamped with
			// this turn's origin).
			runtime.beginTurn();
			cacheManager.addModifiedRange(
				primary,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
			);
			await turnEnd();
			expect(
				consumeTurnEndFindings(cacheManager, env.tmpDir)?.messages[0]
					?.content ?? "",
			).not.toContain("neighbor.ts");

			runtime.appendCascadeRun({
				filePath: primary,
				origin: { turnSeq: runtime.turnIndex, projectSeq: runtime.projectSeq },
				result: cascade(primary, neighbor, "late carried error"),
				neighborCount: 1,
				diagnosticCount: 1,
			});

			// --- Turn 2 (read-only): the agent answers a question, touches no
			// files. The carried run must still be able to reach a drain here.
			runtime.beginTurn();
			await turnEnd();
			const turn2Content =
				consumeTurnEndFindings(cacheManager, env.tmpDir)?.messages[0]
					?.content ?? "";

			// --- Turn 3 (edit): if turn 2 already delivered it, turn 3 must NOT
			// see it again (exactly-once). If turn 2 did not deliver it, turn 3
			// must still see it (never lost) — either is a pass; only silent loss
			// across both turns is the bug (the pre-fix outcome).
			runtime.beginTurn();
			cacheManager.addModifiedRange(
				later,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
			);
			await turnEnd();
			const turn3Content =
				consumeTurnEndFindings(cacheManager, env.tmpDir)?.messages[0]
					?.content ?? "";

			const deliveredOnce =
				(turn2Content.includes("late carried error") ? 1 : 0) +
				(turn3Content.includes("late carried error") ? 1 : 0);
			expect(deliveredOnce).toBe(1);
		} finally {
			env.cleanup();
		}
	});

	// R2 (#1443 follow-up): `projectSeq` is GLOBAL — it used to reject a late
	// run whenever ANY file anywhere in the project was written after the run
	// launched, not just a file the run actually covers. An edit to a wholly
	// unrelated file must not supersede it.
	it("delivers a late run past an unrelated write (#1443 R2)", async () => {
		const env = setupTestEnvironment("cascade-r2-unrelated-");
		logCascadeMock.mockClear();
		try {
			const runtime = new RuntimeCoordinator();
			const cacheManager = new CacheManager(false);
			const primary = path.join(env.tmpDir, "logger.ts");
			const neighbor = path.join(env.tmpDir, "consumer.ts");
			const unrelated = path.join(env.tmpDir, "unrelated.ts");
			fs.writeFileSync(primary, "export const log = 1;\n");
			fs.writeFileSync(neighbor, "import { log } from './logger';\n");
			fs.writeFileSync(unrelated, "export const z = 1;\n");

			const originProjectSeq = runtime.bumpFileSeq(primary).projectSeq;
			runtime.appendCascadeRun({
				filePath: primary,
				origin: { turnSeq: runtime.turnIndex, projectSeq: originProjectSeq },
				result: cascade(primary, neighbor, "unrelated-write-survives"),
				neighborCount: 1,
				diagnosticCount: 1,
			});

			// A write to a file this run has nothing to do with.
			runtime.bumpFileSeq(unrelated);

			cacheManager.addModifiedRange(
				primary,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
			);
			await handleTurnEnd({
				ctxCwd: env.tmpDir,
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager,
				knipClient: {
					ensureAvailable: async () => false,
					analyze: async () => EMPTY_KNIP_RESULT,
				},
				deadCodeClients: [],
				depChecker: { ensureAvailable: async () => false },
				testRunnerClient: { getTestRunTarget: () => null },
				resetLSPService: () => {},
				resetFormatService: () => {},
			} as any);

			const content =
				consumeTurnEndFindings(cacheManager, env.tmpDir)?.messages[0]
					?.content ?? "";
			expect(content).toContain("unrelated-write-survives");
		} finally {
			env.cleanup();
		}
	});

	// R2 (#1443 follow-up): a write that DOES touch the run's own primary file
	// must still supersede it — the honest per-file drop, logged with the
	// changed-file list instead of the global projectSeq.
	it("drops a late run whose own primary file was rewritten, with a log (#1443 R2)", async () => {
		const env = setupTestEnvironment("cascade-r2-own-file-");
		logCascadeMock.mockClear();
		try {
			const runtime = new RuntimeCoordinator();
			const cacheManager = new CacheManager(false);
			const primary = path.join(env.tmpDir, "logger.ts");
			const neighbor = path.join(env.tmpDir, "consumer.ts");
			fs.writeFileSync(primary, "export const log = 1;\n");
			fs.writeFileSync(neighbor, "import { log } from './logger';\n");

			const originProjectSeq = runtime.bumpFileSeq(primary).projectSeq;
			runtime.appendCascadeRun({
				filePath: primary,
				origin: { turnSeq: runtime.turnIndex, projectSeq: originProjectSeq },
				result: cascade(primary, neighbor, "superseded-by-own-write"),
				neighborCount: 1,
				diagnosticCount: 1,
			});

			// A later write to the run's OWN primary file.
			runtime.bumpFileSeq(primary);

			cacheManager.addModifiedRange(
				primary,
				{ start: 2, end: 2 },
				false,
				env.tmpDir,
			);
			await handleTurnEnd({
				ctxCwd: env.tmpDir,
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager,
				knipClient: {
					ensureAvailable: async () => false,
					analyze: async () => EMPTY_KNIP_RESULT,
				},
				deadCodeClients: [],
				depChecker: { ensureAvailable: async () => false },
				testRunnerClient: { getTestRunTarget: () => null },
				resetLSPService: () => {},
				resetFormatService: () => {},
			} as any);

			const content =
				consumeTurnEndFindings(cacheManager, env.tmpDir)?.messages[0]
					?.content ?? "";
			expect(content).not.toContain("superseded-by-own-write");
			expect(logCascadeMock).toHaveBeenCalledWith(
				expect.objectContaining({
					phase: "cascade_carry_over_drop",
					reason: "superseded_by_later_write",
					metadata: expect.objectContaining({
						changedFiles: expect.arrayContaining([
							expect.stringContaining("logger.ts"),
						]),
					}),
				}),
			);
		} finally {
			env.cleanup();
		}
	});

	it("drops a budget carry-over when a selected neighbor was rewritten", async () => {
		const env = setupTestEnvironment("cascade-budget-carry-over-drop-");
		logCascadeMock.mockClear();
		try {
			const runtime = new RuntimeCoordinator();
			const cacheManager = new CacheManager(false);
			const primary = path.join(env.tmpDir, "logger.ts");
			const neighbor = path.join(env.tmpDir, "consumer.ts");
			fs.writeFileSync(primary, "export const log = 1;\n");
			fs.writeFileSync(neighbor, "import { log } from './logger';\n");
			cacheManager.addModifiedRange(
				primary,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
			);

			const originProjectSeq = runtime.bumpFileSeq(primary).projectSeq;
			runtime.appendCascadeRun({
				filePath: primary,
				origin: { turnSeq: runtime.turnIndex, projectSeq: originProjectSeq },
				result: undefined,
				neighborCount: 1,
				diagnosticCount: 0,
				skipReason: "indeterminate",
				selectedNeighborPaths: [neighbor],
				indeterminate: {
					reason: "budget_truncated",
					detail: "budget detail",
					budget: {
						candidateCount: 2,
						eligibleCount: 2,
						selectedCount: 1,
						truncatedCount: 1,
					},
				},
			});

			runtime.bumpFileSeq(neighbor);
			await handleTurnEnd({
				ctxCwd: env.tmpDir,
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager,
				knipClient: {
					ensureAvailable: async () => false,
					analyze: async () => EMPTY_KNIP_RESULT,
				},
				deadCodeClients: [],
				depChecker: { ensureAvailable: async () => false },
				testRunnerClient: { getTestRunTarget: () => null },
				resetLSPService: () => {},
				resetFormatService: () => {},
			} as any);

			const content =
				consumeTurnEndFindings(cacheManager, env.tmpDir)?.messages[0]
					?.content ?? "";
			expect(content).not.toContain("budget detail");
			expect(logCascadeMock).toHaveBeenCalledWith(
				expect.objectContaining({
					phase: "cascade_carry_over_drop",
					reason: "superseded_by_later_write",
					metadata: expect.objectContaining({
						changedFiles: expect.arrayContaining([
							expect.stringContaining("consumer.ts"),
						]),
					}),
				}),
			);
		} finally {
			env.cleanup();
		}
	});

	// #1023: a degraded/indeterminate cascade run must surface an HONEST note at
	// turn_end (today it was a silent all-clear — the #533 bug). It lands in the
	// ADVISORY tier (not the blocker tier) so an over-cap monorepo does not fire a
	// hard blocker every turn. Keyed off the `indeterminate` marker on the run.
	it("surfaces an indeterminate advisory when a cascade run could not compute impact", async () => {
		const env = setupTestEnvironment("cascade-indeterminate-");
		try {
			const runtime = new RuntimeCoordinator();
			const cacheManager = new CacheManager(false);
			const primary = path.join(env.tmpDir, "over-cap.ts");
			fs.writeFileSync(primary, "export const x = 1;\n");
			cacheManager.addModifiedRange(
				primary,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
			);

			runtime.appendCascadeRun({
				filePath: primary,
				result: undefined,
				neighborCount: 0,
				diagnosticCount: 0,
				skipReason: "indeterminate",
				indeterminate: {
					reason: "graph_degraded",
					detail: "review graph disabled — 5000 files over the 4000 cap",
					sourceFileCount: 5000,
					maxFileCount: 4000,
				},
			});

			await handleTurnEnd({
				ctxCwd: env.tmpDir,
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager,
				knipClient: {
					ensureAvailable: async () => false,
					analyze: async () => EMPTY_KNIP_RESULT,
				},
				deadCodeClients: [],
				depChecker: { ensureAvailable: async () => false },
				testRunnerClient: { getTestRunTarget: () => null },
				resetLSPService: () => {},
				resetFormatService: () => {},
			} as any);

			const findings = consumeTurnEndFindings(cacheManager, env.tmpDir);
			const content = findings?.messages[0]?.content ?? "";
			expect(content).toContain("Cascade could not compute downstream impact");
			expect(content).toContain("a clean cascade result does not cover them");
			expect(content).toContain("over-cap.ts");
			expect(content).toContain("5000 files over the 4000 cap");
			// Advisory tier, not blocker tier: it carries the advisory label and
			// must NOT read as a hard blocker imperative.
			expect(content).toContain("Advisory — no action required this turn");
			expect(content).not.toContain("review dependents manually");
		} finally {
			env.cleanup();
		}
	});

	it("uses the selected-neighbor frame for a budget-truncated cascade", async () => {
		const env = setupTestEnvironment("cascade-budget-truncated-");
		try {
			const runtime = new RuntimeCoordinator();
			const cacheManager = new CacheManager(false);
			const primary = path.join(env.tmpDir, "budget-truncated.ts");
			fs.writeFileSync(primary, "export const x = 1;\n");
			cacheManager.addModifiedRange(
				primary,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
			);

			runtime.appendCascadeRun({
				filePath: primary,
				result: undefined,
				neighborCount: 0,
				diagnosticCount: 0,
				skipReason: "indeterminate",
				indeterminate: {
					reason: "budget_truncated",
					detail:
						"cascade budget checked 10 of 40 eligible dependents (30 omitted)",
					budget: {
						candidateCount: 40,
						eligibleCount: 40,
						selectedCount: 10,
						truncatedCount: 30,
					},
				},
			});

			await handleTurnEnd({
				ctxCwd: env.tmpDir,
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager,
				knipClient: {
					ensureAvailable: async () => false,
					analyze: async () => EMPTY_KNIP_RESULT,
				},
				deadCodeClients: [],
				depChecker: { ensureAvailable: async () => false },
				testRunnerClient: { getTestRunTarget: () => null },
				resetLSPService: () => {},
				resetFormatService: () => {},
			} as any);

			const findings = consumeTurnEndFindings(cacheManager, env.tmpDir);
			const content = findings?.messages[0]?.content ?? "";
			expect(content).toContain("Cascade checked the selected neighbors");
			expect(content).toContain(
				"cascade budget checked 10 of 40 eligible dependents (30 omitted)",
			);
			expect(content).toContain("a clean cascade result does not cover them");
			expect(content).not.toContain("the review graph was unavailable");
		} finally {
			env.cleanup();
		}
	});

	// #1104 (review P3 on PR #1143): the advisory preamble used to hardcode "the
	// review graph was unavailable" for EVERY indeterminate reason. For
	// `lsp_binding_rejected` that's a mis-attribution — the graph WAS available
	// and dependents WERE derived; only the LSP diagnostics display was
	// withheld because a fallback snapshot's content binding didn't match
	// current disk. The advisory must use a reason-appropriate frame instead.
	it("uses a binding-specific frame (not 'review graph was unavailable') for an lsp_binding_rejected run", async () => {
		const env = setupTestEnvironment("cascade-binding-rejected-");
		try {
			const runtime = new RuntimeCoordinator();
			const cacheManager = new CacheManager(false);
			const primary = path.join(env.tmpDir, "edited.ts");
			fs.writeFileSync(primary, "export const x = 1;\n");
			cacheManager.addModifiedRange(
				primary,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
			);

			runtime.appendCascadeRun({
				filePath: primary,
				result: undefined,
				neighborCount: 0,
				diagnosticCount: 0,
				skipReason: "indeterminate",
				indeterminate: {
					reason: "lsp_binding_rejected",
					detail:
						"cascade fallback diagnostics were withheld — stale snapshot content did not match current disk (binding rejected)",
				},
			});

			await handleTurnEnd({
				ctxCwd: env.tmpDir,
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager,
				knipClient: {
					ensureAvailable: async () => false,
					analyze: async () => EMPTY_KNIP_RESULT,
				},
				deadCodeClients: [],
				depChecker: { ensureAvailable: async () => false },
				testRunnerClient: { getTestRunTarget: () => null },
				resetLSPService: () => {},
				resetFormatService: () => {},
			} as any);

			const findings = consumeTurnEndFindings(cacheManager, env.tmpDir);
			const content = findings?.messages[0]?.content ?? "";
			// HEADLINE (fails pre-#1104): the old hardcoded frame mis-attributed
			// the cause to the review graph for every reason, including this one.
			expect(content).not.toContain("the review graph was unavailable");
			expect(content).toContain("edited.ts");
			expect(content).toContain("binding rejected");
			expect(content).toContain("Advisory — no action required this turn");
		} finally {
			env.cleanup();
		}
	});

	// #5055: an `unresolved_reference` run is a graph that WAS available; only
	// files that name a changed symbol ambiguously were left unplaced. Recurrence:
	// the bucket filter lists the reasons it excludes, so a new reason falls into
	// the "review graph was unavailable" frame (#1104's mis-attribution) unless it
	// is excluded there too.
	it("words an unresolved_reference run as its own cause and logs its reason (#5055)", async () => {
		const env = setupTestEnvironment("cascade-unresolved-reference-");
		try {
			const runtime = new RuntimeCoordinator();
			const cacheManager = new CacheManager(false);
			const primary = path.join(env.tmpDir, "lib.ts");
			fs.writeFileSync(primary, "export const x = 1;\n");
			cacheManager.addModifiedRange(
				primary,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
			);

			runtime.appendCascadeRun({
				filePath: primary,
				result: undefined,
				neighborCount: 0,
				diagnosticCount: 0,
				skipReason: "indeterminate",
				indeterminate: {
					reason: "unresolved_reference",
					detail:
						"2 file(s) reference a changed symbol by name alone, and several definitions share the name: app.ts, other.ts",
					unplacedReferrerCount: 2,
				},
			});

			logCascadeMock.mockClear();
			await handleTurnEnd({
				ctxCwd: env.tmpDir,
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager,
				knipClient: {
					ensureAvailable: async () => false,
					analyze: async () => EMPTY_KNIP_RESULT,
				},
				deadCodeClients: [],
				depChecker: { ensureAvailable: async () => false },
				testRunnerClient: { getTestRunTarget: () => null },
				resetLSPService: () => {},
				resetFormatService: () => {},
			} as any);

			const findings = consumeTurnEndFindings(cacheManager, env.tmpDir);
			const content = findings?.messages[0]?.content ?? "";
			expect(content).not.toContain("the review graph was unavailable");
			expect(content).toContain("lib.ts");
			// The cause and the unplaced files appear once, not in a lead and again
			// in a bullet (#5070 review F6).
			expect(content.split("by name alone")).toHaveLength(2);
			expect(content).toContain("app.ts, other.ts");
			expect(content).toContain("a clean cascade result does not cover them");
			expect(content).toContain("Advisory — no action required this turn");
			const indeterminateLog = logCascadeMock.mock.calls
				.map((args) => args[0])
				.find((entry) => entry?.phase === "cascade_indeterminate");
			expect(indeterminateLog?.metadata?.reasons).toContain(
				"unresolved_reference",
			);
			expect(indeterminateLog?.metadata?.byFile).toEqual([
				expect.objectContaining({ unplacedReferrerCount: 2 }),
			]);
		} finally {
			env.cleanup();
		}
	});

	// #1445: a `missing_node` compute has two causes that read identically to
	// the advisory text but mean opposite things — "the graph genuinely
	// doesn't know this file" versus "this file's role (test, #260) is
	// excluded from the graph BY DESIGN". The latter is expected behavior, not
	// a graph failure, and must not produce the "review graph was unavailable"
	// advisory that mis-attributes the cause to agents (19% of dogfooded
	// cascades in the reporting window were exactly this false alarm on
	// test-file edits against a healthy graph). RED on pre-fix code: before
	// #1445 every `missing_node` — role-excluded or not — fed the same
	// graph-unavailability frame.
	it("does NOT surface a graph-unavailability advisory for a test-file edit excluded by role", async () => {
		const env = setupTestEnvironment("cascade-excluded-by-role-");
		try {
			const runtime = new RuntimeCoordinator();
			const cacheManager = new CacheManager(false);
			const primary = path.join(env.tmpDir, "widget.test.ts");
			fs.writeFileSync(primary, "import './widget';\n");
			cacheManager.addModifiedRange(
				primary,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
			);

			runtime.appendCascadeRun({
				filePath: primary,
				result: undefined,
				neighborCount: 0,
				diagnosticCount: 0,
				skipReason: "indeterminate",
				indeterminate: {
					reason: "excluded_by_role",
					detail:
						"test-role file — excluded from the review graph by design (#260)",
				},
			});

			logCascadeMock.mockClear();
			await handleTurnEnd({
				ctxCwd: env.tmpDir,
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager,
				knipClient: {
					ensureAvailable: async () => false,
					analyze: async () => EMPTY_KNIP_RESULT,
				},
				deadCodeClients: [],
				depChecker: { ensureAvailable: async () => false },
				testRunnerClient: { getTestRunTarget: () => null },
				resetLSPService: () => {},
				resetFormatService: () => {},
			} as any);

			const findings = consumeTurnEndFindings(cacheManager, env.tmpDir);
			const content = findings?.messages[0]?.content ?? "";
			// No wrong-cause advisory reaches the agent at all for this run.
			expect(content).not.toContain(
				"Cascade could not compute downstream impact",
			);
			expect(content).not.toContain("the review graph was unavailable");
			expect(content).not.toContain("widget.test.ts");

			// The distinction is STILL visible in telemetry (info-level, not
			// agent-facing) — cascade_indeterminate logs the real reason so the log
			// can tell an intentional exclusion from a genuine graph gap.
			const indeterminateLog = logCascadeMock.mock.calls
				.map((args) => args[0])
				.find((entry) => entry?.phase === "cascade_indeterminate");
			expect(indeterminateLog?.metadata?.reasons).toContain("excluded_by_role");
		} finally {
			env.cleanup();
		}
	});

	// #1023 over-correction guard: a HEALTHY run that genuinely found no
	// dependents (skipReason "no_neighbors", no indeterminate marker) must NOT
	// emit the advisory — a real clean leaf edit stays silent (no crying wolf).
	it("stays silent for a healthy no_neighbors run (no over-correction)", async () => {
		const env = setupTestEnvironment("cascade-clean-leaf-");
		try {
			const runtime = new RuntimeCoordinator();
			const cacheManager = new CacheManager(false);
			const primary = path.join(env.tmpDir, "leaf.ts");
			fs.writeFileSync(primary, "export const x = 1;\n");
			cacheManager.addModifiedRange(
				primary,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
			);

			runtime.appendCascadeRun({
				filePath: primary,
				result: undefined,
				neighborCount: 0,
				diagnosticCount: 0,
				skipReason: "no_neighbors",
			});

			await handleTurnEnd({
				ctxCwd: env.tmpDir,
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager,
				knipClient: {
					ensureAvailable: async () => false,
					analyze: async () => EMPTY_KNIP_RESULT,
				},
				deadCodeClients: [],
				depChecker: { ensureAvailable: async () => false },
				testRunnerClient: { getTestRunTarget: () => null },
				resetLSPService: () => {},
				resetFormatService: () => {},
			} as any);

			const findings = consumeTurnEndFindings(cacheManager, env.tmpDir);
			const content = findings?.messages[0]?.content ?? "";
			expect(content).not.toContain(
				"Cascade could not compute downstream impact",
			);
		} finally {
			env.cleanup();
		}
	});

	// F2 (adversarial review of #1446): `cascade_injected` had zero test
	// coverage — the whole logCascade block that emits it could be deleted and
	// all targeted tests still passed. Assert the call shape directly, on the
	// SAME `blockerParts`-population path exercised by the dedup test above.
	it("F2: logs cascade_injected with the section's neighbour/diagnostic counts once it reaches blockerParts", async () => {
		const env = setupTestEnvironment("cascade-injected-record-");
		logCascadeMock.mockClear();
		try {
			const runtime = new RuntimeCoordinator();
			const cacheManager = new CacheManager(false);
			const primary = path.join(env.tmpDir, "primary.ts");
			const neighbor = path.join(env.tmpDir, "neighbor.ts");
			fs.writeFileSync(primary, "export const x = 1;\n");
			fs.writeFileSync(neighbor, "import { x } from './primary';\n");
			cacheManager.addModifiedRange(
				primary,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
			);

			runtime.appendCascadeRun({
				filePath: primary,
				result: cascade(primary, neighbor, "injected error"),
				neighborCount: 1,
				diagnosticCount: 1,
			});

			await handleTurnEnd({
				ctxCwd: env.tmpDir,
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager,
				knipClient: {
					ensureAvailable: async () => false,
					analyze: async () => EMPTY_KNIP_RESULT,
				},
				deadCodeClients: [],
				depChecker: { ensureAvailable: async () => false },
				testRunnerClient: { getTestRunTarget: () => null },
				resetLSPService: () => {},
				resetFormatService: () => {},
			} as any);

			// The record fired means the section reached blockerParts — confirm
			// the text was actually queued, the precondition the record proves.
			const content =
				consumeTurnEndFindings(cacheManager, env.tmpDir)?.messages[0]
					?.content ?? "";
			expect(content).toContain("injected error");

			expect(logCascadeMock).toHaveBeenCalledWith(
				expect.objectContaining({
					phase: "cascade_injected",
					neighborCount: 1,
					diagnosticCount: 1,
					metadata: expect.objectContaining({
						sectionChars: expect.any(Number),
						testSuggestionCount: 0,
						suppressedByOwnership: 0,
					}),
				}),
			);
		} finally {
			env.cleanup();
		}
	});

	// F2 (adversarial review of #1446): `cascade_test_targets` had zero test
	// coverage — same as `cascade_injected` above, the whole logCascade block
	// could be deleted with no test noticing. Covers both the "suggestion
	// found" and "zero suggestions" outcomes the record was written to
	// distinguish.
	it("F2: logs cascade_test_targets for both a resolved suggestion and the zero-suggestion case", async () => {
		const env = setupTestEnvironment("cascade-test-targets-record-");
		try {
			const primary = path.join(env.tmpDir, "primary.ts");
			const neighbor = path.join(env.tmpDir, "neighbor.ts");
			const neighborTestFile = path.join(env.tmpDir, "neighbor.test.ts");
			fs.writeFileSync(primary, "export const x = 1;\n");
			fs.writeFileSync(neighbor, "import { x } from './primary';\n");

			const turnEnd = async (testRunnerClient: unknown) => {
				const runtime = new RuntimeCoordinator();
				const cacheManager = new CacheManager(false);
				cacheManager.addModifiedRange(
					primary,
					{ start: 1, end: 1 },
					false,
					env.tmpDir,
				);
				runtime.appendCascadeRun({
					filePath: primary,
					result: cascade(primary, neighbor, "targets error"),
					neighborCount: 1,
					diagnosticCount: 1,
				});
				await handleTurnEnd({
					ctxCwd: env.tmpDir,
					getFlag: () => false,
					dbg: () => {},
					runtime,
					cacheManager,
					knipClient: {
						ensureAvailable: async () => false,
						analyze: async () => EMPTY_KNIP_RESULT,
					},
					deadCodeClients: [],
					depChecker: { ensureAvailable: async () => false },
					testRunnerClient,
					resetLSPService: () => {},
					resetFormatService: () => {},
				} as any);
			};

			// A resolved suggestion.
			logCascadeMock.mockClear();
			await turnEnd({
				getTestRunTarget: () => null,
				suggestTestFiles: () => [
					{
						testFile: neighborTestFile,
						sourceFile: neighbor,
						runner: "vitest",
					},
				],
			});
			expect(logCascadeMock).toHaveBeenCalledWith(
				expect.objectContaining({
					phase: "cascade_test_targets",
					neighborCount: 1,
					metadata: expect.objectContaining({
						neighborFiles: expect.arrayContaining([neighbor]),
						suggestedTestFiles: expect.arrayContaining([neighborTestFile]),
						runner: "vitest",
						zeroSuggestions: false,
					}),
				}),
			);

			// The zero-suggestion outcome — neighbours had errors, but no test
			// file resolved for any of them. Previously logged nothing at all.
			logCascadeMock.mockClear();
			await turnEnd({
				getTestRunTarget: () => null,
				suggestTestFiles: () => [],
			});
			expect(logCascadeMock).toHaveBeenCalledWith(
				expect.objectContaining({
					phase: "cascade_test_targets",
					neighborCount: 1,
					metadata: expect.objectContaining({
						suggestedTestFiles: [],
						zeroSuggestions: true,
					}),
				}),
			);
		} finally {
			env.cleanup();
		}
	});
});

// #1550: the `cascade_indeterminate` record stamped `filePath: files[0] ?? cwd`
// — the turn's FIRST EDITED file — while the indeterminate runs it summarises
// are `cascadeRuns` entries carrying their own `run.filePath`, a disjoint set
// (a run can be carried across turns, #1443, and an edited file can skip the
// graph entirely). Every forensic read of the log therefore blamed the wrong
// file. Two signatures from the dogfood window (2026-08-09 → 08-17, 135 lines):
//
//   13:20:48.511 cascade_skip          docs/tools.md  unsupported_graph_kind (markdown)
//   13:20:48.518 cascade_indeterminate docs/tools.md  reasons:["missing_node"]
//
// A markdown file returns early with `skipReason: "non_code"` and never calls
// computeImpactCascade, so it cannot be the missing_node file — the real one was
// the previous turn's carried `probe-cap.tmp.mjs` run. And:
//
//   13:13:01.546 cascade_indeterminate providers/tokenrouter/tokenrouter.ts reasons:["excluded_by_role"]
//
// `excluded_by_role` is only ever produced for a test-role file, which that
// source path is not. The label, not the verdict, was wrong — which is also why
// the issue read as "concentrated on test files": the first edited file of a
// turn is usually a test.
describe("cascade_indeterminate attribution (#1550)", () => {
	it("names the indeterminate run's own file, not the turn's first edited file", async () => {
		const env = setupTestEnvironment("cascade-indeterminate-attribution-");
		try {
			const runtime = new RuntimeCoordinator();
			const cacheManager = new CacheManager(false);
			// The edited file this turn is markdown — it never reaches the graph.
			const editedDoc = path.join(env.tmpDir, "notes.md");
			fs.writeFileSync(editedDoc, "# notes\n");
			cacheManager.addModifiedRange(
				editedDoc,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
			);
			// The indeterminate run belongs to an entirely different file.
			const orphan = path.join(env.tmpDir, "orphan.mjs");
			fs.writeFileSync(orphan, "export const orphan = 1;\n");
			runtime.appendCascadeRun({
				filePath: orphan,
				result: undefined,
				neighborCount: 0,
				diagnosticCount: 0,
				skipReason: "indeterminate",
				indeterminate: { reason: "missing_node" },
			});

			logCascadeMock.mockClear();
			await handleTurnEnd({
				ctxCwd: env.tmpDir,
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager,
				knipClient: {
					ensureAvailable: async () => false,
					analyze: async () => EMPTY_KNIP_RESULT,
				},
				deadCodeClients: [],
				depChecker: { ensureAvailable: async () => false },
				testRunnerClient: { getTestRunTarget: () => null },
				resetLSPService: () => {},
				resetFormatService: () => {},
			} as any);

			const entry = logCascadeMock.mock.calls
				.map((args) => args[0])
				.find((e) => e?.phase === "cascade_indeterminate");
			expect(entry).toBeDefined();
			// HEADLINE (red pre-fix): the record blamed the edited markdown file.
			expect(entry?.filePath).toContain("orphan.mjs");
			expect(entry?.filePath).not.toContain("notes.md");
			// Each reason is attributed to the file that produced it, so a
			// multi-file turn is diagnosable from the one line.
			expect(entry?.metadata?.byFile).toEqual([
				expect.objectContaining({ file: "orphan.mjs", reason: "missing_node" }),
			]);
		} finally {
			env.cleanup();
		}
	});

	// Class sweep: `cascade_test_targets`, `cascade_injected` and
	// `cascade_turn_end` shared the same `files[0] ?? cwd` label over the same
	// run-derived data. They claim no per-file cause, so one turn-level label is
	// enough — but on a read-only drain turn it degenerated to a bare DIRECTORY.
	it("labels the turn-level cascade records with the merged run's file on a read-only turn", async () => {
		const env = setupTestEnvironment("cascade-turn-end-label-");
		try {
			const runtime = new RuntimeCoordinator();
			const cacheManager = new CacheManager(false);
			const primary = path.join(env.tmpDir, "carried-result.ts");
			const neighbor = path.join(env.tmpDir, "neighbor.ts");
			fs.writeFileSync(primary, "export const carried = 1;\n");
			fs.writeFileSync(neighbor, "export const neighbor = 1;\n");
			// No addModifiedRange — a read-only turn draining a carried run.
			const result = cascade(primary, neighbor, "boom");
			runtime.appendCascadeRun({
				filePath: primary,
				result,
				neighborCount: 1,
				diagnosticCount: 1,
			});

			logCascadeMock.mockClear();
			await handleTurnEnd({
				ctxCwd: env.tmpDir,
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager,
				knipClient: {
					ensureAvailable: async () => false,
					analyze: async () => EMPTY_KNIP_RESULT,
				},
				deadCodeClients: [],
				depChecker: { ensureAvailable: async () => false },
				testRunnerClient: { getTestRunTarget: () => null },
				resetLSPService: () => {},
				resetFormatService: () => {},
			} as any);

			const turnEndEntry = logCascadeMock.mock.calls
				.map((args) => args[0])
				.find((e) => e?.phase === "cascade_turn_end");
			expect(turnEndEntry).toBeDefined();
			// RED pre-fix: `files` is empty, so this was the workspace directory.
			expect(turnEndEntry?.filePath).toContain("carried-result.ts");
		} finally {
			env.cleanup();
		}
	});

	it("attributes a carried run on a read-only turn instead of falling back to cwd", async () => {
		const env = setupTestEnvironment("cascade-indeterminate-readonly-");
		try {
			const runtime = new RuntimeCoordinator();
			const cacheManager = new CacheManager(false);
			// No edited files this turn — `files` is empty, and the pre-fix
			// `files[0] ?? cwd` fallback stamped a bare DIRECTORY as the filePath.
			const orphan = path.join(env.tmpDir, "carried.ts");
			fs.writeFileSync(orphan, "export const carried = 1;\n");
			runtime.appendCascadeRun({
				filePath: orphan,
				result: undefined,
				neighborCount: 0,
				diagnosticCount: 0,
				skipReason: "indeterminate",
				indeterminate: { reason: "missing_node" },
			});

			logCascadeMock.mockClear();
			await handleTurnEnd({
				ctxCwd: env.tmpDir,
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager,
				knipClient: {
					ensureAvailable: async () => false,
					analyze: async () => EMPTY_KNIP_RESULT,
				},
				deadCodeClients: [],
				depChecker: { ensureAvailable: async () => false },
				testRunnerClient: { getTestRunTarget: () => null },
				resetLSPService: () => {},
				resetFormatService: () => {},
			} as any);

			const entry = logCascadeMock.mock.calls
				.map((args) => args[0])
				.find((e) => e?.phase === "cascade_indeterminate");
			expect(entry).toBeDefined();
			expect(entry?.filePath).toContain("carried.ts");
			expect(entry?.metadata?.byFile).toEqual([
				expect.objectContaining({ file: "carried.ts", reason: "missing_node" }),
			]);
		} finally {
			env.cleanup();
		}
	});
});

/**
 * #4485/#4487: what turn_end does with unanswered neighbours, with a
 * neighbour two results of one turn both cover, and with neighbour errors
 * that persist across turns.
 */
describe("cascade delivery at turn_end (#4485, #4487)", () => {
	async function turnEndOf(
		runtime: RuntimeCoordinator,
		cacheManager: CacheManager,
		cwd: string,
	): Promise<string> {
		await handleTurnEnd({
			ctxCwd: cwd,
			getFlag: () => false,
			dbg: () => {},
			runtime,
			cacheManager,
			knipClient: {
				ensureAvailable: async () => false,
				analyze: async () => EMPTY_KNIP_RESULT,
			},
			deadCodeClients: [],
			depChecker: { ensureAvailable: async () => false },
			testRunnerClient: { getTestRunTarget: () => null },
			resetLSPService: () => {},
			resetFormatService: () => {},
		} as any);
		return (
			consumeTurnEndFindings(cacheManager, cwd)?.messages[0]?.content ?? ""
		);
	}

	function edit(cacheManager: CacheManager, file: string, cwd: string): void {
		fs.writeFileSync(file, `export const v = ${Date.now()};\n`);
		cacheManager.addModifiedRange(file, { start: 1, end: 1 }, false, cwd);
	}

	/** A result the way the in-lane compute builds it: its section text and
	 * the layout turn_end re-renders an owned subset with. */
	async function computedResult(
		cwd: string,
		primary: string,
		neighbors: Array<[string, string[]]>,
	): Promise<CascadeResult> {
		const { composeCascadeSection, formatCascadeNeighborDiagnostics } =
			await import("../../clients/cascade-format.js");
		const layout = {
			cwd,
			noun: "neighbor",
			includeReason: true,
			header: `Impact cascade for ${path.basename(primary)}`,
			truncationLine: "",
			coverageLine: "",
			policySuppressed: 0,
		};
		// The neighbours exist on disk, as a real cascade's do: turn_end's
		// pending line checks each recorded file before claiming it (#4487 F1).
		for (const [filePath] of neighbors) {
			if (!fs.existsSync(filePath))
				fs.writeFileSync(filePath, "export const n = 1;\n");
		}
		const rows = neighbors.map(([filePath, messages]) => ({
			filePath,
			reason: "imports" as const,
			diagnostics: messages.map((m, i) => diagnostic(filePath, m, i + 1)),
			lspTouched: true,
		}));
		return {
			filePath: primary,
			impact: {
				filePath: primary,
				changedSymbols: [],
				directImporters: neighbors.map(([p]) => p),
				directCallers: [],
				neighborFiles: neighbors.map(([p]) => p),
				riskFlags: [],
			},
			neighbors: rows,
			formatted: composeCascadeSection(
				formatCascadeNeighborDiagnostics(cwd, rows, {
					noun: "neighbor",
					includeReason: true,
				}),
				layout,
			),
			layout,
		} as CascadeResult;
	}

	function occurrences(text: string, needle: string): number {
		return text.split(needle).length - 1;
	}

	// Recurrence (#4485): 58 real runs whose every neighbour went unanswered
	// reached the agent as nothing at all, the same silence as a clean leaf.
	it("turn_end renders one pending line per server for unconfirmed neighbours, once per turn", async () => {
		const env = setupTestEnvironment("cascade-4485-pending-");
		try {
			const runtime = new RuntimeCoordinator();
			const cacheManager = new CacheManager(false);
			const a = path.join(env.tmpDir, "a.lua");
			const b = path.join(env.tmpDir, "b.lua");
			const [n1, n2, n3] = ["n1.lua", "n2.lua", "n3.lua"].map((f) =>
				path.join(env.tmpDir, f),
			);
			runtime.beginTurn();
			edit(cacheManager, a, env.tmpDir);
			edit(cacheManager, b, env.tmpDir);
			runtime.appendCascadeRun({
				filePath: a,
				result: undefined,
				neighborCount: 0,
				diagnosticCount: 0,
				skipReason: "indeterminate",
				selectedNeighborPaths: [n1, n2],
				unconfirmed: {
					count: 2,
					servers: [
						{ serverId: "lua-language-server", waitMs: 1000, paths: [n1, n2] },
					],
				},
			} as any);
			runtime.appendCascadeRun({
				filePath: b,
				result: undefined,
				neighborCount: 0,
				diagnosticCount: 0,
				skipReason: "indeterminate",
				selectedNeighborPaths: [n3],
				unconfirmed: {
					count: 1,
					servers: [
						{ serverId: "lua-language-server", waitMs: 1000, paths: [n3] },
					],
				},
			} as any);

			logCascadeMock.mockClear();
			const content = await turnEndOf(runtime, cacheManager, env.tmpDir);

			expect(content).toContain(
				"Cascade sent 3 dependent(s) of a.lua, b.lua to lua-language-server, but no answer arrived within 1000 ms; a clean cascade result does not cover them.",
			);
			expect(content).toContain(
				"  • lua-language-server: n1.lua, n2.lua, n3.lua",
			);
			expect(occurrences(content, "no answer arrived")).toBe(1);
			expect(content).toContain("Advisory — no action required this turn");
			const rendered = logCascadeMock.mock.calls
				.map((args) => args[0])
				.filter((e) => e?.phase === "cascade_unconfirmed_rendered");
			expect(rendered).toHaveLength(1);
			expect(rendered[0].metadata).toMatchObject({ servers: 1, paths: 3 });

			// The next turn does not repeat it.
			runtime.beginTurn();
			edit(cacheManager, a, env.tmpDir);
			expect(await turnEndOf(runtime, cacheManager, env.tmpDir)).not.toContain(
				"no answer arrived",
			);
		} finally {
			env.cleanup();
		}
	});

	it("a neighbour a later run of the turn answered drops out of the pending line", async () => {
		const env = setupTestEnvironment("cascade-4485-pending-answered-");
		try {
			const runtime = new RuntimeCoordinator();
			const cacheManager = new CacheManager(false);
			const a = path.join(env.tmpDir, "a.lua");
			const [n1, n2] = ["n1.lua", "n2.lua"].map((f) =>
				path.join(env.tmpDir, f),
			);
			runtime.beginTurn();
			edit(cacheManager, a, env.tmpDir);
			runtime.appendCascadeRun({
				filePath: a,
				result: undefined,
				neighborCount: 0,
				diagnosticCount: 0,
				skipReason: "indeterminate",
				selectedNeighborPaths: [n1, n2],
				unconfirmed: {
					count: 2,
					servers: [
						{ serverId: "lua-language-server", waitMs: 1000, paths: [n1, n2] },
					],
				},
			} as any);
			runtime.appendCascadeRun({
				filePath: a,
				result: undefined,
				neighborCount: 1,
				diagnosticCount: 0,
				skipReason: "clean",
				observedNeighborPaths: [n1],
			} as any);

			const content = await turnEndOf(runtime, cacheManager, env.tmpDir);

			expect(content).toContain(
				"Cascade sent 1 dependent(s) of a.lua to lua-language-server",
			);
			expect(content).toContain("  • lua-language-server: n2.lua");
			expect(content).not.toContain("n1.lua");
		} finally {
			env.cleanup();
		}
	});

	// #5040: the second shape of absence gets its own sentence. A reused pre-edit
	// answer DID arrive, so the #4485 "no answer arrived" wording would be false
	// for it, and one server can hold both shapes in one turn, so the grouping
	// cannot merge them.
	it("turn_end words a pre-edit answer as its own cause, beside the no-answer line for the same server", async () => {
		const env = setupTestEnvironment("cascade-5040-pending-");
		try {
			const runtime = new RuntimeCoordinator();
			const cacheManager = new CacheManager(false);
			const a = path.join(env.tmpDir, "a.ts");
			const preEdit = path.join(env.tmpDir, "pre-edit.ts");
			const silent = path.join(env.tmpDir, "silent.ts");
			runtime.beginTurn();
			edit(cacheManager, a, env.tmpDir);
			runtime.appendCascadeRun({
				filePath: a,
				result: undefined,
				neighborCount: 0,
				diagnosticCount: 0,
				skipReason: "indeterminate",
				selectedNeighborPaths: [preEdit, silent],
				unconfirmed: {
					count: 2,
					servers: [
						{
							serverId: "gopls",
							reason: "pre-edit-answer",
							waitMs: 0,
							paths: [preEdit],
						},
						{
							serverId: "gopls",
							reason: "no-answer",
							waitMs: 1000,
							paths: [silent],
						},
					],
				},
			} as any);

			logCascadeMock.mockClear();
			const content = await turnEndOf(runtime, cacheManager, env.tmpDir);

			// Recurrence: bucketing by cause made `servers` count cause-groups, so
			// one server holding both shapes logged `servers: 2` and a monitor
			// comparing it with `paths` read two populations as one.
			const rendered = logCascadeMock.mock.calls
				.map((args) => args[0])
				.filter((e) => e?.phase === "cascade_unconfirmed_rendered");
			expect(rendered).toHaveLength(1);
			expect(rendered[0].metadata).toMatchObject({
				servers: 1,
				groups: 2,
				paths: 2,
			});
			expect(content).toContain(
				"Cascade asked gopls about 1 dependent(s) of a.ts, but its cached answer predates this edit; a clean cascade result does not cover them.",
			);
			expect(content).toContain(
				"Cascade sent 1 dependent(s) of a.ts to gopls, but no answer arrived within 1000 ms; a clean cascade result does not cover them.",
			);
			expect(content).toContain("  • gopls: pre-edit.ts");
			expect(content).toContain("  • gopls: silent.ts");
			expect(occurrences(content, "predates this edit")).toBe(1);
			expect(occurrences(content, "no answer arrived")).toBe(1);
		} finally {
			env.cleanup();
		}
	});

	// Recurrence (#4487): with the rolling delta gone, a result that owns only
	// some of its neighbours rendered all of them, so a neighbour a later
	// result also covered reached the agent twice in one turn.
	it("a result that owns only some of its neighbours renders only those", async () => {
		const env = setupTestEnvironment("cascade-4487-partial-");
		try {
			const runtime = new RuntimeCoordinator();
			const cacheManager = new CacheManager(false);
			const a = path.join(env.tmpDir, "a.ts");
			const b = path.join(env.tmpDir, "b.ts");
			const n1 = path.join(env.tmpDir, "n1.ts");
			const n2 = path.join(env.tmpDir, "n2.ts");
			runtime.beginTurn();
			edit(cacheManager, a, env.tmpDir);
			edit(cacheManager, b, env.tmpDir);
			runtime.appendCascadeRun({
				filePath: a,
				result: await computedResult(env.tmpDir, a, [
					[n1, ["alpha error"]],
					[n2, ["beta error, earlier state"]],
				]),
				neighborCount: 2,
				diagnosticCount: 2,
			});
			runtime.appendCascadeRun({
				filePath: b,
				result: await computedResult(env.tmpDir, b, [
					[n2, ["beta error, latest state"]],
				]),
				neighborCount: 1,
				diagnosticCount: 1,
			});

			const content = await turnEndOf(runtime, cacheManager, env.tmpDir);

			expect(occurrences(content, "alpha error")).toBe(1);
			expect(occurrences(content, "beta error, latest state")).toBe(1);
			expect(content).not.toContain("beta error, earlier state");
			expect(occurrences(content, 'file="n2.ts"')).toBe(1);
		} finally {
			env.cleanup();
		}
	});

	// Recurrence (#4487): a neighbour error that outlived the edit read as new
	// once, then vanished; the agent could not tell it was still there.
	it("a neighbour error re-observed on a later turn is labelled with the turn it was first delivered", async () => {
		const env = setupTestEnvironment("cascade-4487-label-");
		try {
			const runtime = new RuntimeCoordinator();
			const cacheManager = new CacheManager(false);
			const a = path.join(env.tmpDir, "a.ts");
			const n1 = path.join(env.tmpDir, "n1.ts");
			const runOf = async (messages: string[]) => ({
				filePath: a,
				result: await computedResult(env.tmpDir, a, [[n1, messages]]),
				neighborCount: 1,
				diagnosticCount: messages.length,
				observedNeighborPaths: [n1],
			});

			runtime.beginTurn();
			edit(cacheManager, a, env.tmpDir);
			runtime.appendCascadeRun(await runOf(["persistent error"]));
			const first = await turnEndOf(runtime, cacheManager, env.tmpDir);
			expect(first).toContain("persistent error");
			expect(first).not.toContain("still present");

			runtime.beginTurn();
			edit(cacheManager, a, env.tmpDir);
			runtime.appendCascadeRun(await runOf(["persistent error", "new error"]));
			const second = await turnEndOf(runtime, cacheManager, env.tmpDir);
			expect(second).toContain("persistent error (still present since turn 1)");
			expect(second).toContain("new error");
			expect(second).not.toContain("new error (still present");
			// Re-observed this turn, so the earlier-turn unresolved line does
			// not repeat it (a double report of one error).
			expect(second).not.toContain("not re-checked this turn");
		} finally {
			env.cleanup();
		}
	});

	// Recurrence (#4487): a turn whose cascade did not cover a neighbour with
	// known errors said nothing about it, which reads as resolved.
	it("a pending neighbour error no cascade covered this turn renders one unresolved line until a fresh observation clears it", async () => {
		const env = setupTestEnvironment("cascade-4487-unresolved-");
		try {
			const runtime = new RuntimeCoordinator();
			const cacheManager = new CacheManager(false);
			const a = path.join(env.tmpDir, "a.ts");
			const other = path.join(env.tmpDir, "other.ts");
			const n1 = path.join(env.tmpDir, "n1.ts");

			runtime.beginTurn();
			edit(cacheManager, a, env.tmpDir);
			runtime.appendCascadeRun({
				filePath: a,
				result: await computedResult(env.tmpDir, a, [
					[n1, ["first error", "second error"]],
				]),
				neighborCount: 1,
				diagnosticCount: 2,
				observedNeighborPaths: [n1],
				checkedAt: Date.now(),
			} as any);
			await turnEndOf(runtime, cacheManager, env.tmpDir);

			// Turn 2: an unrelated edit, no cascade covers n1.
			runtime.beginTurn();
			edit(cacheManager, other, env.tmpDir);
			const second = await turnEndOf(runtime, cacheManager, env.tmpDir);
			expect(second).toMatch(/n1\.ts: 2 error\(s\) unresolved \(scanned/);
			expect(occurrences(second, "n1.ts")).toBe(1);

			// Turn 3: a confirmed clean observation of n1.
			runtime.beginTurn();
			edit(cacheManager, a, env.tmpDir);
			runtime.appendCascadeRun({
				filePath: a,
				result: undefined,
				neighborCount: 1,
				diagnosticCount: 0,
				skipReason: "clean",
				observedNeighborPaths: [n1],
			} as any);
			expect(await turnEndOf(runtime, cacheManager, env.tmpDir)).not.toContain(
				"n1.ts",
			);

			// Nothing left pending. #5034 r3: read the record itself; a fourth
			// turn reaches the turn-cycle cap and returns before the cascade merge
			// (`isMaxCyclesExceeded`), so its silence proved nothing.
			const { listCascadePendingNeighbors } =
				await import("../../clients/cascade-format.js");
			expect(listCascadePendingNeighbors()).toEqual([]);
		} finally {
			env.cleanup();
		}
	});

	// #5034 review r3 (F8). Recurrence: a neighbour no primary answered for is
	// listed with its `fallbackFor` alternate's rows (round 2, F2) but is not an
	// observation (no `observedNeighborPaths`). Its delivery REPLACED the
	// primary's pending record with the fallback's rows, and the listing hid the
	// record's unresolved line; a clean fallback answer then left the record
	// silent with no way to clear it. Delivery must neither drop nor pin it.
	// Three turns per cell: a fourth reaches the turn-cycle cap and returns
	// before the cascade merge (`isMaxCyclesExceeded`).
	it.each([
		["with a finding of its own", ["fallback finding"]],
		["clean", []],
	])(
		"a fallback-served neighbour answering %s neither replaces nor hides the primary's pending errors (#5034 F8)",
		async (_label, fallbackRows) => {
			const env = setupTestEnvironment("cascade-5034-f8-");
			try {
				const { cascadeStillPresentSince, listCascadePendingNeighbors } =
					await import("../../clients/cascade-format.js");
				const runtime = new RuntimeCoordinator();
				const cacheManager = new CacheManager(false);
				const a = path.join(env.tmpDir, "a.py");
				const n1 = path.join(env.tmpDir, "n1.py");
				const primaryError = diagnostic(n1, "primary error", 1);
				const pending = () =>
					listCascadePendingNeighbors().map((e) => e.errorCount);

				// Turn 1: the primary answers and shows its error.
				runtime.beginTurn();
				edit(cacheManager, a, env.tmpDir);
				runtime.appendCascadeRun({
					filePath: a,
					result: await computedResult(env.tmpDir, a, [
						[n1, ["primary error"]],
					]),
					neighborCount: 1,
					diagnosticCount: 1,
					observedNeighborPaths: [n1],
					checkedAt: Date.now(),
				} as any);
				expect(await turnEndOf(runtime, cacheManager, env.tmpDir)).toContain(
					"primary error",
				);
				expect(pending()).toEqual([1]);

				// Turn 2: only the fallback answers. It confirms nothing (#5014),
				// so the primary's error stays pending, unchanged, and named.
				runtime.beginTurn();
				edit(cacheManager, a, env.tmpDir);
				const result = await computedResult(env.tmpDir, a, [
					[n1, fallbackRows],
				]);
				result.neighbors[0].primaryUnavailable = {
					serverIds: ["python"],
					cause: "unstarted",
				};
				runtime.appendCascadeRun({
					filePath: a,
					result,
					neighborCount: 1,
					diagnosticCount: fallbackRows.length,
					checkedAt: Date.now(),
				} as any);
				const second = await turnEndOf(runtime, cacheManager, env.tmpDir);
				for (const row of fallbackRows) expect(second).toContain(row);
				expect(second).toMatch(/n1\.py: 1 error\(s\) unresolved/);
				expect(cascadeStillPresentSince(n1, primaryError, 99)).toBe(1);
				expect(pending()).toEqual([1]);

				// Turn 3: the primary answers clean, which clears it.
				runtime.beginTurn();
				edit(cacheManager, a, env.tmpDir);
				runtime.appendCascadeRun({
					filePath: a,
					result: undefined,
					neighborCount: 1,
					diagnosticCount: 0,
					skipReason: "clean",
					observedNeighborPaths: [n1],
				} as any);
				expect(
					await turnEndOf(runtime, cacheManager, env.tmpDir),
				).not.toContain("n1.py");
				expect(pending()).toEqual([]);
			} finally {
				env.cleanup();
			}
		},
	);

	// Recurrence (#4689 review r1 F5): a cascade names its neighbours by path
	// identity (review-graph keys) while turn_end holds the session root as
	// spelled, so under a root reached through a link the pending line's
	// containment filter read every neighbour as outside the project and the
	// unresolved errors went silent, which reads as fixed.
	it("a pending neighbour keyed by identity still renders under a session root spelled through a link", async (ctx) => {
		const env = setupTestEnvironment("cascade-4689-alias-");
		try {
			const real = path.join(env.tmpDir, "repo");
			const alias = path.join(env.tmpDir, "repo-alias");
			fs.mkdirSync(real);
			try {
				fs.symlinkSync("repo", alias, "dir");
			} catch (error) {
				return ctx.skip(`symlinks unavailable: ${String(error)}`);
			}
			const runtime = new RuntimeCoordinator();
			const cacheManager = new CacheManager(false);
			const a = path.join(alias, "a.ts");
			const other = path.join(alias, "other.ts");
			const n1 = path.join(fs.realpathSync.native(real), "n1.ts");

			runtime.beginTurn();
			edit(cacheManager, a, alias);
			runtime.appendCascadeRun({
				filePath: a,
				result: await computedResult(alias, a, [[n1, ["first error"]]]),
				neighborCount: 1,
				diagnosticCount: 1,
				observedNeighborPaths: [n1],
				checkedAt: Date.now(),
			} as any);
			await turnEndOf(runtime, cacheManager, alias);

			runtime.beginTurn();
			edit(cacheManager, other, alias);
			const second = await turnEndOf(runtime, cacheManager, alias);
			expect(second).toMatch(/n1\.ts: 1 error\(s\) unresolved \(scanned/);
		} finally {
			env.cleanup();
		}
	});

	// Recurrence (#4495 review F1, round-2 verify R2-1/R2-2/R2-3): the 📐 line
	// said "2 error(s) unresolved" for a neighbour fixed by a write pi never
	// saw, every edit turn until a cascade covered it (r1; and r2 again when
	// the write landed between the compute and turn_end, because the record
	// was stamped at delivery). Round 2 then dropped a changed neighbour in
	// silence, which reads as resolved even when the error is still there.
	describe("a pending neighbour whose file changed since its errors were checked", () => {
		async function deliverN1Errors(
			runtime: RuntimeCoordinator,
			cacheManager: CacheManager,
			cwd: string,
			options: {
				checkedAt?: number;
				beforeTurnEnd?: (n1: string) => void;
			} = { checkedAt: Date.now() },
		): Promise<string> {
			const a = path.join(cwd, "a.ts");
			const n1 = path.join(cwd, "n1.ts");
			runtime.beginTurn();
			edit(cacheManager, a, cwd);
			runtime.appendCascadeRun({
				filePath: a,
				result: await computedResult(cwd, a, [
					[n1, ["first error", "second error"]],
				]),
				neighborCount: 1,
				diagnosticCount: 2,
				observedNeighborPaths: [n1],
				...(options.checkedAt !== undefined && {
					checkedAt: options.checkedAt,
				}),
			} as any);
			options.beforeTurnEnd?.(n1);
			const first = await turnEndOf(runtime, cacheManager, cwd);
			expect(first).toContain("first error");
			return n1;
		}

		async function nextTurn(
			runtime: RuntimeCoordinator,
			cacheManager: CacheManager,
			cwd: string,
		): Promise<string> {
			runtime.beginTurn();
			edit(cacheManager, path.join(cwd, "other.ts"), cwd);
			return turnEndOf(runtime, cacheManager, cwd);
		}

		async function pendingPaths(): Promise<string[]> {
			const { listCascadePendingNeighbors } =
				await import("../../clients/cascade-format.js");
			return listCascadePendingNeighbors().map((e) => e.filePath);
		}

		function gatedRows() {
			return logCascadeMock.mock.calls
				.map((c) => c[0] as { phase: string; metadata?: any })
				.filter((e) => e.phase === "cascade_pending_gated");
		}

		// #4597: the sibling record of `cascade_pending_gated` on the block that
		// reaches the model. #4495 named it and no test read it back, so a rename
		// or a dropped emission kept the whole suite green.
		function renderedRows() {
			return logCascadeMock.mock.calls
				.map((c) => c[0] as { phase: string; metadata?: any })
				.filter((e) => e.phase === "cascade_pending_rendered");
		}

		function sharedGateRows() {
			return logLatencyMock.mock.calls
				.map((c) => c[0] as { phase?: string; metadata?: any })
				.filter(
					(e) =>
						(e.phase === "finding_stale_line_demote" ||
							e.phase === "finding_dead_path_drop") &&
						String(e.metadata?.store ?? "").includes(
							"cascade-pending-neighbors",
						),
				);
		}

		const CHANGED =
			/n1\.ts: 2 error\(s\) changed since checked \(scanned [^)]*\), not re-checked/;

		it("an outside touch that keeps the error names it once as changed, then says nothing", async () => {
			const env = setupTestEnvironment("cascade-4495-touch-");
			try {
				const runtime = new RuntimeCoordinator();
				const cacheManager = new CacheManager(false);
				const n1 = await deliverN1Errors(runtime, cacheManager, env.tmpDir);
				// Same bytes, so the error is still real; only the mtime moved,
				// past the check by more than the gate's 50 ms drift tolerance.
				const later = new Date(Date.now() + 10_000);
				fs.utimesSync(n1, later, later);
				logCascadeMock.mockClear();
				logLatencyMock.mockClear();

				const second = await nextTurn(runtime, cacheManager, env.tmpDir);
				expect(second).toMatch(CHANGED);
				expect(second).not.toContain("unresolved");
				expect(occurrences(second, "n1.ts")).toBe(1);
				expect(await pendingPaths()).toEqual([]);
				expect(gatedRows()).toEqual([
					expect.objectContaining({
						metadata: expect.objectContaining({ changed: 1, deleted: 0 }),
					}),
				]);
				expect(sharedGateRows()).toEqual([]);
				// #4597: the block that reached the model is the record of the
				// delivery, so it says how many neighbours it named.
				expect(renderedRows()).toEqual([
					expect.objectContaining({
						metadata: expect.objectContaining({
							neighbors: 0,
							shown: 0,
							changed: 1,
						}),
					}),
				]);

				const third = await nextTurn(runtime, cacheManager, env.tmpDir);
				expect(third).not.toContain("n1.ts");
				// Nothing is left to render, so the row is not repeated.
				expect(renderedRows()).toHaveLength(1);
			} finally {
				env.cleanup();
			}
		});

		it("an outside fix after the compute read and before turn_end is not left unresolved", async () => {
			const env = setupTestEnvironment("cascade-4495-midturn-");
			try {
				const runtime = new RuntimeCoordinator();
				const cacheManager = new CacheManager(false);
				// The compute read n1 two seconds ago; 300 ms later something pi
				// never saw rewrote it clean, still before this turn_end.
				const checkedAt = Date.now() - 2_000;
				await deliverN1Errors(runtime, cacheManager, env.tmpDir, {
					checkedAt,
					beforeTurnEnd: (n1) => {
						fs.writeFileSync(n1, "export const n = 2;\n");
						const fixedAt = new Date(checkedAt + 300);
						fs.utimesSync(n1, fixedAt, fixedAt);
					},
				});

				const second = await nextTurn(runtime, cacheManager, env.tmpDir);
				expect(second).not.toContain("unresolved");
				expect(second).toMatch(CHANGED);
				const third = await nextTurn(runtime, cacheManager, env.tmpDir);
				expect(third).not.toContain("n1.ts");
				expect(await pendingPaths()).toEqual([]);
			} finally {
				env.cleanup();
			}
		});

		it("is forgotten without a line when deleted", async () => {
			const env = setupTestEnvironment("cascade-4487-deleted-");
			try {
				const runtime = new RuntimeCoordinator();
				const cacheManager = new CacheManager(false);
				const n1 = await deliverN1Errors(runtime, cacheManager, env.tmpDir);
				fs.rmSync(n1);
				logCascadeMock.mockClear();
				logLatencyMock.mockClear();

				const second = await nextTurn(runtime, cacheManager, env.tmpDir);
				expect(second).not.toContain("n1.ts");
				expect(await pendingPaths()).toEqual([]);
				expect(gatedRows()).toEqual([
					expect.objectContaining({
						metadata: expect.objectContaining({ changed: 0, deleted: 1 }),
					}),
				]);
				expect(sharedGateRows()).toEqual([]);
			} finally {
				env.cleanup();
			}
		});

		// Recurrence (#4495 round-2 verify R2-1, late-answer arm): a late
		// answer's run was stamped with its publish time, so a write between
		// the touch and that publish passed as unchanged and the errors stayed
		// "unresolved". The run's read bound is the touch's pre-notify stamp.
		it("a late answer's errors, written over between the touch and the publish, are named as changed", async () => {
			const env = setupTestEnvironment("cascade-4495-late-touch-");
			try {
				const { buildResolvedFoundCascadeRun } =
					await import("../../clients/cascade-format.js");
				const runtime = new RuntimeCoordinator();
				const cacheManager = new CacheManager(false);
				const n1 = path.join(env.tmpDir, "n1.ts");
				const touchedAt = Date.now() - 2_000;
				fs.writeFileSync(n1, "export const n = 2;\n");
				const writtenAt = new Date(touchedAt + 300);
				fs.utimesSync(n1, writtenAt, writtenAt);
				const run = buildResolvedFoundCascadeRun(env.tmpDir, {
					filePath: n1,
					diagnostics: [
						{
							severity: 1,
							message: "late error",
							range: {
								start: { line: 0, character: 0 },
								end: { line: 0, character: 1 },
							},
						},
					] as never,
					publishedAt: touchedAt + 1_000,
					touchedAt,
				});
				expect(run?.checkedAt).toBe(touchedAt);
				expect(run?.observedAt).toBe(touchedAt + 1_000);
				runtime.beginTurn();
				edit(cacheManager, path.join(env.tmpDir, "a.ts"), env.tmpDir);
				if (run) runtime.appendCascadeRun(run);
				expect(await turnEndOf(runtime, cacheManager, env.tmpDir)).toContain(
					"late error",
				);

				const second = await nextTurn(runtime, cacheManager, env.tmpDir);
				expect(second).not.toContain("unresolved");
				expect(second).toMatch(/n1\.ts: 1 error\(s\) changed since checked/);
			} finally {
				env.cleanup();
			}
		});

		// Recurrence (the derived rule's fallback): a run that carries no read
		// time must not be stamped "now" at delivery, the R2-1 shape; it can
		// never pass as unchanged.
		it("an entry from a run with no read time is named as changed, never as unresolved", async () => {
			const env = setupTestEnvironment("cascade-4495-unstamped-");
			try {
				const runtime = new RuntimeCoordinator();
				const cacheManager = new CacheManager(false);
				await deliverN1Errors(runtime, cacheManager, env.tmpDir, {});
				const second = await nextTurn(runtime, cacheManager, env.tmpDir);
				expect(second).not.toContain("unresolved");
				expect(second).toMatch(
					/n1\.ts: 2 error\(s\) changed since checked \(scan age unknown\)/,
				);
			} finally {
				env.cleanup();
			}
		});

		// Recurrence (round-2 verify, R2-1 secondary): a clean publish that
		// landed between the read and the delivery was refused, because the
		// record's stamp was the delivery time.
		it("a late clean published after the read but before the delivery clears the entry", async () => {
			const env = setupTestEnvironment("cascade-4495-lateclean-");
			try {
				const runtime = new RuntimeCoordinator();
				const cacheManager = new CacheManager(false);
				const checkedAt = Date.now() - 2_000;
				const n1 = await deliverN1Errors(runtime, cacheManager, env.tmpDir, {
					checkedAt,
				});
				const { forgetCascadePendingNeighbor } =
					await import("../../clients/cascade-format.js");
				forgetCascadePendingNeighbor(n1, checkedAt);
				expect(await pendingPaths()).toEqual([n1]);
				forgetCascadePendingNeighbor(n1, checkedAt + 100);
				expect(await pendingPaths()).toEqual([]);
			} finally {
				env.cleanup();
			}
		});
	});

	// Recurrence: one process serves more than one root (an MCP session over
	// two projects, a secondary activation), and the pending record is
	// process-wide; one root's neighbour errors must not reach another's turn.
	it("a pending neighbour error outside the turn's root is not rendered", async () => {
		const env = setupTestEnvironment("cascade-4487-root-");
		const elsewhere = setupTestEnvironment("cascade-4487-elsewhere-");
		try {
			const { recordDeliveredCascadeNeighbor } =
				await import("../../clients/cascade-format.js");
			const inside = path.join(env.tmpDir, "inside.ts");
			const outside = path.join(elsewhere.tmpDir, "outside.ts");
			const error = (filePath: string) =>
				({
					id: "typescript:2322",
					message: "pending error",
					filePath,
					line: 1,
					column: 1,
					severity: "error",
					semantic: "blocking",
					tool: "lsp",
				}) as Diagnostic;
			fs.writeFileSync(inside, "export const n = 1;\n");
			recordDeliveredCascadeNeighbor(inside, [error(inside)], 1, Date.now());
			recordDeliveredCascadeNeighbor(outside, [error(outside)], 1, Date.now());

			const runtime = new RuntimeCoordinator();
			const cacheManager = new CacheManager(false);
			runtime.beginTurn();
			edit(cacheManager, path.join(env.tmpDir, "a.ts"), env.tmpDir);
			const text = await turnEndOf(runtime, cacheManager, env.tmpDir);
			expect(text).toMatch(/inside\.ts: 1 error\(s\) unresolved/);
			expect(text).not.toContain("outside.ts");
		} finally {
			env.cleanup();
			elsewhere.cleanup();
		}
	});

	it("an edited neighbour's pending errors are left to its own dispatch", async () => {
		const env = setupTestEnvironment("cascade-4487-edited-");
		try {
			const runtime = new RuntimeCoordinator();
			const cacheManager = new CacheManager(false);
			const a = path.join(env.tmpDir, "a.ts");
			const n1 = path.join(env.tmpDir, "n1.ts");
			runtime.beginTurn();
			edit(cacheManager, a, env.tmpDir);
			runtime.appendCascadeRun({
				filePath: a,
				result: await computedResult(env.tmpDir, a, [[n1, ["n1 error"]]]),
				neighborCount: 1,
				diagnosticCount: 1,
				observedNeighborPaths: [n1],
			} as any);
			await turnEndOf(runtime, cacheManager, env.tmpDir);

			runtime.beginTurn();
			edit(cacheManager, n1, env.tmpDir);
			expect(await turnEndOf(runtime, cacheManager, env.tmpDir)).not.toContain(
				"unresolved",
			);
			runtime.beginTurn();
			edit(cacheManager, a, env.tmpDir);
			expect(await turnEndOf(runtime, cacheManager, env.tmpDir)).not.toContain(
				"unresolved",
			);
		} finally {
			env.cleanup();
		}
	});

	// Recurrence (#4495 round 3 table, timing B): a run read n1's errors,
	// then pi edited n1 in the same turn. n1's own dispatch reports it, the
	// rule the record states for edited files, yet round 2 recorded the
	// run's pre-edit errors, to be re-served on later turns.
	it("a neighbour pi edits in the same turn as the run that saw its errors is not recorded", async () => {
		const env = setupTestEnvironment("cascade-4495-edited-same-turn-");
		try {
			const runtime = new RuntimeCoordinator();
			const cacheManager = new CacheManager(false);
			const a = path.join(env.tmpDir, "a.ts");
			const n1 = path.join(env.tmpDir, "n1.ts");
			runtime.beginTurn();
			edit(cacheManager, a, env.tmpDir);
			runtime.appendCascadeRun({
				filePath: a,
				result: await computedResult(env.tmpDir, a, [[n1, ["n1 error"]]]),
				neighborCount: 1,
				diagnosticCount: 1,
				observedNeighborPaths: [n1],
				checkedAt: Date.now(),
			} as any);
			edit(cacheManager, n1, env.tmpDir);
			await turnEndOf(runtime, cacheManager, env.tmpDir);
			const { listCascadePendingNeighbors } =
				await import("../../clients/cascade-format.js");
			expect(listCascadePendingNeighbors()).toEqual([]);
		} finally {
			env.cleanup();
		}
	});

	// Recurrence (#4485): an answer that landed between the compute and
	// turn_end waited for a quiet window that mostly never came.
	it("turn_end peeks the outstanding touches after its settle and delivers a late answer", async () => {
		const env = setupTestEnvironment("cascade-4485-peek-");
		const tier = await import("../../clients/lsp/cascade-tier.js");
		const { buildResolvedFoundCascadeRun } =
			await import("../../clients/cascade-format.js");
		const { normalizeMapKey } = await import("../../clients/path-utils.js");
		tier._resetOutstandingCascadeTouchesForTests();
		tier._resetCascadeTierReconcileRegistrationForTests();
		try {
			const runtime = new RuntimeCoordinator();
			const cacheManager = new CacheManager(false);
			const a = path.join(env.tmpDir, "a.ts");
			const n1 = path.join(env.tmpDir, "n1.ts");
			fs.writeFileSync(n1, "import { v } from './a';\n");
			// What index.ts wires.
			tier.registerCascadeTierReconcileTask(
				() => ({ getWarmClientForFile: async () => undefined }) as any,
				{
					onResolvedFound: (neighbor) => {
						const run = buildResolvedFoundCascadeRun(env.tmpDir, neighbor);
						if (run) runtime.appendCascadeRun(run);
					},
				},
			);
			const touchedAt = Date.now() - 100;
			const client = {
				serverId: "typescript",
				isAlive: () => true,
				getAllDiagnostics: () =>
					new Map([
						[
							normalizeMapKey(n1),
							{
								ts: touchedAt + 50,
								diags: [
									{
										severity: 1,
										message: "answer after the compute",
										range: {
											start: { line: 0, character: 0 },
											end: { line: 0, character: 1 },
										},
									},
								],
							},
						],
					]),
			};
			tier.recordOutstandingCascadeTouch({
				filePath: n1,
				serverId: "typescript",
				touchedAt,
				client: new WeakRef(client),
			} as any);

			runtime.beginTurn();
			edit(cacheManager, a, env.tmpDir);
			const content = await turnEndOf(runtime, cacheManager, env.tmpDir);

			expect(content).toContain("answer after the compute");
			expect(tier._getOutstandingCascadeTouchesForTests()).toEqual([]);
		} finally {
			tier._resetOutstandingCascadeTouchesForTests();
			tier._resetCascadeTierReconcileRegistrationForTests();
			env.cleanup();
		}
	});
});
