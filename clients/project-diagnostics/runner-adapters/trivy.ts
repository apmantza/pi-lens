import * as path from "node:path";
import type { TrivyFinding, TrivyResult } from "../../trivy-client.js";
import type { ProjectDiagnostic } from "../types.js";

/**
 * A trivy finding is a CVE in a dependency — a *dependency-level* finding, not a
 * source location. Anchor it at the manifest/lockfile it was found in (`target`),
 * with no line. Advisory (warning); the CVE severity is carried in the message.
 */
export function trivyFindingToProjectDiagnostic(
	cwd: string,
	finding: TrivyFinding,
): ProjectDiagnostic {
	const filePath = finding.target
		? path.isAbsolute(finding.target)
			? finding.target
			: path.resolve(cwd, finding.target)
		: cwd;
	const version = finding.installedVersion ? `@${finding.installedVersion}` : "";
	const fix = finding.fixedVersion ? ` (fixed in ${finding.fixedVersion})` : "";
	return {
		filePath,
		severity: "warning",
		semantic: "warning",
		tool: "trivy",
		runner: "trivy",
		rule: `trivy:${finding.vulnerabilityId}`,
		code: finding.pkgName,
		message: `${finding.severity} vulnerability ${finding.vulnerabilityId} in ${finding.pkgName}${version}${fix}`,
		source: "project-scan",
	};
}

export function trivyResultToProjectDiagnostics(
	cwd: string,
	result: TrivyResult,
): ProjectDiagnostic[] {
	if (!result.success || result.findings.length === 0) return [];
	return result.findings.map((finding) =>
		trivyFindingToProjectDiagnostic(cwd, finding),
	);
}
