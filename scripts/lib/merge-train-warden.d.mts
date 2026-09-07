export const CONFLICT_LABEL: string;
export const RED_CI_LABEL: string;
export const PAGE_SIZE: number;
export const MAX_PAGES: number;

export type FetchFn = (
	url: string,
	init?: { method?: string; body?: string; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface WardenCheckRun {
	name: string;
	status: string | null;
	conclusion: string | null;
	startedAt?: string | null;
	url?: string;
}

// REQUIRED_CHECKS and resolveCheckRuns moved to ./ci-checks.mjs (#2539 round
// 2, F2) as REQUIRED_CHECKS / resolveLatestByName -- the shared seam for
// this file, merge-train-lane.mjs, and ci-verdict.mjs.

export interface WardenPr {
	number: number;
	url: string;
	headSha: string | undefined;
	headCommittedDate: string | null;
	mergeStateStatus: string;
	autoMergeEnabled: boolean;
	isFork: boolean;
	labels: Set<string>;
	checksUnknown: boolean;
	checkRuns: WardenCheckRun[];
	failingRequiredChecks: Array<{ name: string; url?: string }>;
	unresolvedRequiredChecks: string[];
}

export type WardenAction =
	| { type: "add-label"; label: string }
	| { type: "remove-label"; label: string }
	| { type: "comment"; body: string }
	| { type: "update-branch" }
	| { type: "rerun-run"; runId: number | string; workflowPath: string }
	| { type: "cancel-run"; runId: number | string; workflowPath: string }
	| { type: "note"; benign: boolean; message: string };

export interface WardenError {
	message: string;
	benign: boolean;
}

export interface WardenRunHealthSummary {
	classification: string;
	detail: string;
}

export interface WardenResult {
	number: number | null;
	url: string | null;
	mergeStateStatus: string | null;
	applied: string[];
	errors: WardenError[];
	runHealth: WardenRunHealthSummary | null;
}

/**
 * #2192: `errors` are `WardenError` records, not strings. Both consumers used
 * to map every list error to `benign: false`; classification now happens once,
 * at the source, so a routine UPDATED_AT window slide cannot redden the run.
 */
export function fetchOpenPullRequests(
	fetcher: FetchFn,
	owner: string,
	name: string,
): Promise<{ prs: WardenPr[]; errors: WardenError[] }>;

/**
 * How many repeated PR numbers one cross-page duplicate record names before it
 * reports a remainder count instead (#2192).
 */
export const DUPLICATE_REPORT_CAP: number;
export function decideActions(pr: WardenPr): WardenAction[];
export function classifyActionFailure(
	action: WardenAction,
	pr: WardenPr,
	status: number,
): { benign: boolean; outcome: string | null };
export function applyAction(
	fetcher: FetchFn,
	owner: string,
	repo: string,
	pr: WardenPr,
	action: WardenAction,
): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export function runWarden(options: {
	fetcher: FetchFn;
	owner: string;
	repo: string;
	now?: number;
}): Promise<WardenResult[]>;
