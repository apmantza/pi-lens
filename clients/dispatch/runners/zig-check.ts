import * as path from "node:path";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { createAvailabilityChecker } from "./utils/runner-helpers.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { PRIORITY } from "../priorities.js";

// zig rejects `--version`; the version subcommand is `zig version`. Using the
// default probe would make this runner skip on every machine.
const zig = createAvailabilityChecker("zig", ".exe", ["version"]);

function parseZigOutput(raw: string, filePath: string): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	for (const line of raw.split(/\r?\n/)) {
		const match = line.match(
			/^(.*?):(\d+):(\d+):\s*(error|warning|note):\s*(.+)$/,
		);
		if (!match) continue;

		const [, rawFile, lineStr, colStr, level, message] = match;
		const resolvedSource = path.resolve(rawFile.trim());
		const resolvedTarget = path.resolve(filePath);
		if (resolvedSource !== resolvedTarget) continue;

		const severity = level === "error" ? "error" : "warning";
		diagnostics.push({
			id: `zig-${level}-${lineStr}-${colStr}`,
			message,
			filePath,
			line: Number.parseInt(lineStr, 10) || 1,
			column: Number.parseInt(colStr, 10) || 1,
			severity,
			semantic: severity === "error" ? "blocking" : "warning",
			tool: "zig",
			rule: `zig-${level}`,
			fixable: false,
		});
	}
	return diagnostics;
}

function firstOutputLine(result: { stdout?: string; stderr?: string }): string {
	return `${result.stderr || ""}\n${result.stdout || ""}`
		.trim()
		.split(/\r?\n/, 1)[0]
		.slice(0, 200);
}

const zigCheckRunner: RunnerDefinition = {
	id: "zig-check",
	appliesTo: ["zig"],
	priority: PRIORITY.GENERAL_ANALYSIS,
	enabledByDefault: true,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();
		if (!(await (zig.isAvailableAsync(cwd)))) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const cmd = zig.getCommand(cwd)!;
		const absPath = path.resolve(cwd, ctx.filePath);
		const result = await safeSpawnAsync(
			cmd,
			["build-exe", absPath, "-fno-emit-bin"],
			{ cwd, timeout: 30000 },
		);

		if (result.error && !result.stdout && !result.stderr) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const diagnostics = parseZigOutput(
			`${result.stderr || ""}\n${result.stdout || ""}`,
			ctx.filePath,
		);
		if (diagnostics.length === 0) {
			if (result.status && result.status !== 0) {
				return {
					status: "failed",
					diagnostics: [
						{
							id: "zig-check-nonzero-no-diagnostics",
							message:
								firstOutputLine(result) ||
								"zig build-exe exited non-zero without structured diagnostics",
							filePath: ctx.filePath,
							severity: "warning",
							semantic: "warning",
							tool: "zig",
							rule: "zig-check",
							fixable: false,
						},
					],
					semantic: "warning",
				};
			}
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		const hasErrors = diagnostics.some((d) => d.severity === "error");
		return {
			status: hasErrors ? "failed" : "succeeded",
			diagnostics,
			semantic: hasErrors ? "blocking" : "warning",
		};
	},
};

export default zigCheckRunner;
