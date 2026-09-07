import { recordDegradation } from "./degradation-ledger.js";
import { probeCtxActive } from "./session-lifecycle.js";
import { logBusEvent, type BusEventLogEntry } from "./bus-events-logger.js";

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
export function recordStaleBusFailure(subject: string, error: unknown): void {
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
 * `realpathSync.native` call on Windows) is real per-publish cost that used
 * to be paid on EVERY call regardless of outcome, even though it is only
 * consumed on the `stale-session` branch. Invoking the thunk only there means
 * the common `ready` path pays nothing for it.
 */
export function resolveLiveBusEmitter(
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
