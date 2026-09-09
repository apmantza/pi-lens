/**
 * Ruff runner for dispatch system
 *
 * Dispatch mode is diagnostics-only.
 * Autofix is handled earlier by the post-write pipeline to avoid
 * mutating files mid-dispatch after LSP sync has already happened.
 * Supports venv-local installations.
 */

import { safeSpawnAsync } from "../../safe-spawn.js";
import { stripAnsi } from "../../sanitize.js";
import {
	getAutofixCapability,
	getLinterPolicyForCwd,
	ruffConfigArgs,
} from "../../tool-policy.js";
import { PRIORITY } from "../priorities.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { parseRuffOutput } from "./utils/diagnostic-parsers.js";
import {
	createAvailabilityChecker,
	resolveAvailableOrInstall,
	resolveRunnerCwd,
} from "./utils/runner-helpers.js";

const ruff = createAvailabilityChecker("ruff", ".exe");

function parseRuffJson(raw: string, filePath: string): Diagnostic[] {
	try {
		const parsed = JSON.parse(raw) as Array<{
			code?: string;
			message?: string;
			filename?: string;
			location?: { row?: number; column?: number };
			severity?: string;
			fix?: unknown;
		}>;
		if (!Array.isArray(parsed)) return [];

		const autofix = getAutofixCapability("ruff");
		return parsed.map((item, index) => {
			const severity = item.severity === "error" ? "error" : "warning";
			const code = item.code || "ruff";
			const toolFixable = Boolean(item.fix);
			return {
				id: `ruff-${code}-${item.location?.row ?? index + 1}`,
				message: item.message || code,
				filePath: item.filename || filePath,
				line: item.location?.row ?? 1,
				column: item.location?.column ?? 1,
				severity,
				semantic: severity === "error" ? "blocking" : "warning",
				tool: "ruff",
				rule: code,
				fixable: toolFixable,
				autoFixAvailable:
					toolFixable && (autofix?.safePipelineAutofix ?? false),
				fixKind:
					toolFixable && autofix?.fixKind !== "none"
						? autofix?.fixKind
						: undefined,
			};
		});
	} catch {
		return [];
	}
}

const ruffRunner: RunnerDefinition = {
	id: "ruff-lint",
	appliesTo: ["python"],
	priority: PRIORITY.FORMAT_AND_LINT_PRIMARY,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = resolveRunnerCwd(ctx, "ruff");
		const policy = getLinterPolicyForCwd(ctx.filePath, cwd);
		if (policy && !policy.preferredRunners.includes("ruff-lint")) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}
		const cmd = await resolveAvailableOrInstall(ruff, "ruff", cwd);
		if (!cmd) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// Shared config-args seam (#1247): the autofix path consumes the same
		// builder, so the package-owned fallback config can never drift.
		const configArgs = ruffConfigArgs(cwd);

		// Step 1: Capture diagnostics (before fixing) — teaching signal for the agent
		const checkResult = await safeSpawnAsync(
			cmd,
			["check", "--output-format", "json", ...configArgs, ctx.filePath],
			{ cwd, timeout: 30000 },
		);

		const raw = stripAnsi(checkResult.stdout + checkResult.stderr);
		const diagnostics = parseRuffJson(checkResult.stdout || "", ctx.filePath);
		const parsedDiagnostics =
			diagnostics.length > 0 ? diagnostics : parseRuffOutput(raw, ctx.filePath);

		if (checkResult.status === 0 && parsedDiagnostics.length === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		if (parsedDiagnostics.length === 0) {
			return {
				status: "failed",
				diagnostics: [],
				semantic: "warning",
				rawOutput: raw.slice(0, 500),
			};
		}

		const hasErrors = parsedDiagnostics.some((d) => d.severity === "error");

		return {
			status: hasErrors ? "failed" : "succeeded",
			diagnostics: parsedDiagnostics,
			semantic: hasErrors ? "blocking" : "warning",
		};
	},
};

export default ruffRunner;
