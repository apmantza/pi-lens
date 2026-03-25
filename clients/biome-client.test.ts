import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BiomeClient } from "./biome-client.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

describe("BiomeClient", () => {
	let client: BiomeClient;
	let tmpDir: string;
	let cleanup: () => void;

	beforeEach(() => {
		client = new BiomeClient();
		({ tmpDir, cleanup } = setupTestEnvironment("pi-lens-biome-test-"));
	});

	afterEach(() => {
		cleanup();
	});

	afterEach(() => {
		cleanup();
	});

	describe("isSupportedFile", () => {
		it("should support JS/TS files", () => {
			expect(client.isSupportedFile("test.js")).toBe(true);
			expect(client.isSupportedFile("test.jsx")).toBe(true);
			expect(client.isSupportedFile("test.ts")).toBe(true);
			expect(client.isSupportedFile("test.tsx")).toBe(true);
			expect(client.isSupportedFile("test.mjs")).toBe(true);
			expect(client.isSupportedFile("test.cjs")).toBe(true);
		});

		it("should support CSS and JSON", () => {
			expect(client.isSupportedFile("style.css")).toBe(true);
			expect(client.isSupportedFile("config.json")).toBe(true);
		});

		it("should not support unsupported files", () => {
			expect(client.isSupportedFile("test.py")).toBe(false);
			expect(client.isSupportedFile("test.md")).toBe(false);
			expect(client.isSupportedFile("test.txt")).toBe(false);
		});
	});

	describe("isAvailable", () => {
		it("should check biome availability", () => {
			const available = client.isAvailable();
			// Just verify it doesn't throw - actual availability depends on environment
			expect(typeof available).toBe("boolean");
		});
	});

	describe("checkFile", () => {
		it("should return empty array for non-existent files", () => {
			if (!client.isAvailable()) return;
			const result = client.checkFile("/nonexistent/file.ts");
			expect(result).toEqual([]);
		});

		it("should return array of diagnostics for TS files", () => {
			if (!client.isAvailable()) return;

			const content = `
const x: number = "string";
`;
			const filePath = createTempFile(tmpDir, "test.ts", content);
			const result = client.checkFile(filePath);

			// Should return an array (may or may not have issues)
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
					message: "Unexpected var",
					rule: "noVar",
					category: "lint" as const,
					fixable: true,
				},
			];

			const formatted = client.formatDiagnostics(diags, "test.ts");
			expect(formatted).toContain("Biome");
			expect(formatted).toContain("1 issue");
			expect(formatted).toContain("noVar");
		});

		it("should show fixable count", () => {
			const diags = [
				{
					line: 1,
					column: 0,
					endLine: 1,
					endColumn: 10,
					severity: "error" as const,
					message: "Error 1",
					rule: "rule1",
					category: "lint" as const,
					fixable: true,
				},
				{
					line: 2,
					column: 0,
					endLine: 2,
					endColumn: 10,
					severity: "warning" as const,
					message: "Warning 1",
					rule: "rule2",
					category: "lint" as const,
					fixable: false,
				},
			];

			const formatted = client.formatDiagnostics(diags, "test.ts");
			expect(formatted).toContain("1 fixable");
		});

		it("should truncate long diagnostic lists", () => {
			const diags = Array.from({ length: 20 }, (_, i) => ({
				line: i + 1,
				column: 0,
				endLine: i + 1,
				endColumn: 10,
				severity: "warning" as const,
				message: `Warning ${i}`,
				rule: `rule${i}`,
				category: "lint" as const,
				fixable: false,
			}));

			const formatted = client.formatDiagnostics(diags, "test.ts");
			expect(formatted).toContain("...");
			expect(formatted).toContain("5 more");
		});
	});

	describe("formatFile", () => {
		it("should format a file", () => {
			if (!client.isAvailable()) return;

			const content = `const x={a:1,b:2}`;
			const filePath = createTempFile(tmpDir, "test.ts", content);

			const result = client.formatFile(filePath);
			expect(result.success).toBe(true);

			// Check if file was formatted (should have spaces)
			const formatted = fs.readFileSync(filePath, "utf-8");
			expect(formatted).toContain(": "); // Should have spaces after colons
		});
	});
});
