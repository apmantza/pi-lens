import { describe, expect, it, beforeEach } from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import { functionFactProvider } from "../../../../clients/dispatch/facts/function-facts.js";
import {
	highFanOutRule,
	resetHighFanOutThreshold,
} from "../../../../clients/dispatch/rules/high-fan-out.js";
import {
	highComplexityRule,
	resetHighComplexityThresholds,
} from "../../../../clients/dispatch/rules/high-complexity.js";
import {
	isTestFrameworkNoiseCall,
	isTestSuiteOrganizer,
} from "../../../../clients/dispatch/rules/framework-call-noise.js";
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

async function evaluateBoth(filePath: string, content: string) {
	const facts = new FactStore();
	const ctx = makeCtx(filePath, facts);
	facts.setFileFact(filePath, "file.content", content);
	await functionFactProvider.run(ctx, facts);
	return {
		fanOut: highFanOutRule.evaluate(ctx, facts),
		complexity: highComplexityRule.evaluate(ctx, facts),
	};
}

describe("high-fan-out / high-complexity — test-framework-call awareness (#577)", () => {
	beforeEach(() => {
		resetHighFanOutThreshold();
		resetHighComplexityThresholds();
	});

	it("does not flag a describe() block wrapping many assertion-heavy it()s (real shape from tests/clients/widget-state.test.ts)", async () => {
		const filePath = "/tmp/widget-state-like.test.ts";
		const content = `
describe("widget-state renderWidget", () => {
	it("keeps diagnostic rows within the provided TUI width", () => {
		const filePath = \`\${process.cwd()}/index.ts\`;
		recordRunner(filePath, "type-safety", "failed", 2);
		recordRunner(filePath, "eslint", "succeeded", 27);
		recordRunner(filePath, "ast-grep-napi", "succeeded", 1);
		recordDiagnostics(filePath, []);
		const lines = renderWidget(120, theme);
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(120);
		}
	});

	it("truncates every widget line, including headers and LSP status", () => {
		setSessionLanguages(["typescript", "javascript", "python", "rust"]);
		recordLsp("typescript-language-server", process.cwd(), "spawn_start");
		const lines = renderWidget(40, theme);
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(40);
		}
	});

	it("filters, joins, and matches file rows", () => {
		const lines = renderWidget(120, theme);
		const fileRows = lines.filter((l) => l.includes("cors.ts"));
		expect(fileRows.length).toBeGreaterThanOrEqual(1);
		expect(fileRows.length).toBeLessThanOrEqual(3);
		const allLines = lines.join("\\n");
		expect(allLines).toContain("cors.ts");
		expect(allLines).not.toContain("nope.ts");
		const fileRow = lines.find((l) => l.includes("cors.ts"));
		expect(fileRow).toMatch(/cors\\.ts/);
		expect(fileRow).not.toMatch(/nope/);
	});

	it("orders alphabetically and preserves distinct frames", () => {
		const idxAlpha = 0;
		const idxBeta = 1;
		const idxGamma = 2;
		expect(idxAlpha).toBeGreaterThan(-1);
		expect(idxBeta).toBeGreaterThan(idxAlpha);
		expect(idxGamma).toBeGreaterThan(idxBeta);
		const frames: string[] = [];
		frames.push("a");
		frames.push("b");
		const nonEmptyFrames = frames.filter((f) => f.trim().length > 0);
		expect(nonEmptyFrames.at(-1)).toBeDefined();
		expect(new Set(nonEmptyFrames).size).toBeLessThanOrEqual(nonEmptyFrames.length);
	});
});
`;

		const { fanOut, complexity } = await evaluateBoth(filePath, content);
		expect(fanOut).toHaveLength(0);
		expect(complexity).toHaveLength(0);
	});

	it("does not flag a single assertion-and-mock-heavy it() body", async () => {
		const filePath = "/tmp/single-it.test.ts";
		const content = `
describe("ruff runner", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawn.mockReset();
		ensureTool.mockReset();
	});

	it("dispatches ruff with the expected args and parses results", async () => {
		const execRaw = vi.fn(async (args: string[]) => ({ stdout: "[]", stderr: "", status: 0, args }));
		const result = await runRuff(ctx);
		expect(result.ok).toBe(true);
		expect(result.diagnostics).toHaveLength(0);
		expect(execRaw).toHaveBeenCalledWith(expect.arrayContaining(["check"]));
		expect(ensureTool).toHaveBeenCalledWith("ruff");
		expect(safeSpawn).not.toHaveBeenCalled();
	});
});
`;

		const { fanOut, complexity } = await evaluateBoth(filePath, content);
		expect(fanOut).toHaveLength(0);
		expect(complexity).toHaveLength(0);
	});

	it("STILL flags a genuinely tangled test HELPER function that does not itself call it/describe/test", async () => {
		const filePath = "/tmp/tangled-helper.test.ts";
		// A shared test helper with real branching complexity — this is exactly the
		// signal #577 says must be preserved: it does not call it/describe/test, so
		// it is not a "suite organizer" and must still be evaluated normally.
		const content = `
function buildComplexFixture(mode: string, flags: string[], depth: number) {
	let result = 0;
	if (mode === "a" && depth > 0) {
		result += 1;
	} else if (mode === "b" || depth < 0) {
		result += 2;
	} else if (mode === "c") {
		result += 3;
	}
	switch (mode) {
		case "x":
			result += 100;
			break;
		case "y":
			result += 200;
			break;
		case "z":
			result += 300;
			break;
		case "w":
			result += 400;
			break;
	}
	for (const flag of flags) {
		if (flag === "x") {
			result += 10;
		} else if (flag === "y" && flag.length > 1) {
			result += 20;
		}
	}
	while (depth > 0) {
		if (depth % 2 === 0) {
			result += 1;
		} else {
			try {
				result += riskyStep(depth);
			} catch (err) {
				result -= 1;
			}
		}
		depth--;
	}
	return result;
}

describe("uses the tangled fixture builder", () => {
	it("builds a fixture", () => {
		expect(buildComplexFixture("a", ["x"], 3)).toBeGreaterThan(0);
	});
});
`;

		const { complexity } = await evaluateBoth(filePath, content);
		expect(complexity.length).toBeGreaterThan(0);
		expect(complexity.some((d) => d.message.includes("buildComplexFixture"))).toBe(
			true,
		);
	});

	it("does not affect production (non-test) files — high-fan-out still flags real coordination smell", async () => {
		const filePath = "/tmp/orchestrator.ts";
		const callNames = Array.from({ length: 21 }, (_, i) => `service${i}.call`);
		const content = `
function orchestrate() {
	${callNames.map((c) => `${c}();`).join("\n\t")}
}
`;

		const { fanOut } = await evaluateBoth(filePath, content);
		expect(fanOut).toHaveLength(1);
		expect(fanOut[0].message).toContain("orchestrate");
	});

	it("does not affect production (non-test) files — high-complexity still flags real complexity", async () => {
		const filePath = "/tmp/complex-prod.ts";
		const content = `
function classify(a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number) {
	if (a > 0) { return 1; }
	if (b > 0) { return 2; }
	if (c > 0) { return 3; }
	if (d > 0) { return 4; }
	if (e > 0) { return 5; }
	if (f > 0) { return 6; }
	if (g > 0) { return 7; }
	if (h > 0) { return 8; }
	if (i > 0) { return 9; }
	if (j > 0) { return 10; }
	if (k > 0) { return 11; }
	if (l > 0) { return 12; }
	if (m > 0) { return 13; }
	if (n > 0) { return 14; }
	return 0;
}
`;

		const { complexity } = await evaluateBoth(filePath, content);
		expect(complexity).toHaveLength(1);
		expect(complexity[0].message).toContain("classify");
	});
});

describe("isTestFrameworkNoiseCall", () => {
	it("recognizes expect(...) assertion chains regardless of argument text", () => {
		expect(isTestFrameworkNoiseCall("expect(foo.bar).toBe")).toBe(true);
		expect(isTestFrameworkNoiseCall("expect(a).not.toContain")).toBe(true);
		expect(isTestFrameworkNoiseCall("expect")).toBe(true);
	});

	it("recognizes test lifecycle calls and .only/.skip/.each variants", () => {
		expect(isTestFrameworkNoiseCall("it")).toBe(true);
		expect(isTestFrameworkNoiseCall("test")).toBe(true);
		expect(isTestFrameworkNoiseCall("describe")).toBe(true);
		expect(isTestFrameworkNoiseCall("beforeEach")).toBe(true);
		expect(isTestFrameworkNoiseCall("afterEach")).toBe(true);
		expect(isTestFrameworkNoiseCall("beforeAll")).toBe(true);
		expect(isTestFrameworkNoiseCall("afterAll")).toBe(true);
		expect(isTestFrameworkNoiseCall("it.only")).toBe(true);
		expect(isTestFrameworkNoiseCall("describe.each")).toBe(true);
	});

	it("recognizes mock-library call prefixes", () => {
		expect(isTestFrameworkNoiseCall("vi.fn")).toBe(true);
		expect(isTestFrameworkNoiseCall("vi.spyOn(obj, \"m\").mockReturnValue")).toBe(
			true,
		);
		expect(isTestFrameworkNoiseCall("jest.mock")).toBe(true);
	});

	it("does not flag unrelated production calls", () => {
		expect(isTestFrameworkNoiseCall("service.call")).toBe(false);
		expect(isTestFrameworkNoiseCall("orchestrate")).toBe(false);
	});
});

describe("isTestSuiteOrganizer", () => {
	it("detects a function that directly calls describe/it/test", () => {
		expect(isTestSuiteOrganizer(["describe", "recordRunner"])).toBe(true);
		expect(isTestSuiteOrganizer(["it", "expect"])).toBe(true);
		expect(isTestSuiteOrganizer(["test.each([1, 2])"])).toBe(true);
	});

	it("does not flag helper functions with no it/describe/test calls", () => {
		expect(isTestSuiteOrganizer(["riskyStep", "buildComplexFixture"])).toBe(false);
		expect(isTestSuiteOrganizer([])).toBe(false);
	});
});
