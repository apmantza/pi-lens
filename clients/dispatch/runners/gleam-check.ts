import { safeSpawnAsync } from "../../safe-spawn.js";
import { createAvailabilityChecker } from "./utils/runner-helpers.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { PRIORITY } from "../priorities.js";

const gleam = createAvailabilityChecker("gleam", ".exe");

function parseGleamOutput(raw: string, filePath: string): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const lines = raw.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const location = lines[i].match(/^(.+?):(\d+):(\d+)$/);
		if (!location) continue;
		const [, sourcePath, lineStr, colStr] = location;
		if (
			!sourcePath.replace(/\\/g, "/").endsWith(filePath.replace(/\\/g, "/"))
		) {
			continue;
		}
		const message = lines.slice(i + 1).find((line) => line.trim().length > 0);
		diagnostics.push({
			id: `gleam-check-${lineStr}-${colStr}`,
			message: message?.trim() || "gleam check reported an error",
			filePath,
			line: Number.parseInt(lineStr, 10) || 1,
			column: Number.parseInt(colStr, 10) || 1,
			severity: "error",
			semantic: "blocking",
			tool: "gleam",
			rule: "gleam-check",
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

const gleamCheckRunner: RunnerDefinition = {
	id: "gleam-check",
	appliesTo: ["gleam"],
	priority: PRIORITY.GENERAL_ANALYSIS,
	enabledByDefault: true,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();
		if (!(await (gleam.isAvailableAsync(cwd)))) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const cmd = gleam.getCommand(cwd)!;
		const result = await safeSpawnAsync(cmd, ["check"], {
			cwd,
			timeout: 30000,
		});

		if (result.error && !result.stdout && !result.stderr) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const diagnostics = parseGleamOutput(
			`${result.stderr || ""}\n${result.stdout || ""}`,
			ctx.filePath,
		);
		if (diagnostics.length === 0) {
			if (result.status && result.status !== 0) {
				return {
					status: "failed",
					diagnostics: [
						{
							id: "gleam-check-nonzero-no-diagnostics",
							message:
								firstOutputLine(result) ||
								"gleam check exited non-zero without structured diagnostics",
							filePath: ctx.filePath,
							severity: "error",
							semantic: "blocking",
							tool: "gleam",
							rule: "gleam-check",
							fixable: false,
						},
					],
					semantic: "blocking",
				};
			}
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		return {
			status: "failed",
			diagnostics,
			semantic: "blocking",
		};
	},
};

export default gleamCheckRunner;
