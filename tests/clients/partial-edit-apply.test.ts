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
