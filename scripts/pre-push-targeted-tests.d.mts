// Type declarations for pre-push-targeted-tests.mjs (untyped .mjs imported
// from .ts tests, so the selection logic can be pinned down directly). #1804.

export const MAX_SELECTED_TESTS: number;

export const DIST_IMPORTS: readonly [
	{
		readonly source: "clients/lsp/server-traits.ts";
		readonly output: "dist/clients/lsp/server-traits.js";
	},
];

export function findStaleDistFiles(root: string): Array<{
	source: string;
	output: string;
	reason: "missing" | "stale" | "unreadable";
}>;

export const TREE_SCANNING_GOVERNANCE_TESTS: string[];

/** Tests-tree scanners armed on any tests/ change (#3472 recurrence, #3492). */
export const TEST_TREE_GOVERNANCE_TESTS: string[];

export function changesTestTreeFile(file: string): boolean;

/** CI-only suites (file → why it cannot run in pre-push), #3426 H3432-1. */
export const CI_ONLY_PRE_PUSH_TESTS: Record<string, string>;

/** Returns pushed diff ranges, or null for a deletion-only push. */
export function resolveDiffRange(input?: string): string[] | null;

export function changesProductionFile(file: string): boolean;

export function changedFiles(range: string): string[] | null;

/** Uncommitted tracked edits plus untracked, non-ignored files (#4047). */
export function worktreeChangedFiles(): string[] | null;

export function collectTestFiles(dir: string, out?: string[]): string[];

export interface TargetedTestSelection {
	/** When `capped`, only the armed governance registries (#3492). */
	selected: string[];
	unmatched: string[];
	capped: boolean;
	totalBeforeCap: number;
	/** CI-only suites removed from `selected` for the local pre-push caller. */
	excludedCiOnly: string[];
	/** Tests only the history pass added (#3215 lane 3). */
	fromHistory: string[];
	/** The reason each selected test entered the final selection (#4034). */
	selectionReasons: Map<string, "import" | "history" | "governance">;
}

export function selectTargetedTests(
	changed: string[],
	allTests: string[],
	options?: { includeCiOnly?: boolean; historyPicks?: string[] },
): TargetedTestSelection;

export interface PrePushRecord {
	head: string;
	base: string;
	timestamp: string;
	selected: Array<{
		file: string;
		reason: "import" | "history" | "governance";
	}>;
	passed: number;
	failed: number;
	skipped: number;
	vitestExitCode: number | null;
	wallTimeMs: number;
	outcome:
		| "tests-not-started"
		| "build-only"
		| "build-failed"
		| "self-scan-failed"
		| "tests-complete"
		| "tests-failed"
		| "tests-lock-timeout"
		| "tests-runner-failed";
}

export function readPrePushRecord(
	commonDir: string,
	head: string,
): PrePushRecord | null;

export function writePrePushRecord(input: {
	commonDir: string;
	head: string;
	base: string;
	at?: Date;
	selected: PrePushRecord["selected"];
	passed: number;
	failed: number;
	skipped: number;
	vitestExitCode: number | null;
	wallTimeMs: number;
	outcome?: PrePushRecord["outcome"];
}): PrePushRecord;

export function parseVitestCounts(output: string): {
	passed: number;
	failed: number;
	skipped: number;
};

export function main(): Promise<number>;
