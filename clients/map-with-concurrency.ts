/**
 * Bounded worker pool — the repo's one shared `mapWithConcurrency`.
 *
 * Lived in `dependency-checker.ts` (its first caller) and was exported from
 * there for `dispatch/runners/biome-check.ts`. #2504 added a third caller,
 * `runtime-turn.ts`'s bounded test-runner batch — and runtime-turn must not
 * drag an ANALYZER client into its eager import graph for a 15-line helper
 * (that is exactly the eager-bootstrap cost #2467 removed). So the value moved
 * to this zero-dependency leaf and `dependency-checker.ts` re-exports it: every
 * existing importer keeps its specifier, and a consumer that only needs the
 * pool no longer loads madge.
 *
 * Same shape as `ledger-bounds.ts` (#2426) for the degradation ledger's bound.
 *
 * Callers that need results use the result-returning overload; callers that
 * only need completion use the void overload. Keeping both forms here prevents
 * per-caller worker-pool copies from drifting.
 */

/**
 * Run `mapper` over `items` with at most `concurrency` in flight at once.
 */
export function mapWithConcurrency<T>(
	items: T[],
	concurrency: number,
	mapper: (item: T) => Promise<void>,
): Promise<void>;
export function mapWithConcurrency<T, R>(
	items: T[],
	concurrency: number,
	mapper: (item: T) => Promise<R>,
): Promise<R[]>;
export async function mapWithConcurrency<T, R>(
	items: T[],
	concurrency: number,
	mapper: (item: T) => Promise<R | void>,
): Promise<R[] | void> {
	if (items.length === 0) return [];
	let nextIndex = 0;
	const workerCount = Math.max(1, Math.min(concurrency, items.length));
	const results = Array<R>(items.length);
	const worker = async (): Promise<void> => {
		while (true) {
			const index = nextIndex++;
			if (index >= items.length) return;
			results[index] = (await mapper(items[index])) as R;
		}
	};
	const workers = Array.from({ length: workerCount }, () => worker());
	await Promise.all(workers);
	return results;
}
