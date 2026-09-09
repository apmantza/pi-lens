// Type declarations for resolve-newest-in-range-host.mjs (untyped .mjs
// imported from .ts tests). #2613.

export const SUPPORTED_RANGE_ENV_VAR: string;

export function readPeerRange(
	pkg: Record<string, unknown>,
	packageName: string,
): string;

export function readSupportedRangeEnv(
	env: Record<string, string | undefined>,
): string;

export function pickNewestInRange(
	versions: readonly string[],
	ranges: string | readonly string[],
): string | null;
