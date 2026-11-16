/**
 * #5667: the idle-eviction doc's measured cells (`result`, `reason`, `respawn`,
 * `coverage`) change only after two agreeing nights, and a server this host
 * cannot spawn keeps its prior row.
 *
 * Recurrences these tests prevent:
 *  - 49ed14a6a: opengrep went from `eligible | ok | preserved` to `unavailable |
 *    server-not-started | n/a | n/a` on one night, because the document was
 *    regenerated in full from that night alone;
 *  - a751c7a65: csharp, dart and elixir moved between `unavailable` and
 *    `eligible` (and fsharp to `inconclusive`) on one night, and the refresh
 *    PR carried each as a capability flip.
 *
 * Every case drives `publishIdleEvictionDoc`, the one call the measurement
 * script publishes through, over the doc and the capability matrix as the
 * nightly saw them (fixtures: the 2026-11-16 #5677 refresh, and the matrix from
 * before #5668), and reads the pending flip back from the refresh-state block.
 * `does not prove`: a real language server (the probe is not run here).
 */
import * as fs from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type IdleEvictionRow,
	parseIdleEvictionDoc,
	publishIdleEvictionDoc,
	reportIdleEvictionHeld,
} from "../../scripts/lib/lsp-idle-eviction-doc.mjs";
import {
	IDLE_EVICTION_DOC_KEY,
	IDLE_EVICTION_KEY,
	parseRefreshState,
	refreshCapabilityMatrix,
	setRefreshStateKey,
} from "../../scripts/lib/md-matrix.mjs";
import { stripCommentsAndStrings } from "../support/session-state-scan.js";

const ROOT = resolve(import.meta.dirname, "../..");
const read = (rel: string) => fs.readFileSync(resolve(ROOT, rel), "utf8");
const PRIOR = read(
	"tests/fixtures/lsp-nightly/idle-eviction-2026-11-16-5677.md",
);
// Tonight's matrix (after #5668: a state block with promotion nights and no
// idle-eviction-doc key) and the one from before #5668 (no save-verdict key).
const MATRIX_5677 = read(
	"tests/fixtures/lsp-nightly/matrix-2026-11-16-5677.md",
);
const MATRIX_BEFORE = read(
	"tests/fixtures/lsp-nightly/matrix-2026-11-15-before-3405.md",
);

const prior = parseIdleEvictionDoc(PRIOR) ?? [];
const declared = new Map(prior.map((r) => [r.serverId, r.declared]));
const orNone = (v: string) => (v === "n/a" ? undefined : v);

/** The doc's own rows as tonight's measurement, with per-server overrides. */
function measured(over: Record<string, Partial<IdleEvictionRow>> = {}) {
	return prior.map(
		(r) =>
			({
				serverId: r.serverId,
				role: r.role,
				result: r.result,
				reason: r.reason,
				respawn: orNone(r.respawn),
				coverage: orNone(r.coverage),
				...over[r.serverId],
			}) as IdleEvictionRow,
	);
}

const UNAVAILABLE = {
	result: "unavailable",
	reason: "server-not-started",
	respawn: undefined,
	coverage: undefined,
} as const;
const NO_BASELINE = {
	result: "inconclusive",
	reason: "no-baseline",
	respawn: undefined,
	coverage: "unproven",
} as const;

function night(
	doc: string,
	matrix: string | undefined,
	over: Record<string, Partial<IdleEvictionRow>> = {},
	day = "2026-11-17",
) {
	return publishIdleEvictionDoc({
		rows: measured(over),
		declared,
		date: day,
		platform: "linux",
		priorDoc: doc,
		matrixText: matrix,
	});
}

const rowLine = (doc: string, id: string) =>
	doc.split("\n").find((l) => l.startsWith(`| ${id} |`));
const pendingOf = (matrix: string | undefined) =>
	(parseRefreshState(matrix ?? "")[IDLE_EVICTION_DOC_KEY] ?? {}) as Record<
		string,
		{ pendingCells: string; runs: number }
	>;
const countsLine = (doc: string) =>
	doc
		.split("\n")
		.find((l) => l.startsWith("_Last generated:"))
		?.replace(/^_Last generated: \S+ /, "");

describe("a server this host cannot spawn keeps its prior row (49ed14a6a)", () => {
	it("keeps opengrep's eligible row, its header count and its state, however many nights", () => {
		let doc = PRIOR;
		let matrix = MATRIX_5677;
		for (const day of ["2026-11-17", "2026-11-18", "2026-11-19"]) {
			const out = night(doc, matrix, { opengrep: UNAVAILABLE }, day);
			expect(rowLine(out.doc, "opengrep")).toBe(
				"| opengrep | auxiliary | transparent | eligible | · | ok | preserved |",
			);
			expect(countsLine(out.doc)).toBe(countsLine(PRIOR));
			expect(pendingOf(out.matrixText)).toEqual({});
			expect(out.held.map((h) => h.serverId)).toEqual(["opengrep"]);
			doc = out.doc;
			matrix = out.matrixText ?? matrix;
		}
	});

	it("keeps a prior unavailable row whatever other reason the night reads", () => {
		const out = night(PRIOR, MATRIX_5677, {
			elixir: { ...UNAVAILABLE, reason: "tool-unavailable" },
		});
		expect(rowLine(out.doc, "elixir")).toBe(
			"| elixir | primary | unmeasured | unavailable | server-not-started | n/a | n/a |",
		);
		// Host noise between two unavailable reasons is not a held answer.
		expect(out.held).toEqual([]);
	});

	it("publishes nothing when every row reads as before", () => {
		const out = night(PRIOR, MATRIX_5677);
		// The fixture predates the doc's hold prose, so compare what a night
		// measures: the rows, the counts and the findings, not the date or prose.
		const measuredLines = (doc: string) =>
			doc
				.split("\n")
				.filter((l) => /^(\| |- \*\*|_Last generated)/.test(l))
				.map((l) =>
					l.replace(/^_Last generated: \S+ /, "_Last generated: DAY "),
				);
		expect(measuredLines(out.doc)).toEqual(measuredLines(PRIOR));
		expect(out.matrixText).toBe(MATRIX_5677);
		expect(out.held).toEqual([]);
	});
});

describe("a settled cell changes after two agreeing nights (a751c7a65)", () => {
	const CSHARP =
		"| csharp | primary | unmeasured | eligible | · | ok | preserved |";
	const CSHARP_NEW =
		"| csharp | primary | unmeasured | inconclusive | no-baseline | n/a | unproven |";

	it("holds a first flip, records it, and commits on the second agreeing night", () => {
		const first = night(PRIOR, MATRIX_5677, { csharp: NO_BASELINE });
		expect(rowLine(first.doc, "csharp")).toBe(CSHARP);
		expect(pendingOf(first.matrixText).csharp).toEqual({
			pendingCells: "inconclusive|no-baseline|n/a|unproven",
			runs: 1,
		});
		expect(first.held[0]).toMatchObject({ serverId: "csharp", pendingRuns: 1 });
		const second = night(first.doc, first.matrixText, { csharp: NO_BASELINE });
		expect(rowLine(second.doc, "csharp")).toBe(CSHARP_NEW);
		expect(pendingOf(second.matrixText)).toEqual({});
		expect(countsLine(second.doc)).toContain(
			"37 eligible, 0 vetoed, 4 inconclusive",
		);
	});

	it("holds respawn and coverage with the result, not one cell at a time", () => {
		const out = night(PRIOR, MATRIX_5677, {
			dart: {
				result: "vetoed",
				reason: "findings-narrowed",
				respawn: "ok",
				coverage: "narrowed",
			},
		});
		expect(rowLine(out.doc, "dart")).toBe(
			"| dart | primary | unmeasured | eligible | · | ok | preserved |",
		);
		expect(pendingOf(out.matrixText).dart.pendingCells).toBe(
			"vetoed|findings-narrowed|ok|narrowed",
		);
	});

	it("restarts the count when the second night disagrees with the pending one", () => {
		const first = night(PRIOR, MATRIX_5677, { csharp: NO_BASELINE });
		const second = night(first.doc, first.matrixText, {
			csharp: { ...NO_BASELINE, reason: "not-evicted", coverage: "unproven" },
		});
		expect(rowLine(second.doc, "csharp")).toBe(CSHARP);
		expect(pendingOf(second.matrixText).csharp).toEqual({
			pendingCells: "inconclusive|not-evicted|n/a|unproven",
			runs: 1,
		});
	});

	it("clears the pending flip when a night returns to the published row", () => {
		const first = night(PRIOR, MATRIX_5677, { csharp: NO_BASELINE });
		expect(pendingOf(first.matrixText).csharp.runs).toBe(1);
		const back = night(first.doc, first.matrixText);
		expect(rowLine(back.doc, "csharp")).toBe(CSHARP);
		expect(pendingOf(back.matrixText)).toEqual({});
	});

	it("neither advances nor clears a pending flip on a night the server was not spawned", () => {
		const first = night(PRIOR, MATRIX_5677, { csharp: NO_BASELINE });
		const dark = night(first.doc, first.matrixText, { csharp: UNAVAILABLE });
		expect(pendingOf(dark.matrixText).csharp.runs).toBe(1);
		const third = night(dark.doc, dark.matrixText, { csharp: NO_BASELINE });
		expect(rowLine(third.doc, "csharp")).toBe(CSHARP_NEW);
	});

	it("publishes a first measurement over an unavailable prior on night one", () => {
		const out = night(PRIOR, MATRIX_5677, {
			elixir: {
				result: "eligible",
				reason: undefined,
				respawn: "ok",
				coverage: "preserved",
			},
		});
		expect(rowLine(out.doc, "elixir")).toBe(
			"| elixir | primary | unmeasured | eligible | · | ok | preserved |",
		);
		expect(pendingOf(out.matrixText)).toEqual({});
	});

	it("publishes a server the prior doc has no row for, and drops a pending flip of one the registry lost", () => {
		const pending = setRefreshStateKey(MATRIX_5677, IDLE_EVICTION_DOC_KEY, {
			"gone-server": {
				pendingCells: "vetoed|respawn-failed|failed|n/a",
				runs: 1,
			},
		});
		const rows = [
			...measured(),
			{ serverId: "fresh", role: "primary", ...UNAVAILABLE } as IdleEvictionRow,
		];
		const out = publishIdleEvictionDoc({
			rows,
			declared: new Map([...declared, ["fresh", "unmeasured"]]),
			date: "2026-11-17",
			platform: "linux",
			priorDoc: PRIOR,
			matrixText: pending,
		});
		expect(rowLine(out.doc, "fresh")).toContain(
			"| unavailable | server-not-started |",
		);
		expect(pendingOf(out.matrixText)).toEqual({});
	});
});

describe("the pending flips live in the refresh-state block (#5667)", () => {
	it("survive the matrix refresh that rewrites the block before the measurement", () => {
		const first = night(PRIOR, MATRIX_5677, { csharp: NO_BASELINE });
		const refreshed = refreshCapabilityMatrix(first.matrixText as string, [], {
			now: "2026-11-18",
		}).text;
		expect(pendingOf(refreshed).csharp.runs).toBe(1);
	});

	it("leave the promotion nights alone and parse the block as #5677 and the pre-#5668 doc carried it", () => {
		for (const matrix of [MATRIX_5677, MATRIX_BEFORE]) {
			const out = night(PRIOR, matrix, { csharp: NO_BASELINE });
			expect(
				parseRefreshState(out.matrixText as string)[IDLE_EVICTION_KEY],
			).toEqual(parseRefreshState(matrix)[IDLE_EVICTION_KEY]);
			expect(pendingOf(out.matrixText).csharp.runs).toBe(1);
		}
	});

	it("treat a hand-edited entry as no memory, so a junk value can never commit a flip", () => {
		const junk = setRefreshStateKey(MATRIX_5677, IDLE_EVICTION_DOC_KEY, {
			csharp: {
				pendingCells: "inconclusive|no-baseline|n/a|unproven",
				runs: -3,
			},
			dart: { pendingCells: "", runs: 4 },
		} as never);
		const out = night(PRIOR, junk, { csharp: NO_BASELINE });
		expect(rowLine(out.doc, "csharp")).toContain("| eligible |");
		expect(pendingOf(out.matrixText).csharp.runs).toBe(1);
	});
});

describe("the published document stays self-consistent", () => {
	it("renders the declared-versus-measured section from the held rows", () => {
		const out = night(PRIOR, MATRIX_5677, { opengrep: UNAVAILABLE });
		expect(out.doc).not.toContain("**opengrep** [info]");
	});

	it("publishes unheld, as before, when there is no matrix to keep a pending flip in", () => {
		const out = night(PRIOR, undefined, { opengrep: UNAVAILABLE });
		expect(rowLine(out.doc, "opengrep")).toContain(
			"| unavailable | server-not-started |",
		);
		expect(out.matrixText).toBeUndefined();
	});

	it("publishes every row when the prior document has no table to hold against", () => {
		const out = night("# nothing here\n", MATRIX_5677, {
			opengrep: UNAVAILABLE,
		});
		expect(rowLine(out.doc, "opengrep")).toContain(
			"| unavailable | server-not-started |",
		);
		expect(out.held).toEqual([]);
	});

	it("treats a prior row whose result is not a known state as no prior row", () => {
		const hand = PRIOR.replace(
			"| opengrep | auxiliary | transparent | eligible |",
			"| opengrep | auxiliary | transparent | mostly-fine |",
		);
		const out = night(hand, MATRIX_5677, { opengrep: UNAVAILABLE });
		expect(rowLine(out.doc, "opengrep")).toContain(
			"| unavailable | server-not-started |",
		);
	});
});

describe("a held cell is recorded once per server per run", () => {
	const held = [
		{
			serverId: "csharp",
			prior: "eligible|·|ok|preserved",
			measured: "inconclusive|no-baseline|n/a|unproven",
			pendingRuns: 1,
		},
		{
			serverId: "opengrep",
			prior: "eligible|·|ok|preserved",
			measured: "unavailable|server-not-started|n/a|n/a",
		},
	];

	it("logs one line per server and one annotation under Actions", () => {
		const lines: string[] = [];
		reportIdleEvictionHeld([...held, held[0]], {
			env: { GITHUB_ACTIONS: "true" },
			log: (l) => lines.push(l),
		});
		expect(
			lines.filter((l) => l.startsWith("idle-eviction doc: held back")),
		).toEqual([
			'idle-eviction doc: held back csharp: kept "eligible|·|ok|preserved", this night measured "inconclusive|no-baseline|n/a|unproven" (flip pending, night 1 of 2)',
			'idle-eviction doc: held back opengrep: kept "eligible|·|ok|preserved", this night measured "unavailable|server-not-started|n/a|n/a" (server not spawned)',
		]);
		expect(lines.filter((l) => l.startsWith("::warning::"))).toHaveLength(1);
		expect(lines.at(-1)).toContain("csharp, opengrep");
	});

	it("writes no annotation outside Actions", () => {
		const lines: string[] = [];
		reportIdleEvictionHeld(held, { env: {}, log: (l) => lines.push(l) });
		expect(lines.some((l) => l.startsWith("::warning::"))).toBe(false);
	});
});

describe("the measurement script publishes through the hold (#5667)", () => {
	// 49ed14a6a shipped because the script rendered the document straight from
	// the night's rows. The script cannot be imported (it spawns servers at top
	// level), so its source is read with comments and strings blanked.
	const script = stripCommentsAndStrings(
		read("scripts/measure-lsp-idle-eviction.mjs"),
	);

	it("calls publishIdleEvictionDoc and never renders the document from raw rows", () => {
		expect(script).toMatch(/publishIdleEvictionDoc\(/);
		expect(script).not.toMatch(/renderIdleEvictionDoc\(/);
	});

	it("keeps the summary, the drift state and the evaluated floor on the measured rows", () => {
		expect(script).toMatch(/idleEvictionDrift\(rows,/);
		expect(script).toMatch(/driftIssueState\(rows,/);
		expect(script).toMatch(/summarizeRows\(rows\)/);
	});
});
