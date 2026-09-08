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
