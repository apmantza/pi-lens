// flake-shape: real-process-spawn — the comment layout gate is the committed CLI (exit code and stderr of `--comment`); an in-process call of the pure function cannot prove the argument parsing, the stdin/file read or the exit status a posting role relies on.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkProse } from "../../scripts/check-prose.mjs";
import { lintPrBody } from "../../scripts/check-pr-body.mjs";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("heading rules read the lexer's headings (#4717 N2)", () => {
	it("judges a setext heading's case", () => {
		// Recurrence it prevents: the heading rule kept its own `#` regex, so a
		// setext heading in Title Case was read as a prose line.
		expect(checkProse("Some Title Case\n---------------\n").errors).toEqual([
			expect.stringContaining("heading-case"),
		]);
	});
});

describe("checkProse", () => {
	it("warns on the long sentence from the #4274 comment, without failing (#5110)", () => {
		const result = checkProse(
			"The harness derives repoRoot from import.meta.url, and its sibling worktree case uses two scratch projects, not git worktree add, while the surrounding selection runs many files concurrently and makes the timing-sensitive case fail only under contention.",
		);
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
		expect(result.warnings.join(" ")).toContain("sentence-length");
	});

	it("accepts clean prose and reports passive voice as a warning", () => {
		const result = checkProse("Run the focused test. Read the result.");
		expect(result).toEqual({ valid: true, errors: [], warnings: [] });
		const passive = checkProse("The result was recorded.");
		expect(passive.valid).toBe(true);
		expect(passive.warnings.join(" ")).toContain("passive-voice");
	});

	it("does not count code, URLs, tables, blockquotes, or log lines", () => {
		const text = [
			"```text",
			"This line contains far more than thirty ordinary words and must remain ignored because it is a transcript or code block that users paste for evidence while reviewing a change in CI.",
			"```",
			"https://example.com/a/very-long-url-that-is-not-prose",
			"> This quoted line contains far more than thirty words and must remain ignored.",
			"FAIL This log line contains far more than thirty words and must remain ignored.",
			"| A | This table cell contains far more than thirty words and must remain ignored. |",
		].join("\n");
		expect(checkProse(text)).toEqual({ valid: true, errors: [], warnings: [] });
	});

	it("warns on please and simply, and never fails on them (#5110)", () => {
		const result = checkProse("Please simply do this.");
		expect(result).toMatchObject({ valid: true, errors: [] });
		expect(result.warnings.join(" ")).toContain('remove "please"');
		expect(result.warnings.join(" ")).toContain('remove "simply"');
		expect(checkProse("Please simply do this.", { mode: "warn" })).toEqual(
			result,
		);
	});

	it("ignores comments, generated footers, and trailing metadata", () => {
		const long =
			"This generated metadata contains enough ordinary words to exceed the prose limit and must remain ignored when the checker reads a body supplied by a hosting service.";
		const text = [
			"<!--",
			long,
			"-->",
			long.replace("generated metadata", "footer metadata"),
			"🤖 Generated with [Claude Code](https://claude.com/claude-code)",
			"Co-Authored-By: Example <example@example.com>",
			"Signed-off-by: Example <example@example.com>",
			"Refs: #4280",
			"Closes: #4280",
		].join("\n");
		expect(checkProse(text)).toEqual({ valid: true, errors: [], warnings: [] });
	});

	// Recurrence: #5110 turned every prose finding except heading case into a
	// warning, so the old `expect(result.valid).toBe(true)` over this text could
	// no longer fail whatever the splitter did (surviving mutations: an
	// abbreviation list that never matches, a dropped next-character rule). The
	// text is now one sentence of 31 to 33 words that splits into pieces under the
	// 30-word limit exactly when the splitter wrongly ends a sentence at the dot.
	const words = (count: number) => Array(count).fill("word").join(" ");
	it.each([
		["an abbreviation", `Check e.g. ${words(29)}.`],
		["a dotted version number", `Use version 1.2.3 ${words(28)}.`],
	])("does not end a sentence at %s", (_name, text) => {
		expect(checkProse(text).warnings.join(" ")).toContain("sentence-length");
	});

	it("still ends a sentence at a real full stop, so the rows above can see a split", () => {
		expect(checkProse(`Check this. ${words(29)}.`)).toEqual({
			valid: true,
			errors: [],
			warnings: [],
		});
	});

	it("splits ordered and unordered list items into sentences", () => {
		const item =
			"3. **Warn:** a retired glossary term in prose. Read the retired terms from the AGENTS.md glossary at run time, so the list never drifts. The glossary sweep test already parses that source. Warn only, because several retirements depend on context.";
		expect(checkProse(item)).toEqual({ valid: true, errors: [], warnings: [] });
		expect(
			checkProse(
				"- This deliberately has enough ordinary words to exceed the prose limit because it never reaches a terminal sentence boundary and must remain one sentence while the checker preserves this unbroken paragraph for its length guard.",
			).warnings.join(" "),
		).toContain("sentence-length");
	});

	// Recurrence: the list-marker strip had no observable effect in any case, so
	// `1)` (no sentence end at `)`) was counted as a word of its own item and a
	// 30-word ordered item read as 31.
	it("does not count an ordered list marker as a word of its item", () => {
		expect(checkProse(`1) ${words(30)}.`).warnings).toEqual([]);
		expect(checkProse(`1) ${words(31)}.`).warnings.join(" ")).toContain(
			"found 31",
		);
	});

	const longAfterEnd =
		"This deliberately long sentence sits after a comment close and contains enough ordinary words in one unbroken unit to exceed the prose limit that the checker enforces on every submitted body because the guard must never miss visible text.";
	// Recurrence (#4565): this masker ended an HTML comment at `-->` alone,
	// so text GitHub renders after `--!>`, `<!-->` or `<!--->` was masked,
	// and a gating rule read visible prose as absent. Each row is an inline
	// comment the lexer reads (#4717): `--!>` ends none, so its text is prose
	// too. A line that opens with `<!--` is a raw-HTML block instead, dropped
	// whole (fail closed), so the rows sit mid-line.
	const commentEnds: Array<[string, string]> = [
		["`-->`", `Intro <!-- note --> ${longAfterEnd}`],
		["`--!>`", `Intro <!-- note --!> ${longAfterEnd}`],
		["`<!-->`", `Intro <!--> ${longAfterEnd}`],
		["`<!--->`", `Intro <!---> ${longAfterEnd}`],
	];
	for (const [end, text] of commentEnds)
		it(`counts a long sentence after the ${end} end`, () => {
			expect(checkProse(text).warnings.join(" ")).toContain("sentence-length");
		});

	it("still hides a long sentence inside a comment", () => {
		const hidden =
			"This comment body sits inside the comment and carries enough ordinary words in one unbroken unit to exceed the prose limit that the checker enforces on every submitted body because the guard must never count hidden text as prose.";
		expect(
			checkProse(`<!-- ${hidden} --> Run the test.`).warnings.join(" "),
		).not.toContain("sentence-length");
	});

	// #4717 V1: the masker treated any `<!--` as an opener, so prose after a
	// mid-line opener that never closes was skipped instead of judged, and a
	// body writing about the comment syntax escaped the length rule. The opener
	// rule is `blankHtmlComments`'s now.
	it("counts prose after a mid-line opener that never closes", () => {
		const long =
			"This sentence follows a mid-line opener and carries enough ordinary words in one unbroken unit to exceed the prose limit that the checker enforces on every submitted body because visible prose is prose.";
		expect(
			checkProse(`The scan reads <!-- as an opener. ${long}`).warnings.join(
				" ",
			),
		).toContain("sentence-length");
	});

	it("counts prose after an opener quoted in a backtick span", () => {
		const long =
			"This sentence follows a quoted opener and carries enough ordinary words in one unbroken unit to exceed the prose limit that the checker enforces on every submitted body because visible prose is prose.";
		expect(
			checkProse(`The scan reads \`<!--\` as an opener. ${long}`).warnings.join(
				" ",
			),
		).toContain("sentence-length");
	});

	// #4717 parity: code spans are blanked before the prose rules read a line,
	// but the line filters (a stack frame `at …`, a command) must read the line
	// as written. Filtering the blanked line dropped `\`rows\` at 0 …` from
	// docs/release-qa-baseline.md as a stack frame and lost its findings.
	it("judges a line that opens with a code span followed by `at`", () => {
		const result = checkProse(
			"`rows` at 0 is then dropped, so nothing was witnessed and the row is ignored.",
		);
		expect(result.warnings.join(" ")).toContain("passive-voice");
	});

	it("quotes a passive excerpt with one space where a code span sat", () => {
		expect(
			checkProse("The value is `cap` clamped.").warnings.join(" "),
		).toContain('near "is clamped"');
	});

	it("hides a continuation line that starts with the abrupt-end dash", () => {
		// Recurrence (#4565 round 7): the masker calls the owner at index 0 of a
		// continuation line, where the comment is in body state, but the owner
		// applied its `>` and `->` abrupt-end arms at every `from`. A line that
		// starts with `->` then closed the comment early and hidden words
		// reached the gate. Both arms belong to the comment-start states only.
		const hidden =
			"This comment continuation carries enough ordinary words in one unbroken unit to exceed the prose limit that the checker enforces on every submitted body because the guard must never count hidden text as prose.";
		const result = checkProse(`<!--\n-> ${hidden}\n--> Run the test.`);
		expect(result.warnings.join(" ")).not.toContain("sentence-length");
		expect(result).toEqual({ valid: true, errors: [], warnings: [] });
	});

	it("applies the checker to PR prose sections only", () => {
		const long =
			"This sentence has enough ordinary words to exceed the prose limit and should warn when it appears in a Summary section because the PR body gate checks that section during every local and CI validation run.";
		const body = `## Why\nShort reason.\n\n## Notes for the reviewer\nShort note.\n\n## Summary\n${long}\n\n## Tests\n\`\`\`text\n${long}\n\`\`\`\n\n## Blast radius\nNone.\n\n## Class sweep\nDone.\n\n## Observability\nRecorded.`;
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const result = lintPrBody(body, { workingTree: true });
		expect(result.errors.join(" ")).not.toContain("sentence-length");
		// Only the Summary sentence is judged: the fenced Tests line is not prose.
		const printed = warn.mock.calls.map(([line]) => String(line));
		expect(
			printed.filter((line) => line.includes("sentence-length")),
		).toHaveLength(1);
	});
});

// #5110: the prose rules print warnings and never fail the lint on their own;
// every structural rule still fails. Each body below carries one prose fault
// or one missing section, so a red names the rule that changed.
describe("prose rules warn, structural rules still fail (#5110)", () => {
	const forty =
		"The lint reads every Summary and Notes sentence, and a sentence that runs past thirty words currently blocks the whole body even when every required section is present, complete, accurate, and correct in the final text that reviewers read today.";
	const body = (summary: string, observability = true) =>
		`## Summary\n\nCloses #5110. ${summary} Structural rules still fail.\n\n## Notes for the reviewer\n\n- The fixture changes nothing else.\n\n## Change outline\n\n- caller\n  + changed symbol\n    + callee\n\n## Proof and checks\n\n### Tests\n\nTargeted tests pass.\n\n### Class sweep\n\nDefect shape: a prose rule that fails the lint. Search: \`rg -n "sentence-length" scripts\`. Verdict: stays distributed because the fixture changes no code.\n\nAlignment: none: this fixture touches no family.\n\n${observability ? "### Observability\n\nNo new failure path; no record added.\n\n" : ""}### Fold check\n\nnone: fixture only, no candidate.\n`;

	it("control: a clean body passes with no prose warning", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(
			lintPrBody(body("The lint reads each sentence once."), {
				workingTree: true,
			}),
		).toEqual({ valid: true, errors: [] });
		expect(warn).not.toHaveBeenCalledWith(
			expect.stringContaining("PR body prose"),
		);
	});

	// Recurrence it prevents: a prose rule that fails the lint again, which
	// the author would only see on the next push.
	const passesWithWarning = (summary: string, rule: string, detail: string) => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(lintPrBody(body(summary), { workingTree: true })).toEqual({
			valid: true,
			errors: [],
		});
		const printed = warn.mock.calls.map(([line]) => String(line)).join("\n");
		expect(printed).toContain(`PR body prose warning: ${rule} (line 3)`);
		expect(printed).toContain(detail);
	};
	it("passes a body whose only fault is a 40-word sentence, with a warning line", () =>
		passesWithWarning(forty, "sentence-length", "found 40"));
	it("passes a body whose only fault is a filler word, with a warning line", () =>
		passesWithWarning(
			"Please read the summary before the round starts.",
			"filler",
			'remove "please"',
		));

	it("still fails a body that is missing a required section", () => {
		// Recurrence it prevents: demoting the prose channel to warnings also
		// demotes the structural errors, so a body without its Observability
		// section passes the lint with its prose clean.
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const result = lintPrBody(body(forty, false), { workingTree: true });
		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toContain('is missing "## Observability"');
	});
	it("still fails a title-case heading through the lint (#5110)", () => {
		// Recurrence it prevents: the lint stops pushing prose errors, so the one
		// prose rule that still blocks (title-case headings) passes silently.
		// Only checkProse read it before this pin.
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const text = body("The fixture is short.").replace(
			"## Notes for the reviewer",
			"## Notes For The Reviewer",
		);
		const result = lintPrBody(text, { workingTree: true });
		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toContain("PR body prose heading-case");
	});

	it("demotes a title-case heading in grace mode, and only headings (#5110)", () => {
		// Recurrence it prevents: grace mode (PI_LENS_PROSE_GRACE, --prose-grace)
		// stops reaching the heading rule, or it demotes a structural error too.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const titleCase = body("The fixture is short.").replace(
			"## Notes for the reviewer",
			"## Notes For The Reviewer",
		);
		expect(
			lintPrBody(titleCase, { workingTree: true, proseMode: "warn" }),
		).toEqual({ valid: true, errors: [] });
		const printed = warn.mock.calls.map(([line]) => String(line)).join("\n");
		expect(printed).toContain("PR body prose warning: heading-case");
		expect(
			lintPrBody(body(forty, false), { workingTree: true, proseMode: "warn" })
				.valid,
		).toBe(false);
	});
});

describe("comment layout gate (#5558)", () => {
	const REPO_ROOT = path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		"../..",
	);
	const CLI = path.join(REPO_ROOT, "scripts/check-prose.mjs");
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0))
			fs.rmSync(dir, { recursive: true, force: true });
	});

	function run(body: string, ...extra: string[]) {
		return runWith(body, ["--comment", ...extra]);
	}

	function runWith(body: string, flags: string[]) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-comment-"));
		dirs.push(dir);
		const file = path.join(dir, "comment.md");
		fs.writeFileSync(file, body);
		const result = spawnSync(
			process.execPath,
			[CLI, ...flags, "--body-file", file],
			{ encoding: "utf8" },
		);
		return { status: result.status, err: result.stderr };
	}

	const lines = (n: number, tag = "Line") =>
		Array.from({ length: n }, (_, i) => `${tag} number ${i + 1} is here.`);
	const fold = (summary: string, inner = ["Detail line."]) =>
		[
			"<details>",
			`<summary>${summary}</summary>`,
			"",
			...inner,
			"",
			"</details>",
		].join("\n");
	const SUMMARY = "Claude Sonnet 5.5 (high): the detail";

	// The #5394 review as posted: 40 lines, no fold, 2026-11 (predates #5510).
	const REVIEW_5394 = [
		"Thanks for the PR. Before going further, what do you want the digests to enable?",
		"",
		"## Review (head 1145734f3, merged with master 011b5420a)",
		"",
		"Verdict at that head: needs changes. Nothing high severity.",
		"",
		"**Premises**",
		"",
		"- **(a) MCP bootstrap reset race.** `_resetMcpSessionContext` has no production callers.",
		"- **(b) Config digests.** No production code reads `contributingConfigSources`.",
		"",
		"**Findings**",
		"",
		"- **F1 (medium): the digests have no consumer.** The name clashes with its doc.",
		"- **F2 (medium): a hand-rolled epoch counter.** It duplicated `createGenerationSource`.",
		"- **F3 (medium): mutation survivors.** `session-context-eviction` stayed green for all four.",
		"- **F4 (low): the body overstates coverage.** `retireScope` logs only for `superseded`.",
		"",
		"**What held up**",
		"",
		"- The digest hashes the exact buffer that gets parsed.",
		"- Resolution matched master exactly.",
	].join("\n");

	// A worker hand-back posted as an issue comment, #5308 (117 and 143 lines).
	const HANDBACK_5308 = [
		"# Handback — #5308 run-outcome ratchet, round 1",
		"",
		"Branch deviation, and why: the brief named one branch, but the git guard refuses a commit there.",
		"The work is on a second branch and the PR opens from it:",
		"",
		"## Two pre-push governance reds the first push hit",
		"",
		"- `git-fixture-governance.test.ts` read the plants as bare Git spawns.",
		"- `flake-shape-ratchet.test.ts` flagged this file on one line.",
		"",
		"## Mutations",
		"",
		"- Neutered the census branch, and the new test went red.",
		"- Neutered the unclassified branch, and the plant test went red.",
		"- Restored both, and the suite is green.",
		"",
		"## Checks run",
		"",
		"- `npm run lane:check` printed a clean record.",
		"- The body lint passed.",
	].join("\n");

	// Recurrence it prevents: the orchestrator wrapper accepted any `<details>`
	// anywhere, so a long visible part before the fold passed (#5558).
	it("refuses 14 visible lines before a fold", () => {
		const r = run(`${lines(14).join("\n")}\n${fold(SUMMARY)}\n`);
		expect(r.status).toBe(1);
		expect(r.err).toContain("visible part");
	});

	// Recurrence: #5394 (40 lines, no fold) and #5308 (hand-back posted whole).
	it.each([
		["the #5394 review", REVIEW_5394],
		["the #5308 hand-back", HANDBACK_5308],
	])("refuses %s as posted: no fold", (_name, body) => {
		const r = run(`${body}\n`);
		expect(r.status).toBe(1);
		expect(r.err).toContain("no <details> fold");
	});

	// Recurrence: a fold that is not a layout fold (no summary renders as
	// the bare word "Details" and names no model).
	it("refuses a fold with no summary", () => {
		const body = `${lines(5).join("\n")}\n<details>\n\n${lines(10).join("\n")}\n</details>\n`;
		const r = run(body);
		expect(r.status).toBe(1);
		expect(r.err).toContain("<summary>");
	});

	// Recurrence: without the blank line the Markdown inside the fold does not
	// render (#5510).
	it("refuses a summary with no blank line after it", () => {
		const body = `${lines(5).join("\n")}\n<details>\n<summary>${SUMMARY}</summary>\n${lines(10).join("\n")}\n</details>\n`;
		const r = run(body);
		expect(r.status).toBe(1);
		expect(r.err).toContain("blank line");
	});

	// Recurrence: an unclosed fold swallows every later comment on the page.
	it("refuses an unclosed details", () => {
		const body = `${lines(5).join("\n")}\n<details>\n<summary>${SUMMARY}</summary>\n\n${lines(10).join("\n")}\n`;
		const r = run(body);
		expect(r.status).toBe(1);
		expect(r.err).toContain("unclosed");
	});

	// Recurrence: text on the closing line is visible text that a count of
	// whole-line tags would miss.
	it("refuses text on the </details> line", () => {
		const body = `${lines(5).join("\n")}\n${fold(SUMMARY, lines(10)).replace("</details>", "</details> and a visible tail")}\n`;
		const r = run(body);
		expect(r.status).toBe(1);
		expect(r.err).toContain("line of its own");
	});

	// Recurrence: a stray close tag is a half-pasted fold.
	it("refuses a </details> with no opener", () => {
		const r = run(`${lines(13).join("\n")}\n</details>\n`);
		expect(r.status).toBe(1);
		expect(r.err).toContain("no opening <details>");
	});

	// Recurrence: the #5543 reply folded under "Suggested shape and the probe
	// matrix", which names no model. Fail closed on a summary that is not a
	// recognised form, not only on a missing one.
	it.each([
		["no model", "Suggested shape and the probe matrix"],
		["a label before the colon", "Full triage: the detail"],
		["an unknown effort", "Claude Opus 5.5 (extreme): the detail"],
		["nothing after the colon", "Claude Opus 5.5 (high):"],
		["a word that only starts like a family", "Solution notes: the detail"],
	])("refuses a summary with %s", (_name, summary) => {
		const r = run(`${lines(5).join("\n")}\n${fold(summary, lines(10))}\n`);
		expect(r.status).toBe(1);
		expect(r.err).toContain("summary");
	});

	it.each([
		"Claude Opus 5.5 (high): full triage",
		"Sonnet 5.5: probes and what held up",
		"DeepSeek V4.1 Flash (xhigh): findings",
		"GPT-5 (thinking medium): the review detail",
	])("accepts the summary %s", (summary) => {
		const r = run(`${lines(5).join("\n")}\n${fold(summary, lines(10))}\n`);
		expect(r).toEqual({ status: 0, err: "" });
	});

	// Recurrence: text after the last fold is visible too, so a short opener
	// plus a 100-line tail would pass a check that reads only the text before
	// the first fold.
	it("counts visible text after a fold", () => {
		const r = run(
			`${lines(3).join("\n")}\n${fold(SUMMARY, lines(4))}\n${lines(10).join("\n")}\n`,
		);
		expect(r.status).toBe(1);
		expect(r.err).toContain("visible part");
	});

	// Recurrence: a quoted tag in a code fence is text, not a fold, so a fenced
	// `<details>` must neither satisfy the fold requirement nor close one.
	it("does not read a <details> inside a code fence as a fold", () => {
		const body = `${lines(3).join("\n")}\n\`\`\`html\n<details>\n<summary>${SUMMARY}</summary>\n\n${lines(10).join("\n")}\n</details>\n\`\`\`\n`;
		const r = run(body);
		expect(r.status).toBe(1);
		expect(r.err).toContain("no <details> fold");
	});

	// Recurrence: Markdown renders a four-space-indented tag as a code block,
	// so a fold written that way is 20 visible lines, not a fold.
	it("does not read an indented <details> as a fold", () => {
		const indented = fold(SUMMARY, lines(10))
			.split("\n")
			.map((line) => `    ${line}`)
			.join("\n");
		const r = run(`${lines(3).join("\n")}\n\n${indented}\n`);
		expect(r.status).toBe(1);
		expect(r.err).toContain("no <details> fold");
	});

	// Recurrence: a nested fold is hidden twice and the second summary escapes
	// the model rule; one fold per level, fail closed.
	it("refuses a nested details", () => {
		const inner = fold("Claude Opus 5.5 (high): inner", ["Inner."]);
		const r = run(
			`${lines(5).join("\n")}\n${fold(SUMMARY, [...lines(8), inner])}\n`,
		);
		expect(r.status).toBe(1);
		expect(r.err).toContain("nested");
	});

	// Recurrence: an unrecognised `<details` form is unread, never a pass.
	it("refuses a <details> tag form it does not recognise", () => {
		const r = run(`${lines(13).join("\n")}\n<details class="x">\n`);
		expect(r.status).toBe(1);
		expect(r.err).toContain("unrecognised");
	});

	it("accepts a short comment with no fold, and a short fold that is well formed", () => {
		expect(run(`${lines(12).join("\n")}\n`)).toEqual({ status: 0, err: "" });
		expect(run(`${lines(6).join("\n")}\n${fold(SUMMARY)}\n`)).toEqual({
			status: 0,
			err: "",
		});
	});

	// Recurrence: a malformed fold in a short comment still breaks rendering.
	it("checks fold structure in a short comment", () => {
		const r = run("Short.\n<details>\nNo summary.\n</details>\n");
		expect(r.status).toBe(1);
		expect(r.err).toContain("<summary>");
	});

	// Recurrence: #5510's rule was a wrapper accepting any fold. The worked
	// example in the standard is the shape roles copy, so it must pass the gate
	// it documents.
	it("accepts the worked example in docs/prose-standard.md", () => {
		const doc = fs.readFileSync(
			path.join(REPO_ROOT, "docs/prose-standard.md"),
			"utf8",
		);
		const example = doc
			.split("### Worked example")[1]
			?.match(/```markdown\n([\s\S]*?)\n```/)?.[1];
		expect(example).toBeTruthy();
		expect(run(`${example}\n`)).toEqual({ status: 0, err: "" });
	});

	// Recurrence: the #5543 reply, 4 visible items then a fold (summary shape
	// as posted, with a model named as the standard asks).
	it("accepts the #5543 reply shape", () => {
		const reply = [
			"Thanks for this. We reviewed it against master with real runners, and the anchoring does fix #5541 for the hoisted layout. Two regressions stop a merge for now, plus a Windows test fix.",
			"",
			"1. **Lint policy is read in the wrong directory (F1).** Master skips oxlint for `packages/a`, but this head runs it there.",
			"2. **Binary lookup moves with the cwd (F2).** With a pnpm-style install, this head skips with `not-installed`.",
			"3. **Windows red (F3).** `extension.log` is NDJSON, so parse the line before comparing.",
			"",
			"<details><summary>Claude Sonnet 5.5 (high): suggested shape and the probe matrix</summary>",
			"",
			"Keep the directory you had before anchoring on the resolution record. Use it for the package-scoped questions: policy, `requiresConfig`, Vite+ detection, binary lookup and availability.",
			"",
			"| tool | install | master | this head |",
			"|---|---|---|---|",
			"| oxlint | package only | runs package | skipped `not-installed` |",
			"| oxlint | hoisted to root | skipped | runs root (improvement) |",
			"| eslint | both | runs package | runs root |",
			"",
			"The 11 guard mutations we ran in the built output all fail as they should.",
			"</details>",
		].join("\n");
		expect(run(`${reply}\n`)).toEqual({ status: 0, err: "" });
	});

	// Recurrence: the prose checks must keep running in --comment mode, so the
	// layout gate does not replace them.
	it("still blocks a title-case heading in comment mode", () => {
		const r = run("## Some Title Case\n\nShort.\n");
		expect(r.status).toBe(1);
		expect(r.err).toContain("heading-case");
	});

	// Recurrence: an escape hatch with no stated reason is the wrapper's bare
	// override all over again.
	it("waives the long-comment rules only with a stated reason, and prints it", () => {
		const long = `${lines(20).join("\n")}\n`;
		const bare = run(long, "--long-ok", "x");
		expect(bare.status).toBe(1);
		expect(bare.err).toContain("12 or more characters");
		const ok = run(long, "--long-ok", "verbatim quote of the CI log");
		expect(ok.status).toBe(0);
		expect(ok.err).toContain("layout-waived: verbatim quote of the CI log");
		// The waiver never excuses a broken fold.
		const broken = run(
			`${lines(20).join("\n")}\n<details>\n`,
			"--long-ok",
			"verbatim quote of the CI log",
		);
		expect(broken.status).toBe(1);
	});

	// Recurrence: a flag that does nothing without `--comment` would read as a
	// waiver that was never applied.
	it("refuses --long-ok without --comment", () => {
		const r = runWith("Short.\n", ["--long-ok", "some reason here"]);
		expect(r.status).toBe(1);
		expect(r.err).toContain("--long-ok applies to --comment only");
	});
});
