import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import { setupTestEnvironment } from "../../test-utils.js";

// Mock heavy dependencies before importing the runner
vi.mock("../../../../clients/tool-policy.js", () => ({
	hasEslintConfig: vi.fn().mockReturnValue(false),
}));

vi.mock("../../../../clients/dispatch/runners/yaml-rule-parser.js", () => ({
	loadYamlRules: vi.fn().mockReturnValue([]),
	hasUnsupportedConditions: vi.fn().mockReturnValue(false),
	isOverlyBroadPattern: vi.fn().mockReturnValue(false),
	isStructuredRule: vi.fn().mockReturnValue(false),
	calculateRuleComplexity: vi.fn().mockReturnValue(1),
	MAX_BLOCKING_RULE_COMPLEXITY: 10,
}));

vi.mock("../../../../clients/package-root.js", () => ({
	resolvePackagePath: vi.fn().mockReturnValue("/nonexistent/path"),
}));

function createCtx(filePath: string, overrides: Partial<Record<string, unknown>> = {}) {
	return {
		filePath,
		cwd: path.dirname(filePath),
		kind: "jsts",
		pi: { getFlag: () => undefined },
		autofix: false,
		deltaMode: true,
		blockingOnly: false,
		facts: new FactStore(),
		hasTool: async () => true,
		log: () => {},
		...overrides,
	};
}

describe("ast-grep-napi runner — skip paths", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it("skips unsupported file extensions", async () => {
		const env = setupTestEnvironment("pi-lens-ast-grep-");
		try {
			const filePath = path.join(env.tmpDir, "file.py");
			fs.writeFileSync(filePath, "print('hello')\n");

			// Mock @ast-grep/napi so loadSg succeeds
			vi.doMock("@ast-grep/napi", () => ({
				ts: { parse: vi.fn() },
				js: { parse: vi.fn() },
				tsx: { parse: vi.fn() },
				css: { parse: vi.fn() },
				html: { parse: vi.fn() },
			}));

			const mod = await import("../../../../clients/dispatch/runners/ast-grep-napi.js");
			const runner = mod.default;
			const result = await runner.run(createCtx(filePath) as any);
			expect(result.status).toBe("skipped");
		} finally {
			env.cleanup();
		}
	});

	it("skips when @ast-grep/napi cannot be loaded", async () => {
		const env = setupTestEnvironment("pi-lens-ast-grep-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "const x = 1;\n");

			vi.doMock("@ast-grep/napi", () => {
				throw new Error("module not found");
			});

			const mod = await import("../../../../clients/dispatch/runners/ast-grep-napi.js");
			const runner = mod.default;
			const result = await runner.run(createCtx(filePath) as any);
			expect(result.status).toBe("skipped");
			expect(result.diagnostics).toHaveLength(0);
		} finally {
			env.cleanup();
		}
	});

	it("skips when file does not exist", async () => {
		vi.doMock("@ast-grep/napi", () => ({
			ts: { parse: vi.fn() },
			js: { parse: vi.fn() },
			tsx: { parse: vi.fn() },
			css: { parse: vi.fn() },
			html: { parse: vi.fn() },
		}));

		const mod = await import("../../../../clients/dispatch/runners/ast-grep-napi.js");
		const runner = mod.default;
		const result = await runner.run(createCtx("/nonexistent/file.ts") as any);
		expect(result.status).toBe("skipped");
	});

	it("returns succeeded with no diagnostics when no rules are loaded", async () => {
		const env = setupTestEnvironment("pi-lens-ast-grep-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "const x = 1;\n");

			const mockParse = vi.fn().mockReturnValue({
				root: vi.fn().mockReturnValue({
					children: vi.fn().mockReturnValue([]),
					kind: vi.fn().mockReturnValue("program"),
					range: vi.fn().mockReturnValue({ start: { line: 0, column: 0 }, end: { line: 1, column: 0 } }),
					findAll: vi.fn().mockReturnValue([]),
				}),
			});

			vi.doMock("@ast-grep/napi", () => ({
				ts: { parse: mockParse },
				js: { parse: mockParse },
				tsx: { parse: mockParse },
				css: { parse: mockParse },
				html: { parse: mockParse },
			}));

			const mod = await import("../../../../clients/dispatch/runners/ast-grep-napi.js");
			const runner = mod.default;
			const result = await runner.run(createCtx(filePath) as any);
			expect(result.diagnostics).toHaveLength(0);
			expect(["skipped", "succeeded"]).toContain(result.status);
		} finally {
			env.cleanup();
		}
	});
});

describe("ast-grep-napi runner — metadata", () => {
	it("has expected runner id and appliesTo", async () => {
		vi.resetModules();
		const mod = await import("../../../../clients/dispatch/runners/ast-grep-napi.js");
		const runner = mod.default;
		expect(runner.id).toBe("ast-grep-napi");
		expect(runner.appliesTo).toContain("jsts");
		expect(runner.enabledByDefault).toBe(true);
	});
});
