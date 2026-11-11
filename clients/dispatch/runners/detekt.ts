import { toolAbsentSkip } from "./utils/runner-helpers.js";
import { skipped } from "../types.js";
import * as path from "node:path";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { pathsEqual } from "../../path-utils.js";
import { resolveRunnerCwd } from "../../tool-cwd.js";
import { findToolConfig, hasToolConfig } from "../../tool-config-presence.js";
import { getLinterPolicyForCwd } from "../../tool-policy.js";
import { PRIORITY } from "../priorities.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { createAvailabilityChecker } from "./utils/runner-helpers.js";
import { finishParsedRun, parseToolRun } from "./utils/tool-failure.js";
import { semanticFor } from "../types.js";

const detekt = createAvailabilityChecker("detekt", ".bat");

// Rules that `detekt --auto-correct` rewrites deterministically. Detekt's
// formatting ruleset wraps ktlint, whose rules are all autocorrectable; a
// small handful of style rules also support autocorrect. Detekt's text
// output does not surface a per-finding `canAutoCorrect` flag, so we keep a
// curated allowlist here. Source: https://detekt.dev/docs/rules/formatting/
// plus the autoCorrect-capable rules under style/comments. Conservative —
// when in doubt, leave a rule off this list.
const DETEKT_FIXABLE_RULES = new Set<string>([
	// formatting (ktlint wrapper) — every rule supports autocorrect
	"AnnotationOnSeparateLine",
	"AnnotationSpacing",
	"ArgumentListWrapping",
	"BlockCommentInitialStarAlignment",
	"ChainWrapping",
	"CommentSpacing",
	"CommentWrapping",
	"EnumEntryNameCase",
	"Filename",
	"FinalNewline",
	"ImportOrdering",
	"Indentation",
	"MaximumLineLength",
	"ModifierListSpacing",
	"ModifierOrdering",
	"MultiLineIfElse",
	"NoBlankLineBeforeRbrace",
	"NoBlankLinesInChainedMethodCalls",
	"NoConsecutiveBlankLines",
	"NoEmptyClassBody",
	"NoEmptyFirstLineInMethodBlock",
	"NoLineBreakAfterElse",
	"NoLineBreakBeforeAssignment",
	"NoMultipleSpaces",
	"NoSemicolons",
	"NoTrailingSpaces",
	"NoUnitReturn",
	"NoUnusedImports",
	"NoWildcardImports",
	"PackageName",
	"ParameterListWrapping",
	"SpacingAroundAngleBrackets",
	"SpacingAroundColon",
	"SpacingAroundComma",
	"SpacingAroundCurly",
	"SpacingAroundDot",
	"SpacingAroundDoubleColon",
	"SpacingAroundKeyword",
	"SpacingAroundOperators",
	"SpacingAroundParens",
	"SpacingAroundRangeOperator",
	"SpacingAroundUnaryOperator",
	"SpacingBetweenDeclarationsWithAnnotations",
	"SpacingBetweenDeclarationsWithComments",
	"StringTemplate",
	"TrailingCommaOnCallSite",
	"TrailingCommaOnDeclarationSite",
	"TypeArgumentListSpacing",
	"TypeParameterListSpacing",
	"UnnecessaryParenthesesBeforeTrailingLambda",
	"Wrapping",
	// style / comments — these implement autoCorrect in their detekt rule classes
	"OptionalUnit",
	"OptionalAbstractKeyword",
	"ProtectedMemberInFinalClass",
	"UnnecessaryParentheses",
	"UnusedImports",
	"UnusedPrivateClass",
	"RedundantVisibilityModifierRule",
]);

// detekt text output: /path/file.kt:10:5: Message [RuleId] — no severity token
//
// The level is therefore optional, and a finding that carries none is a warning
// (#4522). The comment here is the one place the shape is stated; the captured
// replay (`detekt/real`) is what proves it.
/**
 * `null` is "this output is not a detekt report" (#5411); `[]` is a report that
 * was read and holds nothing for this file. `finishParsedRun` tells them apart.
 */
function parseDetektOutput(
	raw: string,
	filePath: string,
	cwd: string,
): Diagnostic[] | null {
	const diagnostics: Diagnostic[] = [];
	if (!raw.trim()) return diagnostics;
	let located = 0;
	const pattern =
		/^(.+?):(\d+):(\d+): (?:(error|warning): )?(.+?)(?:\s+\[([^\]]+)\])?$/gm;

	const absTarget = path.resolve(cwd, filePath);
	for (const match of raw.matchAll(pattern)) {
		const [, file, lineStr, colStr, level, message, rule] = match;
		located += 1;
		// #3278: one seam for reported-path attribution — see javac.ts.
		if (!pathsEqual(path.resolve(cwd, file.trim()), absTarget)) continue;

		const severity = level === "error" ? "error" : "warning";
		const lineNum = Number.parseInt(lineStr, 10);
		const colNum = Number.parseInt(colStr, 10);
		const ruleId = rule ?? "detekt";
		const fixable = rule ? DETEKT_FIXABLE_RULES.has(rule) : false;

		diagnostics.push({
			id: `detekt-${ruleId}-${lineNum}-${colNum}`,
			message: rule ? `[${rule}] ${message}` : message,
			filePath,
			line: lineNum,
			column: colNum,
			severity,
			semantic: semanticFor(severity),
			tool: "detekt",
			rule: ruleId,
			defectClass: "style",
			fixable,
			fixSuggestion: fixable
				? "Run `detekt --auto-correct` to apply the deterministic auto-correction for this rule."
				: undefined,
		});
	}
	return located > 0 ? diagnostics : null;
}

const detektRunner: RunnerDefinition = {
	id: "detekt",
	appliesTo: ["kotlin"],
	priority: PRIORITY.GENERAL_ANALYSIS,
	timeoutMs: 90_000,
	skipTestFiles: false,
	requiresConfig: (cwd) => hasToolConfig("detekt", cwd),

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = resolveRunnerCwd(ctx, "detekt");

		const policy = getLinterPolicyForCwd(ctx.filePath, cwd);
		if (policy && !policy.preferredRunners.includes("detekt")) {
			return skipped("not-preferred");
		}

		const configPath = findToolConfig("detekt", cwd)?.file;
		if (!configPath) {
			return skipped("not-configured");
		}

		const cmd = (await detekt.isAvailableAsync(cwd))
			? detekt.getCommand(cwd)
			: null;
		if (!cmd) return toolAbsentSkip();

		const absPath = path.resolve(cwd, ctx.filePath);
		const result = await safeSpawnAsync(
			cmd,
			["--input", absPath, "--config", configPath],
			{ cwd, timeout: 60000 },
		);

		// #1948: detekt reports across both streams, so the gate and the parser
		// read the same concatenated string. A nonzero exit that yields zero
		// findings out of real output is a parser break, not clean Kotlin.
		const raw = `${result.stdout ?? ""}${result.stderr ?? ""}`;
		const run = parseToolRun(
			"detekt",
			{
				result,
				output: raw,
				// EXIT TABLE (detekt 1.23.8 captured fixtures): 0 clean; 2 findings on stdout with empty stderr.
				// Exit 1 is a tool error with NO findings (captured broken-config run: an invalid detekt.yml
				// prints InvalidConfigurationError on stderr), and also can follow printed findings (captured
				// findings-then-exit1 run: a non-numeric build.weights value fails after the report). Exit 1 is
				// therefore admitted, and `finishParsedRun` reports it as failed/parser_error only when the
				// parser read no finding (#5411, was a skip), so a printed finding is kept. Any other nonzero
				// exit is rejected.
				exitCodes: { ran: [1, 2] },
			},
			(out) => parseDetektOutput(out, ctx.filePath, cwd),
		);
		if (run.skipped) return run.skipped;

		const verdict = finishParsedRun({
			tool: "detekt",
			ctx,
			result,
			diagnostics: run.diagnostics,
			unreadable: run.unreadable,
			classify: (diagnostics) => {
				const hasErrors = diagnostics.some((d) => d.severity === "error");
				return {
					status: hasErrors ? "failed" : "succeeded",
					semantic: hasErrors ? "blocking" : "warning",
				};
			},
		});
		if (run.diagnostics.length === 0) return verdict;
		// #4522 T1: exit 1 is a tool error, and detekt can print findings before it.
		// Those findings are kept, but the read is incomplete, so the run is flagged
		// `inconclusive` (the existing "reached no verdict" shape, as tree-sitter's
		// query-run-threw path). Exit 2 is the complete findings class and is not flagged.
		// #4522 F2: here `inconclusive` sits beside failureKind `blocking_diagnostics`,
		// a pairing the RunnerResult field doc does not name, and hasUsableResult still
		// counts this run as usable coverage. It is inert for detekt today (no
		// primary-group consumer reads it); this is a documented gap, not a behaviour.
		return result.status === 1 ? { ...verdict, inconclusive: true } : verdict;
	},
};

export default detektRunner;
export { DETEKT_FIXABLE_RULES, parseDetektOutput };
