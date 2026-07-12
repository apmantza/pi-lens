import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { applyPartiallyApplicableEdits } from "../../clients/partial-edit-apply.js";
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
