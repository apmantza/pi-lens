import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RustClient } from "./rust-client.js";
import { setupTestEnvironment } from "./test-utils.js";

describe("RustClient", () => {
	let client: RustClient;
	let tmpDir: string;
	let cleanup: () => void;

	beforeEach(() => {
		client = new RustClient();
		({ tmpDir, cleanup } = setupTestEnvironment("pi-lens-rust-test-"));
	});

	afterEach(() => {
		cleanup();
	});

	afterEach(() => {
		cleanup();
	});

	describe("isRustFile", () => {
		it("should recognize Rust files", () => {
			expect(client.isRustFile("main.rs")).toBe(true);
			expect(client.isRustFile("lib.rs")).toBe(true);
		});

		it("should not recognize non-Rust files", () => {
			expect(client.isRustFile("main.ts")).toBe(false);
			expect(client.isRustFile("main.py")).toBe(false);
		});
	});

	describe("isAvailable", () => {
		it("should check cargo availability", () => {
			const available = client.isAvailable();
			expect(typeof available).toBe("boolean");
		});
	});

	describe("checkFile", () => {
		it("should return empty array for non-existent files", () => {
			if (!client.isAvailable()) return;
			const result = client.checkFile("/nonexistent/file.rs", tmpDir);
			expect(result).toEqual([]);
		});

		it("should return array for valid Rust files", () => {
			if (!client.isAvailable()) return;

			// Need a Cargo.toml for cargo to work
			fs.writeFileSync(
				path.join(tmpDir, "Cargo.toml"),
				`
[package]
name = "test"
version = "0.1.0"
edition = "2021"
`,
			);
			fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
			fs.writeFileSync(
				path.join(tmpDir, "src", "main.rs"),
				`
fn main() {
    println!("Hello, world!");
}
`,
			);

			const result = client.checkFile(
				path.join(tmpDir, "src", "main.rs"),
				tmpDir,
			);
			expect(Array.isArray(result)).toBe(true);
		});
	});

	describe("formatDiagnostics", () => {
		it("should format diagnostics for display", () => {
			const diags = [
				{
					line: 3,
					column: 0,
					endLine: 3,
					endColumn: 10,
					severity: "error" as const,
					message: "cannot find value `x` in this scope",
					code: "E0425",
					file: "main.rs",
				},
			];

			const formatted = client.formatDiagnostics(diags);
			expect(formatted).toContain("Rust");
			expect(formatted).toContain("1 issue");
			expect(formatted).toContain("E0425");
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
					file: "test.rs",
				},
				{
					line: 2,
					column: 0,
					endLine: 2,
					endColumn: 10,
					severity: "warning" as const,
					message: "Warning",
					file: "test.rs",
				},
			];

			const formatted = client.formatDiagnostics(diags);
			expect(formatted).toContain("1 error(s)");
			expect(formatted).toContain("1 warning(s)");
		});
	});
});
