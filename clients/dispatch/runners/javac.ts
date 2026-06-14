import * as path from "node:path";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { PRIORITY } from "../priorities.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { createAvailabilityChecker } from "./utils/runner-helpers.js";

const javac = createAvailabilityChecker("javac", ".exe");

function parseJavacOutput(raw: string, filePath: string): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const lines = raw.split(/\r?\n/);

	for (const line of lines) {
		const match = line.match(/^(.*?\.java):(\d+):\s+(error|warning):\s+(.+)$/i);
		if (!match) continue;

		const [, reportedFile, lineStr, severityLabel, message] = match;
		const resolvedReported = path.resolve(reportedFile.trim());
		const resolvedTarget = path.resolve(filePath);
		if (resolvedReported !== resolvedTarget) continue;

		const severity =
			severityLabel.toLowerCase() === "error" ? "error" : "warning";
		const lineNum = Number.parseInt(lineStr, 10) || 1;
		diagnostics.push({
			id: `javac-${severity}-${lineNum}-${message}`,
			message: message.trim(),
			filePath,
			line: lineNum,
			column: 1,
			severity,
			semantic: severity === "error" ? "blocking" : "warning",
			tool: "javac",
			rule: "compile",
			fixable: false,
		});
	}

	return diagnostics;
}

const javacRunner: RunnerDefinition = {
	id: "javac",
	appliesTo: ["java"],
	priority: PRIORITY.GENERAL_ANALYSIS,
	enabledByDefault: true,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();
		if (!(await (javac.isAvailableAsync(cwd)))) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const cmd = javac.getCommand(cwd);
		if (!cmd) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const absPath = path.resolve(cwd, ctx.filePath);
		const result = await safeSpawnAsync(
			cmd,
			["-Xlint:none", "-proc:none", absPath],
			{
				cwd,
				timeout: 30000,
			},
		);
		const raw = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();

		if (result.status === 0 && !raw) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		const diagnostics = parseJavacOutput(raw, ctx.filePath);
		if (diagnostics.length === 0) {
			return {
				status: result.status === 0 ? "succeeded" : "failed",
				diagnostics: [],
				semantic: "warning",
				rawOutput: raw,
			};
		}

		const hasErrors = diagnostics.some((d) => d.severity === "error");
		return {
			status: hasErrors ? "failed" : "succeeded",
			diagnostics,
			semantic: hasErrors ? "blocking" : "warning",
		};
	},
};

export default javacRunner;
