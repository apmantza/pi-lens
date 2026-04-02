/**
 * Ruff runner for dispatch system
 *
 * Ruff handles both formatting and linting for Python files.
 * Supports venv-local installations.
 */

import { ensureTool } from "../../installer/index.js";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { stripAnsi } from "../../sanitize.js";
import type {
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { parseRuffOutput } from "./utils/diagnostic-parsers.js";
import { createAvailabilityChecker } from "./utils/runner-helpers.js";

const ruff = createAvailabilityChecker("ruff", ".exe");

const ruffRunner: RunnerDefinition = {
	id: "ruff-lint",
	appliesTo: ["python"],
	priority: 10,
	enabledByDefault: true,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();

		// Auto-install ruff if not available (it's one of the 4 auto-install tools)
		if (!ruff.isAvailable(cwd)) {
			const installed = await ensureTool("ruff");
			if (!installed) {
				return { status: "skipped", diagnostics: [], semantic: "none" };
			}
		}

		// IMPORTANT: Never use --fix in dispatch runner to prevent infinite loops.
		// Writing to the file would trigger another tool_result event, which would
		// call dispatchLint again, creating a feedback loop.
		// Fixes should be applied through explicit commands or user edits.
		const args = ["check", ctx.filePath];

		const result = await safeSpawnAsync(ruff.getCommand()!, args, {
			timeout: 30000,
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

export default ruffRunner;
