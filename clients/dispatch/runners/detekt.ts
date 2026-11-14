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
import {
	resolveToolCommandWithInstallFallback,
	toolAbsentSkip,
} from "./utils/runner-helpers.js";
import { finishParsedRun, parseToolRun } from "./utils/tool-failure.js";
import { semanticFor } from "../types.js";
import yaml from "../../deps/js-yaml.js";
import {
	type AnchoredConfig,
	anchorIgnorePatterns,
	markUnanchored,
	readConfigText,
	withOverlayFile,
} from "./utils/ignore-anchor.js";

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

/**
 * detekt's own top-level sections that are not rule sets: their `excludes` and
 * `exclude` keys name report ids or config paths, never files, so they are not
 * path filters and are left as written.
 */
const DETEKT_NON_RULESET_KEYS = new Set([
	"build",
	"config",
	"processors",
	"console-reports",
	"output-reports",
]);

const DETEKT_PATH_FILTER_KEYS = ["excludes", "includes"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}

/**
 * detekt reads `excludes` and `includes` at two depths of the config: on a rule
 * set (`style: excludes:`) and on a rule (`style: MagicNumber: excludes:`). The
 * value is a list of globs, or one string of comma-separated globs. Each glob is
 * matched against the file's absolute path, so a `**\/x/**` entry reaches the
 * ancestors of the project root too (#5594).
 *
 * The result is an overlay holding ONLY the lists this rewrote, at the place
 * they sit; detekt reads it after the project's own file (`--config
 * <project>,<overlay>`: the later file wins a key), so every other value is the
 * one detekt reads from the project's file itself. A copy of the whole tree
 * would re-spell values this does not model: `threshold: 60.0` came back as
 * `60`, and a config detekt refuses ran (#5606 round 3, row D20).
 *
 * Refused (`unapplied`), because the rewrite cannot be shown to keep the
 * meaning: a YAML the loader cannot read, a path-filter value of another type,
 * a glob form `anchorIgnorePattern` does not recognise, and a comma string
 * holding braces (the comma inside `{kt,kts}` and the comma between globs
 * cannot be told apart).
 */
export function anchorDetektConfig(text: string, root: string): AnchoredConfig {
	// An empty file holds no glob, and js-yaml refuses a document with no content.
	if (text.trim() === "") return { kind: "unchanged" };
	let tree: unknown;
	try {
		tree = yaml.load(text);
	} catch (err) {
		// none: the failure is returned as `unapplied`, and the runner's `markUnanchored` records it and withholds the clean verdict.
		return {
			kind: "unapplied",
			reason: `its detekt config is not readable YAML (${
				err instanceof Error ? err.message.split("\n")[0] : "load failed"
			})`,
		};
	}
	if (tree === null || tree === undefined) return { kind: "unchanged" };
	if (!isPlainObject(tree)) {
		return {
			kind: "unapplied",
			reason: "its detekt config is not a map of rule sets",
		};
	}
	// Null-prototype maps: a rule set or rule named `__proto__` stays a key.
	const overlay: Record<string, Record<string, unknown>> = Object.create(null);
	let refused: string | undefined;
	const rewrite = (
		holder: Record<string, unknown>,
		place: () => Record<string, unknown>,
	): void => {
		for (const key of DETEKT_PATH_FILTER_KEYS) {
			const value = holder[key];
			if (value === undefined || value === null) continue;
			let entries: string[];
			if (typeof value === "string") {
				if (/[{}]/.test(value)) {
					refused = `an ${key} string holds braces: ${value}`;
					return;
				}
				entries = value.split(",").flatMap((entry) => {
					const trimmed = entry.trim();
					return trimmed.length > 0 ? [trimmed] : [];
				});
			} else if (
				Array.isArray(value) &&
				value.every((entry) => typeof entry === "string")
			) {
				entries = value as string[];
			} else {
				refused = `an ${key} value is not a glob list`;
				return;
			}
			const anchored = anchorIgnorePatterns(entries, root, "java-glob");
			if ("unrecognized" in anchored) {
				refused = `${key} entry ${JSON.stringify(anchored.unrecognized)} is not a form it can anchor`;
				return;
			}
			if (
				anchored.patterns.length !== entries.length ||
				anchored.patterns.some((entry, index) => entry !== entries[index])
			) {
				place()[key] = anchored.patterns;
			}
		}
	};
	for (const [name, ruleset] of Object.entries(tree)) {
		if (DETEKT_NON_RULESET_KEYS.has(name) || !isPlainObject(ruleset)) continue;
		const rulesetPlace = () => (overlay[name] ??= Object.create(null));
		rewrite(ruleset, rulesetPlace);
		for (const [ruleName, rule] of Object.entries(ruleset)) {
			if (refused) break;
			if (isPlainObject(rule)) {
				rewrite(rule, () => {
					const set = rulesetPlace();
					return (set[ruleName] ??= Object.create(null)) as Record<
						string,
						unknown
					>;
				});
			}
		}
		if (refused) break;
	}
	if (refused) {
		return { kind: "unapplied", reason: `its detekt config: ${refused}` };
	}
	if (Object.keys(overlay).length === 0) return { kind: "unchanged" };
	return {
		kind: "rewritten",
		text: yaml.dump(overlay, { lineWidth: -1, noRefs: true }),
	};
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

		const cmd = await resolveToolCommandWithInstallFallback(cwd, "detekt");
		if (!cmd) return toolAbsentSkip(cwd, { id: "detekt" });

		const absPath = path.resolve(cwd, ctx.filePath);
		// #5594: detekt reads the project's own config and then an overlay with
		// every glob list anchored at the project root (the later file wins a
		// key). A config the rewrite cannot be shown to keep runs as it stands,
		// and `finish` withholds its clean answer.
		const read = readConfigText("detekt", configPath);
		const anchored: AnchoredConfig =
			read.kind === "read" ? anchorDetektConfig(read.text, cwd) : read;
		const finish = (verdict: RunnerResult): RunnerResult =>
			anchored.kind === "unapplied"
				? markUnanchored("detekt", anchored.reason, verdict)
				: verdict;
		const spawnDetekt = (config: string) =>
			safeSpawnAsync(cmd, ["--input", absPath, "--config", config], {
				cwd,
				timeout: 60000,
			});
		const result =
			anchored.kind === "rewritten"
				? await withOverlayFile("detekt", "detekt.yml", anchored.text, (file) =>
						spawnDetekt(`${configPath},${file}`),
					)
				: await spawnDetekt(configPath);

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
		if (run.diagnostics.length === 0) return finish(verdict);
		// #4522 T1: exit 1 is a tool error, and detekt can print findings before it.
		// Those findings are kept, but the read is incomplete, so the run is flagged
		// `inconclusive` (the existing "reached no verdict" shape, as tree-sitter's
		// query-run-threw path). Exit 2 is the complete findings class and is not flagged.
		// #4522 F2: here `inconclusive` sits beside failureKind `blocking_diagnostics`,
		// a pairing the RunnerResult field doc does not name, and hasUsableResult still
		// counts this run as usable coverage. It is inert for detekt today (no
		// primary-group consumer reads it); this is a documented gap, not a behaviour.
		return finish(
			result.status === 1 ? { ...verdict, inconclusive: true } : verdict,
		);
	},
};

export default detektRunner;
export { DETEKT_FIXABLE_RULES, parseDetektOutput };
