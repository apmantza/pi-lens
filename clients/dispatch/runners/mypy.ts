import * as path from "node:path";
import { safeSpawnAsync } from "../../safe-spawn.js";
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
import type { ToolExitCodes } from "./utils/spawn-outcome.js";
import { parseToolRun } from "./utils/tool-failure.js";
import { finishParsedRun } from "./utils/tool-failure.js";

const mypy = createAvailabilityChecker("mypy", "");

// mypy exit codes: 0 = no type errors, 1 = type errors found, 2 = a blocking
// error. 2 is NOT a rejected invocation on its own — mypy reports a source
// SYNTAX error under 2 and still writes a normal parsable diagnostic to stdout
// (verified live against mypy 2.3.1: `syn.py:1: error: Invalid syntax
// [syntax]`). A bad flag or unreadable config also exits 2, but writes its
// message to STDERR and leaves stdout empty.
//
// So the exit code cannot separate the two, and the STREAM does: the gate below
// judges "nothing to parse" on stdout alone, while the parser still reads both.
// The table's remaining job is to reject any OTHER nonzero status.
const MYPY_EXIT_CODES: ToolExitCodes = { ran: [1, 2] };

// mypy output: file.py:10: error: Incompatible types [assignment]
//
// mypy follows imports and reports errors in OTHER modules, not just the file
// it was invoked on. Attribute each diagnostic to the file mypy names (group 1,
// resolved against cwd) rather than blanket-stamping ctx.filePath — otherwise a
// cross-file regression is mis-located onto the edited file (#265 A2). We do NOT
// filter to the edited file: surfacing the cross-file impact is the point.
export function parseMypyOutput(
	raw: string,
	fallbackPath: string,
	cwd: string,
): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const linePattern =
		/^(.+?):(\d+)(?::(\d+))?:\s*(error|warning|note):\s*(.+?)(?:\s+\[([^\]]+)\])?$/gm;
	for (const match of raw.matchAll(linePattern)) {
		const [, file, lineNum, col, level, message, errorCode] = match;
		if (!lineNum || !level || !message) continue;
		if (level === "note") continue; // skip contextual notes
		const severity = level === "error" ? "error" : "warning";
		const rule = errorCode ?? "mypy";
		const filePath =
			file && file.trim()
				? path.isAbsolute(file)
					? file
					: path.resolve(cwd, file)
				: fallbackPath;
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
			defectClass: "correctness",
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
		if (await mypy.isAvailableAsync(cwd)) {
			cmd = mypy.getCommand(cwd);
		} else {
			cmd = await resolveToolCommandWithInstallFallback(cwd, "mypy");
		}

		if (!cmd) return { status: "skipped", diagnostics: [], semantic: "none" };

		const result = await safeSpawnAsync(
			cmd,
			["--no-error-summary", "--show-column-numbers", ctx.filePath],
			{ timeout: 30000, cwd },
		);

		// #1816: this runner read `result.status` zero times, so an exit-2
		// config error reported the file as cleanly type-checked. The gate reads
		// stdout only (see MYPY_EXIT_CODES) so an exit-2 SYNTAX error, which
		// does write a diagnostic there, still reaches the parser.
		const raw = `${result.stdout ?? ""}${result.stderr ?? ""}`;
		// #1948: `parseOutput` keeps the split this runner already had — the gate
		// judges "did it run" on stdout alone, the parser still reads both
		// streams — so adding the parsed-nothing record does not widen the
		// did-it-run verdict.
		const run = parseToolRun(
			"mypy",
			{ result, output: result.stdout, exitCodes: MYPY_EXIT_CODES },
			(out) => parseMypyOutput(out, ctx.filePath, cwd),
			{ parseOutput: raw },
		);
		if (run.skipped) return run.skipped;

		const diagnostics = run.diagnostics;
		return finishParsedRun({
			tool: "mypy",
			ctx,
			result,
			diagnostics,
		});
	},
};

export default mypyRunner;
