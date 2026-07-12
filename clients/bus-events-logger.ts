/**
 * Persistent NDJSON trace of `pi.events` bus publish attempts
 * (`pilens:files:touched` #482 / `pilens:diagnostics` #502).
 *
 * Both producers (clients/bus-publish.ts, clients/diagnostics-publish.ts) are
 * fire-and-forget: on failure or on a structural no-op (never wired, kill
 * switch off) they only invoke an optional `dbg` callback, which varies by
 * host and is a documented no-op in the MCP host (clients/mcp/session.ts's
 * `dbg: noop`). That leaves bus-publish outcomes invisible in exactly the
 * context where they matter most — same failure shape as the #544 MCP
 * session_start incident this repo already fixed once.
 *
 * This module gives bus events the same durable trace every other pi-lens
 * subsystem already has (latency.log, cascade.log, read-guard.log, ...) —
 * see clients/latency-logger.ts for the house pattern this mirrors exactly:
 * one shared `createNdjsonLogger` writer, `isTestMode()` no-op guard,
 * `getBusEventsLogPath()` for testability.
 *
 * Logging volume: `emitted` and `emit_failed` are logged on every call —
 * they're the two outcomes an operator actually needs a per-event trace for.
 * `skipped_unwired` and `skipped_disabled` are process-lifetime-static facts
 * (wiring happens once at extension factory time; the kill switch is an env
 * var read once at startup) — logging them on every publish attempt would
 * spam one identical line per write batch for an entire session with zero
 * new information after the first. Both are gated log-once-per-process, the
 * same `hasLoggedFailure` shape the producers already use for emit_failed.
 * The empty-batch branch (`paths.length === 0` / `files.length === 0`) is
 * NOT logged at all: every call site already guards against invoking these
 * functions with nothing to report (see clients/pipeline.ts,
 * clients/runtime-agent-end.ts), so it's a normal, frequent no-op rather
 * than a real event worth a log line.
 */
import * as path from "node:path";
import { isTestMode } from "./env-utils.js";
import { getGlobalPiLensDir } from "./file-utils.js";
import { createNdjsonLogger } from "./ndjson-logger.js";

const BUS_EVENTS_LOG_FILE = path.join(getGlobalPiLensDir(), "bus-events.log");

const writer = createNdjsonLogger({ filePath: BUS_EVENTS_LOG_FILE });

export type BusEventName = "pilens:files:touched" | "pilens:diagnostics";

export type BusEventOutcome =
	| "emitted"
	| "skipped_unwired"
	| "skipped_disabled"
	| "emit_failed";

export interface BusEventLogEntry {
	ts: string;
	event: BusEventName;
	outcome: BusEventOutcome;
	cwd: string;
	/** paths.length (files:touched) / files.length (diagnostics), for `emitted`. */
	fileCount?: number;
	/** FilesTouchedReason, when applicable (files:touched only). */
	reason?: string;
	/** Diagnostics seq, when applicable (diagnostics only, `emitted`). */
	seq?: number;
	/** emit_failed detail. */
	error?: string;
}

export function logBusEvent(entry: Omit<BusEventLogEntry, "ts">): void {
	if (isTestMode()) {
		return;
	}
	writer.log({ ts: new Date().toISOString(), ...entry });
}

export function getBusEventsLogPath(): string {
	return BUS_EVENTS_LOG_FILE;
}

/** Resolve once all enqueued bus-event writes are on disk (tests/shutdown). */
export function flushBusEventsLog(): Promise<void> {
	return writer.flush();
}
