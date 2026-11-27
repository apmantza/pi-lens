import { toolAbsentSkip } from "./utils/runner-helpers.js";
import { skipped } from "../types.js";
import * as path from "node:path";
import { pathsEqual } from "../../path-utils.js";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { resolveRunnerCwd } from "../../tool-cwd.js";
import { getLinterPolicyForCwd } from "../../tool-policy.js";
import { PRIORITY } from "../priorities.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { resolveToolCommandWithInstallFallback } from "./utils/runner-helpers.js";
import { parseToolRun } from "./utils/tool-failure.js";
import { finishParsedRun } from "./utils/tool-failure.js";
import { semanticFor } from "../types.js";

interface HadolintResult {
	line: number;
	code: string;
	message: string;
	column: number;
	file: string;
	level: "error" | "warning" | "info" | "style";
}

function parseHadolintOutput(
	raw: string,
	filePath: string,
	cwd: string,
): Diagnostic[] {
	try {
		const parsed = JSON.parse(raw) as HadolintResult[];
		if (!Array.isArray(parsed)) return [];

		const absTarget = path.resolve(cwd, filePath);
		return parsed.flatMap((item) => {
			// #3295: hadolint takes a LIST of Dockerfiles and names each finding's
			// own `file`.
			if (item.file && !pathsEqual(path.resolve(cwd, item.file), absTarget))
				return [];
			const severity = item.level === "error" ? "error" : "warning";
			return [
				{
					id: `hadolint-${item.code}-${item.line}`,
					message: `[${item.code}] ${item.message}`,
					filePath,
					line: item.line,
					column: item.column ?? 1,
					severity,
					semantic: semanticFor(severity),
					tool: "hadolint",
					rule: item.code,
					fixable: false,
				},
			];
		});
	} catch {
		return [];
	}
}

const hadolintRunner: RunnerDefinition = {
	id: "hadolint",
	appliesTo: ["docker"],
	priority: PRIORITY.GENERAL_ANALYSIS,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = resolveRunnerCwd(ctx, "hadolint");
		const policy = getLinterPolicyForCwd(ctx.filePath, cwd);
		if (policy && !policy.preferredRunners.includes("hadolint")) {
			return skipped("not-preferred");
		}

		const cmd = await resolveToolCommandWithInstallFallback(cwd, "hadolint");

		if (!cmd) {
			return toolAbsentSkip(cwd, { id: "hadolint" });
		}

		const result = await safeSpawnAsync(
			cmd,
			["--format", "json", "--no-fail", path.resolve(cwd, ctx.filePath)],
			{ cwd },
		);

		// #1948: hadolint runs with `--no-fail`, so it exits 0 even when it finds
		// something. A nonzero exit therefore means hadolint itself failed, and
		// zero parsed diagnostics out of whatever it printed is a parser break.
		const run = parseToolRun(
			"hadolint",
			{
				result,
				// EXIT TABLE (Hadolint 2.12 measured fixture): 0 clean; 1 findings; 2 error; other nonzero rejected.
				exitCodes: { ran: [1, 2] },
			},
			(out) => parseHadolintOutput(out, ctx.filePath, cwd),
		);
		if (run.skipped) return run.skipped;

		const diagnostics = run.diagnostics;
		return finishParsedRun({
			tool: "hadolint",
			ctx,
			result,
			diagnostics,
			classify: (diagnostics) => {
				const hasErrors = diagnostics.some((d) => d.severity === "error");
				return {
					status: "failed",
					semantic: hasErrors ? "blocking" : "warning",
				};
			},
		});
	},
};

export default hadolintRunner;
