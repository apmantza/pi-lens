// flake-shape: real-process-spawn — the subject IS the CLI's own argv
// parsing (--report/--out) and file I/O; an in-process call would test the
// exported render function again, not the entry script's own wiring.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	renderMutationMarkdown,
	renderStaleMarkdown,
	STICKY_MARKER,
} from "../../scripts/lib/mutation-report-render.mjs";

describe("renderMutationMarkdown", () => {
	it("never reads a 0-mutant run as a clean pass, and states the reason", () => {
		// Recurrence (#3531 acceptance): "A run that evaluates 0 mutants MUST
		// say so ... and must never read as a clean pass."
		const markdown = renderMutationMarkdown({
			files: {},
			piLensMutationDiff: {
				base: "origin/master",
				headSha: "abc1234567890",
				zeroMutants: {
					reason: "no PR-changed lines fall under scripts/**/*.mjs, ...",
				},
			},
		});

		expect(markdown).toContain("0 mutants evaluated");
		expect(markdown).toContain("not a clean pass");
		expect(markdown).toContain("no PR-changed lines fall under");
		expect(markdown).not.toMatch(/score/i);
	});

	it("renders excluded tests and their reasons on the delivered scored summary", () => {
		// Recurrence (#3625 F3): metadata-only exclusions made the scored report
		// look as though the entire related population had been evaluated.
		const markdown = renderMutationMarkdown({
			files: {},
			piLensMutationDiff: {
				base: "origin/master",
				headSha: "abc1234567890",
				zeroMutants: null,
				counts: { Killed: 1 },
				score: "100.00",
				testsExcluded: [
					{
						file: "tests/mcp/server.smoke.test.ts",
						reason: "real stdio scheduling",
					},
				],
			},
		});
		expect(markdown).toContain("Excluded tests:");
		expect(markdown).toContain("tests/mcp/server.smoke.test.ts");
		expect(markdown).toContain("real stdio scheduling");
	});

	it("round 4 R3-1: renders 0/no-zeroMutants/no-partial as not a clean pass, backstopping a driver branch that failed to set either", () => {
		// Recurrence: the round-4 review mutated the driver's OWN success/zero
		// branch (`if (mutants.length > 0)` -> `>= 0`) and its partial branch
		// (`if (outcome.partial)` -> `false`) directly, one at a time. BOTH
		// produced a report with the exact same signature reproduced here --
		// zeroMutants unset, partial unset, 0 total counts -- and all four
		// mutation test files stayed green, because nothing but that one
		// driver `if` ever looked at the raw `mutants.length`. This backstop
		// operates on the WRITTEN REPORT alone, so it catches that signature
		// regardless of which driver branch produced it.
		const markdown = renderMutationMarkdown({
			files: {},
			piLensMutationDiff: {
				base: "origin/master",
				headSha: "abc1234567890",
				zeroMutants: null,
				partial: null,
				counts: {},
				score: "n/a",
			},
		});

		expect(markdown).toContain("0 mutants evaluated");
		expect(markdown).toContain("not a clean pass");
		expect(markdown).not.toContain("Score: n/a%");
		expect(markdown).not.toContain("No survivors.");
	});

	it("round 4 R3-1: mutation 2's exact shape (no counts/score field at all, from the interrupted-else path)", () => {
		// The interrupted branch's `else` (taken when `outcome.partial` is
		// falsy) writes `baseMeta({ zeroMutants: outcome.zeroMutants, ... })`
		// with NO `counts`/`score` fields at all -- distinct from the
		// completed-run zero path above, which DOES set them (to `{}`/"n/a").
		// Both must trip the same backstop.
		const markdown = renderMutationMarkdown({
			files: {},
			piLensMutationDiff: {
				base: "origin/master",
				headSha: "abc1234567890",
				zeroMutants: null,
			},
		});

		expect(markdown).toContain("0 mutants evaluated");
		expect(markdown).toContain("not a clean pass");
	});

	it("round 4 R3-1: the backstop does not fire on a genuine partial run with a real (nonzero) evaluated count", () => {
		// The backstop's condition is `!meta.partial && total === 0` -- a
		// partial run with `partial` SET must still render as partial, not
		// fall into the zero-mutant backstop text, even though its own
		// `counts` can legitimately total more than zero mutants evaluated.
		const markdown = renderMutationMarkdown({
			files: {},
			piLensMutationDiff: {
				base: "origin/master",
				headSha: "abc1234",
				zeroMutants: null,
				partial: { reason: "budget expired", evaluated: 3, total: 9 },
				counts: { Killed: 3 },
				score: "100.00",
			},
		});

		expect(markdown).toContain("Partial run");
		expect(markdown).not.toContain("0 mutants evaluated");
	});

	it("round 5 R4-1: a raw Stryker report with no piLensMutationDiff meta at all still renders its real survivors", () => {
		// Recurrence: round 4's backstop computed `total` from `meta.counts`
		// only. A RAW `mutation.json` -- read directly, never through this
		// driver's `writeReport` -- has no `piLensMutationDiff` key, so
		// `meta.counts` is absent even though `report.files` holds real
		// mutants: at fbb080105 this rendered "0 mutants evaluated" and
		// dropped the survivor table for a report with 1 Survived + 1 Killed.
		const markdown = renderMutationMarkdown({
			files: {
				"clients/x.js": {
					mutants: [
						{
							id: "0",
							mutatorName: "BooleanLiteral",
							replacement: "false",
							original: "true",
							status: "Survived",
							location: {
								start: { line: 1, column: 1 },
								end: { line: 1, column: 5 },
							},
						},
						{
							id: "1",
							mutatorName: "EqualityOperator",
							replacement: "!==",
							status: "Killed",
						},
					],
				},
			},
			// No `piLensMutationDiff` at all -- the raw shape Stryker itself
			// writes.
		});

		expect(markdown).not.toContain("0 mutants evaluated");
		expect(markdown).not.toContain("not a clean pass");
		expect(markdown).toContain("#### Survivors (1)");
		expect(markdown).toContain("clients/x.js:1");
		expect(markdown).toContain("1 killed, 1 survived");
	});

	it("names the --max-files cap and the uncovered files when either applies", () => {
		const markdown = renderMutationMarkdown({
			files: {},
			piLensMutationDiff: {
				base: "origin/master",
				headSha: "abc1234567890",
				zeroMutants: {
					reason: "no changed mutation source has a covering test",
				},
				filesSkippedOverCap: ["clients/z.ts"],
				filesUncovered: ["clients/a.ts"],
			},
		});

		expect(markdown).toContain("clients/z.ts");
		expect(markdown).toContain("clients/a.ts");
	});

	it("tables every survivor with its .ts location when a compiled source maps one", () => {
		const markdown = renderMutationMarkdown({
			files: {
				"clients/runtime-tool-result.js": {
					mutants: [
						{
							id: "1",
							mutatorName: "CallExpression",
							replacement: ";",
							original:
								"runtime.appendCascadePromise(result.cascadePromise, writeSession, filePath);",
							status: "Survived",
							location: {
								start: { line: 1915, column: 9 },
								end: { line: 1915, column: 89 },
							},
							tsLocation: {
								fileName: "clients/runtime-tool-result.ts",
								line: 2515,
							},
						},
					],
				},
			},
			piLensMutationDiff: {
				base: "origin/master",
				headSha: "f9582da8b6189f0f4e512912cf82cd05c2da8b68",
				zeroMutants: null,
				counts: { Survived: 1 },
				score: "0.00",
				testsRun: ["tests/clients/runtime-tool-result.test.ts"],
			},
		});

		expect(markdown).toContain("clients/runtime-tool-result.ts:2515");
		expect(markdown).not.toContain("runtime-tool-result.js:1915");
		expect(markdown).toContain("CallExpression");
		expect(markdown).toContain(
			"`runtime.appendCascadePromise(result.cascadePromise, writeSession, filePath);` → `;`",
		);
	});

	it("falls back to the compiled .js location for a survivor with no ts mapping (e.g. a scripts/**/*.mjs source)", () => {
		const markdown = renderMutationMarkdown({
			files: {
				"scripts/lib/stryker-diff.mjs": {
					mutants: [
						{
							id: "1",
							mutatorName: "StringLiteral",
							replacement: '""',
							status: "Survived",
							location: {
								start: { line: 57, column: 24 },
								end: { line: 57, column: 62 },
							},
						},
					],
				},
			},
			piLensMutationDiff: {
				base: "origin/master",
				headSha: "abc1234",
				zeroMutants: null,
				counts: { Survived: 1 },
				score: "0.00",
			},
		});

		expect(markdown).toContain("scripts/lib/stryker-diff.mjs:57");
	});

	it("says 'no survivors' plainly when every mutant was killed", () => {
		const markdown = renderMutationMarkdown({
			files: {},
			piLensMutationDiff: {
				base: "origin/master",
				headSha: "abc1234",
				zeroMutants: null,
				counts: { Killed: 4 },
				score: "100.00",
			},
		});

		expect(markdown).toContain("No survivors.");
		expect(markdown).not.toContain("| Location |");
	});

	it("#3592 round 2 F4: renders metaTable's --max-files row on a normal, complete, scored run too", () => {
		// Recurrence this guards: the FINAL `lines.push(metaTable(meta))` at
		// the end of a normal scored render (after the survivor table or "No
		// survivors.") survived PR #3590's own mutation run as `;` -- every
		// pre-existing test that asserts metaTable content (the --max-files
		// and no-covering-test rows) does so through the EARLIER,
		// zero-mutant-branch call to metaTable, never through this one.
		const markdown = renderMutationMarkdown({
			files: {},
			piLensMutationDiff: {
				base: "origin/master",
				headSha: "abc1234",
				zeroMutants: null,
				partial: null,
				filesSkippedOverCap: ["clients/z.ts"],
				counts: { Killed: 4 },
				score: "100.00",
			},
		});

		expect(markdown).toContain("Skipped (over --max-files)");
		expect(markdown).toContain("clients/z.ts");
	});

	it("round 3 R2-1: prints the sampling note on the zero-mutant path too, and the sample-aware reason", () => {
		// Recurrence: a real #3579 replay sampled 1 of 99 ranges (a
		// shorthand-property line with 0 mutants) while the measurement found
		// 710 mutants across all 99 -- the zero-mutant branch returned before
		// ever reaching the "Sampled N of M" note built below it, so the
		// comment read as an unqualified "no mutable code in 99 ranges", with
		// no hint that 98 of those 99 were never even tried.
		const markdown = renderMutationMarkdown({
			files: {},
			piLensMutationDiff: {
				base: "origin/master",
				headSha: "9ebbb5dac2d3157d4a5560366098a85ee5099fd6",
				zeroMutants: {
					reason:
						"0 mutants in 1 sampled of 99 ranges (99 ranges held 710 mutant(s))",
				},
				rangesSampled: true,
				rangesEvaluated: 1,
				rangesTotal: 99,
			},
		});

		expect(markdown).toContain("0 mutants evaluated");
		expect(markdown).toContain(
			"0 mutants in 1 sampled of 99 ranges (99 ranges held 710 mutant(s))",
		);
		expect(markdown).toContain("Sampled 1 of 99");
	});

	it("names a deterministic sample when the range budget capped the run", () => {
		const markdown = renderMutationMarkdown({
			files: {},
			piLensMutationDiff: {
				base: "origin/master",
				headSha: "deadbeef0000",
				zeroMutants: null,
				counts: { Killed: 40 },
				score: "100.00",
				rangesSampled: true,
				rangesEvaluated: 40,
				rangesTotal: 212,
			},
		});

		expect(markdown).toContain("Sampled 40 of 212");
		expect(markdown).toContain("deadbeef0000".slice(0, 12));
	});

	it("discloses a truncated test population on scored, partial, and zero reports", () => {
		// Recurrence M3648-2: a bounded test population must not render as a
		// complete score or an unexplained zero/partial result in the PR comment.
		const testSelection = {
			mode: "coverage",
			pool: 155,
			covering: 60,
			kept: 47,
			dropped: 13,
			own: 2,
			unknown: 0,
		};
		const scored = renderMutationMarkdown({
			files: {},
			piLensMutationDiff: {
				counts: { Killed: 1 },
				score: "100.00",
				testSelection,
			},
		});
		const partial = renderMutationMarkdown({
			files: {},
			piLensMutationDiff: {
				partial: { evaluated: 1, total: 2, reason: "budget expired" },
				counts: { Killed: 1 },
				score: "100.00",
				testSelection,
			},
		});
		const zero = renderMutationMarkdown({
			files: {},
			piLensMutationDiff: {
				zeroMutants: { reason: "no mutable lines" },
				testSelection,
			},
		});
		for (const markdown of [scored, partial, zero]) {
			expect(markdown).toContain("13 covering test(s) dropped by the test cap");
			expect(markdown).toContain("truncated test population");
		}
	});

	it("reports related -> covering -> kept on every report kind, and names the truncation only when a test was dropped (S12)", () => {
		// Recurrence S12: the note must not appear when nothing was dropped (a
		// complete population is not "truncated"), and kept < covering is not the
		// trigger -- an own test that covers nothing is kept regardless.
		const whole = {
			mode: "coverage",
			pool: 72,
			covering: 16,
			kept: 16,
			dropped: 0,
			own: 3,
			unknown: 0,
		};
		const scored = renderMutationMarkdown({
			files: {},
			piLensMutationDiff: {
				counts: { Killed: 1 },
				score: "100.00",
				testSelection: whole,
			},
		});
		const zero = renderMutationMarkdown({
			files: {},
			piLensMutationDiff: {
				zeroMutants: { reason: "no mutable lines" },
				testSelection: whole,
			},
		});
		for (const markdown of [scored, zero]) {
			expect(markdown).toContain(
				"**Test selection:** related 72 → covering 16 → kept 16 (3 own)",
			);
			expect(markdown).not.toContain("truncated test population");
			expect(markdown).not.toContain("dropped by the test cap");
		}
		const ownExtra = renderMutationMarkdown({
			files: {},
			piLensMutationDiff: {
				counts: { Killed: 1 },
				score: "100.00",
				testSelection: { ...whole, covering: 13, kept: 16 },
			},
		});
		expect(ownExtra).not.toContain("truncated test population");
	});

	it("says coverage was unavailable when the kept set came from the import graph alone, and names probe failures", () => {
		const markdown = renderMutationMarkdown({
			files: {},
			piLensMutationDiff: {
				counts: { Killed: 1 },
				score: "100.00",
				testSelection: {
					mode: "import-graph",
					pool: 30,
					covering: null,
					kept: 30,
					dropped: 0,
					own: 0,
					unknown: 2,
				},
			},
		});
		expect(markdown).toContain(
			"related 30 → covering coverage unavailable (import-graph ranking) → kept 30 (2 probe failed)",
		);
		const truncated = renderMutationMarkdown({
			files: {},
			piLensMutationDiff: {
				counts: { Killed: 1 },
				score: "100.00",
				testSelection: {
					mode: "import-graph",
					pool: 72,
					covering: null,
					kept: 47,
					dropped: 25,
					own: 0,
					unknown: 0,
				},
			},
		});
		expect(truncated).toContain("25 related test(s) dropped by the test cap");
	});

	it("renders the exact selection line: bare without extras, comma-joined with both", () => {
		const render = (extra: object) =>
			renderMutationMarkdown({
				files: {},
				piLensMutationDiff: {
					counts: { Killed: 1 },
					score: "100.00",
					testSelection: {
						mode: "coverage",
						pool: 72,
						covering: 16,
						kept: 16,
						dropped: 0,
						own: 0,
						unknown: 0,
						...extra,
					},
				},
			});
		expect(render({})).toMatch(
			/^- \*\*Test selection:\*\* related 72 → covering 16 → kept 16$/m,
		);
		expect(render({ own: 3, unknown: 2 })).toMatch(
			/^- \*\*Test selection:\*\* .* kept 16 \(3 own, 2 probe failed\)$/m,
		);
	});

	it.each([
		["pool", { pool: "72" }],
		["kept", { kept: "16" }],
		["dropped", { dropped: "0" }],
		["covering", { covering: "16" }],
	])("ignores a selection whose %s is not a number", (_field, bad) => {
		// Each of the four fields is validated on its own: a selection that is
		// well-formed except for one must not render NaN or "undefined".
		const markdown = renderMutationMarkdown({
			files: {},
			piLensMutationDiff: {
				counts: { Killed: 1 },
				score: "100.00",
				testSelection: {
					pool: 72,
					covering: 16,
					kept: 16,
					dropped: 4,
					own: 0,
					unknown: 0,
					...bad,
				},
			},
		});
		expect(markdown).not.toContain("Test selection");
		expect(markdown).not.toContain("dropped by the test cap");
	});

	it("needs both reuse counts to claim a count, and says so when only one is a number", () => {
		const render = (incremental: object) =>
			renderMutationMarkdown({
				files: {},
				piLensMutationDiff: {
					counts: { Killed: 1 },
					score: "100.00",
					incremental,
				},
			});
		const unavailable = "restored cache accepted (reuse count unavailable)";
		expect(render({ state: "warm", reused: 5, total: null })).toContain(
			unavailable,
		);
		expect(render({ state: "warm", reused: null, total: 6 })).toContain(
			unavailable,
		);
	});

	it("ignores a malformed test selection instead of rendering NaN", () => {
		const markdown = renderMutationMarkdown({
			files: {},
			piLensMutationDiff: {
				counts: { Killed: 1 },
				score: "100.00",
				testSelection: { pool: "many", kept: 1, dropped: 2 },
			},
		});
		expect(markdown).not.toContain("Test selection");
		expect(markdown).not.toContain("dropped by the test cap");
	});

	it("reports the incremental cache state, with the reuse count only for a warm run", () => {
		const render = (incremental: unknown) =>
			renderMutationMarkdown({
				files: {},
				piLensMutationDiff: {
					counts: { Killed: 1 },
					score: "100.00",
					incremental,
				},
			});
		expect(render({ state: "warm", reused: 41, total: 57 })).toContain(
			"**Incremental:** 41 of 57 mutant result(s) reused from the previous push",
		);
		expect(render({ state: "warm", reused: null, total: null })).toContain(
			"restored cache accepted (reuse count unavailable)",
		);
		expect(render({ state: "cold-no-cache" })).toContain(
			"**Incremental:** cold (no restored cache)",
		);
		expect(render({ state: "cold-inputs-changed" })).toContain(
			"cold (a kept test or another changed file differs from the cached run)",
		);
		expect(render({ state: "mystery" })).not.toContain("Incremental");
		expect(render(null)).not.toContain("Incremental");
	});

	it("carries the sticky-comment marker so the workflow can find and update its own comment", () => {
		expect(
			renderMutationMarkdown({ files: {}, piLensMutationDiff: {} }),
		).toContain(STICKY_MARKER);
	});

	it("round 2 S2: labels a partial (budget-killed) run distinctly, alongside whatever DID run", () => {
		const markdown = renderMutationMarkdown({
			files: {
				"clients/string-utils.js": {
					mutants: [
						{
							id: "0",
							mutatorName: "ConditionalExpression",
							replacement: "true",
							status: "Killed",
							location: {
								start: { line: 19, column: 12 },
								end: { line: 19, column: 17 },
							},
						},
					],
				},
			},
			piLensMutationDiff: {
				base: "origin/master",
				headSha: "abc1234",
				zeroMutants: null,
				partial: {
					// round 3 R2-4: describePartialMutationOutcome's shape -- never
					// "no mutants evaluated" under a "6 of 9 evaluated" banner.
					reason:
						"mutation diff: the 0.55-minute mutation budget expired before Stryker produced a result",
					evaluated: 6,
					total: 9,
				},
				counts: { Killed: 6 },
				score: "100.00",
			},
		});

		expect(markdown).toContain("Partial run");
		expect(markdown).toContain(
			"**Partial run** -- 6 of 9 mutant(s) evaluated before the interrupt.",
		);
		expect(markdown).toContain("budget expired");
		// Recurrence (round 3 R2-4): the reason sits right under "6 of 9
		// evaluated" -- it must never itself say the run evaluated nothing.
		expect(markdown).not.toContain("no mutants evaluated");
		// The partial run's own real counts still render, same as a complete run.
		expect(markdown).toContain("100.00");
	});

	it("names an unknown total when the partial run's total mutant count could not be measured", () => {
		const markdown = renderMutationMarkdown({
			files: {},
			piLensMutationDiff: {
				zeroMutants: null,
				partial: { reason: "budget expired", evaluated: 3, total: null },
				counts: { Killed: 3 },
				score: "100.00",
			},
		});

		expect(markdown).toContain("3 of an unknown total of mutant(s)");
	});

	it("#3592 item 2: renders an unsampled, non-partial run as incomplete when it evaluated fewer mutants than the dry run measured", () => {
		// Recurrence this backstops: if a FUTURE driver change dropped
		// `meta.partial` on an interrupted-but-unsampled run, the report would
		// otherwise carry a real (nonzero) `counts`/`score` and render as a
		// normal, complete scored pass -- silently discarding however many
		// mutants never ran. `measuredTotalMutants` (the dry run's own
		// measured count for this candidate range set, persisted into every
		// report by the driver's `baseMeta`) is the only other in-report
		// signal that can catch that shape.
		const markdown = renderMutationMarkdown({
			files: {
				"clients/x.js": {
					mutants: [
						{
							id: "0",
							mutatorName: "BooleanLiteral",
							replacement: "false",
							status: "Killed",
						},
					],
				},
			},
			piLensMutationDiff: {
				base: "origin/master",
				headSha: "abc1234",
				zeroMutants: null,
				partial: null,
				rangesSampled: false,
				measuredTotalMutants: 9,
				counts: { Killed: 1 },
				score: "100.00",
			},
		});

		expect(markdown).toContain("Incomplete run");
		expect(markdown).toContain("1 mutant(s) were evaluated");
		expect(markdown).toContain("measured 9");
		expect(markdown).not.toContain("No survivors.");
		expect(markdown).not.toContain("100.00");
	});

	it("#3592 round 2 F3: also flags the OTHER direction of the mismatch -- more evaluated than measured", () => {
		// The comparison is `!==`, not `<`, on purpose: a data-integrity
		// anomaly where evaluated exceeds the measured total is just as much
		// evidence something is wrong with the report as evaluating fewer.
		const markdown = renderMutationMarkdown({
			files: {
				"clients/x.js": {
					mutants: [
						{
							id: "0",
							mutatorName: "BooleanLiteral",
							replacement: "false",
							status: "Killed",
						},
						{
							id: "1",
							mutatorName: "BooleanLiteral",
							replacement: "false",
							status: "Killed",
						},
					],
				},
			},
			piLensMutationDiff: {
				base: "origin/master",
				headSha: "abc1234",
				zeroMutants: null,
				partial: null,
				rangesSampled: false,
				measuredTotalMutants: 1,
				counts: { Killed: 2 },
				score: "100.00",
			},
		});

		expect(markdown).toContain("Incomplete run");
		expect(markdown).toContain("2 mutant(s) were evaluated");
		expect(markdown).toContain("measured 1");
	});

	it("#3592 item 2: does NOT flag a sampled run whose evaluated count is legitimately below the measured total", () => {
		// measuredTotalMutants counts the WHOLE candidate range set, not the
		// sampled subset actually run -- a sampled, complete run evaluating
		// fewer mutants than that total is the expected, healthy case.
		const markdown = renderMutationMarkdown({
			files: {
				"clients/x.js": {
					mutants: [
						{
							id: "0",
							mutatorName: "BooleanLiteral",
							replacement: "false",
							status: "Killed",
						},
					],
				},
			},
			piLensMutationDiff: {
				base: "origin/master",
				headSha: "abc1234",
				zeroMutants: null,
				partial: null,
				rangesSampled: true,
				rangesEvaluated: 2,
				rangesTotal: 99,
				measuredTotalMutants: 710,
				counts: { Killed: 1 },
				score: "100.00",
			},
		});

		expect(markdown).not.toContain("Incomplete run");
		expect(markdown).toContain("100.00");
	});

	it("#3592 item 2: does NOT flag a genuinely complete, unsampled run whose evaluated count matches the measured total", () => {
		const markdown = renderMutationMarkdown({
			files: {
				"clients/x.js": {
					mutants: [
						{
							id: "0",
							mutatorName: "BooleanLiteral",
							replacement: "false",
							status: "Killed",
						},
					],
				},
			},
			piLensMutationDiff: {
				base: "origin/master",
				headSha: "abc1234",
				zeroMutants: null,
				partial: null,
				rangesSampled: false,
				measuredTotalMutants: 1,
				counts: { Killed: 1 },
				score: "100.00",
			},
		});

		expect(markdown).not.toContain("Incomplete run");
		expect(markdown).toContain("100.00");
	});

	it("#3592 item 2: does NOT flag a run with no measured total on record (measurement never ran, or its output could not be parsed)", () => {
		const markdown = renderMutationMarkdown({
			files: {
				"clients/x.js": {
					mutants: [
						{
							id: "0",
							mutatorName: "BooleanLiteral",
							replacement: "false",
							status: "Killed",
						},
					],
				},
			},
			piLensMutationDiff: {
				base: "origin/master",
				headSha: "abc1234",
				zeroMutants: null,
				partial: null,
				rangesSampled: false,
				measuredTotalMutants: null,
				counts: { Killed: 1 },
				score: "100.00",
			},
		});

		expect(markdown).not.toContain("Incomplete run");
		expect(markdown).toContain("100.00");
	});

	it("#3592 round 2 F2: does NOT flag a genuine PARTIAL run whose evaluated count is legitimately below the measured total", () => {
		// Recurrence this guards against: `evaluatedMismatch`'s `!meta.partial`
		// conjunct is what keeps this backstop from firing on a run that IS
		// supposed to have evaluated fewer mutants than measured -- every
		// partial run does, by definition (that is what "partial" means).
		// Without that conjunct, this exact shape (partial set, evaluated <
		// measuredTotalMutants, unsampled) would render "Incomplete run" and
		// return BEFORE the partial-run render path or the survivor table are
		// ever reached, silently dropping both.
		const markdown = renderMutationMarkdown({
			files: {
				"clients/x.js": {
					mutants: [
						{
							id: "0",
							mutatorName: "BooleanLiteral",
							replacement: "false",
							status: "Survived",
							location: {
								start: { line: 1, column: 1 },
								end: { line: 1, column: 5 },
							},
						},
					],
				},
			},
			piLensMutationDiff: {
				base: "origin/master",
				headSha: "abc1234",
				zeroMutants: null,
				partial: {
					reason:
						"mutation diff: the budget expired before Stryker produced a result",
					evaluated: 6,
					total: 9,
				},
				rangesSampled: false,
				measuredTotalMutants: 9,
				counts: { Survived: 1, Killed: 5 },
				score: "83.33",
			},
		});

		expect(markdown).toContain("Partial run");
		expect(markdown).not.toContain("Incomplete run");
		expect(markdown).toContain("#### Survivors (1)");
	});
});

describe("renderStaleMarkdown (#3531 round 2 T6, round 3/4 R2-4 wording)", () => {
	it("names the head that produced no report, and carries the sticky marker so a later run finds and updates it", () => {
		const markdown = renderStaleMarkdown({
			headSha: "deadbeef00001234",
			runUrl: undefined,
		});

		expect(markdown).toContain(STICKY_MARKER);
		expect(markdown).toContain("Stale");
		expect(markdown).toContain("deadbeef0000");
		expect(markdown).toContain("no longer reflects this PR's current head");
		// Recurrence (round 3 R2-4): the PATCH this very call produces
		// OVERWRITES the comment with this notice -- "left over" implied no
		// action was taken, when the update is happening right now.
		expect(markdown).not.toContain("left over");
		// Recurrence (round 4, cosmetic): the neutral cause clause used to
		// read "produced no mutation report -- it did not produce one (…)",
		// a doubled sentence.
		expect(markdown).not.toContain("it did not produce one");
	});

	it("links the job run when a run URL is given", () => {
		const markdown = renderStaleMarkdown({
			headSha: "abc123",
			runUrl: "https://github.com/apmantza/pi-lens/actions/runs/123",
		});

		expect(markdown).toContain(
			"[Job run](https://github.com/apmantza/pi-lens/actions/runs/123)",
		);
	});

	it("renders without throwing when given no context at all", () => {
		expect(() => renderStaleMarkdown()).not.toThrow();
		expect(renderStaleMarkdown()).toContain(STICKY_MARKER);
	});

	it("names BOTH possible causes of a 'cancelled' upstream result -- a superseding push or the job's own time limit", () => {
		// Recurrence (round 4): `needs.mutation.result` reads "cancelled" both
		// when the workflow's own per-PR concurrency group supersedes a run
		// AND when the job runs past its `timeout-minutes` -- this job cannot
		// tell those two apart, so naming only "superseded" would misattribute
		// a genuine timeout to a push that never happened.
		const markdown = renderStaleMarkdown({
			headSha: "abc123",
			upstreamResult: "cancelled",
		});

		expect(markdown).toContain(
			"cancelled: a newer push superseded it, or the job hit its time limit",
		);
		expect(markdown).not.toContain("crash");
	});

	it("words it neutrally (not a specific crash/cancellation claim) when the upstream result is unknown or a genuine failure", () => {
		const markdown = renderStaleMarkdown({
			headSha: "abc123",
			upstreamResult: "failure",
		});

		expect(markdown).not.toContain("superseded");
	});
});

describe("scripts/mutation-report.mjs (CLI)", () => {
	let dir: string;

	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	it("renders a report file to stdout", () => {
		dir = mkdtempSync(join(tmpdir(), "pi-lens-mutation-report-cli-"));
		const reportPath = join(dir, "mutation.json");
		writeFileSync(
			reportPath,
			JSON.stringify({
				files: {},
				piLensMutationDiff: {
					base: "origin/master",
					headSha: "abc1234",
					zeroMutants: { reason: "no mutable diff" },
				},
			}),
		);

		const output = execFileSync(
			"node",
			["scripts/mutation-report.mjs", "--report", reportPath],
			{ encoding: "utf8" },
		);

		expect(output).toContain("0 mutants evaluated");
		expect(output).toContain("no mutable diff");
	});

	it("exits non-zero with a clear message when the report file is missing", () => {
		expect(() =>
			execFileSync(
				"node",
				[
					"scripts/mutation-report.mjs",
					"--report",
					"/nonexistent/mutation.json",
				],
				{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
			),
		).toThrow();
	});
});
