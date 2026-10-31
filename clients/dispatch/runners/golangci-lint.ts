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
import { pathsEqual } from "../../path-utils.js";
import { resolveRunnerCwd } from "../../tool-cwd.js";
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
import { finishParsedRun, parseToolRun } from "./utils/tool-failure.js";

const golangci = createAvailabilityChecker("golangci-lint", ".exe");

/** Every `golangci-lint run` output format except json (2.14.0 `run --help`). */
const OTHER_OUTPUT_FORMATS = [
	"text",
	"tab",
	"html",
	"checkstyle",
	"code-climate",
	"junit-xml",
	"teamcity",
	"sarif",
];

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
			replacement.NewLines.length > 1
				? ` (+${replacement.NewLines.length - 1} more lines)`
				: "";
		return `Replace with: ${preview}${hint}`;
	}
	return "Apply golangci-lint suggested fix";
}

function parseGolangciJson(
	raw: string,
	filePath: string,
	cwd: string,
): Diagnostic[] {
	try {
		const output: GolangciOutput = JSON.parse(raw);
		if (!output.Issues) return [];

		const absFile = path.resolve(cwd, filePath);

		// #3278: one seam for reported-path attribution — see javac.ts. The base
		// matters here more than anywhere else in the family: golangci-lint's
		// `PathPrettifier` OVERWRITES `Pos.Filename` with `filepath.Rel(basePath,
		// …)` before the JSON printer sees it (v1.64.8,
		// `pkg/result/processors/path_prettifier.go:31` +
		// `path_relativity.go:43`), so the spelling is relative to the child's
		// base path — the `cwd` we spawned it in — and `path.resolve` with no
		// base resolved it against the EXTENSION's cwd instead.
		return output.Issues.filter((issue) =>
			pathsEqual(path.resolve(cwd, issue.Pos.Filename), absFile),
		).map((issue) => {
			const severity = issue.Severity === "error" ? "error" : "warning";
			// golangci-lint's JSON output emits a Replacement object per
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
	timeoutMs: 90_000,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = resolveRunnerCwd(ctx, "golangci-lint");
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
		// v2 (the major the installer downloads) removed `--out-format`: it exits
		// 3 "unknown flag" (#4455). JSON now comes from `--output.json.path`, and
		// the run stats go to stdout after the document unless switched off,
		// which leaves stdout unparseable as one JSON value. The project's own
		// `output.formats` merge with the flags, so a config that prints any other
		// format to stdout puts that text beside the JSON; every other format is
		// pointed at nowhere (`--output.<format>.path=`), probed against 2.14.0.
		// `--fix=false` (#5119): a project config with `issues.fix: true` makes
		// `run` rewrite the file; the flag outranks the config file. Documented
		// bool flag in v1 and v2, not probed here (no Go toolchain on the lane).
		const result = await safeSpawnAsync(
			cmd,
			[
				"run",
				"--fix=false",
				"--output.json.path=stdout",
				...OTHER_OUTPUT_FORMATS.map((format) => `--output.${format}.path=`),
				"--show-stats=false",
				ctx.filePath,
			],
			{ timeout: 60000, cwd },
		);

		// Exit table: 0 is clean-or-findings; 1 means issues, 3 failure,
		// 4 timeout, and 5 missing config. Every nonzero code is a ran outcome
		// whose parser decides: JSON issues remain findings, while emitted
		// non-JSON text becomes a parse-error diagnostic and no output stays
		// skipped. Keep stderr as the parse input when stdout is absent so tool
		// errors cannot be mistaken for a clean file.
		const raw =
			(result.stdout ?? "").length > 0
				? (result.stdout ?? "")
				: result.status !== 0
					? result.stderr || ""
					: "";
		const parsed = parseToolRun(
			"golangci-lint",
			{
				result,
				output: raw,
				// EXIT TABLE (golangci-lint v2 docs https://golangci-lint.run/docs/welcome/quick-start/; 2.14.0 exits 1 on findings and 3 on an unknown flag): 0 clean; 1 findings; 2 error; 3 error; 4 error; 5 error; other nonzero rejected.
				exitCodes: { ran: [1, 2, 3, 4, 5] },
			},
			(raw) => parseGolangciJson(raw, ctx.filePath, cwd),
		);
		if (parsed.skipped) return parsed.skipped;
		return finishParsedRun({
			tool: "golangci-lint",
			ctx,
			result,
			diagnostics: parsed.diagnostics,
		});
	},
};

export default golangciRunner;
