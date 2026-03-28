/**
 * Tests for sanitize.ts
 * Tool output sanitization
 */

import { describe, expect, it } from "vitest";
import {
	extractErrorMessage,
	normalizeWhitespace,
	sanitizeBiomeOutput,
	sanitizeLine,
	sanitizeOutput,
	sanitizeRuffOutput,
	sanitizeToolOutput,
	stripAnsi,
	truncateMessage,
} from "./sanitize.js";

describe("stripAnsi", () => {
	it("should remove ANSI color codes", () => {
		expect(stripAnsi("\x1b[31mError\x1b[0m")).toBe("Error");
		expect(stripAnsi("\x1b[1;32mSuccess\x1b[0m")).toBe("Success");
	});

	it("should remove extended ANSI codes", () => {
		expect(stripAnsi("\x1b[1;2;3mText\x1b[0m")).toBe("Text");
	});

	it("should return original string if no ANSI codes", () => {
		expect(stripAnsi("Plain text")).toBe("Plain text");
	});
});

describe("normalizeWhitespace", () => {
	it("should collapse multiple spaces", () => {
		expect(normalizeWhitespace("Hello    World")).toBe("Hello World");
	});

	it("should trim lines", () => {
		expect(normalizeWhitespace("  Hello  \n  World  ")).toBe("Hello\nWorld");
	});

	it("should remove empty lines", () => {
		expect(normalizeWhitespace("Hello\n\n\nWorld")).toBe("Hello\nWorld");
	});
});

describe("sanitizeLine", () => {
	it("should remove common error prefixes", () => {
		expect(sanitizeLine("[error] Something went wrong")).toBe(
			"Something went wrong",
		);
		expect(sanitizeLine("error: Something went wrong")).toBe(
			"Something went wrong",
		);
	});

	it("should remove check/cross marks", () => {
		expect(sanitizeLine("× Error message")).toBe("Error message");
		expect(sanitizeLine("✓ Success message")).toBe("Success message");
	});

	it("should normalize whitespace", () => {
		expect(sanitizeLine("  Error   message  ")).toBe("Error message");
	});
});

describe("sanitizeOutput", () => {
	it("should return empty string for empty input", () => {
		expect(sanitizeOutput("")).toBe("");
		expect(sanitizeOutput("   ")).toBe("");
	});

	it("should filter out detail lines", () => {
		const output = "Error message\n    at line 10\n    at function foo";
		const result = sanitizeOutput(output);
		expect(result).toBe("Error message");
	});

	it("should remove ANSI codes and normalize", () => {
		const output = "\x1b[31mError\x1b[0m\n\x1b[32mSuccess\x1b[0m";
		const result = sanitizeOutput(output);
		expect(result).toBe("Error\nSuccess");
	});
});

describe("extractErrorMessage", () => {
	it("should return undefined for empty input", () => {
		expect(extractErrorMessage("")).toBeUndefined();
		expect(extractErrorMessage("   ")).toBeUndefined();
	});

	it("should return first error line containing error indicator", () => {
		// Note: extractErrorMessage sanitizes lines first, then checks isErrorLine
		// Since "error:" prefix is removed by sanitizeLine, we need to use a keyword
		// that remains in the sanitized line, like "failed" or "syntax"
		const output = "Some info\nOperation failed: disk full\nMore info";
		const result = extractErrorMessage(output);
		expect(result).toBe("Operation failed: disk full");
	});

	it("should fall back to first non-empty line", () => {
		const output = "info line\nanother info\nand more";
		expect(extractErrorMessage(output)).toBe("info line");
	});

	it("should find error by keyword", () => {
		const result = extractErrorMessage(
			"warning: low severity\nfailed: operation",
		);
		// extractErrorMessage returns the first line with error indicators
		// "failed:" contains "failed" which matches ERROR_INDICATORS
		expect(result).toBe("failed: operation");
	});
});

describe("truncateMessage", () => {
	it("should not truncate short messages", () => {
		const msg = "Short message";
		expect(truncateMessage(msg, 100)).toBe(msg);
	});

	it("should truncate long messages", () => {
		const msg = "A".repeat(200);
		const result = truncateMessage(msg, 50);
		expect(result).toBe(`${"A".repeat(49)}…`);
	});

	it("should use default max length of 140", () => {
		const msg = "A".repeat(200);
		const result = truncateMessage(msg);
		expect(result.length).toBe(140);
	});
});

describe("sanitizeToolOutput", () => {
	it("should return empty result for empty input", () => {
		const result = sanitizeToolOutput("");
		expect(result.summary).toBeUndefined();
		expect(result.details).toBeUndefined();
		expect(result.truncated).toBe(false);
	});

	it("should extract summary and details", () => {
		const output = "error: something failed\nline 2\nline 3\nline 4";
		const result = sanitizeToolOutput(output);
		// sanitizeLine removes "error:" prefix
		expect(result.summary).toContain("something failed");
		expect(result.details).toBeDefined();
	});

	it("should mark as truncated when too many lines", () => {
		const lines: string[] = [];
		for (let i = 0; i < 30; i++) {
			lines.push(`error line ${i}`);
		}
		const result = sanitizeToolOutput(lines.join("\n"));
		expect(result.truncated).toBe(true);
		expect(result.details).toContain("more lines");
	});

	it("should respect max summary length", () => {
		const output = `error: ${"x".repeat(200)}`;
		const result = sanitizeToolOutput(output, 50);
		expect(result.summary?.length).toBeLessThanOrEqual(50);
	});
});

describe("sanitizeBiomeOutput", () => {
	it("should parse JSON diagnostics", () => {
		const json = JSON.stringify({
			diagnostics: [
				{
					location: {
						path: "file.ts",
						span: { start: { line: 10, column: 0 } },
					},
					message: "Unexpected token",
				},
			],
		});
		const result = sanitizeBiomeOutput(json);
		expect(result).toContain("file.ts");
		expect(result).toContain("11"); // line + 1
		expect(result).toContain("Unexpected token");
	});

	it("should handle text output with errors", () => {
		const output = "error: something went wrong\ninfo: some info";
		const result = sanitizeBiomeOutput(output);
		expect(result).toContain("error");
	});

	it("should return empty for empty input", () => {
		expect(sanitizeBiomeOutput("")).toBe("");
	});
});

describe("sanitizeRuffOutput", () => {
	it("should parse JSON diagnostics", () => {
		const json = JSON.stringify([
			{
				location: { row: 10, column: 5 },
				code: "E501",
				message: "Line too long",
			},
		]);
		const result = sanitizeRuffOutput(json);
		expect(result).toContain("10:5");
		expect(result).toContain("[E501]");
		expect(result).toContain("Line too long");
	});

	it("should handle text output", () => {
		const output = "file.py:10:5 [E501] Line too long";
		const result = sanitizeRuffOutput(output);
		expect(result).toContain("E501");
	});

	it("should return empty for empty input", () => {
		expect(sanitizeRuffOutput("")).toBe("");
	});
});
