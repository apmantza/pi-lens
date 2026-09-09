export declare function createIsolatedExecPrefix(): string;

export declare function buildIsolatedExecInvocation(args: {
	npmCli: string;
	execPrefix: string;
	cwd: string;
	packageSpec: string;
	execArgv: string[];
}): {
	command: string;
	argv: string[];
	options: { cwd: string; stdio: "inherit" };
};
