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
import { createAvailabilityChecker } from "./utils/runner-helpers.js";

const typos = createAvailabilityChecker("typos", ".exe");

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
	enabledByDefault: true,
	skipTestFiles: false, // Check docs in test files too

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		// Skip if typos-cli is not installed
		if (!(await typos.isAvailableAsync(ctx.cwd || process.cwd()))) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// Run typos-cli with JSON output
		// --format json: Output JSON Lines
		// --exclude <pattern>: Could be used to exclude code blocks if needed
		const args = ["--format", "json", ctx.filePath];

		const result = await safeSpawnAsync(
			typos.getCommand(ctx.cwd || process.cwd())!,
			args,
			{
				timeout: 15000,
			},
		);

		// typos-cli exits with code 2 if typos found, 0 if clean
		const hasTypos = result.status === 2 || result.stdout?.trim();

		if (!hasTypos) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		// Parse diagnostics
		const raw = result.stdout + result.stderr;
		const diagnostics = parseTyposOutput(raw, ctx.filePath);

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
