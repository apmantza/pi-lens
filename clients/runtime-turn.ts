import * as fs from "node:fs";
import * as path from "node:path";
import {
	type ActionableWarningsReport,
	type ActionableWarningsAdvisoryFilterResult,
	buildActionableWarningsReport,
	formatActionableWarningsAdvisory,
	publishActionableWarningsReport,
	writeDeferredActionableWarningsReport,
} from "./actionable-warnings.js";
import { logActionableWarningsEvent } from "./actionable-warnings-logger.js";
import {
	appendCodeQualityWarningsHistory,
	buildCodeQualityWarningsReport,
	type CodeQualityWarningRecord,
	formatCodeQualityWarningsAdvisory,
	writeCodeQualityWarningsReport,
} from "./code-quality-warnings.js";
import type { CacheEntry, CacheManager } from "./cache-manager.js";
import type { CascadeSkipReason } from "./cascade-types.js";
import {
	clearGitGuardTestFailure,
	mergeGitGuardTestFailure,
	resyncGitGuardAfterInlinePolicy,
	writeGitGuardRecord,
	type TurnEndFindingsCache,
} from "./git-guard.js";
import { cascadeSettleWaitMs } from "./cascade-budget.js";
import { logCascade } from "./cascade-logger.js";
import { normalizeMapKey } from "./path-utils.js";
import { compareOrdinal } from "./string-utils.js";
import type {
	DependencyChecker,
	MadgeBatchStats,
} from "./dependency-checker.js";
import {
	resolveRunnerPath,
	toRunnerDisplayPath,
} from "./dispatch/runner-context.js";
import { getKnipIgnorePatterns } from "./file-utils.js";
import { formatCacheAgeLabel } from "./finding-delivery-gate.js";
import {
	getFullScanWallClockMs,
	isWorkspaceSweepActive,
	runWhenWorkspaceSweepIdle,
	SWEEP_IDLE_SAFETY_MARGIN_MS,
} from "./lsp/workspace-sweep-hold.js";
import { isTestRoleCollateral } from "./collateral-test-role.js";
import type { TrivyResult } from "./trivy-client.js";
import { isSecretWarning, secretLocationKey } from "./secret-findings.js";
import { govulncheckLane } from "./turn-end/lanes/govulncheck.js";
import { secretsLane } from "./turn-end/lanes/secrets.js";
import {
	type ComposedPart,
	type DeliveryHold,
	planDeliveryHolds,
	stillReportedParked,
} from "./turn-end/delivery-holds.js";
import type { TurnEndLaneContext } from "./turn-end/lane.js";
import { isHardFailureSummary } from "./hard-failure-summary.js";
import type { KnipClient, KnipIssue, KnipResult } from "./knip-client.js";
import {
	MAX_KNIP_ROOTS_PER_TURN,
	resolveKnipScanRoots,
} from "./knip-scan-roots.js";
import type {
	DeadCodeClient,
	DeadCodeIssue,
	DeadCodeResult,
} from "./dead-code-client.js";
import {
	DEAD_CODE_DELTA_MAX_SHOWN,
	deadCodeIssueKey,
	deadCodeIssues,
	formatDeadCodeDelta,
	stableFindingKey,
} from "./dead-code-client.js";
import { logDeadCodeScan } from "./dead-code-logger.js";
import { type SessionScope, scopeCell } from "./session-scope.js";
import {
	PROJECT_DIAGNOSTICS_CACHE_VERSION,
	writeProjectDiagnosticsDeltaReport,
} from "./project-diagnostics/cache.js";
import { deadCodeIssueToProjectDiagnostic } from "./project-diagnostics/runner-adapters/dead-code.js";
import { trivyFindingToProjectDiagnostic } from "./project-diagnostics/runner-adapters/trivy.js";
import { knipIssuesToProjectDiagnostics } from "./project-diagnostics/runner-adapters/knip.js";
import type { ProjectDiagnostic } from "./project-diagnostics/types.js";
import { hasAmbientPythonEnvironment } from "./python-environment.js";
import { logLatency } from "./latency-logger.js";
import {
	getLspBudgetIdleTimeoutMs,
	shouldShortenLspIdleTimeout,
} from "./lsp-budget.js";
import { updateHeartbeat } from "./instance-registry.js";
import { emitLensTurnFindings } from "./lens-events.js";
import { RUNTIME_CONFIG } from "./runtime-config.js";
import { isSubagentSession } from "./subagent-mode.js";
import type {
	ResolvedBlockerFile,
	RuntimeCoordinator,
} from "./runtime-coordinator.js";
import type { TurnStateOwner } from "./cache-manager.js";
import type { LensToolHost } from "./tool-config.js";
import { formatRunDurationMs } from "./run-duration.js";
import {
	isExcludedTestTarget,
	isRunnerErrorResult,
	RUNNERS,
	type TestResult,
	type TestRunnerClient,
} from "./test-runner-client.js";
import { createTurnEndTestRoots } from "./test-target-roots.js";
import {
	MAX_ADVISORY_AFFECTED_FILES,
	gateFindingsByPathFreshness,
	snapshotAdvisoryProvenance,
} from "./advisory-provenance.js";
import {
	DEPENDENCY_DRIFT_MAX_DELIVERIES,
	sweepInlineBlockerFreshness,
} from "./blocker-freshness.js";
import { sweepInlineBlockerPastEof } from "./blocker-past-eof.js";
// #2001/#2002: collect-later delivery for slow auxiliary LSP servers.
import { getLSPService } from "./lsp/index.js";
import {
	drainPendingAuxCapEvictedCount,
	drainPendingAuxiliaryCoverage,
	isAuxBacklogPublished,
	isPendingAuxiliaryPastRearmTtl,
	rearmPendingAuxiliaryCoverage,
	MAX_LATE_AUX_REARMS,
	pendingAuxiliaryCoverageSize,
	canRearmPendingAuxiliary,
} from "./lsp/pending-aux-coverage.js";
import type { LSPDiagnostic } from "./lsp/client.js";
import { convertLspDiagnostics } from "./dispatch/utils/lsp-diagnostics.js";
import { retagAuxiliaryDiagnostics } from "./dispatch/auxiliary-lsp.js";
import { findingsResult, hasUsableResult } from "./dispatch/types.js";
import {
	type PersistentReverifyResult,
	runPersistentReverify,
} from "./persistent-reverify.js";
import { cascadeCarrySuffix } from "./cascade-format.js";
import {
	applyPushedFindingPolicy,
	filterFindingsByDisposition,
} from "./dispatch/finding-policy.js";
import { detectFileRole } from "./file-role.js";
import {
	judgeDeferredRunnerFindings,
	recordDeferredRunnerBlockers,
} from "./deferred-runner-blockers.js";
import {
	applyInlineBlockerPolicy,
	type InlineBlockerPolicyTallyEntry,
	summarizeInlineBlockerPolicy,
} from "./inline-blocker-dispositions.js";
import {
	drainPendingRunnerFindings,
	dropStaleRunnerFindings,
	pendingRunnerFindingsSize,
	requeueRunnerFindings,
} from "./dispatch/pending-runner-findings.js";
// #1631 review V2: moved to its own leaf module so a low-level store
// (widget-state.ts) can use the marker without importing this orchestrator —
// see clients/stale-marker.ts's doc comment.
import {
	incrementDegradationCount,
	recordDegradationOnce,
} from "./degradation-ledger.js";
import { mapWithConcurrency } from "./map-with-concurrency.js";
import { getAmbientAbortSignal } from "./safe-spawn.js";
import { emitBounded } from "./bounded-telemetry.js";
import {
	degradeDemotedFindingBody,
	formatDeliveryCapNote,
	formatRetirementNote,
} from "./demoted-finding-render.js";
import { STALE_LINE_MARKER } from "./stale-marker.js";
import { getActiveSessionId } from "./session-lifecycle.js";
import { bounded } from "./deadline-utils.js";
import { HOOK_WALL_BUDGET_MS } from "./hook-budgets.js";

import {
	drainRenderedDependencyDriftFilePaths,
	getWidgetBlockingFilesForSweep,
	incrementWidgetDependencyDriftDelivery,
	markWidgetFileBlockersStale,
	recordRunner,
	retireWidgetDependencyDriftBlockers,
} from "./widget-state.js";
import type {
	DeferredTestTarget,
	TestRunnerFindingsCache,
} from "./project-diagnostics/runner-adapters/runner-findings.js";

/** Maximum detailed notify-stall coverage-gap rows emitted in one turn. */
const LATE_AUX_COVERAGE_GAP_DETAIL_CAP_PER_TURN = 20;

/**
 * #2504 — bounds on the per-turn test-runner fan-out.
 *
 * The reported turn fired 59 `vitest.cmd` spawns at once from a bare
 * `Promise.allSettled(targets.map(...))`. Each spawn carries its OWN 60 s
 * timeout (`test-runner-client.ts`), which bounds one target and says nothing
 * about the batch: 59 of them starved the event loop for the whole turn
 * (`cpuCoverageRatio 0.56`, 20 orphan-backstop escalations inside the storm).
 *
 * Three separate bounds, because they fail differently:
 *  - CONCURRENCY caps how much CPU the batch can hold at one instant;
 *  - TARGET COUNT caps how much work one turn may enqueue at all;
 *  - the WALL BUDGET caps how long the batch may keep spawning, and is raced
 *    against the ambient abort signal so a cancelled turn stops dispatching
 *    immediately rather than at the next natural boundary.
 *
 * #2522: the batch budget shipped at 90 s in #2509 — well over the turn
 * itself, so a slow/hung batch could still hold up the agent for most of a
 * turn before the bound even engaged. Reconciled down to 20 s (one constant,
 * not a second budget alongside it): well under the turn, and still an order
 * of magnitude below the PER-TARGET 60 s cap in `test-runner-client.ts`, so
 * the batch bound is the one that actually fires first for a stuck target.
 *
 * #2522 review round 2: lowering the budget on its own made things WORSE,
 * because the "deferred to the next turn" this comment used to claim did not
 * exist. `runTestTargetsBounded` returned a skipped COUNT and threw the
 * identity of the unrun targets away, so a target slower than the budget
 * produced no result, no cache record and no output — every turn, forever —
 * while a PARTIAL batch fell through to the clean branch and was reported as
 * "all tests passed". The deferral is now a real mechanism:
 *
 *  - the batch owns an `AbortController` that is handed to each target's spawn
 *    (`TestRunRequest.signal` → `safeSpawnAsync`), so reaching the bound KILLS
 *    what is in flight instead of leaving it to burn its own 60 s timeout and
 *    then mutate a results array the caller has already consumed;
 *  - the killed set plus the never-dispatched set is returned BY IDENTITY as
 *    `deferred`, persisted on the `test-runner-findings` record as
 *    `deferredTargets`, and dispatched FIRST on the next turn — ahead of
 *    failed-first/related/self — under the same `TEST_RUNNER_MAX_TARGETS` cap;
 *  - a batch whose `deferred` set is non-empty can never take the clean
 *    branch, so an unfinished run is never reported as a green one and never
 *    relaxes the `--lens-guard` commit gate.
 */
export const TEST_RUNNER_BATCH_CONCURRENCY = 4;
export const TEST_RUNNER_MAX_TARGETS = 12;
/** #3871: owning-checkout rows one `turn_end_test_selection` record carries; the rest are counted in `rootsOmitted`. */
const TURN_END_SELECTION_ROOT_ROWS = 8;
export const TEST_RUNNER_BATCH_BUDGET_MS = 20_000;
/**
 * How many consecutive turn-end batches a target may be cut out of before it
 * is retired from turn-end selection altogether.
 *
 * Without this the deferral is a LIVELOCK, and not hypothetically: this
 * repo's own `tests/index-integration.test.ts` — which turn-end resolves
 * through the `related` strategy whenever `clients/runtime-turn.ts` is
 * edited — takes 26.4 s, MORE than the entire 20 s batch budget on its own.
 * Deferring it puts it FIRST in the next batch, where it is cut again at
 * 20 s, and again, every turn, forever. A target that cannot fit the budget
 * is not a scheduling problem retrying can solve; it is reported once per
 * occurrence and dropped, so the turn stops paying 20 s for it.
 */
export const TEST_RUNNER_MAX_DEFERRALS = 2;

/**
 * Ceiling on how many entries either persisted target list may carry.
 *
 * #2522 review round 4, I1: a write may no longer destroy another session's
 * entries, so nothing in the write path prunes them any more — each session
 * that ever cut or retired a target in this project leaves its rows behind, on
 * a record read at every single turn_end. The bound is applied at the one
 * writer, on the whole list, and sheds FOREIGN rows first (the writer orders
 * this session's entries last), so it can never evict the entries this turn
 * depends on. Generous on purpose: it is a backstop against unbounded growth,
 * not a scheduling policy.
 */
export const TEST_RUNNER_MAX_PERSISTED_TARGETS = 64;

/**
 * Union two deferral sets by target identity, keeping the HIGHER attempt count
 * (#2522 review round 3, F3). Two overlapping batches can both be cut on the
 * same target; taking the lower count would let a target trade an attempt for
 * every overlap and never converge on `TEST_RUNNER_MAX_DEFERRALS`.
 *
 * Identity is (session, path), not path alone (#2522 review round 4, I1): two
 * sessions can each owe a run of the same file, and collapsing those into one
 * row makes the surviving row's `sessionId` decide whose deferral is honoured
 * and whose is silently dropped. The path half is keyed through
 * `normalizeMapKey` so `/`- and `\`-separated spellings are one entry
 * (AGENTS.md cross-form-path screen).
 */
function deferralEntryKey(entry: DeferredTestTarget): string {
	return `${entry.sessionId ?? ""}\u0000${normalizeMapKey(path.resolve(entry.testFile))}`;
}

function mergeDeferredTargets(
	existing: readonly DeferredTestTarget[],
	incoming: readonly DeferredTestTarget[],
): DeferredTestTarget[] {
	const byKey = new Map<string, DeferredTestTarget>();
	for (const entry of [...existing, ...incoming]) {
		const key = deferralEntryKey(entry);
		const prior = byKey.get(key);
		if (prior && (prior.attempts ?? 0) >= (entry.attempts ?? 0)) continue;
		byKey.set(key, entry);
	}
	return [...byKey.values()];
}

export interface BoundedTestBatchOutcome<R, T> {
	/** One entry per target that was dispatched AND settled before the close. */
	results: PromiseSettledResult<R>[];
	/**
	 * The targets that produced no usable result — never dispatched, or in
	 * flight and killed when a bound fired. Returned BY IDENTITY, not as a
	 * count: this IS the deferral set the caller persists and re-runs first
	 * next turn (#2522 review round 2, F1). `deferred.length` is the count the
	 * pre-round-2 `skipped` field used to carry, so there is exactly one
	 * source of truth for "what didn't run".
	 *
	 * A target that FINISHED before the batch closed is not in here — the stamp
	 * that decides that is taken by the `.then` attached AT DISPATCH (see
	 * `settledBeforeClose` below), so it is never charged an attempt toward
	 * retirement (#2522 review round 3 F4, re-founded in round 4 on the stamp
	 * instead of a queue hop).
	 */
	deferred: T[];
	/** Which bound ended the batch early, if either did. */
	stopReason?: "budget" | "abort";
}

/**
 * Run `run` over `targets` with a concurrency cap, a batch-wide wall budget
 * and an abort-signal race. Reuses `mapWithConcurrency` (the repo's existing
 * worker-pool shape) rather than hand-rolling a second pool.
 *
 * Both bounds are enforced twice on purpose: cooperatively, before each
 * dispatch, so no NEW work starts past the bound; and as a real race against
 * the pool, so an in-flight target cannot hold the batch past its budget.
 * Whatever has settled by then is returned — a partial batch of real results
 * is strictly better than none, and the caller reports the shortfall.
 */
export async function runTestTargetsBounded<T, R>(args: {
	targets: T[];
	concurrency: number;
	budgetMs: number;
	signal?: AbortSignal;
	/**
	 * The batch's OWN abort signal is passed as the second argument: the runner
	 * must thread it into its spawn so a target that outlives the wall budget is
	 * killed, not merely abandoned (#2522 review round 2, F1).
	 */
	run: (target: T, signal: AbortSignal) => Promise<R>;
}): Promise<BoundedTestBatchOutcome<R, T>> {
	const results: PromiseSettledResult<R>[] = [];
	if (args.targets.length === 0) return { results, deferred: [] };

	let stopReason: "budget" | "abort" | undefined;
	// One controller for the whole batch. Aborting it tree-kills every child the
	// runner has in flight (`safeSpawnAsync` honours the signal it is handed),
	// which is what turns "the bound fired" into "the work actually stopped".
	const batchAbort = new AbortController();
	// Latched at the moment this call returns. Nothing may push into `results`
	// after that: the caller has already consumed the array, and a late push
	// would silently change a batch it has finished reasoning about.
	let closed = false;
	/**
	 * #2522 review round 4, I4: "was this target CUT, or did it FINISH?" is a
	 * semantic question, and this set is the answer — stamped by the `.then`
	 * attached to `run`'s promise AT DISPATCH, which is that promise's FIRST
	 * continuation. Nothing but a microtask can run between the promise settling
	 * and this stamp, and every path that closes the batch (`setTimeout`, the
	 * ambient signal's `abort` event, the pool settling after every mapper has
	 * returned) reaches `finish()` from a macrotask or later. So `closed` read
	 * here is exactly "the batch was already cut when this value existed".
	 *
	 * Round 3 read the same flag from the mapper's own `await` continuation,
	 * which is several continuations downstream of the settle — a macrotask CAN
	 * interleave there — and papered over the resulting misclassification with a
	 * `setImmediate` hop plus a `latchedOut` parking array. Both are gone: the
	 * hop made the answer depend on queue ordering, which is the thing that kept
	 * producing findings (a spawn aborted BEFORE it started resolves
	 * synchronously, so the hop folded it back in as a completed run — round 4
	 * P3c).
	 */
	const settledBeforeClose = new Set<number>();
	const budgetMs = Math.max(0, args.budgetMs);
	const deadline = Date.now() + budgetMs;
	const shouldStop = (): boolean => {
		if (stopReason !== undefined) return true;
		if (args.signal?.aborted) {
			stopReason = "abort";
			return true;
		}
		if (Date.now() >= deadline) {
			stopReason = "budget";
			return true;
		}
		return false;
	};

	const pool = mapWithConcurrency(
		args.targets.map((target, index) => ({ target, index })),
		Math.max(1, args.concurrency),
		async ({ target, index }) => {
			if (shouldStop()) return;
			const running = args.run(target, batchAbort.signal);
			// Attached HERE, at dispatch, so it is the promise's first
			// continuation — see `settledBeforeClose`. A value that only exists
			// because the batch was cut (a killed spawn's runner error, or
			// `safeSpawnAsync`'s synchronous "Spawn aborted before start") settles
			// strictly after the close and is therefore never recorded, so the
			// caller defers that target instead of reading it as a completed run.
			const stamp = running.then(
				(value) => {
					if (closed) return;
					settledBeforeClose.add(index);
					results.push({ status: "fulfilled", value });
				},
				(reason) => {
					if (closed) return;
					settledBeforeClose.add(index);
					results.push({ status: "rejected", reason });
				},
			);
			// The stamp swallows both settlements, so this only keeps the pool's
			// concurrency slot held for as long as the work actually runs.
			await stamp;
		},
	);
	// The pool's mapper swallows every throw from an async `run`; a `run` that throws
	// SYNCHRONOUSLY still rejects the pool and closes the whole batch (everything defers,
	// nothing publishes clean). Production runners are async, so this is fail-safe, not reachable.
	void pool.catch(() => {});

	await new Promise<void>((resolve) => {
		let settled = false;
		const finish = (reason?: "budget" | "abort"): void => {
			if (settled) return;
			settled = true;
			if (reason !== undefined) stopReason ??= reason;
			// Latch BEFORE resolving, so no continuation scheduled by the kill
			// below can slip a result in behind the caller's back.
			closed = true;
			// Kill whatever is still in flight. Without this the pool ran on past
			// the bound: a stuck vitest spawn kept a core busy to its own 60s
			// timeout, long after the turn had moved on.
			batchAbort.abort();
			clearTimeout(timer);
			args.signal?.removeEventListener("abort", onAbort);
			resolve();
		};
		const onAbort = (): void => finish("abort");
		const timer = setTimeout(() => finish("budget"), budgetMs);
		// A pending batch timer must never hold the process open.
		timer.unref?.();
		if (args.signal?.aborted) finish("abort");
		else args.signal?.addEventListener("abort", onAbort, { once: true });
		void pool.then(
			() => finish(),
			() => finish(),
		);
	});

	return {
		results,
		deferred: args.targets.filter((_, index) => !settledBeforeClose.has(index)),
		stopReason,
	};
}

interface TurnEndDeps {
	ctxCwd?: string;
	getFlag: (name: string) => boolean | string | undefined;
	dbg: (msg: string) => void;
	runtime: RuntimeCoordinator;
	cacheManager: CacheManager;
	knipClient: KnipClient;
	deadCodeClients: DeadCodeClient[];
	depChecker: DependencyChecker;
	testRunnerClient: TestRunnerClient;
	/** Explicit owner for MCP Stop-hook calls; pi calls use runtime identity. */
	owner?: TurnStateOwner;
	resetLSPService: () => void;
	resetFormatService: () => void;
	/** Stage completed test results for the post-agent non-context surface. */
	onTestRunnerComplete?: (args: {
		cwd: string;
		sessionId: string;
		generation: number;
		targetCount: number;
		hasFindings: boolean;
	}) => void;
	/** Stable session identity from the event ctx that fired this turn_end. */
	sessionId?: string;
	/**
	 * #4154: the session scope of the activation whose turn this is: the
	 * coordinator's for the primary, its own for a concurrent secondary (which
	 * shares the coordinator). A late dead-code scan belongs to it. Absent on
	 * the MCP route and in harnesses: the coordinator's scope.
	 */
	sessionScope?: SessionScope;
	/** Abort signal from the event ctx that fired this turn_end. */
	signal?: AbortSignal;
	/** Delivery adapter whose tool names appear in agent-facing advisories. */
	host?: LensToolHost;
}

/**
 * Would writing `next` over `prev` throw away a good scan for a failed one?
 *
 * A failed run carries no findings. Writing it evicts the last good result, and
 * every later reader then serves the failure as the answer — a 194-byte "not
 * available" record replaced 149 KB of real findings in every dogfood project
 * (#925, #1467). Callers keep the previous cache when this returns true.
 */
function wouldPoisonCache(
	prev: { data: { success: boolean } } | null | undefined,
	next: { success: boolean },
): boolean {
	return !next.success && prev?.data.success === true;
}

/**
 * A dead-code scan that missed the turn_end budget and is still running, or
 * has finished since (#4117). `bounded()` abandons the await, not the process,
 * and vulture keeps no disk cache, so what the abandoned scan computes is
 * written and delivered by the entry below instead of being thrown away: the
 * scan lands its baseline row where it settles, and the next turn_end that
 * reaches the lane delivers its delta. One entry per (client, root) on the
 * cell of the session scope whose turn parked it (#4154): the primary's, a
 * concurrent secondary's own, or a replaced session's new one. Park, take,
 * carry and the settle's liveness check all ask that one scope, so a session
 * never sees another's entry, and a scan that settles after its session ended
 * is dropped. While an entry exists no second scan starts, so the settle
 * handler is the session's only writer of the baseline row.
 */
interface LateDeadCodeScan {
	/** Resolved paths of the files edited in the turn the scan was started for. */
	files: ReadonlySet<string>;
	/** The baseline row the scan was started against; absent when there was none. */
	previousScan: DeadCodeResult | undefined;
	/** Resolved paths edited while the scan ran: the next scan covers them. */
	carry: Set<string>;
	/** The scan's result once it succeeded; null while it runs. */
	settled: DeadCodeResult | null;
	/** When the lane asked for the scan (`joinedEarlierScan`). */
	askedAt: number;
}

const LATE_DEAD_CODE_SCANS = "dead-code-late-scans";

function lateDeadCodeScansOf(
	scope: SessionScope,
): Map<string, LateDeadCodeScan> {
	return scopeCell(
		scope,
		LATE_DEAD_CODE_SCANS,
		() => new Map<string, LateDeadCodeScan>(),
	) as Map<string, LateDeadCodeScan>;
}

/**
 * #4154 J1: did `analyze()` hand back a scan that was already running when the
 * lane asked at `askedAt`? The client's single flight is process-wide, so the
 * scan may be another session's, a subagent's, or a fresh fetch's, started
 * before this turn's edits: it read the tree before them and cannot cover
 * them. `scannedAt` is the initiator's read stamp, which a joiner inherits
 * (#3600); a result without one never reached a scan.
 */
function joinedEarlierScan(result: DeadCodeResult, askedAt: number): boolean {
	return (
		result.scannedAt !== undefined && Date.parse(result.scannedAt) < askedAt
	);
}

/**
 * #4154 V1: a scan's result, with the row a FAILED result is judged against
 * before it is written: the row on disk once the scan settled, not the one
 * read before it started. Another writer (another pi-lens process on the same
 * project) may have stored a good row meanwhile, and the failure must not
 * replace it. A success needs no row, and a good `startRow` is kept either way,
 * so only the cold path reads; it reads through `readCacheAsync`, so an inline
 * caller's `bounded()` still covers the read.
 */
function withRowForFailureWrite<R extends { success: boolean }>(
	scan: Promise<R>,
	cacheManager: CacheManager,
	cacheKey: string,
	cwd: string,
	startRow: { data: { success: boolean } } | null,
): Promise<{ result: R; row: { data: { success: boolean } } | null }> {
	return scan.then((result) =>
		result.success || startRow?.data.success === true
			? { result, row: startRow }
			: cacheManager
					.readCacheAsync<{ success: boolean }>(cacheKey, cwd)
					.then((row) => ({ result, row })),
	);
}

/** One finished scan and what it is compared with, for the dead-code delta. */
interface DeadCodeDeltaSource {
	result: DeadCodeResult;
	previousScan: DeadCodeResult | undefined;
	/** Resolved paths of the files whose new findings are attributable to the agent. */
	modified: ReadonlySet<string>;
}

function lateDeadCodeScanKey(client: DeadCodeClient, cwd: string): string {
	return `${client.id}\0${cwd}`;
}

/** The one `dead-code.log` event a cross-file scan produces, inline or late. */
function deadCodeScanEvent(
	client: DeadCodeClient,
	cwd: string,
	result: DeadCodeResult,
	durationMs: number,
): Parameters<typeof logDeadCodeScan>[0] {
	return {
		language: client.language,
		root: cwd,
		success: result.success,
		cached: false,
		unusedExports: result.unusedExports.length,
		unusedFiles: result.unusedFiles.length,
		unusedDeps: result.unusedDeps.length,
		unlistedDeps: result.unlistedDeps.length,
		durationMs: result.durationMs ?? durationMs,
		...(result.excludedWorktrees !== undefined && {
			excludedWorktrees: result.excludedWorktrees,
		}),
		...(!result.success && { reason: result.summary }),
	};
}

/** Remove a late scan that will not be used, and count why. */
function dropLateDeadCodeScan(
	scans: Map<string, LateDeadCodeScan>,
	key: string,
	client: DeadCodeClient,
	reason: string,
): void {
	scans.delete(key);
	incrementDegradationCount({
		kind: "dead-code-late-scan-dropped",
		subject: client.id,
		reason,
	});
}

/**
 * Keep a dead-code scan that missed the turn_end budget (#4117 F1), or one
 * that joined a scan older than this turn's edits (#4154 J1). Where it settles
 * it writes the baseline row (a failure never replaces the good row on disk
 * then, #925, #4154 V1) and its `dead-code.log` event, and a successful result
 * waits in the entry for the next turn_end of the same session that reaches
 * the lane. A result for a session that has ended is dropped and counted.
 */
function parkLateDeadCodeScan(args: {
	scope: SessionScope;
	cacheManager: CacheManager;
	client: DeadCodeClient;
	cwd: string;
	cacheKey: string;
	scan: Promise<DeadCodeResult>;
	startedAt: number;
	files: ReadonlySet<string>;
	previousScan: DeadCodeResult | undefined;
}): void {
	const { scope, cacheManager, client, cwd, cacheKey, startedAt } = args;
	const scans = lateDeadCodeScansOf(scope);
	const key = lateDeadCodeScanKey(client, cwd);
	const entry: LateDeadCodeScan = {
		files: args.files,
		previousScan: args.previousScan,
		carry: new Set(),
		settled: null,
		askedAt: startedAt,
	};
	scans.set(key, entry);
	void withRowForFailureWrite(
		args.scan,
		cacheManager,
		cacheKey,
		cwd,
		entry.previousScan ? { data: entry.previousScan } : null,
	).then(
		({ result, row }) => {
			if (!scope.isLive()) {
				dropLateDeadCodeScan(scans, key, client, "session-ended");
				return;
			}
			const durationMs = Date.now() - startedAt;
			const cacheKept = wouldPoisonCache(row, result);
			if (!cacheKept) {
				cacheManager.writeCache(cacheKey, result, cwd, {
					scanDurationMs: durationMs,
				});
			}
			logDeadCodeScan({
				...deadCodeScanEvent(client, cwd, result, durationMs),
				...(cacheKept && { cacheKept }),
			});
			if (!result.success) {
				dropLateDeadCodeScan(
					scans,
					key,
					client,
					`scan-failed: ${result.summary}`,
				);
				return;
			}
			entry.settled = result;
		},
		(err: unknown) =>
			dropLateDeadCodeScan(scans, key, client, `scan-threw: ${err}`),
	);
}

// LSP idle reset scheduling — prevents thrashing by delaying shutdown
let lspIdleResetTimeout: ReturnType<typeof setTimeout> | null = null;
// #1618: set while this timer's fire is deferred behind an in-flight
// workspace sweep (see `scheduleLSPIdleReset`'s `isWorkspaceSweepActive`
// branch). `cancelLSPIdleReset` must be able to cancel THIS too — otherwise
// an active-editing turn that cancels idle reset while a sweep is still
// running would have it silently resurrected once the sweep finishes, even
// though the session is no longer idle.
let pendingSweepRearm: { cancelled: boolean } | null = null;

function emitIdleResetReporterWarning(reportErr: unknown): void {
	try {
		process.emitWarning(
			`pi-lens LSP idle reset error reporter failed: ${reportErr}`,
			{ code: "PI_LENS_LSP_IDLE_RESET_REPORTER_FAILED" },
		);
	} catch {
		// Preserve the detached-timer invariant: this path must never crash.
		void reportErr;
	}
}

function reportIdleResetError(
	onError: ((err: unknown) => void) | undefined,
	err: unknown,
): void {
	try {
		onError?.(err);
	} catch (reportErr) {
		emitIdleResetReporterWarning(reportErr);
	}
}

function scheduleLSPIdleReset(
	resetFn: () => void,
	delayMs: number,
	options: {
		isCurrentSession?: () => boolean;
		/**
		 * #2157 fix round 2: an idle-reset timer armed by a SECONDARY session
		 * (e.g. a subagent evaluation, `isSubagentSession()`) must not tear down
		 * a PRIMARY session's shared LSP fleet. `isCurrentSession` alone cannot
		 * catch this — it only asks whether THIS evaluation's own session
		 * generation moved on, which stays true for the secondary's own
		 * generation for its whole (shortened) delay while it fires against the
		 * fleet the primary is actively using. Mirrors the
		 * `pipeline_crash`-reset gate in `runtime-tool-result.ts`
		 * (`getActiveSessionId()` vs `runtime.telemetrySessionId`): undefined
		 * primary (no registration yet) is fail-safe "belongs to primary", same
		 * as today's un-gated behavior.
		 */
		isPrimarySession?: () => boolean;
		onError?: (err: unknown) => void;
	} = {},
): void {
	// Clear any pending reset to avoid multiple timers. #1618: also cancel a
	// rearm still waiting on a prior sweep's hold — otherwise re-scheduling
	// here (this call) leaves that OLD waiter armed too, and the sweep's
	// eventual release would fire a SECOND, independent `scheduleLSPIdleReset`
	// alongside this fresh one.
	if (lspIdleResetTimeout) {
		clearTimeout(lspIdleResetTimeout);
	}
	if (pendingSweepRearm) {
		pendingSweepRearm.cancelled = true;
		pendingSweepRearm = null;
	}
	lspIdleResetTimeout = setTimeout(() => {
		lspIdleResetTimeout = null;
		// #1618: a full workspace sweep (`lens_diagnostics mode=full`) grants
		// itself a wall-clock ceiling that can outlive this timer's delay — this
		// used to fire straight into an in-flight sweep and destroy the very
		// service the sweep was actively touching, mislabeling every file the
		// sweep had not yet reached as budget exhaustion. Defer instead of
		// firing: re-arm a FRESH `delayMs` timer once the sweep releases its
		// hold, rather than resuming a countdown that's already elapsed (which
		// would fire the instant the hold releases) or destroying mid-sweep.
		if (isWorkspaceSweepActive()) {
			const rearmToken = { cancelled: false };
			pendingSweepRearm = rearmToken;
			runWhenWorkspaceSweepIdle(() => {
				if (rearmToken.cancelled) return;
				if (pendingSweepRearm === rearmToken) pendingSweepRearm = null;
				scheduleLSPIdleReset(resetFn, delayMs, options);
			});
			return;
		}
		try {
			if (options.isCurrentSession && !options.isCurrentSession()) {
				return;
			}
			if (options.isPrimarySession && !options.isPrimarySession()) {
				return;
			}
			resetFn();
		} catch (err) {
			// Detached timers run outside a pi event boundary. They must never crash
			// the extension process (for example if a host UI object was invalidated
			// by session replacement before the timer fired).
			reportIdleResetError(options.onError, err);
		}
	}, delayMs);
	// unref so this timer does not prevent the process from exiting naturally
	// (critical for subagent / --mode json -p usage where the process should
	// exit after completing its work, not wait 240 seconds for this to fire)
	lspIdleResetTimeout.unref();
}

// #1618 acceptance criterion 6: FULL_SCAN_WALL_CLOCK_MS (the full-sweep wall
// clock ceiling, `tools/lens-diagnostics.ts`) must stay under EVERY idle
// reset delay this module can arm — derived, not asserted, so the constants
// can't drift back into a relationship where a still-running sweep can
// outlive the timer. The AC1 hold above already makes a mid-sweep fire
// impossible regardless of this margin; this is defense in depth against a
// future caller that touches the LSP service outside
// `runWorkspaceDiagnostics`' hold. `SWEEP_IDLE_SAFETY_MARGIN_MS` is
// single-sourced from `workspace-sweep-hold.ts`, which also uses it for its
// own max-hold-age failsafe — one tunable, not two.
const DEFAULT_LSP_IDLE_RESET_MS = 240_000;

function sweepDerivedFloorMs(): number {
	return getFullScanWallClockMs() + SWEEP_IDLE_SAFETY_MARGIN_MS;
}

/** The normal (non-subagent, non-budget-pressured) idle-reset delay. */
function getBaseLspIdleResetMs(): number {
	return Math.max(DEFAULT_LSP_IDLE_RESET_MS, sweepDerivedFloorMs());
}

/**
 * #1618 (R4): the subagent-light (#713) and cross-process-budget-pressured
 * (#449) paths used to arm a flat, much SHORTER delay (60s default) than the
 * sweep's own 300s ceiling — a 5:1 inversion covered only by the AC1 hold.
 * Deriving this path too means AC6 ("the sweep's ceiling stays under every
 * idle-reset delay") holds universally, not just for the common path, and an
 * env override to either constant can never invert it (`Math.max` floors at
 * the derived value no matter how small the override pushes the other side).
 *
 * Accepted cost (deliberate, not incidental — see R6 in the PR body): under
 * default settings this now ALSO arms the ~360s derived floor rather than a
 * true 60s teardown, trading some of #713's "release a short-lived
 * subagent's fleet fast" benefit for AC6 holding without exceptions.
 */
function getShortenedLspIdleResetMs(): number {
	return Math.max(getLspBudgetIdleTimeoutMs(), sweepDerivedFloorMs());
}

/** The idle-reset delay `handleTurnEnd` actually arms on a file-less turn —
 *  exported so tests assert against the REAL computed value instead of a
 *  hand-derived literal that can silently drift from this function. */
export function getEffectiveLspIdleResetMs(): number {
	return isSubagentSession() || shouldShortenLspIdleTimeout()
		? getShortenedLspIdleResetMs()
		: getBaseLspIdleResetMs();
}

export function cancelLSPIdleReset(): void {
	if (lspIdleResetTimeout) {
		clearTimeout(lspIdleResetTimeout);
		lspIdleResetTimeout = null;
	}
	if (pendingSweepRearm) {
		pendingSweepRearm.cancelled = true;
		pendingSweepRearm = null;
	}
}

function capTurnEndMessage(content: string, held = 0): string {
	const maxLines = RUNTIME_CONFIG.turnEnd.maxLines;
	const maxChars = RUNTIME_CONFIG.turnEnd.maxChars;
	// #3813: when the cap cuts a part a producer is holding for the next turn,
	// the marker says how many, in the one line the cap already appends.
	const marker =
		held > 0
			? `... (truncated; ${held} held for the next turn)`
			: "... (truncated)";

	// Both axes cut the CONTENT, then ONE marker is appended. Appending it after
	// the line cut and letting the char axis cut that again left a half-printed
	// marker before a second one (#3813 review r1 F5).
	let kept = content;
	let cut = false;
	const lines = kept.split("\n");
	if (lines.length > maxLines) {
		kept = lines.slice(0, maxLines).join("\n");
		cut = true;
	}
	if (kept.length > maxChars) {
		kept = sliceAtCodePointBoundaries(kept, 0, maxChars);
		cut = true;
	}

	return cut ? `${kept}\n${marker}` : content;
}

/**
 * #3813: how many chars of `content` `capTurnEndMessage` keeps (all of it when
 * nothing is cut). The same two axes as the cap, so what a hold is judged
 * against is exactly what the agent receives.
 */
function turnEndKeptChars(content: string): number {
	const maxLines = RUNTIME_CONFIG.turnEnd.maxLines;
	const maxChars = RUNTIME_CONFIG.turnEnd.maxChars;
	const lines = content.split("\n");
	const kept =
		lines.length > maxLines
			? lines.slice(0, maxLines).join("\n").length
			: content.length;
	return Math.min(
		kept,
		sliceAtCodePointBoundaries(content, 0, maxChars).length,
	);
}

function sliceAtCodePointBoundaries(
	value: string,
	start: number,
	end: number,
): string {
	if (
		start > 0 &&
		start < value.length &&
		isLowSurrogate(value.charCodeAt(start)) &&
		isHighSurrogate(value.charCodeAt(start - 1))
	) {
		start += 1;
	}
	if (
		end > 0 &&
		end < value.length &&
		isLowSurrogate(value.charCodeAt(end)) &&
		isHighSurrogate(value.charCodeAt(end - 1))
	) {
		end -= 1;
	}
	return value.slice(start, end);
}

function isHighSurrogate(codeUnit: number): boolean {
	return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
	return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

/**
 * #3218 criterion 2: the turn-end "Resolved" section's share of the message
 * cap. It rides first (the cap must never cut a consumed line) but is never
 * the whole cap: a cleanup report must not crowd the live blockers out
 * (review-3776-r3 W1). At most 40% of the chars and 5 lines, one of them kept
 * for the "… and N more" tail.
 */
const RESOLVED_SHARE_OF_CHARS = 0.4;
const RESOLVED_MAX_LINES = 5;

/**
 * #3218 criterion 2: "1st", "2nd", "3rd", "4th" … for a retiring write's
 * index in the "Resolved this turn" line. A bare `${n}th` reads as "1th".
 */
function formatWriteOrdinal(n: number): string {
	const mod100 = n % 100;
	if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
	switch (n % 10) {
		case 1:
			return `${n}st`;
		case 2:
			return `${n}nd`; // spellchecker:disable-line
		case 3:
			return `${n}rd`;
		default:
			return `${n}th`;
	}
}

export async function handleTurnEnd(deps: TurnEndDeps): Promise<void> {
	const {
		ctxCwd,
		getFlag,
		dbg,
		runtime,
		cacheManager,
		knipClient,
		deadCodeClients,
		depChecker,
		testRunnerClient,
		sessionId,
		host = "pi",
		owner,
		resetLSPService,
		resetFormatService,
	} = deps;
	const turnIndexAtDispatch = runtime.turnIndex;
	const clearOwnedTurnState = (): void => {
		if (runtime.turnIndex !== turnIndexAtDispatch) {
			dbg(
				`turn_end: retaining newer turn state (dispatch=${turnIndexAtDispatch}, current=${runtime.turnIndex})`,
			);
			return;
		}
		cacheManager.clearTurnState(cwd, currentOwner);
	};

	// #449 slice 1: piggyback the instance-registry heartbeat on this existing
	// per-turn touchpoint rather than adding a new timer/interval. Cheap (reads
	// process.memoryUsage().rss, one read-modify-write of instances.json) and
	// fire-and-forget — the kill-switch check + no-op behavior live inside
	// updateHeartbeat itself, so this call site doesn't need to know about it.
	//
	// #620: intentionally RSS-only here — CPU%/LSP-child sampling (which shells
	// out to `pidusage`, and a full CIM query on Windows for a spawn's process
	// tree) is left to the quiet-window "instance_registry_heartbeat" task
	// (clients/quiet-window.ts's `buildHeartbeatResourcePatch`), which fires on
	// the idle `agent_settled` window rather than every single turn end. Every
	// turn end is a much hotter path than an idle window, and the issue's own
	// guardrail is not to let the measurement itself become a new source of
	// per-turn overhead worth investigating.
	void updateHeartbeat().catch(() => {
		// best-effort observability — never fail turn_end over this
	});

	const cwd = ctxCwd ?? process.cwd();
	let turnState = cacheManager.readTurnState(cwd);

	// A live foreign writer owns this worklist. Do not clear or consume another
	// pi/MCP session's files; a dead/aged owner is safely evicted instead.
	// #2504: `sessionStartedAt` dates the persisted worklist against THIS
	// session. Without it an ownerless turn-state.json — the resting shape
	// before #2504 — read back as "owned" no matter how old it was.
	const currentOwner: TurnStateOwner = {
		...(owner ?? {
			kind: "pi",
			id: runtime.telemetrySessionId,
			pid: process.pid,
			lastSeen: new Date().toISOString(),
		}),
		sessionStartedAt: owner?.sessionStartedAt ?? runtime.sessionStartedAt,
	};
	const access = cacheManager.getTurnStateAccess(cwd, currentOwner);
	// Captured BEFORE the eviction below rewrites the file: the owner the gate
	// actually judged. This pair is what would have settled #2504 from the
	// debug log alone.
	const gateOwnerLabel = turnState.owner
		? `${turnState.owner.kind}:${turnState.owner.id}`
		: turnState.sessionId
			? `legacy:${turnState.sessionId}`
			: "none";
	const sameProcessPiSessionHandoff =
		access === "foreign-live" &&
		currentOwner.kind === "pi" &&
		turnState.owner?.kind === "pi" &&
		turnState.owner.pid === process.pid &&
		turnState.owner.id !== currentOwner.id;
	if (access === "foreign-live" && !sameProcessPiSessionHandoff) {
		dbg(
			`turn_end: foreign live owner retained (${turnState.owner?.kind ?? "legacy"}:${turnState.owner?.id ?? turnState.sessionId})`,
		);
		return;
	}
	if (
		access === "available" &&
		(turnState.files || turnState.owner || turnState.sessionId)
	) {
		dbg("turn_end: evicting stale turn-state owner");
		clearOwnedTurnState();
		turnState = cacheManager.readTurnState(cwd);
	}

	const files = Object.keys(turnState.files);

	/**
	 * #2275: widget-footer sibling of #1950's inline-blocker cap, for the
	 * widget store's OWN dependency-drift demotion
	 * (`markWidgetFileBlockersStale`, driven by the freshness sweep further
	 * down this function) — a completely separate store from
	 * `RuntimeCoordinator`'s inline-blocker map, so it needed its own
	 * delivery count (`WidgetDiagnostic.staleDeliveryCount`) rather than
	 * inheriting one.
	 *
	 * Review F1: the population is what the footer RENDERED since the last
	 * turn end, drained here — not every file that merely holds a demoted
	 * row. The footer draws one record per pass (`withBlocking[0]`, its top
	 * five entries) and may not be drawn at all, so a per-turn walk of the
	 * whole store charged deliveries the agent never received and retired a
	 * delivery early. This is the widget-surface analogue of the inline
	 * loop's own `pendingDependencyDriftDeliveries` deferral below: both
	 * commit a delivery only once the surface has actually served it. Every
	 * `deliveryCount` reported to the ledger is therefore a count of RENDERS.
	 *
	 * Fix-round 3 (#2275 review F1): this drain/charge MUST run before the
	 * `files.length === 0` early return below — a read-only turn (no
	 * modified files) still repaints the footer and can draw a demoted row,
	 * so a cap that only charged deliveries below the early return silently
	 * starved on quiet turns: the footer re-rendered the same demoted row
	 * every turn while the delivery count never advanced. The drain is a
	 * Set.take() plus one map lookup per drained file — cheap enough to run
	 * unconditionally on every turn end.
	 */
	let widgetDemotedFindingsRetired = 0;
	for (const wPath of drainRenderedDependencyDriftFilePaths()) {
		const deliveryCount = incrementWidgetDependencyDriftDelivery(wPath);
		if (deliveryCount >= DEPENDENCY_DRIFT_MAX_DELIVERIES) {
			const capRetired = retireWidgetDependencyDriftBlockers(wPath);
			if (capRetired) {
				widgetDemotedFindingsRetired += 1;
				incrementDegradationCount({
					kind: "demoted-finding-retired",
					subject: `widget-blocker:${toRunnerDisplayPath(cwd, wPath)}`,
					reason: `capped after ${deliveryCount} deliveries with no re-run; hidden from the pi-lens footer, still listed by lens_diagnostics mode=all — re-run can still confirm`,
				});
			}
		}
	}

	// R1 (#1443 follow-up): a read-only turn (no files touched) must not take
	// the fast idle-reset path while a carried cascade run — or one still
	// settling — is waiting for its delivery opportunity. Falling through to
	// the normal pipeline lets the settle/drain/merge logic below run exactly
	// as it does for an edit turn, so a carried finding reaches the agent
	// instead of dying unrendered. `hasCascadeRuns()` is a cheap peek (no
	// pending work almost every turn), so the common read-only turn still
	// takes the early return below.
	// A foreign live owner must not deliver another session's pending findings.
	// A no-file turn falls through when this process has pending runner work so
	// the ordinary freshness gate and delivery cache can run. Max-cycle cleanup
	// below intentionally remains a terminal reset; its pending work stays in
	// the bounded handoff store for the next eligible turn.
	if (files.length === 0 && !runtime.hasCascadeRuns()) {
		// A genuinely clean session must invalidate the persisted guard record.
		// Blocker records are retained only while the runtime still reports one.
		if (getFlag("lens-guard") && !runtime.gitGuardHasBlockers) {
			const guardRecord = cacheManager.readCache<Partial<TurnEndFindingsCache>>(
				"turn-end-findings",
				cwd,
			)?.data;
			if (
				guardRecord?.sessionId === runtime.telemetrySessionId &&
				guardRecord.testFailures !== true
			) {
				cacheManager.clearCache("turn-end-findings", cwd);
			}
		}
		// #713: subagent sessions use a shorter idle reset (nominally 60s) — a
		// short-lived task agent holding a warm fleet for 4 minutes after its
		// last turn is pure waste under fan-out. Classify ONCE here so every
		// tick in this call path shares the same answer. PI_LENS_SUBAGENT_FULL=1
		// restores the base delay via isSubagentSession() returning false.
		// #1618: both branches route through `getEffectiveLspIdleResetMs` so
		// AC6's derivation applies universally — see that function's doc for
		// why the "shorter" path is not always literally 60s anymore.
		const idleResetMs = getEffectiveLspIdleResetMs();
		dbg(
			`turn_end: no modified files, scheduling LSP idle reset (${idleResetMs / 1000}s)`,
		);
		if (!getFlag("no-lsp")) {
			const sessionGeneration = runtime.sessionGeneration;
			scheduleLSPIdleReset(resetLSPService, idleResetMs, {
				isCurrentSession: () => runtime.isCurrentSession(sessionGeneration),
				// #2157 fix round 2: a secondary (subagent) evaluation's own timer
				// must not release the primary's shared fleet — see the option's
				// doc comment on `scheduleLSPIdleReset`.
				isPrimarySession: () => {
					const activePrimarySessionId = getActiveSessionId();
					return (
						activePrimarySessionId === undefined ||
						activePrimarySessionId === runtime.telemetrySessionId
					);
				},
				onError: (err) => dbg(`lsp idle reset failed: ${err}`),
			});
		}
		resetFormatService();
		// #3218 criterion 2: a retirement nobody has reported (a
		// `lens_diagnostics` confirmation lands on exactly this turn) falls
		// through to the composer like a carried runner finding.
		if (pendingRunnerFindingsSize() === 0 && !runtime.hasResolvedBlockerFiles())
			return;
	}

	// Cancel any pending idle reset since we're actively working. #1618: also
	// checks `pendingSweepRearm` — a timer deferred behind an in-flight
	// workspace sweep already nulled `lspIdleResetTimeout` (the setTimeout
	// callback clears it before checking the hold), so this guard used to
	// read "nothing pending" and skip the cancel while a rearm was still
	// queued to fire the instant the sweep released its hold — resurrecting
	// idle reset on a session that had since gone back to active editing.
	if (files.length > 0 && (lspIdleResetTimeout || pendingSweepRearm)) {
		cancelLSPIdleReset();
		dbg("turn_end: cancelled pending LSP idle reset (active editing)");
	}

	dbg(
		`turn_end: ${files.length} file(s) modified, cycles: ${turnState.turnCycles}/${turnState.maxCycles}, access: ${access}, owner: ${gateOwnerLabel}`,
	);

	if (cacheManager.isMaxCyclesExceeded(cwd)) {
		dbg("turn_end: max cycles exceeded, clearing state and forcing through");
		clearOwnedTurnState();
		runtime.fixedThisTurn.clear();
		resetFormatService();
		return;
	}

	const turnEndStart = Date.now();
	const blockerParts: string[] = [];
	/**
	 * #1622 review M2: findings the freshness gate demoted. A third tier between
	 * blockers and advisories — not a blocker, because the cached coordinate is
	 * untrustworthy; not an advisory, because the advisory label reads "no action
	 * required this turn" and these DO require a re-scan. Each part carries its
	 * own imperative preamble rather than inheriting that label.
	 */
	const staleSecretParts: string[] = [];
	const advisoryParts: string[] = [];
	/**
	 * #3813: one-shot state a producer consumes for a part of this message,
	 * held until the cap has said what the message kept (see
	 * `clients/turn-end/delivery-holds.ts`). It folds in #1950 fix-round F1's
	 * deferred dependency-drift commits: that dedupe silences a turn whose
	 * rendered content is byte-identical to the last one delivered, so a
	 * counter must not advance for it (`skipOnSuppressed`).
	 */
	const deliveryHolds: DeliveryHold[] = [];
	/**
	 * #4161/#4168: identity follows the store's owner, each taken here, at
	 * entry. `turnScope` is the activation's scope (the coordinator's for the
	 * primary and on the MCP route, its own for a concurrent secondary): it
	 * owns the late dead-code scan cell (#4154). `holdScope` is the
	 * coordinator's scope: it owns the hold stores (the cascade runs and
	 * parked computes, the park map, and the module-level late-auxiliary and
	 * runner stores), which a concurrent secondary shares with the primary
	 * (#3613). A session replaced mid-turn owns none of the held state any
	 * more, and that is judged at every access, not here: the hold stores are
	 * drained after awaits that a replacement can land in, so a drain or a
	 * write-back runs through `holdScope.guardedWrite` and nothing is drained
	 * once the coordinator's scope has ended (one counted
	 * `generation-guard-stale-write` row per store or lane). A secondary's own
	 * end therefore fences only its cell: what it drained from the shared
	 * stores is restored at settle for the primary, as on master (#4168 R2-F1).
	 */
	const turnScope = deps.sessionScope ?? runtime.sessionScope;
	const holdScope = runtime.captureSessionGeneration();
	/**
	 * #3813/#3901: a parked lane belongs to the session that cut it. The park
	 * map is the coordinator's, shared by a concurrent secondary (subagent)
	 * activation that runs this function on the process-singleton runtime, so
	 * its key carries the turn's own session id, the one the deferred-test list
	 * is keyed by. A secondary neither takes nor shows the primary's parked
	 * items; `holdScope` fences only the session's end.
	 */
	const carryScope = sessionId ?? runtime.telemetrySessionId;
	const carryLane = (...parts: string[]): string =>
		[carryScope, ...parts].join(":");
	/** #3901/#4161: a lane's parked items, taken once, by its own session. */
	const takeParked = <T>(lane: string): T[] =>
		holdScope.guardedWrite(`turn-end:${lane}`, () =>
			runtime.takeCutAdvisoryItems<T>(lane),
		) ?? [];
	/**
	 * #3813/#3901: the hold for an item-bearing advisory whose producer has no
	 * queue to restore (knip, dead-code, call-graph impact). `shown` are the
	 * items the part names. A cut part parks the ones that were new this turn
	 * for the lane's next run, which re-checks each against its own fresh data.
	 * An item that is itself a re-offer (`isReOffer`) is not parked again, so
	 * nothing rides every turn: it is counted instead, and a part showing only
	 * re-offers cannot be held at all.
	 */
	const cutAdvisoryHold = <T>(
		family: "knip" | "dead-code" | "call-graph",
		lane: string,
		part: string,
		shown: readonly T[],
		isReOffer: (item: T) => boolean,
	): DeliveryHold => {
		const fresh = shown.filter((item) => !isReOffer(item));
		const recordDropped = (reason: string): void => {
			incrementDegradationCount({
				kind: "turn-end-advisory-carry-dropped",
				subject: family,
				reason,
			});
		};
		return {
			part,
			canHold: () => fresh.length > 0,
			onHeld: () => {
				for (const evicted of runtime.parkCutAdvisoryItems(lane, fresh)) {
					recordDropped(
						`${evicted} evicted: more lanes had cut items parked than the carry bound keeps`,
					);
				}
				if (fresh.length < shown.length) {
					recordDropped(
						"the cap cut items this lane had already re-offered once",
					);
				}
			},
			onDropped: () =>
				recordDropped(
					"the cap cut a part that showed only items it had already re-offered once",
				),
		};
	};
	const projectDiagnosticsDelta: ProjectDiagnostic[] = [];
	const projectDiagnosticsSources = new Set<string>();

	// Collect-later CLI runners continue off the write path. Their completed
	// answers go through ONE freshness-then-policy verdict
	// (`judgeDeferredRunnerFindings`, shared with the commit gate), like late
	// auxiliary findings.
	//
	// #3814: this lane runs BEFORE the blocker replay below. A blocking survivor
	// is recorded into the inline-blocker map, so the replay delivers it as the
	// one blocker section a finding gets and the composer persists it with the
	// turn's other blockers; the late advisory carries the non-blocking
	// survivors only. Delivered after the replay, a finding the commit gate had
	// recorded first reached the agent twice in one message, and the persisted
	// record said no blockers.
	const runnerFindingsStart = Date.now();
	// Turn-end delivery is deliberately non-blocking. Collect already-settled
	// results and requeue the rest; the edit path already paid the deferral
	// decision, so another 2s wait would charge every turn while a runner is
	// still in flight (#2122 F5).
	const pendingRunnerFindings = await drainPendingRunnerFindings(0);
	let runnerFindingsDelivered = 0;
	let runnerFindingsStale = 0;
	let runnerFindingsFailed = 0;
	let runnerFindingsDropped = 0;
	/** #3814: blocking survivors newly entered into the blocker map this turn end. */
	let runnerBlockersRecorded = 0;
	/** #3248: bounded per-turn on this lane's own row, never per finding. */
	let runnerFindingsDispositionSuppressed = 0;
	const runnerFindingsDeliveredIds: string[] = [];
	for (const pending of pendingRunnerFindings) {
		const result = pending.result;
		if (!result) continue;
		recordRunner(
			pending.filePath,
			pending.runnerId,
			result.status,
			result.diagnostics.length,
			Date.now() - pending.markedAtMs,
			pending.writeIndex,
		);
		// #3796: a runner whose findings fail its check reports `failed` with
		// `blocking_diagnostics`; that goes through the freshness gate and
		// delivery like a success. Any other failed result (a fault kind, or
		// none) is a broken runner, whatever it carries: the note is kept and
		// any partial findings still deliver. `hasUsableResult` owns the rule.
		if (result.status === "failed" && !hasUsableResult(result)) {
			runnerFindingsFailed += 1;
			const detail = result.failureMessage ? `: ${result.failureMessage}` : "";
			const failedNote = `❌ Deferred runner ${pending.runnerId} failed (${result.failureKind ?? "unknown"})${detail}`;
			// #3813: the drain above removed this settled entry for good. If the
			// cap cuts the note, hand back the failure alone (the findings, if
			// any, are judged on their own part below).
			deliveryHolds.push({
				part: failedNote,
				onHeld: () =>
					requeueRunnerFindings({
						...pending,
						result: { ...result, diagnostics: [] },
					}),
			});
			// @delivery-surface: runtime-turn:late-runner-findings
			advisoryParts.push(failedNote);
		}
		// The survivors are what the agent READS, so they take the same policy
		// stack the late-AUXILIARY drain below applies (#3248). The verdict runs
		// the freshness gate first, then the policy against the file's CURRENT
		// bytes; an unreadable file fails open inside it.
		const verdict = judgeDeferredRunnerFindings(pending, cwd);
		runnerFindingsStale += verdict.stale;
		if (verdict.stale > 0) {
			// The runner answered for bytes older than the latest edit. Do not
			// re-arm this completed answer: only a new runner query can restore
			// coverage for the refreshed bytes.
			dropStaleRunnerFindings(pending);
			runnerFindingsDropped += 1;
		}
		if (verdict.live === 0) continue;
		const displayPath = toRunnerDisplayPath(cwd, pending.filePath);
		const runnerKept = verdict.kept;
		runnerFindingsDispositionSuppressed += verdict.suppressed;
		if (runnerKept.length === 0) {
			// Every late finding was marked. A PUSH surface stays silent rather
			// than re-announcing that the mark is working; the count rides this
			// lane's bounded per-turn row below.
			continue;
		}
		runnerFindingsDelivered += runnerKept.length;
		// #3814: the blocking survivors enter the blocker map (the commit gate's
		// latch, the replay below, a later write to the file clears them). The
		// commit gate may have recorded them already (a replay records 0).
		runnerBlockersRecorded += recordDeferredRunnerBlockers(
			runtime,
			pending,
			runnerKept,
			verdict.bytes,
		);
		for (const finding of runnerKept) {
			if (runnerFindingsDeliveredIds.length < 50) {
				runnerFindingsDeliveredIds.push(finding.id);
			}
		}
		// The replay delivers the blocking survivors; the advisory carries the rest.
		const advisoryKept = runnerKept.flatMap((finding) =>
			finding.semantic === "blocking" ? [] : [finding],
		);
		if (advisoryKept.length === 0) continue;
		const lines = advisoryKept.map(
			(finding) =>
				`  ${displayPath}:${finding.line ?? 1}:${finding.column ?? 1} [${finding.rule ?? finding.id}] ${finding.message}`,
		);
		// #1616 suppressed-bucket rule: a delivery that still has something to
		// say states what it dropped, once per delivery.
		const runnerSuppressedNote =
			verdict.suppressed > 0
				? `; suppressed by disposition: ${verdict.suppressed} finding(s)`
				: "";
		const lateRunnerPart = `⏱️ Late runner diagnostics (${pending.runnerId} completed after the edit${runnerSuppressedNote}):\n${lines.join("\n")}`;
		// #3813: the drain above removed this settled entry for good. If the cap
		// cuts this part, hand back only the NON-blocking half this advisory
		// carried; the blocking survivors live in the blocker map (#3814), which
		// the replay persists for the next turn.
		const {
			failureKind: _kind,
			failureMessage: _message,
			...findingsOnly
		} = result;
		deliveryHolds.push({
			part: lateRunnerPart,
			onHeld: () =>
				requeueRunnerFindings({
					...pending,
					result: findingsResult(advisoryKept, findingsOnly),
				}),
		});
		// @delivery-surface: runtime-turn:late-runner-findings
		advisoryParts.push(lateRunnerPart);
	}
	logLatency({
		type: "phase",
		toolName: "turn_end",
		filePath: cwd,
		phase: "late_runner_findings",
		durationMs: Date.now() - runnerFindingsStart,
		metadata: {
			pending: pendingRunnerFindings.length,
			delivered: runnerFindingsDelivered,
			stale: runnerFindingsStale,
			failed: runnerFindingsFailed,
			dropped: runnerFindingsDropped,
			blockersRecorded: runnerBlockersRecorded,
			dispositionSuppressed: runnerFindingsDispositionSuppressed,
			deliveredIds: runnerFindingsDeliveredIds,
		},
	});

	// #1641: past-EOF gate. Runs BEFORE the dependency-drift sweep below — a
	// cheap statSync per cited file is worth paying first so the pricier
	// import-parsing sweep can skip anything already taken out of the
	// authoritative channel this turn (see blocker-past-eof.ts's module doc
	// for the full composition rule with #1631's gate).
	const blockerPastEofStart = Date.now();
	const blockerPastEof = sweepInlineBlockerPastEof(runtime, cwd);
	logLatency({
		type: "phase",
		toolName: "turn_end",
		filePath: cwd,
		phase: "blocker_past_eof_sweep",
		durationMs: Date.now() - blockerPastEofStart,
		metadata: {
			total: blockerPastEof.total,
			checked: blockerPastEof.checked,
			demoted: blockerPastEof.demoted,
			// #1944 review F3: `healed` is gone. Retirement makes the falling edge
			// unreachable on this store, so the field could only ever log zero —
			// see `BlockerPastEofCounts`.
		},
	});

	/** #1944/#1950: demotions retired after their delivery limit. */
	let demotedFindingsRetired = 0;
	/**
	 * The two inline-blocker commits a hold runs once its advisory reached the
	 * message. The past-EOF retire is #1944's "after this ONE delivery"; the
	 * drift count is #1950's `DEPENDENCY_DRIFT_MAX_DELIVERIES` cap.
	 */
	const retirePastEofOnDelivery =
		(bPath: string, deadLines: readonly number[], displayPath: string) =>
		(): void => {
			if (!runtime.retireDemotedPastEofBlocker(bPath, deadLines)) return;
			// The retire left the commit-gate latch counting a record that is
			// gone, as `retireInlineBlockerAndResyncGuard` does for a clean verdict.
			runtime.updateGitGuardStatus(false, "");
			demotedFindingsRetired += 1;
			// Bounded by the ledger's own per-kind/subject tally, and the subject
			// keeps the discriminating identity (which store, which file).
			incrementDegradationCount({
				kind: "demoted-finding-retired",
				subject: `inline-blocker:${displayPath}`,
				reason: `file shrank past cited line(s) ${deadLines.join(", ")}; retired after one degraded delivery`,
			});
		};
	const countDriftDeliveryOnDelivery =
		(bPath: string, displayPath: string) => (): void => {
			const deliveryCount = runtime.incrementInlineBlockerStaleDelivery(bPath);
			if (deliveryCount < DEPENDENCY_DRIFT_MAX_DELIVERIES) return;
			if (!runtime.retireDemotedDependencyDriftBlocker(bPath)) return;
			runtime.updateGitGuardStatus(false, "");
			demotedFindingsRetired += 1;
			incrementDegradationCount({
				kind: "demoted-finding-retired",
				subject: `inline-blocker:${displayPath}`,
				reason: `capped after ${deliveryCount} deliveries with no re-run; re-run can still confirm`,
			});
		};

	// #1631: freshness gate. A cached blocker is a verdict about the file AND
	// everything it imports; before re-serving it, sweep for out-of-band drift of
	// the file or its forward imports and demote drifted entries to a
	// `[stale — re-run to confirm]` advisory instead of re-asserting them at full
	// authority (#1419 demote-not-drop).
	const blockerFreshnessStart = Date.now();
	// #1790: widen the sweep's population with widget-store rows a cache-served
	// replay populated without ever touching RuntimeCoordinator's inline-blocker
	// map — see blocker-freshness.ts's `WidgetSweepBlockerEntry` doc for why this
	// is injected here rather than imported by blocker-freshness.ts itself.
	const blockerFreshness = await sweepInlineBlockerFreshness(runtime, cwd, {
		// #2982: the hook's own signal, so the self axis's filesystem work is
		// bounded by the same abort everything else in this handler honours.
		...(deps.signal === undefined ? {} : { signal: deps.signal }),
		additionalEntries: getWidgetBlockingFilesForSweep().map((row) => ({
			filePath: row.filePath,
			recordedAtMs: row.recordedAtMs,
			demote: () =>
				markWidgetFileBlockersStale(row.filePath, "dependency-drift"),
		})),
	});
	logLatency({
		type: "phase",
		toolName: "turn_end",
		filePath: cwd,
		phase: "blocker_freshness_sweep",
		durationMs: Date.now() - blockerFreshnessStart,
		metadata: {
			total: blockerFreshness.total,
			kept: blockerFreshness.kept,
			revalidated: blockerFreshness.revalidated,
			alreadyStale: blockerFreshness.alreadyStale,
			truncatedImports: blockerFreshness.truncatedImports,
			selfHealed: blockerFreshness.selfHealed,
			selfUnverifiable: blockerFreshness.selfUnverifiable,
			hashBudgetExhausted: blockerFreshness.hashBudgetExhausted,
		},
	});

	// Re-surface inline blockers from this turn that the agent didn't fix.
	// These were shown inline during write/edit but the agent moved on without resolving them.
	const unresolvedBlockers = runtime.getInlineBlockersSnapshot();
	/** #3246: one bounded record per TURN for the policy pass, never per finding. */
	const inlinePolicyEntries: InlineBlockerPolicyTallyEntry[] = [];
	/**
	 * #3248: files whose EVERY blocker this pass suppressed — the post-policy
	 * survivor set, emptied per file. The commit gate is recomputed from it
	 * below, once, after the loop.
	 */
	const policySuppressedPaths: string[] = [];
	const inlinePolicyStart = Date.now();
	for (const record of unresolvedBlockers) {
		const { filePath: bPath, summary, stale, staleReason } = record;
		const displayPath = toRunnerDisplayPath(cwd, bPath);
		const tally = { displayPath, sources: record.sources };
		if (stale) {
			inlinePolicyEntries.push({ ...tally, stale: true });
			// #1631: demoted — out of the authoritative blocker channel and into the
			// advisory channel with a stale marker, so the agent is told to re-run
			// rather than pressured by a verdict that may already be resolved.
			//
			// #1944: the CHANNEL change is not enough. Until this call the advisory
			// embedded the blocker body verbatim, so the agent read "🔴 STOP — 11
			// issue(s) must be fixed" with dead line numbers under a hedge line it
			// ignored. Degrade the body itself, and — when the file shrank past the
			// cited lines, so no re-run can ever confirm it — retire the record
			// after this ONE delivery instead of re-serving it for the rest of the
			// session.
			const deadLines = blockerPastEof.deadLinesByPath.get(bPath) ?? [];
			const degraded = degradeDemotedFindingBody(summary, { deadLines });
			// #3813: asked, not retired. The retire runs once the cap has let
			// this part through (the hold below); a cut part leaves it pending.
			const retires = runtime.wouldRetireDemotedPastEofBlocker(
				bPath,
				deadLines,
			);
			let retirementNote: string | undefined;
			if (retires) {
				retirementNote = formatRetirementNote(deadLines);
			} else if (staleReason === "dependency-drift") {
				// #1950: a dependency-drift demotion is recoverable (its coordinates
				// are still in bounds), so it does NOT retire after one delivery like
				// the past-EOF case above — but nothing capped how many times the
				// SAME demoted-but-unconfirmed record re-serves, and incident data
				// showed repeat deliveries carrying near-zero information after the
				// first. Cap it at DEPENDENCY_DRIFT_MAX_DELIVERIES instead.
				//
				// The count driving THIS render is a peek (fix-round F1): the actual
				// increment is the hold's `onDelivered`, committed only once this
				// turn's content is known to reach the agent, so neither a
				// suppressed turn's tentative render nor a part the cap cut ever
				// advances the stored count.
				const tentativeCount =
					runtime.peekInlineBlockerStaleDeliveryCount(bPath) + 1;
				if (tentativeCount >= DEPENDENCY_DRIFT_MAX_DELIVERIES) {
					retirementNote = formatDeliveryCapNote(tentativeCount);
				}
			}
			const advisoryPart =
				`${STALE_LINE_MARKER} ${displayPath}:\n${degraded.body}` +
				(retirementNote ? `\n${retirementNote}` : "");
			// @delivery-surface: runtime-turn:unresolved-inline-blocker
			advisoryParts.push(advisoryPart);
			if (retires) {
				deliveryHolds.push({
					part: advisoryPart,
					onDelivered: retirePastEofOnDelivery(bPath, deadLines, displayPath),
				});
			} else if (staleReason === "dependency-drift") {
				deliveryHolds.push({
					part: advisoryPart,
					onDelivered: countDriftDeliveryOnDelivery(bPath, displayPath),
					skipOnSuppressed: true,
				});
			}
		} else {
			// #3246: the agent may have marked one of these blockers
			// `false-positive` AFTER the record was written, via
			// `lens_diagnostic_mark` — which every other findings surface honors.
			// Re-derive the body from the record's structured diagnostics through
			// the shared `dispatch/finding-policy.ts` stack against the file's
			// CURRENT bytes, exactly as the late-auxiliary lane below does.
			const policy = applyInlineBlockerPolicy(record, cwd);
			inlinePolicyEntries.push({ ...tally, stale: false, outcome: policy });
			if (policy.body === undefined) {
				// Every blocker on this file was suppressed. This is a PUSH
				// surface: silence after a mark is the mark working, not a clean
				// verdict, so the count rides the bounded per-turn record below
				// instead of announcing the suppression on every later turn.
				policySuppressedPaths.push(bPath);
				continue;
			}
			// #1616 suppressed-bucket rule: a delivery that still has something to
			// say states what it dropped, once per delivery.
			const suppressedNote =
				policy.suppressed > 0
					? ` (suppressed by disposition: ${policy.suppressed} finding(s))`
					: "";
			// @delivery-surface: runtime-turn:unresolved-inline-blocker
			blockerParts.push(
				`Unresolved from this turn — ${displayPath}${suppressedNote}:\n${policy.body}`,
			);
		}
	}
	// #3248: the post-policy survivor set per file is FINAL here. The commit
	// gate reads a latch (`gitGuardHasBlockers`) before it ever reads the
	// persisted record, and the policy wrote neither — so a file whose every
	// blocker was just suppressed kept blocking `git commit` while the banner
	// above said nothing about it. Recompute the latch from this set; the
	// persisted record is rewritten or cleared further down by the writer that
	// already owns it (`:4287` / `:4379`), from the same survivor set, and that
	// clear is gated on the latch recomputed here.
	const guardLatchBefore = runtime.gitGuardHasBlockers;
	resyncGitGuardAfterInlinePolicy({
		runtime,
		suppressedFilePaths: policySuppressedPaths,
	});
	if (inlinePolicyEntries.length > 0) {
		logLatency({
			type: "phase",
			toolName: "turn_end",
			filePath: cwd,
			phase: "inline_blocker_policy",
			durationMs: Date.now() - inlinePolicyStart,
			metadata: {
				...summarizeInlineBlockerPolicy(inlinePolicyEntries),
				// #3248: one row per TURN for the gate outcome, never per finding
				// — the flip is the event a reader needs to explain why a commit
				// that was blocked is now allowed.
				guardFilesSuppressed: policySuppressedPaths.length,
				guardLatchCleared: guardLatchBefore && !runtime.gitGuardHasBlockers,
			},
		});
	}

	// Drain the deferred cascade computes kicked off this turn (#450). They ran
	// concurrently off the write hot path; wait a bounded time for them here so
	// their runs are available to the merge below. A compute still in flight at
	// the cap is carried over to the next turn_end (never dropped).
	// #4161: the settle takes the parked computes at the call and writes them
	// back after its own await; `generation` fences both ends to this turn's
	// session.
	const cascadeSettleStart = Date.now();
	const { settled, timedOut } = await runtime.settleCascadeRuns(
		cascadeSettleWaitMs(),
		{ trackTurnEndClock: true, generation: holdScope },
	);
	logLatency({
		type: "phase",
		toolName: "turn_end",
		filePath: cwd,
		phase: "cascade_settle_wait",
		durationMs: Date.now() - cascadeSettleStart,
		metadata: { settled, timedOut },
	});

	// Merge accumulated cascade results from all pipeline runs this turn.
	// Two-pass dedup:
	//   1. Primary-level: dedup by primary file (last writer wins).
	//   2. Neighbor-level: each neighbor is claimed by the latest cascade result
	//      that covers it — suppresses stale neighbor state from earlier writes.
	const t0 = Date.now();
	const cascadeRuns = (
		holdScope.guardedWrite("turn-end:cascade-runs", () =>
			runtime.consumeCascadeRuns(),
		) ?? []
	).filter((run) => {
		const originSeq = run.origin?.projectSeq;
		const originTurn = run.origin?.turnSeq;
		// A deferred result from AFTER a later write is not current state. Old test
		// fixtures without provenance remain accepted for compatibility.
		//
		// #1443: `turnSeq` alone is NOT a supersede signal, and it used to be an
		// unconditional reject. Every LATE run — one whose compute missed the
		// settle cap and was re-parked by `settleCascadeRuns`, and one the
		// quiet-window reconcile appended after this turn's predecessor already
		// consumed (carried across turn_start by `beginTurn`) — is BY DEFINITION
		// from an earlier turn, so `originTurn === runtime.turnIndex` was always
		// false for exactly the runs the carry-over was built to preserve. Both
		// producers' contracts were dead code: the measured cases were the two
		// highest-fan-out cascades of the day (38 and 40 neighbours).
		//
		// R2 (#1443 follow-up): `projectSeq` alone is NOT a per-file supersede
		// signal — it is GLOBAL, advancing on every pi-observed write anywhere in
		// the project. Rejecting on any mismatch meant an edit to an unrelated
		// file superseded a run that had nothing to do with it, reintroducing the
		// exact 38/40-neighbour loss #1443 was written to fix, one filter down.
		// `getFilesChangedSince` (#451) is the honest per-file signal: a run is
		// superseded only if its own primary file or one of its neighbours was
		// actually rewritten since it launched. A late-but-not-superseded run is
		// surfaced; a superseded one is dropped with a RECORD (never silently),
		// so the loss stays countable.
		if (originSeq !== undefined) {
			const changedSince = runtime.getFilesChangedSince(originSeq);
			if (changedSince.length > 0) {
				const changedSet = new Set(changedSince);
				const primaryKey = normalizeMapKey(path.resolve(run.filePath));
				const neighborKeys = [
					...(run.result?.neighbors ?? []).map((n) => n.filePath),
					...(run.selectedNeighborPaths ?? []),
				].map((filePath) => normalizeMapKey(path.resolve(filePath)));
				const supersededByOwnFile =
					changedSet.has(primaryKey) ||
					neighborKeys.some((k) => changedSet.has(k));
				if (supersededByOwnFile) {
					logCascade({
						phase: "cascade_carry_over_drop",
						filePath: run.filePath,
						neighborCount: run.neighborCount,
						diagnosticCount: run.diagnosticCount,
						reason: "superseded_by_later_write",
						metadata: {
							originProjectSeq: originSeq,
							projectSeq: runtime.projectSeq,
							originTurnSeq: originTurn,
							turnIndex: runtime.turnIndex,
							carriedTurns: run.carriedTurns,
							changedFiles: changedSince,
						},
					});
					return false;
				}
			}
		}
		return true;
	});
	const cascadeResults = cascadeRuns.flatMap((r) =>
		r.result ? [r.result] : [],
	);
	// Fix B (#3167): which results belong to a CARRIED run — the label is
	// per-result at render time, so the run→result pairing must survive the
	// flatMap above (which discards the wrapper).
	// Fix B (#3168 F6): the success-path record — latency.log could not show
	// the feature ever rendered without it (the only phases were the drop/
	// settle records). One bounded record per turn, emitted after both render
	// sections below.
	let carriedRunsRendered = 0;
	let labeledAdvisories = 0;
	const carriedMetaByResult = new Map<
		NonNullable<(typeof cascadeRuns)[number]["result"]>,
		{ carriedTurns: number; observedAt: number | undefined }
	>();
	// #3813: the run behind each result, so a section the cap cuts can hand
	// exactly the runs it rendered back to the coordinator.
	const runByResult = new Map<
		NonNullable<(typeof cascadeRuns)[number]["result"]>,
		(typeof cascadeRuns)[number]
	>();
	for (const r of cascadeRuns) {
		if (r.result) runByResult.set(r.result, r);
		if (r.result && (r.carriedTurns ?? 0) > 0 && r.carriedTurns !== undefined) {
			carriedMetaByResult.set(r.result, {
				carriedTurns: r.carriedTurns,
				observedAt: r.observedAt,
			});
		}
	}
	// #3813: `consumeCascadeRuns` drained every run before the cap runs. A run
	// whose rendering the cap cuts goes back through `appendCascadeRun`, so
	// `beginTurn` carries it to the next turn_end within its existing one-turn
	// carry bound. A coverage advisory hands back the run WITHOUT its result:
	// the section rides ahead of every advisory, so a run whose advisory is cut
	// may have had its section delivered, and must not deliver it twice.
	// #1550 class sweep: every cascade record below summarises `cascadeResults`
	// — runs, which carry their own paths and can be carried across turns
	// (#1443) — so labelling them with the turn's first EDITED file is the same
	// mis-attribution the `cascade_indeterminate` fix removes. On a read-only
	// drain turn `files` is empty and the old `?? cwd` fallback stamped a bare
	// DIRECTORY as the record's file. These three are turn-level AGGREGATES (no
	// per-file cause is claimed), so one label suffices; the edited file and cwd
	// stay as fallbacks.
	const cascadeLogFilePath = cascadeResults[0]?.filePath ?? files[0] ?? cwd;
	if (cascadeResults.length > 0) {
		const seen = new Map<string, (typeof cascadeResults)[number]>();
		for (const result of cascadeResults) {
			seen.set(normalizeMapKey(result.filePath), result);
		}
		// Iterate in reverse so the latest result claims each neighbor first.
		const neighborOwner = new Map<string, string>();
		for (const result of [...seen.values()].reverse()) {
			const pk = normalizeMapKey(result.filePath);
			for (const n of result.neighbors) {
				const nk = normalizeMapKey(n.filePath);
				if (!neighborOwner.has(nk)) neighborOwner.set(nk, pk);
			}
		}
		const parts: string[] = [];
		const sectionRuns: Array<(typeof cascadeRuns)[number]> = [];
		// #1446 item 1: track what actually gets injected — a suppressed result
		// (real formatted cascade text, but every one of its neighbors was claimed
		// by a LATER result — see the reverse-iteration ownership pass above) was
		// previously indistinguishable from "no output"; this counts it explicitly
		// instead of letting it vanish.
		let injectedNeighborCount = 0;
		let injectedDiagnosticCount = 0;
		let suppressedByOwnership = 0;
		for (const result of seen.values()) {
			const pk = normalizeMapKey(result.filePath);
			const ownsAny = result.neighbors.some(
				(n) => neighborOwner.get(normalizeMapKey(n.filePath)) === pk,
			);
			if (ownsAny && result.formatted) {
				// Fix B (#3167/#3168): a carried run's re-rendered blocker is labeled
				// so the agent can tell it from a fresh observation — with the
				// run's own observation age (#3168 F3).
				const carryMeta = carriedMetaByResult.get(result);
				const carrySuffix = cascadeCarrySuffix(
					carryMeta?.carriedTurns,
					carryMeta?.observedAt,
				);
				parts.push(
					carrySuffix
						? `${result.formatted}\n${carrySuffix}`
						: result.formatted,
				);
				if (carrySuffix) carriedRunsRendered += 1;
				const sectionRun = runByResult.get(result);
				if (sectionRun) sectionRuns.push(sectionRun);
				injectedNeighborCount += result.neighbors.length;
				injectedDiagnosticCount += result.neighbors.reduce(
					(s, n) => s + n.diagnostics.length,
					0,
				);
			} else if (!ownsAny && result.formatted) {
				suppressedByOwnership++;
			}
		}
		// Suggest tests for cascade neighbors (files with diagnostics)
		const neighborFilesWithErrors = cascadeResults
			.flatMap((r) => r.neighbors)
			.filter((n) => n.diagnostics.length > 0)
			.map((n) => n.filePath);
		const uniqueNeighborFiles = [...new Set(neighborFilesWithErrors)];
		let testSuggestionCount = 0;
		if (
			uniqueNeighborFiles.length > 0 &&
			typeof testRunnerClient.suggestTestFiles === "function"
		) {
			const testSuggestions = testRunnerClient.suggestTestFiles(
				uniqueNeighborFiles,
				cwd,
			);
			testSuggestionCount = testSuggestions.length;
			// #1446 item 2: this path previously emitted nothing to any log — a
			// zero-suggestion outcome (neighbors had errors but no test file
			// resolved for any of them) is the more interesting case, so it is
			// recorded on the same phase rather than only logging on a hit.
			logCascade({
				phase: "cascade_test_targets",
				filePath: cascadeLogFilePath,
				neighborCount: uniqueNeighborFiles.length,
				metadata: {
					neighborFiles: uniqueNeighborFiles.slice(0, 10),
					suggestedTestFiles: testSuggestions
						.slice(0, 10)
						.map((s) => s.testFile),
					runner: testSuggestions[0]?.runner,
					truncated: testSuggestions.length > 10,
					zeroSuggestions: testSuggestions.length === 0,
				},
			});
			if (testSuggestions.length > 0) {
				const testLines = testSuggestions
					.slice(0, 5)
					.map(
						(s) => `  ${toRunnerDisplayPath(cwd, s.testFile)} (${s.runner})`,
					);
				let testSection = `🧪 Likely tests for affected neighbors:\n${testLines.join("\n")}`;
				if (testSuggestions.length > 5) {
					testSection += `\n  ... and ${testSuggestions.length - 5} more`;
				}
				parts.push(testSection);
			}
		}
		if (parts.length > 0) {
			const section = parts.join("\n\n");
			// @delivery-surface: runtime-turn:cascade-blocker
			blockerParts.push(section);
			deliveryHolds.push({
				part: section,
				onHeld: () => {
					for (const run of sectionRuns) runtime.appendCascadeRun(run);
				},
			});
			// #1446 item 1: proves the cascade section reached `blockerParts` —
			// i.e. it was QUEUED for persistence into the turn-end advisory — not
			// that it reached the agent. The counters alone (cascade_result,
			// cascade_turn_end) never confirmed even that much, only computation.
			// Actual delivery happens later, via consumeTurnEndFindings/
			// peekTurnEndFindings, and can still be suppressed after this point
			// (e.g. allFilesDeleted, cross-turn dedup, or the session ending
			// before the next turn_end drains it) — this record does not prove
			// the agent ever saw the text.
			logCascade({
				phase: "cascade_injected",
				filePath: cascadeLogFilePath,
				neighborCount: injectedNeighborCount,
				diagnosticCount: injectedDiagnosticCount,
				metadata: {
					sectionChars: section.length,
					testSuggestionCount,
					suppressedByOwnership,
				},
			});
		}
		logCascade({
			phase: "cascade_turn_end",
			filePath: cascadeLogFilePath,
			neighborCount: cascadeResults.reduce((s, r) => s + r.neighbors.length, 0),
			diagnosticCount: cascadeResults.reduce(
				(s, r) =>
					s + r.neighbors.reduce((ns, n) => ns + n.diagnostics.length, 0),
				0,
			),
			metadata: {
				fileCount: cascadeResults.length,
				mergedResults: seen.size,
			},
		});
	}
	// #1023: surface an HONEST note whenever a cascade run could not compute
	// downstream impact (degraded/over-cap graph, missing node, a thrown compute,
	// or a deliberately budget-truncated neighbor set) — never a silent all-clear
	// (#533). This goes to the ADVISORY tier,
	// NOT the blocker tier: in an over-cap monorepo the graph is `skipped` on
	// every edit, so a blocker would fire hard and never clear turn state every
	// turn (over-escalation — the mirror of the silent-all-clear bug). Advisory
	// still reaches the agent, just without the blocker mechanics. Keyed strictly
	// off the `indeterminate` marker threaded by the compute; a healthy build
	// with a genuinely empty dependent set carries no marker and stays silent
	// (over-correction guard).
	const indeterminateRuns = cascadeRuns.filter((r) => r.indeterminate);
	if (indeterminateRuns.length > 0) {
		// #1104 (review P3 on PR #1143, rides with the resultId main body): this
		// preamble used to hardcode a graph-unavailability frame for EVERY
		// indeterminate reason. That's accurate for `graph_degraded`/
		// `missing_node`/`error` (the graph really couldn't produce a dependent
		// set), but `lsp_binding_rejected` is a DIFFERENT failure shape — the
		// graph WAS available and dependents WERE derived; only their LSP
		// diagnostics display was withheld because a fallback snapshot's content
		// binding didn't match current disk. Saying "the review graph was
		// unavailable" for that case mis-attributes the cause. Bucket by reason
		// family so each gets its own accurate frame.
		const buildAdvisory = (
			runs: typeof indeterminateRuns,
			frame: {
				lead: (fileCount: number, reasons: string) => string;
				fallbackDetail: (r: (typeof indeterminateRuns)[number]) => string;
			},
		): string | undefined => {
			if (runs.length === 0) return undefined;
			const byDetail = new Map<string, string[]>();
			for (const r of runs) {
				const detail = r.indeterminate?.detail ?? frame.fallbackDetail(r);
				const files = byDetail.get(detail) ?? [];
				files.push(toRunnerDisplayPath(cwd, r.filePath));
				byDetail.set(detail, files);
			}
			const lines: string[] = [];
			for (const [detail, filesRaw] of byDetail) {
				const files = [...new Set(filesRaw)];
				const shown = files.slice(0, 5).join(", ");
				const more = files.length > 5 ? ` (+${files.length - 5} more)` : "";
				lines.push(`  • ${detail}: ${shown}${more}`);
			}
			const fileCount = new Set(runs.map((r) => normalizeMapKey(r.filePath)))
				.size;
			const reasons = [...byDetail.keys()].join("; ");
			return `${frame.lead(fileCount, reasons)}\n${lines.join("\n")}`;
		};

		// #1445: `excluded_by_role` (test files excluded from the graph BY DESIGN,
		// #260) is never agent-facing — it is not a graph failure, and #1080
		// already excludes test-role files from every neighbor surface, so "a
		// clean result does not cover them" would itself be a false claim. It
		// stays visible in the `cascade_indeterminate` log below (metadata-only,
		// info-level) so the log can tell an intentional exclusion from a real
		// graph gap, but it never reaches `buildAdvisory`/the agent.
		const graphRuns = indeterminateRuns.filter(
			(r) =>
				r.indeterminate?.reason !== "lsp_binding_rejected" &&
				r.indeterminate?.reason !== "excluded_by_role" &&
				r.indeterminate?.reason !== "budget_truncated" &&
				r.indeterminate?.budget === undefined,
		);
		const bindingRuns = indeterminateRuns.filter(
			(r) =>
				r.indeterminate?.reason === "lsp_binding_rejected" &&
				r.indeterminate?.budget === undefined,
		);
		// Budget coverage can be merged into a graph or binding marker, so its
		// advisory bucket follows the evidence rather than replacing that reason.
		const budgetRuns = indeterminateRuns.filter(
			(r) =>
				r.indeterminate?.reason === "budget_truncated" ||
				r.indeterminate?.budget !== undefined,
		);

		// Factual/informational phrasing — the advisory tier wraps this with an
		// "ℹ️ Advisory — no action required this turn:" label, so an imperative
		// ("review dependents manually") would contradict it. The #533 substance
		// stays: a clean cascade result does NOT cover these files' dependents.
		// Fix B (#3167/#3168 F4): a coverage advisory computed from a CARRIED
		// indeterminate run describes the previous turn's evidence — label it so
		// the absence-of-coverage statement is not read as current. A MIXED
		// bucket (some carried, some fresh) is left UNLABELED: a Math.max
		// suffix on the finished multi-line advisory would attach the carry to
		// a file that was not carried.
		const withCarryLabel = (
			advisory: string | undefined,
			runs: ReadonlyArray<{ carriedTurns?: number; observedAt?: number }>,
		): string | undefined => {
			if (advisory === undefined) return undefined;
			const carried = runs.filter((r) => (r.carriedTurns ?? 0) > 0);
			if (carried.length === 0 || carried.length !== runs.length) {
				return advisory;
			}
			// #3168 F13: the bucket's age is the OLDEST carried observation, and
			// only when EVERY carried run carries one. A `Math.min` sentinel
			// (`?? Number.MAX_SAFE_INTEGER`) silently ignored the unstamped runs
			// and stated a confident age for a bucket that contains an unaged
			// one; one missing stamp collapses the age half to the helper's
			// neutral "scan age unknown" wording instead.
			const stamps = carried.map((r) => r.observedAt);
			const observedAt = stamps.every((s): s is number => s !== undefined)
				? Math.min(...stamps)
				: undefined;
			const suffix = cascadeCarrySuffix(carried[0]?.carriedTurns, observedAt);
			if (!suffix) return advisory;
			labeledAdvisories += 1;
			// #3168 F11: newline, as the blocker path does above. A space join
			// welded the suffix onto the LAST bullet of a multi-bullet advisory,
			// so the carry label read as a property of that one file.
			return `${advisory}\n${suffix}`;
		};
		const holdAdvisory = (
			advisory: string | undefined,
			runs: typeof indeterminateRuns,
		): void => {
			if (advisory === undefined) return;
			deliveryHolds.push({
				part: advisory,
				onHeld: () => {
					for (const run of runs)
						runtime.appendCascadeRun({ ...run, result: undefined });
				},
			});
		};
		const graphAdvisory = withCarryLabel(
			buildAdvisory(graphRuns, {
				lead: (fileCount, reasons) =>
					`Cascade could not compute downstream impact for ${fileCount} edited file(s) this turn — ` +
					`the review graph was unavailable (${reasons}), so their dependents were not ` +
					`cascade-checked and a clean cascade result does not cover them.`,
				fallbackDetail: (r) =>
					r.indeterminate?.reason === "missing_node"
						? "changed file not in the review graph"
						: "review graph unavailable",
			}),
			graphRuns,
		);
		// @delivery-surface: runtime-turn:cascade-coverage-advisory
		if (graphAdvisory) advisoryParts.push(graphAdvisory);
		holdAdvisory(graphAdvisory, graphRuns);

		const bindingAdvisory = withCarryLabel(
			buildAdvisory(bindingRuns, {
				lead: (fileCount, reasons) =>
					`Cascade identified dependents for ${fileCount} edited file(s) this turn, but their ` +
					`diagnostics could not be freshly confirmed (${reasons}) and were withheld — a clean ` +
					`cascade result does not cover them.`,
				fallbackDetail: () => "cascade diagnostics withheld (binding rejected)",
			}),
			bindingRuns,
		);
		// @delivery-surface: runtime-turn:cascade-coverage-advisory
		if (bindingAdvisory) advisoryParts.push(bindingAdvisory);
		holdAdvisory(bindingAdvisory, bindingRuns);

		const budgetAdvisory = withCarryLabel(
			buildAdvisory(budgetRuns, {
				lead: (fileCount, reasons) =>
					`Cascade checked the selected neighbors for ${fileCount} edited file(s) this turn, ` +
					`but some eligible dependents were not checked because the cascade budget ` +
					`was exhausted (${reasons}); a clean cascade result does not cover them.`,
				fallbackDetail: (r) => {
					const budget = r.indeterminate?.budget;
					if (!budget) return "cascade budget omitted eligible dependents";
					const detail = `cascade budget checked ${budget.selectedCount} of ${budget.eligibleCount} eligible dependents (${budget.truncatedCount} omitted)`;
					return budget.transitiveTruncated
						? `${detail}; transitive expansion was capped before all eligible dependents were enumerated`
						: detail;
				},
			}),
			budgetRuns,
		);
		// @delivery-surface: runtime-turn:cascade-coverage-advisory
		if (budgetAdvisory) advisoryParts.push(budgetAdvisory);
		holdAdvisory(budgetAdvisory, budgetRuns);

		const fileCount = new Set(
			indeterminateRuns.map((r) => normalizeMapKey(r.filePath)),
		).size;
		// #1550: attribute each reason to the file that PRODUCED it. This record
		// used to stamp `filePath: files[0] ?? cwd` — the turn's first EDITED file
		// — and a bare `reasons` array with no file association. The two sets are
		// disjoint: a run can be carried across turns (#1443), and an edited file
		// can skip the graph entirely (markdown/JSON return `non_code` before
		// computeImpactCascade ever runs). So the log blamed a file that could not
		// have produced the reason — a markdown file credited with `missing_node`,
		// a non-test source file credited with `excluded_by_role` — and the defect
		// read as "concentrated on test files" only because the first edited file
		// of a turn usually is one. `fileCount` and the agent-facing advisory
		// already keyed off `r.filePath`; only this record's labels did not.
		const byFile = indeterminateRuns.map((r) => ({
			file: toRunnerDisplayPath(cwd, r.filePath),
			reason: r.indeterminate?.reason,
			...(r.indeterminate?.detail && { detail: r.indeterminate.detail }),
			...(r.indeterminate?.budget && { budget: r.indeterminate.budget }),
			...(r.indeterminate?.diagnostic && {
				diagnostic: r.indeterminate.diagnostic,
			}),
		}));
		logCascade({
			phase: "cascade_indeterminate",
			// The first indeterminate run's own file. `files[0] ?? cwd` survives only
			// as a last resort for a run with no path at all.
			filePath: indeterminateRuns[0]?.filePath ?? files[0] ?? cwd,
			metadata: {
				fileCount,
				reasons: indeterminateRuns.map((r) => r.indeterminate?.reason),
				byFile: byFile.slice(0, 20),
				...(byFile.length > 20 && { byFileTruncated: byFile.length - 20 }),
			},
		});
	}

	// Fix B (#3168 F6): the success-path record — see the counters above.
	if (carriedRunsRendered > 0 || labeledAdvisories > 0) {
		logCascade({
			phase: "cascade_carry_rendered",
			filePath: cascadeLogFilePath,
			metadata: { carriedRunsRendered, labeledAdvisories },
		});
	}

	const cascadeSkipped: Record<CascadeSkipReason, number> = {
		blockers: 0,
		non_code: 0,
		no_neighbors: 0,
		clean: 0,
		indeterminate: 0,
		error: 0,
	};
	for (const r of cascadeRuns) {
		if (r.skipReason)
			cascadeSkipped[r.skipReason] = (cascadeSkipped[r.skipReason] ?? 0) + 1;
	}
	logLatency({
		type: "phase",
		toolName: "turn_end",
		filePath: cwd,
		phase: "cascade_merge",
		durationMs: Date.now() - t0,
		metadata: {
			runsTotal: cascadeRuns.length,
			resultCount: cascadeResults.length,
			neighborCount: cascadeRuns.reduce((s, r) => s + r.neighborCount, 0),
			diagnosticCount: cascadeRuns.reduce((s, r) => s + r.diagnosticCount, 0),
			skipped: cascadeSkipped,
		},
	});

	type KnipTurnMeta = {
		skipped?: boolean;
		/** `deferred`: the scan outlived the turn_end budget and runs on, off-hook (#3872). */
		execution?: "executed" | "cache" | "deferred";
		success?: boolean;
		totalIssues?: number;
		newIssues?: number;
		/** #3901: items re-offered because the cap cut them on the previous turn. */
		reOffered?: number;
		blockerIssues?: number;
		/** #3248: findings dropped by a stored disposition before rendering. */
		dispositionSuppressed?: number;
		reason?: string;
		/** Set when the failure was an availability verdict, not a knip run. */
		failureKind?: string;
		/** True when a failed run left the previous good cache in place (#1467). */
		cacheKept?: boolean;
		/** The hook's own signal fired while the scan was awaited (Escape). */
		aborted?: boolean;
		/** #3872: this root's last two scans both outlasted the budget left (this is the shorter), so it was not awaited. */
		scanFloorMs?: number;
		/** #3872: linked worktrees nested under the root, which knip walks as project files. */
		nestedWorktrees?: number;
		/** #3872: files with issues dropped from the result for living in one. */
		nestedFilesDropped?: number;
	};
	// #3872: knip runs in the checkout that owns each edit. A linked worktree is
	// its own project; the session root would walk it as a nested copy of the
	// whole tree (live: +300 issues per worktree, a 7 s scan past a 3 s budget).
	const knipScan = resolveKnipScanRoots(cwd, files);
	for (const root of knipScan.overCap) {
		incrementDegradationCount({
			kind: "turn-end-knip-root-skipped",
			subject: "root-cap",
			reason: `${toRunnerDisplayPath(cwd, root)} not scanned: more than ${MAX_KNIP_ROOTS_PER_TURN} checkouts edited this turn`,
		});
	}
	/**
	 * What a root whose last scan outlasted the budget is still given to answer:
	 * one timer tick, which a memo hit (microtasks) beats and a real scan loses to.
	 */
	const KNOWN_SLOW_KNIP_GRACE_MS = 1;
	/** Issues each knip section names; a cut section parks exactly these (#3901). */
	const KNIP_MAX_SHOWN = 5;
	/** One checkout's finished scan: cache write, delta, delivery. `scanRoot === cwd` is the session checkout. */
	const applyKnipResult = (
		scanRoot: string,
		prevKnip: CacheEntry<KnipResult> | null,
		knipResult: KnipResult,
		rowNow: { data: { success: boolean } } | null,
	): KnipTurnMeta => {
		// Never overwrite a good scan with a failure (#925, #1467): the last
		// good result stays until a new successful scan replaces it. `rowNow` is
		// the row on disk once the scan settled, not `prevKnip` (#4154 V1).
		const knipWouldPoison = wouldPoisonCache(rowNow, knipResult);
		if (knipWouldPoison) {
			dbg(
				`turn_end: keeping last good knip cache; this run failed: ${knipResult.summary}`,
			);
		} else {
			cacheManager.writeCache("knip", knipResult, scanRoot);
		}
		const knipMeta: KnipTurnMeta = {
			execution: knipResult.execution ?? "executed",
			success: knipResult.success,
			totalIssues: knipResult.issues.length,
			newIssues: 0,
			blockerIssues: 0,
			// #3248: bounded per-turn, on the row this lane already writes —
			// never one record per finding.
			dispositionSuppressed: 0,
			...(!knipResult.success && { reason: knipResult.summary }),
			...(knipResult.failureKind && { failureKind: knipResult.failureKind }),
			...(knipResult.nestedWorktrees !== undefined && {
				nestedWorktrees: knipResult.nestedWorktrees,
				nestedFilesDropped: knipResult.nestedFilesDropped,
			}),
			...(knipWouldPoison && { cacheKept: true }),
		};

		// #3901: items the cap cut on the previous turn. A scan that did not
		// succeed leaves them parked for the next one; a successful scan takes
		// them (offered once) and re-checks each below.
		// One lane per part kind: both parts of one scan are cut together (the cap
		// that cuts a blocker always cuts the advisory behind it), and a park
		// REPLACES its lane's entry (review r1 F1).
		const knipBlockerLane = carryLane("knip", scanRoot, "blocker");
		const knipAdvisoryLane = carryLane("knip", scanRoot, "advisory");
		const parkedKnip = knipResult.success
			? [
					...takeParked<KnipIssue>(knipBlockerLane),
					...takeParked<KnipIssue>(knipAdvisoryLane),
				]
			: [];
		if (knipResult.success && knipResult.issues.length > 0) {
			// Deliberately excludes the line number — see stableFindingKey's
			// doc comment (#1483: mirrors the dead-code fix in #1477).
			const issueKey = (i: KnipIssue) =>
				stableFindingKey(i.type, i.file, i.name, i.package);
			const prevKeys = new Set((prevKnip?.data?.issues ?? []).map(issueKey));
			const modifiedSet = new Set(files.map((f) => resolveRunnerPath(cwd, f)));

			const newIssues = knipResult.issues.filter((issue) => {
				if (prevKeys.has(issueKey(issue))) return false;
				if (!issue.file) return false;
				const abs = resolveRunnerPath(scanRoot, issue.file);
				return modifiedSet.has(abs);
			});
			knipMeta.newIssues = newIssues.length;
			// #3901: a parked item is offered again only while this scan still
			// reports it (a fixed one is not re-announced), as this scan's own
			// record of it. It bypasses the baseline and the edited-file gate: the
			// cut turn overwrote the one and may have retired the other.
			const reOffered = stillReportedParked(
				parkedKnip,
				knipResult.issues,
				issueKey,
				new Set(newIssues.map(issueKey)),
			);
			const reOfferedKeys = new Set(reOffered.map(issueKey));
			if (reOffered.length > 0) knipMeta.reOffered = reOffered.length;
			if (newIssues.length > 0) {
				projectDiagnosticsDelta.push(
					...knipIssuesToProjectDiagnostics(scanRoot, newIssues),
				);
				projectDiagnosticsSources.add("knip");
			}

			// #3248: what the agent READS goes through the same stored-
			// disposition filter every other findings surface applies, keyed off
			// knip's OWN `ProjectDiagnostic` adapter — the identity
			// `lens_diagnostics` surfaces and `lens_diagnostic_mark` anchors
			// against — so a marked finding stops re-reporting here. The
			// `projectDiagnosticsDelta` push above deliberately keeps the
			// UNFILTERED set: that record is what the scan found, and its reader
			// (`lens_diagnostics`) applies dispositions on read, so filtering it
			// here would apply the same policy twice on one lane.
			// Paired through `flatMap` rather than indexing the adapter's array:
			// `knipIssuesToProjectDiagnostics` is a straight `issues.map(...)`
			// (one diagnostic per issue, never empty), so this keeps the pairing
			// total while staying honest under `noUncheckedIndexedAccess`.
			const knipPaired = [...newIssues, ...reOffered].flatMap((issue) =>
				knipIssuesToProjectDiagnostics(scanRoot, [issue]).map((diagnostic) => ({
					issue,
					diagnostic,
				})),
			);
			const knipFiltered = filterFindingsByDisposition(
				knipPaired,
				cwd,
				(pair) => pair.diagnostic,
			);
			const knipDeliverable = {
				kept: knipFiltered.kept.map((pair) => pair.issue),
				suppressed: knipFiltered.suppressed,
			};
			knipMeta.dispositionSuppressed = knipDeliverable.suppressed;
			// Issue files are relative to the scan root; the agent reads paths
			// relative to the session.
			const displayPath = (issue: KnipIssue): string =>
				issue.file
					? toRunnerDisplayPath(cwd, resolveRunnerPath(scanRoot, issue.file))
					: "(unknown)";

			const blockerIssues = knipDeliverable.kept.filter(
				(i) => i.type === "unlisted" || i.type === "bin",
			);
			knipMeta.blockerIssues = blockerIssues.length;
			if (blockerIssues.length > 0) {
				let report =
					"🔴 New unresolved imports/deps in modified code (Knip):\n";
				let firstPath: string | null = null;
				for (const issue of blockerIssues.slice(0, KNIP_MAX_SHOWN)) {
					const display = displayPath(issue);
					if (!firstPath && display !== "(unknown)") firstPath = display;
					report += `  ${display}${issue.line ? `:${issue.line}` : ""} — ${issue.type}: ${issue.name}\n`;
				}
				if (firstPath) {
					report += `  First location: ${firstPath}\n`;
				}
				// @delivery-surface: runtime-turn:knip-blocker
				blockerParts.push(report);
				deliveryHolds.push(
					cutAdvisoryHold(
						"knip",
						knipBlockerLane,
						report,
						blockerIssues.slice(0, KNIP_MAX_SHOWN),
						(issue) => reOfferedKeys.has(issueKey(issue)),
					),
				);
			}

			// Turn-end injects only this turn's HIGH-CONFIDENCE, ATTRIBUTABLE
			// delta: symbols in files the agent just edited that became unused
			// (weren't flagged in the previous scan) — low-volume and actionable
			// now. The FULL project-wide dead-code picture is deliberately NOT
			// injected per turn (hundreds of mostly-pre-existing findings would
			// drown the blockers and burn context every turn); it's available
			// on demand via lens_diagnostics. The delta also feeds the session-slop
			// record (`projectDiagnosticsDelta`) above.
			const unusedExportDelta = knipDeliverable.kept.filter(
				(i) => i.type === "export" || i.type === "enumMember",
			);
			if (unusedExportDelta.length > 0) {
				let report =
					"⚠️ Newly unused exports in files you edited — check if callers need updating (Knip):\n";
				for (const issue of unusedExportDelta.slice(0, KNIP_MAX_SHOWN)) {
					const display = displayPath(issue);
					report += `  ${display}${issue.line ? `:${issue.line}` : ""} — ${issue.name}\n`;
				}
				// @delivery-surface: runtime-turn:knip-advisory
				advisoryParts.push(report);
				deliveryHolds.push(
					cutAdvisoryHold(
						"knip",
						knipAdvisoryLane,
						report,
						unusedExportDelta.slice(0, KNIP_MAX_SHOWN),
						(issue) => reOfferedKeys.has(issueKey(issue)),
					),
				);
			}
		}
		return knipMeta;
	};
	const logKnipRow = (
		root: string,
		startedAt: number,
		metadata: KnipTurnMeta,
	): void =>
		logLatency({
			type: "phase",
			toolName: "turn_end",
			filePath: root,
			phase: "knip",
			durationMs: Date.now() - startedAt,
			metadata,
		});
	if (runtime.isStartupScanInFlight("knip")) {
		dbg("turn_end: skipping knip (startup scan still in flight)");
		logKnipRow(cwd, Date.now(), { skipped: true });
	} else {
		let budgetSpent = false;
		for (const scanRoot of knipScan.roots) {
			if (budgetSpent) {
				incrementDegradationCount({
					kind: "turn-end-knip-root-skipped",
					subject: "budget",
					reason: `${toRunnerDisplayPath(cwd, scanRoot)} not scanned: an earlier knip scan spent the turn_end budget`,
				});
				continue;
			}
			const startedAt = Date.now();
			// Let KnipClient resolve/validate a real JS project root before probing or
			// auto-installing knip. Non-JS repos (for example Unity projects) should not
			// run tool checks every turn. Also back off after a timeout/kill so every
			// agent turn does not spend 30s launching another heavyweight knip process.
			const prevKnip = cacheManager.readCache<KnipResult>("knip", scanRoot);
			// An availability failure is NOT a hard knip failure: knip never ran, so
			// there is nothing to back off from, and backing off would make an
			// expiring probe verdict permanent again (#1467).
			const previousFailedHard =
				prevKnip &&
				!prevKnip.data.success &&
				!prevKnip.data.failureKind &&
				isHardFailureSummary(prevKnip.data.summary);
			// #3872: an abandoned scan that later timed out wrote no cache row, so the
			// client that saw it settle is asked as well (optional: test doubles).
			const abandonedFailure = previousFailedHard
				? null
				: (knipClient.recentHardFailure?.(scanRoot) ?? null);
			let metadata: KnipTurnMeta;
			if (previousFailedHard || abandonedFailure !== null) {
				const reason = previousFailedHard
					? prevKnip.data.summary
					: (abandonedFailure ?? "");
				dbg(`turn_end: skipping knip after recent failure: ${reason}`);
				metadata = { skipped: true, reason };
			} else {
				// #3872: the scan is awaited under the turn_end budget that is LEFT,
				// and the hook's signal. `bounded()` abandons the await, never the
				// process: knip keeps its own 30 s timeout and single-flight slot, so
				// the scan finishes off-hook and warms knip's own cache for the next
				// turn. Its late result is never written or delivered here -- the turn
				// it was computed for has already ended.
				//
				// A root whose last TWO scans both took longer than the budget left
				// is not awaited again (one cold scan is not a measurement): the wait would end in the same deferral, three
				// seconds later on every turn (live clone with six unignored
				// worktrees: the handler sat at 3000 ms on each of three turns). The
				// scan is still started, so a root that became fast is noticed on the
				// next turn, and the grace below still answers a memo hit, which
				// resolves in microtasks.
				const remainingMs = Math.max(
					0,
					HOOK_WALL_BUDGET_MS.turn_end - (Date.now() - turnEndStart),
				);
				const scanFloorMs = knipClient.scanFloorMs?.(scanRoot);
				const knownSlow =
					scanFloorMs !== undefined && scanFloorMs > remainingMs;
				const scanned = await bounded(
					withRowForFailureWrite(
						knipClient.analyze(scanRoot, getKnipIgnorePatterns(), {
							projectSeq: runtime.projectSeq,
						}),
						cacheManager,
						"knip",
						scanRoot,
						prevKnip,
					),
					{
						ms: knownSlow ? KNOWN_SLOW_KNIP_GRACE_MS : remainingMs,
						signal: deps.signal,
						hook: "turn_end",
						label: "knip",
					},
				);
				if (scanned === undefined) {
					dbg(`turn_end: knip for ${scanRoot} outlived the turn_end budget`);
					const aborted = deps.signal?.aborted === true;
					const nestedWorktrees = knipClient.nestedWorktrees?.(scanRoot) ?? 0;
					metadata = {
						execution: "deferred",
						aborted,
						...(knownSlow && {
							reason: "scan-exceeds-budget",
							scanFloorMs,
						}),
						...(nestedWorktrees > 0 && { nestedWorktrees }),
					};
					// The cause, once per root and counted (the root's rows carry the
					// per-turn number): knip walks these worktrees because the project
					// never ignored them, and only the project can stop that. A turn the
					// user cancelled is not a degradation.
					if (nestedWorktrees > 0 && !aborted) {
						incrementDegradationCount({
							kind: "turn-end-knip-nested-worktrees",
							subject: toRunnerDisplayPath(cwd, scanRoot),
							reason: `${nestedWorktrees} linked worktree(s) nested under the scan root: knip walks them as project files and the scan did not fit the turn_end budget; add their directory (for example /.worktrees/) to .gitignore to drop the cost`,
						});
					}
				} else {
					metadata = applyKnipResult(
						scanRoot,
						prevKnip,
						scanned.result,
						scanned.row,
					);
				}
			}
			// A root that was not awaited spent none of the budget: the next
			// checkout still gets its scan (an Escape ends the loop either way).
			budgetSpent =
				metadata.execution === "deferred" &&
				(metadata.scanFloorMs === undefined || metadata.aborted === true);
			logKnipRow(scanRoot, startedAt, metadata);
		}
	}

	// Cross-file dead-code (#127) for non-JS/TS languages, on knip's contract:
	// re-scan only when this turn touched a file the client owns, then inject the
	// ATTRIBUTABLE delta — symbols in those files that became unused because of
	// the edit. The project-wide list is deliberately NOT injected per turn (the
	// same reasoning as knip above) and stays available via lens_diagnostics.
	// MUST run before the projectDiagnosticsDelta write below, or a dead-code-only
	// turn would persist nothing.
	const tDeadCode = Date.now();
	const deadCodeMeta: {
		skipped?: boolean;
		success?: boolean;
		totalIssues?: number;
		newIssues?: number;
		/** #3248: findings dropped by a stored disposition before rendering. */
		dispositionSuppressed?: number;
		/** Why this turn produced no delta — the five states are otherwise identical. */
		reason?: string;
		/** True when a failed run left the previous good cache in place (#1467). */
		cacheKept?: boolean;
		/** #4117: `deferred` when a scan outlived the turn_end budget and was abandoned. */
		execution?: "deferred";
		/** #4117: the abandonment was the hook's own signal (Escape), not the clock. */
		aborted?: boolean;
		/** #4117: linked worktrees the scan was told to leave out. */
		excludedWorktrees?: number;
	} = {};
	if (runtime.isStartupScanInFlight("dead-code")) {
		dbg("turn_end: skipping dead-code (startup scan still in flight)");
		deadCodeMeta.skipped = true;
		deadCodeMeta.reason = "startup_scan_in_flight";
	} else if (deadCodeClients.length === 0) {
		deadCodeMeta.reason = "no_clients";
	} else {
		// The modified-file set costs a resolveRunnerPath per file, and that walks
		// every ancestor to the filesystem root on a miss. Build it lazily, only
		// once a client has actually claimed this project, so an all-JS repo with
		// no dead-code client pays nothing per turn. Knip does the same.
		let modifiedSet: Set<string> | null = null;
		const modifiedFiles = (): Set<string> =>
			(modifiedSet ??= new Set(files.map((f) => resolveRunnerPath(cwd, f))));
		let newIssueTotal = 0;
		/** #3248: bounded per-turn on this lane's own row, never per finding. */
		let deadCodeDispositionSuppressed = 0;
		const reasons: string[] = [];
		/**
		 * The attributable delta of finished scans: what became unused in the files
		 * each source's `modified` names, against that source's `baseline` (the row
		 * its scan was compared with). A source is a scan that finished inside this
		 * turn, or one that missed an earlier turn's budget and settled since
		 * (#4117 F1); the last source is the newest and gives the totals and the
		 * re-offered cut items.
		 */
		const deliverDeadCodeDelta = (
			client: DeadCodeClient,
			sources: readonly DeadCodeDeltaSource[],
		): void => {
			const latest = sources.at(-1);
			if (latest === undefined) return;
			const result = latest.result;
			// #3901: items the cap cut on the previous turn. A failed scan
			// leaves them parked; a successful one takes them (offered once).
			const deadCodeLane = carryLane("dead-code", client.id);
			const parkedDeadCode = takeParked<DeadCodeIssue>(deadCodeLane);
			deadCodeMeta.totalIssues =
				(deadCodeMeta.totalIssues ?? 0) + deadCodeIssues(result).length;
			// No baseline means every finding looks new. Report nothing rather
			// than blame the edit for the whole project's pre-existing debt.
			if (!sources.some((source) => source.previousScan?.success)) {
				reasons.push(`${client.id}:no_previous_scan`);
				return;
			}
			const newIssues: DeadCodeIssue[] = [];
			for (const source of sources) {
				if (!source.previousScan?.success) continue;
				const prevKeys = new Set(
					deadCodeIssues(source.previousScan).map(deadCodeIssueKey),
				);
				for (const issue of deadCodeIssues(source.result)) {
					if (prevKeys.has(deadCodeIssueKey(issue)) || !issue.file) continue;
					if (source.modified.has(resolveRunnerPath(cwd, issue.file))) {
						newIssues.push(issue);
					}
				}
			}
			// #3901: a parked item is offered again only while this scan still
			// reports it, as this scan's own record of it; it bypasses the
			// baseline and the edited-file gate the cut turn overwrote.
			const reOffered = stillReportedParked(
				parkedDeadCode,
				deadCodeIssues(result),
				deadCodeIssueKey,
				new Set(newIssues.map(deadCodeIssueKey)),
			);
			if (newIssues.length === 0 && reOffered.length === 0) {
				reasons.push(`${client.id}:clean`);
				return;
			}
			newIssueTotal += newIssues.length;
			if (newIssues.length > 0) {
				projectDiagnosticsDelta.push(
					...newIssues.map((issue) =>
						deadCodeIssueToProjectDiagnostic(cwd, issue, result.language),
					),
				);
				projectDiagnosticsSources.add("dead-code");
			}
			// #3248: the rendered advisory takes the stored-disposition
			// filter, keyed off this lane's OWN adapter. The delta record
			// above keeps the unfiltered set — its reader applies the policy
			// on read, so filtering both would double-apply on one lane.
			const deadCodeDeliverable = filterFindingsByDisposition(
				[...newIssues, ...reOffered],
				cwd,
				(issue) =>
					deadCodeIssueToProjectDiagnostic(cwd, issue, result.language),
			);
			deadCodeDispositionSuppressed += deadCodeDeliverable.suppressed;
			// Every finding on this scan was marked: a PUSH surface stays
			// silent rather than re-announcing that the mark is working; the
			// count rides this lane's bounded per-turn row.
			if (deadCodeDeliverable.kept.length === 0) {
				reasons.push(`${client.id}:all_disposed`);
				return;
			}
			const deadCodePart = formatDeadCodeDelta(
				deadCodeDeliverable.kept,
				result.language,
			);
			// @delivery-surface: runtime-turn:dead-code-advisory
			advisoryParts.push(deadCodePart);
			const reOfferedKeys = new Set(reOffered.map(deadCodeIssueKey));
			deliveryHolds.push(
				cutAdvisoryHold(
					"dead-code",
					deadCodeLane,
					deadCodePart,
					deadCodeDeliverable.kept.slice(0, DEAD_CODE_DELTA_MAX_SHOWN),
					(issue) => reOfferedKeys.has(deadCodeIssueKey(issue)),
				),
			);
		};
		// A malformed client or deps object must never abort turn_end. Before the
		// per-turn delta this block only read a cache; now it iterates and awaits,
		// so the whole thing needs the guard, not just `client.analyze`.
		try {
			// #4168 F1: the entry scope, never one read after the knip await.
			const lateScans = lateDeadCodeScansOf(turnScope);
			for (const client of deadCodeClients) {
				if (!client.detect(cwd)) {
					reasons.push(`${client.id}:not_detected`);
					continue;
				}
				const cacheKey = `dead-code-${client.id}`;
				const lateKey = lateDeadCodeScanKey(client, cwd);
				const sources: DeadCodeDeltaSource[] = [];
				// A scan an earlier turn abandoned at its budget (#4117 F1): its
				// session may be over; if it finished, its delta is delivered now
				// and the files edited meanwhile join this turn's scan; if it still
				// runs, nothing else starts and this turn's files wait for it.
				const late = lateScans.get(lateKey);
				let carried: ReadonlySet<string> = new Set();
				if (late?.settled) {
					lateScans.delete(lateKey);
					sources.push({
						result: late.settled,
						previousScan: late.previousScan,
						modified: late.files,
					});
					carried = late.carry;
					reasons.push(`${client.id}:late_scan`);
					// #4154 J1: a scan that was already running when the lane asked read
					// the tree before the files it was parked for were edited. Its delta
					// still shows what it saw; the next scan covers those files too.
					if (joinedEarlierScan(late.settled, late.askedAt)) {
						carried = new Set([...late.carry, ...late.files]);
						reasons.push(`${client.id}:joined`);
					}
				}
				try {
					if (late && !late.settled) {
						for (const file of modifiedFiles()) late.carry.add(file);
						reasons.push(`${client.id}:in_flight`);
						continue;
					}
					const scanFiles = new Set([...modifiedFiles(), ...carried]);
					if (![...scanFiles].some((f) => client.owns(f))) {
						reasons.push(`${client.id}:no_owned_files`);
						continue;
					}
					const prev = cacheManager.readCache<DeadCodeResult>(cacheKey, cwd);
					// Back off after a timeout/kill so an unresponsive scanner cannot cost
					// every later turn its full analysis budget (mirrors knip). #4117: a
					// scan abandoned at the budget that later timed out wrote no row, so
					// the client that saw it settle is asked as well (optional: doubles).
					const previousFailedHard =
						prev &&
						!prev.data.success &&
						isHardFailureSummary(prev.data.summary);
					const abandonedFailure = previousFailedHard
						? null
						: (client.recentHardFailure?.(cwd) ?? null);
					if (previousFailedHard || abandonedFailure !== null) {
						const failure = previousFailedHard
							? prev.data.summary
							: (abandonedFailure ?? "");
						dbg(`turn_end: skipping dead-code after failure: ${failure}`);
						deadCodeMeta.skipped = true;
						reasons.push(`${client.id}:backoff:${failure}`);
						continue;
					}
					const startMs = Date.now();
					// #4117: awaited under the turn_end budget that is LEFT and the
					// hook's signal, as knip is (#3872). `bounded()` abandons the await,
					// never the process: vulture keeps its own 30 s timeout and
					// single-flight slot, and a scan that misses the budget is parked
					// (`parkLateDeadCodeScan`) so its row is written where it settles and
					// its delta delivered by a later turn. No further client starts once
					// the budget is spent. A failure's row is re-read inside the same
					// bound (#4154 V1).
					const scan = client.analyze(cwd);
					const settled = await bounded(
						withRowForFailureWrite(scan, cacheManager, cacheKey, cwd, prev),
						{
							signal: deps.signal,
							hook: "turn_end",
							label: "dead-code",
							ms: Math.max(
								0,
								HOOK_WALL_BUDGET_MS.turn_end - (Date.now() - turnEndStart),
							),
						},
					);
					// #4154 J1: a joined scan that predates this turn's edits is not
					// their answer even when it finishes in time: parked like a late
					// one, its delta lands next turn and its files join the next scan.
					const joined =
						settled !== undefined && joinedEarlierScan(settled.result, startMs);
					if (settled === undefined || joined) {
						if (joined) {
							reasons.push(`${client.id}:joined`);
						} else {
							dbg(`turn_end: dead-code(${client.id}) outlived the budget`);
							deadCodeMeta.execution = "deferred";
							deadCodeMeta.aborted = deps.signal?.aborted === true;
							reasons.push(`${client.id}:deferred`);
						}
						parkLateDeadCodeScan({
							scope: turnScope,
							cacheManager,
							client,
							cwd,
							cacheKey,
							scan,
							startedAt: startMs,
							files: scanFiles,
							previousScan: prev?.data,
						});
						if (joined) continue;
						break;
					}
					const { result } = settled;
					const durationMs = Date.now() - startMs;
					// Never overwrite a good scan with a failure (#925, #1467): a
					// vulture timeout on one .py turn would otherwise evict the
					// session_start scan, and the backoff above would then latch
					// off the poisoned record. The good row is the one on disk now.
					if (wouldPoisonCache(settled.row, result)) {
						dbg(
							`turn_end: keeping last good dead-code(${client.id}) cache; this run failed: ${result.summary}`,
						);
						deadCodeMeta.cacheKept = true;
					} else {
						cacheManager.writeCache(cacheKey, result, cwd, {
							scanDurationMs: durationMs,
						});
					}
					// One event per cross-file scan (AGENTS.md) — the per-turn scan is
					// now the primary path, so dead-code.log must see it too.
					logDeadCodeScan(deadCodeScanEvent(client, cwd, result, durationMs));
					deadCodeMeta.success = result.success;
					if (result.excludedWorktrees !== undefined) {
						deadCodeMeta.excludedWorktrees =
							(deadCodeMeta.excludedWorktrees ?? 0) + result.excludedWorktrees;
					}
					if (!result.success) {
						reasons.push(`${client.id}:scan_failed:${result.summary}`);
						continue;
					}
					sources.push({
						result,
						previousScan: prev?.data,
						modified: scanFiles,
					});
				} catch (err) {
					dbg(`turn_end: dead-code(${client.id}) failed: ${err}`);
					reasons.push(`${client.id}:threw`);
				} finally {
					try {
						deliverDeadCodeDelta(client, sources);
					} catch (err) {
						dbg(`turn_end: dead-code(${client.id}) delivery failed: ${err}`);
						reasons.push(`${client.id}:threw`);
					}
				}
			}
		} catch (err) {
			dbg(`turn_end: dead-code block failed: ${err}`);
			reasons.push("block_threw");
		}
		deadCodeMeta.newIssues = newIssueTotal;
		deadCodeMeta.dispositionSuppressed = deadCodeDispositionSuppressed;
		if (reasons.length > 0) deadCodeMeta.reason = reasons.join(",");
	}
	logLatency({
		type: "phase",
		toolName: "turn_end",
		filePath: cwd,
		phase: "dead-code",
		durationMs: Date.now() - tDeadCode,
		metadata: deadCodeMeta,
	});

	// #1617: running total of findings this turn's advisory/blocker sections
	// dropped because an agent/user marked them false-positive/won't-fix —
	// the #1616 suppressed-bucket rule applied to turn_end's own reporting
	// lanes, so a mark's effect stays visible even though the finding itself
	// no longer appears above. Review-round F4 (#1625): kept per-lane, not
	// just a bare total, so the eventual trace says WHICH lane's marks did
	// the suppressing.
	let dispositionSuppressedTotal = 0;
	const dispositionSuppressedByLane: Record<string, number> = {};
	function recordDispositionSuppressed(lane: string, count: number): void {
		if (count <= 0) return;
		dispositionSuppressedTotal += count;
		dispositionSuppressedByLane[lane] =
			(dispositionSuppressedByLane[lane] ?? 0) + count;
	}

	// #1892: ONE read per scanner store per turn_end. The inline lanes got this
	// for free by reading each cache into a local; now that a lane reads its own
	// stores (`TurnEndLaneContext.readScannerCache`), the composer and the lanes
	// must still share one envelope per store — two reads of one store inside
	// one delivery is the parallel-store shape this umbrella exists to kill, and
	// the cache's TTL boundary can fall between them, so the secrets tier and
	// the CVE tier would disagree about the trivy store they both read.
	//
	// #3274: the memo holds the PROMISE of each store's envelope, not the
	// envelope. The read itself moved to `CacheManager.readCacheAsync`, which
	// suspends on `fs.promises`, so `bounded()` finally has something to bound:
	// the sync `readCache` completed during ARGUMENT EVALUATION, before
	// `bounded()` was ever handed a promise, and a wrapper around it registered
	// a turn_end budget that could never be spent (probed on #3274 with an
	// already-aborted signal and `ms: 0` — bounded returned undefined and the
	// read had already parsed). Memoizing the promise is also what keeps the
	// one-envelope-per-store rule under concurrency: two lanes that await the
	// same store share ONE read and ONE TTL boundary even when neither has
	// settled yet, which a value memo could not do.
	//
	// An abandoned read yields null, never a throw and never a late envelope:
	// `bounded()` resolves `undefined` on the budget or the hook's signal and
	// records ONE `hook-await-exceeded` row per (hook, label) for the deadline
	// arm, and the memoized promise is already settled by the time the
	// abandoned read resolves, so nothing mutates after the delivery composed.
	// A lane that receives null behaves exactly as it does for a cold cache.
	const scannerCacheReads = new Map<
		string,
		Promise<CacheEntry<unknown> | null>
	>();
	// Stores this delivery composed WITHOUT because a bound fired, in read
	// order. `bounded()` records the AWAIT's own row (`hook-await-exceeded`),
	// but only for the deadline arm and only about the await; the agent-facing
	// consequence — the secrets tier went out with no gitleaks store behind it,
	// which looks exactly like a clean scan (AGENTS.md defect shape 10) — has no
	// record otherwise, on either arm. One row per DELIVERY, below, never one
	// per store and never on a healthy turn.
	const scannerStoresUnread: string[] = [];
	function readScannerCache<T>(scanner: string): Promise<CacheEntry<T> | null> {
		let pending = scannerCacheReads.get(scanner);
		if (pending === undefined) {
			// An already-aborted turn does not start the read at all. `bounded()`
			// abandons the await but cannot cancel work already dispatched, so
			// without this the cancelled turn still pays six file reads whose
			// result nothing can use. Checked AFTER the memo lookup: a signal that
			// fires mid-delivery must not give the second lane a different answer
			// from the first (that is the TTL-boundary split this memo exists for).
			// It records nothing, on purpose: an already-cancelled turn is Escape,
			// which `bounded()` also keeps off the ledger — the row below is for a
			// delivery that went out degraded, not one the user stopped.
			pending = deps.signal?.aborted
				? Promise.resolve(null)
				: bounded(cacheManager.readCacheAsync<unknown>(scanner, cwd), {
						ms: HOOK_WALL_BUDGET_MS.turn_end,
						signal: deps.signal,
						hook: "turn_end",
						label: `readScannerCache:${scanner}`,
					}).then((entry) => {
						if (entry === undefined) scannerStoresUnread.push(scanner);
						return entry ?? null;
					});
			scannerCacheReads.set(scanner, pending);
		}
		return pending as Promise<CacheEntry<T> | null>;
	}
	const laneCtx: TurnEndLaneContext = {
		cwd,
		signal: deps.signal,
		readScannerCache,
		peekActionableWarnings: () => runtime.peekActionableWarnings(sessionId),
	};

	// govulncheck — the session_start-cached Go CVE store, delivered as ONE
	// advisory tier by the govulncheck LANE
	// (`clients/turn-end/lanes/govulncheck.ts`), which owns every rule this block
	// used to state inline: the `onMissing: "demote"` freshness declaration and
	// its first-filename-frame `citedPath` (#1622 H1), the disposition anchor
	// over BOTH freshness arms (#1694 F1), the stale-line withholding and marker,
	// the module/package fallback, the fix hint and the display cap. No per-turn
	// re-run in this slice; the cache refreshes at next session_start. Like every
	// lane it does NOT gate itself — the freshness pass below is shared.
	const govSources = await govulncheckLane.collect(laneCtx);
	const trivyCacheEntry = await readScannerCache<TrivyResult>("trivy");
	// The secrets lane (`clients/turn-end/lanes/secrets.ts`) reads the gitleaks
	// and trivy stores, classifies, and states the freshness policy its rows
	// need; every rendering and disposition rule for the two secrets tiers lives
	// there. It does NOT gate itself either.
	const secretsSources = await secretsLane.collect(laneCtx);
	// #1892: ONE freshness pass for the three cached scanner stores that cite a
	// file. Each store keeps its own `scannedAt` and its own `onMissing` — the
	// gate carries source identity, so gitleaks' older scan cannot demote a
	// trivy secret its newer scan covers, and govulncheck's `demote` verdict for
	// a deleted path cannot reach gitleaks, which must drop it. What IS shared
	// is the filesystem: one `statSync` per unique cited path per delivery, one
	// stat budget, and one bounded drop/demote record instead of up to six.
	//
	// #1461 slice 1 (#1460) on gitleaks: the cache is TTL-only, so a finding for
	// a file deleted after the scan was served as a 🔴 blocker for the rest of
	// the 30-minute window — 119 of 126 findings in pi-lens's own cache. This
	// read is the single agent-facing consumer of that store (session_start's
	// read only decides whether to re-scan; the project-diagnostics path
	// re-scans fresh and reconciles at load), so the drop belongs here, before
	// the findings enter the shared secret pipeline. #1622 extends the gate from
	// existence to freshness, and adds trivy secrets — the sibling store with
	// the identical shape. A cited file edited after the scan keeps its finding
	// but loses its line number: the credential may still be there, just not
	// where the snapshot says. Dropping instead would let any edit — malicious
	// or accidental — mute a real secret.
	if (scannerStoresUnread.length > 0) {
		logLatency({
			type: "phase",
			toolName: "turn_end",
			filePath: cwd,
			phase: "scanner_cache_read_abandoned",
			durationMs: 0,
			metadata: {
				stores: scannerStoresUnread.join("+"),
				aborted: deps.signal?.aborted === true,
			},
		});
	}
	const scannerGates = gateFindingsByPathFreshness({
		cwd,
		sources: {
			...govSources,
			...secretsSources,
		},
	});
	const govGate = scannerGates.govulncheck;
	const gitleaksGate = scannerGates.gitleaks;
	const trivySecretsGate = scannerGates["trivy-secrets"];
	const govDelivery = govulncheckLane.render(
		govulncheckLane.gate({ govulncheck: govGate }, laneCtx),
		laneCtx,
	);
	for (const [store, count] of Object.entries(
		govDelivery.dispositionSuppressed ?? {},
	)) {
		recordDispositionSuppressed(store, count);
	}
	// @delivery-surface: runtime-turn:govulncheck-advisory
	advisoryParts.push(...(govDelivery.advisoryParts ?? []));

	// Secrets — UNIFIED surfacing (#131 Mode 3). gitleaks, trivy secret, and the
	// ast-grep hardcoded-secret rules can each flag the SAME line with different
	// rule ids, which the rule-keyed diagnostic dedup can't collapse. Collapse by
	// location so a committed/hardcoded secret is reported ONCE (with combined
	// provenance) — a blocker, since credentials need rotation before merge.
	//
	// #1892: both tiers are rendered by the secrets LANE
	// (`clients/turn-end/lanes/secrets.ts`), which owns every rule this block
	// used to state inline — the two stores' disposition anchors over BOTH
	// freshness arms (#1617/#1625/#1628), the location dedupe and ast-grep
	// provenance enrichment, the demoted tier's file+rule+source identity
	// (#1622 M1) and its own-tier placement (#1622 M2). The composer keeps only
	// what is not one lane's rule: the gated arms it hands over, the order the
	// tiers are pushed in, and the per-lane suppression counts that fold into
	// the one notice below.
	const secretsDelivery = secretsLane.render(
		secretsLane.gate(
			{
				gitleaks: gitleaksGate,
				"trivy-secrets": trivySecretsGate,
			},
			laneCtx,
		),
		laneCtx,
	);
	for (const [store, count] of Object.entries(
		secretsDelivery.dispositionSuppressed ?? {},
	)) {
		recordDispositionSuppressed(store, count);
	}
	const secretBlockedLocations =
		secretsDelivery.deliveredLocationKeys ?? new Set<string>();
	// @delivery-surface: runtime-turn:secrets-gitleaks,runtime-turn:secrets-trivy
	blockerParts.push(...(secretsDelivery.blockerParts ?? []));
	// @delivery-surface: runtime-turn:stale-secrets-tier
	staleSecretParts.push(...(secretsDelivery.staleSecretParts ?? []));

	// trivy — surface session_start-cached dependency CVEs (#131, Phase 1).
	// CRITICAL is a blocker (a known-exploitable CVE in a shipped dep is real
	// production risk); HIGH/MEDIUM/LOW are advisory. The agent gets the upgrade
	// target as a hint and decides — we never auto-edit lockfiles.
	//
	// #1634: these three trivy reports (critical blocker, non-critical
	// advisory, license advisory below) name a PACKAGE, not a file:line — there
	// is no cited path for `gateFindingsByPathFreshness` to stat, so unlike the
	// secrets/govulncheck stores above this store cannot be freshness-GATED.
	// It is the delivery gate's explicit-label escape hatch instead
	// (`clients/finding-delivery-gate.ts`, surfaces `runtime-turn:trivy-*`):
	// the session_start cache can be arbitrarily old, so its age is stated
	// plainly rather than presenting a CRITICAL blocker as if it were current.
	// This runs on top of (not instead of) #1625's disposition filter below —
	// a suppressed finding never reaches this render at all, so the two only
	// ever compose.
	const trivyAgeLabel = formatCacheAgeLabel(trivyCacheEntry?.data?.scannedAt);
	const trivyFindingsFiltered = filterFindingsByDisposition(
		trivyCacheEntry?.data?.findings ?? [],
		cwd,
		(f) => trivyFindingToProjectDiagnostic(cwd, f),
	);
	recordDispositionSuppressed("trivy", trivyFindingsFiltered.suppressed);
	if (trivyFindingsFiltered.kept.length) {
		const all = trivyFindingsFiltered.kept;
		const critical = all.filter((f) => f.severity === "CRITICAL");
		const advisory = all.filter((f) => f.severity !== "CRITICAL");
		const fmt = (f: TrivyResult["findings"][number]): string => {
			const pkg = f.installedVersion
				? `${f.pkgName}@${f.installedVersion}`
				: f.pkgName;
			const fix = f.fixedVersion
				? ` — upgrade to ${f.fixedVersion} or later`
				: " — no fix yet, track upstream";
			return `  ${f.vulnerabilityId} (${pkg})${fix}\n`;
		};
		if (critical.length) {
			const shown = critical.slice(0, 5);
			let report = `🔴 STOP — CRITICAL dependency CVEs (trivy, ${trivyAgeLabel}). Upgrade before shipping:\n`;
			for (const f of shown) report += fmt(f);
			if (critical.length > shown.length) {
				report += `  … and ${critical.length - shown.length} more\n`;
			}
			// @delivery-surface: runtime-turn:trivy-critical-blocker
			blockerParts.push(report);
		}
		if (advisory.length) {
			const shown = advisory.slice(0, 5);
			let report = `🛡️ Dependency CVEs (trivy, ${trivyAgeLabel}) — upgrade where possible:\n`;
			for (const f of shown) report += fmt(f);
			if (advisory.length > shown.length) {
				report += `  … and ${advisory.length - shown.length} more\n`;
			}
			// @delivery-surface: runtime-turn:trivy-cve-advisory
			advisoryParts.push(report);
		}
	}

	// trivy — dependency license risk (#131 Mode 4). Advisory only: a copyleft /
	// restricted license in a proprietary tree is a compliance signal, not a
	// build break. Surfaced from the same cached `trivy fs` pass — same #1634
	// explicit-label rationale as the CVE reports above (no cited path to gate).
	const licenses = trivyCacheEntry?.data?.licenses ?? [];
	if (licenses.length) {
		const shown = licenses.slice(0, 5);
		let report = `📜 Dependency license risk (trivy, ${trivyAgeLabel}) — review for compliance:\n`;
		for (const l of shown) {
			const cat = l.category ? `, ${l.category}` : "";
			report += `  ${l.pkgName} — ${l.license} (${l.severity}${cat})\n`;
		}
		if (licenses.length > shown.length) {
			report += `  … and ${licenses.length - shown.length} more\n`;
		}
		// @delivery-surface: runtime-turn:trivy-license-advisory
		advisoryParts.push(report);
	}

	// #1616 suppressed-bucket rule: surface the running disposition-drop total
	// as its own advisory line so a mark's effect is visible, not a silent
	// absence — trace, not a vanish.
	if (dispositionSuppressedTotal > 0) {
		// Review-round F4 (#1625): per-lane attribution, e.g.
		// "gitleaks 2, govulncheck 1" — not just a bare total.
		const byLane = Object.entries(dispositionSuppressedByLane)
			.map(([lane, count]) => `${lane} ${count}`)
			.join(", ");
		// @delivery-surface: runtime-turn:disposition-suppressed-notice
		advisoryParts.push(
			`suppressed by disposition: ${dispositionSuppressedTotal} finding(s) ` +
				`dropped from this turn's gitleaks/govulncheck/trivy sections (${byLane}) ` +
				"(marked false-positive or won't-fix).",
		);
	}

	const t3 = Date.now();
	let madgeStats: MadgeBatchStats | undefined;
	// Off by default (#766): this pass only writes debug output, and user-facing
	// madge diagnostics come from the session-start `madge` cache + the
	// `lens_diagnostics` extractor. Enabled with `--lens-turn-end-madge` /
	// `turnEnd.madge.enabled=true` for those who want the per-edit circular note.
	if (getFlag("lens-turn-end-madge") && (await depChecker.ensureAvailable())) {
		const madgeFiles = cacheManager.getFilesForMadge(cwd);
		if (madgeFiles.length > 0) {
			dbg(
				`turn_end: madge checking ${madgeFiles.length} file(s) for circular deps`,
			);
			// Checked concurrently (bounded) rather than one `await` per file —
			// the shared circular-dep state update is deferred/folded inside
			// checkFilesBatch so concurrent spawns can't clobber each other (#766).
			const absFiles = madgeFiles.map((file) => path.resolve(cwd, file));
			const batch = await depChecker.checkFilesBatch(absFiles, cwd);
			const depResults = batch.results;
			madgeStats = batch.stats;
			for (const file of madgeFiles) {
				const absPath = path.resolve(cwd, file);
				const depResult = depResults.get(absPath);
				if (!depResult) continue;
				if (depResult.hasCircular && depResult.circular.length > 0) {
					// Whole-project circular deps are surfaced in lens_diagnostics via the
					// session-start `madge` cache + extractor; this per-file turn-end pass
					// only logs (blockers-only mode suppresses circular-dep notes).
					dbg(
						`turn_end: circular dependency note for ${file} (suppressed in blockers-only mode)`,
					);
				}
			}
		}
	}

	logLatency({
		type: "phase",
		toolName: "turn_end",
		filePath: cwd,
		phase: "madge",
		durationMs: Date.now() - t3,
		// A ~0ms entry with no metadata is indistinguishable from "ran and was
		// fast" when re-analyzing the #766 tail — mark the skipped case.
		metadata: madgeStats ?? { skipped: true },
	});

	// --- Test runner: fire once per turn after all edits are done ---
	// Runs for each unique test target across modified files; results remain in
	// the pull-diagnostics cache and are delivered after the agent settles.
	if (!getFlag("no-tests") && files.length > 0) {
		const seen = new Set<string>();
		type TurnEndTestTarget = NonNullable<
			ReturnType<TestRunnerClient["getTestRunTarget"]>
		>;
		// `strategy` is widened by one value the resolver itself cannot produce:
		// a target carried over from the previous turn's cut batch (#2522 R2 F1).
		const targets: Array<
			Omit<TurnEndTestTarget, "strategy"> & {
				strategy: TurnEndTestTarget["strategy"] | "deferred";
				sourceFile: string;
				/**
				 * The checkout root this target is selected and run in (#3871): the
				 * session cwd, or the linked worktree that owns it. Not persisted;
				 * a carried target re-derives it from its path.
				 */
				testRoot: string;
				fileSeqAtRun?: number;
				/** Cut-batch count carried in from the cache, for the cap below. */
				deferralAttempts?: number;
			}
		> = [];

		// #628: also target the test companions of this turn's cascade neighbors
		// (files that import an edited file) — a neighbor's own tests can break
		// even though the neighbor's source wasn't touched. Reuses `cascadeResults`,
		// already computed above (from the same #450 deferred-cascade drain) for the
		// LSP cascade-diagnostics merge — no second reverse-dependency walk, and the
		// neighbor set inherits whatever budget the cascade compute already applied
		// (CASCADE_NEIGHBOUR_BUDGET), so this can't turn into unbounded per-edit work.
		// #3871: which checkout root owns each target. One resolver per turn so
		// its per-directory memo is shared by the carried-over targets and this
		// turn's candidates.
		const testRootFor = createTurnEndTestRoots(cwd);
		const candidates: Array<{
			display: string;
			abs: string;
			isNeighbor: boolean;
		}> = [];
		const seenCandidateKeys = new Set<string>();
		for (const file of files) {
			const abs = resolveRunnerPath(cwd, file);
			const key = normalizeMapKey(abs);
			if (seenCandidateKeys.has(key)) continue;
			seenCandidateKeys.add(key);
			candidates.push({ display: file, abs, isNeighbor: false });
		}
		for (const result of cascadeResults) {
			for (const neighbor of result.neighbors) {
				const abs = path.isAbsolute(neighbor.filePath)
					? neighbor.filePath
					: resolveRunnerPath(cwd, neighbor.filePath);
				const key = normalizeMapKey(abs);
				if (seenCandidateKeys.has(key)) continue;
				seenCandidateKeys.add(key);
				candidates.push({ display: neighbor.filePath, abs, isNeighbor: true });
			}
		}

		// #2522 review round 2, F1: the previous turn's unfinished targets go
		// FIRST — ahead of failed-first/related/self — under the same
		// TEST_RUNNER_MAX_TARGETS cap, so a batch that keeps getting cut makes
		// progress instead of re-running whatever this turn happened to touch
		// and dropping the remainder again. The list is consumed here (written
		// back empty below) so a target can never be carried forever.
		const priorTestCache = cacheManager.readCache<TestRunnerFindingsCache>(
			"test-runner-findings",
			cwd,
		)?.data;
		const carriedDeferred = priorTestCache?.deferredTargets ?? [];
		// #2522 review round 3, F5: a deferral list belongs to the session that
		// cut it. `runtime.telemetrySessionId` is the same identity the batch
		// stamps its own entries with below (`firedSessionId`), so this is a
		// single comparison against one source of truth.
		const turnSessionId = sessionId ?? runtime.telemetrySessionId;
		const isThisSession = (entry: DeferredTestTarget): boolean =>
			entry.sessionId === turnSessionId;
		const entryPathKey = (entry: DeferredTestTarget): string =>
			normalizeMapKey(path.resolve(cwd, entry.testFile));
		/**
		 * #2522 review round 3, F1: the retirement, carried forward.
		 *
		 * Round 2 announced the retirement and dropped it on the floor, so the
		 * candidate loop below re-resolved the very same file through
		 * `related`/`self` in the SAME turn and ran it anyway with a fresh
		 * (undefined) attempt count. Steady state was a 3-turn cycle that spawned
		 * and cut the slow suite on every turn. The retired set is persisted on
		 * the record instead.
		 *
		 * Round 4, I1: this is a SELECTION filter and nothing more. Round 3 also
		 * wrote the filtered list straight back, so a turn taken by the other
		 * entry point into the same project — `clients/mcp/session.ts` passes no
		 * `sessionId` and falls back to `telemetrySessionId`, while `index.ts`
		 * passes pi's stable id — erased the entries belonging to the other
		 * route. Both lists survive every write now; see `writeTestFindings`.
		 */
		const retiredCarry: DeferredTestTarget[] = (
			priorTestCache?.retiredTargets ?? []
		).filter(isThisSession);
		const retiredKeys = new Set(retiredCarry.map(entryPathKey));
		/**
		 * Deferral entries of THIS session that this turn has settled: dispatched
		 * into `targets`, retired at the cap, or dropped as unrunnable. Only
		 * these may leave the persisted list, and only when this turn's own write
		 * is not re-asserting them (a cut target comes straight back with
		 * `attempts + 1`).
		 */
		const resolvedDeferralKeys = new Set<string>();
		/**
		 * #2522 review round 4, I5: entries this turn could not fit under
		 * `TEST_RUNNER_MAX_TARGETS`. They were not run, so they keep their attempt
		 * count and stay on the list — round 3 folded the over-cap case in with
		 * "no longer resolves" and dropped them outright, so a carry larger than
		 * the cap lost its tail every turn under a dbg line that said the files
		 * were gone.
		 */
		const heldDeferred: DeferredTestTarget[] = [];
		/**
		 * The ONE writer of `test-runner-findings` in this block, so the rules
		 * about what survives a write are stated once instead of at six call sites
		 * that a seventh would silently not join (#2522 review round 3, F1; same
		 * net-count rule as `retireTestFindings` in `runtime-context.ts`).
		 *
		 * Three rules, all of them round-4 invariants:
		 *  - I1: the LIVE record is re-read here and merged into, never replaced.
		 *    A row belonging to another session is untouchable — this turn may
		 *    ignore it, never delete it.
		 *  - I2: every write merges. A batch that publishes clean, a batch that
		 *    publishes failures and a superseded batch all go through this, so
		 *    none of them can overwrite a concurrent batch's cut set. Removal is
		 *    narrow by construction: an entry leaves only if it is this session's,
		 *    this turn settled it, and this write is not re-asserting it.
		 *  - the persisted lists are bounded (`TEST_RUNNER_MAX_PERSISTED_TARGETS`)
		 *    with this session's rows ordered LAST, so the bound sheds foreign
		 *    rows first and can never evict what this turn just recorded.
		 */
		const boundPersisted = (
			entries: DeferredTestTarget[],
			label: string,
		): DeferredTestTarget[] => {
			const ordered = [
				...entries.filter((entry) => !isThisSession(entry)),
				...entries.filter(isThisSession),
			];
			if (ordered.length <= TEST_RUNNER_MAX_PERSISTED_TARGETS) return ordered;
			dbg(
				`turn_end: ${label} test target list held ${ordered.length} entries, bounded to the newest ${TEST_RUNNER_MAX_PERSISTED_TARGETS} (oldest foreign-session rows dropped)`,
			);
			return ordered.slice(-TEST_RUNNER_MAX_PERSISTED_TARGETS);
		};
		const writeTestFindings = (
			record: TestRunnerFindingsCache,
			ownDeferred: readonly DeferredTestTarget[],
		): void => {
			const live = cacheManager.readCache<TestRunnerFindingsCache>(
				"test-runner-findings",
				cwd,
			)?.data;
			const own = mergeDeferredTargets(heldDeferred, ownDeferred);
			const ownKeys = new Set(own.map(entryPathKey));
			const merged = mergeDeferredTargets(
				live?.deferredTargets ?? [],
				own,
			).filter((entry) => {
				if (!isThisSession(entry)) return true;
				const key = entryPathKey(entry);
				return !resolvedDeferralKeys.has(key) || ownKeys.has(key);
			});
			cacheManager.writeCache(
				"test-runner-findings",
				{
					...record,
					deferredTargets: boundPersisted(merged, "deferred"),
					retiredTargets: boundPersisted(
						mergeDeferredTargets(live?.retiredTargets ?? [], retiredCarry),
						"retired",
					),
				},
				cwd,
			);
		};
		let deadDeferred = 0;
		let heldOverCap = 0;
		let foreignDeferred = 0;
		let redispatchedDeferred = 0;
		let retiredThisTurn = 0;
		for (const carried of carriedDeferred) {
			const testFile = path.resolve(cwd, carried.testFile);
			const carriedKey = normalizeMapKey(testFile);
			// I1: another session still owes this run. Skip it, leave it on the
			// record — `writeTestFindings` never removes a row this turn does not
			// own.
			if (!isThisSession(carried)) {
				foreignDeferred++;
				continue;
			}
			if (seen.has(carriedKey)) {
				resolvedDeferralKeys.add(carriedKey);
				continue;
			}
			const attempts = carried.attempts ?? 0;
			if (attempts >= TEST_RUNNER_MAX_DEFERRALS) {
				resolvedDeferralKeys.add(carriedKey);
				if (!retiredKeys.has(carriedKey)) {
					retiredKeys.add(carriedKey);
					retiredThisTurn++;
					retiredCarry.push({
						testFile,
						runner: carried.runner,
						attempts,
						sessionId: turnSessionId,
					});
					// Never silent, and counted rather than once-per-subject: this is
					// the ledger entry that names WHICH suite is too slow to belong in
					// a per-turn batch at all.
					incrementDegradationCount({
						kind: "test-runner-batch-capped",
						subject: `${cwd}:deferral-exhausted`,
						reason: `test target was cut after ${attempts} turn(s) at the turn-end budget and is retired for this session — too slow for a per-turn batch; run it explicitly (target: ${path.relative(cwd, testFile)})`,
					});
					dbg(
						`turn_end: retiring deferred test target ${path.relative(cwd, testFile)} after ${attempts} cut batch(es) — too slow for the turn-end budget, run it explicitly`,
					);
				}
				continue;
			}
			// A RunnerConfig carries functions, so the cache stores the runner KEY
			// and the config is re-resolved here from the single registry.
			const config = RUNNERS[carried.runner];
			const carriedRoot = testRootFor(testFile);
			if (
				!config ||
				isExcludedTestTarget(testFile, carriedRoot) ||
				!fs.existsSync(testFile)
			) {
				resolvedDeferralKeys.add(carriedKey);
				deadDeferred++;
				continue;
			}
			if (targets.length >= TEST_RUNNER_MAX_TARGETS) {
				// I5: not settled — held, with `attempts` UNCHANGED. It was never
				// dispatched, so charging it toward retirement would retire a suite
				// this turn simply had no room for.
				heldOverCap++;
				heldDeferred.push({
					testFile,
					runner: carried.runner,
					sourceFile: carried.sourceFile ?? testFile,
					attempts,
					sessionId: turnSessionId,
				});
				continue;
			}
			resolvedDeferralKeys.add(carriedKey);
			seen.add(carriedKey);
			redispatchedDeferred++;
			targets.push({
				testFile,
				sourceFile: carried.sourceFile ?? testFile,
				runner: carried.runner,
				config,
				strategy: "deferred",
				testRoot: carriedRoot,
				deferralAttempts: attempts,
			});
			dbg(
				`turn_end: re-running deferred test target ${path.relative(cwd, testFile)} (${carried.runner}) from the previous turn's cut batch`,
			);
		}
		if (deadDeferred > 0) {
			dbg(
				`turn_end: dropped ${deadDeferred} deferred test target(s) that no longer resolve (missing file, excluded, or unknown runner)`,
			);
		}
		if (heldOverCap > 0) {
			dbg(
				`turn_end: held ${heldOverCap} deferred test target(s) over the per-turn cap of ${TEST_RUNNER_MAX_TARGETS} — kept on the deferral list for the next turn, attempts unchanged`,
			);
		}
		if (foreignDeferred > 0) {
			dbg(
				`turn_end: ignored ${foreignDeferred} deferred test target(s) belonging to another session — left on the record for the session that cut them`,
			);
		}
		if (carriedDeferred.length > 0) {
			// #2522 review round 4, S1: the ONE pushed record for this path. The
			// MCP / Stop-hook route calls `handleTurnEnd` with `dbg: noop`, so every
			// line above is invisible there and the deferral machinery — the part
			// that decides whether a suite runs at all — left no trace whatsoever
			// on the route that fires it most.
			logLatency({
				type: "phase",
				toolName: "turn_end",
				filePath: cwd,
				phase: "test_runner_deferral",
				durationMs: 0,
				metadata: {
					carried: carriedDeferred.length,
					redispatched: redispatchedDeferred,
					heldOverCap,
					retired: retiredThisTurn,
					dropped: deadDeferred,
					foreignSession: foreignDeferred,
					sessionId: turnSessionId,
				},
			});
		}

		let overCapTargets = 0;
		let missingTargetFiles = 0;
		let excludedTargets = 0;
		let retiredSkips = 0;
		let noTestFile = 0;
		const candidatesByRoot = new Map<string, number>();
		for (const { display, abs, isNeighbor } of candidates) {
			// #3871: select in the checkout that owns the edit. For an edit the
			// session owns this is `cwd`, exactly as before.
			const testRoot = testRootFor(abs);
			candidatesByRoot.set(testRoot, (candidatesByRoot.get(testRoot) ?? 0) + 1);
			const target = testRunnerClient.getTestRunTarget(
				abs,
				testRoot,
				runtime.turnIndex,
			);
			const targetKey = target ? normalizeMapKey(target.testFile) : "";
			if (target && !seen.has(targetKey)) {
				seen.add(targetKey);
				// #2522 review round 3, F1: THE gate that makes the deferral cap a
				// cap. Whichever strategy produced this target — related, self,
				// failed-first — a target already retired this session for
				// outrunning the whole batch budget is not fired again. Without
				// this the retire branch above was decorative: it logged, and the
				// candidate loop three lines down re-resolved the same file and
				// spawned it anyway, with its attempt counter reset to zero.
				if (retiredKeys.has(targetKey)) {
					retiredSkips++;
					dbg(
						`turn_end: ${display} → test target retired earlier this session (outran the turn-end batch budget), skipping spawn (${path.relative(cwd, target.testFile)})`,
					);
					continue;
				}
				// #2522: the shared turn-end gate excludes integration/e2e targets,
				// out-of-tree files, and foreign Git checkouts, whichever strategy
				// (failed-first/related/self) produced the target. No project knob.
				// Cache admission and retirement reject foreign-checkout failures;
				// this gate still covers self/related discovery and deferred targets.
				// The log must not claim a specific cause from a boolean verdict.
				if (isExcludedTestTarget(target.testFile, testRoot)) {
					excludedTargets++;
					dbg(
						`turn_end: ${display} → test target excluded by the built-in turn-end policy, skipping spawn (${path.relative(cwd, target.testFile)})`,
					);
					continue;
				}
				// #2504: a conventional target that no longer exists on disk still
				// cost a full runner spawn, which came back "Test file not found"
				// and was then dropped as an expected skip further down. 9 of the
				// reported turn's 59 spawns were this. One statSync is cheaper
				// than a vitest process by four orders of magnitude.
				if (!fs.existsSync(target.testFile)) {
					missingTargetFiles++;
					dbg(
						`turn_end: ${display} → test file missing, skipping spawn (${path.relative(cwd, target.testFile)})`,
					);
					continue;
				}
				if (targets.length >= TEST_RUNNER_MAX_TARGETS) {
					overCapTargets++;
					continue;
				}
				targets.push({ ...target, sourceFile: abs, testRoot });
				dbg(
					`turn_end: ${display} → test ${target.runner} ${path.relative(cwd, target.testFile)} (${target.strategy}${isNeighbor ? ", cascade-neighbor" : ""})`,
				);
			} else if (!target) {
				noTestFile++;
				dbg(
					`turn_end: ${display} → no test file found${isNeighbor ? " (cascade-neighbor)" : ""}`,
				);
			}
		}
		if (excludedTargets > 0) {
			dbg(
				`turn_end: excluded ${excludedTargets} test target(s) by the built-in turn-end policy`,
			);
		}
		if (retiredSkips > 0) {
			dbg(
				`turn_end: skipped ${retiredSkips} test target(s) retired earlier this session for outrunning the turn-end batch budget`,
			);
		}
		if (missingTargetFiles > 0) {
			dbg(
				`turn_end: skipped ${missingTargetFiles} test target(s) whose file no longer exists`,
			);
		}
		if (overCapTargets > 0) {
			// Never silent: the agent is told that some of this turn's tests were
			// not run, rather than reading an all-green batch that covered part
			// of the edit set.
			recordDegradationOnce({
				kind: "test-runner-batch-capped",
				subject: cwd,
				reason: `turn touched more test targets than one turn may fire; ran ${TEST_RUNNER_MAX_TARGETS}, skipped ${overCapTargets} — re-run the remainder with lens_diagnostics or edit them in a smaller batch`,
			});
			dbg(
				`turn_end: test target count capped at ${TEST_RUNNER_MAX_TARGETS}, ${overCapTargets} skipped`,
			);
		}
		if (candidates.length > 0) {
			// #3871: ONE record per turn, pushed (the MCP / Stop-hook route's dbg
			// is a no-op), so a turn that ran 0 tests says which checkout owned
			// each edit and why nothing was selected. The live session that
			// ran 0 tests in 44 turn-ends left only per-edit dbg lines.
			const selectedByRoot = new Map<string, number>();
			for (const target of targets) {
				selectedByRoot.set(
					target.testRoot,
					(selectedByRoot.get(target.testRoot) ?? 0) + 1,
				);
			}
			const roots = [...candidatesByRoot.entries()].map(
				([root, candidateCount]) => ({
					root: root === cwd ? "." : toRunnerDisplayPath(cwd, root),
					candidates: candidateCount,
					selected: selectedByRoot.get(root) ?? 0,
				}),
			);
			emitBounded(
				"turn_end_test_selection",
				`${cwd}:turn:${runtime.turnIndex}`,
				{
					filePath: cwd,
					durationMs: 0,
					metadata: {
						sessionId: turnSessionId,
						candidates: candidates.length,
						selected: targets.length,
						noTestFile,
						excluded: excludedTargets,
						missing: missingTargetFiles,
						overCap: overCapTargets,
						retired: retiredSkips,
						roots: roots.slice(0, TURN_END_SELECTION_ROOT_ROWS),
						rootsOmitted: Math.max(
							0,
							roots.length - TURN_END_SELECTION_ROOT_ROWS,
						),
					},
				},
			);
		}
		if (targets.length > 0) {
			for (const target of targets) {
				target.fileSeqAtRun = runtime.getFileSeq(target.sourceFile);
			}
			dbg(
				`turn_end: firing ${targets.length} test target(s) async (non-blocking, max ${TEST_RUNNER_BATCH_CONCURRENCY} concurrent)`,
			);
			const firedAtTurn = runtime.turnIndex;
			const firedSessionId = turnSessionId;
			const testRunGeneration = (priorTestCache?.testRunGeneration ?? 0) + 1;
			const provenanceFiles = [
				...candidates.map((candidate) => ({
					path: candidate.abs,
					role: "source" as const,
				})),
				...targets.map((target) => ({
					path: target.testFile,
					role: "test" as const,
				})),
			];
			const launchedFrom = snapshotAdvisoryProvenance({
				cwd,
				runtime,
				generation: testRunGeneration,
				files: provenanceFiles,
			});
			writeTestFindings(
				{
					...(priorTestCache ?? { content: "" }),
					testRunGeneration,
				},
				// Consumed above into `targets` (or retired, or dropped). Anything
				// this turn HELD is re-asserted by the writer itself; the batch's own
				// outcome adds the NEW cut set below.
				[],
			);
			runTestTargetsBounded({
				targets,
				concurrency: TEST_RUNNER_BATCH_CONCURRENCY,
				budgetMs: TEST_RUNNER_BATCH_BUDGET_MS,
				// Both bounds, per AGENTS.md: a wall budget AND the ambient
				// abort signal the rest of the spawn layer already honours.
				signal: getAmbientAbortSignal(),
				run: (t, batchSignal) =>
					testRunnerClient.runTestFileAsync(t.testFile, t.testRoot, {
						runner: t.runner,
						config: t.config,
						turnIndex: firedAtTurn,
						// #2522 R2 F1: the BATCH's signal, so spending the 20s wall
						// budget kills this spawn rather than letting it run out its
						// own 60s timeout behind a batch that has already returned.
						signal: batchSignal,
						// #3871 r2: a failure in a linked worktree reads relative to the
						// session checkout (`.worktrees/x/tests/a.test.ts:12`), which
						// may hold a file at the worktree-relative path.
						displayRoot: cwd,
						// A worktree root without its own runner install is skipped, not
						// run through `npx` (a network fetch) or a bare interpreter.
						requireOwnInstall: t.testRoot !== cwd,
					}),
			})
				.then(({ results: batchResults, deferred, stopReason }) => {
					const settledResults = batchResults as Array<
						PromiseSettledResult<TestResult>
					>;
					// #3871 r2: a target the client refused to start is neither a pass
					// nor a failure. Counted here, then taken out of everything below
					// so a batch of refusals never publishes a clean run.
					const results: Array<PromiseSettledResult<TestResult>> = [];
					for (const result of settledResults) {
						if (!("value" in result) || !result.value.notRun) {
							results.push(result);
							continue;
						}
						const skippedRoot =
							targets.find(
								(candidate) => candidate.testFile === result.value.file,
							)?.testRoot ?? cwd;
						// #3871: name the refused borrow only when the shell actually
						// set an ambient Python environment.
						const ambientNote =
							result.value.runner === "pytest" && hasAmbientPythonEnvironment()
								? "; ambient Python environments outside this checkout were not borrowed"
								: "";
						incrementDegradationCount({
							kind: "turn-end-test-root-skipped",
							subject: result.value.notRun,
							reason: `${toRunnerDisplayPath(cwd, skippedRoot)} has no ${result.value.runner} install of its own${ambientNote}; its tests were skipped rather than fetched through npx or run in another environment`,
						});
						dbg(
							`turn_end: skipped ${toRunnerDisplayPath(cwd, result.value.file)}: ${result.value.notRun} in ${toRunnerDisplayPath(cwd, skippedRoot)}`,
						);
					}
					const verdicts = results.flatMap((result) => {
						if (result.status === "rejected") return [];
						const target = targets.find(
							(candidate) => candidate.testFile === result.value.file,
						);
						return target
							? [
									{
										file: result.value.file,
										sourceFile: target.sourceFile,
										fileSeq:
											target.fileSeqAtRun === undefined
												? ({
														state: "unknown",
														reason: "sequence-unavailable",
													} as const)
												: ({
														state: "known",
														value: target.fileSeqAtRun,
													} as const),
									},
								]
							: [];
					});
					const deferredTargets: DeferredTestTarget[] = deferred.map((t) => ({
						testFile: t.testFile,
						sourceFile: t.sourceFile,
						runner: t.runner,
						// One more cut batch for this target. Read back by the
						// selection loop above, which retires it at
						// TEST_RUNNER_MAX_DEFERRALS rather than carrying it forever.
						attempts: (t.deferralAttempts ?? 0) + 1,
						// #2522 R3 F5: stamped with the session that cut it, so the
						// next session re-arms this target instead of inheriting an
						// attempt count measured under a load it never saw.
						sessionId: firedSessionId,
					}));
					if (deferred.length > 0) {
						// #2522 review round 2, F4: `incrementDegradationCount`, not
						// `recordDegradationOnce`. At a 20s budget this is a
						// RECURRING event, and a once-per-subject entry reports the
						// tenth cut batch of a session exactly like the first.
						incrementDegradationCount({
							kind: "test-runner-batch-capped",
							subject: `${cwd}:${stopReason ?? "incomplete"}`,
							reason: `test batch stopped early (${stopReason ?? "incomplete"}); ${deferred.length} target(s) killed or never dispatched, deferred to the next turn`,
						});
						dbg(
							`turn_end: test batch stopped early (${stopReason ?? "incomplete"}), ${deferred.length} target(s) deferred to the next turn`,
						);
					}
					const deferralNote =
						deferred.length > 0
							? `${deferred.length} test target(s) did not finish within the turn-end batch budget and are deferred to the next turn (they run first): ${deferredTargets
									.map((t) => path.relative(cwd, t.testFile))
									.join(", ")}`
							: "";
					/**
					 * A newer batch has already published for this project — this
					 * one's results are stale by construction and must not overwrite
					 * it. Was inlined three times; extracted once round 2 added a
					 * fourth call site.
					 */
					const supersededByNewerGeneration = (label: string): boolean => {
						const current = cacheManager.readCache<TestRunnerFindingsCache>(
							"test-runner-findings",
							cwd,
						)?.data;
						const currentGeneration = current?.testRunGeneration;
						if (
							currentGeneration !== undefined &&
							currentGeneration > testRunGeneration
						) {
							dbg(
								`turn_end: ${label}test generation ${testRunGeneration} superseded by ${currentGeneration}`,
							);
							// #2522 review round 3, F3: returning here USED to drop this
							// batch's cut targets entirely. The newer batch's own pre-run
							// write already cleared them, and it never saw this set — so
							// with two overlapping batches the targets the older one was
							// cut on were never deferred, never re-selected, and the suite
							// they belong to simply never ran again. Hand them over
							// instead. Round 4, I2: the merge is `writeTestFindings`'s own
							// rule now, not a second copy of it here — every branch below
							// merges the same way, so a NEWER batch publishing after this
							// one no longer flattens what this hand-over just recorded.
							if (deferredTargets.length > 0) {
								writeTestFindings(
									{ ...(current ?? { content: "" }) },
									deferredTargets,
								);
								dbg(
									`turn_end: ${label}carried ${deferredTargets.length} cut target(s) into the newer generation's deferral set`,
								);
							}
							return true;
						}
						return false;
					};
					const publishedAgainst = snapshotAdvisoryProvenance({
						cwd,
						runtime,
						generation: testRunGeneration,
						files: provenanceFiles,
					});
					const superseded =
						launchedFrom.revision.sessionId !==
							publishedAgainst.revision.sessionId ||
						launchedFrom.revision.projectSeq !==
							publishedAgainst.revision.projectSeq ||
						launchedFrom.revision.turnIndex !==
							publishedAgainst.revision.turnIndex ||
						launchedFrom.files.some(
							(file, index) =>
								publishedAgainst.files[index]?.sha256 !== file.sha256 ||
								publishedAgainst.files[index]?.path !== file.path,
						);
					// #628: the turn advancing while tests ran no longer means the
					// results are thrown away — a late result is still real
					// information about what's currently broken. It's tagged `stale`
					// so a downstream consumer can distinguish it from a result that
					// arrived in time, but it's cached either way.
					const stale = runtime.turnIndex !== firedAtTurn;
					const failures: string[] = [];
					const resultValues: TestResult[] = [];
					let rejectedCount = 0;
					// #2522: whether ANY reported item is a genuine failing test
					// (`failed > 0`) as opposed to the runner itself never
					// completing (timeout, missing provider/binary, a rejected
					// promise). Drives the delivery framing below — a batch made
					// up ENTIRELY of runner errors is not something the agent
					// introduced, so it must not read as "fix before continuing".
					let hasRealFailure = false;
					for (const r of results) {
						if (r.status === "rejected") {
							rejectedCount++;
							emitBounded(
								"test_runner_delivery",
								`${cwd}:generation:${testRunGeneration}:rejected`,
								{
									filePath: cwd,
									durationMs: 0,
									metadata: {
										outcome: "runner-promise-rejected",
										sessionId: firedSessionId,
										generation: testRunGeneration,
										targetCount: targets.length,
										droppedDetailCount: 0,
										reason: String(r.reason).slice(0, 500),
									},
								},
								{
									ledgerKind: "test-runner-delivery",
									reason: "test runner promise rejected",
									capPerTurn: { limit: 8, turnIndex: firedAtTurn },
								},
							);
							dbg(`turn_end: test run rejected — ${r.reason}`);
							continue;
						}
						resultValues.push(r.value);
						const { file, runner, passed, failed, duration, error } = r.value;
						if (failed > 0) hasRealFailure = true;
						const shortFile = path.basename(file);
						// #1479: `(0ms)` used to be printed for a run nobody
						// timed — a payload with no suite timestamps, an
						// unrecognised summary line, or an empty result — and
						// that is the same string a genuinely sub-millisecond
						// run produces. A reader could not tell "measured 0"
						// from "not measured", which is the confusion #1452 was
						// reported for. `duration` is now absent when it was
						// never measured, and this line says which one it has.
						//
						// #1480: the test is `formatRunDurationMs`, not an
						// inline comparison. The "absent = unmeasured" contract
						// was being re-derived at every site that read a
						// duration, and a site that gets it slightly wrong —
						// treating a measured `0` as absent — puts the bug back
						// without touching this comment.
						const elapsed = formatRunDurationMs(duration);
						// Lifted out of the template below for the same reason
						// `elapsed` is: the pair read as a nested ternary, which
						// this line only got flagged for because #1479 touched it.
						const verdict = failed > 0 ? "FAIL" : "PASS";
						// #2532 review S1: folded onto `isRunnerErrorResult` instead of
						// re-deriving `error && passed === 0 && failed === 0` here — that
						// local spelling missed a runner error reported alongside partial
						// passes (pytest `Interrupted` after some tests already passed),
						// which read as a clean "PASS Np/0f" line with the error silently
						// dropped. A partial run says so explicitly rather than reading
						// as a clean pass.
						const summary = isRunnerErrorResult(r.value)
							? passed > 0
								? `error: ${error} (${passed} passed before)`
								: `error: ${error}`
							: `${verdict} ${passed}p/${failed}f (${elapsed})`;
						dbg(
							`turn_end: ${stale ? "[stale] " : ""}test ${runner} ${shortFile} → ${summary}`,
						);
						// #1524: also fires on `error` alone, not just `failed > 0`.
						// A runner error (the suite never started, or was
						// interrupted before finishing — spawn/config/timeout
						// failure) can arrive with `failed === 0` even when tests
						// DID pass before it (#2532 review S2 — not "by
						// construction": `parsePytestOutput` sets `error` from the
						// exit code independently of the parsed counts, so
						// `isRunnerErrorResult` is `failed === 0 && !!error`, not an
						// invariant elsewhere). Gating on `failed > 0` alone dropped
						// it silently: the agent got no context at all, and the
						// empty `failures` array below sent this result down the
						// "all tests passed" branch, clearing any prior real
						// test-failure git-guard blocker. `formatResult` already
						// renders the error-only case as "Could not run tests: ...".
						if (failed > 0 || error) {
							// #2028: "Test file not found" is an expected skip
							// (conventional test path without an actual file),
							// not an actionable failure. Don't surface it.
							if (
								error &&
								String(r.value?.error ?? "").includes("Test file not found")
							) {
								continue;
							}
							const formatted = testRunnerClient.formatResult(r.value);
							if (formatted) failures.push(formatted);
						}
					}
					if (rejectedCount > 0) {
						failures.push(
							`Test runner rejected ${rejectedCount} promise(s) before producing a structured result.`,
						);
					}
					if (failures.length > 0) {
						if (supersededByNewerGeneration("")) return;
						const content = [
							stale
								? "[from a prior turn — the edit that triggered this run had already been superseded by the time results came back]"
								: "",
							failures.join("\n\n"),
							// A batch can BOTH find a real failure and be cut short.
							// The agent needs to see the failure AND that the run was
							// incomplete, or it reads a partial list as the full one.
							deferralNote,
						]
							.filter(Boolean)
							.join("\n\n");
						// #2522: nothing in this batch is a genuine failing test —
						// every entry is a runner error (timeout, missing
						// provider/binary, a rejected promise). `peekTestFindings`
						// reads this to deliver advisory framing instead of
						// "fix before continuing", since the agent introduced
						// nothing here to fix.
						const runnerErrorOnly = !hasRealFailure;
						writeTestFindings(
							{
								content,
								stale,
								results: resultValues,
								verdicts,
								testRunGeneration,
								launchedFrom,
								publishedAgainst,
								provenance: publishedAgainst,
								superseded,
								runnerErrorOnly,
							},
							deferredTargets,
						);
						try {
							deps.onTestRunnerComplete?.({
								cwd,
								sessionId: firedSessionId,
								generation: testRunGeneration,
								targetCount: targets.length,
								hasFindings: true,
							});
						} catch (deliveryErr) {
							dbg(`turn_end: test delivery staging failed — ${deliveryErr}`);
						}
						if (
							getFlag("lens-guard") &&
							firedSessionId === runtime.telemetrySessionId
						) {
							// #1524: `&& !value.error` — a runner-error result has
							// `failed === 0` (the suite never ran, so nothing could
							// fail), but it is not a pass. Without the filter it
							// would clear a prior real test-failure git-guard
							// blocker on the strength of a suite that never
							// started. And the call itself is skipped when this
							// list is empty rather than passed as `[]`:
							// `clearGitGuardTestFailure`'s own empty-array
							// fallback treats "no files named" as "clear every
							// blocked file", so an all-error batch (one go file,
							// runner-error, zero clean files) would otherwise
							// clear every blocker through that fallback instead
							// of clearing none.
							const cleanFiles = resultValues
								.filter((value) => value.failed === 0 && !value.error)
								.map((value) => value.file);
							if (cleanFiles.length > 0) {
								clearGitGuardTestFailure(
									cacheManager,
									cwd,
									runtime,
									cleanFiles,
								);
							}
							// #2532: `runnerErrorOnly` (computed above for the turn-end
							// delivery framing) is true exactly when nothing in this
							// batch is a genuine failing test — every entry is a
							// runner error the agent did not introduce. Without this
							// gate, an all-runner-error batch still called
							// `mergeGitGuardTestFailure` with an EMPTY failed-files
							// list, which unconditionally sets `hasBlockers: true`:
							// the identical event the turn-end message reports as
							// advisory read as "COMMIT BLOCKED" under --lens-guard.
							if (!runnerErrorOnly) {
								mergeGitGuardTestFailure(
									cacheManager,
									cwd,
									runtime,
									content,
									resultValues
										.filter((value) => value.failed > 0)
										.map((value) => value.file),
								);
							} else {
								// #2532 review T2: the skip above is otherwise pull-only —
								// nothing records that a batch with real content
								// (`failures.length > 0`) was deliberately kept OFF the
								// `--lens-guard` blocker because every entry was a runner
								// error. Same phase/ledger as the rejected-promise event
								// above, so both `--lens-guard` demotions land in one
								// queryable place. Reached only inside the enclosing
								// `getFlag("lens-guard") && firedSessionId === …` check —
								// no point recording a demotion the flag can't act on.
								emitBounded(
									"test_runner_delivery",
									`${cwd}:generation:${testRunGeneration}:runner-error-only`,
									{
										filePath: cwd,
										durationMs: 0,
										metadata: {
											outcome: "runner-error-only-not-blocking",
											sessionId: firedSessionId,
											generation: testRunGeneration,
											targetCount: targets.length,
											droppedDetailCount: 0,
										},
									},
									{
										ledgerKind: "test-runner-delivery",
										reason:
											"runner-error-only batch kept off the --lens-guard blocker",
										capPerTurn: { limit: 8, turnIndex: firedAtTurn },
									},
								);
							}
						}
						dbg(
							`turn_end: ${failures.length} test failure(s) cached for pull diagnostics and post-agent delivery${stale ? " (stale — turn advanced while tests ran)" : ""}`,
						);
					} else if (deferred.length > 0) {
						// #2522 review round 2, F1: a PARTIAL batch is not a clean
						// batch. Pre-round-2 this fell through to the branch below —
						// `content: ""`, "all tests passed", and a `--lens-guard`
						// clear — on the strength of a run that never finished. The
						// record names the deferral instead; the commit gate is left
						// exactly as it was, because nothing here proves anything
						// passed that was not already proven.
						if (supersededByNewerGeneration("deferred ")) return;
						writeTestFindings(
							{
								content: deferralNote,
								stale,
								results: resultValues,
								verdicts,
								testRunGeneration,
								launchedFrom,
								publishedAgainst,
								provenance: publishedAgainst,
								superseded,
								// Advisory framing: an unfinished batch is not a
								// failure the agent introduced, exactly like a runner
								// error. See `TestRunnerFindingsCache.runnerErrorOnly`.
								runnerErrorOnly: true,
							},
							deferredTargets,
						);
						try {
							deps.onTestRunnerComplete?.({
								cwd,
								sessionId: firedSessionId,
								generation: testRunGeneration,
								targetCount: targets.length,
								hasFindings: true,
							});
						} catch (deliveryErr) {
							dbg(`turn_end: test delivery staging failed — ${deliveryErr}`);
						}
						dbg(
							`turn_end: partial test batch — ${results.length} target(s) settled, ${deferred.length} deferred to the next turn; NOT recorded as a clean run`,
						);
					} else if (results.length > 0) {
						if (supersededByNewerGeneration("clean ")) return;
						writeTestFindings(
							{
								...(priorTestCache ?? { content: "" }),
								content: "",
								stale: false,
								results: resultValues,
								testRunGeneration,
								launchedFrom,
								publishedAgainst,
								provenance: publishedAgainst,
								superseded,
							},
							// Nothing was cut. This turn's own settled entries drop out;
							// I2 keeps every row this batch does not own — including a
							// concurrent older batch's hand-over.
							[],
						);
						try {
							deps.onTestRunnerComplete?.({
								cwd,
								sessionId: firedSessionId,
								generation: testRunGeneration,
								targetCount: targets.length,
								hasFindings: false,
							});
						} catch (deliveryErr) {
							dbg(`turn_end: test delivery staging failed — ${deliveryErr}`);
						}
						if (
							getFlag("lens-guard") &&
							firedSessionId === runtime.telemetrySessionId
						) {
							clearGitGuardTestFailure(
								cacheManager,
								cwd,
								runtime,
								resultValues.map((value) => value.file),
							);
						}
						dbg(
							`turn_end: all tests passed${stale ? " (stale — turn advanced while tests ran)" : ""}`,
						);
					}
				})
				.catch(() => {});
		} else if (carriedDeferred.length > 0) {
			// Nothing fired, so no batch outcome will write the list back, but this
			// turn still settled part of it (targets retired at the cap, or dropped
			// because their file is gone). Persist that here rather than re-reading
			// a set of dead paths on every future turn; `writeTestFindings` carries
			// this turn's retirements alongside, which is what the deferral-cap
			// branch above depends on when it retires the LAST carried target and
			// fires nothing. Rows this turn only HELD (over the cap) or does not
			// own (another session's) are re-asserted by the writer itself.
			writeTestFindings({ ...(priorTestCache ?? { content: "" }) }, []);
		}
	}

	if (runtime.errorDebtBaseline && files.length > 0) {
		dbg("turn_end: marking error debt check for next session");
		cacheManager.writeCache(
			"errorDebt",
			{
				pendingCheck: true,
				baselineTestsPassed: runtime.errorDebtBaseline.testsPassed,
			},
			cwd,
		);
	}

	// Session summaries are intentionally suppressed at turn_end to avoid
	// distracting the agent with non-blocking telemetry.

	// Call-graph impact analysis — surface WillBreak/MayBreak callers for modified
	// symbols. MUST run BEFORE the writeProjectDiagnosticsDeltaReport serialization
	// below: it is a delta contributor (like knip above), pushing into
	// projectDiagnosticsDelta / projectDiagnosticsSources. If it ran after the
	// single write, a call-graph-only turn would persist nothing and a mixed turn
	// would drop the call-graph entries — so lens_diagnostics (which only reads the
	// persisted report) would never surface the findings (#179/#533).
	if (runtime.callGraph && files.length > 0) {
		const coverage = runtime.callGraph.coverage;
		if (!coverage || coverage.complete !== true) {
			// An incomplete graph can still contain useful edges, but emitting them
			// as ordinary impact findings would turn unsupported/partial extraction
			// into an authoritative-looking clean result for the rest of the file.
			// Keep the limitation visible and require a complete graph for this
			// user-facing impact surface (#1070).
			// @delivery-surface: runtime-turn:call-graph-advisory
			advisoryParts.push(
				"Call-graph impact was not emitted because call-graph extraction coverage is incomplete; " +
					"the affected files may have unreported callers.",
			);
		} else {
			const callGraphStart = Date.now();
			try {
				const { impact, formatImpact, parseSymbolKey } =
					await import("./call-graph.js");
				const { callGraphImpactToProjectDiagnostics } =
					await import("./project-diagnostics/runner-adapters/call-graph-impact.js");
				const impactLines: string[] = [];
				/** #3248: bounded per-turn, never per finding. */
				let callGraphDispositionSuppressed = 0;
				const impactFindings: {
					calleeKey: string;
					results: ReturnType<typeof impact>;
				}[] = [];
				// #3813: files whose impact lines the cap cut on the previous turn.
				// Impact is recomputed from the CURRENT graph, so a re-offer is as
				// fresh as any line; a file edited again this turn is simply fresh.
				const impactFiles = files.slice(0, 5);
				const impactFileKeys = new Set(
					impactFiles.map((file) =>
						normalizeMapKey(resolveRunnerPath(cwd, file)),
					),
				);
				const reOfferedImpactFiles = takeParked<string>(
					carryLane("call-graph"),
				).filter(
					(file) =>
						!impactFileKeys.has(normalizeMapKey(resolveRunnerPath(cwd, file))),
				);
				/** Files that contributed a line to the part. */
				const shownImpactFiles: string[] = [];
				for (const filePath of [...impactFiles, ...reOfferedImpactFiles]) {
					const linesBefore = impactLines.length;
					// Turn-state files may be cwd-relative while graph keys are absolute,
					// and persisted graphs can contain either slash style/casing. Compare
					// through the shared normalized path seam; keep the original filePath
					// only for display and diagnostics.
					const changedFileKey = normalizeMapKey(
						resolveRunnerPath(cwd, filePath),
					);
					const fileCallerKeys = [...runtime.callGraph.callers.keys()].filter(
						(k) => {
							const graphFilePath = parseSymbolKey(k).filePath;
							return (
								normalizeMapKey(resolveRunnerPath(cwd, graphFilePath)) ===
								changedFileKey
							);
						},
					);
					for (const calleeKey of fileCallerKeys.slice(0, 3)) {
						// #1080: drop KNOWN test-role callers BEFORE both the human advisory
						// (formatImpact below) and the persisted delta (impactFindings →
						// callGraphImpactToProjectDiagnostics) — the advisory is rendered
						// first, so the filter must reach the shared `results` set that feeds
						// both. A test caller supplied by an old/fixture/expanded graph must
						// appear in neither surface. Fail-open: an unparseable/unclassifiable
						// key is retained (the adapter re-applies the same predicate).
						const results = impact(runtime.callGraph, calleeKey).filter((r) => {
							const callerFile = parseSymbolKey(r.symbolKey).filePath;
							return (
								!callerFile ||
								!isTestRoleCollateral(resolveRunnerPath(cwd, callerFile))
							);
						});
						if (results.length > 0) {
							impactFindings.push({ calleeKey, results });
							// #3248: the rendered line takes the stored-disposition
							// filter. A result is mapped to its diagnostic by the
							// lane's OWN adapter, ONE result at a time, so the
							// identity can never diverge from the one
							// `lens_diagnostics` surfaces and a mark anchors against
							// — and a result the adapter does not map (the Review
							// tier, an unattributable key, a test-role caller) is
							// kept unconditionally: it is not markable, so nothing
							// may suppress it. Re-rendered with `formatImpact`, the
							// same renderer, never a second one.
							// `flatMap` rather than a push-under-an-`if`: an entry the
							// adapter does not map simply yields nothing, so the array
							// is well-typed with no branch whose removal changes no
							// behaviour (there is nothing here to mutate).
							const markable = results.flatMap((result) =>
								callGraphImpactToProjectDiagnostics(cwd, [
									{ calleeKey, results: [result] },
								]).map((diagnostic) => ({ result, diagnostic })),
							);
							const filtered = filterFindingsByDisposition(
								markable,
								cwd,
								(entry) => entry.diagnostic,
							);
							callGraphDispositionSuppressed += filtered.suppressed;
							const keptEntries = new Set(filtered.kept);
							const dropped = new Set(
								markable
									.filter((entry) => !keptEntries.has(entry))
									.map((entry) => entry.result),
							);
							const survivors =
								dropped.size === 0
									? results
									: results.filter((r) => !dropped.has(r));
							const summary =
								survivors.length > 0 ? formatImpact(survivors, cwd) : "";
							if (summary)
								impactLines.push(
									`  ${parseSymbolKey(calleeKey).symbolName ?? calleeKey}: ${summary}`,
								);
						}
					}
					if (impactLines.length > linesBefore) shownImpactFiles.push(filePath);
				}
				if (impactLines.length > 0) {
					const impactPart = `📊 Call-graph impact (changed symbols have callers):\n${impactLines.join("\n")}`;
					// @delivery-surface: runtime-turn:call-graph-advisory
					advisoryParts.push(impactPart);
					deliveryHolds.push(
						cutAdvisoryHold(
							"call-graph",
							carryLane("call-graph"),
							impactPart,
							shownImpactFiles,
							(file) => !impactFiles.includes(file),
						),
					);
				}
				if (impactFindings.length > 0) {
					const impactDiagnostics = callGraphImpactToProjectDiagnostics(
						cwd,
						impactFindings,
					);
					if (impactDiagnostics.length > 0) {
						projectDiagnosticsDelta.push(...impactDiagnostics);
						projectDiagnosticsSources.add("call-graph");
					}
				}
				// #3248: this lane wrote nothing per turn, so its delivery decision
				// — including how many callers a stored disposition dropped — was
				// unobservable. One bounded row per turn, only when the lane ran.
				if (impactFindings.length > 0 || callGraphDispositionSuppressed > 0) {
					logLatency({
						type: "phase",
						toolName: "turn_end",
						filePath: cwd,
						phase: "call_graph_impact",
						durationMs: Date.now() - callGraphStart,
						metadata: {
							callees: impactFindings.length,
							lines: impactLines.length,
							dispositionSuppressed: callGraphDispositionSuppressed,
						},
					});
				}
				// Non-fatal — call graph is best-effort
			} catch {
				// Non-fatal — call graph is best-effort
			}
		}
	}

	if (projectDiagnosticsDelta.length > 0) {
		writeProjectDiagnosticsDeltaReport(cwd, {
			version: PROJECT_DIAGNOSTICS_CACHE_VERSION,
			cwd,
			generatedAt: new Date().toISOString(),
			sessionId: runtime.telemetrySessionId,
			turnIndex: runtime.turnIndex,
			projectSeqStart: runtime.turnStartProjectSeq,
			projectSeqEnd: runtime.projectSeq,
			diagnostics: projectDiagnosticsDelta,
			sources: [...projectDiagnosticsSources].sort((a, b) =>
				a.localeCompare(b),
			),
		});
	}

	const t4 = Date.now();
	const modifiedRangesByFile = new Map(
		Object.entries(turnState.files).map(([file, state]) => [
			normalizeMapKey(resolveRunnerPath(cwd, file)),
			state.modifiedRanges,
		]),
	);
	const getFileSeq = (runtime as Partial<RuntimeCoordinator>).getFileSeq;
	const fileSeqByPath = new Map<string, number>();
	if (getFileSeq) {
		for (const file of files) {
			const filePath = normalizeMapKey(resolveRunnerPath(cwd, file));
			fileSeqByPath.set(filePath, getFileSeq.call(runtime, filePath));
		}
	}
	let reverify: PersistentReverifyResult | undefined;
	if (getFlag("lens-actionable-warnings")) {
		// #3170: re-verify carried deferred findings before the advisory
		// assembles — a finding whose file is unchanged re-serves from the
		// persisted report without ever being re-observed; root-cause-fixed-
		// elsewhere findings converge here instead of repeating. Bounded in the
		// module (≤4 files, wall budget, abort signal). #3176 F1: the
		// replacement entries fold into THIS turn's single in-band publish
		// below — a separate replacement publish spends the carry marker and
		// this publish then drops the entries at the scope guard (the blocker
		// the review caught).
		const persistedReport = cacheManager.readCache<ActionableWarningsReport>(
			"actionable-warnings",
			cwd,
			Number.MAX_SAFE_INTEGER,
		)?.data;
		if (persistedReport?.files?.some((entry) => entry.origin === "deferred")) {
			const reverifyLspService = getLSPService();
			if (reverifyLspService) {
				// #2523: the hook-path await is bound-wrapped with the hook's own
				// budget and signal; the pass's internal deadline (3s) is the
				// tighter of the two.
				reverify = await bounded(
					runPersistentReverify({
						report: persistedReport,
						cwd,
						lspService: reverifyLspService,
						signal: getAmbientAbortSignal(),
					}),
					{
						ms: HOOK_WALL_BUDGET_MS.turn_end,
						signal: getAmbientAbortSignal(),
						hook: "turn_end",
						label: "persistent_reverify",
					},
				);
			}
		}
		try {
			const report = await buildActionableWarningsReport({
				cwd,
				sessionId: runtime.telemetrySessionId,
				turnIndex: runtime.turnIndex,
				files,
				modifiedRangesByFile,
				dispatchWarnings: runtime.peekActionableWarnings(sessionId),
				includeLspCodeActions: !!getFlag("lens-actionable-warning-actions"),
				projectSeqStart: runtime.turnStartProjectSeq,
				projectSeqEnd: runtime.projectSeq,
				// #3676: the quick fix credits its writes with this epoch.
				branchEpoch: runtime.readGuard.currentBranchEpoch,
				branchScope: runtime.readGuard.lineageKey,
				fileSeqByPath,
				deltaOnly: !getFlag("lens-actionable-warning-all"),
				dbg,
				// #2504: this call is AWAITED on the turn_end hook, so its cost is
				// terminal-blocking time. The file cap and wall budget are its
				// bounds; the abort signal is the second one AGENTS.md requires.
				signal: getAmbientAbortSignal(),
				// A cold-cache turn hands the fresh-pull loop back here, off the
				// hook — it lands in the same cache the in-band report goes to.
				onDeferredReport: (deferred) => {
					try {
						// #2504 review round 2 (F2): GUARDED. This callback fires up
						// to a minute after the turn that armed it, and the report
						// it carries is stamped with THAT turn's
						// turnIndex/projectSeq. Writing it unconditionally
						// overwrote a newer report, which `agent_end` then rejected
						// as `project_seq_mismatch` (silently skipping the autofix
						// pass) and `lens_diagnostics` re-served as a stale delta.
						// #2504 review round 4 (F1): guarded PER FILE, not per
						// report. The round-3 shape (publish, or discard whole
						// when something newer is persisted) composed with
						// incumbent-wins into "publish nothing" — every turn_end
						// with modified files persists an in-band report with a
						// strictly increasing turnIndex, and the decline fires
						// exactly when such a turn runs while a loop is in
						// flight, so a decline always implied a supersede. The
						// merge upserts the entries whose file has not moved and
						// drops only those that have.
						writeDeferredActionableWarningsReport({
							cacheManager,
							cwd,
							report: deferred,
							// The LIVE per-file sequence at WRITE time is the
							// baseline the merge judges each entry against. The
							// runtime is the only thing that knows it: a file
							// edited into cleanliness by a later turn is absent
							// from the persisted report entirely.
							getFileSeq: getFileSeq
								? (filePath: string) => getFileSeq.call(runtime, filePath)
								: undefined,
							dbg,
						});
					} catch (deferErr) {
						dbg(
							`turn_end: deferred actionable-warnings write failed — ${deferErr}`,
						);
					}
				},
			});
			// #2504 review round 5 (F1): THE publish choke point. This was a
			// blind `writeActionableWarningsReport` while the deferred callback
			// above read-modify-wrote the SAME cache key. The deferred merge can
			// land anywhere inside this handleTurnEnd -- the cascade settle,
			// knip, madge, the test batch, the in-band LSP enrichment are all
			// awaited between the moment it is armed and the moment we get
			// here -- and the blind write erased it 607 ms later in the
			// reviewer's trace. The publisher now always reads what is persisted
			// and merges per file, so the two writers cannot race. It carries
			// forward only entries a DEFERRAL produced, and only while their
			// file has not moved, so a `turn_delta` report does not accumulate
			// every prior turn's findings.
			// #3176 F1: the re-verify replacements fold into THIS report — one
			// in-band publish total, so the carry marker is spent exactly once and
			// the merged report cannot drop the entries behind the publish (the
			// blocker the review caught).
			if (reverify?.replacementFiles.length) {
				const replacementByPath = new Map(
					reverify.replacementFiles.map((file) => [
						normalizeMapKey(file.filePath),
						file,
					]),
				);
				const files = (report.files ?? []).map(
					(file) =>
						replacementByPath.get(normalizeMapKey(file.filePath)) ?? file,
				);
				for (const replacement of reverify.replacementFiles) {
					if (
						!files.some(
							(file) =>
								normalizeMapKey(file.filePath) ===
								normalizeMapKey(replacement.filePath),
						)
					) {
						files.push(replacement);
					}
				}
				report.files = files;
			}
			const publishResult = publishActionableWarningsReport(
				cacheManager,
				cwd,
				report,
				{
					origin: "in-band",
					getFileSeq: getFileSeq
						? (filePath: string) => getFileSeq.call(runtime, filePath)
						: undefined,
					dbg,
				},
			);
			// #2504 review round 6 (a): the advisory must read the MERGED report,
			// not the pre-merge `report` this turn assembled -- a rescued deferred
			// entry lives only on `publishResult.report`, and formatting the
			// pre-merge report silently dropped it from the turn_end advisory
			// even though it was correctly persisted to cache.
			// #2521: `cwd` is what resolves the store location the advisory
			// names -- it is the SAME cwd `publishActionableWarningsReport`
			// just wrote through, so the two cannot disagree.
			const advisory = formatActionableWarningsAdvisory(
				publishResult.report,
				cwd,
				host,
				(report): ActionableWarningsAdvisoryFilterResult => {
					let dispositionSuppressed = 0;
					const files = report.files
						.map((file) => {
							const policy = filterFindingsByDisposition(
								file.warnings,
								cwd,
								(warning) => {
									const { line, column, rule, code } = warning;
									return {
										filePath: warning.filePath,
										severity: warning.severity,
										semantic: "warning",
										tool: warning.tool,
										runner: warning.tool,
										message: warning.message,
										source: warning.origin === "lsp" ? "lsp" : "dispatch",
										...(line === undefined ? {} : { line: warning.line }),
										...(column === undefined ? {} : { column: warning.column }),
										...(rule === undefined ? {} : { rule: warning.rule }),
										...(code === undefined ? {} : { code }),
									};
								},
							);
							dispositionSuppressed += policy.suppressed;
							const kept = policy.kept.filter(
								(warning) =>
									!(
										isSecretWarning(warning) &&
										typeof warning.line === "number" &&
										secretBlockedLocations.has(
											secretLocationKey(warning.filePath, warning.line),
										)
									),
							);
							return kept.length > 0 ? { ...file, warnings: kept } : undefined;
						})
						.filter(
							(file): file is NonNullable<typeof file> => file !== undefined,
						);
					recordDispositionSuppressed(
						"actionable-warnings",
						dispositionSuppressed,
					);
					return { files, suppressed: dispositionSuppressed };
				},
			);
			// @delivery-surface: runtime-turn:actionable-warnings-advisory
			if (advisory) advisoryParts.push(advisory);
			logActionableWarningsEvent({
				event: advisory ? "advisory_injected" : "advisory_skipped",
				sessionId: runtime.telemetrySessionId,
				metadata: {
					turnIndex: runtime.turnIndex,
					// #2504 review round 7 (F2): the MERGED report, matching the
					// advisory text above it (round 6, a) -- a rescued deferred
					// entry lives only on `publishResult.report`, and the pre-merge
					// `report` this turn assembled undercounts it. This is the value
					// scripts/analyze-pi-lens-logs.mjs sums, so an undercount here is
					// a silent miscount there too.
					unsuppressed: publishResult.report.summary.unsuppressed,
				},
			});
			logLatency({
				type: "phase",
				toolName: "turn_end",
				filePath: cwd,
				phase: "actionable_warnings_report",
				durationMs: Date.now() - t4,
				metadata: report.summary,
			});
		} catch (err) {
			dbg(`turn_end: actionable warning report failed: ${err}`);
			logLatency({
				type: "phase",
				toolName: "turn_end",
				filePath: cwd,
				phase: "actionable_warnings_report",
				durationMs: Date.now() - t4,
				metadata: {
					failed: true,
					error: err instanceof Error ? err.message : String(err),
				},
			});
		}
	}

	const t5 = Date.now();
	try {
		// #3248: the code-quality records were filtered at DISPATCH time, before
		// any `lens_diagnostic_mark`. `lens_diagnostics mode=delta` re-applies
		// dispositions when it re-serves this same cache
		// (`tools/lens-diagnostics.ts`'s `visibleWarningFiles`), so without this
		// the turn-end advisory counted warnings the delta view had already
		// dropped — the two surfaces disagreed about the same records. Filtered
		// at the report INPUT so the advisory, the persisted report and the delta
		// view all agree; the delta view's own filter then re-applies to the same
		// set and is idempotent. Per file, because the anchor is content-bound.
		const qualityWarningsByFile = new Map<string, CodeQualityWarningRecord[]>();
		for (const warning of runtime.peekCodeQualityWarnings(sessionId)) {
			const group = qualityWarningsByFile.get(warning.filePath);
			if (group) group.push(warning);
			else qualityWarningsByFile.set(warning.filePath, [warning]);
		}
		const qualityWarnings: CodeQualityWarningRecord[] = [];
		let qualityDispositionSuppressed = 0;
		for (const [filePath, group] of qualityWarningsByFile) {
			let content: string | undefined;
			try {
				content = fs.readFileSync(filePath, "utf-8");
			} catch {
				content = undefined;
			}
			const { kept, suppressed } = applyPushedFindingPolicy(group, {
				cwd,
				filePath,
				content,
			});
			qualityWarnings.push(...kept);
			qualityDispositionSuppressed += suppressed;
		}
		const qualityReport = buildCodeQualityWarningsReport({
			cwd,
			sessionId: runtime.telemetrySessionId,
			turnIndex: runtime.turnIndex,
			warnings: qualityWarnings,
			modifiedRangesByFile,
			projectSeqStart: runtime.turnStartProjectSeq,
			projectSeqEnd: runtime.projectSeq,
			fileSeqByPath,
		});
		writeCodeQualityWarningsReport(cacheManager, cwd, qualityReport);
		appendCodeQualityWarningsHistory(cwd, qualityReport);
		const advisory = formatCodeQualityWarningsAdvisory(
			qualityReport,
			cwd,
			host,
		);
		// @delivery-surface: runtime-turn:code-quality-warnings-advisory
		if (advisory) advisoryParts.push(advisory);
		logLatency({
			type: "phase",
			toolName: "turn_end",
			filePath: cwd,
			phase: "code_quality_warnings_report",
			durationMs: Date.now() - t5,
			metadata: {
				...qualityReport.summary,
				// #3248: bounded per-turn on this lane's own row.
				dispositionSuppressed: qualityDispositionSuppressed,
			},
		});
	} catch (err) {
		dbg(`turn_end: code quality warning report failed: ${err}`);
		logLatency({
			type: "phase",
			toolName: "turn_end",
			filePath: cwd,
			phase: "code_quality_warnings_report",
			durationMs: Date.now() - t5,
			metadata: {
				failed: true,
				error: err instanceof Error ? err.message : String(err),
			},
		});
	}

	cacheManager.incrementTurnCycle(cwd, currentOwner);

	// #2001/#2002: collect-later delivery for auxiliary LSP servers whose
	// aux-grace window expired without a publication (opengrep on Windows:
	// ~8s per scan against a 2s grace — the scanner's eventual findings sat
	// in its client cache, agent-invisible). Probe each pending pair through
	// the read-only cache seam (never spawns), freshness-gate the result
	// against when the pair was marked, and deliver survivors as an advisory.
	// A pair whose client is alive but has STILL published nothing re-arms
	// (baseline preserved, TTL anchor advanced) until the re-arm TTL; a dead
	// client drops silently.
	const lateAuxStart = Date.now();
	// #2168: cap evictions retire a pair before any drain can observe it — read
	// and reset that count here so it folds into this turn's reconciliation
	// sum instead of the pair vanishing uncounted.
	// #4161: both belong to the session current now; a replaced one takes none.
	const { drainedPairs, lateAuxCapEvicted } = holdScope.guardedWrite(
		"turn-end:late-aux",
		() => ({
			drainedPairs: drainPendingAuxiliaryCoverage(),
			lateAuxCapEvicted: drainPendingAuxCapEvictedCount(),
		}),
	) ?? { drainedPairs: [], lateAuxCapEvicted: 0 };
	/**
	 * #4161: a re-arm after the probe's await lands only in this session.
	 * True when it landed: a dropped one is the stale-write row's, never a
	 * `rearmed` count (#4168 F2).
	 */
	const rearmLateAux = (pair: (typeof drainedPairs)[number]): boolean =>
		holdScope.guardedWrite(
			// One subject for the store (#4168 F3): the row's count carries how many.
			"turn-end:late-aux-rearm",
			() => {
				rearmPendingAuxiliaryCoverage(pair);
				return true;
			},
		) === true;
	let lateAuxDelivered = 0;
	let lateAuxStale = 0;
	let lateAuxMissing = 0;
	let lateAuxRearmed = 0;
	// #3482: informational, like `probeFailed` — the pair still resolves
	// through rearmed/expired/ceilingExhausted.
	let lateAuxBacklogPending = 0;
	let lateAuxClientGone = 0;
	let lateAuxProbeFailed = 0;
	let lateAuxCleanConfirmed = 0;
	let lateAuxExpired = 0;
	let lateAuxCeilingExhausted = 0;
	let lateAuxAnswered = 0;
	let lateAuxNotifyStallDemoted = 0;
	// #3813: what the turn-end holds did with pairs the cap cut, after the drain's
	// own row above was already logged (see `settleHolds`).
	let lateAuxHoldRearmed = 0;
	let lateAuxHoldExpired = 0;
	let lateAuxHoldCeiling = 0;
	// #3102: dropped by the shared finding-policy stack (inline `pi-lens-ignore`
	// / stored disposition / `.pi-lens.json` rule policy) and, separately, by the
	// auxiliary profile's OWN native suppression inside `retagAuxiliaryDiagnostics`.
	// Both are reported in the one bounded per-turn record below — a drop is
	// never silent (shape 10).
	let lateAuxDispositionSuppressed = 0;
	let lateAuxAuxSuppressed = 0;
	const lateAuxCoverageGapPairs: Array<{
		filePath: string;
		serverId: string;
	}> = [];
	let lateAuxCoverageGapDetailCount = 0;
	let lateAuxCoverageGapDropCount = 0;
	const lateAuxStuckPairs: Array<{ filePath: string; serverId: string }> = [];
	if (drainedPairs.length > 0) {
		const lateObserverDeadline = Date.now() + HOOK_WALL_BUDGET_MS.turn_end;
		const byFile = new Map<string, typeof drainedPairs>();
		for (const pair of drainedPairs) {
			const list = byFile.get(pair.filePath);
			if (list) list.push(pair);
			else byFile.set(pair.filePath, [pair]);
		}
		try {
			const service = getLSPService();
			for (const [lateAuxPath, pairs] of byFile) {
				let cached: Map<
					string,
					{
						diags: LSPDiagnostic[];
						publishedAt?: number;
						notifyStallDemoted?: boolean;
						demotedAt?: number;
					}
				>;
				try {
					cached = await service.readCachedDiagnosticsForServers(
						lateAuxPath,
						new Set(pairs.map((p) => p.serverId)),
					);
				} catch {
					// #2027 round-1 P3-2 / #2167 R2-2: a transient probe rejection
					// tells us nothing about the pair's content, so treat it like the
					// "still scanning" branch below — re-arm under the SAME
					// ceiling/TTL bound rather than dropping the coverage outright.
					// `probeFailed` stays an honest per-turn failure count; it is
					// informational (like `stale`/`missing`), not a terminal bucket,
					// since the pair itself still resolves through rearmed/
					// ceilingExhausted/expired below.
					lateAuxProbeFailed += pairs.length;
					for (const pair of pairs) {
						if (canRearmPendingAuxiliary(pair)) {
							if (rearmLateAux(pair)) lateAuxRearmed += 1;
						} else if (isPendingAuxiliaryPastRearmTtl(pair)) {
							lateAuxExpired += 1;
						} else {
							lateAuxCeilingExhausted += 1;
						}
					}
					continue;
				}
				const displayLateAuxPath = toRunnerDisplayPath(cwd, lateAuxPath);
				// #3102: the file's CURRENT bytes, for the two content-bound halves
				// of the policy stack (inline `pi-lens-ignore` and the STRICT
				// `false-positive` anchor) and for the auxiliary profile's own
				// native suppression. Read at most ONCE per file per drain, lazily:
				// a turn that drains nothing, finds no live client, re-arms, or
				// confirms clean pays no I/O at all, and a file with several pending
				// servers pays one read for all of them. Measured cost on the one
				// file that does publish: 0.10-0.20 ms typical, 4.0 ms worst case
				// (a 180 KB file, 5 findings, a populated disposition store) against
				// the 3000 ms `HOOK_WALL_BUDGET_MS.turn_end`. A read failure yields
				// `undefined`: the content-free half still applies and nothing is
				// hidden on an I/O error (shape 48).
				let lateAuxContentRead = false;
				let lateAuxContentValue: string | undefined;
				const readLateAuxContent = (): string | undefined => {
					if (!lateAuxContentRead) {
						lateAuxContentRead = true;
						try {
							lateAuxContentValue = fs.readFileSync(lateAuxPath, "utf-8");
						} catch {
							lateAuxContentValue = undefined;
						}
					}
					return lateAuxContentValue;
				};
				for (const pair of pairs) {
					const cachedEntry = cached.get(pair.serverId);
					if (cachedEntry === undefined) {
						// No live client for this server any more — best-effort probe,
						// drop the pair silently.
						lateAuxClientGone += 1;
						continue;
					}
					if (cachedEntry.notifyStallDemoted) {
						if (
							cachedEntry.demotedAt === undefined ||
							pair.markedAtMs > cachedEntry.demotedAt
						) {
							// A pair marked after teardown belongs to the missing
							// generation, so it follows ordinary clientGone handling.
							lateAuxClientGone += 1;
							continue;
						}
						// #2356: notify-stall teardown is a transient absence while the
						// breaker cools down, but only for a pair marked before teardown.
						lateAuxNotifyStallDemoted += 1;
						const pastTtl = isPendingAuxiliaryPastRearmTtl(pair);
						const atCeiling = (pair.rearmCount ?? 0) >= MAX_LATE_AUX_REARMS;
						if (!pastTtl && !atCeiling) {
							if (rearmLateAux(pair)) {
								lateAuxRearmed += 1;
								if (lateAuxStuckPairs.length < 20)
									lateAuxStuckPairs.push({
										filePath: pair.filePath,
										serverId: pair.serverId,
									});
							}
						} else {
							if (pastTtl) lateAuxExpired += 1;
							else lateAuxCeilingExhausted += 1;
							lateAuxCoverageGapPairs.push({
								filePath: pair.filePath,
								serverId: pair.serverId,
							});
						}
						continue;
					}
					const rawDiags = cachedEntry.diags;
					// #3482: a version-less publish after the mark can still be an
					// OLDER scan's answer when a re-touch re-marked while it was in
					// flight. Wait until the scanner has published past the backlog
					// it had at the mark.
					const backlogPending = !isAuxBacklogPublished(pair);
					if (backlogPending) lateAuxBacklogPending += 1;
					if (
						cachedEntry.publishedAt === undefined ||
						cachedEntry.publishedAt <= pair.markedAtMs ||
						backlogPending
					) {
						// Still scanning (or published nothing yet) — keep waiting
						// so a scan finishing before the NEXT turn end still
						// delivers. Two clocks, deliberately decoupled: the
						// freshness baseline (`markedAtMs`) NEVER moves — it is what
						// the delivery gate stats against — while the re-arm TTL is
						// anchored on `lastRearmedAtMs`, advanced by every successful
						// empty probe: the scanner is demonstrably alive, just slow.
						if (canRearmPendingAuxiliary(pair)) {
							if (rearmLateAux(pair)) {
								lateAuxRearmed += 1;
								if (lateAuxStuckPairs.length < 20)
									lateAuxStuckPairs.push({
										filePath: pair.filePath,
										serverId: pair.serverId,
									});
							}
						} else {
							if (isPendingAuxiliaryPastRearmTtl(pair)) lateAuxExpired += 1;
							else lateAuxCeilingExhausted += 1;
						}
						continue;
					}
					// A demoted auxiliary still answers through this late path. Feed the
					// publication-minus-mark interval into the re-promotion streak. This is
					// delivery latency observed by the drain, not the scanner's total scan
					// latency. Cache priming is
					// below the freshness gate so a changed file cannot resurrect stale data.
					if (typeof service.observeLateAuxiliaryAnswer === "function") {
						await bounded(
							service.observeLateAuxiliaryAnswer(
								lateAuxPath,
								pair.serverId,
								cachedEntry.publishedAt - pair.markedAtMs,
							),
							{
								ms: Math.max(1, lateObserverDeadline - Date.now()),
								signal: deps.signal /* late observer */,
								hook: "turn_end",
								label: "observeLateAuxiliaryAnswer",
							},
						);
					}
					if (rawDiags.length === 0) {
						lateAuxCleanConfirmed += 1;
						continue;
					}
					// `convertLspDiagnostics` drops entries with no start line, which
					// would break the 1:1 index alignment `retagAuxiliaryDiagnostics`
					// needs. Partition first so `converted[i]` IS `anchored[i]` —
					// the same pre-partition `applyLspFindingPolicy` does.
					const anchored = rawDiags.filter(
						(d) => d.range?.start?.line !== undefined,
					);
					if (anchored.length === 0) {
						lateAuxMissing += rawDiags.length;
						lateAuxAnswered += 1;
						continue;
					}
					const lateAuxContent = readLateAuxContent();
					const converted = convertLspDiagnostics(anchored, lateAuxPath);
					// #3046/#3047: the auxiliary's REAL tool id (and its own native
					// inline suppression — opengrep's `# nosemgrep`, ast-grep's
					// test-file gate), from the ONE shared derivation every other
					// surface anchors a mark against. These diagnostics come straight
					// off the aux client's cache, so nothing upstream applied it.
					const retained = retagAuxiliaryDiagnostics(
						converted,
						anchored,
						lateAuxContent ?? "",
						{ cwd, fileRole: detectFileRole(lateAuxPath, lateAuxContent) },
					);
					lateAuxAuxSuppressed += converted.length - retained.length;
					if (retained.length === 0) {
						lateAuxAnswered += 1;
						continue;
					}
					// Freshness kernel (#1634 gated surface): stat the cited file
					// against the mark timestamp. Missing → drop (no remediation for
					// a deleted file); mtime drifted past the mark → drop too, NOT
					// demote — unlike the cached-blocker gates these findings were
					// NEVER delivered before, and the edit that drifted the file
					// already re-touched it (a fresh pending pair supersedes this
					// one), so a stale-arm replay would double-report old content.
					// Both drops are COUNTED here and in the latency record below —
					// never silent (shape 10).
					const { "late-auxiliary-findings": gate } =
						gateFindingsByPathFreshness({
							cwd,
							sources: {
								"late-auxiliary-findings": {
									findings: retained,
									scannedAt: pair.markedAtMs,
									citedPath: () => lateAuxPath,
								},
							},
						});
					lateAuxStale += gate.stale.length;
					lateAuxMissing +=
						retained.length - gate.live.length - gate.stale.length;
					if (gate.live.length === 0) {
						if (gate.stale.length > 0) {
							// Stale findings mean the scan predates the last edit. Re-arm
							// with the SAME baseline and carry the ceiling count (#3482:
							// a refreshed baseline absorbed the edit, so an older queued
							// scan that published later passed both gates).
							if (canRearmPendingAuxiliary(pair)) {
								if (rearmLateAux(pair)) lateAuxRearmed += 1;
							} else if (isPendingAuxiliaryPastRearmTtl(pair)) {
								lateAuxExpired += 1;
							} else {
								lateAuxCeilingExhausted += 1;
							}
						} else {
							lateAuxAnswered += 1;
						}
						continue;
					}
					// #2810 round 4: this drain does NOT write the hash-bound
					// last-known record. The prime it used to call could only fire when
					// a record already existed at the pair's hash — which requires a
					// FULLY covered touch of those exact bytes, the one case where the
					// scanner's findings are already in the record — so it was a no-op
					// in the demoted steady state it was added for, and a #570/#1470
					// hazard everywhere else (an auxiliary-only array replacing the
					// merged one). Late findings reach the agent as the gated advisory
					// below; the turn-end hash-guarded fast path stays cold for a file
					// whose touch was partial, which is exactly what #1470 requires.
					// #3102: the survivors are what the agent READS, so they take the
					// same `clients/dispatch/finding-policy.ts` stack — inline
					// `pi-lens-ignore` → stored dispositions → `.pi-lens.json` rule
					// policy — the per-edit dispatcher, `mode=full` and the
					// `source=lsp` probe lane apply. Without it a finding the agent
					// marked `false-positive` re-reported on every turn that drained
					// a late pair. Runs AFTER the freshness gate, like the #1625
					// govulncheck/secrets filters: the anchor is derived from the
					// post-gate identity, never the raw pre-gate set.
					// #3248: the four arguments moved into
					// `applyPushedFindingPolicy` so the late-RUNNER drain below
					// cannot make a second copy of them. Same stack, same
					// identities, same fail-open content rule.
					const { kept: lateAuxKept, suppressed: lateAuxSuppressedHere } =
						applyPushedFindingPolicy(gate.live, {
							cwd,
							filePath: lateAuxPath,
							content: lateAuxContent,
						});
					lateAuxDispositionSuppressed += lateAuxSuppressedHere;
					if (lateAuxKept.length === 0) {
						// Every late finding was suppressed. This is a PUSH surface:
						// silence after a mark is the mark working, not a clean
						// verdict, so the count rides the bounded per-turn record below
						// instead of re-announcing the suppression every single turn.
						lateAuxAnswered += 1;
						continue;
					}
					const lines = lateAuxKept.map(
						(f) =>
							`  ${displayLateAuxPath}:${f.line}:${f.column} [${f.rule}] ${f.message}`,
					);
					lateAuxDelivered += lateAuxKept.length;
					lateAuxAnswered += 1;
					// #1616 suppressed-bucket rule: a delivery that still has
					// something to say states what it dropped, once per delivery.
					const lateAuxSuppressedNote =
						lateAuxSuppressedHere > 0
							? `; suppressed by disposition: ${lateAuxSuppressedHere} finding(s)`
							: "";
					const lateAuxPart = `🕐 Late auxiliary diagnostics (${pair.serverId} answered after its grace window${lateAuxSuppressedNote}):\n${lines.join("\n")}`;
					// @delivery-surface: runtime-turn:late-auxiliary-findings
					advisoryParts.push(lateAuxPart);
					// #3813: the drain cleared the pair. A cut part re-arms it under
					// the pair's own TTL and ceiling, with its baseline unmoved, so
					// the scanner's findings are probed and re-gated next turn.
					deliveryHolds.push({
						part: lateAuxPart,
						canHold: () => canRearmPendingAuxiliary(pair),
						onHeld: () => {
							rearmPendingAuxiliaryCoverage(pair);
							lateAuxHoldRearmed += 1;
						},
						onDropped: () => {
							// The bound the drain's own branches count as expired or
							// ceilingExhausted: a delivered-then-cut pair past it is lost.
							if (isPendingAuxiliaryPastRearmTtl(pair)) lateAuxHoldExpired += 1;
							else lateAuxHoldCeiling += 1;
							incrementDegradationCount({
								kind: "late-auxiliary-held-dropped",
								subject: `late-auxiliary:${pair.serverId}`,
								reason:
									"cut by the turn-end cap and past its re-arm bound, so not re-armed",
							});
						},
					});
				}
			}
		} catch (err) {
			dbg(`turn_end: late-auxiliary probe failed: ${err}`);
		}
		// #2356: a demoted scanner that never gets replaced remains a coverage
		// gap. Re-raise it once when the existing bounded late-pair window closes,
		// preserving the server/file identity in both the ledger and latency row.
		for (const pair of lateAuxCoverageGapPairs) {
			const normalizedPairPath = normalizeMapKey(pair.filePath);
			const emitted = emitBounded(
				"lsp_scanner_coverage_gap",
				`${pair.serverId}:${normalizedPairPath}`,
				{
					filePath: normalizedPairPath,
					durationMs: 0,
					metadata: {
						source: "late-auxiliary",
						serverIds: [pair.serverId],
						reason: "notify-stall-replacement-unavailable",
						reRaised: true,
					},
				},
				{
					ledgerKind: "lsp-scanner-coverage-gap",
					reason:
						"notify-stall replacement was not available before late-coverage ceiling",
					capPerTurn: {
						limit: LATE_AUX_COVERAGE_GAP_DETAIL_CAP_PER_TURN,
						turnIndex: runtime.turnIndex,
					},
				},
			);
			if (emitted) lateAuxCoverageGapDetailCount += 1;
			else lateAuxCoverageGapDropCount += 1;
		}
		logLatency({
			type: "phase",
			toolName: "turn_end",
			filePath: cwd,
			phase: "late_auxiliary_findings",
			durationMs: Date.now() - lateAuxStart,
			metadata: {
				pending: drainedPairs.length,
				pairCreated: drainedPairs.length + lateAuxCapEvicted,
				pendingAfter: pendingAuxiliaryCoverageSize(),
				delivered: lateAuxDelivered,
				stale: lateAuxStale,
				missing: lateAuxMissing,
				rearmed: lateAuxRearmed,
				backlogPending: lateAuxBacklogPending,
				clientGone: lateAuxClientGone,
				probeFailed: lateAuxProbeFailed,
				cleanConfirmed: lateAuxCleanConfirmed,
				expired: lateAuxExpired,
				ceilingExhausted: lateAuxCeilingExhausted,
				answered: lateAuxAnswered,
				dispositionSuppressed: lateAuxDispositionSuppressed,
				auxSuppressed: lateAuxAuxSuppressed,
				notifyStallDemoted: lateAuxNotifyStallDemoted,
				coverageGapReRaised: lateAuxCoverageGapPairs.length,
				coverageGapReRaisedDetailed: lateAuxCoverageGapDetailCount,
				coverageGapReRaisedDropped: lateAuxCoverageGapDropCount,
				capEvicted: lateAuxCapEvicted,
				stuckPairs: lateAuxStuckPairs,
			},
		});
	}

	// #3218 criterion 2: files whose inline blocker a fresh clean verdict
	// retired during the turn. The coordinator's retire seam recorded which
	// file, how many blockers, and the retiring write; this composer only
	// formats them. Consumed HERE, once, so a retire is delivered exactly once
	// (the coordinator clears its list and the line cannot re-serve).
	const unresolvedKeys = new Set(
		unresolvedBlockers.map((record) =>
			normalizeMapKey(path.resolve(record.filePath)),
		),
	);
	// A file this message still lists under `Unresolved` is HELD for the next
	// turn_end, not dropped: a retire that landed after the snapshot above
	// (the awaits between it and here) is real, and discarding it leaves the
	// agent holding a STOP block for a file that is clean.
	const formatResolvedTail = (dropped: number) => `… and ${dropped} more`;
	const resolvedTailMax = formatResolvedTail(Number.MAX_SAFE_INTEGER).length;
	const resolvedShareChars =
		Math.floor(RUNTIME_CONFIG.turnEnd.maxChars * RESOLVED_SHARE_OF_CHARS) -
		resolvedTailMax;
	const formatResolvedLine = (entry: ResolvedBlockerFile): string => {
		const clause = entry.confirmedClean
			? " confirmed clean"
			: entry.writeIndex === undefined
				? ""
				: ` cleared by the ${formatWriteOrdinal(entry.writeIndex)} write`;
		// "This turn" only for a retire from this turn; an entry a turn_end
		// that delivered nothing left behind is "since the last report".
		const label =
			entry.turnIndex === runtime.turnIndex
				? "Resolved this turn"
				: "Resolved since the last report";
		const head = `${label}: `;
		const tail = ` (${entry.blockerCount} blocker(s)${clause})`;
		let display = toRunnerDisplayPath(cwd, entry.filePath);
		// review-3776-r3 W2: no line is wider than the share, so the one line
		// the floor below always takes can never be the part the cap cuts. The
		// path loses its middle; both ends (root and file name) stay.
		const room = resolvedShareChars - 1 - head.length - tail.length;
		if (display.length > room) {
			const keepHead = Math.ceil((room - 1) / 2);
			display = `${sliceAtCodePointBoundaries(display, 0, keepHead)}…${sliceAtCodePointBoundaries(display, display.length - (room - 1 - keepHead), display.length)}`;
		}
		return `${head}${display}${tail}`;
	};
	// review-3776-verify V1 + review-3776-r3 W1: the section rides FIRST in
	// the message and is sized BEFORE anything is consumed, on both of
	// `capTurnEndMessage`'s axes, to what the live blockers after it leave
	// (their text plus the `\n\n` joining them), never past its share. Room
	// for the widest tail is kept on both axes. So the cap cuts neither a
	// consumed line nor a blocker. A line that does not fit is HELD for the
	// next turn_end; the first is always taken, so the held list drains.
	const blockerText = blockerParts.join("\n\n");
	const blockerChars = blockerParts.length > 0 ? blockerText.length + 2 : 0;
	const blockerLines =
		blockerParts.length > 0 ? blockerText.split("\n").length + 1 : 0;
	const resolvedCharBudget = Math.min(
		resolvedShareChars,
		RUNTIME_CONFIG.turnEnd.maxChars - blockerChars - resolvedTailMax,
	);
	const resolvedLineBudget =
		Math.min(
			RESOLVED_MAX_LINES,
			RUNTIME_CONFIG.turnEnd.maxLines - blockerLines,
		) - 1;
	let resolvedChars = 0;
	let resolvedCount = 0;
	const {
		files: resolvedBlockerFileList,
		dropped: resolvedBlockerFilesDropped,
	} = runtime.consumeResolvedBlockerFiles((entry) => {
		if (unresolvedKeys.has(normalizeMapKey(path.resolve(entry.filePath))))
			return true;
		const cost = formatResolvedLine(entry).length + 1;
		if (
			resolvedCount > 0 &&
			(resolvedCount >= resolvedLineBudget ||
				resolvedChars + cost > resolvedCharBudget)
		)
			return true;
		resolvedChars += cost;
		resolvedCount += 1;
		return false;
	});
	const resolvedLines = resolvedBlockerFileList.map(formatResolvedLine);
	if (resolvedBlockerFilesDropped > 0) {
		resolvedLines.push(formatResolvedTail(resolvedBlockerFilesDropped));
	}
	// ONE section, `\n`-joined: ten separate `\n\n`-separated sections would
	// spend 19 of the turn-end message's 20-line budget on blank separators
	// and let `capTurnEndMessage` truncate the overflow line away.
	const resolvedParts =
		resolvedLines.length > 0 ? [resolvedLines.join("\n")] : [];

	const asIs = (raw: string): ComposedPart => ({ raw, text: raw });
	// Stale-secret parts sit between the two tiers and are NOT relabelled — they
	// ship the imperative preamble they were built with (#1622 review M2).
	// `raw` is the entry as the producer pushed it, which is what a delivery
	// hold names (#3813); `text` is what the message carries.
	const composedParts: ComposedPart[] = [
		// #3218 criterion 2: the resolution lines ride FIRST, inside their
		// sized share, so the cap cuts neither a consumed retirement
		// (review-3776-verify V1) nor a live blocker (review-3776-r3 W1).
		// They are not a finding tier (no gate applies to a just-cleared
		// verdict), only a status line, and they are part of the block content
		// so an otherwise empty turn still delivers them ONCE (the coordinator
		// consumed them).
		...resolvedParts.map(asIs),
		...blockerParts.map(asIs),
		...staleSecretParts.map(asIs),
		// #3814: a blocking late-runner finding never reaches `advisoryParts`; it
		// rides the blocker replay, so every advisory part gets the label.
		...advisoryParts.map((raw) => ({
			raw,
			text: `ℹ️ Advisory — no action required this turn:\n${raw}`,
		})),
	];
	const findingParts = composedParts.map((part) => part.text);
	let heldSections = 0;
	if (findingParts.length > 0) {
		dbg(
			`turn_end: ${blockerParts.length} blocker section(s), ${advisoryParts.length} advisory section(s) found, persisting for next context`,
		);
		// #3813: judge every hold against what the cap keeps, before the
		// message is final: the marker names how many parts were held.
		const joined = findingParts.join("\n\n");
		const holdPlan = planDeliveryHolds({
			holds: deliveryHolds,
			parts: composedParts,
			keptChars: turnEndKeptChars(joined),
			separatorLength: "\n\n".length,
		});
		const settleHolds = (suppressed: boolean): void => {
			const outcome = holdPlan.settle({
				suppressed,
				isCurrentSession: () => holdScope.isCurrent(),
				onFault: (cause) => dbg(`turn_end: delivery hold failed: ${cause}`),
			});
			heldSections = outcome.held;
			if (lateAuxHoldRearmed + lateAuxHoldExpired + lateAuxHoldCeiling > 0) {
				// One row per turn: the `late_auxiliary_findings` row was logged
				// before the cap ran, so a hold's re-arm (or loss) is only here.
				logLatency({
					type: "phase",
					toolName: "turn_end",
					filePath: cwd,
					phase: "late_auxiliary_holds",
					durationMs: 0,
					metadata: {
						rearmed: lateAuxHoldRearmed,
						expired: lateAuxHoldExpired,
						ceilingExhausted: lateAuxHoldCeiling,
						pendingAfter: pendingAuxiliaryCoverageSize(),
					},
				});
			}
			if (outcome.held > 0) {
				// One counted row per turn, never one per held part.
				incrementDegradationCount({
					kind: "turn-end-sections-held",
					subject: "turn-end",
					reason: `${outcome.held} one-shot section(s) cut by the turn-end cap, kept pending for the next turn`,
				});
			}
		};
		const content = capTurnEndMessage(joined, holdPlan.heldCount);
		const signature = `${files
			.slice()
			.sort((a, b) => compareOrdinal(a, b))
			.join("|")}::${content}`;
		const last = cacheManager.readCache<{
			signature: string;
			sessionId: string;
		}>("turn-end-findings-last", cwd);
		if (
			last?.data?.signature === signature &&
			last?.data?.sessionId === runtime.telemetrySessionId &&
			// #3813: a retirement is an event, not a persisting finding. The
			// coordinator already consumed these entries, so an identical
			// second retirement on consecutive turns (same file, count and
			// ordinal) would be consumed and never shown (#3776 verify r3 F6).
			resolvedBlockerFileList.length === 0
		) {
			dbg(
				"turn_end: duplicate findings detected (same session), suppressing re-prompt",
			);
			if (getFlag("lens-guard")) {
				const existingGuard = cacheManager.readCache<
					Partial<TurnEndFindingsCache>
				>("turn-end-findings", cwd)?.data;
				if (existingGuard) {
					writeGitGuardRecord(cacheManager, runtime, cwd, {
						...(existingGuard as TurnEndFindingsCache),
						content,
						blockerContent:
							blockerParts.length > 0
								? capTurnEndMessage(blockerParts.join("\n\n"))
								: undefined,
						hasBlockers:
							blockerParts.length > 0 || existingGuard.testFailures === true,
						blockingFiles:
							blockerParts.length > 0 ? existingGuard.affectedFiles : undefined,
						projectSeqStart: runtime.turnStartProjectSeq,
						projectSeqEnd: runtime.projectSeq,
						fileSeqByPath: Object.fromEntries(
							runtime
								.getFileSeqEntries()
								.map(([filePath, seq]) => [
									normalizeMapKey(path.resolve(filePath)),
									seq,
								]),
						),
						fileContentHashes: {},
						consumed: false,
					});
				}
			}
			settleHolds(true);
			clearOwnedTurnState();
			runtime.fixedThisTurn.clear();
			resetFormatService();
			return;
		}
		// #1950 fix-round F1: this turn's content is confirmed NOT suppressed —
		// it is about to reach the agent — so NOW settle the holds: commit the
		// delivery-count increments the per-blocker loop above only tentatively
		// computed, and hand back whatever the cap cut (#3813).
		settleHolds(false);
		const fileSeqByPath: Record<string, number> = {};
		for (const [filePath, seq] of runtime.getFileSeqEntries()) {
			fileSeqByPath[normalizeMapKey(path.resolve(filePath))] = seq;
		}
		if (getFlag("lens-guard")) {
			const existingGuard = cacheManager.readCache<
				Partial<TurnEndFindingsCache>
			>("turn-end-findings", cwd)?.data;
			const blockingContent =
				blockerParts.length > 0
					? capTurnEndMessage(blockerParts.join("\n\n"))
					: undefined;
			const affectedFiles = [
				...(existingGuard?.affectedFiles ?? []),
				...files.map((file) => resolveRunnerPath(cwd, file)),
				...cascadeResults.flatMap((result) =>
					result.neighbors
						.filter((neighbor) => neighbor.diagnostics.length > 0)
						.map((neighbor) => resolveRunnerPath(cwd, neighbor.filePath)),
				),
			];
			writeGitGuardRecord(cacheManager, runtime, cwd, {
				content: [content, existingGuard?.testFailureContent]
					.filter((value): value is string => !!value)
					.join("\n\n"),
				blockerContent: blockingContent,
				blockingFiles: blockerParts.length > 0 ? affectedFiles : undefined,
				hasBlockers: !!blockingContent || existingGuard?.testFailures === true,
				affectedFiles,
				sessionId: runtime.telemetrySessionId,
				projectSeqStart: runtime.turnStartProjectSeq,
				projectSeqEnd: runtime.projectSeq,
				fileSeqByPath,
				fileContentHashes: {},
				consumed: false,
				testFailures: existingGuard?.testFailures,
				testFailureContent: existingGuard?.testFailureContent,
				testFailureFiles: existingGuard?.testFailureFiles,
			});
		} else {
			const allAffectedFiles = [
				...files.map((file) => resolveRunnerPath(cwd, file)),
				...cascadeResults.flatMap((result) =>
					result.neighbors
						.filter((neighbor) => neighbor.diagnostics.length > 0)
						.map((neighbor) => resolveRunnerPath(cwd, neighbor.filePath)),
				),
			];
			const affectedFiles = [...new Set(allAffectedFiles)].slice(
				0,
				MAX_ADVISORY_AFFECTED_FILES,
			);
			const affectedFilesTruncated =
				new Set(allAffectedFiles).size > affectedFiles.length;
			cacheManager.writeCache(
				"turn-end-findings",
				{
					content,
					affectedFiles,
					affectedFilesTruncated,
					provenance: snapshotAdvisoryProvenance({
						cwd,
						runtime,
						generation: 0,
						files: affectedFiles.map((file) => ({
							path: file,
							role: "affected" as const,
						})),
						truncated: affectedFilesTruncated,
					}),
				},
				cwd,
			);
		}
		cacheManager.writeCache(
			"turn-end-findings-last",
			{
				signature,
				sessionId: runtime.telemetrySessionId,
				projectSeqStart: runtime.turnStartProjectSeq,
				projectSeqEnd: runtime.projectSeq,
			},
			cwd,
		);
		emitLensTurnFindings({
			cwd,
			filePaths: files.map((file) => resolveRunnerPath(cwd, file)),
			sessionId: runtime.telemetrySessionId,
			turnIndex: runtime.turnIndex,
			blockerSections: blockerParts.length,
			advisorySections: advisoryParts.length,
			content,
		});
	}
	if (blockerParts.length === 0) {
		clearOwnedTurnState();
		// `staleSecretParts` counts here too (#1622 review M2): clearing the
		// findings record while a stale secret is still unverified would drop the
		// only surviving trace of it.
		if (
			getFlag("lens-guard") &&
			advisoryParts.length === 0 &&
			staleSecretParts.length === 0 &&
			// #3218 criterion 2: a resolved line is content worth delivering,
			// so it must not be erased by the no-blockers clean-up. The
			// reader clears it after delivery because `hasBlockers` is false.
			resolvedParts.length === 0 &&
			!runtime.gitGuardHasBlockers
		) {
			const guardRecord = cacheManager.readCache<Partial<TurnEndFindingsCache>>(
				"turn-end-findings",
				cwd,
			)?.data;
			if (
				guardRecord?.sessionId === runtime.telemetrySessionId &&
				guardRecord.testFailures !== true
			) {
				cacheManager.clearCache("turn-end-findings", cwd);
			}
		}
	}

	runtime.fixedThisTurn.clear();
	// #3613: only this turn's session's records; a concurrent session drains
	// its own at its own turn end.
	runtime.clearActionableWarnings(sessionId);
	runtime.clearCodeQualityWarnings(sessionId);
	if (demotedFindingsRetired > 0) {
		// #1944: the retired payload must not survive as a SUPPRESSION key.
		// `turn-end-findings-last` holds a content signature used to silence a
		// duplicate re-prompt; live evidence found the demoted payload still on
		// disk 80+ minutes after the file shrank. It is not a delivery source —
		// `runtime-context.ts` never reads it, and the read at the top of this
		// function is gated on the current `sessionId`, so it cannot resurrect
		// the finding in a later session. It CAN, however, silence a genuinely
		// new report of content the store no longer holds. Drop it with the
		// record it describes.
		cacheManager.clearCache("turn-end-findings-last", cwd);
	}
	logLatency({
		type: "tool_result",
		toolName: "turn_end",
		filePath: cwd,
		durationMs: Date.now() - turnEndStart,
		// #1622 review M2: a pending stale secret is NOT a clean turn. It gets its
		// own result rather than being promoted to `blockers_found`, which would
		// undo the demotion the freshness gate just made.
		result:
			blockerParts.length > 0
				? "blockers_found"
				: staleSecretParts.length > 0
					? "stale_secrets_pending"
					: "clean",
		metadata: {
			fileCount: files.length,
			blockerSections: blockerParts.length,
			staleSecretSections: staleSecretParts.length,
			advisorySections: advisoryParts.length,
			// #3218 criterion 2: how many files this turn LISTED as resolved
			// (held-back entries are not counted), and how many retire events
			// fell past the cap. The line itself is in the delivered content;
			// these make the feature visible in latency.log even when the block
			// is suppressed or the agent reads only telemetry.
			resolvedBlockerFiles: resolvedBlockerFileList.length,
			resolvedBlockerFilesDropped,
			// #3813: one-shot parts the cap cut that stay pending for the next turn.
			heldSections,
			// #1944 AC3: an empty advisory section on its own cannot say whether
			// the turn had nothing to report or dropped something. This counter
			// answers that from latency.log even when the payload is empty, and
			// the payload itself carries the retirement note when it is not.
			demotedFindingsRetired,
			// #2275: the widget-footer store's own dependency-drift retirements —
			// a separate surface/counter from `demotedFindingsRetired` above,
			// since a widget retirement never touches `advisoryParts` or the
			// `turn-end-findings-last` suppression cache the block below clears.
			widgetDemotedFindingsRetired,
		},
	});
	resetFormatService();
}
