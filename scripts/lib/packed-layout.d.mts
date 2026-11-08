export const UNBUNDLED_PREFIXES: readonly string[];

export const COMPUTED_ADMISSIONS: readonly {
	file: string;
	kind: string;
	argument: string;
	reason: string;
}[];

export function packedLayoutViolations(
	packedPaths: readonly string[],
	readText: (packedPath: string) => string,
): string[];

export function packedImportResolutionViolations(
	packedPaths: readonly string[],
	readText: (packedPath: string) => string,
	tally?: { relative: number },
): string[];
