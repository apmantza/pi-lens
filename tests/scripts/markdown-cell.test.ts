// #4490: CodeQL js/incomplete-sanitization (alerts #65/#66) on the census issue
// body. A test name or error holding `\|` was escaped to `\\|`. A reader that
// counts backslashes (marked) reads that as an escaped backslash and splits the
// row; GitHub keeps one cell but drops the backslash (#5026 r5 probe). The
// shared escaper must keep the row's cell count for either reader: the row below
// has three pipes, the same as a row whose cells hold no pipe.
import { describe, expect, it } from "vitest";
import {
	escapeMarkdownCell,
	splitMarkdownRow,
} from "../../scripts/lib/markdown-cell.mjs";

// Cell boundaries as a backslash-counting reader (marked) sees them: a
// backslash escapes the character after it, and any other pipe separates cells.
// GitHub is laxer (no pipe after a backslash splits), so this is the stricter
// count.
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
	// #5026 r4 verify N3: `gh api markdown -f mode=gfm` keeps `x \\| y` and
	// `x \\\| y` in one cell and splits `p\\ | q`: on GitHub a pipe right after
	// any backslash never splits, whatever the backslash count.
	[
		"a pipe after two backslashes stays in its cell",
		"| a \\\\| b |",
		["a \\\\| b"],
	],
	[
		"a pipe after three backslashes stays in its cell",
		"| a \\\\\\| b |",
		["a \\\\\\| b"],
	],
	[
		"a backslash before a space does not protect the pipe",
		"| p\\\\ | q |",
		["p\\\\", "q"],
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
