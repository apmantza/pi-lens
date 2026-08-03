import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { applyPartiallyApplicableEdits } from "../../clients/partial-edit-apply.js";
import { createReadGuardEditBatchSummary } from "../../clients/read-guard-logger.js";
import { setupTestEnvironment } from "./test-utils.js";

describe("applyPartiallyApplicableEdits", () => {
	it("applies exact partial edits and routes through post-edit callback", async () => {
		const env = setupTestEnvironment("partial-apply-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "const a = 1;\nconst b = 2;\n");
			const afterWrite = vi.fn(async () => "pipeline output");

			const result = await applyPartiallyApplicableEdits({
				filePath,
				edits: [
					{
						oldText: "const b = 2;",
						newText: "const b = 20;",
						originalIndex: 1,
					},
					{ oldText: "missing", newText: "noop", originalIndex: 2 },
				],
				afterWrite,
			});

			expect(fs.readFileSync(filePath, "utf-8")).toBe(
				"const a = 1;\nconst b = 20;\n",
			);
			expect(afterWrite).toHaveBeenCalledTimes(1);
			expect(result).toEqual({
				appliedCount: 1,
				appliedIndices: "edits[1]",
				postEditOutput: "pipeline output",
			});
		} finally {
			env.cleanup();
		}
	});

	it("does not call post-edit callback when no partial edit still matches", async () => {
		const env = setupTestEnvironment("partial-apply-none-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "const a = 1;\n");
			const afterWrite = vi.fn(async () => "pipeline output");

			const result = await applyPartiallyApplicableEdits({
				filePath,
				edits: [{ oldText: "missing", newText: "noop", originalIndex: 0 }],
				afterWrite,
			});

			expect(fs.readFileSync(filePath, "utf-8")).toBe("const a = 1;\n");
			expect(afterWrite).not.toHaveBeenCalled();
			expect(result.appliedCount).toBe(0);
		} finally {
			env.cleanup();
		}
	});

	it("preserves CRLF files after applying partial edits", async () => {
		const env = setupTestEnvironment("partial-apply-crlf-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "const a = 1;\r\nconst b = 2;\r\n");

			await applyPartiallyApplicableEdits({
				filePath,
				edits: [
					{
						oldText: "const b = 2;",
						newText: "const b = 20;",
						originalIndex: 0,
					},
				],
			});

			expect(fs.readFileSync(filePath, "utf-8")).toBe(
				"const a = 1;\r\nconst b = 20;\r\n",
			);
		} finally {
			env.cleanup();
		}
	});

	// #505: confusable-hyphen normalization is comparison-only — it folds
	// U+2010/2011/2012/2013/2014/2212 to ASCII '-' when *matching* oldText
	// against file content (clients/host-edit-normalize.ts, consumed by
	// read-guard-tool-lines.ts's resolveOldTextEdits), but must never leak into
	// what actually gets written. This exercises the self-apply write path
	// (used when a partial batch resolves some edits via the preflight
	// comparison) with a newText that intentionally contains an EM DASH
	// (U+2014), confirming the byte written to disk is the caller's literal
	// character, not folded to ASCII.
	it("writes the caller's literal hyphen/dash variant, never normalized (#505)", async () => {
		const env = setupTestEnvironment("partial-apply-confusable-hyphen-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "const total = a-b;\n");

			const result = await applyPartiallyApplicableEdits({
				filePath,
				edits: [
					{
						oldText: "const total = a-b;",
						// Deliberately an EM DASH (U+2014), not ASCII '-'.
						newText: "const total = a—b; // em dash on purpose",
						originalIndex: 0,
					},
				],
			});

			expect(fs.readFileSync(filePath, "utf-8")).toBe(
				"const total = a—b; // em dash on purpose\n",
			);
			expect(result.appliedCount).toBe(1);
		} finally {
			env.cleanup();
		}
	});

	it("reports applied and silently skipped indexes in the bounded summary", async () => {
		const env = setupTestEnvironment("partial-apply-observability-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "const a = 1;\nconst b = 2;\n");
			const result = await applyPartiallyApplicableEdits({
				filePath,
				correlationId: "tool-42",
				summary: createReadGuardEditBatchSummary({
					requestedIndexes: [0, 1, 2],
					resolvedIndexes: [1, 2],
					rejectedReasons: [{ index: 0, code: "oldtext_not_found" }],
				}),
				edits: [
					{ oldText: "const b = 2;", newText: "const b = 20;", originalIndex: 1 },
					{ oldText: "const b = 20;", newText: "const b = 200;", originalIndex: 2 },
					{ oldText: "not present", newText: "never", originalIndex: 0 },
				],
			});

			expect(result.appliedIndices).toBe("edits[1], edits[2]");
			expect(result.skippedCount).toBe(1);
			expect(result.skippedIndices).toBe("edits[0]");
			expect(result.summary).toMatchObject({
				requestedCount: 3,
				requestedTotal: 3,
				requestedIndexes: [0, 1, 2],
				appliedCount: 2,
				appliedTotal: 2,
				appliedIndexes: [1, 2],
				participantIds: ["tool-42"],
				commitStatus: "committed",
				postEditStatus: "not_run",
				terminalStatus: "success",
			});
			expect(JSON.stringify(result.summary)).not.toMatch(/const|present|never/);
		} finally {
			env.cleanup();
		}
	});

	it("keeps true batch totals beside bounded index samples", () => {
		const summary = createReadGuardEditBatchSummary({
			requestedIndexes: Array.from({ length: 150 }, (_, index) => index),
			resolvedIndexes: Array.from({ length: 150 }, (_, index) => index),
			appliedIndexes: Array.from({ length: 150 }, (_, index) => index),
			participantIds: Array.from({ length: 150 }, (_, index) => `call-${index}`),
			requestedTotal: 150,
			resolvedTotal: 150,
			appliedTotal: 150,
			participantTotal: 150,
		});

		expect(summary.requestedIndexes).toHaveLength(100);
		expect(summary.requestedTotal).toBe(150);
		expect(summary.appliedTotal).toBe(150);
		expect(summary.participantIds).toHaveLength(100);
		expect(summary.indexesTruncated).toBe(true);
		expect(summary.participantIdsTruncated).toBe(true);
	});

	it("distinguishes a committed write from a failed post-edit pipeline", async () => {
		const env = setupTestEnvironment("partial-apply-pipeline-failure-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "const a = 1;\n");
			const result = await applyPartiallyApplicableEdits({
				filePath,
				correlationId: "tool-pipeline-1",
				summary: createReadGuardEditBatchSummary({
					requestedIndexes: [0],
					resolvedIndexes: [0],
				}),
				edits: [{ oldText: "const a = 1;", newText: "const a = 2;", originalIndex: 0 }],
				afterWrite: async () => {
					throw new Error("pipeline failure with source content");
				},
			});

			expect(fs.readFileSync(filePath, "utf-8")).toBe("const a = 2;\n");
			expect(result.postEditStatus).toBe("failed");
			expect(result.summary).toMatchObject({
				commitStatus: "committed",
				postEditStatus: "failed",
				appliedCount: 1,
			});
		} finally {
			env.cleanup();
		}
	});

	it("uses host first-occurrence-wins ending detection on mixed files (#257)", async () => {
		const env = setupTestEnvironment("partial-apply-mixed-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			// First newline is LF, a later one is CRLF. The old `includes("\r\n")`
			// rule would rewrite the whole file as CRLF; the host's detectLineEnding
			// resolves LF, so untouched lines keep their LF endings.
			fs.writeFileSync(
				filePath,
				"const a = 1;\nconst b = 2;\r\nconst c = 3;\n",
			);

			await applyPartiallyApplicableEdits({
				filePath,
				edits: [
					{
						oldText: "const c = 3;",
						newText: "const c = 30;",
						originalIndex: 0,
					},
				],
			});

			expect(fs.readFileSync(filePath, "utf-8")).toBe(
				"const a = 1;\nconst b = 2;\nconst c = 30;\n",
			);
		} finally {
			env.cleanup();
		}
	});
});
