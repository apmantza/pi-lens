import { toolAbsentSkip } from "./utils/runner-helpers.js";
import * as path from "node:path";
import { pathsEqual } from "../../path-utils.js";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { resolveRunnerCwd } from "../../tool-cwd.js";
import { createAvailabilityChecker } from "./utils/runner-helpers.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { faultSkip } from "../types.js";
import { PRIORITY } from "../priorities.js";
import { finishParsedRun, parseToolRun } from "./utils/tool-failure.js";

// zig rejects `--version`; the version subcommand is `zig version`. Using the
// default probe would make this runner skip on every machine.
const zig = createAvailabilityChecker("zig", ".exe", ["version"]);

function parseZigOutput(
	raw: string,
	filePath: string,
	cwd: string,
): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const absTarget = path.resolve(cwd, filePath);
	for (const line of raw.split(/\r?\n/)) {
		const match = line.match(
			/^(.*?):(\d+):(\d+):\s*(error|warning|note):\s*(.+)$/,
		);
		if (!match) continue;

		const [, rawFile, lineStr, colStr, level, message] = match;
		// #3278: one seam for reported-path attribution — see javac.ts.
		if (!pathsEqual(path.resolve(cwd, rawFile.trim()), absTarget)) continue;

		const severity = level === "error" ? "error" : "warning";
		diagnostics.push({
			id: `zig-${level}-${lineStr}-${colStr}`,
			message,
			filePath,
			line: Number.parseInt(lineStr, 10) || 1,
			column: Number.parseInt(colStr, 10) || 1,
			severity,
			// `zig build-exe <file>` does not load build.zig module/import context.
			// Its findings are useful evidence, but cannot prove a project blocker.
			semantic: "warning",
			tool: "zig",
			rule: `zig-${level}`,
			fixable: false,
		});
	}
	return diagnostics;
}

const zigCheckRunner: RunnerDefinition = {
	id: "zig-check",
	appliesTo: ["zig"],
	priority: PRIORITY.GENERAL_ANALYSIS,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = resolveRunnerCwd(ctx, "zig-check");
		if (!(await zig.isAvailableAsync(cwd))) {
			return toolAbsentSkip(cwd, { checker: zig });
		}

		const cmd = zig.getCommand(cwd)!;
		const absPath = path.resolve(cwd, ctx.filePath);
		const result = await safeSpawnAsync(
			cmd,
			["build-exe", absPath, "-fno-emit-bin"],
			{ cwd, timeout: 30000 },
		);

		if (result.error && !result.stdout && !result.stderr) {
			return faultSkip("did-not-run");
		}

		const raw = `${result.stdout || ""}\n${result.stderr || ""}`;
		const parsed = parseToolRun(
			"zig-check",
			{
				result,
				output: raw,
				// EXIT TABLE (Zig 0.13 measured fixture): 0 clean; 1 findings; 2 error; other nonzero rejected.
				exitCodes: { ran: [1, 2] },
			},
			(output) => parseZigOutput(output, ctx.filePath, cwd),
		);
		if (parsed.skipped) return parsed.skipped;
		return finishParsedRun({
			tool: "zig-check",
			ctx,
			result,
			diagnostics: parsed.diagnostics,
			classify: (diagnostics) => ({
				status: diagnostics.some((d) => d.severity === "error")
					? "failed"
					: "succeeded",
				semantic: "warning",
			}),
		});
	},
};

export default zigCheckRunner;
