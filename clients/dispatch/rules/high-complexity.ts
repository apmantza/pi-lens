import type { FactRule } from "../fact-provider-types.js";
import type { Diagnostic } from "../types.js";
import type { FunctionSummary } from "../facts/function-facts.js";

const CC_THRESHOLD = 10;
const DEPTH_THRESHOLD = 5;

export const highComplexityRule: FactRule = {
	id: "high-complexity",
	requires: ["file.functionSummaries"],
	appliesTo(ctx) {
		return /\.tsx?$/.test(ctx.filePath);
	},
	evaluate(ctx, store) {
		const fns =
			store.getFileFact<FunctionSummary[]>(ctx.filePath, "file.functionSummaries") ?? [];

		const diagnostics: Diagnostic[] = [];

		for (const f of fns) {
			const ccBreached = f.cyclomaticComplexity >= CC_THRESHOLD;
			const depthBreached = f.maxNestingDepth >= DEPTH_THRESHOLD;
			if (!ccBreached && !depthBreached) continue;

			const parts: string[] = [];
			if (ccBreached) parts.push(`cyclomatic complexity ${f.cyclomaticComplexity}`);
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
