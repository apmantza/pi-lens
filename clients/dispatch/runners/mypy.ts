import { safeSpawn } from "../../safe-spawn.js";
import { hasMypyConfig } from "../../tool-policy.js";
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

const mypy = createAvailabilityChecker("mypy", "");

// mypy output: file.py:10: error: Incompatible types [assignment]
function parseMypyOutput(raw: string, filePath: string): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const linePattern =
		/^(.+?):(\d+)(?::(\d+))?:\s*(error|warning|note):\s*(.+?)(?:\s+\[([^\]]+)\])?$/gm;
	for (const match of raw.matchAll(linePattern)) {
		const [, , lineNum, col, level, message, errorCode] = match;
		if (!lineNum || !level || !message) continue;
		if (level === "note") continue; // skip contextual notes
		const severity = level === "error" ? "error" : "warning";
		const rule = errorCode ?? "mypy";
		diagnostics.push({
			id: `mypy-${lineNum}-${rule}`,
			message: errorCode ? `[${errorCode}] ${message}` : message,
			filePath,
			line: Number(lineNum),
			column: col ? Number(col) : 1,
			severity,
			semantic: severity === "error" ? "blocking" : "warning",
			tool: "mypy",
			rule,
		});
	}
	return diagnostics;
}

const mypyRunner: RunnerDefinition = {
	id: "mypy",
	appliesTo: ["python"],
	priority: PRIORITY.GENERAL_ANALYSIS,
	enabledByDefault: true,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();

		// Only run if mypy config exists — avoids false positives in untyped projects
		if (!hasMypyConfig(cwd)) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		let cmd: string | null = null;
		if (mypy.isAvailable(cwd)) {
			cmd = mypy.getCommand(cwd);
		} else {
			cmd = await resolveToolCommandWithInstallFallback(cwd, "mypy");
		}

		if (!cmd) return { status: "skipped", diagnostics: [], semantic: "none" };

		const result = safeSpawn(
			cmd,
			["--no-error-summary", "--show-column-numbers", ctx.filePath],
			{ timeout: 30000, cwd },
		);

		const raw = `${result.stdout ?? ""}${result.stderr ?? ""}`;
		const diagnostics = parseMypyOutput(raw, ctx.filePath);
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

export default mypyRunner;
