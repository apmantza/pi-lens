import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	lintLocalPrBody,
	lintPullRequestEvent,
} from "../../scripts/check-pr-body.mjs";

// #4774: a bot that edits a PR body appends its block after the author's last
// section, and `## Fold check` is the template's last section. Greptile's
// "Last reviewed commit" link quotes a commit title that ends `(refs #N)`, so
// the check read `#N` as a candidate with no decision (PR 4767, run
// 39863184911). The rule under test: the body ends at the first top-level
// HTML comment after the last heading the template names, so any bot's block
// is cut, a marker nobody listed included. Every case goes through a
// production entry (`lintPullRequestEvent`, CI's, and `lintLocalPrBody`, the
// preflight's); only the GitHub fetch at the process boundary is a double.
//
// #4778 round 1: the cut text goes to the SECTION readers only. A reader that
// owns a GitHub semantic (the closing keywords, the bug label of a closed
// issue, the `Closes #N` a `folded` candidate needs) reads the full body,
// because GitHub acts on the whole of it.
//
// Cost (#4778 F1): a body that cites `tests/...` makes the lint read and lex
// every test file (`testCorpus`, about 1 s idle and 5 s on a loaded CI shard,
// where the first version of this file hit the 5 s default). The cwd below
// sits where `git ls-files -- tests` matches nothing, so the scan is empty.
// The one error that costs is the test-reference error the real #4767 body
// then earns, which the real-body cases name and no other case meets: the
// other cases use a compact body that cites no test.

const FIXTURE_DIR = fileURLToPath(
	new URL("../fixtures/pr-body-bot-blocks/", import.meta.url),
);
const fixture = (name: string) => readFileSync(`${FIXTURE_DIR}${name}`, "utf8");
const GREPTILE = "<!-- greptile_comment -->";
const full4767 = fixture("4767.body.txt");
const FOLD_REFUSAL = 'PR body "## Fold check" must decide each candidate';
const TEST_REFERENCE = "PR body test reference is missing under tests/";

const compact = (fold: string[]) =>
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
		...fold,
		"",
		"🤖 Generated with [Claude Code](https://claude.com/claude-code)",
	].join("\n");
const DECIDED = [
	"- #4606 not folded: a different file and a separate rule.",
	"- #4602 not folded: a different rule on another seam.",
];
const authoredSmall = compact(DECIDED);
const BOT = (quoted: string) =>
	`\n\n${GREPTILE}\n\nLast reviewed commit: [fix thing (${quoted})](https://example.test/c/1)\n`;

function setup() {
	let previousCwd = "";
	beforeEach(() => {
		previousCwd = process.cwd();
		process.chdir(FIXTURE_DIR);
		vi.stubEnv("GITHUB_TOKEN", "t");
		vi.stubEnv("GITHUB_API_URL", "https://api.example");
		vi.stubEnv("GITHUB_REPOSITORY", "o/r");
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => {
		process.chdir(previousCwd);
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});
}

// `labels` is the label list the double answers for any `/issues/<n>`.
async function ci(text: string, labels: string[] = []) {
	const errors = vi.spyOn(console, "error").mockImplementation(() => {});
	const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
		if (String(url).includes("/files"))
			return new Response("[]", { status: 200 });
		if (/\/issues\/\d+$/.test(String(url)))
			return new Response(
				JSON.stringify({ labels: labels.map((name) => ({ name })) }),
				{ status: 200 },
			);
		return new Response(JSON.stringify({ body: text }), { status: 200 });
	});
	const result = await lintPullRequestEvent(
		fetchImpl,
		{ pull_request: { number: 4767, body: text } },
		() => "",
	);
	const printed = errors.mock.calls.flat().join("\n");
	errors.mockClear();
	return { result, printed };
}
// The label of a referenced issue is not this file's subject (#4968): the
// cut is, so the reference label read is pinned at its process boundary.
const localResult = (text: string) =>
	lintLocalPrBody(text, process.cwd(), (() => "") as never, {
		bugReferenced: false,
	});
const local = (text: string) => localResult(text).errors.join("\n");

describe("a bot block appended to the body never counts (#4774)", () => {
	setup();

	// What a real-body case may still print: the test-reference error that the
	// empty corpus earns the body's `tests/...` citations, the caps and the section
	// shapes (`Proof and checks`, Summary, Notes) a body written
	// before #5003 does not meet, and nothing else.
	const unexpected = (printed: string) =>
		printed
			.split("\n")
			.filter(
				(line) =>
					line.trim() &&
					!line.startsWith(TEST_REFERENCE) &&
					!/^PR body (?:is \d+ visible|has a \d+-line|has a code line|has \d+ code lines|is missing "## Proof and checks"|"Class sweep" needs exactly one line|"## Summary" must hold|"## Notes for the reviewer" allows)/.test(
						line,
					),
			);

	// Acceptance 1 and 2. Recurrence: PR 4767 at 7f7ee1127, whose body ends with
	// Greptile's block quoting `(refs #43...`.
	it("passes CI's entry for the #4767 body with Greptile's block", async () => {
		const { printed } = await ci(full4767);
		expect(printed).not.toContain(FOLD_REFUSAL);
		expect(unexpected(printed)).toEqual([]);
	});

	it("passes the local preflight for the #4767 body with Greptile's block", () => {
		const printed = local(full4767);
		expect(printed).not.toContain(FOLD_REFUSAL);
		expect(unexpected(printed)).toEqual([]);
	});

	// Acceptance 3. The cut must not swallow a real defect: an undecided `#N`
	// line in the author's own Fold check still refuses, block or no block.
	it("still refuses a real undecided candidate line before the block", async () => {
		const undecided = full4767.replace(
			"- #3875 not folded:",
			"- #3875 landed on master and this branch merged it. Also #3875 not folded:",
		);
		expect(undecided).not.toBe(full4767);
		const { result, printed } = await ci(undecided);
		expect(printed).toContain(FOLD_REFUSAL);
		expect(result.valid).toBe(false);
		expect(local(undecided)).toContain(FOLD_REFUSAL);
	});

	// The admission rule names no bot. Recurrence it prevents: a fix that
	// listed `<!-- greptile_comment -->` would leave the next bot's marker (a
	// planted one here, nobody's list) reading as the author's text.
	it("cuts a block behind a marker no list holds", async () => {
		const planted = `${authoredSmall}\n\n<!-- unplanned-bot:v9 -->\n\nLast reviewed commit: [fix thing (refs #4999)](https://example.test/c/1)\n`;
		const { result, printed } = await ci(planted);
		expect(printed).not.toContain(FOLD_REFUSAL);
		expect(result).toMatchObject({ valid: true });
		expect(local(planted)).not.toContain(FOLD_REFUSAL);
	});

	// CodeRabbit's block (captured from PR 4680) opens with another marker and
	// holds a markdown heading. Recurrence it prevents: a rule that took any
	// heading for the author's would stop its cut at that heading's marker. The
	// heading is nested one level (`###`), as CodeRabbit's walkthrough nests
	// its own, so it does not end `## Fold check` and the block's quoted
	// `(refs #4999)` lands in the section unless the cut removes it.
	it("cuts CodeRabbit's block, marker and nested heading included", async () => {
		const block = fixture("4680.coderabbit-block.txt")
			.replace("## Summary by CodeRabbit", "### Summary by CodeRabbit")
			.replace("Improved CI handling", "Improved CI handling (refs #4999)");
		expect(block).toContain("### Summary by CodeRabbit");
		const { result, printed } = await ci(`${authoredSmall}\n\n\n${block}`);
		expect(printed).not.toContain(FOLD_REFUSAL);
		expect(result).toMatchObject({ valid: true });
	});

	it("cuts the block of a CRLF body", async () => {
		const { result, printed } = await ci(
			`${authoredSmall}${BOT("refs #4999")}`.replace(/\n/g, "\r\n"),
		);
		expect(printed).not.toContain(FOLD_REFUSAL);
		expect(result).toMatchObject({ valid: true });
	});

	// The author's own comment stays. Recurrence it prevents: PRs 4563 and 4584
	// open with `<!-- ORCHESTRATOR SUMMARY ... -->`, and a cut at the first
	// comment would drop all their sections.
	it("keeps an author comment that a template heading follows", async () => {
		const withTop = `<!-- ORCHESTRATOR SUMMARY\nlane 4774, one note\n-->\n\n${authoredSmall}${BOT("refs #4999")}`;
		const { result, printed } = await ci(withTop);
		expect(printed).not.toContain("is missing");
		expect(printed).not.toContain(FOLD_REFUSAL);
		expect(result).toMatchObject({ valid: true });
	});

	// A bot block with an author section behind it (a fixer appends a round to
	// the stored body) ends the text there: the block never reaches
	// `## Fold check`. Recurrence it prevents: admitting the round heading as
	// the author's last section would keep the block.
	it("cuts a block that a later round section follows", async () => {
		const middle = `${authoredSmall}${BOT("refs #4999")}\n## Review round 1\nThe round fixed the cited finding.\n`;
		const { result, printed } = await ci(middle);
		expect(printed).not.toContain(FOLD_REFUSAL);
		expect(result).toMatchObject({ valid: true });
	});

	// A `<!--` inside a fence is quoted text, not the start of a block.
	it("does not cut at a comment quoted in a fence", async () => {
		const quoted = compact([
			...DECIDED,
			"```html",
			"<!-- quoted -->",
			"```",
			"- #4610 not folded: a different rule on another seam.",
		]);
		const { result, printed } = await ci(`${quoted}${BOT("refs #4999")}`);
		expect(printed).not.toContain(FOLD_REFUSAL);
		expect(result).toMatchObject({ valid: true });
		// The line after the fence was read: the same body with it undecided
		// refuses, so the cut did not stop at the quoted comment.
		const undecided = quoted.replace(
			"- #4610 not folded: a different rule on another seam.",
			"- #4610 landed on master.",
		);
		expect(undecided).not.toBe(quoted);
		expect((await ci(`${undecided}${BOT("refs #4999")}`)).printed).toContain(
			FOLD_REFUSAL,
		);
	});
});

// #4778 F2 (Greptile P2, CodeRabbit threads 1 and 3). Recurrence it prevents:
// the cut was applied before the close-keyword readers, so the local
// preflight returned clean on a body whose only defect sat behind a bot
// marker while the gating `Close-keyword syntax` job (full body) reddened,
// and an issue GitHub closes through text behind a marker skipped the bug
// retrospective.
describe("readers that own a GitHub semantic read the full body (#4778 F2)", () => {
	setup();

	it("refuses a close-keyword defect behind a bot marker, as CI's close-keyword job does", () => {
		const text = `${authoredSmall}\n\n<!-- bot -->\n\nNot fixed #4999\n`;
		const { valid, errors } = localResult(text);
		expect(valid).toBe(false);
		expect(errors.join("\n")).toContain("offending line: Not fixed #4999");
	});

	it("requires ## Detection for a bug issue that only text behind a marker closes", async () => {
		const text = `${authoredSmall}\n\n<!-- bot -->\n\nCloses #4999\n`;
		const bug = await ci(text, ["bug"]);
		expect(bug.result.valid).toBe(false);
		expect(bug.printed).toContain('PR body is missing "## Detection"');
		// Control: the same body is clean when the issue is no bug.
		const plain = await ci(text, ["enhancement"]);
		expect(plain.printed).not.toContain("Detection");
	});

	// The title names `#4602`, and the body's `Closes #4602` sits behind the
	// marker: GitHub honours it, so the placement lint must too.
	it("honours a close keyword behind a marker for the title's issue", () => {
		const text = `${authoredSmall}\n\n<!-- bot -->\n\nCloses #4602\n`;
		const result = lintLocalPrBody(text, process.cwd(), (() => "") as never, {
			title: "fix: x (closes #4602)",
		});
		expect(result.errors.join("\n")).not.toContain(
			"Invalid close-keyword placement",
		);
	});

	// The bug-label resolvers and the "label unreadable" warning read the
	// closed issues of the whole body.
	it("hands the whole body to the label reader and warns for an issue behind a marker", async () => {
		const text = `${authoredSmall}\n\n<!-- bot -->\n\nCloses #4999\n`;
		const resolveBugClosing = vi.fn().mockReturnValue(null);
		lintLocalPrBody(text, process.cwd(), (() => "") as never, {
			resolveBugClosing,
		});
		expect(resolveBugClosing).toHaveBeenCalledWith(text);
		const unreadable = "could not read the closed issue label";
		expect(
			vi
				.mocked(console.warn)
				.mock.calls.flat()
				.filter((line) => String(line).includes(unreadable)),
		).toHaveLength(1);
		vi.mocked(console.warn).mockClear();
		// CI's entry: the label fetch fails, and the warning still names the
		// issue only the cut text hides.
		const failing = vi.fn().mockImplementation(async (url: string) => {
			if (/\/issues\/\d+$/.test(String(url)))
				return new Response("{}", { status: 500 });
			if (String(url).includes("/files"))
				return new Response("[]", { status: 200 });
			return new Response(JSON.stringify({ body: text }), { status: 200 });
		});
		await lintPullRequestEvent(
			failing,
			{ pull_request: { number: 7, body: text } },
			() => "",
		);
		expect(
			vi
				.mocked(console.warn)
				.mock.calls.flat()
				.filter((line) => String(line).includes(unreadable)),
		).toHaveLength(1);
	});

	// The live #4581 shape: the author's `Closes #N` sits behind the bot block.
	// A `folded` candidate needs it, and GitHub closes the issue from it.
	it("lets a close keyword behind a marker satisfy a folded candidate", async () => {
		const text = `${compact(["- #4602 folded: the same body-lint seam, so its rule lands here."])}\n\n<!-- bot -->\n\nCloses #4602\n`;
		const { printed } = await ci(text);
		expect(printed).not.toContain(FOLD_REFUSAL);
		expect(local(text)).not.toContain(FOLD_REFUSAL);
	});
});

// #4778 F3. The direction of the rule, pinned: the cut cannot tell an author's
// own top-level comment after the last template heading from a bot marker, so
// the author's later lines are dropped. For `## Fold check` that means a later
// undecided candidate is not read and the check passes where the full body
// would refuse. Accepted p3 residual, live 0 in the last 200 bodies. Recurrence
// it prevents: the docstring, the branch comment and the PR body claimed the
// opposite ("can only refuse").
describe("an author comment after the last template heading drops what follows (#4778 F3)", () => {
	setup();

	it("does not read an undecided candidate behind the author's own comment", () => {
		const text = compact([...DECIDED, "<!-- my own note -->", "- #4999"]);
		expect(local(text)).not.toContain(FOLD_REFUSAL);
	});

	it("reads the same undecided candidate when no comment precedes it", () => {
		const text = compact([...DECIDED, "- #4999"]);
		expect(local(text)).toContain(FOLD_REFUSAL);
	});
});
