export declare const WORKER_PEAK_RSS_BUDGET_MB: number;
export declare const NON_WORKER_RESERVE_MB: number;
export declare const MAX_WORKER_HEAP_MB: number;
export declare const MIN_WORKER_HEAP_MB: number;

export interface TestWorkerHost {
	totalMemMb: number;
	cpus: number;
	ci: boolean;
	workerOverride?: number;
	heapOverride?: number;
}

export interface TestWorkerBudget {
	maxWorkers: number | string;
	heavyMaxWorkers: number;
	heapMb: number;
	cpuCap: number;
	memCap: number;
}

export declare function resolveTestWorkerBudget(
	host: TestWorkerHost,
): TestWorkerBudget;

export declare function formatTestWorkerBudget(
	host: { totalMemMb: number; cpus: number },
	budget: TestWorkerBudget,
): string;
