export declare function runLockfileCompleteness(options?: {
	cwd?: string;
	spawn?: typeof import("node:child_process").spawnSync;
	timeoutMs?: number;
	env?: NodeJS.ProcessEnv;
}): {
	ok: boolean;
	pin: string;
	inconclusive?: boolean;
	reason?: string;
	output?: string;
};
