export declare function globToRegExp(glob: string): RegExp;
export declare function matchGlob(glob: string, filePath: string): boolean;
export declare function loadCoverageMap(rootDir?: string): TlaCoverageMap;
export declare function parseChangedFiles(diff?: string): string[];
export declare function validateCoverageMap(
	map: TlaCoverageMap,
	rootDir?: string,
): string[];
export declare function evaluateTlaCoverage(input: {
	map: TlaCoverageMap;
	changedFiles?: readonly string[];
	body?: string;
}): { errors: string[]; advisories: string[] };

export interface TlaCoverageMap {
	$comment?: string;
	version?: number;
	families?: string[];
	map?: Record<string, string | string[]>;
	notes?: Record<string, string>;
}
