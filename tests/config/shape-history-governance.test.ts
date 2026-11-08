import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	blankMarkdown,
	issueNumbers,
	parseDefectShapes,
} from "../../scripts/lib/defect-shapes.mjs";

// Recurrence (#4439): shapes 67 and 68 entered the defect-shape catalog on
// 2026-10-14 with no HISTORY.md entry, and nothing checked it. The retro
// contract (`docs/pi-lens-retro.md` step 4) puts each shape's issues and PRs in
// HISTORY.md, because the catalog stays lean (agents-governance.test.ts keeps
// its reference count from growing). A shape has history when HISTORY.md, read
// as comment-blanked markdown, carries one of the shape's own issue or PR
// numbers from its catalog entry, or a heading naming `shape N`.
//
// #4361: the numbered entries moved out of AGENTS.md into
// docs/defect-shapes.md, which keeps AGENTS.md's index from carrying them. The
// scan reads the file that holds the entries.

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

const read = (file: string, env?: string): string =>
	fs.readFileSync(
		(env && process.env[env]) || path.join(REPO_ROOT, file),
		"utf8",
	);

/** Catalog shape numbers with no entry in `history`, ascending. */
function shapesWithoutHistory(catalog: string, history: string): number[] {
	const blanked = blankMarkdown(history);
	const referenced = issueNumbers(blanked);
	const headed = new Set(
		// An ATX heading needs a space after its marks, and the number sits on the
		// heading's own line: a prose line opening with an issue reference
		// ("#4527's ... Shape" / "31") once counted as a heading naming shape 31.
		[...blanked.matchAll(/^#{1,6}[ \t][^\n]*\bshape[ \t]+(\d+)\b/gim)].map(
			(match) => Number(match[1]),
		),
	);
	return [...parseDefectShapes(catalog)]
		.filter(
			([number, entry]) =>
				!headed.has(number) &&
				![...issueNumbers(entry)].some((issue) => referenced.has(issue)),
		)
		.map(([number]) => number)
		.sort((a, b) => a - b);
}

/**
 * The two baseline guards: `added` are uncovered shapes outside the baseline
 * (a new shape without history), `stale` are baseline shapes that gained
 * history (the baseline only shrinks).
 */
function baselineViolations(
	uncovered: readonly number[],
	baseline: readonly number[],
): { added: number[]; stale: number[] } {
	return {
		added: uncovered.filter((n) => !baseline.includes(n)),
		stale: baseline.filter((n) => !uncovered.includes(n)),
	};
}

// Shrink-only baseline: the 57 shapes without HISTORY.md coverage when #4439
// landed (2026-10-14). Backfill a shape's history, then delete its number here;
// never add one. A new shape lands with its HISTORY.md entry. #4361 backfilled
// 31, 54, 60, 61, 63 and 64 with the stories it moved out of the catalog.
const NO_HISTORY_BASELINE: readonly number[] = [
	2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 22, 23, 24,
	25, 26, 27, 28, 29, 30, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44,
	45, 46, 47, 48, 51, 55, 57, 58, 59, 65, 66,
];

describe("catalog shapes have a HISTORY.md entry (#4439)", () => {
	const catalog = read("docs/defect-shapes.md");
	const history = read("HISTORY.md", "PI_LENS_HISTORY_PATH");
	const uncovered = shapesWithoutHistory(catalog, history);

	const { added, stale } = baselineViolations(uncovered, NO_HISTORY_BASELINE);

	it("lets no shape outside the baseline lack a HISTORY.md entry", () => {
		expect(
			added,
			`shape(s) ${added.join(", ")} in docs/defect-shapes.md have no HISTORY.md entry: give each a HISTORY.md section whose heading names it, such as "## 2026-10-14 - model switch drift (shape 68)" (retro step 4), or cite one of its own issues there; never add to the baseline`,
		).toEqual([]);
	});

	it("keeps the baseline shrink-only: a covered shape leaves it", () => {
		expect(
			stale,
			`shape(s) ${stale.join(", ")} now have history: delete them from NO_HISTORY_BASELINE`,
		).toEqual([]);
	});

	it("lists only catalog shapes, once each, ascending", () => {
		const parsed = parseDefectShapes(catalog);
		expect(NO_HISTORY_BASELINE.filter((n) => !parsed.has(n))).toEqual([]);
		expect([...NO_HISTORY_BASELINE]).toEqual(
			[...new Set(NO_HISTORY_BASELINE)].sort((a, b) => a - b),
		);
	});

	it("parses the whole catalog, so the scan is not vacuous", () => {
		expect(parseDefectShapes(catalog).size).toBeGreaterThanOrEqual(68);
	});
});

describe("blankMarkdown options (#4439)", () => {
	const text = "para\n\n    indented\n";

	it("blanks an indented block by default", () => {
		expect(blankMarkdown(text).trim()).toBe("para");
	});

	it("keeps an indented block when indentedCode is false", () => {
		expect(blankMarkdown(text, { indentedCode: false })).toContain("indented");
	});

	it("keeps a list item's indented continuation, which is content", () => {
		// GitHub renders `- item\n\n    indented` as a second paragraph of the
		// item, not as code; the hand scanner this replaced blanked it (#4717).
		expect(blankMarkdown("- item\n\n    indented\n")).toContain("indented");
	});
});

// Recurrence (#4565): the comment rule knew `-->` alone, so it blanked every
// line after a comment GitHub had already closed, and a gating rule then read
// a visible answer as absent. Each row names one end the renderer gives an
// inline comment, read by the lexer (#4717); a line that opens with `<!--` is a
// raw-HTML block instead, which the next describe pins.
describe("blankMarkdown comment ends (#4565)", () => {
	const hidden = (markdown: string) => blankMarkdown(markdown);

	it("keeps an inline `<!-- … --!>` literal, as GitHub renders it", () => {
		// GitHub prints `<!-- secret --!>` as text: `--!>` ends no inline comment.
		const out = hidden("text <!-- secret --!> visible");
		expect(out).toContain("secret");
		expect(out).toContain("visible");
	});

	it("reads `<!-->` as a complete empty comment", () => {
		expect(hidden("text <!-->visible")).toContain("visible");
		expect(blankMarkdown("<!-->")).toBe("     ");
	});

	it("reads `<!--->` as a complete empty comment", () => {
		expect(hidden("text <!--->visible")).toContain("visible");
		expect(blankMarkdown("<!--->")).toBe("      ");
	});

	it("does not end a comment at `--!` without the `>`", () => {
		const out = hidden("text <!-- secret --! still hidden --> tail");
		expect(out).not.toContain("still hidden");
		expect(out).toContain("tail");
	});

	it("keeps the `-->` end and the unterminated tail", () => {
		expect(hidden("text <!-- secret --> visible")).toContain("visible");
		expect(hidden("<!-- secret\nhidden")).not.toContain("hidden");
	});

	it("keeps a comment opener inside a fence literal", () => {
		// An opener in a fence is code, so it cannot swallow the visible line
		// after the fence.
		expect(hidden("```\n<!--\n```\nvisible")).toContain("visible");
	});

	it("keeps the line count and every line's length", () => {
		const out = hidden("<!-->\nafter");
		expect(out.split("\n")).toHaveLength(2);
		expect(out.split("\n")[0]).toHaveLength(5);
		expect(out).toContain("after");
	});
});

// Recurrence (#4717 V1, V4, V5, B6): the hand scanner matched `<!--` at any
// offset, then paired backticks across paragraphs, then missed that a heading
// ends a paragraph, and read `--!>` as a block end; each review round found one
// more spelling. The lexer decides now: a line opening `<!--` (after at most
// three spaces, or inside a list item) starts a raw-HTML block that runs to the
// line holding `-->` or to the end of its container, and an inline opener is a
// comment only when the lexer closes it inside its paragraph. Every other
// spelling is literal text, as GitHub renders it.
describe("blankMarkdown comment openers (#4717 V1)", () => {
	const hidden = (markdown: string) => blankMarkdown(markdown);

	it.each([
		["at a line start", "<!--"],
		["after three spaces of indent", "   <!--"],
	])("hides a block comment %s", (_name, opener) => {
		const out = hidden(`${opener}\nhidden\n-->.\nvisible`);
		expect(out).not.toContain("hidden");
		expect(out).toContain("visible");
	});

	it("runs an unterminated block comment to the end of the text", () => {
		// CommonMark's HTML block ends at the end of the document when no closer
		// follows, so the heading below stays hidden.
		expect(hidden("   <!--\n## Fold check")).not.toContain("Fold check");
	});

	it.each([
		["-->", "<!-- note --> after"],
		["--!>", "<!-- note --!> after"],
		["<!-->", "<!--> after"],
		["<!--->", "<!---> after"],
	])(
		"keeps the text after a block comment's %s end on its line (#4565)",
		(_name, line) => {
			// GitHub prints the block's text after the comment: the browser ends a
			// comment at each of these, whatever the markdown block around it.
			const out = hidden(`${line}\n\nnext`);
			expect(out).not.toContain("note");
			expect(out).toContain("after");
			expect(out).toContain("next");
		},
	);

	it("hides only the comment of a block that `--!>` ends (B6)", () => {
		// No `-->` line ends the HTML block, so it runs to the end and GitHub
		// renders no heading after it (the sections test pins that through the
		// lexer's headings); the browser still shows the block's text after
		// `--!>`, as raw text.
		const out = hidden("<!--\nhidden\n--!>\n\n## Tests\nx");
		expect(out).not.toContain("hidden");
		expect(out).toContain("## Tests");
	});

	it("hides an inline comment that closes in its own paragraph", () => {
		const out = hidden("text <!-- hidden -->\nvisible");
		expect(out).not.toContain("hidden");
		expect(out).toContain("visible");
	});

	it.each([
		["has no end at all", "text <!-- literal\nvisible"],
		[
			"closes only past a blank line",
			"text <!-- literal\n\n--> later\nvisible",
		],
		[
			"closes only past a heading (V5)",
			"text <!-- literal\n## visible\nlater -->",
		],
		[
			"closes only past a heading, CRLF (V5)",
			"text <!-- literal\r\n## visible\r\nlater -->",
		],
	])("keeps an inline opener literal when it %s", (_name, markdown) => {
		const out = hidden(markdown);
		expect(out).toContain("literal");
		expect(out).toContain("visible");
	});

	it.each([
		["unclosed", "text `<!--` literal\nvisible"],
		["with its end inside the span", "text `<!-- note --> now`\nvisible"],
	])("never opens a comment in a backtick span (%s)", (_name, markdown) => {
		const out = hidden(markdown);
		expect(out).toContain("`<!--");
		expect(out).toContain("visible");
	});

	it.each([
		["LF", "\n"],
		["CRLF", "\r\n"],
	])(
		"never pairs backticks across a blank line around a block comment (V4, %s)",
		(_name, eol) => {
			const out = hidden(
				[
					"One stray ` backtick.",
					"",
					"<!--",
					"## Tests",
					"hidden",
					"-->",
					"",
					"Another stray ` backtick.",
				].join(eol),
			);
			expect(out).not.toContain("## Tests");
			expect(out).toContain("Another stray");
		},
	);

	it("never lets a backtick inside one comment shield the next comment (V4)", () => {
		const out = hidden(
			"<!-- one ` tick -->\n\n<!-- two ` tick\n## Tests\nhidden\n-->",
		);
		expect(out).not.toContain("## Tests");
	});

	it("reads a 4-space opener continuing a paragraph as literal text (B5)", () => {
		// A 4-space line cannot open an HTML block or interrupt a paragraph, so
		// its `<!--` is inline and unclosed, and the heading below renders.
		const out = hidden("para\n    <!--\n## visible");
		expect(out).toContain("para");
		expect(out).toContain("## visible");
	});

	it("hides a comment opener inside a list item", () => {
		// The catalog fixture `    <!-- (#100)` is this shape: inside a list item
		// the opener starts an HTML block, so its issue reference never counts.
		expect(hidden("- para\n  <!--\n  hidden")).not.toContain("hidden");
	});

	it("keeps CRLF line ends and every line's length", () => {
		const text = "a <!-- x -->\r\nb\r\n";
		const out = hidden(text);
		expect(out).toHaveLength(text.length);
		expect(out.split("\r\n")).toEqual(["a" + " ".repeat(11), "b", ""]);
	});
});

describe("baselineViolations (#4439)", () => {
	// Recurrence (#4448 review F2): both guards survived neutering because only
	// an env override on the real files ever exercised them.
	it("flags an uncovered shape that is not in the baseline", () => {
		expect(baselineViolations([2, 69], [2, 3])).toEqual({
			added: [69],
			stale: [3],
		});
	});

	it("flags nothing when the uncovered shapes equal the baseline", () => {
		expect(baselineViolations([2, 3], [2, 3])).toEqual({
			added: [],
			stale: [],
		});
	});

	it("flags a baseline shape that gained history", () => {
		expect(baselineViolations([2], [2, 67])).toEqual({
			added: [],
			stale: [67],
		});
	});
});

describe("shapesWithoutHistory (#4439)", () => {
	const catalog = (...entries: string[]): string =>
		`## Recurring defect shapes\n\n${entries.join("\n\n")}\n\n## Next\n`;
	const shape = (n: number, text: string) => `${n}. **Shape ${n}:** ${text}`;

	it("ends a catalog entry at the next unindented line", () => {
		// Recurrence: text after an entry (a block tag, a heading) is not the
		// entry's, so a reference there, even on an indented line, must not
		// count as the shape's own.
		const agents = catalog(shape(1, "old.\n    continued (#100)."));
		const trailing = agents.replace(
			"\n\n## Next",
			"\nunindented prose\n    indented #200\n\n## Next",
		);
		expect(parseDefectShapes(trailing).get(1)).toContain("#100");
		expect(parseDefectShapes(trailing).get(1)).not.toContain("#200");
	});

	it("flags a new shape that HISTORY.md never mentions", () => {
		// Recurrence: shapes 67 and 68 landed with no HISTORY.md entry.
		const agents = catalog(shape(1, "old (#100)."), shape(69, "new (#900)."));
		expect(
			shapesWithoutHistory(agents, "# HISTORY\n\nPR #100 landed.\n"),
		).toEqual([69]);
	});

	it("accepts one of the shape's own issue references", () => {
		const agents = catalog(shape(1, "old (#100, #101)."));
		expect(shapesWithoutHistory(agents, "Fixed in #101.")).toEqual([]);
	});

	it("accepts a heading naming the shape when the entry cites no issue", () => {
		const agents = catalog(shape(7, "no issue number here."));
		expect(shapesWithoutHistory(agents, "## 2026-10-14 (shape 7)\n")).toEqual(
			[],
		);
	});

	it("ignores a shape number in prose that is not a heading", () => {
		const agents = catalog(shape(7, "no issue number here."));
		expect(shapesWithoutHistory(agents, "A relative of shape 7.\n")).toEqual([
			7,
		]);
	});

	// Recurrence (#4601 compliance F1): a prose line opening with an issue
	// reference and wrapping before the number ("#4527's ... Shape" / "31")
	// counted as a heading naming shape 31, so shape 31 left the baseline.
	it.each([
		["a line opening with an issue reference", "#4527's save. Shape 7 asks.\n"],
		["a number wrapped onto the next line", "## Retro, see shape\n7 below\n"],
	])("ignores %s as a heading naming the shape", (_name, history) => {
		const agents = catalog(shape(7, "no issue number here."));
		expect(shapesWithoutHistory(agents, history)).toEqual([7]);
	});

	it("is not satisfied by a reference or heading inside an HTML comment", () => {
		const agents = catalog(shape(1, "old (#100)."), shape(7, "no issue."));
		const history =
			"<!-- #100 -->\n<!--\n## Retro (shape 7)\n-->\nplain text\n";
		expect(shapesWithoutHistory(agents, history)).toEqual([1, 7]);
	});

	// Recurrence (#4448 review F1): the first blanker handled only column-0
	// backtick fences and terminated comments, so each of these covered a
	// shape from text GitHub renders as code or hides.
	it.each([
		["a backtick fence", "```\n#100\n```\n"],
		["an indented fence in a list", "- item\n  ```\n  #100\n  ```\n"],
		["a tilde fence", "~~~\n#100\n~~~\n"],
		["a four-backtick fence", "````md\n```\nx\n```\n#100\n````\n"],
		[
			"a four-backtick fence that holds a short fence line",
			"````md\n```\n#100\n````\n",
		],
		["an unterminated comment", "<!-- #100\n"],
	])("is not satisfied by a reference in %s", (_name, history) => {
		const agents = catalog(shape(1, "old (#100)."));
		expect(shapesWithoutHistory(agents, history)).toEqual([1]);
	});

	it("is not satisfied by a shape heading inside a tilde fence", () => {
		const agents = catalog(shape(1, "no issue."));
		expect(
			shapesWithoutHistory(agents, "~~~\n## Retro (shape 1)\n~~~\n"),
		).toEqual([1]);
	});

	it("does not read a reference from a fence or unterminated comment in an entry", () => {
		for (const hidden of ["    ~~~\n    (#100)\n    ~~~", "    <!-- (#100)"])
			expect(
				shapesWithoutHistory(
					catalog(shape(1, `old.\n${hidden}`)),
					"Fixed in #100.",
				),
			).toEqual([1]);
	});

	it("keeps the heading route working beside the new blanker", () => {
		const agents = catalog(shape(1, "no issue."));
		expect(shapesWithoutHistory(agents, "## Retro (shape 1)\n")).toEqual([]);
	});

	it("does not read a reference from a comment in the catalog entry", () => {
		const agents = catalog(shape(1, "old.\n    <!-- #100 -->"));
		expect(shapesWithoutHistory(agents, "Fixed in #100.")).toEqual([1]);
	});
});
