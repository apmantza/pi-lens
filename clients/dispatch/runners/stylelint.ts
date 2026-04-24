import * as path from "node:path";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { hasStylelintConfig } from "../../tool-policy.js";
import { PRIORITY } from "../priorities.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import {
	createAvailabilityChecker,
	resolveToolCommandWithInstallFallback,
} from "./utils/runner-helpers.js";

const stylelint = createAvailabilityChecker("stylelint", ".cmd");

interface StylelintWarning {
	line: number;
	column: number;
	severity: string;
	rule: string;
	text: string;
}

interface StylelintResult {
	source: string;
	warnings: StylelintWarning[];
}

function parseStylelintJson(raw: string, filePath: string): Diagnostic[] {
	try {
		const results: StylelintResult[] = JSON.parse(raw);
		const diagnostics: Diagnostic[] = [];
		for (const result of results) {
			for (const w of result.warnings) {
				const severity = w.severity === "error" ? "error" : "warning";
				diagnostics.push({
					id: `stylelint-${w.line}-${w.rule}`,
					message: `[${w.rule}] ${w.text.replace(/\s*\(stylelint.*?\)$/, "")}`,
					filePath,
					line: w.line,
					column: w.column,
					severity,
					semantic: severity === "error" ? "blocking" : "warning",
					tool: "stylelint",
					rule: w.rule,
				});
			}
		}
		return diagnostics;
	} catch {
		return [];
	}
}

const stylelintRunner: RunnerDefinition = {
	id: "stylelint",
	appliesTo: ["css"],
	priority: PRIORITY.FORMAT_AND_LINT_PRIMARY,
	enabledByDefault: true,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();
		const fileDir = path.dirname(path.resolve(cwd, ctx.filePath));
		const hasConfig = hasStylelintConfig(fileDir) || hasStylelintConfig(cwd);
		if (!hasConfig) {
			ctx.log("stylelint: no config detected, running with default rules");
		}

		let cmd: string | null = null;
		if (stylelint.isAvailable(cwd)) {
			cmd = stylelint.getCommand(cwd);
		} else {
			cmd = await resolveToolCommandWithInstallFallback(cwd, "stylelint");
		}

		if (!cmd) return { status: "skipped", diagnostics: [], semantic: "none" };

		const result = await safeSpawnAsync(
			cmd,
			["--formatter", "json", ctx.filePath],
			{ timeout: 20000, cwd },
		);

		const raw = result.stdout ?? "";
		const diagnostics = parseStylelintJson(raw, ctx.filePath);
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

export default stylelintRunner;
