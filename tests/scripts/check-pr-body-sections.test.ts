import { describe, expect, it } from "vitest";
import {
	lintClassSweep,
	lintFoldCheck,
	lintLocalPrBody,
	lintPrBody,
} from "../../scripts/check-pr-body.mjs";

// #4717: a required section exists only where the reader sees one. Each round
// of #4717 found a body whose section list the hand-written comment and
// code-span scanner read differently from GitHub, in both directions: a
// hidden section counted (V4: a backtick pair across a blank line shielded a
// block comment) and a visible one went missing (V5: a heading inside an
// unclosed inline comment). The lexer seam (`scripts/lib/markdown-lexer.mjs`)
// reads the body now. Every row below is a body class from the round-4 state
// table; its expected section list is GitHub's own gfm render of that body
// (`POST /markdown`, recorded 2026-10-21), an oracle independent of the code,
// except where a row says the lint departs from it by decision.
//
// #5026: the host text of a row that opens a raw-HTML block, a fence or a nested
// heading sits under `## Detail`, because the Summary admits plain paragraphs.
//
// #4717 F2: a row must fail on the code that carried the defect it names, so
// `I3` and `I5` place the closing `-->` after `## Tests`: a closer inside the
// Summary paragraph satisfied the reviewed head's comment scan too, and the
// row proved nothing. Both now red on 0186fefbd, the source of the V1 defect
// they cite (`Tests 5 failed`, quoted in the PR body); the rest of the family
// reds on 8ef319af3. The 4-space-opener-after-a-blank-line row is gone: its
// claim lives in `marked`'s block tokenizer, so no source in this series and
// no hand mutation of this tree reds it, and `B5` keeps the family's indented
// opener red-able.

const SECTIONS = [
	"Summary",
	"Tests",
	"Class sweep",
	"Observability",
	"Fold check",
];
const HEAD = [
	"## Why",
	"The body gate reads the sections a reader sees.",
	"",
	"## Notes for the reviewer",
	"- None.",
	"",
	"## Change outline",
	"- scripts/check-pr-body.mjs",
	"",
	"## Proof and checks",
	"The proof sections follow.",
	"",
	"## Summary",
].join("\n");
const TAIL = [
	"## Blast radius",
	"No runtime module touched.",
	"",
	"## Class sweep",
	'Defect shape: x. Search: `rg -n "x" scripts`. Verdict: folded onto the lexer.',
	"Alignment: none: this fixture touches no family.",
	"",
	"## Observability",
	"No new failure path; no record added.",
	"",
	"## Fold check",
	"#4606 not folded: a different file and a separate rule.",
].join("\n");
const body = (middle: string) => `${HEAD}\n${middle}\n\n${TAIL}`;
const crlf = (text: string) => text.replace(/\r?\n/g, "\r\n");
const TESTS = "## Tests\nTargeted tests pass.";
const AFTER_SUMMARY = ["Class sweep", "Observability", "Fold check"];
const stub = (): string => "";

const missing = (errors: string[]) =>
	SECTIONS.filter((name) =>
		errors.some((error) => error.includes(`missing "## ${name}"`)),
	);

// [case, body, sections GitHub does not render]
const cases: Array<[string, string, string[]]> = [
	[
		"B1 a closed block comment hides ## Tests (F1)",
		body("Text.\n\n<!--\n## Tests\nhidden\n-->"),
		["Tests"],
	],
	[
		"B2 an unclosed block opener hides the rest",
		body("Text.\n\n<!--\n## Tests\nhidden"),
		["Tests", ...AFTER_SUMMARY],
	],
	[
		"B3 a 3-space block opener hides the rest",
		body("Text.\n\n   <!--\n## Tests\nhidden"),
		["Tests", ...AFTER_SUMMARY],
	],
	[
		"B5 a 4-space opener continuing a paragraph is text",
		body("Text. More text.\n    <!--\n## Tests\nx\n-->"),
		[],
	],
	[
		"B6 a block comment only --!> ends hides the rest",
		body("Text.\n\n<!--\n## Tests\nhidden\n--!>"),
		["Tests", ...AFTER_SUMMARY],
	],
	[
		"B7 an abrupt <!--> at a line start hides nothing after it",
		body(`Text.\n\n## Detail\n<!-->\n${TESTS}`),
		[],
	],
	[
		"B8 a block comment spans blank lines",
		body("Text.\n\n<!--\npara\n\n## Tests\n\npara\n-->"),
		["Tests"],
	],
	[
		"I1 an inline comment closed on its line",
		body(`Text <!-- note --> more.\n\n${TESTS}`),
		[],
	],
	[
		"I2 an inline opener with no end (V1)",
		body(`The scan reads <!-- as an opener.\n\n${TESTS}`),
		[],
	],
	[
		"I3 an inline opener closed past a blank line (V1)",
		body(`Reads <!-- as an opener.\n\n${TESTS}\n\n--> closes it.`),
		[],
	],
	[
		"I4 an opener in a code span (V1, Greptile P1)",
		body(`The scan reads \`<!--\` as an opener.\n\n${TESTS}`),
		[],
	],
	[
		"I5 a code-span opener closed in a later fence (V1)",
		body(`Reads \`<!--\`.\n\n${TESTS}\n\n\`\`\`text\n<!-- c -->\n\`\`\``),
		[],
	],
	[
		"I6 an inline comment over two lines",
		body(`Text <!-- spans\ntwo lines --> end.\n\n${TESTS}`),
		[],
	],
	[
		"V5 a heading ends an unclosed inline comment (Greptile P1)",
		body(
			"The scan reads <!-- as an opener.\n## Tests\nTargeted tests pass. -->",
		),
		[],
	],
	[
		"V5 the same with blank lines",
		body(
			"The scan reads <!-- as an opener.\n\n## Tests\nTargeted tests pass. -->",
		),
		[],
	],
	[
		"V5 the same in CRLF",
		crlf(
			body(
				"The scan reads <!-- as an opener.\n## Tests\nTargeted tests pass. -->",
			),
		),
		[],
	],
	[
		"V4 a stray backtick pair straddles a block comment (Greptile P1)",
		body(
			"One stray ` backtick.\n\n<!--\n## Tests\nhidden\n-->\n\nAnother stray ` backtick.",
		),
		["Tests"],
	],
	[
		"V4 the same in CRLF (CodeRabbit)",
		crlf(
			body(
				"One stray ` backtick.\n\n<!--\n## Tests\nhidden\n-->\n\nAnother stray ` backtick.",
			),
		),
		["Tests"],
	],
	[
		"V4 a backtick in one comment pairs with one in the next",
		body("<!-- one ` tick -->\n\n<!-- two ` tick\n## Tests\nhidden\n-->"),
		["Tests"],
	],
	[
		"V4 a stray backtick before a block comment and a fence after",
		body("A stray ` here.\n\n<!--\n## Tests\nhidden\n-->\n\n```\nx\n```"),
		["Tests"],
	],
	[
		"G1 a fence holding <!--",
		body(`Text.\n\n## Detail\n\`\`\`\n<!--\n\`\`\`\n\n${TESTS}`),
		[],
	],
	[
		"H1 a heading inside a comment beside the real one",
		body(`Text.\n\n${TESTS}\n\n<!--\n## Blast radius\n-->`),
		[],
	],
	[
		"S1 a setext heading",
		body("Text.\n\nTests\n-----\nTargeted tests pass."),
		[],
	],
	[
		"S4 an ATX heading indented three spaces",
		body("Text.\n\n   ## Tests\nTargeted tests pass."),
		[],
	],
	[
		"S5 an ATX heading with closing hashes",
		body("Text.\n\n## Tests ##\nTargeted tests pass."),
		[],
	],
	[
		"S6 a heading in indented code",
		body("Text.\n\n    ## Tests\n    x"),
		["Tests"],
	],
	["S7 an escaped heading", body("Text.\n\n\\## Tests\nx"), ["Tests"]],
	[
		"T6 a <details> block with no blank line swallows ## Tests",
		body("Text.\n\n<details>\n## Tests\nx\n</details>"),
		["Tests"],
	],
	[
		"T6 a <details> block with blank lines keeps ## Tests",
		body(
			"Text.\n\n## Detail\n<details>\n<summary>s</summary>\n\n## Tests\nx\n\n</details>",
		),
		[],
	],
	[
		"T7 a bare <span> line opens an HTML block that swallows ## Tests",
		body("Text.\n\n<span>\n## Tests\nx"),
		["Tests"],
	],
	// By decision, not the render: GitHub renders an <h2> nested in a list
	// item or a block quote, but a nested heading is no section of the
	// document, so the lint refuses it (fail closed, live population 0).
	[
		"S2 a heading in a list item is refused by decision",
		body("Text.\n\n- ## Tests\n  Targeted tests pass."),
		["Tests"],
	],
	[
		"S3 a heading in a block quote is refused by decision",
		body("Text.\n\n> ## Tests\n> Targeted tests pass."),
		["Tests"],
	],
	// By decision too: #1844 accepts H3 and H4 section headings, so `#### Tests`
	// is the Tests section although GitHub renders no <h2>.
	[
		"S8 an H4 heading is the section (#1844)",
		body("Text.\n\n## Detail\n#### Tests\nx"),
		[],
	],
	// #4717 N6: GitHub passes the raw `<!--` through, so a comment a list
	// item leaves open hides every later section, whatever closes the item.
	[
		"N6a an unterminated comment in a list item hides the rest",
		body("- item\n  <!--\n## Tests\nhidden"),
		["Tests", ...AFTER_SUMMARY],
	],
	[
		"N6a the same in CRLF",
		crlf(body("- item\n  <!--\n## Tests\nhidden")),
		["Tests", ...AFTER_SUMMARY],
	],
	[
		"N6b a closer outside the item is text and ends nothing",
		body("- item\n  <!--\n## Tests\nhidden\n  -->"),
		["Tests", ...AFTER_SUMMARY],
	],
	// #4717 N7: the section name is the heading's rendered text.
	[
		"N7 a trailing inline comment on the heading",
		body("Text.\n\n## Tests <!-- note -->\nx"),
		[],
	],
	[
		"N7 a leading inline comment on the heading",
		body("Text.\n\n## <!-- note --> Tests\nx"),
		[],
	],
	["N7 a bold heading", body("Text.\n\n## **Tests**\nx"), []],
	["N7 an emphasised heading", body("Text.\n\n## *Tests*\nx"), []],
	[
		"N7 a link heading",
		body("Text.\n\n## [Tests](https://example.com)\nx"),
		[],
	],
	["N7 a code-span heading", body("Text.\n\n## `Tests`\nx"), []],
];

describe("PR body sections as the reader sees them (#4717)", () => {
	it.each(cases)("%s (CI entry)", (_name, text, hidden) => {
		const errors = lintPrBody(text, { workingTree: true }).errors;
		expect(missing(errors)).toEqual(hidden);
		if (hidden.length === 0) expect(errors).toEqual([]);
	});

	it.each(cases)("%s (local entry)", (_name, text, hidden) => {
		const errors = lintLocalPrBody(text, process.cwd(), stub as never).errors;
		expect(missing(errors)).toEqual(hidden);
		if (hidden.length === 0) expect(errors).toEqual([]);
	});

	it("starts a setext section after its underline", () => {
		// Recurrence it prevents: the underline is part of the heading, so a
		// section holding only its own `-----` would count as written.
		const text = body("Text.\n\nTests\n-----\n");
		expect(lintPrBody(text, { workingTree: true }).errors).toContainEqual(
			expect.stringContaining('"## Tests"'),
		);
	});
});

describe("prose sections end where the lexer ends them (#4717 N2)", () => {
	const long = `${Array.from({ length: 37 }, (_, i) => `word${i}`).join(" ")}.`;
	it.each([
		["a setext heading", "Tests\n-----"],
		["an indented ATX heading", "   ## Tests"],
		["a closed ATX heading", "## Tests ##"],
	])("does not judge the prose under %s as Summary prose", (_name, heading) => {
		// Recurrence it prevents: the prose reader kept its own `## ` regex, so
		// a heading the section reader accepts did not end `## Summary`, and
		// the Tests prose was judged (and refused) as Summary prose.
		const errors = lintPrBody(body(`Text.\n\n${heading}\n${long}`), {
			workingTree: true,
		}).errors;
		expect(errors).toEqual([]);
	});
});

describe("section text drops every raw-HTML block (#4717)", () => {
	it("refuses a required section whose only content is a comment", () => {
		// Recurrence it prevents: round 3's accepted residual. The heading was
		// visible, its content commented out, and the section counted as written.
		const text = body("Text.\n\n## Tests\n<!-- Targeted tests pass. -->");
		expect(lintPrBody(text, { workingTree: true }).errors).toContainEqual(
			expect.stringContaining('no content before the next heading "## Tests"'),
		);
	});

	it("refuses a required section whose only content is a deeper heading", () => {
		// Recurrence it prevents: the content test spelled its own heading regex
		// (`#{2,4}`), so a level-5 heading was content and an empty section passed
		// (#4717 F1 folds it onto the lexer's heading lines, as #2124 F1 did for
		// `###`).
		const text = body("Text.\n\n## Tests\n##### Test assessment");
		expect(lintPrBody(text, { workingTree: true }).errors).toContainEqual(
			expect.stringContaining('no content before the next heading "## Tests"'),
		);
	});

	it("refuses a required section whose only content is a commented nested heading", () => {
		// Recurrence it prevents: #4717 F5. Structure was a body-wide set of the
		// headings' *raw* lines, compared against a comment-blanked section slice,
		// so this heading never matched and an empty "## Tests" passed the merge
		// gate on a trailing `<!-- todo -->`.
		const text = body("Text.\n\n## Tests\n### Note <!-- todo -->");
		expect(lintPrBody(text, { workingTree: true }).errors).toContainEqual(
			expect.stringContaining('no content before the next heading "## Tests"'),
		);
	});

	it("keeps a fold decision that repeats a setext heading's title", () => {
		// Recurrence it prevents: the mirror of #4717 F5. Keyed on text, a setext
		// heading titled with the fold decision claimed that decision's own line as
		// structure, so a valid body was refused.
		const decision = "#4606 not folded: a different file and a separate rule.";
		const text = body("Text.\n\n## Tests\nTargeted tests pass.").replace(
			decision,
			`${decision}\n\n${decision}\n-----`,
		);
		expect(lintPrBody(text, { workingTree: true }).errors).toEqual([]);
	});

	const fold = (section: string) =>
		body(TESTS).replace(
			"#4606 not folded: a different file and a separate rule.",
			section,
		);

	it("refuses a fold decision written only inside a <details> block", () => {
		// GitHub shows a raw-HTML block's text, collapsed; it is not a decision
		// the lint reads (fail closed, by decision).
		expect(
			lintFoldCheck(
				fold(
					"<details>\n#4606 not folded: a different file and rule.\n</details>",
				),
			),
		).toEqual([expect.stringContaining('"## Fold check"')]);
	});

	it("reads a fold decision after a raw-HTML block", () => {
		expect(
			lintFoldCheck(
				fold(
					"<details>\nnote\n</details>\n\n#4606 not folded: a different file and rule.",
				),
			),
		).toEqual([]);
	});

	it("refuses a class-sweep verdict written only inside a raw-HTML block", () => {
		const sweep = [
			"## Class sweep",
			'Defect shape: x. Search: `rg -n "x" scripts`.',
			"<div>",
			"Verdict: folded onto the lexer.",
			"</div>",
		].join("\n");
		expect(lintClassSweep(sweep)).toHaveLength(1);
		expect(
			lintClassSweep(sweep.replace("<div>\n", "\n").replace("\n</div>", "")),
		).toEqual([]);
	});
});
