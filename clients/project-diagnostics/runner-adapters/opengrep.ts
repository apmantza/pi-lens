import * as path from "node:path";
import type {
	OpengrepFinding,
	OpengrepResult,
} from "../../opengrep-client.js";
import type {
	ProjectDiagnostic,
	ProjectDiagnosticSeverity,
} from "../types.js";

/**
 * opengrep's `extra.severity` is semgrep-compatible: `ERROR` / `WARNING` /
 * `INFO` (verified against the real installed 1.25.0 binary's `--json`
 * output). `ERROR` is treated as blocking — the same convention gitleaks
 * secrets and knip's "unlisted dependency" findings use.
 */
function severityFor(raw: string): {
	severity: ProjectDiagnosticSeverity;
	blocking: boolean;
} {
	switch (raw.toUpperCase()) {
		case "ERROR":
			return { severity: "error", blocking: true };
		case "INFO":
			return { severity: "info", blocking: false };
		default:
			return { severity: "warning", blocking: false };
	}
}

export function opengrepFindingToProjectDiagnostic(
	cwd: string,
	finding: OpengrepFinding,
): ProjectDiagnostic {
	const { severity, blocking } = severityFor(finding.severity);
	const cweSuffix = finding.cwe?.length ? ` (${finding.cwe[0]})` : "";
	return {
		filePath: path.isAbsolute(finding.path)
			? finding.path
			: path.resolve(cwd, finding.path),
		line: finding.startLine,
		column: finding.startCol,
		severity,
		semantic: blocking ? "blocking" : "warning",
		tool: "opengrep",
		runner: "opengrep",
		rule: `opengrep:${finding.checkId}`,
		message: `${finding.message}${cweSuffix}`,
		source: "project-scan",
	};
}

export function opengrepResultToProjectDiagnostics(
	cwd: string,
	result: OpengrepResult,
): ProjectDiagnostic[] {
	if (!result.success || result.findings.length === 0) return [];
	return result.findings.map((finding) =>
		opengrepFindingToProjectDiagnostic(cwd, finding),
	);
}
