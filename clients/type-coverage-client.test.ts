import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setupTestEnvironment } from "./test-utils.js";
import { TypeCoverageClient } from "./type-coverage-client.js";

describe("TypeCoverageClient", () => {
	let client: TypeCoverageClient;
	let _tmpDir: string;
	let cleanup: () => void;

	beforeEach(() => {
		client = new TypeCoverageClient();
		({ tmpDir: _tmpDir, cleanup } = setupTestEnvironment("pi-lens-typecoverage-test-"));
	});

	afterEach(() => {
		cleanup();
	});

	afterEach(() => {
		cleanup();
	});

	describe("isAvailable", () => {
		it("should check type-coverage availability", () => {
			const available = client.isAvailable();
			expect(typeof available).toBe("boolean");
		});
	});

	describe("formatResult", () => {
		it("should return empty string when not successful", () => {
			const result = {
				success: false,
				percentage: 0,
				typed: 0,
				total: 0,
				untypedLocations: [],
			};

			expect(client.formatResult(result)).toBe("");
		});

		it("should show coverage percentage", () => {
			const result = {
				success: true,
				percentage: 95,
				typed: 95,
				total: 100,
				untypedLocations: [],
			};

			const formatted = client.formatResult(result);
			expect(formatted).toContain("95.0%");
			expect(formatted).toContain("95/100");
		});

		it("should show warning for low coverage", () => {
			const result = {
				success: true,
				percentage: 80,
				typed: 80,
				total: 100,
				untypedLocations: [],
			};

			const formatted = client.formatResult(result);
			expect(formatted).toContain("⚠");
		});

		it("should show checkmark for high coverage", () => {
			const result = {
				success: true,
				percentage: 100,
				typed: 100,
				total: 100,
				untypedLocations: [],
			};

			const formatted = client.formatResult(result);
			expect(formatted).toContain("✓");
		});

		it("should show untyped locations", () => {
			const result = {
				success: true,
				percentage: 90,
				typed: 90,
				total: 100,
				untypedLocations: [
					{ file: "test.ts", line: 10, column: 5, name: "x" },
					{ file: "test.ts", line: 20, column: 8, name: "y" },
				],
			};

			const formatted = client.formatResult(result);
			expect(formatted).toContain("test.ts:10");
			expect(formatted).toContain("test.ts:20");
			expect(formatted).toContain("x");
			expect(formatted).toContain("y");
		});

		it("should truncate long untyped location lists", () => {
			const locations = Array.from({ length: 20 }, (_, i) => ({
				file: `file${i}.ts`,
				line: i + 1,
				column: 0,
				name: `var${i}`,
			}));

			const result = {
				success: true,
				percentage: 80,
				typed: 80,
				total: 100,
				untypedLocations: locations,
			};

			const formatted = client.formatResult(result, 10);
			expect(formatted).toContain("...");
			expect(formatted).toContain("10 more");
		});
	});
});
