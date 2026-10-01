export declare const REQUIRED_CHECKS: string[];
export declare const CI_JOB_NAMES: Readonly<{
	CHANGELOG_FRAGMENT: string;
	LINT_AND_TYPECHECK: string;
	KNIP: string;
	UNIT_TESTS: string;
}>;
export declare function isUnitTestsJobName(name: unknown): boolean;
export declare function isUnitTestsShardJobName(name: unknown): boolean;
export declare const ADVISORY_CHECKS: Set<string>;
export declare const HEAVY_GATE_CHECK: string;
export declare const CHANGES_CHECK: string;
export declare const DEFERRED_ADVISORY_CHECKS: readonly string[];
export declare function isAdvisoryCheck(name: string): boolean;
export declare function isBlockingConclusion(
	conclusion: string | null | undefined,
): boolean;
export declare function isUncertainConclusion(
	conclusion: string | null | undefined,
): boolean;

export interface CheckRunRecord {
	name: string;
	status?: string | null;
	conclusion?: string | null;
	startedAt?: string | null;
	started_at?: string | null;
	[key: string]: unknown;
}

export declare function resolveLatestByName<T extends CheckRunRecord>(
	checkRuns: T[] | null | undefined,
): Map<string, T>;
