// Type declarations for knip-sibling-purge.mjs (untyped .mjs imported from
// .ts tests).

export interface PurgeDeps {
	/** Injectable git runner for tests; defaults to a real `git` child process. */
	git?: (args: string[]) => string;
}

export function purgeCompiledSiblings(
	repoRoot: string,
	deps?: PurgeDeps,
): string[];
