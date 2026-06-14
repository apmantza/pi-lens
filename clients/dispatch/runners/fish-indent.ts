import { safeSpawnAsync } from "../../safe-spawn.js";
import { PRIORITY } from "../priorities.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { createAvailabilityChecker } from "./utils/runner-helpers.js";

// fish_indent ships with fish — not separately installable, no managed fallback
const fishIndent = createAvailabilityChecker("fish_indent");

const fishIndentRunner: RunnerDefinition = {
	id: "fish-indent",
	appliesTo: ["fish"],
	priority: PRIORITY.FORMAT_AND_LINT_PRIMARY,
	enabledByDefault: true,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();

		const available = await (fishIndent.isAvailableAsync(cwd));
		if (!available) return { status: "skipped", diagnostics: [], semantic: "none" };

		const cmd = fishIndent.getCommand(cwd);
		if (!cmd) return { status: "skipped", diagnostics: [], semantic: "none" };

		// --check: exits 0 if already formatted, 1 if reformatting would change the file
		const result = await safeSpawnAsync(cmd, ["--check", ctx.filePath], {
			timeout: 10000,
			cwd,
		});

		if (result.status === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		// Non-zero exit: either needs formatting or a parse error was reported on stderr
		const stderrLine = (result.stderr ?? "").split("\n").find((l) => l.trim());
		if (stderrLine) {
			// Parse/syntax error — extract line number from "filename (line N): message" if present
			const lineMatch = stderrLine.match(/\(line\s+(\d+)\)/);
			const line = lineMatch ? Number(lineMatch[1]) : 1;
			const diagnostics: Diagnostic[] = [
				{
					id: `fish-indent-parse-${ctx.filePath}`,
					message: `fish_indent: ${stderrLine.trim()}`,
					filePath: ctx.filePath,
					line,
					column: 1,
					severity: "error",
					semantic: "blocking",
					tool: "fish-indent",
					rule: "fish-indent-parse-error",
				},
			];
			return { status: "failed", diagnostics, semantic: "blocking" };
		}

		// Clean stderr — file just needs formatting
		const diagnostics: Diagnostic[] = [
			{
				id: `fish-indent-format-${ctx.filePath}`,
				message: "Fish script is not formatted — run `fish_indent -w` to fix",
				filePath: ctx.filePath,
				line: 1,
				column: 1,
				severity: "warning",
				semantic: "warning",
				tool: "fish-indent",
				rule: "fish-indent-unformatted",
				fixable: true,
				autoFixAvailable: false,
				fixKind: "manual",
			},
		];
		return { status: "succeeded", diagnostics, semantic: "warning" };
	},
};

export default fishIndentRunner;
