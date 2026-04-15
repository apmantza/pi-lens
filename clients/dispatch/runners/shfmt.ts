import { ensureTool } from "../../installer/index.js";
import { safeSpawn } from "../../safe-spawn.js";
import { createAvailabilityChecker } from "./utils/runner-helpers.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { PRIORITY } from "../priorities.js";

const shfmt = createAvailabilityChecker("shfmt", ".exe");

/**
 * shfmt runner — checks shell script formatting.
 * Reports files that differ from shfmt's canonical output as a single warning.
 * Does NOT auto-apply formatting (that's the formatter's job).
 */
const shfmtRunner: RunnerDefinition = {
	id: "shfmt",
	appliesTo: ["shell"],
	priority: PRIORITY.FORMAT_AND_LINT_PRIMARY,
	enabledByDefault: true,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();

		let cmd: string | null = null;
		if (shfmt.isAvailable(cwd)) {
			cmd = shfmt.getCommand(cwd);
		} else {
			const installed = await ensureTool("shfmt");
			if (!installed) {
				return { status: "skipped", diagnostics: [], semantic: "none" };
			}
			cmd = installed;
		}

		if (!cmd) return { status: "skipped", diagnostics: [], semantic: "none" };

		// --diff exits 1 and prints a unified diff if the file needs formatting
		const result = safeSpawn(cmd, ["--diff", ctx.filePath], {
			timeout: 10000,
			cwd,
		});

		// exit 0 = already formatted, exit 1 = needs formatting, exit >1 = parse error
		if (result.status === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		if ((result.status ?? 2) > 1) {
			// Parse error — report on line 1
			const errMsg = (result.stderr ?? "").split("\n")[0].trim();
			const diagnostics: Diagnostic[] = [
				{
					id: `shfmt-parse-${ctx.filePath}`,
					message: errMsg ? `shfmt parse error: ${errMsg}` : "shfmt: failed to parse shell script",
					filePath: ctx.filePath,
					line: 1,
					column: 1,
					severity: "error",
					semantic: "blocking",
					tool: "shfmt",
					rule: "shfmt-parse-error",
				},
			];
			return { status: "failed", diagnostics, semantic: "blocking" };
		}

		// Needs formatting — extract first changed line from diff if possible
		const diffOutput = result.stdout ?? result.stderr ?? "";
		let line = 1;
		const lineMatch = diffOutput.match(/^@@\s+-(\d+)/m);
		if (lineMatch) line = Number(lineMatch[1]);

		const diagnostics: Diagnostic[] = [
			{
				id: `shfmt-format-${ctx.filePath}`,
				message: "Shell script is not formatted — run `shfmt -w` to fix",
				filePath: ctx.filePath,
				line,
				column: 1,
				severity: "warning",
				semantic: "warning",
				tool: "shfmt",
				rule: "shfmt-unformatted",
				fixable: true,
			},
		];
		return { status: "succeeded", diagnostics, semantic: "warning" };
	},
};

export default shfmtRunner;
