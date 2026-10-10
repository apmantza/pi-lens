import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	lintClassSweep,
	lintLocalPrBody,
} from "../../scripts/check-pr-body.mjs";

// #4273: a `## Class sweep` names the defect shape, quotes the search that
// defines its population, and gives a verdict; or it says `none: <reason>`.
// A section that only enumerates the files this PR changed is refused, so the
// population of a shape cannot hide behind the change list (#4248 missed the
// #4268 members this way). The body fixtures are `gh pr view --json body`
// captures, bodies only, of the two real PRs the issue names.
const repositoryRoot = process.cwd();
const readBody = (name: string) =>
	readFileSync(
		join(repositoryRoot, "tests", "fixtures", "ci-pr-bodies", name),
		"utf8",
	);
const pr4248Body = readBody("pr-4248-body.md");
const pr4245Body = readBody("pr-4245-body.md");

const section = (sweep: string) =>
	`## Class sweep\n${sweep}\n\n## Observability\nRecorded.`;

describe("Class sweep shape and search (#4273)", () => {
	it("fails #4248's changed-file population with a template pointer", () => {
		const errors = lintClassSweep(pr4248Body);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain('"## Class sweep"');
		expect(errors[0]).toContain(".github/PULL_REQUEST_TEMPLATE.md");
	});

	it("passes #4245's named shape, quoted search, and per-member verdict", () => {
		expect(lintClassSweep(pr4245Body)).toEqual([]);
	});

	it("accepts none: with a reason of at least three words", () => {
		expect(
			lintClassSweep(section("none: docs only, no runtime change")),
		).toEqual([]);
	});

	it.each([
		[
			"no shape",
			"Search: `rg -n foo clients`. The family folds onto the bar seam.",
		],
		[
			"no quoted search",
			"Defect shape: a foo. The family folds onto the bar seam.",
		],
		[
			"no verdict",
			"Defect shape: a foo. Search: `rg -n foo clients`. The changed population is the loader.",
		],
	])("refuses a sweep with %s", (_name, sweep) => {
		expect(lintClassSweep(section(sweep))).toHaveLength(1);
	});

	it("reaches the local preflight composition", () => {
		const gitStub = () => "";
		expect(
			lintLocalPrBody(pr4248Body, process.cwd(), gitStub as never).errors.join(
				" ",
			),
		).toContain('"## Class sweep"');
		expect(
			lintLocalPrBody(pr4245Body, process.cwd(), gitStub as never).errors.join(
				" ",
			),
		).not.toContain('"## Class sweep"');
	});

	// F1: the template sanctions "a per-member line (an arrow or a coverage
	// note)" and the repo writes sweeps as markdown tables. The header here
	// carries no verdict keyword, so only the table-row branch can pass it.
	it("accepts a markdown table as a per-member verdict", () => {
		const table = [
			"Defect shape: a mapped runtime file changed without its model.",
			"Search: `rg -n read-guard formal`.",
			"",
			"| member | note |",
			"| --- | --- |",
			"| clients/a.ts | → read-guard seam |",
			"| clients/b.ts | Clean |",
		].join("\n");
		expect(lintClassSweep(section(table))).toEqual([]);
	});

	// The per-member branch predates the table form; keep a bullet/numbered
	// line pinned with no fold/stay keyword anywhere, so a mutation that drops
	// the line-prefix branch cannot ride the keyword path.
	it("accepts a bullet per-member verdict with no fold keyword", () => {
		const bullets = [
			"Defect shape: a mapped runtime file changed without its model.",
			"Search: `rg -n read-guard formal`.",
			"",
			"- clients/a.ts → read-guard seam",
			"- clients/b.ts — Clean",
		].join("\n");
		expect(lintClassSweep(section(bullets))).toEqual([]);
	});

	// F2: the repository cites AGENTS.md's numbered catalog (`Defect shape 25`)
	// and uses `Defect class:` / `Class:` for the same concept.
	it.each([
		[
			"numbered citation without a colon",
			"Defect shape 25 (mapped runtime file). Search: `rg -n read-guard formal`. Verdict: contained.",
		],
		[
			"numbered citation with a colon",
			"Defect shape 25: a mapped runtime file. Search: `rg -n read-guard formal`. Verdict: contained.",
		],
		[
			"defect class synonym",
			"Defect class: a mapped runtime file. Search: `rg -n read-guard formal`. Verdict: contained.",
		],
		[
			"class synonym",
			"Class: a mapped runtime file. Search: `rg -n read-guard formal`. Verdict: contained.",
		],
	])("accepts the shape label %s", (_name, sweep) => {
		expect(lintClassSweep(section(sweep))).toEqual([]);
	});

	it.each([
		["ugrep", "Search: `ugrep -n read-guard formal`."],
		[
			"a fenced ast-grep run",
			"Search:\n```sh\nast-grep run -p read-guard formal\n```",
		],
		["sg run", "Search: `sg run -p read-guard formal`."],
	])("accepts the %s search tool", (_name, search) => {
		expect(
			lintClassSweep(
				section(
					`Defect shape: a mapped runtime file. ${search} Verdict: contained.`,
				),
			),
		).toEqual([]);
	});

	// F3: `TLA+ unaffected: <family>` is a different governance statement and
	// must not satisfy the class-sweep verdict.
	it("does not accept a TLA+ unaffected line as the verdict", () => {
		expect(
			lintClassSweep(
				section(
					"Defect shape: a mapped runtime file. Search: `rg -n read-guard formal`. TLA+ unaffected: read-guard",
				),
			),
		).toHaveLength(1);
	});

	// F3: bound `none:`.
	it.each([
		["a one-word reason", "none: docs-only"],
		["a two-word reason", "none: no runtime"],
		["a punctuation-only reason", "none: ."],
	])("refuses none: with %s", (_name, sweep) => {
		expect(lintClassSweep(section(sweep))).toHaveLength(1);
	});

	const runtimeDiff =
		"diff --git a/clients/example.ts b/clients/example.ts\n@@ -1 +1 @@\n+const x = 1;";
	const shippedScriptDiff =
		"diff --git a/scripts/rpc-load-check.mjs b/scripts/rpc-load-check.mjs\n@@ -1 +1 @@\n+x";
	const governanceScriptDiff =
		"diff --git a/scripts/check-pr-body.mjs b/scripts/check-pr-body.mjs\n@@ -1 +1 @@\n+x";
	const docsDiff =
		"diff --git a/docs/example.md b/docs/example.md\n@@ -1 +1 @@\n+x";

	it.each([
		["a clients/ diff", runtimeDiff],
		["index.ts", "diff --git a/index.ts b/index.ts\n@@ -1 +1 @@\n+x"],
		["a shipped script diff", shippedScriptDiff],
	])("refuses none: when the diff changes %s", (_name, diff) => {
		expect(
			lintClassSweep(section("none: documentation only, nothing runtime"), {
				diff,
			}),
		).toHaveLength(1);
	});

	it.each([
		["a docs-only diff", docsDiff],
		["a non-shipped governance-script diff", governanceScriptDiff],
	])("accepts none: for %s", (_name, diff) => {
		expect(
			lintClassSweep(section("none: documentation only, nothing runtime"), {
				diff,
			}),
		).toEqual([]);
	});

	it("keeps the reason check when no diff is available", () => {
		expect(
			lintClassSweep(section("none: documentation only, nothing runtime")),
		).toEqual([]);
		expect(lintClassSweep(section("none: docs-only"))).toHaveLength(1);
	});
});
