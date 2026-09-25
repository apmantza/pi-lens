// Type declarations for pre-push-targeted-tests.mjs (untyped .mjs imported
// from .ts tests, so the selection logic can be pinned down directly). #1804.

export const MAX_SELECTED_TESTS: number;

export const TREE_SCANNING_GOVERNANCE_TESTS: string[];

/** CI-only suites (file → why it cannot run in pre-push), #3426 H3432-1. */
export const CI_ONLY_PRE_PUSH_TESTS: Record<string, string>;

export function resolveDiffRange(): string;

export function changesProductionFile(file: string): boolean;

export function changedFiles(range: string): string[] | null;

export function collectTestFiles(dir: string, out?: string[]): string[];

export interface TargetedTestSelection {
	selected: string[];
	unmatched: string[];
	capped: boolean;
	totalBeforeCap: number;
	/** CI-only suites removed from `selected` for the local pre-push caller. */
	excludedCiOnly: string[];
}

export function selectTargetedTests(
	changed: string[],
	allTests: string[],
	options?: { includeCiOnly?: boolean },
): TargetedTestSelection;

export function main(): Promise<number>;
