import * as path from "node:path";
import type { GitleaksFinding, GitleaksResult } from "../../gitleaks-client.js";
import type { ProjectDiagnostic } from "../types.js";

/**
 * A gitleaks finding is a leaked secret at a concrete `file:startLine`. Secrets
 * are treated as **blocking** — a committed credential is not a style nit.
 */
export function gitleaksFindingToProjectDiagnostic(
	cwd: string,
	finding: GitleaksFinding,
): ProjectDiagnostic {
	return {
		filePath: path.isAbsolute(finding.file)
			? finding.file
			: path.resolve(cwd, finding.file),
		line: finding.startLine,
		severity: "error",
		semantic: "blocking",
		tool: "gitleaks",
		runner: "gitleaks",
		rule: `gitleaks:${finding.ruleId}`,
		message: `Potential secret: ${finding.description || finding.ruleId}`,
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
