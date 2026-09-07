// Type declarations for tool-smoke-drift.mjs (untyped .mjs imported from
// .ts tests). #2723.

export type StepOutcome = "success" | "failure" | "cancelled" | "skipped";

export const VALID_STEP_OUTCOMES: readonly StepOutcome[];

export interface DriftStep {
	name: string;
	outcome: string;
}

export interface DriftReport {
	steps: DriftStep[];
}

export function isValidReport(report: DriftReport): boolean;

export function firstFailingStep(report: DriftReport): string | null;

export function hasDrift(report: DriftReport): boolean;

export function isCleanRun(report: DriftReport): boolean;

export type DriftAction =
	| "file-or-refresh"
	| "close-if-open"
	| "no-action"
	| "unknown";

export function decideAction(report: DriftReport): DriftAction;

export const DRIFT_ISSUE_LABEL: string;

export function findDriftTrackingIssue(
	issues: { number: number; title: string }[] | null | undefined,
	title?: string,
): { number: number; title: string } | null;

export const TOOL_SMOKE_DRIFT_TITLE: string;

export interface LayerSummary {
	passed: number;
	failed: number;
	setupFailed: number;
	skipped: number;
}

export interface FailingRow {
	lang: string;
	runner: string;
	detail: string;
}

export interface ToolSmokeLayer {
	name: string;
	outcome: string;
	summary: LayerSummary | null;
	failingRows: FailingRow[];
}

export interface ToolSmokeReport {
	layers: ToolSmokeLayer[];
	consecutiveRed?: number;
}

export function parseLayerSummary(
	text: string | null | undefined,
): LayerSummary | null;

export function parseFailingRows(text: string | null | undefined): FailingRow[];

export function buildLayer(
	name: string,
	outcome: string,
	logText: string | null | undefined,
): ToolSmokeLayer;

export function parseConsecutiveRedCount(
	existingBody: string | null | undefined,
): number;

export function nextConsecutiveRedCount(
	existingBody: string | null | undefined,
): number;

export function buildToolSmokeDriftBody(
	report: ToolSmokeReport,
	opts?: { runUrl?: string | null },
): string;

export function buildToolSmokeDriftComment(report: ToolSmokeReport): string;
