export declare const DEFAULT_MAX_FILES: 6;
export declare function capMutationFiles(
	files: string[],
	maxFiles?: number,
): { selected: string[]; skipped: string[] };
export declare function formatCapNotice(
	selectedCount: number,
	totalCount: number,
	skipped: string[],
): string;
export declare const isScriptMutationFile: (file: string) => boolean;
export declare function mapRelatedTests(
	changedFiles: string[],
	options?: {
		testFiles?: string[];
		readFile?: (file: string) => string;
	},
): {
	related: Map<string, Set<string>>;
	covered: string[];
	uncovered: string[];
	tests: string[];
};
