export declare const SHARD_WEIGHTS_FILE: string;
export declare function loadShardWeights(filePath: string): {
	files: Record<string, number>;
	median: number;
};
export declare function median(values: number[]): number;
export declare const PROJECT_PARALLELISM: Readonly<Record<string, number>>;
export declare function projectWorkers(projectName: unknown): number;
export declare function specCost(seconds: number, workers: number): number;
export declare function assignShards(
	items: Array<{ id: string; cost: number }>,
	count: number,
): Map<string, number>;
export declare function shardLoads(
	items: Array<{ id: string; cost: number }>,
	assignment: Map<string, number>,
	count: number,
): { loads: number[]; files: number[] };
