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
 *   - **Dockerfiles**: overlaps hadolint on a few rules (`:latest`, root, …);
 *     the dispatcher suppresses trivy-config findings that hadolint already
 *     reports at the same line (`suppressTrivyConfigDockerOverlap`), so trivy
 *     only adds the security checks hadolint lacks.
 *
 * Deferred (tracked on #131): Terraform (tflint overlap), Helm chart rendering,
 * Docker Compose, CloudFormation.
 *
 * Gating: the same explicit `trivy.enabled` opt-in as the session-scan modes —
 * trivy is opt-in, period. (Misconfig needs only the small policy bundle, not
 * the 30-200 MB vuln DB, but we keep a single consent switch.) The misconfig
 * `--severity` floor reuses `pi-lens.trivy.minSeverity` (default HIGH).
 *
 * Refs: #131 (Mode 2)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { safeSpawnAsync } from "../../safe-spawn.js";
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
import { createAvailabilityChecker } from "./utils/runner-helpers.js";

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
	appliesTo: ["docker", "yaml"],
	priority: PRIORITY.GENERAL_ANALYSIS,
	enabledByDefault: true,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();

		// Single opt-in switch — trivy is opt-in across all modes.
		if (!isTrivyEnabled(cwd)) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const absPath = path.resolve(cwd, ctx.filePath);

		// YAML is far broader than k8s; only scan files that look like manifests.
		if (ctx.kind === "yaml") {
			let content = "";
			try {
				content = fs.readFileSync(absPath, "utf-8");
			} catch {
				return { status: "skipped", diagnostics: [], semantic: "none" };
			}
			if (!looksLikeKubernetesManifest(content)) {
				return { status: "skipped", diagnostics: [], semantic: "none" };
			}
		}

		let cmd: string | null = null;
		if (await trivy.isAvailableAsync(cwd)) {
			cmd = trivy.getCommand(cwd);
		} else {
			const { ensureTool } = await import("../../installer/index.js");
			const managed = await ensureTool("trivy");
			if (managed) cmd = managed;
		}
		if (!cmd) return { status: "skipped", diagnostics: [], semantic: "none" };

		const severities = resolveSeverityFloor(cwd).join(",");
		const result = await safeSpawnAsync(
			cmd,
			[
				"config",
				"--quiet",
				"--no-progress",
				"--format",
				"json",
				"--severity",
				severities,
				absPath,
			],
			{ cwd, timeout: 60_000 },
		);

		if (result.error && !result.stdout) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const diagnostics = parseTrivyConfigOutput(result.stdout || "", ctx.filePath);
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
