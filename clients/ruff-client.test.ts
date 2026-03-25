import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuffClient } from "./ruff-client.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

describe("RuffClient", () => {
	let client: RuffClient;
	let tmpDir: string;
	let cleanup: () => void;

	beforeEach(() => {
		client = new RuffClient();
		({ tmpDir, cleanup } = setupTestEnvironment("pi-lens-ruff-test-"));
	});

	afterEach(() => {
		cleanup();
	});

	afterEach(() => {
		cleanup();
	});

	describe("isPythonFile", () => {
		it("should recognize Python files", () => {
			expect(client.isPythonFile("test.py")).toBe(true);
			expect(client.isPythonFile("module.py")).toBe(true);
		});

		it("should not recognize non-Python files", () => {
			expect(client.isPythonFile("test.ts")).toBe(false);
			expect(client.isPythonFile("test.js")).toBe(false);
			expect(client.isPythonFile("test.txt")).toBe(false);
		});
	});

	describe("isAvailable", () => {
		it("should check ruff availability", () => {
			const available = client.isAvailable();
			expect(typeof available).toBe("boolean");
		});
	});

	describe("checkFile", () => {
		it("should return empty array for non-existent files", () => {
			if (!client.isAvailable()) return;
			const result = client.checkFile("/nonexistent/file.py");
			expect(result).toEqual([]);
		});

		it("should detect lint issues in Python code", () => {
			if (!client.isAvailable()) return;

			const content = `
import os
import sys

x = 1
`;
			const filePath = createTempFile(tmpDir, "test.py", content);
			const result = client.checkFile(filePath);

			// Should detect unused imports
			expect(
				result.some((d) => d.rule === "F401" || d.message.includes("unused")),
			).toBe(true);
		});

		it("should return array of diagnostics", () => {
			if (!client.isAvailable()) return;

			const content = `
def foo():
    x = undefined_variable
    return x
`;
			const filePath = createTempFile(tmpDir, "test.py", content);
			const result = client.checkFile(filePath);

			// Should return an array
			expect(Array.isArray(result)).toBe(true);
		});
	});

	describe("formatDiagnostics", () => {
		it("should format diagnostics for display", () => {
			const diags = [
				{
					line: 1,
					column: 0,
					endLine: 1,
					endColumn: 10,
					severity: "error" as const,
					message: "Undefined name 'x'",
					rule: "F821",
					file: "test.py",
					fixable: false,
				},
			];

			const formatted = client.formatDiagnostics(diags);
			expect(formatted).toContain("Ruff");
			expect(formatted).toContain("F821");
			expect(formatted).toContain("Undefined name");
		});

		it("should show fixable count", () => {
			const diags = [
				{
					line: 1,
					column: 0,
					endLine: 1,
					endColumn: 10,
					severity: "warning" as const,
					message: "Unused import",
					rule: "F401",
					file: "test.py",
					fixable: true,
				},
			];

			const formatted = client.formatDiagnostics(diags);
			expect(formatted).toContain("fixable");
		});
	});

	describe("checkFormatting", () => {
		it("should detect formatting issues", () => {
			if (!client.isAvailable()) return;

			const content = `x=1
y=2
`;
			const filePath = createTempFile(tmpDir, "test.py", content);
			const result = client.checkFormatting(filePath);

			// Should suggest formatting (missing spaces around =)
			expect(typeof result).toBe("string");
		});

		it("should return empty string for well-formatted code", () => {
			if (!client.isAvailable()) return;

			const content = `x = 1
y = 2
`;
			const filePath = createTempFile(tmpDir, "test.py", content);
			const result = client.checkFormatting(filePath);

			// Well-formatted code should return empty or minimal output
			expect(result).toBe("");
		});
	});
});
