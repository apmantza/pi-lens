import * as path from "node:path";
import type { GitleaksFinding, GitleaksResult } from "../../gitleaks-client.js";
import type { ProjectDiagnostic } from "../types.js";

/**
 * A gitleaks finding is a leaked secret at a concrete `file:startLine`. Secrets
 * are treated as **blocking** — a committed credential is not a style nit.
 *
 * Findings in scratch trees, gitignored files, and nested repositories are
 * retained for explicit audit but demoted to `severity: "info"` / `semantic:
 * "none"`. They are outside the current repository's shippable source, so they
 * must never read as blocking leaked-secret alarms. Tracked files and ordinary
 * untracked files remain blocking.
 */
export function gitleaksFindingToProjectDiagnostic(
	cwd: string,
	finding: GitleaksFinding,
): ProjectDiagnostic {
	// #1562 observability criterion: surface the git status right in the
	// finding's message so a triage is a read, not a re-derivation. Omitted
	// when git itself degraded (`pathStatus` undefined) rather than guessed.
	const statusSuffix = finding.pathStatus
		? ` [git: ${finding.pathStatus}]`
		: "";
	const isBlocking =
		finding.pathStatus !== "scratch" &&
		finding.pathStatus !== "ignored" &&
		finding.pathStatus !== "nested-repository";
	return {
		filePath: path.isAbsolute(finding.file)
			? finding.file
			: path.resolve(cwd, finding.file),
		line: finding.startLine,
		severity: isBlocking ? "error" : "info",
		semantic: isBlocking ? "blocking" : "none",
		tool: "gitleaks",
		runner: "gitleaks",
		rule: `gitleaks:${finding.ruleId}`,
		message: `Potential secret: ${finding.description || finding.ruleId}${statusSuffix}`,
		source: "project-scan",
	};
}

export function gitleaksResultToProjectDiagnostics(
	cwd: string,
	result: GitleaksResult,
): ProjectDiagnostic[] {
	if (!result.success || result.findings.length === 0) return [];
	return result.findings.map((finding) =>
		gitleaksFindingToProjectDiagnostic(cwd, finding),
	);
}
