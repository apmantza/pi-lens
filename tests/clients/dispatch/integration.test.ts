/**
 * Dispatch Integration Tests
 *
 * Tests dispatchLintWithResult, shouldDispatch, and getAvailableRunners
 * with mocked dispatcher to avoid real tool spawning.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	dispatchLintWithResult,
	getAvailableRunners,
	resetDispatchBaselines,
	shouldDispatch,
} from "../../../clients/dispatch/integration.js";

// Mock dispatcher internals to avoid real runner execution
vi.mock("../../../clients/dispatch/dispatcher.js", async (importOriginal) => {
	const mod =
		await importOriginal<
			typeof import("../../../clients/dispatch/dispatcher.js")
		>();
	return {
		...mod,
		dispatchForFile: vi.fn(),
	};
});

vi.mock("../../../clients/dispatch/fact-runner.js", async (importOriginal) => {
	const mod =
		await importOriginal<
			typeof import("../../../clients/dispatch/fact-runner.js")
		>();
	return {
		...mod,
		runProviders: vi.fn(),
	};
});

import { dispatchForFile } from "../../../clients/dispatch/dispatcher.js";
import { runProviders } from "../../../clients/dispatch/fact-runner.js";

const emptyDispatchResult = {
	diagnostics: [],
	blockers: [],
	warnings: [],
	baselineWarningCount: 0,
	fixed: [],
	resolvedCount: 0,
	output: "",
	hasBlockers: false,
};

describe("Dispatch Integration", () => {
	beforeEach(() => {
		resetDispatchBaselines();
		vi.mocked(dispatchForFile).mockReset();
		vi.mocked(dispatchForFile).mockResolvedValue(emptyDispatchResult);
		vi.mocked(runProviders).mockReset();
	});

	describe("dispatchLintWithResult", () => {
		it("returns empty result for unsupported file kind", async () => {
			const result = await dispatchLintWithResult("data.csv", "/project", {
				getFlag: () => false,
			});

			expect(result.diagnostics).toEqual([]);
			expect(result.hasBlockers).toBe(false);
			expect(result.output).toBe("");
		});

		it("returns empty result when no dispatch groups match", async () => {
			const result = await dispatchLintWithResult("unknown.xyz", "/project", {
				getFlag: () => false,
			});

			expect(result.diagnostics).toEqual([]);
			expect(result.hasBlockers).toBe(false);
			expect(result.output).toBe("");
		});

		it("calls dispatchForFile and returns its result", async () => {
			vi.mocked(dispatchForFile).mockResolvedValue({
				diagnostics: [
					{
						id: "test-1",
						message: "Test error",
						filePath: "app.ts",
						line: 1,
						severity: "error",
						semantic: "blocking",
						tool: "tsc",
					},
				],
				blockers: [
					{
						id: "test-1",
						message: "Test error",
						filePath: "app.ts",
						line: 1,
						severity: "error",
						semantic: "blocking",
						tool: "tsc",
					},
				],
				warnings: [],
				baselineWarningCount: 0,
				fixed: [],
				resolvedCount: 0,
				output: "Test error at line 1",
				hasBlockers: true,
			});

			const result = await dispatchLintWithResult("app.ts", "/project", {
				getFlag: () => false,
			});

			expect(runProviders).toHaveBeenCalled();
			expect(dispatchForFile).toHaveBeenCalled();
			expect(result.hasBlockers).toBe(true);
			expect(result.output).toBe("Test error at line 1");
			expect(result.diagnostics).toHaveLength(1);
		});

		it("returns result with warnings but no blockers", async () => {
			vi.mocked(dispatchForFile).mockResolvedValue({
				diagnostics: [
					{
						id: "warn-1",
						message: "Unused import",
						filePath: "app.ts",
						line: 1,
						severity: "warning",
						semantic: "warning",
						tool: "biome",
					},
				],
				blockers: [],
				warnings: [
					{
						id: "warn-1",
						message: "Unused import",
						filePath: "app.ts",
						line: 1,
						severity: "warning",
						semantic: "warning",
						tool: "biome",
					},
				],
				baselineWarningCount: 0,
				fixed: [],
				resolvedCount: 0,
				output: "1 warning",
				hasBlockers: false,
			});

			const result = await dispatchLintWithResult("app.ts", "/project", {
				getFlag: () => false,
			});

			expect(result.hasBlockers).toBe(false);
			expect(result.warnings).toHaveLength(1);
			expect(result.blockers).toHaveLength(0);
		});
	});

	describe("shouldDispatch", () => {
		it("returns true for TypeScript files", () => {
			expect(shouldDispatch("app.ts")).toBe(true);
			expect(shouldDispatch("app.tsx")).toBe(true);
		});

		it("returns true for Python files", () => {
			expect(shouldDispatch("app.py")).toBe(true);
		});

		it("returns true for Go files", () => {
			expect(shouldDispatch("main.go")).toBe(true);
		});

		it("returns false for unknown extensions", () => {
			expect(shouldDispatch("data.csv")).toBe(false);
			expect(shouldDispatch("image.png")).toBe(false);
			expect(shouldDispatch("unknown.xyz")).toBe(false);
		});
	});

	describe("getAvailableRunners", () => {
		it("returns runners for TypeScript files", async () => {
			const runners = await getAvailableRunners("app.ts");
			expect(runners.length).toBeGreaterThan(0);
			expect(runners).toContain("lsp");
		});

		it("returns runners for Python files", async () => {
			const runners = await getAvailableRunners("app.py");
			expect(runners.length).toBeGreaterThan(0);
			expect(runners).toContain("lsp");
		});

		it("returns empty array for unsupported files", async () => {
			const runners = await getAvailableRunners("data.csv");
			expect(runners).toEqual([]);
		});
	});
});
