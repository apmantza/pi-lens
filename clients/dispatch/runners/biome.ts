/**
 * Biome runner for dispatch system
 *
 * Requires: @biomejs/biome (npm install -D @biomejs/biome)
 */

import { safeSpawnAsync } from "../../safe-spawn.js";
import type {
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { createBiomeParser } from "./utils/diagnostic-parsers.js";
import { biome } from "./utils/runner-helpers.js";

const biomeRunner: RunnerDefinition = {
	id: "biome-lint",
	appliesTo: ["jsts", "json"],
	priority: 10,
	enabledByDefault: true,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		// Check if biome is available (via PATH, venv, or npx)
		let cmd = biome.getCommand();
		let useNpx = false;

		if (!cmd || !biome.isAvailable(ctx.cwd)) {
			// Try npx as fallback
			const npxCheck = await safeSpawnAsync("npx", ["biome", "--version"], {
				timeout: 5000,
			});
			if (!npxCheck.error && npxCheck.status === 0) {
				cmd = "npx";
				useNpx = true;
			} else {
				return { status: "skipped", diagnostics: [], semantic: "none" };
			}
		}

		// IMPORTANT: Never use --write in dispatch runner to prevent infinite loops.
		// Writing to the file would trigger another tool_result event, which would
		// call dispatchLint again, creating a feedback loop.
		// Use /lens-format command for explicit formatting, or autofix flags on
		// the write/edit tools directly.
		const args = useNpx
			? ["biome", "check", ctx.filePath]
			: ["check", ctx.filePath];

		const result = await safeSpawnAsync(cmd, args, {
			timeout: 30000,
		});

		const output = result.stdout + result.stderr;

		if (result.status === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		// Parse diagnostics (never autofix in dispatch to prevent loops)
		const parseBiomeOutput = createBiomeParser(false);
		const diagnostics = parseBiomeOutput(output, ctx.filePath);

		return {
			status: "failed",
			diagnostics,
			semantic: "warning",
		};
	},
};

export default biomeRunner;
