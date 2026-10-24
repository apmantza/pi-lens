/**
 * ClientRegistry: LSP client identity and lifecycle, extracted from
 * LSPService (#2372 slice 3, #277 R3). It owns the client map and its key
 * (`serverId:normalizeMapKey(root)`, root from {@link ClientRegistry.resolveServerRoot}),
 * single-flight spawn, the circuit breaker, leases, capacity and idle
 * eviction, adopted roots, and the client half of shutdown.
 *
 * LSPService composes one registry per service generation and reaches its
 * own per-generation state (readiness, notify backlog, first-contact
 * latches) only through {@link ClientGenerationHooks}, called at the exact
 * points the code ran inline before the move. The registry's four maps are
 * shared by object with `LSPState`, so the service's readers see the same
 * Map; every write to them happens in this module.
 */

import path from "node:path";
import { emitBounded } from "../bounded-telemetry.js";
import {
	incrementDegradationCount,
	recordDegradation,
	recordDegradationOnce,
} from "../degradation-ledger.js";
import { isEphemeralCheckoutRoot } from "../ephemeral-root.js";
import { logLatency } from "../latency-logger.js";
import {
	findLocalBinUpwards,
	isProjectLocalBinPath,
} from "../package-manager.js";
import { isWindowsPath, normalizeMapKey } from "../path-utils.js";
import {
	assertInstallAllowed,
	isLspSpawnAllowedByTrust,
	projectTrustDenialReason,
} from "../project-trust.js";
import { logSessionStart } from "../sessionstart-logger.js";
import { recordLsp } from "../widget-state.js";
import {
	resolveAnalysisRoot,
	resolveAnalysisRootPath,
} from "../analysis-root.js";
import type {
	LSPClientInfo,
	LSPPullFailure,
	LSPShutdownOptions,
} from "./client.js";
import { createLSPClient } from "./client.js";
import { getServerInitOverride } from "./config.js";
import {
	refuseUntrustedLspExecution,
	withLspProjectCodePermission,
} from "./launch.js";
import {
	declinesLooseFileRoot,
	declinesProjectlessRoot,
	enforceLspRootCeiling,
	getServerById,
	hasProjectBoundaryMarker,
	isDirectLspCommandTemporarilyUnavailable,
	isSameOrWithin,
	resolveLspServerCwd,
	type LSPServerInfo,
} from "./server.js";
import { isAuxiliary } from "./server-traits.js";
import {
	getSessionRootsForTelemetry,
	isOutsideAllSessionRoots,
} from "./session-roots.js";
import { recordSuccessfulLspSpawn } from "./spawn-history.js";

/** Phase A bound: adopted roots are foreign workspaces, not session roots. */
const ADOPTED_ROOT_CAP = 2;
const ADOPTED_ROOT_IDLE_EVICT_MS = 60_000;

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
 * A client key is `<serverId>:<normalized root>`. A built-in server id never
 * holds a colon (a custom `lsp.servers` id can, and no key reader handles that
 * yet); the root can (a Windows drive `c:/work`, a POSIX `a:b` directory), so
 * the key is cut at the FIRST colon only. One reading for every status and
 * bookkeeping path: `getStatus` once split at every colon and kept `c` for
 * `c:/work/proj`. A key with no colon reads as a bare server id with no root.
 */
function parseClientKey(key: string): { serverId: string; root: string } {
	const separator = key.indexOf(":");
	return separator < 0
		? { serverId: key, root: "" }
		: { serverId: key.slice(0, separator), root: key.slice(separator + 1) };
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

export const BROKEN_BASE_COOLDOWN_MS = 15_000;
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

const OPTIONAL_LSP_RETRY_COOLDOWN_MS = 5 * 60_000;
const OPTIONAL_LSP_SERVER_IDS = new Set<string>();

const DEFAULT_LSP_CLIENT_CEILING = 24;
const DEFAULT_IDLE_EVICT_MS = 20 * 60_000;
const DEFAULT_EPHEMERAL_IDLE_EVICT_MS = 60_000;

/**
 * #3645: the idle window shared by every server whose registry policy is
 * `transparent`. `PI_LENS_LSP_IDLE_EVICT_MS` is the generic spelling; the
 * original `PI_LENS_TS_IDLE_EVICT_MS` keeps its meaning and is consulted when
 * the generic one is unset or invalid.
 */
export function getLspIdleEvictMs(): number {
	for (const name of [
		"PI_LENS_LSP_IDLE_EVICT_MS",
		"PI_LENS_TS_IDLE_EVICT_MS",
	]) {
		const parsed = Number.parseInt(process.env[name] ?? "", 10);
		if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
	}
	return DEFAULT_IDLE_EVICT_MS;
}

function getEphemeralLspIdleEvictMs(): number {
	const parsed = Number.parseInt(
		process.env.PI_LENS_EPHEMERAL_LSP_IDLE_EVICT_MS ?? "",
		10,
	);
	return Number.isSafeInteger(parsed) && parsed > 0
		? parsed
		: DEFAULT_EPHEMERAL_IDLE_EVICT_MS;
}

export function getLspIdleEvictMsForRoot(root: string): number {
	return isEphemeralCheckoutRoot(root)
		? getEphemeralLspIdleEvictMs()
		: getLspIdleEvictMs();
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

export interface SpawnedServer {
	client: LSPClientInfo;
	info: LSPServerInfo;
}

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

/**
 * The service-owned, per-generation records a registry transition must keep
 * in step. Each hook replaces the inline statement it was before the move,
 * at the same position, so no ordering changed.
 */
export interface ClientGenerationHooks {
	/** Release the generation's outstanding auxiliary notify write and its timer. */
	releaseNotifyWrite(key: string): void;
	/** Drop readiness verdicts and the write-timeout streak (#3502, #3537). */
	forgetReadiness(key: string): void;
	/** Drop the auxiliary notify backlog and its drain-latency estimate. */
	forgetNotifyBacklog(key: string): void;
	/** A replacement generation was published: clear its notify-stall marker. */
	clearStallDemotion(key: string): void;
	/** A replacement process is about to initialize: re-arm first contact. */
	rearmFirstContact(serverId: string): void;
	/** The client published diagnostics for `serverId`. */
	noteDiagnosticsPublished(serverId: string): void;
}

export class ClientRegistry {
	/** Live clients, key "serverId:normalizedRoot". Shared with `LSPState.clients`. */
	readonly clients = new Map<string, LSPClientInfo>();
	/** Servers that failed to initialize, with their retry-at timestamp. */
	readonly broken = new Map<string, number>();
	/** One spawn promise per key: prevents duplicate spawns. */
	readonly inFlight = new Map<string, Promise<SpawnedServer | undefined>>();
	/** Epoch ms of each key's last successful spawn. */
	readonly clientSpawnedAt = new Map<string, number>();
	/**
	 * Epoch ms each live client's LAUNCH began, before its process read the
	 * tree (#4532 round 5, review F6). The install look compares an install
	 * against this: `clientSpawnedAt` is stamped after the initialize handshake,
	 * so an install that landed while the server was starting read as older
	 * than the client and became the baseline. Kept apart from
	 * `clientSpawnedAt` because the #1127 breaker measures post-init uptime from
	 * that one. Same key and lifetime: written beside it, retired with it.
	 */
	readonly clientLaunchStartedAt = new Map<string, number>();
	private readonly hooks: ClientGenerationHooks;
	private readonly sessionCwd: string | undefined;
	private readonly workspaceProbeLogged = new Set<string>();
	/** Per-service immutable root-boundary verdicts; root detectors cache hits too. */
	private readonly projectBoundaryCache = new Map<string, Promise<boolean>>();
	/** Foreign roots are recorded once per normalized root for this service/session. */
	private readonly warmStartLogged = new Set<string>();
	private readonly optionalFailureLogged = new Set<string>();
	/** Server/root pairs that already emitted unavailable for the current occurrence. */
	readonly unavailableLogged = new Set<string>();
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
	readonly permanentlyBroken = new Set<string>();
	/** LRU clock for capacity eviction, keyed by the canonical server/root key. */
	private readonly clientLastUsedAt = new Map<string, number>();
	/** LRU of foreign project roots; kept apart from the session-root registry. */
	private readonly adoptedRootLastUsedAt = new Map<string, number>();
	private readonly adoptedClientKeys = new Set<string>();
	/**
	 * Manager-owned use leases close the acquisition/use gap that `isBusy()`
	 * cannot see: a caller may hold a selected client before its first request has
	 * entered the client. Eviction skips any key with an outstanding lease.
	 */
	private readonly clientLeases = new Map<string, number>();
	/**
	 * Per-root idle eviction for servers whose registry policy is `transparent`.
	 * Timers are unref'd so an idle language service cannot keep a one-shot host
	 * alive, and are removed before shutdown so a concurrent request rebuilds
	 * instead of receiving the retiring client.
	 */
	private readonly idleEvictionTimers = new Map<
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

	constructor(
		hooks: ClientGenerationHooks,
		generationHandoff?: Promise<void>,
		sessionCwd?: string,
	) {
		this.hooks = hooks;
		this.generationHandoff = generationHandoff;
		this.sessionCwd = sessionCwd;
	}

	/** Guard: return true if service is shutting down or shut down. Public so a
	 *  caller holding this generation can tell a reset from "no client" (#3483). */
	checkDestroyed(): boolean {
		return this.isDestroyed;
	}

	/** The first step of `LSPService.shutdown`: block new operations. */
	markDestroyed(): void {
		this.isDestroyed = true;
	}

	/** The notify-stall demotion's breaker cooldown (`LSPService.demoteForNotifyStall`). */
	coolDown(key: string, cooldownMs: number): void {
		this.broken.set(key, Date.now() + cooldownMs);
	}

	analysisRootModeForFile(filePath: string): string {
		const roots = getSessionRootsForTelemetry(128);
		if (this.sessionCwd) roots.push(this.sessionCwd);
		let adopted = false;
		for (const root of new Set(roots)) {
			const mode = resolveAnalysisRoot(filePath, root);
			if (mode === "session" || mode === "linked-worktree") return mode;
			adopted ||= mode === "adopted";
		}
		return adopted ? "adopted" : "none";
	}

	fileIsOutsideRegisteredRoots(filePath: string): boolean {
		const roots = getSessionRootsForTelemetry(128);
		if (roots.length === 0) return isOutsideAllSessionRoots(filePath);
		return !roots.some((root) => isSameOrWithin(root, filePath));
	}

	private admitAdoptedRoot(root: string, filePath: string): boolean {
		if (this.analysisRootModeForFile(filePath) !== "adopted") return false;
		const normalized = normalizeMapKey(root);
		const liveRoots = new Set<string>();
		for (const key of this.clients.keys()) {
			if (this.adoptedClientKeys.has(key))
				liveRoots.add(parseClientKey(key).root);
		}
		for (const root of this.adoptedRootLastUsedAt.keys()) {
			if (!liveRoots.has(root)) this.adoptedRootLastUsedAt.delete(root);
		}
		if (liveRoots.has(normalized)) {
			this.adoptedRootLastUsedAt.set(normalized, Date.now());
			return true;
		}
		if (this.adoptedRootLastUsedAt.size < ADOPTED_ROOT_CAP) {
			this.adoptedRootLastUsedAt.set(normalized, Date.now());
			return true;
		}
		this.adoptedRootLastUsedAt.set(normalized, Date.now());
		const victim = [...this.adoptedRootLastUsedAt.keys()]
			.sort(
				(a, b) =>
					(this.adoptedRootLastUsedAt.get(a) ?? 0) -
					(this.adoptedRootLastUsedAt.get(b) ?? 0),
			)
			.find((candidate) => candidate !== normalized);
		if (!victim) return true;
		this.adoptedRootLastUsedAt.delete(victim);
		for (const [key, client] of this.clients) {
			if (
				!this.adoptedClientKeys.has(key) ||
				parseClientKey(key).root !== victim
			)
				continue;
			if ((this.clientLeases.get(key) ?? 0) > 0) continue;
			this.retireClient(key);
			void client.shutdown({ reason: "adopted-root-lru" }).catch(() => {});
		}
		incrementDegradationCount({
			kind: "lsp-adopted-root-evicted",
			subject: victim,
			reason: `adopted root cap ${ADOPTED_ROOT_CAP} evicted ${victim}`,
		});
		return true;
	}

	/**
	 * Resolve one server's client identity root. Root selection is hard-bounded
	 * by the session cwd, then config-only nested roots reuse an already-hosted
	 * same-server ancestor. Real nested projects retain independent clients.
	 */
	async resolveServerRoot(
		server: LSPServerInfo,
		filePath: string,
		onRootFailure?: (reason: string) => void,
	): Promise<string | undefined> {
		const candidate = await resolveLspServerCwd(
			server,
			filePath,
			this.sessionCwd ?? process.cwd(),
			onRootFailure,
		);
		if (!candidate) return undefined;
		const mode = this.analysisRootModeForFile(filePath);
		if (mode === "adopted") {
			const classifierRoot = resolveAnalysisRootPath(
				filePath,
				this.sessionCwd ?? process.cwd(),
			);
			if (
				!classifierRoot ||
				normalizeMapKey(classifierRoot) !== normalizeMapKey(candidate)
			)
				return undefined;
		}
		// #2052: a file outside EVERY initialized session cwd gets no client at
		// all. The ceiling below is unchanged (`process.cwd()`, as before this
		// issue) and still only clamps files that are actually inside it —
		// `enforceLspRootCeiling` returns the root untouched for an out-of-ceiling
		// file. So this gate is the ONLY new refusal, and it consults the
		// registry, not a single cwd.
		if (
			this.fileIsOutsideRegisteredRoots(filePath) &&
			this.analysisRootModeForFile(filePath) !== "adopted"
		)
			return undefined;
		const root = enforceLspRootCeiling(candidate, process.cwd(), filePath);
		if (normalizeMapKey(root) === normalizeMapKey(process.cwd())) return root;

		const rootKey = normalizeMapKey(root);
		const prefix = `${server.id}:`;
		let nearestAncestor: string | undefined;
		for (const key of new Set([
			...this.clients.keys(),
			...this.inFlight.keys(),
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
		const boundaryKey = `${server.id}:${rootKey}`;
		let boundary = this.projectBoundaryCache.get(boundaryKey);
		if (!boundary) {
			boundary = hasProjectBoundaryMarker(root, server);
			this.projectBoundaryCache.set(boundaryKey, boundary);
		}
		if (await boundary) return root;
		return (
			this.clients.get(`${server.id}:${nearestAncestor}`)?.root ??
			nearestAncestor
		);
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

	async acquireClientLease(
		entry: SpawnedServer,
		filePath: string,
	): Promise<string | undefined> {
		const key = await this.clientKeyFor(entry, filePath);
		if (!key) return undefined;
		return this.withClientSpawnGate(async () => {
			if (this.isDestroyed || this.clients.get(key) !== entry.client) {
				return undefined;
			}
			this.clientLeases.set(key, (this.clientLeases.get(key) ?? 0) + 1);
			return key;
		});
	}

	async acquireClientLeases(
		entries: readonly SpawnedServer[],
		filePath: string,
	): Promise<{ key: string; server: LSPServerInfo }[] | undefined> {
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
				keyed.some(([key, entry]) => this.clients.get(key) !== entry.client)
			) {
				return undefined;
			}
			for (const [key] of keyed) {
				this.clientLeases.set(key, (this.clientLeases.get(key) ?? 0) + 1);
			}
			return keyed.map(([key, entry]) => ({ key, server: entry.info }));
		});
	}

	releaseClientLease(key: string, server: LSPServerInfo): void {
		const remaining = (this.clientLeases.get(key) ?? 1) - 1;
		if (remaining > 0) {
			this.clientLeases.set(key, remaining);
			return;
		}
		this.clientLeases.delete(key);
		if (this.clients.has(key)) {
			this.clientLastUsedAt.set(key, Date.now());
			this.scheduleIdleEviction(key, server);
		}
	}

	private async makeCapacityForClient(key: string): Promise<boolean> {
		const occupiedKeys = new Set(this.inFlight.keys());
		for (const [clientKey, client] of this.clients) {
			if (client.isAlive()) occupiedKeys.add(clientKey);
		}
		const occupied = occupiedKeys.size;
		if (occupied < getLspClientCeiling()) return true;

		const idle = [...this.clients.entries()]
			.filter(
				([candidateKey, client]) =>
					candidateKey !== key &&
					client.isAlive() &&
					client.isBusy?.() !== true &&
					(this.clientLeases.get(candidateKey) ?? 0) === 0,
			)
			.sort(
				([a], [b]) =>
					(this.clientLastUsedAt.get(a) ?? this.clientSpawnedAt.get(a) ?? 0) -
					(this.clientLastUsedAt.get(b) ?? this.clientSpawnedAt.get(b) ?? 0),
			);
		const victim = idle[0];
		if (!victim) {
			logSessionStart(
				`lsp client ceiling ${getLspClientCeiling()}: spawn declined; all clients are in use`,
			);
			return false;
		}

		const [victimKey, victimClient] = victim;
		// Released BEFORE the awaited shutdown so a waiter never parks on a client
		// that is already going down; retireClient's own release is then a no-op.
		this.hooks.releaseNotifyWrite(victimKey);
		await victimClient.shutdown({ reason: "client_ceiling_lru" });
		this.retireClient(victimKey);
		logSessionStart(
			`lsp client ceiling ${getLspClientCeiling()}: evicted idle LRU ${victimKey}`,
		);
		return true;
	}

	clearIdleEvictionTimer(key: string): void {
		const timer = this.idleEvictionTimers.get(key);
		if (timer) clearTimeout(timer);
		this.idleEvictionTimers.delete(key);
	}

	/**
	 * #3585: the ONE retirement of a client generation, used by capacity
	 * eviction, idle eviction, notify-stall demotion and the
	 * dead-client respawn. Everything keyed to the retired client's lifetime is
	 * dropped here, so a replacement starts cold: a path that forgot one entry
	 * was the defect shape behind #3502 (readiness) and #3537 (timeout streak).
	 * Synchronous on purpose: idle eviction publishes the cold state before it
	 * awaits teardown. Callers keep only what differs per path (the shutdown
	 * call and its ordering, breaker cooldowns, demotion stamps).
	 */
	retireClient(key: string): void {
		this.hooks.releaseNotifyWrite(key);
		this.clients.delete(key);
		this.clientSpawnedAt.delete(key);
		this.clientLaunchStartedAt.delete(key);
		this.hooks.forgetReadiness(key);
		this.clientLastUsedAt.delete(key);
		if (this.adoptedClientKeys.delete(key)) {
			const { root } = parseClientKey(key);
			if (
				![...this.adoptedClientKeys].some(
					(candidate) => parseClientKey(candidate).root === root,
				)
			)
				this.adoptedRootLastUsedAt.delete(root);
		}
		this.clearIdleEvictionTimer(key);
		// #1714/#3585: the backlog count and the per-write latency estimate
		// describe a process that no longer exists.
		this.hooks.forgetNotifyBacklog(key);
	}

	scheduleIdleEviction(key: string, server: LSPServerInfo): void {
		// The registry owns this policy. Unmeasured and resident servers stay resident.
		if (
			server.idleEviction !== "transparent" &&
			!this.adoptedClientKeys.has(key)
		) {
			// #3952: say why no timer was scheduled. Without this row a caller
			// that ARMS an `unmeasured` server and waits for the eviction (the
			// nightly probe's whole protocol) sees the same "nothing happened" as
			// a server whose timer is merely slow, and the two are opposite
			// verdicts: `not-evicted` here means the policy was never read off the
			// object the service holds, which is a pi-lens defect, not a slow
			// server. Once per server per session: the policy is a declaration, so
			// one row per (server, session) carries every occurrence's verdict.
			recordDegradationOnce({
				kind: "lsp-idle-eviction-declined",
				subject: server.id,
				reason: `no idle-eviction timer: declared ${server.idleEviction ?? "unmeasured"}`,
			});
			return;
		}
		// Pressure-gating these timers would require a separate reconciliation pass
		// when the manager crosses the threshold; keep ownership simple and use the
		// warm-LSP-friendly 20-minute default instead.
		this.clearIdleEvictionTimer(key);
		const lastUsedAt = this.clientLastUsedAt.get(key) ?? Date.now();
		const { root } = parseClientKey(key);
		const idleMs = this.adoptedClientKeys.has(key)
			? ADOPTED_ROOT_IDLE_EVICT_MS
			: getLspIdleEvictMsForRoot(root);
		const timer = setTimeout(() => {
			this.idleEvictionTimers.delete(key);
			void this.withClientSpawnGate(async () => {
				if (this.isDestroyed) return;
				const client = this.clients.get(key);
				if (!client?.isAlive()) return;
				if (
					client.isBusy?.() === true ||
					(this.clientLeases.get(key) ?? 0) > 0 ||
					(this.clientLastUsedAt.get(key) ?? 0) !== lastUsedAt
				) {
					this.scheduleIdleEviction(key, server);
					return;
				}

				// Publish the cold state synchronously before awaiting teardown. A request
				// arriving while shutdown is in progress therefore waits on the spawn gate
				// and creates a fresh client; it can never receive this retiring one.
				this.retireClient(key);
				try {
					await client.shutdown({ reason: "idle_eviction" });
				} catch {
					// The strong manager reference is already gone; shutdown is best-effort
					// like the other eviction paths and must not reject from a timer callback.
				}
				logSessionStart(`lsp idle eviction: released ${key}`);
				recordDegradation({
					kind: "lsp-idle-eviction",
					subject: key,
					reason: "idle LSP client released to bound memory",
				});
			}).catch(() => {});
		}, idleMs);
		timer.unref?.();
		this.idleEvictionTimers.set(key, timer);
	}

	/**
	 * #4476: retire and shut down the live primary clients whose root contains
	 * `root` or lies under it, after a dependency install there. The install
	 * rewrote files no watched-files event can name one by one, and a server
	 * that caches closed files (TypeScript 7's native server, measured) keeps
	 * the old declarations until it restarts. Auxiliary scanners resolve no
	 * dependencies and stay: a cold one answered the next dispatch late, and
	 * the installing bash result lost its other files' results (live probe).
	 * The idle-eviction sequence: the cold state is published before the
	 * awaited shutdown, so a touch arriving meanwhile waits on the spawn gate
	 * and gets a fresh client, which reads the new files. Shutdown is
	 * best-effort, as on every eviction path: the client is already retired,
	 * so a failed one leaves no stale view behind. Answers the retired keys.
	 */
	async restartPrimaryClientsUnder(root: string): Promise<string[]> {
		const rootKey = normalizeMapKey(root);
		const overlaps = (clientRoot: string) =>
			clientRoot === rootKey ||
			clientRoot.startsWith(`${rootKey}/`) ||
			rootKey.startsWith(`${clientRoot}/`);
		return this.withClientSpawnGate(async () => {
			if (this.isDestroyed) return [];
			const victims: Array<[string, LSPClientInfo]> = [];
			for (const [key, client] of this.clients) {
				const { serverId, root: clientRoot } = parseClientKey(key);
				if (
					client.isAlive() &&
					!isAuxiliary(getServerById(serverId)) &&
					overlaps(clientRoot)
				)
					victims.push([key, client]);
			}
			for (const [key] of victims) this.retireClient(key);
			await Promise.all(
				victims.map(([, client]) =>
					client.shutdown({ reason: "dependency_change" }).catch(() => {}),
				),
			);
			return victims.map(([key]) => key);
		});
	}

	private recordBreaker(key: string, reason: string): void {
		recordDegradationOnce({ kind: "lsp-breaker", subject: key, reason });
	}

	/**
	 * #4532: the roots of the live PRIMARY clients, each with the epoch ms its
	 * earliest live client at that root spawned. The out-of-band install look
	 * runs at these roots as well as the session's cwd, so a dependency install
	 * in a LINKED WORKTREE — a root the session cwd is not under — restarts that
	 * worktree's server. Read-only: never spawns and never waits.
	 *
	 * The earliest spawn, not the latest: `restartPrimaryClientsUnder` retires
	 * every primary overlapping a root, so a root whose newer client spawned
	 * after an install must not hide an older one that read the pre-install
	 * tree. The epoch is the client's LAUNCH start (`clientLaunchStartedAt`):
	 * the server reads the tree from its spawn on, not from the end of its
	 * initialize handshake. An absent stamp reports 0, which a first look reads
	 * as "no epoch" and never as "before every install".
	 */
	livePrimaryClientRoots(): Array<{ root: string; spawnedAt: number }> {
		const byRoot = new Map<string, number>();
		for (const [key, client] of this.clients) {
			if (!client.isAlive()) continue;
			const { serverId, root } = parseClientKey(key);
			if (!root) continue;
			if (isAuxiliary(getServerById(serverId))) continue;
			const spawnedAt = this.clientLaunchStartedAt.get(key) ?? 0;
			const prior = byRoot.get(root);
			byRoot.set(
				root,
				prior === undefined ? spawnedAt : Math.min(prior, spawnedAt),
			);
		}
		return [...byRoot].map(([root, spawnedAt]) => ({ root, spawnedAt }));
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

	/**
	 * {@link resolveServerRoot}, memoized against a caller-owned map so one
	 * acquisition asks a given server for its root at most once (#2525).
	 *
	 * Resolution is cheap exactly when it SUCCEEDS: `NearestRoot` caches hits,
	 * but deliberately never caches negatives (so a marker scaffolded
	 * mid-session is picked up without a restart). An unrooted candidate
	 * therefore re-walks to the filesystem root on every call, which is why the
	 * acquisition path and the records it emits must share one resolution
	 * instead of each taking their own. Without a `memo` this is a plain
	 * passthrough, for callers that have no acquisition to share with.
	 */
	resolveServerRootOnce(
		server: LSPServerInfo,
		filePath: string,
		memo?: Map<string, Promise<string | undefined>>,
		onRootFailure?: (reason: string) => void,
	): Promise<string | undefined> {
		if (!memo) return this.resolveServerRoot(server, filePath, onRootFailure);
		const pending = memo.get(server.id);
		if (pending !== undefined) return pending;
		const started = this.resolveServerRoot(server, filePath, onRootFailure);
		memo.set(server.id, started);
		return started;
	}

	async ensureClientForServer(
		filePath: string,
		server: LSPServerInfo,
		resolvedRoots?: Map<string, string>,
		onSpawnInFlight?: (serverId: string) => void,
		onOutcome?: (outcome: LSPClientAcquisitionOutcome) => void,
		rootMemo?: Map<string, Promise<string | undefined>>,
	): Promise<SpawnedServer | undefined> {
		const handoff = this.generationHandoff;
		if (handoff) {
			await handoff;
			if (this.generationHandoff === handoff) {
				this.generationHandoff = undefined;
			}
			if (this.checkDestroyed()) return undefined;
		}

		const root = await this.resolveServerRootOnce(server, filePath, rootMemo);
		if (!root || this.checkDestroyed()) return undefined;
		if (!isAuxiliary(server)) {
			resolvedRoots?.set(server.id, normalizeMapKey(root));
		}
		const allowInstall = this.shouldAllowInstall(server.id);

		const normalizedRoot = normalizeMapKey(root);
		const key = `${server.id}:${normalizedRoot}`;
		if (declinesLooseFileRoot(server, root)) {
			// #4760: a root at or above `$HOME` is too large to walk. Decline BEFORE
			// any process starts, on the policy path (no failure-ladder count, no
			// breaker), with one bounded record per (server, root) per session.
			recordDegradationOnce({
				kind: "lsp-root-declined",
				subject: key,
				reason: `LSP root declined for ${server.id}: root at or above $HOME`,
			});
			this.noteSpawnVerdict(key, "declined");
			return undefined;
		}
		const adopted = this.analysisRootModeForFile(filePath) === "adopted";
		if (adopted) {
			const localCommand =
				server.command ?? server.projectLocalCommand ?? server.availabilityKey;
			const localBinary = localCommand
				? path.isAbsolute(localCommand)
					? isProjectLocalBinPath(localCommand, root)
						? localCommand
						: undefined
					: findLocalBinUpwards(localCommand, root)
				: undefined;
			if (localBinary) {
				recordDegradationOnce({
					kind: "lsp-registry-decision",
					subject: `${server.id}:${normalizeMapKey(root)}`,
					reason: "project-local LSP binary refused for adopted root",
				});
				return undefined;
			}
			this.adoptedClientKeys.add(key);
			if (!this.admitAdoptedRoot(root, filePath)) return undefined;
		}
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

		const existing = this.clients.get(key);
		if (existing) {
			if (existing.isAlive()) {
				this.unavailableLogged.delete(key);
				this.clientLastUsedAt.set(key, Date.now());
				this.scheduleIdleEviction(key, server);
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
			const spawnedAt = this.clientSpawnedAt.get(key);
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
			this.hooks.releaseNotifyWrite(key);
			try {
				await existing.shutdown();
			} catch {
				/* ignore dead client shutdown errors */
			}
			// #3502: the replacement is cold and earns its own readiness verdict.
			this.retireClient(key);
			this.broken.delete(key);

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
					this.broken.set(
						key,
						Math.max(
							this.broken.get(key) ?? 0,
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
					this.broken.set(key, Date.now() + rCooldown);
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

		const brokenUntil = this.broken.get(key);
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
			this.broken.delete(key);
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
		let spawnPromise = this.inFlight.get(key);
		if (!spawnPromise) {
			const started = await this.withClientSpawnGate(async () => {
				const raced = this.inFlight.get(key);
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
				this.inFlight.set(key, promise);
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
			if (this.inFlight.get(key) === spawnPromise) {
				this.inFlight.delete(key);
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
		try {
			if (server.executesProjectCode === true) {
				refuseUntrustedLspExecution({
					kind: "project-code-server",
					serverId: server.id,
					root,
				});
			}
		} catch (error) {
			logSessionStart(
				`lsp spawn ${server.id}: refused — ${error instanceof Error ? error.message : String(error)}`,
			);
			this.noteSpawnVerdict(key, "failed");
			return undefined;
		}
		// Admission is normally performed by compileLspRegistry. Keep this
		// service-side backstop for uncompiled test/host entries so a raw server
		// object cannot bypass the registry's trust decision.
		if (server.trustAllowed !== true && !isLspSpawnAllowedByTrust()) {
			logSessionStart(
				`lsp spawn ${server.id}: refused — ${projectTrustDenialReason()}`,
			);
			this.noteSpawnVerdict(key, "declined");
			return undefined;
		}
		// #4806: a server whose process aborts without a project file below its
		// root (csharp-ls, SIGABRT) is declined BEFORE any process starts, on the
		// policy path like `declinesLooseFileRoot`: no `spawn_failed`, no failure
		// ladder, no breaker, and one record per (server, root) per session.
		if (await declinesProjectlessRoot(server, root)) {
			recordDegradationOnce({
				kind: "lsp-root-declined",
				subject: key,
				reason: `LSP spawn declined for ${server.id}: no project file at or below ${root}`,
			});
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
			const projectCodeAllowed =
				this.analysisRootModeForFile(filePath) !== "adopted";
			const spawned = await withLspProjectCodePermission(
				projectCodeAllowed,
				() =>
					server.spawn(root, {
						allowInstall,
						projectCodeAllowed,
						sessionRoot: this.sessionCwd ?? process.cwd(),
					}),
			);

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
					this.broken.set(key, Date.now() + BROKEN_BASE_COOLDOWN_MS);
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
				this.broken.set(key, Date.now() + uCooldown);
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
			// #4299: the compiler owner's admitted path must survive config
			// merging; otherwise the wrapper can fork a different compiler.
			const mergedInit =
				spawned.launchVariant === "classic"
					? mergeInitializationOptions(
							override?.initializationOptions,
							spawned.initialization,
						)
					: mergeInitializationOptions(
							spawned.initialization,
							override?.initializationOptions,
						);
			// A replacement process is a new first-contact identity even when the
			// configured server id is unchanged. Re-arm both capability latches before
			// the replacement can publish a snapshot.
			this.hooks.rearmFirstContact(server.id);

			const client = await createLSPClient({
				serverId: server.id,
				process: spawned.process,
				root,
				sessionCwd: this.sessionCwd,
				initialization: mergedInit,
				initializeTimeoutMs: server.initializeTimeoutMs,
				launchVariant: spawned.launchVariant,
				// #4764: the declared role travels with the client, so a failed server
				// config can gate an auxiliary scanner's empty publications only.
				role: server.role,
				onDiagnosticsPublished: (serverId) => {
					this.hooks.noteDiagnosticsPublished(serverId);
				},
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

			this.clients.set(key, client);
			// #3502: a verdict cached while no client was registered (a failed
			// spawn's cold warm-up) does not describe this one.
			this.hooks.forgetReadiness(key);
			// #2356: this generation is the replacement the late-coverage probe was
			// waiting for. Clear the retired-generation marker before any later probe.
			this.hooks.clearStallDemotion(key);
			this.unavailableLogged.delete(key);
			// #1934 review F1: a success retires the previous verdict, so the map
			// never outlives the attempts it describes.
			this.lastSpawnVerdict.delete(key);
			this.clientSpawnedAt.set(key, Date.now());
			this.clientLaunchStartedAt.set(key, startedAt);
			this.clientLastUsedAt.set(key, Date.now());
			this.scheduleIdleEviction(key, server);
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
			this.broken.set(key, Date.now() + eCooldown);
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
	 * Check whether the PRIMARY server for this file is currently mid-spawn
	 * (`state.inFlight`, keyed `${server.id}:${normalizeMapKey(root)}` — see
	 * :2413). Lets a caller whose own wait budget expires distinguish "the
	 * server hasn't finished its first spawn yet" from "the server is running
	 * but slow/wedged" (#1766) — a cold spawn still in flight is not a verdict
	 * on a server that doesn't exist yet.
	 *
	 * Mirrors the `!isAuxiliary` filter getClientForFile applies at
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
			if (this.inFlight.has(`${serverId}:${root}`)) return true;
		}
		return false;
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
		return Array.from(this.clients.entries()).map(([key, client]) => {
			const { serverId, root } = parseClientKey(key);
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
		const keys = new Set([...this.broken.keys(), ...this.permanentlyBroken]);
		return [...keys].map((key) => {
			return {
				...parseClientKey(key),
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
				cooldownUntil: this.broken.get(key) ?? 0,
			};
		});
	}

	/**
	 * Count clients that are currently alive (connected and initialized).
	 * Lightweight — does not spawn or wait for anything.
	 */
	getAliveClientCount(): number {
		let count = 0;
		for (const client of this.clients.values()) {
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
		for (const client of this.clients.values()) {
			if (!client.isAlive()) continue;
			const id = client.serverId;
			if (seen.has(id)) continue;
			seen.add(id);
			(isAuxiliary(getServerById(id)) ? aux : primary).push(id);
		}
		return [...primary, ...aux];
	}

	/**
	 * The client half of `LSPService.shutdown`, in its original order: idle
	 * timers, in-flight spawns, the alive count, then every client teardown.
	 * Returns the count of clients alive before teardown, for `lsp_service_reset`.
	 */
	async shutdownClients(options: LSPShutdownOptions): Promise<number> {
		for (const key of this.idleEvictionTimers.keys()) {
			this.clearIdleEvictionTimer(key);
		}

		// Belt-and-braces: wait for any in-flight spawns so that Guard 1/2 in
		// spawnClient can observe isDestroyed and clean up. Skip on the
		// process-exiting path — the event loop is closing and we must not block.
		if (!options.processExiting && this.inFlight.size > 0) {
			const pending = Array.from(this.inFlight.values());
			this.inFlight.clear();
			const settled = await Promise.allSettled(pending);
			for (const result of settled) {
				if (result.status === "fulfilled" && result.value?.client) {
					result.value.client.shutdown({ fast: true }).catch(() => {});
				}
			}
		} else {
			this.inFlight.clear();
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
			Array.from(this.clients.values(), (client) =>
				Promise.resolve().then(() => client.shutdown(options)),
			),
		);
		return aliveClients;
	}

	/** After `lsp_service_reset`: every client generation is gone. */
	clearAfterShutdown(): void {
		this.clients.clear();
		this.broken.clear();
		// #1934 review F1: map hygiene alongside the breaker it sits next to.
		// Not load-bearing — every read follows its own attempt's write — but a
		// verdict for a client generation that no longer exists is dead weight.
		this.lastSpawnVerdict.clear();
		this.workspaceProbeLogged.clear();
		this.warmStartLogged.clear();
	}
}
