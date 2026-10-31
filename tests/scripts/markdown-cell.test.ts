// #4490: CodeQL js/incomplete-sanitization (alerts #65/#66) on the census issue
// body. A test name or error holding `\|` was escaped to `\\|`, which GFM reads
// as an escaped backslash, so the pipe split the table row. The shared escaper
// must keep the row's cell count: the row below has three pipes, the same as a
// row whose cells hold no pipe.
import { describe, expect, it } from "vitest";
import {
	escapeMarkdownCell,
	splitMarkdownRow,
} from "../../scripts/lib/markdown-cell.mjs";

// GFM cell boundaries: a backslash escapes the character after it, and a pipe
// that is not escaped separates cells.
function unescapedPipes(row: string): number {
	let count = 0;
	for (let i = 0; i < row.length; i++) {
		if (row[i] === "\\") i++;
		else if (row[i] === "|") count++;
	}
	return count;
}

describe("escapeMarkdownCell", () => {
	it("keeps the row's cell count when a cell holds a backslash before a pipe", () => {
		const input = "a\\|b";
		const row = `| ${escapeMarkdownCell(input)} | x |`;
		expect(unescapedPipes(row)).toBe(3);
	});

	// Recurrence (#4490 review M2): the row test above passed with a no-op
	// escaper, because its input was already escaped by the author. These pin
	// the exact output, so an identity or a wrong-order escaper reds.
	it("escapes a pipe", () => {
		expect(escapeMarkdownCell("a|b")).toBe("a\\|b");
	});

	it("doubles a lone backslash", () => {
		expect(escapeMarkdownCell("a\\b")).toBe("a\\\\b");
	});

	it("escapes the backslash before the pipe, not after", () => {
		// Input `a\|b`: the backslash doubles first (`a\\|b`), then the pipe
		// is escaped (`a\\\|b`). Pipe-then-backslash would give `a\\|b`,
		// which GFM splits.
		expect(escapeMarkdownCell("a\\|b")).toBe("a\\\\\\|b");
	});
});

// #5070: the reading side. Pairs with the escaper above; the cases are the
// ones the five split("|") sites of check-pr-body.mjs got wrong.
const SPLIT_CASES = [
	["borders are not cells", "| a | b |", ["a", "b"]],
	["borderless rows split too", "a | b", ["a", "b"]],
	["an escaped pipe stays in its cell", "| a \\| b | c |", ["a \\| b", "c"]],
	["a code span does not protect a pipe", "| `x | y` | z |", ["`x", "y`", "z"]],
	[
		"an escaped backslash does not escape the pipe",
		"| a \\\\| b |",
		["a \\\\", "b"],
	],
	["an empty middle cell is kept", "| a | | c |", ["a", "", "c"]],
	["surrounding space is trimmed", "  |  a  |  b  |  ", ["a", "b"]],
] as const;

describe("splitMarkdownRow", () => {
	it.each(SPLIT_CASES)("%s", (_name, row, cells) => {
		expect(splitMarkdownRow(row)).toEqual(cells);
	});

	// Recurrence: a cell escaped for a generated table must come back as one
	// cell, whatever it holds.
	it("reads back one cell for any value escapeMarkdownCell wrote", () => {
		for (const value of [
			"a|b",
			"a\\|b",
			"\\",
			"x\\\\|y",
			"`1 failed | 2 passed`",
		]) {
			expect(
				splitMarkdownRow(`| ${escapeMarkdownCell(value)} | z |`),
			).toHaveLength(2);
		}
	});
});
