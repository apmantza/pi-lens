/**
 * Go vet runner for dispatch system
 *
 * Runs `go vet` for Go files to catch common mistakes.
 */

import { GoClient } from "../../go-client.js";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { stripAnsi } from "../../sanitize.js";
import { parseGoVetOutput } from "./utils/diagnostic-parsers.js";
import type {
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { PRIORITY } from "../priorities.js";

const goClient = new GoClient();

const goVetRunner: RunnerDefinition = {
	id: "go-vet",
	appliesTo: ["go"],
	priority: PRIORITY.SPECIALIZED_ANALYSIS,
	enabledByDefault: true,
	timeoutMs: 40_000,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		// Resolve go path using platform-aware lookup (handles system install paths on Windows)
		const goExe = await goClient.findGoPathAsync();
		if (!goExe) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// Run go vet on the file
		const result = await safeSpawnAsync(goExe, ["vet", ctx.filePath], {
			timeout: 30000,
		});

		const raw = stripAnsi(result.stdout + result.stderr);

		if (result.status === 0 && !raw.trim()) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		// Parse output
		const diagnostics = parseGoVetOutput(raw, ctx.filePath);

		if (diagnostics.length === 0) {
			// go vet returned non-zero but no parseable output
			return {
				status: "failed",
				diagnostics: [],
				semantic: "warning",
				rawOutput: raw,
			};
		}

		return {
			status: "failed",
			diagnostics,
			semantic: "warning",
		};
	},
};

export default goVetRunner;
