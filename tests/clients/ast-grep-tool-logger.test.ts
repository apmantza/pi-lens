import { describe, expect, it } from "vitest";
import {
	_countLinesForTest,
	astGrepRemediationHint,
	classifyAstGrepError,
} from "../../clients/ast-grep-tool-logger.js";

describe("classifyAstGrepError", () => {
	it("maps the wrapped 'Multiple AST nodes' error to multiple_ast_nodes", () => {
		// sg-runner.ts wraps the raw stderr inside a friendlier message; we
		// want both the wrapper text and the raw stderr to classify the same.
		expect(
			classifyAstGrepError(
				"Invalid AST pattern: The pattern appears to contain multiple AST nodes or is malformed.\nOriginal error: Multiple AST nodes are detected",
			),
		).toBe("multiple_ast_nodes");

		expect(
			classifyAstGrepError("Multiple AST nodes are detected in the pattern."),
		).toBe("multiple_ast_nodes");
	});

	it("maps 'Cannot parse query' (and its wrapper) to cannot_parse_query", () => {
		expect(classifyAstGrepError("Cannot parse query: unexpected token")).toBe(
			"cannot_parse_query",
		);
		expect(
			classifyAstGrepError(
				"Pattern syntax error: The pattern could not be parsed as valid code.\nOriginal error: Cannot parse query",
			),
		).toBe("cannot_parse_query");
	});

	it("maps ENOENT / CLI-not-found to tool_not_found", () => {
		expect(
			classifyAstGrepError(
				"ast-grep CLI not found. Install: npm i -D @ast-grep/cli",
			),
		).toBe("tool_not_found");
		expect(classifyAstGrepError("spawn ast-grep ENOENT")).toBe(
			"tool_not_found",
		);
	});

	it("maps timeout-shaped messages to timeout", () => {
		expect(classifyAstGrepError("Command timed out after 30000ms")).toBe(
			"timeout",
		);
		expect(classifyAstGrepError("timeout exceeded")).toBe("timeout");
	});

	it("maps JSON parse failures to json_parse_failed", () => {
		expect(classifyAstGrepError("Failed to parse output")).toBe(
			"json_parse_failed",
		);
	});

	it("returns 'other' for unrecognised error shapes — never throws", () => {
		expect(classifyAstGrepError("some completely unexpected failure")).toBe(
			"other",
		);
		expect(classifyAstGrepError(undefined)).toBe("other");
		expect(classifyAstGrepError("")).toBe("other");
	});

	it("is case-insensitive so log analyses are not skewed by casing variants", () => {
		expect(classifyAstGrepError("MULTIPLE AST NODES are detected")).toBe(
			"multiple_ast_nodes",
		);
	});
});

describe("astGrepRemediationHint", () => {
	it("returns null for the two categories sg-runner already curates", () => {
		// Avoid doubling up — the error text already carries multi-line guidance.
		expect(astGrepRemediationHint("multiple_ast_nodes")).toBeNull();
		expect(astGrepRemediationHint("cannot_parse_query")).toBeNull();
	});

	it("gives an install hint for tool_not_found", () => {
		expect(astGrepRemediationHint("tool_not_found")).toContain("@ast-grep/cli");
	});

	it("gives a scoping hint for timeout", () => {
		expect(astGrepRemediationHint("timeout")).toMatch(/timed out/i);
		expect(astGrepRemediationHint("timeout")).toMatch(/paths/);
	});

	it("gives a retry hint for json_parse_failed", () => {
		expect(astGrepRemediationHint("json_parse_failed")).toMatch(/parsed/i);
	});

	it("gives a generic single-node hint for 'other'", () => {
		const hint = astGrepRemediationHint("other");
		expect(hint).toMatch(/single valid AST node|ast_grep_dump|grep/i);
	});

	it("classify → hint composes: raw stderr 'other' yields the generic hint", () => {
		// The exact failure from the log: an empty --rewrite value.
		const raw =
			"error: a value is required for '--rewrite <FIX>' but none was supplied";
		expect(astGrepRemediationHint(classifyAstGrepError(raw))).toMatch(
			/single valid AST node/,
		);
	});

	it("classify → hint composes: a wrapped multiple-nodes error adds no extra hint", () => {
		const raw =
			"Invalid AST pattern: ...\nOriginal error: Multiple AST nodes are detected";
		expect(astGrepRemediationHint(classifyAstGrepError(raw))).toBeNull();
	});
});

describe("_countLinesForTest (line counting helper)", () => {
	it("returns 0 for empty input", () => {
		expect(_countLinesForTest("")).toBe(0);
	});

	it("returns 1 for a single line without a newline", () => {
		expect(_countLinesForTest("foo")).toBe(1);
	});

	it("counts trailing newlines as starting a (possibly empty) next line", () => {
		expect(_countLinesForTest("foo\n")).toBe(2);
		expect(_countLinesForTest("foo\nbar")).toBe(2);
		expect(_countLinesForTest("a\nb\nc\nd")).toBe(4);
	});

	it("returns undefined for undefined input", () => {
		expect(_countLinesForTest(undefined)).toBeUndefined();
	});
});
