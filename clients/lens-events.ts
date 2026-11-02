import { logExtension } from "./extension-log.js";
import type { Diagnostic } from "./dispatch/types.js";
import {
	createBusPublisher,
	createLiveBusEmitter,
	type BusEmitGetter,
} from "./live-bus-emitter.js";

const LENS_EVENT_VERSION = 1;

export const LENS_EVENT_NAMES = {
	analysisComplete: "pi-lens/analysis-complete",
	findings: "pi-lens/findings",
	turnFindings: "pi-lens/turn-findings",
} as const;

type LensEventName = (typeof LENS_EVENT_NAMES)[keyof typeof LENS_EVENT_NAMES];

interface LensTelemetryPayload {
	model: string;
	sessionId: string;
	turnIndex: number;
	writeIndex: number;
}

export interface LensAnalysisPayload extends LensTelemetryPayload {
	version: typeof LENS_EVENT_VERSION;
	source: "pi-lens";
	timestamp: string;
	cwd: string;
	filePath: string;
	toolName: string;
	diagnostics: Diagnostic[];
	blockers: Diagnostic[];
	warnings: Diagnostic[];
	fixed: Diagnostic[];
	resolvedCount: number;
	hasBlockers: boolean;
	fileModified: boolean;
	changedFiles: string[];
	durationMs: number;
}

export interface LensTurnFindingsPayload {
	version: typeof LENS_EVENT_VERSION;
	source: "pi-lens";
	timestamp: string;
	cwd: string;
	filePaths: string[];
	sessionId: string;
	turnIndex: number;
	blockerSections: number;
	advisorySections: number;
	content: string;
}

const liveEmitter = createLiveBusEmitter();

/** Keep deferred deliveries on the live extension activation. */
export function initLensEventsGetter(getter: BusEmitGetter | undefined): void {
	liveEmitter.wireGetter(getter);
}

function truncateText(
	value: string | undefined,
	maxChars: number,
): string | undefined {
	if (value === undefined) return undefined;
	if (value.length <= maxChars) return value;
	return `${value.slice(0, maxChars)}…`;
}

function normalizeDiagnostic(diagnostic: Diagnostic): Diagnostic {
	return {
		...diagnostic,
		message: truncateText(diagnostic.message, 1_000) ?? "",
		matchedText: truncateText(diagnostic.matchedText, 500),
		fixSuggestion: truncateText(diagnostic.fixSuggestion, 500),
	};
}

function normalizeDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
	return diagnostics.map(normalizeDiagnostic);
}

// Dropped-emit observability (#1128 review): drops are legitimate (no bus
// during startup/replacement windows) but must not be invisible. One line per
// process, whichever event was dropped first — enough to notice a
// permanently-missing bus without spamming. The seam holds that latch and the
// emit-failure one: occurrence-scoped (H1, #1415 review), re-armed by a
// success, so a later failure records a fresh degradation rather than being
// silently absorbed by an earlier one (AGENTS.md's "one bus-stale degradation
// per occurrence" invariant).
const publisher = createBusPublisher(liveEmitter, {
	module: "lens-events",
	onUnwired: (eventName) =>
		logExtension({
			subsystem: "lens-events",
			level: "warn",
			message: `lens event dropped (no live bus): ${eventName} — further drops logged once per process`,
			metadata: { eventName },
		}),
});

/** Test-only: reset module state between test files. */
export function _resetForTests(): void {
	liveEmitter.reset();
	publisher.reset();
}

function emitLensEvent(eventName: LensEventName, payload: unknown): void {
	setImmediate(() => {
		publisher.publish({
			event: eventName,
			cwd: (payload as { cwd?: string }).cwd ?? process.cwd(),
			// Inter-extension events are observational. A listener must never break
			// the pi-lens hook path or delay agent progress.
			build: () => payload,
		});
	});
}

export function emitLensAnalysisComplete(
	payload: Omit<
		LensAnalysisPayload,
		| "version"
		| "source"
		| "timestamp"
		| "diagnostics"
		| "blockers"
		| "warnings"
		| "fixed"
	> & {
		diagnostics: Diagnostic[];
		blockers: Diagnostic[];
		warnings: Diagnostic[];
		fixed: Diagnostic[];
	},
): void {
	const normalized: LensAnalysisPayload = {
		version: LENS_EVENT_VERSION,
		source: "pi-lens",
		timestamp: new Date().toISOString(),
		...payload,
		diagnostics: normalizeDiagnostics(payload.diagnostics),
		blockers: normalizeDiagnostics(payload.blockers),
		warnings: normalizeDiagnostics(payload.warnings),
		fixed: normalizeDiagnostics(payload.fixed),
	};

	emitLensEvent(LENS_EVENT_NAMES.analysisComplete, normalized);
	if (
		normalized.diagnostics.length > 0 ||
		normalized.blockers.length > 0 ||
		normalized.warnings.length > 0 ||
		normalized.fixed.length > 0
	) {
		emitLensEvent(LENS_EVENT_NAMES.findings, normalized);
	}
}

export function emitLensTurnFindings(
	payload: Omit<
		LensTurnFindingsPayload,
		"version" | "source" | "timestamp" | "content"
	> & {
		content: string;
	},
): void {
	emitLensEvent(LENS_EVENT_NAMES.turnFindings, {
		version: LENS_EVENT_VERSION,
		source: "pi-lens",
		timestamp: new Date().toISOString(),
		...payload,
		content: truncateText(payload.content, 8_000) ?? "",
	} satisfies LensTurnFindingsPayload);
}
