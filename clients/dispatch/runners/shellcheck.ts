/**
 * Shellcheck runner for dispatch system
 *
 * Industry-standard linter for shell scripts (bash, sh, zsh).
 * Detects syntax errors, undefined variables, quoting issues, and best practices.
 *
 * Why shellcheck?
 * - Industry standard (used in CI/CD everywhere)
 * - Comprehensive checks (syntax, variables, quotes, best practices)
 * - JSON output for easy parsing
 * - Available on all platforms (apt, brew, cargo, etc.)
 *
 * Alternative considered: bash-language-server
 * - LSP approach like OpenCode uses
 * - Richer features but heavier
 * - shellcheck is simpler and faster for basic linting
 *
 * Install: apt install shellcheck, brew install shellcheck, or cargo install shellcheck
 *
 * Config: .shellcheckrc (optional, zero-config works)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { ensureTool } from "../../installer/index.js";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { PRIORITY } from "../priorities.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { createAvailabilityChecker } from "./utils/runner-helpers.js";

const shellcheck = createAvailabilityChecker("shellcheck", ".exe");

function findShellcheckConfig(cwd: string): string | undefined {
	const local = path.join(cwd, ".shellcheckrc");
	if (fs.existsSync(local)) return local;

	let current = path.resolve(cwd);
	while (true) {
		const candidate = path.join(current, ".shellcheckrc");
		if (fs.existsSync(candidate)) return candidate;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}

	return undefined;
}

/**
 * Parse shellcheck JSON output
 *
 * Format: Array of check objects
 * [{
 *   "file": "script.sh",
 *   "line": 10,
 *   "endLine": 10,
 *   "column": 5,
 *   "endColumn": 10,
 *   "level": "warning",
 *   "code": 2154,
 *   "message": "var is referenced but not assigned.",
 *   "fix": null
 * }]
 *
 * Levels: "error", "warning", "info", "style"
 */
function parseShellcheckOutput(raw: string, filePath: string): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];

	if (!raw.trim()) {
		return diagnostics;
	}

	try {
		const parsed = JSON.parse(raw) as Array<{
			file?: string;
			line?: number;
			endLine?: number;
			column?: number;
			endColumn?: number;
			level?: string;
			code?: number;
			message?: string;
			fix?: unknown;
		}>;

		if (!Array.isArray(parsed)) {
			return diagnostics;
		}

		for (const item of parsed) {
			if (!item.message || !item.line) continue;

			// Map shellcheck levels to our severity
			const severityMap: Record<string, "error" | "warning" | "info"> = {
				error: "error",
				warning: "warning",
				info: "info",
				style: "info",
			};
			const severity = severityMap[item.level || "warning"] || "warning";

			const ruleCode = item.code ? `SC${item.code}` : "unknown";

			diagnostics.push({
				id: `shellcheck-${item.line}-${ruleCode}`,
				message: `[${ruleCode}] ${item.message}`,
				filePath,
				line: item.line,
				column: item.column || 1,
				severity,
				semantic: severity === "error" ? "blocking" : "warning",
				tool: "shellcheck",
				rule: ruleCode,
				fixable: !!item.fix,
				autoFixAvailable: false,
				fixKind: item.fix ? "suggestion" : undefined,
			});
		}
	} catch {
		// JSON parse failed, return empty
		return diagnostics;
	}

	return diagnostics;
}

const shellcheckRunner: RunnerDefinition = {
	id: "shellcheck",
	appliesTo: ["shell"],
	priority: PRIORITY.GENERAL_ANALYSIS,
	enabledByDefault: true,
	skipTestFiles: false, // Shell scripts in test directories should still be checked

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();
		let cmd: string | null = null;
		if (await (shellcheck.isAvailableAsync(cwd))) {
			cmd = shellcheck.getCommand(cwd);
		} else {
			const managed = await ensureTool("shellcheck");
			if (managed) cmd = managed;
		}
		if (!cmd) return { status: "skipped", diagnostics: [], semantic: "none" };

		// Determine shell dialect from file extension (all map to bash for shellcheck)
		const shellDialect = "bash";

		// Build args
		// --format json: JSON output
		// --shell: Specify shell dialect (bash, sh, zsh, ksh, busybox)
		// --severity: Minimum severity (we'll filter ourselves)
		const args: string[] = ["--format", "json", "--shell", shellDialect];

		// Check for config file
		const configPath = findShellcheckConfig(ctx.cwd);
		if (!configPath) {
			// No config file: surface `info`-level findings (e.g. SC2086
			// double-quote-to-prevent-globbing — a high-value, commonly-relevant
			// check that was previously dropped, #213) while still excluding pure
			// `style` rules to limit noise. Projects opt into style via .shellcheckrc.
			args.push("--severity", "info");
		}

		args.push(ctx.filePath);

		const result = await safeSpawnAsync(cmd, args, { timeout: 15000 });

		// shellcheck exits with code 1 if issues found, 0 if clean
		if (result.status === 0 && !result.stdout?.trim()) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		// Parse diagnostics
		const raw = result.stdout + result.stderr;
		const diagnostics = parseShellcheckOutput(raw, ctx.filePath);

		if (diagnostics.length === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		const hasBlocking = diagnostics.some((d) => d.semantic === "blocking");

		return {
			status: hasBlocking ? "failed" : "succeeded",
			diagnostics,
			semantic: hasBlocking ? "blocking" : "warning",
		};
	},
};

export default shellcheckRunner;
