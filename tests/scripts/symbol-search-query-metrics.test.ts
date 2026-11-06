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
		// file:/ext: population: the file: and ext: listings; the lang: miss is
		// structured scope, not in emptyRate.
		expect(window.emptyRate.numerator).toBe(0);
		expect(window.emptyRate.denominator).toBe(2);
		expect(window.emptyRate.excluded).toBe(2);
		expect(window.structuredScoped).toEqual({
			classified: 1,
			empty: 1,
			error: 0,
		});
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
		// listed file (a listed read, no repeat). Three reads follow the first
		// listing, one of them a repeat.
		const window = windowFor("repeat-read.jsonl");
		expect(window.results.listing).toBe(2);
		expect(window.listedReadRate.numerator).toBe(1);
		expect(window.listedReadRate.denominator).toBe(2);
		expect(window.repeatReadRate.numerator).toBe(1);
		expect(window.repeatReadRate.denominator).toBe(3);
		expect(window.repeatReadRate.rate).toBeCloseTo(1 / 3);
	});

	it("does not count a first read of a listed file as a repeat read", () => {
		const window = windowFor("re-read.jsonl");
		expect(window.listedReadRate.numerator).toBe(1);
		expect(window.repeatReadRate.numerator).toBe(0);
		expect(window.repeatReadRate.denominator).toBe(2);
	});

	it("counts reads, not listings: one listing and three reads with one repeat is 1/3", () => {
		// Recurrence: the maintainer decision of 2026-11-06 on #5355. The listing
		// unit scored this session 1/1 and tended to 1.0 in long sessions, because
		// one late repeat made every earlier listing count. The per-read unit
		// stays comparable across session lengths.
		const window = windowFor("repeat-three-reads.jsonl");
		expect(window.results.listing).toBe(1);
		expect(window.repeatReadRate.numerator).toBe(1);
		expect(window.repeatReadRate.denominator).toBe(3);
		expect(window.repeatReadRate.rate).toBeCloseTo(1 / 3);
	});

	it("counts a repeat read many calls after the listing, with no window", () => {
		// Recurrence: #5355 r1 counted a repeat read only within three calls of a
		// listing, so a re-read later in the session scored 0. The maintainer
		// decided on 2026-11-06 that any second read of a file the session already
		// read counts. repeat-late.jsonl re-reads its file as the tenth call after
		// the listing: two reads follow the listing, the second a repeat.
		const window = windowFor("repeat-late.jsonl");
		expect(window.results.listing).toBe(1);
		expect(window.repeatReadRate.numerator).toBe(1);
		expect(window.repeatReadRate.denominator).toBe(2);
	});

	it("never counts a first read, or a read of a different file, as a repeat", () => {
		// Recurrence: the repeat check keys on the exact resolved path (#5355 r1
		// D8). A check that counted any earlier read would score every read after
		// a session's first as a repeat. no-repeat.jsonl reads the listed file
		// for the first time, then two other files, each for the first time.
		const window = windowFor("no-repeat.jsonl");
		expect(window.results.listing).toBe(1);
		expect(window.listedReadRate.numerator).toBe(1);
		expect(window.repeatReadRate.numerator).toBe(0);
		expect(window.repeatReadRate.denominator).toBe(3);
	});

	it("does not count a repeat read that comes before the listing", () => {
		// Recurrence: reads before the first listing are in neither repeatReadRate
		// count. With no window, a repeat anywhere in the session would otherwise
		// count. repeat-before-listing.jsonl repeats a read before its listing;
		// the one read after the listing is a first read of a different file.
		const window = windowFor("repeat-before-listing.jsonl");
		expect(window.results.listing).toBe(1);
		expect(window.repeatReadRate.numerator).toBe(0);
		expect(window.repeatReadRate.denominator).toBe(1);
	});

	it("counts an isError result as an error; a lang-only miss is not in emptyRate", () => {
		// Recurrence: D9 turns silent empties into errors; the isError arm of
		// classifyResult had no cell (the old unit case matched the text arm).
		// error.jsonl is a structured `lang` scope, so it is outside D8's
		// file:/ext: population and counted in structuredScoped.
		const window = windowFor("error.jsonl");
		expect(window.results.error).toBe(1);
		expect(window.results.unknown).toBe(0);
		expect(window.emptyRate.denominator).toBe(0);
		expect(window.structuredScoped).toEqual({
			classified: 1,
			empty: 0,
			error: 1,
		});
	});

	it("reports emptyRate over inline file:/ext: queries only and counts paths/lang misses apart", () => {
		// Recurrence: #5355 r1 F2. isScoped counted any `paths`, any `lang` and
		// inline `lang:`, so the review's census read 4/17 where D8's file:/ext:
		// population read 0/1. scope-census.jsonl: ext: empty, file: listing,
		// then a paths, a lang and an inline lang: miss, and an unscoped miss.
		const window = windowFor("scope-census.jsonl");
		expect(window.results.empty).toBe(5);
		expect(window.emptyRate.numerator).toBe(1);
		expect(window.emptyRate.denominator).toBe(2);
		expect(window.structuredScoped).toEqual({
			classified: 3,
			empty: 3,
			error: 0,
		});
		const summary = formatSummary(
			buildReport(path.join(FIXTURES, "scope-census.jsonl"), [ALL]),
		);
		expect(summary).toContain("structuredScoped=empty 3 error 0 of 3");
	});

	it("keeps a scoped call that ends in an error in emptyRate's denominator", () => {
		// Recurrence: #5355 r1 F3. D2 and D9 turn silent empties into loud
		// errors; the error left the denominator, so the rate fell (2/2 became
		// 0/1) while the model still got no answer. scoped-error.jsonl: an ext:
		// miss and an ext: query with a bad lang that errored.
		const window = windowFor("scoped-error.jsonl");
		expect(window.results.error).toBe(1);
		expect(window.emptyRate.numerator).toBe(1);
		expect(window.emptyRate.denominator).toBe(2);
		expect(window.scopedError).toBe(1);
		const summary = formatSummary(
			buildReport(path.join(FIXTURES, "scoped-error.jsonl"), [ALL]),
		);
		expect(summary).toContain("emptyRate=1/2(excluded=0) 0.500 scopedError=1");
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

	// Recurrence: #5355 r1 F4. The regex detector dropped ten real spellings
	// without a count (alias, destructure, computed key, optional chain, .call,
	// another receiver, an interpolated call, a regex literal holding a quote).
	// The gate admits `tools.symbol_search(` and `globalThis.tools.symbol_search(`
	// called with a static object, and every other occurrence of the identifier
	// is unscannable. The 25 spellings are the review's table.
	const U = { unscannable: true };
	const S = { unscannable: false, args: { query: "ext:ts a" } };
	const FORMS: Array<[string, string, unknown[]]> = [
		[
			"literal",
			'return await tools.symbol_search({ query: "ext:ts a" });',
			[S],
		],
		["comment", '// tools.symbol_search({query:"ext:ts a"})\nreturn 1;', []],
		["string", 'const s = "tools.symbol_search({query: 1})"; return s;', []],
		["template text", 'return `tools.symbol_search({ query: "x" })`;', []],
		[
			"template interpolation",
			'return `${await tools.symbol_search({ query: "ext:ts a" })}`;',
			[S],
		],
		[
			"alias",
			'const s = tools.symbol_search; return await s({ query: "ext:ts a" });',
			[U],
		],
		[
			"destructure",
			'const { symbol_search } = tools; return await symbol_search({ query: "ext:ts a" });',
			[U, U],
		],
		[
			"computed string key",
			'return await tools["symbol_search"]({ query: "ext:ts a" });',
			[U],
		],
		[
			"computed template key",
			'return await tools[`symbol_search`]({ query: "ext:ts a" });',
			[U],
		],
		[
			"optional chain",
			'return await tools?.symbol_search({ query: "ext:ts a" });',
			[U],
		],
		[
			"call form",
			'return await tools.symbol_search.call(null, { query: "ext:ts a" });',
			[U],
		],
		[
			"other receiver",
			'const subtools = {symbol_search: async()=>1}; return await subtools.symbol_search({ query: "ext:ts a" });',
			[U, U],
		],
		[
			"regex literal with a quote",
			'const re = /"/; return await tools.symbol_search({ query: "ext:ts a" });',
			[S],
		],
		[
			"regex literal with an apostrophe",
			'const re = /\'/g; return await tools.symbol_search({ query: "ext:ts a" });',
			[S],
		],
		[
			"non-literal argument",
			'const o = { query: "ext:ts a" }; return await tools.symbol_search(o);',
			[U],
		],
		[
			"spread inside the literal",
			'return await tools.symbol_search({ ...{query:"ext:ts a"} });',
			[U],
		],
		[
			"trailing comma after the argument",
			'return await tools.symbol_search({ query: "ext:ts a" },);',
			[S],
		],
		[
			"concatenated query",
			'return await tools.symbol_search({ query: "ext:" + "ts a" });',
			[U],
		],
		[
			"comment holding a paren inside the argument",
			'return await tools.symbol_search({ query: "ext:ts a" /* ) */ });',
			[S],
		],
		[
			"pilens_ name",
			'return await tools.pilens_symbol_search({ query: "ext:ts a" });',
			[U],
		],
		[
			"mcp receiver",
			'return await mcp.pilens_symbol_search({ query: "ext:ts a" });',
			[U],
		],
		[
			"arrow wrapper",
			'const f = (a) => tools.symbol_search(a); return await f({query:"ext:ts a"});',
			[U],
		],
		[
			"apostrophe in a comment before the call",
			'// it\'s a comment\nreturn await tools.symbol_search({ query: "ext:ts a" });',
			[S],
		],
		[
			"receiver bound to a variable",
			'const t = tools; return await t.symbol_search({ query: "ext:ts a" });',
			[U],
		],
		[
			"globalThis receiver",
			'return await globalThis.tools.symbol_search({ query: "ext:ts a" });',
			[S],
		],
	];

	it.each(FORMS)("codemode form: %s", (_name, script, expected) => {
		expect(findCodemodeSymbolSearchArgs(script)).toEqual(expected);
	});

	it("does not read a symbol_search-suffixed or -prefixed name as the tool", () => {
		expect(
			findCodemodeSymbolSearchArgs(
				"tools.mysymbol_search({ a: 1 }); tools.symbol_searcher({ a: 1 });",
			),
		).toEqual([]);
	});

	it("treats a script that does not parse as unscannable once per token", () => {
		// A script the parser rejects cannot be read, so no occurrence may be
		// dropped: two tokens, two unscannable entries (a comment's token too).
		expect(
			findCodemodeSymbolSearchArgs(
				'const q = ;\n// symbol_search\nawait tools.symbol_search({ query: "ext:ts a" });',
			),
		).toEqual([U, U]);
		expect(findCodemodeSymbolSearchArgs("const q = ;")).toEqual([]);
	});

	it("counts every dropped spelling as unscannable through buildReport", () => {
		// One codemode row per form; the result text is irrelevant to scanning.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ssqm-forms-"));
		try {
			const rows: string[] = [
				JSON.stringify({
					type: "session",
					cwd: "/work",
					timestamp: "2026-11-01T00:00:00Z",
				}),
			];
			FORMS.forEach(([, script], index) => {
				const id = `f${index}`;
				const at = `2026-11-01T00:00:${String(index).padStart(2, "0")}Z`;
				rows.push(
					JSON.stringify({
						type: "message",
						timestamp: at,
						message: {
							role: "assistant",
							content: [
								{
									type: "toolCall",
									id,
									name: "codemode",
									arguments: { code: script },
								},
							],
						},
					}),
					JSON.stringify({
						type: "message",
						timestamp: at,
						message: {
							role: "toolResult",
							toolCallId: id,
							toolName: "codemode",
							content: [
								{ type: "text", text: "Script completed\nOutput:\nnull" },
							],
							isError: false,
						},
					}),
				);
			});
			fs.writeFileSync(path.join(dir, "forms.jsonl"), `${rows.join("\n")}\n`);
			const window = buildReport(dir, [ALL]).windows[0];
			const noCall = FORMS.filter(
				([, , expected]) => expected.length === 0,
			).length;
			const withUnscannable = FORMS.filter(([, , expected]) =>
				expected.some(
					(entry) => (entry as { unscannable: boolean }).unscannable,
				),
			).length;
			expect(window.calls.discovered).toBe(FORMS.length - noCall);
			expect(window.calls.unscannable).toBe(withUnscannable);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
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
