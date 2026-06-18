import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	applyProjectLensConfig,
	resetDispatchBaselines,
} from "../../../clients/dispatch/integration.js";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import { highComplexityRule } from "../../../clients/dispatch/rules/high-complexity.js";
import { highFanOutRule } from "../../../clients/dispatch/rules/high-fan-out.js";
import { resetHighComplexityThresholds } from "../../../clients/dispatch/rules/high-complexity.js";
import { resetHighFanOutThreshold } from "../../../clients/dispatch/rules/high-fan-out.js";
import { resetProjectLensConfigCache } from "../../../clients/project-lens-config.js";
import type { DispatchContext } from "../../../clients/dispatch/types.js";
import type { FileKind } from "../../../clients/file-kinds.js";
import type { FunctionSummary } from "../../../clients/dispatch/facts/function-facts.js";

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

function summaryWithCC(cc: number): FunctionSummary {
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
		maxNestingDepth: 1,
		outgoingCalls: [],
	};
}

function summaryWithCallees(n: number): FunctionSummary {
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
		outgoingCalls: Array.from({ length: n }, (_, i) => `fn${i}`),
	};
}

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-apply-cfg-"));
	resetHighComplexityThresholds();
	resetHighFanOutThreshold();
	resetProjectLensConfigCache();
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
	resetHighComplexityThresholds();
	resetHighFanOutThreshold();
	resetProjectLensConfigCache();
});

describe("applyProjectLensConfig", () => {
	it("is a no-op when no .pi-lens.json exists", () => {
		// Reset to known baseline (defaults), then apply with no config present.
		// Expectation: thresholds stay at defaults (15 / 20).
		applyProjectLensConfig(tmpDir);

		const filePath = "/tmp/a.ts";
		const facts = new FactStore();
		// CC=15 — exactly at default → should flag
		facts.setFileFact(filePath, "file.functionSummaries", [summaryWithCC(15)]);
		const ctx = makeCtx(filePath, facts);
		expect(highComplexityRule.evaluate(ctx, facts)).toHaveLength(1);
	});

	it("applies high-complexity threshold from .pi-lens.json", () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				rules: { "high-complexity": { threshold: 5 } },
			}),
		);

		applyProjectLensConfig(tmpDir);

		const filePath = "/tmp/a.ts";
		const facts = new FactStore();
		// CC=6 — above new threshold (5), below default (15) → should flag
		facts.setFileFact(filePath, "file.functionSummaries", [summaryWithCC(6)]);
		const ctx = makeCtx(filePath, facts);
		expect(highComplexityRule.evaluate(ctx, facts)).toHaveLength(1);
	});

	it("applies high-fan-out threshold from .pi-lens.json", () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				rules: { "high-fan-out": { threshold: 5 } },
			}),
		);

		applyProjectLensConfig(tmpDir);

		const filePath = "/tmp/a.ts";
		const facts = new FactStore();
		// 6 callees — above new threshold (5), below default (20) → should flag
		facts.setFileFact(filePath, "file.functionSummaries", [
			summaryWithCallees(6),
		]);
		const ctx = makeCtx(filePath, facts);
		expect(highFanOutRule.evaluate(ctx, facts)).toHaveLength(1);
	});

	it("applies both thresholds from a single .pi-lens.json", () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				rules: {
					"high-complexity": { threshold: 5 },
					"high-fan-out": { threshold: 5 },
				},
			}),
		);

		applyProjectLensConfig(tmpDir);

		const filePath = "/tmp/a.ts";
		const facts = new FactStore();
		facts.setFileFact(filePath, "file.functionSummaries", [
			summaryWithCC(6),
			summaryWithCallees(6),
		]);
		const ctx = makeCtx(filePath, facts);
		expect(highComplexityRule.evaluate(ctx, facts)).toHaveLength(1);
		expect(highFanOutRule.evaluate(ctx, facts)).toHaveLength(1);
	});

	it("ignores unknown rule ids in the config without breaking known ones", () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				rules: {
					"high-complexity": { threshold: 5 },
					"high-fan-out": { threshold: 5 },
					"future-rule": { threshold: 99 },
				},
			}),
		);

		// Should not throw.
		expect(() => applyProjectLensConfig(tmpDir)).not.toThrow();

		const filePath = "/tmp/a.ts";
		const facts = new FactStore();
		facts.setFileFact(filePath, "file.functionSummaries", [summaryWithCC(6)]);
		const ctx = makeCtx(filePath, facts);
		expect(highComplexityRule.evaluate(ctx, facts)).toHaveLength(1);
	});

	it("resets absent thresholds to defaults when a config key is removed", async () => {
		const configPath = path.join(tmpDir, ".pi-lens.json");
		fs.writeFileSync(
			configPath,
			JSON.stringify({
				rules: { "high-complexity": { threshold: 5 } },
			}),
		);

		applyProjectLensConfig(tmpDir);
		let filePath = "/tmp/a.ts";
		let facts = new FactStore();
		facts.setFileFact(filePath, "file.functionSummaries", [summaryWithCC(10)]);
		let ctx = makeCtx(filePath, facts);
		expect(highComplexityRule.evaluate(ctx, facts)).toHaveLength(1);

		await new Promise((r) => setTimeout(r, 20));
		fs.writeFileSync(configPath, JSON.stringify({ rules: {} }));
		applyProjectLensConfig(tmpDir);

		filePath = "/tmp/b.ts";
		facts = new FactStore();
		// CC=10 — below default (15) → should NOT flag after config removal.
		facts.setFileFact(filePath, "file.functionSummaries", [summaryWithCC(10)]);
		ctx = makeCtx(filePath, facts);
		expect(highComplexityRule.evaluate(ctx, facts)).toHaveLength(0);
	});

	it("does not leak thresholds into a project without config", () => {
		const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-no-cfg-"));
		try {
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({
					rules: { "high-fan-out": { threshold: 5 } },
				}),
			);

			applyProjectLensConfig(tmpDir);
			applyProjectLensConfig(otherDir);

			const filePath = "/tmp/a.ts";
			const facts = new FactStore();
			// 6 callees is above the configured 5 but below the default 20.
			facts.setFileFact(filePath, "file.functionSummaries", [
				summaryWithCallees(6),
			]);
			const ctx = makeCtx(filePath, facts);
			expect(highFanOutRule.evaluate(ctx, facts)).toHaveLength(0);
		} finally {
			fs.rmSync(otherDir, { recursive: true, force: true });
		}
	});

	it("resetDispatchBaselines applies project config through the production entry point", () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				rules: { "high-complexity": { threshold: 5 } },
			}),
		);

		resetDispatchBaselines(tmpDir);

		const filePath = "/tmp/a.ts";
		const facts = new FactStore();
		facts.setFileFact(filePath, "file.functionSummaries", [summaryWithCC(6)]);
		const ctx = makeCtx(filePath, facts);
		expect(highComplexityRule.evaluate(ctx, facts)).toHaveLength(1);
	});

	it("ignore-only config leaves rule thresholds at defaults", () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({ ignore: ["fixtures/**"] }),
		);

		applyProjectLensConfig(tmpDir);

		const filePath = "/tmp/a.ts";
		const facts = new FactStore();
		facts.setFileFact(filePath, "file.functionSummaries", [summaryWithCC(10)]);
		const ctx = makeCtx(filePath, facts);
		expect(highComplexityRule.evaluate(ctx, facts)).toHaveLength(0);
	});

	it("resetHighComplexityThresholds restores defaults after applyProjectLensConfig", () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				rules: { "high-complexity": { threshold: 5 } },
			}),
		);

		applyProjectLensConfig(tmpDir);
		resetHighComplexityThresholds();

		const filePath = "/tmp/a.ts";
		const facts = new FactStore();
		// CC=10 — below default (15) → should NOT flag after reset
		facts.setFileFact(filePath, "file.functionSummaries", [summaryWithCC(10)]);
		const ctx = makeCtx(filePath, facts);
		expect(highComplexityRule.evaluate(ctx, facts)).toHaveLength(0);
	});
});
