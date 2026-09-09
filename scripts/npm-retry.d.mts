// Type declarations for npm-retry.mjs (untyped .mjs imported from .ts tests). #2613.

export function main(
	args: string[],
	env: Record<string, string | undefined>,
): Promise<number>;

export function classifyNpmFailure(
	stderr: string,
	run?: { timedOut?: boolean; error?: Error; code?: number | null },
): { retryable: boolean; reason: string };
