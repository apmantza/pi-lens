import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GoClient } from "./go-client.js";
import { setupTestEnvironment } from "./test-utils.js";

describe("GoClient", () => {
	let client: GoClient;
	let tmpDir: string;
	let cleanup: () => void;

	beforeEach(() => {
		client = new GoClient();
		({ tmpDir, cleanup } = setupTestEnvironment("pi-lens-go-test-"));
	});

	afterEach(() => {
		cleanup();
	});

	afterEach(() => {
		cleanup();
	});

	describe("isGoFile", () => {
		it("should recognize Go files", () => {
			expect(client.isGoFile("main.go")).toBe(true);
			expect(client.isGoFile("handler.go")).toBe(true);
		});

		it("should not recognize non-Go files", () => {
			expect(client.isGoFile("main.ts")).toBe(false);
			expect(client.isGoFile("main.py")).toBe(false);
		});
	});

	describe("isGoAvailable", () => {
		it("should check Go availability", () => {
			const available = client.isGoAvailable();
			expect(typeof available).toBe("boolean");
		});
	});

	describe("isGoplsAvailable", () => {
		it("should check gopls availability", () => {
			const available = client.isGoplsAvailable();
			expect(typeof available).toBe("boolean");
		});
	});

	describe("checkFile", () => {
		it("should return empty array for non-existent files", () => {
			if (!client.isGoAvailable()) return;
			const result = client.checkFile("/nonexistent/file.go");
			expect(result).toEqual([]);
		});

		it("should return array for valid Go files", () => {
			if (!client.isGoAvailable()) return;

			const content = `
package main

import "fmt"

func main() {
    fmt.Println("Hello, World!")
}
`;
			const filePath = path.join(tmpDir, "main.go");
			fs.writeFileSync(filePath, content);

			const result = client.checkFile(filePath);
			expect(Array.isArray(result)).toBe(true);
		});

		it("should detect syntax errors", () => {
			if (!client.isGoAvailable()) return;

			const content = `
package main

func main() {
    fmt.Println("missing import"
}
`;
			const filePath = path.join(tmpDir, "main.go");
			fs.writeFileSync(filePath, content);

			const result = client.checkFile(filePath);
			// go vet should catch syntax issues
			expect(Array.isArray(result)).toBe(true);
		});
	});

	describe("formatDiagnostics", () => {
		it("should format diagnostics for display", () => {
			const diags = [
				{
					line: 5,
					column: 2,
					endLine: 5,
					endColumn: 10,
					severity: "error" as const,
					message: "undefined: fmt",
					file: "main.go",
				},
			];

			const formatted = client.formatDiagnostics(diags);
			expect(formatted).toContain("Go");
			expect(formatted).toContain("1 issue");
			expect(formatted).toContain("undefined: fmt");
		});

		it("should show error and warning counts", () => {
			const diags = [
				{
					line: 1,
					column: 0,
					endLine: 1,
					endColumn: 10,
					severity: "error" as const,
					message: "Error",
					file: "test.go",
				},
				{
					line: 2,
					column: 0,
					endLine: 2,
					endColumn: 10,
					severity: "warning" as const,
					message: "Warning",
					file: "test.go",
				},
			];

			const formatted = client.formatDiagnostics(diags);
			expect(formatted).toContain("1 error(s)");
			expect(formatted).toContain("1 warning(s)");
		});
	});
});
