/**
 * Ruff runner for dispatch system
 *
 * Dispatch mode is diagnostics-only.
 * Autofix is handled earlier by the post-write pipeline to avoid
 * mutating files mid-dispatch after LSP sync has already happened.
 * Supports venv-local installations.
 */

import { toolAbsentSkip } from "./utils/runner-helpers.js";
import { skipped } from "../types.js";
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
import { finishParsedRun, parseToolRun } from "./utils/tool-failure.js";
import { parseRuffOutput } from "./utils/diagnostic-parsers.js";
import {
	createAvailabilityChecker,
	resolveAvailableOrInstall,
	resolveRunnerCwd,
} from "./utils/runner-helpers.js";
import { semanticFor } from "../types.js";

const ruff = createAvailabilityChecker("ruff", ".exe");

export function parseRuffJson(raw: string, filePath: string): Diagnostic[] {
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
				semantic: semanticFor(severity),
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
			return skipped("not-preferred");
		}
		const cmd = await resolveAvailableOrInstall(ruff, "ruff", cwd);
		if (!cmd) {
			return toolAbsentSkip();
		}

		// Shared config-args seam (#1247): the autofix path consumes the same
		// builder, so the package-owned fallback config can never drift.
		const configArgs = ruffConfigArgs(cwd);

		// Step 1: Capture diagnostics (before fixing) — teaching signal for the agent.
		// `--no-fix --no-fix-only` (#5119): a project `fix = true` or
		// `fix-only = true` would otherwise make this diagnostics-only pass
		// rewrite the file; `--no-fix` alone leaves `fix-only = true` writing.
		const checkResult = await safeSpawnAsync(
			cmd,
			[
				"check",
				"--no-fix",
				"--no-fix-only",
				"--output-format",
				"json",
				...configArgs,
				ctx.filePath,
			],
			{ cwd, timeout: 30000 },
		);

		// EXIT TABLE (Ruff 0.6 docs https://docs.astral.sh/ruff/linter/): 0 = clean, 1 = findings, 2 = findings/error or
		// tool error. A nonzero exit with valid findings stays findings; empty or
		// unparsable output must never become clean (#1816).
		const run = parseToolRun(
			"ruff",
			{ result: checkResult, exitCodes: { ran: [1, 2] } },
			(rawOutput) => {
				// The report is stdout: ruff prints deprecation notices on stderr
				// beside a valid JSON document (#5411).
				const output = stripAnsi(rawOutput);
				const diagnostics = parseRuffJson(output, ctx.filePath);
				return diagnostics.length > 0
					? diagnostics
					: parseRuffOutput(output, ctx.filePath, cwd);
			},
			{ parseStreams: "stdout-else-stderr" },
		);
		if (run.skipped) return run.skipped;
		return finishParsedRun({
			tool: "ruff",
			ctx,
			result: checkResult,
			diagnostics: run.diagnostics,
		});
	},
};

export default ruffRunner;
