export declare function buildEsbuildExecInvocation(args: {
	npmCli: string;
	execPrefix: string;
}): {
	command: string;
	argv: string[];
	options: { cwd: string; stdio: "inherit" };
};

export declare function main(): void;
