export declare function buildEsbuildExecInvocation(args: {
	npmCli: string;
	execPrefix: string;
}): {
	command: string;
	argv: string[];
	options: { cwd: string; stdio: "inherit" };
};

export declare function main(): void;

/** #3219: `[output path under dist/, tsc input]` for every split entry. */
export declare const SPLIT_ENTRIES: ReadonlyArray<readonly [string, string]>;

export declare function buildSplitEsbuildExecInvocation(args: {
	npmCli: string;
	execPrefix: string;
}): {
	command: string;
	argv: string[];
	options: { cwd: string; stdio: "inherit" };
};
