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
let preserveObservationsOnReset = false;
let connectionEnded = false;
let sessionHost: "pi" | "mcp" = "mcp";

function observe(set: Set<SituationalToolName>, name: string): void {
	if (situationalToolSet.has(name as SituationalToolName)) {
		set.add(name as SituationalToolName);
	}
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
	if (preserveObservationsOnReset) return;
	activated.clear();
	called.clear();
	// The session opener owns the once-only latch. Session-start resets run after
	// the opener and must not make a live session emit twice.
	if (!sessionStarted) emitted = false;
}

/** Begin a fresh session, preserving one row for an abruptly replaced one. */
export function startSituationalToolTelemetrySession(
	idempotent = false,
	preserveOnReset = idempotent,
	host: "pi" | "mcp" = "mcp",
): void {
	if (host === "mcp" && idempotent && connectionEnded) return;
	if (host === "mcp" && !idempotent) connectionEnded = false;
	if (sessionStarted && idempotent) return;
	if (sessionStarted) {
		preserveObservationsOnReset = false;
		emitSituationalDeadWeight();
		resetSituationalToolTelemetry();
		emitted = false;
		return;
	}
	preserveObservationsOnReset = preserveOnReset;
	sessionHost = host;
	resetSituationalToolTelemetry();
	emitted = false;
	sessionStarted = true;
}

/** Emit the one session-end row and make repeated shutdown calls harmless. */
export function endSituationalToolTelemetry(): void {
	if (!sessionStarted) return;
	emitSituationalDeadWeight();
	if (sessionHost === "mcp") connectionEnded = true;
	preserveObservationsOnReset = false;
	resetSituationalToolTelemetry();
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
