import * as path from "node:path";
import {
	appendActionableWarningsHistory,
	buildActionableWarningsReport,
	formatActionableWarningsAdvisory,
	writeActionableWarningsReport,
} from "./actionable-warnings.js";
import { logActionableWarningsEvent } from "./actionable-warnings-logger.js";
import {
	appendCodeQualityWarningsHistory,
	buildCodeQualityWarningsReport,
	formatCodeQualityWarningsAdvisory,
	writeCodeQualityWarningsReport,
} from "./code-quality-warnings.js";
import type { CacheManager } from "./cache-manager.js";
import type { CascadeSkipReason } from "./cascade-types.js";
import {
	clearGitGuardTestFailure,
	mergeGitGuardTestFailure,
	writeGitGuardRecord,
	type TurnEndFindingsCache,
} from "./git-guard.js";
import { cascadeSettleWaitMs } from "./cascade-budget.js";
import { logCascade } from "./cascade-logger.js";
import { normalizeMapKey } from "./path-utils.js";
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
import type { GitleaksResult } from "./gitleaks-client.js";
import type { GovulncheckResult } from "./govulncheck-client.js";
import type { TrivyResult } from "./trivy-client.js";
import {
	dedupeSecretFindings,
	fromAstGrepWarnings,
	fromGitleaks,
	fromTrivySecrets,
	isSecretWarning,
	secretLocationKey,
} from "./secret-findings.js";
import type { KnipClient, KnipIssue, KnipResult } from "./knip-client.js";
import type { DeadCodeClient, DeadCodeResult } from "./dead-code-client.js";
import {
	deadCodeIssueKey,
	deadCodeIssues,
	formatDeadCodeDelta,
	stableFindingKey,
} from "./dead-code-client.js";
import { logDeadCodeScan } from "./dead-code-logger.js";
import {
	PROJECT_DIAGNOSTICS_CACHE_VERSION,
	writeProjectDiagnosticsDeltaReport,
} from "./project-diagnostics/cache.js";
import { deadCodeIssueToProjectDiagnostic } from "./project-diagnostics/runner-adapters/dead-code.js";
import { gitleaksFindingToProjectDiagnostic } from "./project-diagnostics/runner-adapters/gitleaks.js";
import { govulncheckFindingToProjectDiagnostic } from "./project-diagnostics/runner-adapters/govulncheck.js";
import {
	trivyFindingToProjectDiagnostic,
	trivySecretFindingToProjectDiagnostic,
} from "./project-diagnostics/runner-adapters/trivy.js";
import { knipIssuesToProjectDiagnostics } from "./project-diagnostics/runner-adapters/knip.js";
import type { ProjectDiagnostic } from "./project-diagnostics/types.js";
import { applyDispositionsMultiFile } from "./diagnostic-dispositions.js";
import { logLatency } from "./latency-logger.js";
import {
	getLspBudgetIdleTimeoutMs,
	shouldShortenLspIdleTimeout,
} from "./lsp-budget.js";
import { updateHeartbeat } from "./instance-registry.js";
import { emitLensTurnFindings } from "./lens-events.js";
import { RUNTIME_CONFIG } from "./runtime-config.js";
import { isSubagentSession } from "./subagent-mode.js";
import type { RuntimeCoordinator } from "./runtime-coordinator.js";
import type { TurnStateOwner } from "./cache-manager.js";
import { formatRunDurationMs } from "./run-duration.js";
import type { TestResult, TestRunnerClient } from "./test-runner-client.js";
import {
	MAX_ADVISORY_AFFECTED_FILES,
	gateFindingsByPathFreshness,
	snapshotAdvisoryProvenance,
} from "./advisory-provenance.js";
import { sweepInlineBlockerFreshness } from "./blocker-freshness.js";
import { sweepInlineBlockerPastEof } from "./blocker-past-eof.js";
// #2001/#2002: collect-later delivery for slow auxiliary LSP servers.
import { getLSPService } from "./lsp/index.js";
import {
	drainPendingAuxiliaryCoverage,
	isPendingAuxiliaryPastRearmTtl,
	markPendingAuxiliaryCoverage,
} from "./lsp/pending-aux-coverage.js";
import type { LSPDiagnostic } from "./lsp/client.js";
import { convertLspDiagnostics } from "./dispatch/utils/lsp-diagnostics.js";
// #1631 review V2: moved to its own leaf module so a low-level store
// (widget-state.ts) can use the marker without importing this orchestrator —
// see clients/stale-marker.ts's doc comment.
import { incrementDegradationCount } from "./degradation-ledger.js";
import {
	degradeDemotedFindingBody,
	formatRetirementNote,
} from "./demoted-finding-render.js";
import { STALE_LINE_MARKER } from "./stale-marker.js";
import {
	getWidgetBlockingFilesForSweep,
	markWidgetFileBlockersStale,
} from "./widget-state.js";
import type { TestRunnerFindingsCache } from "./project-diagnostics/runner-adapters/runner-findings.js";

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
}

/**
 * #1617: turn_end reads gitleaks/govulncheck/trivy straight from their
 * session-scan caches and formats them into advisory/blocker text — a
 * reporting lane parallel to (and, before this fix, entirely bypassing)
 * `dispatcher.ts:924`'s `applyDispositions` filter. An agent-marked
 * false-positive/won't-fix on one of these findings never suppressed it
 * here, so it re-reported on every turn.
 *
 * Filters `findings` through the SAME anchor derivation the dispatch path
 * and `lens_diagnostics mode=full` use (`applyDispositionsMultiFile` in
 * `diagnostic-dispositions.ts`), keyed off each lane's own canonical
 * `ProjectDiagnostic` adapter (`toDiagnostic`) — the exact tool/rule/message
 * identity `lens_diagnostics` already surfaces and `lens_diagnostic_mark`
 * already anchors a mark against, not a second, cloned identity that would
 * silently diverge from what the agent actually marked.
 *
 * Returns the surviving findings plus how many were dropped, so a caller can
 * still surface a "suppressed by disposition: N" trace (the #1616
 * suppressed-bucket rule — a security finding must never vanish with no
 * trace, even when the disposition that dropped it is working as intended).
 */
function filterFindingsByDisposition<F>(
	findings: F[],
	cwd: string,
	toDiagnostic: (finding: F) => ProjectDiagnostic,
): { kept: F[]; suppressed: number } {
	if (findings.length === 0) return { kept: findings, suppressed: 0 };
	const candidates = findings.map((finding) => ({
		finding,
		diagnostic: toDiagnostic(finding),
	}));
	const survivors = new Set(
		applyDispositionsMultiFile(
			candidates.map((c) => c.diagnostic),
			cwd,
			(d) => d.filePath,
		),
	);
	const kept = candidates
		.filter((c) => survivors.has(c.diagnostic))
		.map((c) => c.finding);
	return { kept, suppressed: findings.length - kept.length };
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

function capTurnEndMessage(content: string): string {
	const maxLines = RUNTIME_CONFIG.turnEnd.maxLines;
	const maxChars = RUNTIME_CONFIG.turnEnd.maxChars;

	let out = content;
	const lines = out.split("\n");
	if (lines.length > maxLines) {
		out = `${lines.slice(0, maxLines).join("\n")}\n... (truncated)`;
	}
	if (out.length > maxChars) {
		out = `${out.slice(0, maxChars)}\n... (truncated)`;
	}

	return out;
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
		owner,
		resetLSPService,
		resetFormatService,
	} = deps;

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
	const currentOwner: TurnStateOwner = owner ?? {
		kind: "pi",
		id: runtime.telemetrySessionId,
		pid: process.pid,
		lastSeen: new Date().toISOString(),
	};
	const access = cacheManager.getTurnStateAccess(cwd, currentOwner);
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
		cacheManager.clearTurnState(cwd, currentOwner);
		turnState = cacheManager.readTurnState(cwd);
	}

	const files = Object.keys(turnState.files);

	// R1 (#1443 follow-up): a read-only turn (no files touched) must not take
	// the fast idle-reset path while a carried cascade run — or one still
	// settling — is waiting for its delivery opportunity. Falling through to
	// the normal pipeline lets the settle/drain/merge logic below run exactly
	// as it does for an edit turn, so a carried finding reaches the agent
	// instead of dying unrendered. `hasCascadeRuns()` is a cheap peek (no
	// pending work almost every turn), so the common read-only turn still
	// takes the early return below.
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
				onError: (err) => dbg(`lsp idle reset failed: ${err}`),
			});
		}
		resetFormatService();
		return;
	}

	// Cancel any pending idle reset since we're actively working. #1618: also
	// checks `pendingSweepRearm` — a timer deferred behind an in-flight
	// workspace sweep already nulled `lspIdleResetTimeout` (the setTimeout
	// callback clears it before checking the hold), so this guard used to
	// read "nothing pending" and skip the cancel while a rearm was still
	// queued to fire the instant the sweep released its hold — resurrecting
	// idle reset on a session that had since gone back to active editing.
	if (lspIdleResetTimeout || pendingSweepRearm) {
		cancelLSPIdleReset();
		dbg("turn_end: cancelled pending LSP idle reset (active editing)");
	}

	dbg(
		`turn_end: ${files.length} file(s) modified, cycles: ${turnState.turnCycles}/${turnState.maxCycles}`,
	);

	if (cacheManager.isMaxCyclesExceeded(cwd)) {
		dbg("turn_end: max cycles exceeded, clearing state and forcing through");
		cacheManager.clearTurnState(cwd, currentOwner);
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
	const projectDiagnosticsDelta: ProjectDiagnostic[] = [];
	const projectDiagnosticsSources = new Set<string>();

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
		},
	});

	// Re-surface inline blockers from this turn that the agent didn't fix.
	// These were shown inline during write/edit but the agent moved on without resolving them.
	const unresolvedBlockers = runtime.getInlineBlockersSnapshot();
	/** #1944: past-EOF demotions retired after their single degraded delivery. */
	let demotedFindingsRetired = 0;
	for (const { filePath: bPath, summary, stale } of unresolvedBlockers) {
		const displayPath = toRunnerDisplayPath(cwd, bPath);
		if (stale) {
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
			const retired = runtime.retireDemotedPastEofBlocker(bPath, deadLines);
			if (retired) {
				demotedFindingsRetired += 1;
				// Bounded by the ledger's own per-kind/subject tally, and the subject
				// keeps the discriminating identity (which store, which file).
				incrementDegradationCount({
					kind: "demoted-finding-retired",
					subject: `inline-blocker:${displayPath}`,
					reason: `file shrank past cited line(s) ${deadLines.join(", ")}; retired after one degraded delivery`,
				});
			}
			// @delivery-surface: runtime-turn:unresolved-inline-blocker
			advisoryParts.push(
				`${STALE_LINE_MARKER} ${displayPath}:\n${degraded.body}` +
					(retired ? `\n${formatRetirementNote(deadLines)}` : ""),
			);
		} else {
			// @delivery-surface: runtime-turn:unresolved-inline-blocker
			blockerParts.push(
				`Unresolved from this turn — ${displayPath}:\n${summary}`,
			);
		}
	}

	// Drain the deferred cascade computes kicked off this turn (#450). They ran
	// concurrently off the write hot path; wait a bounded time for them here so
	// their runs are available to the merge below. A compute still in flight at
	// the cap is carried over to the next turn_end (never dropped).
	const cascadeSettleStart = Date.now();
	const { settled, timedOut } = await runtime.settleCascadeRuns(
		cascadeSettleWaitMs(),
		{ trackTurnEndClock: true },
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
	const cascadeRuns = runtime.consumeCascadeRuns().filter((run) => {
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
				parts.push(result.formatted);
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
		const graphAdvisory = buildAdvisory(graphRuns, {
			lead: (fileCount, reasons) =>
				`Cascade could not compute downstream impact for ${fileCount} edited file(s) this turn — ` +
				`the review graph was unavailable (${reasons}), so their dependents were not ` +
				`cascade-checked and a clean cascade result does not cover them.`,
			fallbackDetail: (r) =>
				r.indeterminate?.reason === "missing_node"
					? "changed file not in the review graph"
					: "review graph unavailable",
		});
		// @delivery-surface: runtime-turn:cascade-coverage-advisory
		if (graphAdvisory) advisoryParts.push(graphAdvisory);

		const bindingAdvisory = buildAdvisory(bindingRuns, {
			lead: (fileCount, reasons) =>
				`Cascade identified dependents for ${fileCount} edited file(s) this turn, but their ` +
				`diagnostics could not be freshly confirmed (${reasons}) and were withheld — a clean ` +
				`cascade result does not cover them.`,
			fallbackDetail: () => "cascade diagnostics withheld (binding rejected)",
		});
		// @delivery-surface: runtime-turn:cascade-coverage-advisory
		if (bindingAdvisory) advisoryParts.push(bindingAdvisory);

		const budgetAdvisory = buildAdvisory(budgetRuns, {
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
		});
		// @delivery-surface: runtime-turn:cascade-coverage-advisory
		if (budgetAdvisory) advisoryParts.push(budgetAdvisory);

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

	const t2 = Date.now();
	let knipMeta: {
		skipped?: boolean;
		execution?: "executed" | "cache";
		success?: boolean;
		totalIssues?: number;
		newIssues?: number;
		blockerIssues?: number;
		reason?: string;
		/** Set when the failure was an availability verdict, not a knip run. */
		failureKind?: string;
		/** True when a failed run left the previous good cache in place (#1467). */
		cacheKept?: boolean;
	} = {};
	if (runtime.isStartupScanInFlight("knip")) {
		dbg("turn_end: skipping knip (startup scan still in flight)");
		knipMeta = { skipped: true };
	} else {
		// Let KnipClient resolve/validate a real JS project root before probing or
		// auto-installing knip. Non-JS repos (for example Unity projects) should not
		// run tool checks every turn. Also back off after a timeout/kill so every
		// agent turn does not spend 30s launching another heavyweight knip process.
		const prevKnip = cacheManager.readCache<KnipResult>("knip", cwd);
		// An availability failure is NOT a hard knip failure: knip never ran, so
		// there is nothing to back off from, and backing off would make an
		// expiring probe verdict permanent again (#1467).
		const previousFailedHard =
			prevKnip &&
			!prevKnip.data.success &&
			!prevKnip.data.failureKind &&
			/(timed out|killed|SIGTERM|SIGKILL|SIGABRT)/i.test(prevKnip.data.summary);

		if (previousFailedHard) {
			dbg(
				`turn_end: skipping knip after recent failure: ${prevKnip.data.summary}`,
			);
			knipMeta = { skipped: true, reason: prevKnip.data.summary };
		} else {
			const knipResult = await knipClient.analyze(
				cwd,
				getKnipIgnorePatterns(),
				{
					projectSeq: runtime.projectSeq,
				},
			);
			// Never overwrite a good scan with a failure (#925, #1467): the last
			// good result stays until a new successful scan replaces it.
			const knipWouldPoison = wouldPoisonCache(prevKnip, knipResult);
			if (knipWouldPoison) {
				dbg(
					`turn_end: keeping last good knip cache; this run failed: ${knipResult.summary}`,
				);
			} else {
				cacheManager.writeCache("knip", knipResult, cwd);
			}
			knipMeta = {
				execution: knipResult.execution ?? "executed",
				success: knipResult.success,
				totalIssues: knipResult.issues.length,
				newIssues: 0,
				blockerIssues: 0,
				...(!knipResult.success && { reason: knipResult.summary }),
				...(knipResult.failureKind && { failureKind: knipResult.failureKind }),
				...(knipWouldPoison && { cacheKept: true }),
			};

			if (knipResult.success && knipResult.issues.length > 0) {
				// Deliberately excludes the line number — see stableFindingKey's
				// doc comment (#1483: mirrors the dead-code fix in #1477).
				const issueKey = (i: KnipIssue) =>
					stableFindingKey(i.type, i.file, i.name, i.package);
				const prevKeys = new Set((prevKnip?.data?.issues ?? []).map(issueKey));
				const modifiedSet = new Set(
					files.map((f) => resolveRunnerPath(cwd, f)),
				);

				const newIssues = knipResult.issues.filter((issue) => {
					if (prevKeys.has(issueKey(issue))) return false;
					if (!issue.file) return false;
					const abs = resolveRunnerPath(cwd, issue.file);
					return modifiedSet.has(abs);
				});
				knipMeta.newIssues = newIssues.length;
				if (newIssues.length > 0) {
					projectDiagnosticsDelta.push(
						...knipIssuesToProjectDiagnostics(cwd, newIssues),
					);
					projectDiagnosticsSources.add("knip");
				}

				const blockerIssues = newIssues.filter(
					(i) => i.type === "unlisted" || i.type === "bin",
				);
				knipMeta.blockerIssues = blockerIssues.length;
				if (blockerIssues.length > 0) {
					let report =
						"🔴 New unresolved imports/deps in modified code (Knip):\n";
					let firstPath: string | null = null;
					for (const issue of blockerIssues.slice(0, 5)) {
						const display = issue.file
							? toRunnerDisplayPath(cwd, issue.file)
							: "(unknown)";
						if (!firstPath && display !== "(unknown)") firstPath = display;
						report += `  ${display}${issue.line ? `:${issue.line}` : ""} — ${issue.type}: ${issue.name}\n`;
					}
					if (firstPath) {
						report += `  First location: ${firstPath}\n`;
					}
					// @delivery-surface: runtime-turn:knip-blocker
					blockerParts.push(report);
				}

				// Turn-end injects only this turn's HIGH-CONFIDENCE, ATTRIBUTABLE
				// delta: symbols in files the agent just edited that became unused
				// (weren't flagged in the previous scan) — low-volume and actionable
				// now. The FULL project-wide dead-code picture is deliberately NOT
				// injected per turn (hundreds of mostly-pre-existing findings would
				// drown the blockers and burn context every turn); it's available
				// on demand via lens_diagnostics. The delta also feeds the session-slop
				// record (`projectDiagnosticsDelta`) above.
				const unusedExportDelta = newIssues.filter(
					(i) => i.type === "export" || i.type === "enumMember",
				);
				if (unusedExportDelta.length > 0) {
					let report =
						"⚠️ Newly unused exports in files you edited — check if callers need updating (Knip):\n";
					for (const issue of unusedExportDelta.slice(0, 5)) {
						const display = issue.file
							? toRunnerDisplayPath(cwd, issue.file)
							: "(unknown)";
						report += `  ${display}${issue.line ? `:${issue.line}` : ""} — ${issue.name}\n`;
					}
					// @delivery-surface: runtime-turn:knip-advisory
					advisoryParts.push(report);
				}
			}
		}
	}
	logLatency({
		type: "phase",
		toolName: "turn_end",
		filePath: cwd,
		phase: "knip",
		durationMs: Date.now() - t2,
		metadata: knipMeta,
	});

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
		/** Why this turn produced no delta — the five states are otherwise identical. */
		reason?: string;
		/** True when a failed run left the previous good cache in place (#1467). */
		cacheKept?: boolean;
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
		const reasons: string[] = [];
		// A malformed client or deps object must never abort turn_end. Before the
		// per-turn delta this block only read a cache; now it iterates and awaits,
		// so the whole thing needs the guard, not just `client.analyze`.
		try {
			for (const client of deadCodeClients) {
				if (!client.detect(cwd)) {
					reasons.push(`${client.id}:not_detected`);
					continue;
				}
				if (![...modifiedFiles()].some((f) => client.owns(f))) {
					reasons.push(`${client.id}:no_owned_files`);
					continue;
				}
				const cacheKey = `dead-code-${client.id}`;
				const prev = cacheManager.readCache<DeadCodeResult>(cacheKey, cwd);
				// Back off after a timeout/kill so an unresponsive scanner cannot cost
				// every later turn its full analysis budget (mirrors knip).
				if (
					prev &&
					!prev.data.success &&
					/(timed out|killed|SIGTERM|SIGKILL|SIGABRT)/i.test(prev.data.summary)
				) {
					dbg(
						`turn_end: skipping dead-code after failure: ${prev.data.summary}`,
					);
					deadCodeMeta.skipped = true;
					reasons.push(`${client.id}:backoff:${prev.data.summary}`);
					continue;
				}
				const startMs = Date.now();
				try {
					const result = await client.analyze(cwd);
					const durationMs = Date.now() - startMs;
					// Never overwrite a good scan with a failure (#925, #1467): a
					// vulture timeout on one .py turn would otherwise evict the
					// session_start scan, and the backoff above would then latch
					// off the poisoned record.
					if (wouldPoisonCache(prev, result)) {
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
					logDeadCodeScan({
						language: client.language,
						success: result.success,
						cached: false,
						unusedExports: result.unusedExports.length,
						unusedFiles: result.unusedFiles.length,
						unusedDeps: result.unusedDeps.length,
						unlistedDeps: result.unlistedDeps.length,
						durationMs: result.durationMs ?? durationMs,
						...(!result.success && { reason: result.summary }),
					});
					deadCodeMeta.success = result.success;
					if (!result.success) {
						reasons.push(`${client.id}:scan_failed:${result.summary}`);
						continue;
					}
					deadCodeMeta.totalIssues =
						(deadCodeMeta.totalIssues ?? 0) + deadCodeIssues(result).length;
					// No baseline means every finding looks new. Report nothing rather
					// than blame the edit for the whole project's pre-existing debt.
					if (!prev?.data.success) {
						reasons.push(`${client.id}:no_previous_scan`);
						continue;
					}
					const prevKeys = new Set(
						deadCodeIssues(prev.data).map(deadCodeIssueKey),
					);
					const modified = modifiedFiles();
					const newIssues = deadCodeIssues(result).filter((issue) => {
						if (prevKeys.has(deadCodeIssueKey(issue))) return false;
						if (!issue.file) return false;
						return modified.has(resolveRunnerPath(cwd, issue.file));
					});
					if (newIssues.length === 0) {
						reasons.push(`${client.id}:clean`);
						continue;
					}
					newIssueTotal += newIssues.length;
					projectDiagnosticsDelta.push(
						...newIssues.map((issue) =>
							deadCodeIssueToProjectDiagnostic(cwd, issue, result.language),
						),
					);
					projectDiagnosticsSources.add("dead-code");
					// @delivery-surface: runtime-turn:dead-code-advisory
					advisoryParts.push(formatDeadCodeDelta(newIssues, result.language));
				} catch (err) {
					dbg(`turn_end: dead-code(${client.id}) failed: ${err}`);
					reasons.push(`${client.id}:threw`);
				}
			}
		} catch (err) {
			dbg(`turn_end: dead-code block failed: ${err}`);
			reasons.push("block_threw");
		}
		deadCodeMeta.newIssues = newIssueTotal;
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

	// govulncheck — surface session_start-cached Go CVE findings as advisory.
	// No per-turn re-run in this slice; the cache refreshes at next session_start.
	const govCacheEntry = cacheManager.readCache<GovulncheckResult>(
		"govulncheck",
		cwd,
	);
	// #1622: govulncheck renders a call site as `file:line`, and the cache is a
	// session_start snapshot — the same stale-line shape as gitleaks, one tier
	// lower. A CVE is pinned by go.mod, NOT by the call site, so neither an edit
	// nor a deletion may drop it: `onMissing: "demote"` routes a vanished traced
	// file into the same arm as an edited one. This gate only ever decides
	// whether the cited LINE is still worth printing. (Review round H1: the first
	// cut let a deleted trace file drop the CVE, contradicting this comment, and
	// `citedPath` reads only the FIRST filename frame — so one deleted file in a
	// long trace silently killed a CVE that go.mod still pins.)
	const govGate = gateFindingsByPathFreshness({
		store: "govulncheck",
		findings: govCacheEntry?.data?.findings ?? [],
		cwd,
		scannedAt: govCacheEntry?.data?.scannedAt,
		citedPath: (finding) => finding.trace.find((t) => t.filename)?.filename,
		onMissing: "demote",
	});
	const govStale = new Set(govGate.stale);
	// #1625 review round: the #1622 freshness gate runs FIRST — the disposition
	// filter's anchor is derived from each finding's post-demotion identity
	// (this array is already the gate's live+stale partition, never the raw
	// pre-gate cache). #1627's own post-gate guard (`if (govFindings.length)`)
	// and this round's disposition guard are the SAME guard — compose them,
	// never fall back to a raw-cache-length check (that would print the header
	// with zero rows beneath it whenever either filter empties the list).
	const govFiltered = filterFindingsByDisposition(
		[...govGate.live, ...govGate.stale],
		cwd,
		(f) => govulncheckFindingToProjectDiagnostic(cwd, f),
	);
	recordDispositionSuppressed("govulncheck", govFiltered.suppressed);
	const govFindings = govFiltered.kept;
	if (govFindings.length) {
		const findings = govFindings.slice(0, 5);
		let report =
			"🛡️ Go CVEs reachable from this code (govulncheck) — upgrade where possible:\n";
		for (const f of findings) {
			const callSite = f.trace.find((t) => t.filename);
			const stale = govStale.has(f);
			const where = callSite?.filename
				? `${toRunnerDisplayPath(cwd, callSite.filename)}${!stale && callSite.line ? `:${callSite.line}` : ""}${stale ? ` ${STALE_LINE_MARKER}` : ""}`
				: (f.module ?? f.packageName ?? "(module)");
			const fix = f.fixedVersion
				? ` — upgrade to ${f.fixedVersion} or later`
				: " — no fix yet, track upstream";
			report += `  ${f.osv} (${where})${fix}\n`;
		}
		if (govFindings.length > findings.length) {
			report += `  … and ${govFindings.length - findings.length} more\n`;
		}
		// @delivery-surface: runtime-turn:govulncheck-advisory
		advisoryParts.push(report);
	}

	const trivyCacheEntry = cacheManager.readCache<TrivyResult>("trivy", cwd);

	// Secrets — UNIFIED surfacing (#131 Mode 3). gitleaks, trivy secret, and the
	// ast-grep hardcoded-secret rules can each flag the SAME line with different
	// rule ids, which the rule-keyed diagnostic dedup can't collapse. Collapse by
	// location so a committed/hardcoded secret is reported ONCE (with combined
	// provenance) — a blocker, since credentials need rotation before merge.
	const gitleaksData = cacheManager.readCache<GitleaksResult>(
		"gitleaks",
		cwd,
	)?.data;
	const trivySecretsData = trivyCacheEntry?.data;
	// #1461 slice 1 (#1460): the gitleaks cache is TTL-only, so a finding for a
	// file deleted after the scan is still served as a 🔴 blocker for the rest
	// of the 30-minute window — the live case, and 119 of 126 findings in
	// pi-lens's own cache. This read is the single agent-facing consumer of that
	// store (session_start's read only decides whether to re-scan; the
	// project-diagnostics path re-scans fresh and reconciles at load), so the
	// drop belongs here, before the findings enter the shared secret pipeline.
	// #1622 extends that gate from existence to freshness, and adds trivy
	// secrets — the sibling store with the identical shape. A cited file edited
	// after the scan keeps its finding but loses its line number: the credential
	// may still be there, just not where the snapshot says. Dropping instead
	// would let any edit — malicious or accidental — mute a real secret.
	const gitleaksGate = gateFindingsByPathFreshness({
		store: "gitleaks",
		findings: gitleaksData?.findings ?? [],
		cwd,
		scannedAt: gitleaksData?.scannedAt,
		citedPath: (finding) => finding.file,
	});
	const trivySecretsGate = gateFindingsByPathFreshness({
		store: "trivy-secrets",
		findings: trivySecretsData?.secrets ?? [],
		cwd,
		scannedAt: trivySecretsData?.scannedAt,
		citedPath: (finding) => finding.file,
	});
	// #1617: THE bug this issue exists for — gitleaks findings never passed
	// through `applyDispositions`, so an agent-marked false-positive/won't-fix
	// re-reported as a 🔴 STOP blocker on every turn. Filter through the SAME
	// `gitleaksFindingToProjectDiagnostic` identity `lens_diagnostics
	// mode=full` surfaces (tool="gitleaks", rule="gitleaks:<ruleId>", the
	// exact "Potential secret: …" message) so a mark made against what the
	// agent was shown is honored here too.
	//
	// #1625 review round: filtered AFTER the #1622 freshness gate above — the
	// anchor is derived from each finding's post-demotion identity, never the
	// raw pre-gate cache. Applied to BOTH `gitleaksGate.live` AND
	// `gitleaksGate.stale`: `staleSecretEntries` below derives from the stale
	// arm, and an fp-marked finding that later goes stale must not reappear
	// there — a suppression escape (and a double count against
	// `dispositionSuppressedTotal`) that a live-only filter would have missed.
	//
	// #1628: trivy-secret findings get the SAME treatment, now that
	// `trivySecretFindingToProjectDiagnostic` (project-diagnostics/runner-
	// adapters/trivy.ts) gives them a `lens_diagnostics`-surfaced identity
	// (tool="trivy", rule="trivy-secret:<ruleId>") to anchor a mark against —
	// same pattern as gitleaks above, applied to both the live and stale arms
	// for the same reason.
	//
	// ast-grep secret findings need no filtering here — they already went
	// through dispatch's applyDispositions before reaching
	// `peekActionableWarnings()`.
	const gitleaksLiveFiltered = filterFindingsByDisposition(
		gitleaksGate.live,
		cwd,
		(f) => gitleaksFindingToProjectDiagnostic(cwd, f),
	);
	const gitleaksStaleFiltered = filterFindingsByDisposition(
		gitleaksGate.stale,
		cwd,
		(f) => gitleaksFindingToProjectDiagnostic(cwd, f),
	);
	recordDispositionSuppressed(
		"gitleaks",
		gitleaksLiveFiltered.suppressed + gitleaksStaleFiltered.suppressed,
	);
	const trivySecretsLiveFiltered = filterFindingsByDisposition(
		trivySecretsGate.live,
		cwd,
		(f) => trivySecretFindingToProjectDiagnostic(cwd, f),
	);
	const trivySecretsStaleFiltered = filterFindingsByDisposition(
		trivySecretsGate.stale,
		cwd,
		(f) => trivySecretFindingToProjectDiagnostic(cwd, f),
	);
	recordDispositionSuppressed(
		"trivy-secrets",
		trivySecretsLiveFiltered.suppressed + trivySecretsStaleFiltered.suppressed,
	);
	const astSecretWarnings = runtime
		.peekActionableWarnings()
		.filter(isSecretWarning);
	const sessionSecrets = dedupeSecretFindings([
		...fromGitleaks(gitleaksLiveFiltered.kept),
		...fromTrivySecrets(trivySecretsLiveFiltered.kept),
	]);
	// Demoted secrets are addressed by FILE, never by line — the line is the one
	// field the edit invalidated. Rule id and source survive it and must be
	// carried through (review round M1): an agent triages an `aws-access-token`
	// differently from a low-confidence `generic-api-key`, and cannot do that
	// from a bare path. Deduped on file+rule+source so a file with twenty stale
	// hits of one rule is named once.
	const staleSecretEntries = [
		...gitleaksStaleFiltered.kept.map((f) => ({
			file: toRunnerDisplayPath(cwd, f.file),
			rule: f.ruleId,
			source: "gitleaks",
		})),
		...trivySecretsStaleFiltered.kept.map((f) => ({
			file: toRunnerDisplayPath(cwd, f.file),
			rule: f.ruleId,
			source: "trivy",
		})),
	];
	const staleSecrets = [
		...new Map(
			staleSecretEntries.map((e) => [`${e.file}|${e.rule}|${e.source}`, e]),
		).values(),
	];
	// Locations already surfaced as session-scan secret blockers — used to enrich
	// provenance where ast-grep agrees and to suppress the duplicate ast-grep copy
	// from the actionable-warnings advisory below.
	const secretBlockedLocations = new Set(
		sessionSecrets.map((f) => secretLocationKey(f.file, f.line)),
	);
	if (sessionSecrets.length) {
		// Fold in ast-grep provenance ONLY where it coincides with a session
		// secret — don't promote ast-grep-only findings out of their advisory tier.
		const enriched = dedupeSecretFindings([
			...sessionSecrets,
			...fromAstGrepWarnings(astSecretWarnings).filter((a) =>
				secretBlockedLocations.has(secretLocationKey(a.file, a.line)),
			),
		]);
		const shown = enriched.slice(0, 5);
		let report =
			"🔴 STOP — hardcoded secrets detected. Rotate the credentials and remove them from source:\n";
		for (const f of shown) {
			const where = `${toRunnerDisplayPath(cwd, f.file)}:${f.line}`;
			report += `  ${where} — ${f.rule} [${f.sources.join(" + ")}]${f.description ? `: ${f.description}` : ""}\n`;
		}
		if (enriched.length > shown.length) {
			report += `  … and ${enriched.length - shown.length} more\n`;
		}
		// @delivery-surface: runtime-turn:secrets-gitleaks,runtime-turn:secrets-trivy
		blockerParts.push(report);
	}
	if (staleSecrets.length) {
		// Its OWN tier, never `advisoryParts` (review round M2). The advisory tier
		// is labelled "no action required this turn", which would sit directly
		// above copy telling the agent to re-scan — a section that contradicts its
		// own heading. This preamble is imperative because the action is real: the
		// finding is unverified, not dismissed.
		const shown = staleSecrets.slice(0, 5);
		let report =
			`🔑 ACTION NEEDED — secrets were flagged in files that changed after the scan. ${STALE_LINE_MARKER}\n` +
			"The cached line numbers are no longer trustworthy, so they are withheld. Re-run a secrets scan to confirm or clear these:\n";
		for (const entry of shown) {
			report += `  ${entry.file} — ${entry.rule} [${entry.source}]\n`;
		}
		if (staleSecrets.length > shown.length) {
			report += `  … and ${staleSecrets.length - shown.length} more\n`;
		}
		// @delivery-surface: runtime-turn:stale-secrets-tier
		staleSecretParts.push(report);
	}

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
				if (depResult.localSkips && depResult.localSkips > 0) {
					// Not silent: a skipped LOCAL import means madge couldn't resolve
					// it into the graph, so a cycle through it would be missed.
					dbg(
						`turn_end: madge skipped ${depResult.localSkips} local file(s) resolving ${file} — possible silent cycle-miss`,
					);
				}
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
	// Runs for each unique test target across modified files; results appear
	// in the next turn's context injection alongside jscpd/madge findings.
	if (!getFlag("no-tests") && files.length > 0) {
		const seen = new Set<string>();
		const targets: NonNullable<
			ReturnType<TestRunnerClient["getTestRunTarget"]>
		>[] = [];

		// #628: also target the test companions of this turn's cascade neighbors
		// (files that import an edited file) — a neighbor's own tests can break
		// even though the neighbor's source wasn't touched. Reuses `cascadeResults`,
		// already computed above (from the same #450 deferred-cascade drain) for the
		// LSP cascade-diagnostics merge — no second reverse-dependency walk, and the
		// neighbor set inherits whatever budget the cascade compute already applied
		// (CASCADE_NEIGHBOUR_BUDGET), so this can't turn into unbounded per-edit work.
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

		for (const { display, abs, isNeighbor } of candidates) {
			const target = testRunnerClient.getTestRunTarget(abs, cwd);
			if (target && !seen.has(target.testFile)) {
				seen.add(target.testFile);
				targets.push(target);
				dbg(
					`turn_end: ${display} → test ${target.runner} ${path.relative(cwd, target.testFile)} (${target.strategy}${isNeighbor ? ", cascade-neighbor" : ""})`,
				);
			} else if (!target) {
				dbg(
					`turn_end: ${display} → no test file found${isNeighbor ? " (cascade-neighbor)" : ""}`,
				);
			}
		}
		if (targets.length > 0) {
			dbg(
				`turn_end: firing ${targets.length} test target(s) async (non-blocking)`,
			);
			const firedAtTurn = runtime.turnIndex;
			const firedSessionId = runtime.telemetrySessionId;
			const priorTestCache = cacheManager.readCache<TestRunnerFindingsCache>(
				"test-runner-findings",
				cwd,
			)?.data;
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
			cacheManager.writeCache(
				"test-runner-findings",
				{ ...(priorTestCache ?? { content: "" }), testRunGeneration },
				cwd,
			);
			Promise.allSettled(
				targets.map((t) =>
					testRunnerClient.runTestFileAsync(
						t.testFile,
						cwd,
						t.runner,
						t.config,
					),
				),
			)
				.then((results) => {
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
					for (const r of results) {
						if (r.status === "rejected") {
							dbg(`turn_end: test run rejected — ${r.reason}`);
							continue;
						}
						resultValues.push(r.value);
						const { file, runner, passed, failed, duration, error } = r.value;
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
						const summary =
							error && passed === 0 && failed === 0
								? `error: ${error}`
								: `${verdict} ${passed}p/${failed}f (${elapsed})`;
						dbg(
							`turn_end: ${stale ? "[stale] " : ""}test ${runner} ${shortFile} → ${summary}`,
						);
						// #1524: also fires on `error` alone, not just `failed > 0`.
						// A runner-error result (the suite never started — spawn/
						// config failure) has `failed === 0` by construction, so
						// gating on `failed > 0` alone dropped it silently: the
						// agent got no context at all, and the empty `failures`
						// array below sent this result down the "all tests
						// passed" branch, clearing any prior real test-failure
						// git-guard blocker. `formatResult` already renders the
						// error-only case as "Could not run tests: ...".
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
					if (failures.length > 0) {
						const currentGeneration =
							cacheManager.readCache<TestRunnerFindingsCache>(
								"test-runner-findings",
								cwd,
							)?.data?.testRunGeneration;
						if (
							currentGeneration !== undefined &&
							currentGeneration > testRunGeneration
						) {
							dbg(
								`turn_end: test generation ${testRunGeneration} superseded by ${currentGeneration}`,
							);
							return;
						}
						const content = stale
							? `[from a prior turn — the edit that triggered this run had already been superseded by the time results came back]\n\n${failures.join("\n\n")}`
							: failures.join("\n\n");
						cacheManager.writeCache(
							"test-runner-findings",
							{
								content,
								stale,
								results: resultValues,
								testRunGeneration,
								launchedFrom,
								publishedAgainst,
								provenance: publishedAgainst,
								superseded,
							},
							cwd,
						);
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
							mergeGitGuardTestFailure(
								cacheManager,
								cwd,
								runtime,
								content,
								resultValues
									.filter((value) => value.failed > 0)
									.map((value) => value.file),
							);
						}
						dbg(
							`turn_end: ${failures.length} test failure(s) cached for next context injection${stale ? " (stale — turn advanced while tests ran)" : ""}`,
						);
					} else if (results.length > 0) {
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
			try {
				const { impact, formatImpact, parseSymbolKey } =
					await import("./call-graph.js");
				const { callGraphImpactToProjectDiagnostics } =
					await import("./project-diagnostics/runner-adapters/call-graph-impact.js");
				const impactLines: string[] = [];
				const impactFindings: {
					calleeKey: string;
					results: ReturnType<typeof impact>;
				}[] = [];
				for (const filePath of files.slice(0, 5)) {
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
							const summary = formatImpact(results, cwd);
							if (summary)
								impactLines.push(
									`  ${parseSymbolKey(calleeKey).symbolName ?? calleeKey}: ${summary}`,
								);
						}
					}
				}
				if (impactLines.length > 0) {
					// @delivery-surface: runtime-turn:call-graph-advisory
					advisoryParts.push(
						`📊 Call-graph impact (changed symbols have callers):\n${impactLines.join("\n")}`,
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
	if (getFlag("lens-actionable-warnings")) {
		try {
			const report = await buildActionableWarningsReport({
				cwd,
				sessionId: runtime.telemetrySessionId,
				turnIndex: runtime.turnIndex,
				files,
				modifiedRangesByFile,
				// Suppress the ast-grep secret advisory at any location already
				// surfaced in the unified secrets blocker above (#131 Mode 3) — the
				// secret is reported once, not twice.
				dispatchWarnings: runtime
					.peekActionableWarnings()
					.filter(
						(w) =>
							!(
								isSecretWarning(w) &&
								typeof w.line === "number" &&
								secretBlockedLocations.has(
									secretLocationKey(w.filePath, w.line),
								)
							),
					),
				includeLspCodeActions: !!getFlag("lens-actionable-warning-actions"),
				projectSeqStart: runtime.turnStartProjectSeq,
				projectSeqEnd: runtime.projectSeq,
				fileSeqByPath,
				deltaOnly: !getFlag("lens-actionable-warning-all"),
				dbg,
			});
			writeActionableWarningsReport(cacheManager, cwd, report);
			appendActionableWarningsHistory(cwd, report);
			const advisory = formatActionableWarningsAdvisory(report);
			// @delivery-surface: runtime-turn:actionable-warnings-advisory
			if (advisory) advisoryParts.push(advisory);
			logActionableWarningsEvent({
				event: advisory ? "advisory_injected" : "advisory_skipped",
				sessionId: runtime.telemetrySessionId,
				metadata: {
					turnIndex: runtime.turnIndex,
					unsuppressed: report.summary.unsuppressed,
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
		const qualityReport = buildCodeQualityWarningsReport({
			cwd,
			sessionId: runtime.telemetrySessionId,
			turnIndex: runtime.turnIndex,
			warnings: runtime.peekCodeQualityWarnings(),
			modifiedRangesByFile,
			projectSeqStart: runtime.turnStartProjectSeq,
			projectSeqEnd: runtime.projectSeq,
			fileSeqByPath,
		});
		writeCodeQualityWarningsReport(cacheManager, cwd, qualityReport);
		appendCodeQualityWarningsHistory(cwd, qualityReport);
		const advisory = formatCodeQualityWarningsAdvisory(qualityReport);
		// @delivery-surface: runtime-turn:code-quality-warnings-advisory
		if (advisory) advisoryParts.push(advisory);
		logLatency({
			type: "phase",
			toolName: "turn_end",
			filePath: cwd,
			phase: "code_quality_warnings_report",
			durationMs: Date.now() - t5,
			metadata: qualityReport.summary,
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
	const drainedPairs = drainPendingAuxiliaryCoverage();
	let lateAuxDelivered = 0;
	let lateAuxStale = 0;
	let lateAuxMissing = 0;
	let lateAuxRearmed = 0;
	let lateAuxClientGone = 0;
	let lateAuxProbeFailed = 0;
	if (drainedPairs.length > 0) {
		const byFile = new Map<string, typeof drainedPairs>();
		for (const pair of drainedPairs) {
			const list = byFile.get(pair.filePath);
			if (list) list.push(pair);
			else byFile.set(pair.filePath, [pair]);
		}
		try {
			const service = getLSPService();
			for (const [lateAuxPath, pairs] of byFile) {
				let cached: Map<string, LSPDiagnostic[]>;
				try {
					cached = await service.readCachedDiagnosticsForServers(
						lateAuxPath,
						new Set(pairs.map((p) => p.serverId)),
					);
				} catch {
					// #2027 round-1 P3-2: count dropped pairs — never silent.
					lateAuxProbeFailed += pairs.length;
					for (const pair of pairs) {
						markPendingAuxiliaryCoverage(
							pair.filePath,
							[pair.serverId],
							Date.now(),
						);
					}
					continue;
				}
				const displayLateAuxPath = toRunnerDisplayPath(cwd, lateAuxPath);
				for (const pair of pairs) {
					const rawDiags = cached.get(pair.serverId);
					if (rawDiags === undefined) {
						// No live client for this server any more — best-effort probe,
						// drop the pair silently.
						lateAuxClientGone += 1;
						continue;
					}
					if (rawDiags.length === 0) {
						// Still scanning (or published nothing yet) — keep waiting
						// so a scan finishing before the NEXT turn end still
						// delivers. Two clocks, deliberately decoupled: the
						// freshness baseline (`markedAtMs`) NEVER moves — it is what
						// the delivery gate stats against — while the re-arm TTL is
						// anchored on `lastRearmedAtMs`, advanced by every successful
						// empty probe: the scanner is demonstrably alive, just slow.
						if (!isPendingAuxiliaryPastRearmTtl(pair)) {
							markPendingAuxiliaryCoverage(
								lateAuxPath,
								[pair.serverId],
								pair.markedAtMs,
								Date.now(),
							);
							lateAuxRearmed += 1;
						}
						continue;
					}
					const converted = convertLspDiagnostics(rawDiags, lateAuxPath, {
						tool: "lsp",
					});
					if (converted.length === 0) continue;
					// Freshness kernel (#1634 gated surface): stat the cited file
					// against the mark timestamp. Missing → drop (no remediation for
					// a deleted file); mtime drifted past the mark → drop too, NOT
					// demote — unlike the cached-blocker gates these findings were
					// NEVER delivered before, and the edit that drifted the file
					// already re-touched it (a fresh pending pair supersedes this
					// one), so a stale-arm replay would double-report old content.
					// Both drops are COUNTED here and in the latency record below —
					// never silent (shape 10).
					const gate = gateFindingsByPathFreshness({
						store: "late-auxiliary-findings",
						findings: converted,
						cwd,
						scannedAt: pair.markedAtMs,
						citedPath: () => lateAuxPath,
					});
					lateAuxStale += gate.stale.length;
					lateAuxMissing +=
						converted.length - gate.live.length - gate.stale.length;
					if (gate.stale.length > 0) {
						// Stale findings mean the scan predates the last edit.
						// Re-arm with a REFRESHED baseline so the next turn probes
						// the newer revision (#2027 round-1 P2-1).
						markPendingAuxiliaryCoverage(
							lateAuxPath,
							[pair.serverId],
							Date.now(),
						);
					}
					if (gate.live.length === 0) continue;
					const lines = gate.live.map(
						(f) =>
							`  ${displayLateAuxPath}:${f.line}:${f.column} [${f.rule}] ${f.message}`,
					);
					lateAuxDelivered += gate.live.length;
					// @delivery-surface: runtime-turn:late-auxiliary-findings
					advisoryParts.push(
						`🕐 Late auxiliary diagnostics (${pair.serverId} answered after its grace window):\n${lines.join("\n")}`,
					);
				}
			}
		} catch (err) {
			dbg(`turn_end: late-auxiliary probe failed: ${err}`);
		}
		logLatency({
			type: "phase",
			toolName: "turn_end",
			filePath: cwd,
			phase: "late_auxiliary_findings",
			durationMs: Date.now() - lateAuxStart,
			metadata: {
				pending: drainedPairs.length,
				delivered: lateAuxDelivered,
				stale: lateAuxStale,
				missing: lateAuxMissing,
				rearmed: lateAuxRearmed,
				clientGone: lateAuxClientGone,
				probeFailed: lateAuxProbeFailed,
			},
		});
	}

	const labeledAdvisoryParts = advisoryParts.map(
		(p) => `ℹ️ Advisory — no action required this turn:\n${p}`,
	);
	// Stale-secret parts sit between the two tiers and are NOT relabelled — they
	// ship the imperative preamble they were built with (#1622 review M2).
	const findingParts = [
		...blockerParts,
		...staleSecretParts,
		...labeledAdvisoryParts,
	];
	if (findingParts.length > 0) {
		dbg(
			`turn_end: ${blockerParts.length} blocker section(s), ${advisoryParts.length} advisory section(s) found, persisting for next context`,
		);
		const content = capTurnEndMessage(findingParts.join("\n\n"));
		const signature = `${files
			.slice()
			.sort((a, b) => a.localeCompare(b))
			.join("|")}::${content}`;
		const last = cacheManager.readCache<{
			signature: string;
			sessionId: string;
		}>("turn-end-findings-last", cwd);
		if (
			last?.data?.signature === signature &&
			last?.data?.sessionId === runtime.telemetrySessionId
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
			cacheManager.clearTurnState(cwd, currentOwner);
			runtime.fixedThisTurn.clear();
			resetFormatService();
			return;
		}
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
		cacheManager.clearTurnState(cwd, currentOwner);
		// `staleSecretParts` counts here too (#1622 review M2): clearing the
		// findings record while a stale secret is still unverified would drop the
		// only surviving trace of it.
		if (
			getFlag("lens-guard") &&
			advisoryParts.length === 0 &&
			staleSecretParts.length === 0 &&
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
	runtime.clearActionableWarnings();
	runtime.clearCodeQualityWarnings();
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
			// #1944 AC3: an empty advisory section on its own cannot say whether
			// the turn had nothing to report or dropped something. This counter
			// answers that from latency.log even when the payload is empty, and
			// the payload itself carries the retirement note when it is not.
			demotedFindingsRetired,
		},
	});
	resetFormatService();
}
