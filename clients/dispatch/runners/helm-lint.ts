import * as path from "node:path";
import { PathKeyedMap } from "../../path-keyed-map.js";
import { normalizeMapKey } from "../../path-utils.js";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { truncatedByOutputCap } from "../../spawn-output-cap.js";
import { resolveRunnerCwd } from "../../tool-cwd.js";
import { findNearestDirWithMarker } from "../../workspace-topology.js";
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
	type AvailabilityOutcome,
} from "./utils/runner-helpers.js";

const helm = createAvailabilityChecker("helm", ".exe");
const inFlightByChartRoot = new PathKeyedMap<Promise<RunnerResult>>(
	normalizeMapKey,
);
const HELM_LINT_TIMEOUT_MS = 30_000;
// `helm lint` prints one `[LEVEL]` line per finding for one chart, so nothing
// legitimate approaches 8 MiB: this bounds a wedged or runaway helm rather than
// real lint output, and it is what makes `outputTruncated` reachable for this
// runner at all (#2100). Same value as the sibling report caps.
const MAX_HELM_LINT_OUTPUT_BYTES = 8 * 1024 * 1024;

const SKIPPED: RunnerResult = {
	status: "skipped",
	diagnostics: [],
	semantic: "none",
};

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(
		normalizeMapKey(root),
		normalizeMapKey(candidate),
	);
	return (
		relative === "" ||
		(!relative.startsWith(`..${path.sep}`) &&
			relative !== ".." &&
			!path.isAbsolute(relative))
	);
}

function diagnosticLocation(
	message: string,
	chartRoot: string,
): { filePath: string; line?: number; message: string } {
	const location = message.match(
		/(?:^|\s)([^:\r\n]+\.(?:ya?ml|tpl|json))(?::(\d+))?(?::\d+)?(?::|\s)/i,
	);
	if (!location) {
		return { filePath: path.join(chartRoot, "Chart.yaml"), message };
	}
	const candidate = path.resolve(chartRoot, location[1]);
	return {
		filePath: isWithin(chartRoot, candidate)
			? candidate
			: path.join(chartRoot, "Chart.yaml"),
		line: location[2] ? Number(location[2]) : undefined,
		message,
	};
}

export function parseHelmLintOutput(
	raw: string,
	chartRoot: string,
): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	for (const line of raw.split(/\r?\n/)) {
		const match = line.trim().match(/^\[(INFO|WARNING|ERROR)\]\s*(.+)$/);
		if (!match) {
			// helm indents multi-line diagnostic detail under its [LEVEL] header
			// (#1342 review): fold continuation text into the open diagnostic
			// instead of silently dropping it.
			const last = diagnostics[diagnostics.length - 1];
			if (last && /^\s+\S/.test(line)) {
				last.message += `
${line.trim()}`;
			}
			continue;
		}
		const level = match[1];
		const location = diagnosticLocation(match[2].trim(), chartRoot);
		const severity =
			level === "ERROR" ? "error" : level === "WARNING" ? "warning" : "info";
		diagnostics.push({
			id: `helm-lint-${diagnostics.length + 1}-${level.toLowerCase()}`,
			message: location.message,
			filePath: location.filePath,
			line: location.line,
			column: 1,
			severity,
			semantic: severity === "error" ? "blocking" : "warning",
			tool: "helm-lint",
			rule: level.toLowerCase(),
			fixable: false,
		});
	}
	return diagnostics;
}

function failedResult(kind: string, message: string): RunnerResult {
	return {
		status: "failed",
		diagnostics: [],
		semantic: "warning",
		failureKind: kind,
		failureMessage: message.slice(0, 200),
	};
}

async function lintChart(
	chartRoot: string,
	cwd: string,
): Promise<RunnerResult> {
	const cmd = await resolveAvailableOrInstall(helm, "helm", cwd);
	if (!cmd) {
		const outcome: AvailabilityOutcome | null = helm.getOutcome(cwd);
		return {
			status: "failed",
			diagnostics: [],
			semantic: "warning",
			failureKind: "unavailable",
			failureMessage: `helm unavailable (${outcome ?? "unknown"})`,
		};
	}

	const result = await safeSpawnAsync(cmd, ["lint", chartRoot], {
		cwd,
		timeout: HELM_LINT_TIMEOUT_MS,
		deadlineAt: Date.now() + HELM_LINT_TIMEOUT_MS,
		resourceLabel: "helm-lint",
		maxOutputBytes: MAX_HELM_LINT_OUTPUT_BYTES,
	});
	// FIRST (#2100): the cap kill is OUR SIGTERM, so it also sets
	// `spawnFailure.kind === "killed"` and `failure === "signal"`. Read after
	// those two, a truncated lint was reported as a server_error — helm blamed
	// for output we threw away. A timed-out or aborted run carries
	// `outputTruncated` too, and `truncatedByOutputCap` leaves those to the
	// typed-failure block below so they keep reporting timeout/aborted.
	if (truncatedByOutputCap(result)) {
		return failedResult(
			"parser_error",
			"helm lint output was truncated before parsing completed",
		);
	}
	const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
	const diagnostics = parseHelmLintOutput(output, chartRoot);
	const typedFailure = result.spawnFailure?.kind;
	if (typedFailure) {
		const failureKind =
			typedFailure === "tool-not-found"
				? "unavailable"
				: typedFailure === "timeout"
					? "timeout"
					: typedFailure === "killed" && result.failure === "aborted"
						? "aborted"
						: "server_error";
		return failedResult(
			failureKind,
			result.error?.message || `helm lint ${typedFailure}`,
		);
	}
	if (result.failure) {
		return failedResult(
			result.failure === "timeout" ? "timeout" : result.failure,
			result.error?.message || `helm lint ${result.failure}`,
		);
	}
	const hasErrorDiagnostic = diagnostics.some(
		(diagnostic) => diagnostic.severity === "error",
	);
	if (result.status !== 0 && !hasErrorDiagnostic) {
		return failedResult(
			output.trim() ? "parser_error" : "server_error",
			output.trim() || "helm lint exited without an error diagnostic",
		);
	}
	return {
		status: "succeeded",
		diagnostics,
		semantic: diagnostics.some((item) => item.severity === "error")
			? "blocking"
			: diagnostics.length > 0
				? "warning"
				: "none",
	};
}

const helmLintRunner: RunnerDefinition = {
	id: "helm-lint",
	appliesTo: ["yaml", "helm-template"],
	priority: PRIORITY.GENERAL_ANALYSIS,
	skipTestFiles: false,
	timeoutMs: 35_000,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = resolveRunnerCwd(ctx, "helm");
		const workspaceRoot = path.resolve(ctx.projectRoot ?? ctx.cwd);
		const startDir = path.dirname(path.resolve(ctx.filePath));
		const discovered = findNearestDirWithMarker(startDir, "chartYamlPath");
		if (!discovered) return SKIPPED;
		const chartRoot = path.resolve(discovered);
		if (!isWithin(workspaceRoot, chartRoot)) return SKIPPED;
		const existing = inFlightByChartRoot.get(chartRoot);
		if (existing) return existing;
		const promise = lintChart(chartRoot, cwd).finally(() => {
			if (inFlightByChartRoot.get(chartRoot) === promise)
				inFlightByChartRoot.delete(chartRoot);
		});
		inFlightByChartRoot.set(chartRoot, promise);
		return promise;
	},
};

export default helmLintRunner;
