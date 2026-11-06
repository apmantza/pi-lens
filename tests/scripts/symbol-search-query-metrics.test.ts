import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
	bashViewPaths,
	buildReport,
	classifyResult,
	defaultWindows,
	extractListedPaths,
	extractStaticObject,
	findCodemodeSymbolSearchArgs,
	formatSummary,
	main,
	parseArgs,
} from "../../scripts/symbol-search-query-metrics.mjs";

const FIXTURES = path.resolve(
	import.meta.dirname,
	"../fixtures/symbol-search-transcripts",
);

const ALL = { label: "all", since: null, until: null };

function windowFor(fixture: string) {
	return buildReport(path.join(FIXTURES, fixture), [ALL]).windows[0];
}

describe("symbol_search query metrics — fixture corpus", () => {
	it("counts native, alias and literal codemode calls and buckets the dynamic one", () => {
		const window = windowFor("basic.jsonl");
		expect(window.calls.discovered).toBe(4);
		expect(window.calls.scanned).toBe(3);
		expect(window.calls.unscannable).toBe(1);
		expect(window.calls.unpaired).toBe(0);
		expect(window.results.listing).toBe(2);
		expect(window.results.empty).toBe(1);
		expect(window.results.error).toBe(0);
		expect(window.results.unknown).toBe(0);
		expect(window.emptyRate.numerator).toBe(1);
		expect(window.emptyRate.denominator).toBe(3);
		expect(window.emptyRate.excluded).toBe(1);
		expect(window.emptyRate.rate).toBeCloseTo(1 / 3);
		expect(window.unscannableRate.numerator).toBe(1);
		expect(window.unscannableRate.denominator).toBe(4);
		expect(window.unscannableRate.excluded).toBe(0);
	});

	it("counts a listed-path read within three tool calls and not one at the fourth", () => {
		const window = windowFor("re-read.jsonl");
		expect(window.results.listing).toBe(2);
		expect(window.listedReadRate.numerator).toBe(1);
		expect(window.listedReadRate.denominator).toBe(2);
		expect(window.listedReadRate.excluded).toBe(0);
		expect(window.listedReadRate.rate).toBeCloseTo(0.5);
	});

	it("counts a bash view of a listed path but not a grep of it", () => {
		const window = windowFor("bash-view.jsonl");
		expect(window.results.listing).toBe(1);
		expect(window.listedReadRate.numerator).toBe(1);
		expect(window.listedReadRate.denominator).toBe(1);
	});

	it("reports an unpaired call and excludes it from both rates", () => {
		const window = windowFor("unpaired.jsonl");
		expect(window.calls.discovered).toBe(2);
		expect(window.calls.unpaired).toBe(1);
		expect(window.results.empty).toBe(1);
		expect(window.emptyRate.numerator).toBe(1);
		expect(window.emptyRate.denominator).toBe(1);
		expect(window.listedReadRate.denominator).toBe(0);
		expect(window.listedReadRate.numerator).toBe(0);
	});

	it("ignores a symbol_search spelling inside a comment or a string", () => {
		const window = windowFor("comment.jsonl");
		expect(window.calls.discovered).toBe(0);
		expect(window.calls.scanned).toBe(0);
	});

	it("counts a multi-search codemode script once against its one result blob", () => {
		const window = windowFor("two-search.jsonl");
		expect(window.calls.discovered).toBe(1);
		expect(window.results.listing).toBe(1);
		expect(window.listedReadRate.denominator).toBe(1);
	});

	it("counts a read of the top hit of a listing the real renderer printed", () => {
		// Recurrence: #5104 changed the row to `path line (score ...)`; the parser
		// returned "clients/a.ts 42" and every listed read read as 0. The fixture's
		// result text comes from renderCompactSymbolSearch, and its read sends the
		// real tool's `path` argument.
		const window = windowFor("real-renderer.jsonl");
		expect(window.results.listing).toBe(1);
		expect(window.listedReadRate.numerator).toBe(1);
		expect(window.listedReadRate.denominator).toBe(1);
	});

	it("reports a listed read and a repeat read separately", () => {
		// repeat-read.jsonl: listing 1 is followed by two reads of an unlisted
		// file (a repeat, no listed read); listing 2 by a first read of its
		// listed file (a listed read, no repeat).
		const window = windowFor("repeat-read.jsonl");
		expect(window.results.listing).toBe(2);
		expect(window.listedReadRate.numerator).toBe(1);
		expect(window.listedReadRate.denominator).toBe(2);
		expect(window.repeatReadRate.numerator).toBe(1);
		expect(window.repeatReadRate.denominator).toBe(2);
		expect(window.repeatReadRate.rate).toBeCloseTo(0.5);
	});

	it("does not count a first read of a listed file as a repeat read", () => {
		const window = windowFor("re-read.jsonl");
		expect(window.listedReadRate.numerator).toBe(1);
		expect(window.repeatReadRate.numerator).toBe(0);
		expect(window.repeatReadRate.denominator).toBe(2);
	});

	it("counts a repeat read within three tool calls and not one at the fourth", () => {
		// Recurrence: the repeat-read window must match the listed-read window;
		// repeat-late.jsonl repeats a read as the fourth call after the listing.
		const window = windowFor("repeat-late.jsonl");
		expect(window.results.listing).toBe(1);
		expect(window.repeatReadRate.numerator).toBe(0);
		expect(window.repeatReadRate.denominator).toBe(1);
	});

	it("counts an isError result as an error, outside the empty-rate denominator", () => {
		// Recurrence: D9 turns silent empties into errors; the isError arm of
		// classifyResult had no cell (the old unit case matched the text arm).
		const window = windowFor("error.jsonl");
		expect(window.results.error).toBe(1);
		expect(window.results.unknown).toBe(0);
		expect(window.emptyRate.denominator).toBe(0);
	});

	it("includes rows exactly on the --since and --until instants", () => {
		// Recurrence: the docblock says both bounds are inclusive; `<=`/`>=` in
		// inWindow dropped the call row or the result row and no cell noticed.
		const window = buildReport(path.join(FIXTURES, "windows.jsonl"), [
			{
				label: "edge",
				since: "2026-11-04T22:20:00.000Z",
				until: "2026-11-04T22:20:00.100Z",
			},
		]).windows[0];
		expect(window.calls.discovered).toBe(1);
		expect(window.calls.unpaired).toBe(0);
		expect(window.results.empty).toBe(1);
	});

	it("skips the subagent-artifacts envelope file and says so", () => {
		// Recurrence: an envelope file (first row has no `type`) holds
		// symbol_search traffic that is not a session; counting it inflates
		// every denominator.
		const report = buildReport(path.join(FIXTURES, "envelope.jsonl"), [ALL]);
		expect(report.windows[0].calls.discovered).toBe(0);
		expect(report.files).toEqual({ read: 1, skipped: 1 });
	});

	it("counts a module_report follow-up as a drilldown, not a re-read", () => {
		const window = windowFor("drilldown.jsonl");
		expect(window.results.listing).toBe(1);
		expect(window.drilldownRate.numerator).toBe(1);
		expect(window.drilldownRate.denominator).toBe(1);
		expect(window.listedReadRate.numerator).toBe(0);
	});

	it("keeps pairing when a bounded window covers the fixture", () => {
		const window = buildReport(path.join(FIXTURES, "basic.jsonl"), [
			{
				label: "covered",
				since: "2026-11-01T00:00:00.000Z",
				until: "2026-11-01T00:01:00.000Z",
			},
		]).windows[0];
		expect(window.calls.discovered).toBe(4);
		expect(window.calls.unpaired).toBe(0);
	});

	it("cuts rows to the --since/--until window and prints both bounds", () => {
		const bracket = [
			{
				label: "bracket",
				since: "2026-11-04T22:13:00Z",
				until: "2026-11-04T22:38:00Z",
			},
		];
		const report = buildReport(path.join(FIXTURES, "windows.jsonl"), bracket);
		const window = report.windows[0];
		expect(window.calls.discovered).toBe(1);
		expect(window.results.empty).toBe(1);
		const summary = formatSummary(report);
		expect(summary).toContain("since=2026-11-04T22:13:00Z");
		expect(summary).toContain("until=2026-11-04T22:38:00Z");
	});

	it("counts only rows after --since and only rows before --until", () => {
		const after = buildReport(path.join(FIXTURES, "windows.jsonl"), [
			{ label: "after", since: "2026-11-04T22:13:00Z", until: null },
		]).windows[0];
		expect(after.calls.discovered).toBe(2);
		const before = buildReport(path.join(FIXTURES, "windows.jsonl"), [
			{ label: "before", since: null, until: "2026-11-04T22:13:00Z" },
		]).windows[0];
		expect(before.calls.discovered).toBe(1);
		expect(before.results.listing).toBe(1);
	});

	it("prints one summary line per default window", () => {
		const report = buildReport(
			FIXTURES,
			defaultWindows(new Date("2026-11-05T12:00:00Z")),
		);
		expect(report.windows).toHaveLength(5);
		const summary = formatSummary(report);
		const lines = summary
			.trim()
			.split("\n")
			.filter((line) => line.startsWith("window "));
		expect(lines).toHaveLength(5);
	});
});

describe("symbol_search query metrics — parsers", () => {
	it("reads a static object literal and refuses a dynamic argument", () => {
		expect(extractStaticObject('{ query: "auth", limit: 5 }')).toEqual({
			query: "auth",
			limit: 5,
		});
		expect(
			extractStaticObject("{ paths: ['a/b.ts'], lang: 'typescript' }"),
		).toEqual({ paths: ["a/b.ts"], lang: "typescript" });
		expect(extractStaticObject("{ query: q }")).toBeUndefined();
		expect(extractStaticObject("buildQuery()")).toBeUndefined();
		expect(extractStaticObject("{ query: `${q}` }")).toBeUndefined();
	});

	it("finds codemode symbol_search calls with readable arguments", () => {
		expect(
			findCodemodeSymbolSearchArgs(
				'const r = await tools.symbol_search({ query: "ext:ts" });\nreturn r;',
			),
		).toEqual([{ unscannable: false, args: { query: "ext:ts" } }]);
		expect(
			findCodemodeSymbolSearchArgs(
				"return await tools.symbol_search({ query: q });",
			),
		).toEqual([{ unscannable: true }]);
		expect(findCodemodeSymbolSearchArgs("return 1;")).toEqual([]);
		expect(
			findCodemodeSymbolSearchArgs(
				'// tools.symbol_search({ query: "commented" })\nreturn 1;',
			),
		).toEqual([]);
		expect(
			findCodemodeSymbolSearchArgs(
				'const a = await tools.symbol_search({ query: "x" });\nconst b = await tools.symbol_search({ query: "y" });',
			),
		).toHaveLength(2);
	});

	it("classifies an isError result whose text names no known error", () => {
		expect(classifyResult("boom", true)).toBe("error");
		expect(classifyResult("boom", false)).toBe("unknown");
	});

	it("reads a static object and array with trailing commas", () => {
		// Recurrence: model-written scripts end object and array literals with a
		// comma; the parser marked those calls unscannable.
		expect(extractStaticObject('{ query: "ext:ts a", }')).toEqual({
			query: "ext:ts a",
		});
		expect(extractStaticObject("{ paths: ['a.ts',], limit: 5,\n}")).toEqual({
			paths: ["a.ts"],
			limit: 5,
		});
		expect(
			findCodemodeSymbolSearchArgs(
				'await tools.symbol_search({\n  query: "ext:ts a",\n  limit: 5,\n});',
			),
		).toEqual([{ unscannable: false, args: { query: "ext:ts a", limit: 5 } }]);
		expect(extractStaticObject("{ query: q, }")).toBeUndefined();
		expect(extractStaticObject("{ , }")).toBeUndefined();
	});

	it("classifies listing, empty, error and unknown results", () => {
		expect(
			classifyResult(
				'Top 1 file(s) for "x":\n  1. a.ts (score 2.00, 1 hit(s), line 1)',
			),
		).toBe("listing");
		expect(classifyResult('No files matched "x".\nIndex covers 1 files.')).toBe(
			"empty",
		);
		expect(classifyResult("Word index is building", true)).toBe("error");
		expect(classifyResult("something else entirely")).toBe("unknown");
	});

	it("extracts listed paths from the JSON line and from the numbered rows", () => {
		const withJson =
			'Top 1 file(s) for "x":\n  1. a.ts (score 2.00, 1 hit(s), line 1)\n\n{"available":true,"results":[{"file":"a.ts"}]}';
		expect(extractListedPaths(withJson)).toEqual(["a.ts"]);
		const withoutJson =
			'Top 2 file(s) for "x":\n  1. a.ts (score 2.00, 1 hit(s), line 1)\n  2. b.ts (score 1.00, 1 hit(s), line 1)';
		expect(extractListedPaths(withoutJson)).toEqual(["a.ts", "b.ts"]);
	});

	it("extracts the path from the renderer row `path line (score ...)`", () => {
		const current =
			'Top 2 file(s) for "x":\n  1. clients/a.ts 42 (score 2.00, 3 hit(s), fanIn 4)\n  2. my dir/b 2.ts 7 (score 1.00, 1 hit(s))';
		expect(extractListedPaths(current)).toEqual([
			"clients/a.ts",
			"my dir/b 2.ts",
		]);
	});

	it("detects bash file views and ignores searches and in-place edits", () => {
		expect(bashViewPaths("cat clients/a.ts")).toEqual(["clients/a.ts"]);
		expect(bashViewPaths("sed -n '1,20p' clients/a.ts")).toEqual([
			"clients/a.ts",
		]);
		expect(bashViewPaths("grep -n foo clients/a.ts")).toEqual([]);
		expect(bashViewPaths("sed -i 's/a/b/' clients/a.ts")).toEqual([]);
	});

	it("rejects an unknown option and validates an instant", () => {
		expect(() => parseArgs(["--entry-gate-cell-probe"])).toThrow(
			/unknown option/,
		);
		expect(() => parseArgs(["--since", "not-a-date"])).toThrow(/ISO-8601/);
		expect(parseArgs(["--since", "2026-11-04T22:13:00Z"])).toMatchObject({
			since: "2026-11-04T22:13:00Z",
		});
	});

	it("prints n/a for a rate with a zero denominator and defines each rate", () => {
		// Recurrence: a zero denominator printed rate 0, which reads as a perfect
		// rate in a before/after diff.
		const report = buildReport(path.join(FIXTURES, "unpaired.jsonl"), [ALL]);
		expect(report.windows[0].listedReadRate.denominator).toBe(0);
		expect(report.windows[0].listedReadRate.rate).toBeNull();
		const summary = formatSummary(report);
		expect(summary).toContain("listedReadRate=0/0(excluded=2) n/a");
		for (const rate of [
			"emptyRate",
			"listedReadRate",
			"repeatReadRate",
			"drilldownRate",
			"unscannableRate",
		]) {
			expect(summary).toMatch(new RegExp(`^  ${rate} = `, "m"));
		}
	});

	it("names the five default windows and their bounds", () => {
		const windows = defaultWindows(new Date("2026-11-05T12:00:00Z"));
		expect(windows.map((window) => window.label)).toEqual([
			"all",
			"until-2026-11-04T22:13:00Z",
			"2026-11-04T22:13:00Z..2026-11-04T22:38:00Z",
			"since-2026-11-04T22:38:00Z",
			"today",
		]);
		expect(windows[4].since).toBe("2026-11-05T00:00:00.000Z");
	});
});

describe("symbol_search query metrics — corpus failures", () => {
	// Recurrence: an empty directory exited 0 with all-zero windows, which reads
	// as a clean after-window. A missing directory died with a raw ENOENT.
	function runMain(argv: string[]) {
		const written: string[] = [];
		const spy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation((chunk: string | Uint8Array) => {
				written.push(String(chunk));
				return true;
			});
		try {
			return { code: main(argv), stderr: written.join("") };
		} finally {
			spy.mockRestore();
		}
	}

	it("exits non-zero and prints a zero file count for an empty directory", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ssqm-empty-"));
		try {
			const { code, stderr } = runMain([dir]);
			expect(code).toBe(1);
			expect(stderr).toMatch(/no session files under .*\(0 files read\)/);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("exits non-zero with the same message for a missing directory", () => {
		const dir = path.join(os.tmpdir(), "pi-lens-ssqm-absent-corpus-dir");
		const { code, stderr } = runMain([dir]);
		expect(code).toBe(1);
		expect(stderr).toMatch(/does not exist: .*\(0 files read\)/);
	});
});
