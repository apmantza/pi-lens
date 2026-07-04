import * as path from "node:path";
import type {
	GovulncheckFinding,
	GovulncheckResult,
} from "../../govulncheck-client.js";
import type { ProjectDiagnostic } from "../types.js";

/**
 * A govulncheck finding is a vulnerable dependency *reachable* from the code via
 * a call trace. Anchor the diagnostic at the first trace frame that has a source
 * position (the reachable call site in the project), falling back to the project
 * root when the trace carries no file. Advisory (warning) — a reachable CVE is
 * worth surfacing but is not a code-blocking error.
 */
export function govulncheckFindingToProjectDiagnostic(
	cwd: string,
	finding: GovulncheckFinding,
): ProjectDiagnostic {
	const frame = finding.trace?.find((f) => f.filename);
	const filePath = frame?.filename
		? path.isAbsolute(frame.filename)
			? frame.filename
			: path.resolve(cwd, frame.filename)
		: cwd;
	const fix = finding.fixedVersion ? ` (fixed in ${finding.fixedVersion})` : "";
	return {
		filePath,
		line: frame?.line,
		severity: "warning",
		semantic: "warning",
		tool: "govulncheck",
		runner: "govulncheck",
		rule: `govulncheck:${finding.osv}`,
		code: finding.packageName ?? finding.module,
		message: `Vulnerability ${finding.osv}: ${finding.summary ?? "reachable vulnerable dependency"}${fix}`,
		source: "project-scan",
	};
}

export function govulncheckResultToProjectDiagnostics(
	cwd: string,
	result: GovulncheckResult,
): ProjectDiagnostic[] {
	if (!result.success || result.findings.length === 0) return [];
	return result.findings.map((finding) =>
		govulncheckFindingToProjectDiagnostic(cwd, finding),
	);
}
