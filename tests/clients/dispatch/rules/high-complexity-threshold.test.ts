import { describe, expect, it, beforeEach } from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import {
	highComplexityRule,
	resetHighComplexityThresholds,
	setHighComplexityThresholds,
} from "../../../../clients/dispatch/rules/high-complexity.js";
import type { FunctionSummary } from "../../../../clients/dispatch/facts/function-facts.js";
import type { DispatchContext } from "../../../../clients/dispatch/types.js";
import type { FileKind } from "../../../../clients/file-kinds.js";

function makeCtx(filePath: string, facts: FactStore): DispatchContext {
	return {
		filePath,
		cwd: "/tmp",
		kind: "jsts" as FileKind,
		fileRole: "source",
		pi: { getFlag: () => undefined },
		autofix: false,
		deltaMode: false,
		facts,
		hasTool: async () => false,
		log: () => {},
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
	beforeEach(() => {
		resetHighComplexityThresholds();
	});

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

	it("respects setHighComplexityThresholds — lower threshold flags more", () => {
		setHighComplexityThresholds(5, 6);

		const filePath = "/tmp/a.ts";
		const facts = new FactStore();
		facts.setFileFact(filePath, "file.functionSummaries", [
			summaryWithCC(6), // above the new threshold of 5
		]);

		const ctx = makeCtx(filePath, facts);
		const diagnostics = highComplexityRule.evaluate(ctx, facts);
		expect(diagnostics).toHaveLength(1);
	});

	it("respects setHighComplexityThresholds — higher threshold flags less", () => {
		setHighComplexityThresholds(50, 6);

		const filePath = "/tmp/a.ts";
		const facts = new FactStore();
		facts.setFileFact(filePath, "file.functionSummaries", [
			summaryWithCC(20), // below the new threshold of 50
		]);

		const ctx = makeCtx(filePath, facts);
		const diagnostics = highComplexityRule.evaluate(ctx, facts);
		expect(diagnostics).toHaveLength(0);
	});

	it("depth threshold override fires independently of CC threshold", () => {
		setHighComplexityThresholds(100, 3); // CC effectively disabled, depth at 3

		const filePath = "/tmp/a.ts";
		const facts = new FactStore();
		facts.setFileFact(filePath, "file.functionSummaries", [
			summaryWithCC(1, 4), // CC=1, depth=4 → depth flag
		]);

		const ctx = makeCtx(filePath, facts);
		const diagnostics = highComplexityRule.evaluate(ctx, facts);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].message).toMatch(/nesting depth 4/);
	});

	it("ignores invalid threshold inputs", () => {
		setHighComplexityThresholds(5, 3);
		setHighComplexityThresholds(Number.NaN, Number.POSITIVE_INFINITY);
		setHighComplexityThresholds(0, -1);

		const filePath = "/tmp/a.ts";
		const facts = new FactStore();
		facts.setFileFact(filePath, "file.functionSummaries", [
			summaryWithCC(6, 4),
		]);

		const ctx = makeCtx(filePath, facts);
		const diagnostics = highComplexityRule.evaluate(ctx, facts);
		expect(diagnostics).toHaveLength(1);
	});

	it("resetHighComplexityThresholds restores defaults", () => {
		setHighComplexityThresholds(5, 3);
		resetHighComplexityThresholds();

		const filePath = "/tmp/a.ts";
		const facts = new FactStore();
		// CC=10 is below default (15) → should NOT flag after reset
		facts.setFileFact(filePath, "file.functionSummaries", [summaryWithCC(10)]);

		const ctx = makeCtx(filePath, facts);
		const diagnostics = highComplexityRule.evaluate(ctx, facts);
		expect(diagnostics).toHaveLength(0);
	});
});
