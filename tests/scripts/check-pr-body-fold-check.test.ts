import { describe, expect, it } from "vitest";
import {
	lintClassSweep,
	lintFoldCheck,
	lintLocalPrBody,
	lintPrBody,
} from "../../scripts/check-pr-body.mjs";

// #4711: AGENTS.md requires a `## Fold check` section in every PR body, and
// `scripts/check-pr-body.mjs` never read it. A PR opened with `gh pr create`
// therefore skipped the rule while the maintainer's local script
// (`pr-create.sh`'s `fold_gate`) refused the body: two fixer-written bodies on
// 2026-10-21 were refused by the local gate and would have passed CI.
//
// The lint owns the FORM, because it cannot read the issue tracker: a decision
// line names its candidate (`#N`), one of the three decisions, and a reason
// after the decision word; or the section says `none: <reason>`. The local
// script owns the candidate list. Both read the same three facts in the same
// order, so one body satisfies both gates.
const body = (fold: string) =>
	[
		"## Why",
		"The body gate records the fold decision.",
		"",
		"## Notes for the reviewer",
		"- None.",
		"",
		"## Change outline",
		"- scripts/check-pr-body.mjs",
		"",
		"## Summary",
		"The lint reads the fold check section.",
		"",
		"## Proof and checks",
		"The proof sections follow.",
		"",
		"## Tests",
		"Targeted tests pass.",
		"",
		"## Blast radius",
		"No runtime module touched.",
		"",
		"## Class sweep",
		'Defect shape: a documented rule with no gate. Search: `rg -n "fold check" scripts`. Verdict: folded onto the body lint.',
		"Alignment: none: this fixture touches no family.",
		"",
		"## Observability",
		"No new failure path; no record added.",
		"",
		"## Fold check",
		fold,
	].join("\n");
const withoutFold = (text: string) =>
	text.slice(0, text.indexOf("\n\n## Fold check"));
const folded = [
	"#4606 not folded: a different file and a separate rule.",
	"#4602 folded: the same body-lint seam, so its rule lands here. Closes #4602.",
	"#3260 sequenced: after this form lands and its tests run.",
].join("\n");

describe("Fold check form (#4711)", () => {
	it.each([
		["folded", "#4602 folded: the same body-lint seam. Closes #4602."],
		["not folded", "#4606 not folded: a different rule and file."],
		["sequenced", "#3260 sequenced: after this form lands."],
	])("accepts a %s decision with its reason", (_name, line) => {
		expect(lintFoldCheck(body(line))).toEqual([]);
	});

	it("accepts a decision table row", () => {
		const table = [
			"| candidate | decision | reason |",
			"| --- | --- | --- |",
			"| #4606 | not folded | a different file and rule |",
		].join("\n");
		expect(lintFoldCheck(body(table))).toEqual([]);
	});

	it("accepts none: with a reason of at least three words", () => {
		expect(lintFoldCheck(body("none: the search listed no candidate"))).toEqual(
			[],
		);
	});

	// Acceptance item 2: a decision word with no reason is not a decision. The
	// local gate refuses it too (`fold_gate` needs two words after the word).
	it("refuses a decision word with no reason", () => {
		const errors = lintFoldCheck(body("#4606 not folded"));
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain('"## Fold check"');
		expect(errors[0]).toContain(".github/PULL_REQUEST_TEMPLATE.md");
	});

	it("refuses a decision line that names no candidate", () => {
		expect(
			lintFoldCheck(body("not folded: a different file and rule")),
		).toEqual([expect.stringContaining('"## Fold check"')]);
	});

	// Fail closed (engineering principles §1): the admitted forms are the
	// decision line and `none:`; an unrecognised line does not satisfy either.
	it("refuses a section holding neither form", () => {
		expect(lintFoldCheck(body("TODO: decide after the round."))).toEqual([
			expect.stringContaining('"## Fold check"'),
		]);
	});

	it("refuses none: with a reason of fewer than three words", () => {
		expect(lintFoldCheck(body("none: nothing found"))).toEqual([
			expect.stringContaining('"## Fold check"'),
		]);
	});

	// A quoted example is not a decision. The class sweep accepts a search
	// command inside a fence, but a verdict is prose the author wrote.
	it.each([
		[
			"a fenced example",
			["```text", "#4606 not folded: a different file", "```"],
		],
		["an HTML comment", ["<!-- #4606 not folded: a different file -->"]],
	])("does not read a decision out of %s", (_name, lines) => {
		expect(lintFoldCheck(body(lines.join("\n")))).toEqual([
			expect.stringContaining('"## Fold check"'),
		]);
	});

	// The first section is the record, as for `## Observability` and for the
	// local gate's awk reader; a later section cannot rescue an empty one.
	it("reads only the first section", () => {
		const twice = `${body("TODO: decide later.")}\n\n## Fold check\n${folded}`;
		expect(lintFoldCheck(twice)).toHaveLength(1);
	});

	// The section ends at the next heading of the same or a higher level: a
	// decision written under a later section is not this section's verdict.
	it("does not read a decision from the next section", () => {
		const leak = [
			"## Fold check",
			"Decide after the round.",
			"",
			"## Tests",
			"#4606 not folded: a different file and rule.",
		].join("\n");
		expect(lintFoldCheck(leak)).toHaveLength(1);
	});

	// Acceptance item 4: one parser for both sections' verdict forms, so one
	// body satisfies the repository lint and the local script's class gate.
	it("lets one body satisfy the fold check and the class sweep", () => {
		const text = body(folded);
		expect(lintFoldCheck(text)).toEqual([]);
		expect(lintClassSweep(text)).toEqual([]);
	});
});

// #4717: the reviewed head admitted a form a reader cannot act on. Each case
// below is a shape the review measured as ACCEPTED, and each is refused now,
// because the gate fails closed (engineering principles §1): a malformed line
// beside a good one does not become a decision, a decision word before its
// candidate decides the wrong issue, an unlisted spelling is not one of the
// three decisions, `none:` beside a candidate contradicts itself, and a
// `folded` candidate whose issue the body never closes leaves the issue open.
describe("Fold check refuses an unlisted or malformed form (#4717)", () => {
	it("refuses a well-formed line that excuses a malformed sibling", () => {
		// The review's `mixed-candidates` probe: `.some` accepted this section.
		const mixed = [
			"#4602 folded: the same body-lint seam. Closes #4602.",
			"#4606 not folded",
		].join("\n");
		expect(lintFoldCheck(body(mixed))).toHaveLength(1);
	});

	it("refuses a candidate line with no decision word", () => {
		// PR 4710's merged record names a candidate and decides nothing.
		expect(
			lintFoldCheck(
				body("- #4690 landed on master and this branch merged it."),
			),
		).toHaveLength(1);
	});

	it("refuses the decision word before its candidate", () => {
		// Two spellings: the first also fails the reason floor, and the second
		// fails nothing but the order, so the ordering guard has its own witness.
		expect(lintFoldCheck(body("folded: see #4606"))).toHaveLength(1);
		expect(
			lintFoldCheck(body("not folded: #4606 is a different file and rule.")),
		).toHaveLength(1);
	});

	it("does not count an issue number as the reason", () => {
		expect(lintFoldCheck(body("#4606 not folded: see #4675"))).toHaveLength(1);
	});

	it.each([
		["not-folded", "#4711 not-folded: the same seam and file."],
		["re-sequenced", "#4711 re-sequenced: after this form lands."],
	])("refuses the unlisted spelling %s", (_name, line) => {
		// The body closes #4711, so a reader that resolved `not-folded` to the
		// `folded` token (the reviewed head did) would accept this line: the
		// spelling is the only thing left refusing it.
		const closing = body(line).replace(
			"The lint reads the fold check section.",
			"The lint reads the fold check section. Closes #4711.",
		);
		expect(lintFoldCheck(closing)).toHaveLength(1);
	});

	it("does not read an HTML entity as a candidate", () => {
		// PR 4708's merged fold section ends with a bot footer that quotes
		// `&#39;`: a fail-closed candidate scan that took the entity for `#39`
		// refused the whole section.
		const text = body(
			[
				"- #4708 not folded: this PR itself.",
				"",
				"<sub>Reviewed commit &#39;abc&#39;</sub>",
			].join("\n"),
		);
		expect(lintFoldCheck(text)).toEqual([]);
	});

	it("refuses one line deciding two candidates", () => {
		expect(
			lintFoldCheck(
				body("#4602 and #4610 folded: both are the same seam. Closes #4602."),
			),
		).toHaveLength(1);
	});

	it("refuses none: beside a candidate line", () => {
		const contradictory = [
			"none: the search listed no candidate",
			"#4606 not folded: a different rule and file.",
		].join("\n");
		expect(lintFoldCheck(body(contradictory))).toHaveLength(1);
	});

	it.each([["none: no"], ["none: no candidate"]])(
		"refuses a short %s beside a candidate line (#4717 N3)",
		(none) => {
			// Recurrence it prevents: the contradiction was judged only after a
			// three-word reason, so a short `none:` left the candidate line alone
			// to decide the section.
			const contradictory = [
				none,
				"#4606 not folded: a different rule and file.",
			].join("\n");
			expect(lintFoldCheck(body(contradictory))).toHaveLength(1);
		},
	);

	it("refuses a folded candidate the body does not close", () => {
		expect(
			lintFoldCheck(body("#4602 folded: the same body-lint seam.")),
		).toHaveLength(1);
	});

	it("does not read a Closes that inline code hides", () => {
		// PR 4680's fold cell: `parseCloseKeywords` blanks inline code, so that
		// row would say `folded` while the issue stays open.
		const table = [
			"| candidate | decision | reason |",
			"| --- | --- | --- |",
			"| #4672 | folded: `Closes #4672` | the mechanism itself |",
		].join("\n");
		expect(lintFoldCheck(body(table))).toHaveLength(1);
	});

	it.each([
		["a backtick fence", "```\nCloses #4602\n```"],
		["a tilde fence", "~~~\nCloses #4602\n~~~"],
		["indented code", "    Closes #4602"],
	])("does not read a Closes that %s holds (#4717 N1)", (_name, code) => {
		// Recurrence it prevents: the close parser blanked backtick fences
		// only, so a tilde-fenced closer satisfied a `folded` line while the
		// issue stayed open. The lexer decides what is code.
		const text = body("#4602 folded: the same body-lint seam.").replace(
			"The lint reads the fold check section.",
			`The lint reads the fold check section.\n\n${code}\n`,
		);
		expect(lintFoldCheck(text)).toHaveLength(1);
	});

	it("accepts a folded candidate its body closes elsewhere", () => {
		const text = body("#4602 folded: the same body-lint seam.").replace(
			"The lint reads the fold check section.",
			"The lint reads the fold check section. Closes #4602.",
		);
		expect(lintFoldCheck(text)).toEqual([]);
	});
});

describe("Fold check section requirement (#4711)", () => {
	it("refuses a body with no section", () => {
		const result = lintPrBody(withoutFold(body("none: no candidate listed")), {
			workingTree: true,
		});
		expect(result.valid).toBe(false);
		expect(result.errors).toEqual([
			expect.stringContaining('missing "## Fold check"'),
		]);
	});

	// Acceptance item 3: the lint has no docs-only exemption for body sections,
	// so a docs diff carries the section like any other and answers it `none:`.
	it("requires the section for a docs-only diff", () => {
		const diff = [
			"diff --git a/docs/pi-lens-fixer.md b/docs/pi-lens-fixer.md",
			"@@ -1,0 +1,1 @@",
			"+A doc line.",
		].join("\n");
		const missing = lintPrBody(withoutFold(body("none: no candidate listed")), {
			workingTree: true,
			diff,
		});
		expect(missing.errors).toContainEqual(
			expect.stringContaining('missing "## Fold check"'),
		);
		expect(lintFoldCheck(body("none: docs only, no runtime code."))).toEqual(
			[],
		);
	});

	it("refuses a section with no content before the next heading", () => {
		const result = lintPrBody(body(""), { workingTree: true });
		expect(result.errors).toContainEqual(
			expect.stringContaining(
				'no content before the next heading "## Fold check"',
			),
		);
	});

	it("reaches the local preflight composition", () => {
		const stub = (): string => "";
		const missing = lintLocalPrBody(
			withoutFold(body("none: no candidate listed")),
			process.cwd(),
			stub as never,
		);
		expect(missing.errors.join(" ")).toContain('missing "## Fold check"');
		expect(
			lintLocalPrBody(body(folded), process.cwd(), stub as never).errors.join(
				" ",
			),
		).not.toContain('"## Fold check"');
	});

	// #4717 F7: the reviewed head's `lintLocalPrBody` wire carried no case of its
	// own, so deleting it left the suite green while the local preflight accepted
	// a malformed decision line. This case reaches the wire that call site makes.
	it("refuses a malformed decision line at the local preflight", () => {
		const stub = (): string => "";
		const result = lintLocalPrBody(
			body("#4606 not folded"),
			process.cwd(),
			stub as never,
		);
		expect(result.errors.join(" ")).toContain('"## Fold check"');
	});

	// #4717 F1: GitHub renders nothing for a section inside an HTML comment, so
	// both entries read the section list as the reader sees it. The reviewed head
	// found the heading through the fence-blanked scan and accepted the body.
	it("refuses a Fold check section an HTML comment hides (CI entry)", () => {
		const hidden = `${withoutFold(
			body("none: no candidate listed"),
		)}\n\n<!--\n## Fold check\n#4606 not folded: a different file and rule.\n-->`;
		expect(lintPrBody(hidden, { workingTree: true }).errors).toContainEqual(
			expect.stringContaining('missing "## Fold check"'),
		);
	});

	it("refuses a Fold check section an HTML comment hides (local entry)", () => {
		const hidden = `${withoutFold(
			body("none: no candidate listed"),
		)}\n\n<!--\n## Fold check\n#4606 not folded: a different file and rule.\n-->`;
		const stub = (): string => "";
		expect(
			lintLocalPrBody(hidden, process.cwd(), stub as never).errors.join(" "),
		).toContain('missing "## Fold check"');
	});

	// #4717 V1: only the commonmark opener forms hide text. A mid-line `<!--`
	// (in prose or in a backtick span) is text the reader sees, so every later
	// heading stays visible and both entries accept the body. The reviewed head
	// blanked from the first mid-line opener to the next `-->` anywhere in the
	// body, so each shape puts its end after `## Tests` and the row reds on
	// 0186fefbd (its round's pre-fix source: `Tests 4 failed`, quoted in the PR
	// body). A shape whose end sits inside the Summary paragraph was satisfied by
	// that scan too, so it proved nothing (#4717 F2).
	const openedAtSummary = (summary: string, end: string) =>
		`${body("#4606 not folded: a different file and a rule.").replace(
			"The lint reads the fold check section.",
			summary,
		)}\n\n${end}`;
	it.each([
		["in prose with no end", "The scan reads <!-- as an opener.", ""],
		[
			"in a backtick span with no end",
			"The scan reads `<!--` as an opener.",
			"",
		],
		[
			"in prose, end in a later section",
			"The scan reads <!-- as an opener.",
			"--> and a later bot comment closes it.",
		],
		[
			"in a backtick span, end in a later section",
			"The scan reads `<!--` as an opener.",
			"--> and a later bot comment closes it.",
		],
		[
			"in prose, end in a later fence",
			"The scan reads <!-- as an opener.",
			"```text\n<!-- closer -->\n```",
		],
		[
			"in a backtick span, end in a later fence",
			"The scan reads `<!--` as an opener.",
			"```text\n<!-- closer -->\n```",
		],
	])("accepts a Summary naming <!-- %s", (_name, summary, end) => {
		const text = openedAtSummary(summary, end);
		expect(lintFoldCheck(text)).toEqual([]);
		expect(lintPrBody(text, { workingTree: true }).errors).toEqual([]);
		const stub = (): string => "";
		expect(lintLocalPrBody(text, process.cwd(), stub as never).errors).toEqual(
			[],
		);
	});

	// #4717 F8: a `###` sub-heading does not end the section, because the section
	// ends at the next heading of the same or a higher level. Dropping that level
	// test turned no case red on the reviewed head.
	it("keeps a deeper sub-heading inside the section", () => {
		const text = body(
			[
				"Decide after the round.",
				"",
				"### Detail",
				"#4606 not folded: a different file and rule.",
			].join("\n"),
		);
		expect(lintFoldCheck(text)).toEqual([]);
	});
});
