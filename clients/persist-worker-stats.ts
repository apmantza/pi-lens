/** Common V8 heap snapshot shape for the two long-lived persist workers. */
export interface PersistWorkerHeapStatistics {
	heapUsedBytes: number;
	heapTotalBytes: number;
	heapSizeLimitBytes: number;
}

export interface WorkerHeapStatisticsSource {
	getHeapStatistics?: () => Promise<{
		used_heap_size: number;
		total_heap_size: number;
		heap_size_limit: number;
	}>;
}

export async function readWorkerHeapStatistics(
	worker: WorkerHeapStatisticsSource,
): Promise<PersistWorkerHeapStatistics> {
	const stats = await worker.getHeapStatistics!();
	return {
		heapUsedBytes: stats.used_heap_size,
		heapTotalBytes: stats.total_heap_size,
		heapSizeLimitBytes: stats.heap_size_limit,
	};
}
