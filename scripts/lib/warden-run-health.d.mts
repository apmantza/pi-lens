import type {
	FetchFn,
	WardenAction,
	WardenPr,
} from "./merge-train-warden.d.mts";

export const STALLED_RUN_MINUTES: number;
export const RUN_HEALTH: {
	NORMAL: string;
	STARVED: string;
	STALLED: string;
	ABSENT: string;
	PENDING: string;
	UNKNOWN: string;
};

export interface WorkflowJobStep {
	status?: string;
	conclusion?: string | null;
}

export interface WorkflowJob {
	name?: string;
	status?: string;
	conclusion?: string | null;
	steps?: WorkflowJobStep[];
}

export interface HeadRun {
	id: number | string;
	path: string;
	name?: string;
	status: string;
	conclusion: string | null;
	runAttempt?: number;
	url?: string;
	createdAt?: string;
	jobs: WorkflowJob[] | null;
}

/** A stalled run carries how long it has been stuck (#2203). */
export interface StalledHeadRun extends HeadRun {
	stalledForMinutes?: number | null;
}

export interface HeadRunHealth {
	classification: string;
	starvedRuns: HeadRun[];
	stalledRuns: StalledHeadRun[];
	cancelledStalledRuns: HeadRun[];
	absentWorkflows: string[];
	unknownWorkflows: string[];
	pendingWorkflows: string[];
	ageMinutes: number | null;
}

export function countExecutedSteps(jobs: WorkflowJob[] | null): number;
export function isStarvedRun(run: HeadRun | null | undefined): boolean;

export function isStalledRun(
	run: HeadRun | null | undefined,
	now: number,
	thresholdMinutes?: number,
): boolean;
export function isCancelledStalledRun(run: HeadRun | null | undefined): boolean;

export function classifyHeadRun(options: {
	runs: HeadRun[];
	headCommittedDate: string | null | undefined;
	now: number;
	graceMinutes?: number;
	stalledMinutes?: number;
	trackedPaths?: string[];
}): HeadRunHealth;
export function fetchHeadRunHealth(
	fetcher: FetchFn,
	owner: string,
	repo: string,
	headSha: string | undefined,
	headCommittedDate: string | null | undefined,
	now: number,
): Promise<{ health: HeadRunHealth; errors: string[] }>;
export function absentRunCommentMarker(headSha: string | undefined): string;

export function stalledRunCommentMarker(runId: number | string): string;

export function decideRunHealthActions(
	pr: WardenPr,
	health: HeadRunHealth,
	options?: {
		absentCommentExists?: boolean;
		stalledRunMarkers?: Set<string> | null;
	},
): WardenAction[];
