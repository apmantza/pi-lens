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

const dart = createAvailabilityChecker("dart", ".exe");
const flutter = createAvailabilityChecker("flutter", ".bat");

// dart analyze --format=machine output:
// severity|type|code|file|line|col|length|message
function parseDartMachineOutput(raw: string, filePath: string): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	for (const line of raw.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const parts = line.split("|");
		if (parts.length < 8) continue;

		const [severityStr, , code, file, lineStr, colStr, , ...messageParts] = parts;
		const message = messageParts.join("|").trim();
		const lineNum = parseInt(lineStr, 10);
		const colNum = parseInt(colStr, 10);

		// Only include diagnostics for the target file
		if (file && !path.resolve(file).endsWith(path.resolve(filePath).replace(/\\/g, "/"))) {
			const resolvedFile = path.resolve(file.trim());
			const resolvedTarget = path.resolve(filePath);
			if (resolvedFile !== resolvedTarget) continue;
		}

		const severity = severityStr?.trim().toLowerCase() === "error" ? "error" : "warning";
		diagnostics.push({
			id: `dart-${code?.trim()}-${lineNum}-${colNum}`,
			message: `[${code?.trim()}] ${message}`,
			filePath,
			line: lineNum || 1,
			column: colNum || 1,
			severity,
			semantic: severity === "error" ? "blocking" : "warning",
			tool: "dart",
			rule: code?.trim() ?? "dart",
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

const dartAnalyzeRunner: RunnerDefinition = {
	id: "dart-analyze",
	appliesTo: ["dart"],
	priority: PRIORITY.GENERAL_ANALYSIS,
	enabledByDefault: true,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();
		const absPath = path.resolve(cwd, ctx.filePath);
		const dartAvailable = dart.isAvailable(cwd);
		const flutterAvailable = !dartAvailable && flutter.isAvailable(cwd);
		if (!dartAvailable && !flutterAvailable) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}
		const cmd = dartAvailable ? dart.getCommand(cwd)! : flutter.getCommand(cwd)!;
		const args = dartAvailable
			? ["analyze", "--format=machine", absPath]
			: ["analyze", "--machine", absPath];

		const result = await safeSpawnAsync(
			cmd,
			args,
			{ cwd, timeout: 30000 },
		);

		if (result.error && !result.stdout && !result.stderr) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// dart analyze writes diagnostics to stderr in machine format
		const raw = (result.stderr || "") + (result.stdout || "");
		const diagnostics = parseDartMachineOutput(raw, ctx.filePath);

		if (diagnostics.length === 0) {
			if (result.status && result.status !== 0) {
				return {
					status: "failed",
					diagnostics: [
						{
							id: "dart-analyze-nonzero-no-diagnostics",
							message:
								firstOutputLine(result) ||
								"dart analyze exited non-zero without machine diagnostics",
							filePath: ctx.filePath,
							severity: "warning",
							semantic: "warning",
							tool: "dart",
							rule: "dart-analyze",
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

export default dartAnalyzeRunner;
