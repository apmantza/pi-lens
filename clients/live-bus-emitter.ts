/**
 * Persistent NDJSON trace of `pi.events` bus publish attempts
 * (`pilens:files:touched` #482 / `pilens:diagnostics` #502 /
 * `pilens:diagnostic:disposition` / `pilens:format:queued` +
 * `pilens:format:start` + `pilens:format:done` + `pilens:autofix:start` #673/#684 /
 * `pi-lens/analysis-complete` + `pi-lens/findings` + `pi-lens/turn-findings`
 * #1415) — ten event names across five producers.
 *
 * All five producers (clients/bus-publish.ts, clients/diagnostics-publish.ts,
 * clients/disposition-publish.ts, clients/format-events-publish.ts,
 * clients/lens-events.ts) are fire-and-forget: on failure or on a structural
 * no-op (never wired, kill switch off) the four #482/#502/#673/#684
 * producers only invoke an optional `dbg` callback, which varies by host and
 * is a documented no-op in the MCP host (clients/mcp/session.ts's
 * `dbg: noop`); `lens-events.ts` (#1415) has no `dbg` param at all — its
 * events are purely observational inter-extension telemetry, so this NDJSON
 * trace is its ONLY failure-visible surface. Either way, that leaves
 * bus-publish outcomes invisible in exactly the context where they matter
 * most — same failure shape as the #544 MCP session_start incident this repo
 * already fixed once.
 *
 * This module gives bus events the same durable trace every other pi-lens
 * subsystem already has (latency.log, cascade.log, read-guard.log, ...) —
 * see clients/latency-logger.ts for the house pattern this mirrors exactly:
 * one shared `createNdjsonLogger` writer, `isTestMode()` no-op guard.
 *
 * Logging volume: `emitted` and `emit_failed` are logged on every call —
 * they're the two outcomes an operator actually needs a per-event trace for.
 * `skipped_unwired` and `skipped_disabled` are process-lifetime-static facts
 * (wiring happens once at extension factory time; the kill switch is an env
 * var read once at startup) — logging them on every publish attempt would
 * spam one identical line per write batch for an entire session with zero
 * new information after the first. Both are gated log-once-per-process, the
 * same `hasLoggedFailure` shape the producers already use for emit_failed.
 * `skipped_stale_session` is an info-level per-occurrence outcome: the emit
 * seam intentionally declined a target whose associated ctx was confirmed
 * stale, so it is neither a bus failure nor input for the smells rollup.
 * The empty-batch branch (`paths.length === 0` / `files.length === 0`) is
 * NOT logged at all: every call site already guards against invoking these
 * functions with nothing to report (see clients/pipeline.ts,
 * clients/runtime-agent-end.ts), so it's a normal, frequent no-op rather
 * than a real event worth a log line.
 */
import * as path from "node:path";
import { isTestMode } from "./env-utils.js";
import { getGlobalPiLensLogDir } from "./probe-home-state.js";
import { createNdjsonLogger } from "./ndjson-logger.js";
import { getMaxLogSizeMB } from "./log-cleanup.js";
import { logLatency } from "./latency-logger.js";

const BUS_EVENTS_LOG_FILE = path.join(
	getGlobalPiLensLogDir(),
	"bus-events.log",
);

const writer = createNdjsonLogger({
	filePath: BUS_EVENTS_LOG_FILE,
	maxBytes: getMaxLogSizeMB() * 1024 * 1024,
});

type BusEventName =
	| "pilens:files:touched"
	| "pilens:diagnostics"
	| "pilens:diagnostic:disposition"
	| "pilens:format:queued"
	| "pilens:format:start"
	| "pilens:format:done"
	| "pilens:autofix:start"
	| "pi-lens/analysis-complete"
	| "pi-lens/findings"
	| "pi-lens/turn-findings";

type BusEventOutcome =
	| "emitted"
	| "skipped_unwired"
	| "skipped_disabled"
	| "skipped_stale_session"
	| "emit_failed";

export interface BusEventLogEntry {
	ts: string;
	event: BusEventName;
	outcome: BusEventOutcome;
	level?: "info";
	cwd: string;
	/** paths.length (files:touched) / files.length (diagnostics), for `emitted`. */
	fileCount?: number;
	/** FilesTouchedReason, when applicable (files:touched only). */
	reason?: string;
	/** The pi-lens writer that produced a files:touched correlation record. */
	writer?: "pi-lens";
	/** Bounded normalized paths for correlating writes with drift records. */
	paths?: string[];
	/** Diagnostics seq, when applicable (diagnostics only, `emitted`). */
	seq?: number;
	/** emit_failed detail. */
	error?: string;
	/** Which event ctx source backed stale/failure classification. */
	ctxSource?: "own" | "global-fallback" | "unwired";
}

// S2d (gap 5, #1432 review): a per-event-name {emitted, skipped_stale_session,
// emit_failed} rollup, counted at this shared seam so every producer AND
// `resolveLiveBusEmitter`'s own `skipped_stale_session` write (the seam
// exception documented in bus-producer-coverage.test.ts) are covered without
// touching each producer individually. In-memory only — bounded by the fixed
// set of event names in `BusEventName`, reset at session_shutdown after the
// rollup row is logged (see index.ts) so counts never leak across sessions.
type BusEventRollupOutcome =
	| "emitted"
	| "skipped_stale_session"
	| "emit_failed";
const eventRollupCounts = new Map<
	BusEventName,
	Record<BusEventRollupOutcome, number>
>();

function bumpRollupCount(
	event: BusEventName,
	outcome: BusEventRollupOutcome,
): void {
	const existing = eventRollupCounts.get(event) ?? {
		emitted: 0,
		skipped_stale_session: 0,
		emit_failed: 0,
	};
	existing[outcome] += 1;
	eventRollupCounts.set(event, existing);
}

function logBusEvent(entry: Omit<BusEventLogEntry, "ts">): void {
	if (
		entry.outcome === "emitted" ||
		entry.outcome === "skipped_stale_session" ||
		entry.outcome === "emit_failed"
	) {
		bumpRollupCount(entry.event, entry.outcome);
	}
	if (isTestMode()) {
		return;
	}
	writer.log({ ts: new Date().toISOString(), ...entry });
}

/** Snapshot the current session's rollup, keyed by event name. Non-mutating —
 *  pair with {@link resetBusEventRollupCounts} at session end. */
export function getBusEventRollupCounts(): Record<
	string,
	Record<BusEventRollupOutcome, number>
> {
	return Object.fromEntries(eventRollupCounts);
}

/** Clear the rollup — call once the session-end snapshot has been logged
 *  (or from tests) so a new session starts from zero. */
export function resetBusEventRollupCounts(): void {
	eventRollupCounts.clear();
}

/**
 * Log one `session_end_bus_rollup` latency row per event NAME that had any
 * activity this session, then clear the rollup. Called from index.ts's
 * `session_shutdown` handler (the session-end hook this repo's other
 * teardown work — LSP fleet shutdown, cache-prefix eviction — already runs
 * from). A no-op (logs nothing) when nothing was ever published, matching
 * `formatSmellsSessionStartLine`'s "no noise on an ordinary session" shape.
 */
export function emitBusEventRollupAtSessionEnd(cwd: string): void {
	for (const [event, counts] of eventRollupCounts) {
		logLatency({
			type: "phase",
			phase: "session_end_bus_rollup",
			filePath: cwd,
			durationMs: 0,
			metadata: { event, ...counts },
		});
	}
	resetBusEventRollupCounts();
}

import { recordDegradation } from "./degradation-ledger.js";
import { probeCtxActive } from "./session-lifecycle.js";
import { normalizeFilePath } from "./path-utils.js";

/** Resolve a pi event-bus emitter and its ctx at delivery time, not
 * subscription time. */
export type BusEmitFn = (channel: string, data: unknown) => void;
interface BusEmitTarget {
	emit: BusEmitFn;
	/**
	 * Required (L3, #1415 review): every `BusEmitTarget` wiring must pair its
	 * emitter with the ctx it belongs to, or use the bare-function
	 * `BusEmitFn` union arm instead (which the resolver treats as ctxless by
	 * construction, not by an omitted field). Making `ctx` optional here let a
	 * wiring forget it silently — the stale-session guard would then never
	 * fire for that target. A caller with no ctx to pair should reach for the
	 * `BusEmitFn` arm, not `{ emit, ctx: undefined }`.
	 */
	ctx: unknown;
}
export type BusEmitGetter = () => BusEmitFn | BusEmitTarget | undefined;
export type BusEmitResolution =
	| { outcome: "ready"; emit: BusEmitFn; ctxSource: "own" | "global-fallback" }
	| { outcome: "unwired"; ctxSource: "unwired" }
	| { outcome: "stale-session"; ctxSource: "own" };

export interface LiveBusEmitter {
	wire(emit: BusEmitFn | undefined): void;
	wireGetter(getter: BusEmitGetter | undefined): void;
	resolve(): BusEmitResolution;
	reset(): void;
}

const STALE_CTX_MESSAGE =
	"This extension ctx is stale after session replacement";

/** Ledger a dead activation once, at the publisher's occurrence-window guard. */
function recordStaleBusFailure(subject: string, error: unknown): void {
	const reason = String(error);
	if (!reason.includes(STALE_CTX_MESSAGE)) return;
	recordDegradation({ kind: "bus-stale", subject, reason });
}

export function createLiveBusEmitter(): LiveBusEmitter {
	let emit: BusEmitFn | undefined;
	let getter: BusEmitGetter | undefined;
	return {
		wire(next) {
			emit = next;
			getter = undefined;
		},
		wireGetter(next) {
			getter = next;
			emit = undefined;
		},
		resolve() {
			// Invoke the getter for every delivery so session_start rewiring can
			// replace a captured pre-await activation with the current primary. When
			// the current target is nevertheless confirmed stale, never invoke it.
			const target = getter?.() ?? emit;
			if (!target) return { outcome: "unwired", ctxSource: "unwired" };
			if (typeof target === "function") {
				return { outcome: "ready", emit: target, ctxSource: "global-fallback" };
			}
			// Object targets are always "own"-sourced (only `wire(fn)`'s bare
			// function arm is "global-fallback", and it never reaches this
			// branch) — compute it once so the ready/stale-session outcomes
			// below both carry the same value instead of restating the
			// literal independently.
			const ctxSource = "own" as const;
			if (probeCtxActive(target.ctx) === false) {
				return { outcome: "stale-session", ctxSource };
			}
			return { outcome: "ready", emit: target.emit, ctxSource };
		},
		reset() {
			emit = undefined;
			getter = undefined;
		},
	};
}

/**
 * Resolve through the shared stale-session guard and record a declined
 * target.
 *
 * `entry` is a THUNK, not a value (M1, #1415 review): building the log entry
 * (every producer's version normalizes `cwd` via `normalizeFilePath`, a sync
 * `realpathSync.native` call on Windows and, since #3098, on POSIX too) is
 * real per-publish cost that used
 * to be paid on EVERY call regardless of outcome, even though it is only
 * consumed on the `stale-session` branch. Invoking the thunk only there means
 * the common `ready` path pays nothing for it.
 */
function resolveLiveBusEmitter(
	liveEmitter: LiveBusEmitter,
	entry: () => Omit<BusEventLogEntry, "ts" | "outcome" | "level">,
): BusEmitResolution {
	const resolution = liveEmitter.resolve();
	if (resolution.outcome === "stale-session") {
		logBusEvent({
			...entry(),
			outcome: "skipped_stale_session",
			level: "info",
			ctxSource: resolution.ctxSource,
		});
	}
	return resolution;
}

type BusPublishEvent = BusEventLogEntry["event"];

/** One publish attempt, as a producer hands it to {@link BusPublisher.publish}. */
export interface BusPublishCall<P> {
	event: BusPublishEvent;
	/** The kill switch's answer (`isBusPublishEnabled()`), read by the caller. */
	enabled?: boolean;
	/** Raw cwd; the seam normalizes it at most once per call, and only when a record needs it. */
	cwd: string;
	/** Fields every skip and failure row of this producer repeats (files:touched `reason`). */
	extra?: Pick<BusEventLogEntry, "reason">;
	/** Work that runs only when the kill switch is on, before the emitter resolves. */
	whenEnabled?: () => void;
	/** Build the payload from the normalized cwd. Runs inside the failure guard. */
	build: (cwd: string) => P;
	/** Fields of the `emitted` row beyond event, outcome, cwd and `extra`. */
	emittedFields?: (payload: P) => Partial<BusEventLogEntry>;
	dbg?: ((msg: string) => void) | undefined;
}

export interface BusPublisher {
	publish<P>(call: BusPublishCall<P>): void;
	/** Re-arm the three once-per-process latches. Tests only: no session resets them. */
	reset(): void;
}

export interface BusPublisherOptions {
	/** Names the producer in the `dbg` line of a first failure. */
	module: string;
	/**
	 * Replaces the default `skipped_unwired` row, once per process. `lens-events`
	 * writes its drop to the extension log, so this seam holds the latch for it.
	 */
	onUnwired?: (event: BusPublishEvent) => void;
}

/**
 * The one publish path every `pi.events` producer runs (defect shape 83: it
 * replaced eight hand-copied bodies). One publisher is one latch scope: the
 * three latches below are shared by every event published through it. Order,
 * which the producers' tests pin:
 * kill switch (one `skipped_disabled` row per process), the producer's
 * `whenEnabled` work, the live-emitter resolve (a stale target is declined and
 * recorded, an unwired one is recorded once per process), then payload build
 * and emit under one guard. A throw writes `emit_failed` every time and
 * ledgers and `dbg`-logs the first of each run of failures; a success re-arms
 * that latch. Never throws.
 */
export function createBusPublisher(
	liveEmitter: LiveBusEmitter,
	options: BusPublisherOptions,
): BusPublisher {
	let failureLogged = false;
	let unwiredLogged = false;
	let disabledLogged = false;
	return {
		publish<P>(call: BusPublishCall<P>): void {
			const { event } = call;
			let normalized: string | undefined;
			const cwd = (): string => {
				normalized ??= normalizeFilePath(call.cwd);
				return normalized;
			};
			const extra = call.extra ?? {};
			if (call.enabled === false) {
				if (!disabledLogged) {
					disabledLogged = true;
					logBusEvent({
						event,
						outcome: "skipped_disabled",
						cwd: cwd(),
						...extra,
					});
				}
				return;
			}
			call.whenEnabled?.();
			const resolution = resolveLiveBusEmitter(liveEmitter, () => ({
				event,
				cwd: cwd(),
				...extra,
			}));
			if (resolution.outcome === "stale-session") return;
			if (resolution.outcome === "unwired") {
				if (!unwiredLogged) {
					unwiredLogged = true;
					if (options.onUnwired) options.onUnwired(event);
					else {
						logBusEvent({
							event,
							outcome: "skipped_unwired",
							cwd: cwd(),
							...extra,
						});
					}
				}
				return;
			}
			try {
				const payload = call.build(cwd());
				resolution.emit(event, payload);
				failureLogged = false;
				logBusEvent({
					event,
					outcome: "emitted",
					cwd: cwd(),
					...extra,
					...call.emittedFields?.(payload),
				});
			} catch (err) {
				logBusEvent({
					event,
					outcome: "emit_failed",
					cwd: cwd(),
					...extra,
					error: String(err),
					ctxSource: resolution.ctxSource,
				});
				if (!failureLogged) {
					failureLogged = true;
					recordStaleBusFailure(event, err);
					call.dbg?.(
						`${options.module}: ${event} emit failed (further failures suppressed): ${err}`,
					);
				}
			}
		},
		reset() {
			failureLogged = false;
			unwiredLogged = false;
			disabledLogged = false;
		},
	};
}
