/**
 * #5062: the bot-opened refresh PRs (the nightly LSP-docs refresh and the
 * idle-eviction promotion) are linted by `PR body (advisory)` like any other
 * PR, so the bodies their composers write must pass the real body lint.
 *
 * ## The recurrence this guards
 *
 * PR #4945 (head 1b7930bc1, run 41648177678) opened with a body that had none
 * of the template's required sections and a 25-line flips fence over the
 * 20-line cap, so the advisory check was red on the first push of every
 * nightly refresh. The composers (`buildRefreshPrBody`, `renderPromotionBody`)
 * had only ever been asserted on their own substrings, never on the lint the
 * PR meets.
 *
 * The cases run each real composer and pipe its output through the real
 * entry `lintLocalPrBody` (what `--lint-local` runs), with the diff the
 * workflow's `add-paths` produces for that PR.
 */
import { describe, expect, it } from "vitest";
import { lintLocalPrBody } from "../../scripts/check-pr-body.mjs";
import { renderPromotionBody } from "../../scripts/lib/lsp-idle-eviction-promote.mjs";
import { buildRefreshPrBody } from "../../scripts/lib/refresh-flips.mjs";

const fileDiff = (file: string) =>
	`diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old\n+new\n`;

// The paths each workflow step stages through `add-paths`.
const REFRESH_DIFF = [
	"docs/lsp-capability-matrix.md",
	"docs/servercapabilities.md",
	"docs/lsp-idle-eviction.md",
]
	.map(fileDiff)
	.join("");
const PROMOTE_DIFF = [
	"clients/lsp/server.ts",
	"tests/config/lsp-idle-eviction-reasons.json",
	"tests/config/lsp-idle-eviction-registry.test.ts",
	".changelog/3989-lsp-idle-eviction-promote.md",
]
	.map(fileDiff)
	.join("");

const REFRESH_TITLE = "docs(nightly): refresh LSP capability docs (refs #3217)";
const PROMOTE_TITLE =
	"perf(lsp): promote measured idle-eviction servers (refs #3989)";

// The post-image of each file the diff names, so the diff-keyed rows read the
// same bytes the diff adds without needing the real promotion edit on disk.
const postImages = (diff: string) =>
	new Map([...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => [m[1], "new\n"]));

function lint(body: string, title: string, diff: string) {
	// Only the PR diff is the workflow's. Every other git read throws, which the
	// lint answers with its in-process walk of tests/, so a citation in a body
	// is still judged against the tree and no git process is spawned (the
	// real-process-spawn ratchet, tests/clients/flake-shape-ratchet.test.ts).
	const git = ((args: string[]) => {
		if (args[0] === "diff") return diff;
		throw new Error("git is not available in this test");
	}) as never;
	// The label of a referenced issue is not this file's subject: pinned at the
	// process boundary, as tests/scripts/check-pr-body-bot-block.test.ts does.
	return lintLocalPrBody(body, process.cwd(), git, {
		title,
		headFiles: postImages(diff),
		bugClosing: false,
		bugReferenced: false,
	});
}

// The Tests section alone, so a phrase in another section (the verdict bullet
// also says "could not run") cannot satisfy an assertion about this one.
const testsSection = (body: string) =>
	body.slice(body.indexOf("### Tests"), body.indexOf("### Class sweep"));

const flipLines = (n: number) =>
	Array.from(
		{ length: n },
		(_, i) => `docs/lsp-capability-matrix.md: + | lang${i} | server${i} |`,
	);

describe("the LSP-docs refresh PR body passes the body lint (#5062)", () => {
	const landings = ["automerge", "ci-only", "manual"] as const;

	for (const landing of landings) {
		it(`flip-free, landing ${landing}`, () => {
			const body = buildRefreshPrBody({ flips: [], landing });
			expect(lint(body, REFRESH_TITLE, REFRESH_DIFF).errors).toEqual([]);
			expect(testsSection(body)).toContain("classified the flips above");
		});
	}

	it("with a few flips and the drift link", () => {
		const body = buildRefreshPrBody({
			flips: flipLines(3),
			landing: "ci-only",
			issuesUrl: "https://example.test/issues?q=label%3Anightly-drift",
		});
		expect(lint(body, REFRESH_TITLE, REFRESH_DIFF).errors).toEqual([]);
		expect(body).toContain("lang2");
	});

	// Recurrence: #4945 listed 25 flips in one fence (cap 20). The 6 not listed
	// are named by their exact count and by where their full rows live.
	it("with more flips than the fence cap, naming how many are not listed", () => {
		const body = buildRefreshPrBody({
			flips: flipLines(25),
			landing: "automerge",
			issuesUrl: "https://example.test/issues",
		});
		expect(lint(body, REFRESH_TITLE, REFRESH_DIFF).errors).toEqual([]);
		expect(body).toContain(
			`\`\`\`diff\n${flipLines(19).join("\n")}\n... 6 more, in the Files changed diff\n\`\`\``,
		);
	});

	it("with long flip lines, inside the visible-text budget", () => {
		const body = buildRefreshPrBody({
			flips: flipLines(70).map((line) => line + "x".repeat(300)),
			landing: "ci-only",
		});
		expect(lint(body, REFRESH_TITLE, REFRESH_DIFF).errors).toEqual([]);
	});

	// Recurrence: the Tests section said the landing script classified the flips
	// on this path, when the flip check had not run (review r1 F1).
	it("when the flip check could not run", () => {
		const body = buildRefreshPrBody({
			flips: [],
			landing: "automerge",
			checkFailed: true,
		});
		expect(lint(body, REFRESH_TITLE, REFRESH_DIFF).errors).toEqual([]);
		expect(testsSection(body)).not.toContain("classified the flips");
		expect(testsSection(body)).toContain("The flip check could not run");
	});
});

describe("the idle-eviction promotion PR body passes the body lint (#5062)", () => {
	const night = (day: string) => ({ day, rssMb: 120, coldMs: 40 });
	const promoted = (id: string) => ({
		serverId: id,
		minRssMb: 120,
		worstColdMs: 40,
		nights: [night("2026-11-01"), night("2026-11-02")],
	});

	it("one server", () => {
		const body = renderPromotionBody([promoted("json")], [], null);
		expect(lint(body, PROMOTE_TITLE, PROMOTE_DIFF).errors).toEqual([]);
	});

	it("many servers, a skipped list and a run link", () => {
		const body = renderPromotionBody(
			Array.from({ length: 12 }, (_, i) => promoted(`server${i}`)),
			Array.from({ length: 12 }, (_, i) => ({
				serverId: `held${i}`,
				reason: "a promotion PR containing this server was closed unmerged",
			})),
			"https://example.test/actions/runs/1",
		);
		expect(lint(body, PROMOTE_TITLE, PROMOTE_DIFF).errors).toEqual([]);
		// The marker the next night's closed-PR scan reads must survive.
		expect(body).toContain("<!-- idle-evict-set: ");
	});
});
