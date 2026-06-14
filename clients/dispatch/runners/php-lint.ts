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

const php = createAvailabilityChecker("php", ".exe");

function parsePhpLintOutput(raw: string, filePath: string): Diagnostic[] {
	const output = raw.trim();
	if (!output) return [];

	const lineMatch = output.match(/on line (\d+)/i);
	const messageMatch =
		output.match(/PHP Parse error:\s*(.+?)(?:\s+in\s+.+?\s+on line \d+)?$/im) ??
		output.match(/Parse error:\s*(.+?)(?:\s+in\s+.+?\s+on line \d+)?$/im);

	return [
		{
			id: `php-lint:${lineMatch?.[1] ?? "1"}`,
			message: messageMatch?.[1]?.trim() ?? output,
			filePath,
			line: lineMatch ? Number.parseInt(lineMatch[1], 10) : 1,
			column: 1,
			severity: "error",
			semantic: "blocking",
			tool: "php-lint",
			rule: "syntax",
			fixable: false,
		},
	];
}

const phpLintRunner: RunnerDefinition = {
	id: "php-lint",
	appliesTo: ["php"],
	priority: PRIORITY.GENERAL_ANALYSIS,
	enabledByDefault: true,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();
		if (!(await (php.isAvailableAsync(cwd)))) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const cmd = php.getCommand(cwd);
		if (!cmd) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const absPath = path.resolve(cwd, ctx.filePath);
		const result = await safeSpawnAsync(cmd, ["-l", absPath], {
			timeout: 15000,
			cwd,
		});
		if (result.status === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		const diagnostics = parsePhpLintOutput(
			`${result.stdout ?? ""}\n${result.stderr ?? ""}`,
			ctx.filePath,
		);
		if (diagnostics.length === 0) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		return {
			status: "failed",
			diagnostics,
			semantic: "blocking",
		};
	},
};

export default phpLintRunner;
