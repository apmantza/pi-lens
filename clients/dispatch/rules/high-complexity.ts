import type { FactRule } from "../fact-provider-types.js";
import type { Diagnostic } from "../types.js";
import type { FunctionSummary } from "../facts/function-facts.js";

// Thresholds are mutable so a project's `.pi-lens.json` can override them via
// `rules["high-complexity"].threshold` (cyclomatic complexity) and (implicitly)
// the depth threshold via the same setter. Defaults match the historical
// hardcoded values so behavior is unchanged for projects without a config.
export const DEFAULT_HIGH_COMPLEXITY_THRESHOLD = 15;
export const DEFAULT_HIGH_COMPLEXITY_DEPTH_THRESHOLD = 6;
let ccThreshold = DEFAULT_HIGH_COMPLEXITY_THRESHOLD;
let depthThreshold = DEFAULT_HIGH_COMPLEXITY_DEPTH_THRESHOLD;

function isPositiveFiniteThreshold(value: number): boolean {
	return Number.isFinite(value) && value > 0;
}

/** Override thresholds from a project's `.pi-lens.json`. Idempotent. */
export function setHighComplexityThresholds(cc: number, depth: number): void {
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

		for (const f of fns) {
			const ccBreached = f.cyclomaticComplexity >= ccThreshold;
			const depthBreached = f.maxNestingDepth >= depthThreshold;
			if (!ccBreached && !depthBreached) continue;

			const parts: string[] = [];
			if (ccBreached)
				parts.push(`cyclomatic complexity ${f.cyclomaticComplexity}`);
			if (depthBreached) parts.push(`nesting depth ${f.maxNestingDepth}`);

			diagnostics.push({
				id: `high-complexity:${ctx.filePath}:${f.line}`,
				tool: "high-complexity",
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
