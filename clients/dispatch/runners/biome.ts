/**
 * Biome runner for dispatch system
 */

import { spawnSync } from "node:child_process";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";

const biomeRunner: RunnerDefinition = {
	id: "biome-lint",
	appliesTo: ["jsts", "json"],
	priority: 10,
	enabledByDefault: true,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		// Check if biome is available
		const check = spawnSync("npx", ["@biomejs/biome", "--version"], {
			encoding: "utf-8",
			timeout: 5000,
			shell: true,
		});

		if (check.error || check.status !== 0) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// Run biome check
		const args = ctx.autofix
			? ["check", "--write", ctx.filePath]
			: ["check", ctx.filePath];

		const result = spawnSync("npx", ["@biomejs/biome", ...args], {
			encoding: "utf-8",
			timeout: 30000,
			shell: true,
		});

		const output = result.stdout + result.stderr;

		if (result.status === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		// Parse diagnostics
		const diagnostics = parseBiomeOutput(output, ctx.filePath, ctx.autofix);

		return {
			status: "failed",
			diagnostics,
			semantic: "warning",
		};
	},
};

function parseBiomeOutput(
	raw: string,
	filePath: string,
	autofix: boolean,
): Diagnostic[] {
	const clean = raw.replace(/\x1b\[[0-9;]*m/g, "");
	const lines = clean.split("\n").filter((l) => l.trim());
	const diagnostics: Diagnostic[] = [];

	for (const line of lines) {
		// Parse biome output format: file:line:col message (category)
		const match = line.match(/^(.+?):(\d+):(\d+)\s+(.+?)\s*\((.+?)\)/);
		if (match) {
			diagnostics.push({
				id: `biome-${match[2]}-${match[5]}`,
				message: `${match[5]}: ${match[4]}`,
				filePath,
				line: parseInt(match[2], 10),
				column: parseInt(match[3], 10),
				severity: line.includes("error") ? "error" : "warning",
				semantic: "warning",
				tool: "biome",
				rule: match[5],
				fixable: true,
				fixSuggestion: autofix
					? "Auto-fix applied"
					: "Run with --autofix-biome to fix",
			});
		}
	}

	return diagnostics;
}

export default biomeRunner;
