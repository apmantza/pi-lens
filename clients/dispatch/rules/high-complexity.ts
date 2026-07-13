import type { FactRule } from "../fact-provider-types.js";
import type { Diagnostic } from "../types.js";
import type { FunctionSummary } from "../facts/function-facts.js";
import { isTestSuiteOrganizer } from "./framework-call-noise.js";

// Defaults match the historical hardcoded values so behavior is unchanged for
// projects without a config. Project-specific overrides are read from the
// per-dispatch context; these mutable fallbacks exist for tests/legacy direct
// rule evaluation only.
export const DEFAULT_HIGH_COMPLEXITY_THRESHOLD = 15;
export const DEFAULT_HIGH_COMPLEXITY_DEPTH_THRESHOLD = 6;
let ccThreshold = DEFAULT_HIGH_COMPLEXITY_THRESHOLD;
let depthThreshold = DEFAULT_HIGH_COMPLEXITY_DEPTH_THRESHOLD;

function isPositiveFiniteThreshold(value: number): boolean {
	return Number.isFinite(value) && value > 0;
}

/** Override fallback thresholds for tests/legacy direct rule evaluation. */
export function setHighComplexityThresholds(cc: number, depth: number): void {
	// Non-positive thresholds make every function violate the rule; treat them as
	// invalid config/test input rather than turning the rule into noise.
	if (isPositiveFiniteThreshold(cc)) ccThreshold = cc;
	if (isPositiveFiniteThreshold(depth)) depthThreshold = depth;
}

/** Test helper: restore compile-time defaults. */
export function resetHighComplexityThresholds(): void {
	ccThreshold = DEFAULT_HIGH_COMPLEXITY_THRESHOLD;
	depthThreshold = DEFAULT_HIGH_COMPLEXITY_DEPTH_THRESHOLD;
}

export const highComplexityRule: FactRule = {
	id: "high-complexity",
	requires: ["file.functionSummaries"],
	appliesTo(ctx) {
		return /\.tsx?$/.test(ctx.filePath);
	},
	evaluate(ctx, store) {
		const fns =
			store.getFileFact<FunctionSummary[]>(
				ctx.filePath,
				"file.functionSummaries",
			) ?? [];

		const diagnostics: Diagnostic[] = [];
		const configuredCcThreshold =
			ctx.projectConfig?.rules["high-complexity"]?.threshold;
		const activeCcThreshold = configuredCcThreshold ?? ccThreshold;

		for (const f of fns) {
			// A describe()/it()/test() wrapper's own complexity/nesting-depth
			// aggregates branches from ALL of its nested test bodies (#577) — e.g. a
			// `for` loop inside each of several `it()`s sums into the enclosing
			// `describe()`'s cyclomatic complexity, even though no single test is
			// complex. Unlike high-fan-out's call-name filter, there's no per-call
			// signal to exclude for branch counting, so the equivalent fix here is to
			// skip the organizer function itself. Genuinely complex test HELPER
			// functions don't call it/describe/test themselves, so they're unaffected.
			if (isTestSuiteOrganizer(f.outgoingCalls)) continue;

			const ccBreached = f.cyclomaticComplexity >= activeCcThreshold;
			const depthBreached = f.maxNestingDepth >= depthThreshold;
			if (!ccBreached && !depthBreached) continue;

			const parts: string[] = [];
			if (ccBreached)
				parts.push(`cyclomatic complexity ${f.cyclomaticComplexity}`);
			if (depthBreached) parts.push(`nesting depth ${f.maxNestingDepth}`);

			diagnostics.push({
				id: `high-complexity:${ctx.filePath}:${f.line}`,
				tool: "fact-rules",
				rule: "high-complexity",
				filePath: ctx.filePath,
				line: f.line,
				column: f.column,
				severity: "warning",
				semantic: "warning",
				message: `'${f.name}' has ${parts.join(" and ")} — consider breaking it up`,
			});
		}

		return diagnostics;
	},
};
