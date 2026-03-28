/**
 * Go vet runner for dispatch system
 *
 * Runs `go vet` for Go files to catch common mistakes.
 */

import type { DispatchContext, Diagnostic, RunnerDefinition, RunnerResult } from "../types.js";
import { spawnSync } from "node:child_process";
import { stripAnsi } from "../../sanitize.js";

const goVetRunner: RunnerDefinition = {
	id: "go-vet",
	appliesTo: ["go"],
	priority: 15,
	enabledByDefault: true,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		// Check if go is available
		const check = spawnSync("go", ["version"], {
			encoding: "utf-8",
			timeout: 5000,
			shell: true,
		});

		if (check.error || check.status !== 0) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// Run go vet on the file
		const result = spawnSync(
			"go",
			["vet", ctx.filePath],
			{
				encoding: "utf-8",
				timeout: 30000,
				shell: true,
			},
		);

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

function parseGoVetOutput(raw: string, filePath: string): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const lines = raw.split("\n");

	for (const line of lines) {
		// Parse go vet output: file:line:col: message
		const match = line.match(/^(.+?):(\d+):(\d+):\s*(.+)/);
		if (match) {
			diagnostics.push({
				id: `go-vet-${match[2]}`,
				message: match[4],
				filePath,
				line: parseInt(match[2], 10),
				column: parseInt(match[3], 10),
				severity: "warning",
				semantic: "warning",
				tool: "go-vet",
			});
		}
	}

	return diagnostics;
}

export default goVetRunner;
