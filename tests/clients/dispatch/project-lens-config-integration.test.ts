import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDispatchContext } from "../../../clients/dispatch/dispatcher.js";
import { applyProjectLensConfig } from "../../../clients/dispatch/integration.js";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import { highComplexityRule } from "../../../clients/dispatch/rules/high-complexity.js";
import { highFanOutRule } from "../../../clients/dispatch/rules/high-fan-out.js";
import {
	resetProjectLensConfigCache,
	type PiLensProjectConfig,
} from "../../../clients/project-lens-config.js";
import type { DispatchContext } from "../../../clients/dispatch/types.js";
import type { FileKind } from "../../../clients/file-kinds.js";
import type { FunctionSummary } from "../../../clients/dispatch/facts/function-facts.js";
import { removeTempDirSync } from "../test-utils.js";

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
	resetProjectLensConfigCache();
});

afterEach(() => {
	removeTempDirSync(tmpDir);
	resetProjectLensConfigCache();
});

describe("applyProjectLensConfig", () => {
	it("is a no-op when no .pi-lens.json exists", () => {
		// Reset to known baseline (defaults), then apply with no config present.
		// Expectation: thresholds stay at defaults (15 / 20).
		const config = applyProjectLensConfig(tmpDir);

		const filePath = "/tmp/a.ts";
		const facts = new FactStore();
		// CC=15 — exactly at default → should flag
		facts.setFileFact(filePath, "file.functionSummaries", [summaryWithCC(15)]);
		const ctx = makeCtx(filePath, facts, config);
		expect(highComplexityRule.evaluate(ctx, facts)).toHaveLength(1);
	});

	it("applies high-complexity threshold from .pi-lens.json", () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				rules: { "high-complexity": { threshold: 5 } },
			}),
		);

		const config = applyProjectLensConfig(tmpDir);

		const filePath = "/tmp/a.ts";
		const facts = new FactStore();
		// CC=6 — above new threshold (5), below default (15) → should flag
		facts.setFileFact(filePath, "file.functionSummaries", [summaryWithCC(6)]);
		const ctx = makeCtx(filePath, facts, config);
		expect(highComplexityRule.evaluate(ctx, facts)).toHaveLength(1);
	});

	it("applies high-fan-out threshold from .pi-lens.json", () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				rules: { "high-fan-out": { threshold: 5 } },
			}),
		);

		const config = applyProjectLensConfig(tmpDir);

		const filePath = "/tmp/a.ts";
		const facts = new FactStore();
		// 6 callees — above new threshold (5), below default (20) → should flag
		facts.setFileFact(filePath, "file.functionSummaries", [
			summaryWithCallees(6),
		]);
		const ctx = makeCtx(filePath, facts, config);
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

		const config = applyProjectLensConfig(tmpDir);

		const filePath = "/tmp/a.ts";
		const facts = new FactStore();
		facts.setFileFact(filePath, "file.functionSummaries", [
			summaryWithCC(6),
			summaryWithCallees(6),
		]);
		const ctx = makeCtx(filePath, facts, config);
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

		let config: PiLensProjectConfig | undefined;
		expect(() => {
			config = applyProjectLensConfig(tmpDir);
		}).not.toThrow();

		const filePath = "/tmp/a.ts";
		const facts = new FactStore();
		facts.setFileFact(filePath, "file.functionSummaries", [summaryWithCC(6)]);
		const ctx = makeCtx(filePath, facts, config);
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

		let config = applyProjectLensConfig(tmpDir);
		let filePath = "/tmp/a.ts";
		let facts = new FactStore();
		facts.setFileFact(filePath, "file.functionSummaries", [summaryWithCC(10)]);
		let ctx = makeCtx(filePath, facts, config);
		expect(highComplexityRule.evaluate(ctx, facts)).toHaveLength(1);

		await new Promise((r) => setTimeout(r, 20));
		fs.writeFileSync(configPath, JSON.stringify({ rules: {} }));
		config = applyProjectLensConfig(tmpDir);

		filePath = "/tmp/b.ts";
		facts = new FactStore();
		// CC=10 — below default (15) → should NOT flag after config removal.
		facts.setFileFact(filePath, "file.functionSummaries", [summaryWithCC(10)]);
		ctx = makeCtx(filePath, facts, config);
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
			const otherConfig = applyProjectLensConfig(otherDir);

			const filePath = "/tmp/a.ts";
			const facts = new FactStore();
			// 6 callees is above the configured 5 but below the default 20.
			facts.setFileFact(filePath, "file.functionSummaries", [
				summaryWithCallees(6),
			]);
			const ctx = makeCtx(filePath, facts, otherConfig);
			expect(highFanOutRule.evaluate(ctx, facts)).toHaveLength(0);
		} finally {
			removeTempDirSync(otherDir);
		}
	});

	it("createDispatchContext carries project config through the production entry point", () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				rules: { "high-complexity": { threshold: 5 } },
			}),
		);

		const filePath = path.join(tmpDir, "a.ts");
		const facts = new FactStore();
		facts.setFileFact(filePath, "file.functionSummaries", [summaryWithCC(6)]);
		const ctx = createDispatchContext(
			filePath,
			tmpDir,
			{ getFlag: () => undefined },
			facts,
			false,
		);
		expect(highComplexityRule.evaluate(ctx, facts)).toHaveLength(1);
	});

	it("a session rooted at a link resolves a nested package's root and reads its config (#4689)", (ctx) => {
		// RECURRENCE GUARDED: review r1 F3. The language-root walk ran from the
		// file's path identity while the workspace stayed the session's link
		// spelling, so `path.relative` read every nested package as outside
		// the workspace: `ctx.cwd` collapsed to the workspace and the package's
		// own `.pi-lens.json` (and each runner's spawn root) was never used.
		const real = path.join(tmpDir, "mono");
		const alias = path.join(tmpDir, "mono-alias");
		const app = path.join(real, "packages", "app");
		fs.mkdirSync(path.join(app, "src"), { recursive: true });
		fs.writeFileSync(path.join(real, "package.json"), '{"name":"mono"}');
		fs.writeFileSync(path.join(app, "package.json"), '{"name":"app"}');
		fs.writeFileSync(
			path.join(app, ".pi-lens.json"),
			JSON.stringify({ rules: { "high-complexity": { threshold: 5 } } }),
		);
		try {
			fs.symlinkSync("mono", alias, "dir");
		} catch (error) {
			return ctx.skip(`symlinks unavailable: ${String(error)}`);
		}

		const facts = new FactStore();
		const dispatch = createDispatchContext(
			"packages/app/src/a.ts",
			alias,
			{ getFlag: () => undefined },
			facts,
			false,
		);
		expect(dispatch.cwd).toBe(fs.realpathSync.native(app).replace(/\\/g, "/"));
		facts.setFileFact(dispatch.filePath, "file.functionSummaries", [
			summaryWithCC(6),
		]);
		expect(highComplexityRule.evaluate(dispatch, facts)).toHaveLength(1);
	});

	it("ignore-only config leaves rule thresholds at defaults", () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({ ignore: ["fixtures/**"] }),
		);

		const config = applyProjectLensConfig(tmpDir);

		const filePath = "/tmp/a.ts";
		const facts = new FactStore();
		facts.setFileFact(filePath, "file.functionSummaries", [summaryWithCC(10)]);
		const ctx = makeCtx(filePath, facts, config);
		expect(highComplexityRule.evaluate(ctx, facts)).toHaveLength(0);
	});
});
