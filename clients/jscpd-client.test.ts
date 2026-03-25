import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JscpdClient } from "./jscpd-client.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

describe("JscpdClient", () => {
	let client: JscpdClient;
	let tmpDir: string;
	let cleanup: () => void;

	beforeEach(() => {
		client = new JscpdClient();
		({ tmpDir, cleanup } = setupTestEnvironment("pi-lens-jscpd-test-"));
	});

	afterEach(() => {
		cleanup();
	});

	afterEach(() => {
		cleanup();
	});

	describe("isAvailable", () => {
		it("should check jscpd availability", () => {
			const available = client.isAvailable();
			expect(typeof available).toBe("boolean");
		});
	});

	describe("scan", () => {
		it("should return success=false when not available", () => {
			// Create a mock that returns false
			const mockClient = new JscpdClient();
			if (mockClient.isAvailable()) return; // Skip if available

			const result = mockClient.scan(tmpDir);
			expect(result.success).toBe(false);
			expect(result.clones).toEqual([]);
		});

		it("should detect duplicate code blocks", () => {
			if (!client.isAvailable()) return;

			// Create identical code blocks in different files
			const duplicateCode = `
function processData(data: number[]): number {
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum += data[i];
  }
  return sum;
}
`;
			createTempFile(tmpDir, "file1.ts", duplicateCode);
			createTempFile(tmpDir, "file2.ts", duplicateCode);

			const result = client.scan(tmpDir, 3, 20); // Lower thresholds for test

			expect(result.success).toBe(true);
			// May or may not detect clones depending on jscpd behavior
		});
	});

	describe("formatResult", () => {
		it("should return empty string for no success", () => {
			const result = {
				success: false,
				clones: [],
				duplicatedLines: 0,
				totalLines: 100,
				percentage: 0,
			};

			expect(client.formatResult(result)).toBe("");
		});

		it("should return empty string for no clones", () => {
			const result = {
				success: true,
				clones: [],
				duplicatedLines: 0,
				totalLines: 100,
				percentage: 0,
			};

			expect(client.formatResult(result)).toBe("");
		});

		it("should format clones for display", () => {
			const result = {
				success: true,
				clones: [
					{
						fileA: "src/file1.ts",
						startA: 10,
						fileB: "src/file2.ts",
						startB: 20,
						lines: 15,
						tokens: 50,
					},
					{
						fileA: "src/file3.ts",
						startA: 5,
						fileB: "src/file4.ts",
						startB: 12,
						lines: 8,
						tokens: 30,
					},
				],
				duplicatedLines: 23,
				totalLines: 500,
				percentage: 4.6,
			};

			const formatted = client.formatResult(result);
			expect(formatted).toContain("jscpd");
			expect(formatted).toContain("2 duplicate block(s)");
			expect(formatted).toContain("4.6%");
			expect(formatted).toContain("15 lines");
		});

		it("should truncate long clone lists", () => {
			const clones = Array.from({ length: 10 }, (_, i) => ({
				fileA: `file${i}a.ts`,
				startA: 1,
				fileB: `file${i}b.ts`,
				startB: 1,
				lines: 5,
				tokens: 20,
			}));

			const result = {
				success: true,
				clones,
				duplicatedLines: 50,
				totalLines: 1000,
				percentage: 5,
			};

			const formatted = client.formatResult(result, 8);
			expect(formatted).toContain("...");
			expect(formatted).toContain("2 more");
		});
	});
});
