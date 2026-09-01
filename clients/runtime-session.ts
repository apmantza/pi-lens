import * as nodeFs from "node:fs";
import * as path from "node:path";
import type { AstGrepClient } from "./ast-grep-client.js";
import type { BiomeClient } from "./biome-client.js";
import { resetBoundedTelemetry } from "./bounded-telemetry.js";
import { rotateMessageEndAttribution } from "./message-end-attribution.js";
import type { CacheManager } from "./cache-manager.js";
import { createDeadline, yieldIfOverBudget } from "./cooperative-budget.js";
import type { DeadCodeClient, DeadCodeResult } from "./dead-code-client.js";
import { deadCodeIssueCount } from "./dead-code-client.js";
import { logDeadCodeScan } from "./dead-code-logger.js";
import {
	incrementDegradationCount,
	resetDegradationLedger,
} from "./degradation-ledger.js";
import type { DependencyChecker } from "./dependency-checker.js";
import { getDiagnosticTracker } from "./diagnostic-tracker.js";
import { resetPsScriptAnalyzerAvailability } from "./dispatch/runners/psscriptanalyzer.js";
import { resetInstallRetryLatches } from "./dispatch/runners/utils/availability-policy.js";
import { resetLazyInstallAttempts } from "./dispatch/runners/utils/lazy-installer.js";
import { resetDispatchAvailabilityState } from "./dispatch/runners/utils/runner-helpers.js";
import { resetObservedRunnerLatency } from "./dispatch/collect-later-tier.js";
import { resetPendingRunnerFindings } from "./dispatch/pending-runner-findings.js";
import type { FileKind } from "./file-kinds.js";
import { clearAllSessions as clearFileTimeSessions } from "./file-time.js";
import {
	getGlobalPiLensDir,
	getKnipIgnorePatterns,
	getProjectDataDir,
} from "./file-utils.js";
import { GitleaksClient, type GitleaksResult } from "./gitleaks-client.js";
import type { GoClient } from "./go-client.js";
import {
	GovulncheckClient,
	type GovulncheckResult,
} from "./govulncheck-client.js";
import { sweepAtomicWriteStages } from "./instance-reaper.js";
import type { JscpdClient } from "./jscpd-client.js";
import type { KnipClient, KnipResult } from "./knip-client.js";
import { canRunStartupHeavyScans } from "./language-policy.js";
import {
	detectProjectLanguageProfile,
	getDefaultStartupTools,
} from "./language-profile.js";
import { logLatency } from "./latency-logger.js";
import { runLogCleanup } from "./log-cleanup.js";
import { resetCascadeTierSessionState } from "./lsp/cascade-tier.js";
import type { LSPShutdownOptions } from "./lsp/client.js";
import { initLSPConfig, loadLSPConfig } from "./lsp/config.js";
import { resetWorkspaceDiagnosticsCacheSession } from "./lsp/workspace-diagnostics-session.js";
import {
	resetDirectLspCommandAvailability,
	resetLSPCaseSensitivityState,
} from "./lsp/server.js";
import { loadLspService } from "./lsp-lazy.js";
import type { MetricsClient } from "./metrics-client.js";
import type { OpengrepClient, OpengrepResult } from "./opengrep-client.js";
import { resetManagedToolRefreshSession } from "./installer/managed-tool-refresh-session.js";
import { resetResolvedPathCache } from "./installer/index.js";
import { _resetPackageManagerCache } from "./package-manager.js";
import { clearFormatterCache } from "./formatters.js";
import { isAtOrAboveHomeDir } from "./path-utils.js";
import { isPrintMode } from "./print-mode.js";
import {
	type ProjectSequenceBase,
	type ProjectSequenceIndex,
	readLatestProjectSequence,
	readLatestProjectSequenceAsync,
} from "./project-changes.js";
import {
	getProjectSnapshotPath,
	getProjectSnapshotLegacyPath,
	hydrateRuntimeFromProjectSnapshot,
	hydrateRuntimeFromProjectSnapshotIfIdle,
	isProjectSnapshotFresh,
	isProjectSnapshotMetaStale,
	loadProjectSnapshot,
	loadProjectSnapshotExportsAndRules,
	PROJECT_SNAPSHOT_VERSION,
	type ProjectSnapshot,
	type ProjectSnapshotExportsAndRules,
	readProjectSnapshotMeta,
	saveRuntimeProjectSnapshot,
} from "./project-snapshot.js";
import type { RuffClient } from "./ruff-client.js";
import { scanProjectRules } from "./rules-scanner.js";
import type { RuntimeCoordinator } from "./runtime-coordinator.js";
import type { RustClient } from "./rust-client.js";
import { resetSafeSpawnWindowsCommandCache } from "./safe-spawn.js";
import {
	getSlowFsVerdict,
	isSlowFs,
	slowFsDegradationNotice,
} from "./slow-fs.js";
import {
	countRecentSmells,
	formatSmellsSessionStartLine,
	resetSmellsSessionState,
} from "./smells-rollup.js";
import {
	findNearestProjectRoot,
	getStartupScanMaxEntries,
	isStartupScanVerdictFresh,
	resolveStartupScanContext,
	type StartupScanContext,
} from "./startup-scan.js";
import {
	getSubagentIdentity,
	isSubagentSession,
	subagentLightModeNotice,
} from "./subagent-mode.js";
import type { TestRunnerClient } from "./test-runner-client.js";
import type { TodoScanner } from "./todo-scanner.js";
import { TrivyClient, type TrivyResult } from "./trivy-client.js";
import { isWarmAttached } from "./warm-attach.js";
import { setSessionLanguages } from "./widget-state.js";
import { logWordIndex } from "./word-index-logger.js";
import { resetOpaqueMutationState } from "./opaque-mutation-scan.js";
import { resetPendingAuxiliaryCoverage } from "./lsp/pending-aux-coverage.js";
import { resetWorkspaceTopology } from "./workspace-topology.js";
import { resetZizmorTokenAvailability } from "./zizmor-config.js";
import { resetSpawnTimeoutCooldowns } from "./spawn-timeout-cooldown.js";
import { resetTestRunnerDelivery } from "./test-runner-delivery.js";
import type { SessionStartClassification } from "./session-lifecycle.js";

/** Durable root-identity value on `session_start_total` records. */
export type SessionStartRootTelemetry = boolean | "unknown";

interface SessionStartDeps {
	ctxCwd?: string;
	/** Host hook timestamp, so total includes work before this handler is entered. */
	sessionStartFiredAt?: number;
	/** Monotonic host hook timestamp for the extension-loaded → session_start span. */
	sessionStartMonotonicAt?: number;
	/** Monotonic instant when the extension finished loading. */
	extensionLoadedAt?: number;
	/** True only for the process's first session_start with a load anchor. */
	emitHostReadyDelay?: boolean;
	sessionReason?: string;
	handlerEnteredAt?: number;
	bootstrapClientsStartedAt?: number;
	bootstrapClientsDurationMs?: number;
	getFlag: (name: string) => boolean | string | undefined;
	notify: (msg: string, level: "info" | "warning" | "error") => void;
	dbg: (msg: string) => void;
	log: (msg: string) => void;
	/**
	 * Host-provided startup-mode override. When set, the first-call-quick
	 * heuristic (TUI cold-start latency mitigation) is skipped and this value
	 * wins — but only when `PI_LENS_STARTUP_MODE` is NOT explicitly set in the
	 * environment (an explicit env var still takes highest precedence).
	 *
	 * Use case: the MCP server has no TUI keystroke latency to protect and
	 * should always get "full" mode on its first (and only) session_start so
	 * the dominant-language LSP pre-warm, scans, and error-debt baseline all
	 * run. Pass `"full"` from `clients/mcp/session.ts`.
	 */
	startupModeOverride?: StartupMode;
	/**
	 * #2129 observability: the classification `decideSessionStart` already made
	 * for this start, before this handler ever runs (a declined start never
	 * reaches here). Logged alongside `session_start_total`'s `mode` field so a
	 * log reader can tell "sequential-replacement" from "primary" without
	 * cross-referencing `concurrent_session_bind`, which only fires for the
	 * declined side.
	 */
	sessionStartClassification?: SessionStartClassification;
	/** The root-identity input that classification consulted (mirrors
	 *  `ClassifySessionStartInput.sameRoot`). */
	sessionStartSameRoot?: boolean;
	runtime: RuntimeCoordinator;
	metricsClient: MetricsClient;
	cacheManager: CacheManager;
	todoScanner: TodoScanner;
	astGrepClient: AstGrepClient;
	biomeClient: BiomeClient;
	ruffClient: RuffClient;
	knipClient: KnipClient;
	jscpdClient: JscpdClient;
	deadCodeClients: DeadCodeClient[];
	govulncheckClient: GovulncheckClient;
	gitleaksClient: GitleaksClient;
	trivyClient: TrivyClient;
	opengrepClient: OpengrepClient;
	depChecker: DependencyChecker;
	testRunnerClient: TestRunnerClient;
	goClient: GoClient;
	rustClient: RustClient;
	ensureTool: (name: string) => Promise<string | null | undefined>;
	cleanStaleTsBuildInfo: (cwd: string) => string[];
	resetDispatchBaselines: (cwd?: string) => void;
	resetLSPService: (options?: LSPShutdownOptions) => void;
}

type StartupMode = "full" | "minimal" | "quick";

const HOST_STALL_THRESHOLD_MS = 30_000;

function logHostReadyDelay(deps: SessionStartDeps, cwd: string): void {
	if (
		!deps.emitHostReadyDelay ||
		deps.sessionStartMonotonicAt === undefined ||
		deps.extensionLoadedAt === undefined
	) {
		return;
	}
	const durationMs = Math.max(
		0,
		deps.sessionStartMonotonicAt - deps.extensionLoadedAt,
	);
	logLatency({
		type: "phase",
		filePath: cwd,
		phase: "host_ready_delay",
		durationMs,
		metadata: {
			hostStallSuspected: durationMs > HOST_STALL_THRESHOLD_MS,
			sessionStart: "first-process-session",
			reason: deps.sessionReason,
		},
	});
}

function resolveSnapshotRoot(cwd: string): string {
	const resolvedCwd = path.resolve(cwd);
	const nearest = findNearestProjectRoot(resolvedCwd);
	// Reject a root at — or above — $HOME (the #250/#253 escape); fall back to
	// the cwd so the snapshot stays scoped to the actual workspace.
	if (!nearest || isAtOrAboveHomeDir(nearest)) {
		return resolvedCwd;
	}
	return nearest;
}

/**
 * #947: meta-first staleness gate. Both interactive paths used to sync-parse
 * the whole `project-snapshot.json` body (110-130ms at 40MB, ~0.5s at the
 * observed 112MB) BEFORE checking freshness — wasted work in the 71% of
 * sessions where the snapshot turns out stale. Read the tiny meta sidecar
 * (`project-snapshot.meta.json`, written on every save) first; when it says
 * stale (seq or version mismatch — the exact fields `isProjectSnapshotFresh`
 * checks), skip the body parse entirely. Callers already tolerate a missing
 * snapshot (fail-open contract). A missing meta file (legacy install, or a
 * snapshot written before the sidecar existed) falls through to parsing the
 * body exactly as before.
 */
/**
 * #1019: build the bounded-replay base from the snapshot's tiny meta sidecar.
 * The sequence index is mirrored into the meta (not just the body) precisely so
 * this read is cheap — reading it does NOT parse the 40-112MB body, preserving
 * the #947 skip-stale optimization. Returns `undefined` (→ full replay) for a
 * legacy meta with no embedded index, a version-mismatched meta (a foreign
 * snapshot generation), or a missing meta. A seq-stale meta is NOT rejected
 * here — folding the newer entries onto it is the whole point; the base's
 * trustworthiness against a truncated/ahead log is guarded inside
 * `readLatestProjectSequence` itself.
 */
function snapshotSequenceBase(root: string): ProjectSequenceBase | undefined {
	const meta = readProjectSnapshotMeta(root);
	if (!meta || meta.version !== PROJECT_SNAPSHOT_VERSION) return undefined;
	const index = meta.sequenceIndex;
	if (!index) return undefined;
	return {
		projectSeq: index.projectSeq,
		fileSeqByPath: index.fileSeqByPath,
		sinceSeq: meta.seq,
	};
}

/**
 * #1785: one bounded ledger record per timed-out sequence read, so a real
 * occurrence is diagnosable from the ledger alone rather than only from a
 * `dbg` line that most hosts never surface. Carries the project root and the
 * on-disk snapshot's age/size (when one exists) — the identity AC1 asks for:
 * which project, how stale/large the snapshot that got skipped was.
 */
function recordSnapshotSequenceTimeout(args: {
	snapshotRoot: string;
	snapshotPath: string;
}): void {
	let reason = "sequence read timed out; no snapshot on disk";
	try {
		const stat = nodeFs.statSync(args.snapshotPath);
		reason = `sequence read timed out; snapshot age=${Math.round(Date.now() - stat.mtimeMs)}ms size=${stat.size}b`;
	} catch {
		// No snapshot on disk yet — the reason above already covers it.
	}
	incrementDegradationCount({
		kind: "snapshot-sequence-read-timeout",
		subject: args.snapshotRoot,
		reason,
	});
}

/**
 * #1785: the synchronous freshness check made a conservative call with the
 * `UNKNOWN_PROJECT_SEQ` sentinel (never hydrate when the real sequence is
 * unknown). Once the deferred read resolves — a deterministic completion
 * signal, not a sleep — this re-checks freshness against the now-known
 * sequence and hydrates late when the snapshot really was current, instead of
 * leaving the runtime without `cachedExports`/`projectRulesScan` for the rest
 * of the session.
 *
 * #1785 review round F5 (design (a), replacing rounds 1-3's synchronous
 * capture entirely): quick mode's own cold-start warmup ALREADY loads the
 * on-disk snapshot for its own purposes — `cachedSnapshot` at the top of the
 * warmup body, used to reuse a still-fresh `startupScan` verdict — strictly
 * BEFORE the warmup's own possible save (`saveRuntimeProjectSnapshot`, only
 * reached when that verdict was NOT fresh). Reusing THAT already-loaded
 * value costs nothing new: the read was always going to happen regardless of
 * this fix, and it is guaranteed to predate any overwrite the SAME warmup
 * invocation might go on to make — a read-before-write invariant of the
 * warmup's own code, not something this function has to defend against with
 * a race window of its own. `getWarmupOwnSnapshotRead` is a closure over a
 * per-`handleSessionStart`-call LOCAL variable (never module-scope — #1785
 * F6 is exactly the class of bug a module-scope holder here would
 * reintroduce) that the warmup publishes into once its own read completes.
 *
 * When the getter still returns `undefined` — the deferred read resolved
 * before the warmup got that far (or no warmup was ever armed by this call:
 * a later quick-mode call in the same process, print mode, full mode) —
 * there is nothing published yet, so this falls back to a live re-load via
 * `loadProjectSnapshotExportsAndRules`. That fallback is exactly as safe as
 * the primary path: if the warmup hasn't reached its own read yet, it
 * certainly hasn't saved yet either (same invariant), so disk still holds
 * whatever was there before any warmup activity.
 *
 * Both the published value and the fallback re-load are the narrow,
 * postings-free `ProjectSnapshotExportsAndRules` shape — never the full
 * `loadProjectSnapshot`. This path only ever hydrates
 * `cachedExports`/`projectRulesScan`; it can NOT hydrate `wordIndex` even
 * when the underlying snapshot would otherwise have one, because the narrow
 * type never carries it. That is intentional, not a regression: F2's hazard
 * was this exact path nulling a `wordIndex` that quick mode's warmup had, in
 * the meantime, built for real — the warmup remains the sole source of a
 * late-arriving `wordIndex` for the interactive path.
 */
function retroactivelyHydrateAfterDeferredSequence(args: {
	getWarmupOwnSnapshotRead: () =>
		| ProjectSnapshotExportsAndRules
		| null
		| undefined;
	snapshotRoot: string;
	runtime: RuntimeCoordinator;
	dbg: (msg: string) => void;
}): (latestSeq: ProjectSequenceIndex) => void {
	return (latestSeq) => {
		const published = args.getWarmupOwnSnapshotRead();
		const snapshot =
			published !== undefined
				? published
				: loadProjectSnapshotExportsAndRules(args.snapshotRoot);
		if (
			!snapshot ||
			snapshot.version !== PROJECT_SNAPSHOT_VERSION ||
			snapshot.seq !== latestSeq.projectSeq
		) {
			return;
		}
		const hydrated = hydrateRuntimeFromProjectSnapshotIfIdle(
			args.runtime,
			snapshot,
		);
		if (hydrated) {
			args.dbg(
				`session_start: deferred sequence read confirmed snapshot freshness — hydrating cachedExports/projectRulesScan late (seq=${snapshot.seq})`,
			);
		} else {
			args.dbg(
				`session_start: deferred sequence read confirmed snapshot freshness (seq=${snapshot.seq}), but the runtime already has live state (warmup or another task got there first) — skipping late hydration to avoid clobbering it`,
			);
		}
	};
}

function loadSnapshotBodyUnlessStale(args: {
	root: string;
	currentProjectSeq: number;
	dbg: (msg: string) => void;
}): { snapshot: ProjectSnapshot | null; skippedStale: boolean } {
	const meta = readProjectSnapshotMeta(args.root);
	if (meta && isProjectSnapshotMetaStale(meta, args.currentProjectSeq)) {
		args.dbg(
			`project_snapshot: meta gate stale (metaSeq=${meta.seq} metaVersion=${meta.version} current=${args.currentProjectSeq}) — skipping body parse`,
		);
		return { snapshot: null, skippedStale: true };
	}
	return {
		snapshot: loadProjectSnapshot(args.root),
		skippedStale: false,
	};
}

function describeSnapshotMiss(
	snapshot: ProjectSnapshot | null,
	currentProjectSeq: number,
	args: { skippedStale: boolean; bodyPresent: boolean },
): string {
	if (args.skippedStale) return "stale-meta-gate";
	if (!snapshot) return args.bodyPresent ? "invalid-body" : "missing";
	if (snapshot.seq !== currentProjectSeq) {
		return `stale(seq=${snapshot.seq}, current=${currentProjectSeq})`;
	}
	// Defensive-only arm: parseSnapshot rejects incompatible versions, and a
	// same-sequence parsed snapshot is fresh. Keep this classification explicit
	// so a future loader change cannot collapse it into a generic miss.
	return "incompatible";
}

function logProjectSnapshotProbe(args: {
	dbg: (msg: string) => void;
	root: string;
	currentProjectSeq: number;
	snapshot: ProjectSnapshot | null;
	missReason: string;
}): void {
	args.dbg(
		`project_snapshot: probe root=${args.root} path=${getProjectSnapshotPath(args.root)} currentSeq=${args.currentProjectSeq}`,
	);
	if (isProjectSnapshotFresh(args.snapshot, args.currentProjectSeq)) {
		args.dbg(
			`project_snapshot: loaded seq=${args.snapshot.seq} exports=${args.snapshot.cachedExports.length} files=${Object.keys(args.snapshot.files ?? {}).length} reverseDeps=${Object.keys(args.snapshot.reverseDeps ?? {}).length} startupScan=${Boolean(args.snapshot.startupScan)} languageProfile=${Boolean(args.snapshot.languageProfile)}`,
		);
	} else {
		args.dbg(`project_snapshot: miss reason=${args.missReason}`);
	}
}

function resolveStartupMode(): StartupMode {
	const envMode = (process.env.PI_LENS_STARTUP_MODE ?? "").trim().toLowerCase();
	if (envMode === "full" || envMode === "minimal" || envMode === "quick") {
		return envMode;
	}

	if (isPrintMode()) {
		return "quick";
	}

	return "full";
}

// --- Session-start helpers ---

// #1162: bound the session_start sequence read to this budget. The default
// mirrors the issue's ~250ms figure; overridable for tests (mirrors the
// `PI_LENS_WARMUP_DELAY_MS` precedent above) so a regression can use a tiny
// budget instead of racing a real 250ms wall-clock wait.
function sequenceReadBudgetMs(): number {
	const raw = Number(process.env.PI_LENS_SEQUENCE_READ_BUDGET_MS ?? 250);
	return Number.isFinite(raw) && raw > 0 ? raw : 250;
}

// #1162 review follow-up (P3): the sentinel used ONLY for the snapshot
// freshness check (`isProjectSnapshotFresh`/`isProjectSnapshotMetaStale`,
// both `=== currentProjectSeq` equality) when a sequence read timed out.
// Every real `projectSeq`/`snapshot.seq` is >= 0 (both derive from
// `Math.max(0, ...)`/a monotonic fold starting at 0), so this value can
// never collide with a legitimate seq — including a project's real
// first-ever snapshot persisted at `seq === 0`, which the cold-seed's OWN
// `projectSeq: 0` would otherwise alias. Deliberately kept separate from
// `runtime.projectSeq` (which a timed-out read still seeds to plain `0`):
// the reseed-advancement guard on the deferred continuation below needs
// `runtime.projectSeq` to read exactly 0 immediately after a cold seed so
// `> 0` reliably means "a bump happened in the stall window", which this
// sentinel is never fed into.
const UNKNOWN_PROJECT_SEQ = -1;

/**
 * Bound the sequence read that gates snapshot freshness (#1162). Normally
 * ~2ms, but the underlying read is a blocking `fs.readFileSync` that can
 * balloon under host I/O pressure (2125ms observed) with NO escape hatch —
 * and a `setTimeout`/`Promise.race` timeout can never preempt a *synchronous*
 * read (the thread only returns to the event loop once the OS call
 * returns). The fix is to read asynchronously (`readLatestProjectSequenceAsync`,
 * which uses `fs.promises.readFile` and genuinely yields) so a timeout CAN
 * win the race.
 *
 * On the healthy path (the overwhelming common case) the async read settles
 * first and this adds ~zero overhead beyond one microtask hop. On a stalled
 * read, the timeout wins: the caller proceeds immediately with a cold
 * sequence (`{ projectSeq: 0, fileSeqByPath: empty }` — byte-identical to
 * what a full replay of a missing/empty log already produces, so this is
 * exactly the existing cold-start case, not a new code path) while the real
 * read keeps running in the background. When it resolves, it re-seeds the
 * runtime so the warm-start optimization is recovered for the NEXT
 * session_start/turn instead of lost for the rest of the process — unless
 * the session has since moved on (`runtime.isCurrentSession`) or this is a
 * one-shot `pi --print` process (`isPrintMode()`), which has no future
 * session in-process to benefit and where letting background work outlive
 * settle is exactly the referenced-handle retention class #1154/#1153 just
 * closed. The timeout timer itself is `.unref()`'d and always cleared on
 * both race outcomes, so it never holds the process open either.
 *
 * Never silent (shape 10): the caller's `session_start_sequence_read`
 * latency line always carries `timedOut`, and a successful deferred reseed
 * logs its own `session_start_sequence_read_deferred_reseed` phase.
 */
async function readSequenceWithBudget(args: {
	snapshotRoot: string;
	base?: ProjectSequenceBase;
	cwd: string;
	runtime: RuntimeCoordinator;
	sessionGeneration: number;
	dbg: (msg: string) => void;
	/**
	 * #1785: the sequence read that timed out is still running in the
	 * background (see below) and, once it lands, is the FIRST point this
	 * session ever learns the real project sequence. Without this hook the
	 * only thing the deferred completion did was reseed `runtime.projectSeq`
	 * — the snapshot hydration decision made synchronously (with the
	 * `UNKNOWN_PROJECT_SEQ` sentinel, which can never match) stood for the
	 * rest of the session even once the real sequence proved the snapshot
	 * WAS fresh. Called with the resolved sequence so the caller can
	 * retroactively hydrate; skipped whenever the reseed itself is skipped
	 * (cross-session move-on or an in-window edit already advanced
	 * `runtime.projectSeq` — hydrating from the pre-edit snapshot over that
	 * would silently regress the edit).
	 */
	onDeferredSequenceResolved?: (latestSeq: ProjectSequenceIndex) => void;
}): Promise<{ latestSeq: ProjectSequenceIndex; timedOut: boolean }> {
	const {
		snapshotRoot,
		base,
		cwd,
		runtime,
		sessionGeneration,
		dbg,
		onDeferredSequenceResolved,
	} = args;
	const readPromise = readLatestProjectSequenceAsync(snapshotRoot, base);

	let timeoutHandle: NodeJS.Timeout | undefined;
	const timeoutPromise = new Promise<{ timedOut: true }>((resolve) => {
		timeoutHandle = setTimeout(
			() => resolve({ timedOut: true }),
			sequenceReadBudgetMs(),
		);
		timeoutHandle.unref();
	});

	const raced = await Promise.race([
		readPromise.then((latestSeq) => ({ timedOut: false as const, latestSeq })),
		timeoutPromise,
	]);
	if (timeoutHandle) clearTimeout(timeoutHandle);

	if (!raced.timedOut) {
		return { latestSeq: raced.latestSeq, timedOut: false };
	}

	dbg(
		`session_start: sequence read exceeded ${sequenceReadBudgetMs()}ms budget — falling back to cold-start sequence`,
	);

	if (!isPrintMode()) {
		readPromise
			.then((latestSeq) => {
				if (!runtime.isCurrentSession(sessionGeneration)) return;
				// #1162 review follow-up (P3): `isCurrentSession` alone catches a
				// CROSS-session move-on but not a SAME-session advancement in the
				// stall window. Interleaving: timeout -> cold seed sets
				// projectSeq=0 -> handler returns -> agent edits file X ->
				// `bumpFileSeq(X)` advances `_projectSeq`/`_fileSeq[X]` -> this
				// deferred read completes. Reseeding here would blindly `.clear()`
				// and repopulate `_fileSeq`/`_fileLastProjectSeq` from the STALE
				// pre-edit snapshot, erasing the in-window bump for file X (a
				// transient inconsistency that self-heals into a full sweep per
				// `seedProjectSequence`'s empty-changed-map invariant — safe, but
				// worth not doing). The cold seed always sets `projectSeq` to
				// exactly 0, so `runtime.projectSeq > 0` here can ONLY be true if a
				// `bumpFileSeq` ran since — i.e. an in-window edit — never a false
				// positive from a legitimately-empty log (which leaves it at 0, and
				// the reseed below is then still wanted: it recovers the real,
				// possibly non-empty, result that arrived too late for the budget).
				if (runtime.projectSeq > 0) {
					dbg(
						"session_start: deferred sequence read completed, but the session already advanced (in-window edit) — skipping reseed to avoid clobbering it",
					);
					return;
				}
				const reseedStartedAt = Date.now();
				runtime.seedProjectSequence?.(
					latestSeq.projectSeq,
					latestSeq.fileSeqByPath,
				);
				logLatency({
					type: "phase",
					phase: "session_start_sequence_read_deferred_reseed",
					filePath: cwd,
					startedAt: new Date(reseedStartedAt).toISOString(),
					durationMs: Date.now() - reseedStartedAt,
					metadata: { entries: latestSeq.fileSeqByPath.size, deferred: true },
				});
				dbg(
					`session_start: deferred sequence read completed — reseeded projectSeq=${latestSeq.projectSeq} fileSeqEntries=${latestSeq.fileSeqByPath.size}`,
				);
				onDeferredSequenceResolved?.(latestSeq);
			})
			.catch((err) => {
				dbg(`session_start: deferred sequence read failed: ${err}`);
			});
	}

	return {
		latestSeq: { projectSeq: 0, fileSeqByPath: new Map<string, number>() },
		timedOut: true,
	};
}

async function igniteWarmFiles(
	cwd: string,
	warmFiles: string[],
	runtime: RuntimeCoordinator,
	sessionGeneration: number,
	dbg: (msg: string) => void,
): Promise<void> {
	try {
		dbg(`session_start lsp-warm: ${warmFiles.length} warm file(s) configured`);

		await initLSPConfig(cwd);
		if (!runtime.isCurrentSession(sessionGeneration)) return;

		const lspService = (await loadLspService()).getLSPService();
		const total = warmFiles.length;
		let loaded = 0;
		let errors = 0;

		for (const relPath of warmFiles) {
			if (!runtime.isCurrentSession(sessionGeneration)) return;
			const filePath = path.isAbsolute(relPath)
				? relPath
				: path.resolve(cwd, relPath);
			if (!nodeFs.existsSync(filePath)) {
				dbg(`session_start lsp-warm: not found: ${relPath}`);
				errors++;
				continue;
			}
			try {
				const content = nodeFs.readFileSync(filePath, "utf-8");
				await lspService.touchFile(filePath, content, {
					diagnostics: "none",
					source: "startup-warm",
					clientScope: "primary",
					maxClientWaitMs: 2000,
				});
				loaded++;
			} catch (err) {
				dbg(`session_start lsp-warm: error ${relPath}: ${err}`);
				errors++;
			}
		}

		dbg(`session_start lsp-warm: ${loaded}/${total} opened (${errors} err)`);
	} catch (err) {
		dbg(`session_start lsp-warm: config/init error: ${err}`);
	}
}

/**
 * Fallback warm when a project has no explicit `warmFiles`: pre-spawn the LSP
 * for the project's *dominant* language (highest source-file count) by opening
 * one representative file. This eliminates the cold-spawn stall the first edit
 * would otherwise pay (`lsp_client_wait_timeout`, observed up to 5s on
 * TypeScript/Deno). Only a single server is warmed — launching every detected
 * language's server at once (rust-analyzer + gopls + tsserver …) would spike CPU
 * and the event loop at startup, working against the very latency we protect.
 * Projects that want more pre-warming can list explicit `warmFiles` (#203).
 */
async function igniteDominantLanguageWarm(
	cwd: string,
	runtime: RuntimeCoordinator,
	sessionGeneration: number,
	dbg: (msg: string) => void,
): Promise<void> {
	try {
		await initLSPConfig(cwd);
		if (!runtime.isCurrentSession(sessionGeneration)) return;

		const lspService = (await loadLspService()).getLSPService();
		const { collectSourceFilesAsync } = await import("./source-filter.js");
		const { CODE_KINDS, detectFileKind } = await import("./file-kinds.js");
		// Async, event-loop-yielding walk (deferred off the interactive path).
		// inspectGeneratedHeaders:false keeps the walk to directory reads only — no
		// per-file content opens — so we never hold a file handle (cheaper, and it
		// can't collide with concurrent fs teardown). Picking a representative file
		// doesn't need generated-banner filtering.
		const files = await collectSourceFilesAsync(cwd, {
			inspectGeneratedHeaders: false,
		});
		if (!runtime.isCurrentSession(sessionGeneration)) return;

		// Rank languages by source-file count. Computed here from the scan rather
		// than reused from languageProfile.counts, which is left empty on the
		// no-warm-caches startup path (detectProjectLanguageProfile is called with
		// an empty file list there).
		const counts = new Map<FileKind, number>();
		for (const f of files) {
			const kind = detectFileKind(f);
			if (kind) counts.set(kind, (counts.get(kind) ?? 0) + 1);
		}
		if (counts.size === 0) {
			dbg("session_start lsp-warm: no detected languages to auto-warm");
			return;
		}
		const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);

		// #894 review: data/doc kinds (json/yaml/markdown/…) have builtin LSP
		// servers too, and broadened enumeration makes them countable — so a TS
		// repo with more .json/.yml than .ts files would otherwise warm the
		// json/yaml server while tsserver still pays the ~5s cold-spawn stall
		// this warm exists to prevent (#203). Rank CODE_KINDS first; non-code
		// kinds stay as a fallback so a pure-config/docs repo still warms its
		// dominant server.
		const warmOrder = [
			...ranked.filter(([kind]) => CODE_KINDS.has(kind)),
			...ranked.filter(([kind]) => !CODE_KINDS.has(kind)),
		];

		// Walk languages by descending count; warm the first that has both an LSP
		// server and a representative on-disk file.
		for (const [kind] of warmOrder) {
			const sample = files.find(
				(f) => detectFileKind(f) === kind && lspService.supportsLSP(f),
			);
			if (!sample) continue;
			const content = await nodeFs.promises.readFile(sample, "utf-8");
			if (!runtime.isCurrentSession(sessionGeneration)) return;
			await lspService.touchFile(sample, content, {
				diagnostics: "none",
				source: "startup-warm-dominant",
				clientScope: "primary",
				maxClientWaitMs: 2000,
			});
			dbg(
				`session_start lsp-warm: dominant=${kind} via ${path.basename(sample)}`,
			);
			return;
		}
		dbg("session_start lsp-warm: no dominant-language LSP file found to warm");
	} catch (err) {
		dbg(`session_start lsp-warm: dominant warm error: ${err}`);
	}
}

function firePreinstallDefaults(
	ensureTool: SessionStartDeps["ensureTool"],
	dbg: SessionStartDeps["dbg"],
	startupDefaults: string[],
): void {
	for (const tool of startupDefaults) {
		const startedAt = Date.now();
		dbg(`session_start preinstall ${tool}: start`);
		ensureTool(tool)
			.then((toolPath) => {
				if (toolPath) {
					dbg(`session_start: ${tool} ready at ${toolPath}`);
					dbg(
						`session_start preinstall ${tool}: success (${Date.now() - startedAt}ms)`,
					);
				} else {
					dbg(`session_start: ${tool} installation unavailable`);
					dbg(
						`session_start preinstall ${tool}: unavailable (${Date.now() - startedAt}ms)`,
					);
				}
			})
			.catch((err) => {
				dbg(`session_start: ${tool} pre-install error: ${err}`);
				dbg(
					`session_start preinstall ${tool}: error (${Date.now() - startedAt}ms)`,
				);
			});
	}
}

/**
 * Default delay before the managed-tool version refresh runs (#1730). Long
 * enough that `session_start`, the startup scans, and the tool preinstalls have
 * all settled — the refresh may spawn one `npm update`, and that must never
 * compete with the work the user is waiting on.
 */
const MANAGED_TOOL_REFRESH_DELAY_MS = 30_000;

/**
 * Schedule the periodic managed-tool refresh (#1730) on an unref'd background
 * timer.
 *
 * `session_start`'s own cost here is a single `setTimeout` registration: the
 * refresh module is not even imported until the timer fires. The timer is
 * unref'd so a one-shot process exits without waiting for it, matching the
 * warmup timer above. Whether a refresh actually runs is decided inside
 * `runManagedToolRefresh` against a PERSISTED per-tool stamp, so a launch loop
 * cannot escalate the weekly cadence.
 */
function scheduleManagedToolRefresh(dbg: SessionStartDeps["dbg"]): void {
	const delayMs = Number(
		process.env.PI_LENS_TOOL_REFRESH_DELAY_MS ?? MANAGED_TOOL_REFRESH_DELAY_MS,
	);
	const timer = setTimeout(
		() => {
			void (async () => {
				try {
					const refresh = await import("./installer/managed-tool-refresh.js");
					const outcome = await refresh.runManagedToolRefresh();
					if (outcome.skipped) {
						dbg(`session_start tool-refresh: skipped (${outcome.skipped})`);
						return;
					}
					for (const result of outcome.refreshed) {
						dbg(
							`session_start tool-refresh: ${result.toolId} ${result.ok ? "ok" : "failed"}` +
								`${result.changed ? ` ${result.previousVersion ?? "unknown"} → ${result.currentVersion}` : " (unchanged)"}`,
						);
					}
				} catch (err) {
					dbg(`session_start tool-refresh: error ${err}`);
				}
			})();
		},
		Number.isFinite(delayMs) ? delayMs : MANAGED_TOOL_REFRESH_DELAY_MS,
	);
	timer.unref?.();
}

async function probePrettierInstall(
	ensureTool: SessionStartDeps["ensureTool"],
	dbg: SessionStartDeps["dbg"],
	analysisRoot: string,
): Promise<void> {
	const pkgPath = path.join(analysisRoot, "package.json");
	try {
		const raw = await nodeFs.promises.readFile(pkgPath, "utf-8");
		const pkg = JSON.parse(raw) as {
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
			prettier?: unknown;
		};
		const usesPrettier =
			!!pkg.devDependencies?.prettier ||
			!!pkg.dependencies?.prettier ||
			pkg.prettier !== undefined;
		if (usesPrettier) {
			dbg("session_start: project uses prettier, ensuring install...");
			ensureTool("prettier")
				.then((p) => {
					if (p) dbg(`session_start: prettier ready at ${p}`);
					else dbg("session_start: prettier install failed silently");
				})
				.catch((err) => dbg(`session_start: prettier install error: ${err}`));
		}
	} catch {
		// no package.json at cwd root
	}
}

/** A todo scanner that may expose a per-file API (newer) or only the
 * directory walk (older / mocked). `scanFile` returns the items array directly
 * (`TodoItem[]`); `scanDirectory` returns a `{ items }` result. */
type TodoScannerLike = {
	scanDirectory: (root: string) => { items: unknown[] };
	scanFile?: (filePath: string) => unknown[];
};

/** Scan one file via the per-file API, pushing any items. Tolerates an
 * unreadable file and a scanner without `scanFile` (no-op). */
function scanOneTodoFile(
	scanner: TodoScannerLike,
	filePath: string,
	items: unknown[],
): void {
	if (typeof scanner.scanFile !== "function") return;
	try {
		// scanFile returns TodoItem[] directly (not a { items } result).
		const result = scanner.scanFile(filePath);
		if (Array.isArray(result)) items.push(...result);
	} catch {
		// Per-file error: skip and continue (matches scanDirectory's tolerance).
	}
}

/** Collect the TODO baseline without blocking: enumerate source files and scan
 * them per-file, yielding to the event loop every 30 files. Falls back to the
 * blocking `scanDirectory` if the chunked path can't run (import error or a
 * scanner without `scanFile`). */
async function collectTodoBaselineItems(
	scanner: TodoScannerLike,
	analysisRoot: string,
	stillCurrent: () => boolean,
): Promise<unknown[]> {
	const items: unknown[] = [];
	try {
		const { getSourceFilesAsync } = await import("./scan-utils.js");
		// Enumerate with the chunked-yield walker so the file collection itself
		// (the previously-synchronous ~1.5s burst on a 2k-file tree) no longer
		// blocks the event loop before the per-file scan loop below even starts.
		const files = await getSourceFilesAsync(analysisRoot, true);
		if (!stillCurrent()) return items;
		const deadline = createDeadline(8);
		for (const file of files) {
			if (!stillCurrent()) return items;
			scanOneTodoFile(scanner, file, items);
			// scanFile cost scales with the file contents, so a count cadence cannot
			// bound the event-loop block across differently-sized corpora.
			await yieldIfOverBudget(deadline);
		}
	} catch {
		const todoResult = scanner.scanDirectory(analysisRoot);
		items.push(...todoResult.items);
	}
	return items;
}

// word-index — identifier inverted index + BM25 for ranked symbol search
// (#162). Shared load -> rebuild-if-stale -> persist lifecycle (#348), the same
// shape the call-graph task uses: reuse a fresh persisted index when the
// project `seq` hasn't moved since it was built, otherwise do a bounded
// rebuild and persist. Called from the full-mode background task AND the
// quick-mode cold-start warmup pass (below) so every startup mode ends up
// with a queryable index once per session, off the hot path.
interface WordIndexWarmupResult {
	mode: "full" | "incremental";
	refreshed: number;
	dropped: number;
	skipped?: number;
	reused: number;
}

async function buildOrRefreshWordIndex(args: {
	runtime: RuntimeCoordinator;
	sessionGeneration: number;
	analysisRoot: string;
	snapshotRoot: string;
	dbg: (msg: string) => void;
}): Promise<WordIndexWarmupResult | undefined> {
	const { runtime, sessionGeneration, analysisRoot, snapshotRoot, dbg } = args;
	if (!runtime.isCurrentSession(sessionGeneration)) return;
	const startMs = Date.now();
	let rebuildPreflightFiles:
		| import("./word-index.js").WordIndexPreflightFiles
		| undefined;

	const latestSeq = readLatestProjectSequence(
		snapshotRoot,
		snapshotSequenceBase(snapshotRoot),
	);
	const effectiveSeq = runtime.projectSeq ?? latestSeq.projectSeq;
	const snapshotLoadStartMs = Date.now();
	const snapshot = loadProjectSnapshot(snapshotRoot);
	const snapshotLoadMs = Date.now() - snapshotLoadStartMs;
	if (snapshot?.wordIndex) {
		const {
			deserializeWordIndex,
			refreshWordIndexIncrementally,
			countWordIndexPostingEntries,
			estimateWordIndexResidentBytes,
		} = await import("./word-index.js");
		const deserializeStartMs = Date.now();
		const index = deserializeWordIndex(snapshot.wordIndex);
		const deserializeMs = Date.now() - deserializeStartMs;
		if (index) {
			try {
				const result = await refreshWordIndexIncrementally(
					index,
					analysisRoot,
					() => runtime.isCurrentSession(sessionGeneration),
				);
				if (!runtime.isCurrentSession(sessionGeneration)) return;
				if (result.mode === "full-required") {
					rebuildPreflightFiles = result.preflightFiles;
					dbg(
						`session_start word-index: incremental preflight selected full rebuild (${result.reason})`,
					);
					logWordIndex({
						phase: "incremental_fallback",
						cwd: snapshotRoot,
						trigger: "session_start",
						reason: result.reason,
						phaseDurationsMs: {
							snapshotLoadMs,
							deserializeMs,
							...result.timings,
						},
					});
				} else {
					runtime.wordIndex = index;
					let snapshotSaveSyncMs = 0;
					// A stale project seq must be advanced even when mtimes prove every
					// indexed document reusable. Fresh snapshots with no changes avoid
					// an unnecessary rewrite of the large shared snapshot.
					if (
						!isProjectSnapshotFresh(snapshot, effectiveSeq) ||
						result.refreshed > 0 ||
						result.dropped > 0 ||
						snapshot.wordIndex.truncated !== index.truncated
					) {
						const serializeSaveEnqueueStartMs = Date.now();
						saveRuntimeProjectSnapshot({ cwd: snapshotRoot, runtime, dbg });
						snapshotSaveSyncMs = Date.now() - serializeSaveEnqueueStartMs;
					}
					const phases =
						`snapshot-load=${snapshotLoadMs}ms, deserialize=${deserializeMs}ms, ` +
						`source-walk=${result.timings.sourceWalkMs}ms, stat-walk=${result.timings.statWalkMs}ms, ` +
						`refresh-reads=${result.timings.refreshReadsMs}ms, ` +
						`snapshot-save-sync=${snapshotSaveSyncMs}ms`;
					dbg(
						`session_start word-index: incremental (seq=${effectiveSeq}, refreshed=${result.refreshed}, dropped=${result.dropped}, skipped=${result.skipped}, reused=${result.reused}, ${Date.now() - startMs}ms, phases: ${phases})`,
					);
					// M2, #958: the incremental-vs-full decision + honest coverage
					// (indexedFileCount/truncated/skipped), independent of host `dbg`.
					logWordIndex({
						phase: "incremental_refresh",
						cwd: snapshotRoot,
						trigger: "session_start",
						durationMs: Date.now() - startMs,
						indexedFileCount: index.docCount,
						tokens: index.postings.size,
						postingEntries: countWordIndexPostingEntries(index),
						residentBytes: estimateWordIndexResidentBytes(index),
						truncated: index.truncated,
						phaseDurationsMs: {
							snapshotLoadMs,
							deserializeMs,
							...result.timings,
							snapshotSaveSyncMs,
						},
						refreshed: result.refreshed,
						dropped: result.dropped,
						skipped: result.skipped,
						reused: result.reused,
					});
					return result;
				}
			} catch (err) {
				// Supersession is an expected transition, not a failure: a newer
				// session_start bumped the generation mid-refresh. Return undefined the
				// way master's synchronous path did instead of reporting a fallback and
				// re-walking for a rebuild whose result this generation may not publish.
				if (!runtime.isCurrentSession(sessionGeneration)) {
					dbg("session_start word-index: incremental refresh superseded");
					return;
				}
				dbg(
					`session_start word-index: incremental refresh failed; falling back to full rebuild (${err})`,
				);
				logWordIndex({
					phase: "incremental_fallback",
					cwd: snapshotRoot,
					trigger: "session_start",
					reason: err instanceof Error ? err.message : String(err),
					phaseDurationsMs: { snapshotLoadMs, deserializeMs },
				});
			}
		}
	}

	// Shared file-walk-and-read helper (#348): the ONE collectWordIndexDocs
	// implementation backs this task, the quick-mode warmup call below, AND the
	// stateless cold-query background trigger in word-index.ts — a bound/skip
	// -rule change lands once, not in three copies.
	const {
		buildWordIndexAsync,
		collectWordIndexDocs,
		countWordIndexPostingEntries,
		estimateWordIndexResidentBytes,
	} = await import("./word-index.js");
	const docs = await collectWordIndexDocs(
		analysisRoot,
		() => runtime.isCurrentSession(sessionGeneration),
		rebuildPreflightFiles,
	);
	if (!runtime.isCurrentSession(sessionGeneration)) return;
	// #1197 review finding 2: `buildWordIndexAsync` THROWS on supersession, and
	// the quick-mode warmup caller (below) awaits this function OUTSIDE any
	// per-step try/catch — an escaping throw there skips the rest of warmup,
	// including the #947 LSP pre-warm, and resets `__piLensWarmupScheduled`.
	// Supersession is an expected transition (master's synchronous path just
	// returned), so absorb it here and let the caller continue.
	let rebuiltIndex: Awaited<ReturnType<typeof buildWordIndexAsync>>;
	try {
		rebuiltIndex = await buildWordIndexAsync(docs, () =>
			runtime.isCurrentSession(sessionGeneration),
		);
	} catch (err) {
		if (!runtime.isCurrentSession(sessionGeneration)) {
			dbg("session_start word-index: rebuild superseded");
			return;
		}
		throw err;
	}
	if (!runtime.isCurrentSession(sessionGeneration)) return;
	runtime.wordIndex = rebuiltIndex;
	saveRuntimeProjectSnapshot({ cwd: snapshotRoot, runtime, dbg });
	dbg(
		`session_start word-index: rebuilt (absent/stale, seq=${effectiveSeq}) ` +
			`${runtime.wordIndex.docCount} files, ${runtime.wordIndex.postings.size} tokens (${Date.now() - startMs}ms)`,
	);
	// M2, #958: full-rebuild decision + honest coverage. `docs.skipped` (L1)
	// counts files the walk saw but could not index (unreadable / over the byte
	// cap) so a partial index is never reported as complete (#533).
	logWordIndex({
		phase: "full_rebuild",
		cwd: snapshotRoot,
		trigger: "session_start",
		durationMs: Date.now() - startMs,
		indexedFileCount: runtime.wordIndex.docCount,
		tokens: runtime.wordIndex.postings.size,
		postingEntries: countWordIndexPostingEntries(runtime.wordIndex),
		residentBytes: estimateWordIndexResidentBytes(runtime.wordIndex),
		truncated: runtime.wordIndex.truncated,
		skipped: docs.skipped,
	});
	return {
		mode: "full",
		refreshed: runtime.wordIndex.docCount,
		dropped: 0,
		skipped: docs.skipped,
		reused: 0,
	};
}

// Fire off heavy scans as background tasks — don't block session start.
// Each consumer already handles the "not ready yet" case gracefully
// (cachedExports.size > 0, cache miss paths).
function scheduleStartupScans(
	deps: SessionStartDeps,
	runtime: RuntimeCoordinator,
	sessionGeneration: number,
	analysisRoot: string,
	snapshotRoot: string,
	languageProfile: ReturnType<typeof detectProjectLanguageProfile>,
	dbg: SessionStartDeps["dbg"],
): void {
	const {
		todoScanner,
		cacheManager,
		knipClient,
		jscpdClient,
		deadCodeClients,
		govulncheckClient,
		gitleaksClient,
		trivyClient,
		opengrepClient,
		astGrepClient,
		depChecker,
	} = deps;

	// Some background scans are CPU-heavy and arrive on the event loop
	// just as the user is most likely typing (right after /new). Defer
	// those by a few seconds so the perceptible 50-100ms sync bursts they
	// contain land during LLM streaming idle time instead. All other
	// tasks (those not listed here) run on the next `setImmediate` tick
	// as before. The delays are deliberately staggered (200ms apart) so
	// two heavy tasks don't both run on the same macrotask.
	const taskDeferMsByName: Record<string, number> = {
		"call-graph": 5000,
		"codebase-model": 5200,
		"ast-grep exports": 5400,
		"project index": 5400,
	};
	const runTask = (name: string, task: () => Promise<void>): Promise<void> => {
		const queuedAt = Date.now();
		dbg(`session_start task ${name}: scheduled`);
		runtime.markStartupScanInFlight(name, sessionGeneration);
		const completion = new Promise<void>((resolve) => {
			const fire = (): void => {
				const startedAt = Date.now();
				dbg(
					`session_start task ${name}: start queuedMs=${startedAt - queuedAt}`,
				);
				void task()
					.then(() => {
						dbg(
							`session_start task ${name}: success runMs=${Date.now() - startedAt} queuedMs=${startedAt - queuedAt}`,
						);
					})
					.catch((err) => {
						dbg(`session_start: ${name} background scan failed: ${err}`);
						dbg(
							`session_start task ${name}: failed runMs=${Date.now() - startedAt} queuedMs=${startedAt - queuedAt}`,
						);
					})
					.finally(() => {
						runtime.clearStartupScanInFlight(name, sessionGeneration);
						dbg(`session_start task ${name}: end`);
						resolve();
					});
			};
			const delay = taskDeferMsByName[name] ?? 0;
			if (delay > 0) {
				// #1154: unref to match the repo-wide convention that every
				// background timer is `.unref()`'d. Full-mode deferred scans only
				// run in long-lived/interactive sessions today (never a one-shot),
				// so this is defensive — but a referenced 5s timer would keep a
				// process open were a full-mode one-shot ever introduced.
				setTimeout(fire, delay).unref?.();
			} else {
				setImmediate(fire);
			}
		});
		return completion;
	};

	const canRunJsTsHeavyScans = canRunStartupHeavyScans(languageProfile, "jsts");
	const scanNames = ["todo", "dead-code"];
	if (canRunJsTsHeavyScans) {
		scanNames.push("knip", "jscpd", "ast-grep exports", "project index");
	}
	dbg(`session_start: launching background scans (${scanNames.join(", ")})`);

	runTask("todo", async () => {
		if (!runtime.isCurrentSession(sessionGeneration)) return;
		// The original implementation called todoScanner.scanDirectory(), which
		// walks the project synchronously and freezes the TUI for ~3s on a 2k-file
		// project. collectTodoBaselineItems re-implements the walk in async chunks
		// (per-file scan, yielding every 30 files), falling back to scanDirectory.
		const items = await collectTodoBaselineItems(
			todoScanner as TodoScannerLike,
			analysisRoot,
			() => runtime.isCurrentSession(sessionGeneration),
		);
		if (!runtime.isCurrentSession(sessionGeneration)) return;
		dbg(`session_start TODO scan: ${items.length} items (baseline stored)`);
		cacheManager.writeCache("todo-baseline", { items }, analysisRoot);
	});

	if (!canRunJsTsHeavyScans) {
		dbg(
			"session_start: skipping JS/TS startup scans (requires JS/TS language + project config)",
		);
		return;
	}

	// #462: knip/jscpd/madge/dead-code/govulncheck/gitleaks/trivy/opengrep each spawn an
	// external CLI that walks the whole project tree on its own — a walk we
	// don't control or get to route to an async collector. On a measured-slow
	// filesystem that walk reproduces the exact multi-second freeze this
	// feature exists to prevent, so skip exactly those seven with a visible
	// reason instead of leaving the agent to read an empty/stale cache as
	// "clean". The other scans in this function (todo above; call-graph/
	// codebase-model/ast-grep-exports/word-index below) walk via
	// `collectSourceFilesAsync` or build from cached review-graph data, so
	// they stay on.
	//
	// #449 slice 0: the same gate also fires inside a nicobailon/pi-subagents
	// child `pi` process (`PI_SUBAGENT_CHILD=1`) — a fan-out of N subagents in
	// the same cwd otherwise pays N full heavyweight-scan fleets for
	// short-lived task agents that rarely consult them. In-process scans stay
	// on for the same reason as slow-FS: the subagent may still use symbol
	// search / word-index.
	const isSubagent = isSubagentSession();
	const skipHeavyweightScans = isSlowFs(analysisRoot) || isSubagent;
	const runHeavyweightTask = (
		name: string,
		task: () => Promise<void>,
	): void => {
		if (skipHeavyweightScans) return;
		runTask(name, task);
	};
	if (skipHeavyweightScans) {
		dbg(
			`session_start: skipping knip/jscpd/madge/dead-code/govulncheck/gitleaks/trivy/opengrep (${
				isSubagent ? "subagent" : "slow-fs"
			})`,
		);
		deps.notify(
			`⏭️ Skipped background code-quality scans (knip/jscpd/madge/dead-code/govulncheck/gitleaks/trivy/opengrep): ${
				isSubagent ? subagentLightModeNotice() : slowFsDegradationNotice()
			}`,
			"info",
		);
	}

	// Knip — dead code / unused exports
	runHeavyweightTask("knip", async () => {
		if (!runtime.isCurrentSession(sessionGeneration)) return;
		const cached = cacheManager.readCache<KnipResult>("knip", analysisRoot);
		if (cached) {
			if (!runtime.isCurrentSession(sessionGeneration)) return;
			dbg(
				`session_start Knip: cache hit (${Math.round((Date.now() - new Date(cached.meta.timestamp).getTime()) / 1000)}s ago)`,
			);
		} else {
			// KnipClient skips before probing/installing when analysisRoot is not a real
			// JS/Knip project. This avoids running knip from Unity/C#/generic repos.
			const startMs = Date.now();
			const knipResult = await knipClient.analyze(
				analysisRoot,
				getKnipIgnorePatterns(),
				{ projectSeq: runtime.projectSeq },
			);
			if (!runtime.isCurrentSession(sessionGeneration)) return;
			if (knipResult.success) {
				cacheManager.writeCache("knip", knipResult, analysisRoot, {
					scanDurationMs: Date.now() - startMs,
				});
			}
			dbg(`session_start Knip scan done (${Date.now() - startMs}ms)`);
		}
	});

	// jscpd — duplicate code detection
	runHeavyweightTask("jscpd", async () => {
		if (await jscpdClient.ensureAvailable()) {
			if (!runtime.isCurrentSession(sessionGeneration)) return;
			// Detect TS projects by tsconfig.json at the analysis root. When
			// set, JscpdClient.scan adds **/*.js and **/*.jsx to its ignore
			// pattern so compiled artifacts under dist/ aren't flagged as
			// duplicates of their TypeScript sources (closes #126's latent
			// dist/-as-duplicate bug). Cache scanner key varies by this flag
			// so a stale cache built with the wrong setting invalidates on
			// first read.
			const isTsProject = nodeFs.existsSync(
				path.join(analysisRoot, "tsconfig.json"),
			);
			const scannerKey = isTsProject ? "jscpd-ts" : "jscpd";
			const cached = cacheManager.readCache<
				Awaited<ReturnType<JscpdClient["scan"]>>
			>(scannerKey, analysisRoot);
			if (cached) {
				if (!runtime.isCurrentSession(sessionGeneration)) return;
				dbg(`session_start jscpd: cache hit (${scannerKey})`);
			} else {
				const startMs = Date.now();
				const jscpdResult = await jscpdClient.scan(
					analysisRoot,
					undefined,
					undefined,
					isTsProject,
				);
				if (!runtime.isCurrentSession(sessionGeneration)) return;
				if (jscpdResult.success) {
					cacheManager.writeCache(scannerKey, jscpdResult, analysisRoot, {
						scanDurationMs: Date.now() - startMs,
					});
				}
				dbg(
					`session_start jscpd scan done (${Date.now() - startMs}ms, isTsProject=${isTsProject})`,
				);
			}
		} else {
			if (!runtime.isCurrentSession(sessionGeneration)) return;
			dbg("session_start jscpd: not available");
		}
	});

	// dead-code — cross-file dead-code for non-JS/TS languages (#127). Each
	// client self-gates via detect() (a cheap fs marker probe), so only a
	// matching-language project incurs the whole-tree scan cost. Knip remains
	// the JS/TS path (above); these run alongside it for polyglot repos.
	runHeavyweightTask("dead-code", async () => {
		const applicable = deadCodeClients.filter((c) => c.detect(analysisRoot));
		if (applicable.length === 0) return;
		await Promise.all(
			applicable.map(async (client) => {
				if (!runtime.isCurrentSession(sessionGeneration)) return undefined;
				const cacheKey = `dead-code-${client.id}`;
				const cached = cacheManager.readCache<DeadCodeResult>(
					cacheKey,
					analysisRoot,
				);
				if (cached) {
					dbg(`session_start dead-code(${client.id}): cache hit`);
					return undefined;
				}
				const startMs = Date.now();
				const result = await client.analyze(analysisRoot);
				if (!runtime.isCurrentSession(sessionGeneration)) return undefined;
				if (result.success) {
					cacheManager.writeCache(cacheKey, result, analysisRoot, {
						scanDurationMs: Date.now() - startMs,
					});
				}
				logDeadCodeScan({
					language: client.language,
					success: result.success,
					cached: false,
					unusedExports: result.unusedExports.length,
					unusedFiles: result.unusedFiles.length,
					unusedDeps: result.unusedDeps.length,
					unlistedDeps: result.unlistedDeps.length,
					durationMs: result.durationMs ?? Date.now() - startMs,
					...(!result.success && { reason: result.summary }),
				});
				dbg(
					`session_start dead-code(${client.id}) done (${Date.now() - startMs}ms, ${deadCodeIssueCount(result)} issues)`,
				);
			}),
		);
	});

	// govulncheck — Go module CVE detection (#132)
	// Skipped silently when the project isn't a Go module or when
	// `govulncheck` isn't installed (no auto-install in this slice).
	runHeavyweightTask("govulncheck", async () => {
		if (!GovulncheckClient.hasGoModule(analysisRoot)) {
			dbg("session_start govulncheck: no go.mod — skipped");
			return;
		}
		if (!(await govulncheckClient.ensureAvailable())) {
			if (!runtime.isCurrentSession(sessionGeneration)) return;
			dbg(
				"session_start govulncheck: not installed (go install golang.org/x/vuln/cmd/govulncheck@latest)",
			);
			return;
		}
		if (!runtime.isCurrentSession(sessionGeneration)) return;
		const cached = cacheManager.readCache<GovulncheckResult>(
			"govulncheck",
			analysisRoot,
		);
		if (cached) {
			if (!runtime.isCurrentSession(sessionGeneration)) return;
			dbg(
				`session_start govulncheck: cache hit (${cached.data.findings.length} findings)`,
			);
			return;
		}
		const startMs = Date.now();
		const result = await govulncheckClient.analyze(analysisRoot);
		if (!runtime.isCurrentSession(sessionGeneration)) return;
		if (result.success) {
			cacheManager.writeCache("govulncheck", result, analysisRoot, {
				scanDurationMs: Date.now() - startMs,
			});
		}
		dbg(
			`session_start govulncheck: ${result.findings.length} reachable findings (${Date.now() - startMs}ms)`,
		);
	});

	// gitleaks — committed-secrets detection (#130)
	// Config-gated: opts in via .gitleaks.toml / .gitleaksignore / git
	// hook / gitleaks dep. Cross-language by design.
	runHeavyweightTask("gitleaks", async () => {
		if (!GitleaksClient.hasGitleaksSignal(analysisRoot)) {
			dbg("session_start gitleaks: no opt-in signal — skipped");
			return;
		}
		if (!(await gitleaksClient.ensureAvailable())) {
			if (!runtime.isCurrentSession(sessionGeneration)) return;
			dbg("session_start gitleaks: not available (install failed?)");
			return;
		}
		if (!runtime.isCurrentSession(sessionGeneration)) return;
		const cached = cacheManager.readCache<GitleaksResult>(
			"gitleaks",
			analysisRoot,
		);
		if (cached) {
			if (!runtime.isCurrentSession(sessionGeneration)) return;
			dbg(
				`session_start gitleaks: cache hit (${cached.data.findings.length} findings)`,
			);
			return;
		}
		const startMs = Date.now();
		const result = await gitleaksClient.scan(analysisRoot);
		if (!runtime.isCurrentSession(sessionGeneration)) return;
		if (result.success) {
			cacheManager.writeCache("gitleaks", result, analysisRoot, {
				scanDurationMs: Date.now() - startMs,
			});
		}
		dbg(
			`session_start gitleaks: ${result.findings.length} findings (${Date.now() - startMs}ms)`,
		);
	});

	// opengrep — full-workspace security/quality findings via a single CLI scan
	// (#584). Structurally always-on (mirrors the LSP auxiliary's own
	// enablement — see `OpengrepClient.resolveConfig`): the local rule file or
	// `auto` registry ruleset always runs, `resolveOpengrepConfig` only picks
	// which. Replaces the per-file LSP sweep as the source of opengrep
	// findings for `lens_diagnostics mode=full` (`runWorkspaceDiagnostics` now
	// excludes the opengrep server from its per-file "all"-scope touch —
	// clients/lsp/index.ts `WORKSPACE_SWEEP_EXCLUDED_SERVER_IDS`); the per-edit
	// real-time LSP path is untouched.
	runHeavyweightTask("opengrep", async () => {
		if (!(await opengrepClient.ensureAvailable())) {
			if (!runtime.isCurrentSession(sessionGeneration)) return;
			dbg("session_start opengrep: not available (install failed?)");
			return;
		}
		if (!runtime.isCurrentSession(sessionGeneration)) return;
		const cached = cacheManager.readCache<OpengrepResult>(
			"opengrep",
			analysisRoot,
		);
		if (cached) {
			if (!runtime.isCurrentSession(sessionGeneration)) return;
			dbg(
				`session_start opengrep: cache hit (${cached.data.findings.length} findings)`,
			);
			return;
		}
		const startMs = Date.now();
		const result = await opengrepClient.scan(analysisRoot);
		if (!runtime.isCurrentSession(sessionGeneration)) return;
		if (result.success) {
			cacheManager.writeCache("opengrep", result, analysisRoot, {
				scanDurationMs: Date.now() - startMs,
			});
		}
		dbg(
			`session_start opengrep: ${result.findings.length} findings (${Date.now() - startMs}ms)`,
		);
	});

	// madge — whole-project circular-dependency detection. Session-start + cached
	// (uniform with knip/jscpd/gitleaks) so lens_diagnostics mode=full reads it
	// from the `madge` cache via the extractor registry — never a fresh scan.
	runHeavyweightTask("madge", async () => {
		if (!(await depChecker.ensureAvailable())) {
			if (!runtime.isCurrentSession(sessionGeneration)) return;
			dbg("session_start madge: not available");
			return;
		}
		if (!runtime.isCurrentSession(sessionGeneration)) return;
		const cached = cacheManager.readCache<{ circular: unknown[] }>(
			"madge",
			analysisRoot,
		);
		if (cached) {
			dbg(
				`session_start madge: cache hit (${cached.data.circular.length} cycles)`,
			);
			return;
		}
		const startMs = Date.now();
		const result = await depChecker.scanProject(analysisRoot);
		if (!runtime.isCurrentSession(sessionGeneration)) return;
		cacheManager.writeCache("madge", result, analysisRoot, {
			scanDurationMs: Date.now() - startMs,
		});
		dbg(
			`session_start madge: ${result.circular.length} circular dependency chain(s) (${Date.now() - startMs}ms)`,
		);
	});

	// trivy — dependency CVE detection (#131, Phase 1)
	// Explicit opt-in: `trivy.enabled: true` in .pi-lens.json AND a dependency
	// manifest present. The first run downloads Trivy's vuln DB (~30-200 MB);
	// harmless here since this whole task runs in the background session_start
	// wrapper.
	runHeavyweightTask("trivy", async () => {
		if (!TrivyClient.shouldScan(analysisRoot)) {
			dbg(
				"session_start trivy: not enabled / no dependency manifest — skipped",
			);
			return;
		}
		if (!(await trivyClient.ensureAvailable())) {
			if (!runtime.isCurrentSession(sessionGeneration)) return;
			dbg("session_start trivy: not available (install failed?)");
			return;
		}
		if (!runtime.isCurrentSession(sessionGeneration)) return;
		const cached = cacheManager.readCache<TrivyResult>("trivy", analysisRoot);
		if (cached) {
			if (!runtime.isCurrentSession(sessionGeneration)) return;
			dbg(
				`session_start trivy: cache hit (${cached.data.findings.length} findings)`,
			);
			return;
		}
		const startMs = Date.now();
		const result = await trivyClient.scan(analysisRoot);
		if (!runtime.isCurrentSession(sessionGeneration)) return;
		if (result.success) {
			cacheManager.writeCache("trivy", result, analysisRoot, {
				scanDurationMs: Date.now() - startMs,
			});
		}
		dbg(
			`session_start trivy: ${result.findings.length} CVE findings (${Date.now() - startMs}ms)`,
		);
	});

	// call-graph — build function-level call graph from review graph data
	let callGraphIdentity:
		| { reviewGraphVersion: string; reviewGraphSignature: string }
		| undefined;
	const callGraphTask = runTask("call-graph", async () => {
		const { FactStore } = await import("./dispatch/fact-store.js");
		const {
			buildOrUpdateGraph,
			extractSymbolsAndRefsFromGraph,
			getReviewGraphCacheIdentity,
		} = await import("./review-graph/builder.js");
		const { buildCallGraph, saveCallGraph, loadCallGraph } =
			await import("./call-graph.js");
		if (!runtime.isCurrentSession(sessionGeneration)) return;
		const startMs = Date.now();
		// Build (or hydrate) the canonical review graph first. The call graph is a
		// derived projection of that graph, so its freshness is the review graph's
		// version/signature—not a second source walk and mtime policy.
		// Subject labels this store's capacity-eviction telemetry distinctly
		// from the other five production FactStore instances (#2243 review
		// round 3, F1) — this session-start walk runs BEFORE any dispatch and
		// can visit every file in the project, so a shared subject would let
		// it consume the dispatch store's once-per-session ledger slot first.
		const sessionFacts = new FactStore("runtime-session-call-graph");
		const graph = await buildOrUpdateGraph(analysisRoot, [], sessionFacts);
		if (!runtime.isCurrentSession(sessionGeneration)) return;
		const identity = getReviewGraphCacheIdentity(analysisRoot, graph);
		if (!identity) {
			dbg(
				"session_start call-graph: canonical review-graph identity unavailable",
			);
			return;
		}
		callGraphIdentity = {
			reviewGraphVersion: identity.version,
			reviewGraphSignature: identity.signature,
		};
		const cached = loadCallGraph(snapshotRoot, {
			reviewGraphVersion: identity.version,
			reviewGraphSignature: identity.signature,
		});
		if (cached) {
			runtime.callGraph = cached.graph;
			dbg(
				`session_start call-graph: loaded from cache (${cached.graph.edges.length} edges, ${cached.graph.callers.size} callee entries, ${Date.now() - startMs}ms)`,
			);
			return;
		}
		// Build from the canonical review graph (reuses already-parsed data, no
		// duplicate parser or source walk).
		const { allSymbols, allRefs, coverage } =
			extractSymbolsAndRefsFromGraph(graph);
		const callGraph = buildCallGraph(allSymbols, allRefs, coverage);
		runtime.callGraph = callGraph;
		saveCallGraph(snapshotRoot, callGraph, {
			reviewGraphVersion: identity.version,
			reviewGraphSignature: identity.signature,
		});
		dbg(
			`session_start call-graph: built ${callGraph.edges.length} edges, ${callGraph.callers.size} callee entries (${Date.now() - startMs}ms)`,
		);
	});

	// codebase-model — build mental model from call graph (internal-only until validated)
	// Keep this deferred, but await the call-graph task's completion rather than
	// racing its independently deferred timer. Otherwise a slow graph build leaves
	// `runtime.callGraph` unset at this task's start and loses the model for the
	// entire session (#1070).
	runTask("codebase-model", async () => {
		await callGraphTask;
		if (!runtime.isCurrentSession(sessionGeneration)) return;
		if (!runtime.callGraph) return;
		const {
			buildCodebaseModel,
			saveCodebaseModel,
			DEFAULT_CODEBASE_MODEL_TOKEN_BUDGET,
		} = await import("./codebase-model.js");
		if (!callGraphIdentity) return;
		const model = buildCodebaseModel(
			runtime.callGraph,
			analysisRoot,
			DEFAULT_CODEBASE_MODEL_TOKEN_BUDGET,
			callGraphIdentity,
		);
		saveCodebaseModel(snapshotRoot, model);
		const top3 = model.entries
			.slice(0, 3)
			.map((e) => e.name)
			.join(", ");
		dbg(
			`session_start codebase-model: ${model.entries.length} entries, ` +
				`${model.totalTokens} tokens, top symbols: ${top3 || "(none)"}`,
		);
	});

	// ast-grep — export scan for duplicate detection
	runTask("ast-grep-exports", async () => {
		if (await astGrepClient.ensureAvailable()) {
			if (!runtime.isCurrentSession(sessionGeneration)) return;
			const exports = await astGrepClient.scanExports(
				analysisRoot,
				"typescript",
			);
			if (!runtime.isCurrentSession(sessionGeneration)) return;
			dbg(`session_start exports scan: ${exports.size} functions found`);
			for (const [name, file] of exports) {
				runtime.cachedExports.set(name, file);
			}
			saveRuntimeProjectSnapshot({ cwd: snapshotRoot, runtime, dbg });
		}
	});

	// word-index — identifier inverted index + BM25 for ranked symbol search
	// (#162). Load -> rebuild-if-stale -> persist lifecycle (#348), shared with
	// the quick-mode cold-start warmup pass below.
	runTask("word-index", async () => {
		await buildOrRefreshWordIndex({
			runtime,
			sessionGeneration,
			analysisRoot,
			snapshotRoot,
			dbg,
		});
	});
}

function scheduleDeferredToolProbes(
	deps: SessionStartDeps,
	languageProfile: ReturnType<typeof detectProjectLanguageProfile>,
	startupDefaults: string[],
	startupScansWillRun: boolean,
	dbg: SessionStartDeps["dbg"],
): void {
	const { biomeClient, ruffClient, depChecker } = deps;
	const defaultTools = new Set(startupDefaults);
	const probes: Array<[name: string, run: () => Promise<boolean>]> = [];

	// Do not probe tools already covered by startup preinstall or startup scans.
	// This keeps session_start logs from showing duplicate "ensure X: start" lines
	// while preserving lazy checks for tools that are actually relevant.
	if (languageProfile.present.jsts && !defaultTools.has("biome")) {
		probes.push(["biome", () => biomeClient.ensureAvailable()]);
	}
	if (languageProfile.present.python && !defaultTools.has("ruff")) {
		probes.push(["ruff", () => ruffClient.ensureAvailable()]);
	}
	if (startupScansWillRun) {
		probes.push(["madge", () => depChecker.ensureAvailable()]);
	}

	if (probes.length === 0) {
		dbg("session_start tools: no deferred availability probes needed");
		return;
	}

	void (async () => {
		const warmStart = Date.now();
		const results = await Promise.all(
			probes.map(async ([name, run]) => {
				try {
					return [name, await run()] as const;
				} catch (err) {
					dbg(`session_start: ${name} availability check failed: ${err}`);
					return [name, false] as const;
				}
			}),
		);
		const summary = results
			.map(([name, ready]) => `${name}=${ready}`)
			.join(" ");
		dbg(
			`session_start tools (deferred probes complete, ${Date.now() - warmStart}ms): ${summary}`,
		);
	})();
}

/**
 * Session-start orientation prepended as a context message (gated by the
 * context-injection toggle). Deliberately lean: it names the high-value tools
 * and the one non-obvious behaviour (mode=all resurfaces stale blocking errors)
 * — per-tool argument detail lives in each tool's own registered description, so
 * re-documenting it here would just pay the tokens twice every session.
 */
export const SESSION_START_GUIDANCE: string[] = [
	"📌 pi-lens active — automated checks run on every edit/write; blocking errors (including pre-existing) show inline and must be fixed.\n" +
		"Key tools (see each tool's own description for args):\n" +
		"• lens_diagnostics — session-wide diagnostic state; mode=all resurfaces stale blocking errors that dropped from turn context.\n" +
		"• symbol_search → module_report → read_symbol/read_enclosing — ranked identifier search, then navigable outline/callback handles + exact body reads; cheaper than reading a whole file before editing.\n" +
		"• lsp_diagnostics — probe LSP for errors in a file/folder/workspace.\n" +
		"• Situational (activate via pi_lens_activate_tools): lsp_navigation, ast_grep_search, ast_grep_replace, ast_grep_dump.",
];

export async function handleSessionStart(
	deps: SessionStartDeps,
): Promise<void> {
	resetDegradationLedger();
	resetTestRunnerDelivery();
	// #1743: the bounded-telemetry per-turn counters. The rising-edge state is
	// NOT here — it is the ledger's own tally, reset on the line above. These
	// counters are keyed by turn index, and a new session restarts turn
	// numbering at 0, so without this a stale count could survive a session
	// boundary that happened to land on the same index.
	resetBoundedTelemetry();
	// #1956 R3: stale message_end events drain after replacement. Rotate the
	// live anchor into one bounded previous slot so the queued event keeps the
	// replaced session's attribution until a newer live message_end is seen.
	rotateMessageEndAttribution();
	const handlerEnteredAt = Date.now();
	const sessionStartMs = deps.sessionStartFiredAt ?? handlerEnteredAt;
	const cwdForTelemetry = deps.ctxCwd ?? process.cwd();
	if (
		deps.bootstrapClientsStartedAt !== undefined &&
		deps.bootstrapClientsDurationMs !== undefined
	) {
		logLatency({
			type: "phase",
			filePath: cwdForTelemetry,
			phase: "bootstrap_clients_load",
			startedAt: new Date(deps.bootstrapClientsStartedAt).toISOString(),
			durationMs: deps.bootstrapClientsDurationMs,
			metadata: {
				parent: "session_start_prehandler",
				reason: deps.sessionReason,
			},
		});
	}
	if (deps.sessionStartFiredAt !== undefined) {
		logLatency({
			type: "phase",
			filePath: cwdForTelemetry,
			phase: "session_start_prehandler",
			startedAt: new Date(deps.sessionStartFiredAt).toISOString(),
			durationMs:
				(deps.handlerEnteredAt ?? handlerEnteredAt) - deps.sessionStartFiredAt,
			metadata: { reason: deps.sessionReason },
		});
	}
	// Cold-start input-latency mitigation. The first `session_start` of
	// the process — i.e. the one that fires immediately after the user
	// launches `pi` — must return as fast as possible so the TUI input
	// box becomes responsive. The full startup mode runs several
	// expensive synchronous walks (resolveStartupScanContext,
	// detectProjectLanguageProfile, scanProjectRules, scheduleStartupScans)
	// that together can block the event loop for 3-6s on a 2k-file
	// project, during which keystrokes are dropped or batched.
	//
	// Strategy:
	//   - Force the very first invocation to "quick" mode, which exits
	//     after a minimal runtime reset and snapshot hydration.
	//   - 2 seconds later, schedule a background warmup that walks the
	//     project asynchronously (yielding every 100 entries) and
	//     populates the in-process memo caches
	//     (startupScanContextCache + languageProfileCache).
	//   - The user's first /new (or any subsequent session_start) sees
	//     a cache hit on both walks and finishes the full path in <50ms.
	//
	// Opt-out: PI_LENS_COLD_START_QUICK=0 disables this behaviour.
	// Override: PI_LENS_STARTUP_MODE explicitly set wins (we honour it).
	//   deps.startupModeOverride lets a host (e.g. the MCP server, which has
	//   no TUI keystroke latency to protect) skip the quick-mode heuristic
	//   entirely — but only when PI_LENS_STARTUP_MODE is unset in the env
	//   (an explicit env var still takes highest precedence).
	// Tunable: PI_LENS_WARMUP_DELAY_MS adjusts the warmup delay.
	let startupMode = resolveStartupMode();
	// SAFETY: these two flags are process-lifetime state pi-lens stashes on
	// `globalThis` so a second extension instance in the same process sees the
	// first one's warmup. There is no ambient declaration for them, and adding
	// one would let any module write them. Both are declared OPTIONAL here, so
	// the reads below are `undefined`-safe on a process where nothing set them.
	const processGlobals = globalThis as unknown as {
		__piLensFirstSessionDone?: boolean;
		__piLensWarmupScheduled?: boolean;
	};
	const isFirstSessionOfProcess = !processGlobals.__piLensFirstSessionDone;
	if (
		isFirstSessionOfProcess &&
		process.env.PI_LENS_COLD_START_QUICK !== "0" &&
		!process.env.PI_LENS_STARTUP_MODE
	) {
		// Apply host-provided override (e.g. MCP server forces "full") before
		// falling back to the TUI quick-mode heuristic.
		startupMode = deps.startupModeOverride ?? "quick";
	}
	processGlobals.__piLensFirstSessionDone = true;

	// #1785 F5 (round 4, design (a)): the warmup timer body below ALREADY
	// loads the on-disk snapshot for its own purposes (`cachedSnapshot`,
	// reused for the `startupScan` verdict cache) strictly BEFORE any save it
	// might go on to make. This LOCAL variable — per-`handleSessionStart`-call,
	// deliberately NOT module-scope (see #1785 F6) — lets the warmup publish
	// that already-loaded read (narrowed to exports+rules, never the full
	// object with `wordIndex`) for `retroactivelyHydrateAfterDeferredSequence`
	// to reuse at zero additional cost, instead of this call paying for its
	// own separate synchronous capture (rounds 1-3's approach, reverted here:
	// see that function's doc comment for the full history). `undefined`
	// means the warmup hasn't reached its own read yet (or was never armed by
	// this call at all) — the quick-mode block's retroactive-hydration
	// callback then falls back to a live re-load instead.
	let warmupOwnSnapshotRead: ProjectSnapshotExportsAndRules | null | undefined;

	// #1154: quick mode is entered on BOTH `pi -p`/`--print` (a one-shot that
	// exits right after this turn) and an interactive process's first
	// session_start (forced quick to protect keystroke latency, then warms
	// caches for the NEXT /new). The warmup only benefits a *future* session in
	// the same process — a one-shot print invocation has none. Worse, in a
	// one-shot the warmup is a referenced-handle keep-alive: the +2s timer and
	// the LSP-prewarm children / language-profile source walk it launches
	// outlive settle with no session_shutdown teardown, holding the process
	// open (the #1097/#1110/#1122-hyp-A class). So skip warmup entirely in
	// print mode; interactive first-sessions (not print) still warm.
	if (
		startupMode === "quick" &&
		!isPrintMode() &&
		process.env.PI_LENS_COLD_START_QUICK !== "0" &&
		!processGlobals.__piLensWarmupScheduled
	) {
		processGlobals.__piLensWarmupScheduled = true;
		const warmupDelayMs = Number(process.env.PI_LENS_WARMUP_DELAY_MS ?? 2000);
		const warmupCwd = deps.ctxCwd ?? process.cwd();
		const warmupDbg = deps.dbg;
		// #1154: `.unref()` the warmup timer so — even for a warmup that IS
		// scheduled (an interactive first-session) — the pending timer alone can
		// never hold the loop open. Interactive processes stay alive for other
		// reasons, so the warmup still fires; a one-shot never reaches here (the
		// isPrintMode gate above), and repo convention is that every background
		// timer is unref'd (this file previously had none).
		const warmupTimer = setTimeout(() => {
			const warmupStartedAt = Date.now();
			void (async () => {
				try {
					warmupDbg("warmup: starting background warmup");
					const scanContextStartedAt = Date.now();
					// Dynamic imports keep the warmup pipeline off the hot
					// startup path — these modules don't load until the timer
					// fires, well after the TUI is interactive.
					const startupScanModule = await import("./startup-scan.js");
					const languageProfileModule = await import("./language-profile.js");
					const warmupSnapshotRoot = resolveSnapshotRoot(warmupCwd);

					// #699: this background timer is the ONLY place a quick-mode
					// session (i.e. every `-p`/`--print` invocation, which forces
					// quick mode and returns before line ~1253 without ever touching
					// scan-context) computes scan-context — and that process exits
					// right after, discarding the result. Before walking, check for a
					// still-fresh persisted verdict (mirrors the interactive path's
					// snapshot reuse); after walking, persist unconditionally
					// (canWarmCaches true OR false) so the NEXT one-shot process can
					// reuse it instead of re-walking a possibly huge tree from
					// scratch on every single startup.
					const cachedSnapshot = loadProjectSnapshot(warmupSnapshotRoot);
					// #1785 F5 (round 4): publish this ALREADY-loaded read — narrowed
					// to exports+rules, never a reference to `cachedSnapshot` itself
					// (which carries `wordIndex`/`files`/`symbols`/`reverseDeps`) — for
					// `retroactivelyHydrateAfterDeferredSequence` to reuse. This read
					// strictly precedes the warmup's own possible save a few lines
					// below, so it is guaranteed to reflect disk as it stood before
					// THIS warmup could have touched it. Zero marginal cost: this read
					// already happens unconditionally for the `startupScan` verdict
					// cache below, with or without this fix.
					warmupOwnSnapshotRead = cachedSnapshot
						? {
								version: cachedSnapshot.version,
								seq: cachedSnapshot.seq,
								cachedExports: cachedSnapshot.cachedExports,
								projectRulesScan: cachedSnapshot.projectRulesScan,
							}
						: null;
					const cachedVerdict = cachedSnapshot?.startupScan;
					let scan: StartupScanContext;
					if (
						cachedVerdict &&
						startupScanModule.isStartupScanVerdictFresh(cachedVerdict)
					) {
						scan = { ...cachedVerdict, cwd: path.resolve(warmupCwd) };
						warmupDbg(
							`warmup: scan-context reused from cache (canWarm=${scan.canWarmCaches}${scan.reason ? `, reason=${scan.reason}` : ""})`,
						);
					} else {
						scan =
							await startupScanModule.resolveStartupScanContextAsync(warmupCwd);
						logLatency({
							type: "phase",
							phase: "session_start_scan_context_compute",
							filePath: warmupCwd,
							startedAt: new Date(scanContextStartedAt).toISOString(),
							durationMs: Date.now() - scanContextStartedAt,
							metadata: { mode: "quick-background" },
						});
						warmupDbg(
							`warmup: scan-context done in ${Date.now() - warmupStartedAt}ms (canWarm=${scan.canWarmCaches})`,
						);
						// Best-effort: a save failure must never affect warmup itself —
						// saveRuntimeProjectSnapshot already swallows its own errors.
						saveRuntimeProjectSnapshot({
							cwd: warmupSnapshotRoot,
							runtime: deps.runtime,
							startupScan: scan,
							dbg: warmupDbg,
						});
					}
					logLatency({
						type: "phase",
						phase: "warmup_scan_context",
						filePath: warmupCwd,
						startedAt: new Date(scanContextStartedAt).toISOString(),
						durationMs: Date.now() - scanContextStartedAt,
					});
					// Respect the startup-scan guard (#250): canWarmCaches is false for
					// home-dir / no-project-root / too-many-source-files. Proceeding into
					// the language-profile source walk in those cases lets it root at an
					// ancestor (e.g. a marker in $HOME when pi runs in ~/tmp) and traverse
					// the entire home tree — multi-hour scans. Nothing to warm anyway when
					// the guard says caches can't be warmed.
					if (!scan.canWarmCaches) {
						warmupDbg(
							`warmup: skipping language-profile (canWarm=false, reason=${scan.reason ?? "unknown"})`,
						);
						return;
					}
					const languageRoot = scan.projectRoot ?? warmupCwd;
					const languageProfileStartedAt = Date.now();
					await languageProfileModule.detectProjectLanguageProfileAsync(
						languageRoot,
					);
					warmupDbg(
						`warmup: language-profile done in ${Date.now() - languageProfileStartedAt}ms`,
					);
					logLatency({
						type: "phase",
						phase: "warmup_language_profile",
						filePath: warmupCwd,
						startedAt: new Date(languageProfileStartedAt).toISOString(),
						durationMs: Date.now() - languageProfileStartedAt,
					});
					// #348: fold the word-index build/refresh into this existing
					// cold-start warmup pass so quick-mode (and any session whose very
					// first session_start is forced quick) still ends up with a
					// queryable index — full-mode sessions get it via the "word-index"
					// runTask above; this is the quick-mode equivalent, once per
					// process, off the hot path.
					const wordIndexStartedAt = Date.now();
					const wordIndexResult = await buildOrRefreshWordIndex({
						runtime: deps.runtime,
						sessionGeneration: deps.runtime.sessionGeneration,
						analysisRoot: languageRoot,
						snapshotRoot: warmupSnapshotRoot,
						dbg: warmupDbg,
					});
					warmupDbg(
						`warmup: word-index done in ${Date.now() - wordIndexStartedAt}ms`,
					);
					logLatency({
						type: "phase",
						phase: "warmup_word_index",
						filePath: warmupCwd,
						startedAt: new Date(wordIndexStartedAt).toISOString(),
						durationMs: Date.now() - wordIndexStartedAt,
						metadata: wordIndexResult ? { ...wordIndexResult } : undefined,
					});
					// #947: fold the dominant-language LSP pre-warm into this
					// warmup pass. The first-session-of-process heuristic forces
					// quick mode, and the pre-warm below is gated on
					// allowBootstrapTasks (full mode only) — so it NEVER ran in
					// practice and every session's first edit paid a cold LSP
					// spawn (~750ms wait + ~2.5s spawn, measured). Fire it here
					// instead: off the interactive path, once per process (the
					// __piLensWarmupScheduled guard above), generation-guarded
					// inside igniteDominantLanguageWarm, and honoring the same
					// skips as the full-mode path — subagent light mode (#449),
					// warm-attach (#822), the no-lsp flag, and the
					// canWarmCaches guard (the early return above). Concurrent
					// secondaries never reach handleSessionStart at all (the
					// #473 guard in index.ts), so they never schedule this
					// warmup in the first place.
					const lspPrewarmStartedAt = Date.now();
					if (deps.getFlag("no-lsp")) {
						warmupDbg("warmup: skipping LSP pre-warm (no-lsp)");
					} else if (isSubagentSession()) {
						warmupDbg("warmup: skipping LSP pre-warm (subagent session)");
					} else if (isWarmAttached()) {
						warmupDbg("warmup: skipping LSP pre-warm (attached to incumbent)");
					} else {
						// #957 review: honor explicit warmFiles (#203) like the full
						// path does — configured projects warm exactly what they
						// asked for; dominant-language warm is the fallback.
						const lspConfig = await loadLSPConfig(warmupCwd).catch(() => ({
							warmFiles: [] as string[],
						}));
						const warmFiles = lspConfig.warmFiles ?? [];
						if (warmFiles.length > 0) {
							await igniteWarmFiles(
								warmupCwd,
								warmFiles,
								deps.runtime,
								deps.runtime.sessionGeneration,
								warmupDbg,
							);
						} else {
							await igniteDominantLanguageWarm(
								languageRoot,
								deps.runtime,
								deps.runtime.sessionGeneration,
								warmupDbg,
							);
						}
						logLatency({
							type: "phase",
							phase: "warmup_lsp_prewarm",
							filePath: warmupCwd,
							startedAt: new Date(lspPrewarmStartedAt).toISOString(),
							durationMs: Date.now() - lspPrewarmStartedAt,
						});
						warmupDbg(
							`warmup: lsp-prewarm done in ${Date.now() - lspPrewarmStartedAt}ms`,
						);
					}
					warmupDbg(`warmup: total ${Date.now() - warmupStartedAt}ms`);
				} catch (err) {
					warmupDbg(`warmup: error ${err}`);
					// Allow a future session to retry the warmup.
					processGlobals.__piLensWarmupScheduled = false;
				} finally {
					logLatency({
						type: "phase",
						phase: "warmup_total",
						filePath: warmupCwd,
						startedAt: new Date(warmupStartedAt).toISOString(),
						durationMs: Date.now() - warmupStartedAt,
					});
				}
			})();
		}, warmupDelayMs);
		warmupTimer.unref?.();
	}

	const allowBootstrapTasks = startupMode === "full";
	const quickMode = startupMode === "quick";
	const {
		ctxCwd,
		getFlag,
		notify,
		dbg,
		log,
		runtime,
		metricsClient,
		knipClient,
		cacheManager,
		testRunnerClient,
		goClient,
		rustClient,
		ensureTool,
		cleanStaleTsBuildInfo,
		resetDispatchBaselines,
		resetLSPService,
	} = deps;

	// Lightweight phase timer — resets after each call so each log line shows
	// the cost of that phase alone, not cumulative time from session start.
	let _phaseT = Date.now();
	const phase = (name: string): void => {
		dbg(`session_start phase ${name}: ${Date.now() - _phaseT}ms`);
		_phaseT = Date.now();
	};

	metricsClient.reset();
	getDiagnosticTracker().reset();
	clearFileTimeSessions();
	runtime.complexityBaselines.clear();
	resetDispatchBaselines(ctxCwd);
	// #806: clear the shared per-directory marker index and registered
	// topology-derived caches only at session start. Mid-session edits are NOT
	// detected; #805's tsconfig matcher cache follows the same registry reset.
	resetWorkspaceTopology();
	// #2000: opaque-recovery baselines are keyed cwd:generation (unreachable
	// after reset) and the git-worktree memo must re-probe after a session
	// that may have seen a non-git dir become one.
	resetOpaqueMutationState();
	// #2026: pending auxiliary baselines are unreachable after generation bump.
	resetPendingAuxiliaryCoverage();
	// #817/#1199: Windows command resolution is cached per (command, canonical
	// effective child PATH/PATHEXT/cwd/per-drive provenance); drop it each
	// session so environment changes (e.g.
	// a tool installed mid-session or a differently-scoped managed bin) are
	// picked up fresh.
	resetSafeSpawnWindowsCommandCache();
	// #1266: install-failure suppression in dispatch runner availability
	// checkers (`noteInstallFailure`) is meant to last only until "the next
	// session", per #1222 — but nothing called the reset helper, so a
	// transient install failure (npm registry blip, locked file) suppressed
	// the tool for the rest of the process lifetime. Clear it here, same
	// boundary as the other per-session caches on this line.
	resetDispatchAvailabilityState();
	// Runner collect-later observations and their late findings are session
	// scoped. A new session must re-probe rather than inherit a process latch.
	resetObservedRunnerLatency();
	resetPendingRunnerFindings();
	// #1995: a command that TIMED OUT (not merely failed a probe) cools down
	// for the rest of the session so a hot loop of edits cannot hand the same
	// wedged .cmd shim a second budget. A new session may retry: the executable
	// or its environment may have changed.
	resetSpawnTimeoutCooldowns();
	// #1895: formatter PATH verdicts are session-scoped, but they live in
	// formatters.ts and are not covered by the dispatch generation. Re-arm them
	// here so a formatter installed or removed between sessions is observed by
	// the next session. `clearFormatterCache` drops the per-cwd selection cache
	// as well as the which latches, which is what a real re-probe needs: the
	// selection cache answers a same-cwd lookup before any probe runs, so
	// clearing the latches alone would leave the stale verdict standing in the
	// one directory the user is working in.
	clearFormatterCache();
	// #1535: same #1266 pattern, one caller earlier — the `gh auth token` latch
	// zizmor's spawn reads is process-lived storage whose durability contract is
	// per SESSION, not per process. Without this, a user who runs `gh auth
	// login` and starts a fresh session still reads the previous session's
	// stale "no token" verdict until the cooldown (if any) happens to expire.
	resetZizmorTokenAvailability();
	// psscriptanalyzer's three latches (interpreter, module, -File exec) are
	// module-local, so the generation counter above does not reach them
	// (#1490, #1540).
	resetPsScriptAnalyzerAvailability();
	// #1497: the install-class retry ceiling is terminal for a SESSION, but the
	// latches holding it live on process-lived client instances (bootstrap builds
	// them once). Same #1266/#1490/#1535 shape — without this line "terminal for
	// the session" is terminal for the process, and a repaired network never
	// re-earns its `go install`.
	resetInstallRetryLatches();
	// #1537: the lazy-install seam's hold (`gem install rubocop`, `rustup
	// component add`) is durable for a SESSION. Its map is module-local, so the
	// generation counter above does not reach it — same #1490/#1497 shape. It
	// belongs on THIS line and not on the turn_end path: the first cut cleared it
	// from `clearFormatterRuntimeState()`, which runs every turn, so a failing
	// install re-spawned every turn instead of once per session.
	resetLazyInstallAttempts();
	// #1897: direct-LSP negative availability and bare installer paths are
	// session facts. A command or PATH entry can appear between sessions.
	resetDirectLspCommandAvailability();
	// #2052: a root may not exist when the case-sensitivity probe first sees it.
	// Re-probe it at the next session boundary after the workspace is created.
	resetLSPCaseSensitivityState();
	resetResolvedPathCache();
	// #1653: pnpm/yarn/bun/npm's availability latches (package-manager.ts) are
	// module-local, same #1490/#1535 shape as the two lines above — the
	// generation counter above does not reach them. Without this line, a
	// pnpm/yarn/bun install done mid-day stayed invisible: a genuine "missing"
	// verdict from one session latched into the next until a process restart.
	_resetPackageManagerCache();
	// #1730: the managed-tool refresh budget is a per-SESSION allowance (at most
	// one `npm update` per session). Left process-lived, one long-running pi
	// would refresh a single tool at launch and never look at the other 21
	// again — the same latch shape as the two lines above. The weekly cadence
	// itself is NOT reset here: it lives in the persisted per-tool stamp, so
	// re-arming the budget only restores the session's right to ask.
	resetManagedToolRefreshSession();
	// #1123 item 3: a fresh session can re-report smells that a prior session
	// already surfaced once (see `checkSmellsAndNoteOnce`'s once-per-session gate).
	resetSmellsSessionState();
	// #1782: re-arm the workspace-diagnostics cache session clock. Entries
	// written before this instant assert findings from a session that is over,
	// so they must revalidate before they can be served as current again.
	resetWorkspaceDiagnosticsCacheSession(sessionStartMs);
	// Some embedders inject a capability-shaped Knip client rather than the
	// concrete KnipClient. Session reset is an optional lifecycle capability;
	// its absence must not make session_start fail.
	knipClient.resetSessionState?.();
	// #1910: the tier-3 cascade outstanding-touch registry and its
	// sweep-scoped expired/evicted counters (clients/lsp/cascade-tier.ts) are
	// a per-SESSION claim about touches THIS session fired. #1899 bounded the
	// registry between sweeps but, by its own review, left the session
	// boundary unwired — a session replacement inherited the prior session's
	// outstanding touches and misattributed a stray expiry/eviction to the
	// next session's first reconcile gauge.
	resetCascadeTierSessionState();
	runtime.resetForSession(sessionStartMs);
	logLatency({
		type: "phase",
		phase: "session_start_runtime_reset",
		filePath: ctxCwd ?? process.cwd(),
		startedAt: new Date(handlerEnteredAt).toISOString(),
		durationMs: Date.now() - handlerEnteredAt,
		metadata: { mode: startupMode, reason: deps.sessionReason },
	});

	// #1019: log cleanup is deferred OFF the interactive critical path. It does
	// synchronous fs sweeps (~7ms) whose only consumer is an async notification —
	// nothing on the hot path reads its result — so running it inline just taxed
	// every session start. It still runs every session (correctness unchanged),
	// now on the next tick, and notifies when done. Errors are swallowed to a
	// dbg line: a best-effort log sweep must never surface as a session failure.
	const cleanupCwd = ctxCwd ?? process.cwd();
	setImmediate(() => {
		const logCleanupStartedAt = Date.now();
		try {
			const logCleanup = runLogCleanup(dbg);
			logLatency({
				type: "phase",
				phase: "session_start_log_cleanup",
				filePath: cleanupCwd,
				startedAt: new Date(logCleanupStartedAt).toISOString(),
				durationMs: Date.now() - logCleanupStartedAt,
				metadata: {
					mode: startupMode,
					reason: deps.sessionReason,
					deferred: true,
				},
			});
			if (logCleanup.cleaned > 0 || logCleanup.rotated > 0) {
				notify(`🧹 ${logCleanup.report}`, "info");
			}
		} catch (err) {
			dbg(`session_start: deferred log cleanup failed: ${err}`);
		}
	});
	dbg(`session_start startup mode: ${startupMode}`);

	if (!getFlag("no-lsp")) {
		resetLSPService({ fast: true, reason: "session_start" });
		dbg("session_start: LSP service reset");
		dbg(
			"session_start: phase0 workspace diagnostics observation enabled (capability probe only)",
		);
	}

	const hasWorkspaceCwd = typeof ctxCwd === "string" && ctxCwd.length > 0;
	const cwd = ctxCwd ?? process.cwd();
	// #1228: generic atomic-write stages are shared by several project stores,
	// so the review-graph-specific sweep cannot own this namespace. Sweep the
	// project data roots and machine-global registry root once per session start;
	// this is fire-and-forget and bounded so it never delays startup.
	const projectDataDir = getProjectDataDir(cwd);
	// #1609 review F1: sweepOwnStagingFiles does not recurse, so the installer's
	// bin/ and tools/ subdirectories (clients/installer/index.ts's
	// GITHUB_BIN_DIR / TOOLS_DIR, now atomic-write.js writers too) need their
	// own entries — otherwise an orphaned staging file from a kill mid-install
	// (this PR's own motivating scenario) never gets reaped, and unique
	// pid-thread-seq staging names mean repeated kills ACCUMULATE full-size
	// orphan binaries instead of being cleaned up.
	const globalDir = getGlobalPiLensDir();
	void sweepAtomicWriteStages([
		projectDataDir,
		path.join(projectDataDir, "cache"),
		path.join(projectDataDir, "sessions"),
		globalDir,
		path.join(globalDir, "bin"),
		path.join(globalDir, "tools"),
	]).catch(() => {
		// best-effort lifecycle cleanup — never fail session_start
	});
	if (quickMode) {
		runtime.projectRoot = cwd;
		const sequenceReadStartedAt = Date.now();
		const snapshotRoot = resolveSnapshotRoot(cwd);
		// #1785 F5 (round 4): the getter closes over `warmupOwnSnapshotRead`
		// directly (a `let` in this same `handleSessionStart` invocation's
		// scope), so it reads whatever value is current AT DEFERRED-RESOLVE
		// TIME — not whatever it was at this wiring instant. See
		// `retroactivelyHydrateAfterDeferredSequence`'s doc comment for the
		// full design.
		const { latestSeq, timedOut } = await readSequenceWithBudget({
			snapshotRoot,
			base: snapshotSequenceBase(snapshotRoot),
			cwd,
			runtime,
			sessionGeneration: runtime.sessionGeneration,
			dbg,
			onDeferredSequenceResolved: retroactivelyHydrateAfterDeferredSequence({
				getWarmupOwnSnapshotRead: () => warmupOwnSnapshotRead,
				snapshotRoot,
				runtime,
				dbg,
			}),
		});
		logLatency({
			type: "phase",
			phase: "session_start_sequence_read",
			filePath: cwd,
			startedAt: new Date(sequenceReadStartedAt).toISOString(),
			durationMs: Date.now() - sequenceReadStartedAt,
			metadata: { entries: latestSeq.fileSeqByPath.size, timedOut },
		});
		if (timedOut) {
			recordSnapshotSequenceTimeout({
				snapshotRoot,
				snapshotPath: getProjectSnapshotPath(snapshotRoot),
			});
		}
		runtime.seedProjectSequence?.(
			latestSeq.projectSeq,
			latestSeq.fileSeqByPath,
		);
		const effectiveSeq = runtime.projectSeq ?? latestSeq.projectSeq;
		dbg(
			`session_start sequence: projectSeq=${effectiveSeq} fileSeqEntries=${latestSeq.fileSeqByPath.size}`,
		);
		// #1162 review follow-up (P3): a timed-out read's cold sentinel is
		// `projectSeq: 0`, which is indistinguishable from a project's real
		// first-ever snapshot (persisted with `seq === 0` before any change was
		// logged). Feeding `effectiveSeq` (0) straight into the freshness check
		// would let that legit seq-0 snapshot match and hydrate as FRESH even
		// though the on-disk log has since moved past it. Use a value the
		// freshness check can never match (`snapshot.seq` is always >= 0) ONLY
		// for this gate when the read timed out — `runtime.projectSeq` itself
		// stays 0 (untouched), which is what Fix 1's advancement guard above
		// relies on to detect an in-window bump.
		const freshnessSeq = timedOut ? UNKNOWN_PROJECT_SEQ : effectiveSeq;
		const snapshotLoadStartedAt = Date.now();
		const snapshotPath = getProjectSnapshotPath(snapshotRoot);
		let snapshotBytes = 0;
		try {
			snapshotBytes = nodeFs.statSync(snapshotPath).size;
		} catch {
			// Missing snapshots are the normal cold-start case.
		}
		const snapshotBodyPresent =
			nodeFs.existsSync(snapshotPath) ||
			nodeFs.existsSync(getProjectSnapshotLegacyPath(snapshotRoot));
		const snapshotGate = loadSnapshotBodyUnlessStale({
			root: snapshotRoot,
			currentProjectSeq: freshnessSeq,
			dbg,
		});
		const snapshot = snapshotGate.snapshot;
		const snapshotFresh = isProjectSnapshotFresh(snapshot, freshnessSeq);
		const snapshotMissReason = describeSnapshotMiss(snapshot, freshnessSeq, {
			skippedStale: snapshotGate.skippedStale,
			bodyPresent: snapshotBodyPresent,
		});
		logLatency({
			type: "phase",
			phase: "session_start_snapshot_load",
			filePath: cwd,
			startedAt: new Date(snapshotLoadStartedAt).toISOString(),
			durationMs: Date.now() - snapshotLoadStartedAt,
			metadata: {
				bytes: snapshotBytes,
				fresh: snapshotFresh,
				seq: snapshot?.seq ?? null,
				reason: snapshotFresh ? undefined : snapshotMissReason,
				...(snapshotGate.skippedStale ? { skippedStale: true } : {}),
				...(timedOut ? { sequenceUnknown: true } : {}),
			},
		});
		logProjectSnapshotProbe({
			dbg,
			root: snapshotRoot,
			currentProjectSeq: freshnessSeq,
			snapshot,
			missReason: snapshotMissReason,
		});
		if (snapshotFresh) {
			hydrateRuntimeFromProjectSnapshot(runtime, snapshot);
		}
		const quickTools: string[] = [];
		if (!getFlag("no-lsp")) {
			quickTools.push("LSP Service");
		}
		log(`Active tools: ${quickTools.join(", ")}`);
		dbg(
			`session_start tools: ${quickTools.join(", ") || "deferred (quick mode)"}`,
		);
		dbg(
			"session_start: quick mode active - skipping slow tool probes, language profiling, preinstall, scans, and error debt baseline",
		);
		// #1911: the debug line above says WHICH steps were skipped, but nothing
		// bounded or structured said so — quick mode's absence of work and an
		// absent LOGGER read identically in latency.log. This record is that
		// line's structured twin: one bounded gauge per quick-mode session_start,
		// naming exactly the step set skipped, so a reader can tell "quick mode
		// correctly skipped these" from "the probes silently never ran".
		logLatency({
			type: "phase",
			phase: "session_start_skipped_steps",
			filePath: cwd,
			durationMs: 0,
			metadata: {
				mode: startupMode,
				reason: deps.sessionReason,
				// #1911 review F3: this `if (quickMode)` branch is an early return —
				// the whole quick path — so there is no enumerable list of "steps
				// run vs. skipped" this array could be derived from mechanically. It
				// is DESCRIPTIVE documentation of what the early return skips,
				// matching the `dbg()` line above word for word; keep both in sync by
				// hand if either changes. It also does NOT narrow under
				// `getFlag("no-lsp")` — quick mode skips the same five steps either
				// way; the LSP flag instead affects `quickTools` above, a separate
				// record.
				steps: [
					"slow_tool_probes",
					"language_profiling",
					"tool_preinstall",
					"startup_scans",
					"error_debt_baseline",
				],
			},
		});
		const totalDurationMs = Date.now() - sessionStartMs;
		dbg(`session_start total: ${totalDurationMs}ms (interactive path)`);
		logLatency({
			type: "phase",
			phase: "session_start_total",
			filePath: cwd,
			startedAt: new Date(sessionStartMs).toISOString(),
			durationMs: totalDurationMs,
			metadata: {
				mode: startupMode,
				reason: deps.sessionReason,
				// #2129: the root-identity input decideSessionStart consulted,
				// alongside `mode` — every start reaching this line already
				// classified `primary`/`sequential-replacement` (a `secondary-root`
				// start returns before `handleSessionStart` is ever called).
				classification: deps.sessionStartClassification,
				// `undefined` is omitted by JSON.stringify. Keep unknown explicit so
				// strict log readers can distinguish it from legacy omission.
				sameRoot: deps.sessionStartSameRoot ?? "unknown",
			},
		});
		logHostReadyDelay(deps, cwd);
		emitSmellsSessionStartLine(dbg, sessionStartMs);
		return;
	}

	const tools: string[] = [];
	if (!getFlag("no-lsp")) tools.push("LSP Service");

	if (allowBootstrapTasks && !getFlag("no-lsp")) {
		const cleaned = cleanStaleTsBuildInfo(ctxCwd ?? process.cwd());
		if (cleaned.length > 0) {
			notify(
				`🧹 Deleted stale TypeScript build cache (${cleaned.map((f) => path.basename(f)).join(", ")}) — phantom errors suppressed.`,
				"warning",
			);
			dbg(`session_start: cleaned stale tsbuildinfo: ${cleaned.join(", ")}`);
		}
	}

	// Captured here (not at first use, below) because #1162's bounded read
	// needs it to gate the deferred reseed against a stale/moved-on session —
	// it's stable for the rest of this call (no further `resetForSession`
	// between here and the later uses of the same generation).
	const sessionGeneration = runtime.sessionGeneration;
	const sequenceReadStartedAt = Date.now();
	const snapshotRoot = resolveSnapshotRoot(cwd);
	const { latestSeq, timedOut } = await readSequenceWithBudget({
		snapshotRoot,
		base: snapshotSequenceBase(snapshotRoot),
		cwd,
		runtime,
		sessionGeneration,
		dbg,
	});
	logLatency({
		type: "phase",
		phase: "session_start_sequence_read",
		filePath: cwd,
		startedAt: new Date(sequenceReadStartedAt).toISOString(),
		durationMs: Date.now() - sequenceReadStartedAt,
		metadata: { entries: latestSeq.fileSeqByPath.size, timedOut },
	});
	if (timedOut) {
		// #1785: instrumentation only here, deliberately no
		// `onDeferredSequenceResolved` — unlike quick mode's cold path (which
		// does nothing when the snapshot isn't trusted), full mode's cold path
		// actively kicks off a real rescan below to rebuild this same state.
		// Retroactively hydrating from the on-disk snapshot once the deferred
		// read lands could overwrite that fresher, actively-computed state with
		// the stale disk copy — a regression, not a fix. See the PR body for the
		// full reasoning.
		recordSnapshotSequenceTimeout({
			snapshotRoot,
			snapshotPath: getProjectSnapshotPath(snapshotRoot),
		});
	}
	runtime.seedProjectSequence?.(latestSeq.projectSeq, latestSeq.fileSeqByPath);
	const effectiveSeq = runtime.projectSeq ?? latestSeq.projectSeq;
	dbg(
		`session_start sequence: projectSeq=${effectiveSeq} fileSeqEntries=${latestSeq.fileSeqByPath.size}`,
	);
	// #1162 review follow-up (P3) — see the matching comment in the quick-mode
	// path above: a timed-out read's cold sentinel (`projectSeq: 0`) must
	// never satisfy the freshness check, or a project's real first-ever
	// snapshot (persisted at `seq === 0`) would hydrate as fresh despite the
	// on-disk log having moved past it. `runtime.projectSeq` itself is left
	// at 0, which Fix 1's advancement guard above depends on.
	const freshnessSeq = timedOut ? UNKNOWN_PROJECT_SEQ : effectiveSeq;

	const snapshotLoadStartedAt = Date.now();
	const snapshotPath = getProjectSnapshotPath(snapshotRoot);
	let snapshotBytes = 0;
	try {
		snapshotBytes = nodeFs.statSync(snapshotPath).size;
	} catch {
		// Missing snapshots are the normal cold-start case.
	}
	const snapshotBodyPresent =
		nodeFs.existsSync(snapshotPath) ||
		nodeFs.existsSync(getProjectSnapshotLegacyPath(snapshotRoot));
	const snapshotGate = loadSnapshotBodyUnlessStale({
		root: snapshotRoot,
		currentProjectSeq: freshnessSeq,
		dbg,
	});
	const snapshot = snapshotGate.snapshot;
	const snapshotFresh = isProjectSnapshotFresh(snapshot, freshnessSeq);
	const snapshotMissReason = describeSnapshotMiss(snapshot, freshnessSeq, {
		skippedStale: snapshotGate.skippedStale,
		bodyPresent: snapshotBodyPresent,
	});
	logLatency({
		type: "phase",
		phase: "session_start_snapshot_load",
		filePath: cwd,
		startedAt: new Date(snapshotLoadStartedAt).toISOString(),
		durationMs: Date.now() - snapshotLoadStartedAt,
		metadata: {
			bytes: snapshotBytes,
			fresh: snapshotFresh,
			seq: snapshot?.seq ?? null,
			reason: snapshotFresh ? undefined : snapshotMissReason,
			...(snapshotGate.skippedStale ? { skippedStale: true } : {}),
			...(timedOut ? { sequenceUnknown: true } : {}),
		},
	});
	logProjectSnapshotProbe({
		dbg,
		root: snapshotRoot,
		currentProjectSeq: freshnessSeq,
		snapshot,
		missReason: snapshotMissReason,
	});
	const freshSnapshot = snapshotFresh ? snapshot : null;
	if (freshSnapshot) {
		hydrateRuntimeFromProjectSnapshot(runtime, freshSnapshot);
	}

	// #699: a persisted `too-many-source-files` verdict is only reused while
	// still within its TTL (isStartupScanVerdictFresh) — the seq-based
	// freshness check above (isProjectSnapshotFresh) never fires for that
	// reason on its own, since pi-lens never wrote anything while
	// canWarmCaches was false, so the snapshot's seq never advances.
	const cachedStartupScan =
		freshSnapshot?.startupScan &&
		isStartupScanVerdictFresh(freshSnapshot.startupScan)
			? freshSnapshot.startupScan
			: undefined;
	const startupScanSource = cachedStartupScan ? "snapshot" : "computed";
	let startupScan: StartupScanContext;
	if (cachedStartupScan) {
		startupScan = { ...cachedStartupScan, cwd: path.resolve(cwd) };
	} else {
		const scanContextStartedAt = Date.now();
		startupScan = resolveStartupScanContext(cwd);
		logLatency({
			type: "phase",
			phase: "session_start_scan_context_compute",
			filePath: cwd,
			startedAt: new Date(scanContextStartedAt).toISOString(),
			durationMs: Date.now() - scanContextStartedAt,
			metadata: { mode: startupMode },
		});
	}
	phase("scan-context");
	dbg(`session_start scan-context source=${startupScanSource}`);
	const scanRoot = startupScan.projectRoot ?? cwd;
	// Both "tree is too big" verdicts still found a real project root — the
	// walk just refused to warm caches over it — so signals stay anchored at
	// that root rather than falling back to cwd (#758 added too-many-entries
	// as the sibling of too-many-source-files).
	const useScanRootForSignals =
		startupScan.canWarmCaches ||
		startupScan.reason === "too-many-source-files" ||
		startupScan.reason === "too-many-entries";
	const analysisRoot = useScanRootForSignals ? scanRoot : cwd;
	runtime.projectRoot = cwd;
	const languageProfileSource = freshSnapshot?.languageProfile
		? "snapshot"
		: "computed";
	const languageProfile = freshSnapshot?.languageProfile
		? freshSnapshot.languageProfile
		: detectProjectLanguageProfile(
				analysisRoot,
				startupScan.canWarmCaches ? undefined : [],
			);
	phase("language-profile");
	dbg(`session_start language-profile source=${languageProfileSource}`);
	dbg(`session_start cwd: ${cwd}`);
	dbg(
		`session_start scan root: ${scanRoot} (warmCaches=${startupScan.canWarmCaches}${startupScan.reason ? `, reason=${startupScan.reason}` : ""})`,
	);
	dbg(`session_start analysis root: ${analysisRoot}`);
	dbg(`session_start workspace root: ${runtime.projectRoot}`);
	dbg(
		`session_start language profile: ${languageProfile.detectedKinds.join(", ") || "none"}`,
	);
	dbg(
		`session_start language counts: ${JSON.stringify(languageProfile.counts)} configured=${JSON.stringify(languageProfile.configured)}`,
	);
	dbg(`session_start workspace cwd available: ${hasWorkspaceCwd}`);
	if (useScanRootForSignals && analysisRoot !== cwd) {
		dbg(`session_start: monorepo analysis root override -> ${analysisRoot}`);
	}

	// Slow-FS probe (#462): classify the workspace filesystem by measurement
	// (median fs.statSync cost) before any tree walk runs. WSL 9p mounts cost
	// ~1.3ms/stat vs ~17µs native — a 75x slowdown that turns a 5,000-file sync
	// walk into a multi-second TUI freeze. Logged to the latency log so
	// dogfooding can see the verdict; a visible notice fires when engaged so a
	// degraded scan is never mistaken for a silently-empty one.
	const slowFsVerdict = getSlowFsVerdict(analysisRoot);
	logLatency({
		type: "phase",
		phase: "slow_fs_probe",
		filePath: analysisRoot,
		durationMs: 0,
		metadata: {
			slow: slowFsVerdict.slow,
			medianStatMicros: slowFsVerdict.medianStatMicros,
			samples: slowFsVerdict.samples,
		},
	});
	dbg(
		`session_start slow-fs probe: slow=${slowFsVerdict.slow} medianStatMicros=${slowFsVerdict.medianStatMicros.toFixed(1)} samples=${slowFsVerdict.samples}`,
	);
	if (slowFsVerdict.slow) {
		notify(
			`🐢 Slow filesystem detected (median ${slowFsVerdict.medianStatMicros.toFixed(0)}µs/stat) — reduced-scan mode engaged (set PI_LENS_ALLOW_SLOW_FS_SCAN=1 to override).`,
			"warning",
		);
	}

	// Subagent light mode (#449 slice 0): detected once per session, alongside
	// the slow-FS probe above. Logged to the latency log so dogfooding can see
	// how often subagent fan-outs engage it and what identity they carry.
	const subagentSession = isSubagentSession();
	if (isWarmAttached()) {
		dbg("session_start lsp-warm: skipping pre-warm (attached to incumbent)");
	} else if (subagentSession) {
		const identity = getSubagentIdentity();
		logLatency({
			type: "phase",
			phase: "subagent_light_mode",
			filePath: analysisRoot,
			durationMs: 0,
			metadata: {
				runId: identity?.runId,
				agentName: identity?.agentName,
				marker: identity?.marker,
			},
		});
		dbg(
			`session_start subagent light mode: engaged (marker=${identity?.marker ?? "unknown"} runId=${identity?.runId ?? "unknown"} agentName=${identity?.agentName ?? "unknown"})`,
		);
	}

	const lensLspEnabled = !getFlag("no-lsp");
	const startupDefaults = getDefaultStartupTools(languageProfile).filter(
		(tool) => {
			if (
				(tool === "typescript-language-server" || tool === "pyright") &&
				!lensLspEnabled
			) {
				return false;
			}
			return true;
		},
	);

	if (!allowBootstrapTasks) {
		dbg("session_start: skipping tool preinstall (startup mode)");
	} else if (startupDefaults.length > 0) {
		dbg(`session_start: pre-install defaults -> ${startupDefaults.join(", ")}`);
		firePreinstallDefaults(ensureTool, dbg, startupDefaults);
	} else {
		dbg("session_start: no language defaults selected for pre-install");
	}

	const startupScansWillRun = allowBootstrapTasks && startupScan.canWarmCaches;
	const jstsHeavyScansWillRun =
		startupScansWillRun && canRunStartupHeavyScans(languageProfile, "jsts");
	if (allowBootstrapTasks) {
		scheduleDeferredToolProbes(
			deps,
			languageProfile,
			startupDefaults,
			jstsHeavyScansWillRun,
			dbg,
		);
		scheduleManagedToolRefresh(dbg);
	}

	if (allowBootstrapTasks) {
		// Fire-and-forget like other tool probes
		void probePrettierInstall(ensureTool, dbg, analysisRoot);
	} else {
		dbg("session_start: skipping prettier preinstall probe (startup mode)");
	}

	const detectedRunner = testRunnerClient.detectRunner(analysisRoot);
	phase("test-runner-detect");
	if (detectedRunner) tools.push(`Test runner (${detectedRunner.runner})`);
	if (await goClient.isGoAvailableAsync()) tools.push("Go (go vet)");
	if (await rustClient.isAvailableAsync()) tools.push("Rust (cargo)");
	log(`Active tools: ${tools.join(", ")}`);
	dbg(`session_start tools: ${tools.join(", ")}`);

	const agentStartupGuidance = SESSION_START_GUIDANCE;

	runtime.projectRulesScan = scanProjectRules(analysisRoot);
	saveRuntimeProjectSnapshot({
		cwd: snapshotRoot,
		runtime,
		startupScan,
		languageProfile,
		dbg,
	});
	phase("project-rules");
	if (runtime.projectRulesScan.hasCustomRules) {
		const ruleCount = runtime.projectRulesScan.rules.length;
		const sources = [
			...new Set(runtime.projectRulesScan.rules.map((r) => r.source)),
		];
		dbg(
			`session_start: found ${ruleCount} project rule(s) from ${sources.join(", ")}`,
		);
	} else {
		dbg("session_start: no project rules found");
	}

	cacheManager.writeCache(
		"session-start-guidance",
		{ content: agentStartupGuidance.join("\n") },
		analysisRoot,
	);

	// `sessionGeneration` was captured earlier (#1162's bounded sequence read
	// needs it before this point) and is stable across this whole call.
	if (!allowBootstrapTasks) {
		dbg("session_start: skipping startup background scans (startup mode)");
	} else if (!startupScan.canWarmCaches) {
		dbg(
			`session_start: skipping heavy scans (${startupScan.reason ?? "unknown"})`,
		);
		dbg(
			`session_start: skipping TODO scan (${startupScan.reason ?? "unknown"})`,
		);
		// #775: mirror the slow-fs notify above — a size-skipped warm pipeline is
		// otherwise silent (debug-log only), so a large project can look like
		// pi-lens just isn't scanning anything. Fires ONCE per session (this
		// `else` branch runs once per handleSessionStart call — the
		// dominant-language LSP pre-warm skip further down reuses this same
		// verdict rather than notifying a second time).
		if (
			startupScan.reason === "too-many-source-files" ||
			startupScan.reason === "too-many-entries"
		) {
			const overrideHint =
				startupScan.reason === "too-many-entries"
					? ` (set PI_LENS_STARTUP_SCAN_MAX_ENTRIES=<n> to override the ${getStartupScanMaxEntries()}-entry cap)`
					: "";
			notify(
				`📦 Project-size limits disabled background warm scans (heavy scans, TODO scan, LSP pre-warm)${overrideHint}.`,
				"warning",
			);
		}
	} else {
		scheduleStartupScans(
			deps,
			runtime,
			sessionGeneration,
			analysisRoot,
			snapshotRoot,
			languageProfile,
			dbg,
		);
	}

	// LSP warm files — deferred to the next event-loop turn so the config walk
	// (several ENOENT readFile calls up the directory tree) never runs on the
	// interactive path. setImmediate guarantees handleSessionStart has already
	// resolved before loadLSPConfig is even called.
	//
	// #449 slice 0: skip both the explicit warmFiles warm and the
	// dominant-language auto-warm inside a subagent session — a fan-out of N
	// subagents otherwise pays N full LSP pre-warms in the same cwd. Per-edit
	// LSP dispatch is untouched (see `pipeline.ts`), so a subagent that
	// actually edits code still gets diagnostics; it just spawns the server
	// lazily on first edit instead of eagerly at session start.
	if (subagentSession) {
		dbg("session_start lsp-warm: skipping pre-warm (subagent session)");
	} else if (!getFlag("no-lsp") && allowBootstrapTasks) {
		setImmediate(() => {
			void loadLSPConfig(cwd).then((lspConfig) => {
				const warmFiles = lspConfig.warmFiles ?? [];
				dbg(
					`session_start lsp-config: loaded (${warmFiles.length} warm file(s) configured)`,
				);
				if (warmFiles.length > 0) {
					igniteWarmFiles(
						cwd,
						warmFiles,
						runtime,
						sessionGeneration,
						dbg,
					).catch((err) =>
						dbg(`session_start lsp-warm: unhandled error: ${err}`),
					);
				} else if (startupScan.canWarmCaches) {
					// No explicit warmFiles — pre-spawn just the dominant language's
					// LSP so the first edit doesn't pay the cold-spawn stall (#203).
					// Only do the auto-discovery warm on guarded real project roots; on
					// home/no-project/too-large roots this source walk can become the same
					// delayed background tree scan that the startup-scan guard prevents.
					igniteDominantLanguageWarm(
						analysisRoot,
						runtime,
						sessionGeneration,
						dbg,
					).catch((err) =>
						dbg(`session_start lsp-warm: unhandled dominant error: ${err}`),
					);
				} else {
					dbg(
						`session_start lsp-warm: skipping dominant-language auto-warm (${startupScan.reason ?? "unknown"})`,
					);
				}
			});
		});
		phase("lsp-config");
	}

	setSessionLanguages(languageProfile.detectedKinds);

	const totalDurationMs = Date.now() - sessionStartMs;
	dbg(
		`session_start total: ${totalDurationMs}ms (interactive path; background tasks may continue)`,
	);
	logLatency({
		type: "phase",
		phase: "session_start_total",
		filePath: cwd,
		startedAt: new Date(sessionStartMs).toISOString(),
		durationMs: totalDurationMs,
		metadata: {
			mode: startupMode,
			reason: deps.sessionReason,
			// #2129: see the quick-mode session_start_total record above.
			classification: deps.sessionStartClassification,
			// Keep the full path's durable shape identical to quick mode.
			sameRoot: deps.sessionStartSameRoot ?? "unknown",
		},
	});
	logHostReadyDelay(deps, cwd);
	emitSmellsSessionStartLine(dbg, sessionStartMs);
}

/**
 * #1123 item 3: one bounded `session_start` line surfacing smells the manual
 * `npm run logs:smells` analyzer would otherwise only catch on demand — see
 * `clients/smells-rollup.ts` for the tail-scan cost bound and threshold
 * gating. Never throws: a rollup miss must not break session_start.
 */
function emitSmellsSessionStartLine(
	dbg: (msg: string) => void,
	sessionStartMs: number,
): void {
	try {
		const line = formatSmellsSessionStartLine(
			countRecentSmells(undefined, sessionStartMs),
		);
		if (line) dbg(line);
	} catch {
		// best-effort — smells rollup must never break session_start
	}
}
