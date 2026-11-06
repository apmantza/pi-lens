/**
 * #5323 D3: every measured server gets a capability-matrix row, through the
 * real nightly merges over a recorded run.
 *
 * Recurrences this file prevents:
 *  - `mergeCharacterization` never appended a row, so run 41462786084 measured
 *    48 servers and kept 30 rows: go, cpp, kotlin, fish and the rest never got
 *    a version or a stale mark (#4512 items 1 and 4).
 *  - #5325 round 1 appended them all to the curated table, with blank
 *    clean-behavior cells and fixture variants as rows, and the census redded
 *    the refresh PR (review r1 F1, F2).
 *  - #5325 round 2 held them in a table that rewrote a run date every night
 *    (36 flips over two identical nights, so the refresh never landed
 *    flip-free) and dropped a held row the night its server was absent, with
 *    nothing moving a row on to the curated table (verify r2 F12, F13).
 *
 * Input: recorded run 42149703889 (characterize rows and provenance, the
 * clean-signal report rows) merged into the recorded matrix
 * `matrix-before-4338.md`, with the server set from the real registry and
 * fixtures, through the same calls the two nightly scripts make.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { LSP_SERVERS } from "../../clients/lsp/server.js";
import {
	buildMatrixObservations,
	resolveTargetLangRows,
} from "../../scripts/lib/clean-signal.mjs";
import { probePopulation } from "../../scripts/lib/lsp-idle-eviction-probe.mjs";
import {
	HELD_ROWS_MARKER,
	mergeCharacterization,
	parseTable,
	refreshCapabilityMatrix,
} from "../../scripts/lib/md-matrix.mjs";
import { listRefreshFlips } from "../../scripts/lib/refresh-flips.mjs";
import { LSP_FIXTURES } from "../../scripts/smoke-tools.mjs";
import { stripSource } from "../support/sweep-kit.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const MATRIX_DOC = "docs/lsp-capability-matrix.md";
const MARKER = "| lang | server |";
const BASE = read("tests/fixtures/lsp-nightly/matrix-before-4338.md");
const RUN = JSON.parse(read("tests/fixtures/lsp-nightly/42149703889.json"));

// The same expression characterize-lsp.mjs passes as `serverLangs`.
const SERVER_LANGS = probePopulation(LSP_SERVERS, LSP_FIXTURES).flatMap(
	({ fixture }) => (fixture ? [fixture.lang] : []),
);

type Run = { rows: any[]; provenance: Map<string, any>; clean: any[] };
const recorded = (absent: string[] = []): Run => ({
	rows: RUN.characterize.rows.filter((r: any) => !absent.includes(r.lang)),
	provenance: new Map(
		Object.entries(RUN.characterize.provenance).filter(
			([lang]) => !absent.includes(lang),
		),
	),
	clean: RUN.cleanSignal.rows.filter((r: any) => !absent.includes(r.lang)),
});

function characterize(
	doc: string,
	run: Run,
	day: string,
	extra: { probedLangs?: string[] } = {},
) {
	return mergeCharacterization(doc, run.rows, run.provenance, "ci", undefined, {
		serverLangs: SERVER_LANGS,
		now: day,
		...extra,
	})!;
}

/** One nightly: characterize-lsp's merge, then probe-clean-signal's refresh. */
function night(doc: string, run: Run, day: string): string {
	const merged = characterize(doc, run, day).text;
	return refreshCapabilityMatrix(
		merged,
		buildMatrixObservations(resolveTargetLangRows(run.clean)),
		{ src: "ci", now: day },
	).text;
}

function held(text: string): Map<string, Record<string, string>> {
	const tbl = parseTable(text, HELD_ROWS_MARKER);
	const out = new Map<string, Record<string, string>>();
	for (const cells of tbl?.rows ?? [])
		out.set(
			cells[0],
			Object.fromEntries(tbl!.header.map((name, i) => [name, cells[i]])),
		);
	return out;
}

function curated(text: string): Map<string, Record<string, string>> {
	const tbl = parseTable(text, MARKER)!;
	return new Map(
		tbl.rows.map((cells) => [
			cells[0],
			Object.fromEntries(tbl.header.map((name, i) => [name, cells[i]])),
		]),
	);
}

const flips = (a: string, b: string) =>
	listRefreshFlips({ [MATRIX_DOC]: a }, { [MATRIX_DOC]: b });

const PUSH_NEW = [
	"cmake",
	"cpp",
	"expert",
	"fallow",
	"fish",
	"fsharp",
	"go",
	"kotlin",
	"powershell",
	"typos",
	"typst",
	"zizmor",
];
const VARIANTS = [
	"ast-grep-baseline",
	"effect-tsgo",
	"java-lombok",
	"lua-custom-provenance",
	"typescript-clean",
	"typescript-nested-root-markers",
	"typescript7",
	"typescript7-clean",
];

describe("#5323 matrix rows for every measured server (run 42149703889)", () => {
	// characterize-lsp.mjs runs on load and spawns servers, so its wiring is
	// pinned on comment-and-string-blanked source: the merge gets the server set
	// this file uses. Without it the merge adds no row (fail closed), which is
	// the D3 defect again.
	it("hands the characterize merge the registry server set (#5323)", () => {
		const blanked = stripSource(read("scripts/characterize-lsp.mjs"));
		expect(blanked).toMatch(
			/const serverLangs = probePopulation\(LSP_SERVERS, LSP_FIXTURES\)\.flatMap\(/,
		);
		expect(blanked).toMatch(
			/mergeCharacterization\(\s*text,\s*measuredRows,\s*provenance,\s*src,\s*undefined,\s*\{\s*serverLangs,/,
		);
	});

	it("holds every new push server, adds no curated row, and makes no variant a row", () => {
		const night1 = characterize(BASE, recorded(), RUN.date).text;
		expect([...held(night1).keys()].sort()).toEqual(PUSH_NEW);
		// The curated table, the census's whole population, gains nothing yet.
		expect([...curated(night1).keys()]).toEqual([...curated(BASE).keys()]);
		const anyRow = new Set([...held(night1).keys(), ...curated(night1).keys()]);
		// Variants measured a mode (and some a provenance line) and still have no row.
		expect(VARIANTS.filter((lang) => anyRow.has(lang))).toEqual([]);
		// A server the run did not measure has no row either.
		const unmeasured = RUN.characterize.rows
			.filter((r: any) => r.mode === "unknown")
			.map((r: any) => r.lang);
		expect(unmeasured.length).toBeGreaterThan(0);
		expect(unmeasured.filter((lang: string) => anyRow.has(lang))).toEqual([]);
		// Every server lang the run measured has a row in one table or the other.
		const measured = RUN.characterize.rows
			.filter((r: any) => r.mode === "pull" || r.mode === "push-only")
			.map((r: any) => r.lang)
			.filter((lang: string) => SERVER_LANGS.includes(lang));
		expect(measured.filter((lang: string) => !anyRow.has(lang))).toEqual([]);
		expect(held(night1).get("go")).toEqual({
			lang: "go",
			mode: "push-only",
			server: "gopls",
			src: "ci",
			version: "—",
			install: "—",
			stale: "—",
		});
		expect(held(night1).get("fish")?.version).toBe("1.1.5");
	});

	it("rewrites nothing on a night that measures the same thing again (F12)", () => {
		const first = characterize(BASE, recorded(), "2026-11-06").text;
		const second = characterize(first, recorded(), "2026-11-07").text;
		expect(second).toBe(first);
		// Through both nightly writers: night 2 commits the hysteresis (the
		// promotions below), and a third identical night is flip-free.
		const n1 = night(BASE, recorded(), "2026-11-06");
		const n2 = night(n1, recorded(), "2026-11-07");
		const n3 = night(n2, recorded(), "2026-11-08");
		expect(flips(n2, n3)).toEqual([]);
	});

	it("keeps a held row its server's run did not measure, stale from the first missed night (F13)", () => {
		const n1 = characterize(BASE, recorded(), "2026-11-06").text;
		const n2 = characterize(n1, recorded(["cmake", "go"]), "2026-11-07").text;
		const n3 = characterize(n2, recorded(["cmake", "go"]), "2026-11-08").text;
		expect(held(n2).get("cmake")?.stale).toBe("since 2026-11-07");
		expect(held(n3).get("go")?.stale).toBe("since 2026-11-07");
		expect(held(n3).get("fsharp")?.stale).toBe("—");
		// The stale stamp is bookkeeping, as in the curated table: no flip.
		expect(flips(n1, n3)).toEqual([]);
		const back = characterize(n3, recorded(), "2026-11-09").text;
		expect(held(back).get("go")?.stale).toBe("—");
		// A subset run says nothing about the servers it did not run.
		const subset = characterize(n1, recorded(), "2026-11-07", {
			probedLangs: ["kotlin"],
		}).text;
		expect(
			[...held(subset).values()].filter((row) => row.stale !== "—"),
		).toEqual([]);
	});

	it("moves a held row to the curated matrix the night its clean-behavior commits (F13)", () => {
		const n1 = night(BASE, recorded(), "2026-11-06");
		// One observation is pending, as for a curated `unknown` cell.
		expect(held(n1).has("go")).toBe(true);
		expect(curated(n1).has("go")).toBe(false);
		const n2 = night(n1, recorded(), "2026-11-07");
		expect(held(n2).has("go")).toBe(false);
		expect(curated(n2).get("go")).toMatchObject({
			server: "gopls",
			mode: "push-only",
			"clean-behavior": "publishes-versioned",
			"first-publish": "direct",
			tier: "2",
			stale: "—",
		});
		// A server the probe never classified stays held.
		expect([...held(n2).keys()].sort()).toEqual(["cmake", "fsharp"]);
	});
});
