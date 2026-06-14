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
import { PRIORITY } from "../priorities.js";
import { createBiomeParser } from "./utils/diagnostic-parsers.js";
import { biome, createCwdCachedProbe } from "./utils/runner-helpers.js";

// Cached per-cwd probe for the npx biome fallback. Before #120, this fired
// a fresh `safeSpawnAsync("npx", ["biome", "--version"])` every dispatch
// invocation when the primary `biome` PATH checker missed — once per file
// save in any repo without a local biome binary.
const probeNpxBiome = createCwdCachedProbe(async (cwd) => {
	const r = await safeSpawnAsync("npx", ["biome", "--version"], {
		timeout: 5000,
		cwd,
	});
	return !r.error && r.status === 0;
});

const biomeRunner: RunnerDefinition = {
	id: "biome-lint",
	appliesTo: ["jsts", "json"],
	priority: PRIORITY.FORMAT_AND_LINT_PRIMARY,
	enabledByDefault: true,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();
		// Check if biome is available (via PATH, venv, or npx)
		let cmd: string | null = null;
		let useNpx = false;

		if (await (biome.isAvailableAsync(cwd))) {
			cmd = biome.getCommand(cwd);
		}

		if (!cmd) {
			// Try npx as fallback (cached per cwd — see probeNpxBiome above).
			if (await probeNpxBiome(cwd)) {
				cmd = "npx";
				useNpx = true;
			} else {
				return { status: "skipped", diagnostics: [], semantic: "none" };
			}
		}

		// No --write here: dispatch runners report issues for agent understanding,
		// not silent correction. Auto-format (biome --write) already runs in the
		// format phase before dispatch, handling all safe style transforms.
		// Silently rewriting here would leave the agent's context window stale.
		const args = useNpx
			? ["biome", "check", ctx.filePath]
			: ["check", ctx.filePath];

		const result = await safeSpawnAsync(cmd, args, {
			timeout: 30000,
			cwd,
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
