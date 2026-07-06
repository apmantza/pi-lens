import * as path from "node:path";
import type {
	DeadCodeIssue,
	DeadCodeResult,
} from "../../dead-code-client.js";
import type { ProjectDiagnostic } from "../types.js";

function deadCodeMessage(issue: DeadCodeIssue): string {
	if (issue.category === "unlisted") return `Unlisted dependency ${issue.name}`;
	if (issue.category === "dependency") return `Unused dependency ${issue.name}`;
	if (issue.category === "file") return `Unused file ${issue.name}`;
	return `Unused ${issue.kind} ${issue.name}`;
}

/**
 * A dead-code issue (the non-JS/TS analogue of knip — e.g. Python via vulture)
 * at a concrete `file:line`. An *unlisted* dependency is blocking (a real
 * import gap), matching knip; everything else is an advisory warning.
 */
export function deadCodeIssueToProjectDiagnostic(
	cwd: string,
	issue: DeadCodeIssue,
	language: string,
): ProjectDiagnostic {
	const blocking = issue.category === "unlisted";
	return {
		filePath: issue.file
			? path.isAbsolute(issue.file)
				? issue.file
				: path.resolve(cwd, issue.file)
			: cwd,
		line: issue.line,
		severity: blocking ? "error" : "warning",
		semantic: blocking ? "blocking" : "warning",
		tool: "dead-code",
		runner: `dead-code-${language}`,
		rule: `dead-code:${issue.category}`,
		message: deadCodeMessage(issue),
		source: "project-scan",
	};
}

export function deadCodeResultToProjectDiagnostics(
	cwd: string,
	result: DeadCodeResult,
): ProjectDiagnostic[] {
	if (!result.success) return [];
	const issues = [
		...result.unusedExports,
		...result.unusedFiles,
		...result.unusedDeps,
		...result.unlistedDeps,
	];
	return issues.map((issue) =>
		deadCodeIssueToProjectDiagnostic(cwd, issue, result.language),
	);
}
