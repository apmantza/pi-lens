/**
 * RuboCop runner for dispatch system
 *
 * Runs rubocop in lint-only mode (no auto-correct) on Ruby files.
 * Auto-correct is handled by the formatter pipeline — this runner
 * only reports remaining offenses after formatting.
 *
 * Supports bundle exec (preferred in Bundler projects).
 */

import * as path from "node:path";
import { pathsEqual } from "../../path-utils.js";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { resolveRunnerCwd } from "../../tool-cwd.js";
import {
	getAutofixCapability,
	getLinterPolicyForCwd,
	getRubocopCommand,
} from "../../tool-policy.js";
import { PRIORITY } from "../priorities.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { resolveCommandArgsWithInstallFallback } from "./utils/runner-helpers.js";
import { finishParsedRun, parseToolRun } from "./utils/tool-failure.js";
import { semanticFor } from "../types.js";

interface RubocopOffense {
	severity: string;
	message: string;
	cop_name: string;
	correctable: boolean;
	location: {
		line: number;
		column: number;
	};
}

interface RubocopFile {
	path: string;
	offenses: RubocopOffense[];
}

interface RubocopOutput {
	files: RubocopFile[];
}

const SEVERITY_MAP: Record<string, "error" | "warning" | "info"> = {
	fatal: "error",
	error: "error",
	warning: "warning",
	convention: "warning",
	refactor: "info",
};

function parseRubocopJson(
	raw: string,
	filePath: string,
	cwd: string,
): Diagnostic[] {
	try {
		const output: RubocopOutput = JSON.parse(raw);
		const autofix = getAutofixCapability("rubocop");
		const diagnostics: Diagnostic[] = [];
		const absTarget = path.resolve(cwd, filePath);

		for (const file of output.files) {
			// #3295: `.rubocop.yml` `Include:`/`inherit_from` can widen the run past
			// the argv, and each result carries its own `path`.
			if (file.path && !pathsEqual(path.resolve(cwd, file.path), absTarget))
				continue;
			for (const offense of file.offenses) {
				const severity = SEVERITY_MAP[offense.severity] ?? "warning";
				diagnostics.push({
					id: `rubocop:${offense.cop_name}:${offense.location.line}`,
					message: `${offense.cop_name}: ${offense.message}`,
					filePath,
					line: offense.location.line,
					column: offense.location.column,
					severity,
					semantic: semanticFor(severity),
					tool: "rubocop",
					rule: offense.cop_name,
					fixable: offense.correctable,
					autoFixAvailable:
						offense.correctable && (autofix?.safePipelineAutofix ?? false),
					fixKind:
						offense.correctable && autofix?.fixKind !== "none"
							? autofix?.fixKind
							: undefined,
				});
			}
		}

		return diagnostics;
	} catch {
		return [];
	}
}

const rubocopRunner: RunnerDefinition = {
	id: "rubocop",
	appliesTo: ["ruby"],
	priority: PRIORITY.FORMAT_AND_LINT_PRIMARY,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = resolveRunnerCwd(ctx, "rubocop");
		const policy = getLinterPolicyForCwd(ctx.filePath, cwd);
		if (policy && !policy.preferredRunners.includes("rubocop")) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}
		const resolved = await resolveCommandArgsWithInstallFallback(
			getRubocopCommand(cwd),
			"rubocop",
			cwd,
			["--version"],
			10000,
		);
		if (!resolved) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}
		const { cmd, args } = resolved;

		// Lint only — no auto-correct (formatter handles that)
		const result = await safeSpawnAsync(
			cmd,
			[...args, "--format", "json", "--no-color", ctx.filePath],
			{ timeout: 30000, cwd },
		);

		// EXIT TABLE (RuboCop 1.66 docs https://docs.rubocop.org/rubocop/usage/basic_usage.html): 0 = clean, 1 = offenses/findings, 2 = fatal/error or rejected
		// invocation. A nonzero exit with valid JSON remains findings; a nonzero
		// exit with empty or unparsable JSON is never clean (#1816).
		const run = parseToolRun(
			"rubocop",
			{
				result,
				// Classify both streams so stderr-only failures reach the parse-error
				// path, while parseOutput keeps RuboCop's native JSON parser on stdout.
				output: `${result.stdout}${result.stderr}`,
				exitCodes: { ran: [1, 2] },
			},
			(output) => parseRubocopJson(output, ctx.filePath, cwd),
			{ parseOutput: result.stdout },
		);
		if (run.skipped) return run.skipped;
		return finishParsedRun({
			tool: "rubocop",
			ctx,
			result,
			diagnostics: run.diagnostics,
		});
	},
};

export default rubocopRunner;
