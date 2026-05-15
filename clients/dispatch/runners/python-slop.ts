/**
 * Python Slop runner for dispatch system
 *
 * Detects "slop" patterns in Python code:
 * - Verbose patterns (ceremony that adds no value)
 * - Defensive over-checking (excessive guards)
 * - Manual reimplementation of builtins
 * - Unnecessary object allocations
 *
 * Based on slop-code-bench: https://github.com/SprocketLab/slop-code-bench
 */

import { safeSpawnAsync } from "../../safe-spawn.js";
import { PRIORITY } from "../priorities.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import {
	createConfigFinder,
	getSgCommand,
	isSgAvailableAsync,
} from "./utils/runner-helpers.js";

const findSlopConfig = createConfigFinder("python-slop-rules");

const pythonSlopRunner: RunnerDefinition = {
	id: "python-slop",
	appliesTo: ["python"],
	priority: PRIORITY.PYTHON_SLOP,
	enabledByDefault: true,
	skipTestFiles: true, // Slop rules can be noisy in test files

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		// Check if ast-grep is available
		if (!await isSgAvailableAsync()) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// Find slop config
		const configPath = findSlopConfig(ctx.cwd);
		if (!configPath) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// Run ast-grep scan
		const { cmd: sgCmd, args: sgPre } = getSgCommand();
		const args = [
			...sgPre,
			"scan",
			"--config",
			configPath,
			"--json",
			ctx.filePath,
		];

		const result = await safeSpawnAsync(sgCmd, args, {
			timeout: 30000,
		});

		const raw = result.stdout + result.stderr;

		if (result.status === 0 && !raw.trim()) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		// Parse results
		const diagnostics = parseSlopOutput(raw, ctx.filePath);

		if (diagnostics.length === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		return {
			status: "failed",
			diagnostics,
			semantic: "warning",
		};
	},
};

function parseSlopOutput(raw: string, filePath: string): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];

	try {
		// Try to parse as JSON first
		const data = JSON.parse(raw);
		const items = Array.isArray(data) ? data : [data];

		for (const item of items) {
			const rule = item.rule || "slop";
			const message = item.message || "Pattern detected";
			const severity = item.severity || "warning";

			diagnostics.push({
				id: `python-slop-${rule}`,
				message,
				filePath,
				line: item.start?.line || 0,
				column: item.start?.column || 0,
				severity: severity === "error" ? "error" : "warning",
				semantic: severity === "error" ? "blocking" : "warning",
				tool: "python-slop",
				rule,
			});
		}
	} catch {
		// Not JSON, try line-by-line parsing
		const lines = raw.split("\n").filter((l) => l.trim());
		for (const line of lines) {
			// Try to extract line numbers from typical output formats
			const match = line.match(/:(\d+):/);
			if (match) {
				diagnostics.push({
					id: "python-slop-pattern",
					message: line.trim(),
					filePath,
					line: parseInt(match[1], 10),
					column: 0,
					severity: "warning",
					semantic: "warning",
					tool: "python-slop",
				});
			}
		}
	}

	return diagnostics;
}

export default pythonSlopRunner;
