import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
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
