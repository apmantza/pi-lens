export declare const PR_FILES_API_CAP: number;
export declare function classifyChangedFiles(paths: string[]): {
	code: boolean;
	formal: boolean;
	reason: string;
};
export declare function pathsFromPrFiles(
	files: Array<{ filename: string; previous_filename?: string }>,
): string[];
export declare function parseArgs(argv: string[]): {
	event: string;
	repo: string | null;
	pr: string | null;
};
export declare function run(
	argv: string[],
	io?: {
		env?: NodeJS.ProcessEnv;
		fetchFiles?: (repo: string, pr: string) => string[];
		log?: (line: string) => void;
	},
): number;
