export declare function buildWeights(runDirs: string[]): Record<string, number>;
export declare function buildWeightsFromJournal(
	lines: Array<string | object>,
	days: number,
): { files: Record<string, number>; days: string[] };
