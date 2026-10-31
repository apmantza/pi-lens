/**
 * Tests for the pure helpers behind `scripts/probe-save-verdict.mjs` (#3405
 * acceptance 4):
 *   - `scripts/lib/save-verdict.mjs` — the ARM classifier (which measurement arm
 *     owns the answer), the cell wording, the partial-doc merge guard and the
 *     probe ordering.
 *
 * Why these and not a live probe: the classifier is the only thing standing
 * between an arm's observation and a committed table cell, and every wrong
 * direction it could take is a silent table lie — a slow server credited to the
 * save, an unreachable toolchain blanking a measured row, a hand edit dressed as
 * a measurement. All of them are decidable from the arms, so they are pinned here
 * without spawning a language server (the same split as
 * `tests/scripts/clean-signal.test.ts`).
 */

import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GENERATED_LSP_DOCS } from "../../scripts/lib/md-matrix.mjs";
import { listRefreshFlips } from "../../scripts/lib/refresh-flips.mjs";
import { stripCommentsAndStrings } from "../support/session-state-scan.js";
import {
	classifySaveVerdict,
	describeArm,
	describeHeldBack,
	fixturePolicy,
	orderByNeed,
	parseSaveVerdictRows,
	refreshSaveVerdictTable,
	reportHeldBack,
	rowsReached,
	SAVE_VERDICT_COLUMN,
	SAVE_VERDICT_COMMAND,
	SAVE_VERDICT_MARKER,
	SAVE_VERDICT_VALUES,
	saveVerdictCells,
	saveVerdictSummary,
} from "../../scripts/lib/save-verdict.mjs";

const MATRIX_DOC = GENERATED_LSP_DOCS[0];

const arm = (nonEmpty: number, ms: number | null = nonEmpty ? 100 : null) => ({
	nonEmpty,
	ms,
});

const DOC = [
	"# LSP capability matrix",
	"",
	"## Save-triggered servers: per-server verdict (#3405)",
	"",
	"| server | save as declared | publishes after save only | verdict | evidence |",
	"|---|---|---|---|---|",
	"| cpp | `save` | unknown | Unverified: not measured. | none |",
	"| cmake | `save` | unknown | Unverified: not measured. | none |",
	"| gopls | `save` | no | Source: DidSave calls didModifyFiles. | golang/tools `02c9e4c` |",
	"",
	"## Next section",
	"",
	"Untouched prose.",
	"",
].join("\n");

/** A doc with one row per ordering tier (provenance, unsettled, settled, no row). */
const TIERED_DOC = [
	"# LSP capability matrix",
	"",
	"| server | save as declared | publishes after save only | verdict | evidence |",
	"|---|---|---|---|---|",
	"| gopls | `save` | no | Source: DidSave calls didModifyFiles. | golang/tools `02c9e4c` |",
	"| cpp | `save` | no | Measured: answers without a save. | `node scripts/probe-save-verdict.mjs` (fixture cpp) |",
	"| cmake | `save` | inconclusive | Measured: inconclusive. | `node scripts/probe-save-verdict.mjs` (fixture cmake) |",
	"| fish | `save+text` | unknown | Unverified: not measured. | none |",
	"",
].join("\n");

describe("classifySaveVerdict: which arm owns the answer (#3405)", () => {
	it("answers no when the seeded error publishes with no save", () => {
		const verdict = classifySaveVerdict({
			mode: "push-only",
			noSave: arm(3, 97),
			saveAlone: arm(0),
		});
		expect(verdict.verdict).toBe("no");
		expect(verdict.reason).toContain("without a save");
	});

	it("marks a pull server's no-save answer (pull) so no publish is implied", () => {
		// A pull server never publishes; the diagnostics request answers instead.
		expect(
			classifySaveVerdict({ mode: "pull", noSave: arm(1, 210) }).verdict,
		).toBe("no (pull)");
	});

	it("never credits a pull server with a save-triggered answer", () => {
		// #4999 F2: rust-analyzer is `mode=pull`, and the nightly measured
		// save-alone=1 over this doc's `inconclusive`. That "finding" is the answer
		// to a repeated `textDocument/diagnostic` request: no arm of a pull server
		// has the save as its only new input, so the positive branches cannot
		// apply. The old rule credited it and wrote a `yes` no publish backed.
		for (const arms of [
			{ noSave: arm(0), saveAlone: arm(2, 54) },
			{ noSave: arm(0), saveAlone: arm(0), savedWrite: arm(1, 900) },
		]) {
			const verdict = classifySaveVerdict({ mode: "pull", ...arms });
			expect(verdict.verdict).toBe("inconclusive");
			expect(verdict.verdict).not.toBe("yes");
			expect(verdict.reason).toContain("textDocument/diagnostic");
		}
	});

	it("answers yes only when the same bytes published after the save alone", () => {
		const verdict = classifySaveVerdict({
			mode: "push-only",
			noSave: arm(0),
			silence: arm(0),
			saveAlone: arm(1, 233),
		});
		expect(verdict.verdict).toBe("yes");
	});

	it("credits a saved write separately, because a change rode along", () => {
		const verdict = classifySaveVerdict({
			mode: "push-only",
			noSave: arm(0),
			silence: arm(0),
			saveAlone: arm(0),
			savedWrite: arm(2, 3400),
		});
		expect(verdict.verdict).toBe("yes (saved write)");
	});

	it("refuses to credit the save with an answer that arrived after its arm closed", () => {
		// The recurrence: a cold server publishes 9 s late, the save arm's window
		// sees it, and the row would read `yes` — a save-triggered verdict for a
		// server that simply needed more time.
		const verdict = classifySaveVerdict({
			mode: "push-only",
			noSave: arm(0),
			silence: arm(4, null),
			saveAlone: arm(0),
		});
		expect(verdict.verdict).toBe("inconclusive");
		expect(verdict.reason).toContain("untriggered window");
	});

	it("is inconclusive — never a guessed yes — when no arm published", () => {
		expect(
			classifySaveVerdict({
				mode: "push-only",
				noSave: arm(0),
				silence: arm(0),
				saveAlone: arm(0),
				savedWrite: arm(0),
			}).verdict,
		).toBe("inconclusive");
	});

	it("treats an absent arm as silent and never as evidence of a save", () => {
		expect(classifySaveVerdict({ mode: "push-only" }).verdict).toBe(
			"inconclusive",
		);
		expect(classifySaveVerdict({}).verdict).toBe("inconclusive");
	});
});

describe("describeArm: the quoted observation", () => {
	it("names the count and the window length when silent", () => {
		expect(describeArm(arm(2, 97), 8000)).toBe("2 findings");
		expect(describeArm(arm(1, 40), 8000)).toBe("1 finding");
		expect(describeArm(arm(0), 8000)).toBe("silent (8000 ms)");
	});

	it("names the unit the arm counted, pluralised", () => {
		// #4999 F9: a push arm counts publish EVENTS (one event may carry several
		// findings) and a pull arm counts the diagnostics a request answered. The
		// committed cpp cell read "1 finding at 459 ms" while #4768 measured three
		// diagnostics per publish — a unit no arm ever counted.
		expect(describeArm(arm(1), 6000, "publish event")).toBe("1 publish event");
		expect(describeArm(arm(3), 6000, "publish event")).toBe("3 publish events");
		expect(describeArm(arm(2), 6000, "diagnostic")).toBe("2 diagnostics");
		expect(describeArm(arm(0), 6000, "publish event")).toBe("silent (6000 ms)");
	});
});

describe("fixturePolicy: the clean-gate token comes from the fixture", () => {
	it("reads the harness's own declaration", () => {
		expect(fixturePolicy({ lspGate: true })).toBe("Gated.");
		expect(fixturePolicy({ lspGateExempt: "no toolchain" })).toBe(
			"Exempt from the clean gate.",
		);
		expect(fixturePolicy({ auxiliaryServerIds: ["opengrep"] })).toBe(
			"Auxiliary, not gated.",
		);
		expect(fixturePolicy({})).toBe("");
	});
});

/** One measured row's cells; throws when the run produced none (a failed arm). */
const measure = (overrides: Record<string, unknown> = {}) => {
	const cells = saveVerdictCells({
		server: "cpp",
		save: "save",
		mode: "push-only",
		fixture: { lang: "cpp", lspGate: true },
		arms: { noSave: arm(3, 97), saveAlone: arm(0) },
		waitMs: 6000,
		...overrides,
	});
	if (!cells) throw new Error("expected a measured row, got no cells");
	return cells;
};

describe("saveVerdictCells: the three columns a run owns", () => {
	it("writes the verdict value, the evidence command and the policy", () => {
		const cells = measure();
		expect(cells[SAVE_VERDICT_COLUMN]).toBe("no");
		expect(cells[SAVE_VERDICT_COLUMN]).not.toBe("unknown");
		expect(cells.verdict).toContain("3 publish events");
		expect(cells.verdict).toContain("Gated.");
		expect(cells.evidence).toContain(SAVE_VERDICT_COMMAND);
		expect(cells.evidence).toContain("fixture cpp");
	});

	it("attributes a pull row's late answer to the request, never to the save", () => {
		// #4999 R3-2: a pull server's `saveAlone` arm is a save PLUS a
		// `textDocument/diagnostic` request, so its count cannot be credited to the
		// save — and the cell's own verdict says no save is needed. The `no (pull)`
		// template said "a later save alone", which the nightly wrote for deno,
		// svelte and csharp.
		const cells = measure({
			mode: "pull",
			arms: { noSave: arm(1, 210), saveAlone: arm(1, 80) },
		});
		expect(cells[SAVE_VERDICT_COLUMN]).toBe("no (pull)");
		expect(cells.verdict).toContain("save+request answered: 1 diagnostic");
		expect(cells.verdict).not.toContain("a later save alone");
	});

	it("writes nothing a re-measurement of the same behaviour would move", () => {
		// #4999 F7: the elapsed time of each arm and the run's `src` token used to
		// live in the committed cells, so a night that changed only those arrived
		// as a capability flip and disarmed the refresh PR's auto-merge (the run on
		// the reviewed head rewrote 20 of 21 rows). Both now go to the run log.
		const first = measure({ arms: { noSave: arm(1, 459), saveAlone: arm(0) } });
		const second = measure({
			arms: { noSave: arm(1, 777), saveAlone: arm(0) },
		});
		expect(second).toEqual(first);
		expect(first.verdict).not.toContain("459");
		expect(first.evidence).not.toMatch(/src=/);

		const head = refreshSaveVerdictTable(DOC, [first]).text;
		const next = refreshSaveVerdictTable(DOC, [second]).text;
		expect(next).toBe(head);
		expect(
			listRefreshFlips({ [MATRIX_DOC]: head }, { [MATRIX_DOC]: next }),
		).toEqual([]);
	});

	it("keeps `unknown` out of a measured row entirely", () => {
		for (const arms of [
			{ noSave: arm(1) },
			{ noSave: arm(0), saveAlone: arm(1) },
			{ noSave: arm(0), saveAlone: arm(0), savedWrite: arm(1) },
			{ noSave: arm(0), saveAlone: arm(0) },
		]) {
			expect(
				SAVE_VERDICT_VALUES.has(measure({ arms })[SAVE_VERDICT_COLUMN]),
			).toBe(true);
			expect(measure({ arms })[SAVE_VERDICT_COLUMN]).not.toBe("unknown");
		}
	});

	it("states the arms in an inconclusive row", () => {
		const cells = measure({ arms: { noSave: arm(0), saveAlone: arm(0) } });
		expect(cells[SAVE_VERDICT_COLUMN]).toBe("inconclusive");
		expect(cells.verdict).toContain("no arm published");
	});

	it("writes NO cell when the run failed an arm, so the prior cell survives", () => {
		// #4999 F8, both anchor sites: a failed `touchFile` returned zero
		// observations, the classifier read that zero as silence, and a publishing
		// save-alone arm minted a `yes` for a comparison that never happened. The
		// same hole opens when `ensureTool` fails. The row then keeps its last
		// measured cell (#390) instead of gaining a verdict read off a failure.
		for (const failures of [
			["no-save arm failed: touch timed out"],
			["install failed for clangd: getaddrinfo EAI_AGAIN"],
			[""],
		]) {
			const cells = saveVerdictCells({
				server: "cpp",
				save: "save",
				mode: "push-only",
				fixture: { lang: "cpp", lspGate: true },
				arms: { noSave: arm(0), saveAlone: arm(2, 54) },
				waitMs: 6000,
				failures,
			});
			// Only a real cause suppresses the cell; an empty string is not one.
			if (failures[0] === "") expect(cells).toBeDefined();
			else expect(cells).toBeUndefined();
		}
	});
});

describe("refreshSaveVerdictTable: the merge guard (#390)", () => {
	it("rewrites measured rows and copies unreached ones verbatim", () => {
		const cells = measure();
		const { text, changed, measured, kept } = refreshSaveVerdictTable(DOC, [
			cells,
		]);
		expect(changed).toBe(true);
		expect(measured).toEqual(["cpp"]);
		// The cmake row this run could not reach keeps its evidence byte for byte.
		expect(kept).toContain("cmake");
		expect(text).toContain(
			"| cmake | `save` | unknown | Unverified: not measured. | none |",
		);
		expect(text).toContain("| cpp | `save` | no | Measured:");
		// A source-read row nobody measured is untouched, citation included.
		expect(text).toContain("golang/tools `02c9e4c`");
		// Everything outside the table survives.
		expect(text).toContain("## Next section\n\nUntouched prose.");
	});

	it("is a no-op for a run that measured nothing", () => {
		const { text, changed } = refreshSaveVerdictTable(DOC, []);
		expect(changed).toBe(false);
		expect(text).toBe(DOC);
	});

	it("does not append a server the table does not list, and names it", () => {
		// The population is the capability inventory's save-declaring servers, one
		// row per registry id. A launch VARIANT that declares `save` under an id the
		// inventory records as declaring none (typescript's TS7 variants) must not
		// add a row contradicting the inventory — it is reported instead.
		const cells = measure({
			server: "typescript",
			save: "save+text",
			fixture: { lang: "typescript7" },
			arms: { noSave: arm(1, 12) },
		});
		const result = refreshSaveVerdictTable(DOC, [cells]);
		expect(result.notInTable).toEqual(["typescript"]);
		expect(result.measured).toEqual([]);
		expect(result.text).toBe(DOC);
	});

	it("refuses to rewrite anything when the doc has no save-verdict table", () => {
		const { text, changed, reason } = refreshSaveVerdictTable(
			"# nothing here",
			[
				{
					server: "cpp",
					[SAVE_VERDICT_COLUMN]: "no",
				},
			],
		);
		expect(changed).toBe(false);
		expect(text).toBe("# nothing here");
		expect(reason).toBe("save-verdict table not found in doc");
	});
});

describe("parseSaveVerdictRows / orderByNeed: a bounded run converges", () => {
	it("reads the three columns back, with the provenance", () => {
		expect(parseSaveVerdictRows(DOC)).toEqual([
			{ server: "cpp", save: "`save`", verdict: "unknown", evidence: "none" },
			{
				server: "cmake",
				save: "`save`",
				verdict: "unknown",
				evidence: "none",
			},
			{
				server: "gopls",
				save: "`save`",
				verdict: "no",
				evidence: "golang/tools `02c9e4c`",
			},
		]);
	});

	it("orders unmeasured and source-read rows first so a short budget reaches them", () => {
		const fixtures = [
			{ lang: "cpp" },
			{ lang: "cmake" },
			{ lang: "gopls" },
			{ lang: "clojure" },
		];
		// `clojure` has no row at all and can never write one; `gopls` holds a
		// SOURCE claim nobody measured. Both are ahead of a queue slot a measured
		// row would take, and the fixture with no row is last.
		expect(
			orderByNeed(fixtures, parseSaveVerdictRows(DOC), (fx) => fx.lang).map(
				(fx) => fx.lang,
			),
		).toEqual(["cpp", "cmake", "gopls", "clojure"]);
	});

	it("orders the four tiers by the row's provenance, not by its verdict", () => {
		// #4999 F3: the first version ranked a source-read `no` as "measured" and a
		// fixture with no row as "unmeasured", so 33 fixtures that can never write a
		// cell came first and the four source claims came last — exactly where the
		// 600 s budget never reached them.
		const fixtures = [
			{ lang: "cpp", serverId: "cpp" },
			{ lang: "cmake", serverId: "cmake" },
			{ lang: "gopls", serverId: "gopls" },
			{ lang: "fish", serverId: "fish" },
			{ lang: "typescript7", serverId: "typescript" },
		];
		expect(
			orderByNeed(
				fixtures,
				parseSaveVerdictRows(TIERED_DOC),
				(fx) => fx.serverId ?? fx.lang,
			).map((fx) => fx.lang),
		).toEqual(["gopls", "fish", "cmake", "cpp", "typescript7"]);
	});

	it("keeps fixture order among equals", () => {
		const fixtures = [{ lang: "b" }, { lang: "a" }];
		expect(
			orderByNeed(fixtures, [], (fx) => fx.lang).map((fx) => fx.lang),
		).toEqual(["b", "a"]);
	});

	it("probes a row marked inconclusive again, before a settled one", () => {
		expect(
			orderByNeed(
				[{ lang: "cmake" }, { lang: "go" }],
				[
					{
						server: "cmake",
						verdict: "inconclusive",
						evidence: `\`${SAVE_VERDICT_COMMAND}\` (fixture cmake)`,
					},
					{
						server: "go",
						verdict: "yes",
						evidence: `\`${SAVE_VERDICT_COMMAND}\` (fixture go)`,
					},
				],
				(fx) => fx.lang,
			).map((fx) => fx.lang),
		).toEqual(["cmake", "go"]);
	});
});

/**
 * PR #4945's base rows, verbatim (base 0286dd96): the two settled `no` answers
 * the 2026-10-30 refresh turned into `inconclusive`, evidence column and all.
 */
const EXPERT_BASE =
	"| expert | `save` | no | Prior measurement: answers with no `didSave` once the seed is under `lib/`. Gated. | #4768 arms A, B, C; nightly run 39852672584 (answered on call 6, 10955 ms); `tests/fixtures/nightly-floors/expert-readiness.json` |";
const FSHARP_BASE =
	"| fsharp | `save+text` | no | Source: a save holds the source and refreshes code lenses; diagnostics come from open and change checks. Exempt: 0 findings in every run. | ionide/FsAutoComplete `8f011f1395a4`, `src/FsAutoComplete/LspServers/AdaptiveFSharpLspServer.fs` (`TextDocumentDidSave`); nightly run 39845687189 |";
const REAL_DOC = [
	"# LSP capability matrix",
	"",
	"| server | save as declared | publishes after save only | verdict | evidence |",
	"|---|---|---|---|---|",
	EXPERT_BASE,
	FSHARP_BASE,
	"| cmake | `save` | unknown | Unverified: not measured. | none |",
	"",
	"## Next section",
	"",
].join("\n");

/** What the 2026-10-30 nightly measured for the two rows (PR #4945 head d54b073d). */
const measureExpert = () =>
	measure({
		server: "expert",
		fixture: { lang: "expert", lspGate: true },
		arms: { noSave: arm(0), silence: arm(1, 3000), saveAlone: arm(0) },
	});
const measureFsharp = () =>
	measure({
		server: "fsharp",
		save: "save+text",
		fixture: { lang: "fsharp", lspGateExempt: "0 findings in every run" },
		arms: { noSave: arm(0), saveAlone: arm(0) },
	});

describe("refreshSaveVerdictTable: a night with no answer keeps the last answer (#5060)", () => {
	// Recurrence: PR #4945 (2026-10-30) rewrote expert and fsharp from a settled
	// `no` to `inconclusive` and replaced their evidence with the probe command,
	// against the #390 rule that a refresh never regresses a richer classification.
	it("reproduces the nightly's measurement for both rows", () => {
		expect(measureExpert()[SAVE_VERDICT_COLUMN]).toBe("inconclusive");
		expect(measureExpert().verdict).toContain(
			"1 finding(s) arrived in the untriggered window",
		);
		expect(measureFsharp()[SAVE_VERDICT_COLUMN]).toBe("inconclusive");
		expect(measureFsharp().verdict).toContain("no arm published");
	});

	it("keeps expert and fsharp at `no` with their evidence", () => {
		const result = refreshSaveVerdictTable(REAL_DOC, [
			measureExpert(),
			measureFsharp(),
		]);
		expect(result.text).toContain(EXPERT_BASE);
		expect(result.text).toContain(FSHARP_BASE);
		expect(result.text).not.toContain("| inconclusive |");
		expect(result.changed).toBe(false);
		expect(result.measured).toEqual([]);
		expect(result.heldBack.map((h) => h.server)).toEqual(["expert", "fsharp"]);
		// The held night is recorded: the prior answer and what this night saw.
		expect(result.heldBack[0]).toMatchObject({
			server: "expert",
			prior: "no",
			measured: "inconclusive",
		});
		expect(result.heldBack[0].verdict).toContain("untriggered window");
		// The run log names the held night: the answer that stands and the one tonight.
		expect(describeHeldBack(result.heldBack[0])).toMatch(
			/^save-verdict: held back expert: kept "no", this night measured "inconclusive" — Measured: inconclusive — 1 finding\(s\) arrived in the untriggered window/,
		);
		expect(
			listRefreshFlips(
				{ [MATRIX_DOC]: REAL_DOC },
				{ [MATRIX_DOC]: result.text },
			),
		).toEqual([]);
	});

	it("keeps a settled answer over `cannot measure` and over a spelling nobody planned", () => {
		// The gate admits the settled answers and refuses everything else, so an
		// input outside SAVE_VERDICT_VALUES cannot erase an answer either.
		for (const value of ["cannot measure", "maybe", "No ", ""]) {
			const result = refreshSaveVerdictTable(REAL_DOC, [
				{ ...measureExpert(), [SAVE_VERDICT_COLUMN]: value },
			]);
			expect(result.text, value).toContain(EXPERT_BASE);
			expect(
				result.heldBack.map((h) => h.server),
				value,
			).toEqual(["expert"]);
		}
	});

	it("still writes an inconclusive night over a row that held no answer", () => {
		const unknown = refreshSaveVerdictTable(REAL_DOC, [
			measure({
				server: "cmake",
				fixture: { lang: "cmake", lspGate: true },
				arms: { noSave: arm(0), saveAlone: arm(0) },
			}),
		]);
		expect(unknown.text).toContain("| cmake | `save` | inconclusive |");
		expect(unknown.heldBack).toEqual([]);
		const again = refreshSaveVerdictTable(unknown.text, [
			measure({
				server: "cmake",
				fixture: { lang: "cmake", lspGate: true },
				arms: { noSave: arm(0), silence: arm(2), saveAlone: arm(0) },
			}),
		]);
		expect(again.text).toContain("untriggered window");
		expect(again.heldBack).toEqual([]);
	});

	it("still replaces an older answer with a new one, and the flip stays visible", () => {
		const flipped = refreshSaveVerdictTable(REAL_DOC, [
			measure({
				server: "expert",
				fixture: { lang: "expert", lspGate: true },
				arms: { noSave: arm(0), silence: arm(0), saveAlone: arm(2) },
			}),
		]);
		expect(flipped.text).toContain("| expert | `save` | yes |");
		expect(flipped.heldBack).toEqual([]);
		const flips = listRefreshFlips(
			{ [MATRIX_DOC]: REAL_DOC },
			{ [MATRIX_DOC]: flipped.text },
		);
		expect(
			flips.some((f) => f.includes("- | expert |") && f.includes("| no |")),
		).toBe(true);
		expect(
			flips.some((f) => f.includes("+ | expert |") && f.includes("| yes |")),
		).toBe(true);
		const back = refreshSaveVerdictTable(flipped.text, [
			measure({
				server: "expert",
				fixture: { lang: "expert", lspGate: true },
				arms: { noSave: arm(3), saveAlone: arm(0) },
			}),
		]);
		expect(back.text).toContain("| expert | `save` | no |");
	});
});

describe("the held night reaches the Actions run (#5060 F1, F2)", () => {
	// Recurrence: PR #5069 round 1 held a night in a stderr line nothing read, and
	// the review deleted the driver's log loop and the `wroteCount` term with all
	// 70 tests still green. These cells cover the report, the floor count and the
	// summary at the functions the driver calls, and pin the calls themselves.
	const held = () =>
		refreshSaveVerdictTable(REAL_DOC, [measureExpert(), measureFsharp()])
			.heldBack;

	it("logs one line per held server and no annotation off Actions", () => {
		const lines: string[] = [];
		reportHeldBack(held(), {
			env: {},
			log: (line: string) => lines.push(line),
		});
		expect(lines).toHaveLength(2);
		expect(lines[0]).toMatch(/^save-verdict: held back expert: kept "no"/);
		expect(lines[1]).toMatch(/^save-verdict: held back fsharp: kept "no"/);
	});

	it("adds one ::warning:: per held server under GITHUB_ACTIONS", () => {
		const lines: string[] = [];
		reportHeldBack(held(), {
			env: { GITHUB_ACTIONS: "true" },
			log: (line: string) => lines.push(line),
		});
		const warnings = lines.filter((line) => line.startsWith("::warning::"));
		expect(warnings).toHaveLength(2);
		expect(warnings[0]).toContain("held back expert");
		expect(warnings[1]).toContain("held back fsharp");
		expect(lines).toHaveLength(4);
	});

	it("emits one record per server per run, however often the row repeats", () => {
		const lines: string[] = [];
		const [expert] = held();
		reportHeldBack([expert, expert, expert], {
			env: { GITHUB_ACTIONS: "true" },
			log: (line: string) => lines.push(line),
		});
		expect(lines).toHaveLength(2);
	});

	it("counts a held row as reached, so an all-held night is not 'no table row'", () => {
		const result = refreshSaveVerdictTable(REAL_DOC, [
			measureExpert(),
			measureFsharp(),
		]);
		expect(result.measured).toEqual([]);
		expect(rowsReached(result)).toBe(2);
		expect(rowsReached({ measured: ["cpp"], heldBack: held() })).toBe(3);
	});

	it("puts heldBack in the --summary record", () => {
		const result = refreshSaveVerdictTable(REAL_DOC, [measureExpert()]);
		const summary = saveVerdictSummary({
			command: "node scripts/probe-save-verdict.mjs",
			src: "ci",
			waitMs: 6000,
			rows: [{ cells: measureExpert() }],
			refreshed: result,
			notMeasured: [],
			budgetExhausted: false,
		});
		expect(summary.heldBack.map((h: { server: string }) => h.server)).toEqual([
			"expert",
		]);
		expect(summary.wrote).toEqual([]);
		expect(summary.measured).toEqual([measureExpert()]);
	});

	it("the driver calls the report, the floor count and the summary builder", () => {
		// The driver cannot run here (it spawns language servers), so this is the
		// closest executable check: the three calls exist in its code, read from
		// comment-and-string-blanked text so a comment naming them proves nothing.
		const driver = stripCommentsAndStrings(
			fs.readFileSync(
				fileURLToPath(
					new URL("../../scripts/probe-save-verdict.mjs", import.meta.url),
				),
				"utf8",
			),
		);
		expect(driver).toMatch(/\breportHeldBack\(\s*refreshed\.heldBack\b/);
		expect(driver).toMatch(/\browsReached\(\s*refreshed\s*\)/);
		expect(driver).toMatch(/\bsaveVerdictSummary\(\s*\{/);
	});
});

describe("SAVE_VERDICT_MARKER", () => {
	it("is the table header the doc carries", () => {
		expect(SAVE_VERDICT_MARKER).toBe("| server | save as declared |");
		expect(DOC).toContain(SAVE_VERDICT_MARKER);
	});
});
