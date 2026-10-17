import { logLatency } from "./latency-logger.js";
import { getProcessSingleton } from "./process-singletons.js";

/**
 * The complete observability path for a concurrent secondary. It deliberately
 * emits one bind record only: secondary sessions skip every primary reset and
 * hydration phase.
 */

// #2249: bounded per-session rollup of declined binds, counted at this shared
// seam so every decline the process's PRIMARY has seen this session —
// `concurrent-secondary` and `secondary-root` alike — is summarized in one row
// at session end instead of requiring a reader to hand-count
// `concurrent_session_bind` lines. Process-singleton backed (AGENTS.md catalog
// shape 25), NOT a module-scope `let` like the other `*_rollup` counters
// (bus-events-logger.ts, path-attribution-telemetry.ts): a `let` here exists
// once per module EVALUATION, not once per process, and #2146 measured one pid
// evaluating this exact graph nine times — a bare `let` would only ever see
// the binds routed through its own copy, undercounting every rollup that
// isn't reached through the first evaluation. `decideSessionStart` never
// returns a declined classification outside `concurrent-secondary`/
// `secondary-root` (session-lifecycle.ts), so those two are the whole
// contract; `unclassified` is a bounded third bucket for the legacy callers
// this function's `classification?` param still accepts.
const BIND_ROLLUP_FAMILY = "concurrent-session-bind-rollup";
const BIND_ROLLUP_VERSION = 1;

type BindRollupClassification =
	| "concurrent-secondary"
	| "secondary-root"
	| "unclassified";

function bindRollupCounts(): Record<BindRollupClassification, number> {
	return getProcessSingleton(BIND_ROLLUP_FAMILY, BIND_ROLLUP_VERSION, () => ({
		"concurrent-secondary": 0,
		"secondary-root": 0,
		unclassified: 0,
	}));
}

function bindRollupKey(
	classification: string | undefined,
): BindRollupClassification {
	return classification === "concurrent-secondary" ||
		classification === "secondary-root"
		? classification
		: "unclassified";
}

export function logConcurrentSessionBind(args: {
	secondaryCount: number;
	sessionReason?: string;
	sameCwd: boolean;
	/** #2129: which secondary shape this was — `concurrent-secondary` (a live
	 *  sibling session) or `secondary-root` (a start in a different project
	 *  root). Optional so older callers/tests keep compiling. */
	classification?: string;
	/** #2129: the root-identity input the classifier consulted. `undefined`
	 *  means the comparison had nothing to compare, NOT "same root". */
	sameRoot?: boolean;
	/** #2129: the registered primary's normalized root at decision time. */
	primaryRoot?: string;
}): void {
	bindRollupCounts()[bindRollupKey(args.classification)] += 1;
	logLatency({
		type: "phase",
		filePath: "<pi-lens>",
		phase: "concurrent_session_bind",
		durationMs: 0,
		metadata: args,
	});
}

/** Snapshot of the current rollup counters, keyed by classification.
 *  Non-mutating — for tests/observability, mirroring
 *  `getBusEventRollupCounts`/`getVerifiedPathAttributionGuessCount`. */
export function getConcurrentSessionBindRollupCounts(): Record<
	BindRollupClassification,
	number
> {
	return { ...bindRollupCounts() };
}

/**
 * Log one `concurrent_session_bind_rollup` row summarizing this session's
 * declined binds by classification, then clear the counters. Call from
 * index.ts's `session_shutdown` handler at the same primary-only placement as
 * `emitBusEventRollupAtSessionEnd`/`emitVerifiedPathAttributionRollup` — a
 * concurrent secondary's own shutdown returns before reaching that point, and
 * the counters are process-wide state a still-live secondary would still need.
 * A no-op when nothing was ever declined this session, matching those same
 * rollups' "no noise on an ordinary session" shape.
 */
export function emitConcurrentSessionBindRollupAtSessionEnd(cwd: string): void {
	const counts = bindRollupCounts();
	const total =
		counts["concurrent-secondary"] +
		counts["secondary-root"] +
		counts.unclassified;
	if (total === 0) return;
	logLatency({
		type: "phase",
		filePath: cwd,
		phase: "concurrent_session_bind_rollup",
		durationMs: 0,
		metadata: { ...counts },
	});
	resetConcurrentSessionBindRollupCounts();
}

/**
 * Session-boundary reset (AGENTS.md catalog shape 17). Call from index.ts's
 * `session_start` handler on the PRIMARY continuation path only — never from
 * a declined bind's own `session_start`, which is exactly what increments
 * these counters, so resetting there would erase every prior sibling's tally
 * from the same primary session. Covers the case a primary session never
 * reaches `session_shutdown` (a crash, a forced kill) and the process's next
 * primary must still start from zero. Also exported for tests.
 */
export function resetConcurrentSessionBindRollupCounts(): void {
	const counts = bindRollupCounts();
	counts["concurrent-secondary"] = 0;
	counts["secondary-root"] = 0;
	counts.unclassified = 0;
}

/**
 * #4554: one row when an activation's shared session teardown runs on behalf
 * of a session classified `concurrent-secondary` — the activation's LAST live
 * member, in an activation that also ran a full session_start for a sibling.
 *
 * WHY THIS RECORD EXISTS. Every other row the shared branch leaves describes
 * the PRIMARY's infra (`session_end_bus_rollup`, the fence and bind rollups,
 * the cache summary), so a reader of `latency.log` would otherwise see a full
 * teardown attributed to a session whose own role said secondary and have no
 * way to tell the correct case (the last member of a multi-session activation)
 * from the defect it replaced (#4554: the stored role made EVERY shutdown take
 * the local-only branch). Emitted at most once per activation, from
 * `index.ts`'s `session_shutdown` handler, and only on that path.
 */
export function logSharedTeardownForSecondarySession(args: {
	sessionId: string | undefined;
	cwd: string;
}): void {
	logLatency({
		type: "phase",
		filePath: args.cwd,
		phase: "session_teardown_last_member",
		durationMs: 0,
		metadata: {
			sessionId: args.sessionId,
			classification: "secondary",
		},
	});
}
