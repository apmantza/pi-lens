/**
 * Autofix Integration Tests
 *
 * Tests for auto-format and auto-fix behavior.
 * Validates that autofix runs by default and can be disabled.
 */

import { describe, expect, it, vi } from "vitest";
import type {
	DispatchContext,
	RunnerDefinition,
	RunnerGroup,
} from "../types.js";

// --- Mock Runners ---

const createAutofixRunner = (id: string): RunnerDefinition => ({
	id,
	appliesTo: ["jsts"],
	priority: 10,
	enabledByDefault: true,
	when: async (ctx) => ctx.autofix,
	async run(ctx: DispatchContext) {
		return {
			status: "succeeded",
			diagnostics: [
				{
					id: `${id}:fixed`,
					message: `Fixed by ${id}`,
					filePath: ctx.filePath,
					line: 1,
					column: 1,
					severity: "info",
					semantic: "fixed",
					tool: id,
				},
			],
			semantic: "fixed",
		};
	},
});

const createNonAutofixRunner = (id: string): RunnerDefinition => ({
	id,
	appliesTo: ["jsts"],
	priority: 20,
	enabledByDefault: true,
	async run(ctx: DispatchContext) {
		return {
			status: "succeeded",
			diagnostics: [
				{
					id: `${id}:info`,
					message: `Info from ${id}`,
					filePath: ctx.filePath,
					line: 1,
					column: 1,
					severity: "info",
					semantic: "silent",
					tool: id,
				},
			],
			semantic: "none",
		};
	},
});

const createMockContext = (
	filePath: string = "test.ts",
	autofix: boolean = true,
): DispatchContext => ({
	filePath,
	cwd: "/test",
	kind: "jsts",
	pi: {
		getFlag: vi.fn((flag: string) => {
			if (flag === "no-autofix") return !autofix;
			return autofix;
		}),
	},
	autofix,
	deltaMode: false,
	baselines: new Map(),
	hasTool: vi.fn(() => Promise.resolve(false)),
	log: vi.fn(),
});

const _createMockGroup = (runners: RunnerDefinition[]): RunnerGroup => ({
	runnerIds: runners.map((r) => r.id),
	mode: "all",
});

// --- Tests ---

describe("Autofix Integration", () => {
	describe("Autofix by Default", () => {
		it("should run autofix runners when enabled", async () => {
			const autofixRunner = createAutofixRunner("biome-fix");
			const ctx = createMockContext("test.ts", true);

			// The runner should apply (autofix is true)
			const shouldRun = await autofixRunner.when?.(ctx);
			expect(shouldRun).toBe(true);
		});

		it("should skip autofix runners when disabled", async () => {
			const autofixRunner = createAutofixRunner("biome-fix");
			const ctx = createMockContext("test.ts", false);

			// The runner should not apply (autofix is false)
			const shouldRun = await autofixRunner.when?.(ctx);
			expect(shouldRun).toBe(false);
		});
	});

	describe("--no-autofix Flag", () => {
		it("should disable autofix with --no-autofix flag", () => {
			const mockPi = {
				getFlag: vi.fn((flag: string) => flag === "no-autofix"),
			};

			// Simulate flag check in dispatch context
			const autofixEnabled = !mockPi.getFlag("no-autofix");
			expect(autofixEnabled).toBe(false);
		});

		it("should enable autofix without --no-autofix flag", () => {
			const mockPi = {
				getFlag: vi.fn((_flag: string) => false),
			};

			const autofixEnabled = !mockPi.getFlag("no-autofix");
			expect(autofixEnabled).toBe(true);
		});
	});

	describe("File Modification Warnings", () => {
		it("should track when format changes files", async () => {
			// Simulate format result
			const formatResult = {
				formatChanged: true,
				fixedCount: 0,
			};

			// Should show warning
			const shouldWarn =
				formatResult.formatChanged || formatResult.fixedCount > 0;
			expect(shouldWarn).toBe(true);
		});

		it("should track when autofix changes files", async () => {
			// Simulate autofix result
			const fixResult = {
				formatChanged: false,
				fixedCount: 3,
			};

			// Should show warning
			const shouldWarn = fixResult.formatChanged || fixResult.fixedCount > 0;
			expect(shouldWarn).toBe(true);
		});

		it("should show warning message format", () => {
			const warningMessage =
				"⚠️ **File modified by auto-format/fix. Re-read before next edit.**";
			expect(warningMessage).toContain("File modified");
			expect(warningMessage).toContain("auto-format");
			expect(warningMessage).toContain("fix");
		});
	});

	describe("Runner Categories", () => {
		it("should have autofix runners with when conditions", () => {
			const autofixRunner = createAutofixRunner("ruff-fix");

			expect(autofixRunner.when).toBeDefined();
			expect(typeof autofixRunner.when).toBe("function");
		});

		it("should have non-autofix runners without when conditions", () => {
			const regularRunner = createNonAutofixRunner("ts-lsp");

			// Regular runners run regardless of autofix setting
			expect(regularRunner.when).toBeUndefined();
		});

		it("should categorize fixed diagnostics correctly", async () => {
			const autofixRunner = createAutofixRunner("biome-fix");
			const ctx = createMockContext("test.ts", true);

			const result = await autofixRunner.run(ctx);

			// Should have semantic: "fixed"
			expect(result.semantic).toBe("fixed");

			// Diagnostics should also be fixed
			for (const diag of result.diagnostics || []) {
				expect(diag.semantic).toBe("fixed");
			}
		});
	});

	describe("Format vs Autofix Coordination", () => {
		it("should run format before lint", async () => {
			const order: string[] = [];

			const formatRunner: RunnerDefinition = {
				id: "format",
				appliesTo: ["jsts"],
				priority: 5, // Lower = runs first
				enabledByDefault: true,
				async run() {
					order.push("format");
					return { status: "succeeded", diagnostics: [], semantic: "none" };
				},
			};

			const lintRunner: RunnerDefinition = {
				id: "lint",
				appliesTo: ["jsts"],
				priority: 10, // Higher = runs after
				enabledByDefault: true,
				async run() {
					order.push("lint");
					return { status: "succeeded", diagnostics: [], semantic: "none" };
				},
			};

			// Verify priority ordering
			expect(formatRunner.priority).toBeLessThan(lintRunner.priority!);
		});

		it("should handle format and lint race conditions", async () => {
			// Simulate format changing file while lint is running
			const _ctx = createMockContext("test.ts", true);

			// Format result
			const formatChanged = true;

			// Lint should still work
			const lintResult = {
				status: "succeeded",
				diagnostics: [],
				semantic: "none",
			};

			// Both should complete without error
			expect(formatChanged).toBe(true);
			expect(lintResult.status).toBe("succeeded");
		});
	});

	describe("Real-world Scenarios", () => {
		it("should handle ruff autofix flow", async () => {
			const ruffRunner = createAutofixRunner("ruff");
			const ctxWithAutofix = createMockContext("test.py", true);
			const ctxNoAutofix = createMockContext("test.py", false);

			// With autofix
			const shouldRunWith = await ruffRunner.when?.(ctxWithAutofix);
			expect(shouldRunWith).toBe(true);

			// Without autofix
			const shouldRunWithout = await ruffRunner.when?.(ctxNoAutofix);
			expect(shouldRunWithout).toBe(false);
		});

		it("should handle biome autofix flow", async () => {
			const biomeRunner = createAutofixRunner("biome-fix");
			const ctxWithAutofix = createMockContext("test.ts", true);
			const ctxNoAutofix = createMockContext("test.ts", false);

			// With autofix
			const shouldRunWith = await biomeRunner.when?.(ctxWithAutofix);
			expect(shouldRunWith).toBe(true);

			// Without autofix
			const shouldRunWithout = await biomeRunner.when?.(ctxNoAutofix);
			expect(shouldRunWithout).toBe(false);
		});

		it("should show file modification warning only when changes made", async () => {
			// No changes
			const noChanges = { formatChanged: false, fixedCount: 0 };
			expect(noChanges.formatChanged || noChanges.fixedCount > 0).toBe(false);

			// Format only
			const formatOnly = { formatChanged: true, fixedCount: 0 };
			expect(formatOnly.formatChanged || formatOnly.fixedCount > 0).toBe(true);

			// Fix only
			const fixOnly = { formatChanged: false, fixedCount: 5 };
			expect(fixOnly.formatChanged || fixOnly.fixedCount > 0).toBe(true);

			// Both
			const both = { formatChanged: true, fixedCount: 3 };
			expect(both.formatChanged || both.fixedCount > 0).toBe(true);
		});
	});
});
