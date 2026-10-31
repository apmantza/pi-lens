import { resolve } from "node:path";
import { getDefaults, Lexer } from "marked";
import { describe, expect, it } from "vitest";
import {
	blankMarkdownRegions,
	markdownBlockComments,
	markdownChildren,
	markdownHeadings,
	markdownTokens,
} from "../../scripts/lib/markdown-lexer.mjs";
import {
	assertNonEmptyScan,
	listSourceFiles,
	readWalkedFiles,
	relativePosix,
} from "../support/sweep-kit.js";

// #4717: the markdown gates read headings, comments and code through one
// lexer seam. Four review rounds each found one more spelling the hand-written
// scanner it replaced missed (an inline-code `<!--`, a backtick pair across a
// blank line, a heading inside an unclosed inline comment). These rows pin the
// seam's own contract: where it places the lexer's tokens, and how it fails
// closed when it cannot.

const repositoryRoot = resolve(import.meta.dirname, "../..");

describe("the lexer's raw text covers the source (#4717)", () => {
	// Recurrence it prevents: every region offset is the running sum of the
	// top-level tokens' raw text, so a marked upgrade that drops or rewrites a
	// character would misplace every blanked region silently. This pins the
	// assumption over every documents markdown file and the characters a lexer
	// is most likely to rewrite.
	// One read per walked file (readWalkedFiles drops a path that vanished
	// mid-walk, #3082); dist/ holds build copies of the same documents.
	const documents = readWalkedFiles(
		listSourceFiles(repositoryRoot, {
			extensions: [".md"],
			exclude: (file) => file.startsWith("dist/"),
		}),
	).map(({ file, source }) => [relativePosix(repositoryRoot, file), source]);
	const samples = [
		"﻿## Tests\nx",
		"a\u0000b\n",
		"a\tb\n\tc",
		"x\f\ny",
		"- a\n\t- b\n",
		"> a\n>\n> b",
		"x\n===\n",
		"| a |\n|-|\n",
	];

	it("over every markdown file in the repository and the sample characters", () => {
		assertNonEmptyScan(
			"markdown files under the repository",
			documents.length,
			100,
		);
		const uncovered = [
			...documents,
			...samples.map((text) => [JSON.stringify(text), text]),
		]
			.filter(([, text]) => {
				const source = text.replace(/\r\n?/g, "\n");
				const tokens = new Lexer({ ...getDefaults(), gfm: true }).lex(source);
				return tokens.map((token) => token.raw).join("") !== source;
			})
			.map(([name]) => name);
		expect(uncovered).toEqual([]);
	});
});

describe("markdownHeadings (#4717)", () => {
	it("reads ATX, closed ATX, indented ATX and setext headings", () => {
		expect(
			markdownHeadings(
				"## One\nx\n\n   ## Two ##\ny\n\nThree\n-----\nz\n\n# Four\n",
			),
		).toEqual([
			{ line: 0, contentLine: 1, depth: 2, text: "One" },
			{ line: 3, contentLine: 4, depth: 2, text: "Two" },
			{ line: 6, contentLine: 8, depth: 2, text: "Three" },
			{ line: 10, contentLine: 11, depth: 1, text: "Four" },
		]);
	});

	it.each([
		["a comment", "<!--\n## Tests\n-->"],
		["a raw-HTML block", "<details>\n## Tests\n</details>"],
		["a type-7 HTML block", "<span>\n## Tests"],
		["a list item", "- ## Tests"],
		["a block quote", "> ## Tests"],
		["indented code", "para\n\n    ## Tests"],
		["a fence", "```\n## Tests\n```"],
	])("is not a section inside %s", (_name, markdown) => {
		expect(markdownHeadings(markdown)).toEqual([]);
	});

	it("names a heading by its rendered text (#4717 N7)", () => {
		// Recurrence it prevents: the name was the heading's source text, so
		// `## Tests <!-- note -->` or `## **Tests**` named no section.
		expect(
			markdownHeadings(
				"## Tests <!-- note -->\n## **Bold** [link](u) `code` *em*\n## *Nested <!-- note -->*\n",
			).map((heading) => heading.text),
		).toEqual(["Tests", "Bold link code em", "Nested"]);
	});

	it("drops a heading a comment left open in a list item hides (#4717 N6)", () => {
		expect(markdownHeadings("- item\n  <!--\n## Tests\nx")).toEqual([]);
	});

	it("counts lines over CRLF text", () => {
		expect(markdownHeadings("x\r\n\r\n## Tests\r\ny")).toEqual([
			{ line: 2, contentLine: 3, depth: 2, text: "Tests" },
		]);
	});
});

describe("markdownBlockComments (#4774)", () => {
	it("names the first line of each top-level comment block", () => {
		expect(
			markdownBlockComments(
				"Text.\n\n<!-- one -->\n\nMore.\n\n  <!--\ntwo\n-->",
			),
		).toEqual([2, 6]);
	});

	// Recurrence it prevents: a scan for `<!--` read a quoted opener as the start
	// of a bot block and cut the author's last section short.
	it.each([
		["a fence", "```html\n<!-- x -->\n```"],
		["a code span", "Reads `<!-- x -->` here."],
		["inline text", "Text <!-- x --> more."],
		["a list item", "- item\n  <!-- x -->"],
		["a block quote", "> <!-- x -->"],
		["indented code", "para\n\n    <!-- x -->"],
	])("is blind to a comment in %s", (_name, markdown) => {
		expect(markdownBlockComments(markdown)).toEqual([]);
	});

	it("is blind to a raw-HTML block that is not a comment", () => {
		expect(markdownBlockComments("<details>\nx\n</details>")).toEqual([]);
	});

	// A comment a list item leaves open hides the top-level comment that closes
	// it (#4717 N6), so that block is no marker of a bot.
	it("is blind to a comment an earlier open comment hides", () => {
		expect(markdownBlockComments("- item\n  <!--\n\n<!-- later -->")).toEqual(
			[],
		);
	});

	it("counts lines over CRLF text", () => {
		expect(markdownBlockComments("x\r\n\r\n<!-- c -->\r\ny")).toEqual([2]);
	});
});

describe("blankMarkdownRegions (#4717)", () => {
	it("keeps raw-HTML blocks under html: comments and drops them under html: blocks", () => {
		const text = "<details>\nvisible\n</details>\n\n<!-- hidden -->";
		const comments = blankMarkdownRegions(text, { html: "comments" });
		expect(comments).toContain("visible");
		expect(comments).not.toContain("hidden");
		expect(blankMarkdownRegions(text, { html: "blocks" })).not.toContain(
			"visible",
		);
	});

	it.each([
		["a raw-HTML block", "<details>\n<!-- hidden -->\nb\n</details>", "b"],
		["a block comment's line", "<!-- hidden --> b", "b"],
		["a block quote", "> a <!-- hidden -->\n> b", "b"],
		["a list item", "- a <!-- hidden -->\n- b", "b"],
		["a table cell", "| a | <!-- hidden --> |\n| - | - |\n| b | c |", "b"],
		["a heading", "## A <!-- hidden --> B\nb", "B"],
	])("hides only the comment inside %s", (_name, markdown, kept) => {
		const out = blankMarkdownRegions(markdown, { html: "comments" });
		expect(out).not.toContain("hidden");
		expect(out).toContain(kept);
		expect(out).toHaveLength(markdown.length);
	});

	it("blanks a nested fence in a list item and keeps the item text", () => {
		const out = blankMarkdownRegions("- item\n  ```\n  secret\n  ```\n", {
			code: "blocks",
		});
		expect(out).toContain("item");
		expect(out).not.toContain("secret");
	});

	it("keeps indented code under code: fenced", () => {
		const text = "para\n\n    indented\n\n```\nfenced\n```";
		const out = blankMarkdownRegions(text, { code: "fenced" });
		expect(out).toContain("indented");
		expect(out).not.toContain("fenced");
	});

	it("blanks a whole table whose code span it cannot place (fail closed)", () => {
		// Recurrence it prevents: a table cell's `\|` reaches the lexer as `|`,
		// so the span's raw text is not in the source. Skipping it would leave
		// the code span visible to a gate that asked for code spans blanked.
		const out = blankMarkdownRegions("| `a\\|b` | y |\n| - | - |\n| x | z |", {
			codeSpans: true,
		});
		expect(out).not.toContain("a\\|b");
		expect(out.trim()).toBe("");
	});

	it("blanks the table when only a later copy matches its cell (#4717 N4)", () => {
		// Recurrence it prevents: placement searched the whole rest of the
		// text, so a later `a|b` placed the cell's span outside the table and
		// the escaped cell stayed visible.
		const out = blankMarkdownRegions(
			"| `a\\|b` | y |\n| - | - |\n\nLater `a|b` copy.",
			{ codeSpans: true },
		);
		expect(out).toBe(
			`${" ".repeat(14)}\n${" ".repeat(9)}\n\nLater       copy.`,
		);
	});

	it("places each of two identical items on its own line (#4717 N5)", () => {
		// Recurrence it prevents: a placement that ignored the cursor put the
		// second item's comment on the first copy and left it visible.
		expect(
			blankMarkdownRegions("- <!-- same -->\n- <!-- same -->\nafter", {
				html: "comments",
			}),
		).toBe(`-${" ".repeat(14)}\n-${" ".repeat(14)}\nafter`);
	});

	it.each([
		[
			"a list item's unterminated comment hides to the end",
			"- item\n  <!--\n## Tests\nhidden",
			"- item\n      \n        \n      ",
		],
		[
			"a second comment left open on a block comment's line",
			"<!-- a --> <!-- b\n## Tests\n\n<!-- c --> d",
			`${" ".repeat(17)}\n${" ".repeat(8)}\n\n${" ".repeat(11)}d`,
		],
		[
			"an escaped `-->` in a code span ends nothing",
			"- item\n  <!--\n\nText `-->` tail",
			"- item\n      \n\n               ",
		],
	])(
		"carries an open comment past its token: %s (#4717 N6)",
		(_name, text, out) => {
			// Recurrence it prevents: a comment a token left open was hidden only
			// inside that token, while GitHub hides everything up to the next raw
			// `-->` (a later HTML token) or the end of the text.
			expect(blankMarkdownRegions(text, { html: "comments" })).toBe(out);
		},
	);

	it("hides a comment whose copy sits in an earlier link destination", () => {
		// Recurrence it prevents: the link's destination is text no child token
		// covers, so a cursor that only moved past the children found the
		// comment's copy there, blanked it, and left the real comment visible.
		const out = blankMarkdownRegions("[a](u<!--z-->)<!--z--> tail", {
			html: "comments",
		});
		expect(out).toBe(`[a](u<!--z-->)${" ".repeat(8)} tail`);
	});

	it("never turns a blanked line start into indented code", () => {
		// Recurrence it prevents: a second lex of the blanked text read the
		// spaces left before a comment's visible tail as an indented code block
		// and blanked the tail too (#4565's evidence line).
		expect(
			blankMarkdownRegions("<!-- note --> after", {
				html: "comments",
				code: "blocks",
			}),
		).toBe(`${" ".repeat(13)} after`);
	});

	it("keeps a lone CR and CRLF line end where they were", () => {
		const text = "a <!-- x -->\rb\r\nc";
		const out = blankMarkdownRegions(text, { html: "comments" });
		expect(out).toHaveLength(text.length);
		expect(out).toBe(`a ${" ".repeat(10)}\rb\r\nc`);
	});

	it("blanks nothing when the mode names nothing", () => {
		const text = "## A\n<!-- c -->\n`x`\n```\ny\n```";
		expect(blankMarkdownRegions(text, {})).toBe(text);
	});
});

describe("the top-level token walk the PR-body budgets read (#5026)", () => {
	// Recurrence it prevents: the budgets assign a token to a section by its
	// first line. A token whose line drifted (CRLF, a multi-line token before
	// it) would count a section's text under the wrong heading, and a budget
	// that does not see a list's items or a table's cells would charge nothing
	// for them.
	it("places each top-level token on its first line, CRLF included", () => {
		const text =
			"# A\r\npara\r\nmore\r\n\r\n- x\r\n- y\r\n\r\n```\r\nc\r\n```\r\n";
		expect(
			markdownTokens(text).map(({ token, line }) => [token.type, line]),
		).toEqual([
			["heading", 0],
			["paragraph", 1],
			["space", 2],
			["list", 4],
			["space", 5],
			["code", 7],
		]);
	});

	it("opens a list's items and a table's cells as children", () => {
		const [list, , table] = markdownTokens(
			"- a\n- b\n\n| h |\n| - |\n| c |",
		).map(({ token }) => token);
		expect(markdownChildren(list).map((item) => item.type)).toEqual([
			"list_item",
			"list_item",
		]);
		expect(markdownChildren(table).map((cell) => cell.text)).toEqual([
			"h",
			"c",
		]);
	});
});
