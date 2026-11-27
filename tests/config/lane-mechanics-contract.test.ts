import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { blankMarkdown } from "../../scripts/lib/defect-shapes.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const SECTION = "Orchestrator lane mechanics";

// PI_LENS_CONTRACT_DOCS_DIR lets the red run point at the pre-change docs, as
// PI_LENS_AGENTS_PATH does for agents-governance.test.ts.
function doc(name: string): string {
	return fs.readFileSync(
		path.join(
			process.env.PI_LENS_CONTRACT_DOCS_DIR ?? path.join(REPO_ROOT, "docs"),
			name,
		),
		"utf8",
	);
}

// Fenced blocks and HTML comments do not count (`blankMarkdown`): a heading or
// grant name quoted in an example must not satisfy a presence pin. Blanking
// keeps offsets, so the section's span in the blanked text is its
// span in the raw text.
function sectionSpan(text: string): [number, number] | undefined {
	const blanked = blankMarkdown(text);
	const start = blanked.search(new RegExp(`^## ${SECTION}\\s*$`, "m"));
	if (start < 0) return undefined;
	const next = blanked.slice(start + 1).search(/^## /m);
	return [start, next < 0 ? text.length : start + 1 + next];
}

function sectionBody(text: string): string {
	const span = sectionSpan(text);
	return span ? text.slice(span[0], span[1]) : "";
}

function outsideSection(text: string): string {
	const span = sectionSpan(text);
	return span ? text.slice(0, span[0]) + text.slice(span[1]) : text;
}

const flat = (text: string): string => text.replace(/\s+/g, " ");

describe("orchestrator lane mechanics contract (#4007)", () => {
	// Recurrence: about 30 delegated briefs each restated the same lane
	// boilerplate, so the copies drifted; the one home is this section.
	it("keeps the section in the shared subagent contract", () => {
		expect(sectionBody(doc("pi-lens-subagent.md")).trim()).not.toBe("");
	});

	// Recurrence: a brief naming a grant that the contract does not define (or
	// a renamed grant) leaves workers guessing what push/PR authority they hold.
	it("defines each Git-authority grant by name", () => {
		const body = sectionBody(doc("pi-lens-subagent.md"));
		for (const grant of ["own-branch", "fork-push", "none"]) {
			expect(body, grant).toMatch(new RegExp(`^ {2}- \`${grant}\`: `, "m"));
		}
	});

	// Recurrence: #3173 (`git worktree remove` over a symlinked node_modules
	// deleted the main install), #3526 (checkouts under tmpfs /tmp), and
	// worker commands run without a lane TMPDIR.
	it("states the checkout, teardown, TMPDIR and summary rules", () => {
		const body = flat(sectionBody(doc("pi-lens-subagent.md")));
		expect(body).toContain(
			"~/.local/share/pi-lens-orchestrator/tmp/<lane>`, never under `/tmp`",
		);
		expect(body).toContain(
			"TMPDIR=~/.local/share/pi-lens-orchestrator/tmp/<lane>-tmp",
		);
		expect(body).toMatch(
			/`rm` a symlinked `node_modules` before `git worktree remove`/,
		);
		expect(body).toContain("#3173");
		expect(body).toContain("Never force");
		expect(body).toContain("ORCHESTRATOR SUMMARY`. Its cap");
		expect(body).toContain("at most 6 lines for a mechanical lane");
		expect(body).toMatch(
			/20 for a locate or investigation\s+pass, and 30 for a fix or review round/,
		);
	});

	// Recurrence: #4044 (2026-10-07: a verify worker's `npm ci --ignore-scripts
	// --dry-run` through a linked node_modules emptied the main install under
	// every lane; the contract only said "preserve linked dependencies" and the
	// brief itself invited the local run).
	it("forbids mutating npm verbs through a linked node_modules and names the scratch-copy answer", () => {
		const body = flat(sectionBody(doc("pi-lens-subagent.md")));
		expect(body).toMatch(
			/Never run a mutating npm verb \([^)]*`ci`[^)]*\), even `--dry-run`, where `node_modules` is a link/,
		);
		expect(body).toContain("#4044");
		expect(body).toContain("Answer install-flag questions in a scratch copy");
		// #4044 sibling: the slash/glob delete forms empty the link target.
		expect(body).toContain(
			"Unlink with `rm node_modules` (no trailing slash or glob)",
		);
	});

	// Recurrence: the section is only useful when the role contracts point to
	// it instead of carrying their own copy.
	it.each(["pi-lens-fixer.md", "pi-lens-reviewer.md"])(
		"points %s at the section",
		(name) => {
			expect(flat(doc(name))).toContain(
				`\`docs/pi-lens-subagent.md\` "${SECTION}"`,
			);
		},
	);

	// Recurrence: the removed copies were the push-form and scratch-path lines
	// that now live only in the section.
	it("keeps the push form and lane TMPDIR in one place", () => {
		const subagent = doc("pi-lens-subagent.md");
		const outside = outsideSection(subagent);
		expect(outside).not.toContain(
			"credential.helper='!gh auth git-credential'",
		);
		expect(outside).not.toContain("pi-lens-orchestrator/tmp/<lane>");
		expect(doc("pi-lens-reviewer.md")).not.toContain(
			"pi-lens-orchestrator/tmp/<lane>",
		);
	});
});

// Recurrence: 2026-10-17. Greptile posted a P1 on #4566 and two P2s on #4575
// at the heads the fixers had just pushed. Neither worker read them; the
// threads reached the next round only because the orchestrator relayed them.
// docs/pi-lens-merge-policy.md:34 and :81 make a disposition reply and a
// resolved thread a merge condition, but neither role contract told a worker
// to look. These pins hold the read-at-round-start rule and the verdict gate.
describe("bot review threads and code-scanning alerts (#4566/#4575)", () => {
	// A rule quoted in a fence or an HTML comment is an example, not the rule
	// (#4248), so presence is read from blanked text: a command block copied
	// into a doc cannot satisfy a pin its own sentences do not carry.
	const rule = (name: string): string => flat(blankMarkdown(doc(name)));

	it("sends the fixer to the unresolved threads and the open alerts", () => {
		const text = rule("pi-lens-fixer.md");
		// Conditional by construction: a bot review that never arrives is not a
		// gate, so the rule must not read as a prerequisite the round waits on.
		expect(text).toMatch(
			/when bot threads or code-scanning alerts exist, read and dispose of each one/i,
		);
		expect(text).toMatch(/missing bot review is never evidence/i);
		expect(text).toContain("reviewThreads");
		expect(text).toContain("isResolved == false");
		expect(text).toContain("code-scanning/alerts");
		expect(text).toContain("state=open");
		// The alert query is per branch: an alert on master is not this round's.
		expect(text).toContain("refs/heads/<branch>");
	});

	it("disposes of every thread before the fixer hands back", () => {
		const text = rule("pi-lens-fixer.md");
		expect(text).toMatch(/reply to and resolve/);
		expect(text).toMatch(/disposition/);
		// A rule without its recurrence loses its argument at the next edit.
		expect(text).toContain("#4566");
		expect(text).toContain("#4575");
	});

	// Recurrence: #4587 round 1. Both commands stopped at page one, so a
	// finding past it was never read, and the reviewer reuses the same text.
	it("follows both commands to their last page and says so", () => {
		const text = rule("pi-lens-fixer.md");
		expect(text).toContain("gh api graphql --paginate");
		expect(text).toContain(
			'gh api --paginate "repos/{owner}/{repo}/code-scanning/alerts',
		);
		// Round 2 of #4587: `--paginate` pages nothing on its own. The query
		// pages through its cursor, so every cursor field the doc spells is
		// pinned; deleting one leaves a query that reads page one for ever.
		expect(text).toContain("$endCursor:String");
		expect(text).toContain("after:$endCursor");
		expect(text).toContain("pageInfo{hasNextPage endCursor}");
		// The truncation itself is disclosed: one page never reads as the list.
		expect(text).toMatch(/clear only after that page prints/i);
		expect(text).toMatch(/one page is never read as the whole list/i);
	});

	it("refuses a merge-ready verdict over an undisposed thread or alert", () => {
		const text = rule("pi-lens-reviewer.md");
		expect(text).toMatch(
			/when bot threads or code-scanning alerts exist, read and dispose of each one/i,
		);
		// The reviewer's own pass stands alone: no bot pre-pass, no waiting.
		expect(text).toMatch(/missing bot review is never evidence/i);
		expect(text).toMatch(/never wait/i);
		expect(text).toMatch(/stand alone/i);
		expect(text).toContain("reviewThreads");
		expect(text).toContain("code-scanning");
		// Each item is rated, so an unprobed one cannot read as cleared.
		expect(text).toMatch(/refuted/);
		// The prohibition itself is the gate: dropping the negation, not only the
		// verdict word, must red this pin (mutation: delete "No" from
		// docs/pi-lens-reviewer.md). Round 1 of #4587: the old sentence-scoped
		// match stayed green with the gate reversed.
		expect(text).toMatch(
			/no `merge-ready` verdict while any thread or alert stays undisposed/i,
		);
		expect(text).toContain("#4566");
		expect(text).toContain("#4575");
	});

	// Both contracts cite the merge policy's own lines instead of carrying a
	// copy of the disposition vocabulary, which would drift from its owner.
	it.each(["pi-lens-fixer.md", "pi-lens-reviewer.md"])(
		"points %s at the merge-policy rule instead of restating it",
		(name) => {
			expect(rule(name)).toContain(
				`\`docs/pi-lens-merge-policy.md\` "The loop, per PR"`,
			);
		},
	);
});

// Recurrence: #5645 closed a Windows timeout by scaling the cell's budget and
// named no slow step; #5802, a sibling cell in the same file, timed out next.
// Flakes had also closed on case-by-case windows (#2042 on 11 clean runs,
// others on one green rerun). These pins hold the two rules in their one home
// (the fixer contract) and every pointer that makes them bind.
describe("flaky-test rules (#5806)", () => {
	const rule = (name: string): string => flat(blankMarkdown(doc(name)));
	const agents = (): string =>
		flat(
			blankMarkdown(
				fs.readFileSync(
					process.env.PI_LENS_AGENTS_PATH ?? path.join(REPO_ROOT, "AGENTS.md"),
					"utf8",
				),
			),
		);
	// The fixer section body, so a sentence elsewhere cannot satisfy a pin.
	const fixerSection = (): string => {
		const text = rule("pi-lens-fixer.md");
		const start = text.indexOf("## Flaky tests");
		if (start < 0) return "";
		const next = text.indexOf(" ## ", start + 1);
		return text.slice(start, next < 0 ? undefined : next);
	};

	// Recurrence: a scaled or lengthened budget, a retry, a skip or a quarantine
	// made the failure go away without a reproduction (#5645 -> #5802).
	it("states no-reproduction-no-fix with the measurement a budget increase needs", () => {
		const text = fixerSection();
		expect(text).toMatch(/No reproduction, no fix\./);
		expect(text).toMatch(
			/A retry, a longer or scaled timeout[^.]*a skip or a quarantine is not a fix/,
		);
		expect(text).toMatch(
			/Raise a budget only with a measurement that names the slow step and its time on the failing host/,
		);
		expect(text).toContain("#5645");
		expect(text).toContain("#5802");
	});

	// Recurrence: closing windows were picked case by case (#2042: 11 runs;
	// others: one green rerun).
	it("states the 3/p stopping rule with its derivation and how p is estimated", () => {
		const text = fixerSection();
		expect(text).toMatch(
			/failure rate p counts as fixed after 3\/p consecutive clean runs/,
		);
		expect(text).toContain("e^-3");
		expect(text).toMatch(/about 95% confidence/);
		expect(text).toMatch(
			/Estimate p\*\* as failures over runs of the same job in a stated window/,
		);
	});

	// Recurrence: a flake whose 3/p is out of reach closed as fixed, so the next
	// failure read as a regression instead of an unfinished count.
	it("sends an impractical 3/p to the accepted-gap record and never to a fix close", () => {
		const text = fixerSection();
		expect(text).toMatch(/do not close the issue as fixed/);
		expect(text).toMatch(/accepted gap/);
		expect(text).toMatch(
			/each state p, the failures, runs and window behind it, and the clean-run count reached against 3\/p/,
		);
	});

	// Recurrence: the reviewer checklist is what judges a flake close; without
	// its own item a close on one green rerun reads as merge-ready.
	it("puts the rules on the reviewer checklist, pointing at the fixer home", () => {
		const text = rule("pi-lens-reviewer.md");
		expect(text).toContain("**Flake fixes and flake closes.**");
		expect(text).toContain('`docs/pi-lens-fixer.md` "Flaky tests"');
		expect(text).toMatch(/a close on one green rerun[^.]*is a finding/);
	});

	// Recurrence: the close and the known-gap record are where the numbers are
	// quoted; each points at the one home instead of restating the rule.
	it("points the merge policy's close and known-gap record at the fixer home", () => {
		const text = rule("pi-lens-merge-policy.md");
		expect(text).toMatch(
			/A flake issue closes as fixed only when the comment that closes it quotes p/,
		);
		expect(text).toMatch(
			/A flake whose 3\/p clean-run count is impractical joins the tracker/,
		);
		expect(text.match(/`docs\/pi-lens-fixer\.md` "Flaky tests"/g)?.length).toBe(
			2,
		);
	});

	// Recurrence: AGENTS.md's one-line flake rule predates the scaled-timeout
	// shape; it must name that form and point at the home, not copy the rule.
	it("keeps the AGENTS.md flake line pointing at the fixer home", () => {
		const text = agents();
		expect(text).toMatch(/no scaled timeout without a measured slow step/);
		expect(text).toContain('`docs/pi-lens-fixer.md` "Flaky tests"');
		expect(text).not.toContain("3/p consecutive clean runs");
	});
});
