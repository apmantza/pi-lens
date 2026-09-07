/**
 * Shared write-plumbing for the hand-rolled NDJSON debug loggers in clients/.
 *
 * One buffered async writer replaces eight drifting copies of append+rotate.
 * `log()`/`append()` are synchronous-call, async-write: they enqueue a
 * serialized line and a single in-flight `fs.promises.appendFile` drains the
 * queue — no `appendFileSync` on the per-edit hot path (latency-logger alone
 * fired ~10–20 sync appends per edit, #454/#361/#368).
 *
 * Errors are swallowed best-effort, matching every current logger. A
 * best-effort SYNC flush is registered on `process.on("exit")` (appendFileSync
 * is fine at exit — not the hot path; no child spawning, #234). Normal drains
 * use promise-based mkdir/append/truncate, while rotation stays synchronous
 * inside the already-deferred drain so it cannot race a flushSync rename. A
 * The shared writer state uses the `NDJSON_GLOBAL_STATE_SCHEMA` protocol:
 * version 1 (the 6a8a0994 shape) is upgraded in place to current version 2,
 * retaining its queues while replacing stale exit flushers. A pre-7e4b9120
 * private-queue shape is fenced rather than adopted, because its queues cannot
 * be migrated safely.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { normalizeFilePath } from "./path-utils.js";
import { redactSecrets } from "./redact/secrets.js";

/** A queued write ("line") or an in-band truncate op (latency clear). */
type QueueItem = { kind: "line"; line: string } | { kind: "truncate" };

export interface NdjsonLoggerOptions {
	/** Absolute log file path, or a lazy resolver (diagnostic-logger keys on the date). */
	filePath: string | (() => string);
	/**
	 * Rotation threshold in bytes. Absent = never rotate (preserves the loggers
	 * that don't rotate today). At/above the threshold the file is renamed to
	 * `<filePath>.1` (previous backup removed first, Windows-safe).
	 */
	maxBytes?: number;
	/** Backup path for rotation. Defaults to `<filePath>.1`. Ignored without maxBytes. */
	backupPath?: string | (() => string);
}

export interface NdjsonLogger {
	/** Serialize `obj`, redact secrets, and enqueue one NDJSON line. */
	log(obj: unknown): void;
	/** Redact and enqueue a serialized line without a trailing newline. */
	append(line: string): void;
	/** Enqueue a truncate op in the same serialized queue (clear-without-racing). */
	truncate(): void;
	/** Resolves once everything enqueued so far is on disk. */
	flush(): Promise<void>;
	/** Best-effort SYNC flush of any buffered lines — safe to call at process exit. */
	flushSync(): void;
}

function resolve(v: string | (() => string)): string {
	return typeof v === "function" ? v() : v;
}

function runBestEffort(operation: () => void): void {
	try {
		operation();
	} catch {
		return;
	}
}

// One shared exit handler flushes every logger — avoids an EventEmitter
// MaxListeners warning once more than ~10 loggers exist (we ship eight, plus
// diagnostic + test instances). No child spawning at teardown (#234).
//
// Keep the registry on globalThis as well as in module state. Vitest can
// re-evaluate this module after vi.resetModules(), and pi can load the source
// and compiled entry through separate module graphs; a module-local guard then
// registers one process listener per graph and recreates the warning. Symbol.for
// gives those graphs one process-wide state without exposing a public global
// property name.
interface NdjsonWriterState {
	file: string;
	maxBytes?: number;
	backupPath?: string;
	queue: QueueItem[];
	drainPromise: Promise<void> | null;
	inFlightBatch: QueueItem[] | null;
	/** Operations to replay after a late in-flight write (truncate ordering). */
	syncRepairItems: QueueItem[] | null;
	ensuredDir: boolean;
	/** One canonical exit flusher per file, never one per logger facade. */
	exitFlusher: () => void;
	/**
	 * Writes that failed even after the reopen-and-retry-once recovery below
	 * (#1970). Process-lifetime, in-memory only — never itself durably logged
	 * from inside this module, so a sink that is failing cannot recurse into
	 * writing a record ABOUT its own failure through the same broken sink.
	 * `degradation-ledger.ts` reads this via `getSinkWriteFailures()` and
	 * folds it into `getDegradationSummary()` at READ time, so the count
	 * reaches `pilens_health` without this module ever performing I/O about
	 * its own I/O failure. Reset at session_start alongside the ledger
	 * (`resetSinkWriteFailures`, catalog shape 17: a process-lifetime latch
	 * must re-arm at session_start).
	 */
	writeFailures: number;
	/**
	 * Best-known on-disk byte size, maintained in memory so the write path
	 * doesn't `fs.statSync` before every single write (#2505). Undefined means
	 * "unknown — needs a real stat before the next rotation decision" (fresh
	 * state, or after a rotation attempt failed and left the on-disk truth
	 * uncertain). Updated cheaply after every successful write/rotate/truncate;
	 * periodically reconciled against the real file via `syncKnownSizeIfDue`
	 * (bounded cadence, not per write) so drift from an external writer to the
	 * same global log (another pi-lens process sharing ~/.pi-lens) self-heals.
	 */
	knownSize: number | undefined;
	/** Writes since `knownSize` was last reconciled with a real `fs.statSync`. */
	writesSinceStatSync: number;
	/** `Date.now()` at the last real `fs.statSync` reconciliation (0 = never). */
	lastStatSyncMs: number;
	/**
	 * Total successful rotations for this file this session. Process-lifetime,
	 * in-memory only, same "pulled at READ time" shape as `writeFailures`
	 * above: `degradation-ledger.ts` already imports THIS module
	 * (`getSinkWriteFailures`), so a reverse import to call
	 * `recordDegradationOnce` directly from here would close a
	 * ndjson-logger.ts <-> degradation-ledger.ts cycle. `getSinkRotations()`
	 * exposes this tally for `degradation-ledger.ts` to fold into
	 * `getDegradationSummary()` at read time instead (see the
	 * `log-sink-rotated` doc comment on `DegradationKind`). Reset at
	 * session_start via `resetSinkRotations()` (catalog shape 17).
	 */
	rotationCount: number;
	/**
	 * Rotation attempts that THREW this session (#2505 review F2). The
	 * original catch swallowed them and only `rotationCount` moved, and
	 * only on success — so a sink that could never rotate (an unwritable
	 * backup path, or the Windows sharing violation another process
	 * holding the file open produces) looked exactly like a healthy one
	 * while its file grew without any bound at all. Pulled at READ time
	 * by `getSinkRotations()`, same as `rotationCount` and for the same
	 * import-cycle reason.
	 */
	rotationFailures: number;
	/**
	 * `Date.now()` before which no further rotation is ATTEMPTED, set
	 * after a failed rename (#2505 review F2). Without it a rename that
	 * cannot succeed is retried by every single write for the rest of the
	 * session. The sink keeps writing during the backoff (dropping lines
	 * would be worse than an oversized file) and says so through the
	 * ledger instead of failing silently.
	 */
	rotationRetryAfterMs: number;
}

const NDJSON_GLOBAL_STATE_SCHEMA = "pi-lens.ndjson-logger.state";
const NDJSON_LEGACY_GLOBAL_STATE_VERSION = 1;
const NDJSON_GLOBAL_STATE_VERSION = 2;

interface NdjsonGlobalState {
	/** Versioned protocol: only states with shared writer queues are adoptable. */
	schema: string;
	version: number;
	writers: Map<string, NdjsonWriterState>;
	exitFlushers: Set<() => void>;
	exitHandlerRegistered: boolean;
	registeredLogFiles: Set<string>;
}

interface LegacyNdjsonGlobalState {
	exitFlushers: Set<() => void>;
	exitHandlerRegistered: boolean;
	registeredLogFiles: Set<string>;
}

const NDJSON_GLOBAL_STATE_KEY = Symbol.for("pi-lens.ndjson-logger.state");
const globalStateHost = globalThis as typeof globalThis & {
	[key: symbol]: unknown;
};
const existingGlobalState = globalStateHost[NDJSON_GLOBAL_STATE_KEY];

function isSharedWriterState(value: unknown): value is NdjsonGlobalState {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<NdjsonGlobalState>;
	const knownSchema =
		candidate.schema === undefined ||
		candidate.schema === NDJSON_GLOBAL_STATE_SCHEMA;
	const knownVersion =
		candidate.version === undefined ||
		candidate.version === NDJSON_LEGACY_GLOBAL_STATE_VERSION ||
		candidate.version === NDJSON_GLOBAL_STATE_VERSION;
	return (
		knownSchema &&
		knownVersion &&
		candidate.writers instanceof Map &&
		candidate.exitFlushers instanceof Set &&
		candidate.registeredLogFiles instanceof Set &&
		typeof candidate.exitHandlerRegistered === "boolean"
	);
}

function isLegacyGlobalState(value: unknown): value is LegacyNdjsonGlobalState {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<LegacyNdjsonGlobalState>;
	return (
		candidate.exitFlushers instanceof Set &&
		candidate.registeredLogFiles instanceof Set &&
		typeof candidate.exitHandlerRegistered === "boolean"
	);
}

let ndjsonGlobalState: NdjsonGlobalState | undefined;
let legacyGlobalState: LegacyNdjsonGlobalState | undefined;
if (isSharedWriterState(existingGlobalState)) {
	// The 7e4b9120 graph had no version marker and 6a8a0994 used version 1.
	// Both shapes are bridgeable: retain their queues, but replace every stale
	// exit flusher with a closure from this module graph. A current state is
	// left untouched so it keeps exactly one canonical flusher per writer.
	const needsFlusherMigration =
		existingGlobalState.schema !== NDJSON_GLOBAL_STATE_SCHEMA ||
		existingGlobalState.version !== NDJSON_GLOBAL_STATE_VERSION;
	if (needsFlusherMigration) {
		for (const state of existingGlobalState.writers.values()) {
			const staleExitFlusher = state.exitFlusher;
			const currentExitFlusher = () => flushStateSync(state);
			state.exitFlusher = currentExitFlusher;
			existingGlobalState.exitFlushers.delete(staleExitFlusher);
			existingGlobalState.exitFlushers.add(currentExitFlusher);
		}
	}
	existingGlobalState.schema = NDJSON_GLOBAL_STATE_SCHEMA;
	existingGlobalState.version = NDJSON_GLOBAL_STATE_VERSION;
	ndjsonGlobalState = existingGlobalState;
} else if (existingGlobalState === undefined) {
	ndjsonGlobalState = globalStateHost[NDJSON_GLOBAL_STATE_KEY] = {
		schema: NDJSON_GLOBAL_STATE_SCHEMA,
		version: NDJSON_GLOBAL_STATE_VERSION,
		writers: new Map<string, NdjsonWriterState>(),
		exitFlushers: new Set<() => void>(),
		exitHandlerRegistered: false,
		registeredLogFiles: new Set<string>(),
	};
} else if (isLegacyGlobalState(existingGlobalState)) {
	// Do not mutate or replace this state: its private queues and exit flusher
	// closures are not observable, so adopting it would falsely claim safety.
	// New facades fail closed in requireCurrentGlobalState().
	legacyGlobalState = existingGlobalState;
}

const exitFlushers: Set<() => void> =
	ndjsonGlobalState?.exitFlushers ??
	legacyGlobalState?.exitFlushers ??
	new Set<() => void>();
const registeredLogFiles: Set<string> =
	ndjsonGlobalState?.registeredLogFiles ??
	legacyGlobalState?.registeredLogFiles ??
	new Set<string>();

/** Test-only view of the canonical per-file exit flushers (see ndjson-logger.test.ts). */
export function _exitFlushersForTest(): ReadonlySet<() => void> {
	return exitFlushers;
}

// Auto-derived retention coverage (clients/log-cleanup.ts): every *static*
// filePath a createNdjsonLogger instance is constructed with self-registers
// here at module-load time — the moment latency-logger.ts, bus-events-logger.ts,
// etc. call createNdjsonLogger(), the sweep in log-cleanup.ts picks the file up
// automatically. No second hand-maintained list to forget (the exact mistake
// that left actionable-warnings/ast-grep-tools/dead-code, then bus-events.log,
// unrotated — see log-cleanup.ts's module doc).
//
// A *lazy* filePath (a resolver function, e.g. diagnostic-logger's date-keyed
// `logs/{date}.jsonl`) is deliberately NOT registered: those already live
// under the `logs/` subdirectory and are covered by log-cleanup's separate
// `*.jsonl` daily-log sweep, not the single-file rotation list.
/** Every absolute path registered by a static-filePath createNdjsonLogger instance. */
export function getRegisteredLogFiles(): ReadonlySet<string> {
	return registeredLogFiles;
}

export interface SinkWriteFailureSummary {
	/** Canonicalized absolute path of the sink that lost writes. */
	file: string;
	/** Writes that failed even after the reopen-and-retry-once recovery (#1970). */
	droppedCount: number;
}

/**
 * Snapshot of unrecovered write losses, one entry per sink that has any
 * (#1970). Pure in-memory read — no I/O, so a caller (`degradation-ledger.ts`)
 * can fold this into a durable ledger entry without this module ever writing
 * a record about its own failure through the sink that is failing. See
 * `NdjsonWriterState.writeFailures` for the recursion-hazard rationale.
 */
export function getSinkWriteFailures(): SinkWriteFailureSummary[] {
	if (!ndjsonGlobalState) return [];
	const result: SinkWriteFailureSummary[] = [];
	for (const state of ndjsonGlobalState.writers.values()) {
		if (state.writeFailures > 0) {
			result.push({ file: state.file, droppedCount: state.writeFailures });
		}
	}
	return result;
}

/**
 * Session-boundary reset (catalog shape 17: a process-lifetime latch must
 * re-arm at session_start). Wired into `resetDegradationLedger()` so both
 * reset together; also used directly by tests.
 */
export function resetSinkWriteFailures(): void {
	if (!ndjsonGlobalState) return;
	for (const state of ndjsonGlobalState.writers.values())
		state.writeFailures = 0;
}

export interface SinkRotationSummary {
	/** Canonicalized absolute path of the sink. */
	file: string;
	/** Successful rotations this session (#2505). */
	rotationCount: number;
	/**
	 * Rotation attempts that threw this session (#2505 review F2).
	 * Non-zero means the sink could NOT bound itself: the file is still
	 * growing past `maxBytes` and only this counter says so.
	 */
	failureCount: number;
}

/**
 * Snapshot of mid-session rotations, one entry per sink that has rotated
 * at least once (#2505). Pure in-memory read — no I/O — so a caller
 * (`degradation-ledger.ts`) can fold this into a durable ledger entry the
 * same way it folds `getSinkWriteFailures()`, without this module importing
 * the ledger back (see `NdjsonWriterState.rotationCount`'s doc comment).
 */
export function getSinkRotations(): SinkRotationSummary[] {
	if (!ndjsonGlobalState) return [];
	const result: SinkRotationSummary[] = [];
	for (const state of ndjsonGlobalState.writers.values()) {
		if (state.rotationCount > 0 || state.rotationFailures > 0) {
			result.push({
				file: state.file,
				rotationCount: state.rotationCount,
				failureCount: state.rotationFailures,
			});
		}
	}
	return result;
}

/**
 * Session-boundary reset (catalog shape 17), same shape as
 * `resetSinkWriteFailures`. Wired into `resetDegradationLedger()`.
 */
export function resetSinkRotations(): void {
	if (!ndjsonGlobalState) return;
	for (const state of ndjsonGlobalState.writers.values()) {
		state.rotationCount = 0;
		state.rotationFailures = 0;
		state.rotationRetryAfterMs = 0;
	}
}

function requireCurrentGlobalState(): NdjsonGlobalState {
	if (ndjsonGlobalState) return ndjsonGlobalState;
	throw new Error(
		"createNdjsonLogger: incompatible module graph state; a pre-7e4b9120 " +
			"logger graph may still own private queues. Restart the process before " +
			"loading the current logger graph",
	);
}

function registerWriter(state: NdjsonWriterState): void {
	const globalState = requireCurrentGlobalState();
	if (!exitFlushers.has(state.exitFlusher)) exitFlushers.add(state.exitFlusher);
	if (!globalState.exitHandlerRegistered) {
		globalState.exitHandlerRegistered = true;
		process.on("exit", () => {
			for (const flush of exitFlushers) runBestEffort(flush);
		});
	}
}

function normalizeLogPath(file: string): string {
	return normalizeFilePath(path.resolve(file));
}

function assertCompatibleWriterOptions(
	existing: NdjsonWriterState,
	maxBytes?: number,
	backupPath?: string,
): void {
	if (existing.maxBytes === maxBytes && existing.backupPath === backupPath)
		return;
	throw new Error(
		`createNdjsonLogger: incompatible options for shared path ${existing.file}; ` +
			`the first writer's maxBytes/backupPath must be reused`,
	);
}

function writeQueueItemSync(state: NdjsonWriterState, item: QueueItem): void {
	if (item.kind === "truncate") {
		fs.writeFileSync(state.file, "");
		noteTruncated(state);
	} else {
		// One line, so the batch cap has nothing to cap: the plan is only
		// ever "rotate first if this line no longer fits".
		const plan = planBoundedWrite(state, [item.line]);
		fs.appendFileSync(state.file, plan.joined);
		noteWriteSucceeded(state, plan.bytes);
	}
}

/**
 * The pi-analyze #15 shape (#1970): a write that throws — including the
 * `ERR_STREAM_DESTROYED` a torn-down sink produces — gets one reopen-and-
 * retry before it counts as a loss. There is no persistent handle to close
 * here (every write already opens, writes, and closes in one call), so
 * "reopen" means dropping the cached `ensuredDir` assumption and
 * re-verifying the parent directory before the retry — the one piece of
 * cross-write state this module holds that a destroyed sink could have
 * invalidated. An unrecovered write is counted, never thrown or retried a
 * second time (`applyQueueItemSync`, `applyQueueItemAsync`, and the batched
 * write in `drainLoop` skip DIFFERENT amounts of work per queue item, so
 * each keeps its own copy of this two-step shape rather than sharing one
 * generic retry wrapper across sync/async).
 */
function applyQueueItemSync(state: NdjsonWriterState, item: QueueItem): void {
	ensureDirSync(state);
	try {
		writeQueueItemSync(state, item);
		return;
	} catch {
		// fall through to the one reopen-and-retry
	}
	state.ensuredDir = false;
	ensureDirSync(state);
	try {
		writeQueueItemSync(state, item);
	} catch {
		state.writeFailures += 1;
	}
}

function flushStateSync(state: NdjsonWriterState): void {
	// Drain the in-memory queue synchronously — safe at process exit.
	// The in-flight async batch is INCLUDED even though its appendFile may
	// also land: if the process dies before the threadpool issues that
	// write, skipping the prefix would drop the whole batch. The per-line
	// writer deliberately traded duplicate lines at exit for never-drops
	// (#935 review) — keep that trade. If a late in-flight append crosses a
	// truncate, the post-truncate operations are replayed after that append
	// completes so pre-truncate data cannot be reintroduced.
	const inFlight = state.inFlightBatch;
	const inFlightAtHead =
		inFlight !== null &&
		inFlight.every((item, index) => state.queue[index] === item);
	const repairStart = inFlightAtHead
		? inFlight?.[0]?.kind === "truncate"
			? 0
			: state.queue.findIndex((item) => item.kind === "truncate")
		: -1;
	if (state.syncRepairItems) {
		state.syncRepairItems.push(...state.queue);
	} else if (repairStart >= 0) {
		state.syncRepairItems = state.queue.slice(repairStart);
	}

	while (state.queue.length > 0) {
		const item = state.queue.shift() as QueueItem;
		applyQueueItemSync(state, item);
	}
}

function createWriterState(
	file: string,
	maxBytes?: number,
	backupPath?: string,
): NdjsonWriterState {
	const globalState = requireCurrentGlobalState();
	const existing = globalState.writers.get(file);
	if (existing) {
		// A partially initialized global state from another graph still needs to
		// be enrolled, but it must never get a second queue or exit flusher.
		assertCompatibleWriterOptions(existing, maxBytes, backupPath);
		if (!exitFlushers.has(existing.exitFlusher)) registerWriter(existing);
		// A state adopted from a pre-#1970 module graph predates this field.
		if (typeof existing.writeFailures !== "number") existing.writeFailures = 0;
		// A state adopted from a pre-#2505 module graph predates these fields.
		// (`knownSize` itself needs no adoption shim: its type is
		// `number | undefined`, so a value that is neither is unreachable —
		// #2515 review S2.)
		if (typeof existing.writesSinceStatSync !== "number")
			existing.writesSinceStatSync = 0;
		if (typeof existing.lastStatSyncMs !== "number")
			existing.lastStatSyncMs = 0;
		if (typeof existing.rotationCount !== "number") existing.rotationCount = 0;
		if (typeof existing.rotationFailures !== "number")
			existing.rotationFailures = 0;
		if (typeof existing.rotationRetryAfterMs !== "number")
			existing.rotationRetryAfterMs = 0;
		return existing;
	}

	const state = {} as NdjsonWriterState;
	state.file = file;
	state.maxBytes = maxBytes;
	state.backupPath = backupPath;
	state.queue = [];
	state.drainPromise = null;
	state.inFlightBatch = null;
	state.syncRepairItems = null;
	state.ensuredDir = false;
	state.exitFlusher = () => flushStateSync(state);
	state.writeFailures = 0;
	state.knownSize = undefined;
	state.writesSinceStatSync = 0;
	state.lastStatSyncMs = 0;
	state.rotationCount = 0;
	state.rotationFailures = 0;
	state.rotationRetryAfterMs = 0;
	globalState.writers.set(file, state);
	registerWriter(state);
	return state;
}

function ensureDirSync(state: NdjsonWriterState): void {
	if (state.ensuredDir) return;
	runBestEffort(() => {
		fs.mkdirSync(path.dirname(state.file), { recursive: true });
		state.ensuredDir = true;
	});
}

async function ensureDirAsync(state: NdjsonWriterState): Promise<void> {
	if (state.ensuredDir) return;
	try {
		await fs.promises.mkdir(path.dirname(state.file), { recursive: true });
		state.ensuredDir = true;
	} catch {
		// telemetry is best-effort
	}
}

// Rotation-check cadence (#2505): the real `fs.statSync` reconciliation below
// is throttled to at most once per this many writes OR this many elapsed ms,
// whichever comes first — never once per individual write. Between
// reconciliations, `state.knownSize` (updated cheaply, no I/O, after every
// successful write) is trusted. A short window in both axes bounds how far a
// concurrent writer to the same global log (another pi-lens process sharing
// ~/.pi-lens) can drift `knownSize` from the real file before the next
// reconciliation self-heals it.
const ROTATION_STAT_RESYNC_WRITES = 25;
const ROTATION_STAT_RESYNC_MS = 2_000;

/** Reconcile `state.knownSize` with a real stat, gated by the cadence above. */
function syncKnownSizeIfDue(state: NdjsonWriterState, now: number): void {
	const due =
		state.knownSize === undefined ||
		state.writesSinceStatSync >= ROTATION_STAT_RESYNC_WRITES ||
		now - state.lastStatSyncMs >= ROTATION_STAT_RESYNC_MS;
	if (!due) return;
	state.writesSinceStatSync = 0;
	state.lastStatSyncMs = now;
	try {
		state.knownSize = fs.statSync(state.file).size;
	} catch {
		// No file yet (first write) or a transient stat error — treat as
		// empty; the next successful write/rotate re-establishes the truth.
		state.knownSize = 0;
	}
}

/**
 * A rotation attempt that FAILS (an unwritable backup path, or the Windows
 * sharing violation another process holding the file open produces) must not
 * be re-attempted by every subsequent write: that is a syscall storm that
 * never succeeds. After a failure the next attempt is deferred by this many
 * ms. The sink keeps writing during the window — dropping lines would be a
 * worse trade than an oversized file — and the failure is reported through
 * `getSinkRotations()` as `log-sink-rotate-failed`, so an unbounded log is
 * visible in `pilens_health` instead of silent (#2505 review F2).
 */
const ROTATION_FAILURE_BACKOFF_MS = 10_000;

/**
 * Move the active file aside, and report whether that actually happened.
 *
 * The in-memory size check that gets us here is deliberately cheap and
 * therefore fallible: another process writing the SAME global log (a pi
 * session and the warm MCP server share one global read-guard.log) moves the
 * real file under us, so a cached size can be stale in either direction.
 * Believing a stale-HIGH size is destructive, not merely wasteful — it
 * force-removes the other process backup and renames that process freshly
 * rotated (tiny) file on top of it, losing real log data. So the decision is
 * CONFIRMED against a real stat here, on the rare path where a rotation is
 * believed due, instead of on the hot path where every write would pay for
 * it (#2505 review F4).
 */
function rotateNow(
	state: NdjsonWriterState,
	incomingBytes: number,
	now: number,
): boolean {
	if (state.maxBytes === undefined) return false;
	if (now < state.rotationRetryAfterMs) return false;
	let actualSize: number;
	try {
		actualSize = fs.statSync(state.file).size;
	} catch {
		// No file yet — nothing to rotate, and the next write creates it.
		state.knownSize = 0;
		state.writesSinceStatSync = 0;
		state.lastStatSyncMs = now;
		return false;
	}
	state.knownSize = actualSize;
	state.writesSinceStatSync = 0;
	state.lastStatSyncMs = now;
	// The real file disagrees with the cached belief: nothing to do. This is
	// the cross-process case above, and declining here is exactly what
	// preserves the other process backup.
	if (actualSize === 0) return false;
	if (actualSize + incomingBytes < state.maxBytes) return false;
	const backup = state.backupPath ?? `${state.file}.1`;
	try {
		runBestEffort(() => fs.rmSync(backup, { force: true }));
		fs.renameSync(state.file, backup);
	} catch {
		// The rename failed and the file is still there at `actualSize` (which
		// `knownSize` now holds — no guessing, the stat above just confirmed
		// it). Counted rather than swallowed so `log-sink-rotate-failed` can
		// surface an unbounded sink, and backed off so the next write does not
		// re-run the same failing syscall.
		state.rotationFailures += 1;
		state.rotationRetryAfterMs = now + ROTATION_FAILURE_BACKOFF_MS;
		return false;
	}
	state.knownSize = 0;
	state.rotationCount += 1;
	state.rotationRetryAfterMs = 0;
	return true;
}

/** What one append may write without breaking the byte bound (#2505). */
interface BoundedWritePlan {
	/** How many of the offered lines this write takes (always >= 1). */
	count: number;
	/** Those lines, concatenated. */
	joined: string;
	/** Byte length of `joined`. */
	bytes: number;
}

function takeAll(lines: string[]): BoundedWritePlan {
	const joined = lines.join("");
	return { count: lines.length, joined, bytes: Buffer.byteLength(joined) };
}

/**
 * Decide what this append writes, rotating first when the file already on
 * disk leaves no room. Two things have to hold, and the pre-#2505 write path
 * did neither:
 *
 *  1. The bound is checked against the size this write PRODUCES, not only
 *     the size already on disk — otherwise the write that crosses the bound
 *     is always allowed through and only the NEXT one rotates (one write
 *     late), which on a long-lived or idle-tailed session (the warm MCP
 *     server never re-runs the session-start sweep in `log-cleanup.ts`) may
 *     be a long time or never.
 *  2. The batch ITSELF is capped at the bound. Rotation only ever moves
 *     PRE-EXISTING content aside, so an oversized batch written whole into
 *     an empty (or just-rotated) file lands past the bound with nothing left
 *     to rotate away: a 500-line drain against a 1KB bound landed at ~107KB,
 *     106x over, with zero rotations. Capping makes the drain loop come back
 *     around for the remainder instead.
 *
 * A single NDJSON line is atomic and cannot be split, so at least one line
 * is always taken: the enforced invariant is "the bound plus at most one
 * line", never "the bound plus an unbounded batch".
 */
function planBoundedWrite(
	state: NdjsonWriterState,
	lines: string[],
): BoundedWritePlan {
	if (state.maxBytes === undefined || lines.length === 0) return takeAll(lines);
	const now = Date.now();
	syncKnownSizeIfDue(state, now);
	state.writesSinceStatSync += 1;
	const firstBytes = Buffer.byteLength(lines[0] ?? "");
	let known = state.knownSize ?? 0;
	if (known > 0 && known + firstBytes >= state.maxBytes) {
		rotateNow(state, firstBytes, now);
		known = state.knownSize ?? 0;
		if (known > 0 && known + firstBytes >= state.maxBytes) {
			// Rotation is unavailable (a failing rename, or its backoff window).
			// Capping cannot bound a file that cannot be rotated — it would only
			// shred each drain into one append per line for the rest of the
			// window. Write the whole batch; the reason the bound is not holding
			// is reported through `log-sink-rotate-failed`.
			return takeAll(lines);
		}
	}
	let bytes = 0;
	let count = 0;
	for (const line of lines) {
		const lineBytes = Buffer.byteLength(line);
		if (count > 0 && known + bytes + lineBytes >= state.maxBytes) break;
		bytes += lineBytes;
		count += 1;
	}
	if (count === lines.length) return takeAll(lines);
	return { count, joined: lines.slice(0, count).join(""), bytes };
}

/** Cheap in-memory bookkeeping after a write actually lands (#2505). */
function noteWriteSucceeded(state: NdjsonWriterState, bytes: number): void {
	if (state.maxBytes === undefined) return;
	state.knownSize = (state.knownSize ?? 0) + bytes;
}

/** The file is now definitively empty — no guessing needed (#2505). */
function noteTruncated(state: NdjsonWriterState): void {
	if (state.maxBytes === undefined) return;
	state.knownSize = 0;
	state.writesSinceStatSync = 0;
	state.lastStatSyncMs = Date.now();
}

async function writeQueueItemAsync(
	state: NdjsonWriterState,
	item: QueueItem,
): Promise<void> {
	if (item.kind === "truncate") {
		await fs.promises.writeFile(state.file, "");
		noteTruncated(state);
	} else {
		// Rotation is deliberately synchronous here. This function is only
		// reached from the already-deferred drain, and keeping stat/rm/rename
		// in one synchronous section prevents flushSync from racing a late
		// async rename after it has written new data.
		const plan = planBoundedWrite(state, [item.line]);
		await fs.promises.appendFile(state.file, plan.joined);
		noteWriteSucceeded(state, plan.bytes);
	}
}

/** See `applyQueueItemSync`'s doc comment for the reopen-and-retry-once shape. */
async function applyQueueItemAsync(
	state: NdjsonWriterState,
	item: QueueItem,
): Promise<void> {
	await ensureDirAsync(state);
	try {
		await writeQueueItemAsync(state, item);
		return;
	} catch {
		// fall through to the one reopen-and-retry
	}
	state.ensuredDir = false;
	await ensureDirAsync(state);
	try {
		await writeQueueItemAsync(state, item);
	} catch {
		state.writeFailures += 1;
	}
}

async function drainLoop(state: NdjsonWriterState): Promise<void> {
	// Peek, write, then remove — an item stays in the queue until it is on
	// disk, so a teardown flushSync (which abandons this async loop) never
	// drops an item this loop had already dequeued but not yet written.
	while (state.queue.length > 0) {
		const item = state.queue[0];
		await ensureDirAsync(state);
		const truncateIndex =
			item.kind === "line"
				? state.queue.findIndex((queued) => queued.kind === "truncate")
				: 0;
		const pendingEnd =
			truncateIndex === -1 ? state.queue.length : truncateIndex;
		const offered =
			item.kind === "truncate" ? [item] : state.queue.slice(0, pendingEnd);
		// Rotation and the batch cap are decided synchronously, BEFORE this
		// batch is published as in-flight: rotation stays inside the already-
		// deferred drain (only the append remains async), so no awaited
		// rotation step can run after flushSync has written to the active file.
		const plan =
			item.kind === "truncate"
				? null
				: planBoundedWrite(
						state,
						offered.map(
							(queued) => (queued as { kind: "line"; line: string }).line,
						),
					);
		// Only the lines the plan actually takes belong to THIS write. A batch
		// that would itself cross `maxBytes` is cut at the bound and the loop
		// comes back around for the remainder (#2505) — writing it whole would
		// sail past a bound that rotation cannot recover, because rotation only
		// moves pre-existing content aside.
		const pending = plan === null ? offered : offered.slice(0, plan.count);
		state.inFlightBatch = pending;
		const writeBatch = async (): Promise<void> => {
			if (plan === null) {
				await fs.promises.writeFile(state.file, "");
				noteTruncated(state);
			} else {
				await fs.promises.appendFile(state.file, plan.joined);
				noteWriteSucceeded(state, plan.bytes);
			}
		};
		try {
			await writeBatch();
		} catch {
			// Reopen-and-retry once (#1970, pi-analyze #15 shape): a destroyed
			// sink (ERR_STREAM_DESTROYED) or a directory that vanished mid-session
			// gets exactly one recovery attempt before the batch counts as a loss.
			state.ensuredDir = false;
			await ensureDirAsync(state);
			try {
				await writeBatch();
			} catch {
				// Unrecovered: count every line in this batch as dropped. Purely
				// in-memory — see `writeFailures`'s doc comment for why this must
				// never itself attempt a durable write through this same sink.
				state.writeFailures += pending.length;
			}
		}
		for (const written of pending) {
			// flushSync may have drained this prefix while the append is in
			// flight. Never remove newer items from a later enqueue.
			if (state.queue[0] !== written) break;
			state.queue.shift();
		}
		if (state.inFlightBatch === pending) {
			state.inFlightBatch = null;
			const repairItems = state.syncRepairItems;
			state.syncRepairItems = null;
			if (repairItems) {
				for (const repairItem of repairItems) {
					await applyQueueItemAsync(state, repairItem);
				}
			}
		}
	}
}

function drain(state: NdjsonWriterState): Promise<void> {
	// Serialize: a single in-flight drain owns the canonical per-file queue.
	// This guard lives in global state, so module re-evaluation cannot create a
	// second drainer for the same path.
	if (!state.drainPromise) {
		state.drainPromise = Promise.resolve()
			.then(() => drainLoop(state))
			.finally(() => {
				state.drainPromise = null;
			});
	}
	return state.drainPromise;
}

export function createNdjsonLogger(options: NdjsonLoggerOptions): NdjsonLogger {
	const states = new Set<NdjsonWriterState>();
	// Static logger paths are canonicalized once. Lazy diagnostic paths are
	// resolved at enqueue time, but each resolved raw path is canonicalized only
	// once (normally once per date), keeping realpath work off the hot path.
	const canonicalPaths = new Map<string, string>();
	const staticFile =
		typeof options.filePath === "string"
			? normalizeLogPath(options.filePath)
			: undefined;
	const staticBackupPath =
		typeof options.backupPath === "string" && options.maxBytes !== undefined
			? normalizeLogPath(options.backupPath)
			: undefined;

	function canonicalPath(file: string): string {
		const raw = path.resolve(file);
		const cached = canonicalPaths.get(raw);
		if (cached) return cached;
		const normalized = normalizeLogPath(raw);
		canonicalPaths.set(raw, normalized);
		return normalized;
	}

	function stateForCall(): NdjsonWriterState {
		const file = staticFile ?? canonicalPath(resolve(options.filePath));
		const backupPath =
			options.maxBytes !== undefined && options.backupPath
				? (staticBackupPath ?? canonicalPath(resolve(options.backupPath)))
				: undefined;
		const state = createWriterState(file, options.maxBytes, backupPath);
		states.add(state);
		return state;
	}

	if (staticFile !== undefined) {
		const state = stateForCall();
		registeredLogFiles.add(state.file);
	}

	function enqueue(item: QueueItem): void {
		const state = stateForCall();
		state.queue.push(item);
		void drain(state);
	}

	return {
		log(obj: unknown): void {
			const serialized = String(JSON.stringify(obj));
			enqueue({
				kind: "line",
				line: `${redactSecrets(serialized)}\n`,
			});
		},
		append(line: string): void {
			enqueue({ kind: "line", line: `${redactSecrets(line)}\n` });
		},
		truncate(): void {
			enqueue({ kind: "truncate" });
		},
		async flush(): Promise<void> {
			await Promise.all([...states].map((state) => drain(state)));
		},
		flushSync(): void {
			for (const state of states) flushStateSync(state);
		},
	};
}
