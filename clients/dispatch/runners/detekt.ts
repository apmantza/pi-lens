import * as fs from "node:fs";
import * as path from "node:path";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { getLinterPolicyForCwd } from "../../tool-policy.js";
import { PRIORITY } from "../priorities.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { createAvailabilityChecker } from "./utils/runner-helpers.js";

const detekt = createAvailabilityChecker("detekt", ".bat");

const DETEKT_CONFIG_CANDIDATES = [
	"detekt.yml",
	".detekt.yml",
	path.join("config", "detekt", "detekt.yml"),
	path.join("detekt", "detekt.yml"),
];

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

function findDetektConfig(cwd: string): string | undefined {
	for (const candidate of DETEKT_CONFIG_CANDIDATES) {
		const full = path.join(cwd, candidate);
		if (fs.existsSync(full)) return full;
	}
	return undefined;
}

// detekt text output: /path/file.kt:10:5: error: Message [RuleId]
function parseDetektOutput(raw: string, filePath: string): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const pattern =
		/^(.+?):(\d+):(\d+): (error|warning): (.+?)(?:\s+\[([^\]]+)\])?$/gm;

	const absTarget = path.resolve(filePath);
	for (const match of raw.matchAll(pattern)) {
		const [, file, lineStr, colStr, level, message, rule] = match;
		if (path.resolve(file.trim()) !== absTarget) continue;

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
			semantic: severity === "error" ? "blocking" : "warning",
			tool: "detekt",
			rule: ruleId,
			defectClass: "style",
			fixable,
			fixSuggestion: fixable
				? "Run `detekt --auto-correct` to apply the deterministic auto-correction for this rule."
				: undefined,
		});
	}
	return diagnostics;
}

const detektRunner: RunnerDefinition = {
	id: "detekt",
	appliesTo: ["kotlin"],
	priority: PRIORITY.GENERAL_ANALYSIS,
	enabledByDefault: true,
	timeoutMs: 90_000,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();

		const policy = getLinterPolicyForCwd(ctx.filePath, cwd);
		if (policy && !policy.preferredRunners.includes("detekt")) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const configPath = findDetektConfig(cwd);
		if (!configPath) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const cmd = (await detekt.isAvailableAsync(cwd))
			? detekt.getCommand(cwd)
			: null;
		if (!cmd) return { status: "skipped", diagnostics: [], semantic: "none" };

		const absPath = path.resolve(cwd, ctx.filePath);
		const result = await safeSpawnAsync(
			cmd,
			["--input", absPath, "--config", configPath],
			{ cwd, timeout: 60000 },
		);

		if (result.error && !result.stdout && !result.stderr) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const raw = `${result.stdout ?? ""}${result.stderr ?? ""}`;
		const diagnostics = parseDetektOutput(raw, ctx.filePath);

		if (diagnostics.length === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		const hasErrors = diagnostics.some((d) => d.severity === "error");
		return {
			status: hasErrors ? "failed" : "succeeded",
			diagnostics,
			semantic: hasErrors ? "blocking" : "warning",
		};
	},
};

export default detektRunner;
export { parseDetektOutput, DETEKT_FIXABLE_RULES };
