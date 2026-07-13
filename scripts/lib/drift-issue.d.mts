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
): { number: number; title: string } | null;
