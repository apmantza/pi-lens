import type { FactRule } from "../fact-provider-types.js";
import type { Diagnostic } from "../types.js";
import type { FunctionSummary } from "../facts/function-facts.js";
import { isTypeScriptFile } from "../../language-registry.js";

export const asyncUnnecessaryWrapperRule: FactRule = {
	id: "async-unnecessary-wrapper",
	requires: ["file.functionSummaries"],
	appliesTo(ctx) {
		return isTypeScriptFile(ctx.filePath);
	},
	evaluate(ctx, store) {
		const fns =
			store.getFileFact<FunctionSummary[]>(
				ctx.filePath,
				"file.functionSummaries",
			) ?? [];

		const diagnostics: Diagnostic[] = [];

		for (const f of fns) {
			if (!f.isAsync || !f.isPassThroughWrapper || f.hasAwait) continue;

			diagnostics.push({
				id: `async-unnecessary-wrapper:${ctx.filePath}:${f.line}`,
				tool: "fact-rules",
				rule: "async-unnecessary-wrapper",
				filePath: ctx.filePath,
				line: f.line,
				column: f.column,
				severity: "warning",
				semantic: "warning",
				message: `'${f.name}' is async but has no await and just forwards to '${f.passThroughTarget}' — the async keyword is unnecessary and wraps the return in an extra Promise`,
			});
		}

		return diagnostics;
	},
};
