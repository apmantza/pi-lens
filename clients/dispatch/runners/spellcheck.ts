/**
 * Spellcheck runner for dispatch system
 *
 * Uses typos-cli (Rust-based, fast, zero-config) to check spelling in:
 * - Markdown files (.md, .mdx)
 * - Code comments (optional, if typos is configured)
 *
 * Key features:
 * - Fast (Rust-based, ~10x faster than cspell)
 * - Low false positives (only checks known typos)
 * - Zero-config by default
 * - JSON output for easy parsing
 *
 * Alternative considered: cspell
 * - cspell: More comprehensive, but higher false positives, needs config
 * - typos-cli: Faster, less noise, works out of the box
 *
 * Install: cargo install typos-cli
 * Or: npm install -g typos-cli (if wrapped)
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
	createAvailabilityChecker,
	resolveRunnerCwd,
} from "./utils/runner-helpers.js";
import type { ToolExitCodes } from "./utils/spawn-outcome.js";
import { parseToolRun } from "./utils/tool-failure.js";

const typos = createAvailabilityChecker("typos", ".exe");

// typos-cli exit codes: 0 = no typos, 2 = typos found, 1 = an error that
// stopped the scan. Anything nonzero outside {2} is a rejected invocation.
const TYPOS_EXIT_CODES: ToolExitCodes = { ran: [2] };

/**
 * Parse typos-cli JSON output (JSON Lines format)
 *
 * Each line is a JSON object:
 * {
 *   "path": "file.md",
 *   "line_num": 42,
 *   "byte_offset": 1234,
 *   "typo": "recieve",
 *   "corrections": ["receive"]
 * }
 */
function parseTyposOutput(raw: string, filePath: string): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];

	if (!raw.trim()) {
		return diagnostics;
	}

	const lines = raw
		.trim()
		.split("\n")
		.filter((l) => l.trim());

	for (const line of lines) {
		try {
			const parsed = JSON.parse(line) as {
				path?: string;
				line_num?: number;
				byte_offset?: number;
				typo?: string;
				corrections?: string[];
			};

			if (!parsed.typo || !parsed.line_num) continue;

			const corrections = parsed.corrections?.join(", ") || "no suggestions";
			const message = `Typo: "${parsed.typo}" → ${corrections}`;

			diagnostics.push({
				id: `typos-${parsed.line_num}-${parsed.typo}`,
				message,
				filePath,
				line: parsed.line_num,
				column: 1, // typos-cli doesn't provide column, just byte offset
				severity: "warning",
				semantic: "warning",
				tool: "typos",
				rule: "typo",
				fixable: !!parsed.corrections?.length,
				autoFixAvailable: false,
				fixKind: parsed.corrections?.length ? "suggestion" : undefined,
				fixSuggestion: parsed.corrections?.[0],
			});
		} catch (err) {
			void err;
		}
	}

	return diagnostics;
}

const spellcheckRunner: RunnerDefinition = {
	id: "spellcheck",
	appliesTo: ["markdown"],
	priority: PRIORITY.DOC_QUALITY,
	skipTestFiles: false, // Check docs in test files too

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = resolveRunnerCwd(ctx, "spellcheck/typos");
		// Skip if typos-cli is not installed
		if (!(await typos.isAvailableAsync(cwd))) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// Run typos-cli with JSON output
		// --format json: Output JSON Lines
		// --exclude <pattern>: Could be used to exclude code blocks if needed
		const args = ["--format", "json", ctx.filePath];

		const result = await safeSpawnAsync(typos.getCommand(cwd)!, args, {
			cwd,
			timeout: 15000,
		});

		// #1816: typos-cli exits 0 clean, 2 with typos found, and 1 on an ERROR
		// (unreadable config, bad argument). The `status === 2 || stdout` test
		// below is false for exit 1 with an empty stdout, so a failed run was
		// reported as a clean file. Only 0 and 2 are runs.
		//
		// #1948: parse through the shared seam so an exit-2 run whose JSON lines
		// yield nothing leaves a record. `parseOutput` keeps the historical
		// split: the gate judges "did it run" on stdout, the parser reads both
		// streams.
		const run = parseToolRun(
			"spellcheck",
			{ result, exitCodes: TYPOS_EXIT_CODES },
			(out) => parseTyposOutput(out, ctx.filePath),
			{ parseOutput: `${result.stdout ?? ""}${result.stderr ?? ""}` },
		);
		if (run.skipped) return run.skipped;

		const diagnostics = run.diagnostics;

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

export default spellcheckRunner;
