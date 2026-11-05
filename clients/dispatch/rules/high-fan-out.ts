import type { FactRule } from "../fact-provider-types.js";
import type { Diagnostic } from "../types.js";
import type { FunctionSummary } from "../facts/function-facts.js";
import {
	isTestFrameworkNoiseCall,
	isTestSuiteOrganizer,
} from "./framework-call-noise.js";
import { isTypeScriptFile } from "../../language-registry.js";

// Default matches the historical hardcoded value so behavior is unchanged for
// projects without a config. Project-specific overrides are read from the
// per-dispatch context.
const DEFAULT_HIGH_FAN_OUT_THRESHOLD = 20;

export const highFanOutRule: FactRule = {
	id: "high-fan-out",
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
		const configuredFanOutThreshold =
			ctx.projectConfig?.rules["high-fan-out"]?.threshold;
		const activeFanOutThreshold =
			configuredFanOutThreshold ?? DEFAULT_HIGH_FAN_OUT_THRESHOLD;

		for (const f of fns) {
			// A describe()/it()/test() wrapper's own call list aggregates every call
			// from ALL of its nested test bodies (#577) — not real fan-out. Genuinely
			// complex test HELPER functions don't call it/describe/test themselves, so
			// they're unaffected.
			if (isTestSuiteOrganizer(f.outgoingCalls)) continue;

			// Filter out noise: utility calls, logging, type assertions, and
			// test-framework calls (expect/it/describe/vi.*/jest.*, #577) — assertion-
			// and mock-heavy test bodies naturally call many of these; that's test
			// structure, not a coordination smell.
			const meaningful = f.outgoingCalls.filter((c) => {
				const lower = c.toLowerCase();
				return (
					!lower.startsWith("console.") &&
					!lower.startsWith("math.") &&
					!lower.startsWith("json.") &&
					!lower.startsWith("object.") &&
					!lower.startsWith("array.") &&
					!lower.startsWith("string(") &&
					!lower.startsWith("number(") &&
					!lower.startsWith("boolean(") &&
					!lower.startsWith("error(") &&
					c !== "resolve" &&
					c !== "reject" &&
					c !== "next" &&
					c !== "done" &&
					!isTestFrameworkNoiseCall(c)
				);
			});

			if (meaningful.length < activeFanOutThreshold) continue;

			diagnostics.push({
				id: `high-fan-out:${ctx.filePath}:${f.line}`,
				tool: "fact-rules",
				rule: "high-fan-out",
				filePath: ctx.filePath,
				line: f.line,
				column: f.column,
				severity: "warning",
				semantic: "warning",
				message: `'${f.name}' calls ${meaningful.length} distinct functions — coordination smell, consider splitting responsibilities`,
			});
		}

		return diagnostics;
	},
};
