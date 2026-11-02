import { recordDegradation } from "./degradation-ledger.js";
import { probeCtxActive } from "./session-lifecycle.js";
import { logBusEvent, type BusEventLogEntry } from "./bus-events-logger.js";
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
