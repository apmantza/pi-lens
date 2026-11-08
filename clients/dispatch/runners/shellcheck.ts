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

import * as path from "node:path";
import { findLocalToolConfig, pathsEqual } from "../../path-utils.js";
import {
	isShellcheckDialectSupported,
	resolveShellFileDialect,
} from "../../shell-dialect.js";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { resolveRunnerCwd } from "../../tool-cwd.js";
import { PRIORITY } from "../priorities.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import {
	createAvailabilityChecker,
	coveringLaneAvailable,
	lspPrimaryCoversFile,
	resolveAvailableOrInstall,
} from "./utils/runner-helpers.js";
import type { ToolExitCodes } from "./utils/spawn-outcome.js";
import { finishParsedRun, parseToolRun } from "./utils/tool-failure.js";
import { semanticFor } from "../types.js";

const shellcheck = createAvailabilityChecker("shellcheck", ".exe");

// EXIT TABLE (ShellCheck v0.11.0 documents these codes, pinned at
// https://github.com/koalaman/shellcheck/blob/b12c2a6a0834a5b8c12b1c0eb36704f698de5bac/shellcheck.1.md#return-values):
// 0 = no issues, 1 = issues found, 2 = some files could not be processed,
// 3 = invoked with bad syntax, 4 = invoked with bad options. Only 1 is a run
// that carries findings; 2, 3 and 4 are rejected invocations, never a scan.
const SHELLCHECK_EXIT_CODES: ToolExitCodes = { ran: [1] };

function findShellcheckConfig(cwd: string): string | undefined {
	return findLocalToolConfig(cwd, [".shellcheckrc"]);
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
function parseShellcheckOutput(
	raw: string,
	filePath: string,
	cwd: string,
): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const absTarget = path.resolve(cwd, filePath);

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
			if (!item.file || !pathsEqual(path.resolve(cwd, item.file), absTarget))
				continue;

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
				semantic: semanticFor(severity),
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
	skipTestFiles: false, // Shell scripts in test directories should still be checked

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = resolveRunnerCwd(ctx, "shellcheck");

		// #233, generalized (#3968): when the file's selected primary LSP
		// declares a covers fact for THIS RUNNER's capability (the old literal
		// `bash` server-id match could not express that), and the covering lane
		// can actually run, the warm server already produces these diagnostics —
		// skip the redundant CLI scan. Stays active when the covering lane is
		// absent so shell coverage never regresses.
		const cover = lspPrimaryCoversFile(ctx, "shellcheck");
		if (
			cover &&
			(await coveringLaneAvailable(ctx, cover)) &&
			(await ctx.hasTool("shellcheck"))
		) {
			return {
				status: "skipped",
				diagnostics: [],
				semantic: "none",
				skipReason: "covered-by-primary",
				// WHO claimed (#3968 F2): declared (the row's own covers, gated
				// on the custom row's own command) or builtin-fact.
				claimSource: cover.claimSource,
				// #4484 round 8: the skip is a verdict only when that server's
				// lane answers; the dispatcher voids it otherwise.
				coveredBy: { runnerId: "lsp", serverId: cover.serverId },
			};
		}

		// #3968 dialect gate — categorical, deliberately independent of covers:
		// ShellCheck cannot analyze dialects outside SHELLCHECK_DIALECTS (it
		// refuses them outright with SC1071, and zsh-adjacent code that happens
		// to parse under bash semantics reports findings built on the wrong
		// dialect — error-severity noise exactly like #3968's report). Skipping
		// client-side here diverges from the upstream LSP lane's deliberate
		// pass-through on shebang'd files, because THAT pass-through is the
		// reported harm — the #1064 "let ShellCheck report it" comment protects
		// the bash-lsp embedding, not a CLI lane with no other zsh lane to defer
		// to. `zsh` always skips, regardless of LSP state.
		const dialectInfo = resolveShellFileDialect(ctx.filePath);
		if (!isShellcheckDialectSupported(dialectInfo.dialect)) {
			return {
				status: "skipped",
				diagnostics: [],
				semantic: "none",
				skipReason: "dialect-unsupported",
			};
		}

		let cmd: string | null = null;
		if (await shellcheck.isAvailableAsync(cwd)) {
			cmd = shellcheck.getCommand(cwd);
		} else {
			const managed = await resolveAvailableOrInstall(
				shellcheck,
				"shellcheck",
				cwd,
			);
			if (managed) cmd = managed;
		}
		if (!cmd) return { status: "skipped", diagnostics: [], semantic: "none" };

		// Build args
		// --format json: JSON output
		// --shell: specify the dialect ONLY when the file carries neither a
		// shebang nor a `shellcheck shell=` directive — ShellCheck performs its
		// own shebang parsing when one exists (mirror of
		// bash-language-server@server-5.8.1's lint flow, their #1064 guard
		// against interfering with that). A shebang-less file keeps the bash
		// fallback, exactly like upstream's own tentative detection.
		// --severity: minimum severity (we'll filter ourselves)
		const args: string[] = ["--format", "json"];
		if (!dialectInfo.shebang && !dialectInfo.directive) {
			args.push("--shell", dialectInfo.dialect);
		}

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

		const result = await safeSpawnAsync(cmd, args, { cwd, timeout: 15000 });

		// shellcheck exits with code 1 if issues found, 0 if clean
		if (result.status === 0 && !result.stdout?.trim()) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		// A shellcheck that was killed, timed out, or exited without a word did
		// not analyse the file; `finishParsedRun` alone reads that as clean
		// (#4522: the tool-state matrix's crashed and unanswered cells).
		const parsed = parseToolRun(
			"shellcheck",
			{ result, exitCodes: SHELLCHECK_EXIT_CODES },
			(output) => parseShellcheckOutput(output, ctx.filePath, cwd),
			{ parseStreams: "stdout-else-stderr" },
		);
		if (parsed.skipped) return parsed.skipped;

		return finishParsedRun({
			tool: "shellcheck",
			ctx,
			result,
			diagnostics: parsed.diagnostics,
		});
	},
};

export default shellcheckRunner;
