export const MAX_ATTEMPTS: number;
export const MAX_RUNS_PER_NIGHT: number;
export const SELECT_OVERLAP_MS: number;
export const LIST_LOOKBACK_MS: number;
export const METADATA_ONLY_MAX_BYTES: number;
export const LIST_PAGE_SIZE: number;
export const MAX_LIST_PAGES: number;
export const ARTIFACT_NAMES: string[];
/** One listed artifact, as the downloader maps the REST listing. */
export interface ListedArtifact {
	id: number;
	name: string;
	size: number;
	createdAt: string;
	expired: boolean;
	runId: number | string;
}
export function listArtifacts(
	fetchPage: (page: number) => ListedArtifact[],
	cutoffMs: number,
	maxPages?: number,
): ListedArtifact[];
export function windowFor(
	since: string | null,
	now: number,
): { selectAfterMs: number; listCutoffMs: number };
export function selectArtifacts(
	artifacts: ListedArtifact[],
	options: {
		since: string | null;
		now: number;
		maxRuns?: number;
		names?: string[];
	},
): {
	runs: Array<{ runId: string; artifacts: ListedArtifact[]; newest: string }>;
	artifacts: ListedArtifact[];
	eligibleRuns: number;
	metadataOnly: number;
	capped: boolean;
};
export function downloadArtifacts(options: {
	repository: string;
	outputDir: string;
	since?: string | null;
	maxRuns?: number;
	names?: string[];
	now?: number;
}): ReturnType<typeof selectArtifacts>;
