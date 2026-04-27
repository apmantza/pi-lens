import { describe, expect, it } from "vitest";
import {
	extractErrorMessage,
	sanitizeBiomeOutput,
	sanitizeGoOutput,
	sanitizeLine,
	sanitizeOutput,
	sanitizeRuffOutput,
	sanitizeRustOutput,
	sanitizeTsDiagnostic,
	sanitizeToolOutput,
	stripAnsi,
	truncateMessage,
} from "../../clients/sanitize.js";

describe("stripAnsi", () => {
	it("removes basic color codes", () => {
		expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
	});

	it("removes extended escape sequences", () => {
		expect(stripAnsi("\x1b[2Jhello")).toBe("hello");
	});

	it("passes plain text through unchanged", () => {
		expect(stripAnsi("plain text")).toBe("plain text");
	});

	it("handles empty string", () => {
		expect(stripAnsi("")).toBe("");
	});
});

describe("sanitizeLine", () => {
	it("strips ANSI codes", () => {
		expect(sanitizeLine("\x1b[31merror: bad\x1b[0m")).toBe("bad");
	});

	it("removes leading [error] prefix", () => {
		expect(sanitizeLine("[error] something broke")).toBe("something broke");
	});

	it("removes leading error: prefix", () => {
		expect(sanitizeLine("error: type mismatch")).toBe("type mismatch");
	});

	it("removes leading × symbol", () => {
		expect(sanitizeLine("× lint issue")).toBe("lint issue");
	});

	it("removes leading ✓ symbol", () => {
		expect(sanitizeLine("✓ passed")).toBe("passed");
	});

	it("collapses multiple spaces", () => {
		expect(sanitizeLine("a    b")).toBe("a b");
	});

	it("trims surrounding whitespace", () => {
		expect(sanitizeLine("  hello  ")).toBe("hello");
	});
});

describe("sanitizeOutput", () => {
	it("returns empty string for empty input", () => {
		expect(sanitizeOutput("")).toBe("");
	});

	it("returns empty string for non-string input", () => {
		expect(sanitizeOutput(null as any)).toBe("");
	});

	it("strips ANSI codes from all lines", () => {
		const result = sanitizeOutput("\x1b[31merror\x1b[0m\nwarning");
		expect(result).toBe("error\nwarning");
	});

	it("filters out detail lines (stack traces)", () => {
		const output = "error: bad\n    at foo.ts:10\nnote: see here";
		const result = sanitizeOutput(output);
		expect(result).not.toContain("at foo.ts");
		expect(result).not.toContain("note:");
	});

	it("filters out empty lines", () => {
		const result = sanitizeOutput("line1\n\n\nline2");
		expect(result).toBe("line1\nline2");
	});

	it("handles Windows CRLF line endings", () => {
		const result = sanitizeOutput("line1\r\nline2");
		expect(result).toBe("line1\nline2");
	});
});

describe("extractErrorMessage", () => {
	it("returns undefined for empty input", () => {
		expect(extractErrorMessage("")).toBeUndefined();
	});

	it("returns undefined for non-string input", () => {
		expect(extractErrorMessage(null as any)).toBeUndefined();
	});

	it("returns first line containing error indicator", () => {
		const output = "info: starting\nerror: file not found\nother";
		expect(extractErrorMessage(output)).toContain("file not found");
	});

	it("falls back to first non-detail line when no error indicator", () => {
		const output = "    at stack.ts:1\noutput line";
		expect(extractErrorMessage(output)).toBe("output line");
	});
});

describe("truncateMessage", () => {
	it("returns message unchanged when under limit", () => {
		expect(truncateMessage("short", 140)).toBe("short");
	});

	it("truncates with ellipsis when over limit", () => {
		const long = "a".repeat(150);
		const result = truncateMessage(long, 140);
		expect(result).toHaveLength(140);
		expect(result.endsWith("…")).toBe(true);
	});
});

describe("sanitizeTsDiagnostic", () => {
	it("returns empty string for empty input", () => {
		expect(sanitizeTsDiagnostic("")).toBe("");
	});

	it("filters lines with TS error codes", () => {
		const output = "src/foo.ts(10,5): error TS2322: Type mismatch\ninfo line";
		const result = sanitizeTsDiagnostic(output);
		expect(result).toContain("TS2322");
		expect(result).not.toContain("info line");
	});

	it("extracts file:line:col formatted errors", () => {
		const output = "src/foo.ts(10,5): error TS2322: bad type";
		const result = sanitizeTsDiagnostic(output);
		expect(result).toContain("src/foo.ts(10,5)");
	});
});

describe("sanitizeRustOutput", () => {
	it("returns empty string for empty input", () => {
		expect(sanitizeRustOutput("")).toBe("");
	});

	it("keeps error lines", () => {
		const output = "error[E0308]: mismatched types\n  --> src/main.rs:5:10\nnote: ignored";
		const result = sanitizeRustOutput(output);
		expect(result).toContain("mismatched types");
		expect(result).toContain("src/main.rs");
	});
});

describe("sanitizeGoOutput", () => {
	it("returns empty string for empty input", () => {
		expect(sanitizeGoOutput("")).toBe("");
	});

	it("keeps .go: file reference lines", () => {
		const output = "./foo.go:10:5: undefined: bar\nrandom output";
		const result = sanitizeGoOutput(output);
		expect(result).toContain("foo.go");
	});
});

describe("sanitizeBiomeOutput", () => {
	it("returns empty string for empty input", () => {
		expect(sanitizeBiomeOutput("")).toBe("");
	});

	it("parses JSON diagnostics format", () => {
		const json = JSON.stringify({
			diagnostics: [
				{ message: "unused variable", location: { path: "a.ts", span: { start: { line: 0 } } } },
			],
		});
		const result = sanitizeBiomeOutput(json);
		expect(result).toContain("unused variable");
		expect(result).toContain("a.ts");
	});

	it("falls back to text processing for non-JSON", () => {
		const result = sanitizeBiomeOutput("error: something failed");
		expect(result).toContain("something failed");
	});
});

describe("sanitizeRuffOutput", () => {
	it("returns empty string for empty input", () => {
		expect(sanitizeRuffOutput("")).toBe("");
	});

	it("parses JSON array format", () => {
		const json = JSON.stringify([
			{ location: { row: 5, column: 3 }, code: "E501", message: "line too long" },
		]);
		const result = sanitizeRuffOutput(json);
		expect(result).toContain("E501");
		expect(result).toContain("line too long");
	});

	it("falls back to text for non-JSON", () => {
		const result = sanitizeRuffOutput("error: parse failed");
		expect(result).toContain("parse failed");
	});
});

describe("sanitizeToolOutput", () => {
	it("returns undefined fields for empty input", () => {
		const r = sanitizeToolOutput("");
		expect(r.summary).toBeUndefined();
		expect(r.details).toBeUndefined();
		expect(r.truncated).toBe(false);
	});

	it("returns summary and details for normal output", () => {
		const r = sanitizeToolOutput("error: bad thing happened");
		expect(r.summary).toBeDefined();
		expect(r.details).toBeDefined();
	});

	it("sets truncated flag when output exceeds 20 lines", () => {
		const manyLines = Array.from({ length: 25 }, (_, i) => `error: line ${i}`).join("\n");
		const r = sanitizeToolOutput(manyLines);
		expect(r.truncated).toBe(true);
		expect(r.details).toContain("more lines");
	});

	it("does not set truncated for short output", () => {
		const r = sanitizeToolOutput("error: one thing\nerror: two things");
		expect(r.truncated).toBe(false);
	});
});
