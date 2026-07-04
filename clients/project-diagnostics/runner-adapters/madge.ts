import * as path from "node:path";
import type { CircularDep } from "../../dependency-checker.js";
import type { ProjectDiagnostic } from "../types.js";

function resolveCyclePath(cwd: string, file: string): string {
	return path.isAbsolute(file) ? file : path.resolve(cwd, file);
}

/** The files making up a cycle: prefer the full `path`, fall back to `file`. */
function cycleMembers(dep: CircularDep): string[] {
	return dep.path.length > 0 ? dep.path : [dep.file];
}

/**
 * A madge circular dependency is a *set* of files (`a → b → c → a`), unlike a
 * single-point knip finding. Emit a diagnostic on EACH file in the cycle so it
 * surfaces wherever the agent is looking, each one rendering the whole cycle.
 */
export function circularDepToProjectDiagnostics(
	cwd: string,
	dep: CircularDep,
): ProjectDiagnostic[] {
	const members = cycleMembers(dep);
	const rendered = `${members.map((f) => path.basename(f)).join(" → ")} → ${path.basename(members[0] ?? "")}`;
	return members.map((file) => ({
		filePath: resolveCyclePath(cwd, file),
		severity: "warning",
		semantic: "warning",
		tool: "madge",
		runner: "madge",
		rule: "madge:circular",
		message: `Part of circular dependency: ${rendered}`,
		source: "project-scan",
	}));
}

/**
 * Map madge's circular-dependency findings into per-file `ProjectDiagnostic`s.
 * Deduplicates cycles reported from different anchor files (same member set), so
 * a cycle is emitted once per participating file, not once per anchor.
 */
export function circularDepsToProjectDiagnostics(
	cwd: string,
	circular: CircularDep[],
): ProjectDiagnostic[] {
	const seen = new Set<string>();
	const out: ProjectDiagnostic[] = [];
	for (const dep of circular) {
		const key = cycleMembers(dep)
			.map((f) => resolveCyclePath(cwd, f))
			.sort((a, b) => a.localeCompare(b))
			.join("|");
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(...circularDepToProjectDiagnostics(cwd, dep));
	}
	return out;
}
