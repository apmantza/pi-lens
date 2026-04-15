import type { FactRule } from "../fact-provider-types.js";
import type { Diagnostic } from "../types.js";
import type { FunctionSummary } from "../facts/function-facts.js";
import type { TryCatchSummary } from "../facts/try-catch-facts.js";

/**
 * Flags async functions where a catch block logs the error but doesn't
 * rethrow — the caller receives undefined and assumes success.
 *
 * Distinct from error-obscuring (catch param never referenced) and
 * error-swallowing (empty catch). This catches the "looks handled" pattern:
 *   } catch (err) {
 *     console.error(err);   ← appears handled
 *   }                        ← but caller gets undefined, not the error
 */
export const missingErrorPropagationRule: FactRule = {
	id: "missing-error-propagation",
	requires: ["file.functionSummaries", "file.tryCatchSummaries"],
	appliesTo(ctx) {
		return /\.tsx?$/.test(ctx.filePath);
	},
	evaluate(ctx, store) {
		const fns =
			store.getFileFact<FunctionSummary[]>(ctx.filePath, "file.functionSummaries") ?? [];
		const catches =
			store.getFileFact<TryCatchSummary[]>(ctx.filePath, "file.tryCatchSummaries") ?? [];

		const diagnostics: Diagnostic[] = [];

		// Only consider async functions
		const asyncFns = fns.filter((f) => f.isAsync && !f.isPassThroughWrapper);

		for (const f of asyncFns) {
			// Find catch blocks within this function's body
			// (catch line >= function line, and within reasonable range)
			const nextFnLine = fns
				.filter((g) => g.line > f.line)
				.reduce((min, g) => Math.min(min, g.line), Infinity);

			const relevantCatches = catches.filter(
				(c) => c.line >= f.line && c.line < nextFnLine,
			);

			for (const c of relevantCatches) {
				if (c.isEmpty || c.hasRethrow) continue;
				if (!c.hasLogging) continue;
				// Structured return or documented fallback = intentional error handling
				if (c.catchReturnsDefault) continue;
				if (c.catchReturnsStructuredError) continue;
				if (c.isDocumentedLocalFallback) continue;
				if (c.isFilesystemExistenceProbe) continue;
				// Catch body that sets an error-flag variable = intentional state management
				if (/\b(serverFailed|failed|error)\s*=/.test(c.bodyText)) continue;

				diagnostics.push({
					id: `missing-error-propagation:${ctx.filePath}:${c.line}`,
					tool: "missing-error-propagation",
					rule: "missing-error-propagation",
					filePath: ctx.filePath,
					line: c.line,
					column: c.column,
					severity: "warning",
					semantic: "warning",
					message: `Catch block in async '${f.name}' logs the error but doesn't rethrow — callers receive undefined and assume success`,
				});
			}
		}

		return diagnostics;
	},
};
