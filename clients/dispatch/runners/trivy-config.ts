/**
 * trivy config — per-edit IaC misconfiguration runner (#131 Mode 2).
 *
 * `trivy config <file>` runs Trivy's security-misconfiguration policy engine
 * (the former tfsec/Defsec checks) over infrastructure-as-code. Unlike the
 * dependency-CVE / secret / license modes (whole-tree session scans), misconfig
 * is genuine push-on-edit feedback, so it ships as a dispatch runner alongside
 * hadolint / tflint.
 *
 * v1 scope — the highest-value, lowest-overlap surface:
 *   - **Kubernetes manifests** (yaml with an `apiVersion:` + `kind:` signature):
 *     zero existing coverage in pi-lens, so no dedup needed.
 *   - **CloudFormation templates** (yaml OR json with an
 *     `AWSTemplateFormatVersion` key, or a `Resources` map whose entries carry
 *     an `AWS::`/`Custom::`-namespaced `Type`; refs #1757): same zero-overlap
 *     rationale as Kubernetes — trivy's `cloudformation` misconfig scanner is
 *     the only IaC-misconfig coverage pi-lens has for CFN.
 *   - **Dockerfiles**: overlaps hadolint on a few rules (`:latest`, root, …);
 *     the dispatcher suppresses trivy-config findings that hadolint already
 *     reports at the same line (`suppressTrivyConfigDockerOverlap`), so trivy
 *     only adds the security checks hadolint lacks.
 *
 *   - **Terraform**: the `.tf` language files themselves — trivy evaluates
 *     the Terraform language directly, so no content gate is needed (unlike
 *     the yaml/k8s/CloudFormation heuristics above). Terragrunt (`.hcl`) is
 *     deliberately excluded: trivy has no terragrunt support, and terragrunt
 *     config is covered by the terragrunt runner instead.
 *
 * Deferred (tracked on #131): Helm chart rendering, Docker Compose.
 *
 * Gating: the same explicit `trivy.enabled` opt-in as the session-scan modes —
 * trivy is opt-in, period. (Misconfig needs only the small policy bundle, not
 * the 30-200 MB vuln DB, but we keep a single consent switch.) The misconfig
 * `--severity` floor reuses `pi-lens.trivy.minSeverity` (default HIGH).
 *
 * Refs: #131 (Mode 2)
 */

import { formatToolFailure } from "./utils/tool-failure.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { incrementDegradationCount } from "../../degradation-ledger.js";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { resolveRunnerCwd } from "../../tool-cwd.js";
import {
	isTrivyEnabled,
	resolveSeverityFloor,
	type TrivySeverity,
} from "../../trivy-client.js";
import { PRIORITY } from "../priorities.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import {
	createAvailabilityChecker,
	resolveAvailableOrInstall,
} from "./utils/runner-helpers.js";

const trivy = createAvailabilityChecker("trivy", ".exe");

/**
 * Heuristic: does this YAML look like a Kubernetes manifest (vs a CI workflow,
 * a Compose file, etc.)? A k8s object always declares a top-level `apiVersion:`
 * and `kind:`. Checked per-document so a multi-doc file with at least one k8s
 * object qualifies. Deliberately strict so we don't run trivy on every `.yaml`.
 */
export function looksLikeKubernetesManifest(content: string): boolean {
	for (const doc of content.split(/^---\s*$/m)) {
		if (/^apiVersion:\s*\S/m.test(doc) && /^kind:\s*\S/m.test(doc)) {
			return true;
		}
	}
	return false;
}

/**
 * Heuristic: does this file (yaml OR json) look like a CloudFormation
 * template? The unambiguous signal is the `AWSTemplateFormatVersion` key,
 * present on the vast majority of real templates; SAM templates instead
 * declare `Transform: AWS::Serverless-2016-10-31` (or an array containing
 * it). Templates that skip both still always declare a `Resources` map whose
 * entries carry a `Type` in the `AWS::`/`Custom::`/`Alexa::` namespaces — the
 * one field CFN mandates on every resource. Any one signal qualifies (refs
 * #1757).
 */
export function looksLikeCloudFormationTemplate(content: string): boolean {
	if (/AWSTemplateFormatVersion/.test(content)) return true;
	if (/Transform:\s*(\[.*)?["']?AWS::Serverless/.test(content)) return true;
	return /Type["']?\s*:\s*["']?(AWS|Custom|Alexa)::/.test(content);
}

function normalizeSeverity(raw: unknown): TrivySeverity {
	const s = typeof raw === "string" ? raw.toUpperCase() : "";
	if (s === "CRITICAL" || s === "HIGH" || s === "MEDIUM" || s === "LOW") {
		return s;
	}
	return "UNKNOWN";
}

/**
 * Map Trivy's `config --format json` report to diagnostics. The report is
 * `{ Results: [{ Target, Misconfigurations: [{ ID, Title, Severity,
 * CauseMetadata: { StartLine } }] }] }`. CRITICAL → blocking, the rest advisory.
 * Defensive: malformed input returns `[]`. Exported for unit tests.
 */
export function parseTrivyConfigOutput(
	raw: string,
	filePath: string,
): Diagnostic[] {
	if (!raw.trim()) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	const results = (parsed as { Results?: unknown })?.Results;
	if (!Array.isArray(results)) return [];

	const diagnostics: Diagnostic[] = [];
	for (const resultEntry of results) {
		if (!resultEntry || typeof resultEntry !== "object") continue;
		const rows = (resultEntry as { Misconfigurations?: unknown })
			.Misconfigurations;
		if (!Array.isArray(rows)) continue;
		for (const row of rows) {
			if (!row || typeof row !== "object") continue;
			const m = row as Record<string, unknown>;
			const id = typeof m.ID === "string" ? m.ID : undefined;
			if (!id) continue;
			const cause = (m.CauseMetadata ?? {}) as { StartLine?: unknown };
			const line =
				typeof cause.StartLine === "number" && cause.StartLine > 0
					? cause.StartLine
					: 1;
			const severity = normalizeSeverity(m.Severity);
			const title = typeof m.Title === "string" ? m.Title : id;
			const resolution =
				typeof m.Resolution === "string" && m.Resolution
					? ` ${m.Resolution}`
					: "";
			diagnostics.push({
				id: `trivy-config-${id}-${line}`,
				message: `[${id}] ${title} (${severity}).${resolution}`.trim(),
				filePath,
				line,
				column: 1,
				severity: severity === "CRITICAL" ? "error" : "warning",
				semantic: severity === "CRITICAL" ? "blocking" : "warning",
				defectClass: "safety",
				tool: "trivy-config",
				rule: id,
				fixable: false,
			});
		}
	}
	return diagnostics;
}

const trivyConfigRunner: RunnerDefinition = {
	id: "trivy-config",
	appliesTo: ["docker", "yaml", "terraform", "json"],
	priority: PRIORITY.GENERAL_ANALYSIS,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = resolveRunnerCwd(ctx, "trivy-config");

		// Single opt-in switch — trivy is opt-in across all modes.
		if (!isTrivyEnabled(cwd)) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const absPath = path.resolve(cwd, ctx.filePath);

		// YAML is far broader than k8s/CloudFormation; JSON is far broader than
		// CloudFormation — only scan files that look like one of the IaC
		// manifest shapes trivy's misconfig scanners understand (refs #1757).
		if (ctx.kind === "yaml" || ctx.kind === "json") {
			let content = "";
			try {
				content = fs.readFileSync(absPath, "utf-8");
			} catch {
				return { status: "skipped", diagnostics: [], semantic: "none" };
			}
			const isManifest =
				ctx.kind === "yaml"
					? looksLikeKubernetesManifest(content) ||
						looksLikeCloudFormationTemplate(content)
					: looksLikeCloudFormationTemplate(content);
			if (!isManifest) {
				return { status: "skipped", diagnostics: [], semantic: "none" };
			}
		}

		let cmd: string | null = null;
		if (await trivy.isAvailableAsync(cwd)) {
			cmd = trivy.getCommand(cwd);
		} else {
			const managed = await resolveAvailableOrInstall(trivy, "trivy", cwd);
			if (managed) cmd = managed;
		}
		if (!cmd) return { status: "skipped", diagnostics: [], semantic: "none" };

		const severities = resolveSeverityFloor(cwd).join(",");
		const result = await safeSpawnAsync(
			cmd,
			[
				"config",
				// `--quiet` alone suppresses both the progress bar and log output.
				// `--no-progress` is NOT a `config` subcommand flag (unlike `fs`,
				// which does accept it) — trivy 0.73.0 exits 1 on the rejected
				// flag, but prints its full usage/help text (thousands of bytes)
				// to STDOUT before the FATAL line on stderr. That stdout is
				// non-empty, so an empty-output-only guard did not catch it: the
				// help text failed to JSON-parse, `parseTrivyConfigOutput`
				// returned `[]`, and this reported `{ status: "succeeded",
				// diagnostics: [] }` — a clean scan — on every single real
				// invocation (refs #1757; verified against the real installed
				// binary, not assumed).
				"--quiet",
				"--format",
				"json",
				"--severity",
				severities,
				absPath,
			],
			{ cwd, timeout: 60_000 },
		);

		// `trivy config` is not given `--exit-code`, so it exits 0 whenever it
		// completed (findings included — see parseTrivyConfigOutput's severity
		// mapping for how CRITICAL becomes blocking). ANY nonzero status is
		// therefore a real error, WITH or WITHOUT something on stdout — mirrors
		// the model already in clients/dispatch/runners/helm-render.ts's
		// runIacPass, which has the same "trivy prints usage text on a bad
		// flag" exposure and already got this right. A bounded ledger record
		// means a broken trivy invocation can no longer go unnoticed for an
		// entire lane's lifetime the way this one did (refs #1757).
		if (result.error || result.status !== 0) {
			// #1816: one shared wording, one truncation, signal named. `subject`
			// stays the file path — the discriminating identity a reader needs
			// is WHICH file trivy stopped covering.
			incrementDegradationCount({
				kind: "runner-empty-result",
				subject: absPath,
				reason: formatToolFailure({
					tool: "trivy config",
					status: result.status,
					signal: result.signal,
					stderr: result.stderr || result.error?.message,
					stdout: result.stdout,
				}),
			});
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const diagnostics = parseTrivyConfigOutput(
			result.stdout || "",
			ctx.filePath,
		);
		if (diagnostics.length === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		const hasBlocking = diagnostics.some((d) => d.semantic === "blocking");
		return {
			status: hasBlocking ? "failed" : "succeeded",
			diagnostics,
			semantic: hasBlocking ? "blocking" : "warning",
		};
	},
};

export default trivyConfigRunner;
