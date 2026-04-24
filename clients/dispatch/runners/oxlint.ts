/**
 * Oxlint runner for dispatch system
 *
 * Fast JavaScript/TypeScript linter written in Rust.
 * Drop-in replacement for ESLint with better performance.
 *
 * Requires: oxlint (npm install -g oxlint)
 */

import { safeSpawnAsync } from "../../safe-spawn.js";
import { getJstsLintPolicyForCwd } from "../../tool-policy.js";
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

const oxlint = createAvailabilityChecker("oxlint", ".exe");

const oxlintRunner: RunnerDefinition = {
	id: "oxlint",
	appliesTo: ["jsts"],
	priority: PRIORITY.LINT_SECONDARY,
	enabledByDefault: true,
	skipTestFiles: true,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();
		const policy = getJstsLintPolicyForCwd(cwd);
		if (!policy.preferredRunners.includes("oxlint")) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		let cmd: string | null = null;
		if (oxlint.isAvailable(cwd)) {
			cmd = oxlint.getCommand(cwd);
		} else {
			cmd = await resolveToolCommandWithInstallFallback(cwd, "oxlint");
		}
		if (!cmd) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// Run oxlint on the file
		const result = await safeSpawnAsync(
			cmd,
			["--format", "unix", ctx.filePath],
			{
				timeout: 30000,
			},
		);

		// Oxlint returns non-zero when issues found
		if (result.status === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		// Parse Unix format output: file:line:column: message (rule)
		const diagnostics = parseOxlintOutput(
			result.stdout + result.stderr,
			ctx.filePath,
		);

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

function parseOxlintOutput(raw: string, filePath: string): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const lines = raw.split("\n");

	for (const line of lines) {
		// Parse: file:line:column: message (rule)
		// Example: src/main.ts:10:5: Unexpected console statement (no-console)
		const match = line.match(/^(.+):(\d+):(\d+):\s*(.+?)\s*\(([^)]+)\)$/);
		if (match) {
			const [, _file, lineStr, _col, message, rule] = match;
			diagnostics.push({
				id: `oxlint-${rule}-${lineStr}`,
				message: `${message} (${rule})`,
				filePath,
				line: parseInt(lineStr, 10),
				severity: "warning",
				semantic: "warning",
				tool: "oxlint",
				rule,
			});
		}
	}

	return diagnostics;
}

export default oxlintRunner;
