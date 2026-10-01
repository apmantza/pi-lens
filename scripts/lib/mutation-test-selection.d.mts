export type ChangedRanges = Array<[number, number]>;
export declare function coveredChangedLines(
	entry: {
		statementMap?: Record<
			string,
			{ start: { line: number }; end: { line: number } }
		>;
		s?: Record<string, number>;
	},
	ranges: ChangedRanges,
): number;
export declare function coveredChangedLinesInReport(
	coverage: Record<string, object>,
	rangesByFile: Map<string, ChangedRanges>,
	root?: string,
): number;
export declare const INCREMENTAL_FINGERPRINT_PATH: string;
export declare const PROBE_REPORTS_ROOT: string;
export declare function probeReportsDirectory(test: string): string;
export declare function buildCoverageProbeArgs(
	test: string,
	includeFiles: string[],
	reportsDirectory: string,
	options?: { testTimeoutMs?: number },
): string[];
export type TestProbeResult = { lines: number } | { unknown: string };
export declare function probeTestCoverage(
	test: string,
	deps: {
		run: (
			test: string,
		) => Promise<{ status: number | null; timedOut?: boolean }>;
		readCoverage: (test: string) => Record<string, object> | null;
		rangesByFile: Map<string, ChangedRanges>;
		root?: string;
	},
): Promise<TestProbeResult>;
export declare function probeAllTests(
	tests: string[],
	probe: (test: string) => Promise<TestProbeResult>,
	options: { concurrency: number; signal?: AbortSignal },
): Promise<Map<string, number | null>>;
export declare function ownTestFiles(changedPaths: string[]): string[];
export declare function partitionOwnTests(
	changedPaths: string[],
	deps: {
		exists: (file: string) => boolean;
		exclusionOf: (file: string) => { file: string; reason: string } | null;
		alreadyExcluded?: Array<{ file: string }>;
	},
): { own: string[]; excluded: Array<{ file: string; reason: string }> };
export declare function probeConcurrency(cpus: number): number;
export type TestSelection = {
	mode: "coverage" | "import-graph";
	pool: number;
	covering: number | null;
	kept: string[];
	dropped: string[];
	own: string[];
	unknown: string[];
};
export declare function selectMutationTests(args: {
	related: string[];
	ownTests?: string[];
	priorities?: Map<string, number>;
	lines: Map<string, number | null> | null;
	maxTests: number;
}): TestSelection;
export declare function fingerprintPaths(args: {
	changedFiles: string[];
	mutatedFiles: string[];
	keptTests: string[];
}): string[];
export declare function fingerprintEntries(
	entries: Array<[string, string]>,
): string;
export declare function buildFingerprint(args: {
	forkPoint: string;
	nodeVersion: string;
	read: (file: string) => string;
	changedFiles: string[];
	mutatedFiles: string[];
	keptTests: string[];
}): string;
export declare function decideIncrementalReuse(args: {
	hasIncrementalFile: boolean;
	previous: string | null;
	current: string;
}): {
	reuse: boolean;
	state: "cold-no-cache" | "cold-inputs-changed" | "warm";
};
export declare function pruneIncrementalReport<
	T extends {
		files: Record<
			string,
			{
				mutants: Array<{
					location: { start: { line: number }; end: { line: number } };
				}>;
			}
		>;
	},
>(report: T, patterns: string[]): T;
export declare function parseIncrementalReuse(
	log: string,
): { reused: number; total: number } | null;
