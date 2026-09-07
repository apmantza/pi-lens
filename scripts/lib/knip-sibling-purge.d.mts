// Type declarations for knip-sibling-purge.mjs (untyped .mjs imported from
// .ts tests).

export interface PurgeDeps {
	/** Injectable git runner for tests; defaults to a real `git` child process. */
	git?: (args: string[]) => string;
	/** Overrides the real runner's buffer cap (tests only). */
	maxBuffer?: number;
	/** Overrides the real runner's wall-clock bound in ms (tests only). */
	timeout?: number;
}

export function purgeCompiledSiblings(
	repoRoot: string,
	deps?: PurgeDeps,
): string[];
