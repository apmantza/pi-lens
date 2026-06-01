/**
 * golangci-lint runner for dispatch system
 *
 * Runs golangci-lint when a .golangci.yml config is present.
 * golangci-lint is the standard meta-linter for Go projects — it runs
 * staticcheck, errcheck, gosimple, and many others in one pass.
 *
 * Gate: skips when no .golangci.yml/.golangci.yaml config is found (project
 * relies on go-vet only). This avoids noisy default-rule runs on projects
 * that haven't opted in.
 */

import * as path from "node:path";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { getLinterPolicyForCwd, hasGolangciConfig } from "../../tool-policy.js";
import { PRIORITY } from "../priorities.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import {
	createAvailabilityChecker,
	resolveAvailableOrInstall,
} from "./utils/runner-helpers.js";

const golangci = createAvailabilityChecker("golangci-lint", ".exe");

interface GolangciInlineReplacement {
	StartCol?: number;
	Length?: number;
	NewString?: string;
}

interface GolangciReplacement {
	NeedOnlyDelete?: boolean;
	NewLines?: string[];
	Inline?: GolangciInlineReplacement;
}

interface GolangciIssue {
	FromLinter: string;
	Text: string;
	Severity?: string;
	Pos: {
		Filename: string;
		Line: number;
		Column: number;
	};
	Replacement?: GolangciReplacement | null;
}

interface GolangciOutput {
	Issues: GolangciIssue[] | null;
}

/**
 * Summarize a golangci-lint Replacement into a single-line fixSuggestion.
 * Prefers the Inline rewrite (precise + short) over multi-line block
 * replacements, and reports a delete-only fix when there's no new content.
 * Returns undefined when there is no Replacement attached.
 */
function describeReplacement(
	replacement: GolangciReplacement | null | undefined,
): string | undefined {
	if (!replacement) return undefined;
	if (replacement.Inline?.NewString !== undefined) {
		return `Replace with: ${replacement.Inline.NewString}`;
	}
	if (replacement.NeedOnlyDelete) return "Delete this code";
	if (replacement.NewLines && replacement.NewLines.length > 0) {
		const preview = replacement.NewLines[0].trim();
		const hint =
			replacement.NewLines.length > 1 ? ` (+${replacement.NewLines.length - 1} more lines)` : "";
		return `Replace with: ${preview}${hint}`;
	}
	return "Apply golangci-lint suggested fix";
}

function parseGolangciJson(raw: string, filePath: string): Diagnostic[] {
	try {
		const output: GolangciOutput = JSON.parse(raw);
		if (!output.Issues) return [];

		const absFile = path.resolve(filePath);

		return output.Issues.filter(
			(issue) => path.resolve(issue.Pos.Filename) === absFile,
		).map((issue) => {
			const severity = issue.Severity === "error" ? "error" : "warning";
			// golangci-lint's --out-format=json emits a Replacement object per
			// issue when `golangci-lint run --fix` would deterministically
			// rewrite the code. Mirror the rust-clippy structured-output path
			// (commit 221b34d): propagate the field to fixable / fixSuggestion
			// so the diagnostic routes through actionable-warnings.
			const fixSuggestion = describeReplacement(issue.Replacement);
			return {
				id: `golangci:${issue.FromLinter}:${issue.Pos.Line}`,
				message: `${issue.FromLinter}: ${issue.Text}`,
				filePath,
				line: issue.Pos.Line,
				column: issue.Pos.Column,
				severity,
				semantic: severity === "error" ? "blocking" : "warning",
				tool: "golangci-lint",
				rule: issue.FromLinter,
				defectClass: "correctness",
				fixable: Boolean(issue.Replacement),
				fixSuggestion,
			} satisfies Diagnostic;
		});
	} catch {
		return [];
	}
}

// Exported for the parser unit tests (#112 golangci-lint slice).
export { parseGolangciJson };

const golangciRunner: RunnerDefinition = {
	id: "golangci-lint",
	appliesTo: ["go"],
	priority: PRIORITY.GENERAL_ANALYSIS,
	enabledByDefault: true,
	timeoutMs: 90_000,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();
		const policy = getLinterPolicyForCwd(ctx.filePath, cwd);
		if (policy && !policy.preferredRunners.includes("golangci-lint")) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// Only run if project has opted in via config file
		if (!hasGolangciConfig(cwd)) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const cmd = await resolveAvailableOrInstall(golangci, "golangci-lint", cwd);
		if (!cmd) return { status: "skipped", diagnostics: [], semantic: "none" };

		// Run on the specific file. golangci-lint accepts file paths directly.
		const result = await safeSpawnAsync(
			cmd,
			["run", "--out-format=json", ctx.filePath],
			{ timeout: 60000, cwd },
		);

		if (result.status === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		const diagnostics = parseGolangciJson(result.stdout, ctx.filePath);
		let semantic: RunnerResult["semantic"] = "none";
		if (diagnostics.some((d) => d.semantic === "blocking")) {
			semantic = "blocking";
		} else if (diagnostics.length > 0) {
			semantic = "warning";
		}

		if (semantic === "none") {
			// Non-zero exit but no parseable issues — likely a config/tool error
			return { status: "skipped", diagnostics: [], semantic };
		}

		return {
			status: semantic === "blocking" ? "failed" : "succeeded",
			diagnostics,
			semantic,
		};
	},
};

export default golangciRunner;
