import {
	collectSourceFilesWithBudgetAsync,
	type SourceCollectionOptions,
	type SourceCollectionResult,
} from "./source-filter.js";

export interface ProjectSourceCollectionOptions extends SourceCollectionOptions {}

/**
 * Budget-aware twin of {@link collectProjectSourceFilesAsync} (#760): same
 * walk, but returns `{ files, entryBudgetExceeded }` so a caller on a hot
 * path (e.g. the per-edit cascade graph rebuild) can observe that the walk
 * stopped at its `maxScanEntries` entry budget and got a truncated
 * best-effort list rather than a complete enumeration.
 */
export function collectProjectSourceFilesWithBudgetAsync(
	rootDir: string,
	options?: ProjectSourceCollectionOptions & { budgetMs?: number },
): Promise<SourceCollectionResult> {
	return collectSourceFilesWithBudgetAsync(rootDir, options);
}
