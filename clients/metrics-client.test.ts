import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MetricsClient } from "./metrics-client.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

describe("MetricsClient", () => {
	let client: MetricsClient;
	let tmpDir: string;
	let cleanup: () => void;

	beforeEach(() => {
		client = new MetricsClient();
		({ tmpDir, cleanup } = setupTestEnvironment("pi-lens-metrics-test-"));
	});

	afterEach(() => {
		cleanup();
	});

	afterEach(() => {
		cleanup();
	});

	describe("calculateEntropy", () => {
		it("should return 0 for empty string", () => {
			expect(client.calculateEntropy("")).toBe(0);
		});

		it("should return 0 for single repeated character", () => {
			expect(client.calculateEntropy("aaaaaa")).toBe(0);
		});

		it("should return 1 for two equally likely characters", () => {
			expect(client.calculateEntropy("ababab")).toBe(1);
		});

		it("should return higher entropy for more diverse content", () => {
			const lowEntropy = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
			const highEntropy = "abcdefghijklmnopqrstuvwxyz";

			expect(client.calculateEntropy(highEntropy)).toBeGreaterThan(
				client.calculateEntropy(lowEntropy),
			);
		});

		it("should match expected Shannon entropy for known input", () => {
			// "aabb" has p(a)=0.5, p(b)=0.5, entropy = -2*(0.5*log2(0.5)) = 1
			expect(client.calculateEntropy("aabb")).toBeCloseTo(1, 5);
		});
	});

	describe("recordBaseline", () => {
		it("should record baseline for existing file", () => {
			const content = "const x = 1;\nconst y = 2;";
			const filePath = createTempFile(tmpDir, "test.ts", content);

			client.recordBaseline(filePath);

			const metrics = client.getFileMetrics(filePath);
			expect(metrics).not.toBeNull();
			expect(metrics?.totalLines).toBeGreaterThanOrEqual(2);
		});

		it("should not record baseline for non-existent file", () => {
			client.recordBaseline("/nonexistent/file.ts");

			// Should not throw, just silently skip
		});

		it("should not overwrite existing baseline", () => {
			const content1 = "const x = 1;\n";
			const content2 = "const x = 1;\nconst y = 2;\nconst z = 3;\n";
			const filePath = createTempFile(tmpDir, "test.ts", content1);

			client.recordBaseline(filePath);

			// Modify file
			fs.writeFileSync(filePath, content2);

			// Record again - should not update baseline
			client.recordBaseline(filePath);

			const metrics = client.getFileMetrics(filePath);
			expect(metrics?.entropyStart).toBe(client.calculateEntropy(content1));
		});
	});

	describe("recordWrite", () => {
		it("should track agent-written lines", () => {
			const original = "const x = 1;\n";
			const filePath = createTempFile(tmpDir, "test.ts", original);

			client.recordBaseline(filePath);

			const modified = "const x = 1;\nconst y = 2;\nconst z = 3;\n";
			fs.writeFileSync(filePath, modified);
			client.recordWrite(filePath, modified);

			const aiRatio = client.getAICodeRatio();
			expect(aiRatio.agentLines).toBeGreaterThan(0);
		});

		it("should calculate AI code ratio", () => {
			const file1 = createTempFile(
				tmpDir,
				"file1.ts",
				"original content line 1\noriginal content line 2\n",
			);
			const file2 = createTempFile(tmpDir, "file2.ts", "original\n");

			client.recordBaseline(file1);
			client.recordBaseline(file2);

			// Simulate agent writing new content
			const newContent1 =
				"original content line 1\noriginal content line 2\nagent line 3\nagent line 4\n";
			fs.writeFileSync(file1, newContent1);
			client.recordWrite(file1, newContent1);

			const aiRatio = client.getAICodeRatio();
			expect(aiRatio.fileCount).toBe(2);
			expect(aiRatio.ratio).toBeGreaterThanOrEqual(0);
			expect(aiRatio.ratio).toBeLessThanOrEqual(1);
		});
	});

	describe("getEntropyDeltas", () => {
		it("should track entropy changes", () => {
			const simple = "const x = 1;\n";
			const filePath = createTempFile(tmpDir, "test.ts", simple);

			client.recordBaseline(filePath);

			// Make file more complex
			const complex = `
function complex(a: number, b: number, c: number): number {
  if (a > 0) {
    if (b > 0) {
      if (c > 0) {
        return a + b + c;
      }
    }
  }
  return 0;
}
`;
			fs.writeFileSync(filePath, complex);
			client.recordWrite(filePath, complex);

			const deltas = client.getEntropyDeltas();
			expect(deltas.length).toBe(1);
			expect(deltas[0].delta).not.toBe(0);
		});
	});

	describe("formatSessionSummary", () => {
		it("should return empty string when no files touched", () => {
			expect(client.formatSessionSummary()).toBe("");
		});

		it("should format AI code ratio when files are modified", () => {
			const filePath = createTempFile(tmpDir, "test.ts", "original\n");
			client.recordBaseline(filePath);

			const modified = "original\nnew line 1\nnew line 2\n";
			fs.writeFileSync(filePath, modified);
			client.recordWrite(filePath, modified);

			const summary = client.formatSessionSummary();
			expect(summary).toContain("AI Code");
			expect(summary).toContain("file(s)");
		});
	});

	describe("reset", () => {
		it("should clear all tracked data", () => {
			const filePath = createTempFile(tmpDir, "test.ts", "content\n");
			client.recordBaseline(filePath);

			client.reset();

			const aiRatio = client.getAICodeRatio();
			expect(aiRatio.fileCount).toBe(0);
			expect(client.formatSessionSummary()).toBe("");
		});
	});
});
