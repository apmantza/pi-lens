import * as path from "node:path";
import type { DuplicateClone, JscpdResult } from "../../jscpd-client.js";
import type { ProjectDiagnostic } from "../types.js";

function resolveClonePath(cwd: string, file: string): string {
	return path.isAbsolute(file) ? file : path.resolve(cwd, file);
}

/**
 * A jscpd clone is a *relationship* between two spans (`fileA:startA` ↔
 * `fileB:startB`), unlike a single-point knip finding. Emit a diagnostic on
 * BOTH ends so the duplication surfaces on whichever file the agent is looking
 * at, each one naming the other end.
 */
export function jscpdCloneToProjectDiagnostics(
	cwd: string,
	clone: DuplicateClone,
): ProjectDiagnostic[] {
	const a = resolveClonePath(cwd, clone.fileA);
	const b = resolveClonePath(cwd, clone.fileB);

	const make = (
		filePath: string,
		line: number,
		otherFile: string,
		otherLine: number,
	): ProjectDiagnostic => ({
		filePath,
		line,
		severity: "warning",
		semantic: "warning",
		tool: "jscpd",
		runner: "jscpd",
		rule: "jscpd:duplicate",
		message: `Duplicate code (${clone.lines} lines) — also at ${path.relative(cwd, otherFile)}:${otherLine}`,
		source: "project-scan",
	});

	return [
		make(a, clone.startA, b, clone.startB),
		make(b, clone.startB, a, clone.startA),
	];
}

/**
 * Map a whole jscpd scan into per-file `ProjectDiagnostic`s (two per clone).
 * Empty when the scan failed or found no duplication.
 */
export function jscpdResultToProjectDiagnostics(
	cwd: string,
	result: JscpdResult,
): ProjectDiagnostic[] {
	if (!result.success || result.clones.length === 0) return [];
	return result.clones.flatMap((clone) =>
		jscpdCloneToProjectDiagnostics(cwd, clone),
	);
}
