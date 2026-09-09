export const SCRATCH_DIR_ROOT: string;
export const SCRATCH_OWNER_FILE: string;
export function claimScratchDir(root: string, prefix: string): string;
export function sweepScratchDirs(
	root: string,
	prefix: string,
	options?: { maxAgeMs?: number },
): number;
