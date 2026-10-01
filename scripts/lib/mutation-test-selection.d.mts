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
export declare function forkPointOf(
	git: (args: string[]) => string,
	ref: string,
	head: string,
): string;
export declare function parseNameList(output: string): string[];
export declare function runProbeProcess(options: {
	spawn: (
		command: string,
		args: string[],
		options: object,
	) => {
		on: (event: string, listener: (...args: any[]) => void) => unknown;
		kill: (signal: string) => unknown;
	};
	command: string;
	args: string[];
	timeoutMs: number;
}): Promise<{ status: number | null; timedOut: boolean }>;
export declare function readProbeCoverage(
	io: {
		exists: (file: string) => boolean;
		read: (file: string) => string;
		remove: (directory: string) => void;
	},
	directory: string,
): Record<string, object> | null;
export declare function selectionNotes(
	choice: { dropped: string[]; unknown: string[] },
	maxTests: number,
): string[];
export declare function planIncrementalAttempt(args: {
	attempt: number;
	decision: { reuse: boolean; state: string };
}): { reuse: boolean; meta: { state: string } };
export declare function prepareIncrementalFile(args: {
	reuse: boolean;
	patterns: string[];
	read: () => string;
	write: (text: string) => void;
	remove: () => void;
}): boolean;
export declare function withReuseCount<M extends { state: string }>(
	meta: M,
	log: string,
): M | { state: "warm"; reused: number | null; total: number | null };
