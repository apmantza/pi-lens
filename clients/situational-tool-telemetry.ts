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
// MCP-only connection-terminal latch: once the connection's row is recorded,
// repeated initialize/tool-call starts must not reopen the session.
let connectionEnded = false;
// Which host owns the open session; only MCP may arm connectionEnded. Pi state
// belongs to the conversation and survives in-process session rebuilds.
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
 * Pi keeps one observation set for the conversation. Reload, resume, and fork
 * preserve it. A fresh `/new` start emits the prior row once and opens an
 * empty set. The boolean result identifies a process restart to the pi opener,
 * which may observe restored active tools as activations; `called` is not
 * recoverable across that restart. MCP remains connection-scoped.
 */
export function startSituationalToolTelemetrySession(
	host: "pi" | "mcp",
	fresh: boolean,
): boolean {
	if (host === "mcp") {
		if (connectionEnded) return false;
		if (sessionStarted) return false;
		sessionHost = "mcp";
		clearObservations();
		emitted = false;
		sessionStarted = true;
		return true;
	}
	if (sessionStarted) {
		if (fresh) {
			emitSituationalDeadWeight();
			clearObservations();
			emitted = false;
		}
		sessionHost = "pi";
		return false;
	}
	sessionHost = "pi";
	clearObservations();
	emitted = false;
	sessionStarted = true;
	return true;
}

/** Emit the one session-end row and make repeated shutdown calls harmless. */
export function endSituationalToolTelemetry(): void {
	if (!sessionStarted) return;
	emitSituationalDeadWeight();
	if (sessionHost === "mcp") connectionEnded = true;
	clearObservations();
	emitted = false;
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
} {
	return {
		activated: activated.size,
		called: called.size,
		emitted,
		sessionStarted,
	};
}
