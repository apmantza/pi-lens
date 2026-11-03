export declare const DEFAULT_MAX_FILES: 6;
export declare const DEFAULT_MAX_RANGES: 40;
export declare const DEFAULT_MAX_TESTS: 47;
export declare const MAX_DRY_RUN_SECONDS: 240;
export declare const UNKNOWN_TEST_SECONDS: 12;
export declare const TEST_FILE_OVERHEAD_SECONDS: 0.5;
export declare const isDryRunTimeout: (output?: string) => boolean;
export declare const MUTATION_BUDGET_MINUTES: 60;
export declare const DEFAULT_MUTATION_FIXED_OVERHEAD_MS: number;
export declare class MutationLaneExclusionError extends Error {
	constructor(file: string);
}
export declare function mutationLaneExclusion(
	file: string,
	options?: {
		readFile?: (file: string) => string;
		exclusions?: Record<string, { reason?: string }>;
	},
): { file: string; reason: string } | null;
export declare function capMutationFiles(
	files: string[],
	maxFiles?: number,
	weights?: Map<string, number>,
): { selected: string[]; skipped: string[] };
export declare function changedLineWeights(
	rangesByFile: Map<string, Array<[number, number]>>,
): Map<string, number>;
export declare function formatCapNotice(
	selectedCount: number,
	totalCount: number,
	skipped: string[],
): string;
export declare const isScriptMutationFile: (file: string) => boolean;
export declare const isCompiledMutationSource: (file: string) => boolean;
export declare const isMutationSourceFile: (file: string) => boolean;
export declare const compiledJsPath: (file: string) => string;
export declare function importsMutationSource(
	testFile: string,
	content: string,
	sourceFile: string,
): boolean;
export declare function mapRelatedTests(
	changedFiles: string[],
	options?: {
		testFiles?: string[];
		readFile?: (file: string) => string;
		exclusions?: Record<string, { reason?: string }>;
	},
): {
	related: Map<string, Set<string>>;
	covered: string[];
	uncovered: string[];
	tests: string[];
	excluded: Array<{ file: string; reason: string }>;
	priorities: Map<string, number>;
};
export declare function parseChangedLineRanges(
	diffText: string,
): Map<string, Array<[number, number]>>;
export declare function mutationRangePatterns(
	files: string[],
	rangesByFile: Map<string, Array<[number, number]>>,
): string[];
export declare function describeStrykerFailure(
	result: {
		status: number | null;
		signal?: NodeJS.Signals | null;
		error?: Error & { code?: string };
	},
	budgetMinutes: number,
	options?: {
		tests?: string[];
		output?: string;
		dryRunTimeoutMinutes?: number;
	},
): string;
export declare function describePartialMutationOutcome(
	result: {
		status: number | null;
		signal?: NodeJS.Signals | null;
		error?: Error & { code?: string };
	},
	budgetMinutes: number,
	partial: {
		evaluated: number;
		total: number | null;
	},
): string;
export declare function sampleRangesDeterministically(
	patterns: string[],
	limit: number,
	seed: string,
): { selected: string[]; sampled: boolean };
export type MutantFit = {
	selected: string[];
	mutants: number | null;
	passes: number;
	unverified: boolean;
};
export declare function fitSampleToMutantAllowance(args: {
	patterns: string[];
	startCount: number;
	allowedMutants: number;
	seed: string;
	countMutants: (selection: string[]) => number | null;
}): MutantFit;
export declare function describeSampledMutants(
	fit: MutantFit,
	allowedMutants: number,
): string;
export declare function extractSnippet(
	sourceLines: string[],
	location:
		| {
				start: { line: number; column: number };
				end: { line: number; column: number };
		  }
		| undefined,
): string | undefined;
export declare function buildRunConfig(
	baseConfig: Record<string, unknown> & { commandRunner?: object },
	options: { command: string; reuse?: boolean },
): Record<string, unknown>;
export declare function parseDryRunCost(
	output: string,
): { totalMutants: number; dryRunMs: number } | null;
export declare function estimateAffordableMutants(args: {
	remainingMs: number;
	dryRunMs: number;
	fixedOverheadMs?: number;
	safetyFactor?: number;
}): number;
export declare function dedupePatterns(patterns: string[]): string[];
export declare function describeZeroMutantOutcome(args: {
	sampled: boolean;
	rangesEvaluated: number;
	rangesTotal: number;
	totalMutants: number | null;
}): string;
export declare function decideMutationOutcome(args: {
	interrupted: boolean;
	mutants: Array<{ status: string }>;
	sampled: boolean;
	rangesEvaluated: number;
	rangesTotal: number;
	totalMutants: number | null;
	failureReason?: string;
	partialReason?: string;
}): {
	zeroMutants: { reason: string } | null;
	partial: { reason: string; evaluated: number; total: number | null } | null;
};
export declare function planResample(args: {
	allPatterns: string[];
	triedPatterns: string[];
	keepRangeCount: number;
	seed: string;
	attemptsSoFar: number;
	maxAttempts: number;
	sample?: (
		patterns: string[],
		limit: number,
		seed: string,
	) => { selected: string[] };
}): { retry: false } | { retry: true; patterns: string[] };
export declare function augmentAndSummarize(
	strykerReport: { files?: Record<string, { mutants?: any[] }> },
	compiledIndexByJsFile: Map<string, { index: object; tsFile: string }>,
	options?: { readFile?: (file: string) => string },
): { mutants: any[]; counts: Record<string, number>; score: string };

export declare function selectMutationFiles(options: {
	pending?: string[];
	windowFiles: string[];
	maxFiles?: number;
	weights?: Map<string, number>;
}): { selected: string[]; skipped: string[] };
export declare function partitionMutationFiles(options: {
	selected: string[];
	skipped: string[];
	shardIndex?: number;
	shardCount?: number;
}): { selected: string[]; skipped: string[] };
export declare function collectChangedRanges(options: {
	files: string[];
	baseRef: string;
	baseOf?: Map<string, string>;
	diff: (base: string, files: string[]) => Map<string, Array<[number, number]>>;
}): Map<string, Array<[number, number]>>;
export declare const isQueueablePath: (file: unknown) => boolean;
export declare function parseQueueEntry(
	spelling: unknown,
): { file: string; base: string | null } | null;
export declare const formatQueueEntry: (entry: {
	file: string;
	base: string | null;
}) => string;
