export declare function globToRegExp(glob: string): RegExp;
export declare function matchGlob(glob: string, filePath: string): boolean;
export declare function loadCoverageMap(rootDir?: string): TlaCoverageMap;
export declare function parseChangedFiles(diff?: string): string[];
export declare function findHookRanges(
	source: string,
): Map<string, Array<[number, number]>>;
export declare function hookAnchorsFromRanges(
	ranges: ReadonlyMap<string, ReadonlyArray<readonly [number, number]>>,
	hunk: {
		added: ReadonlyMap<number, string>;
		deletedAfter: ReadonlySet<number>;
		removed: readonly string[];
	},
	anchorNames: readonly string[],
): string[];
export declare function changedHookAnchors(
	source: string,
	hunk: {
		added: ReadonlyMap<number, string>;
		deletedAfter: ReadonlySet<number>;
		removed: readonly string[];
	},
	anchorNames: readonly string[],
): string[] | null;
export declare function validateCoverageMap(
	map: TlaCoverageMap,
	rootDir?: string,
): string[];
export declare function evaluateTlaCoverage(input: {
	map: TlaCoverageMap;
	changedFiles?: readonly string[];
	changedAnchors?: readonly string[];
	body?: string;
}): { errors: string[]; advisories: string[] };

export interface TlaCoverageMap {
	$comment?: string;
	version?: number;
	families?: string[];
	map?: Record<string, string | string[] | TlaCoverageAnchoredRow>;
	notes?: Record<string, string>;
}

export interface TlaCoverageAnchoredRow {
	families: string[];
	anchors: Record<string, string[]>;
}
