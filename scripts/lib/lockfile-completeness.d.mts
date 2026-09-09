export declare const LOCKFILE_COMPLETENESS_TIMEOUT_MS: number;
export declare function getPinnedNpmVersion(cwd?: string): string;
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
