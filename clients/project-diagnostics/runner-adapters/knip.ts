import * as path from "node:path";
import type { KnipIssue } from "../../knip-client.js";
import type { ProjectDiagnostic } from "../types.js";

function knipIssueFile(cwd: string, issue: KnipIssue): string {
	if (!issue.file) return cwd;
	return path.isAbsolute(issue.file)
		? issue.file
		: path.resolve(cwd, issue.file);
}

function knipIssueMessage(issue: KnipIssue): string {
	if (issue.type === "unlisted") {
		return `Unlisted dependency ${issue.name}`;
	}
	if (issue.type === "bin") {
		return `Unlisted binary ${issue.name}`;
	}
	if (issue.type === "export") {
		return `Unused export ${issue.name}`;
	}
	if (issue.type === "file") {
		return `Unused file ${issue.name}`;
	}
	if (issue.type === "dependency" || issue.type === "devDependency") {
		return `Unused ${issue.type} ${issue.name}`;
	}
	return `${issue.type}: ${issue.name}`;
}

export function knipIssueToProjectDiagnostic(
	cwd: string,
	issue: KnipIssue,
): ProjectDiagnostic {
	const blocking = issue.type === "unlisted" || issue.type === "bin";
	return {
		filePath: knipIssueFile(cwd, issue),
		line: issue.line,
		severity: blocking ? "error" : "warning",
		semantic: blocking ? "blocking" : "warning",
		tool: "knip",
		runner: "knip",
		rule: `knip:${issue.type}`,
		code: issue.package,
		message: knipIssueMessage(issue),
		source: "project-scan",
	};
}

export function knipIssuesToProjectDiagnostics(
	cwd: string,
	issues: KnipIssue[],
): ProjectDiagnostic[] {
	return issues.map((issue) => knipIssueToProjectDiagnostic(cwd, issue));
}
