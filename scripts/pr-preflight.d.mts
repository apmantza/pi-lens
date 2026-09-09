export declare const GATES: Array<[string, string[], string]>;
export declare function parseArgs(argv: string[]): {
	only?: string;
	skip?: string;
};
export declare function formatSummary(
	rows: Array<{ gate: string; job: string; code: number; firstRed: string }>,
): string;
export declare function runPreflight(options?: {
	cwd?: string;
	argv?: string[];
	spawn?: typeof import("node:child_process").spawnSync;
	env?: NodeJS.ProcessEnv;
}): number;
