// Type declarations for tool-smoke-drift.mjs (untyped .mjs imported from
// .ts tests). #2723. Kept in lockstep with the .mjs's own export set (#2723
// review F7: knip flags any pair drift as unused exports on one side or the
// other — #2725 lands a ratchet on that).

export interface DriftStep {
	name: string;
	outcome: string;
}

export interface DriftReport {
	steps: DriftStep[];
}

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
	outsideTrackedLayers?: boolean;
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

// Looser than ToolSmokeLayer: decideToolSmokeAction/layersGenuinelyClean
// only ever read `name`/`outcome`/`summary` (never `failingRows`), and
// tests exercise them directly against bare `{name, outcome}` step
// fixtures (mirroring install-smoke-drift.mjs's own DriftStep shape) as
// well as full buildLayer() results — both must type-check.
export interface ToolSmokeDecisionLayer {
	name: string;
	outcome: string;
	summary?: LayerSummary | null;
}

export function decideToolSmokeAction(
	report: { layers: ToolSmokeDecisionLayer[] },
	jobStatus: string,
): { action: DriftAction; outsideTrackedLayers: boolean };

export function layersGenuinelyClean(layers: ToolSmokeDecisionLayer[]): boolean;

export function buildToolSmokeDriftBody(
	report: ToolSmokeReport,
	opts?: { runUrl?: string | null },
): string;

export function buildToolSmokeDriftComment(report: ToolSmokeReport): string;
