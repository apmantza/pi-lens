import { toolAbsentSkip } from "./utils/runner-helpers.js";
import * as path from "node:path";
import { pathsEqual } from "../../path-utils.js";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { resolveRunnerCwd } from "../../tool-cwd.js";
import { hasJavaBuildDescriptor } from "../../tool-policy.js";
import { PRIORITY } from "../priorities.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { createAvailabilityChecker } from "./utils/runner-helpers.js";
import { finishParsedRun, parseToolRun } from "./utils/tool-failure.js";

const javac = createAvailabilityChecker("javac", ".exe");

function parseJavacOutput(
	raw: string,
	filePath: string,
	cwd: string,
): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const lines = raw.split(/\r?\n/);
	const absTarget = path.resolve(cwd, filePath);

	for (const line of lines) {
		const match = line.match(/^(.*?\.java):(\d+):\s+(error|warning):\s+(.+)$/i);
		if (!match) continue;

		const [, reportedFile, lineStr, severityLabel, message] = match;
		// Is this reported diagnostic about the file we dispatched for? ONE seam
		// answers that for every runner (#3278): resolve the tool's spelling against
		// the cwd the tool RAN in — never `process.cwd()`, which is the extension's,
		// not the runner's — and compare through `pathsEqual`, the repo's on-disk
		// identity predicate. A bare `===` treats a spelling that differs only in
		// case (the same file on Windows and on a case-folding POSIX mount) as a
		// different file and drops every finding for the edited file (#209, #3277).
		if (!pathsEqual(path.resolve(cwd, reportedFile.trim()), absTarget))
			continue;

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
			// A standalone single-file javac run has no project classpath. It can
			// report useful syntax/type evidence, but it cannot prove a blocker.
			semantic: "warning",
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
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = resolveRunnerCwd(ctx, "javac");
		const absPath = path.resolve(cwd, ctx.filePath);

		// Inside a Maven/Gradle project a classpath-less single-file compile
		// cannot produce a valid verdict: every non-JDK import becomes a
		// "package does not exist" error, and the fallback turns those into
		// false blocking diagnostics (#1877). jdtls owns those projects; this
		// runner keeps its value for standalone files with no build descriptor.
		// Same shared descriptor walk the SpotBugs gate uses.
		if (
			hasJavaBuildDescriptor(path.dirname(absPath), ctx.projectRoot ?? ctx.cwd)
		) {
			ctx.log?.(
				"javac: skipped — file is inside a Maven/Gradle project; a classpath-less compile would emit false positives",
			);
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		if (!(await javac.isAvailableAsync(cwd))) {
			return toolAbsentSkip(cwd, { checker: javac });
		}

		const cmd = javac.getCommand(cwd);
		if (!cmd) {
			return toolAbsentSkip(cwd, { checker: javac });
		}
		const result = await safeSpawnAsync(
			cmd,
			["-Xlint:none", "-proc:none", absPath],
			{
				cwd,
				timeout: 30000,
			},
		);
		const raw = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();

		const parsed = parseToolRun(
			"javac",
			{
				result,
				output: raw,
				// EXIT TABLE (javac 21 docs https://docs.oracle.com/en/java/javase/21/docs/specs/man/javac.html): 0 clean; 1 findings; 2 error; other nonzero rejected.
				exitCodes: { ran: [1, 2] },
			},
			(output) => parseJavacOutput(output, ctx.filePath, cwd),
		);
		if (parsed.skipped) return parsed.skipped;
		return finishParsedRun({
			tool: "javac",
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

export default javacRunner;
