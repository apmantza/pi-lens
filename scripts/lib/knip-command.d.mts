// Type declarations for knip-command.mjs (untyped .mjs imported from .ts
// tests).

export interface CommandDeps {
	/** Injectable module resolver for tests; defaults to a real `require.resolve`. */
	resolve?: (specifier: string) => string;
}

export function resolveKnipCommand(
	extraArgs: string[],
	deps?: CommandDeps,
): { command: string; args: string[] };
