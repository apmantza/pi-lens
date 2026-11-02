type GitFixtureEnvOptions = { keep?: string[] };

type GitOptions = {
	gitFixtureEnv?: GitFixtureEnvOptions;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	encoding?: BufferEncoding;
	stdio?: "ignore" | "pipe" | "inherit";
	maxBuffer?: number;
};

export function envFor(
	cwd: string,
	overrides?: Record<string, string | undefined>,
	options?: GitFixtureEnvOptions,
): Record<string, string | undefined>;
export function gitExecFileSync(
	args: string[],
	options?: GitOptions,
): Buffer | string;
export function gitExecSync(
	command: string,
	options?: GitOptions,
): Buffer | string;
