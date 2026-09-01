import type { FetchFn, WardenPr } from "./merge-train-warden.d.mts";
import type { HeadRunHealth } from "./warden-run-health.d.mts";

export const TRAIN_APPROVED_LABEL: string;
export const TRAIN_SQUASH_LABEL: string;
export const POST_MERGE_EVENT: string;
export const POST_MERGE_DISPATCH_ATTEMPTS: number;
export const POST_MERGE_RECONCILE_WINDOW_MS: number;
export const POST_MERGE_RECONCILE_GRACE_MS: number;
export const POST_MERGE_RETRY_GENERATION_MS: number;
export const POST_MERGE_RECONCILE_PAGE_SIZE: number;
export const POST_MERGE_RECONCILE_MAX_PAGES: number;
export const POST_MERGE_RECONCILE_MAX_RECORDS: number;
export const POST_MERGE_VALIDATION_WORKFLOWS: readonly string[];
export const ADVISORY_SUFFIX: string;
export const ADVISORY_CHECKS: Set<string>;
export const CONCLUDED_STATUS: string;
export const PASSING_CONCLUSION: string;
export const BLOCKING_CONCLUSIONS: Set<string>;
export const MERGEABLE_STATES: Set<string>;
export const UPDATEABLE_STATES: Set<string>;
export const MERGE_GATE_REASON: Record<string, string>;

export interface ApprovalActor {
	allowed: boolean;
	actor: string | null;
	error: string | null;
}

export interface MergeGateDecision {
	merge: boolean;
	update: boolean;
	silent: boolean;
	method: "squash" | "merge" | null;
	reason: string;
	detail: string;
}

export interface MergeLaneResult {
	number: number | null;
	url?: string;
	reason: string;
	detail?: string;
	method?: "squash" | "merge" | null;
	runHealth?: string;
	approvedBy?: string | null;
	merged: boolean;
	updated?: boolean;
	errors: Array<{ message: string; benign: boolean }>;
}

export function isAdvisoryCheck(name: string): boolean;
export function resolveApprovalActor(
	fetcher: FetchFn,
	owner: string,
	repo: string,
	prNumber: number,
	approvers: string[],
): Promise<ApprovalActor>;
export function updatePullRequestBranch(
	fetcher: FetchFn,
	owner: string,
	repo: string,
	pr: WardenPr,
): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
export function evaluateMergeGate(
	pr: WardenPr,
	health: HeadRunHealth,
	options?: { approvedBy?: ApprovalActor },
): MergeGateDecision;
export function laneCommentMarker(
	headSha: string | undefined,
	reason: string,
): string;
export function laneCommentBody(pr: WardenPr, gate: MergeGateDecision): string;
export function mergeFailureCommentBody(
	pr: WardenPr,
	gate: MergeGateDecision,
	status: number,
): string;
export function mergePullRequest(
	fetcher: FetchFn,
	owner: string,
	repo: string,
	pr: WardenPr,
	method: string,
): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
export function dispatchPostMergeValidation(
	fetcher: FetchFn,
	owner: string,
	repo: string,
	mergeSha: string,
	prNumber: number,
): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
export function dispatchPostMergeValidationWithRetry(
	fetcher: FetchFn,
	owner: string,
	repo: string,
	mergeSha: string,
	prNumber: number,
): Promise<{
	response: { ok: boolean; status: number; json(): Promise<unknown> };
	attempts: number;
}>;
export function reconcilePostMergeValidations(options: {
	fetcher: FetchFn;
	owner: string;
	repo: string;
	now?: number;
	windowMs?: number;
	graceMs?: number;
}): Promise<
	Array<{
		number: number | null;
		sha: string | null;
		dispatched: boolean;
		errors: string[];
	}>
>;
export function runMergeLane(options: {
	fetcher: FetchFn;
	owner: string;
	repo: string;
	now?: number;
	approvers?: string[];
}): Promise<MergeLaneResult[]>;
