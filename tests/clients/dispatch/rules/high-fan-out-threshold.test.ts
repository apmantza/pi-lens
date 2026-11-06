import { describe, expect, it } from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import { highFanOutRule } from "../../../../clients/dispatch/rules/high-fan-out.js";
import type { FunctionSummary } from "../../../../clients/dispatch/facts/function-facts.js";
import type { DispatchContext } from "../../../../clients/dispatch/types.js";
import type { FileKind } from "../../../../clients/file-kinds.js";
import {
	EMPTY_PROJECT_CONFIG,
	type PiLensProjectConfig,
} from "../../../../clients/project-lens-config.js";

function makeCtx(
	filePath: string,
	facts: FactStore,
	projectConfig?: PiLensProjectConfig,
): DispatchContext {
	return {
		filePath,
		cwd: "/tmp",
		kind: "jsts" as FileKind,
		fileRole: "source",
		pi: { getFlag: () => undefined },
		autofix: false,
		deltaMode: false,
		facts,
		// The dispatcher hands a rule threshold from the file's config owner, and
		// `projectConfig` is not a threshold source any more (#5292), so a
		// hand-built context supplies it over that one seam.
		ruleThreshold: (ruleId) => projectConfig?.rules[ruleId]?.threshold,
		hasTool: async () => false,
		log: () => {},
	};
}

function fanOutThresholdConfig(threshold: number): PiLensProjectConfig {
	return {
		...EMPTY_PROJECT_CONFIG,
		rules: { "high-fan-out": { threshold } },
	};
}

function summaryWithCallees(callees: string[]): FunctionSummary {
	return {
		name: "f",
		line: 1,
		column: 1,
		isAsync: false,
		hasAwait: false,
		hasReturnAwaitCall: false,
		statementCount: 1,
		parameterCount: 0,
		isPassThroughWrapper: false,
		isBoundaryWrapper: false,
		cyclomaticComplexity: 1,
		maxNestingDepth: 1,
		outgoingCalls: callees,
	};
}

describe("highFanOutRule threshold override", () => {
	it("flags a function with callees exactly at the default threshold (20)", () => {
		const filePath = "/tmp/a.ts";
		const facts = new FactStore();
		const callees = Array.from({ length: 20 }, (_, i) => `fn${i}`);
		facts.setFileFact(filePath, "file.functionSummaries", [
			summaryWithCallees(callees),
		]);

		const ctx = makeCtx(filePath, facts);
		const diagnostics = highFanOutRule.evaluate(ctx, facts);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].rule).toBe("high-fan-out");
	});

	it("does NOT flag a function below the default threshold", () => {
		const filePath = "/tmp/a.ts";
		const facts = new FactStore();
		const callees = Array.from({ length: 19 }, (_, i) => `fn${i}`);
		facts.setFileFact(filePath, "file.functionSummaries", [
			summaryWithCallees(callees),
		]);

		const ctx = makeCtx(filePath, facts);
		const diagnostics = highFanOutRule.evaluate(ctx, facts);
		expect(diagnostics).toHaveLength(0);
	});

	it("respects a project-config threshold — lower threshold flags more", () => {
		const filePath = "/tmp/a.ts";
		const facts = new FactStore();
		const callees = Array.from({ length: 6 }, (_, i) => `fn${i}`);
		facts.setFileFact(filePath, "file.functionSummaries", [
			summaryWithCallees(callees),
		]);

		const ctx = makeCtx(filePath, facts, fanOutThresholdConfig(5));
		const diagnostics = highFanOutRule.evaluate(ctx, facts);
		expect(diagnostics).toHaveLength(1);
	});

	it("respects a project-config threshold — higher threshold flags less", () => {
		const filePath = "/tmp/a.ts";
		const facts = new FactStore();
		const callees = Array.from({ length: 25 }, (_, i) => `fn${i}`);
		facts.setFileFact(filePath, "file.functionSummaries", [
			summaryWithCallees(callees),
		]);

		const ctx = makeCtx(filePath, facts, fanOutThresholdConfig(50));
		const diagnostics = highFanOutRule.evaluate(ctx, facts);
		expect(diagnostics).toHaveLength(0);
	});

	it("noise filters in the rule body still apply after threshold override", () => {
		// Even with threshold=2, console.* / resolve / etc. are filtered before
		// the count check, so a body full of console.log still doesn't flag.
		const filePath = "/tmp/a.ts";
		const facts = new FactStore();
		const callees = [
			"console.log",
			"console.warn",
			"resolve",
			"reject",
			"console.error",
		];
		facts.setFileFact(filePath, "file.functionSummaries", [
			summaryWithCallees(callees),
		]);

		const ctx = makeCtx(filePath, facts, fanOutThresholdConfig(2));
		const diagnostics = highFanOutRule.evaluate(ctx, facts);
		expect(diagnostics).toHaveLength(0);
	});
});
