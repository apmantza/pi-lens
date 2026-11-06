import { describe, expect, it } from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import { highComplexityRule } from "../../../../clients/dispatch/rules/high-complexity.js";
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

function ccThresholdConfig(threshold: number): PiLensProjectConfig {
	return {
		...EMPTY_PROJECT_CONFIG,
		rules: { "high-complexity": { threshold } },
	};
}

function summaryWithCC(cc: number, depth = 1): FunctionSummary {
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
		cyclomaticComplexity: cc,
		maxNestingDepth: depth,
		outgoingCalls: [],
	};
}

describe("highComplexityRule threshold override", () => {
	it("flags a function with CC exactly at the default threshold (15)", () => {
		const filePath = "/tmp/a.ts";
		const facts = new FactStore();
		facts.setFileFact(filePath, "file.functionSummaries", [summaryWithCC(15)]);

		const ctx = makeCtx(filePath, facts);
		const diagnostics = highComplexityRule.evaluate(ctx, facts);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].rule).toBe("high-complexity");
	});

	it("does NOT flag a function with CC below the default threshold", () => {
		const filePath = "/tmp/a.ts";
		const facts = new FactStore();
		facts.setFileFact(filePath, "file.functionSummaries", [summaryWithCC(14)]);

		const ctx = makeCtx(filePath, facts);
		const diagnostics = highComplexityRule.evaluate(ctx, facts);
		expect(diagnostics).toHaveLength(0);
	});

	it("respects a project-config threshold — lower threshold flags more", () => {
		const filePath = "/tmp/a.ts";
		const facts = new FactStore();
		facts.setFileFact(filePath, "file.functionSummaries", [
			summaryWithCC(6), // above the configured threshold of 5
		]);

		const ctx = makeCtx(filePath, facts, ccThresholdConfig(5));
		const diagnostics = highComplexityRule.evaluate(ctx, facts);
		expect(diagnostics).toHaveLength(1);
	});

	it("respects a project-config threshold — higher threshold flags less", () => {
		const filePath = "/tmp/a.ts";
		const facts = new FactStore();
		facts.setFileFact(filePath, "file.functionSummaries", [
			summaryWithCC(20), // below the configured threshold of 50
		]);

		const ctx = makeCtx(filePath, facts, ccThresholdConfig(50));
		const diagnostics = highComplexityRule.evaluate(ctx, facts);
		expect(diagnostics).toHaveLength(0);
	});

	it("flags nesting depth at the default depth threshold (6) independently of CC", () => {
		const filePath = "/tmp/a.ts";
		const facts = new FactStore();
		facts.setFileFact(filePath, "file.functionSummaries", [
			summaryWithCC(1, 6), // CC=1, depth=6 → depth flag
		]);

		const ctx = makeCtx(filePath, facts, ccThresholdConfig(100));
		const diagnostics = highComplexityRule.evaluate(ctx, facts);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].message).toMatch(/nesting depth 6/);
	});

	it("does NOT flag nesting depth below the default depth threshold", () => {
		const filePath = "/tmp/a.ts";
		const facts = new FactStore();
		facts.setFileFact(filePath, "file.functionSummaries", [
			summaryWithCC(1, 5),
		]);

		const ctx = makeCtx(filePath, facts, ccThresholdConfig(100));
		const diagnostics = highComplexityRule.evaluate(ctx, facts);
		expect(diagnostics).toHaveLength(0);
	});
});
