import * as fs from "node:fs";
import * as path from "node:path";
import { ensureTool } from "../../installer/index.js";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { PRIORITY } from "../priorities.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { createAvailabilityChecker } from "./utils/runner-helpers.js";

const shfmt = createAvailabilityChecker("shfmt", ".exe");

// shfmt's only config source is .editorconfig. We treat its presence as the
// opt-in for the (non-error) format-diff warning, so out of the box shfmt only
// reports genuine parse errors instead of nagging every unformatted shell file
// against shfmt's built-in defaults (#211).
function hasEditorConfig(cwd: string): boolean {
	let current = path.resolve(cwd);
	while (true) {
		if (fs.existsSync(path.join(current, ".editorconfig"))) return true;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return false;
}

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
		if (await (shfmt.isAvailableAsync(cwd))) {
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
		const result = await safeSpawnAsync(cmd, ["--diff", ctx.filePath], {
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
					message: errMsg
						? `shfmt parse error: ${errMsg}`
						: "shfmt: failed to parse shell script",
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

		// Needs formatting (exit 1). Only warn if the project opted into shfmt via
		// .editorconfig — otherwise this nags on every shell write against shfmt's
		// defaults (#211). Parse errors (above) are always reported.
		if (!hasEditorConfig(cwd)) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		// Extract first changed line from diff if possible
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
				autoFixAvailable: false,
				fixKind: "manual",
			},
		];
		return { status: "succeeded", diagnostics, semantic: "warning" };
	},
};

export default shfmtRunner;
