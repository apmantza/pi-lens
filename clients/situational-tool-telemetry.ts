import { logExtension } from "./extension-log.js";
import { TOOL_REGISTRY, type ToolRegistryEntry } from "./tool-config.js";

export type SituationalToolName = Extract<
	ToolRegistryEntry,
	{ situational: true }
>["name"];

type SituationalToolEntry = Extract<ToolRegistryEntry, { situational: true }>;

const situationalTools: readonly SituationalToolName[] = TOOL_REGISTRY.filter(
	(tool): tool is SituationalToolEntry =>
		"situational" in tool && tool.situational === true,
).map((tool) => tool.name);
const situationalToolSet = new Set(situationalTools);
const activated = new Set<SituationalToolName>();
const called = new Set<SituationalToolName>();
let sessionStarted = false;
let emitted = false;
// Pi-only: a session that began from a rebuilt AgentSession (reload/resume/
// fork) records no row; conversation-owned accounting across rebuilds is
// #2858. Set by the opener, cleared by a fresh open or by the session's end.
let suppressed = false;
// MCP-only connection-terminal latch: once the connection's row is recorded,
// repeated initialize/tool-call starts must not reopen the session.
let connectionEnded = false;
// Which host owns the open session; endSituationalToolTelemetry arms the MCP
// latch only for an MCP session.
let sessionHost: "pi" | "mcp" = "mcp";

function observe(set: Set<SituationalToolName>, name: string): void {
	if (situationalToolSet.has(name as SituationalToolName)) {
		set.add(name as SituationalToolName);
	}
}

function clearObservations(): void {
	activated.clear();
	called.clear();
}

export function observeSituationalToolActivation(
	names: readonly string[],
): void {
	for (const name of names) observe(activated, name);
}

export function observeSituationalToolCall(name: SituationalToolName): void {
	observe(called, name);
}

export function resetSituationalToolTelemetry(): void {
	// A live telemetry session owns its observation sets: both hosts open the
	// session (which resets the sets) BEFORE handleSessionStart runs, and a
	// repeated MCP session_start refresh legitimately re-runs that handler —
	// clearing here would wipe the calls recorded before the refresh. This
	// registered reset therefore only acts when no session is open.
	if (sessionStarted) return;
	clearObservations();
	emitted = false;
}

/**
 * Open the telemetry session for one host.
 *
 * Pi records the dead-weight row for fresh sessions only: a non-fresh start
 * marks the session suppressed, `endSituationalToolTelemetry` records nothing
 * for a suppressed session, and a fresh open clears the suppression and resets
 * both observation sets. A fresh start that replaces a still-open pi session
 * emits that session's row (unless it was suppressed) before opening the
 * replacement. MCP keeps its connection-scoped lifecycle — a repeated start is
 * an idempotent refresh and an ended connection never reopens — so `fresh` is
 * MCP-inert and MCP callers pass false.
 */
export function startSituationalToolTelemetrySession(
	host: "pi" | "mcp",
	fresh: boolean,
): void {
	if (host === "mcp") {
		if (connectionEnded) return;
		if (sessionStarted) return;
		sessionHost = "mcp";
		clearObservations();
		emitted = false;
		suppressed = false;
		sessionStarted = true;
		return;
	}
	if (sessionStarted && !fresh) {
		// Rebuilt session: it records no row (#2858), and the replaced
		// session's partial tally is discarded without emitting it.
		clearObservations();
		emitted = false;
		suppressed = true;
		sessionHost = "pi";
		return;
	}
	if (sessionStarted) {
		if (!suppressed) emitSituationalDeadWeight();
		clearObservations();
		emitted = false;
		suppressed = false;
		sessionHost = "pi";
		return;
	}
	sessionHost = "pi";
	suppressed = !fresh;
	clearObservations();
	emitted = false;
	sessionStarted = true;
}

/** Emit the one session-end row and make repeated shutdown calls harmless. */
export function endSituationalToolTelemetry(): void {
	if (!sessionStarted) return;
	if (!suppressed) emitSituationalDeadWeight();
	if (sessionHost === "mcp") connectionEnded = true;
	clearObservations();
	emitted = false;
	suppressed = false;
	sessionStarted = false;
}

export function emitSituationalDeadWeight(): void {
	if (emitted) return;
	emitted = true;
	const used = new Set([...activated, ...called]);
	logExtension({
		subsystem: "tools",
		level: "debug",
		message: "situational tool dead weight",
		metadata: {
			tools: situationalTools.filter((name) => !used.has(name)),
		},
	});
}

/** Test-only view of the module's state, for the #1635 session-state registry probe. */
export function _getSituationalToolTelemetryStateForTests(): {
	activated: number;
	called: number;
	emitted: boolean;
	sessionStarted: boolean;
	suppressed: boolean;
} {
	return {
		activated: activated.size,
		called: called.size,
		emitted,
		sessionStarted,
		suppressed,
	};
}
