export const HISTORY_MAX_AGE_MS: number;
export const METADATA_FILENAME: string;
export function rowsFromArtifacts(inputs: string[]): Array<{
	headSha: string;
	runId: string;
	file: string;
	outcome: string;
	durationMs: number;
	lane: string;
	/** Absent on artifacts written before #3447. */
	runAttempt?: string;
	recordedAt: string;
}>;
export function rollupTestHistory(options: {
	artifactPaths: string[];
	historyPath: string;
	summaryPath: string;
	now?: number;
}): {
	rowCount: number;
	files: unknown[];
	flakeCandidates: Array<{ file: string; headSha: string }>;
};
export function runCli(argv: string[]): number;
