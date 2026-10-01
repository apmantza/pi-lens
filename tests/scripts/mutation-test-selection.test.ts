import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildCoverageProbeArgs,
	buildFingerprint,
	coveredChangedLines,
	coveredChangedLinesInReport,
	decideIncrementalReuse,
	fingerprintEntries,
	fingerprintPaths,
	INCREMENTAL_FINGERPRINT_PATH,
	PROBE_REPORTS_ROOT,
	probeReportsDirectory,
	ownTestFiles,
	partitionOwnTests,
	probeConcurrency,
	parseIncrementalReuse,
	probeAllTests,
	probeTestCoverage,
	pruneIncrementalReport,
	selectMutationTests,
} from "../../scripts/lib/mutation-test-selection.mjs";

// Coverage-based test selection and the incremental-cache rules of the mutation
// diff lane (#3810). The old selector kept the first 47 related tests by path:
// on PR #3794 it dropped all three of the PR's own test files (related 72 ->
// kept 47) and the lane reported 37 false survivors. Every test here guards
// one row of the PR's failure list; the recorded fixture is the real #3794
// selection input, taken through the driver's own functions.

type Statement = { start: { line: number }; end: { line: number } };
function entryOf(
	statements: Array<{ start: number; end?: number; hits: number }>,
) {
	const statementMap: Record<string, Statement> = {};
	const s: Record<string, number> = {};
	statements.forEach((statement, index) => {
		statementMap[String(index)] = {
			start: { line: statement.start },
			end: { line: statement.end ?? statement.start },
		};
		s[String(index)] = statement.hits;
	});
	return { statementMap, s };
}

describe("coveredChangedLines", () => {
	it("counts a changed line whose statement ran and skips one whose statement never did", () => {
		// Recurrence S4/S5: selection is by executed changed lines, so the count
		// must separate a run statement from an unrun one on the same range.
		const entry = entryOf([
			{ start: 10, hits: 3 },
			{ start: 11, hits: 0 },
			{ start: 12, hits: 1 },
		]);
		expect(coveredChangedLines(entry, [[10, 12]])).toBe(2);
	});

	it("stops at both ends of the range (S6: off-by-one at either edge)", () => {
		const entry = entryOf([
			{ start: 4, hits: 1 },
			{ start: 5, hits: 1 },
			{ start: 6, hits: 1 },
			{ start: 7, hits: 1 },
		]);
		expect(coveredChangedLines(entry, [[5, 6]])).toBe(2);
		expect(coveredChangedLines(entry, [[5, 5]])).toBe(1);
		expect(coveredChangedLines(entry, [[6, 6]])).toBe(1);
	});

	it("sums separate ranges and never counts a line twice", () => {
		const entry = entryOf([
			{ start: 1, hits: 1 },
			{ start: 1, hits: 1 },
			{ start: 9, hits: 1 },
		]);
		expect(
			coveredChangedLines(entry, [
				[1, 1],
				[9, 9],
			]),
		).toBe(2);
	});

	it("does not credit an unexecuted body nested inside an executed statement (S7)", () => {
		// `const f = () => {` (line 1-5) ran; the function was never called, so
		// its own statements (2 and 3-4) did not. Crediting the outer statement's
		// span to every line would make a test that merely loads the module look
		// like it executes the function body.
		const entry = entryOf([
			{ start: 1, end: 5, hits: 1 },
			{ start: 2, hits: 0 },
			{ start: 3, end: 4, hits: 0 },
		]);
		expect(coveredChangedLines(entry, [[2, 4]])).toBe(0);
	});

	it("counts the continuation line of an executed multi-line statement and not of an unexecuted one", () => {
		// A mutant on `b` in `a &&\n b` lives on a line no statement starts on;
		// the statement that spans it decides.
		const ran = entryOf([{ start: 20, end: 21, hits: 2 }]);
		expect(coveredChangedLines(ran, [[21, 21]])).toBe(1);
		const idle = entryOf([{ start: 20, end: 21, hits: 0 }]);
		expect(coveredChangedLines(idle, [[21, 21]])).toBe(0);
	});

	it("ignores a line no statement touches (comment, type, blank)", () => {
		const entry = entryOf([{ start: 5, hits: 1 }]);
		expect(coveredChangedLines(entry, [[1, 4]])).toBe(0);
	});

	it("reads a line as executed when any statement starting on it ran", () => {
		const entry = entryOf([
			{ start: 7, hits: 0 },
			{ start: 7, hits: 4 },
		]);
		expect(coveredChangedLines(entry, [[7, 7]])).toBe(1);
	});
});

describe("coveredChangedLinesInReport", () => {
	const ranges = new Map<string, Array<[number, number]>>([
		["clients/a.ts", [[1, 2]]],
		["scripts/b.mjs", [[3, 3]]],
	]);

	it("matches repo-relative changed files against absolute report keys and sums them", () => {
		const report = {
			"/repo/clients/a.ts": entryOf([
				{ start: 1, hits: 1 },
				{ start: 2, hits: 1 },
			]),
			"/repo/scripts/b.mjs": entryOf([{ start: 3, hits: 1 }]),
			"/repo/scripts/unrelated.mjs": entryOf([{ start: 1, hits: 1 }]),
		};
		expect(coveredChangedLinesInReport(report, ranges, "/repo")).toBe(3);
	});

	it("refuses a compiled .js entry whose .ts sibling is the changed file (S13: no source map applied)", () => {
		// Recurrence S13: without `.js.map` vitest reports the compiled file under
		// its own name with compiled line numbers. Reading that as "0 changed
		// lines executed" drops every test and ends the run as a clean zero.
		const report = { "/repo/clients/a.js": entryOf([{ start: 1, hits: 1 }]) };
		expect(() => coveredChangedLinesInReport(report, ranges, "/repo")).toThrow(
			"clients/a.js is not source-mapped",
		);
	});

	it("does not mistake an unrelated .js file for an unmapped changed .ts", () => {
		const report = {
			"/repo/clients/other.js": entryOf([{ start: 1, hits: 1 }]),
		};
		expect(coveredChangedLinesInReport(report, ranges, "/repo")).toBe(0);
	});
});

describe("buildCoverageProbeArgs", () => {
	const args = buildCoverageProbeArgs(
		"tests/x.test.ts",
		["clients/a.js", "scripts/b.mjs"],
		".stryker/coverage/x",
	);

	it("attaches to spawned children (S8: a script run only through spawnSync reads 0 of 51 statements without it)", () => {
		expect(args).toContain("--coverage.autoAttachSubprocess=true");
	});

	it("names the test, every changed file and the report directory, and reports json", () => {
		expect(args).toContain("tests/x.test.ts");
		expect(args).toContain("--coverage.include=clients/a.js");
		expect(args).toContain("--coverage.include=scripts/b.mjs");
		expect(args).toContain("--coverage.reportsDirectory=.stryker/coverage/x");
		expect(args).toContain("--coverage.reporter=json");
		expect(args).toContain("--coverage.enabled");
	});
});

describe("probeTestCoverage", () => {
	const rangesByFile = new Map<string, Array<[number, number]>>([
		["scripts/b.mjs", [[1, 1]]],
	]);
	const report = {
		"/repo/scripts/b.mjs": entryOf([{ start: 1, hits: 1 }]),
	};
	const base = {
		rangesByFile,
		root: "/repo",
		readCoverage: () => report,
	};

	it("reports the covered changed lines of a passing probe", async () => {
		await expect(
			probeTestCoverage("t", {
				...base,
				run: async () => ({ status: 0 }),
			}),
		).resolves.toEqual({ lines: 1 });
	});

	it("reads a passing probe that wrote no coverage file as 0 lines, not as unknown", async () => {
		// vitest writes no entry for a file the test never loaded.
		await expect(
			probeTestCoverage("t", {
				...base,
				readCoverage: () => null,
				run: async () => ({ status: 0 }),
			}),
		).resolves.toEqual({ lines: 0 });
	});

	it("reports a failed probe as unknown, never as 0 (S9: a flaky probe must not drop a test)", async () => {
		await expect(
			probeTestCoverage("t", { ...base, run: async () => ({ status: 1 }) }),
		).resolves.toEqual({ unknown: "probe exited 1" });
		await expect(
			probeTestCoverage("t", {
				...base,
				run: async () => ({ status: null, timedOut: true }),
			}),
		).resolves.toEqual({ unknown: "probe timed out" });
	});

	it("reports an unreadable or unmapped coverage report as unknown", async () => {
		await expect(
			probeTestCoverage("t", {
				...base,
				readCoverage: () => {
					throw new SyntaxError("Unexpected end of JSON input");
				},
				run: async () => ({ status: 0 }),
			}),
		).resolves.toEqual({ unknown: "coverage report unreadable" });
		await expect(
			probeTestCoverage("t", {
				...base,
				rangesByFile: new Map([["clients/a.ts", [[1, 1]]]]),
				readCoverage: () => ({
					"/repo/clients/a.js": entryOf([{ start: 1, hits: 1 }]),
				}),
				run: async () => ({ status: 0 }),
			}),
		).resolves.toEqual({
			unknown: "coverage of clients/a.js is not source-mapped",
		});
	});
});

describe("probeAllTests", () => {
	it("runs the first probe alone, then the rest at most `concurrency` at a time", async () => {
		// Recurrence: a cold checkout's globalSetup pre-fetches missing grammars;
		// several cold probes racing on that download is the one shared-state
		// hazard of probing side by side.
		const started: string[] = [];
		const finishers = new Map<string, () => void>();
		let inFlight = 0;
		let maxInFlight = 0;
		const probe = (test: string) =>
			new Promise<{ lines: number }>((resolveProbe) => {
				started.push(test);
				inFlight += 1;
				maxInFlight = Math.max(maxInFlight, inFlight);
				finishers.set(test, () => {
					inFlight -= 1;
					resolveProbe({ lines: 1 });
				});
			});
		const tests = ["a", "b", "c", "d", "e"];
		const done = probeAllTests(tests, probe, { concurrency: 2 });
		await Promise.resolve();
		expect(started).toEqual(["a"]);
		finishers.get("a")?.();
		await flushMicrotasks();
		expect(started).toEqual(["a", "b", "c"]);
		for (const test of ["b", "c"]) finishers.get(test)?.();
		await flushMicrotasks();
		for (const test of ["d", "e"]) finishers.get(test)?.();
		const lines = await done;
		expect(maxInFlight).toBe(2);
		expect([...lines.keys()]).toEqual(tests);
		expect([...lines.values()]).toEqual([1, 1, 1, 1, 1]);
	});

	it("records an unknown probe as null and leaves tests the signal cut off as null", async () => {
		const controller = new AbortController();
		const lines = await probeAllTests(
			["a", "b", "c"],
			async (test) => {
				if (test === "b") controller.abort();
				return test === "a" ? { unknown: "probe exited 1" } : { lines: 2 };
			},
			{ concurrency: 1, signal: controller.signal },
		);
		expect(lines.get("a")).toBeNull();
		expect(lines.get("b")).toBe(2);
		expect(lines.get("c")).toBeNull();
	});

	it("handles an empty pool", async () => {
		expect(
			await probeAllTests([], async () => ({ lines: 1 }), { concurrency: 4 }),
		).toEqual(new Map());
	});
});

async function flushMicrotasks() {
	for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

describe("selectMutationTests", () => {
	const lines = (entries: Record<string, number | null>) =>
		new Map(Object.entries(entries));

	it("keeps the PR's own tests although the cap is smaller than the covering set (S1: the #3794 shape)", () => {
		const selection = selectMutationTests({
			related: ["tests/z-other.test.ts", "tests/y-other.test.ts"],
			ownTests: ["tests/own.test.ts"],
			lines: lines({
				"tests/z-other.test.ts": 50,
				"tests/y-other.test.ts": 40,
				"tests/own.test.ts": 1,
			}),
			maxTests: 1,
		});
		expect(selection.kept).toEqual(["tests/own.test.ts"]);
		expect(selection.dropped).toEqual([
			"tests/z-other.test.ts",
			"tests/y-other.test.ts",
		]);
	});

	it("keeps an own test that covers no changed line, and never counts it as covering", () => {
		const selection = selectMutationTests({
			related: [],
			ownTests: ["tests/own.test.ts"],
			lines: lines({ "tests/own.test.ts": 0 }),
			maxTests: 5,
		});
		expect(selection.kept).toEqual(["tests/own.test.ts"]);
		expect(selection.covering).toBe(0);
	});

	it("fills the slots left by own tests, not the whole cap", () => {
		const selection = selectMutationTests({
			related: ["tests/a.test.ts", "tests/b.test.ts", "tests/c.test.ts"],
			ownTests: ["tests/own1.test.ts", "tests/own2.test.ts"],
			lines: lines({
				"tests/a.test.ts": 3,
				"tests/b.test.ts": 2,
				"tests/c.test.ts": 1,
				"tests/own1.test.ts": 1,
				"tests/own2.test.ts": 1,
			}),
			maxTests: 3,
		});
		expect(selection.kept).toHaveLength(3);
		expect(selection.kept).toContain("tests/a.test.ts");
		expect(selection.dropped).toEqual(["tests/b.test.ts", "tests/c.test.ts"]);
	});

	it("ranks by covered changed lines, most first, whatever the test is called (S2, S3)", () => {
		// Recurrence S2: the old cap kept `tests/a-*` before `tests/z-*` at equal
		// priority, so the kept set depended on file names.
		const selection = selectMutationTests({
			related: ["tests/a.test.ts", "tests/m.test.ts", "tests/z.test.ts"],
			lines: lines({
				"tests/a.test.ts": 1,
				"tests/m.test.ts": 9,
				"tests/z.test.ts": 4,
			}),
			maxTests: 2,
		});
		expect(selection.kept).toEqual(["tests/m.test.ts", "tests/z.test.ts"]);
		expect(selection.dropped).toEqual(["tests/a.test.ts"]);
	});

	it("drops a related test that covers no changed line and keeps every covering one under the cap (S4, S5)", () => {
		const selection = selectMutationTests({
			related: [
				"tests/idle.test.ts",
				"tests/hit.test.ts",
				"tests/hit2.test.ts",
			],
			lines: lines({
				"tests/idle.test.ts": 0,
				"tests/hit.test.ts": 2,
				"tests/hit2.test.ts": 1,
			}),
			maxTests: 47,
		});
		expect(selection.kept).toEqual(["tests/hit.test.ts", "tests/hit2.test.ts"]);
		expect(selection.dropped).toEqual([]);
		expect(selection.pool).toBe(3);
		expect(selection.covering).toBe(2);
		expect(selection.mode).toBe("coverage");
	});

	it("breaks a tie by import-graph priority, sibling before importer", () => {
		const selection = selectMutationTests({
			related: ["tests/importer.test.ts", "tests/sibling.test.ts"],
			priorities: new Map([
				["tests/sibling.test.ts", 0],
				["tests/importer.test.ts", 1],
			]),
			lines: lines({
				"tests/importer.test.ts": 3,
				"tests/sibling.test.ts": 3,
			}),
			maxTests: 1,
		});
		expect(selection.kept).toEqual(["tests/sibling.test.ts"]);
	});

	it("breaks a full tie by a hash of the path, not alphabetically, independent of input order", () => {
		// sha256 of these paths sorts c < e < d < b < a: alphabetical would keep
		// a and b, the hash keeps c and e. Reversing the input must not change it.
		const names = ["a", "b", "c", "d", "e"].map((n) => `tests/${n}.test.ts`);
		const equal = Object.fromEntries(names.map((name) => [name, 5]));
		const forward = selectMutationTests({
			related: names,
			lines: lines(equal),
			maxTests: 2,
		});
		const reversed = selectMutationTests({
			related: [...names].reverse(),
			lines: lines(equal),
			maxTests: 2,
		});
		expect(forward.kept).toEqual(["tests/c.test.ts", "tests/e.test.ts"]);
		expect(reversed.kept).toEqual(forward.kept);
	});

	it("keeps a test whose probe failed after every proven covering test, and reports it (S9)", () => {
		const selection = selectMutationTests({
			related: [
				"tests/flaky.test.ts",
				"tests/hit.test.ts",
				"tests/idle.test.ts",
			],
			lines: lines({
				"tests/flaky.test.ts": null,
				"tests/hit.test.ts": 1,
				"tests/idle.test.ts": 0,
			}),
			maxTests: 47,
		});
		expect(selection.kept).toEqual([
			"tests/hit.test.ts",
			"tests/flaky.test.ts",
		]);
		expect(selection.unknown).toEqual(["tests/flaky.test.ts"]);
		expect(selection.covering).toBe(1);
	});

	it("drops an unknown test before a covering one when the cap binds", () => {
		const selection = selectMutationTests({
			related: ["tests/flaky.test.ts", "tests/hit.test.ts"],
			lines: lines({ "tests/flaky.test.ts": null, "tests/hit.test.ts": 1 }),
			maxTests: 1,
		});
		expect(selection.kept).toEqual(["tests/hit.test.ts"]);
		expect(selection.dropped).toEqual(["tests/flaky.test.ts"]);
	});

	it("falls back to the import-graph ranking when no probe produced an answer (S11)", () => {
		const related = ["tests/z-sibling.test.ts", "tests/a-importer.test.ts"];
		const priorities = new Map([
			["tests/z-sibling.test.ts", 0],
			["tests/a-importer.test.ts", 1],
		]);
		for (const all of [
			null,
			lines({
				"tests/z-sibling.test.ts": null,
				"tests/a-importer.test.ts": null,
			}),
		]) {
			const selection = selectMutationTests({
				related,
				ownTests: ["tests/own.test.ts"],
				priorities,
				lines: all,
				maxTests: 2,
			});
			expect(selection.mode).toBe("import-graph");
			expect(selection.covering).toBeNull();
			expect(selection.kept).toEqual([
				"tests/own.test.ts",
				"tests/z-sibling.test.ts",
			]);
			expect(selection.dropped).toEqual(["tests/a-importer.test.ts"]);
		}
	});

	it("keeps nothing when every probe succeeded and none covers a changed line (S10)", () => {
		// The driver turns an empty list into a zero-mutant report; handing vitest
		// no file filter would run the whole suite instead.
		const selection = selectMutationTests({
			related: ["tests/idle.test.ts"],
			lines: lines({ "tests/idle.test.ts": 0 }),
			maxTests: 47,
		});
		expect(selection.mode).toBe("coverage");
		expect(selection.kept).toEqual([]);
		expect(selection.covering).toBe(0);
	});

	it("rejects a cap that is not a non-negative integer", () => {
		for (const maxTests of [-1, 1.5, Number.NaN]) {
			expect(() =>
				selectMutationTests({ related: [], lines: null, maxTests }),
			).toThrow(RangeError);
		}
	});

	it("does not list an own test twice when it is also import-related", () => {
		const selection = selectMutationTests({
			related: ["tests/own.test.ts"],
			ownTests: ["tests/own.test.ts"],
			lines: lines({ "tests/own.test.ts": 2 }),
			maxTests: 5,
		});
		expect(selection.kept).toEqual(["tests/own.test.ts"]);
		expect(selection.pool).toBe(1);
	});
});

describe("ownTestFiles", () => {
	it("selects changed test files and not fixtures, sources or other test-like paths", () => {
		// Recurrence: naming tests/fixtures/** to vitest is "No test files found"
		// (the config excludes it), a failed run.
		expect(
			ownTestFiles([
				"tests/tools/x.test.ts",
				"tests/fixtures/project/y.test.ts",
				"tests/support/helper.ts",
				"clients/z.ts",
				"tests/clients/deep/w.test.ts",
				"scripts/q.test.mjs",
			]),
		).toEqual(["tests/tools/x.test.ts", "tests/clients/deep/w.test.ts"]);
	});
});

describe("partitionOwnTests", () => {
	const exclusion = (file: string) => ({
		file,
		reason: "scheduling-sensitive",
	});

	it("keeps an existing own test, skips one the PR deleted, and routes a marked one to the exclusions (item 4)", () => {
		const result = partitionOwnTests(
			[
				"tests/scripts/kept.test.ts",
				"tests/scripts/deleted.test.ts",
				"tests/scripts/marked.test.ts",
				"scripts/not-a-test.mjs",
			],
			{
				exists: (file) => file !== "tests/scripts/deleted.test.ts",
				exclusionOf: (file) =>
					file === "tests/scripts/marked.test.ts" ? exclusion(file) : null,
			},
		);
		expect(result.own).toEqual(["tests/scripts/kept.test.ts"]);
		expect(result.excluded).toEqual([
			exclusion("tests/scripts/marked.test.ts"),
		]);
	});

	it("does not report a file twice that the related-test scan already excluded", () => {
		const result = partitionOwnTests(["tests/scripts/marked.test.ts"], {
			exists: () => true,
			exclusionOf: exclusion,
			alreadyExcluded: [{ file: "tests/scripts/marked.test.ts" }],
		});
		expect(result.own).toEqual([]);
		expect(result.excluded).toEqual([]);
	});

	it("reports an excluded file that only the own-test scan found", () => {
		const result = partitionOwnTests(["tests/scripts/marked.test.ts"], {
			exists: () => true,
			exclusionOf: exclusion,
			alreadyExcluded: [{ file: "tests/scripts/other.test.ts" }],
		});
		expect(result.excluded).toEqual([
			exclusion("tests/scripts/marked.test.ts"),
		]);
	});
});

describe("probe and cache paths", () => {
	it("keeps each probe's coverage report in its own directory under the scratch root", () => {
		// Recurrence: two concurrent probes writing coverage-final.json to one
		// directory read each other's report.
		const a = probeReportsDirectory("tests/a.test.ts");
		const b = probeReportsDirectory("tests/b.test.ts");
		expect(a).toMatch(/^\.stryker\/coverage\/[0-9a-f]{12}$/);
		expect(a.startsWith(`${PROBE_REPORTS_ROOT}/`)).toBe(true);
		expect(a).not.toBe(b);
		expect(probeReportsDirectory("tests/a.test.ts")).toBe(a);
	});

	it("writes the fingerprint beside the incremental file", () => {
		expect(INCREMENTAL_FINGERPRINT_PATH).toBe(
			".stryker/incremental.fingerprint",
		);
	});
});

describe("probeConcurrency", () => {
	it("is the core count, at least one and at most four", () => {
		expect(probeConcurrency(0)).toBe(1);
		expect(probeConcurrency(1)).toBe(1);
		expect(probeConcurrency(2)).toBe(2);
		expect(probeConcurrency(4)).toBe(4);
		expect(probeConcurrency(64)).toBe(4);
	});
});

describe("recorded #3794 selection (real coverage, real import graph)", () => {
	const fixture = JSON.parse(
		readFileSync(
			resolve(import.meta.dirname, "../fixtures/mutation-selection-3794.json"),
			"utf8",
		),
	);
	const lines = new Map<string, number | null>(Object.entries(fixture.lines));
	const priorities = new Map<string, number>(
		Object.entries(fixture.priorities),
	);

	it("the old cap dropped every one of the PR's own test files (the premise)", () => {
		expect(fixture.related).toHaveLength(72);
		expect(fixture.oldCapKept).toHaveLength(47);
		expect(fixture.ownTests).toHaveLength(3);
		for (const own of fixture.ownTests) {
			expect(fixture.related).toContain(own);
			expect(fixture.oldCapKept).not.toContain(own);
		}
	});

	it("selects related 72 -> covering 16 -> kept 16 with all three own tests and no alphabetical cut", () => {
		const selection = selectMutationTests({
			related: fixture.related,
			ownTests: fixture.ownTests,
			priorities,
			lines,
			maxTests: 47,
		});
		expect(selection.pool).toBe(72);
		expect(selection.covering).toBe(16);
		expect(selection.kept).toHaveLength(16);
		expect(selection.dropped).toEqual([]);
		for (const own of fixture.ownTests) expect(selection.kept).toContain(own);
		// Every kept test executes a changed line; every related test that does
		// not is gone (the old cap kept 47 of them).
		for (const test of selection.kept) {
			expect(lines.get(test)).toBeGreaterThan(0);
		}
		expect(
			selection.kept.filter((test) => fixture.oldCapKept.includes(test)).length,
		).toBeLessThan(selection.kept.length);
	});

	it("ranks the recorded tests by covered changed lines when the cap is tighter than the covering set", () => {
		const selection = selectMutationTests({
			related: fixture.related,
			ownTests: [],
			priorities,
			lines,
			maxTests: 4,
		});
		const counts = selection.kept.map((test) => lines.get(test) as number);
		expect(counts).toEqual([...counts].sort((a, b) => b - a));
		const droppedBest = Math.max(
			...selection.dropped.map((test) => (lines.get(test) as number) ?? -1),
		);
		expect(Math.min(...counts)).toBeGreaterThanOrEqual(droppedBest);
		expect(selection.dropped).toHaveLength(12);
	});

	it("recomputes each recorded covering test's count from its recorded statements", () => {
		const ranges = new Map<string, Array<[number, number]>>(
			Object.entries(fixture.changedRanges),
		);
		const recorded = Object.keys(fixture.coverage);
		expect(recorded).toHaveLength(16);
		for (const test of recorded) {
			const absolute = Object.fromEntries(
				Object.entries(fixture.coverage[test] as Record<string, object>).map(
					([file, entry]) => [`/repo/${file}`, entry],
				),
			);
			expect(coveredChangedLinesInReport(absolute, ranges, "/repo")).toBe(
				lines.get(test),
			);
		}
	});
});

describe("incremental cache rules", () => {
	it("fingerprints the kept tests and every other changed file, but not the mutated sources or prose (C1, C2, C4)", () => {
		expect(
			fingerprintPaths({
				changedFiles: [
					"scripts/mutated.mjs",
					"scripts/helper.mjs",
					"tests/kept.test.ts",
					"tests/support/fixture.ts",
					".changelog/entry.md",
					"docs/guide.md",
					"vitest.config.ts",
				],
				mutatedFiles: ["scripts/mutated.mjs"],
				keptTests: ["tests/kept.test.ts", "tests/unchanged.test.ts"],
			}),
		).toEqual([
			"scripts/helper.mjs",
			"tests/kept.test.ts",
			"tests/support/fixture.ts",
			"tests/unchanged.test.ts",
			"vitest.config.ts",
		]);
	});

	it("changes the fingerprint when any one input changes and not when only the order does (C1)", () => {
		const entries: Array<[string, string]> = [
			["tests/a.test.ts", "expect(1)"],
			["tests/b.test.ts", "expect(2)"],
		];
		const same = fingerprintEntries([...entries].reverse());
		expect(fingerprintEntries(entries)).toBe(same);
		expect(
			fingerprintEntries([
				["tests/a.test.ts", "expect(1)"],
				["tests/b.test.ts", "expect(3)"],
			]),
		).not.toBe(same);
		expect(
			fingerprintEntries([
				["tests/a.test.ts", "expect(2)"],
				["tests/b.test.ts", "expect(1)"],
			]),
		).not.toBe(same);
	});

	describe("buildFingerprint", () => {
		const files: Record<string, string> = {
			"stryker.config.mjs": "config",
			"package-lock.json": "lock",
			"tests/kept.test.ts": "kept",
			"scripts/helper.mjs": "helper",
			"scripts/mutated.mjs": "mutated",
		};
		const args = {
			forkPoint: "abc123",
			nodeVersion: "v22.0.0",
			read: (file: string) => files[file] ?? "<absent>",
			changedFiles: ["scripts/helper.mjs", "scripts/mutated.mjs"],
			mutatedFiles: ["scripts/mutated.mjs"],
			keptTests: ["tests/kept.test.ts"],
		};
		const base = buildFingerprint(args);

		it("is stable for the same inputs", () => {
			expect(buildFingerprint({ ...args })).toBe(base);
		});

		it.each([
			["the fork point (a rebase)", { forkPoint: "def456" }],
			["the node version", { nodeVersion: "v24.0.0" }],
			[
				"the Stryker config",
				{
					read: (f: string) =>
						f === "stryker.config.mjs" ? "other" : (files[f] ?? "<absent>"),
				},
			],
			[
				"the lockfile (vitest, Stryker)",
				{
					read: (f: string) =>
						f === "package-lock.json" ? "other" : (files[f] ?? "<absent>"),
				},
			],
			[
				"a kept test",
				{
					read: (f: string) =>
						f === "tests/kept.test.ts" ? "weaker" : (files[f] ?? "<absent>"),
				},
			],
			[
				"another changed file",
				{
					read: (f: string) =>
						f === "scripts/helper.mjs" ? "edited" : (files[f] ?? "<absent>"),
				},
			],
		])("changes when %s changes (C1, C2, C3)", (_name, change) => {
			expect(buildFingerprint({ ...args, ...change })).not.toBe(base);
		});

		it("does not change when only the mutated source does (Stryker diffs it itself)", () => {
			expect(
				buildFingerprint({
					...args,
					read: (f: string) =>
						f === "scripts/mutated.mjs" ? "edited" : (files[f] ?? "<absent>"),
				}),
			).toBe(base);
		});

		it("tells a config change from a same-content change of a differently named file", () => {
			// The label is part of the entry: swapping two files' contents is a change.
			const swapped: Record<string, string> = {
				...files,
				"stryker.config.mjs": "lock",
				"package-lock.json": "config",
			};
			expect(
				buildFingerprint({
					...args,
					read: (f: string) => swapped[f] ?? "<absent>",
				}),
			).not.toBe(base);
		});
	});

	it("reuses only a restored file whose fingerprint matches (C1, C3, C6)", () => {
		expect(
			decideIncrementalReuse({
				hasIncrementalFile: true,
				previous: "abc",
				current: "abc",
			}),
		).toEqual({ reuse: true, state: "warm" });
		expect(
			decideIncrementalReuse({
				hasIncrementalFile: true,
				previous: "abc",
				current: "changed",
			}),
		).toEqual({ reuse: false, state: "cold-inputs-changed" });
		expect(
			decideIncrementalReuse({
				hasIncrementalFile: true,
				previous: null,
				current: "abc",
			}),
		).toEqual({ reuse: false, state: "cold-no-cache" });
		expect(
			decideIncrementalReuse({
				hasIncrementalFile: false,
				previous: "abc",
				current: "abc",
			}),
		).toEqual({ reuse: false, state: "cold-no-cache" });
	});

	it("prunes restored mutants to the current ranges, inclusively, and drops files no longer mutated (C5)", () => {
		const mutant = (start: number, end = start) => ({
			id: `${start}-${end}`,
			location: { start: { line: start }, end: { line: end } },
		});
		const report = {
			schemaVersion: "2",
			files: {
				"clients/a.js": {
					language: "javascript",
					mutants: [
						mutant(9),
						mutant(10),
						mutant(12),
						mutant(13),
						mutant(11, 14),
					],
				},
				"clients/gone.js": { mutants: [mutant(1)] },
			},
		};
		const pruned = pruneIncrementalReport(report, ["clients/a.js:10-12"]);
		expect(Object.keys(pruned.files)).toEqual(["clients/a.js"]);
		expect(pruned.files["clients/a.js"].mutants.map((m) => m.id)).toEqual([
			"10-10",
			"12-12",
		]);
		expect(pruned.schemaVersion).toBe("2");
		expect(
			(pruned.files["clients/a.js"] as { language: string }).language,
		).toBe("javascript");
	});

	it("ignores a pattern that is not file:start-end", () => {
		const report = { files: { "a.js": { mutants: [] } } };
		expect(pruneIncrementalReport(report, ["a.js"]).files).toEqual({});
	});

	it("parses Stryker's own reuse line (pinned to @stryker-mutator/core 10.0.0 incremental-differ.ts)", () => {
		// Source line: `${chalk.yellowBright(reusedMutantCount)} of ${currentMutants.length}
		// mutant result(s) are reused.` under "Incremental report:".
		const log = [
			"00:00:01 (1) INFO IncrementalDiffer Incremental report:",
			"\tMutants:\t0 added, 2 removed",
			"\tResult:\t\t41 of 57 mutant result(s) are reused.",
		].join("\n");
		expect(parseIncrementalReuse(log)).toEqual({ reused: 41, total: 57 });
		expect(parseIncrementalReuse("no such line")).toBeNull();
	});
});
