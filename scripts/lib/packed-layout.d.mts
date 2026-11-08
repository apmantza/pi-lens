export const UNBUNDLED_PREFIXES: readonly string[];

export function packedLayoutViolations(
	packedPaths: readonly string[],
	readText: (packedPath: string) => string,
): string[];

export function packedImportResolutionViolations(
	packedPaths: readonly string[],
	readText: (packedPath: string) => string,
): string[];
