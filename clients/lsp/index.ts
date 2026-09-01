/**
 * LSP Service Layer for pi-lens
 *
 * Manages multiple LSP clients per workspace with:
 * - Auto-spawning based on file type
 * - Effect-TS service composition
 * - Bus event integration
 * - Resource cleanup
 */

import { CASCADE_DIAGNOSTICS_TTL_MS } from "../cascade-types.js";
import * as nodeFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, URL } from "node:url";
import { getProjectIgnoreMatcher, isExcludedDirName } from "../file-utils.js";
import { recordLsp } from "../widget-state.js";
import { applyAuxiliarySuppressions } from "../dispatch/auxiliary-lsp.js";
import { detectFileRole } from "../file-role.js";
import { emitBounded } from "../bounded-telemetry.js";
import { logLatency, phaseFinished, phaseStarted } from "../latency-logger.js";
import { logSessionStart } from "../sessionstart-logger.js";
import {
	incrementDegradationCount,
	recordDegradation,
	recordDegradationOnce,
} from "../degradation-ledger.js";
import {
	isLspSpawnAllowedByTrust,
	assertInstallAllowed,
	projectTrustDenialReason,
} from "../project-trust.js";
import { shouldPreferPullOnlyDiagnostics } from "../lsp-budget.js";
import { sampleProcessTreeCpuPercent } from "../resource-sampler.js";
import { withDeadline, withTimeout } from "../deadline-utils.js";
import {
	acquireWorkspaceSweepHold,
	clearWorkspaceSweepHoldForSessionStart,
} from "./workspace-sweep-hold.js";
import {
	DocumentDriftTracker,
	fingerprintDocumentContent,
	type DriftSweepResult,
} from "./document-drift.js";
import {
	markPendingAuxiliaryCoverage,
	napiFallbackCoveredSince,
} from "./pending-aux-coverage.js";
import {
	isAtOrAboveHomeDir,
	isWindowsPath,
	normalizeMapKey,
	uriToPath,
} from "../path-utils.js";
import type {
	LSPClientInfo,
	LSPOperationSupport,
	LSPPullFailure,
	LSPShutdownOptions,
} from "./client.js";
import { recordLspMutation, type LspMutationContext } from "../lsp-mutation.js";
import { createLSPClient } from "./client.js";
import {
	auxiliaryCoverageGap,
	bindingStateLabel,
	composeBoundToCurrentDisk,
	createDiskBindingCache,
	hashDiagnosticContent,
	resolveTouchVerdict,
	touchCoverageGap,
	type BoundToCurrentDisk,
	type DiagnosticBinding,
	type DiskBindingCache,
	type StoredDiagnosticBinding,
	type TouchFileResult,
} from "./diagnostic-binding.js";
import {
	getServersForFileWithConfig,
	getServerInitOverride,
} from "./config.js";
// #2052: deliberately NOT taken from `config.js`. This module's import surface
// from `config.js` is mirrored by explicit `vi.mock` factories in ~58 test
// files, so every new symbol taken from there breaks all of them.
import {
	getSessionRootsForTelemetry,
	isOutsideAllSessionRoots,
} from "./session-roots.js";
import { getProcessSingleton } from "../process-singletons.js";
import { getLanguageId } from "./language.js";
import type { LSPServerInfo } from "./server.js";
import {
	LSP_SERVERS,
	enforceLspRootCeiling,
	hasProjectBoundaryMarker,
	isDirectLspCommandTemporarilyUnavailable,
	resetClassicTsRepairGuard,
	resetLspLaunchAvailabilityGeneration,
} from "./server.js";
import {
	classifyCascadeWaitTier,
	classifyServerWaitTier,
	getStrategy,
	type LSPCapabilitySnapshot,
} from "./wait-policy/index.js";
export type { LSPCapabilitySnapshot } from "./wait-policy/index.js";

const WORKSPACE_ATTRIBUTION_CLIENT_CAP = 16;

/**
 * Request-local attribution for no-filePath workspace queries. The fixed site
 * and capability keys plus the capped client list keep the caller's existing
 * latency record bounded. Callers create one collector per request; the
 * service never stores shared "last client" state that concurrent calls could
 * overwrite.
 */
export interface LSPWorkspaceScopeAttribution {
	workspaceSymbol?: string;
	getAdvertisedCommands?: string;
	executeCommand?: string;
	getOperationSupport?: {
		baseClientId: string;
		contributors: Partial<Record<keyof LSPOperationSupport, string>>;
	};
	getCapabilitySnapshots?: { clientIds: string[]; clientCount: number };
	getWorkspaceDiagnosticsSupport?: string;
}
import { raceToCompletion, type PromiseDescriptor } from "./aggregation.js";
import {
	applyWorkspaceEdit,
	mergeWorkspaceTextEditsByPriority,
	summarizeWorkspaceEdit,
	validateWorkspaceEdit,
} from "./edits.js";
import {
	buildScopeKey,
	createWorkspaceDiagnosticsCacheContext,
} from "./workspace-diagnostics-cache.js";
import { attemptTsserverSyncDiagnostics } from "./tsserver-sync.js";
import { isWarmAttached, tryWarmAttachedDiagnostics } from "../warm-attach.js";
import {
	getSuccessfulLspSpawnDurationMs,
	recordSuccessfulLspSpawn,
} from "./spawn-history.js";

function destinationUriPreservingSpelling(
	oldUri: string,
	oldFilePath: string,
	newFilePath: string,
): string {
	const canonical = pathToFileURL(newFilePath);
	try {
		const original = new URL(oldUri);
		const authority = /^file:\/\/([^/]*)/i.exec(oldUri)?.[1] ?? "";
		if (
			original.protocol !== "file:" ||
			(original.host !== "" && original.hostname !== "localhost")
		) {
			return canonical.href;
		}
		const canonicalDestination = () =>
			`${original.protocol}//${authority}${canonical.pathname}`;
		const oldParent = path.resolve(path.dirname(oldFilePath));
		const newParent = path.resolve(path.dirname(newFilePath));
		if (normalizeMapKey(oldParent) !== normalizeMapKey(newParent)) {
			return canonicalDestination();
		}
		const slash = original.pathname.lastIndexOf("/");
		if (slash < 0) return canonicalDestination();
		let rawName = canonical.pathname.slice(
			canonical.pathname.lastIndexOf("/") + 1,
		);
		const oldRawName = original.pathname.slice(slash + 1);
		const oldName = decodeURIComponent(oldRawName);
		const expectedOldName = path.basename(oldFilePath);
		if (oldName.toLowerCase() !== expectedOldName.toLowerCase()) {
			return canonicalDestination();
		}
		// Keep non-canonical percent-encoding choices from the URI that was
		// opened (for example `%2E` instead of `.`) while using the new path's
		// exact basename. The authority and directory spelling are preserved too.
		for (const match of oldRawName.matchAll(/%([0-9a-f]{2})/gi)) {
			const encoded = match[0];
			const decoded = String.fromCharCode(Number.parseInt(match[1], 16));
			rawName = rawName.split(decoded).join(encoded);
		}
		return `${original.protocol}//${authority}${original.pathname.slice(0, slash + 1)}${rawName}`;
	} catch {
		return canonical.href;
	}
}

// --- Init override helpers ---

/**
 * Recursively merges `override` onto `base`. Override wins on leaf conflicts
 * at every nesting level; arrays and non-plain-object values are replaced, not
 * merged (consistent with standard LSP settings merge semantics).
 */
function deepMergeObjects(
	base: Record<string, unknown>,
	override: Record<string, unknown>,
): Record<string, unknown> {
	const result: Record<string, unknown> = { ...base };
	for (const [key, val] of Object.entries(override)) {
		if (
			val !== null &&
			typeof val === "object" &&
			!Array.isArray(val) &&
			result[key] !== null &&
			typeof result[key] === "object" &&
			!Array.isArray(result[key])
		) {
			result[key] = deepMergeObjects(
				result[key] as Record<string, unknown>,
				val as Record<string, unknown>,
			);
		} else {
			result[key] = val;
		}
	}
	return result;
}

/**
 * Merges user-supplied initializationOptions onto a server's built-in defaults.
 * - If neither side is defined → undefined (no options sent).
 * - If only one side is defined → that side is returned directly.
 * - Both defined → deep merge, user wins on conflicts.
 */
export function mergeInitializationOptions(
	base: Record<string, unknown> | undefined,
	override: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!override) return base;
	if (!base) return override;
	return deepMergeObjects(base, override);
}

// --- Types ---

export interface LSPState {
	clients: Map<string, LSPClientInfo>; // key: "serverId:root"
	servers: Map<string, LSPServerInfo>;
	broken: Map<string, number>; // servers that failed to initialize with retry-at timestamp
	inFlight: Map<string, Promise<SpawnedServer | undefined>>; // prevent duplicate spawns
	clientSpawnedAt: Map<string, number>; // key: "serverId:root" → epoch ms of last successful spawn
	/**
	 * #667: key "serverId:root" of every client that has already answered at
	 * least one diagnostics-mode `touchFile` (not `.inconclusive`) this
	 * session. Deliberately a STRONGER bar than `isAlive()`/spawned/
	 * initialize-handshake-complete (all already true at `serverCountReady:1`
	 * while the server was still uselessly timing out on real requests — see
	 * `ensureWarmForSweep`): only a confirmed round trip counts as "warm".
	 */
	demonstratedReady: Set<string>;
	/**
	 * #799: key "serverId:root" (same identity as {@link demonstratedReady})
	 * of every server whose `ensureWarmForSweep` warm-up ended inconclusive
	 * this session (initial attempt + retry both left it without a confirmed
	 * round trip — the same condition that populates `failedServerIds`). A
	 * later sweep in the SAME session sees this and skips straight to the
	 * caller's group-skip accounting instead of re-paying the warm-up
	 * round trip (and its retry) all over again. Session-scoped like
	 * `demonstratedReady`: a fresh `LSPService` (created by
	 * `resetLSPService`) starts with an empty set, so a new session always
	 * retries fresh. A key is removed the moment that server demonstrates
	 * readiness through ANY path (see `markDemonstratedReadyKey`), so a
	 * server that recovers later in the same session is never stuck cold.
	 */
	demonstratedCold: Set<string>;
}

const BROKEN_BASE_COOLDOWN_MS = 15_000;
const BROKEN_MAX_COOLDOWN_MS = 5 * 60_000; // cap at 5 minutes
const BROKEN_PERMANENT_AFTER = 5; // disable for session after N consecutive failures
// #1127: a client that dies THIS soon after a successful spawn/initialize is
// treated as a crash-loop symptom (opengrep's post-init "Unhandled message"
// exit), not a legitimate long-running server that happened to restart once.
// 60s comfortably covers normal serve-a-few-files-then-idle sessions while
// still catching "spawns fine, dies within seconds every time" servers.
const RUNTIME_EXIT_UPTIME_THRESHOLD_MS = 60_000;
// #1142: the fast path above only trips on CONSECUTIVE exits UNDER the 60s
// threshold, so a server that reliably dies just PAST it (~65-90s after every
// spawn) resets that streak on every death and churns forever — a persistent
// low-frequency crash loop the hard-cutoff design structurally cannot see. The
// windowed-rate trip COMPOSES with (does not replace) the fast path: N
// non-intentional deaths within a rolling M-minute window trip the breaker
// regardless of each death's individual lifetime.
//   N = BROKEN_PERMANENT_AFTER (5): one uniform "5 strikes" give-up count
//       across both streams, and high enough that the benign over-threshold
//       deaths that reach this path (a one-off crash after a long healthy run;
//       a single sleep/resume connection drop) — at most one per key per event
//       — cannot approach it.
//   M = 15 min: wide enough for a genuine slow loop (each life ~65-90s, so 5
//       death→respawn cycles land in ~6-15 min of active churn) to accumulate
//       5, yet short enough that sparse benign crashes (e.g. "twice last hour,
//       now healthy") age out of the rolling window before five ever coincide.
const RUNTIME_EXIT_WINDOW_MS = 15 * 60_000;
const RUNTIME_EXIT_WINDOW_TRIP_COUNT = BROKEN_PERMANENT_AFTER;
// A death whose measured lifetime (`exitedAt - spawnedAt`) exceeds this ceiling
// is NOT recorded toward the window: it is either a genuinely long healthy run
// that crashed once, or a lifetime computed ACROSS a machine-sleep / Modern-
// Standby suspend (the #1122/#1139 death-timestamp lesson — a suspend gap makes
// a benign exit look like a huge "uptime"), and neither is crash-loop churn.
// The slow-loop residual this fix targets dies well within the ceiling
// (~65-90s), so it is unaffected. This is a belt-and-suspenders guard on top of
// the structural defense that the window is per-KEY: a single suspend kills at
// most one live client per server, contributing at most one death to any one
// key's window, so it cannot by itself reach the trip count regardless.
const RUNTIME_EXIT_WINDOW_UPTIME_CEILING_MS = 10 * 60_000;
// #743: a server whose per-server notify write (didOpen/didChange) times out
// this many times in a row is a persistently backpressured server; it is demoted
// into the `broken` cooldown map (evicted + cooled down) so subsequent sweeps
// stop re-paying its notify budget on every file. A single successful write
// resets the streak.
const NOTIFY_BACKPRESSURE_BROKEN_AFTER = 3;
const OPTIONAL_LSP_RETRY_COOLDOWN_MS = 5 * 60_000;
const OPTIONAL_LSP_SERVER_IDS = new Set<string>();
const NAV_CLIENT_WAIT_TIMEOUT_MS = Math.max(
	0,
	Number.parseInt(process.env.PI_LENS_LSP_NAV_CLIENT_WAIT_MS ?? "1500", 10) ||
		1500,
);
const TOUCH_DEBOUNCE_MS = Math.max(
	0,
	Number.parseInt(process.env.PI_LENS_LSP_TOUCH_DEBOUNCE_MS ?? "1500", 10) ||
		1500,
);
// #1621: the rename-propagation notifies (`didClose` ahead of the rename,
// `workspace/didRenameFiles` after) share the exit-notify defect #1620 fixed —
// a notify write on a pipe that is not draining neither resolves nor rejects,
// so the bare `await` was unbounded. Rename propagation is best-effort advice
// to servers, not a correctness gate, so a wedged client's notify gets its own
// ceiling and a recorded disposition rather than stalling the `Promise.all`
// for every healthy client alongside it.
// #1621 F3: floor at 50ms, not 0 — a negative env value (e.g. "-100") is
// truthy after `Number.parseInt`, so it survives the `|| 1500` fallback and
// would otherwise reach `withDeadline`'s `ms <= 0` branch. That branch treats
// the budget as already expired and settles without ever really attempting
// the notify — a negative override would silently disable rename propagation
// instead of merely shortening its budget.
const RENAME_NOTIFY_TIMEOUT_MS = Math.max(
	50,
	Number.parseInt(
		process.env.PI_LENS_LSP_RENAME_NOTIFY_TIMEOUT_MS ?? "1500",
		10,
	) || 1500,
);

// #1621: bound a single rename-propagation notify call and classify how it
// failed. `withTimeout` rejects with the deterministic `"Timeout after Nms"`
// message on the timer branch (see deadline-utils.ts) — the same signal
// `navRequest`/`clientPingLiveness` in clients/lsp/client.ts already match on
// to tell a timeout from a genuine rejection, reused here rather than forking
// a second convention.
type RenameNotifyResult =
	| { ok: true }
	| { ok: false; error: string; disposition: RenameNotifyDisposition };

async function runRenameNotify(
	send: () => Promise<void>,
	timeoutMs: number,
): Promise<RenameNotifyResult> {
	try {
		await withTimeout(send(), timeoutMs);
		return { ok: true };
	} catch (err) {
		const timedOut =
			err instanceof Error && err.message.startsWith("Timeout after");
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
			disposition: timedOut ? "timedOut" : "rejected",
		};
	}
}
const DEFAULT_LSP_CLIENT_CEILING = 24;
const DEFAULT_TS_IDLE_EVICT_MS = 20 * 60_000;

export function getTypeScriptIdleEvictMs(): number {
	const parsed = Number.parseInt(
		process.env.PI_LENS_TS_IDLE_EVICT_MS ?? "",
		10,
	);
	return Number.isSafeInteger(parsed) && parsed > 0
		? parsed
		: DEFAULT_TS_IDLE_EVICT_MS;
}

export function getLspClientCeiling(): number {
	const parsed = Number.parseInt(
		process.env.PI_LENS_LSP_CLIENT_CEILING ?? "",
		10,
	);
	return Number.isSafeInteger(parsed) && parsed > 0
		? parsed
		: DEFAULT_LSP_CLIENT_CEILING;
}
// #667: the sweep warm-up round trip's OWN generous, one-time budget —
// deliberately larger than any single per-file sweep budget (`perFileMs` in
// `runWorkspaceDiagnostics`, or the batch tool's per-file wait) because this
// pays for whatever a cold tsserver-style server needs to finish its internal
// project load/index before it can usefully answer ANY diagnostics request,
// not just one file's worth of work. Env-tunable like every other wait budget
// in this file.
/**
 * #1783: does this client hold the document open? Tolerates a client that does
 * not implement `isDocumentOpen` (a test double, or a future client shape) by
 * answering "no" — the drift backstop then drops the record rather than
 * resyncing a view it cannot confirm exists.
 */
function documentIsOpenOn(client: LSPClientInfo, filePath: string): boolean {
	const probe = (client as { isDocumentOpen?: (path: string) => boolean })
		.isDocumentOpen;
	if (typeof probe !== "function") return false;
	try {
		return probe.call(client, filePath) === true;
	} catch {
		return false;
	}
}

function warmupTimeoutMs(): number {
	const raw = Number.parseInt(
		process.env.PI_LENS_LSP_WARMUP_TIMEOUT_MS ?? "",
		10,
	);
	return Number.isFinite(raw) && raw > 0 ? raw : 20_000;
}

// #744: short pause between the first warm-up round trip and the single retry
// `ensureWarmForSweep` gives a server that didn't warm on its first attempt.
// Deliberately small — it's a breather for a server mid-relaunch/index (the
// state where warmup failure is most likely, e.g. a sweep starting seconds
// after an `lsp_service_reset`), not a second full budget. Read at call time so
// tests can drive the retry without waiting out a real backoff. 0 disables the
// pause entirely (retry fires immediately).
function warmupRetryBackoffMs(): number {
	const raw = Number.parseInt(
		process.env.PI_LENS_LSP_WARMUP_RETRY_BACKOFF_MS ?? "",
		10,
	);
	return Number.isFinite(raw) && raw >= 0 ? raw : 500;
}

/**
 * Read the `PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS` env override at call time
 * (process.env mutations in tests stay live). Returns undefined when unset,
 * non-numeric, or negative — callers fall back through the explicit option
 * chain in {@link LSPService.touchFile}.
 */
function readEnvDiagnosticsWaitMs(): number | undefined {
	const raw = process.env.PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS;
	if (raw === undefined) return undefined;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
	return parsed;
}

/**
 * #707: grace delay before the racing tsserver sync clean-confirm fires on a
 * tier-3 silent primary. Short enough to beat the full push-wait budget by a
 * wide margin (~300ms grace + sync RTT vs ~1000ms budget), long enough to give
 * a genuinely dirty file's push a head start — a push that arrives within the
 * grace costs zero extra requests. Read at call time (not memoized) so tests
 * and users can tune without a rebuild.
 */
function readTsserverSyncGraceMs(): number {
	const raw = process.env.PI_LENS_TSSERVER_SYNC_GRACE_MS;
	if (raw === undefined) return 300;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed < 0) return 300;
	return parsed;
}
/**
 * Read the `PI_LENS_AUX_GRACE_MS` env override at call time (not module
 * load time) so tests can set it per-case. Controls the CEILING on how long
 * auxiliary-role promises (opengrep, ast-grep, zizmor, …) are waited after
 * all primary-role promises have settled, in both getDiagnostics
 * (raceToCompletion) and the touchFile push wait (#1458 S2 — the two lanes
 * share the same declared-budget-capped-by-ceiling shape). Each auxiliary
 * still gets only its OWN declared `aggregateWaitMs` up to this ceiling —
 * this is not a flat per-touch wait. Returns undefined when the var is
 * absent; each call site then supplies its own default ceiling (touchFile:
 * 2000ms; getDiagnostics: 2000ms — see the `?? 2000` at each call site).
 */
function readEnvAuxGraceMs(): number | undefined {
	const raw = process.env.PI_LENS_AUX_GRACE_MS;
	if (raw === undefined) return undefined;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed < 0) return undefined;
	return parsed;
}
const DEFAULT_AUX_GRACE_CEILING_MS = 2000;
const MAX_ADAPTIVE_AUX_GRACE_CEILING_MS = 8000;
const ADAPTIVE_AUX_GRACE_MARGIN_MS = 500;

export function auxWaitBudgetMs(
	serverId: string,
	isCold: boolean,
	configuredCeilingMs: number | undefined,
	declaredWaitMs: number,
): number {
	if (configuredCeilingMs !== undefined || !isCold) {
		return Math.min(
			declaredWaitMs,
			configuredCeilingMs ?? DEFAULT_AUX_GRACE_CEILING_MS,
		);
	}
	const observedSpawnMs = getSuccessfulLspSpawnDurationMs(serverId);
	if (observedSpawnMs === undefined || observedSpawnMs <= 0) {
		return Math.min(declaredWaitMs, DEFAULT_AUX_GRACE_CEILING_MS);
	}
	return Math.min(
		MAX_ADAPTIVE_AUX_GRACE_CEILING_MS,
		Math.max(declaredWaitMs, observedSpawnMs + ADAPTIVE_AUX_GRACE_MARGIN_MS),
	);
}
const DIAGNOSTICS_SEMANTIC_SETTLE_THRESHOLD_MS = Math.max(
	0,
	Number.parseInt(
		process.env.PI_LENS_LSP_DIAGNOSTICS_SEMANTIC_THRESHOLD_MS ?? "250",
		10,
	) || 250,
);
const DIAGNOSTICS_SEMANTIC_SETTLE_WAIT_MS = Math.max(
	0,
	Number.parseInt(
		process.env.PI_LENS_LSP_DIAGNOSTICS_SEMANTIC_SETTLE_MS ?? "400",
		10,
	) || 400,
);
// Once the fastest client has diagnostics, remaining clients get this window before
// we proceed with whatever results are ready. 0 disables early-unblock.
const EARLY_UNBLOCK_GRACE_MS = Math.max(
	0,
	Number.parseInt(
		process.env.PI_LENS_LSP_EARLY_UNBLOCK_GRACE_MS ?? "400",
		10,
	) || 400,
);
export interface SpawnedServer {
	client: LSPClientInfo;
	info: LSPServerInfo;
}

type OutstandingAuxNotifyWrite = {
	startedAt: number;
	client: LSPClientInfo;
	settled: Promise<void>;
	wedgeTimer: ReturnType<typeof setTimeout>;
	armedBudgetMs: number;
	resolveSettled: () => void;
};

/**
 * #1934: what the client pool actually did to serve one selection.
 *
 * `lsp_client_selected` fired 5601 times in a 20.8h window carrying only
 * `{serverId, candidateCount}`, so nothing in the log said whether the pool
 * reused a warm client or paid for a language-server spawn. The only estimate
 * was a cross-record inference against `lsp_launch_candidate_success`, which
 * has a different denominator, so a regression that halved pool reuse was
 * invisible. This rides ON the existing record: one record, one denominator,
 * reuse rate = `warm-reuse / (warm-reuse + cold-spawn)`.
 *
 * `spawn-failure` and `declined` are deliberately separate values, per the
 * availability invariant: an ERRORED acquisition (the spawn ran and the
 * breaker cooled the key down) must not read the same as a CLEAN decline
 * (no root, breaker already open, host trust refused, capacity, shutdown).
 * `declined` never reaches `lsp_client_selected` — those paths already have
 * their own records (`lsp_client_unavailable`, `lsp_client_skipped_broken`,
 * `lsp_client_skipped_unavailable_command`).
 *
 * #2064: `cold-spawn` alone conflated two different facts. Every caller that
 * awaited one spawn reported `cold-spawn`, so the value read as a spawn count
 * and was not one. In a 21.8h field window 62 `cold-spawn` records clustered
 * into 21 real spawn events, a 3.0x over-count, and one cluster held 39
 * records inside 2ms against a measured 29.3s TypeScript spawn. The `-joined`
 * values split the two readings apart without splitting the record:
 *
 * - selections that paid a spawn wait = every cold/failure value;
 * - selections served from the pool = `warm-reuse`;
 * - reuse rate = `warm-reuse / (warm-reuse + every cold/failure value)`, the
 *   same single denominator #1934 defined.
 *
 * These values are NOT the spawn count. `lsp_server_spawned` is, and it is
 * authoritative: `getClientsForFile` and `getAuxiliaryClientsForFile` pass no
 * `onOutcome`, so a multi-client or auxiliary spawn writes a spawn record and
 * no selection record at all. Read the relation as
 * `count(lsp_server_spawned) >= count(outcome="cold-spawn")`, never as
 * equality (#2064 review F1).
 */
export type LSPClientAcquisitionOutcome =
	| "warm-reuse"
	| "cold-spawn"
	| "cold-spawn-joined"
	| "spawn-failure"
	| "spawn-failure-joined"
	| "declined";

// #1621: a rename-propagation notify failure now records WHY it failed —
// `timedOut` (the notify write never settled inside its budget) is distinct
// from `rejected` (the send itself errored) — so an empty failure list still
// means clean, and a timeout doesn't read as an indistinguishable rejection.
export type RenameNotifyDisposition = "timedOut" | "rejected";
export interface RenameNotifyFailure {
	serverId: string;
	error: string;
	disposition: RenameNotifyDisposition;
}

export interface LSPRenameFileResult {
	applied: boolean;
	serverIds: string[];
	willRenameFailures: Array<{ serverId: string; error: string }>;
	didRenameFailures: RenameNotifyFailure[];
	droppedConflicts: number;
	inputEditCount: number;
	summary: string[];
	descriptions?: string[];
	files?: string[];
}

export interface LSPDiagnosticsHealth {
	health: "ok" | "ok_empty" | "no_clients" | "no_clients_stale" | "destroyed";
	failureKind: string;
	serverCountAttempted: number;
	serverCountReady: number;
	candidateServerIds: string[];
	mergedCount: number;
	dedupDroppedCount: number;
	checkedAt: string;
}

function mergeLspDiagnostics(
	diagnostics: import("./client.js").LSPDiagnostic[],
): import("./client.js").LSPDiagnostic[] {
	const merged: import("./client.js").LSPDiagnostic[] = [];
	const seen = new Set<string>();
	for (const diagnostic of diagnostics) {
		const key = [
			diagnostic.range.start.line,
			diagnostic.range.start.character,
			diagnostic.message,
		].join(":");
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(diagnostic);
	}
	return merged;
}

export type LSPDiagnosticsMode = "none" | "document" | "full";
export type LSPTouchClientScope = "primary" | "all" | "with-auxiliary";

export interface LSPTouchFileOptions {
	diagnostics?: LSPDiagnosticsMode;
	source?: string;
	clientScope?: LSPTouchClientScope;
	/**
	 * For clientScope "with-auxiliary": the auxiliary server ids (e.g. "opengrep")
	 * to attach alongside the primary. The caller (lsp runner) computes which are
	 * enabled (it owns flag access); the service just spawns + collects them.
	 */
	auxiliaryServerIds?: readonly string[];
	/**
	 * For clientScope "all": server ids to skip even though they match the
	 * file's extension. Used by `runWorkspaceDiagnostics` (#584) to keep
	 * opengrep off the per-file bulk-sweep touch loop — its findings now come
	 * from a dedicated CLI project-diagnostics extractor (`opengrep-client.ts`)
	 * that runs once per project instead of once per file, so re-touching it
	 * here would be redundant AND (per #584/#387) the slow auxiliary that
	 * dominates the per-file wait during a full workspace sweep.
	 */
	excludeServerIds?: ReadonlySet<string>;
	/** Budget for waiting on the LSP client to spawn / become ready. */
	maxClientWaitMs?: number;
	/**
	 * Budget for waiting on `textDocument/publishDiagnostics` after the notify
	 * lands. The dispatch-lsp-runner sets this to a tighter value so a slow
	 * LSP on one file doesn't dominate the per-edit pipeline budget (#117).
	 *
	 * Resolution order (first wins):
	 *   1. `PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS` env var (user override)
	 *   2. this option
	 *   3. `maxClientWaitMs` (legacy fallback)
	 *   4. built-in defaults (3000 ms for `full`, 1200 ms for `document`)
	 */
	maxDiagnosticsWaitMs?: number;
	/** Return merged diagnostics from the clients touched by this call. */
	collectDiagnostics?: boolean;
	/** Skip workspace/didChangeWatchedFiles — use for cascade reads, not real fs changes */
	silent?: boolean;
	/**
	 * #645: per-sweep gate (see `createSweepIndexGate`/`SweepIndexGate`) that
	 * lets a `workspaceIndexing`-strategy server (e.g. marksman) pay its full
	 * `aggregateWaitMs` wait only once per `runWorkspaceDiagnostics` sweep
	 * instead of once per swept file. Only `runWorkspaceDiagnostics` passes
	 * this; every other caller (per-edit dispatch, cascade touches) omits it,
	 * so `perServerTimeout` below always falls back to the pre-#645 full-wait
	 * behavior for them.
	 */
	sweepIndexGate?: SweepIndexGate;
	/**
	 * #669: `perServerTimeout`'s caller-cap is a CEILING by design (#242) for
	 * the normal per-edit/steady-state dispatch path — a slow strategy must
	 * never blow past the pipeline's cap. `ensureWarmForSweep`'s cold-server
	 * warm-up call is the inverse case: it deliberately asks for a budget
	 * LARGER than the server's normal warm-state `aggregateWaitMs`, precisely
	 * because the server hasn't finished its cold launch/indexing yet. Without
	 * this flag, `Math.min(callerCap, strategyWait)` silently shrinks that
	 * request back down to `strategyWait` (e.g. 1000ms for typescript)
	 * regardless of the 20000ms actually requested, defeating the warm-up
	 * entirely. When true, the caller's cap is treated as a FLOOR instead —
	 * `Math.max(callerCap, strategyWait)` — never shrunk below what was asked.
	 * #832: the first warm-up touch is exempt from this floor when the live
	 * capability classification identifies a workspace-indexing push-only
	 * server as silent-on-clean; that server uses its configured strategy wait.
	 * Only `ensureWarmForSweep` sets this; every other caller leaves it unset
	 * and keeps the pre-existing ceiling-only semantics exactly as-is.
	 */
	warmupOverride?: boolean;
	/**
	 * #799: which `warmupOverride` attempt this touch is (1 = the first
	 * round trip against a cold server, 2 = `ensureWarmForSweep`'s single
	 * retry). Normally only the FIRST attempt gets the full cold-start floor
	 * (`Math.max(callerCap, strategyWait)`) — a genuinely slow-to-index
	 * server (tsserver-style) deserves that full window once. #832's
	 * workspace-indexing push-only silent-on-clean exception uses the shorter
	 * configured strategy wait on both attempts. A retry
	 * attempt already got that window and re-flooring it to another 20s
	 * would silently double-pay the ceiling for a server whose real issue
	 * is that it's `silentOnClean` and simply never publishes (marksman) —
	 * that retry instead respects the server's own (much shorter) strategy
	 * budget, same as a normal steady-state touch. For non-exempt servers,
	 * undefined/1 keeps today's floor-every-attempt behavior; only
	 * `ensureWarmForSweep`'s retry sets this to 2.
	 */
	warmupAttempt?: number;
}

/**
 * #1618: discriminated cause for an unconfirmed (`timedOut: true`)
 * `LSPWorkspaceDiagnosticResult` — replaces the old single `timedOutFiles`
 * bucket, which conflated a real budget timeout with a thrown error (the
 * `unconfirmedErrored = length - unconfirmedTimedOut` dead-subtraction bug
 * downstream in `tools/lens-diagnostics.ts` was structurally always 0
 * because the sweep's own catch block set BOTH `error` and `timedOut`) and
 * with a service torn down mid-sweep by the idle-reset race (81 files that
 * left zero trace and rendered as "check didn't complete within budget").
 *
 * - `budget` — the outer per-file `withDeadline` wrapper never got a result
 *   back at all within `perFileMs`.
 * - `inconclusive` — `touchFile`'s own `.inconclusive` flag (#570): the
 *   notify write or the diagnostics wait itself timed out. Also used for a
 *   group skipped after a failed pre-sweep server warm-up (#744) — the
 *   check was never even attempted, which is inconclusive, not a timeout.
 * - `coverage_gap` — legacy/downstream classification for an auxiliary
 *   scanner gap. New sweep results carry the lane ids in
 *   `unconfirmedServerIds` without setting the file-wide `timedOut` verdict.
 * - `service_destroyed` — the LSP service was torn down (`resetLSPService`)
 *   while this sweep was still in flight; the remainder of the sweep never
 *   even attempted a language-server round trip for this file.
 * - `error` — the per-file check threw.
 * - `binding_mismatch` — never set by this module. `tools/lens-diagnostics.ts`
 *   classifies a result into this reason AFTER the sweep returns, when its
 *   content-binding fingerprint no longer matches disk (`boundToCurrentDisk:
 *   false`, or a hash check that failed post-hoc) — the LSP layer itself
 *   considered the touch confirmed, but the file changed under it. Listed
 *   here so both modules share one discriminated union rather than the tools
 *   layer inventing a second, parallel one (#1618 review round 2).
 */
export type LSPWorkspaceUnconfirmedReason =
	| "budget"
	| "inconclusive"
	| "coverage_gap"
	| "service_destroyed"
	| "error"
	| "binding_mismatch"
	// #2052: the file lies outside every initialized session cwd, so no client
	// was asked at all. NOT a timeout and NOT a clean result: the sweep has no
	// evidence about this file either way. It shares `timedOut: true` with the
	// other members purely because that flag is what excludes a result from the
	// workspace-cache write-back — persisting a declined file as confirmed
	// clean would replay a false clean on every later sweep, which is the whole
	// defect #2052 exists to close.
	| "outside_project_root";

export interface LSPWorkspaceDiagnosticResult {
	filePath: string;
	diagnostics: import("./client.js").LSPDiagnostic[];
	count: number;
	error?: string;
	/**
	 * True when this file's primary per-file check was NOT confirmed — either
	 * `touchFile`'s own `.inconclusive` flag was set (#570: the notify write
	 * or the diagnostics wait itself timed out), the OUTER `perFileMs`
	 * `withDeadline` wrapper never got a result back at all, or the check
	 * threw. `diagnostics` is a default-empty placeholder in every one of
	 * those cases, not a confirmed result, and must not be treated as
	 * "confirmed clean" by any caller reconciling this into cached state
	 * (#571). An auxiliary-only gap is represented separately by
	 * `unconfirmedServerIds`: answering lanes remain usable, while cache and
	 * state-replacement consumers still require full coverage. Absent/false
	 * means the primary check completed within budget; workspace-pull results are
	 * always confirmed (a pull either returns a real report or the caller
	 * falls back to per-file, never a silent empty default).
	 */
	timedOut?: boolean;
	/**
	 * #1618: WHY `timedOut` is true — see {@link LSPWorkspaceUnconfirmedReason}.
	 * Always set alongside `timedOut: true` on every path this sweep
	 * produces; absent only on a legacy/test double that predates this field.
	 */
	unconfirmedReason?: LSPWorkspaceUnconfirmedReason;
	/**
	 * Auxiliary lanes that did not contribute evidence for this file. Their
	 * absence narrows coverage, but does not invalidate diagnostics returned by
	 * answering servers. A result carrying this field is usable for delivery,
	 * but is not eligible to replace the fully-covered workspace cache.
	 */
	unconfirmedServerIds?: string[];
	/**
	 * #744: true when this file's per-file check was never even attempted
	 * because its primary language server failed the pre-sweep warm-up (an
	 * initial round trip plus one retry both left it cold — e.g. marksman still
	 * building its workspace index). Such a server would re-pay its full timeout
	 * on every one of its files and drag the whole sweep, so the group is skipped
	 * up front. Always accompanies `timedOut: true` (the result is unconfirmed,
	 * NOT a confirmed-clean `[]`); this flag only records WHY, so the outcome
	 * reads honestly as "skipped after failed warm-up" rather than "ran clean".
	 */
	skippedWarmupFailure?: boolean;
	/**
	 * #1093: wall-clock time (ms) these diagnostics were actually OBSERVED, set
	 * ONLY for results served from the workspace-diagnostics cache (a replay of
	 * an older scan). Absent for freshly-touched results (observed now). Callers
	 * reconciling this into the footer widget must pass it as the `observedAt`
	 * stamp so a cache-hit replay doesn't re-arm the mtime-staleness gate
	 * (`reconcileStaleWidgetFiles`) and keep a resolved finding on screen (the
	 * #1092 touchedAt-re-arming defect).
	 */
	observedAt?: number;
	/**
	 * #1104: sha256 of the file bytes this result's diagnostics were computed
	 * against, when known — from the pull path's server-answered `resultId`
	 * flow (a "full" `workspace/diagnostic`/`textDocument/diagnostic` report is
	 * fingerprinted at request time; an "unchanged" report inherits the prior
	 * fingerprint) or, for a per-file touch, the SAME `contentHash` the #1095
	 * push-path binding records. Absent means "no hash available" (never
	 * fabricated) — the cache-record site below then honestly stores no
	 * contentHash and a later `lookup()`'s binding reads "unknown", exactly the
	 * pre-#1104 behavior for that entry.
	 */
	contentHash?: string;
	/**
	 * Monotonic token reserved when this file entered the scan, rather than when
	 * its asynchronous LSP work settled. Consumers use it to reject late old
	 * results (#1198).
	 */
	writeIndex?: number;
	/** #1198: explicit content-binding verdict from a per-file touch. */
	boundToCurrentDisk?: BoundToCurrentDisk;
}

/**
 * Group files by their primary language server id (#387/#631 — extracted
 * from `runWorkspaceDiagnostics`'s inline grouping so other callers, e.g.
 * `lsp_diagnostics`' batch/directory scan in tools/lsp-diagnostics.ts, can
 * share the exact same server-affinity key instead of hand-copying it).
 * `multiServer` flags a group containing at least one file with more than
 * one attached server (primary + auxiliary) — callers that care about that
 * distinction (the workspace-pull fast path below) can act on it; callers
 * that don't (a plain per-file touch) can ignore it.
 */
export function groupFilesByPrimaryServer(
	files: readonly string[],
): Array<{ files: string[]; multiServer: boolean }> {
	const byServer = new Map<string, { files: string[]; multiServer: boolean }>();
	for (const filePath of files) {
		const servers = getServersForFileWithConfig(filePath);
		const primary = servers[0]?.id ?? "none";
		const group = byServer.get(primary);
		if (group) {
			group.files.push(filePath);
			if (servers.length > 1) group.multiServer = true;
		} else {
			byServer.set(primary, {
				files: [filePath],
				multiServer: servers.length > 1,
			});
		}
	}
	return [...byServer.values()];
}

/**
 * #645: tracks, for ONE `runWorkspaceDiagnostics` sweep, which server ids
 * have already had at least one file pay the full `aggregateWaitMs` wait
 * budget. `touchFile` consults this (via `LSPTouchFileOptions.sweepIndexGate`)
 * only for servers whose strategy is marked `workspaceIndexing: true` —
 * every other server is untouched. Deliberately a plain per-sweep object
 * (created fresh by `runWorkspaceDiagnostics`, never stored on `LSPService`
 * itself) so this is scoped to a single sweep call and can never leak state
 * across sweeps or affect a per-edit touch, which never receives one.
 */
export interface SweepIndexGate {
	/**
	 * Returns true the first time it's called for `serverId` in this sweep
	 * (and records that it was called), false on every subsequent call for
	 * the same `serverId`. Synchronous and side-effecting by design — callers
	 * must call it exactly once per touched file's server list (see
	 * `touchFile`'s upfront per-server precompute) so a single `touchFile`
	 * call's internal helper re-invocations don't each consume a separate
	 * "first touch" slot.
	 */
	consumeFirstTouch(serverId: string): boolean;
}

/** Create a fresh, empty {@link SweepIndexGate} for one `runWorkspaceDiagnostics` call. */
export function createSweepIndexGate(): SweepIndexGate {
	const seen = new Set<string>();
	return {
		consumeFirstTouch(serverId: string): boolean {
			if (seen.has(serverId)) return false;
			seen.add(serverId);
			return true;
		},
	};
}

/**
 * Run one worker per server group (#387/#631): at most one in-flight
 * `processGroup` call per group at a time — each group's own callback is
 * responsible for iterating its files serially, this scheduler never starts
 * a second concurrent call into the same group — parallelized ACROSS
 * distinct groups up to `concurrency` workers. This is the exact scheduling
 * shape `runWorkspaceDiagnostics` (the engine behind `lens_diagnostics
 * mode=full`) has used since #387 to avoid flooding a single-threaded LSP
 * server with concurrent touches that only queue server-side instead of
 * parallelizing (observed: 51/123 files "timed out" purely from queue
 * position in a flat pool) — extracted here so `lsp_diagnostics`' batch/
 * directory scan (tools/lsp-diagnostics.ts, #631) can share the identical
 * property instead of running a flat, server-oblivious bounded pool.
 *
 * `concurrency` caps how many DISTINCT groups run at once, not how many
 * files run at once — a single-language batch (one group, the common case)
 * becomes effectively serial for that group regardless of `concurrency`.
 * That is the intended #387 behavior, not something to work around.
 *
 * `processGroup` receives the whole group (not just `.files`) so a caller
 * that cares about `multiServer` (e.g. the workspace-pull fast path below,
 * which only applies to a single-server group) can still act on it; a
 * caller that doesn't can just destructure `.files`.
 */
export async function runPerServerGroups<
	G extends { files: readonly string[]; multiServer?: boolean },
>(
	groups: readonly G[],
	concurrency: number,
	processGroup: (group: G) => Promise<void>,
	signal?: AbortSignal,
): Promise<void> {
	let nextGroup = 0;
	const workers = Math.min(Math.max(1, concurrency), groups.length);
	await Promise.all(
		Array.from({ length: workers }, async () => {
			while (!signal?.aborted) {
				const gi = nextGroup;
				nextGroup += 1;
				if (gi >= groups.length) break;
				await processGroup(groups[gi]!);
			}
			return true;
		}),
	);
}

const WORKSPACE_DIAGNOSTICS_CONCURRENCY = 8;

// #621: a single-server group (the common case — one language, one server)
// used to pre-open its ENTIRE file list in one uninterrupted burst (#608)
// before the per-file diagnostics-wait loop even started. That coalesces
// watched-files notifications into one flush (the #608 fix's intent), but at
// real project scale (~150 files) it also dumps the whole group on the
// server's single-threaded request queue essentially at once, forcing it to
// ingest/typecheck the full burst before any per-file diagnostics request
// even gets a turn — observed to collapse to near-100% per-file timeouts on
// a ~150-file TS project (pi-drykiss dogfooding). `lsp_diagnostics`'
// bounded-concurrency batch/directory mode (tools/lsp-diagnostics.ts, default
// 8) never has this problem: it only ever has ~8 files in flight at once.
// Chunking the pre-open+process cycle to the same width gets both properties:
// each chunk's opens still land inside `WatchedFilesQueue`'s 100ms debounce
// window and coalesce into one flush (bounded burst, not per-file — the
// original #608 bug pre-opened lazily one file at a time with a full
// diagnostics wait in between, which is what defeated the debounce), while no
// single burst ever exceeds this width regardless of total group size.
const WORKSPACE_SWEEP_PREOPEN_CHUNK_SIZE = (() => {
	const raw = Number(process.env.PI_LENS_LSP_WORKSPACE_PREOPEN_CHUNK);
	return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 8;
})();

// #584: opengrep has no `workspace/diagnostic` pull support (push-only,
// docs/servercapabilities.md) and `reopenOnResync: true` (wait-policy/strategies.ts)
// means every per-file LSP touch already forces a full re-scan anyway — there's
// no incremental win from routing it through the sweep's per-file loop. On a
// full workspace sweep it instead dominates the per-file wait (its own
// wait-tier budget is the slowest of any spawned server) and serializes with
// everything else in its server group (#387). Its findings for a BULK/
// full-workspace scan come from `opengrep-client.ts` — a dedicated CLI
// extractor that scans the whole tree once and is read via
// `project-diagnostics/extractors.ts`, same architecture as knip/jscpd/
// gitleaks. The per-edit real-time LSP path (clientScope "primary"/
// "with-auxiliary") is untouched by this — opengrep still attaches there.
const WORKSPACE_SWEEP_EXCLUDED_SERVER_IDS: ReadonlySet<string> = new Set([
	"opengrep",
]);

// The notify write (didOpen/didChange) is normally instant, but it awaits a
// JSON-RPC send that BACKPRESSURES when the server's stdin isn't being drained
// (a wedged/CPU-bound server, e.g. TypeScript mid-recheck). Unbounded, that
// write parks every touchFile caller: the pre-dispatch sync, the dispatch LSP
// runner (which then rides to its 30s dispatcher timeout — the observed ~31s
// edits), and the workspace sweep. Bounding it here degrades a wedged server to
// "no fresh diagnostics" instead of hanging the edit, for ALL callers.
function notifyWriteBudgetMs(): number {
	const raw = Number(process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : 2000;
}

// #2239: the SAME effective per-server wait floor `getClientForFile` uses to
// size its own acquisition race — the caller's declared budget, raised to
// whatever the file's primary server(s) configure via `clientWaitTimeoutMs`
// (Ruby 30s, and the Bash/JSON/Vue/Svelte/Prisma overrides #2233 added). A
// cold primary spawn is allowed to run this long, so anything downstream that
// charges itself against `maxWaitMs` alone — rather than this floor — sees an
// already-elapsed time it never budgeted for and clamps to zero.
function primaryServerWaitFloorMs(
	filePath: string,
	maxWaitMs?: number,
): number {
	const serverWaitOverrideMs = getServersForFileWithConfig(filePath)
		.filter((s) => s.role !== "auxiliary")
		.reduce((max, server) => Math.max(max, server.clientWaitTimeoutMs ?? 0), 0);
	return Math.max(maxWaitMs ?? 0, serverWaitOverrideMs);
}

// #1459: how long ONE auxiliary notify write may stay outstanding before the
// server counts as wedged rather than merely slow. A scanner whose per-file work
// exceeds the write budget is normal (opengrep routinely needs >2s on a large
// file) and must not be demoted for it — the gate defers the next write instead.
// A write still unaccepted after this window is a different animal: nothing is
// draining that stdin, so the server is demoted through the existing breaker.
// Expressed as a multiple of the write budget so tuning one moves both.
const NOTIFY_WEDGED_BUDGET_MULTIPLIER = 5;

function notifyWedgedMs(): number {
	return notifyWriteBudgetMs() * NOTIFY_WEDGED_BUDGET_MULTIPLIER;
}

// #2358: the wedge window's teardown decision gained a liveness discriminator.
// The fixed window above stays the FLOOR; a server whose drain history says it
// answers per-write in `ewmaMs` with `unacked` documents queued earns
// `k x ewmaMs x unacked` of patience instead — the issue's "a server that
// historically answers in 855 ms with 8 writes queued earns 15-20 s". The cap
// bounds the whole thing so a busy-but-never-draining server still respawns.
const NOTIFY_WEDGED_EWMA_MULTIPLIER = 2;
const NOTIFY_WEDGED_CAP_MS = 60_000;

function notifyWedgedCapMs(): number {
	const raw = Number(process.env.PI_LENS_LSP_NOTIFY_WEDGED_CAP_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : NOTIFY_WEDGED_CAP_MS;
}

// #2358: how long the CPU-liveness discriminator watches the server between
// two process-CPU samples before deciding "busy" vs "flat". Only ever spent
// on a server whose write is already past its patience window — never on the
// per-edit hot path.
function notifyStallCpuSampleMs(): number {
	const raw = Number(process.env.PI_LENS_LSP_NOTIFY_STALL_CPU_SAMPLE_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : 1200;
}

// A server burning more than this percent of one core across the sample
// window counts as BUSY (progressing), not flat (wedged). A single-threaded
// scanner under burst sits near 100; an idle or dead one near 0.
const NOTIFY_STALL_CPU_BUSY_FLOOR_PERCENT = 10;

/**
 * #2358: the reason a notify-stall teardown fired, naming WHICH discriminator
 * decided it. `demoteForNotifyStall` spreads this into the
 * `lsp_notify_backpressure_broken` record, so a production kill is classifiable
 * by its own log line.
 */
export type NotifyStallDemotionReason =
	| {
			consecutiveTimeouts: number;
			discriminator?: "consecutive-timeouts";
			cpuVerdict?: "flat" | "busy" | "unmeasured";
	  }
	| {
			outstandingMs: number;
			discriminator:
				| "budget-exceeded"
				| "budget-exceeded-cpu-flat"
				| "cap-exceeded";
			budgetMs?: number;
			ewmaInputMs?: number;
			unackedDepth?: number;
			cpuVerdict?: "flat" | "busy" | "unmeasured";
			cpuPercent?: number | null;
	  };

// #1714: how many document notifies one auxiliary may hold UNACKNOWLEDGED
// before the next notify has to prove the server drained its input.
//
// #1459's gate bounds CONCURRENT writes to one per auxiliary. That stops a
// simultaneous fan-out, but a `lens_diagnostics mode=full` sweep is mostly
// SEQUENTIAL — one file after another inside a server group (#387) — so every
// write is alone in flight and the gate never engages. Each write still resolves
// as soon as the pipe accepts the bytes, not when the scanner has read them, so
// the sweep can hand a single-threaded scanner hundreds of full re-parses faster
// than it consumes them. ast-grep stalled and had to be force-killed twice in
// two full-scan exposures. Counting unacknowledged notifies bounds the BACKLOG
// the sweep is allowed to build, which pipe-level backpressure alone does not.
const AUX_NOTIFY_INFLIGHT_DEFAULT = 8;

function auxNotifyInflightLimit(info: LSPServerInfo): number {
	const perServer = info.notifyInflightLimit;
	if (
		typeof perServer === "number" &&
		Number.isFinite(perServer) &&
		perServer > 0
	) {
		return Math.floor(perServer);
	}
	const raw = Number(process.env.PI_LENS_LSP_AUX_NOTIFY_INFLIGHT);
	return Number.isFinite(raw) && raw > 0
		? Math.floor(raw)
		: AUX_NOTIFY_INFLIGHT_DEFAULT;
}

// Budget for one project-wide `workspace/diagnostic` pull (#387 Item 2). Larger
// than a per-file wait — it's a single request but scans the whole program —
// yet bounded so a hung server still falls back to the per-file path.
function workspacePullBudgetMs(): number {
	const raw = Number(process.env.PI_LENS_LSP_WORKSPACE_PULL_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
}

// Hard cap on the workspace-diagnostics walk. Even though this is an explicit,
// user-invoked project-wide tool, the walk must be bounded so a misrooted run
// (e.g. cwd that resolves to $HOME) can't enumerate an entire home tree (#250).
// Generous — real projects are well under this; override for monorepos.
const DEFAULT_MAX_WORKSPACE_DIAGNOSTIC_FILES = 5000;

function getMaxWorkspaceDiagnosticFiles(): number {
	const override = Number.parseInt(
		process.env.PI_LENS_LSP_WORKSPACE_MAX_FILES ?? "",
		10,
	);
	return Number.isFinite(override) && override > 0
		? override
		: DEFAULT_MAX_WORKSPACE_DIAGNOSTIC_FILES;
}

/**
 * Async, event-loop-yielding walk of the workspace to find LSP-supported source
 * files. Uses `fs.promises.readdir` so each directory read hands control back to
 * the loop — a synchronous `readdirSync` recursion blocks the loop for the whole
 * O(N) enumeration (~44ms at 1.4k files, scaling linearly on monorepos).
 *
 * Directory/file exclusion goes through the SAME ignore matcher every other scan
 * surface uses: `isExcludedDirName` for default dependency/build dirs plus the
 * project's `.pi-lens.json` / `.gitignore` patterns via `getProjectIgnoreMatcher`.
 * Previously this walk used its own hardcoded skip-dir set, which silently
 * dropped user `"ignore": [...]` patterns and diverged from the canonical list
 * (#243). The walk is also hard-capped (#250).
 */
async function collectWorkspaceDiagnosticFiles(
	root: string,
	maxFiles: number = getMaxWorkspaceDiagnosticFiles(),
	signal?: AbortSignal,
	homeDir?: string,
): Promise<string[]> {
	const files: string[] = [];
	// #747/#250: the 5000-file cap alone bounds total work, but from a cwd at or
	// above $HOME the walk still traverses (and pulls diagnostics for) 5000 files
	// spread across every unrelated repo under home. Refuse outright — walking
	// nothing is the honest result; the caller (runWorkspaceDiagnostics →
	// tools/lens-diagnostics.ts) renders "unsafe root" so an empty sweep never
	// reads as a clean project. Same ceiling as fresh-fetch.ts / the cheap-tier
	// scanner.
	if (isAtOrAboveHomeDir(root, homeDir)) return files;
	const ignoreMatcher = getProjectIgnoreMatcher(root);
	// #703: prime the tracked-files set once before the walk so a tracked file
	// matching a `.gitignore`/global pattern still gets its workspace
	// diagnostics pulled. Fail-open on no-git/spawn failure.
	await ignoreMatcher.ensureTrackedIndex();
	async function walk(current: string): Promise<void> {
		if (signal?.aborted || files.length >= maxFiles) return;
		let entries: nodeFs.Dirent[];
		try {
			entries = await nodeFs.promises.readdir(current, {
				withFileTypes: true,
			});
		} catch {
			return;
		}
		for (const entry of entries) {
			if (signal?.aborted || files.length >= maxFiles) return;
			if (entry.isSymbolicLink()) continue;
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) {
				if (isExcludedDirName(entry.name)) continue;
				if (ignoreMatcher.isIgnored(full, true)) continue;
				await walk(full);
			} else if (
				// #1974: the getServersForFileWithConfig lookup (an in-memory
				// extension/pathFilter match against the registered LSP servers) is
				// cheap relative to isIgnored's per-call minimatch pattern compile,
				// so it gates first — the same order-independent shape as the four
				// walkers fixed for #1974.
				entry.isFile() &&
				getServersForFileWithConfig(full).length > 0 &&
				!ignoreMatcher.isIgnored(full, false)
			) {
				files.push(full);
			}
		}
	}
	await walk(root);
	return files;
}

// --- Service ---

export class LSPService {
	private readonly sessionCwd: string | undefined;
	private state: LSPState;
	private readonly workspaceProbeLogged = new Set<string>();
	/** Per-service immutable root-boundary verdicts; root detectors cache hits too. */
	private readonly projectBoundaryCache = new Map<string, Promise<boolean>>();
	/** Foreign roots are recorded once per normalized root for this service/session. */
	private readonly warmStartLogged = new Set<string>();
	private readonly optionalFailureLogged = new Set<string>();
	/** Server/root pairs that already emitted unavailable for the current occurrence. */
	private readonly unavailableLogged = new Set<string>();
	private readonly optionalDisabled = new Set<string>();
	/**
	 * #1934 review F1: what the last COMPLETED `spawnClient` call for a
	 * (server, root) key decided, written by that call at every point it
	 * returns without a client. This is a direct signal, deliberately NOT an
	 * inference from breaker state: the "binary unavailable while installs are
	 * disabled" branch sets a cooldown yet is a POLICY decline by its own
	 * comment, so reading the cooldown mislabels it as a server failure.
	 *
	 * Not a latch, and nothing re-arms it at `session_start`. Every read sits
	 * in the same microtask as the `await` of the spawn promise that just
	 * wrote it, so a stale entry is unreachable: a read is always preceded by
	 * its own attempt's write. Cardinality matches `state.clients` — one entry
	 * per (server, root) — and a successful spawn deletes its entry.
	 */
	private readonly lastSpawnVerdict = new Map<string, "failed" | "declined">();
	/** Consecutive failure counts for exponential backoff circuit breaker */
	private readonly failureCounts = new Map<string, number>();
	/**
	 * #1127: consecutive EARLY post-init runtime exits — a client that closed
	 * unexpectedly (not via our own `shutdown()`) with an uptime under
	 * {@link RUNTIME_EXIT_UPTIME_THRESHOLD_MS}. Tracked separately from
	 * {@link failureCounts} because a successful spawn/initialize clears that
	 * map (correct for the spawn/init failure class it was built for — see
	 * `spawnClient`'s success path) but is exactly the event a crash-loop
	 * server keeps producing right before it dies again; reusing the same map
	 * would make every respawn erase the streak the moment it re-spawned,
	 * which is the #1127 bug. This counter shares the SAME cooldown formula,
	 * the SAME `state.broken`/`permanentlyBroken` maps, and the SAME
	 * give-up-after-N-failures threshold as the spawn/init breaker — it is a
	 * parallel counter feeding one circuit, not a second mechanism.
	 */
	private readonly runtimeExitCounts = new Map<string, number>();
	/**
	 * #1142: rolling window of recent non-intentional death timestamps
	 * (`exitedAt`) per "serverId:root" key (the SAME identity as
	 * {@link runtimeExitCounts} and {@link LSPState.broken} — defect shape 1) —
	 * the SECOND, independent breaker trip condition that COMPOSES with the
	 * {@link runtimeExitCounts} fast path. That counter only sees CONSECUTIVE
	 * exits under the 60s threshold; a server that dies just PAST it every spawn
	 * resets that streak forever (#1142). This window trips when
	 * {@link RUNTIME_EXIT_WINDOW_TRIP_COUNT} deaths fall within
	 * {@link RUNTIME_EXIT_WINDOW_MS}, regardless of each death's lifetime.
	 *
	 * Bounded on BOTH axes (defect shape 9): entries older than the window are
	 * pruned on every record, AND the array is hard-capped at the trip count
	 * (drop-oldest) — a rate trip needs only the count within the window, never
	 * an unbounded history of timestamps. No timer backs it (defect shape 4): it
	 * ages purely by prune-on-check, so there is nothing to `unref()` or
	 * print-mode-gate. Like {@link runtimeExitCounts} it is a per-instance field,
	 * so a fresh `LSPService` (via `resetLSPService`) starts empty.
	 */
	private readonly runtimeExitWindow = new Map<string, number[]>();
	/** Server/root keys disabled for the rest of this session after repeated failures. */
	private readonly permanentlyBroken = new Set<string>();
	/**
	 * Last non-empty diagnostic result per normalized file path.
	 * Returned as a fallback when no live LSP clients are available so the
	 * widget keeps showing the last known issues rather than going blank.
	 */
	private readonly lastKnownDiagnostics = new Map<
		string,
		import("./client.js").LSPDiagnostic[]
	>();
	/**
	 * SHA-256 of the file content that produced the matching {@link
	 * lastKnownDiagnostics} entry, when that content is known (set by
	 * {@link touchFile}). Lets a hot-path consumer verify a cached entry is for
	 * the *current* bytes before trusting it as fresh — see
	 * {@link getLastKnownDiagnostics}. Absent for entries written without content
	 * (the service-level {@link getDiagnostics} merge), so a hash-guarded read of
	 * those falls through to a fresh check rather than serving a stale result.
	 */
	private readonly lastKnownContentHash = new Map<string, string>();
	/**
	 * #1783: what content actually landed on a language server, per document.
	 * The drift sweep compares disk (size, mtime) against these records and
	 * resynchronizes anything an untracked edit moved behind the server's back.
	 * See `document-drift.ts` for the key design and the pacing rules.
	 */
	private readonly documentDrift = new DocumentDriftTracker();
	/**
	 * #1095: lazily verifies a stored {@link DiagnosticBinding} against current
	 * disk bytes, memoizing the disk fingerprint per (file, mtime) so repeated
	 * binding reads across `touchFile`/`getAllDiagnostics` within a session don't
	 * re-hash unchanged files. Owned by the service so the memo is shared.
	 */
	private readonly diskBindingCache: DiskBindingCache =
		createDiskBindingCache();
	private readonly lastDiagnosticsHealth = new Map<
		string,
		LSPDiagnosticsHealth
	>();
	/**
	 * Touch-debounce record of "this server already has this content", keyed
	 * "normalizedFilePath:clientScope:serverId".
	 *
	 * #743/#1253: the serverId component is load-bearing. #1253 requires that a
	 * server whose notify write never landed does NOT get an entry (otherwise the
	 * next touch debounces the re-push and the silent-clean gates read its silence
	 * as a confirmed clean). #743 requires that one wedged server must not degrade
	 * its healthy siblings. A file-level key can only satisfy one of those at a
	 * time — per-server, both hold: the stalled server simply has no entry and is
	 * re-pushed, while every sibling whose write landed keeps its own debounce.
	 */
	private readonly recentTouches = new Map<
		string,
		{ fingerprint: string; touchedAt: number; clientScope: LSPTouchClientScope }
	>();
	/**
	 * #743: consecutive per-server notify-write timeout count, keyed by
	 * "serverId:normalizedRoot" — the SAME identity as {@link LSPState.broken}
	 * and {@link demonstratedReadyKeyFor}. A server that backpressures its stdin
	 * write {@link NOTIFY_BACKPRESSURE_BROKEN_AFTER} times in a row is demoted
	 * into the broken cooldown (see {@link recordNotifyWriteBackpressure}); any
	 * successful write clears its entry.
	 */
	private readonly notifyWriteBackpressureStreak = new Map<string, number>();
	/**
	 * #2358: EWMA of one auxiliary's per-document drain latency
	 * (ms per unacknowledged write), keyed by "serverId:normalizedRoot".
	 *
	 * Updated from DRAINED notify barriers only: the round-trip proves the
	 * server processed its `outstanding` backlog, and
	 * duration / outstanding is the per-write service time a single-threaded
	 * scanner actually achieves under load. The breaker grants a wedged write
	 * `k x ewma x unacked` of patience from it, so a slow-but-alive scanner is
	 * not killed at the fixed window by construction (#2358).
	 *
	 * Cleared by the service teardown (via `session_start`) like the rest of
	 * the breaker state; a stale throughput estimate from a previous session's
	 * client must not price the next one.
	 */
	private readonly auxNotifyDrainLatencyEwma = new Map<string, number>();
	/**
	 * #1714: unacknowledged auxiliary document notifies per server key
	 * ("serverId:normalizedRoot" — the same identity as every other gate here).
	 *
	 * `unacked` counts notifies ISSUED to this client that the server has not yet
	 * been proven to have PROCESSED. It rises with each write the sweep hands over
	 * and falls only when a drain barrier round-trips (see {@link paceAuxNotify}).
	 * `drain` holds the one in-flight barrier so a burst shares a single
	 * round-trip instead of each touch sending its own.
	 *
	 * `gateOpen` is the fail-open latch. A scanner that will not answer the
	 * barrier inside the caller's budget has stopped being a pacing problem and
	 * become a stall, which #743's write deadline, streak and wedge timer already
	 * own — and they own it by DEMOTING and respawning, which pacing can never do.
	 * Once latched, this gate steps aside for the rest of the client's life and
	 * every notify takes the pre-#1714 path. It re-arms on the only event that
	 * means the stall is over: a new client generation, which gets a new record.
	 *
	 * Cleared wholesale by the service teardown (`session_start` runs through it),
	 * by {@link demoteForNotifyStall}, and per key whenever the client identity
	 * changes, so no count can outlive the client it describes.
	 */
	private readonly auxNotifyInflight = new Map<
		string,
		{
			client: LSPClientInfo;
			unacked: number;
			drain?: Promise<boolean>;
			gateOpen?: boolean;
			/** One stalled record per barrier, however many waiters give up on it. */
			stallLogged?: boolean;
		}
	>();
	/**
	 * #1459: the ONE outstanding auxiliary notify write per server key
	 * ("serverId:normalizedRoot"). A `reopenOnResync` scanner re-parses the whole
	 * file on every `didOpen`, so a `clientScope: "all"` sweep that fans out
	 * across a neighbour set pushes N full re-scans at it inside a few
	 * milliseconds; its stdin stops draining and the #743 write deadline expires
	 * for each one, which walked the breaker open in three touches. The gate keeps
	 * a sweep to one in-flight resync per auxiliary: while one is outstanding the
	 * next touch DEFERS its write and reports the server as uncovered instead of
	 * adding to the flood. `startedAt` dates the outstanding write so a write that
	 * never lands is still demoted (see {@link demoteForNotifyStall}).
	 */
	private readonly outstandingAuxNotifyWrites = new Map<
		string,
		OutstandingAuxNotifyWrite
	>();
	/**
	 * #2356: auxiliary clients removed by the notify-stall breaker are a
	 * temporary absence, not a missing scanner. Keep the demotion identity after
	 * deleting the client so the turn-end late-coverage probe can re-arm the
	 * pending pair until a replacement is published (or its existing bounded
	 * re-arm ceiling is reached). A successful replacement removes the marker.
	 */
	private readonly notifyStallDemotions = new Map<string, number>();
	private static readonly MAX_NOTIFY_STALL_DEMOTIONS = 50;
	/** LRU clock for capacity eviction, keyed by the canonical server/root key. */
	private readonly clientLastUsedAt = new Map<string, number>();
	/**
	 * Manager-owned use leases close the acquisition/use gap that `isBusy()`
	 * cannot see: a caller may hold a selected client before its first request has
	 * entered the client. Eviction skips any key with an outstanding lease.
	 */
	private readonly clientLeases = new Map<string, number>();
	/**
	 * Per-root idle eviction for TypeScript's large, rebuildable program graph.
	 * Timers are unref'd so an idle language service cannot keep a one-shot host
	 * alive, and are removed before shutdown so a concurrent request rebuilds
	 * instead of receiving the retiring client.
	 */
	private readonly typeScriptIdleTimers = new Map<
		string,
		ReturnType<typeof setTimeout>
	>();
	/** Serializes capacity decisions with publication into `state.inFlight`. */
	private clientSpawnGate: Promise<void> = Promise.resolve();
	/** True after shutdown() has been called; blocks new operations */
	private isDestroyed = false;
	/**
	 * #850: teardown completion for every singleton generation retired before
	 * this service was published. Only replacement services receive one; direct
	 * `new LSPService()` callers and the first singleton generation stay hot-path
	 * identical. Cleared after the first completed wait so warm reuse never pays
	 * a permanent promise/microtask tax.
	 */
	private generationHandoff: Promise<void> | undefined;

	constructor(generationHandoff?: Promise<void>, sessionCwd?: string) {
		this.generationHandoff = generationHandoff;
		this.sessionCwd = sessionCwd;
		this.state = {
			clients: new Map(),
			servers: new Map(),
			broken: new Map(),
			inFlight: new Map(),
			clientSpawnedAt: new Map(),
			demonstratedReady: new Set(),
			demonstratedCold: new Set(),
		};
	}

	/**
	 * Resolve one server's client identity root. Root selection is hard-bounded
	 * by the session cwd, then config-only nested roots reuse an already-hosted
	 * same-server ancestor. Real nested projects retain independent clients.
	 */
	private async resolveServerRoot(
		server: LSPServerInfo,
		filePath: string,
	): Promise<string | undefined> {
		const candidate = await server.root(filePath);
		if (!candidate) return undefined;
		// #2052: a file outside EVERY initialized session cwd gets no client at
		// all. The ceiling below is unchanged (`process.cwd()`, as before this
		// issue) and still only clamps files that are actually inside it —
		// `enforceLspRootCeiling` returns the root untouched for an out-of-ceiling
		// file. So this gate is the ONLY new refusal, and it consults the
		// registry, not a single cwd.
		if (isOutsideAllSessionRoots(filePath)) return undefined;
		const root = enforceLspRootCeiling(candidate, process.cwd(), filePath);
		if (normalizeMapKey(root) === normalizeMapKey(process.cwd())) return root;

		const rootKey = normalizeMapKey(root);
		const prefix = `${server.id}:`;
		let nearestAncestor: string | undefined;
		for (const key of new Set([
			...this.state.clients.keys(),
			...this.state.inFlight.keys(),
		])) {
			if (!key.startsWith(prefix)) continue;
			const ancestorKey = key.slice(prefix.length);
			const pathApi =
				isWindowsPath(ancestorKey) || isWindowsPath(rootKey)
					? path.win32
					: path;
			const relative = pathApi.relative(ancestorKey, rootKey);
			if (
				relative === "" ||
				relative.startsWith("..") ||
				pathApi.isAbsolute(relative)
			) {
				continue;
			}
			if (!nearestAncestor || ancestorKey.length > nearestAncestor.length) {
				nearestAncestor = ancestorKey;
			}
		}
		if (!nearestAncestor) return root;
		let boundary = this.projectBoundaryCache.get(rootKey);
		if (!boundary) {
			boundary = hasProjectBoundaryMarker(root);
			this.projectBoundaryCache.set(rootKey, boundary);
		}
		if (await boundary) return root;
		return (
			this.state.clients.get(`${server.id}:${nearestAncestor}`)?.root ??
			nearestAncestor
		);
	}

	/** Guard: return true if service is shutting down or shut down */
	private checkDestroyed(): boolean {
		return this.isDestroyed;
	}

	private async withClientSpawnGate<T>(
		operation: () => Promise<T>,
	): Promise<T> {
		const previous = this.clientSpawnGate;
		let release!: () => void;
		this.clientSpawnGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await operation();
		} finally {
			release();
		}
	}

	private async clientKeyFor(
		entry: SpawnedServer,
		filePath: string,
	): Promise<string | undefined> {
		const root = await this.resolveServerRoot(entry.info, filePath);
		return root ? `${entry.info.id}:${normalizeMapKey(root)}` : undefined;
	}

	private async acquireClientLease(
		entry: SpawnedServer,
		filePath: string,
	): Promise<string | undefined> {
		const key = await this.clientKeyFor(entry, filePath);
		if (!key) return undefined;
		return this.withClientSpawnGate(async () => {
			if (this.isDestroyed || this.state.clients.get(key) !== entry.client) {
				return undefined;
			}
			this.clientLeases.set(key, (this.clientLeases.get(key) ?? 0) + 1);
			return key;
		});
	}

	private async acquireClientLeases(
		entries: readonly SpawnedServer[],
		filePath: string,
	): Promise<string[] | undefined> {
		const keys = await Promise.all(
			entries.map((entry) => this.clientKeyFor(entry, filePath)),
		);
		if (keys.some((key) => key === undefined)) return undefined;
		const keyed = entries.map(
			(entry, index) => [keys[index] as string, entry] as const,
		);
		return this.withClientSpawnGate(async () => {
			if (
				this.isDestroyed ||
				keyed.some(
					([key, entry]) => this.state.clients.get(key) !== entry.client,
				)
			) {
				return undefined;
			}
			for (const [key] of keyed) {
				this.clientLeases.set(key, (this.clientLeases.get(key) ?? 0) + 1);
			}
			return keyed.map(([key]) => key);
		});
	}

	private releaseClientLease(key: string): void {
		const remaining = (this.clientLeases.get(key) ?? 1) - 1;
		if (remaining > 0) {
			this.clientLeases.set(key, remaining);
			return;
		}
		this.clientLeases.delete(key);
		if (this.state.clients.has(key)) {
			this.clientLastUsedAt.set(key, Date.now());
			this.scheduleTypeScriptIdleEviction(key);
		}
	}

	private async withClientForFileUse<T>(
		filePath: string,
		maxWaitMs: number | undefined,
		hardCapMs: number | undefined,
		use: (entry: SpawnedServer) => Promise<T> | T,
	): Promise<T | undefined> {
		while (!this.isDestroyed) {
			const entry = await this.getClientForFile(filePath, maxWaitMs, hardCapMs);
			if (!entry) return undefined;
			const leaseKey = await this.acquireClientLease(entry, filePath);
			if (!leaseKey) continue;
			try {
				return await use(entry);
			} finally {
				this.releaseClientLease(leaseKey);
			}
		}
		return undefined;
	}

	private async makeCapacityForClient(key: string): Promise<boolean> {
		const occupiedKeys = new Set(this.state.inFlight.keys());
		for (const [clientKey, client] of this.state.clients) {
			if (client.isAlive()) occupiedKeys.add(clientKey);
		}
		const occupied = occupiedKeys.size;
		if (occupied < getLspClientCeiling()) return true;

		const idle = [...this.state.clients.entries()]
			.filter(
				([candidateKey, client]) =>
					candidateKey !== key &&
					client.isAlive() &&
					client.isBusy?.() !== true &&
					(this.clientLeases.get(candidateKey) ?? 0) === 0,
			)
			.sort(
				([a], [b]) =>
					(this.clientLastUsedAt.get(a) ??
						this.state.clientSpawnedAt.get(a) ??
						0) -
					(this.clientLastUsedAt.get(b) ??
						this.state.clientSpawnedAt.get(b) ??
						0),
			);
		const victim = idle[0];
		if (!victim) {
			logSessionStart(
				`lsp client ceiling ${getLspClientCeiling()}: spawn declined; all clients are in use`,
			);
			return false;
		}

		const [victimKey, victimClient] = victim;
		this.releaseOutstandingAuxNotifyWrite(victimKey);
		await victimClient.shutdown({ reason: "client_ceiling_lru" });
		this.state.clients.delete(victimKey);
		this.state.clientSpawnedAt.delete(victimKey);
		this.state.demonstratedReady.delete(victimKey);
		this.state.demonstratedCold.delete(victimKey);
		this.clientLastUsedAt.delete(victimKey);
		this.clearTypeScriptIdleTimer(victimKey);
		logSessionStart(
			`lsp client ceiling ${getLspClientCeiling()}: evicted idle LRU ${victimKey}`,
		);
		return true;
	}

	private clearTypeScriptIdleTimer(key: string): void {
		const timer = this.typeScriptIdleTimers.get(key);
		if (timer) clearTimeout(timer);
		this.typeScriptIdleTimers.delete(key);
	}

	/** Release a notify token and its timer when its client generation retires. */
	private releaseOutstandingAuxNotifyWrite(
		key: string,
		token?: OutstandingAuxNotifyWrite,
	): void {
		const current = this.outstandingAuxNotifyWrites.get(key);
		if (!current || (token !== undefined && current !== token)) return;
		clearTimeout(current.wedgeTimer);
		this.outstandingAuxNotifyWrites.delete(key);
		current.resolveSettled();
	}

	private scheduleTypeScriptIdleEviction(key: string): void {
		if (!key.startsWith("typescript:")) return;
		// Pressure-gating these timers would require a separate reconciliation pass
		// when the manager crosses the threshold; keep ownership simple and use the
		// warm-LSP-friendly 20-minute default instead.
		this.clearTypeScriptIdleTimer(key);
		const lastUsedAt = this.clientLastUsedAt.get(key) ?? Date.now();
		const timer = setTimeout(() => {
			this.typeScriptIdleTimers.delete(key);
			void this.withClientSpawnGate(async () => {
				if (this.isDestroyed) return;
				const client = this.state.clients.get(key);
				if (!client?.isAlive()) return;
				if (
					client.isBusy?.() === true ||
					(this.clientLeases.get(key) ?? 0) > 0 ||
					(this.clientLastUsedAt.get(key) ?? 0) !== lastUsedAt
				) {
					this.scheduleTypeScriptIdleEviction(key);
					return;
				}

				// Publish the cold state synchronously before awaiting teardown. A request
				// arriving while shutdown is in progress therefore waits on the spawn gate
				// and creates a fresh client; it can never receive this retiring one.
				this.releaseOutstandingAuxNotifyWrite(key);
				this.state.clients.delete(key);
				this.state.clientSpawnedAt.delete(key);
				this.state.demonstratedReady.delete(key);
				this.state.demonstratedCold.delete(key);
				this.clientLastUsedAt.delete(key);
				try {
					await client.shutdown({ reason: "typescript_idle_eviction" });
				} catch {
					// The strong manager reference is already gone; shutdown is best-effort
					// like the other eviction paths and must not reject from a timer callback.
				}
				logSessionStart(`lsp typescript idle eviction: released ${key}`);
				recordDegradation({
					kind: "ts-idle-eviction",
					subject: key,
					reason: "idle TypeScript client released to bound memory",
				});
			}).catch(() => {});
		}, getTypeScriptIdleEvictMs());
		timer.unref?.();
		this.typeScriptIdleTimers.set(key, timer);
	}

	private fingerprintContent(content: string): string {
		if (content.length <= 96) {
			return `${content.length}:${content}`;
		}
		return `${content.length}:${content.slice(0, 48)}:${content.slice(-48)}`;
	}

	/**
	 * Should the whole touchFile call short-circuit? Only when the caller does
	 * NOT need diagnostics — those callers still need to wait for the LSP to
	 * publish, even if the notify itself is a no-op.
	 */
	private shouldSkipTouch(
		filePath: string,
		content: string,
		clientScope: LSPTouchClientScope,
		waitForDiagnostics: boolean,
		serverIds: readonly string[],
	): boolean {
		if (waitForDiagnostics) return false;
		// #743: only short-circuit the whole call when EVERY spawned server already
		// has this content. If even one still needs the push, fall through — the
		// write loop skips the servers that are covered and pushes only the rest.
		if (serverIds.length === 0) return false;
		return serverIds.every((serverId) =>
			this.shouldSkipNotify(filePath, content, clientScope, serverId),
		);
	}

	/**
	 * Should the didOpen/didChange notify be skipped while keeping the
	 * waitForDiagnostics step? True when the same content was already pushed
	 * recently. Skipping the notify avoids the diagnostic-cache clear that
	 * notify.open does, so the LSP doesn't restart computation it already
	 * finished for the first push.
	 *
	 * Concretely: the post-write tool_result fires touchFile with
	 * diagnosticsMode="none" first; the dispatch-lsp-runner fires it again
	 * with diagnosticsMode="document" moments later. Without this check the
	 * second call's notify clears in-progress diagnostics and the LSP has to
	 * start over — observed as multi-second waits on slow TS projects.
	 *
	 * Decided PER SERVER (#743): a sibling's stalled write must not cost this
	 * server its debounce. See {@link recentTouches}.
	 */
	private shouldSkipNotify(
		filePath: string,
		content: string,
		clientScope: LSPTouchClientScope,
		serverId: string,
	): boolean {
		if (TOUCH_DEBOUNCE_MS <= 0) return false;
		const previous = this.recentTouches.get(
			this.recentTouchKey(filePath, clientScope, serverId),
		);
		if (!previous) return false;
		const now = Date.now();
		if (now - previous.touchedAt > TOUCH_DEBOUNCE_MS) return false;
		return previous.fingerprint === this.fingerprintContent(content);
	}

	private recentTouchKey(
		filePath: string,
		clientScope: LSPTouchClientScope,
		serverId: string,
	): string {
		return `${normalizeMapKey(filePath)}:${clientScope}:${serverId}`;
	}

	private markTouched(
		filePath: string,
		content: string,
		clientScope: LSPTouchClientScope,
		serverId: string,
	): void {
		const key = this.recentTouchKey(filePath, clientScope, serverId);
		const now = Date.now();
		this.recentTouches.set(key, {
			fingerprint: this.fingerprintContent(content),
			touchedAt: now,
			clientScope,
		});
		// Trim entries that are already past the debounce window — shouldSkipTouch
		// ignores them anyway, so they serve no purpose. Only sweep when the map
		// exceeds the threshold to avoid iterating on every call. The threshold is
		// per-ENTRY and entries are now per-server, so it is scaled up to keep the
		// same effective file capacity a file-level key gave a multi-server scope.
		if (this.recentTouches.size > 800) {
			for (const [k, v] of this.recentTouches) {
				if (now - v.touchedAt > TOUCH_DEBOUNCE_MS) {
					this.recentTouches.delete(k);
				}
			}
		}
	}

	/**
	 * Key `demonstratedReady`/`clientSpawnedAt`/`state.clients` all share:
	 * "serverId:normalizedRoot" — the same identity `ensureClientForServer`
	 * uses to store/look up a client. Deliberately resolved from the
	 * `LSPServerInfo.root()` config resolver (NOT `LSPClientInfo.root`):
	 * `touchFile`'s spawned entries carry both `{ client, info }`, and
	 * resolving from `info.root()` guarantees this lines up with
	 * `ensureWarmForSweep`'s own key derivation (also via `server.root()`)
	 * even for a not-fully-real client (test fixture, or any future client
	 * implementation that doesn't independently stamp `.root`).
	 */
	private async demonstratedReadyKeyFor(
		server: LSPServerInfo,
		filePath: string,
	): Promise<string | undefined> {
		const root = await this.resolveServerRoot(server, filePath);
		if (!root) return undefined;
		return `${server.id}:${normalizeMapKey(root)}`;
	}

	private markDemonstratedReadyKey(key: string): void {
		this.state.demonstratedReady.add(key);
		// #799: readiness through ANY path supersedes an earlier cold verdict —
		// a server that recovers later in the session must not stay stuck in
		// the negative cache.
		this.state.demonstratedCold.delete(key);
	}

	private recordBreaker(key: string, reason: string): void {
		recordDegradationOnce({ kind: "lsp-breaker", subject: key, reason });
	}

	/**
	 * #743: record one notify-write timeout for a server and, once it has stalled
	 * {@link NOTIFY_BACKPRESSURE_BROKEN_AFTER} times in a row, demote it through
	 * the EXISTING broken-cooldown map so subsequent sweeps stop re-paying its
	 * notify budget on every file. The wedged client is also evicted: an alive
	 * client is reused before the broken check in {@link ensureClientForServer},
	 * so the cooldown only bites once the stale client is gone. `key` is
	 * "serverId:normalizedRoot" (the broken-map identity); undefined when the
	 * server's root could not be resolved, in which case there is nothing to key.
	 */
	private recordNotifyWriteBackpressure(
		key: string | undefined,
		entry: SpawnedServer,
		filePath: string,
	): void {
		if (!key) return;
		const streak = (this.notifyWriteBackpressureStreak.get(key) ?? 0) + 1;
		if (streak < NOTIFY_BACKPRESSURE_BROKEN_AFTER) {
			this.notifyWriteBackpressureStreak.set(key, streak);
			return;
		}
		this.notifyWriteBackpressureStreak.delete(key);
		// #2358: the consecutive-timeout ladder lands here too, and its verdict
		// must not kill a server that is demonstrably BUSY. The guarded demotion
		// samples the live process CPU and merely resets the ladder (the next
		// three timeouts re-try) when the server is progressing — the wedged-write
		// path's cap owns a busy-but-never-draining server, not this streak.
		void this.demoteNotifyStallCpuGuarded(key, entry, filePath, {
			consecutiveTimeouts: NOTIFY_BACKPRESSURE_BROKEN_AFTER,
		});
	}

	/**
	 * #2358: liveness-guarded teardown for the STREAK ladder.
	 *
	 * The wedged-write path ({@link decideNotifyStallTeardown}) keeps its own
	 * re-arm loop so a busy server's outstanding write stays un-torn-down; the
	 * streak ladder has no write to hold — it simply does not demote, and the
	 * next three timeouts re-attempt. Generation-guarded after the await so a
	 * client replaced mid-sample is never demoted for a verdict about its
	 * predecessor.
	 */
	private async demoteNotifyStallCpuGuarded(
		key: string,
		entry: SpawnedServer,
		filePath: string,
		reason: { consecutiveTimeouts: number },
	): Promise<void> {
		if (this.state.clients.get(key) !== entry.client) return;
		// The CPU verdict is asynchronous, but the streak has already committed to
		// this client's teardown path. Release the TypeScript idle-timer ownership
		// before sampling so another idle callback cannot target the same client
		// while the verdict is in flight. A BUSY verdict below re-arms a fresh timer.
		this.clearTypeScriptIdleTimer(key);
		const verdict = await this.notifyStallCpuVerdict(entry);
		if (verdict.cpuVerdict === "busy") {
			if (this.state.clients.get(key) === entry.client) {
				this.scheduleTypeScriptIdleEviction(key);
			}
			this.logNotifyStallCpuBusy(key, entry, filePath, 0, verdict);
			return;
		}
		if (this.state.clients.get(key) !== entry.client) return;
		this.demoteForNotifyStall(key, entry, filePath, {
			...reason,
			discriminator: "consecutive-timeouts",
			cpuVerdict: verdict.cpuVerdict,
		});
	}

	/**
	 * #2358: classify a stalled server's live process CPU.
	 *
	 * A client with no process handle (a test/mock double, a legacy client)
	 * reports "unmeasured" — the caller keeps the pre-#2358 demote-at-budget
	 * behavior, because there is no liveness evidence to override it. A sampled
	 * process that burns a core is BUSY; anything else is FLAT, including a
	 * query that failed to resolve the pid — a server we cannot measure is not
	 * proven busy, and the replacement self-heal is cheap.
	 */
	private async notifyStallCpuVerdict(entry: SpawnedServer): Promise<{
		cpuVerdict: "busy" | "flat" | "unmeasured";
		cpuPercent: number | null;
	}> {
		const pid = entry.client.getProcessPid?.();
		if (pid === undefined || !(Number.isFinite(pid) && pid > 0)) {
			return { cpuVerdict: "unmeasured", cpuPercent: null };
		}
		const sample = await sampleProcessTreeCpuPercent(
			pid,
			notifyStallCpuSampleMs(),
			NOTIFY_STALL_CPU_BUSY_FLOOR_PERCENT,
		);
		if (!sample.measured) {
			return { cpuVerdict: "unmeasured", cpuPercent: null };
		}
		if (sample.busy) {
			return { cpuVerdict: "busy", cpuPercent: sample.cpuPercent };
		}
		return { cpuVerdict: "flat", cpuPercent: sample.cpuPercent };
	}

	/**
	 * #2358: one bounded row per busy defer. Not a failure record — the
	 * discrimination succeeded — so it is a plain latency phase; its volume is
	 * bounded by the re-arm cadence of one outstanding write (at most the wedge
	 * cap divided by the budget, ~6 fires at defaults).
	 */
	private logNotifyStallCpuBusy(
		key: string,
		entry: SpawnedServer,
		filePath: string,
		outstandingMs: number,
		verdict: { cpuPercent: number | null },
		extra: { budgetMs?: number } = {},
	): void {
		emitBounded(
			"lsp_notify_stall_cpu_busy",
			`${key}:${normalizeMapKey(filePath)}`,
			{
				type: "phase",
				durationMs: outstandingMs,
				metadata: {
					serverId: entry.info.id,
					clientKey: key,
					outstandingMs,
					cpuPercent: verdict.cpuPercent ?? null,
					...extra,
				},
			},
			{
				ledgerKind: "lsp-notify-stall-cpu-busy",
				risingEdgePer: "identity",
			},
		);
	}

	/**
	 * #2358: the patience window a wedged auxiliary write earns.
	 *
	 * max(fixed floor, k x EWMA per-write latency x unacked depth), capped so a
	 * busy-but-never-draining server still respawns within the cap. The EWMA
	 * comes from DRAINED notify barriers (see {@link noteAuxNotifyDrainLatency});
	 * with no history the fixed floor (the pre-#2358 window) stands.
	 */
	private auxNotifyWedgeBudgetMs(key: string): number {
		let budgetMs = notifyWedgedMs();
		const ewma = this.auxNotifyDrainLatencyEwma.get(key);
		if (ewma !== undefined && ewma > 0) {
			const unacked = this.auxNotifyInflight.get(key)?.unacked ?? 0;
			budgetMs = Math.max(
				budgetMs,
				NOTIFY_WEDGED_EWMA_MULTIPLIER * ewma * unacked,
			);
		}
		return Math.min(budgetMs, notifyWedgedCapMs());
	}

	/**
	 * The demotion itself, shared by the #743 consecutive-timeout streak and the
	 * #1459 wedged-write rule. Both mean the same thing — this client's input path
	 * is not moving — and both need the same teardown.
	 */
	private demoteForNotifyStall(
		key: string,
		entry: SpawnedServer,
		filePath: string,
		reason: NotifyStallDemotionReason,
	): void {
		// An async verdict belongs to one client generation. Never let a
		// predecessor's decision delete or cool down its replacement.
		if (this.state.clients.get(key) !== entry.client) return;
		this.notifyWriteBackpressureStreak.delete(key);
		this.releaseOutstandingAuxNotifyWrite(key);
		// #1714: the demoted client is torn down, so its backlog count describes a
		// process that no longer exists. Leaving it would make the replacement start
		// at the ceiling and pay a barrier on its first file.
		this.auxNotifyInflight.delete(key);
		this.state.broken.set(key, Date.now() + BROKEN_BASE_COOLDOWN_MS);
		this.notifyStallDemotions.set(key, Date.now());
		while (
			this.notifyStallDemotions.size > LSPService.MAX_NOTIFY_STALL_DEMOTIONS
		) {
			const oldest = this.notifyStallDemotions.keys().next().value;
			if (oldest === undefined) break;
			this.notifyStallDemotions.delete(oldest);
		}
		void entry.client.shutdown().catch(() => {});
		this.state.clients.delete(key);
		this.state.clientSpawnedAt.delete(key);
		this.state.demonstratedReady.delete(key);
		this.clientLastUsedAt.delete(key);
		this.clearTypeScriptIdleTimer(key);
		logLatency({
			type: "phase",
			phase: "lsp_notify_backpressure_broken",
			filePath: normalizeMapKey(filePath),
			durationMs: 0,
			metadata: {
				serverId: entry.info.id,
				cooldownMs: BROKEN_BASE_COOLDOWN_MS,
				...reason,
			},
		});
	}

	/**
	 * #1459: the caller's write deadline is a LATENCY bound, not a health verdict.
	 * A scanner whose `didOpen` lands a second after we stopped waiting is slow,
	 * not broken, so its late success retracts the timeout it was charged for.
	 * Without this, three slow-but-healthy scans in a row opened the breaker and
	 * blacked out the security lane for 15 s.
	 */
	private retractNotifyWriteBackpressure(
		key: string,
		serverId: string,
		filePath: string,
		outstandingMs: number,
		client: LSPClientInfo,
	): void {
		// Generation-checked, exactly like the gate: a predecessor's late landing
		// must not decrement its SUCCESSOR's streak and mask a real stall.
		if (this.state.clients.get(key) !== client) return;
		const streak = this.notifyWriteBackpressureStreak.get(key);
		if (!streak) return;
		const streakAfter = streak - 1;
		if (streakAfter <= 0) this.notifyWriteBackpressureStreak.delete(key);
		else this.notifyWriteBackpressureStreak.set(key, streakAfter);
		logLatency({
			type: "phase",
			phase: "lsp_notify_write_late_landed",
			filePath: normalizeMapKey(filePath),
			durationMs: outstandingMs,
			metadata: { serverId, outstandingMs, streakAfter },
		});
	}

	/**
	 * #1714: record that one more document notify went to this auxiliary.
	 *
	 * Counted at ISSUE time, not on the write's settle: the backlog the sweep
	 * builds is what the server still has to read, and a write that has not landed
	 * yet is part of it. A client-identity change resets the count, because a
	 * respawned server carries none of its predecessor's backlog.
	 */
	private noteAuxNotifyIssued(key: string, client: LSPClientInfo): void {
		const record = this.auxNotifyInflight.get(key);
		if (record && record.client === client) {
			record.unacked += 1;
			return;
		}
		this.auxNotifyInflight.set(key, { client, unacked: 1 });
	}

	/**
	 * #2358: fold one DRAINED notify barrier's per-write latency into the
	 * per-key EWMA. A drained round-trip proves the server processed its
	 * `outstanding` backlog after the ping; duration / outstanding is the
	 * per-document service time the single-threaded scanner actually achieves
	 * under load, which is exactly what a busy-server patience window must be
	 * priced from (#2358's evidence: an 855 ms per-answer server with an
	 * 8-write backlog, able to drain in 10-20 s while healthy).
	 */
	private noteAuxNotifyDrainLatency(
		key: string,
		durationMs: number,
		outstanding: number,
		record?: { client: LSPClientInfo },
	): void {
		if (!(outstanding > 0 && durationMs > 0)) return;
		if (record && this.auxNotifyInflight.get(key) !== record) return;
		const perWriteMs = durationMs / outstanding;
		const prev = this.auxNotifyDrainLatencyEwma.get(key);
		this.auxNotifyDrainLatencyEwma.set(
			key,
			prev === undefined ? perWriteMs : 0.5 * perWriteMs + 0.5 * prev,
		);
	}

	/**
	 * #2358: decide whether a wedged notify write's teardown really fires.
	 *
	 * Before #2358 the breaker killed a server whose write stayed outstanding
	 * past a FIXED window, conflating a dead input path with a busy scanner
	 * draining a burst — the live opengrep kill at #2358's head. The decision
	 * now has two guards, and the record names which one fired:
	 *
	 * - the window is ADAPTIVE — max(fixed floor, k x EWMA per-write latency x
	 *   unacked depth), capped at {@link notifyWedgedCapMs} — so a server that
	 *   historically answers in 855 ms with 8 writes queued earns 13.7 s (k=2),
	 *   not 10 s;
	 * - past the window, the server's process CPU is sampled twice; a BUSY
	 *   server is left alone (the write stays outstanding and the caller re-arms
	 *   this timer), a FLAT or unmeasured one is torn down.
	 *
	 * The hard cap still kills: a busy server that cannot drain inside it is
	 * damaged, and the replacement is the self-heal the breaker exists to
	 * provide.
	 */
	private async decideNotifyStallTeardown(
		key: string,
		entry: SpawnedServer,
		filePath: string,
		token: OutstandingAuxNotifyWrite,
	): Promise<
		| { action: "demote"; reason: NotifyStallDemotionReason }
		| { action: "rearm"; budgetMs: number }
	> {
		if (
			this.state.clients.get(key) !== entry.client ||
			this.outstandingAuxNotifyWrites.get(key) !== token
		) {
			throw new Error("stale notify generation");
		}
		const outstandingMs = Date.now() - token.startedAt;
		const armedBudgetMs = token.armedBudgetMs;
		if (outstandingMs >= notifyWedgedCapMs()) {
			return {
				action: "demote",
				reason: {
					outstandingMs,
					discriminator: "cap-exceeded",
					budgetMs: armedBudgetMs,
				},
			};
		}
		const verdict = await this.notifyStallCpuVerdict(entry);
		if (
			this.state.clients.get(key) !== entry.client ||
			this.outstandingAuxNotifyWrites.get(key) !== token
		) {
			throw new Error("stale notify generation");
		}
		if (verdict.cpuVerdict === "busy") {
			this.logNotifyStallCpuBusy(key, entry, filePath, outstandingMs, verdict, {
				budgetMs: armedBudgetMs,
			});
			return { action: "rearm", budgetMs: this.auxNotifyWedgeBudgetMs(key) };
		}
		return {
			action: "demote",
			reason: {
				outstandingMs,
				discriminator:
					verdict.cpuVerdict === "unmeasured"
						? "budget-exceeded"
						: "budget-exceeded-cpu-flat",
				budgetMs: armedBudgetMs,
				ewmaInputMs: this.auxNotifyDrainLatencyEwma.get(key),
				unackedDepth: this.auxNotifyInflight.get(key)?.unacked ?? 0,
				cpuVerdict: verdict.cpuVerdict,
				cpuPercent: verdict.cpuPercent ?? null,
			},
		};
	}

	/**
	 * #1714: is this auxiliary already holding as many documents as it may?
	 *
	 * Read by the sweep's PRE-OPEN pass, which writes `didOpen` directly instead
	 * of going through `touchFile` and so meets neither the #1459 slot gate nor
	 * the drain barrier. Pre-opening is explicitly best-effort — the file's own
	 * `touchFile` opens it a moment later, through the barrier — so a backlogged
	 * scanner is simply left out of the warm-up burst rather than handed a second
	 * copy of every file in the chunk.
	 */
	private auxNotifyBacklogAtCeiling(
		key: string,
		entry: SpawnedServer,
	): boolean {
		const record = this.auxNotifyInflight.get(key);
		if (!record || record.client !== entry.client) return false;
		// Latched open: this scanner is a stall, not a pacing problem, and the
		// breaker owns it. Step aside here too rather than half-throttling it.
		if (record.gateOpen) return false;
		return record.unacked >= auxNotifyInflightLimit(entry.info);
	}

	/**
	 * #1714: hold the next notify until this auxiliary has proven it PROCESSED the
	 * ones already sent. Returns when the caller may write — it never refuses.
	 *
	 * Under the limit there is nothing to prove, so the common case returns without
	 * awaiting anything and the sweep runs at full speed. At the limit the gate
	 * sends ONE request round-trip (`pingLiveness`, #1277,
	 * clients/lsp/client.ts:2577).
	 *
	 * WHY A REPLY PROVES PROCESSING, measured rather than assumed. ast-grep-lsp is
	 * tower-lsp-server and drains its message stream in order on one task, so a
	 * request written after N `didOpen`s is answered after those N are scanned.
	 * Live probe against the real binary, 30 real repository files:
	 *
	 *   idle `workspace/symbol` reply        0 ms
	 *   after 30 didOpens                 2263 ms, 29 of 30 publishes already in
	 *   all 30 processed                  2330 ms
	 *
	 *   idle `textDocument/hover` reply      1 ms
	 *   after 30 didOpens                 2086 ms, 29 of 30 publishes already in
	 *
	 * Idle-zero to loaded-seconds, landing within one document of the whole
	 * backlog, is the ordering property this gate needs; one document of slack is
	 * immaterial against a ceiling of 4 to 8.
	 *
	 * A server that answered requests off a SEPARATE task would not give this
	 * proof. What keeps that server safe is NOT the fail-open latch below: the
	 * latch never arms for it. Such a server answers the barrier instantly,
	 * `unacked` resets, and the gate stays inert for the whole sweep. Safety comes
	 * from the outcome that inertness produces — the notify sequence is exactly
	 * the pre-#1714 one, and #743's write deadline, backpressure streak and wedge
	 * timer own the stall the same way they did before this change. The throttle
	 * buys such a server nothing; it also costs it nothing.
	 *
	 * The wait is bounded by the CALLER's remaining budget, never by a schedule of
	 * its own: every waiter gives the shared round-trip only `waitMs`, so a caller
	 * that asked for a 1 s touch still gets one.
	 *
	 * A waiter whose budget runs out does NOT defer the file. It latches the gate
	 * open and falls through to the write. Pacing exists to stop a healthy-but-slow
	 * scanner drowning; a scanner that will not answer at all is a stall, and #743's
	 * write deadline, backpressure streak and wedge timer already own that case —
	 * they demote and respawn it, which is the self-heal that recovered the live
	 * session. Deferring instead withheld the write, accrued no strike, and left
	 * the sweep with no exit.
	 *
	 * Fails OPEN for a client with no liveness round-trip: unmeasurable is not the
	 * same as backlogged, and the codebase already reads this capability as
	 * `pingLiveness?.() ?? true` (clients/lsp/client.ts:281). Every real client
	 * provides it.
	 */
	private async paceAuxNotify(
		key: string,
		entry: SpawnedServer,
		filePath: string,
		waitMs: number,
		context: { source: string; clientScope: LSPTouchClientScope },
	): Promise<void> {
		const record = this.auxNotifyInflight.get(key);
		if (!record) return;
		if (record.client !== entry.client) {
			// A previous generation's backlog says nothing about this client.
			this.auxNotifyInflight.delete(key);
			return;
		}
		// Already handed to the breaker: no barrier, no wait, no extra cost per
		// file. This is what stops a stalled scanner turning every remaining file
		// into a fresh full-budget wait.
		if (record.gateOpen) return;
		const limit = auxNotifyInflightLimit(entry.info);
		if (record.unacked < limit) return;
		const ping = entry.client.pingLiveness;
		if (!ping) {
			record.unacked = 0;
			return;
		}
		if (waitMs <= 0) {
			this.openAuxNotifyGate(key, entry, filePath, context, {
				unacked: record.unacked,
				limit,
				waitMs,
				durationMs: 0,
			});
			return;
		}
		if (!record.drain) {
			const startedAt = Date.now();
			const outstanding = record.unacked;
			const client = entry.client;
			const barrier = (async (): Promise<boolean> => {
				let drained = false;
				try {
					drained = await ping.call(client, waitMs);
				} catch {
					// A ping that throws proves nothing about the backlog; treat it as
					// undrained rather than waving the next write through.
					drained = false;
				}
				const current = this.auxNotifyInflight.get(key);
				if (current === record && current.client === client) {
					current.drain = undefined;
					// Subtract the snapshot rather than zeroing: a concurrent touch may
					// have issued a write after this round-trip was sent, and that write
					// is still unacknowledged.
					if (drained)
						current.unacked = Math.max(0, current.unacked - outstanding);
					// Deliberately no `else` latch here. A barrier is only ever created
					// by a call that goes on to await it, so a negative result always
					// reaches a waiter — as `false`, or as that waiter's own timeout —
					// and the waiter is what latches. A second latch here would be
					// unreachable, and no test could hold it honest.
				}
				// #2358: a DRAINED round-trip is a per-write latency measurement —
				// the server really processed its backlog — so it feeds the EWMA
				// the adaptive wedge window is priced from.
				const durationMs = Date.now() - startedAt;
				if (drained)
					this.noteAuxNotifyDrainLatency(key, durationMs, outstanding, record);
				this.noteDrainBarrierOutcome(key, entry, filePath, context, {
					unacked: outstanding,
					limit,
					waitMs,
					durationMs,
					outcome: drained ? "drained" : "stalled",
				});
				return drained;
			})();
			barrier.catch(() => {});
			record.drain = barrier;
			record.stallLogged = false;
		}
		// Each waiter spends only its OWN remaining budget on the shared barrier.
		const waitStartedAt = Date.now();
		const drained = await withDeadline(record.drain, {
			ms: waitMs,
			onTimeout: "undefined",
			onReject: "undefined",
		});
		if (drained !== true) {
			// The waiter gave up before the round-trip answered. Latch open and let
			// the caller write: a barrier whose ping never answers would otherwise
			// tax every remaining file a full budget for nothing.
			this.openAuxNotifyGate(key, entry, filePath, context, {
				unacked: record.unacked,
				limit,
				waitMs,
				durationMs: Date.now() - waitStartedAt,
			});
		}
	}

	/**
	 * #1714: stop pacing this client and hand it to the breaker.
	 *
	 * Latched, not cooled down — a timer here would be a schedule of this gate's
	 * own, and it would race the caller's cadence. The latch clears only when the
	 * record does: a demotion ({@link demoteForNotifyStall}), a client-identity
	 * change, or the service teardown. Every one of those means a new server
	 * process, which is the only event that makes the old backlog meaningless.
	 */
	private openAuxNotifyGate(
		key: string,
		entry: SpawnedServer,
		filePath: string,
		context: { source: string; clientScope: LSPTouchClientScope },
		detail: {
			unacked: number;
			limit: number;
			waitMs: number;
			durationMs: number;
		},
	): void {
		const record = this.auxNotifyInflight.get(key);
		if (record && record.client === entry.client) {
			// `drain` is deliberately left alone. Once the gate is open nothing
			// reads it again — `paceAuxNotify` returns above the barrier — and the
			// round-trip's own settle handler clears it when it finally answers.
			// Clearing it here would be a write no test could hold honest.
			record.gateOpen = true;
		}
		this.noteDrainBarrierOutcome(key, entry, filePath, context, {
			...detail,
			outcome: "stalled",
		});
	}

	/**
	 * #1714: emit at most ONE record per barrier. A stalled barrier can be
	 * abandoned by every file left in the sweep, and one row per file would turn a
	 * single stuck scanner into hundreds of identical records.
	 */
	private noteDrainBarrierOutcome(
		key: string,
		entry: SpawnedServer,
		filePath: string,
		context: { source: string; clientScope: LSPTouchClientScope },
		detail: {
			unacked: number;
			limit: number;
			waitMs: number;
			durationMs: number;
			outcome: "drained" | "stalled";
		},
	): void {
		const record = this.auxNotifyInflight.get(key);
		if (detail.outcome === "stalled" && record) {
			if (record.stallLogged) return;
			record.stallLogged = true;
		}
		this.logDrainBarrier(key, entry, filePath, context, detail);
	}

	/**
	 * #1714: one row per barrier, not per waiter — a burst of N notifies produces
	 * at most one round-trip and one record, so the volume is bounded by the sweep
	 * divided by the limit. Names the server and the file that hit the ceiling, so
	 * "which scanner is falling behind" survives aggregation.
	 */
	private logDrainBarrier(
		key: string,
		entry: SpawnedServer,
		filePath: string,
		context: { source: string; clientScope: LSPTouchClientScope },
		detail: {
			unacked: number;
			limit: number;
			waitMs: number;
			durationMs: number;
			outcome: "drained" | "stalled";
		},
	): void {
		if (detail.outcome === "stalled") {
			incrementDegradationCount({
				kind: "lsp-notify-inflight-stall",
				subject: `${entry.info.id}:${normalizeMapKey(filePath)}`,
				reason: `notify barrier stalled with ${detail.unacked} unacknowledged writes`,
			});
		}
		logLatency({
			type: "phase",
			phase: "lsp_notify_inflight_barrier",
			filePath: normalizeMapKey(filePath),
			durationMs: detail.durationMs,
			metadata: {
				serverId: entry.info.id,
				clientKey: key,
				source: context.source,
				clientScope: context.clientScope,
				...detail,
			},
		});
	}

	/**
	 * #1459: take this auxiliary's resync slot, waiting up to `budgetMs` for it.
	 *
	 * The gate is a QUEUE, not a drop: a healthy scanner accepts a `didOpen` in
	 * milliseconds, so a sweep's neighbours take their turns one after another and
	 * every file still gets scanned — what the gate prevents is N simultaneous
	 * full re-scans flooding one stdin. Only a scanner that cannot accept a write
	 * inside the budget makes a waiter give up, and giving up is reported as a
	 * coverage gap rather than pushed anyway.
	 *
	 * The slot is CLAIMED SYNCHRONOUSLY: the check and the insert sit in one
	 * uninterrupted run of statements, and the returned handle owns the entry. A
	 * version that returned "the slot looks free, go write" and let the caller
	 * insert its own record after an `await` was not a gate at all — when the
	 * holder's write landed, every waiter woke in the same microtask batch, each
	 * read an empty map, and all of them wrote at once (measured: one write at t=0,
	 * then a five-wide flood at t=50 for six touches). That is #1459's own root
	 * cause rebuilt inside the fix for it.
	 *
	 * Returns a handle with `release()` (call on the write's settle, idempotent), or
	 * a verdict naming how long the blocking write has been outstanding.
	 */
	private async claimAuxNotifySlot(
		clientKey: string,
		entry: SpawnedServer,
		filePath: string,
		budgetMs: number,
	): Promise<{ release: () => void } | { outstandingMs: number }> {
		const deadline = Date.now() + budgetMs;
		for (;;) {
			const outstanding = this.outstandingAuxNotifyWrites.get(clientKey);
			// A record left behind by a PREVIOUS client generation (evicted,
			// respawned) says nothing about this client's stdin — drop it, so a stale
			// entry can never starve a healthy server.
			if (outstanding && outstanding.client !== entry.client) {
				this.releaseOutstandingAuxNotifyWrite(clientKey, outstanding);
			} else if (outstanding) {
				const outstandingMs = Date.now() - outstanding.startedAt;
				const remainingMs = deadline - Date.now();
				if (remainingMs <= 0) return { outstandingMs };
				// `settled` never rejects, so this only resolves or times out.
				await withDeadline(outstanding.settled, {
					ms: remainingMs,
					onTimeout: "undefined",
					onReject: "undefined",
				});
				continue;
			}
			// This client was evicted or replaced while we queued — writing to it
			// would target a retired generation. Report the gap instead.
			//
			// `!== entry.client` covers BOTH shapes, and the missing-entry one is the
			// dangerous half: eviction (idle, capacity, a #743 demotion) DELETES the
			// registry entry, so an `undefined`-exempting guard would wave the waiter
			// through to a corpse whose write resolves `true` — and `markTouched` would
			// then record this content as delivered, which is exactly the #1253
			// laundering the debounce entry must never do.
			const current = this.state.clients.get(clientKey);
			if (current !== entry.client) {
				return { outstandingMs: 0 };
			}
			// ---- No `await` from here to the `set` below: the claim is atomic. ----
			let resolveSettled: (() => void) | undefined;
			const settled = new Promise<void>((resolve) => {
				resolveSettled = resolve;
			});
			const token = {
				startedAt: Date.now(),
				client: entry.client,
				settled,
				armedBudgetMs: 0,
				// SAFETY: the handle is a torn-initialized placeholder. It is armed
				// a beat later in this same atomic claim (no await in between) and
				// thereafter only ever written by this token's own fire/release
				// closures, so the placeholder value is never read by anyone.
				wedgeTimer: undefined as unknown as ReturnType<typeof setTimeout>,
				resolveSettled: (): void => resolveSettled?.(),
			};
			// A write nothing accepts for the whole wedge window is a dead input
			// path, not a slow scan. Armed HERE rather than checked by the next
			// waiter: inside a burst every waiter arrives within one budget, so a
			// waiter-side check could never see the wedge window elapse and a
			// wedged scanner was never demoted. Unref'd so it cannot hold a
			// one-shot host alive, and cleared on release.
			//
			// #2358: the window itself is now ADAPTIVE (issue's `max(fixed,
			// k x EWMA per-answer latency x unacked depth)`, capped), and when it
			// fires the server's process CPU is sampled before the kill — a busy
			// server is left alone and the timer re-arms, so a scanner draining a
			// burst is never killed by construction. Every fire re-checks the
			// token identity after its awaits, so a release or a concurrent
			// demotion that lands mid-sample aborts the decision.
			const fireWedge = async (): Promise<void> => {
				if (
					this.outstandingAuxNotifyWrites.get(clientKey) !== token ||
					this.state.clients.get(clientKey) !== entry.client
				) {
					this.releaseOutstandingAuxNotifyWrite(clientKey, token);
					return;
				}
				let decision:
					| { action: "demote"; reason: NotifyStallDemotionReason }
					| { action: "rearm"; budgetMs: number };
				try {
					decision = await this.decideNotifyStallTeardown(
						clientKey,
						entry,
						filePath,
						token,
					);
				} catch {
					// A failed decision must not strand the outstanding write or the
					// waiter: fall back to the pre-#2358 demote-at-budget teardown.
					decision = {
						action: "demote",
						reason: {
							outstandingMs: Date.now() - token.startedAt,
							discriminator: "budget-exceeded",
							budgetMs: token.armedBudgetMs,
						},
					};
				}
				if (
					this.outstandingAuxNotifyWrites.get(clientKey) !== token ||
					this.state.clients.get(clientKey) !== entry.client
				) {
					this.releaseOutstandingAuxNotifyWrite(clientKey, token);
					return;
				}
				if (decision.action === "demote") {
					this.demoteForNotifyStall(
						clientKey,
						entry,
						filePath,
						decision.reason,
					);
					resolveSettled?.();
					return;
				}
				token.wedgeTimer = setTimeout(
					() => void fireWedge(),
					decision.budgetMs,
				);
				token.wedgeTimer.unref?.();
			};
			token.armedBudgetMs = this.auxNotifyWedgeBudgetMs(clientKey);
			token.wedgeTimer = setTimeout(
				() => void fireWedge(),
				token.armedBudgetMs,
			);
			token.wedgeTimer.unref?.();
			this.outstandingAuxNotifyWrites.set(clientKey, token);
			return {
				release: (): void => {
					this.releaseOutstandingAuxNotifyWrite(clientKey, token);
				},
			};
		}
	}

	/**
	 * #1459: the auxiliary scanners that WOULD have attached to this touch but got
	 * no client because their circuit breaker is open (cooldown or permanent).
	 *
	 * A skipped scanner said nothing about the file. Until now it also left no
	 * trace on the result: it simply dropped out of `spawned`, and the touch
	 * resolved `confirmation: "confirmed"` on the strength of whoever was left —
	 * so a 15 s opengrep cooldown read as "scanned, clean" for every file swept
	 * inside it. Naming the scanners here narrows the touch to `"partial"` instead,
	 * which every coverage consumer already fails closed on (#1470).
	 *
	 * Deliberately AUXILIARY-only. A broken primary is already visible through the
	 * `no_clients` failure kind and the demonstrated-cold path; the false-clean
	 * hazard this addresses is the scanner lane, where an empty result is the
	 * normal, expected answer.
	 *
	 * SCOPE, stated so the next reader does not assume the room is closed: this
	 * covers the BREAKER doors only (cooldown + permanent). `ensureClientForServer`
	 * also drops a scanner for a temporarily-unavailable command (the #1496 latch),
	 * `optionalDisabled`, a spawn failure, or capacity eviction. Those are the same
	 * defect class in the same lane, but they are persistent-absence states rather
	 * than a transient blackout, so flagging every touch partial for them is a
	 * broader behavior change than #1459 is scoped to make. Tracked separately.
	 */
	private async brokenSkippedAuxiliaryServerIds(
		filePath: string,
		clientScope: LSPTouchClientScope,
		options: LSPTouchFileOptions,
		spawned: SpawnedServer[],
	): Promise<string[]> {
		// "primary" scope attaches no auxiliaries at all, so nothing was skipped.
		if (clientScope === "primary") return [];
		const enabledAuxiliaries =
			clientScope === "with-auxiliary"
				? new Set(options.auxiliaryServerIds ?? [])
				: undefined;
		const attached = new Set(spawned.map((entry) => entry.info.id));
		const skipped: string[] = [];
		for (const server of getServersForFileWithConfig(filePath)) {
			if (server.role !== "auxiliary") continue;
			if (attached.has(server.id)) continue;
			// An explicitly excluded server (the #584 workspace-sweep exclusion) was
			// never asked, and its findings come from its own CLI extractor — that is
			// a routing decision, not a coverage gap.
			if (options.excludeServerIds?.has(server.id)) continue;
			if (enabledAuxiliaries && !enabledAuxiliaries.has(server.id)) continue;
			const key = await this.demonstratedReadyKeyFor(server, filePath);
			if (!key) continue;
			const brokenUntil = this.state.broken.get(key);
			if (
				this.permanentlyBroken.has(key) ||
				(typeof brokenUntil === "number" && brokenUntil > Date.now())
			) {
				skipped.push(server.id);
			}
		}
		return skipped;
	}

	private activeClientsForCwd(
		cwd: string,
		priorityServerIds: string[] = [],
	): Array<{ serverId: string; client: LSPClientInfo }> {
		const normalizedCwd = normalizeMapKey(cwd);
		const priority = new Map(
			priorityServerIds.map((serverId, index) => [serverId, index]),
		);
		const entries: Array<{ serverId: string; client: LSPClientInfo }> = [];
		for (const [key, client] of this.state.clients) {
			if (!client.isAlive()) continue;
			const separator = key.indexOf(":");
			const serverId = separator >= 0 ? key.slice(0, separator) : key;
			const root = normalizeMapKey(client.root);
			const sameOrNested =
				root === normalizedCwd ||
				root.startsWith(`${normalizedCwd}/`) ||
				normalizedCwd.startsWith(`${root}/`);
			if (!sameOrNested) continue;
			entries.push({ serverId, client });
		}
		return entries.sort(
			(a, b) =>
				(priority.get(a.serverId) ?? Number.MAX_SAFE_INTEGER) -
				(priority.get(b.serverId) ?? Number.MAX_SAFE_INTEGER),
		);
	}

	/**
	 * Get or create LSP client for a file
	 * Prevents duplicate client creation via in-flight promise tracking
	 */
	async getClientForFile(
		filePath: string,
		maxWaitMs?: number,
		hardCapMs?: number,
		resolvedRoots?: Map<string, string>,
		waitSkipReasons?: Set<string>,
	): Promise<SpawnedServer | undefined> {
		if (this.checkDestroyed()) return undefined;
		// Primary selection considers language servers only — auxiliary servers
		// (opengrep, …) attach alongside the primary and are never chosen as it.
		const servers = getServersForFileWithConfig(filePath).filter(
			(s) => s.role !== "auxiliary",
		);
		// hardCapMs is a caller-imposed ceiling (e.g. pipeline budget) that
		// prevents tool_result from blocking the TUI for the full LSP cold-start
		// window. When no server config sets a wait (serverWaitOverrideMs = 0),
		// hardCapMs is used directly — Math.min(0, cap) = 0 would otherwise
		// take the no-timeout branch and block indefinitely (e.g. pyright, which
		// has no clientWaitTimeoutMs but can take 30s to initialize on cold start).
		const serverBaseMs = primaryServerWaitFloorMs(filePath, maxWaitMs);
		const effectiveMaxWaitMs =
			hardCapMs !== undefined
				? serverBaseMs > 0
					? Math.min(serverBaseMs, hardCapMs)
					: hardCapMs
				: serverBaseMs;

		let knownSlowResolve: (() => void) | undefined;
		const knownSlowSentinel = Symbol("lsp-client-wait-known-slow");
		const knownSlow = new Promise<typeof knownSlowSentinel>((resolve) => {
			knownSlowResolve = () => resolve(knownSlowSentinel);
		});
		const noteSpawnInFlight = (serverId: string): void => {
			const knownDurationMs = getSuccessfulLspSpawnDurationMs(serverId);
			if (
				knownDurationMs !== undefined &&
				knownDurationMs > effectiveMaxWaitMs * 2
			) {
				// Let a completion microtask already queued by the acquisition win
				// before the shortcut decision is observed by Promise.race.
				queueMicrotask(() => knownSlowResolve?.());
			}
		};

		const withBudget = async (): Promise<SpawnedServer | undefined> => {
			if (servers.length === 0) return undefined;

			// #1934: the first server whose acquisition ERRORED, as opposed to
			// cleanly declining. Kept so a selection that served nobody still
			// says which server the pool actually tried and failed to spawn.
			// #2064 carries the errored outcome VALUE with it, so the record
			// below reports whether this caller started the failed spawn or
			// joined it, instead of pinning a starter label on every joiner.
			let erroredServerId: string | undefined;
			let erroredOutcome: LSPClientAcquisitionOutcome | undefined;

			// Try each matching server
			for (const server of servers) {
				// A box, not a `let`: control-flow analysis cannot see the callback
				// write and would narrow a plain local to its initializer.
				const acquisition: { outcome: LSPClientAcquisitionOutcome } = {
					outcome: "declined",
				};
				const spawned = await this.ensureClientForServer(
					filePath,
					server,
					resolvedRoots,
					noteSpawnInFlight,
					(reported) => {
						acquisition.outcome = reported;
					},
				);
				if (spawned) {
					logLatency({
						type: "phase",
						phase: "lsp_client_selected",
						filePath,
						durationMs: 0,
						metadata: {
							serverId: server.id,
							candidateCount: servers.length,
							// Emitted RAW, never coerced to a "safe" value: a served
							// client always reports `warm-reuse` or `cold-spawn`, so a
							// `declined` here would be a real reporting bug and must be
							// visible in the log rather than laundered into a lie.
							outcome: acquisition.outcome,
						},
					});
					return spawned;
				}
				if (
					acquisition.outcome === "spawn-failure" ||
					acquisition.outcome === "spawn-failure-joined"
				) {
					if (erroredServerId === undefined) {
						erroredServerId = server.id;
						erroredOutcome = acquisition.outcome;
					}
				}
			}

			if (erroredServerId !== undefined) {
				// Same record, same denominator as the two served outcomes. Bounded
				// by the LSP breaker, not by a latch: a spawn failure always cools
				// the (server, root) key down, so the next touch takes the
				// `lsp_client_skipped_broken` early return and reports `declined`
				// instead of reaching here again until the cooldown expires.
				logLatency({
					type: "phase",
					phase: "lsp_client_selected",
					filePath,
					durationMs: 0,
					metadata: {
						serverId: erroredServerId,
						candidateCount: servers.length,
						outcome: (erroredOutcome ??
							"spawn-failure") satisfies LSPClientAcquisitionOutcome,
					},
				});
			}

			const unavailable = (
				await Promise.all(
					servers.map(async (server) => {
						const root = await server.root(filePath);
						return {
							server,
							key: `${server.id}:${root ? normalizeMapKey(root) : "<unresolved>"}`,
						};
					}),
				)
			).filter(({ key }) => !this.unavailableLogged.has(key));
			for (const { key } of unavailable) this.unavailableLogged.add(key);
			if (unavailable.length === 0) return undefined;
			logLatency({
				type: "phase",
				phase: "lsp_client_unavailable",
				filePath,
				durationMs: 0,
				metadata: {
					candidateCount: unavailable.length,
					servers: unavailable.map(({ server }) => server.id),
				},
			});

			return undefined;
		};

		if (!effectiveMaxWaitMs || effectiveMaxWaitMs <= 0) {
			return withBudget();
		}

		const timeoutSentinel = Symbol("lsp-client-wait-timeout");
		// #1097: store the timer and clear it once the race settles. Without this,
		// when `withBudget()` wins (the common case: the client is ready well before
		// the budget), the losing `setTimeout` stays a REF'D pending timer for the
		// full remaining `effectiveMaxWaitMs`. In a long-lived interactive session
		// that is invisible (it fires later, resolves an orphan promise, is GC'd).
		// In a one-shot `pi --print --no-session` process it is fatal: the timer
		// keeps the event loop alive for up to `effectiveMaxWaitMs` after
		// `agent_settled`/`session_shutdown`, so the completed process never exits
		// (issue #1097 — a recurrence of the #22 symptom via a different handle, and
		// a member of the uncleared-race-timeout class the shared `withDeadline`
		// helper already guards against elsewhere).
		let waitTimer: ReturnType<typeof setTimeout> | undefined;
		let waitResult:
			| SpawnedServer
			| undefined
			| typeof timeoutSentinel
			| typeof knownSlowSentinel;
		try {
			waitResult = await Promise.race<
				| SpawnedServer
				| undefined
				| typeof timeoutSentinel
				| typeof knownSlowSentinel
			>([
				withBudget(),
				knownSlow,
				new Promise<typeof timeoutSentinel>((resolve) => {
					waitTimer = setTimeout(
						() => resolve(timeoutSentinel),
						effectiveMaxWaitMs,
					);
				}),
			]);
		} finally {
			if (waitTimer) clearTimeout(waitTimer);
		}

		if (waitResult === knownSlowSentinel) {
			// `inFlight` is cleared in ensureClientForServer's finally block, so a
			// settled acquisition can still be present here. Re-read the published
			// clients at the decision point; a usable client outranks the sentinel.
			for (const server of servers) {
				const root = await this.resolveServerRoot(server, filePath);
				const client = root
					? this.state.clients.get(`${server.id}:${normalizeMapKey(root)}`)
					: undefined;
				if (client?.isAlive()) return { client, info: server };
			}
			waitSkipReasons?.add("budget_skipped_known_slow");
			logLatency({
				type: "phase",
				phase: "lsp_client_wait_skipped",
				filePath,
				durationMs: 0,
				metadata: {
					maxWaitMs: effectiveMaxWaitMs,
					serverIds: servers.map((server) => server.id),
					reason: "budget_skipped_known_slow",
				},
			});
			return undefined;
		}

		if (waitResult === timeoutSentinel) {
			// Snapshot known client health — scan by serverId prefix (no root needed)
			const knownHealth = [...this.state.clients.entries()]
				.filter(([k]) => servers.some((s) => k.startsWith(`${s.id}:`)))
				.map(([k, c]) => ({
					serverId: k.split(":")[0],
					alive: c.isAlive(),
					spawnedAt: this.state.clientSpawnedAt.get(k) ?? null,
				}));
			logLatency({
				type: "phase",
				phase: "lsp_client_wait_timeout",
				filePath,
				durationMs: effectiveMaxWaitMs,
				metadata: {
					maxWaitMs: effectiveMaxWaitMs,
					serverIds: servers.map((s) => s.id),
					// servers absent from knownHealth were never spawned or are still spawning
					knownClientHealth: knownHealth,
				},
			});
			return undefined;
		}

		return waitResult;
	}

	/**
	 * Get or create all complementary LSP clients that can serve a file. Alternate
	 * language servers marked with `fallbackFor` remain sequential fallbacks: an
	 * aggregate diagnostics pass must not launch them beside a working preferred
	 * server merely because it requested `clientScope: "all"`.
	 */
	async getClientsForFile(
		filePath: string,
		excludeServerIds?: ReadonlySet<string>,
		resolvedRoots?: Map<string, string>,
	): Promise<{ clients: SpawnedServer[]; serverCountAttempted: number }> {
		const allServers = getServersForFileWithConfig(filePath);
		const servers =
			excludeServerIds && excludeServerIds.size > 0
				? allServers.filter((s) => !excludeServerIds.has(s.id))
				: allServers;
		if (servers.length === 0) return { clients: [], serverCountAttempted: 0 };

		// Resolve once to keep the attempted count tied to servers with a real root.
		const rootedServers = (
			await Promise.all(
				servers.map(async (server) => ({
					server,
					root: await this.resolveServerRoot(server, filePath),
				})),
			)
		).filter(
			(entry): entry is { server: LSPServerInfo; root: string } =>
				entry.root !== undefined,
		);

		let serverCountAttempted = 0;
		const acquisitions = new Map<string, Promise<SpawnedServer | undefined>>();
		const acquire = (server: LSPServerInfo) => {
			serverCountAttempted += 1;
			return this.ensureClientForServer(filePath, server, resolvedRoots);
		};

		// Start complementary servers immediately. An alternate waits only for its
		// own preferred server, not for unrelated scanners, and starts if that server
		// declines. Registry order makes chained fallbacks deterministic.
		for (const { server } of rootedServers) {
			const preferred = server.fallbackFor
				? acquisitions.get(server.fallbackFor)
				: undefined;
			const acquisition = preferred
				? preferred.then((entry) =>
						entry === undefined ? acquire(server) : undefined,
					)
				: acquire(server);
			acquisitions.set(server.id, acquisition);
		}

		const results = await Promise.all(acquisitions.values());
		const clients = results.filter(
			(entry): entry is SpawnedServer => entry !== undefined,
		);
		return { clients, serverCountAttempted };
	}

	/**
	 * Spawn/get the AUXILIARY clients for a file (role:"auxiliary") restricted to
	 * the enabled set. These attach alongside the primary on the with-auxiliary
	 * diagnostics path (cross-cutting scanners like opengrep).
	 */
	async getAuxiliaryClientsForFile(
		filePath: string,
		enabledIds: ReadonlySet<string>,
		onOutcome?: (
			serverId: string,
			outcome: LSPClientAcquisitionOutcome,
		) => void,
	): Promise<SpawnedServer[]> {
		if (this.checkDestroyed() || enabledIds.size === 0) return [];
		const servers = getServersForFileWithConfig(filePath).filter(
			(s) => s.role === "auxiliary" && enabledIds.has(s.id),
		);
		if (servers.length === 0) return [];
		const spawned = await Promise.all(
			servers.map((server) =>
				this.ensureClientForServer(
					filePath,
					server,
					undefined,
					undefined,
					(reported) => onOutcome?.(server.id, reported),
				),
			),
		);
		return spawned.filter((entry): entry is SpawnedServer => Boolean(entry));
	}

	/**
	 * Get a warm LSP client for a file without spawning.
	 * Returns undefined if no matching client is already connected and alive.
	 */
	async getWarmClientForFile(
		filePath: string,
	): Promise<SpawnedServer | undefined> {
		if (this.checkDestroyed()) return undefined;
		const servers = getServersForFileWithConfig(filePath);
		// #1934: the (server, root) pairs that COULD have served this file and
		// were cold. A server with no resolvable root is not a pool miss — it
		// never had a slot to miss — so it stays out of this list.
		const missed: string[] = [];
		for (const server of servers) {
			const root = await this.resolveServerRoot(server, filePath);
			if (!root) continue;
			const key = `${server.id}:${normalizeMapKey(root)}`;
			const existing = this.state.clients.get(key);
			if (existing?.isAlive()) {
				return { client: existing, info: server };
			}
			missed.push(key);
		}
		// #1934: an empty `missed` means "this file has no language server here",
		// which is the normal answer for most reads and must not be logged as a
		// pool miss. Callers run per file in the cascade quiet window and on the
		// read-expansion path, so a raw record would be a per-file log storm:
		// the ledger counts every miss exactly and only the FIRST per candidate
		// set also writes the detailed record.
		if (missed.length > 0) {
			emitBounded(
				"lsp_warm_client_missing",
				missed.join(","),
				{
					filePath,
					durationMs: 0,
					metadata: {
						serverIds: missed.map((key) => key.slice(0, key.indexOf(":"))),
						roots: missed.map((key) => key.slice(key.indexOf(":") + 1)),
					},
				},
				{
					ledgerKind: "lsp-warm-client-missing",
					risingEdgePer: "identity",
					reason: `no warm client for ${missed.join(",")}`,
				},
			);
		}
		return undefined;
	}

	/**
	 * Read-only Gate-B readiness check for one auxiliary server/root. A connected
	 * process is not yet a diagnostic producer: only its first publication proves
	 * that this root's client can supersede an in-process fallback runner.
	 */
	async hasServerPublishedForFileRoot(
		serverId: string,
		filePath: string,
	): Promise<boolean> {
		if (this.checkDestroyed()) return false;
		for (const server of getServersForFileWithConfig(filePath)) {
			if (server.id !== serverId) continue;
			const root = await this.resolveServerRoot(server, filePath);
			if (!root) continue;
			const key = `${server.id}:${normalizeMapKey(root)}`;
			const client = this.state.clients.get(key);
			// #2324 F1: per-file grain. `diagnosticsVersion` is client-global —
			// any sibling path's publication bumps it, so it cannot answer "did
			// THIS server publish for THIS file?" (client.ts:339-341). A file
			// this server never touched would otherwise read as gated-open the
			// moment any other file on the same client got a publication.
			if (
				client?.isAlive() &&
				client.getDiagnosticsVersionForPath(filePath) > 0
			) {
				return true;
			}
		}
		return false;
	}

	/**
	 * #2001/#2002 collect-later: read-only cached-diagnostics probe for the
	 * turn-end late-auxiliary delivery (`clients/runtime-turn.ts`). Like
	 * the Gate-B readiness check, this NEVER creates or warms a client — it only
	 * resolves each requested server's root and reads the already-connected
	 * client's cached diagnostics for `filePath`. Servers with no live client
	 * are absent unless notify-stall teardown marked that generation as
	 * replaceable; that status carries the demotion timestamp so turn-end late
	 * coverage can correlate each pair to the removed generation. A live
	 * client is present even when its per-file cache entry is empty; its
	 * timestamp distinguishes a published clean result from no publication.
	 */
	async readCachedDiagnosticsForServers(
		filePath: string,
		serverIds: ReadonlySet<string>,
	): Promise<
		Map<
			string,
			{
				diags: import("./client.js").LSPDiagnostic[];
				publishedAt?: number;
				/** The client was removed by notify-stall teardown and may be replaced. */
				notifyStallDemoted?: boolean;
				/** When the demoted client generation was removed. */
				demotedAt?: number;
			}
		>
	> {
		const out = new Map<
			string,
			{
				diags: import("./client.js").LSPDiagnostic[];
				publishedAt?: number;
				notifyStallDemoted?: boolean;
				demotedAt?: number;
			}
		>();
		if (this.checkDestroyed() || serverIds.size === 0) return out;
		for (const server of getServersForFileWithConfig(filePath)) {
			if (!serverIds.has(server.id) || out.has(server.id)) continue;
			const root = await this.resolveServerRoot(server, filePath);
			if (!root) continue;
			const key = `${server.id}:${normalizeMapKey(root)}`;
			const client = this.state.clients.get(key);
			if (!client?.isAlive()) {
				const demotedAt = this.notifyStallDemotions.get(key);
				if (demotedAt !== undefined) {
					out.set(server.id, {
						diags: [],
						notifyStallDemoted: true,
						demotedAt,
					});
				}
				continue;
			}
			// A replacement is live again. The old generation's marker no longer
			// describes this client and must not make a later absence look transient.
			this.notifyStallDemotions.delete(key);
			const entry = client.getAllDiagnostics().get(normalizeMapKey(filePath));
			out.set(server.id, {
				diags: entry?.diags ?? [],
				publishedAt: entry?.ts,
			});
		}
		return out;
	}

	/**
	 * #1668: deliver a `workspace/didChangeWatchedFiles` event for a disk
	 * change the client did not author through open-document sync — a bash
	 * write/delete, or any other external change. `type` is the LSP
	 * `FileChangeType` (1 Created, 2 Changed, 3 Deleted).
	 *
	 * Only reaches ALREADY-ACTIVE clients for this file's servers — a server
	 * that hasn't been spawned yet has no stale cache to correct, so this
	 * never spawns one just to deliver the notification. Each affected
	 * client enqueues into its own #271 debounced queue, so a burst of
	 * external changes still coalesces into one notification per server.
	 */
	async notifyExternalFileChange(
		filePath: string,
		type: number,
	): Promise<void> {
		if (this.checkDestroyed()) return;
		for (const server of getServersForFileWithConfig(filePath)) {
			const root = await this.resolveServerRoot(server, filePath);
			if (!root) continue;
			const key = `${server.id}:${normalizeMapKey(root)}`;
			const existing = this.state.clients.get(key);
			if (existing?.isAlive()) {
				existing.notify.watchedFileChange(filePath, type);
			}
		}
	}

	/**
	 * #1783: disk-drift backstop. Stat one batch of the documents a language
	 * server currently holds, and re-push any whose bytes on disk no longer
	 * match what the server was last given.
	 *
	 * Why this exists: an edit made outside the tracked write/edit path (a
	 * bash-tool bulk edit) sends no `didChange`, so the server keeps publishing
	 * pre-edit diagnostics with nothing to correct it. The resync-on-read path
	 * only fires for a file the session reads again; a file that is edited and
	 * never re-read stayed stale for the life of the server.
	 *
	 * Hot-path contract: callers fire this WITHOUT awaiting it. It is
	 * rate-limited to one pass per drift-check interval (10s default),
	 * stats at most 64 documents per pass, reads only the ones whose stat
	 * already diverged, and issues at most 4 resyncs per pass serially. So the
	 * steady-state cost on the touch path is zero, and the worst-case cost of a
	 * pass is 64 stats plus up to 4 reads, off the caller's critical path.
	 *
	 * Never spawns: a document with no live client already holding it open has
	 * no stale view to correct, so its record is dropped instead of resynced.
	 */
	async sweepDocumentDrift(
		options: { force?: boolean } = {},
	): Promise<DriftSweepResult | undefined> {
		if (this.checkDestroyed()) return undefined;
		return this.documentDrift.sweep(
			{
				resync: async (filePath, content) => {
					// Reuse the normal touch path so the resync inherits the existing
					// per-server notify-write budget, the #743 backpressure demotion and
					// the client-lease machinery. diagnostics:"none" keeps it a pure
					// content push — the next genuine query gets correct diagnostics
					// because the server's view is now right, not because this call
					// waited for them.
					//
					// Scope "all" MINUS the servers that are not holding this document:
					// the resync must cover every view that is actually stale, primary
					// and auxiliary alike, and the exclusion set is what keeps that from
					// spawning anything (see serverIdsNotHoldingDocument). The write is
					// still one per held server through the same bounded notify path, so
					// the per-pass resync cap continues to bound the total writes.
					await this.touchFile(filePath, content, {
						diagnostics: "none",
						source: "drift_resync",
						clientScope: "all",
						excludeServerIds: await this.serverIdsNotHoldingDocument(filePath),
					});
					// touchFile swallows a rejected or timed-out notify write so the
					// caller's edit keeps moving, so its return proves nothing about
					// whether the heal landed. The drift record is stamped in exactly
					// one place — recordFullyCoveredSync, and only on full coverage —
					// so "did the record advance to this content" IS the answer.
					return (
						this.documentDrift.peek(filePath)?.fingerprint ===
						fingerprintDocumentContent(content)
					);
				},
				holdsDocument: (filePath) =>
					this.hasLiveClientHoldingDocument(filePath),
				onDrift: (event) => {
					// A clean re-stamp, a deleted file and a closed document are all
					// normal bookkeeping, not degradations. Only a real resync — or a
					// heal the pacing had to defer — earns a record.
					if (
						event.disposition === "unchanged" ||
						event.disposition === "vanished" ||
						event.disposition === "unheld"
					) {
						return;
					}
					// Bounded record, per-file so the identity of the stuck document
					// survives aggregation. `incrementDegradationCount` keeps one entry
					// per file with an exact repeat tally instead of N entries.
					incrementDegradationCount({
						kind: "lsp-document-drift",
						subject: event.filePath,
						reason:
							event.disposition === "deferred"
								? `disk drift deferred by resync pacing after ${event.driftAgeMs}ms`
								: event.disposition === "failed"
									? `resync FAILED after ${event.driftAgeMs}ms of untracked disk drift; view still stale (${event.syncedSize}->${event.diskSize} bytes)`
									: `resynced after ${event.driftAgeMs}ms of untracked disk drift (${event.syncedSize}->${event.diskSize} bytes)`,
					});
					logLatency({
						type: "phase",
						phase: "lsp_document_drift",
						filePath: event.filePath,
						durationMs: event.driftAgeMs,
						metadata: {
							disposition: event.disposition,
							driftAgeMs: event.driftAgeMs,
							syncedSize: event.syncedSize,
							diskSize: event.diskSize,
						},
					});
				},
			},
			options,
		);
	}

	/** #1783: tracked drift-record count. Test seam for the reset conformance. */
	_driftTrackedCountForTests(): number {
		return this.documentDrift.size;
	}

	/**
	 * #1783: does any LIVE client already hold this document open? A record for
	 * a document no server holds is dropped rather than resynced, so the drift
	 * backstop can never spawn a server just to correct a view nobody has.
	 */
	private hasLiveClientHoldingDocument(filePath: string): boolean {
		for (const client of this.state.clients.values()) {
			if (!client.isAlive()) continue;
			if (documentIsOpenOn(client, filePath)) return true;
		}
		return false;
	}

	/**
	 * #1783: server ids for this file whose client is NOT currently holding the
	 * document open — the exclusion set the drift resync passes to
	 * `clientScope:"all"`.
	 *
	 * This is what keeps "resync every server that holds it" and "never spawn"
	 * compatible. `getClientsForFile` filters by this set BEFORE
	 * `ensureClientForServer`, so an excluded server is never reached, and every
	 * remaining server already has a live client that returns from the cache.
	 * Without it, `clientScope:"all"` would spawn the file's other servers, and
	 * `clientScope:"primary"` would leave an auxiliary's view stale while the
	 * record claimed the file was back in sync.
	 */
	private async serverIdsNotHoldingDocument(
		filePath: string,
	): Promise<Set<string>> {
		const exclude = new Set<string>();
		for (const server of getServersForFileWithConfig(filePath)) {
			const root = await this.resolveServerRoot(server, filePath);
			const existing = root
				? this.state.clients.get(`${server.id}:${normalizeMapKey(root)}`)
				: undefined;
			if (existing?.isAlive() && documentIsOpenOn(existing, filePath)) continue;
			exclude.add(server.id);
		}
		return exclude;
	}

	/**
	 * #1783: stamp the drift record only when this touch reached EVERY server
	 * that currently holds the document, and every one of those writes landed.
	 *
	 * `at` is the touch's START time, not the moment the write landed. The write
	 * can take up to the notify budget, and an untracked edit inside that window
	 * would otherwise be stamped as already-synchronized and become invisible
	 * (the mtime half of the key compares against this timestamp). Starting the
	 * clock at the touch — within a millisecond or two of the caller's read —
	 * narrows that blind window to the caller's own read-to-touch gap.
	 */
	private recordFullyCoveredSync(
		filePath: string,
		content: string,
		targeted: readonly SpawnedServer[],
		allWritesLanded: boolean,
		at: number,
	): void {
		if (!allWritesLanded || targeted.length === 0) return;
		const targetedClients = new Set(targeted.map((entry) => entry.client));
		for (const client of this.state.clients.values()) {
			if (targetedClients.has(client)) continue;
			if (!client.isAlive()) continue;
			// A live client outside this touch's scope still holds the document, so
			// its view is NOT covered by this content. Recording here would claim it.
			if (documentIsOpenOn(client, filePath)) return;
		}
		this.documentDrift.recordSynced(filePath, content, at);
	}

	/**
	 * #1934 review F1: record what a `spawnClient` call decided, at the point
	 * it decides it. Called on EVERY path that returns without a client, so
	 * "no verdict" cannot silently mean "failed".
	 *
	 * `"failed"` is a server failure: the spawn or the initialize handshake
	 * went wrong. `"declined"` is policy or lifecycle: host trust refused the
	 * binary, the service shut down mid-spawn, or the binary is absent while
	 * installs are disabled. That last one sets a breaker cooldown but is NOT
	 * a failure, which is exactly why the outcome cannot be inferred from
	 * breaker state.
	 */
	private noteSpawnVerdict(key: string, verdict: "failed" | "declined"): void {
		this.lastSpawnVerdict.set(key, verdict);
	}

	private async ensureClientForServer(
		filePath: string,
		server: LSPServerInfo,
		resolvedRoots?: Map<string, string>,
		onSpawnInFlight?: (serverId: string) => void,
		onOutcome?: (outcome: LSPClientAcquisitionOutcome) => void,
	): Promise<SpawnedServer | undefined> {
		const handoff = this.generationHandoff;
		if (handoff) {
			await handoff;
			if (this.generationHandoff === handoff) {
				this.generationHandoff = undefined;
			}
			if (this.checkDestroyed()) return undefined;
		}

		const root = await this.resolveServerRoot(server, filePath);
		if (!root || this.checkDestroyed()) return undefined;
		if (server.role !== "auxiliary") {
			resolvedRoots?.set(server.id, normalizeMapKey(root));
		}
		const allowInstall = this.shouldAllowInstall(server.id);

		const normalizedRoot = normalizeMapKey(root);
		const key = `${server.id}:${normalizedRoot}`;
		const isOptionalServer = OPTIONAL_LSP_SERVER_IDS.has(server.id); // NOSONAR: set intentionally empty — no optional servers configured yet

		if (
			server.availabilityKey &&
			isDirectLspCommandTemporarilyUnavailable(server.availabilityKey)
		) {
			// #1743: during an outage this path runs once per file per touch,
			// so a raw write here is a per-file log storm. The ledger counts
			// every skip exactly, keyed on (command, file); only the first per
			// pair also writes the detailed record.
			emitBounded(
				"lsp_client_skipped_unavailable_command",
				`${server.availabilityKey}:${normalizeMapKey(filePath)}`,
				{
					filePath,
					durationMs: 0,
					metadata: {
						serverId: server.id,
						command: server.availabilityKey,
					},
				},
				{
					ledgerKind: "lsp-client-skipped-unavailable-command",
					risingEdgePer: "identity",
					reason: `command ${server.availabilityKey} temporarily unavailable`,
				},
			);
			return undefined;
		}

		if (isOptionalServer && this.optionalDisabled.has(key)) {
			return undefined;
		}
		if (this.permanentlyBroken.has(key)) {
			// #1743: same per-file-per-touch storm as the unavailable-command
			// skip above. Identity is (server, file) so a single wedged server
			// cannot hide which files it is refusing.
			emitBounded(
				"lsp_client_skipped_broken",
				`${server.id}:${normalizeMapKey(filePath)}`,
				{
					filePath,
					durationMs: 0,
					metadata: {
						serverId: server.id,
						permanent: true,
					},
				},
				{
					ledgerKind: "lsp-client-skipped-broken",
					risingEdgePer: "identity",
					reason: `${server.id} latched permanently broken`,
				},
			);
			return undefined;
		}

		const existing = this.state.clients.get(key);
		if (existing) {
			if (existing.isAlive()) {
				this.unavailableLogged.delete(key);
				this.clientLastUsedAt.set(key, Date.now());
				this.scheduleTypeScriptIdleEviction(key);
				if (!this.warmStartLogged.has(key)) {
					logSessionStart(
						`lsp warm-start ${server.id}: reused root=${root} file=${filePath}`,
					);
					this.warmStartLogged.add(key);
				}
				// #1934: the pool paid nothing. This is the outcome the reuse rate
				// is built from, so it is reported on the ONE path that returns a
				// client without spawning.
				onOutcome?.("warm-reuse");
				return { client: existing, info: server };
			}
			// Dead client — was previously alive, now needs respawn
			const spawnedAt = this.state.clientSpawnedAt.get(key);
			// #1127: capture BEFORE calling existing.shutdown() below — both
			// wasShutdownIntentional() and getExitedAt() read state that
			// existing.shutdown() itself mutates as a side effect of our own
			// cleanup (shutdownRequested flips true, and the process exit it
			// triggers would stamp exitedAt at CLEANUP time rather than at the
			// real death), so both must be read before that call.
			const wasIntentional = existing.wasShutdownIntentional();
			const exitedAt = existing.getExitedAt();
			// #1127: lifetime MUST be measured from the client's own recorded
			// death (exitedAt), not from "now" (this detection). Detection is
			// lazy — the next file attach — and #1127's real-world pattern is
			// attach-triggered respawns minutes to HOURS apart: a server that
			// died 5s after spawning but wasn't detected until an hour later
			// must still read as an early, breaker-worthy exit. Fall back to the
			// detection-time delta only when exitedAt is somehow unset (the
			// client's own exit handlers always set it before isAlive() can go
			// false, so this is a defensive fallback, not the expected path).
			const uptimeMs =
				exitedAt != null && spawnedAt != null
					? exitedAt - spawnedAt
					: spawnedAt != null
						? Date.now() - spawnedAt
						: null;
			logLatency({
				type: "phase",
				phase: "lsp_server_respawn",
				filePath,
				durationMs: 0,
				metadata: {
					serverId: server.id,
					root,
					uptimeMs,
					intentional: wasIntentional,
				},
			});
			this.releaseOutstandingAuxNotifyWrite(key);
			try {
				await existing.shutdown();
			} catch {
				/* ignore dead client shutdown errors */
			}
			this.state.clients.delete(key);
			this.state.clientSpawnedAt.delete(key);
			this.clientLastUsedAt.delete(key);
			this.clearTypeScriptIdleTimer(key);
			this.state.broken.delete(key);

			// #1127: count EARLY, non-intentional runtime exits toward the circuit
			// breaker. Spawn/initialize itself succeeded here (this client made it
			// into state.clients), so `failureCounts` — the spawn/init breaker —
			// never saw this failure and was cleared to 0 on that earlier success.
			// Without this, a server that spawns fine and then dies shortly after
			// serving (opengrep's post-init "Unhandled message" crash, #1122/#1127)
			// respawns forever: cooldown/permanent-disable never engage.
			//
			// Deliberate teardowns (session reset, #743 notify-backpressure
			// eviction, a generation handoff) call `shutdown()` themselves and set
			// `shutdownRequested` before the process exits — those must never count,
			// or a legitimate restart would wrongly march the server toward
			// permanent disablement.
			if (wasIntentional) {
				// Not evidence of a bad server — leave any existing runtime-exit
				// streak alone (a deliberate restart is not a recovery signal
				// either; only clear the streak once the server proves itself by
				// staying up past the threshold, handled in the `else` below). The
				// windowed-rate trip below is likewise gated behind this
				// `!wasIntentional` guard, so user-initiated restarts, config/
				// workspace reloads, session changes, #743 eviction and generation
				// handoffs (all shutdown()-driven) never feed it.
			} else {
				// #1142: windowed-rate trip — the SECOND, independent breaker
				// condition, composed with the fast path below. Record this
				// non-intentional death and, if RUNTIME_EXIT_WINDOW_TRIP_COUNT
				// deaths fell within the rolling window, give up NOW regardless of
				// each death's individual lifetime. This catches the slow loop
				// (dies just past the 60s threshold every spawn) that the
				// consecutive-early-exit fast path structurally cannot see.
				if (this.recordRuntimeExitWindow(key, exitedAt, uptimeMs)) {
					const rate = `${RUNTIME_EXIT_WINDOW_TRIP_COUNT} deaths within ${Math.round(RUNTIME_EXIT_WINDOW_MS / 60_000)}m`;
					// Set a cooldown so THIS detection also stops respawning (the
					// broken check below at the end of this method re-reads it),
					// symmetric with the fast path which cools down on every count.
					// `max` is defensive, not load-bearing under the actual call
					// order: `state.broken` for this key is `delete`d at the top of
					// this method (see the "detect dead client" branch above), so
					// this `.get(key) ?? 0` always reads 0 here — it's the fast
					// path below that runs AFTER this block and can raise the
					// cooldown for the same death. Harmless either way: the
					// non-optional branch latches `permanentlyBroken` (making the
					// cooldown moot), and the optional branch here is currently
					// unreachable (`OPTIONAL_LSP_SERVER_IDS` is empty).
					this.state.broken.set(
						key,
						Math.max(
							this.state.broken.get(key) ?? 0,
							Date.now() +
								(isOptionalServer
									? OPTIONAL_LSP_RETRY_COOLDOWN_MS
									: BROKEN_MAX_COOLDOWN_MS),
						),
					);
					if (isOptionalServer) {
						// Optional servers never latch permanently (mirrors the fast
						// path): cool down + disable for a retry interval, and reset
						// the window so the trip must be re-earned afterward.
						this.optionalDisabled.add(key);
						this.runtimeExitWindow.delete(key);
						logSessionStart(
							`lsp respawn ${server.id}: optional server cooled down (windowed-rate trip: ${rate})`,
						);
					} else {
						this.permanentlyBroken.add(key);
						this.recordBreaker(key, `windowed runtime-exit trip: ${rate}`);
						logSessionStart(
							`lsp respawn ${server.id}: permanently disabled (windowed-rate trip: ${rate}, uptimeMs=${uptimeMs})`,
						);
					}
				}

				// #1127/#1139 fast path — CONSECUTIVE exits UNDER the 60s
				// threshold. UNCHANGED: its own counter, its own trip point. A
				// single death may feed BOTH accumulators (the window above AND
				// runtimeExitCounts here), but neither alters the other's threshold,
				// so the fast path's trip point is exactly what it was.
				if (uptimeMs != null && uptimeMs < RUNTIME_EXIT_UPTIME_THRESHOLD_MS) {
					const rCount = (this.runtimeExitCounts.get(key) ?? 0) + 1;
					this.runtimeExitCounts.set(key, rCount);
					const rCooldown = Math.min(
						BROKEN_BASE_COOLDOWN_MS * 2 ** (rCount - 1),
						BROKEN_MAX_COOLDOWN_MS,
					);
					this.state.broken.set(key, Date.now() + rCooldown);
					if (!isOptionalServer && rCount >= BROKEN_PERMANENT_AFTER) {
						this.permanentlyBroken.add(key);
						this.recordBreaker(
							key,
							`permanently disabled after ${rCount} early post-init exits`,
						);
						logSessionStart(
							`lsp respawn ${server.id}: permanently disabled after ${rCount} early post-init exits (uptimeMs=${uptimeMs})`,
						);
					} else {
						logSessionStart(
							`lsp respawn ${server.id}: early post-init exit ${rCount}/${BROKEN_PERMANENT_AFTER} (uptimeMs=${uptimeMs}), cooldown=${rCooldown}ms`,
						);
					}
				} else {
					// Survived past the threshold (or uptime unknown) before dying —
					// this was a functioning server, not a HOT crash loop. Reset the
					// consecutive-early streak so an occasional post-longrun crash
					// doesn't creep it toward permanent disablement. The windowed
					// counter above is deliberately NOT reset here: a ~65-90s death
					// lands in this branch yet IS the churn #1142 targets — the
					// window ages those out by time instead.
					this.runtimeExitCounts.delete(key);
					// Outer-map hygiene (#1183): runtimeExitWindow itself is only
					// ever `delete`d on the optional-trip branch above (currently
					// unreachable — OPTIONAL_LSP_SERVER_IDS is empty), so a key
					// that crashed once then recovered would otherwise retain a
					// stale timestamp array forever, even once every entry in it
					// has aged out of the window. Drop it here once nothing in it
					// is still in-window — purely map hygiene: a later death
					// rebuilds the array from scratch via recordRuntimeExitWindow,
					// so this cannot change trip behavior. Anchor "now" on this
					// death's own `exitedAt` (falling back to real time only if
					// unset), NOT `Date.now()` directly — this death's timestamp
					// is what `recordRuntimeExitWindow` itself anchors pruning on
					// (see its `windowRef` comment), so a death that WAS just
					// recorded is guaranteed to still be in-window here and this
					// can only ever fire for the "declined to record" cases
					// (over the sleep-gap ceiling, or a missing `exitedAt`) where
					// nothing new was added and the array is genuinely stale.
					const windowDeaths = this.runtimeExitWindow.get(key);
					if (windowDeaths) {
						const windowNow = exitedAt ?? Date.now();
						if (
							!windowDeaths.some((t) => t >= windowNow - RUNTIME_EXIT_WINDOW_MS)
						) {
							this.runtimeExitWindow.delete(key);
						}
					}
				}
			}
		}

		const brokenUntil = this.state.broken.get(key);
		if (typeof brokenUntil === "number" && brokenUntil > Date.now()) {
			// #1743: the breaker-cooldown sibling of the permanently-broken skip
			// above, sharing its identity so an outage produces one record per
			// (server, file) rather than one per touch.
			emitBounded(
				"lsp_client_skipped_broken",
				`${server.id}:${normalizeMapKey(filePath)}`,
				{
					filePath,
					durationMs: 0,
					metadata: {
						serverId: server.id,
						retryInMs: Math.max(0, brokenUntil - Date.now()),
					},
				},
				{
					ledgerKind: "lsp-client-skipped-broken",
					risingEdgePer: "identity",
					reason: `${server.id} in breaker cooldown`,
				},
			);
			return undefined;
		}
		if (typeof brokenUntil === "number" && brokenUntil <= Date.now()) {
			this.state.broken.delete(key);
			if (isOptionalServer) this.optionalDisabled.delete(key);
		}

		// #2064: did THIS caller start the language-server process, or did it
		// join a spawn another caller already had in flight? The answer is only
		// knowable here, before the await — downstream of `await spawnPromise`
		// the two are indistinguishable, which is exactly how the 3.0x
		// over-count happened. There are two join sites and both count as
		// joins: the unguarded read below, and the `raced` re-read inside the
		// spawn gate, which catches a caller that reached the gate before the
		// starter published its promise.
		let startedSpawn = false;
		let spawnPromise = this.state.inFlight.get(key);
		if (!spawnPromise) {
			const started = await this.withClientSpawnGate(async () => {
				const raced = this.state.inFlight.get(key);
				if (raced) return { promise: raced, startedSpawn: false };
				// `server.root()` and dead-client cleanup above are async. A reset during
				// either gap must not let this retired generation start a late spawn.
				if (this.checkDestroyed()) return undefined;
				if (!(await this.makeCapacityForClient(key))) return undefined;
				const promise = this.spawnClient(
					server,
					root,
					key,
					filePath,
					allowInstall,
				);
				this.state.inFlight.set(key, promise);
				return { promise, startedSpawn: true };
			});
			if (!started) return undefined;
			spawnPromise = started.promise;
			startedSpawn = started.startedSpawn;
		}
		// Announce the in-flight spawn so the caller can skip a doomed touch
		// wait. The announcement never returns a client and never
		// short-circuits. A spawn that settles inside the race window is picked
		// up by getClientForFile, which re-reads `state.clients` at the point it
		// acts on the shortcut.
		//
		// Do NOT add a `state.clients` early return here. This point sits
		// downstream of the warm-reuse path, the dead-client shutdown, the #1127
		// give-up latch, the breaker cooldown, and the #1332 idle eviction, so a
		// return here re-publishes a client every one of those already declined.
		// It also skips the `finally` below that owns the `inFlight` entry,
		// which strands the settled promise and stops the server respawning.
		onSpawnInFlight?.(server.id);

		try {
			const spawned = await spawnPromise;
			// #1934: a client here cost a process WAIT, whether this caller
			// started the spawn or joined another caller's in-flight promise.
			// Either way the selection was not served from the warm pool.
			// #2064: which of the two it was is now named, so the record can
			// answer "how many processes started" as well as "how many
			// selections paid a wait". `startedSpawn` is captured before the
			// await, because after it the two are indistinguishable.
			//
			// The verdict read is synchronous and sits in the same microtask as
			// the await above, so it can only see the attempt just settled.
			onOutcome?.(
				spawned
					? startedSpawn
						? "cold-spawn"
						: "cold-spawn-joined"
					: this.lastSpawnVerdict.get(key) === "failed"
						? startedSpawn
							? "spawn-failure"
							: "spawn-failure-joined"
						: "declined",
			);
			return spawned;
		} catch (err) {
			// A throwing spawn promise is an errored acquisition by definition.
			//
			// #2064 review F2: deliberately NOT split into a starter/joiner pair
			// like the resolve path above, because nothing could observe the
			// split. `spawnClient` never rethrows; it catches its own spawn and
			// initialize failures and resolves `undefined`. This catch is
			// therefore reachable only when `spawnClient` throws BEFORE its own
			// `try` (the trust probe, `logSessionStart`, `recordLsp`). A joiner
			// CAN read the already-rejected promise out of `inFlight` (the #2106
			// verify measured 2 invocations for 3 callers), but it does not
			// matter: the rethrow
			// below unwinds past every `lsp_client_selected` emit site, so this
			// value is written to no record: a probe drove a throwing trust
			// check through two concurrent callers and got two rejections and
			// zero selection records. An unobservable discriminator is a
			// vacuous guard, so this path keeps the single #1934 value.
			onOutcome?.("spawn-failure");
			throw err;
		} finally {
			if (this.state.inFlight.get(key) === spawnPromise) {
				this.state.inFlight.delete(key);
			}
		}
	}

	private shouldAllowInstall(serverId: string): boolean {
		if (!assertInstallAllowed(`lsp install: ${serverId}`)) return false;
		return process.env.PI_LENS_DISABLE_LSP_INSTALL !== "1";
	}

	/**
	 * Internal: spawn a client for a server/root combination
	 */
	private async spawnClient(
		server: LSPServerInfo,
		root: string,
		key: string,
		filePath: string,
		allowInstall: boolean,
	): Promise<SpawnedServer | undefined> {
		// #1334 S5: honor the host project-trust decision before executing any
		// project-resolved binary. Only an explicit host "not trusted" blocks —
		// a host with no trust surface (`"unknown"`) spawns exactly as before.
		// Deliberately NOT marked broken: trust is a policy outcome, not a server
		// failure, and the user may grant trust later in the same session.
		if (!isLspSpawnAllowedByTrust()) {
			logSessionStart(
				`lsp spawn ${server.id}: refused — ${projectTrustDenialReason()}`,
			);
			this.noteSpawnVerdict(key, "declined");
			return undefined;
		}
		const isOptionalServer = OPTIONAL_LSP_SERVER_IDS.has(server.id); // NOSONAR: set intentionally empty — no optional servers configured yet
		const startedAt = Date.now();
		logSessionStart(
			`lsp spawn ${server.id}: start root=${root} install=${allowInstall ? "enabled" : "disabled"} file=${filePath}`,
		);
		recordLsp(server.id, root, "spawn_start");
		try {
			const spawned = await server.spawn(root, { allowInstall });

			// Guard 1: service was shut down while we were waiting for the spawn.
			// Kill the raw process — no LSPClient exists yet — and bail out without
			// marking the key broken (this is not a server failure).
			if (this.isDestroyed) {
				try {
					spawned?.process?.process?.kill();
				} catch {
					// pi-lens-ignore: missing-error-propagation — best-effort kill on aborted spawn
				}
				logSessionStart(
					`lsp spawn ${server.id}: aborted (service shut down mid-spawn)`,
				);
				this.noteSpawnVerdict(key, "declined");
				return undefined;
			}

			if (!spawned) {
				logSessionStart(
					`lsp spawn ${server.id}: unavailable (${Date.now() - startedAt}ms)`,
				);
				recordLsp(server.id, root, "spawn_failed", Date.now() - startedAt);

				// When installs are disabled, an unavailable binary is an expected
				// policy outcome, not proof the server/root is broken. Cool down briefly
				// to avoid hot-looping PATH probes, but do not count toward permanent
				// disablement: a user may install or expose the binary on PATH during the
				// same session and should not need a full LSP reset.
				if (!allowInstall) {
					logSessionStart(
						`lsp spawn ${server.id}: unavailable with install disabled; temporary cooldown only`,
					);
					this.state.broken.set(key, Date.now() + BROKEN_BASE_COOLDOWN_MS);
					// #1934 review F1: this branch sets a cooldown but is a POLICY
					// decline by the comment above — the binary may appear on PATH
					// later in the same session, so it never counts toward permanent
					// disablement and the cooldown has no ladder. With installs
					// disabled or a project untrusted, a missing binary reaches here
					// once per 15s per (server, root) for the whole session. Calling
					// that a spawn failure would write thousands of mislabeled
					// records a day, so it reads as a decline. The event is already
					// recorded once by `lsp_client_unavailable` and by the
					// `sessionstart.log` line above.
					this.noteSpawnVerdict(key, "declined");
					return undefined;
				}

				const uCount = (this.failureCounts.get(key) ?? 0) + 1;
				this.failureCounts.set(key, uCount);
				const uCooldown = Math.min(
					BROKEN_BASE_COOLDOWN_MS * 2 ** (uCount - 1),
					BROKEN_MAX_COOLDOWN_MS,
				);
				this.state.broken.set(key, Date.now() + uCooldown);
				if (uCount >= BROKEN_PERMANENT_AFTER) {
					this.permanentlyBroken.add(key);
					this.recordBreaker(
						key,
						`permanently disabled after ${uCount} unavailable spawns`,
					);
					logSessionStart(
						`lsp spawn ${server.id}: permanently disabled after ${uCount} failures`,
					);
				}
				// Installs were allowed and the server is still unavailable: a real
				// failure, on the exponential ladder toward permanent disablement.
				this.noteSpawnVerdict(key, "failed");
				return undefined;
			}

			const override = getServerInitOverride(server.id, filePath);
			const mergedInit = mergeInitializationOptions(
				spawned.initialization,
				override?.initializationOptions,
			);

			const client = await createLSPClient({
				serverId: server.id,
				process: spawned.process,
				root,
				sessionCwd: this.sessionCwd,
				initialization: mergedInit,
				initializeTimeoutMs: server.initializeTimeoutMs,
				launchVariant: spawned.launchVariant,
			});

			// Guard 2: service was shut down while we were completing the initialize
			// handshake. Shut down the live client best-effort and do not register it.
			if (this.isDestroyed) {
				client.shutdown({ fast: true }).catch(() => {});
				logSessionStart(
					`lsp spawn ${server.id}: aborted (service shut down mid-initialize)`,
				);
				this.noteSpawnVerdict(key, "declined");
				return undefined;
			}

			const wsDiag =
				typeof client.getWorkspaceDiagnosticsSupport === "function"
					? client.getWorkspaceDiagnosticsSupport()
					: {
							advertised: false,
							mode: "push-only" as const,
							diagnosticProviderKind: "unavailable",
						};

			this.state.clients.set(key, client);
			// #2356: this generation is the replacement the late-coverage probe was
			// waiting for. Clear the retired-generation marker before any later probe.
			this.notifyStallDemotions.delete(key);
			this.unavailableLogged.delete(key);
			// #1934 review F1: a success retires the previous verdict, so the map
			// never outlives the attempts it describes.
			this.lastSpawnVerdict.delete(key);
			this.state.clientSpawnedAt.set(key, Date.now());
			this.clientLastUsedAt.set(key, Date.now());
			this.scheduleTypeScriptIdleEviction(key);
			this.failureCounts.delete(key);
			if (isOptionalServer) {
				this.optionalDisabled.delete(key);
				this.optionalFailureLogged.delete(key);
			}
			logSessionStart(
				`lsp spawn ${server.id}: success source=${spawned.source ?? "unknown"} (${Date.now() - startedAt}ms)`,
			);
			const spawnDurationMs = Date.now() - startedAt;
			recordLsp(server.id, root, "spawn_success", spawnDurationMs);
			recordSuccessfulLspSpawn(server.id, spawnDurationMs);
			// #2064: the only latency record that a language-server PROCESS
			// started. `lsp_launch_candidate_success` covers the servers that
			// launch through `resolveAndLaunch` and never fired for TypeScript,
			// which served 913 of 941 selections in the field window — so
			// nothing in `latency.log` counted the 29.3s TypeScript spawn at
			// all. This sits at `spawnClient`'s single success path, so every
			// server reports through one record instead of a per-server
			// launcher, and `count(serverId=typescript)` is answerable from
			// `latency.log` alone. Volume is bounded by process starts: one
			// record per spawn, and a spawn is single-flighted per
			// `serverId:root` by `state.inFlight`.
			//
			// The two path fields are deliberate and are not duplicates.
			// `filePath` carries the ROOT, because the root plus `serverId` is
			// the client's identity and the unit a spawn is single-flighted on.
			// `triggerFilePath` carries the file whose touch paid for the
			// spawn, which answers a different question and is the one that
			// varies across records for the same client.
			logLatency({
				type: "phase",
				phase: "lsp_server_spawned",
				filePath: root,
				durationMs: spawnDurationMs,
				metadata: {
					serverId: server.id,
					source: spawned.source ?? "unknown",
					launchVariant: spawned.launchVariant ?? "default",
					triggerFilePath: filePath,
				},
			});
			if (!this.workspaceProbeLogged.has(key)) {
				logSessionStart(
					`lsp workspace-diag probe ${server.id}: advertised=${wsDiag.advertised} mode=${wsDiag.mode} provider=${wsDiag.diagnosticProviderKind}`,
				);
				this.workspaceProbeLogged.add(key);
			}
			return { client, info: server };
		} catch (err) {
			recordLsp(server.id, root, "spawn_failed", Date.now() - startedAt);
			if (!isOptionalServer || !this.optionalFailureLogged.has(key)) {
				logSessionStart(
					`lsp spawn ${server.id}: failed (${Date.now() - startedAt}ms) error=${err instanceof Error ? err.message : String(err)}`,
				);
				if (isOptionalServer) {
					this.optionalFailureLogged.add(key);
				}
			}
			const eCount = (this.failureCounts.get(key) ?? 0) + 1;
			this.failureCounts.set(key, eCount);
			const eCooldown = isOptionalServer
				? OPTIONAL_LSP_RETRY_COOLDOWN_MS
				: Math.min(
						BROKEN_BASE_COOLDOWN_MS * 2 ** (eCount - 1),
						BROKEN_MAX_COOLDOWN_MS,
					);
			this.state.broken.set(key, Date.now() + eCooldown);
			if (!isOptionalServer && eCount >= BROKEN_PERMANENT_AFTER) {
				this.permanentlyBroken.add(key);
				this.recordBreaker(
					key,
					`permanently disabled after ${eCount} spawn/initialize failures`,
				);
				logSessionStart(
					`lsp spawn ${server.id}: permanently disabled after ${eCount} failures`,
				);
			}
			if (isOptionalServer) {
				this.optionalDisabled.add(key);
			}
			// The spawn or the initialize handshake threw: a server failure.
			this.noteSpawnVerdict(key, "failed");
			return undefined;
		}
	}

	/**
	 * Open a file in LSP (sends textDocument/didOpen)
	 */
	async openFile(
		filePath: string,
		content: string,
		options?: { preserveDiagnostics?: boolean; spawnBudgetMs?: number },
	): Promise<void> {
		if (this.checkDestroyed()) return;
		// #1783: anchored before the client acquisition, for the same reason
		// touchFile anchors on its own start — see recordFullyCoveredSync.
		const startedAt = Date.now();
		await this.withClientForFileUse(
			filePath,
			undefined,
			options?.spawnBudgetMs,
			async (spawned) => {
				const languageId = getLanguageId(filePath) ?? "plaintext";
				await spawned.client.notify.open(
					filePath,
					content,
					languageId,
					options?.preserveDiagnostics,
				);
				// #1783: openFile is a real sync path — actionable-warnings and the
				// diagnostic-freshness callers reach a server through here and never
				// through touchFile. Without this, those documents were invisible to
				// the drift backstop. The same full-coverage gate applies, so an
				// auxiliary holding the document keeps the record unwritten rather
				// than letting one client's push claim every view is current.
				this.recordFullyCoveredSync(
					filePath,
					content,
					[spawned],
					true,
					startedAt,
				);
			},
		);
	}

	/**
	 * Update file content (sends textDocument/didChange)
	 */
	async updateFile(filePath: string, content: string): Promise<void> {
		if (this.checkDestroyed()) return;
		await this.withClientForFileUse(filePath, undefined, undefined, (spawned) =>
			spawned.client.notify.change(filePath, content),
		);
	}

	/**
	 * Touch a file like OpenCode's LSP flow: ensure document is open/synced,
	 * and optionally collect diagnostics with explicit scope.
	 */
	async touchFile(
		filePath: string,
		content: string,
		options: LSPTouchFileOptions = {},
	): Promise<
		// #1179 (shape-5 structural fix): a WRAPPER, not the bare array. `.diags`
		// carries the diagnostics; `.inconclusive` (#570/#1093) and `.binding`
		// (#1095) are EXPLICIT ENUMERABLE fields, so a `[...]`/`.map`/`.filter`/
		// `JSON` copy of `.diags` cannot silently drop them (was the #1094/#1096
		// copy-loss class — the flags used to ride the array as non-enumerable
		// side-channels). See `TouchFileResult` for the field-presence contract.
		TouchFileResult | undefined
	> {
		if (this.checkDestroyed()) {
			// #1618: a destroyed service never reaches the language server — this
			// early return used to log nothing at all, so a workspace sweep whose
			// idle-reset timer fired mid-run left every remaining file with zero
			// trace, indistinguishable from budget exhaustion. Cheap and local: no
			// server round trip, matching the `no_clients`/`success` sibling
			// records this phase already emits below.
			const destroyedDiagnosticsMode = options.collectDiagnostics
				? (options.diagnostics ?? "document")
				: (options.diagnostics ?? "none");
			logLatency({
				type: "phase",
				phase: "lsp_touch_file",
				filePath: normalizeMapKey(filePath),
				durationMs: 0,
				metadata: {
					serverCountAttempted: 0,
					serverCountReady: 0,
					clientScope:
						options.clientScope ??
						(destroyedDiagnosticsMode === "full" ? "all" : "primary"),
					diagnosticsMode: destroyedDiagnosticsMode,
					source: options.source ?? "unknown",
					failureKind: "destroyed",
				},
			});
			return;
		}
		const startedAt = Date.now();
		const normalizedPath = normalizeMapKey(filePath);
		const outsideRoot = await this.findOutsideProjectRoot(filePath);
		if (outsideRoot) {
			this.recordOutsideRootDecline(filePath, outsideRoot, "touchFile");
			return { diags: [], skipReason: "outside-project-root" };
		}
		// #1783: every path that asks a language server anything comes through
		// here, so this is where the disk-drift backstop gets its heartbeat.
		// Deliberately NOT awaited: the sweep is rate-limited to one pass per
		// 10s and runs alongside this touch's own client acquisition and
		// diagnostics wait, so it adds nothing to this call's latency. The
		// resync it may issue re-enters touchFile; every such re-entry happens
		// while the pass is still running, so the tracker's single-flight guard
		// returns the running pass and no recursion occurs. That guard is the
		// single mechanism — there is deliberately no second source-based check
		// here, which would be an unprovable duplicate of it.
		void this.sweepDocumentDrift().catch(() => {});
		const diagnosticsMode = options.collectDiagnostics
			? (options.diagnostics ?? "document")
			: (options.diagnostics ?? "none");
		const source = options.source ?? "unknown";
		const clientScope: LSPTouchClientScope =
			options.clientScope ?? (diagnosticsMode === "full" ? "all" : "primary");
		const useAllClients = clientScope === "all";
		const resolvedPrimaryRoots = new Map<string, string>();
		const waitSkipReasons = new Set<string>();
		const coldAuxiliaryServerIds = new Set<string>();
		const noteColdAuxiliary = (
			serverId: string,
			outcome: LSPClientAcquisitionOutcome,
		): void => {
			if (outcome === "cold-spawn" || outcome === "cold-spawn-joined") {
				coldAuxiliaryServerIds.add(serverId);
			}
		};
		let spawned: SpawnedServer[];
		let serverCountAttempted: number;
		if (useAllClients) {
			const result = await this.getClientsForFile(
				filePath,
				options.excludeServerIds,
				resolvedPrimaryRoots,
			);
			spawned = result.clients;
			serverCountAttempted = result.serverCountAttempted;
		} else if (clientScope === "with-auxiliary") {
			// Primary language server + the enabled cross-cutting auxiliaries
			// (opengrep, …). The aggregation layer merges/dedups their diagnostics.
			const [entry, aux] = await Promise.all([
				this.getClientForFile(
					filePath,
					options.maxClientWaitMs,
					undefined,
					resolvedPrimaryRoots,
					waitSkipReasons,
				),
				this.getAuxiliaryClientsForFile(
					filePath,
					new Set(options.auxiliaryServerIds ?? []),
					noteColdAuxiliary,
				),
			]);
			spawned = entry ? [entry, ...aux] : aux;
			serverCountAttempted = spawned.length;
		} else {
			const entry = await this.getClientForFile(
				filePath,
				options.maxClientWaitMs,
				undefined,
				resolvedPrimaryRoots,
				waitSkipReasons,
			);
			spawned = entry ? [entry] : [];
			serverCountAttempted =
				spawned.length > 0
					? 1
					: getServersForFileWithConfig(filePath).length > 0
						? 1
						: 0;
		}
		if (spawned.length === 0) {
			// A bounded caller can lose the client race while the single-flight spawn
			// it started is still progressing. Preserve that lifecycle evidence in the
			// touch verdict instead of reclassifying an empty ready set as absence.
			// `isSpawnInFlight` reads the spawn coordinator's own state and filters to
			// primary candidates, so this stays coupled to the dedupe mechanism.
			const failureKind = this.isSpawnInFlight(filePath, resolvedPrimaryRoots)
				? "spawn_in_flight_budget_elapsed"
				: "no_clients_none_spawning";
			logLatency({
				type: "phase",
				phase: "lsp_touch_file",
				filePath: normalizedPath,
				durationMs: Date.now() - startedAt,
				metadata: {
					serverCountAttempted,
					serverCountReady: 0,
					clientScope,
					diagnosticsMode,
					source,
					maxClientWaitMs: options.maxClientWaitMs,
					failureKind,
					...(waitSkipReasons.size > 0
						? { reason: [...waitSkipReasons][0] }
						: {}),
				},
			});
			return;
		}
		const leaseKeys = await this.acquireClientLeases(spawned, filePath);
		if (!leaseKeys) {
			// An idle eviction won between selection and lease admission. Resolve the
			// now-current client set and replay; no notification targets the retiree.
			return this.touchFile(filePath, content, options);
		}
		try {
			const spawnedServerIds = spawned.map((entry) => entry.info.id);
			if (
				this.shouldSkipTouch(
					filePath,
					content,
					clientScope,
					diagnosticsMode !== "none",
					spawnedServerIds,
				)
			) {
				logLatency({
					type: "phase",
					phase: "lsp_touch_file",
					filePath: normalizedPath,
					durationMs: Date.now() - startedAt,
					metadata: {
						serverCountReady: spawned.length,
						clientScope,
						diagnosticsMode,
						source,
						failureKind: "success",
						skipped: true,
						reason: "debounced_unchanged_content",
					},
				});
				// #1179: a debounced skip collected nothing — resolve the wrapper's
				// `.diags` as empty with neither flag (exactly the pre-wrapper `[]`).
				return { diags: [] };
			}

			const languageId = getLanguageId(filePath) ?? "plaintext";
			const silent = options.silent ?? false;
			// When the same content was already pushed to the LSP within the touch
			// debounce window, skip the notify — pushing again clears the LSP's
			// diagnostic cache (via notify.open) and forces it to restart work it
			// already did. This is what makes the post-write touch + dispatch-lsp-
			// runner touch sequence expensive on slow TS projects.
			//
			// #743: resolved PER SERVER. A server whose sibling's write stalled last
			// touch still holds its own debounce entry, so it is skipped here while the
			// stalled server (which has no entry) gets re-pushed. `notifySkipped` stays
			// as the file-level "every server was skipped" summary for the logs and the
			// no-new-version baseline below.
			const notifySkippedServerIds = new Set(
				spawnedServerIds.filter((serverId) =>
					this.shouldSkipNotify(filePath, content, clientScope, serverId),
				),
			);
			const notifySkipped =
				spawned.length > 0 && notifySkippedServerIds.size === spawned.length;
			// #1531: the pre-notify diagnostics baseline for THIS file on each client.
			// It used to be `client.diagnosticsVersion`, a client-GLOBAL counter that also
			// advances for files this touch never mentions — which let a sibling file's
			// publication both end this file's wait early and read as an answer for it.
			// `getDiagnosticsVersionForPath` returns that same counter's value as of this
			// file's last publication, so every comparison downstream stays on one axis
			// while ignoring sibling paths. Captured here because the notify below clears
			// each client's cache for the file.
			//
			// The accessor is REQUIRED on `LSPClient`, so a real client always answers
			// with a number. The optional call is only so a hand-written test double that
			// predates it fails CLOSED — `undefined` keeps the existing "no usable
			// baseline" branch below and can never satisfy the evidence check — instead of
			// quietly reverting to the global counter, which is the defect itself.
			const readPathVersion = (
				client: (typeof spawned)[number]["client"],
			): number | undefined => client.getDiagnosticsVersionForPath?.(filePath);
			const diagnosticBaselines = new Map(
				spawned.map((entry) => [entry.client, readPathVersion(entry.client)]),
			);
			// #2161: anchor publication evidence before this touch's notify. A
			// later per-file cache entry, including an empty one, proves that the
			// primary answered; an empty diagnostics result alone cannot.
			const markedAtMs = Date.now();
			// #1458: read a late auxiliary publication BEFORE the ordinary resync
			// clears its client cache. Carry it only when the publication's exact
			// sent-content fingerprint matches this touch's content. A changed edit,
			// version-less publication, or malformed binding fails closed and is not
			// replayed. The fresh notify still runs below, so scanners continue toward
			// a publication for this touch while the prior late result reaches the read.
			const touchContentHash = this.hashContent(content);
			// #1586: THE content-match atom. Every content-bound question in this touch
			// — the carry-over below, #1493's pre-notify snapshot, and the merge-time
			// coverage predicate — asks it here and nowhere else, so a door cannot
			// acquire a rule of its own by writing the comparison inline. A binding with
			// no `contentHash` (version-less publish) fails closed: `undefined` never
			// equals a hash.
			const bindingMatchesTouchContent = (
				binding: StoredDiagnosticBinding | undefined,
			): boolean => binding?.contentHash === touchContentHash;
			const carriedAuxiliary = options.collectDiagnostics
				? spawned.flatMap((entry) => {
						if (entry.info.role !== "auxiliary") return [];
						const binding = entry.client.getDiagnosticBinding?.(filePath);
						if (!bindingMatchesTouchContent(binding)) return [];
						const diags = entry.client.getDiagnostics(filePath);
						return diags.length > 0 ? [{ diags, binding }] : [];
					})
				: [];
			// #1493: auxiliaries whose STORED publication already covers exactly the
			// bytes this touch carries. Read BEFORE the notify below, which clears each
			// client's cache for the file. Unlike `carriedAuxiliary` this does not
			// require findings: an empty publication bound to this content is evidence
			// the scanner reported, which is what keeps a genuinely clean file clean
			// when its wait produces nothing new (a debounce-skipped notify, or a late
			// publication carried in from the previous touch).
			const auxPublishedThisContent = new Set(
				spawned.flatMap((entry) =>
					entry.info.role === "auxiliary" &&
					bindingMatchesTouchContent(
						entry.client.getDiagnosticBinding?.(filePath),
					)
						? [entry.info.id]
						: [],
				),
			);
			const spawnedByServerId = new Map(
				spawned.map((entry) => [entry.info.id, entry]),
			);
			// #1549/#1586: does this auxiliary's publication describe exactly the bytes
			// this touch carries? THE coverage predicate — every door reads it, so a
			// scanner can never be named uncovered while its findings ride along in
			// `.diags`, or the reverse.
			//
			// It UNIONS two content-bound reads rather than replacing one with the other,
			// because they answer different questions:
			//
			//   - `auxPublishedThisContent` was captured BEFORE the notify (#1493), because
			//     a landed write clears the cache and would erase the evidence that the
			//     scanner had already reported on these bytes.
			//   - the read below is LIVE, and it catches the opposite race — #1459's own
			//     documented signature: a write charged as timed out, or one the fan-out
			//     gate deferred behind, that LANDS LATE, after which the scanner publishes
			//     for this touch's content. Judging that auxiliary on the pre-notify
			//     snapshot alone drops its CURRENT findings and names it uncovered — an
			//     underclaim about a scanner that answered.
			//
			// Either match means covered; both are content-bound, so neither can pass off
			// another revision's findings as this touch's answer.
			//
			// WHEN it is asked is part of the rule. The live half moves over the life of
			// a touch, so two doors that ask at two instants can disagree — and the merge
			// ACTS on its answer by dropping findings, which a later answer cannot undo.
			// Every door that shares the merge's consequences therefore reads ONE frozen
			// evaluation (`auxCoveredAtMerge`, below), taken immediately before the merge
			// and never re-asked afterwards. The only callers of this function are that
			// freeze and the two aux wait-outcome producers, whose rows describe their own
			// instant and are reconciled against the freeze before anything is claimed.
			//
			// Everything it cannot speak for fails CLOSED — an id that never reached
			// `spawned` (a breaker-skipped scanner, which never attached) and any
			// primary-role server, whose findings are governed by #570's
			// timeout-preserves-last-known semantics rather than by this exemption.
			const auxCoversThisContent = (serverId: string): boolean => {
				const entry = spawnedByServerId.get(serverId);
				if (entry?.info.role !== "auxiliary") return false;
				return (
					auxPublishedThisContent.has(serverId) ||
					bindingMatchesTouchContent(
						entry.client.getDiagnosticBinding?.(filePath),
					)
				);
			};
			// #743: PER-SERVER notify-write deadlines. Each server's didOpen/didChange
			// write gets its OWN notifyWriteBudgetMs budget rather than one shared
			// deadline over a single Promise.all — otherwise one backpressured server
			// (stalled stdin) times out the write for the ENTIRE file, flipping every
			// co-touched healthy server to inconclusive and zeroing its diagnostics.
			// Bounded so a backpressured write can't hang the caller; on timeout we
			// proceed — the diagnostics wait below is separately bounded and simply
			// returns no fresh diagnostics for the server(s) that stalled.
			//
			// Holds the serverId of every server whose write did NOT land in time.
			// The file-level `notifyWriteTimedOut` (logged below) means "at least one
			// server timed out"; this list carries the per-server detail the
			// demonstratedReady gate reads so a healthy sibling stays eligible.
			const notifyWriteTimedOutServerIds: string[] = [];
			// #1459: auxiliaries whose resync was DEFERRED because the gate already had
			// one outstanding write for that server. They carry no evidence about this
			// content, so they join the coverage gap below.
			const notifyDeferredServerIds: string[] = [];
			if (!notifySkipped) {
				const budget = notifyWriteBudgetMs();
				// #1459: how long a queued auxiliary may wait for its resync slot. Bounded
				// by the write budget and by the effective primary wait floor, minus what
				// which includes the caller's `maxClientWaitMs` and any primary
				// server `clientWaitTimeoutMs` override. The elapsed client wait is
				// subtracted below.
				// A flat write-budget wait would tax a caller that asked for less than one
				// budget in total. Non-positive means "no time left to queue": the server
				// is reported as uncovered immediately.
				//
				// #2239: "what the caller already declared" is `primaryServerWaitFloorMs`,
				// not the raw `options.maxClientWaitMs` — the SAME floor `getClientForFile`
				// races the primary spawn against. A cold primary configured with its own
				// `clientWaitTimeoutMs` (Ruby 30s, and the #2233 Bash/JSON/Vue/Svelte/Prisma
				// overrides) is allowed to run past the caller's flat budget, and did just
				// that by the time this line runs — charging the subtraction against the
				// flat value alone always went negative and clamped to zero. The outer
				// `Math.min(budget, …)` is unchanged, so this raises what "already spent"
				// is measured against without widening the wait beyond one write budget.
				const queueWaitMs =
					options.maxClientWaitMs !== undefined
						? Math.min(
								budget,
								Math.max(
									0,
									primaryServerWaitFloorMs(filePath, options.maxClientWaitMs) -
										(Date.now() - startedAt),
								),
							)
						: budget;
				await Promise.all(
					spawned.map(async (entry) => {
						// #743: this server already has this content from a recent touch
						// that landed. Pushing again would clear its diagnostic cache for
						// nothing — leave its debounce entry (and its original timestamp)
						// alone so the window still expires naturally.
						if (notifySkippedServerIds.has(entry.info.id)) return;
						// Same identity as the broken/demonstratedReady maps.
						const clientKey = await this.demonstratedReadyKeyFor(
							entry.info,
							filePath,
						);
						// #1459: one outstanding resync per auxiliary. Primaries are
						// untouched — they serve one file per touch and are not the fan-out
						// target a `clientScope: "all"` sweep floods.
						const gated =
							entry.info.role === "auxiliary" && clientKey !== undefined;
						let slot: { release: () => void } | undefined;
						if (gated && clientKey) {
							// #1714: before taking the slot, make the server prove it
							// processed the notifies already sent. A sweep is sequential, so
							// the slot gate below is almost always free and cannot see a
							// backlog building. This never refuses the write — a scanner that
							// will not answer is latched past and left to #743's stall
							// machinery, which can demote and respawn it.
							const barrierStartedAt = Date.now();
							await this.paceAuxNotify(
								clientKey,
								entry,
								filePath,
								queueWaitMs,
								{
									source,
									clientScope,
								},
							);
							// The barrier spends from the SAME budget the caller granted, so
							// the slot wait gets only what is left. Otherwise a paced touch
							// could cost two full budgets.
							const slotWaitMs = Math.max(
								0,
								queueWaitMs - (Date.now() - barrierStartedAt),
							);
							const claim = await this.claimAuxNotifySlot(
								clientKey,
								entry,
								filePath,
								slotWaitMs,
							);
							if ("outstandingMs" in claim) {
								// Queued behind a write the scanner has not accepted inside our
								// budget. Pushing anyway is what floods it, so this touch reports
								// the scanner as uncovered instead. The wedge timer armed with the
								// blocking write is what demotes a dead input path.
								notifyDeferredServerIds.push(entry.info.id);
								logLatency({
									type: "phase",
									phase: "lsp_notify_resync_deferred",
									filePath: normalizedPath,
									durationMs: claim.outstandingMs,
									metadata: {
										serverId: entry.info.id,
										source,
										clientScope,
										reason: "outstanding_write",
										outstandingMs: claim.outstandingMs,
										queueWaitMs,
									},
								});
								return;
							}
							slot = claim;
						}
						let wrote: true | undefined;
						let rejected = false;
						try {
							const writeStartedAt = Date.now();
							// Constructed inside the try so a client double without `notify`
							// (or any synchronous throw) still reads as a rejected write rather
							// than rejecting the whole per-file `Promise.all`.
							const writePromise = entry.client.notify
								.open(filePath, content, languageId, undefined, silent)
								.then(() => true as const);
							// #1714: the document is now in this auxiliary's input queue,
							// whether or not the write settles inside our budget. Counted here
							// so the next file sees the real backlog.
							if (gated && clientKey) {
								this.noteAuxNotifyIssued(clientKey, entry.client);
							}
							if (slot && clientKey) {
								const client = entry.client;
								const release = slot.release;
								// Release the slot on the write's OWN settle, whatever the caller
								// below decided to wait for. The handle is identity-checked, so a
								// demotion (which clears the map) or a later claim cannot be
								// released by this one.
								void writePromise.then(() => {
									release();
									// The write landed, just not inside the caller's budget —
									// retract the timeout it was charged for. A write that landed
									// IN budget took the success path below, which clears the
									// streak outright, so only the late case retracts. A landing
									// past the WEDGE window keeps its strike: at that point the
									// stall was long enough that #743's demotion is the honest
									// verdict, not a latency artifact. #2358: the wedge window
									// is the adaptive one the timer itself arms with, so a
									// write a BUSY server would have been left alone for also
									// retracts its strike instead of accruing a ladder charge.
									const outstandingMs = Date.now() - writeStartedAt;
									if (
										outstandingMs > budget &&
										outstandingMs <= this.auxNotifyWedgeBudgetMs(clientKey)
									) {
										this.retractNotifyWriteBackpressure(
											clientKey,
											entry.info.id,
											filePath,
											outstandingMs,
											client,
										);
									}
								}, release);
							}
							wrote = await withDeadline(writePromise, {
								ms: budget,
								onTimeout: "undefined",
								onReject: "propagate",
							});
						} catch {
							// The write itself rejected (not backpressure): the content did
							// not land, so this server is inconclusive for the touch, but a
							// rejection is not a stdin-backpressure signal and must not count
							// toward the backpressure demotion streak.
							rejected = true;
							// A synchronous throw (a client double without `notify`) never
							// reached the settle handlers that release the slot — release it
							// here so one bad client cannot wedge the queue. Idempotent.
							slot?.release();
						}
						if (wrote === true) {
							// A clean write clears any accrued backpressure streak (#743).
							if (clientKey)
								this.notifyWriteBackpressureStreak.delete(clientKey);
							// #1253: record the debounce entry for THIS server only, and only
							// because its own write landed. A server whose write timed out or
							// rejected falls through without an entry, so the next touch
							// re-pushes it instead of laundering the failure into a later
							// touch that looks fully delivered (which the silent-clean gates
							// would then read as a confirmed clean).
							this.markTouched(filePath, content, clientScope, entry.info.id);
						} else {
							notifyWriteTimedOutServerIds.push(entry.info.id);
							if (!rejected) {
								this.recordNotifyWriteBackpressure(clientKey, entry, filePath);
							}
						}
					}),
				);
				// #1783: stamp the disk-drift record only when the touch achieved FULL
				// coverage — every targeted server's write landed AND no other live
				// client holds this document. The debounce entry above is per-server, so
				// stamping a per-FILE record inside that loop claimed a coverage the
				// touch may not have had: a primary-scoped touch leaves an auxiliary's
				// view untouched, and a touch where one server times out leaves that
				// server behind. Either way the sweep would then read "in sync" and stop
				// looking. On a partial touch the PREVIOUS record is deliberately kept:
				// its older `syncedAt` and older fingerprint keep the document eligible,
				// so the next sweep re-pushes it at full scope instead of going blind.
				//
				// BOTH exit lists, not just the timed-out one. The #1459 gate defers an
				// auxiliary whose previous write is still outstanding, and that server
				// leaves the write loop early without ever joining
				// `notifyWriteTimedOutServerIds`. Reading only that list let a deferred
				// scanner's untouched view be stamped as covered — the same laundering
				// through a different door.
				this.recordFullyCoveredSync(
					filePath,
					content,
					spawned,
					notifyWriteTimedOutServerIds.length === 0 &&
						notifyDeferredServerIds.length === 0,
					startedAt,
				);
				if (notifyWriteTimedOutServerIds.length > 0) {
					logLatency({
						type: "phase",
						phase: "lsp_notify_timeout",
						filePath: normalizedPath,
						durationMs: Date.now() - startedAt,
						metadata: {
							source,
							clientScope,
							serverCount: spawned.length,
							timedOutServerIds: notifyWriteTimedOutServerIds,
						},
					});
				}
			}
			// File-level flag: at least one server's write timed out. Kept as the
			// observability summary (`lsp_touch_file.notifyWriteTimedOut`); the
			// `inconclusive` verdict reads the PRIMARY-scoped flag below (#1549).
			const notifyWriteTimedOut = notifyWriteTimedOutServerIds.length > 0;
			// #1549: the honesty verdict is decided from the PRIMARY population only.
			// An auxiliary that missed a deadline is a named coverage gap, never an
			// inconclusive touch — see `resolveTouchVerdict` (diagnostic-binding.ts).
			const primaryEntries = spawned.filter(
				(entry) => entry.info.role !== "auxiliary",
			);
			const primaryServerIds = new Set(primaryEntries.map((e) => e.info.id));
			const primaryNotifyWriteTimedOutServerIds =
				notifyWriteTimedOutServerIds.filter((id) => primaryServerIds.has(id));
			const primaryNotifyWriteTimedOut =
				primaryNotifyWriteTimedOutServerIds.length > 0;
			// #1459: read by the diagnostics wait and the merge below — a deferred
			// server is neither waited on nor read from.
			const deferredResyncServerIds = new Set(notifyDeferredServerIds);

			let diagnosticsTimedOut = false;
			// #1549: every server (any role) that produced no publication evidence when
			// the diagnostics wait lapsed. Read three ways: the primary members decide
			// `diagnosticsTimedOut` and are the `inconclusiveServerIds` attribution, the
			// auxiliary members join the coverage gap, and no member may be marked
			// `demonstratedReady`. Empty when the wait did not lapse.
			let diagnosticsUnansweredServerIds: string[] = [];
			// #1549: the primary subset of the list above, captured when the wait lapsed
			// so the attribution survives the silent-clean/sync gates clearing the flag.
			let diagnosticsUnansweredPrimaryServerIds: string[] = [];
			// #1549: a gate that certifies silence AS the answer (the tsserver sync
			// confirm, either silent-clean gate) retracts the primary attribution with it —
			// those servers answered, in the only way their capabilities allow, so they
			// stay eligible for `demonstratedReady` exactly as before this change.
			// Auxiliary members are left in place: nothing certified them, and they are
			// what the coverage gap reports.
			const retractPrimaryTimeoutAttribution = (): void => {
				diagnosticsUnansweredPrimaryServerIds = [];
				diagnosticsUnansweredServerIds = diagnosticsUnansweredServerIds.filter(
					(id) => !primaryServerIds.has(id),
				);
			};
			// R8 (#714): server ids of aux-role servers whose push wait was cut off by
			// the aux grace window. Undefined when no aux was cut off (primary-only
			// paths never set this). Logged in lsp_touch_file metadata.
			let auxCutOffServerIds: string[] | undefined;
			// #1493: aux-role servers this touch carries NO evidence from — the cut-off
			// set above PLUS the ones that stayed silent through their own budget with
			// no stored publication for this content. This is what narrows the
			// confirmation; `auxCutOffServerIds` stays cut_off-only so the R8 latency
			// field keeps its original meaning.
			let auxUnconfirmedServerIds: string[] | undefined;
			// #707: tsserver sync clean-confirm state. `tsserverSyncEligible` is the
			// full gate (evaluated once, before the wait); `tsserverSyncConfirmed`
			// holds the sync commands' answer when the racing confirm won the wait
			// (undefined = the race didn't produce an answer; the end-of-wait
			// fallback below may still fill it in on a timed-out empty result).
			let tsserverSyncEligible = false;
			let tsserverSyncConfirmed:
				| import("./client.js").LSPDiagnostic[]
				| undefined;
			if (diagnosticsMode !== "none") {
				// Resolution: env wins so users can tune the cap without rebuilding.
				// Otherwise, on the single-server hot path (primary scope), use that
				// server's own strategy budget (wait-policy/strategies.ts) so a fast server
				// (TypeScript ~1s) isn't held to a flat multi-second wait while a slow
				// one (rust-analyzer 3s) gets the time it needs — bounded by any caller
				// ceiling that exists to protect the per-edit pipeline budget (#203).
				// #573: clientScope "all" (lsp_diagnostics, lens_diagnostics_full) now
				// gets the same per-server treatment as "with-auxiliary" — each spawned
				// server (primary + any auxiliaries) is bounded by ITS OWN strategy
				// budget instead of one flat number shared by every server. This was
				// never a deliberate "all means wait for the group ceiling" semantic:
				// #203 introduced perServerTimeout only for the single-server primary
				// path and left "full"/"all" on the pre-existing flat resolution
				// ("full/cascade path unchanged"); #242 later added "with-auxiliary"
				// without revisiting "all". The one property "all" genuinely needs —
				// the touch's overall detection deadline is the SLOWEST spawned
				// server's budget, not the fastest — is unaffected: `timeoutMs` below
				// is always `Math.max(...spawned.map(timeoutFor))` regardless of which
				// timeoutFor is selected, so a slow auxiliary still gets to run to its
				// own budget before the touch is logged as timed out. What changes is
				// only that a fast server's *individual* `waitForDiagnostics` call
				// (further below) now resolves/times out against its own budget
				// instead of blocking to the flat multi-server number.
				const envWait = readEnvDiagnosticsWaitMs();
				const callerCap =
					options.maxDiagnosticsWaitMs ?? options.maxClientWaitMs;
				const modeFloor = diagnosticsMode === "full" ? 3000 : 1200;
				// #645: resolve each spawned server's "is this the first same-sweep
				// touch for it" verdict EXACTLY ONCE up front, before `perServerTimeout`
				// is defined. `SweepIndexGate.consumeFirstTouch` is side-effecting
				// (it marks the server seen), and `perServerTimeout` below is invoked
				// twice per server in this call (once to compute the overall
				// `timeoutMs` deadline, again inside the wait `Promise.all`) — calling
				// the gate directly from inside `perServerTimeout` would consume the
				// "first touch" slot on the first of those two calls and read as
				// already-warm on the second, silently shortchanging the very touch
				// that was supposed to get the full budget.
				const sweepFirstTouch = new Map<string, boolean>();
				if (options.sweepIndexGate) {
					for (const entry of spawned) {
						const strategy = getStrategy(
							entry.client.serverId,
							entry.client.getLaunchVariant?.(),
						);
						if (strategy.workspaceIndexing) {
							sweepFirstTouch.set(
								entry.client.serverId,
								options.sweepIndexGate.consumeFirstTouch(entry.client.serverId),
							);
						}
					}
				}
				// #832: workspace-indexing servers that are classified as silent on
				// clean do not benefit from the generic cold-indexing floor. Their
				// configured strategy already gives the first sweep touch a bounded
				// workspace-index budget (marksman: 1500ms), while the capability
				// classification proves that a clean push has no affirmative signal to
				// wait for. Keep this restricted to the workspace-indexing strategy:
				// TypeScript is also a silent-on-clean push server, but its cold project
				// load still needs the longer 20s floor.
				//
				// Build this from the live spawned client's capabilities rather than
				// server id alone. Missing/throwing capability data fails closed, so a
				// new or ambiguous server keeps the existing generous warm-up budget.
				const silentCleanWarmupServers = new Set<string>();
				if (options.warmupOverride && (options.warmupAttempt ?? 1) <= 1) {
					for (const entry of spawned) {
						const strategy = getStrategy(
							entry.client.serverId,
							entry.client.getLaunchVariant?.(),
						);
						if (strategy.workspaceIndexing !== true) continue;
						try {
							const snapshot: LSPCapabilitySnapshot = {
								serverId: entry.client.serverId,
								root: entry.client.root,
								operationSupport: entry.client.getOperationSupport(),
								workspaceDiagnosticsSupport:
									entry.client.getWorkspaceDiagnosticsSupport(),
								advertisedCommands: entry.client.getAdvertisedCommands(),
								rawCapabilityKeys: entry.client.getRawCapabilityKeys?.() ?? [],
								launchVariant: entry.client.getLaunchVariant?.(),
							};
							if (
								classifyServerWaitTier(entry.client.serverId, snapshot) ===
								"tier3-silent"
							) {
								silentCleanWarmupServers.add(entry.client.serverId);
							}
						} catch {
							// Fail closed: capability uncertainty must retain the cold floor.
						}
					}
				}
				// Each server gets its OWN deadline, bounded by the caller cap as a
				// CEILING (never a floor) — so a clean push-silent primary (typescript
				// ~1s) can't hold the whole touch to a slow auxiliary's budget, and a
				// slow aux (opengrep) can't override the per-edit cap. Resolves as soon
				// as a server publishes; this is just its individual deadline. (#242)
				const perServerTimeout = (serverId: string): number => {
					const launchVariant = spawned
						.find((entry) => entry.client.serverId === serverId)
						?.client.getLaunchVariant?.();
					const strategy = getStrategy(serverId, launchVariant);
					let strategyWait = strategy.aggregateWaitMs;
					// #645: a `workspaceIndexing` server (marksman) only needs the
					// full budget for the FIRST same-sweep touch to it — every
					// subsequent touch in this sweep uses the much shorter warm-wait
					// instead, since the one-time index build only needs to finish
					// once. `sweepFirstTouch` only has entries when a sweep gate was
					// passed in AND the strategy is marked, so a per-edit touch
					// (no gate) or an unmarked server is completely unaffected.
					const isFirstTouch = sweepFirstTouch.get(serverId);
					if (isFirstTouch === false && strategy.workspaceIndexing) {
						strategyWait =
							strategy.workspaceIndexingWarmWaitMs ??
							Math.min(300, strategyWait);
					}
					if (callerCap !== undefined) {
						// #669: `ensureWarmForSweep`'s cold-server warm-up wants its cap
						// to act as a FLOOR (give it at least this much, possibly more
						// if the strategy already wants more) rather than the normal
						// ceiling — see `warmupOverride` doc on `LSPTouchFileOptions`.
						if (options.warmupOverride) {
							// #832: a workspace-indexing server already classified as
							// silent-on-clean uses its strategy's bounded wait on the first
							// attempt; the generic cold floor is for servers whose cold work
							// can eventually produce a push answer (notably TypeScript).
							if (silentCleanWarmupServers.has(serverId)) {
								return Math.min(
									callerCap,
									strategyWait > 0 ? strategyWait : callerCap,
								);
							}
							// #799: only the FIRST warm-up attempt for a cold server gets the
							// floor — see the `warmupAttempt` doc on `LSPTouchFileOptions`.
							if ((options.warmupAttempt ?? 1) > 1) {
								return Math.min(
									callerCap,
									strategyWait > 0 ? strategyWait : callerCap,
								);
							}
							return Math.max(callerCap, strategyWait > 0 ? strategyWait : 0);
						}
						return Math.min(
							callerCap,
							strategyWait > 0 ? strategyWait : callerCap,
						);
					}
					return strategyWait > 0 ? strategyWait : modeFloor;
				};
				let timeoutFor: (serverId: string) => number;
				if (envWait !== undefined) {
					// Env override is a single flat cap so users can tune without rebuilding.
					timeoutFor = () => envWait;
				} else if (
					(!useAllClients && spawned.length === 1) ||
					clientScope === "with-auxiliary" ||
					clientScope === "all"
				) {
					timeoutFor = perServerTimeout;
				} else {
					// Fail-safe for any future clientScope this branch hasn't been
					// taught about yet — keep the old flat resolution rather than
					// silently mis-budgeting an unrecognized scope.
					timeoutFor = () => callerCap ?? modeFloor;
				}
				// Detection deadline = the slowest individual server's budget.
				// #1459: computed over the servers actually WAITED ON. A deferred server
				// contributes no wait, so including its (typically longest) scanner budget
				// here would raise the aggregate threshold above anything that can elapse
				// and mask a real timeout on the servers that did wait.
				const timeoutMs = Math.max(
					0,
					...spawned
						.filter((e) => !deferredResyncServerIds.has(e.info.id))
						.map((e) => timeoutFor(e.client.serverId)),
				);

				// #707: evaluate the tsserver sync clean-confirm gate BEFORE the wait
				// starts. Cheap synchronous gates first (notify succeeded, collecting,
				// primary scope, `serverId === "typescript"` — the sync commands this
				// races are tsserver-specific protocol extensions, not a generic
				// push-only capability, so #799 giving other servers (marksman) the
				// SAME `silentOnClean` marker must not route them into a sync attempt
				// that can never succeed for them), then the live capability-snapshot
				// tier classification (`classifyCascadeWaitTier`, which also excludes
				// native-ts7 via `launchVariant`). Every other server fails this
				// synchronous gate and pays ZERO extra work — not even the snapshot
				// read; a non-typescript `silentOnClean` server instead gets the
				// generic (non-racing) clean-confirm fallback further below.
				if (
					!notifyWriteTimedOut &&
					options.collectDiagnostics === true &&
					clientScope === "primary" &&
					spawned.length === 1 &&
					spawned[0].client.serverId === "typescript" &&
					getStrategy(
						spawned[0].client.serverId,
						spawned[0].client.getLaunchVariant?.(),
					).silentOnClean === true
				) {
					try {
						const snapshots = await this.getCapabilitySnapshots(filePath);
						tsserverSyncEligible =
							classifyCascadeWaitTier(this, filePath, snapshots) ===
							"tier3-silent";
					} catch {
						// Fail-safe: ineligible — today's full wait, no sync attempt.
					}
				}

				const waitStartedAt = Date.now();
				// R8 (#714): on the with-auxiliary path, apply a bounded aux grace so a
				// slow auxiliary no longer holds the push wait to its own deadline.
				// Primary waits resolve on their own per-server budget; once ALL primaries
				// have settled the auxiliaries get at most auxGraceMs before we proceed.
				// Primary-only and "all"/"primary" scopes are completely unaffected —
				// they fall through to the original Promise.all path below.
				//
				// "Primary" here = a server whose LSPServerInfo.role is not "auxiliary".
				// In the with-auxiliary spawn list, `getClientForFile` returns the
				// language-primary entry first and `getAuxiliaryClientsForFile` appends
				// the rest — but we use info.role rather than position so the logic is
				// correct even if ordering shifts in the future.
				//
				// The #707 tsserver sync race operates exclusively on single-server
				// primary-scope touches (guarded by `clientScope === "primary" &&
				// spawned.length === 1`), so there is NO interaction with this path.
				// #1458 S4: also gated on `collectDiagnostics` — a non-collecting
				// with-auxiliary touch has nothing to carry the aux wait's result
				// INTO (its diagnostics are discarded either way), so paying up to
				// `auxCeilingMs` of extra latency for it buys nothing. Both current
				// callers (`getDiagnostics`'s with-auxiliary path and the cascade's
				// collecting touch) already pass `collectDiagnostics: true`, so this
				// is latent-today defense, not a behavior change — but a future
				// non-collecting with-auxiliary caller must not silently inherit the
				// full aux-grace cost for diagnostics it's about to throw away.
				const hasTouchAuxiliaries =
					clientScope === "with-auxiliary" &&
					options.collectDiagnostics === true &&
					spawned.some((e) => e.info.role === "auxiliary");

				// Per-server wait promises (each already bounded by its own
				// perServerTimeout — unchanged from before R8).
				let pressureSnapshots: LSPCapabilitySnapshot[] = [];
				if (shouldPreferPullOnlyDiagnostics()) {
					try {
						pressureSnapshots = await this.getCapabilitySnapshots(filePath);
					} catch {
						// Fail-open: missing capability state keeps today's push fallback.
					}
				}
				const configuredAuxCeilingMs = readEnvAuxGraceMs();
				const perServerDeclaredTimeouts = spawned.map((entry) =>
					timeoutFor(entry.client.serverId),
				);
				const perServerWaitTimeouts = spawned.map((entry, entryIndex) => {
					const declaredServerTimeout = perServerDeclaredTimeouts[entryIndex];
					const observedSpawnMs = getSuccessfulLspSpawnDurationMs(
						entry.client.serverId,
					);
					return hasTouchAuxiliaries &&
						entry.info.role === "auxiliary" &&
						coldAuxiliaryServerIds.has(entry.client.serverId) &&
						(configuredAuxCeilingMs !== undefined ||
							(observedSpawnMs !== undefined && observedSpawnMs > 0))
						? auxWaitBudgetMs(
								entry.client.serverId,
								true,
								configuredAuxCeilingMs,
								declaredServerTimeout,
							)
						: perServerDeclaredTimeouts[entryIndex];
				});
				const perServerRaceBudgets = spawned.map((entry, entryIndex) => {
					return hasTouchAuxiliaries && entry.info.role === "auxiliary"
						? auxWaitBudgetMs(
								entry.client.serverId,
								coldAuxiliaryServerIds.has(entry.client.serverId),
								configuredAuxCeilingMs,
								perServerDeclaredTimeouts[entryIndex],
							)
						: perServerDeclaredTimeouts[entryIndex];
				});
				const perServerWaits = spawned.map((entry, entryIndex) => {
					// #1459: a DEFERRED server never received this content, so its version
					// can never advance past the baseline — waiting on it burns its whole
					// budget and would flip the touch to `inconclusive`, discarding a
					// primary answer that IS trustworthy. It contributes no wait; the
					// coverage gap below is what reports its absence.
					if (deferredResyncServerIds.has(entry.info.id)) {
						return Promise.resolve(undefined);
					}
					const serverTimeout = perServerWaitTimeouts[entryIndex];
					// #1531: a per-path baseline. `clientWaitForDiagnostics` compares it
					// against this path's own publication stamp, so a sibling file's
					// publication on a shared client can no longer end this wait before the
					// server's own budget lapses — which is what kept the outcome labels
					// honest (`cut_off` means our grace won, `silent` means the server's own
					// budget lapsed with nothing published).
					const baseline = diagnosticBaselines.get(entry.client);
					const pullOnly =
						classifyServerWaitTier(
							entry.client.serverId,
							pressureSnapshots.find(
								(snapshot) => snapshot.serverId === entry.client.serverId,
							),
						) === "pull-capable";
					// #1639: `ensureWarmForSweep`'s readiness probe (`source:
					// "lsp_sweep_warmup"`, `collectDiagnostics: false`) runs a real pull
					// round trip on this same file, then the sweep's real touch follows
					// immediately after — two legitimate settle observations for one
					// file, not a duplicate. Tag the warm-up one distinctly so a
					// consumer can tell them apart instead of double-counting. Omitted
					// (rather than passed as "pull") on the common path — the client
					// already defaults to "pull", and existing tests assert the exact
					// argument list `waitForDiagnostics` is called with.
					const isWarmupTouch = source === "lsp_sweep_warmup";
					// #743: per-server — a server we DID push to still gets the
					// version-baseline wait even when a sibling was debounced away.
					const wait =
						!notifySkippedServerIds.has(entry.info.id) &&
						Number.isFinite(baseline)
							? entry.client.waitForDiagnostics(filePath, serverTimeout, {
									minVersion: baseline,
									...(pullOnly && { pullOnly: true }),
									...(isWarmupTouch && { pullSettleSource: "pull-warmup" }),
								})
							: pullOnly
								? entry.client.waitForDiagnostics(filePath, serverTimeout, {
										pullOnly: true,
										...(isWarmupTouch && { pullSettleSource: "pull-warmup" }),
									})
								: isWarmupTouch
									? entry.client.waitForDiagnostics(filePath, serverTimeout, {
											pullSettleSource: "pull-warmup",
										})
									: entry.client.waitForDiagnostics(filePath, serverTimeout);
					return wait.catch(() => undefined);
				});

				// The push wait — same per-server budget composition as before #707;
				// only the awaiting changed (assigned so it can be raced below).
				let pushWaitSettled = false;
				const pushWait: Promise<void> = hasTouchAuxiliaries
					? (() => {
							// Primary waits: all non-auxiliary servers.
							const primaryWaits = perServerWaits.filter(
								(_, i) => spawned[i].info.role !== "auxiliary",
							);
							// Aux waits: auxiliary servers (advisory). `client` and the
							// pre-notify `diagnosticsVersion` baseline travel alongside the
							// promise so the outcome can be decided from EVIDENCE after the
							// race, not from how the raced promise settled (#1458 S1 — see
							// below).
							const auxWaits = perServerWaits
								.map((p, i) =>
									spawned[i].info.role === "auxiliary"
										? {
												promise: p,
												serverId: spawned[i].info.id,
												client: spawned[i].client,
												baseline: diagnosticBaselines.get(spawned[i].client),
												budgetMs: perServerRaceBudgets[i],
											}
										: null,
								)
								.filter(
									(
										x,
									): x is {
										promise: Promise<void | undefined>;
										serverId: string;
										client: (typeof spawned)[number]["client"];
										baseline: number | undefined;
										budgetMs: number;
									} => x !== null,
								);
							// After all primaries settle, use the same per-auxiliary budget
							// that bounded its own diagnostic wait. Warm acquisitions retain
							// the 2000ms ceiling; cold acquisitions include observed startup.
							// Late aux results are dropped from this wait. A later unchanged-
							// content read may carry a SHA-256-bound cache publication before its
							// resync clears the cache; changed or unknown content never replays.
							// Aux servers that answer within the grace are included automatically since
							// their waitForDiagnostics already resolved. The cut-off server ids
							// are logged in the latency metadata (lsp_touch_file phase, field
							// `auxCutOffServerIds`).
							return Promise.all(primaryWaits).then(async () => {
								if (auxWaits.length === 0) return;
								const auxWaitStartedAt = Date.now();
								const outcomes = await Promise.all(
									auxWaits.map(async (aux) => {
										const { budgetMs } = aux;
										let timer: ReturnType<typeof setTimeout> | undefined;
										const timeout = new Promise<false>((resolve) => {
											timer = setTimeout(() => resolve(false), budgetMs);
											if (typeof timer === "object" && "unref" in timer) {
												timer.unref?.();
											}
										});
										const raced = await Promise.race([
											aux.promise.then(() => true as const),
											timeout,
										]);
										if (timer) clearTimeout(timer);
										// #1458 S1: `waitForDiagnostics` RESOLVES on its own timeout
										// (client.ts) — it never rejects, and a silent scanner that
										// published nothing looks identical, promise-wise, to one
										// that answered. `raced === true` only means "the promise
										// settled before our timer fired"; it is not proof anything
										// was published. Decide the outcome from evidence instead:
										// did this aux's `diagnosticsVersion` advance past the
										// pre-notify baseline captured before the wait started?
										//   - raced === false            → "cut_off" (our timer won;
										//     the aux's own wait never got to answer for itself).
										//   - raced === true, no evidence → "silent" (the aux's own
										//     wait gave up within its budget with nothing to report —
										//     NOT the same as having answered).
										//   - raced === true, evidence   → "answered" (a fresh
										//     publication actually landed for this touch).
										//
										// #1531: the evidence is read PER PATH. The global
										// `diagnosticsVersion` advances for every file this client
										// publishes, so a concurrent touch of an unrelated file used to
										// hand this one an unearned "answered" row. The per-path stamp
										// carries the global counter's value at store time, so the
										// comparison stays monotonic across cache evictions while
										// ignoring sibling paths — and it is the SAME axis `baseline`
										// was captured on above.
										const currentPathVersion = readPathVersion(aux.client);
										const publishedEvidence =
											raced &&
											Number.isFinite(aux.baseline) &&
											currentPathVersion !== undefined &&
											currentPathVersion > (aux.baseline as number);
										// #1459: a DEFERRED aux was never sent this content and is not
										// waited on at all, so its instantly-resolved placeholder
										// promise must not read as "silent". "Silent" is the reserved
										// signal for a scanner that HAD the content, finished inside
										// its own budget, and published nothing (#1493) — recording a
										// deferral there would corrupt the one row that tracks it.
										const outcome = deferredResyncServerIds.has(aux.serverId)
											? ("deferred" as const)
											: !raced
												? ("cut_off" as const)
												: publishedEvidence
													? ("answered" as const)
													: ("silent" as const);
										return {
											serverId: aux.serverId,
											outcome,
											// #1493: carried into the coverage-gap policy so a silent
											// auxiliary that already published for these exact bytes is
											// not demoted. Logged too — it is the reason a `silent` row
											// did not narrow the touch.
											// #1586: through the one predicate, so this row and the merge
											// below cannot disagree about the same scanner.
											publishedThisContent: auxCoversThisContent(aux.serverId),
											budgetMs,
											elapsedMs: Date.now() - auxWaitStartedAt,
											// #1458 S3: elapsed measured from BEFORE the primary wait
											// (waitStartedAt), not just from auxWaitStartedAt — this is
											// what lets a latency row validate the ~1.3s warm-scanner
											// figure the 2000ms ceiling was set from; `elapsedMs` alone
											// only covers the POST-primary aux phase.
											elapsedSinceNotifyMs: Date.now() - waitStartedAt,
										};
									}),
								);
								const unfinished = outcomes
									.filter((outcome) => outcome.outcome === "cut_off")
									.map((outcome) => outcome.serverId);
								if (unfinished.length > 0) auxCutOffServerIds = unfinished;
								// #1493: one policy over both no-answer shapes. Lives in
								// diagnostic-binding.ts so no consumer re-derives the rule from
								// an outcome string.
								const uncovered = auxiliaryCoverageGap(outcomes);
								if (uncovered.length > 0) auxUnconfirmedServerIds = uncovered;
								// #2001/#2002 collect-later: an auxiliary with NO publication
								// evidence for this content (`cut_off` — our grace timer won; or
								// `silent` — its own budget lapsed with nothing published) may still
								// publish into its client cache seconds later. Mark the pair so the
								// NEXT turn_end can probe the cache and deliver the late findings
								// instead of dropping them on the floor. Exclusions mirror the
								// coverage-gap policy: `answered` already rode along, a #1493-exempt
								// scanner's stored findings are bound to exactly these bytes (its
								// answer is already carried), and DEFERRED servers never received
								// this content at all (#1459) — their cache describes the PREVIOUS
								// revision and probing it would replay stale findings.
								const collectLaterServerIds = outcomes
									.filter(
										(o) =>
											!o.publishedThisContent &&
											(o.outcome === "cut_off" || o.outcome === "silent") &&
											// #2324 R2-A/R3-A: ast-grep's napi fallback is a
											// SECOND producer of coverage for this exact pair,
											// dispatched CONCURRENTLY with this whole touch
											// (dispatcher.ts's Promise.all groups) — not just
											// concurrently with this wait. On a COLD touch,
											// getClientsForFile's spawn+handshake (above, before
											// waitStartedAt is ever captured) can itself take
											// long enough that napi's near-instant Gate-B check
											// records coverage BEFORE waitStartedAt — the
											// issue's own 68ms race shape. Baseline on startedAt
											// instead: stamped at touchFile's own entry, before
											// ANY spawn work, so it is the earliest instant this
											// touch's own napi run could possibly predate. Still
											// excludes a stale record from an EARLIER touch,
											// which is all the staleness guard needs.
											!(
												o.serverId === "ast-grep" &&
												napiFallbackCoveredSince(filePath, startedAt)
											),
									)
									.map((o) => o.serverId);
								if (collectLaterServerIds.length > 0) {
									markPendingAuxiliaryCoverage(filePath, collectLaterServerIds);
								}
								logLatency({
									type: "phase",
									phase: "lsp_aux_wait_outcome",
									filePath: normalizedPath,
									durationMs: Date.now() - auxWaitStartedAt,
									// #1533: `waitShape` names the producer, because the aggregate
									// path emits the same row with the same outcome vocabulary
									// minus `cut_off`. A field query that sees only `silent` rows
									// must be able to tell "our ceiling was in play" from "the
									// auxiliary's own full budget lapsed".
									metadata: { clientScope, waitShape: "aux_grace", outcomes },
								});
							});
						})()
					: Promise.all(perServerWaits).then(() => {});
				pushWait.then(() => {
					pushWaitSettled = true;
				});

				if (tsserverSyncEligible) {
					// #707 racing variant: rather than burning the full push-wait budget
					// on a silent-on-clean server (which by definition never answers on a
					// clean file), race the push wait against a grace-delayed sync
					// confirm. The grace (default 300ms, PI_LENS_TSSERVER_SYNC_GRACE_MS)
					// gives a genuinely dirty file's push a head start: if diagnostics
					// arrive before the grace elapses, the sync request never goes out —
					// zero new latency or requests on the push-answers path.
					//
					// Race semantics:
					//   - sync answers first → that's the confirmed result (clean OR
					//     dirty — the sync commands return the file's real syntactic +
					//     semantic state, so a dirty-file win is still correct and its
					//     findings are surfaced, never discarded).
					//   - push settles first → push wins; a still-in-flight sync outcome
					//     is discarded (the racer checks `pushWaitSettled` after the
					//     call returns and drops its own result).
					//   - sync unavailable/fails → the racer parks on a never-resolving
					//     promise so the race is decided by the push wait's own budget,
					//     exactly today's behavior (the end-of-wait fallback below still
					//     gets its shot on a timed-out empty result).
					// The racer never rejects (every failure path is caught), so the
					// losing promise can never surface as an unhandled rejection.
					const graceMs = readTsserverSyncGraceMs();
					const primaryClient = spawned[0].client;
					// Resolves with the sync commands' diagnostics when the confirm
					// succeeds; parks on a never-resolving promise on EVERY other path
					// (push already answered, sync unavailable/failed, push won while
					// in flight) so the race is then decided by the push wait's own
					// budget — exactly today's behavior.
					const syncRacer = (async (): Promise<
						import("./client.js").LSPDiagnostic[]
					> => {
						await new Promise<void>((resolve) => {
							const timer = setTimeout(resolve, graceMs);
							timer.unref?.();
						});
						// Push already answered (settled, or published diagnostics that
						// its wait is about to settle on) — nothing to confirm, no sync
						// request goes out.
						const publishedAt = primaryClient
							.getAllDiagnostics?.()
							.get(normalizedPath)?.ts;
						if (
							pushWaitSettled ||
							(publishedAt !== undefined && publishedAt > markedAtMs)
						) {
							return new Promise<never>(() => {});
						}
						try {
							const result = await attemptTsserverSyncDiagnostics(
								filePath,
								this,
							);
							if (result === undefined || pushWaitSettled) {
								// Sync unavailable/failed, or push won while the sync call
								// was in flight — drop the sync outcome and let the push
								// wait decide the race.
								return new Promise<never>(() => {});
							}
							return result;
						} catch {
							return new Promise<never>(() => {});
						}
					})();
					const raceOutcome = await Promise.race([
						pushWait.then((): undefined => undefined),
						syncRacer,
					]);
					if (raceOutcome !== undefined) {
						tsserverSyncConfirmed = raceOutcome;
					}
				} else {
					await pushWait;
				}
				const waitedMs = Date.now() - waitStartedAt;
				// #1533: the same auxiliary coverage evidence for a collecting touch that
				// did NOT enter the aux-grace wait — in practice `clientScope: "all"`, the
				// batch/directory scan surface. Auxiliaries ARE spawned on that scope
				// (`getClientsForFile` returns every matching server, #573) and each one is
				// waited on inside `Promise.all(perServerWaits)` on its own per-server
				// budget, but `hasTouchAuxiliaries` is `with-auxiliary`-only, so no evidence
				// was ever derived and a silent scanner aggregated as an unqualified
				// `"confirmed"` — the #1493 false clean surviving on a different scope.
				//
				// NO SECOND WAIT. Every aux promise here has already settled (the
				// `Promise.all` above awaited it), so this reads post-wait state only. That
				// is deliberate: #1459's resync gate exists to ABSORB the aux fan-out of an
				// "all"-scope sweep into deferrals, and entering a per-neighbour aux grace
				// here would pay back the latency that gate just recovered. The evidence is
				// free; only the verdict changes.
				//
				// WHICH verdicts change, stated without overreach. Where the auxiliary's
				// budget is the MAX over waited servers (`perServerTimeout` is
				// `min(callerCap, strategyWait)` per server, `timeoutMs` is the max across
				// them), a silent auxiliary already tripped `diagnosticsTimedOut` and the
				// touch was already `inconclusive` — which is decided BEFORE the coverage
				// gap, so those results are unchanged. That covers opengrep on every current
				// per-edit path, whose 3500 exceeds either cap. But a FASTER auxiliary beside
				// a slower primary (typos 1500 or ast-grep 1800 next to rust-analyzer 3000
				// under a 2000 cap) settles inside `timeoutMs`, so nothing timed out and this
				// block genuinely narrows a result that used to read `confirmed`. That is the
				// fix working: the scanner said nothing about these bytes. It is fail-safe —
				// the primary's findings still ride along and only the coverage claim is
				// withdrawn — and the cost is a skipped cache seed for that file. Both cases
				// are pinned in `tests/clients/lsp/service-aux-grace.test.ts`.
				//
				// `cut_off` cannot arise on this path — there is no grace timer to end a
				// wait early — so the shapes are `answered` / `silent` / `deferred`, decided
				// by exactly the rules the grace path uses (#1458 S1: a settled promise is
				// not proof of a publication; only a `diagnosticsVersion` advance past the
				// pre-notify baseline is). `waitShape` distinguishes the two producers in
				// field data, since a `silent` row here means the auxiliary's own full
				// per-server budget lapsed rather than our ceiling cutting it short.
				//
				// A server the caller EXCLUDED (`WORKSPACE_SWEEP_EXCLUDED_SERVER_IDS`, #584)
				// never reaches `spawned`, so it cannot be reported here — an excluded-by-
				// design scanner is a routing decision, not a coverage gap, exactly as
				// `brokenSkippedAuxiliaryServerIds` already treats it.
				//
				// Written as `!hasTouchAuxiliaries` rather than `clientScope === "all"` so a
				// future scope that spawns auxiliaries without entering the grace wait fails
				// closed here by default instead of needing to be remembered. The #707
				// tsserver sync race can reach here with `pushWait` still pending, but it is
				// gated on `clientScope === "primary" && spawned.length === 1`, which spawns
				// no auxiliaries at all — so the per-role filter below is empty and no
				// evidence is read before its wait ends.
				//
				// `elapsedMs` and `elapsedSinceNotifyMs` are equal by construction here:
				// there is no separate post-primary aux phase to measure, so both describe
				// the one aggregate wait. Both fields are kept so a query can read either
				// producer's rows without special-casing the schema.
				//
				// The evidence is read PER PATH, through the same `readPathVersion` accessor
				// the grace path uses (#1531, landed on master while this was in review).
				// This is NOT interchangeable with `client.diagnosticsVersion`: that global
				// counter also advances for files this touch never mentions, so two
				// CONCURRENT touches sharing one auxiliary client cross-satisfy — a
				// publication for a.ts hands b.ts an unearned `answered`. That matters
				// especially here, because the highest-frequency `"all"` caller (the cascade
				// neighbour fan-out in `clients/dispatch/integration.ts`) is a
				// `Promise.allSettled` and its touches are always concurrent. Reading the
				// per-path stamp keeps this comparison on the SAME axis `baseline` was
				// captured on, and `undefined` from a double that predates the accessor fails
				// CLOSED rather than silently reverting to the global counter.
				if (!hasTouchAuxiliaries && options.collectDiagnostics === true) {
					const auxEntries = spawned.filter(
						(entry) => entry.info.role === "auxiliary",
					);
					if (auxEntries.length > 0) {
						const outcomes = auxEntries.map((entry) => {
							const baseline = diagnosticBaselines.get(entry.client);
							const currentPathVersion = readPathVersion(entry.client);
							const publishedEvidence =
								Number.isFinite(baseline) &&
								currentPathVersion !== undefined &&
								currentPathVersion > (baseline as number);
							return {
								serverId: entry.info.id,
								outcome: deferredResyncServerIds.has(entry.info.id)
									? ("deferred" as const)
									: publishedEvidence
										? ("answered" as const)
										: ("silent" as const),
								publishedThisContent: auxCoversThisContent(entry.info.id),
								budgetMs: timeoutFor(entry.client.serverId),
								elapsedMs: waitedMs,
								elapsedSinceNotifyMs: waitedMs,
							};
						});
						const uncovered = auxiliaryCoverageGap(outcomes);
						if (uncovered.length > 0) auxUnconfirmedServerIds = uncovered;
						logLatency({
							type: "phase",
							phase: "lsp_aux_wait_outcome",
							filePath: normalizedPath,
							durationMs: waitedMs,
							metadata: { clientScope, waitShape: "aggregate", outcomes },
						});
					}
				}
				if (tsserverSyncConfirmed !== undefined) {
					// #707: the racing sync confirm won — a definitive answer well under
					// the push-wait budget. Not a timeout, not inconclusive.
					logLatency({
						type: "phase",
						phase: "lsp_tsserver_sync_confirm",
						filePath: normalizedPath,
						durationMs: waitedMs,
						metadata: {
							source,
							serverId: spawned[0]?.client.serverId,
							clientScope,
							diagnosticsMode,
							mode: "race",
							confirmedDiagnosticCount: tsserverSyncConfirmed.length,
							budgetMs: timeoutMs,
							savedVsBudgetMs: Math.max(0, timeoutMs - waitedMs),
						},
					});
				} else if (waitedMs + 20 >= timeoutMs) {
					// Within ~20 ms of the configured budget we treat it as a timeout;
					// the LSP didn't beat the cap. Diagnostics that arrive late still
					// land in the client's cache and surface on the next edit.
					//
					// #1549: WHOSE budget lapsed decides the verdict. `timeoutMs` is the MAX
					// over the servers waited on, so a slow auxiliary (opengrep declares
					// 3500ms) sets the aggregate deadline for the whole touch — and a
					// touch-wide `diagnosticsTimedOut = true` then discarded a primary answer
					// that landed in 100ms. Attribute the lapse per server instead: the
					// touch is inconclusive only when a PRIMARY produced no evidence; an
					// auxiliary that produced none becomes a named coverage gap below.
					//
					// Evidence, not promise settlement (#1458 S1): `waitForDiagnostics`
					// resolves on its own timeout, so a settled wait proves nothing. The
					// per-path publication stamp advancing past this touch's pre-notify
					// baseline (#1531) is the primary signal; a present per-file cache entry
					// is the second, because the notify this touch just sent cleared that
					// entry (`clearDiagnosticsForPath`), so a present one can only be a fresh
					// answer — the same signal #814's aggregate gate already trusts.
					//
					// Every unknown fails CLOSED: a client that exposes neither accessor
					// reads as unanswered, which for a primary is exactly the pre-#1549
					// verdict. This block can therefore only ever NARROW an inconclusive
					// touch, never create one.
					const answeredForThisTouch = (
						entry: (typeof spawned)[number],
					): boolean => {
						const baseline = diagnosticBaselines.get(entry.client);
						const currentPathVersion = readPathVersion(entry.client);
						if (
							Number.isFinite(baseline) &&
							currentPathVersion !== undefined &&
							currentPathVersion > (baseline as number)
						) {
							return true;
						}
						try {
							return (
								entry.client.getAllDiagnostics?.().has(normalizedPath) === true
							);
						} catch {
							// Fail closed: an unreadable cache is not evidence of an answer.
							return false;
						}
					};
					// A deferred server was never sent this content and is not waited on, so
					// it cannot have "timed out" — it is already reported as a coverage gap.
					const waited = spawned.filter(
						(entry) => !deferredResyncServerIds.has(entry.info.id),
					);
					const unanswered = waited.filter(
						(entry) => !answeredForThisTouch(entry),
					);
					diagnosticsUnansweredServerIds = unanswered.map((e) => e.info.id);
					diagnosticsUnansweredPrimaryServerIds = unanswered
						.filter((entry) => entry.info.role !== "auxiliary")
						.map((e) => e.info.id);
					// Fail-safe: a touch with no waited-on primary has no primary answer to
					// preserve, so it keeps the pre-#1549 touch-wide verdict rather than
					// absolving itself on an auxiliary's evidence.
					const hasWaitedPrimary = waited.some(
						(entry) => entry.info.role !== "auxiliary",
					);
					diagnosticsTimedOut =
						!hasWaitedPrimary ||
						diagnosticsUnansweredPrimaryServerIds.length > 0;
					for (const entry of unanswered) {
						incrementDegradationCount({
							kind: "lsp-diagnostics-timeout",
							// `info.id` is the authoritative server identity carried by
							// every spawned entry. The client test doubles (and some
							// lightweight clients) need not expose a serverId property;
							// ledger recording must never abort the touch or alter #570's
							// timeout-preserves-last-known-diagnostics semantics.
							subject: entry.info.id,
							reason: "diagnostics wait timed out",
						});
					}
					logLatency({
						type: "phase",
						phase: "lsp_diagnostics_timeout",
						filePath: normalizedPath,
						durationMs: waitedMs,
						metadata: {
							source,
							// #1444: WHICH server(s) burned the budget — without this the
							// ~221/day timeout rows can't be attributed to a server at all.
							// `info.id` (not `client.serverId`) for the same reason the
							// degradation ledger above uses it: test doubles and lightweight
							// clients need not expose `serverId`.
							serverIds: spawned.map((e) => e.info.id),
							clientScope,
							diagnosticsMode,
							timeoutMs,
							// #1549: which of those servers actually produced no evidence, and
							// whether the lapse is attributable to a primary (the touch is
							// inconclusive) or only to auxiliaries (a named coverage gap, with
							// the primary's findings intact). Without these two fields a
							// forensic sweep cannot tell the two apart at all.
							unansweredServerIds: diagnosticsUnansweredServerIds,
							attributedToPrimary: diagnosticsTimedOut,
						},
					});
				}

				// #814: capability-aware AGGREGATE wait — generalize #799's
				// single-server (`clientScope === "primary" && spawned.length === 1`)
				// silent-clean confirm to multi-server `clientScope: "all"` touches
				// (`lens_diagnostics` mode=full per-file sweep, `lsp_diagnostics`
				// `serverScope: "all"`). #799's gate never fires here (it's scoped to
				// the primary hot path), so a scope-"all" touch where every OTHER
				// spawned server already answered but one push-only `silentOnClean`
				// server (marksman on a clean markdown file) never publishes still
				// reported the WHOLE touch `inconclusive`/`diagnosticsTimedOut` even
				// though the "silence" is exactly what that server's own known
				// clean-behavior predicts — not an unresolved question.
				//
				// A spawned server counts as "still outstanding" when nothing landed
				// in its per-file diagnostics cache for THIS touch — `getAllDiagnostics`
				// is keyed by file and `clearDiagnosticsForPath` (`client.ts`) deletes
				// that file's entry as part of the didOpen/didChange this touch just
				// sent, so a present entry can only be a FRESH answer (found or a real
				// confirmed-empty push/pull), never a stale one bleeding through from
				// an earlier touch. This is the same "did anything publish for this
				// file since we asked" signal `cascade-tier.ts`'s Tier-3 reconcile
				// already trusts (#240 doctrine) — reused here, not reinvented.
				//
				// The touch stays inconclusive unless EVERY still-outstanding server
				// is classified `tier3-silent` (push-only + `silentOnClean`, the same
				// `classifyServerWaitTier` rule the single-server gate below and the
				// cascade lane use) — one ordinary push-only straggler (still
				// genuinely analyzing) or a pull-capable server that never answered
				// keeps the touch cautious, matching #799's "err toward caution"
				// posture for partial timeouts. `!notifyWriteTimedOut` (touch-wide)
				// plus the per-server re-check below are the same "the notify write
				// must have actually landed" conservatism #799 established — a
				// server's silence is only evidence of "clean" when we know it saw
				// the new content.
				//
				// #1549: both the gate and its "still outstanding" set are PRIMARY-scoped.
				// An auxiliary is never asked to prove itself tier3-silent here, because an
				// auxiliary that never reported is already named as a coverage gap — and
				// requiring it to was the second half of the touch-wide conflation: a clean
				// markdown file whose marksman silence IS the answer stayed inconclusive
				// purely because an opengrep scan beside it had not finished. The auxiliary's
				// absence still costs the touch its full confirmation (`partial`); what it no
				// longer does is erase the primary's answer.
				if (
					diagnosticsTimedOut &&
					!primaryNotifyWriteTimedOut &&
					clientScope === "all"
				) {
					try {
						const outstanding = primaryEntries.filter(
							(entry) =>
								!notifyWriteTimedOutServerIds.includes(entry.info.id) &&
								!entry.client.getAllDiagnostics().has(normalizedPath),
						);
						if (outstanding.length > 0) {
							const snapshots = await this.getCapabilitySnapshots(filePath);
							const allSilent = outstanding.every(
								(entry) =>
									classifyServerWaitTier(
										entry.client.serverId,
										snapshots.find((s) => s.serverId === entry.client.serverId),
									) === "tier3-silent",
							);
							if (allSilent) {
								// #1277: the static tier3-silent classification alone can't
								// tell a genuinely clean server from one that accepted the
								// notify write and then wedged — both look identical to
								// `classifyServerWaitTier`, which only reads the capability
								// snapshot, never the server's actual current responsiveness.
								// Require every still-outstanding server to answer a cheap
								// bounded round-trip before trusting the silence as clean;
								// any server that doesn't respond in time keeps the touch
								// inconclusive rather than confirming a possibly-dead server
								// clean.
								const liveness = await Promise.all(
									outstanding.map((entry) =>
										(
											entry.client.pingLiveness?.() ?? Promise.resolve(true)
										).catch(() => false),
									),
								);
								if (liveness.every(Boolean)) {
									diagnosticsTimedOut = false;
									retractPrimaryTimeoutAttribution(); // #1549
									logLatency({
										type: "phase",
										phase: "lsp_silent_clean_confirm",
										filePath: normalizedPath,
										durationMs: Date.now() - startedAt,
										metadata: {
											source,
											clientScope,
											diagnosticsMode,
											aggregate: true,
											serverIds: outstanding.map(
												(entry) => entry.client.serverId,
											),
										},
									});
								}
							}
						}
					} catch {
						// Fail-safe: leave `diagnosticsTimedOut` as-is — today's
						// inconclusive behavior, exactly like the single-server gate.
					}
				}
			}

			// #1586: THE coverage evaluation, taken ONCE, here — the last statement before
			// the merge, with no `await` between it and the drop it authorizes. Everything
			// that shares the merge's consequences reads this frozen set and never asks
			// the live predicate again.
			//
			// The review round on this change proved why the freeze has to be the unit.
			// `touchFile` awaits after the merge — `brokenSkippedAuxiliaryServerIds` on
			// every collecting touch, the tsserver sync and liveness gates on theirs — and
			// a publication landing in that window flips the live predicate. Re-asking it
			// when the coverage gap was named then un-named a scanner whose findings the
			// merge had ALREADY dropped: `.diags` missing the scanner's answer while the
			// touch claimed `confirmed`, which unblocks the `lastKnownDiagnostics` prime
			// and the `demonstratedReady` mark that `coverageGap` exists to hold shut.
			// That is #1459's blackout reading as scanned-clean — the overclaim direction,
			// and the worse one. A drop is an action; a later answer cannot undo it, so
			// the naming must be settled from the same instant that authorized it.
			const auxCoveredAtMerge = new Set(
				spawned
					.filter((entry) => auxCoversThisContent(entry.info.id))
					.map((entry) => entry.info.id),
			);
			// Which DEFERRED auxiliaries this touch genuinely carries no evidence from.
			// The deferral itself only proves the gate did not send these bytes on THIS
			// touch; whether the scanner has reported on them is a content-hash question.
			const uncoveredDeferredServerIds = notifyDeferredServerIds.filter(
				(serverId) => !auxCoveredAtMerge.has(serverId),
			);
			// An AUXILIARY whose notify write never landed still holds the previous
			// content's findings — nothing cleared its cache — and before this change that
			// touch was blanket `inconclusive`, so no consumer read the merged array. Now
			// the primary's answer flows, which means the auxiliary's stale findings would
			// flow with it and be reported (with the previous revision's line numbers) as
			// this touch's answer. Drop them; the write failure is reported as a coverage
			// gap instead.
			// Auxiliaries only. A PRIMARY keeps #570's deliberate
			// timeout-preserves-last-known-diagnostics semantics, and its write failure
			// makes the touch inconclusive anyway, so no consumer reads the array as
			// current.
			const staleWriteAuxiliaryServerIds = spawned
				.filter(
					(entry) =>
						entry.info.role === "auxiliary" &&
						notifyWriteTimedOutServerIds.includes(entry.info.id) &&
						!auxCoveredAtMerge.has(entry.info.id),
				)
				.map((entry) => entry.info.id);
			// #1586: every contribution this merge withholds, in one set. The merged
			// BINDING reads it too (#1459's door, which filtered the raw deferral set and
			// so excluded the fingerprint of a deferred-but-covered scanner whose findings
			// the merge had just kept) — a dropped contributor must lose its findings and
			// its binding together, or the merged `boundToCurrentDisk` describes bytes the
			// result no longer contains.
			const droppedAuxiliaryServerIds = new Set([
				...uncoveredDeferredServerIds,
				...staleWriteAuxiliaryServerIds,
			]);
			// #707: when the racing sync confirm won the wait, its answer IS the
			// collected result — the file's real syntactic + semantic state straight
			// from tsserver (clean = [], dirty = real findings that a silentOnClean
			// server had computed but never published). Otherwise merge the push
			// diagnostics from the client cache as always.
			let collected = options.collectDiagnostics
				? tsserverSyncConfirmed !== undefined
					? mergeLspDiagnostics(tsserverSyncConfirmed)
					: mergeLspDiagnostics([
							// #1459: a DEFERRED server's cache still holds the PREVIOUS
							// content's findings — the resync that would have cleared it never
							// ran. Merging them would report another revision's findings (and
							// its line numbers) as this touch's answer, the one hazard the
							// gate itself creates. Drop them; the gap is reported instead.
							// #1586: unless the scanner has since published for exactly these
							// bytes — `droppedAuxiliaryServerIds` is the one frozen answer the
							// coverage naming and the merged binding read too.
							...spawned.flatMap((entry) =>
								droppedAuxiliaryServerIds.has(entry.info.id)
									? []
									: entry.client.getDiagnostics(filePath),
							),
							...carriedAuxiliary.flatMap((entry) => entry.diags),
						])
				: undefined;
			// #1095 (P3-b): whether `collected` came from a tsserver sync confirm
			// (`tsserverSyncRequest`) rather than the publish cache. A sync-confirmed
			// result is authoritative for the CURRENT buffer but is NOT tied to the
			// publish-path content binding (`diagnosticBindings`, set on publish), so
			// composing that binding here could let a STALE publish fingerprint demote a
			// genuinely-fresh sync answer to `false`. The end-of-wait fallback below can
			// also set this. When true, the binding is surfaced as "unknown" (honest,
			// non-demoting) rather than the stale publish binding.
			let syncConfirmed = tsserverSyncConfirmed !== undefined;

			// #707 end-of-wait fallback: when the racing confirm did NOT decide the
			// wait (sync unavailable/failed mid-race, or push resolved as a bare
			// timeout) and the wait timed out with an empty result on an eligible
			// touch, give the sync clean-confirm one last shot before reporting
			// inconclusive. `tsserverSyncEligible` already encodes every gate (notify
			// succeeded, collecting, primary scope, tier3-silent classic typescript —
			// native-ts7 excluded by `classifyCascadeWaitTier`). If the sync call
			// answers (even with an empty body, which is a confirmed clean), we use
			// those diagnostics as the confirmed result and clear the
			// `diagnosticsTimedOut` flag so the touch is no longer treated as
			// inconclusive. Sync diagnostics on a dirty file are surfaced, not
			// discarded. If the sync call fails or is unavailable, we fall through to
			// today's behavior: `inconclusive` = true, `collected` unchanged. This
			// turns "unconfirmed after ~1000ms" into "confirmed at ~wait+sync-RTT"
			// even when the race path couldn't answer.
			if (
				diagnosticsTimedOut &&
				tsserverSyncEligible &&
				collected !== undefined &&
				collected.length === 0
			) {
				try {
					const syncResult = await attemptTsserverSyncDiagnostics(
						filePath,
						this,
					);
					if (syncResult !== undefined) {
						// Sync answered — confirmed result (clean or with diagnostics).
						// Clear the timed-out flag so the touch is no longer inconclusive.
						diagnosticsTimedOut = false;
						retractPrimaryTimeoutAttribution(); // #1549
						syncConfirmed = true;
						collected =
							syncResult.length > 0 ? mergeLspDiagnostics(syncResult) : [];
						logLatency({
							type: "phase",
							phase: "lsp_tsserver_sync_confirm",
							filePath: normalizedPath,
							durationMs: Date.now() - startedAt,
							metadata: {
								source,
								clientScope,
								diagnosticsMode,
								mode: "end-of-wait",
								confirmedDiagnosticCount: collected.length,
							},
						});
					}
				} catch {
					// Any failure here falls through to today's inconclusive behavior.
				}
			}

			// #799: generalize the "silent-clean push-only" confirm beyond
			// typescript's active sync-command race above. That mechanism is
			// TS-specific (`attemptTsserverSyncDiagnostics` races an actual
			// `typescript.tsserverRequest` — no equivalent protocol exists for
			// e.g. marksman) and is now scoped to `serverId === "typescript"`
			// only (see the gate above), so it never fires for another
			// `silentOnClean` server. This is the generic fallback for those
			// servers: if the wait ran its full budget with a successful notify
			// write and nothing published, and the live capability snapshot
			// classifies this touch as tier3-silent (push-only + `silentOnClean`,
			// #458's `classifyCascadeWaitTier`), that is not "still working" —
			// `silentOnClean` means by definition this server publishes NOTHING
			// on a clean transition, so a timeout under those conditions IS the
			// confirmed-clean answer. `!tsserverSyncEligible` keeps this from
			// ever double-deciding typescript's own touches — when the sync race
			// was attempted and failed/was unavailable, typescript's existing
			// "falls through to inconclusive, unchanged" contract (#707) is
			// preserved exactly; typescript touches that never enter that gate
			// (e.g. `collectDiagnostics: false`, like `ensureWarmForSweep`'s own
			// warm-up call) are still eligible here as a genuine bonus fix. Scoped
			// to `clientScope === "primary"`/`spawned.length === 1` exactly like
			// the sync-eligible gate above (and like `ensureWarmForSweep`'s own
			// `clientScope: "primary"` warm-up touch) so a multi-server
			// with-auxiliary/all touch — where a partial timeout must stay
			// cautious per the doc below — is never affected.
			//
			// #814: this is now a SPECIAL CASE of the more general per-server gate
			// above (the `clientScope === "all"` block right before the diagnostics-
			// wait `if` closes) — for `spawned.length === 1`, "every still-outstanding
			// server is tier3-silent" collapses to exactly this single-server check.
			// Left in place unchanged (rather than deleted/rewritten to delegate to
			// the new gate) per #814's scope: a future cleanup could fold this block
			// into the general one once both have soaked, but that's a separate,
			// lower-risk follow-up, not bundled into this fix.
			if (
				diagnosticsTimedOut &&
				// #1549: primary-scoped, like the aggregate gate. `spawned.length === 1`
				// below means the one server IS the primary, so this is the same condition
				// written in the vocabulary the rest of the merge now uses.
				!primaryNotifyWriteTimedOut &&
				!tsserverSyncEligible &&
				clientScope === "primary" &&
				spawned.length === 1 &&
				getStrategy(
					spawned[0].client.serverId,
					spawned[0].client.getLaunchVariant?.(),
				).silentOnClean === true
			) {
				try {
					const snapshots = await this.getCapabilitySnapshots(filePath);
					if (
						classifyCascadeWaitTier(this, filePath, snapshots) ===
						"tier3-silent"
					) {
						// #1277: same liveness precondition as the aggregate gate above —
						// `tier3-silent` is a static capability classification and can't
						// distinguish "silent because clean" from "silent because wedged".
						// A cheap bounded round-trip proves the server is still actually
						// responding before its silence is trusted as a clean confirm; a
						// server that doesn't answer in time leaves the touch inconclusive.
						const alive = await (
							spawned[0].client.pingLiveness?.() ?? Promise.resolve(true)
						).catch(() => false);
						if (alive) {
							diagnosticsTimedOut = false;
							retractPrimaryTimeoutAttribution(); // #1549
							if (collected !== undefined) collected = mergeLspDiagnostics([]);
							logLatency({
								type: "phase",
								phase: "lsp_silent_clean_confirm",
								filePath: normalizedPath,
								durationMs: Date.now() - startedAt,
								metadata: {
									source,
									clientScope,
									diagnosticsMode,
									serverId: spawned[0].client.serverId,
								},
							});
						}
					}
				} catch {
					// Fail-safe: leave `diagnosticsTimedOut` as-is — today's inconclusive
					// behavior.
				}
			}

			// #1549: a touch is inconclusive when a PRIMARY's notify write or the
			// diagnostics wait hit their deadline. Both inputs are primary-scoped now.
			//
			// The rule this replaced — `notifyWriteTimedOut || diagnosticsTimedOut`, both
			// flags touch-wide over every spawned server — discarded every good answer in
			// the touch whenever one auxiliary was slow. `timeoutMs` is the MAX over the
			// servers waited on, so opengrep's 3500ms budget set the deadline for the whole
			// touch and a typescript answer that landed in 100ms read as "nothing is known
			// about this file". Measured over 6,079 cascade neighbour sweeps: 97.6%
			// inconclusive, against 15% for ordinary edit-time touches in the same window.
			//
			// The caution the old comment argued for is preserved, in the honest place: the
			// merged result IS missing whatever the unreporting auxiliary would have said,
			// so the touch withdraws its claim of full coverage (`confirmation: "partial"`
			// plus `unconfirmedServerIds`, below) and every consumer that treats
			// confirmation as proof of coverage still fails closed. What it no longer does
			// is throw away the primary's answer, which is the #533 honesty doctrine
			// cutting both ways.
			const verdict = resolveTouchVerdict({
				primaryNotifyWriteTimedOutServerIds,
				diagnosticsTimedOut,
				diagnosticsUnansweredServerIds: diagnosticsUnansweredPrimaryServerIds,
			});
			const inconclusive = verdict.inconclusive;

			// #1470/#1493: an auxiliary whose push wait was CUT OFF by the aux grace
			// timer (R8/#714) contributed exactly as much evidence about this file as one
			// that went silent inside its own budget — none. Both now narrow the
			// confirmation, through the one `auxiliaryCoverageGap` policy. A hung or
			// silent opengrep used to resolve `confirmation: "confirmed"` and read as
			// confirmed-clean on the security lane; the silent half survived #1470
			// because it only tripped `diagnosticsTimedOut` when it was the ONLY
			// auxiliary, so a fast sibling hid it (#1493).
			// This does NOT flip the touch to inconclusive: that would discard a
			// primary answer that IS trustworthy (#533 honesty doctrine cuts both ways —
			// overclaiming and underclaiming are both dishonest). Instead the confirmation
			// is NARROWED: `"partial"`, naming the servers it does not speak for, so every
			// consumer that treats confirmation as proof of coverage fails closed while
			// the primary's findings still flow.
			// #1459: two more doors into the same room, and they open BEFORE any wait —
			// so `auxiliaryCoverageGap` (which reads wait outcomes) cannot see either on
			// its own. A scanner whose breaker was open never attached, and one whose
			// resync the fan-out gate deferred never received this content.
			//
			// The deferred ids are unioned in rather than left to the aux-wait policy on
			// purpose: an aux outcome row requires an auxiliary to have been SPAWNED, and a
			// breaker-skipped scanner never was. #1533: an `"all"`-scope sweep emits outcome
			// rows now too, so a spawned-but-deferred server arrives through BOTH routes as
			// outcome `"deferred"` — where a stored publication
			// for these exact bytes can still exempt it — so the Set dedups rather than
			// double-reports, and #1493's content-hash exemption is not bypassed here:
			// a deferred aux is only unioned in because the gate itself proves it was
			// never sent this content.
			const brokenSkippedServerIds =
				collected !== undefined
					? await this.brokenSkippedAuxiliaryServerIds(
							filePath,
							clientScope,
							options,
							spawned,
						)
					: [];
			// #1549: the fourth door, and the one this issue opened. An auxiliary that
			// missed a deadline no longer makes the touch inconclusive, so it MUST arrive
			// here instead — otherwise the fix would launder a scanner blackout into a
			// clean bill of health, which is the #1459/#1493 false-clean pointing the other
			// way. Two shapes reach this and no aux outcome row: an auxiliary whose notify
			// write timed out or rejected, and one that produced no publication evidence
			// when the wait lapsed (including on a NON-collecting touch, which derives no
			// outcome rows at all). The content-bound exemption is honored through the same
			// `auxCoversThisContent` predicate the merge uses — one rule, so a scanner
			// cannot be named uncovered while its findings ride along in `.diags`, or the
			// reverse. The Set dedups against the ids `auxiliaryCoverageGap` reported.
			const auxNoAnswerServerIds = spawned
				.filter(
					(entry) =>
						entry.info.role === "auxiliary" &&
						(diagnosticsUnansweredServerIds.includes(entry.info.id) ||
							notifyWriteTimedOutServerIds.includes(entry.info.id)) &&
						!auxCoveredAtMerge.has(entry.info.id),
				)
				.map((entry) => entry.info.id);
			// #1586: whatever the doors contributed, the RESULT's coverage claim is
			// settled from the MERGE's frozen evaluation — never a fresh one, which is
			// what made this an overclaim in review (see `auxCoveredAtMerge`). The
			// per-door filters above are not redundant with this one: they shape the
			// `lsp_scanner_coverage_gap` fields, which each answer "what did THIS door
			// see", while this settles "what does the touch speak for". It matters most
			// for `auxUnconfirmedServerIds`, decided when the aux wait ended and therefore
			// strictly BEFORE the merge — reconciling it here is what keeps a scanner from
			// being named while the merge kept its findings. A breaker-skipped scanner
			// never reached `spawned`, so it is not in the covered set and stays named:
			// fail closed.
			const unconfirmedServerIds = [
				...new Set([
					...(auxUnconfirmedServerIds ?? []),
					...auxNoAnswerServerIds,
					...uncoveredDeferredServerIds,
					...brokenSkippedServerIds,
				]),
			].filter((serverId) => !auxCoveredAtMerge.has(serverId));
			const coverageGap = unconfirmedServerIds.length > 0;
			// The record that proves a blackout is no longer read as clean: one row per
			// touch that a scanner did not cover, naming the scanner and the reason.
			if (
				brokenSkippedServerIds.length > 0 ||
				uncoveredDeferredServerIds.length > 0 ||
				// #1549: the auxiliary deadline misses that used to surface as a blanket
				// `inconclusive` need their own row now that the touch reports usable
				// findings — otherwise the fix would remove the only record of the blackout.
				auxNoAnswerServerIds.length > 0
			) {
				for (const serverId of unconfirmedServerIds) {
					const reasons = [
						brokenSkippedServerIds.includes(serverId) && "breaker skip",
						uncoveredDeferredServerIds.includes(serverId) && "deferred resync",
						auxNoAnswerServerIds.includes(serverId) && "no diagnostics answer",
					].filter(Boolean);
					incrementDegradationCount({
						kind: "lsp-scanner-coverage-gap",
						subject: `${serverId}:${normalizedPath}`,
						reason: reasons.join(", ") || "scanner coverage gap",
					});
				}
				emitBounded("lsp_scanner_coverage_gap", `${source}:${normalizedPath}`, {
					filePath: normalizedPath,
					durationMs: Date.now() - startedAt,
					metadata: {
						source,
						clientScope,
						...(brokenSkippedServerIds.length > 0 && {
							brokenSkippedServerIds,
						}),
						// #1586: the deferrals this touch is actually uncovered for. The
						// gate action keeps its own record in `lsp_notify_resync_deferred`;
						// this row exists to prove a blackout, and a scanner already bound
						// to these bytes is not one.
						...(uncoveredDeferredServerIds.length > 0 && {
							deferredResyncServerIds: uncoveredDeferredServerIds,
						}),
						...(auxNoAnswerServerIds.length > 0 && { auxNoAnswerServerIds }),
					},
				});
			}

			// #667: a confirmed (non-inconclusive) diagnostics-mode touch is the
			// "actually warm" signal `ensureWarmForSweep` waits for — mark every
			// spawned server so a later sweep in this session sees the check as a
			// no-op instead of paying the warm-up round trip again.
			//
			// #743: the diagnostics wait is a blanket (touch-wide) gate, but the
			// notify-write timeout is now PER-SERVER — a healthy server whose sibling's
			// write stalled must still be eligible, so only servers whose OWN write
			// timed out are skipped here (rather than gating the whole loop on the
			// file-level `inconclusive`).
			//
			// #1470/#1493: same per-server reasoning for an auxiliary that contributed
			// no evidence. "Demonstrated ready" means this server answered for this
			// file; an auxiliary our grace timer cut off, or one that stayed silent
			// through its own budget, demonstrably did not.
			//
			// NO TEST PINS THIS LINE, and that is a property of today's readers rather
			// than a coverage gap: `ensureWarmForSweep` filters `role === "auxiliary"`
			// out of its server list entirely, so no reader consumes an auxiliary's
			// `demonstratedReady` mark and deleting this `continue` changes no observable
			// behavior (verified by mutation — the LSP suite stays green). It stays
			// because the mark's meaning is "this server answered", and the moment any
			// reader stops filtering auxiliaries out, marking a cut-off scanner warm
			// would let it skip a warm-up it never earned.
			//
			// #1549: `diagnosticsTimedOut` is primary-attributed now, so this loop can be
			// reached with an auxiliary that never answered — including on a NON-COLLECTING
			// touch, which derives no aux wait-outcome rows. `unconfirmedServerIds` covers
			// that case because `auxNoAnswerServerIds` is computed for every touch, not only
			// a collecting one; an unheard scanner is therefore already excluded here and
			// needs no separate guard. A primary cannot reach this loop unheard at all: it
			// would have set `diagnosticsTimedOut`, and the gates that clear that flag
			// retract its attribution precisely because they certified its silence AS the
			// answer (`retractPrimaryTimeoutAttribution`).
			const notifyTimedOutServerIds = new Set(notifyWriteTimedOutServerIds);
			const uncoveredServerIds = new Set(unconfirmedServerIds);
			if (diagnosticsMode !== "none" && !diagnosticsTimedOut) {
				for (const entry of spawned) {
					if (notifyTimedOutServerIds.has(entry.info.id)) continue;
					if (uncoveredServerIds.has(entry.info.id)) continue;
					const key = await this.demonstratedReadyKeyFor(entry.info, filePath);
					if (key) this.markDemonstratedReadyKey(key);
				}
			}

			// Prime the last-known cache WITH the hash of the content we just synced,
			// so a hot-path consumer (actionable-warnings at turn_end) can verify the
			// cached diagnostics are for the current bytes before reusing them instead
			// of paying for a second open+wait. Only when we actually collected — a
			// non-collecting touch (didChange-only) leaves the prior entry intact.
			// Skip this entirely when the touch was inconclusive: an unconfirmed
			// empty `collected` must never erase a previously-confirmed non-empty
			// record (that's the #570 bug — a timeout silently reporting as clean
			// and wiping out known-good diagnostic state).
			// #1470/#1493: a PARTIAL touch is the same hazard wearing a different flag.
			// Its merged array is missing whatever the unreporting auxiliary would have said, so
			// priming the cache with it would let `actionable-warnings`' hash-guarded
			// read replay a partially-covered result as an authoritative observation —
			// and an empty one would DELETE a previously-confirmed record on the strength
			// of a scanner that never answered. Skip the prime; the next read pays a real
			// round trip instead of trusting an incomplete one.
			if (collected !== undefined && !inconclusive && !coverageGap) {
				const normalizedKey = normalizeMapKey(filePath);
				if (collected.length > 0) {
					this.lastKnownDiagnostics.set(normalizedKey, collected);
					this.lastKnownContentHash.set(
						normalizedKey,
						this.hashContent(content),
					);
				} else {
					this.lastKnownDiagnostics.delete(normalizedKey);
					this.lastKnownContentHash.delete(normalizedKey);
				}
			}

			// #1179 (shape-5 structural fix): build the result WRAPPER. The two flags
			// that used to ride the returned array as NON-enumerable side-channels
			// (`Object.defineProperty(collected, ...)`, dropped by any `[...]`/`.filter`/
			// `JSON` copy — the #1094/#1096 loss class) are now EXPLICIT ENUMERABLE
			// fields on this wrapper. `.diags` holds the array a copy operates on, so the
			// flags survive by construction. Field presence mirrors the old attachment
			// conditions EXACTLY: `inconclusive` only for a confirmed-inconclusive
			// collect, `binding` only for a collecting touch — a non-collecting touch
			// keeps resolving `{ diags: [] }`, no flags.
			const result: TouchFileResult = { diags: collected ?? [] };

			if (collected !== undefined && inconclusive) {
				result.inconclusive = true;
				// #1549: name the primary that produced the verdict and which deadline it
				// missed, so a forensic sweep reads the cause instead of inferring it from
				// duration histograms. Absent ids on an inconclusive touch mean the
				// attribution was not derivable (a client with no per-path publication
				// stamp) — honest, and the same fail-closed verdict as before.
				if (verdict.inconclusiveServerIds) {
					result.inconclusiveServerIds = verdict.inconclusiveServerIds;
				}
				result.inconclusiveReason = verdict.inconclusiveReason;
			} else if (collected !== undefined && coverageGap) {
				// #1470/#1493: narrowed, not collapsed. Reached for EITHER no-answer
				// shape — a cut-off auxiliary or a silent one with nothing published for
				// this content. The primary's findings ride along in `.diags` exactly as
				// before; what changes is that the touch now states which servers it does
				// not speak for, so no consumer can read this as a full clean bill of
				// health.
				result.confirmation = "partial";
				result.unconfirmedServerIds = [...unconfirmedServerIds];
			} else if (collected !== undefined) {
				// Preserve the lower-level affirmative result across consumers. In
				// particular, the silent-clean gates above clear diagnosticsTimedOut only
				// after a successful notify and capability-confirmed wait; reclassifying
				// that empty array later would discard the evidence that made it clean.
				result.confirmation = "confirmed";
			}

			// #1095: attach the merged content binding so a consumer can ask whether
			// these diagnostics were computed against current disk. Composed across every
			// spawned client so a single client whose view diverged from disk marks the
			// whole merged result mismatched. Disk verify is lazy + memoized per
			// (file, mtime).
			let binding: DiagnosticBinding | undefined;
			if (collected !== undefined) {
				binding = syncConfirmed
					? // #1095 (P3-b): a tsserver sync-confirmed result is authoritative for
						// the current buffer but not tied to the publish-path fingerprint —
						// surface "unknown" so a stale publish binding can't demote it.
						{ boundToCurrentDisk: "unknown" }
					: this.mergeBinding(
							filePath,
							// Optional-chain so a client without the getter (test doubles, a
							// partially-mocked client) yields "unknown" rather than throwing —
							// unknown preserves pre-#1095 behavior for that contributor.
							[
								// #1459/#1549: a contributor whose findings the merge DROPPED must
								// not decide the merged verdict either — its binding describes
								// bytes this result no longer contains.
								// #1586: read off the same frozen set the drop used. Filtering the
								// raw deferral set instead excluded the fingerprint of a
								// deferred-but-COVERED scanner whose findings the merge had just
								// kept, which diverges whenever the primary is version-less and
								// that scanner is the only contributor with a fingerprint.
								...spawned
									.filter(
										(entry) => !droppedAuxiliaryServerIds.has(entry.info.id),
									)
									.map((entry) =>
										entry.client.getDiagnosticBinding?.(filePath),
									),
								...carriedAuxiliary.map((entry) => entry.binding),
							],
						);
				result.binding = binding;
			}

			// The recent-touches entries are recorded per server inside the notify-write
			// loop above, at the moment each server's own write lands (#1253) — a server
			// whose write timed out or rejected deliberately gets none, so the next touch
			// re-pushes it rather than debouncing a failure into a later touch that looks
			// fully delivered. Nothing to record here: a skipped server keeps its original
			// entry (and timestamp) so its window still expires naturally instead of being
			// extended by every reuse.

			logLatency({
				type: "phase",
				phase: "lsp_touch_file",
				filePath: normalizedPath,
				durationMs: Date.now() - startedAt,
				metadata: {
					serverCountReady: spawned.length,
					clientScope,
					diagnosticsMode,
					source,
					failureKind: "success",
					collectedDiagnostics: collected?.length,
					// #1095: observability so an unbinding server is diagnosable —
					// "bound" (matches disk) / "mismatch" (diverged) / "unknown"
					// (version-less server or disk unreadable). Absent for non-collecting
					// touches (no merged result to bind).
					...(binding !== undefined && {
						bindingState: bindingStateLabel(binding.boundToCurrentDisk),
					}),
					notifySkipped,
					notifyWriteTimedOut,
					// #743: per-server detail — which servers' writes actually timed out.
					// Absent when none did. `notifyWriteTimedOut` is the file-level "at
					// least one" summary.
					...(notifyWriteTimedOutServerIds.length > 0 && {
						notifyWriteTimedOutServerIds,
					}),
					diagnosticsTimedOut,
					inconclusive,
					// #1549: the attribution the issue's observability contract asks for —
					// WHICH primary made the touch inconclusive and which deadline it missed
					// (`notify-write` vs `diagnostics-wait`, or `mixed`). Absent on a
					// conclusive touch, which blames nobody.
					...(verdict.inconclusiveServerIds && {
						inconclusiveServerIds: verdict.inconclusiveServerIds,
					}),
					...(verdict.inconclusiveReason && {
						inconclusiveReason: verdict.inconclusiveReason,
					}),
					// #1470: the touch's own honesty verdict, so a `cut_off` row in
					// `lsp_aux_wait_outcome` can be joined to the touch that produced it and
					// shown NOT to have claimed confirmation for that server's coverage.
					// Absent for a non-collecting touch, which claims nothing either way.
					...(result.confirmation !== undefined && {
						confirmation: result.confirmation,
					}),
					// R8 (#714): server ids of auxiliaries whose push wait was cut off by
					// the aux grace window (primary settled clean + aux timed out in grace).
					// Absent when no aux was cut off. These servers' diagnostics are
					// advisory-only and will surface on the next edit from their cache.
					...(auxCutOffServerIds !== undefined && { auxCutOffServerIds }),
					// #1493: the full set the confirmation was narrowed on — the cut-off
					// ids plus every auxiliary that stayed silent with nothing published
					// for this content. Absent when the touch speaks for every server.
					// This is the join key for the issue's observability contract: a
					// `silent` row in `lsp_aux_wait_outcome` must appear here, on a touch
					// whose `confirmation` is `"partial"`.
					...(auxUnconfirmedServerIds !== undefined && {
						auxUnconfirmedServerIds,
					}),
					// #1459: scanners this touch does not speak for because their breaker
					// was open, or because the resync gate deferred their write. Separate
					// fields because these two doors open BEFORE any wait, so neither can
					// appear in an `lsp_aux_wait_outcome` row on the sweep path. Absent
					// when every configured scanner got this content — #1586 included: a
					// deferred scanner already bound to these bytes is covered, so it is not
					// named here either. The gate's own action is recorded regardless, in
					// `lsp_notify_resync_deferred`.
					...(brokenSkippedServerIds.length > 0 && { brokenSkippedServerIds }),
					...(uncoveredDeferredServerIds.length > 0 && {
						deferredResyncServerIds: uncoveredDeferredServerIds,
					}),
					// #1549: auxiliaries whose own deadline lapsed — the wait produced no
					// publication, or the notify write never landed. Distinct from the fields
					// above (a different door) and from `auxUnconfirmedServerIds` (derived
					// from aux wait-outcome rows, which a non-collecting touch never emits).
					...(auxNoAnswerServerIds.length > 0 && { auxNoAnswerServerIds }),
				},
			});
			return result;
		} finally {
			for (const key of leaseKeys) this.releaseClientLease(key);
		}
	}

	/**
	 * #2052: the file's nearest marker root, but ONLY when the file is outside
	 * every initialized session cwd. Returns undefined (no decline) otherwise.
	 *
	 * The cheap registry test runs FIRST so an in-session file — the hot path —
	 * pays one bounded map walk and never the `server.root()` filesystem walks.
	 */
	private async findOutsideProjectRoot(
		filePath: string,
	): Promise<string | undefined> {
		if (!isOutsideAllSessionRoots(filePath)) return undefined;
		const candidates = await Promise.all(
			getServersForFileWithConfig(filePath).map((server) =>
				server.root(filePath),
			),
		);
		return candidates.find((candidate): candidate is string =>
			Boolean(candidate),
		);
	}

	/**
	 * #2052: one bounded record per normalized foreign root per session.
	 *
	 * `operation` is a PARAMETER, not a constant: `touchFile` and
	 * `getDiagnostics` both decline here, and a record that always claimed
	 * "touchFile" would erase which call site actually refused — the
	 * discriminating identity a bounded record has to preserve. The ledger's
	 * rising edge is keyed on the root, so many files under one foreign root
	 * still collapse to a single detailed row.
	 */
	private recordOutsideRootDecline(
		filePath: string,
		nearestRoot: string,
		operation: "touchFile" | "getDiagnostics",
	): void {
		const root = normalizeMapKey(nearestRoot);
		const sessionRoots = getSessionRootsForTelemetry()
			.map((sessionRoot) => normalizeMapKey(sessionRoot))
			.join(", ");
		emitBounded(
			"lsp_capability_skip",
			root,
			{
				filePath: normalizeMapKey(filePath),
				durationMs: 0,
				metadata: {
					operation,
					nearestMarkerRoot: root,
					sessionRoots,
					identity: root,
				},
			},
			{
				ledgerKind: "lsp-capability-skip",
				risingEdgePer: "identity",
				reason: `declined LSP root outside session cwd: ${root}`,
			},
		);
	}

	/**
	 * Get diagnostics for a file
	 */
	getDiagnosticsHealth(filePath: string): LSPDiagnosticsHealth | undefined {
		return this.lastDiagnosticsHealth.get(normalizeMapKey(filePath));
	}

	/**
	 * Return whatever LSP diagnostics were last cached for this file without
	 * triggering a fresh open / wait / merge. Returns `undefined` when nothing
	 * was ever cached; callers should treat that as distinct from "cached but
	 * empty" (`[]`), which means LSP confirmed no diagnostics last time.
	 *
	 * Intended for hot-path consumers (e.g. actionable-warnings at turn_end)
	 * that already paid for a `touchFile` during dispatch and just want to
	 * read the result without a second LSP round trip.
	 *
	 * Pass `expectedContentHash` (sha256 of the current file bytes) to guard
	 * against staleness: the entry is returned only when it was primed by a
	 * `touchFile` for the *same* content. On mismatch — or for an entry written
	 * without content (the service-level merge) — this returns `undefined` so the
	 * caller does a fresh check instead of serving a previous turn's diagnostics.
	 * Omit it for display consumers (the widget) that accept last-known.
	 */
	getLastKnownDiagnostics(
		filePath: string,
		expectedContentHash?: string,
	): import("./client.js").LSPDiagnostic[] | undefined {
		const normalizedKey = normalizeMapKey(filePath);
		if (expectedContentHash !== undefined) {
			const knownHash = this.lastKnownContentHash.get(normalizedKey);
			if (knownHash === undefined || knownHash !== expectedContentHash) {
				return undefined;
			}
		}
		return this.lastKnownDiagnostics.get(normalizedKey);
	}

	async getDiagnostics(
		filePath: string,
		diagnosticsMode: LSPDiagnosticsMode = "full",
	): Promise<import("./client.js").LSPDiagnostic[]> {
		const normalizedPath = normalizeMapKey(filePath);
		const outsideRoot = await this.findOutsideProjectRoot(filePath);
		if (outsideRoot) {
			this.recordOutsideRootDecline(filePath, outsideRoot, "getDiagnostics");
			return [];
		}
		if (this.checkDestroyed()) {
			this.lastDiagnosticsHealth.set(normalizedPath, {
				health: "destroyed",
				failureKind: "destroyed",
				serverCountAttempted: 0,
				serverCountReady: 0,
				candidateServerIds: getServersForFileWithConfig(filePath).map(
					(s) => s.id,
				),
				mergedCount: 0,
				dedupDroppedCount: 0,
				checkedAt: new Date().toISOString(),
			});
			return [];
		}
		const startedAt = Date.now();
		const candidateServerIds = getServersForFileWithConfig(filePath).map(
			(s) => s.id,
		);
		const { clients: spawned, serverCountAttempted } =
			await this.getClientsForFile(filePath);
		if (spawned.length === 0) {
			const stale = this.lastKnownDiagnostics.get(normalizedPath);
			const failureKind = stale?.length ? "no_clients_stale" : "no_clients";
			this.lastDiagnosticsHealth.set(normalizedPath, {
				health: failureKind,
				failureKind,
				serverCountAttempted,
				serverCountReady: 0,
				candidateServerIds,
				mergedCount: stale?.length ?? 0,
				dedupDroppedCount: 0,
				checkedAt: new Date().toISOString(),
			});
			logLatency({
				type: "phase",
				phase: "lsp_diagnostics_aggregate",
				filePath: normalizedPath,
				durationMs: Date.now() - startedAt,
				metadata: {
					serverCountAttempted,
					serverCountReady: 0,
					mergedCount: stale?.length ?? 0,
					dedupDroppedCount: 0,
					failureKind,
					health: failureKind,
					servers: [],
				},
			});
			return stale ?? [];
		}

		// Per-server entries produced by client waits. Each promise resolves
		// with a PerServerEntry; raceToCompletion collects them as they finish.
		type PerServerEntry = {
			serverId: string;
			launchVariant?: "classic" | "native-ts7";
			waitMs: number;
			diagnosticCount: number;
			diagnostics: import("./client.js").LSPDiagnostic[];
		};

		const clientWaits: Promise<PerServerEntry>[] = spawned.map(
			async (entry) => {
				const waitStart = Date.now();
				const launchVariant = entry.client.getLaunchVariant?.();
				const strategy = getStrategy(entry.info.id, launchVariant);
				await entry.client.waitForDiagnostics(
					filePath,
					strategy.aggregateWaitMs,
				);
				let diagnostics = entry.client.getDiagnostics(filePath);
				const firstWaitMs = Date.now() - waitStart;
				if (
					strategy.expectSemanticSecondPush &&
					diagnostics.length === 0 &&
					firstWaitMs < DIAGNOSTICS_SEMANTIC_SETTLE_THRESHOLD_MS
				) {
					await entry.client.waitForDiagnostics(
						filePath,
						DIAGNOSTICS_SEMANTIC_SETTLE_WAIT_MS,
					);
					diagnostics = entry.client.getDiagnostics(filePath);
				}
				return {
					serverId: entry.info.id,
					launchVariant,
					waitMs: Date.now() - waitStart,
					diagnosticCount: diagnostics.length,
					diagnostics,
				};
			},
		);

		// Document mode: 0ms grace — return as soon as any client has results.
		// Full mode: 400ms grace — wait a bit for other clients to catch up.
		const graceMs = diagnosticsMode === "document" ? 0 : EARLY_UNBLOCK_GRACE_MS;

		// R8 (#714) / #1458 S2: per-promise role descriptors so raceToCompletion
		// can apply a bounded aux grace once all primary-role promises have
		// settled. Servers with role:"auxiliary" (opengrep, ast-grep, zizmor, …)
		// get their OWN declared `aggregateWaitMs` budget after the primary
		// settles, capped by the PI_LENS_AUX_GRACE_MS global ceiling (default
		// 2000ms) — the same "declared budget, capped by a ceiling" shape
		// `touchFile`'s with-auxiliary push wait uses, so this lane can no longer
		// starve a scanner whose measured warm run (e.g. opengrep ~1.3s) is
		// shorter than the ceiling but longer than a flat short grace. Late
		// arrivals are still dropped (advisory only — they land in the client
		// cache and surface on the next edit). Primary-only callers have no
		// auxiliary descriptors, so this path is never entered and there is
		// zero behavior change for the single-server hot path.
		const diagDescriptors: PromiseDescriptor[] = spawned.map((entry) => {
			if (entry.info.role !== "auxiliary") return { role: "primary" };
			const strategy = getStrategy(
				entry.info.id,
				entry.client.getLaunchVariant?.(),
			);
			// Deleting this `budgetMs` fails no end-to-end test, and that is
			// expected rather than a coverage gap: every promise in `clientWaits`
			// already self-bounds at this same `strategy.aggregateWaitMs`, so an
			// auxiliary cuts itself off at its declared budget whether or not the
			// shared grace timer also knows about it. The descriptor is what keeps
			// the two agreeing — it is the mitigation for the over-granting
			// `raceToCompletion` documents, and it starts mattering the moment a
			// promise here stops self-bounding. The narrowing itself is pinned in
			// tests/clients/lsp/aggregation.test.ts, which can build the
			// non-self-bounded promises this path cannot.
			return { role: "auxiliary", budgetMs: strategy.aggregateWaitMs };
		});

		// Result-aware racing: trigger early-unblock when any client has results,
		// OR when a seedFirstPush server returns (its first push is authoritative
		// even when empty — waiting longer yields nothing more).
		const perServer = await raceToCompletion(
			clientWaits,
			(results) =>
				results.some(
					(r) =>
						r.diagnosticCount > 0 ||
						getStrategy(r.serverId, r.launchVariant).seedFirstPush,
				),
			{
				timeoutMs: Math.max(
					...spawned.map(
						(entry) =>
							getStrategy(entry.info.id, entry.client.getLaunchVariant?.())
								.aggregateWaitMs,
					),
				),
				graceMs,
				descriptors: diagDescriptors,
				// #1458 S2: ceiling, not a flat wait — each auxiliary's own
				// budgetMs (above) determines the actual per-touch grace up to
				// this cap. Matches touchFile's `readEnvAuxGraceMs() ?? 2000`.
				auxGraceMs: readEnvAuxGraceMs() ?? 2000,
			},
		);

		// Fill in any slots that timed out before producing results.
		const earlyUnblockedCount = spawned.length - perServer.length;
		const perServerFull: PerServerEntry[] = spawned.map((entry) => {
			const found = perServer.find((r) => r.serverId === entry.info.id);
			return (
				found ?? {
					serverId: entry.info.id,
					launchVariant: entry.client.getLaunchVariant?.(),
					waitMs: getStrategy(entry.info.id, entry.client.getLaunchVariant?.())
						.aggregateWaitMs,
					diagnosticCount: 0,
					diagnostics: [],
				}
			);
		});

		// Deduplicate across servers (same diagnostic reported by multiple tools).

		const merged: import("./client.js").LSPDiagnostic[] = [];
		const seen = new Set<string>();
		for (const entry of perServerFull) {
			for (const diagnostic of entry.diagnostics) {
				const key = [
					diagnostic.range.start.line,
					diagnostic.range.start.character,
					diagnostic.message,
				].join(":");
				if (seen.has(key)) continue;
				seen.add(key);
				merged.push(diagnostic);
			}
		}

		const rawCount = perServerFull.reduce(
			(sum, entry) => sum + entry.diagnosticCount,
			0,
		);
		const serversWithDiagnostics = perServerFull.filter(
			(entry) => entry.diagnosticCount > 0,
		).length;
		const failureKind = merged.length === 0 ? "ok_empty" : "success";

		this.lastDiagnosticsHealth.set(normalizedPath, {
			health: failureKind === "success" ? "ok" : "ok_empty",
			failureKind,
			serverCountAttempted,
			serverCountReady: perServerFull.length,
			candidateServerIds,
			mergedCount: merged.length,
			dedupDroppedCount: rawCount - merged.length,
			checkedAt: new Date().toISOString(),
		});

		logLatency({
			type: "phase",
			phase: "lsp_diagnostics_aggregate",
			filePath: normalizedPath,
			durationMs: Date.now() - startedAt,
			metadata: {
				serverCountAttempted,
				serverCountReady: perServerFull.length,
				serverCountWithDiagnostics: serversWithDiagnostics,
				mergedCount: merged.length,
				dedupDroppedCount: rawCount - merged.length,
				earlyUnblockedCount,
				diagnosticsMode,
				failureKind,
				health: failureKind === "success" ? "ok" : "ok_empty",
				servers: perServerFull.map((entry) => ({
					id: entry.serverId,
					waitMs: entry.waitMs,
					diagnosticCount: entry.diagnosticCount,
				})),
			},
		});

		// Keep last known so the widget can show stale diagnostics if LSP dies.
		// Live clients returning [] means genuinely no errors — clear the stale
		// entry so the widget doesn't show resolved issues. This path has no
		// content in hand, so drop any content hash: a hash-guarded read won't
		// trust this entry as current (it falls through to a fresh check), while
		// the unguarded widget read still gets last-known for display.
		if (merged.length > 0) {
			this.lastKnownDiagnostics.set(normalizedPath, merged);
		} else {
			this.lastKnownDiagnostics.delete(normalizedPath);
		}
		this.lastKnownContentHash.delete(normalizedPath);

		return merged;
	}

	/**
	 * Delegates to {@link hashDiagnosticContent} rather than re-hashing here. Every
	 * comparison this hash takes part in (`publishedThisContent`, the carried-aux
	 * check, the last-known content guard) is against a hash the client produced
	 * with that function, so the two implementations must agree byte for byte —
	 * a duplicate is a silent divergence waiting for one of them to be tuned.
	 */
	private hashContent(content: string): string {
		return hashDiagnosticContent(content);
	}

	/**
	 * #1095: compose the content `binding` for a merged diagnostics result across
	 * the clients that contributed to it (primary + any auxiliaries). Verifies
	 * each contributor's stored binding against current disk lazily (memoized per
	 * file+mtime by {@link diskBindingCache}) and composes per
	 * {@link composeBoundToCurrentDisk}: ANY contributor mismatches disk → false;
	 * else all "unknown" (or no contributors) → "unknown"; else true. The
	 * surfaced version/contentHash come from the first contributor that carries
	 * them — informational only; the load-bearing field is `boundToCurrentDisk`.
	 * #1104: `version` and `contentHash` are tracked INDEPENDENTLY (not gated on
	 * the same contributor carrying both) — a pull-sourced binding deliberately
	 * has no `version` (the pull protocol has no version-echo concept) but does
	 * carry a real `contentHash`; gating the latter on the former would silently
	 * drop it here even though `boundToCurrentDisk` above already used it.
	 */
	private mergeBinding(
		filePath: string,
		stored: readonly (StoredDiagnosticBinding | undefined)[],
	): DiagnosticBinding {
		const verdicts: BoundToCurrentDisk[] = [];
		let version: number | undefined;
		let contentHash: string | undefined;
		for (const entry of stored) {
			verdicts.push(
				this.diskBindingCache.boundToCurrentDisk(filePath, entry ?? {}),
			);
			if (version === undefined && entry?.version !== undefined) {
				version = entry.version;
			}
			if (contentHash === undefined && entry?.contentHash !== undefined) {
				contentHash = entry.contentHash;
			}
		}
		return {
			version,
			contentHash,
			boundToCurrentDisk: composeBoundToCurrentDisk(verdicts),
		};
	}

	/**
	 * Navigation: go to definition
	 */
	async definition(filePath: string, line: number, character: number) {
		const spawned = await this.getClientForFile(
			filePath,
			NAV_CLIENT_WAIT_TIMEOUT_MS,
		);
		if (!spawned) return [];
		if (!spawned.client.getOperationSupport().definition) {
			throw new Error(
				"__UNSUPPORTED__ Active LSP server does not advertise support for definition",
			);
		}
		return spawned.client.definition(filePath, line, character);
	}

	/**
	 * Navigation: go to the type definition of the symbol at a position
	 */
	async typeDefinition(filePath: string, line: number, character: number) {
		const spawned = await this.getClientForFile(
			filePath,
			NAV_CLIENT_WAIT_TIMEOUT_MS,
		);
		if (!spawned) return [];
		if (!spawned.client.getOperationSupport().typeDefinition) {
			throw new Error(
				"__UNSUPPORTED__ Active LSP server does not advertise support for typeDefinition",
			);
		}
		return spawned.client.typeDefinition(filePath, line, character);
	}

	/**
	 * Navigation: go to the declaration of the symbol at a position
	 */
	async declaration(filePath: string, line: number, character: number) {
		const spawned = await this.getClientForFile(
			filePath,
			NAV_CLIENT_WAIT_TIMEOUT_MS,
		);
		if (!spawned) return [];
		if (!spawned.client.getOperationSupport().declaration) {
			throw new Error(
				"__UNSUPPORTED__ Active LSP server does not advertise support for declaration",
			);
		}
		return spawned.client.declaration(filePath, line, character);
	}

	/**
	 * Navigation: find all references
	 */
	async references(
		filePath: string,
		line: number,
		character: number,
		includeDeclaration = true,
	) {
		const spawned = await this.getClientForFile(
			filePath,
			NAV_CLIENT_WAIT_TIMEOUT_MS,
		);
		if (!spawned) return [];
		if (!spawned.client.getOperationSupport().references) {
			throw new Error(
				"__UNSUPPORTED__ Active LSP server does not advertise support for references",
			);
		}
		return spawned.client.references(
			filePath,
			line,
			character,
			includeDeclaration,
		);
	}

	/**
	 * Navigation: hover info
	 */
	async hover(filePath: string, line: number, character: number) {
		const spawned = await this.getClientForFile(
			filePath,
			NAV_CLIENT_WAIT_TIMEOUT_MS,
		);
		if (!spawned) return null;
		if (!spawned.client.getOperationSupport().hover) {
			throw new Error(
				"__UNSUPPORTED__ Active LSP server does not advertise support for hover",
			);
		}
		return spawned.client.hover(filePath, line, character);
	}

	/**
	 * Navigation: signature help at cursor position
	 */
	async signatureHelp(filePath: string, line: number, character: number) {
		const spawned = await this.getClientForFile(
			filePath,
			NAV_CLIENT_WAIT_TIMEOUT_MS,
		);
		if (!spawned) return null;
		if (!spawned.client.getOperationSupport().signatureHelp) {
			throw new Error(
				"__UNSUPPORTED__ Active LSP server does not advertise support for signatureHelp",
			);
		}
		return spawned.client.signatureHelp(filePath, line, character);
	}

	/**
	 * Navigation: symbols in document
	 */
	async documentSymbol(filePath: string) {
		const spawned = await this.getClientForFile(
			filePath,
			NAV_CLIENT_WAIT_TIMEOUT_MS,
		);
		if (!spawned) return [];
		if (!spawned.client.getOperationSupport().documentSymbol) {
			throw new Error(
				"__UNSUPPORTED__ Active LSP server does not advertise support for documentSymbol",
			);
		}
		return spawned.client.documentSymbol(filePath);
	}

	/**
	 * Resolves "the target client" for a workspace-scope query that has no
	 * filePath to route through `getClientForFile`. `state.clients` is keyed
	 * `${serverId}:${root}` in spawn order, not role order, so an auxiliary
	 * scanner (ast-grep, opengrep, zizmor, ...) that happens to spawn first in
	 * a polyglot workspace used to win every no-filePath query outright (#1812
	 * — a supporting primary server spawned later never got a look-in). Scans
	 * for the first LIVE client matching `predicate` (when given), preferring
	 * any primary (non-`"auxiliary"` role) match over an auxiliary one — the
	 * same primary-over-auxiliary preference `getClientForFile` encodes via
	 * its `role !== "auxiliary"` filter (this file, `getClientForFile`) and
	 * `getAliveServerIds` groups by. `isAlive()` is required for BOTH the
	 * preferred and fallback candidate — mirrors `getCapabilitySnapshots`'s
	 * own no-filePath branch (this file, ~line 5868), whose liveness filter
	 * this helper otherwise duplicates; without it a dead primary would win
	 * over a live, answering auxiliary. Role is read from the map key's
	 * `serverId` prefix against `LSP_SERVERS`, the same single source of
	 * truth `getCapabilitySnapshots` already parses that key from — never a
	 * second, hand-rolled role table. A `serverId` prefix absent from
	 * `LSP_SERVERS` (should not happen in practice — every spawned client's
	 * key is built from a known server's `id`) resolves to `role === undefined`,
	 * which falls through to the primary branch: unknown treated as primary,
	 * never silently dropped. Returns undefined only when NO live client
	 * (primary or auxiliary) matches.
	 */
	private selectWorkspaceScopeClient(
		predicate?: (client: LSPClientInfo) => boolean,
	): { client: LSPClientInfo; serverId: string } | undefined {
		let auxFallback: { client: LSPClientInfo; serverId: string } | undefined;
		for (const [key, client] of this.state.clients) {
			if (!client.isAlive()) continue;
			if (predicate && !predicate(client)) continue;
			const separator = key.indexOf(":");
			const serverId = separator >= 0 ? key.slice(0, separator) : key;
			const role = LSP_SERVERS.find((s) => s.id === serverId)?.role;
			if (role === "auxiliary") {
				if (!auxFallback) auxFallback = { client, serverId };
				continue;
			}
			return { client, serverId };
		}
		return auxFallback;
	}

	/**
	 * Navigation: workspace-wide symbol search
	 *
	 * #1789: gated on the target server's advertised `workspaceSymbolProvider`
	 * (the same `getOperationSupport().workspaceSymbol` single source of truth
	 * `lsp-document-symbols.ts`'s documentSymbol gate reads — see clients/
	 * lsp-document-symbols.ts:50).
	 *
	 * #1812: without a path, the no-filePath branch used to stop at
	 * `state.clients`' first entry by insertion order regardless of whether it
	 * supported `workspace/symbol` — an auxiliary spawned first silently ate
	 * every query with `[]` and zero requests, even when a supporting primary
	 * server was already spawned too. `selectWorkspaceScopeClient` now scans
	 * for the first client that DOES support it, preferring a primary over an
	 * auxiliary; only when none of the spawned clients support it does this
	 * fall back to `[]`.
	 */
	async workspaceSymbol(
		query: string,
		filePath?: string,
		attribution?: LSPWorkspaceScopeAttribution,
	) {
		if (filePath) {
			const spawned = await this.getClientForFile(
				filePath,
				NAV_CLIENT_WAIT_TIMEOUT_MS,
			);
			if (!spawned) return [];
			if (!spawned.client.getOperationSupport().workspaceSymbol) return [];
			return spawned.client.workspaceSymbol(query);
		}

		const target = this.selectWorkspaceScopeClient(
			(client) => client.getOperationSupport().workspaceSymbol,
		);
		if (!target) return [];
		if (attribution) attribution.workspaceSymbol = target.serverId;
		return target.client.workspaceSymbol(query);
	}

	/**
	 * Commands advertised for workspace/executeCommand. If filePath is given,
	 * the server for that file; otherwise the first active client, preferring
	 * a primary over an auxiliary scanner spawned first (#1812 sweep — see
	 * `selectWorkspaceScopeClient`).
	 */
	async getAdvertisedCommands(
		filePath?: string,
		attribution?: LSPWorkspaceScopeAttribution,
	): Promise<string[]> {
		if (filePath) {
			const spawned = await this.getClientForFile(
				filePath,
				NAV_CLIENT_WAIT_TIMEOUT_MS,
			);
			if (!spawned) return [];
			return spawned.client.getAdvertisedCommands();
		}
		const first = this.selectWorkspaceScopeClient();
		if (!first) return [];
		if (attribution) attribution.getAdvertisedCommands = first.serverId;
		return first.client.getAdvertisedCommands();
	}

	/**
	 * Run a server command via workspace/executeCommand (hardened: allowlisted by
	 * advertisement in the client). If filePath is given, target that file's
	 * server; otherwise the first active client, preferring a primary over an
	 * auxiliary scanner spawned first (#1812 sweep — see
	 * `selectWorkspaceScopeClient`).
	 */
	async executeCommand(
		filePath: string | undefined,
		command: string,
		args?: unknown[],
		mutationContext?: LspMutationContext,
		attribution?: LSPWorkspaceScopeAttribution,
	): Promise<{ executed: boolean; result?: unknown; reason?: string }> {
		if (filePath) {
			const spawned = await this.getClientForFile(
				filePath,
				NAV_CLIENT_WAIT_TIMEOUT_MS,
			);
			if (!spawned) {
				return { executed: false, reason: "no LSP server for file" };
			}
			return spawned.client.executeCommand(command, args, mutationContext);
		}
		const first = this.selectWorkspaceScopeClient();
		if (!first) return { executed: false, reason: "no active LSP server" };
		if (attribution) attribution.executeCommand = first.serverId;
		return first.client.executeCommand(command, args, mutationContext);
	}

	/**
	 * #1640: run a read-only probe command against a server that is ALREADY
	 * running for this file. Two hard guarantees the mutation-channel
	 * `executeCommand` above cannot give a render-path probe:
	 *
	 * - **Never spawns.** It resolves the already-connected client map the way
	 *   other read-only client-map lookups do, instead of routing through
	 *   `getClientForFile` → `ensureClientForServer`. A probe that spawns a
	 *   language-server fleet to answer a question about how to RENDER a
	 *   diagnostic is a cost the caller never asked for — and under warm attach
	 *   the freshly spawned server's answer would not even be the warm session's
	 *   answer.
	 * - **Never opens the mutation window.** `executeReadOnlyCommand` leaves
	 *   `serverEditsAllowed` and `activeMutationContext` alone, so an in-flight
	 *   real command's mutation context survives a concurrent probe.
	 *
	 * Returns `{executed:false}` — never a thrown error and never a spawn — when
	 * no live client owns the file. Callers must read that as UNKNOWN.
	 */
	async executeReadOnlyCommandOnLiveClient(
		filePath: string,
		command: string,
		args?: unknown[],
	): Promise<{ executed: boolean; result?: unknown; reason?: string }> {
		if (this.checkDestroyed()) {
			return { executed: false, reason: "lsp service destroyed" };
		}
		for (const server of getServersForFileWithConfig(filePath)) {
			const root = await this.resolveServerRoot(server, filePath);
			if (!root) continue;
			const entry = this.state.clients.get(
				`${server.id}:${normalizeMapKey(root)}`,
			);
			if (!entry?.isAlive()) continue;
			const run = entry.executeReadOnlyCommand;
			if (typeof run !== "function") continue;
			return run.call(entry, command, args);
		}
		return { executed: false, reason: "no live LSP server for file" };
	}

	/**
	 * Capability snapshot for LSP operations.
	 * If filePath is provided, probes that server. Without a filePath the
	 * snapshot describes the whole workspace, so each capability is ORed
	 * across every client `selectWorkspaceScopeClient` would consider.
	 *
	 * #1846: the no-filePath branch used to report ONE client's capabilities,
	 * whichever `selectWorkspaceScopeClient()` returned with no predicate. In
	 * a multi-primary workspace (say `json` spawned before `typescript`), a
	 * first client that does not advertise `workspaceSymbolProvider` reported
	 * the operation unsupported even though a later client advertises it. The
	 * tool layer then refused the call before `workspaceSymbol()` — which
	 * #1812 taught to find the supporting client — was ever reached
	 * (tools/lsp-navigation.ts, the `runWorkspaceSymbolOperation` gate).
	 *
	 * Each capability resolves through `selectWorkspaceScopeClient` with a
	 * per-capability predicate, so this answer is built from the SAME liveness
	 * and primary-over-auxiliary rules that route the operation itself (see
	 * `selectWorkspaceScopeClient`, this file). A dead client therefore cannot
	 * contribute a capability nobody can execute. Capabilities the base client
	 * already reports true are skipped, so the extra scans only run for the
	 * capabilities it lacks.
	 */
	async getOperationSupport(
		filePath?: string,
		attribution?: LSPWorkspaceScopeAttribution,
	): Promise<import("./client.js").LSPOperationSupport | null> {
		if (filePath) {
			const spawned = await this.getClientForFile(filePath);
			if (!spawned) return null;
			const getter = spawned.client.getOperationSupport;
			if (typeof getter !== "function") return null;
			return getter();
		}

		const readable = (client: LSPClientInfo) =>
			typeof client.getOperationSupport === "function";
		const first = this.selectWorkspaceScopeClient(readable);
		if (!first) return null;
		const aggregate = { ...first.client.getOperationSupport() };
		const contributors: Partial<Record<keyof LSPOperationSupport, string>> = {};
		for (const capability of Object.keys(aggregate) as Array<
			keyof import("./client.js").LSPOperationSupport
		>) {
			if (aggregate[capability]) {
				contributors[capability] = first.serverId;
				continue;
			}
			const supporter = this.selectWorkspaceScopeClient(
				(client) =>
					readable(client) && Boolean(client.getOperationSupport()[capability]),
			);
			if (supporter) {
				aggregate[capability] = true;
				contributors[capability] = supporter.serverId;
			}
		}
		if (attribution) {
			attribution.getOperationSupport = {
				baseClientId: first.serverId,
				contributors,
			};
		}
		return aggregate;
	}

	/**
	 * Capability snapshot for workspace diagnostics support.
	 * If filePath is provided, probes that server; otherwise uses first active client.
	 */
	async getCapabilitySnapshots(
		filePath?: string,
		attribution?: LSPWorkspaceScopeAttribution,
	): Promise<LSPCapabilitySnapshot[]> {
		if (this.checkDestroyed()) return [];
		const snapshots: LSPCapabilitySnapshot[] = [];

		if (filePath) {
			const servers = getServersForFileWithConfig(filePath);
			for (const server of servers) {
				const root = await this.resolveServerRoot(server, filePath);
				if (!root) continue;
				const client = this.state.clients.get(
					`${server.id}:${normalizeMapKey(root)}`,
				);
				if (!client?.isAlive()) continue;
				snapshots.push({
					serverId: server.id,
					root,
					operationSupport: client.getOperationSupport(),
					workspaceDiagnosticsSupport: client.getWorkspaceDiagnosticsSupport(),
					advertisedCommands: client.getAdvertisedCommands(),
					rawCapabilityKeys: client.getRawCapabilityKeys?.() ?? [],
					launchVariant: client.getLaunchVariant?.(),
				});
			}
			return snapshots;
		}

		for (const [key, client] of this.state.clients) {
			if (!client.isAlive()) continue;
			const separator = key.indexOf(":");
			const serverId = separator >= 0 ? key.slice(0, separator) : key;
			snapshots.push({
				serverId,
				root: client.root,
				operationSupport: client.getOperationSupport(),
				workspaceDiagnosticsSupport: client.getWorkspaceDiagnosticsSupport(),
				advertisedCommands: client.getAdvertisedCommands(),
				rawCapabilityKeys: client.getRawCapabilityKeys?.() ?? [],
				launchVariant: client.getLaunchVariant?.(),
			});
		}
		if (attribution) {
			attribution.getCapabilitySnapshots = {
				clientIds: snapshots
					.slice(0, WORKSPACE_ATTRIBUTION_CLIENT_CAP)
					.map((snapshot) => snapshot.serverId),
				clientCount: snapshots.length,
			};
		}
		return snapshots;
	}

	async getWorkspaceDiagnosticsSupport(
		filePath?: string,
		attribution?: LSPWorkspaceScopeAttribution,
	): Promise<import("./client.js").LSPWorkspaceDiagnosticsSupport | null> {
		if (filePath) {
			const spawned = await this.getClientForFile(filePath);
			if (!spawned) return null;
			const getter = spawned.client.getWorkspaceDiagnosticsSupport;
			if (typeof getter !== "function") return null;
			return getter();
		}

		const first = this.selectWorkspaceScopeClient();
		if (!first) return null;
		const getter = first.client.getWorkspaceDiagnosticsSupport;
		if (typeof getter !== "function") return null;
		if (attribution)
			attribution.getWorkspaceDiagnosticsSupport = first.serverId;
		return getter.call(first.client);
	}

	/**
	 * Navigation: available code actions at position/range
	 */
	async codeAction(
		filePath: string,
		line: number,
		character: number,
		endLine: number,
		endCharacter: number,
	) {
		const spawned = await this.getClientForFile(
			filePath,
			NAV_CLIENT_WAIT_TIMEOUT_MS,
		);
		if (!spawned) return [];
		if (!spawned.client.getOperationSupport().codeAction) {
			throw new Error(
				"__UNSUPPORTED__ Active LSP server does not advertise support for codeAction",
			);
		}
		return spawned.client.codeAction(
			filePath,
			line,
			character,
			endLine,
			endCharacter,
		);
	}

	/**
	 * Navigation: rename symbol at position
	 */
	async rename(
		filePath: string,
		line: number,
		character: number,
		newName: string,
	) {
		const spawned = await this.getClientForFile(
			filePath,
			NAV_CLIENT_WAIT_TIMEOUT_MS,
		);
		if (!spawned) return null;
		if (!spawned.client.getOperationSupport().rename) {
			throw new Error(
				"__UNSUPPORTED__ Active LSP server does not advertise support for rename",
			);
		}
		return spawned.client.rename(filePath, line, character, newName);
	}

	async renameFile(
		oldFilePath: string,
		newFilePath: string,
		options: {
			cwd: string;
			apply?: boolean;
			mutationContext?: LspMutationContext;
		},
	): Promise<LSPRenameFileResult> {
		const cwd = options.cwd;
		const apply = options.apply ?? false;
		// Validate the complete resource operation before asking any server for
		// willRenameFiles edits. This is a read-only preflight, but it reuses the
		// same confinement, realpath/symlink, existence, and destination checks as
		// the eventual apply path, so an invalid rename cannot first mutate an
		// in-workspace file through returned text edits (including previews).
		await validateWorkspaceEdit(
			{
				documentChanges: [
					{
						kind: "rename",
						oldUri: pathToFileURL(oldFilePath).href,
						newUri: pathToFileURL(newFilePath).href,
					},
				],
			},
			cwd,
		);
		const priorityServerIds = getServersForFileWithConfig(oldFilePath).map(
			(server) => server.id,
		);
		const activeClients = this.activeClientsForCwd(cwd, priorityServerIds);
		const willRenameFailures: Array<{ serverId: string; error: string }> = [];
		const didRenameFailures: RenameNotifyFailure[] = [];
		const willRenameClients = activeClients.filter(({ serverId, client }) => {
			if (client.getOperationSupport().willRenameFiles === true) return true;
			recordDegradationOnce({
				kind: "lsp-capability-skip",
				subject: `${serverId}:workspace/willRenameFiles`,
				reason: client
					.getMalformedFileOperationRegistrations()
					.has("willRename")
					? "malformed-registration"
					: "no-registration",
			});
			return false;
		});

		const willResults = await Promise.all(
			willRenameClients.map(async ({ serverId, client }) => {
				try {
					return {
						serverId,
						edit: await client.willRenameFiles(oldFilePath, newFilePath),
					};
				} catch (err) {
					willRenameFailures.push({
						serverId,
						error: err instanceof Error ? err.message : String(err),
					});
					return { serverId, edit: null };
				}
			}),
		);

		const successfulWillResults = willResults.filter(
			(result) =>
				!willRenameFailures.some(
					(failure) => failure.serverId === result.serverId,
				),
		);
		if (willRenameClients.length > 0 && successfulWillResults.length === 0) {
			throw new Error(
				`workspace/willRenameFiles failed for all active LSP servers: ${willRenameFailures.map((failure) => `${failure.serverId}: ${failure.error}`).join("; ")}`,
			);
		}

		const merged = mergeWorkspaceTextEditsByPriority(successfulWillResults);
		const summary = summarizeWorkspaceEdit(merged.edit, cwd);
		if (!apply) {
			return {
				applied: false,
				serverIds: activeClients.map((entry) => entry.serverId),
				willRenameFailures,
				didRenameFailures,
				droppedConflicts: merged.droppedConflicts,
				inputEditCount: merged.inputEditCount,
				summary,
			};
		}

		let applied;
		try {
			applied = await applyWorkspaceEdit(merged.edit, cwd, {
				mutationContext: options.mutationContext,
				observe: false,
			});
		} catch (err) {
			if (options.mutationContext) {
				const partial = (err as { appliedWorkspaceEdit?: typeof applied })
					.appliedWorkspaceEdit;
				if (partial) {
					recordLspMutation(options.mutationContext, {
						results: [partial],
						status: "failed",
					});
				}
			}
			throw err;
		}
		const openDocuments = activeClients
			.filter(({ client }) => client.isDocumentOpen(oldFilePath))
			.map(({ serverId, client }) => ({
				serverId,
				client,
				oldUri: client.getDocumentUri(oldFilePath),
			}));
		const closeFailures: RenameNotifyFailure[] = [];
		await Promise.all(
			openDocuments.map(async ({ serverId, client }) => {
				// #1621: bounded so one wedged server's didClose write cannot stall
				// this Promise.all — and therefore the whole rename — for every
				// other client alongside it.
				const result = await runRenameNotify(
					() => client.closeDocument(oldFilePath),
					RENAME_NOTIFY_TIMEOUT_MS,
				);
				if (!result.ok) {
					closeFailures.push({
						serverId,
						error: result.error,
						disposition: result.disposition,
					});
				}
			}),
		);
		if (closeFailures.length > 0) {
			if (options.mutationContext) {
				recordLspMutation(options.mutationContext, {
					results: [applied],
					status: "failed",
				});
			}
			// Do not rename or send didRenameFiles while any server still has the
			// old document open. Re-open/resync every affected client so a partial
			// close cannot leave an in-memory document behind the disk contents.
			// Reopen with the document's ACTUAL language ID (the same resolver every
			// genuine open uses) rather than a hardcoded "plaintext" fallback — a
			// wrong languageId here degrades that server's diagnostics until the
			// next genuine open (#1147 P3-7).
			const content = await fs.readFile(oldFilePath, "utf-8");
			const languageId = getLanguageId(oldFilePath) ?? "plaintext";
			const resyncFailures: RenameNotifyFailure[] = [];
			// #1621 F1: the resync write is the SAME class of notify as the didClose
			// it is repairing after — a pipe that is wedged for didClose is wedged
			// for every subsequent write on it too, so this bare await reintroduced
			// the exact unbounded primitive one Promise.all up. Bound it with the
			// same budget and record the disposition rather than let a wedged
			// resync silently move the hang here instead of removing it.
			await Promise.all(
				openDocuments.map(async ({ serverId, client }) => {
					const resyncResult = await runRenameNotify(
						() =>
							client.notify.open(oldFilePath, content, languageId, true, true),
						RENAME_NOTIFY_TIMEOUT_MS,
					);
					if (!resyncResult.ok) {
						resyncFailures.push({
							serverId,
							error: resyncResult.error,
							disposition: resyncResult.disposition,
						});
					}
				}),
			);
			if (resyncFailures.length > 0) {
				// A resync failure is not swallowed: the affected client is left with
				// no open document at all until its next genuine open, so this is
				// logged for the same reason lsp_client_shutdown records a forced
				// teardown — a degraded resync must be countable from the log.
				logLatency({
					type: "phase",
					phase: "lsp_rename_resync_failed",
					filePath: oldFilePath,
					durationMs: 0,
					metadata: {
						failures: resyncFailures.map((failure) => ({
							serverId: failure.serverId,
							disposition: failure.disposition,
							error: failure.error,
						})),
					},
				});
			}
			const closeFailureSummary = closeFailures
				.map(
					(failure) =>
						`${failure.serverId} (${failure.disposition}): ${failure.error}`,
				)
				.join("; ");
			const resyncFailureSummary =
				resyncFailures.length > 0
					? ` (resync also failed: ${resyncFailures.map((failure) => `${failure.serverId} (${failure.disposition}): ${failure.error}`).join("; ")})`
					: "";
			throw new Error(
				`workspace/didClose failed; rename aborted: ${closeFailureSummary}${resyncFailureSummary}`,
			);
		}
		let renameApplied;
		try {
			// Route the resource mutation through the same preflight confinement,
			// realpath and symlink policy as all other workspace edits. Do not
			// duplicate that security boundary with a direct mkdir/rename pair.
			renameApplied = await applyWorkspaceEdit(
				{
					documentChanges: [
						{
							kind: "rename",
							oldUri: pathToFileURL(oldFilePath).href,
							newUri: pathToFileURL(newFilePath).href,
						},
					],
				},
				cwd,
				{ observe: false },
			);
		} catch (err) {
			if (options.mutationContext) {
				recordLspMutation(options.mutationContext, {
					results: [applied],
					status: "failed",
				});
			}
			throw err;
		}
		const relOld =
			path.relative(cwd, oldFilePath).replace(/\\/g, "/") ||
			path.basename(oldFilePath);
		const relNew =
			path.relative(cwd, newFilePath).replace(/\\/g, "/") ||
			path.basename(newFilePath);
		const renameDescription = `Renamed ${relOld} → ${relNew}`;

		await Promise.all(
			activeClients.map(async ({ serverId, client }) => {
				// #1971 review: didRename has its own registration. A server that
				// never asked for didRenameFiles notifications must not receive
				// them — same chokepoint discipline as the willRename preflight.
				if (client.getOperationSupport().didRenameFiles !== true) {
					recordDegradationOnce({
						kind: "lsp-capability-skip",
						subject: `${serverId}:workspace/didRenameFiles`,
						reason: client
							.getMalformedFileOperationRegistrations()
							.has("didRename")
							? "malformed-registration"
							: "no-registration",
					});
					return;
				}
				const opened = openDocuments.find(
					(entry) => entry.serverId === serverId,
				);
				// #1621: bounded for the same reason as the didClose notify above —
				// rename propagation is best-effort advice to servers, not a
				// correctness gate, so a wedged client's notify must not stall the
				// healthy clients settling alongside it in this Promise.all.
				const result = await runRenameNotify(
					() =>
						opened?.oldUri
							? client.didRenameFiles(
									oldFilePath,
									newFilePath,
									opened.oldUri,
									destinationUriPreservingSpelling(
										opened.oldUri,
										oldFilePath,
										newFilePath,
									),
								)
							: client.didRenameFiles(oldFilePath, newFilePath),
					RENAME_NOTIFY_TIMEOUT_MS,
				);
				if (!result.ok) {
					didRenameFailures.push({
						serverId,
						error: result.error,
						disposition: result.disposition,
					});
				}
			}),
		);

		const files = [...new Set([...applied.files, oldFilePath, newFilePath])];
		if (options.mutationContext) {
			recordLspMutation(options.mutationContext, {
				results: [
					{
						...applied,
						files,
						operationTotal:
							applied.operationTotal + renameApplied.operationTotal,
						appliedOperationTotal:
							applied.appliedOperationTotal +
							renameApplied.appliedOperationTotal,
						appliedOperationIndexes: [
							...applied.appliedOperationIndexes,
							...renameApplied.appliedOperationIndexes.map(
								(index) => applied.operationTotal + index,
							),
						],
						operationCounts: {
							textEdits:
								applied.operationCounts.textEdits +
								renameApplied.operationCounts.textEdits,
							create:
								applied.operationCounts.create +
								renameApplied.operationCounts.create,
							rename:
								applied.operationCounts.rename +
								renameApplied.operationCounts.rename,
							delete:
								applied.operationCounts.delete +
								renameApplied.operationCounts.delete,
						},
						fileDetails: [...applied.fileDetails, ...renameApplied.fileDetails],
					},
				],
				status: "success",
			});
		}

		return {
			applied: true,
			serverIds: activeClients.map((entry) => entry.serverId),
			willRenameFailures,
			didRenameFailures,
			droppedConflicts: merged.droppedConflicts,
			inputEditCount: merged.inputEditCount,
			summary,
			descriptions: [...applied.descriptions, renameDescription],
			files,
		};
	}

	/**
	 * Navigation: go to implementation
	 */
	async implementation(filePath: string, line: number, character: number) {
		const spawned = await this.getClientForFile(
			filePath,
			NAV_CLIENT_WAIT_TIMEOUT_MS,
		);
		if (!spawned) return [];
		if (!spawned.client.getOperationSupport().implementation) {
			throw new Error(
				"__UNSUPPORTED__ Active LSP server does not advertise support for implementation",
			);
		}
		return spawned.client.implementation(filePath, line, character);
	}

	/**
	 * Navigation: prepare call hierarchy at position
	 */
	async prepareCallHierarchy(
		filePath: string,
		line: number,
		character: number,
	) {
		const spawned = await this.getClientForFile(
			filePath,
			NAV_CLIENT_WAIT_TIMEOUT_MS,
		);
		if (!spawned) return [];
		if (!spawned.client.getOperationSupport().callHierarchy) {
			throw new Error(
				"__UNSUPPORTED__ Active LSP server does not advertise support for prepareCallHierarchy",
			);
		}
		return spawned.client.prepareCallHierarchy(filePath, line, character);
	}

	/**
	 * Navigation: find incoming calls (callers)
	 *
	 * #1803: gated on the target server's advertised `callHierarchyProvider`
	 * (the same `getOperationSupport().callHierarchy` single source of truth
	 * populated by `detectOperationSupport` in clients/lsp/client.ts — see
	 * client.ts:5253). Mirrors the #1789 gate on `workspaceSymbol` above.
	 */
	async incomingCalls(item: import("./client.js").LSPCallHierarchyItem) {
		const spawned = await this.getClientForFile(
			uriToPath(item.uri),
			NAV_CLIENT_WAIT_TIMEOUT_MS,
		);
		if (!spawned) return [];
		if (!spawned.client.getOperationSupport().callHierarchy) return [];
		return spawned.client.incomingCalls(item);
	}

	/**
	 * Navigation: find outgoing calls (callees)
	 *
	 * #1803: same gate as `incomingCalls` above.
	 */
	async outgoingCalls(item: import("./client.js").LSPCallHierarchyItem) {
		const spawned = await this.getClientForFile(
			uriToPath(item.uri),
			NAV_CLIENT_WAIT_TIMEOUT_MS,
		);
		if (!spawned) return [];
		if (!spawned.client.getOperationSupport().callHierarchy) return [];
		return spawned.client.outgoingCalls(item);
	}

	/**
	 * #667: shared warm-check/ensure-warm step for BOTH `lsp_diagnostics`
	 * (`tools/lsp-diagnostics.ts`'s batch/directory sweep) and
	 * `lens_diagnostics mode=full` (`runWorkspaceDiagnostics` below) — one
	 * implementation instead of two hand-copied ones, since both already
	 * share `groupFilesByPrimaryServer`/`runPerServerGroups` (#631).
	 *
	 * Root cause this closes (#667): `serverCountReady:1` only proves the
	 * server process spawned and passed the LSP `initialize` handshake — it
	 * does NOT prove the server can usefully answer a diagnostics request
	 * yet. tsserver-style servers can still be loading/indexing the project
	 * internally for seconds after `initialize` resolves, and without this
	 * check whichever file(s) land first in a sweep pay that cost as
	 * individual per-file timeouts (observed: the first 5 files of a
	 * 100-file sweep all hit the exact per-file ceiling with
	 * `serverCountReady:1`, file 6 onward clean and fast).
	 *
	 * `representativeFile` should be one file from the group/batch about to
	 * be swept — used only to resolve which server(s) serve it and, if
	 * needed, to perform the warm-up touch itself.
	 *
	 * Cheap/no-op when every non-auxiliary server for `representativeFile`
	 * has already answered a confirmed diagnostics touch earlier in THIS
	 * session (`isDemonstratedReady` — set by `touchFile` above): resolves
	 * the server list and root(s) (no spawn, no I/O beyond that) and
	 * returns immediately. Only when at least one candidate server hasn't
	 * demonstrated readiness does this perform one deliberate warm-up
	 * `touchFile` round trip against `representativeFile`, bounded by its
	 * OWN generous budget (`warmupTimeoutMs`/`PI_LENS_LSP_WARMUP_TIMEOUT_MS`
	 * — distinct from the per-file sweep budget), and waits for it to
	 * settle (success, timeout, or abort) before returning. This does NOT
	 * change the per-file wait budgets or confirmed/unconfirmed contract
	 * (#242/#611/#634) the sweep itself uses — it only runs once, before
	 * the sweep's own loop starts.
	 *
	 * Returns `performedWarmup: true` only when the round trip actually ran
	 * (false = already warm, no-op) — tests assert on this to guard against
	 * the warm-up becoming a mandatory extra round trip on every sweep.
	 *
	 * #744: a warm-up that TIMES OUT is no longer left as a silent dead end.
	 * The old one-shot behavior left a wedged server (observed live: marksman,
	 * a `workspaceIndexing` server, burned the full 20s and stayed cold) with
	 * no re-warm and no skip — so every subsequent per-file touch in the sweep
	 * re-paid a full per-file budget against it and timed out again, dragging
	 * the whole sweep. Now: on a failed warm-up this retries exactly once (after
	 * a short `warmupRetryBackoffMs` breather — the state where warm-up fails is
	 * usually a server mid-relaunch/index that just needs a moment), and if the
	 * retry ALSO leaves the server cold it is reported in `failedServerIds`. The
	 * caller (the sweep loop) skips that server's files up front and marks them
	 * unconfirmed, so per-file touches stop paying its timeout. This is a
	 * sweep-scoped skip (the caller discards `failedServerIds` when the sweep
	 * ends), deliberately NOT the global `broken` cooldown map: a server that is
	 * merely still indexing is not broken and must not be cooldown-banned across
	 * the whole session — it just wasn't ready for THIS sweep.
	 *
	 * "Failed warm-up" is measured per non-auxiliary server via the SAME
	 * `demonstratedReady` signal `touchFile` marks on a confirmed round trip: a
	 * server whose key is still absent from `demonstratedReady` after both
	 * attempts never proved it can answer diagnostics. Warm-up stays
	 * `clientScope:"primary"` (not the sweep's `"all"`) on purpose: `"all"`
	 * would additionally spawn the sweep-EXCLUDED auxiliaries
	 * (`WORKSPACE_SWEEP_EXCLUDED_SERVER_IDS`), which is work this warm-up does not
	 * need. (Before #1549 it was also unsafe: `touchFile`'s `inconclusive` flag was
	 * touch-wide, so one slow advisory auxiliary suppressed the `demonstratedReady`
	 * marking for a perfectly healthy primary — falsely condemning it. The verdict is
	 * per-server now, and the marking loop skips only the servers that did not answer
	 * for themselves, so the scope choice is a cost argument rather than a
	 * correctness one.) Recording per-primary-server outcomes and skipping
	 * on those is the correct, non-regressing way to cover the servers the sweep
	 * actually gates on (the sweep groups by primary server, so the group this
	 * warms IS the one whose per-file touches would drag).
	 */
	async ensureWarmForSweep(
		representativeFile: string,
		options: { timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<{
		performedWarmup: boolean;
		failedServerIds: string[];
		/** #799: true when `failedServerIds` came from the negative cache
		 * (`demonstratedCold`) rather than a fresh warm-up attempt — lets a
		 * caller/log distinguish "we already knew this was cold" from "this
		 * attempt just failed". */
		skippedFromCache?: boolean;
	}> {
		if (this.checkDestroyed() || options.signal?.aborted) {
			return { performedWarmup: false, failedServerIds: [] };
		}
		const servers = getServersForFileWithConfig(representativeFile).filter(
			(s) => s.role !== "auxiliary",
		);
		if (servers.length === 0) {
			return { performedWarmup: false, failedServerIds: [] };
		}

		// A server with no resolvable root never spawns a client for this file
		// either way, so it can't block "already warm" — only servers that WILL
		// actually be used count toward the readiness check. Same key
		// derivation `touchFile` uses to mark readiness (`demonstratedReadyKeyFor`)
		// so this lines up exactly regardless of what a client instance itself
		// reports as its `.root`.
		const keys = await Promise.all(
			servers.map((server) =>
				this.demonstratedReadyKeyFor(server, representativeFile),
			),
		);
		const alreadyWarm = keys.every(
			(key) => key === undefined || this.state.demonstratedReady.has(key),
		);
		if (alreadyWarm) return { performedWarmup: false, failedServerIds: [] };

		// #799: negative cache. Every server that still needs warming (not
		// already `demonstratedReady`) was ALSO left cold by a warm-up earlier
		// this session (`demonstratedCold`, populated below when a warm-up's
		// initial attempt + retry both fail) — skip straight to the group-skip
		// accounting the caller already has for `failedServerIds`, instead of
		// re-paying the initial-attempt + retry round trip all over again. A
		// MIXED group (one server cached cold, another never tried) still runs
		// the real warm-up — the never-tried server deserves its fair shot, and
		// `touchFile`'s multi-server spawn already covers both in one call.
		const cachedColdServerIds: string[] = [];
		let allNonWarmCached = true;
		for (let i = 0; i < servers.length; i++) {
			const key = keys[i];
			if (key === undefined || this.state.demonstratedReady.has(key)) continue;
			if (this.state.demonstratedCold.has(key)) {
				cachedColdServerIds.push(servers[i].id);
			} else {
				allNonWarmCached = false;
			}
		}
		if (allNonWarmCached && cachedColdServerIds.length > 0) {
			logLatency({
				type: "phase",
				phase: "lsp_sweep_warmup_cached_cold",
				filePath: representativeFile,
				durationMs: 0,
				metadata: { serverIds: cachedColdServerIds },
			});
			return {
				performedWarmup: false,
				failedServerIds: cachedColdServerIds,
				skippedFromCache: true,
			};
		}

		let content: string;
		try {
			content = await nodeFs.promises.readFile(representativeFile, "utf-8");
		} catch {
			// Nothing to warm up with — the real sweep's own read will surface
			// the file error.
			return { performedWarmup: false, failedServerIds: [] };
		}
		if (options.signal?.aborted) {
			return { performedWarmup: false, failedServerIds: [] };
		}

		const timeoutMs = options.timeoutMs ?? warmupTimeoutMs();

		// A non-auxiliary server that WILL spawn for this file (resolvable key)
		// but whose key is still absent from `demonstratedReady` after an attempt
		// never proved it can answer diagnostics — that's a failed warm-up. A
		// server with an unresolvable key never spawns here, so it can't fail this
		// way and is excluded (never skipped by the caller for this file).
		const stillColdServerIds = (): string[] => {
			const cold: string[] = [];
			for (let i = 0; i < servers.length; i++) {
				const key = keys[i];
				if (key !== undefined && !this.state.demonstratedReady.has(key)) {
					cold.push(servers[i].id);
				}
			}
			return cold;
		};

		const runWarmupTouch = async (attempt: number): Promise<void> => {
			if (options.signal?.aborted) return;
			const startedAt = Date.now();
			logLatency({
				type: "phase",
				phase: "lsp_sweep_warmup_start",
				filePath: representativeFile,
				durationMs: 0,
				metadata: { serverIds: servers.map((s) => s.id), timeoutMs, attempt },
			});
			const warmupAttempt = this.touchFile(representativeFile, content, {
				diagnostics: "document",
				collectDiagnostics: false,
				clientScope: "primary",
				source: "lsp_sweep_warmup",
				maxClientWaitMs: timeoutMs,
				maxDiagnosticsWaitMs: timeoutMs,
				// #669: the caller's cap here is the warm-up budget for a genuinely
				// COLD server — it must act as a floor, not the usual ceiling, or
				// `perServerTimeout` silently shrinks it to the strategy's normal
				// warm-state `aggregateWaitMs` (e.g. 1000ms for typescript) instead
				// of the requested 20000ms.
				warmupOverride: true,
				// #799: only attempt 1 gets the cold-start floor — see the
				// `warmupAttempt` doc on `LSPTouchFileOptions`.
				warmupAttempt: attempt,
			});
			await (options.signal
				? Promise.race([
						withDeadline(warmupAttempt, {
							ms: timeoutMs,
							onTimeout: "undefined",
						}),
						new Promise<void>((resolve) => {
							if (options.signal!.aborted) {
								resolve();
								return;
							}
							options.signal!.addEventListener("abort", () => resolve(), {
								once: true,
							});
						}),
					])
				: withDeadline(warmupAttempt, {
						ms: timeoutMs,
						onTimeout: "undefined",
					}));
			const coldServerIds = stillColdServerIds();
			logLatency({
				type: "phase",
				phase: options.signal?.aborted
					? "lsp_sweep_warmup_aborted"
					: coldServerIds.length > 0
						? "lsp_sweep_warmup_failed"
						: "lsp_sweep_warmup_done",
				filePath: representativeFile,
				durationMs: Date.now() - startedAt,
				metadata: {
					serverIds: servers.map((s) => s.id),
					timeoutMs,
					attempt,
					coldServerIds,
				},
			});
		};

		await runWarmupTouch(1);
		let failedServerIds = stillColdServerIds();

		// One retry, and only when the first attempt actually left a server cold —
		// a short backoff first so a server mid-relaunch/index gets a breather
		// rather than an immediate second hammer.
		if (failedServerIds.length > 0 && !options.signal?.aborted) {
			const backoffMs = warmupRetryBackoffMs();
			if (backoffMs > 0) {
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, backoffMs);
					timer.unref?.();
					options.signal?.addEventListener("abort", () => resolve(), {
						once: true,
					});
				});
			}
			if (!options.signal?.aborted) {
				await runWarmupTouch(2);
				failedServerIds = stillColdServerIds();
			}
		}

		if (failedServerIds.length > 0) {
			// #799: record the negative cache so a LATER sweep this session
			// skips straight past re-paying this warm-up (initial + retry).
			// Cleared automatically the moment the server demonstrates
			// readiness through any path (`markDemonstratedReadyKey`).
			for (let i = 0; i < servers.length; i++) {
				const key = keys[i];
				if (key !== undefined && failedServerIds.includes(servers[i].id)) {
					this.state.demonstratedCold.add(key);
				}
			}
		}
		return { performedWarmup: true, failedServerIds };
	}

	/**
	 * Actively scan every LSP-supported source file under a project root.
	 * This is intentionally expensive and used only by explicit project-wide tools.
	 */
	async runWorkspaceDiagnostics(
		cwd: string,
		options: {
			maxFiles?: number;
			signal?: AbortSignal;
			onProgress?: (completed: number, total: number) => void;
			/** Called after a cold sweep warm-up successfully brings a server group
			 * online. The caller may use this to refresh host observability UI. */
			onServerReady?: () => void;
			/**
			 * Reserve per-file reconciliation order at scan admission time. The
			 * callback is never called at result-settlement time (#1198).
			 */
			nextWriteIndex?: () => number;
			/**
			 * Explicit file list (#461): skip the project walk entirely and route
			 * exactly these files through the sweep. Used by lens_diagnostics'
			 * `paths` scope restrictor so a wrapper (e.g. "git-staged files only")
			 * gets the full mode=full treatment without paying for a whole-project
			 * walk. Caller is responsible for resolving/deduping/filtering these
			 * (lens-diagnostics.ts already applies the ignore matcher the same way
			 * the walk does before calling in).
			 */
			files?: string[];
		} = {},
	): Promise<LSPWorkspaceDiagnosticResult[]> {
		// #1618: hold the shared sweep gate for this call's ENTIRE lifetime —
		// counter-based (not a boolean) so two overlapping `mode=full` calls each
		// release independently, and try/finally so a throw or an aborted sweep
		// still releases it (a leaked hold would permanently disable idle reset,
		// the inverse defect). While held, `clients/runtime-turn.ts`'s idle-reset
		// timer defers instead of destroying this service mid-sweep.
		const releaseSweepHold = acquireWorkspaceSweepHold();
		try {
			return await this.runWorkspaceDiagnosticsSwept(cwd, options);
		} finally {
			releaseSweepHold();
		}
	}

	private async runWorkspaceDiagnosticsSwept(
		cwd: string,
		options: {
			maxFiles?: number;
			signal?: AbortSignal;
			onProgress?: (completed: number, total: number) => void;
			onServerReady?: () => void;
			nextWriteIndex?: () => number;
			files?: string[];
		} = {},
	): Promise<LSPWorkspaceDiagnosticResult[]> {
		const startedAt = Date.now();
		const root = path.resolve(cwd);
		const { signal } = options;
		// #1783: second heartbeat for the drift backstop. The per-file touch
		// below already carries one, but a round that answers every file from
		// the #671 cache never calls touchFile at all — and that is precisely the
		// round whose stale answers the pi-codec witness recorded. Same rate
		// limit, same non-awaited contract.
		void this.sweepDocumentDrift().catch(() => {});
		// Cap the per-file LSP sweep: a Next.js-scale project can route thousands
		// of files through the language server at concurrency 8, and without a
		// caller cap that grinds for tens of minutes (#341). `maxFiles` lets
		// lens_diagnostics' `maxLspFiles` bound it; falls back to the env/default.
		const maxFiles =
			typeof options.maxFiles === "number" &&
			Number.isFinite(options.maxFiles) &&
			options.maxFiles > 0
				? Math.floor(options.maxFiles)
				: getMaxWorkspaceDiagnosticFiles();
		const files = options.files
			? options.files.slice(0, maxFiles)
			: await collectWorkspaceDiagnosticFiles(root, maxFiles, signal);
		// Per-file wall-clock: a language server that hangs during spawn/initialize
		// would otherwise park a worker on `touchFile` FOREVER (the per-edit
		// diagnostic wait is bounded, but client acquisition here is not) — the root
		// of an observed multi-hour hang. Budget each file so the worker always
		// returns to the loop (and its abort check). Env-tunable.
		const perFileMs = (() => {
			const raw = Number(process.env.PI_LENS_LSP_WORKSPACE_PER_FILE_MS);
			return Number.isFinite(raw) && raw > 0 ? raw : 15_000;
		})();
		const results: LSPWorkspaceDiagnosticResult[] = [];
		let completed = 0;
		let timedOutFiles = 0;
		let lastHeartbeat = Date.now();

		// #671: reuse the last CONFIRMED per-file result instead of re-touching
		// every file through the language server(s) again when nothing relevant
		// changed since the last sweep. `createWorkspaceDiagnosticsCacheContext`
		// (`workspace-diagnostics-cache.ts`) is shared with `tools/lsp-
		// diagnostics.ts`'s batch/directory sweep so a file swept by either tool
		// benefits the other's next sweep under the SAME `scopeKey` — see that
		// module's doc comment for the invalidation rules (own-mtime +
		// best-effort cross-file dependency staleness) and why `scopeKey` exists
		// (this sweep's `excludeServerIds` differs from that tool's).
		const workspaceDiagnosticsCacheCtx =
			createWorkspaceDiagnosticsCacheContext(root);
		const workspaceSweepScopeKey = buildScopeKey("all", [
			...WORKSPACE_SWEEP_EXCLUDED_SERVER_IDS,
		]);
		const cachedResults: LSPWorkspaceDiagnosticResult[] = [];
		const filesToTouch: string[] = [];
		const writeIndexByPath = new Map<string, number | undefined>();
		for (const filePath of files) {
			// Reserve order before cache lookup/touch admission. A result that settles
			// later is still ordered by when this scan began observing the file (#1198).
			writeIndexByPath.set(
				normalizeMapKey(filePath),
				options.nextWriteIndex?.(),
			);
			const cached = workspaceDiagnosticsCacheCtx.lookup(
				filePath,
				workspaceSweepScopeKey,
			);
			// #1095 (P2-1 bug-class sweep): both sweeps share cache entries under the
			// same scopeKey, so this service sweep must apply the SAME content-binding
			// gate the tools/lsp-diagnostics.ts sibling site does — an entry whose
			// recorded fingerprint no longer matches disk (bytes changed WITHOUT an
			// mtime bump the freshness check would catch, exactly what contentHash
			// exists to detect) must NOT be replayed and reconciled as confirmed via
			// mode=full. On a mismatch, fall through to a fresh touch.
			if (cached && cached.binding.boundToCurrentDisk !== false) {
				cachedResults.push({
					filePath,
					diagnostics: cached.diagnostics,
					count: cached.count,
					// #1093: a cache hit replays an older observation — carry its
					// scan time so mode=full's footer reconcile stamps `touchedAt`
					// with when the truth was seen, not now().
					observedAt: cached.scannedAt,
					contentHash: cached.binding.contentHash,
					boundToCurrentDisk: cached.binding.boundToCurrentDisk,
					writeIndex: writeIndexByPath.get(normalizeMapKey(filePath)),
				});
			} else {
				filesToTouch.push(filePath);
			}
		}
		completed = cachedResults.length;
		if (cachedResults.length > 0) {
			options.onProgress?.(completed, files.length);
		}
		// #1782: which files this sweep is REPLAYING from cache, and which of those
		// a workspace pull then explicitly re-answered clean. A project-wide pull
		// report names files far beyond the group that asked for it; an explicit
		// zero-diagnostic answer for a replayed file is authoritative and must
		// supersede the replay, in the sweep's result list AND on disk. Without
		// this, a server that re-checked a file and found it clean could not
		// dislodge the stale entry by any means available to a user — the
		// 2026-08-20 dogfood's 23:07 record.
		const cacheServedKeys = new Set(
			cachedResults.map((result) => normalizeMapKey(result.filePath)),
		);
		const supersededCacheKeys = new Set<string>();
		// Per-file scan mtime captured as each file completes below, so a
		// confirmed fresh result can be written back into the cache with the
		// mtime it was ACTUALLY scanned at (not re-stat'd after the fact, which
		// could race a concurrent edit).
		const scannedMtimeByFile = new Map<string, number>();
		// #2300: size from the SAME stat call as the mtime above — zero extra
		// syscalls — so the cache write below can give `isEntryFresh` a size
		// axis alongside the mtime.
		const scannedSizeByFile = new Map<string, number>();

		// Group files by their primary language server (#387, extracted as
		// `groupFilesByPrimaryServer` for #631). tsserver — and most servers — is
		// single-threaded per project: N concurrent touches to ONE server don't
		// parallelize, they queue. That inflates the working set (each didOpen can
		// force a project recheck) and cascades per-file-budget timeouts by queue
		// position (observed: 51/123 files "timed out" purely from being behind
		// others in an 8-wide flat pool). So serialize WITHIN a server (one
		// in-flight touch each) and parallelize ACROSS servers — real parallelism
		// where it exists (a mixed TS+Python repo runs both), no flooding where it
		// doesn't. Capped so a many-language monorepo can't spawn unbounded groups.
		// Only files that failed the cache-freshness check above go through this
		// (and the touch loop below) at all.
		const groups = groupFilesByPrimaryServer(filesToTouch);
		// #645: shared across every file/group in THIS sweep — lets a
		// `workspaceIndexing`-strategy server (marksman) pay its full
		// aggregateWaitMs budget only for the first file that touches it,
		// instead of every markdown file independently racing the same cold
		// workspace-index build. Scoped to this one call (never stored on the
		// service), so it can't leak into a later sweep or a per-edit touch.
		const sweepIndexGate = createSweepIndexGate();
		// Opt-in project-wide pull: one `workspace/diagnostic` per server instead of
		// N per-file opens (#387 Item 2). Gated off by default — a cold server can
		// answer with an empty/partial report that reads as a false "all clean", and
		// the pull covers only the primary server (files with auxiliary scanners
		// would lose those). Enabled per group only when the server advertises it and
		// no file in the group has an auxiliary; any miss falls back to per-file.
		const workspacePullEnabled = process.env.PI_LENS_LSP_WORKSPACE_PULL === "1";

		// Start marker: without this a hang leaves no trace that the sweep even
		// began (the completion log below never fires). Per-file `lsp_touch_file`
		// phases + these heartbeats let a hang be bracketed to a file/time.
		logLatency({
			type: "phase",
			phase: "lsp_workspace_diagnostics_start",
			filePath: root,
			durationMs: 0,
			metadata: {
				fileCount: files.length,
				cacheHits: cachedResults.length,
				filesToTouch: filesToTouch.length,
				maxFiles,
				perFileMs,
				serverGroups: groups.length,
			},
		});

		// #608: pre-open every swept file's document, across whichever server(s)
		// it belongs to, in ONE fast pass BEFORE a group's serial per-file
		// diagnostics-wait loop starts (see the per-group worker below).
		// `handleNotifyOpen`'s workspace/didChangeWatchedFiles enqueue (#271)
		// only coalesces opens that land within its 100ms debounce window
		// (`WatchedFilesQueue`, watch-queue.ts) — it arms the flush timer on
		// the FIRST enqueue and just accumulates on every call after that
		// until the timer fires. The per-file loop waits up to several
		// seconds per file for diagnostics before moving to the next one, so
		// consecutive first-opens during a sweep land far outside that 100ms
		// window: every previously-unopened file used to fire its OWN
		// project-wide recheck notification instead of one for the whole
		// sweep, and later files timed out purely from queueing behind those
		// rechecks (#608). Firing every file's open notification here,
		// back-to-back with no diagnostics wait between them, keeps them
		// inside the debounce window so `WatchedFilesQueue` coalesces them
		// into (at most a small handful of) flushes per server the same way
		// a per-edit dispatch burst already does. By the time `processFile`
		// below calls `touchFile`, each document is already in
		// `openDocuments`, so `handleNotifyOpen` takes the cheap already-open
		// `didChange` branch and enqueues nothing further. Content read here
		// is cached so `processFile` doesn't re-read the same file from disk.
		//
		// Only used on the per-file fallback path — a group whose
		// `workspace/diagnostic` pull (#387 Item 2) succeeds never opens
		// per-file documents at all, so pre-opening ahead of a pull attempt
		// would be pure waste (and would break that path's "no per-file
		// opens" guarantee). Called from inside each group's own serial loop
		// (below), so it inherits the SAME #387 shape: one in-flight open at
		// a time per server, parallel across distinct servers via the
		// existing group-worker pool.
		const contentCache = new Map<string, string>();
		const preOpenGroupFiles = async (
			groupFiles: readonly string[],
		): Promise<void> => {
			if (isWarmAttached()) return;
			for (const filePath of groupFiles) {
				if (signal?.aborted) return;
				let content: string;
				try {
					content = await nodeFs.promises.readFile(filePath, "utf-8");
				} catch {
					continue; // processFile's own read will surface the real error.
				}
				contentCache.set(filePath, content);
				const languageId = getLanguageId(filePath) ?? "plaintext";
				// #615: this pre-open pass had NO bound at all — unlike every other
				// per-file step in this sweep (`processFile`'s `touchFile` call
				// below is `withDeadline`-wrapped). `getClientsForFile` can wait on
				// a server spawn/initialize handshake, and `notify.open` can wait
				// on a stuck notification write; either hanging left the WHOLE
				// sweep stuck with no heartbeat and no escape (a real dogfooding
				// incident: `lsp_workspace_diagnostics_start` logged, then total
				// silence — and pressing Escape didn't help either, since the
				// per-iteration `signal?.aborted` check above never gets a turn
				// while stuck inside a single file's await). Two bounds, not one:
				// `withDeadline` catches a hang with no abort press at all; racing
				// the abort signal directly means an explicit Escape unblocks
				// immediately too, instead of waiting out the rest of `perFileMs`.
				// `onTimeout:"undefined"` mirrors the existing catch-based "best
				// effort" intent below: a timed-out/aborted pre-open just means
				// `processFile`'s own touchFile call pays for the open instead,
				// exactly like a thrown error already did.
				const preOpenAttempt = withDeadline(
					(async () => {
						const { clients } = await this.getClientsForFile(
							filePath,
							WORKSPACE_SWEEP_EXCLUDED_SERVER_IDS,
						);
						for (const entry of clients) {
							// #1714: this pass is the sweep's SECOND source of `didOpen`
							// volume, and it reaches the server without passing the drain
							// barrier. Charge it to the same backlog ledger, and leave a
							// scanner that is already at its ceiling out of the burst.
							let auxKey: string | undefined;
							if (entry.info.role === "auxiliary") {
								auxKey = await this.demonstratedReadyKeyFor(
									entry.info,
									filePath,
								);
								if (auxKey && this.auxNotifyBacklogAtCeiling(auxKey, entry)) {
									continue;
								}
							}
							try {
								await entry.client.notify.open(filePath, content, languageId);
								if (auxKey) this.noteAuxNotifyIssued(auxKey, entry.client);
								// #1783: deliberately NOT recorded for the drift backstop.
								// This pass can skip a scanner at its backlog ceiling, so its
								// coverage is partial by design, and `processFile` runs
								// `touchFile` over every file in the group immediately after
								// — that call records with a full-coverage check. Stamping
								// here would only claim a coverage this loop does not have.
							} catch {
								// Best-effort: a failed pre-open just means processFile's own
								// touchFile call below pays for the open instead.
							}
						}
					})(),
					{ ms: perFileMs, onTimeout: "undefined" },
				);
				await (signal
					? Promise.race([
							preOpenAttempt,
							new Promise<void>((resolve) => {
								if (signal.aborted) {
									resolve();
									return;
								}
								signal.addEventListener("abort", () => resolve(), {
									once: true,
								});
							}),
						])
					: preOpenAttempt);
			}
		};

		// #1618: a service destroyed mid-sweep (idle-reset race, an explicit
		// `resetLSPService` call, session replacement, …) must stop the loop for
		// every file it has not yet reached and record WHY — never a bare
		// `timedOut` that reads identically to a budget timeout. Cheap: no
		// language-server round trip, just a results push.
		const markServiceDestroyed = (remainingFiles: readonly string[]): void => {
			for (const filePath of remainingFiles) {
				results.push({
					filePath,
					diagnostics: [],
					count: 0,
					timedOut: true,
					unconfirmedReason: "service_destroyed",
					writeIndex: writeIndexByPath.get(normalizeMapKey(filePath)),
				});
				timedOutFiles += 1;
				completed += 1;
			}
			options.onProgress?.(completed, files.length);
		};

		const processFile = async (filePath: string): Promise<void> => {
			try {
				const content =
					contentCache.get(filePath) ??
					(await nodeFs.promises.readFile(filePath, "utf-8"));
				// #671: captured alongside the read, ahead of the (possibly slow)
				// touchFile wait below, so the cache entry records the mtime this
				// file actually had AT scan time — not a later re-stat that could
				// race a concurrent edit and silently mis-date the entry. Deliberately
				// synchronous (not `nodeFs.promises.stat`): this loop is timing-
				// sensitive (its opens must land inside `WatchedFilesQueue`'s 100ms
				// debounce window — see workspace-diagnostics-sweep-batch-open.test.ts
				// / -preopen-chunk.test.ts), and a blocking `statSync` costs a few
				// microseconds with no extra event-loop tick, where an awaited
				// promise would insert one.
				try {
					const scanStat = nodeFs.statSync(filePath);
					scannedMtimeByFile.set(filePath, scanStat.mtimeMs);
					scannedSizeByFile.set(filePath, scanStat.size);
				} catch {
					// Best-effort: a failed stat here just means this file won't be
					// eligible for caching below (no entry gets written for it).
				}
				// onTimeout:"undefined" so a hung file yields no diagnostics and the
				// worker moves on; a real touchFile rejection still propagates to the
				// catch below and is recorded as an error.
				const attached = isWarmAttached()
					? await tryWarmAttachedDiagnostics(
							filePath,
							content,
							perFileMs,
							"sweep",
						)
					: undefined;
				if (attached && !attached.available) {
					await this.ensureWarmForSweep(filePath, { signal });
				}
				// #1179 (shape-5 structural fix): normalize both sources into the
				// `TouchFileResult` wrapper shape so the flag reads below come off
				// EXPLICIT fields, not a non-enumerable side-channel a copy would drop.
				// The warm-attach IPC branch resolves a plain diagnostics array with
				// `inconclusive` re-surfaced as an enumerable DTO field (the socket can
				// carry no binding, and the IPC client already rejects an inconclusive
				// answer, so `available` implies confirmed) — wrap it as `{ diags }`;
				// the incumbent branch already returns the wrapper.
				const touchResult = attached?.available
					? {
							diags: attached.response.diagnostics,
							// #1470: the incumbent's coverage gap crosses the socket as an
							// explicit DTO field, so carry it onto the wrapper the sweep
							// reads. Dropping it here would let a partially covered
							// incumbent answer be persisted as a confirmed sweep result —
							// the same false clean this change closes on the local route.
							...(attached.response.unconfirmedServerIds !== undefined && {
								unconfirmedServerIds: attached.response.unconfirmedServerIds,
							}),
						}
					: await withDeadline(
							this.touchFile(filePath, content, {
								diagnostics: "document",
								collectDiagnostics: true,
								clientScope: "all",
								source: "lens_diagnostics_full",
								// #584: opengrep's findings for a full sweep come from the
								// `opengrep-client.ts` CLI extractor (one project-wide scan,
								// cached, read via extractors.ts) instead — see the
								// `excludeServerIds` doc on `LSPTouchFileOptions`.
								excludeServerIds: WORKSPACE_SWEEP_EXCLUDED_SERVER_IDS,
								// #645: lets a workspaceIndexing server (marksman) pay its
								// full wait budget only once across this whole sweep.
								sweepIndexGate,
							}),
							{ ms: perFileMs, onTimeout: "undefined" },
						);
				const diagnostics = touchResult?.diags;
				// #571: prefer #570's real per-touch inconclusive signal
				// (`touchFile`'s `.inconclusive` flag — set when the notify write or the
				// diagnostics wait itself timed out) over this sweep's own OUTER
				// `perFileMs` deadline, which only catches a touch that never returned at
				// all within budget. Either one means the result wasn't confirmed.
				const inconclusive = touchResult?.inconclusive === true;
				// #1470/#1493: an auxiliary that never reported — cut off by the grace
				// timer, or silent with nothing published for this content — is the
				// THIRD reason this result is not a confirmed observation, and it is
				// deliberately not `inconclusive`. The
				// record loop below persists every `!timedOut` result into the workspace
				// cache, so reading `inconclusive` alone caches a partially covered
				// answer as clean and replays it on every later sweep. The warm-attach
				// incumbent reaches this branch through the aux GRACE wait (its touch
				// runs `clientScope: "with-auxiliary"`), where all three no-answer shapes
				// arise. #1459 added the two pre-wait doors for the sweep's own local
				// `clientScope: "all"` touch — a scanner whose breaker was open, or whose
				// resync the fan-out gate deferred. #1533 closed the last hole: `"all"`
				// still never enters the grace wait, but it now derives the SAME evidence
				// from post-wait state, so a silent auxiliary narrows this scope too
				// instead of aggregating as a confirmed clean. Every route is gated here.
				const unconfirmedServerIds = touchCoverageGap(touchResult);
				const coverageGap = unconfirmedServerIds.length > 0;
				// #2052: the touch DECLINED this file — it is outside every
				// initialized session cwd, so nothing was asked and `diags` is an
				// empty placeholder, not an observation. Before this, the sweep
				// never read `skipReason`, so a declined foreign file fell through
				// as `timedOut: false` with zero diagnostics: reported CONFIRMED
				// CLEAN, and then written into the workspace cache by the record
				// loop below, which replays that false clean on every later sweep.
				const declinedOutsideRoot =
					touchResult?.skipReason === "outside-project-root";
				// #1549: the sweep verdict is per answering lane. An auxiliary gap
				// narrows coverage, but a primary answer remains usable; only absence of
				// the touch result or a primary-scoped inconclusive verdict poisons it.
				const timedOut =
					touchResult === undefined || inconclusive || declinedOutsideRoot;
				if (timedOut) timedOutFiles += 1;
				// #1618: WHY, in priority order — the outer deadline (nothing came
				// back at all) outranks an inner inconclusive signal, which outranks
				// a narrower auxiliary coverage gap.
				// #2052: `outside_project_root` is checked FIRST among the reasons a
				// touch produced no observation. A declined file cannot be
				// `inconclusive` (nothing was asked, so nothing timed out), and
				// rendering it as "didn't complete within budget" would tell the
				// reader to retry a request that will always be refused.
				const unconfirmedReason: LSPWorkspaceUnconfirmedReason | undefined =
					touchResult === undefined
						? "budget"
						: declinedOutsideRoot
							? "outside_project_root"
							: inconclusive
								? "inconclusive"
								: undefined;
				// #1104 (shape 5 — AGENTS.md): the touch's content binding is an
				// EXPLICIT enumerable field on the wrapper now (#1179), so it survives
				// `applyAuxiliarySuppressions` below rebuilding `.diags` via `.filter()`
				// — read it off `touchResult`, not off the derived array. A version-
				// less/pull-less server composed no binding, so `contentHash` stays
				// undefined here (honest "unknown" downstream), matching prior behavior.
				const rawBinding = touchResult?.binding;
				// #586: honor each auxiliary profile's native inline-suppression
				// comment (e.g. opengrep's `// nosemgrep`, #441) — computed from the
				// raw `diagnostics` (before this drops its non-enumerable
				// `.inconclusive` flag, already read above) so a `lens_diagnostics
				// mode=full` sweep suppresses the same findings the per-edit dispatch
				// runner does, instead of only the latter honoring it.
				// #692: also honor a profile's `skipTestFiles` gate (e.g. ast-grep,
				// #687/#688) — those PRs added the gate only to the per-edit merge
				// loop (`clients/dispatch/runners/lsp.ts`), so a `mode=full` sweep
				// re-surfaced every ast-grep finding on `*.test.ts` files wholesale,
				// duplicating what the per-edit path already suppresses. `content`
				// was already read above for this file, so `detectFileRole` gets the
				// higher-accuracy content-aware classification at no extra cost.
				const filteredDiagnostics = diagnostics
					? applyAuxiliarySuppressions(diagnostics, content, {
							fileRole: detectFileRole(filePath, content),
						})
					: diagnostics;
				results.push({
					filePath,
					diagnostics: filteredDiagnostics ?? [],
					count: filteredDiagnostics?.length ?? 0,
					...(timedOut && { timedOut: true, unconfirmedReason }),
					...(coverageGap && {
						unconfirmedServerIds: [...unconfirmedServerIds],
					}),
					contentHash: rawBinding?.contentHash,
					boundToCurrentDisk: rawBinding?.boundToCurrentDisk,
					writeIndex: writeIndexByPath.get(normalizeMapKey(filePath)),
				});
			} catch (err) {
				results.push({
					filePath,
					diagnostics: [],
					count: 0,
					error: err instanceof Error ? err.message : String(err),
					// An errored check is exactly as inconclusive as a timed-out one —
					// no confirmed result was obtained, so reconciliation (#571) must
					// skip it the same way. #1618: distinct from every OTHER
					// `timedOut: true` reason — an `error` must never render as "didn't
					// complete within budget" (the old dead-subtraction bug in
					// tools/lens-diagnostics.ts's `unconfirmedErrored` computation).
					timedOut: true,
					unconfirmedReason: "error",
					writeIndex: writeIndexByPath.get(normalizeMapKey(filePath)),
				});
			}
			completed += 1;
			// User-facing progress (streamed to the tool's onUpdate). Per-file so the
			// bar moves; the tool throttles the actual UI writes.
			options.onProgress?.(completed, files.length);
			// Time-based heartbeat (every ~10s): a hang shows the last heartbeat
			// then silence, so latency.log pinpoints how far it got.
			if (Date.now() - lastHeartbeat >= 10_000) {
				lastHeartbeat = Date.now();
				logLatency({
					type: "phase",
					phase: "lsp_workspace_diagnostics_progress",
					filePath: root,
					durationMs: Date.now() - startedAt,
					metadata: {
						completed,
						total: files.length,
						timedOutFiles,
						aborted: signal?.aborted ?? false,
					},
				});
			}
		};

		// One worker per server group (serial within a server), up to the
		// concurrency cap across distinct servers — `runPerServerGroups` (#631)
		// is the same primitive `tools/lsp-diagnostics.ts`'s batch/directory scan
		// now uses for its own file list.
		const groupWorkers = Math.min(
			WORKSPACE_DIAGNOSTICS_CONCURRENCY,
			groups.length,
		);
		// #1723 residual, named as a deferred gap on PR #1805 and closed here:
		// the SCAN-side twin of the runner chokepoint #1805 wired in
		// `dispatcher.ts`'s `runRunner`. This sweep is the site whose COMPLETION
		// (`lsp_workspace_diagnostics`) is the `lastPhase` on #1723's own
		// 18 270 ms reproduction, so until this bracket existed the record could
		// only ever name the phase that finished BEFORE the block, never the one
		// burning the time during it.
		//
		// ONE bracket for the whole fan-out, not one per file (#2272 review F1).
		// Per-file bracketing was the first shape and it was inert for exactly
		// the case above: `phaseFinished` pushes onto a ring capped at
		// `CLOSED_BRACKET_CAP` (5, clients/latency-logger.ts), while `turn_end`
		// reads `getPhaseForWindow` AFTER the sweep returns. A 225-file sweep
		// therefore evicted the blocking file's own bracket unless the block
		// landed in the last five files, and the survivors were then rejected by
		// `MIN_PLAUSIBLE_ELAPSED_FRACTION` for being far shorter than the block
		// window. The phase string is a constant carrying no per-file identity,
		// so 225 brackets never held more information than one — they only cost
		// 225 map inserts and destroyed the ring. One bracket keeps the same
		// discriminating identity, survives to the read point, and spans the
		// block by construction.
		//
		// Paired in `finally`, per `phaseFinished`'s contract: an abandoned
		// bracket would misattribute every LATER loop_block to this sweep. The
		// leak guard is what the tests pin: emptying this `finally` reds three
		// of them. `finally` rather than a trailing call covers a throw that
		// escapes the fan-out; abort and service-destroyed both RETURN from the
		// worker callback rather than throwing, so those two paths alone would
		// not distinguish the two spellings.
		const sweepPhase = phaseStarted("lsp_workspace_diagnostics_touch");
		try {
			await runPerServerGroups(
				groups,
				groupWorkers,
				async (group) => {
					if (signal?.aborted) return;
					// #1618: checked before any per-group work (pull attempt, warm-up,
					// per-file loop) so a service already destroyed when this group
					// starts never pays for a language-server round trip it cannot get.
					if (this.checkDestroyed()) {
						markServiceDestroyed(group.files);
						return;
					}
					// Fast path: one project-wide pull for the whole group (opt-in).
					if (!isWarmAttached() && workspacePullEnabled && !group.multiServer) {
						const pulled = await this.tryWorkspacePull(
							group.files,
							perFileMs,
							cacheServedKeys,
						);
						if (pulled) {
							// #1782: an explicit zero-diagnostic answer for a file this
							// sweep served from cache SUPERSEDES that cached replay. Route
							// it through the same result list every other answer uses, so
							// the cache write below overwrites the stale entry and the
							// footer reconcile in `tools/lens-diagnostics.ts` clears the
							// widget rows — no second eviction path to keep in step.
							for (const clean of pulled.extraClean) {
								supersededCacheKeys.add(normalizeMapKey(clean.filePath));
							}
							for (const result of [...pulled.results, ...pulled.extraClean]) {
								results.push({
									...result,
									writeIndex: writeIndexByPath.get(
										normalizeMapKey(result.filePath),
									),
								});
								// #671: a pull result is always confirmed (see
								// `tryWorkspacePull`'s doc comment), so it's cache-eligible
								// too — best-effort stat since the pull already resolved the
								// diagnostics for this file some time ago.
								try {
									const pullStat = nodeFs.statSync(result.filePath);
									scannedMtimeByFile.set(result.filePath, pullStat.mtimeMs);
									scannedSizeByFile.set(result.filePath, pullStat.size);
								} catch {
									// Not cache-eligible without a confirmed mtime.
								}
							}
							completed += group.files.length;
							options.onProgress?.(completed, files.length);
							return;
						}
					}
					// #667: warm-check before this group's own per-file loop starts —
					// cheap/no-op when the group's primary server already demonstrated
					// readiness (from an earlier sweep, or an earlier group sharing the
					// same server root, this session); pays one deliberate warm-up round
					// trip against the group's first file only when genuinely cold. Not
					// needed above the pull fast path: a `workspace/diagnostic` pull
					// already covers the WHOLE group with its own generous per-server
					// budget in one shot — the per-file "first N files eat individual
					// timeouts" failure mode this fixes doesn't apply there.
					const first = group.files[0];
					if (first && !isWarmAttached()) {
						const warmup = await this.ensureWarmForSweep(first, { signal });
						if (signal?.aborted) return;
						// #744: the group's primary server failed warm-up (initial round
						// trip + one retry both left it cold). Every per-file touch to it
						// would re-pay its full timeout and time out again, dragging the
						// whole sweep — the exact wedged-marksman failure mode this closes.
						// So skip this group's files and record each as UNCONFIRMED
						// (timedOut + skippedWarmupFailure), never as confirmed-clean `[]`:
						// the group is keyed by its primary server, so a non-empty
						// `failedServerIds` means that primary is the one that couldn't warm.
						if (warmup.failedServerIds.length > 0) {
							logLatency({
								type: "phase",
								phase: "lsp_sweep_group_skipped_warmup",
								filePath: first,
								durationMs: 0,
								metadata: {
									failedServerIds: warmup.failedServerIds,
									// #799: distinguishes a fresh warm-up failure from a
									// negative-cache hit (this sweep never re-attempted warm-up
									// at all — it was already known cold from earlier this
									// session).
									skippedFromCache: warmup.skippedFromCache ?? false,
									skippedFiles: group.files.length,
								},
							});
							for (const filePath of group.files) {
								results.push({
									filePath,
									diagnostics: [],
									count: 0,
									timedOut: true,
									unconfirmedReason: "inconclusive",
									skippedWarmupFailure: true,
								});
								timedOutFiles += 1;
								completed += 1;
							}
							options.onProgress?.(completed, files.length);
							return;
						}
						if (warmup.performedWarmup) options.onServerReady?.();
					}
					// #608/#621: batch-open a CHUNK of this group's files before
					// waiting on diagnostics for any of them individually — see
					// `preOpenGroupFiles` above. Chunking (rather than the whole
					// group at once) bounds how much a single burst can dump on
					// the server's request queue at real project scale, while each
					// chunk's opens still land inside the debounce window and
					// coalesce into one flush — see `WORKSPACE_SWEEP_PREOPEN_CHUNK_SIZE`.
					for (
						let chunkStart = 0;
						chunkStart < group.files.length;
						chunkStart += WORKSPACE_SWEEP_PREOPEN_CHUNK_SIZE
					) {
						if (signal?.aborted) return;
						// #1618: a service destroyed WHILE this group's chunk loop was
						// already running (the group-start check above can't see a
						// destruction that lands mid-loop) — stop here and mark every
						// file from this chunk onward, rather than letting the remaining
						// chunks pay for pre-opens/touches against a torn-down service.
						if (this.checkDestroyed()) {
							markServiceDestroyed(group.files.slice(chunkStart));
							return;
						}
						const chunk = group.files.slice(
							chunkStart,
							chunkStart + WORKSPACE_SWEEP_PREOPEN_CHUNK_SIZE,
						);
						await preOpenGroupFiles(chunk);
						for (const filePath of chunk) {
							// Honor cancellation between files (#341); already-collected
							// results are returned as a partial.
							if (signal?.aborted) return;
							if (this.checkDestroyed()) {
								markServiceDestroyed(
									group.files.slice(group.files.indexOf(filePath)),
								);
								return;
							}
							await processFile(filePath);
						}
					}
				},
				signal,
			);
		} finally {
			phaseFinished(sweepPhase);
		}

		// #1618: per-reason tally alongside the flat `timedOutFiles` count (kept
		// for the existing `scripts/analyze-pi-lens-logs.mjs` consumer) — a
		// dashboard reading only the flat count can no longer mistake 81
		// service-destroyed files for 81 budget-exhausted ones.
		const unconfirmedByReason: Partial<
			Record<LSPWorkspaceUnconfirmedReason, number>
		> = {};
		for (const result of results) {
			if (!result.timedOut) continue;
			const reason = result.unconfirmedReason ?? "budget";
			unconfirmedByReason[reason] = (unconfirmedByReason[reason] ?? 0) + 1;
		}
		const partiallyCoveredFiles = results.filter(
			(result) => (result.unconfirmedServerIds?.length ?? 0) > 0,
		).length;
		// Code-unit comparator (#1883): this list ships as the
		// `unconfirmedServerIds` field on the `lsp_workspace_diagnostics` record,
		// so its order must be deterministic across locales — localeCompare is
		// deliberately avoided.
		const unconfirmedServerIds = [
			...new Set(
				results.flatMap((result) => result.unconfirmedServerIds ?? []),
			),
		].sort((a, b) => Number(a > b) - Number(a < b));
		logLatency({
			type: "phase",
			phase: "lsp_workspace_diagnostics",
			filePath: root,
			durationMs: Date.now() - startedAt,
			metadata: {
				filesChecked: files.length,
				cacheHits: cachedResults.length,
				diagnosticCount: results.reduce(
					(sum, result) => sum + (result?.count ?? 0),
					0,
				),
				serverGroups: groups.length,
				concurrency: groupWorkers,
				maxFiles,
				timedOutFiles,
				unconfirmedByReason,
				partiallyCoveredFiles,
				...(unconfirmedServerIds.length > 0 && { unconfirmedServerIds }),
				aborted: signal?.aborted ?? false,
			},
		});

		// #671: record every CONFIRMED fresh result (`!timedOut && !error`) back
		// into the cache, keyed by the mtime it was actually scanned at
		// (`scannedMtimeByFile`, captured per-file above), then persist once.
		// Deliberately survives an aborted/partial sweep — whatever completed
		// before the abort is still real, confirmed work and shouldn't be thrown
		// away; files that never got a confirmed result (including ones an abort
		// cut off before `processFile` ran) are simply absent from
		// `scannedMtimeByFile` and are skipped, leaving any pre-existing cache
		// entry for them exactly as `createWorkspaceDiagnosticsCacheContext`
		// loaded it (already-stale entries stay unreachable via `lookup`'s own
		// freshness check; nothing here needs to explicitly evict them).
		for (const result of results) {
			const scannedAt = scannedMtimeByFile.get(result.filePath);
			if (
				result.error ||
				result.timedOut ||
				(result.unconfirmedServerIds?.length ?? 0) > 0 ||
				scannedAt === undefined
			) {
				continue;
			}
			// #1104: thread the per-result `contentHash` (from either the
			// `tryWorkspacePull` fast path or a per-file touch's own #1095 binding)
			// into the cache entry — previously this call never passed one, so
			// every pull-served entry read binding "unknown" forever and the #1095
			// P2-1 service-sweep binding gate above (`cached.binding.
			// boundToCurrentDisk !== false`) could never demote a pull-cached
			// entry. Absent `contentHash` (no binding was available) behaves
			// exactly as before.
			workspaceDiagnosticsCacheCtx.record(
				result.filePath,
				workspaceSweepScopeKey,
				result.diagnostics,
				scannedAt,
				result.contentHash,
				scannedSizeByFile.get(result.filePath),
			);
		}
		workspaceDiagnosticsCacheCtx.persist();

		// #1782: drop every cached replay a pull answered clean — returning both
		// would hand the footer reconcile two contradictory results for one file,
		// and the stale one could win on ordering.
		const servedCacheResults =
			supersededCacheKeys.size === 0
				? cachedResults
				: cachedResults.filter(
						(result) =>
							!supersededCacheKeys.has(normalizeMapKey(result.filePath)),
					);
		return [...servedCacheResults, ...results].filter(Boolean);
	}

	/**
	 * #387 Item 2: one `workspace/diagnostic` pull covering a whole server group,
	 * instead of N per-file opens. Returns per-file results (files absent from the
	 * report are reported clean), or `undefined` when the server doesn't advertise
	 * workspace pull / the pull fails — the caller then falls back to per-file.
	 *
	 * #1782: the report is project-wide, so it routinely names files this group
	 * never asked about — including files this sweep already served from the
	 * cache. Those answers used to be dropped on the floor: the mapping below
	 * only ever looked up `groupFiles`. That is how a server can explicitly
	 * re-answer a file with ZERO diagnostics while the cache and the widget keep
	 * rendering its stale blockers, which is what the 2026-08-20 dogfood recorded
	 * at 23:07. `reanswerFor` opts a caller into those extra answers: pass the
	 * normalized keys of files served from cache, and any of them the report
	 * explicitly names with zero diagnostics comes back in `extraClean` as a
	 * confirmed clean result.
	 *
	 * Only an EXPLICIT zero-diagnostic entry qualifies. Absence from the report
	 * reads as clean for `groupFiles`, which this sweep did ask about, but it is
	 * genuinely UNKNOWN for a file nobody asked about — a server may report only
	 * what it re-checked.
	 */
	private async tryWorkspacePull(
		groupFiles: string[],
		perFileMs: number,
		reanswerFor?: ReadonlySet<string>,
	): Promise<
		| {
				results: LSPWorkspaceDiagnosticResult[];
				extraClean: LSPWorkspaceDiagnosticResult[];
		  }
		| undefined
	> {
		try {
			const first = groupFiles[0];
			if (!first) return undefined;
			const spawned = await this.getClientForFile(first, perFileMs);
			if (!spawned) return undefined;
			if (
				!spawned.client.getWorkspaceDiagnosticsSupport().workspaceDiagnostics
			) {
				return undefined;
			}
			const report = await spawned.client.requestWorkspaceDiagnostics(
				Math.max(perFileMs, workspacePullBudgetMs()),
			);
			if (!report) return undefined;
			// Last-wins per file: the report builder does not dedup, so a server
			// naming the same URI twice appears twice in `report` (#1786 review F2).
			const byPath = new Map<
				string,
				{
					filePath: string;
					diagnostics: import("./client.js").LSPDiagnostic[];
					contentHash?: string;
				}
			>();
			for (const entry of report) {
				byPath.set(normalizeMapKey(entry.filePath), entry);
			}
			const results = groupFiles.map((filePath) => {
				const entry = byPath.get(normalizeMapKey(filePath));
				const diagnostics = entry?.diagnostics ?? [];
				// A pull that got here returned a real workspace/diagnostic report
				// (see the `!report` guard above) — always confirmed, unlike a
				// per-file touchFile default-empty on timeout.
				// #1104: `contentHash` comes straight from the client's pull layer —
				// a file absent from the report (reported "clean" here) carries none,
				// same honest "unknown" the record site already applies for it.
				return {
					filePath,
					diagnostics,
					count: diagnostics.length,
					timedOut: false,
					contentHash: entry?.contentHash,
				};
			});
			// #1782: harvest explicit clean answers for files this group never asked
			// about but the caller is serving from cache. Same confirmed status as
			// the mapping above — it is the same report.
			//
			// #1786 review F2: iterate `byPath`, not `report`. The report BUILDER
			// (`clients/lsp/client.ts`'s `requestWorkspaceDiagnostics`) pushes one
			// output entry per report item with no dedup, so a server that names the
			// same URI twice yields two entries for one file. Walking the raw list
			// would emit two results for one file — breaking the caller's
			// one-result-per-file invariant — and would let a zero-diagnostic
			// duplicate evict a cached blocker that the SAME report also reports as
			// still failing. `byPath` is last-wins and unique per file, and
			// `withFindings` refuses eviction whenever ANY entry for that file
			// reports findings, whatever the order. Refusing costs a stale entry one
			// more sweep; evicting on a contradicted answer discards a live blocker.
			const extraClean: LSPWorkspaceDiagnosticResult[] = [];
			if (reanswerFor && reanswerFor.size > 0) {
				const asked = new Set(groupFiles.map((f) => normalizeMapKey(f)));
				const withFindings = new Set<string>();
				for (const entry of report) {
					if (entry.diagnostics.length > 0) {
						withFindings.add(normalizeMapKey(entry.filePath));
					}
				}
				for (const [key, entry] of byPath) {
					// The membership filter is load-bearing: a report names files far
					// beyond this sweep, and a file nobody asked about and nothing is
					// replaying has no business entering the sweep's results.
					if (asked.has(key) || !reanswerFor.has(key)) continue;
					if (entry.diagnostics.length > 0 || withFindings.has(key)) continue;
					extraClean.push({
						filePath: entry.filePath,
						diagnostics: [],
						count: 0,
						timedOut: false,
						contentHash: entry.contentHash,
					});
				}
			}
			return { results, extraClean };
		} catch {
			return undefined;
		}
	}

	/**
	 * Get all diagnostics across all tracked files (for cascade checking)
	 */
	async getAllDiagnostics(): Promise<
		Map<
			string,
			{
				diags: import("./client.js").LSPDiagnostic[];
				ts: number;
				binding?: DiagnosticBinding;
			}
		>
	> {
		const all = new Map<
			string,
			{
				diags: import("./client.js").LSPDiagnostic[];
				ts: number;
				binding?: DiagnosticBinding;
			}
		>();
		// #1095: per-file stored bindings across every contributing client, merged
		// into one `boundToCurrentDisk` verdict after the client loop.
		const bindingsByPath = new Map<
			string,
			(StoredDiagnosticBinding | undefined)[]
		>();
		const now = Date.now();
		for (const [_key, client] of this.state.clients) {
			// Resolve existence asynchronously (was a blocking existsSync per tracked
			// file inside the prune predicate) so this cascade-checking path doesn't
			// hold the event loop; then prune with a synchronous, in-memory predicate.
			const trackedPaths = client.getTrackedDiagnosticPaths();
			const existingPaths = new Set<string>();
			await Promise.all(
				trackedPaths.map(async (filePath) => {
					try {
						await nodeFs.promises.access(filePath);
						existingPaths.add(filePath);
					} catch {
						/* missing → will be pruned */
					}
					return true;
				}),
			);
			client.pruneDiagnostics(
				(filePath, ts) =>
					!existingPaths.has(filePath) || now - ts > CASCADE_DIAGNOSTICS_TTL_MS,
			);
			const clientDiags = client.getAllDiagnostics();
			for (const [filePath, entry] of clientDiags) {
				const existing = all.get(filePath);
				if (existing) {
					existing.diags = mergeLspDiagnostics([
						...existing.diags,
						...entry.diags,
					]);
					existing.ts = Math.max(existing.ts, entry.ts);
				} else {
					all.set(filePath, { diags: [...entry.diags], ts: entry.ts });
				}
				const list = bindingsByPath.get(filePath) ?? [];
				list.push(entry.binding);
				bindingsByPath.set(filePath, list);
			}
		}
		// #1095 (P2-2): expose the composed content binding per file LAZILY — the
		// disk stat+hash verify only runs when a consumer actually reads `.binding`.
		// The current caller (the cascade, once per edit turn) does NOT read it yet
		// (binding adoption in cascade/integration.ts is deferred to the second PR),
		// so this leaves ZERO eager disk cost while still surfacing the field for the
		// consumer that arrives next. Non-enumerable so incidental spread/serialize
		// (e.g. logging) can't trigger a stat storm; memoized per entry so repeated
		// reads verify once.
		// #1179: DELIBERATELY NOT migrated to an enumerable wrapper field (unlike the
		// `touchFile` flags). Enumerable would make an incidental `{...entry}`/serialize
		// eagerly fire this getter and stat every file — the exact stat storm the
		// laziness above exists to prevent. It therefore stays on the read-off-original
		// carriage contract (see `DiagnosticBinding`): every consumer reads `.binding`
		// off the ORIGINAL Map entry (`clients/dispatch/integration.ts` reads it off
		// `entry`, never a copy), and the cascade's TTL gate reads it only when fresh.
		for (const [filePath, entry] of all) {
			const stored = bindingsByPath.get(filePath) ?? [];
			let memo: DiagnosticBinding | undefined;
			Object.defineProperty(entry, "binding", {
				enumerable: false,
				configurable: true,
				get: () => (memo ??= this.mergeBinding(filePath, stored)),
			});
		}
		return all;
	}

	/**
	 * Check whether a file type/root has any configured LSP support.
	 * Pure capability check — does not spawn or wait for clients.
	 */
	supportsLSP(filePath: string): boolean {
		return getServersForFileWithConfig(filePath).length > 0;
	}

	/**
	 * Check whether the PRIMARY server for this file is currently mid-spawn
	 * (`state.inFlight`, keyed `${server.id}:${normalizeMapKey(root)}` — see
	 * :2413). Lets a caller whose own wait budget expires distinguish "the
	 * server hasn't finished its first spawn yet" from "the server is running
	 * but slow/wedged" (#1766) — a cold spawn still in flight is not a verdict
	 * on a server that doesn't exist yet.
	 *
	 * Mirrors the `role !== "auxiliary"` filter getClientForFile applies at
	 * :2146-2148 (kept coupled to that line intentionally): auxiliary servers
	 * (opengrep, typos, …) spawn routinely and concurrently with an ALREADY
	 * ALIVE primary (dispatch/runners/lsp.ts's with-auxiliary path fires one
	 * per edit for most files via TYPOS_EXTENSIONS). Without this filter, an
	 * unrelated auxiliary spawn would downgrade a genuinely wedged primary to
	 * a benign "spawn-in-flight" verdict — the worse misreport direction.
	 *
	 * The touch path supplies roots resolved before acquisition. Matching the full
	 * server/root key prevents another workspace's spawn from relabeling this one.
	 * Root resolution is already complete, and this check stays synchronous.
	 * The failure mode is limited to the matching workspace key.
	 * Pure lookup — does not spawn or wait for a client.
	 */
	isSpawnInFlight(
		_filePath: string,
		resolvedRoots: ReadonlyMap<string, string> = new Map(),
	): boolean {
		for (const [serverId, root] of resolvedRoots) {
			if (this.state.inFlight.has(`${serverId}:${root}`)) return true;
		}
		return false;
	}

	/**
	 * Check whether an LSP client is already alive for a file.
	 * Lightweight — does not spawn or wait for a client.
	 */
	async hasWarmLSP(filePath: string): Promise<boolean> {
		const spawned = await this.getWarmClientForFile(filePath);
		return Boolean(spawned);
	}

	/**
	 * Check if LSP is available for a file.
	 * May spawn a client; prefer supportsLSP()/hasWarmLSP() when you only need
	 * a capability or warm-state check.
	 */
	async hasLSP(filePath: string): Promise<boolean> {
		const spawned = await this.getClientForFile(filePath);
		return Boolean(spawned);
	}

	/**
	 * Shutdown all LSP clients
	 */
	async shutdown(options: LSPShutdownOptions = {}): Promise<void> {
		const resetStartedAt = Date.now();
		if (this.checkDestroyed()) return;
		this.isDestroyed = true;
		for (const [key, token] of this.outstandingAuxNotifyWrites) {
			this.releaseOutstandingAuxNotifyWrite(key, token);
		}
		for (const key of this.typeScriptIdleTimers.keys()) {
			this.clearTypeScriptIdleTimer(key);
		}

		// Belt-and-braces: wait for any in-flight spawns so that Guard 1/2 in
		// spawnClient can observe isDestroyed and clean up. Skip on the
		// process-exiting path — the event loop is closing and we must not block.
		if (!options.processExiting && this.state.inFlight.size > 0) {
			const pending = Array.from(this.state.inFlight.values());
			this.state.inFlight.clear();
			const settled = await Promise.allSettled(pending);
			for (const result of settled) {
				if (result.status === "fulfilled" && result.value?.client) {
					result.value.client.shutdown({ fast: true }).catch(() => {});
				}
			}
		} else {
			this.state.inFlight.clear();
		}

		// Count alive clients BEFORE tearing them down — gives a meaningful
		// snapshot of what was released by this reset (post-teardown the count
		// would always be zero, which is useless for root-cause analysis).
		const aliveClients = this.getAliveClientCount();
		// Start every client teardown before awaiting any of them. A non-fast
		// process-tree kill can spend its grace period per client, so awaiting in
		// map order makes the reset tail O(clientCount * grace) instead of the
		// maximum individual teardown. allSettled preserves the per-client
		// best-effort contract: one failure must not prevent other clients from
		// finishing, and the caller still waits for every teardown to settle.
		await Promise.allSettled(
			Array.from(this.state.clients.values(), (client) =>
				Promise.resolve().then(() => client.shutdown(options)),
			),
		);
		logLatency({
			type: "phase",
			phase: "lsp_service_reset",
			filePath: "",
			startedAt: new Date(resetStartedAt).toISOString(),
			durationMs: Date.now() - resetStartedAt,
			metadata: {
				reason: options.reason ?? null,
				aliveClients,
				fast: !!options.fast,
				processExiting: !!options.processExiting,
			},
		});
		this.state.clients.clear();
		this.state.broken.clear();
		// #1934 review F1: map hygiene alongside the breaker it sits next to.
		// Not load-bearing — every read follows its own attempt's write — but a
		// verdict for a client generation that no longer exists is dead weight.
		this.lastSpawnVerdict.clear();
		// #1459: every gated client is gone, so no outstanding-write record can
		// describe a live one. The gate's identity check already neutralises a stale
		// entry; clearing keeps the map honest rather than relying on that.
		for (const [key, token] of this.outstandingAuxNotifyWrites) {
			this.releaseOutstandingAuxNotifyWrite(key, token);
		}
		this.notifyStallDemotions.clear();
		// #2358: same reasoning — a per-write latency estimate belongs to a client
		// generation, and every client is gone. `session_start` reaches this
		// through the service reset, so the adaptive wedge window re-arms with
		// the session rather than being priced by a previous one's throughput.
		this.auxNotifyDrainLatencyEwma.clear();
		// #1714: same reasoning — a backlog count belongs to a client generation,
		// and every client is gone. `session_start` reaches this through the service
		// reset, so the pacing state re-arms with the session rather than living for
		// the process.
		this.auxNotifyInflight.clear();
		// #1783: the drift records describe what THESE clients hold. Every client
		// is gone, so every record is a claim about a dead server's view. Keeping
		// them would make the first sweep of the next generation resync files no
		// one has open yet, and — like the pacing state above — this is state that
		// must re-arm at `session_start`, which reaches it through this reset.
		this.documentDrift.clear();
		this.workspaceProbeLogged.clear();
		this.warmStartLogged.clear();
	}

	/**
	 * Get status of all active clients
	 */
	getStatus(): Array<{
		serverId: string;
		root: string;
		connected: boolean;
		pullFailureHistory: LSPPullFailure[];
	}> {
		return Array.from(this.state.clients.entries()).map(([key, client]) => {
			const [serverId, root] = key.split(":");
			return {
				serverId,
				root,
				connected: client.isAlive(),
				pullFailureHistory: (client.getPullFailureHistory?.() ?? []).map(
					(entry) => ({
						...entry,
						message: entry.message.slice(0, 200),
					}),
				),
			};
		});
	}

	/**
	 * #1142 windowed-rate breaker (composes with the {@link runtimeExitCounts}
	 * fast path — see that field and {@link RUNTIME_EXIT_WINDOW_MS}).
	 *
	 * Records one non-intentional death and returns true iff this death pushes
	 * the rolling window to {@link RUNTIME_EXIT_WINDOW_TRIP_COUNT} deaths, i.e.
	 * the breaker should give up now. The caller has ALREADY excluded intentional
	 * teardowns (shutdown()-driven restarts, #743 eviction, session resets,
	 * generation handoffs) — only genuine crash-respawns reach here.
	 *
	 * Sleep-gap / long-healthy-run guard: a death whose measured lifetime exceeds
	 * {@link RUNTIME_EXIT_WINDOW_UPTIME_CEILING_MS} (or is unknown) is NOT
	 * recorded — a lifetime spanning a Modern-Standby suspend, or a genuinely
	 * long run that crashed once, is not churn. See that constant for the
	 * per-KEY structural defense this backs up.
	 *
	 * Bounded on both axes (defect shape 9): prune entries outside the window,
	 * then hard-cap the retained array at the trip count (drop-oldest — a rate
	 * trip needs only the in-window count, so earliest-evidence order is
	 * irrelevant here).
	 */
	private recordRuntimeExitWindow(
		key: string,
		exitedAt: number | undefined,
		uptimeMs: number | null,
	): boolean {
		if (
			exitedAt == null ||
			uptimeMs == null ||
			uptimeMs > RUNTIME_EXIT_WINDOW_UPTIME_CEILING_MS
		) {
			return false;
		}
		const deaths = this.runtimeExitWindow.get(key) ?? [];
		deaths.push(exitedAt);
		// Roll the window around the most recent death. `exitedAt` is the client's
		// own recorded death time (#1127), which can arrive out of DETECTION order
		// — a death detected hours later still carries its true, older timestamp —
		// so anchor on the max, not on push order.
		const windowRef = Math.max(...deaths);
		const windowStart = windowRef - RUNTIME_EXIT_WINDOW_MS;
		let pruned = deaths.filter((t) => t >= windowStart);
		if (pruned.length > RUNTIME_EXIT_WINDOW_TRIP_COUNT) {
			pruned = pruned.slice(pruned.length - RUNTIME_EXIT_WINDOW_TRIP_COUNT);
		}
		this.runtimeExitWindow.set(key, pruned);
		return pruned.length >= RUNTIME_EXIT_WINDOW_TRIP_COUNT;
	}

	/**
	 * Read-only circuit-breaker status, including server/root pairs that have no
	 * live client and would therefore be absent from getStatus().
	 *
	 * #1127: `failureCounts` (spawn/init failures) and `runtimeExitCounts`
	 * (early post-init runtime exits) are two INDEPENDENT streams feeding one
	 * circuit — either can trip its own cooldown/permanent-disable on its own
	 * threshold, without the other. `failures` below is their SUM, purely for
	 * display: it is the total churn behind whatever cooldown/permanent state
	 * is showing, not a claim that both streams are at that count.
	 */
	getBrokenStatus(): Array<{
		serverId: string;
		root: string;
		failures: number;
		permanentlyBroken: boolean;
		cooldownUntil: number;
	}> {
		const keys = new Set([
			...this.state.broken.keys(),
			...this.permanentlyBroken,
		]);
		return [...keys].map((key) => {
			const separator = key.indexOf(":");
			return {
				serverId: separator >= 0 ? key.slice(0, separator) : key,
				root: separator >= 0 ? key.slice(separator + 1) : "",
				// #1127/#1142: spawn/init failures, consecutive early post-init
				// exits, and the windowed-rate stream all feed the same breaker
				// (see `runtimeExitCounts`/`runtimeExitWindow` docs). Sum spawn/init
				// failures with the LARGER of the two runtime-exit streams — a
				// single <60s death feeds BOTH runtimeExitCounts and the window, so
				// `max` avoids double-counting them, while still surfacing a
				// windowed-only trip (whose runtimeExitCounts may be 0) instead of
				// misreporting `failures: 0` behind a permanent-disable.
				failures:
					(this.failureCounts.get(key) ?? 0) +
					Math.max(
						this.runtimeExitCounts.get(key) ?? 0,
						this.runtimeExitWindow.get(key)?.length ?? 0,
					),
				permanentlyBroken: this.permanentlyBroken.has(key),
				cooldownUntil: this.state.broken.get(key) ?? 0,
			};
		});
	}

	/**
	 * Count clients that are currently alive (connected and initialized).
	 * Lightweight — does not spawn or wait for anything.
	 */
	getAliveClientCount(): number {
		let count = 0;
		for (const client of this.state.clients.values()) {
			if (client.isAlive()) count++;
		}
		return count;
	}

	/**
	 * Distinct serverIds of currently-alive clients, ordered primary-first then
	 * auxiliary (cross-cutting scanners like opengrep/ast-grep), stable within
	 * each group. Deduped across roots — one warm server serving two roots
	 * collapses to a single id. Lightweight: does not spawn or wait. (#267)
	 */
	getAliveServerIds(): string[] {
		const primary: string[] = [];
		const aux: string[] = [];
		const seen = new Set<string>();
		for (const client of this.state.clients.values()) {
			if (!client.isAlive()) continue;
			const id = client.serverId;
			if (seen.has(id)) continue;
			seen.add(id);
			const role = LSP_SERVERS.find((s) => s.id === id)?.role;
			(role === "auxiliary" ? aux : primary).push(id);
		}
		return [...primary, ...aux];
	}
}

// --- Singleton Instance ---

interface LSPProcessState {
	service: LSPService | null;
	generationHandoff: Promise<void> | undefined;
}

const LSP_PROCESS_FAMILY = "lsp.service";
const LSP_PROCESS_VERSION = 1;

function lspProcessState(): LSPProcessState {
	let incompatibleHandoff: Promise<void> | undefined;
	return getProcessSingleton(
		LSP_PROCESS_FAMILY,
		LSP_PROCESS_VERSION,
		() => ({ service: null, generationHandoff: incompatibleHandoff }),
		(value) => {
			// Shut down a live incompatible service before replacing its cell.
			if (!value || typeof value !== "object") return;
			const candidate = value as {
				service?: {
					shutdown?: (options: LSPShutdownOptions) => Promise<void>;
				} | null;
				generationHandoff?: Promise<void>;
			};
			const previousHandoff = candidate.generationHandoff;
			const teardown = candidate.service?.shutdown
				? candidate.service
						.shutdown({ fast: true, reason: "process_singleton_reset" })
						.catch(() => undefined)
				: undefined;
			if (previousHandoff && teardown) {
				incompatibleHandoff = Promise.allSettled([
					previousHandoff,
					teardown,
				]).then(() => undefined);
			} else {
				incompatibleHandoff = previousHandoff ?? teardown;
			}
		},
	);
}

function processService(): LSPService {
	const state = lspProcessState();
	if (!state.service)
		state.service = new LSPService(state.generationHandoff, process.cwd());
	return state.service;
}
/**
 * #850: all singleton generations whose teardown is still pending. A new
 * generation may be allocated synchronously, but its first spawn waits on this
 * handoff so two generations can never own the same server/root concurrently.
 */
export function getLSPService(): LSPService {
	return processService();
}

/**
 * Gate-B readiness seam. It reads only the live client map and never spawns,
 * waits for initialization, or probes a binary.
 */
export async function hasAuxiliaryLspPublishedForRoot(
	serverId: string,
	filePath: string,
): Promise<boolean> {
	return getLSPService().hasServerPublishedForFileRoot(serverId, filePath);
}

/**
 * Cross-layer seam (#1668) for callers outside `lsp/` (bash/write tool-result
 * handling) that observe a disk change no open-document sync path will ever
 * report — an external delete/create/modify. Delivers to already-active
 * clients only; see `LSPService.notifyExternalFileChange`.
 */
export async function notifyExternalFileChange(
	filePath: string,
	type: number,
): Promise<void> {
	return getLSPService().notifyExternalFileChange(filePath, type);
}

export function resetLSPService(options: LSPShutdownOptions = {}): void {
	// Invalidate availability publication started by the retiring service before
	// any asynchronous teardown. The launch seam checks this generation after
	// every managed lookup, install, and process launch (#2351).
	resetLspLaunchAvailabilityGeneration();
	// A new session must get its own classic-tsserver-repair attempt: the
	// guard is a process-lifetime flag (see resetClassicTsRepairGuard), so a
	// repair that failed transiently in an earlier session must not stay
	// latched for the rest of the extension-host process (#1570).
	if (options.reason === "session_start") {
		resetClassicTsRepairGuard();
		// #1618 (R3): a hold from a PRIOR generation's sweep must never survive
		// a session boundary — state that must re-arm at session_start cannot
		// hide behind a leaked/stuck guard from the generation before it.
		clearWorkspaceSweepHoldForSessionStart();
	}
	const state = lspProcessState();
	const retiringService = state.service;
	state.service = null;
	if (!retiringService) return;

	// shutdown() marks the service destroyed synchronously before its first
	// await. Include both that teardown and every earlier pending generation:
	// repeated resets may retire a replacement that is itself still waiting on
	// its predecessor. allSettled keeps teardown best-effort without ever
	// rejecting (and therefore permanently poisoning) the next generation.
	const teardown = retiringService.shutdown(options);
	const pending = state.generationHandoff
		? [state.generationHandoff, teardown]
		: [teardown];
	const handoff = Promise.allSettled(pending).then(() => undefined);
	state.generationHandoff = handoff;
	void handoff.then(() => {
		if (state.generationHandoff === handoff) {
			state.generationHandoff = undefined;
		}
	});
}

/**
 * Test-only: exposes the async workspace-diagnostics file walk so its
 * event-loop occupancy can be guarded (see workspace-diagnostics-occupancy
 * test). Not part of the public API.
 */
export function __collectWorkspaceDiagnosticFilesForTest(
	root: string,
	maxFiles?: number,
	signal?: AbortSignal,
	homeDir?: string,
): Promise<string[]> {
	return collectWorkspaceDiagnosticFiles(
		path.resolve(root),
		maxFiles ?? getMaxWorkspaceDiagnosticFiles(),
		signal,
		homeDir,
	);
}
