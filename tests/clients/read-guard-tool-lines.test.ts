import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	countFileLines,
	getTouchedLinesForGuard,
	tryCorrectIndentationMismatch,
} from "../../clients/read-guard-tool-lines.js";
import { setupTestEnvironment } from "./test-utils.js";

describe("read-guard tool line helpers", () => {
	it("returns undefined touchedLines for text-replacement edits without explicit ranges and no filePath", () => {
		const event = {
			toolName: "edit",
			input: {
				path: "/src/file.ts",
				edits: [{ oldText: "foo", newText: "bar" }],
			},
		};

		expect(getTouchedLinesForGuard(event).touchedLines).toBeUndefined();
	});

	it("uses only edits that actually provide ranges", () => {
		const event = {
			toolName: "edit",
			input: {
				path: "/src/file.ts",
				edits: [
					{ oldText: "foo", newText: "bar" },
					{
						range: {
							start: { line: 10 },
							end: { line: 12 },
						},
					},
				],
			},
		};

		expect(getTouchedLinesForGuard(event).touchedLines).toEqual([10, 12]);
	});

	it("uses actual on-disk line count for writes", () => {
		const env = setupTestEnvironment("read-guard-lines-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "line1\nline2\nline3\n");

			expect(countFileLines(filePath)).toBe(4);
			expect(
				getTouchedLinesForGuard(
					{ toolName: "write", input: { path: filePath } },
					filePath,
				).touchedLines,
			).toEqual([1, 4]);
		} finally {
			env.cleanup();
		}
	});

	it("resolves unique oldText to a line range", () => {
		const env = setupTestEnvironment("read-guard-lines-resolve-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(
				filePath,
				"function foo() {\n  return 1;\n}\n\nfunction bar() {\n  return 2;\n}\n",
			);

			const event = {
				toolName: "edit",
				input: {
					path: filePath,
					edits: [
						{
							oldText: "function bar() {\n  return 2;\n}",
							newText: "function bar() {\n  return 99;\n}",
						},
					],
				},
			};

			const result = getTouchedLinesForGuard(event, filePath);
			expect(result.touchedLines).toEqual([5, 7]);
			expect(result.preflightError).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("returns preflightError with line numbers when oldText appears multiple times", () => {
		const env = setupTestEnvironment("read-guard-lines-dup-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(
				filePath,
				"  return value;\n}\n\nfunction b() {\n  return value;\n}\n",
			);

			const event = {
				toolName: "edit",
				input: {
					path: filePath,
					edits: [{ oldText: "  return value;", newText: "  return 42;" }],
				},
			};

			const result = getTouchedLinesForGuard(event, filePath);
			expect(result.touchedLines).toBeUndefined();
			expect(result.preflightError).toMatch(/BLOCKED/);
			expect(result.preflightError).toMatch(/edits\[0\]/);
			expect(result.preflightError).toMatch(/2 times/);
			expect(result.preflightError).toMatch(/Line 1/);
			expect(result.preflightError).toMatch(/Line 5/);
		} finally {
			env.cleanup();
		}
	});

	it("returns preflightError when oldText is not found", () => {
		const env = setupTestEnvironment("read-guard-lines-missing-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "function foo() {\n  return 1;\n}\n");

			const event = {
				toolName: "edit",
				input: {
					path: filePath,
					edits: [
						{ oldText: "function bar() {\n  return 2;\n}", newText: "noop" },
					],
				},
			};

			const result = getTouchedLinesForGuard(event, filePath);
			expect(result.touchedLines).toBeUndefined();
			expect(result.preflightError).toMatch(/BLOCKED/);
			expect(result.preflightError).toMatch(/was not found/);
			expect(result.preflightError).toMatch(/Re-read the file/);
		} finally {
			env.cleanup();
		}
	});

	it("returns preflightError when only some edits resolve", () => {
		const env = setupTestEnvironment("read-guard-lines-partial-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(
				filePath,
				"function foo() {\n  return 1;\n}\n\nfunction bar() {\n  return 2;\n}\n",
			);

			const event = {
				toolName: "edit",
				input: {
					path: filePath,
					edits: [
						{ oldText: "function bar() {\n  return 2;\n}", newText: "ok" },
						{ oldText: "function baz() {\n  return 3;\n}", newText: "missing" },
					],
				},
			};

			const result = getTouchedLinesForGuard(event, filePath);
			expect(result.touchedLines).toBeUndefined();
			expect(result.preflightError).toMatch(/BLOCKED/);
			expect(result.preflightError).toMatch(/edits\[1\]/);
			expect(result.preflightError).toMatch(/was not found/);
		} finally {
			env.cleanup();
		}
	});
});

describe("tryCorrectIndentationMismatch", () => {
	it("returns undefined when oldText already matches the file", () => {
		const env = setupTestEnvironment("pi-lens-indent-match-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "function foo() {\n\treturn 1;\n}\n");
			expect(
				tryCorrectIndentationMismatch(
					"function foo() {\n\treturn 1;\n}",
					filePath,
				),
			).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("corrects 4-space indentation to tabs when file uses tabs", () => {
		const env = setupTestEnvironment("pi-lens-indent-4to-tab-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "function foo() {\n\treturn 1;\n}\n");
			const result = tryCorrectIndentationMismatch(
				"function foo() {\n    return 1;\n}",
				filePath,
			);
			expect(result).toBe("function foo() {\n\treturn 1;\n}");
		} finally {
			env.cleanup();
		}
	});

	it("corrects 2-space indentation to tabs when file uses tabs", () => {
		const env = setupTestEnvironment("pi-lens-indent-2to-tab-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "function foo() {\n\treturn 1;\n}\n");
			const result = tryCorrectIndentationMismatch(
				"function foo() {\n  return 1;\n}",
				filePath,
			);
			expect(result).toBe("function foo() {\n\treturn 1;\n}");
		} finally {
			env.cleanup();
		}
	});

	it("corrects tabs to 4-space indentation when file uses 4 spaces", () => {
		const env = setupTestEnvironment("pi-lens-indent-tab-to-4-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "function foo() {\n    return 1;\n}\n");
			const result = tryCorrectIndentationMismatch(
				"function foo() {\n\treturn 1;\n}",
				filePath,
			);
			expect(result).toBe("function foo() {\n    return 1;\n}");
		} finally {
			env.cleanup();
		}
	});

	it("corrects tabs to 2-space indentation when file uses 2 spaces", () => {
		const env = setupTestEnvironment("pi-lens-indent-tab-to-2-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "function foo() {\n  return 1;\n}\n");
			const result = tryCorrectIndentationMismatch(
				"function foo() {\n\treturn 1;\n}",
				filePath,
			);
			expect(result).toBe("function foo() {\n  return 1;\n}");
		} finally {
			env.cleanup();
		}
	});

	it("returns undefined when no indentation conversion fixes the mismatch", () => {
		const env = setupTestEnvironment("pi-lens-indent-no-fix-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "function foo() {\n\treturn 1;\n}\n");
			expect(
				tryCorrectIndentationMismatch(
					"function bar() {\n\treturn 2;\n}",
					filePath,
				),
			).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});
});
