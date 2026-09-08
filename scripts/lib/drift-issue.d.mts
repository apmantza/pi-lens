// Type declarations for drift-issue.mjs (untyped .mjs imported from .ts tests).

export const DRIFT_ISSUE_LABEL: string;
export const DRIFT_ISSUE_TITLE: string;

export interface DriftSummary {
	generatedAt?: string;
	count?: number;
	warnings?: { lang: string; kind: string; detail: string }[];
}

export function buildDriftIssueBody(
	summary: DriftSummary,
	opts?: { runUrl?: string | null },
): string;

export function findDriftTrackingIssue(
	issues: { number: number; title: string }[] | null | undefined,
	title?: string,
): { number: number; title: string } | null;

export function upsertTrackingIssue(options: {
	title: string;
	label: string;
	body?: string;
	bodyFile?: string;
	clean?: boolean;
	closeWhenClean?: boolean;
	comment?: string;
	closeComment?: string;
	gh: (args: string[]) => string;
}): {
	action: "created" | "updated" | "closed" | "no-action";
	issueNumber?: number;
};
