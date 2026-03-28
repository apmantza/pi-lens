/**
 * Ruff runner for dispatch system
 *
 * Ruff handles both formatting and linting for Python files.
 */

import { spawnSync } from "node:child_process";
import { stripAnsi } from "../../sanitize.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";

const ruffRunner: RunnerDefinition = {
	id: "ruff-lint",
	appliesTo: ["python"],
	priority: 10,
	enabledByDefault: true,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		// Check if ruff is available
		const check = spawnSync("ruff", ["--version"], {
			encoding: "utf-8",
			timeout: 5000,
			shell: true,
		});

		if (check.error || check.status !== 0) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// Run ruff check
		const args = ctx.autofix
			? ["check", "--fix", ctx.filePath]
			: ["check", ctx.filePath];

		const result = spawnSync("ruff", args, {
			encoding: "utf-8",
			timeout: 30000,
			shell: true,
		});

		const raw = stripAnsi(result.stdout + result.stderr);

		if (result.status === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		// Parse diagnostics
		const diagnostics = parseRuffOutput(raw, ctx.filePath);

		return {
			status: "failed",
			diagnostics,
			semantic: "warning",
		};
	},
};

function parseRuffOutput(raw: string, filePath: string): Diagnostic[] {
	const lines = raw.split("\n").filter((l) => l.trim());
	const diagnostics: Diagnostic[] = [];

	for (const line of lines) {
		// Parse ruff output: file:line:col: message (code)
		const match = line.match(/^(.+?):(\d+):(\d+):\s*(.+?)\s+\((.+?)\)/);
		if (match) {
			diagnostics.push({
				id: `ruff-${match[2]}-${match[5]}`,
				message: `${match[5]}: ${match[4]}`,
				filePath,
				line: parseInt(match[2], 10),
				column: parseInt(match[3], 10),
				severity: line.includes("error") ? "error" : "warning",
				semantic: "warning",
				tool: "ruff",
				rule: match[5],
				fixable: true,
			});
		}
	}

	return diagnostics;
}

export default ruffRunner;
