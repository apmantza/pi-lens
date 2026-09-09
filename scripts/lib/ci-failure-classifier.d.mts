export type FetchFn = (
	url: string,
	init?: { method?: string; body?: string; headers?: Record<string, string> },
) => Promise<{
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
	text(): Promise<string>;
}>;

export type ClassificationKind = "real" | "infra-kill" | "infra-net";
export interface Classification {
	kind: ClassificationKind;
	detail: string;
}
export type RerunState = "true" | "false" | `failed:${number}`;
export interface ClassifierMarker {
	sha: string;
	// Optional on the TYPE (shouldTriggerRerun's guard only reads sha +
	// rerunTriggered) even though parseClassifierMarker always sets it.
	rerunState?: string;
	rerunTriggered: boolean;
}
export interface ClassifierDecision {
	classification: Classification;
	// "did THIS pass trigger a rerun" -- distinct from ClassifierMarker's
	// `rerunTriggered`, which is the marker's CUMULATIVE state (review round
	// 2, V5: kept as two differently-named fields on purpose).
	rerunTriggeredThisPass: boolean;
	commentBody: string;
}

/** Network-shaped failure needles shared with scripts/npm-retry.mjs (#2684). */
export declare const NET_PATTERN: RegExp;
export declare function classifyFailureLog(rawLog: string): Classification;
export declare function readCgroupOomKillCount(log: string): number | null;
export declare function describeKernelKillEvidence(log: string): string | null;
export declare function buildMarker(sha: string, rerunState: string): string;
export declare function parseClassifierMarker(
	commentBody: string | null | undefined,
): ClassifierMarker | null;
export declare function shouldTriggerRerun(args: {
	classification: Classification;
	sha: string;
	existingMarker: ClassifierMarker | null;
	rerunKinds?: ClassificationKind[];
}): boolean;
export declare function buildCommentBody(args: {
	classification: Classification;
	sha: string;
	rerunState: string;
}): string;
export declare function decideClassifierAction(args: {
	rawLog: string;
	sha: string;
	existingCommentBody: string | null | undefined;
}): ClassifierDecision;

export interface FetchedJob {
	sha: string;
	prNumber: number | null;
	jobId: number;
	jobName: string;
}
export interface RunClassifierArgs {
	fetcher: FetchFn;
	owner: string;
	repo: string;
	runId: number | string;
	jobName?: string;
	prNumber?: number;
	sha?: string;
	rerunKinds?: ClassificationKind[];
	skipMissingJob?: boolean;
	// #2668: a master-push run has no associated PR at all (not merely an
	// unresolved lookup) -- allow classification and the rerun to proceed
	// without one, skipping every PR-comment step.
	allowMissingPr?: boolean;
}
export type SuccessfulClassifierRun = ClassifierDecision & {
	sha: string;
	prNumber: number | null;
	jobId: number;
	jobName: string;
	supersededByCommentId?: number;
};
export type SkippedClassifierRun = { skipped: true; reason: string };
export declare function runClassifier(
	args: RunClassifierArgs & { skipMissingJob?: false },
): Promise<SuccessfulClassifierRun>;
export declare function runClassifier(
	args: RunClassifierArgs & { skipMissingJob: true },
): Promise<SuccessfulClassifierRun | SkippedClassifierRun>;
export declare function runClassifier(
	args: RunClassifierArgs,
): Promise<SuccessfulClassifierRun | SkippedClassifierRun>;
