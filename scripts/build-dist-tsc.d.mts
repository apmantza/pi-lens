export declare function resolveLocalTsc(args: {
	root: string;
	version: string;
}): string | null;

export declare function planTscInvocation(args: {
	localTscBin: string | null;
	root: string;
	version: string;
	npmCli: string;
	execPrefix?: string;
	tsconfigProject: string;
}): {
	command: string;
	argv: string[];
	options: { cwd: string; stdio: "inherit" };
};

export declare function main(): void;
