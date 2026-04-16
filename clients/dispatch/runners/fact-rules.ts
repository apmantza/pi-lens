/**
 * Fact-rules runner — executes all registered FactRule instances against
 * the populated fact store. Each FactRule has its own appliesTo() guard
 * so this runner can be registered broadly; rules self-select.
 *
 * Severity semantics follow each rule's own diagnostic output.
 * Blocking rules surface on every write; warning-tier rules surface
 * only during full scans (blockingOnly === false).
 */

import type {
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { PRIORITY } from "../priorities.js";
import { evaluateRules } from "../fact-rule-runner.js";

const factRulesRunner: RunnerDefinition = {
	id: "fact-rules",
	appliesTo: ["jsts", "python", "go", "rust", "ruby", "shell", "cmake"],
	priority: PRIORITY.GENERAL_ANALYSIS + 1, // just after type-safety
	enabledByDefault: true,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const diagnostics = evaluateRules(ctx);

		if (diagnostics.length === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		const hasBlocking = diagnostics.some(
			(d) => d.semantic === "blocking" || d.severity === "error",
		);

		return {
			status: hasBlocking ? "failed" : "succeeded",
			diagnostics,
			semantic: hasBlocking ? "blocking" : "warning",
		};
	},
};

export default factRulesRunner;
