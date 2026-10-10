/**
 * #3401 — the expiry and hysteresis guards on `docs/lsp-capability-matrix.md`'s
 * probe-owned cells.
 *
 * ## The recurrence this guards
 *
 * `probe-clean-signal.mjs`'s merge guard preserves a cell the current run did
 * not measure, so an ubuntu-poor nightly cannot regress a richer dev-box row
 * (#390). But "not measured" is also how a stale value hides: the vue and
 * ast-grep `first-publish=direct` cells were produced by the pre-#3394
 * attribution defect, and once the corrected probe observed NOTHING on that
 * axis the guard kept them forever — a dead instrument and a healthy one look
 * identical when non-results are discarded by design (the #3310 lesson).
 *
 * A second shape is a flap: ast-grep's `clean-behavior` went 2 → 2* → 3 → 2*
 * across four nightlies, so any single run could rewrite a tier. The fix holds
 * a change as `pending` until `TIER_CHANGE_AGREE_RUNS` consecutive runs agree.
 *
 * Both need an observation memory that outlives one nightly. The matrix doc is
 * the only state the refresh persists, so the bookkeeping lives in a generated
 * section of that same doc. The nightly seeds its working copy from the last
 * `bot/lsp-docs-refresh` doc (even an unmerged one), so the clock is the
 * nightly run, not the bot PR's merge (round 2; the seed is tested in
 * tests/scripts/seed-matrix-from-bot-branch.test.ts). The first-publish expiry
 * is DATE-based (`firstMissed`, written once, expires after N elapsed days) so a
 * skipped nightly cannot stall it; the tier hysteresis stays run-based. These
 * tests drive the real refresh entry, `refreshCapabilityMatrix`, with recorded
 * run inputs, an injected clock and no LSP spawn.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { strategyKeyForLang } from "../../scripts/lib/clean-signal.mjs";
import { SERVER_DIAGNOSTIC_STRATEGIES } from "../../clients/lsp/wait-policy/strategies.js";
import {
	FIRST_PUBLISH_EXPIRY_DAYS,
	TIER_CHANGE_AGREE_RUNS,
	mergeRows,
	parseRefreshState,
	parseTable,
	refreshCapabilityMatrix,
	replaceTable,
	type MatrixObservation,
} from "../../scripts/lib/md-matrix.mjs";

const MARKER = "| lang | server |";
const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

const FIXTURE = [
	"# LSP capability matrix",
	"",
	"| lang | server | mode | clean-behavior | first-publish | tier | src |",
	"|---|---|---|---|---|---|---|",
	"| vue | @vue/language-server | push-only | unknown | direct | 2/3? | dev+ci |",
	"| ast-grep | ast-grep (aux) | push-only | publishes-versioned | direct | 2 | dev+ci |",
	"| rust | rust-analyzer | pull | — | n/a (pull) | 1 | dev+ci |",
	"| php | intelephense | push-only | publishes-unversioned | empty-first | 2* | dev+ci |",
	"| svelte | svelteserver | push-only | unknown | unknown | 3? | dev |",
	"",
	"## Key findings",
	"",
	"Prose after the table must survive the refresh.",
	"",
].join("\n");

/** Read one cell from the fixture matrix by lang + header name. */
function cellOf(
	text: string,
	lang: string,
	column: string,
): string | undefined {
	const table = parseTable(text, MARKER);
	if (!table) return undefined;
	const langIdx = table.header.indexOf("lang");
	const colIdx = table.header.indexOf(column);
	if (langIdx < 0 || colIdx < 0) return undefined;
	for (const cells of table.rows) {
		if (cells[langIdx] === lang) return cells[colIdx];
	}
	return undefined;
}

/**
 * A classified observation, as the probe hands it to the refresh entry: an axis
 * the run did not observe comparably is `null` (the expiry population), and a
 * measured clean-behavior carries the tier the writer should record with it.
 */
function observation(
	lang: string,
	overrides: Partial<MatrixObservation> = {},
): MatrixObservation {
	return {
		lang,
		cleanBehavior: null,
		firstPublish: null,
		tier: null,
		...overrides,
	};
}

/** A recorded run input that measured both axes. */
function measured(
	lang: string,
	cleanBehavior: string,
	tier: string,
): MatrixObservation {
	return observation(lang, {
		cleanBehavior,
		tier,
		firstPublish: "direct",
	});
}

/** The injected clock: nightly `n` days after 2026-09-01 (UTC). */
function day(n: number): string {
	return new Date(Date.UTC(2026, 8, 1 + n)).toISOString().slice(0, 10);
}

/** One nightly run on `day(n)`; `extra` carries probedLangs etc. */
function nightly(
	text: string,
	n: number,
	observations: readonly MatrixObservation[] = [],
	extra: { probedLangs?: readonly string[] } = {},
) {
	return refreshCapabilityMatrix(text, observations, {
		src: "ci",
		now: day(n),
		...extra,
	});
}

describe("#3401 first-publish expiry (date-based)", () => {
	it("preserves a stale first-publish cell through the plain merge guard (the pre-fix defect)", () => {
		// The pre-fix production path: the merge guard writes only the columns a
		// run measured, so a run with no first-publish observation leaves the
		// stale `direct` in place. This is the behavior the expiry must end.
		const table = parseTable(FIXTURE, MARKER)!;
		const merged = mergeRows(
			table.rows,
			table.header,
			[{ lang: "vue", src: "ci" }],
			"lang",
			["clean-behavior", "first-publish", "tier", "src"],
			{ updateOnly: true },
		);
		const preFix = replaceTable(
			FIXTURE,
			MARKER,
			table.header,
			table.sep,
			merged,
		)!;
		expect(cellOf(preFix, "vue", "first-publish")).toBe("direct");
	});

	it("keeps the stale cell until FIRST_PUBLISH_EXPIRY_DAYS have elapsed, then expires it to unknown", () => {
		let text = FIXTURE;
		for (let n = 0; n < FIRST_PUBLISH_EXPIRY_DAYS; n++) {
			text = nightly(text, n).text;
			expect(
				cellOf(text, "vue", "first-publish"),
				`night ${n} is ${n} elapsed days after the first miss: the cell must still stand`,
			).toBe("direct");
		}
		const final = nightly(text, FIRST_PUBLISH_EXPIRY_DAYS);
		expect(cellOf(final.text, "vue", "first-publish")).toBe("unknown");
		expect(cellOf(final.text, "ast-grep", "first-publish")).toBe("unknown");
		expect(final.expired).toBe(2);
		expect(final.expiredLangs).toEqual(["vue", "ast-grep"]);
		// The expired cell's bookkeeping is gone, so a settled doc is stable.
		expect(parseRefreshState(final.text)["first-publish"]).toBeUndefined();
	});

	it("writes firstMissed once, at the first miss, and never slides it", () => {
		let text = nightly(FIXTURE, 0).text;
		expect(parseRefreshState(text)["first-publish"]?.vue).toEqual({
			firstMissed: day(0),
		});
		text = nightly(text, 1).text;
		text = nightly(text, 3).text;
		expect(parseRefreshState(text)["first-publish"]?.vue).toEqual({
			firstMissed: day(0),
		});
	});

	it("counts elapsed days, not runs: a run after skipped nights expires a stale cell", () => {
		// Night 0 is the only run; nights 1-8 were skipped (the bot PR sat, the
		// workflow was disabled). The next run, on day 9, is 9 elapsed days.
		const first = nightly(FIXTURE, 0).text;
		expect(cellOf(first, "vue", "first-publish")).toBe("direct");
		const later = nightly(first, 9);
		expect(cellOf(later.text, "vue", "first-publish")).toBe("unknown");
		expect(later.expired).toBe(2);
	});

	it("does not advance on extra runs the same day", () => {
		let text = FIXTURE;
		for (let run = 0; run < FIRST_PUBLISH_EXPIRY_DAYS + 3; run++) {
			text = nightly(text, 0).text;
		}
		expect(cellOf(text, "vue", "first-publish")).toBe("direct");
	});

	it("resets the clock when the axis is observed again", () => {
		const observed = observation("vue", { firstPublish: "direct" });
		let text = nightly(FIXTURE, 0).text;
		text = nightly(text, 3).text;
		text = nightly(text, 4, [observed]).text;
		expect(parseRefreshState(text)["first-publish"]?.vue).toBeUndefined();
		// The next miss is a NEW first miss on day 5: elapsed time is measured
		// from it, not from day 0.
		text = nightly(text, 5).text;
		expect(parseRefreshState(text)["first-publish"]?.vue).toEqual({
			firstMissed: day(5),
		});
		text = nightly(text, 5 + FIRST_PUBLISH_EXPIRY_DAYS - 1).text;
		expect(cellOf(text, "vue", "first-publish")).toBe("direct");
		text = nightly(text, 5 + FIRST_PUBLISH_EXPIRY_DAYS).text;
		expect(cellOf(text, "vue", "first-publish")).toBe("unknown");
	});

	it("treats a garbage or future firstMissed as a fresh first miss, never an expiry", () => {
		for (const bad of ["not-a-date", "2099-01-01", "2026-13-45", ""]) {
			const doc = `${FIXTURE}\n## Capability matrix refresh state (nightly-generated)\n\n\`\`\`json\n${JSON.stringify(
				{ "first-publish": { vue: { firstMissed: bad } } },
			)}\n\`\`\`\n`;
			const result = nightly(doc, 40);
			expect(cellOf(result.text, "vue", "first-publish"), bad).toBe("direct");
			expect(parseRefreshState(result.text)["first-publish"]?.vue, bad).toEqual(
				{ firstMissed: day(40) },
			);
		}
	});

	it("never expires a pull row's n/a (pull) cell", () => {
		let text = FIXTURE;
		for (let n = 0; n < FIRST_PUBLISH_EXPIRY_DAYS + 7; n++)
			text = nightly(text, n).text;
		expect(cellOf(text, "rust", "first-publish")).toBe("n/a (pull)");
		expect(parseRefreshState(text)["first-publish"]?.rust).toBeUndefined();
	});

	it("never counts an unknown first-publish cell (no measurement to expire)", () => {
		// Recurrence: counting every non-empty cell would tick `unknown` forever
		// and keep the bot PR noisy with bookkeeping for a cell that holds nothing.
		let text = FIXTURE;
		for (let n = 0; n < FIRST_PUBLISH_EXPIRY_DAYS + 3; n++)
			text = nightly(text, n).text;
		expect(cellOf(text, "svelte", "first-publish")).toBe("unknown");
		expect(parseRefreshState(text)["first-publish"]?.svelte).toBeUndefined();
	});

	it("never expires an empty-first cell (the evidence behind a live emptyFirstPublish marker)", () => {
		// Recurrence (review F2, mutation M7b): php/terraform `empty-first` back a
		// LIVE `emptyFirstPublish: "indexing"` marker. Expiring the cell erases the
		// measurement behind the marker while the first-publish census stays green
		// (it ignores `unknown`). Only a stale `direct` -- the no-op default -- may
		// expire.
		let text = FIXTURE;
		for (let n = 0; n < FIRST_PUBLISH_EXPIRY_DAYS * 6; n++)
			text = nightly(text, n).text;
		expect(cellOf(text, "php", "first-publish")).toBe("empty-first");
		expect(parseRefreshState(text)["first-publish"]?.php).toBeUndefined();
		// ...while the `direct` cells in the same doc did expire, so the loop
		// genuinely ran the expiry.
		expect(cellOf(text, "vue", "first-publish")).toBe("unknown");
	});

	it("keeps every marker-backed empty-first cell of the real matrix through a month of misses", () => {
		// The same rule against the real registry: every server the wait policy
		// marks `emptyFirstPublish: "indexing"` keeps its measured cell.
		const real = fs.readFileSync(
			path.join(repoRoot, "docs", "lsp-capability-matrix.md"),
			"utf8",
		);
		const table = parseTable(real, MARKER)!;
		const langIdx = table.header.indexOf("lang");
		const marked = table.rows
			.filter(
				(cells) =>
					SERVER_DIAGNOSTIC_STRATEGIES[strategyKeyForLang(cells[langIdx])]
						?.emptyFirstPublish === "indexing",
			)
			.map((cells) => cells[langIdx]);
		expect(
			marked.length,
			"the registry marks at least one server",
		).toBeGreaterThan(0);
		let text = real;
		for (let n = 0; n < 30; n++) text = nightly(text, n).text;
		for (const lang of marked) {
			expect(cellOf(text, lang, "first-publish"), lang).toBe("empty-first");
		}
	});
});

describe("#3401 subset probe", () => {
	it("does not advance or expire the state of a lang it did not probe", () => {
		// Recurrence (review F4): `probe-clean-signal.mjs typescript` used to tick
		// every unprobed first-publish cell, so a dev's one-lang run expired cells.
		const first = nightly(FIXTURE, 0).text;
		const subset = nightly(first, 30, [], { probedLangs: ["rust"] });
		expect(subset.expired).toBe(0);
		expect(cellOf(subset.text, "vue", "first-publish")).toBe("direct");
		expect(parseRefreshState(subset.text)["first-publish"]?.vue).toEqual({
			firstMissed: day(0),
		});
		// The bookkeeping survived intact: the next FULL run expires it.
		expect(cellOf(nightly(subset.text, 30).text, "vue", "first-publish")).toBe(
			"unknown",
		);
	});

	it("does not start a clock for an unprobed lang either", () => {
		const subset = nightly(FIXTURE, 0, [], { probedLangs: ["rust"] });
		expect(parseRefreshState(subset.text)["first-publish"]).toBeUndefined();
		expect(subset.changed).toBe(false);
	});

	it("still processes the langs it did probe", () => {
		const first = nightly(FIXTURE, 0).text;
		const subset = nightly(first, 30, [], { probedLangs: ["vue"] });
		expect(cellOf(subset.text, "vue", "first-publish")).toBe("unknown");
		// ast-grep was not probed: still direct, clock kept.
		expect(cellOf(subset.text, "ast-grep", "first-publish")).toBe("direct");
		expect(
			parseRefreshState(subset.text)["first-publish"]?.["ast-grep"],
		).toEqual({ firstMissed: day(0) });
	});

	it("keeps an unprobed lang's pending tier hold", () => {
		const a = measured("ast-grep", "publishes-unversioned", "2*");
		const held = nightly(FIXTURE, 0, [a]).text;
		expect(
			parseRefreshState(held)["clean-behavior"]?.["ast-grep"],
		).toBeDefined();
		const subset = nightly(held, 1, [], { probedLangs: ["vue"] });
		expect(
			parseRefreshState(subset.text)["clean-behavior"]?.["ast-grep"],
		).toBeDefined();
		// The hold survived, so the next agreeing full run commits.
		const commit = nightly(subset.text, 2, [a]);
		expect(commit.committed).toBe(1);
		expect(cellOf(commit.text, "ast-grep", "clean-behavior")).toBe(
			"publishes-unversioned",
		);
	});
});

describe("#3401 clean-behavior hysteresis", () => {
	it("writes a change only after TIER_CHANGE_AGREE_RUNS agreeing runs", () => {
		expect(TIER_CHANGE_AGREE_RUNS).toBe(2);
		const rows = [measured("ast-grep", "publishes-unversioned", "2*")];
		const first = refreshCapabilityMatrix(FIXTURE, rows, { src: "ci" });
		expect(cellOf(first.text, "ast-grep", "clean-behavior")).toBe(
			"publishes-versioned",
		);
		expect(first.pending).toBe(1);
		expect(first.pendingLangs).toEqual(["ast-grep"]);
		expect(first.committed).toBe(0);
		const second = refreshCapabilityMatrix(first.text, rows, { src: "ci" });
		expect(cellOf(second.text, "ast-grep", "clean-behavior")).toBe(
			"publishes-unversioned",
		);
		expect(cellOf(second.text, "ast-grep", "tier")).toBe("2*");
		expect(second.committed).toBe(1);
		expect(second.committedLangs).toEqual(["ast-grep"]);
	});

	it("holds the ast-grep 2 -> 2* -> 3 -> 2* flap without a single-run rewrite", () => {
		// The recorded nightly sequence the #3443 investigation found. No run
		// alone may move the cell; only two consecutive runs of the SAME value can.
		const sequence = [
			measured("ast-grep", "publishes-unversioned", "2*"),
			measured("ast-grep", "silent", "3"),
			measured("ast-grep", "publishes-unversioned", "2*"),
			measured("ast-grep", "silent", "3"),
		];
		let text = FIXTURE;
		for (const row of sequence) {
			const result = refreshCapabilityMatrix(text, [row], { src: "ci" });
			text = result.text;
			expect(result.committed).toBe(0);
			expect(cellOf(text, "ast-grep", "clean-behavior")).toBe(
				"publishes-versioned",
			);
			expect(cellOf(text, "ast-grep", "tier")).toBe("2");
		}
	});

	it("breaks a held change when an intervening run observes something else", () => {
		const a = measured("ast-grep", "publishes-unversioned", "2*");
		const b = measured("ast-grep", "silent", "3");
		let text = refreshCapabilityMatrix(FIXTURE, [a], { src: "ci" }).text;
		text = refreshCapabilityMatrix(text, [b], { src: "ci" }).text;
		// A second `a` would have committed under the first hold; the intervening
		// `b` reset it, so this is a first sighting again.
		const third = refreshCapabilityMatrix(text, [a], { src: "ci" });
		expect(third.committed).toBe(0);
		expect(cellOf(third.text, "ast-grep", "clean-behavior")).toBe(
			"publishes-versioned",
		);
	});

	it("counts agreeing runs from the first sighting of the new value (agreeRuns 3)", () => {
		// A differing observation starts its own count at 1: A, B, B is two runs of
		// B, which is below three and must not commit.
		const a = measured("ast-grep", "publishes-unversioned", "2*");
		const b = measured("ast-grep", "silent", "3");
		const opts = { src: "ci", agreeRuns: 3 } as const;
		let text = refreshCapabilityMatrix(FIXTURE, [a], opts).text;
		text = refreshCapabilityMatrix(text, [b], opts).text;
		text = refreshCapabilityMatrix(text, [b], opts).text;
		expect(cellOf(text, "ast-grep", "clean-behavior")).toBe(
			"publishes-versioned",
		);
		expect(parseRefreshState(text)["clean-behavior"]?.["ast-grep"]?.runs).toBe(
			2,
		);
		const third = refreshCapabilityMatrix(text, [b], opts);
		expect(cellOf(third.text, "ast-grep", "clean-behavior")).toBe("silent");
	});

	it("resets the hold on a probed night that measured nothing for the lang", () => {
		// Pins the skip semantics (review mutation M13): A, a night with no
		// comparable observation, A again is two NON-consecutive runs, so the
		// second A is a first sighting again and must not commit.
		const a = measured("ast-grep", "publishes-unversioned", "2*");
		let text = refreshCapabilityMatrix(FIXTURE, [a], { src: "ci" }).text;
		expect(parseRefreshState(text)["clean-behavior"]?.["ast-grep"]?.runs).toBe(
			1,
		);
		text = refreshCapabilityMatrix(text, [], { src: "ci" }).text;
		expect(
			parseRefreshState(text)["clean-behavior"]?.["ast-grep"],
		).toBeUndefined();
		const third = refreshCapabilityMatrix(text, [a], { src: "ci" });
		expect(third.committed).toBe(0);
		expect(cellOf(third.text, "ast-grep", "clean-behavior")).toBe(
			"publishes-versioned",
		);
	});

	it("clears a held change when the cell already matches", () => {
		const change = measured("ast-grep", "publishes-unversioned", "2*");
		const steady = measured("ast-grep", "publishes-versioned", "2");
		let text = refreshCapabilityMatrix(FIXTURE, [change], { src: "ci" }).text;
		expect(
			parseRefreshState(text)["clean-behavior"]?.["ast-grep"],
		).toBeDefined();
		text = refreshCapabilityMatrix(text, [steady], { src: "ci" }).text;
		expect(
			parseRefreshState(text)["clean-behavior"]?.["ast-grep"],
		).toBeUndefined();
		// Re-observing the change must now be a fresh first sighting, not a commit.
		const again = refreshCapabilityMatrix(text, [change], { src: "ci" });
		expect(again.committed).toBe(0);
	});
});

describe("#3401 refresh state block", () => {
	it("records a state-only change so the refresh PR can persist it", () => {
		const result = nightly(FIXTURE, 0);
		expect(result.changed).toBe(true);
		expect(result.expired).toBe(0);
		expect(parseRefreshState(result.text)["first-publish"]?.vue).toEqual({
			firstMissed: day(0),
		});
	});

	it("is byte-stable when every measured cell already matches", () => {
		const steady = [
			measured("ast-grep", "publishes-versioned", "2"),
			observation("vue", { firstPublish: "direct" }),
		];
		const first = refreshCapabilityMatrix(FIXTURE, steady, { src: "ci" });
		expect(first.changed).toBe(false);
		const second = refreshCapabilityMatrix(first.text, steady, { src: "ci" });
		expect(second.text).toBe(first.text);
	});

	it("round-trips the state block and treats an absent or corrupt block as empty", () => {
		const text = nightly(FIXTURE, 0).text;
		expect(parseRefreshState(text)["first-publish"]?.vue).toEqual({
			firstMissed: day(0),
		});
		// A second pass parses what the first wrote and keeps the first miss.
		expect(
			parseRefreshState(nightly(text, 2).text)["first-publish"]?.vue,
		).toEqual({ firstMissed: day(0) });
		expect(parseRefreshState("# no state block\n")).toEqual({});
		expect(
			parseRefreshState(
				"## Capability matrix refresh state (nightly-generated)\n\n```json\n{not json\n```\n",
			),
		).toEqual({});
	});

	it("reports a missing capability table instead of crashing", () => {
		const result = refreshCapabilityMatrix("# no table here\n", []);
		expect(result.changed).toBe(false);
		expect(result.reason).toMatch(/capability table/);
	});
});

// The cases below pin the writer's edges that the Mutation diff lane reported
// as surviving on the round-1 head (rows of md-matrix.mjs: the state parser,
// renderer and section replacer, the observation/src writes, and the hold
// predicate). Each asserts an observable output of the real refresh entry.
const STATE_HEADING = "## Capability matrix refresh state (nightly-generated)";
const stateBlock = (payload: unknown) =>
	`${STATE_HEADING}\n\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\n`;

describe("#3401 state block parsing, rendering and replacement", () => {
	it("parses a heading with trailing whitespace and a heading on the first line", () => {
		const payload = { "first-publish": { vue: { firstMissed: day(0) } } };
		expect(
			parseRefreshState(
				`${STATE_HEADING}  \n\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\n`,
			),
		).toEqual(payload);
		expect(parseRefreshState(stateBlock(payload))).toEqual(payload);
	});

	it("ignores a json fence that is not under the state heading", () => {
		expect(
			parseRefreshState(
				'# Doc\n\n```json\n{"first-publish":{"vue":{"firstMissed":"2026-09-01"}}}\n```\n',
			),
		).toEqual({});
	});

	it("treats a non-object payload as empty", () => {
		for (const payload of [null, 42, "text", true]) {
			expect(parseRefreshState(stateBlock(payload)), String(payload)).toEqual(
				{},
			);
		}
	});

	it("renders keys sorted, whatever the table order", () => {
		// Table order is vue, ast-grep; the block must read ast-grep, vue so a
		// settled run is byte-stable and the refresh PR does not open on churn.
		const out = nightly(FIXTURE, 0, [
			observation("vue", { cleanBehavior: "silent", tier: "3" }),
			observation("ast-grep", { cleanBehavior: "silent", tier: "3" }),
		]).text;
		const json = out.split("\n").find((l) => l.startsWith("{"))!;
		expect(Object.keys(JSON.parse(json)["clean-behavior"])).toEqual([
			"ast-grep",
			"vue",
		]);
		const missed = nightly(FIXTURE, 0)
			.text.split("\n")
			.find((l) => l.startsWith("{"))!;
		expect(Object.keys(JSON.parse(missed)["first-publish"])).toEqual([
			"ast-grep",
			"vue",
		]);
	});

	it("replaces a state section that sits mid-document without swallowing the next section", () => {
		const doc = FIXTURE.replace(
			"## Key findings",
			`${stateBlock({ "first-publish": { vue: { firstMissed: day(0) } } })}a ## b stray line\n\n### Sub heading\n\n## Key findings`,
		);
		const out = nightly(doc, 1).text;
		expect(out.split(STATE_HEADING).length - 1).toBe(1);
		expect(out).toContain("Prose after the table must survive the refresh.");
		expect(out).toContain("## Key findings");
		expect(out).not.toContain("a ## b stray line");
		expect(out.indexOf("## Key findings")).toBeLessThan(
			out.indexOf(STATE_HEADING),
		);
	});

	it("replaces a state section that is the very first lines of the doc", () => {
		const doc = `${stateBlock({ "first-publish": { vue: { firstMissed: day(0) } } })}\n${FIXTURE}`;
		const out = nightly(doc, 1).text;
		expect(out.split(STATE_HEADING).length - 1).toBe(1);
		// A stray trailing space on the old heading must still find it.
		const spaced = doc.replace(STATE_HEADING, `${STATE_HEADING} `);
		expect(nightly(spaced, 1).text.split(STATE_HEADING).length - 1).toBe(1);
	});

	it("tolerates a null entry and a missing runs field in a hand-edited block", () => {
		const doc = `${FIXTURE}\n${stateBlock({
			"first-publish": { vue: null },
			"clean-behavior": {
				"ast-grep": { pendingBehavior: "silent", pendingTier: "3" },
			},
		})}`;
		const noCrash = nightly(doc, 3, [
			observation("vue", { firstPublish: "direct" }),
		]);
		expect(cellOf(noCrash.text, "vue", "first-publish")).toBe("direct");
		// A hold without `runs` counts as one sighting, so the same value commits.
		const commit = nightly(doc, 3, [measured("ast-grep", "silent", "3")]);
		expect(commit.committed).toBe(1);
		expect(cellOf(commit.text, "ast-grep", "clean-behavior")).toBe("silent");
		// ...and a subset run carries it with `runs` normalised to 1.
		const carried = nightly(doc, 3, [], { probedLangs: ["rust"] });
		expect(
			parseRefreshState(carried.text)["clean-behavior"]?.["ast-grep"]?.runs,
		).toBe(1);
	});
});

describe("#3401 refresh entry edges", () => {
	it("drops a carried hold that lacks a behavior or a tier", () => {
		// A hand-edited block must not keep a half hold alive across a subset run.
		const doc = `${FIXTURE}\n${stateBlock({
			"clean-behavior": {
				"ast-grep": { pendingBehavior: "silent" },
				vue: { pendingTier: "3" },
			},
		})}`;
		const out = nightly(doc, 1, [], { probedLangs: ["rust"] }).text;
		expect(parseRefreshState(out)["clean-behavior"]).toBeUndefined();
	});

	it("starts from an empty src when a row has no src cell", () => {
		const doc = FIXTURE.replace(
			"| svelte | svelteserver | push-only | unknown | unknown | 3? | dev |",
			"| svelte | svelteserver | push-only | unknown | unknown | 3? |",
		);
		const out = nightly(doc, 0, [
			observation("svelte", { firstPublish: "direct" }),
		]).text;
		expect(cellOf(out, "svelte", "src")).toBe("ci");
	});

	it("keeps a single-night first-publish flip pending", () => {
		// Recurrence (#3310): one noisy nightly flipped a direct server to
		// empty-first and made the census demand a live hold marker.
		const result = nightly(FIXTURE, 0, [
			observation("vue", { firstPublish: "empty-first" }),
		]);
		expect(cellOf(result.text, "vue", "first-publish")).toBe("direct");
		expect(result.pendingLangs).toEqual(["vue"]);
		expect(parseRefreshState(result.text)["first-publish"]?.vue).toEqual({
			pendingFirstPublish: "empty-first",
			runs: 1,
		});
	});

	it("commits a first-publish flip after two agreeing nights", () => {
		const first = nightly(FIXTURE, 0, [
			observation("vue", { firstPublish: "empty-first" }),
		]);
		const second = nightly(first.text, 1, [
			observation("vue", { firstPublish: "empty-first" }),
		]);
		expect(cellOf(second.text, "vue", "first-publish")).toBe("empty-first");
		expect(second.committedLangs).toEqual(["vue"]);
		expect(
			parseRefreshState(second.text)["first-publish"]?.vue,
		).toBeUndefined();
	});

	it("clears a pending first-publish flip when the observation reverts", () => {
		const first = nightly(FIXTURE, 0, [
			observation("vue", { firstPublish: "empty-first" }),
		]);
		const reverted = nightly(first.text, 1, [
			observation("vue", { firstPublish: "direct" }),
		]);
		expect(cellOf(reverted.text, "vue", "first-publish")).toBe("direct");
		expect(reverted.pendingLangs).toEqual([]);
		expect(
			parseRefreshState(reverted.text)["first-publish"]?.vue,
		).toBeUndefined();

		const newFlip = nightly(reverted.text, 2, [
			observation("vue", { firstPublish: "empty-first" }),
		]);
		expect(cellOf(newFlip.text, "vue", "first-publish")).toBe("direct");
		expect(newFlip.committed).toBe(0);
	});

	it("merges src for an observed lang only, and defaults the source to ci", () => {
		const out = refreshCapabilityMatrix(
			FIXTURE,
			[observation("svelte", { firstPublish: "direct" })],
			{ now: day(0) },
		).text;
		expect(cellOf(out, "svelte", "src")).toBe("dev+ci");
		expect(cellOf(out, "ast-grep", "src")).toBe("dev+ci");
		const unobserved = refreshCapabilityMatrix(FIXTURE, [], {
			now: day(0),
		}).text;
		expect(cellOf(unobserved, "svelte", "src")).toBe("dev");
	});

	it("never appends a lang that is not in the table", () => {
		const out = nightly(FIXTURE, 0, [
			measured("not-a-row", "silent", "3"),
		]).text;
		expect(cellOf(out, "not-a-row", "clean-behavior")).toBeUndefined();
		expect(parseTable(out, MARKER)!.rows).toHaveLength(
			parseTable(FIXTURE, MARKER)!.rows.length,
		);
	});

	it("picks the capability table even when another table precedes it", () => {
		const doc = `| a | b |\n|---|---|\n| 1 | 2 |\n\n${FIXTURE}`;
		const out = nightly(doc, 0, [
			observation("vue", { firstPublish: "empty-first" }),
		]).text;
		expect(cellOf(out, "vue", "first-publish")).toBe("direct");
		expect(parseRefreshState(out)["first-publish"]?.vue).toEqual({
			pendingFirstPublish: "empty-first",
			runs: 1,
		});
		expect(out).toContain("| 1 | 2 |");
	});

	it("accepts a call without observations", () => {
		expect(() =>
			refreshCapabilityMatrix(
				FIXTURE,
				undefined as unknown as MatrixObservation[],
				{
					now: day(0),
				},
			),
		).not.toThrow();
	});

	it("holds a change that differs in only one of behavior and tier", () => {
		// Only the tier differs, then only the behavior: each is a change.
		const tierOnly = nightly(FIXTURE, 0, [
			observation("ast-grep", {
				cleanBehavior: "publishes-versioned",
				tier: "2*",
			}),
		]);
		expect(tierOnly.pending).toBe(1);
		expect(cellOf(tierOnly.text, "ast-grep", "tier")).toBe("2");
		const behaviorOnly = nightly(FIXTURE, 0, [
			observation("ast-grep", { cleanBehavior: "silent", tier: "2" }),
		]);
		expect(behaviorOnly.pending).toBe(1);
		expect(cellOf(behaviorOnly.text, "ast-grep", "clean-behavior")).toBe(
			"publishes-versioned",
		);
	});

	it("does not treat a hold as agreeing when only its behavior or only its tier matches", () => {
		const first = nightly(FIXTURE, 0, [
			observation("ast-grep", { cleanBehavior: "silent", tier: "3" }),
		]).text;
		const sameBehaviorOtherTier = nightly(first, 1, [
			observation("ast-grep", { cleanBehavior: "silent", tier: "2*" }),
		]);
		expect(sameBehaviorOtherTier.committed).toBe(0);
		const otherBehaviorSameTier = nightly(first, 1, [
			observation("ast-grep", {
				cleanBehavior: "publishes-unversioned",
				tier: "3",
			}),
		]);
		expect(otherBehaviorSameTier.committed).toBe(0);
	});

	it("needs a second sighting even when agreeRuns is 1", () => {
		const opts = { src: "ci", agreeRuns: 1, now: day(0) } as const;
		const a = measured("ast-grep", "publishes-unversioned", "2*");
		const first = refreshCapabilityMatrix(FIXTURE, [a], opts);
		expect(first.committed).toBe(0);
		expect(first.pending).toBe(1);
		expect(refreshCapabilityMatrix(first.text, [a], opts).committed).toBe(1);
	});
});
