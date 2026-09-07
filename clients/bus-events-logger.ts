/**
 * Persistent NDJSON trace of `pi.events` bus publish attempts
 * (`pilens:files:touched` #482 / `pilens:diagnostics` #502 /
 * `pilens:diagnostic:disposition` / `pilens:format:queued` +
 * `pilens:format:start` + `pilens:autofix:start` #673/#684 /
 * `pi-lens/analysis-complete` + `pi-lens/findings` + `pi-lens/turn-findings`
 * #1415) — nine event names across five producers.
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

export function logBusEvent(entry: Omit<BusEventLogEntry, "ts">): void {
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
