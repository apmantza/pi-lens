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

const stylelint = createAvailabilityChecker("stylelint", ".cmd");

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
		if (
			await (stylelint.isAvailableAsync?.(cwd) ?? stylelint.isAvailable(cwd))
		) {
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

		const raw = result.stdout ?? "";
		const diagnostics = parseStylelintJson(raw, ctx.filePath);
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

export default stylelintRunner;
