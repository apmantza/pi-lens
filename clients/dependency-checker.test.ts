import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DependencyChecker } from "./dependency-checker.js";
import { setupTestEnvironment } from "./test-utils.js";

describe("DependencyChecker", () => {
	let client: DependencyChecker;
	let tmpDir: string;
	let cleanup: () => void;

	beforeEach(() => {
		client = new DependencyChecker();
		({ tmpDir, cleanup } = setupTestEnvironment("pi-lens-dep-test-"));
	});

	afterEach(() => {
		cleanup();
	});

	describe("isAvailable", () => {
		it("should check madge availability", () => {
			const available = client.isAvailable();
			expect(typeof available).toBe("boolean");
		});
	});

	describe("checkFile", () => {
		it("should return no circular deps for non-existent files", () => {
			const result = client.checkFile("/nonexistent/file.ts");
			expect(result.hasCircular).toBe(false);
			expect(result.circular).toEqual([]);
		});

		it("should return correct structure when not available", () => {
			const mockChecker = new DependencyChecker();
			if (mockChecker.isAvailable()) return; // Skip if available

			const result = mockChecker.checkFile("/some/file.ts");
			expect(result).toHaveProperty("hasCircular");
			expect(result).toHaveProperty("circular");
			expect(result).toHaveProperty("checked");
		});
	});

	describe("scanProject", () => {
		it("should return correct structure", () => {
			const mockChecker = new DependencyChecker();
			// When not available, should still return expected structure
			const result = mockChecker.scanProject(tmpDir);
			expect(result).toHaveProperty("circular");
			expect(result).toHaveProperty("count");
			expect(Array.isArray(result.circular)).toBe(true);
		});
	});

	describe("formatWarning", () => {
		it("should format circular dependency warning", () => {
			const circularDeps = ["b.ts", "c.ts", "a.ts"];
			const formatted = client.formatWarning("a.ts", circularDeps);

			expect(formatted).toContain("cycle");
			expect(formatted).toContain("a.ts");
		});

		it("should show the circular path", () => {
			const circularDeps = ["b.ts", "a.ts"];
			const formatted = client.formatWarning("a.ts", circularDeps);

			expect(formatted).toContain("b.ts");
		});
	});
});
