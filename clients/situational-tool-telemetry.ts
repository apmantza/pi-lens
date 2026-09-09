import { logExtension } from "./extension-log.js";
import { TOOL_REGISTRY } from "./tool-config.js";

const situationalTools = TOOL_REGISTRY.filter(
	(tool) => "situational" in tool && tool.situational === true,
).map((tool) => tool.name);
const situationalToolSet = new Set(situationalTools);
const activated = new Set<string>();
const called = new Set<string>();
let sessionStarted = false;
let emitted = false;

function observe(set: Set<string>, name: string): void {
	if (situationalToolSet.has(name)) set.add(name);
}

export function observeSituationalToolActivation(
	names: readonly string[],
): void {
	for (const name of names) observe(activated, name);
}

export function observeSituationalToolCall(name: string): void {
	observe(called, name);
}

export function resetSituationalToolTelemetry(): void {
	activated.clear();
	called.clear();
	emitted = false;
}

/** Begin a fresh session, preserving one row for an abruptly replaced one. */
export function startSituationalToolTelemetrySession(): void {
	if (sessionStarted) emitSituationalDeadWeight();
	resetSituationalToolTelemetry();
	sessionStarted = true;
}

/** Emit the one session-end row and make repeated shutdown calls harmless. */
export function endSituationalToolTelemetry(): void {
	if (!sessionStarted) return;
	emitSituationalDeadWeight();
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

export const _observeSituationalActivationForTests =
	observeSituationalToolActivation;
export const _observeSituationalCallForTests = observeSituationalToolCall;
