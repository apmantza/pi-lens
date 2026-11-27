export const DEFINITION_FILE: string;
export function findUnboundedAwaitLines(stripped: string): number[];
export function findHandRolledRaceLines(stripped: string): number[];
export function findBoundedCallLines(stripped: string): number[];
export interface BoundedCall {
	line: number;
	form: "thunk" | "promise";
}
export function findBoundedCalls(stripped: string): BoundedCall[];
export function findBoundedReferenceLines(raw: string): number[];
export function isThunkLiteral(first: string): boolean;
export function awaitOccurrenceKey(
	rel: string,
	rawLines: readonly string[],
	index: number,
): string;
export function hookPathFiles(repoRoot: string): string[];
export function localImportTargets(absolute: string): string[];
export function hookHelperModules(repoRoot: string): string[];
export function shippedSourceFiles(repoRoot: string): string[];
export interface FlaggedSite {
	key: string;
	detail: string;
}
/** occurrence key (`call:` prefix, as {@link scanFiles} builds it) -> call form. */
export function scanBoundedCallForms(
	repoRoot: string,
	files: readonly string[],
	skipRel?: (rel: string) => boolean,
): Map<string, "thunk" | "promise">;
export function scanFiles(
	repoRoot: string,
	files: readonly string[],
	detect: (stripped: string) => number[],
	prefix: string,
	skipRel?: (rel: string) => boolean,
): { occurrences: FlaggedSite[]; scanned: number };
