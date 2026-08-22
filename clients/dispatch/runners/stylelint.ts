import * as path from "node:path";
import { safeSpawnAsync } from "../../safe-spawn.js";
import {
	getLinterPolicyForCwd,
	hasStylelintConfig,
} from "../../tool-policy.js";
import { PRIORITY } from "../priorities.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import {
	createAvailabilityChecker,
	resolveToolCommandWithInstallFallback,
} from "./utils/runner-helpers.js";
import type { ToolExitCodes } from "./utils/spawn-outcome.js";
import { parseToolRun } from "./utils/tool-failure.js";
import { finishParsedRun } from "./utils/tool-failure.js";

const stylelint = createAvailabilityChecker("stylelint", ".cmd");

// stylelint exit codes (its "Exit codes" docs page): 0 = no problems, 1 = a
// fatal error, 2 = lint problems found, 78 = a configuration error.
//
// 1 is listed as a run here rather than a rejection. The evidence for that is
// NOT a live stylelint: it is this repo's own hand-written fixture
// (tests/clients/dispatch/runners/stylelint-fixable.test.ts), which reports
// findings under exit 1. Rather than rewrite a fixture whose provenance is
// unknown, the table keeps 1 permissive. 78 is the rejection this table
// exists to name.
//
// #1937 corrected the safety argument that used to sit here: it claimed a
// fatal stylelint "writes nothing to stdout", which is true but useless,
// because a stylelint that DID find problems writes nothing to stdout either.
// `stylelintReport` below is what now separates the two.
const STYLELINT_EXIT_CODES: ToolExitCodes = { ran: [1, 2] };

/**
 * The JSON report out of a stylelint run, whichever stream carried it (#1937).
 *
 * stylelint 16+ writes the formatted report to STDERR whenever the run
 * "errored" — which is every run that found an error-severity warning, i.e.
 * every run with something to say. Reading stdout alone parsed nothing and
 * called the stylesheet clean, the #1933 vale shape. Verified against
 * stylelint 17.8.0 in tests/fixtures/runner-output/stylelint/.
 *
 * Only a stream that actually starts a JSON array counts. A crash's stack
 * trace on stderr must stay "nothing to parse" so #1816's empty-result skip
 * still fires instead of reporting a clean file.
 */
export function stylelintReport(
	stdout: string | undefined,
	stderr: string | undefined,
): string {
	for (const stream of [stdout, stderr]) {
		if (stream?.trimStart().startsWith("[")) return stream;
	}
	return "";
}

interface StylelintWarning {
	line: number;
	column: number;
	severity: string;
	rule: string;
	text: string;
}

interface StylelintResult {
	source: string;
	warnings: StylelintWarning[];
}

// Stylelint's standard JSON output reports only aggregate fixableErrorCount /
// fixableWarningCount per file — there is no per-warning fix flag in the CLI
// surface. To route the actionable warnings here without a tool rewrite, we
// keep a curated set of rule IDs whose `--fix` behavior is deterministic and
// safe. Sourced from rule pages in stylelint's docs that explicitly state
// "stylelint can automatically fix all of the problems reported by this rule".
// Update when stylelint adds or removes fixable rules.
const STYLELINT_FIXABLE_RULES = new Set<string>([
	// whitespace / spacing — formatter-style, always safe
	"block-no-empty",
	"color-hex-length",
	"declaration-block-no-duplicate-properties",
	"declaration-block-no-redundant-longhand-properties",
	"declaration-block-no-shorthand-property-overrides",
	"declaration-block-single-line-max-declarations",
	"font-family-name-quotes",
	"function-url-quotes",
	"length-zero-no-unit",
	"media-feature-name-no-vendor-prefix",
	"no-descending-specificity",
	"no-duplicate-at-import-rules",
	"no-duplicate-selectors",
	"no-empty-source",
	"no-eol-whitespace",
	"no-extra-semicolons",
	"no-invalid-double-slash-comments",
	"no-missing-end-of-source-newline",
	"number-leading-zero",
	"number-no-trailing-zeros",
	"property-no-vendor-prefix",
	"selector-attribute-quotes",
	"selector-no-vendor-prefix",
	"selector-pseudo-element-colon-notation",
	"selector-type-case",
	"shorthand-property-no-redundant-values",
	"string-quotes",
	"value-no-vendor-prefix",
]);

function parseStylelintJson(raw: string, filePath: string): Diagnostic[] {
	try {
		const results: StylelintResult[] = JSON.parse(raw);
		const diagnostics: Diagnostic[] = [];
		for (const result of results) {
			for (const w of result.warnings) {
				const severity = w.severity === "error" ? "error" : "warning";
				const fixable = STYLELINT_FIXABLE_RULES.has(w.rule);
				diagnostics.push({
					id: `stylelint-${w.line}-${w.rule}`,
					message: `[${w.rule}] ${w.text.replace(/\s*\(stylelint.*?\)$/, "")}`,
					filePath,
					line: w.line,
					column: w.column,
					severity,
					semantic: severity === "error" ? "blocking" : "warning",
					tool: "stylelint",
					rule: w.rule,
					fixable,
					fixSuggestion: fixable
						? "Run `stylelint --fix` to apply the deterministic auto-correction for this rule."
						: undefined,
				});
			}
		}
		return diagnostics;
	} catch {
		return [];
	}
}

const stylelintRunner: RunnerDefinition = {
	id: "stylelint",
	appliesTo: ["css"],
	priority: PRIORITY.FORMAT_AND_LINT_PRIMARY,
	enabledByDefault: true,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();
		const policy = getLinterPolicyForCwd(ctx.filePath, cwd);
		if (policy && !policy.preferredRunners.includes("stylelint")) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}
		const fileDir = path.dirname(path.resolve(cwd, ctx.filePath));
		const hasConfig = hasStylelintConfig(fileDir) || hasStylelintConfig(cwd);
		if (!hasConfig) {
			ctx.log("stylelint: no config detected, running with default rules");
		}

		let cmd: string | null = null;
		if (await stylelint.isAvailableAsync(cwd)) {
			cmd = stylelint.getCommand(cwd);
		} else {
			cmd = await resolveToolCommandWithInstallFallback(cwd, "stylelint");
		}

		if (!cmd) return { status: "skipped", diagnostics: [], semantic: "none" };

		const result = await safeSpawnAsync(
			cmd,
			["--formatter", "json", ctx.filePath],
			{ timeout: 20000, cwd },
		);

		// #1816: this runner read `result.status` zero times, so an exit-78
		// config error (or an exit-1 crash) fell through parseStylelintJson's
		// catch to zero diagnostics and reported a clean stylesheet.
		const raw = stylelintReport(result.stdout, result.stderr);
		// #1948: the stdout-vs-stderr report bug landed here as exit 2 plus a
		// full JSON report and zero parsed warnings. That now leaves a record.
		const run = parseToolRun(
			"stylelint",
			{ result, output: raw, exitCodes: STYLELINT_EXIT_CODES },
			(out) => parseStylelintJson(out, ctx.filePath),
		);
		if (run.skipped) return run.skipped;

		const diagnostics = run.diagnostics;
		return finishParsedRun({
			tool: "stylelint",
			ctx,
			result,
			diagnostics,
		});
	},
};

export default stylelintRunner;
