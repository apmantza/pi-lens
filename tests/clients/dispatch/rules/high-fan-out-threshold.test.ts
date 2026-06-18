import { describe, expect, it, beforeEach } from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import {
	highFanOutRule,
	resetHighFanOutThreshold,
	setHighFanOutThreshold,
} from "../../../../clients/dispatch/rules/high-fan-out.js";
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
	beforeEach(() => {
		resetHighFanOutThreshold();
	});

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

	it("respects setHighFanOutThreshold — lower threshold flags more", () => {
		setHighFanOutThreshold(5);

		const filePath = "/tmp/a.ts";
		const facts = new FactStore();
		const callees = Array.from({ length: 6 }, (_, i) => `fn${i}`);
		facts.setFileFact(filePath, "file.functionSummaries", [
			summaryWithCallees(callees),
		]);

		const ctx = makeCtx(filePath, facts);
		const diagnostics = highFanOutRule.evaluate(ctx, facts);
		expect(diagnostics).toHaveLength(1);
	});

	it("respects setHighFanOutThreshold — higher threshold flags less", () => {
		setHighFanOutThreshold(50);

		const filePath = "/tmp/a.ts";
		const facts = new FactStore();
		const callees = Array.from({ length: 25 }, (_, i) => `fn${i}`);
		facts.setFileFact(filePath, "file.functionSummaries", [
			summaryWithCallees(callees),
		]);

		const ctx = makeCtx(filePath, facts);
		const diagnostics = highFanOutRule.evaluate(ctx, facts);
		expect(diagnostics).toHaveLength(0);
	});

	it("noise filters in the rule body still apply after threshold override", () => {
		// Even with threshold=2, console.* / resolve / etc. are filtered before
		// the count check, so a body full of console.log still doesn't flag.
		setHighFanOutThreshold(2);

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

		const ctx = makeCtx(filePath, facts);
		const diagnostics = highFanOutRule.evaluate(ctx, facts);
		expect(diagnostics).toHaveLength(0);
	});

	it("ignores invalid threshold inputs", () => {
		setHighFanOutThreshold(5);
		setHighFanOutThreshold(Number.NaN);
		setHighFanOutThreshold(Number.POSITIVE_INFINITY);
		setHighFanOutThreshold(0);
		setHighFanOutThreshold(-1);

		const filePath = "/tmp/a.ts";
		const facts = new FactStore();
		const callees = Array.from({ length: 6 }, (_, i) => `fn${i}`);
		facts.setFileFact(filePath, "file.functionSummaries", [
			summaryWithCallees(callees),
		]);

		const ctx = makeCtx(filePath, facts);
		const diagnostics = highFanOutRule.evaluate(ctx, facts);
		expect(diagnostics).toHaveLength(1);
	});

	it("resetHighFanOutThreshold restores the default", () => {
		setHighFanOutThreshold(3);
		resetHighFanOutThreshold();

		const filePath = "/tmp/a.ts";
		const facts = new FactStore();
		// 10 callees — below default (20) → should NOT flag after reset
		const callees = Array.from({ length: 10 }, (_, i) => `fn${i}`);
		facts.setFileFact(filePath, "file.functionSummaries", [
			summaryWithCallees(callees),
		]);

		const ctx = makeCtx(filePath, facts);
		const diagnostics = highFanOutRule.evaluate(ctx, facts);
		expect(diagnostics).toHaveLength(0);
	});
});
