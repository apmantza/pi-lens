import * as fs from "node:fs";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildWeights,
	buildWeightsFromJournal,
} from "../../scripts/gen-test-shard-weights.mjs";

// #3771: the weights snapshot is regenerated from CI's per-shard vitest JSON.
// Recurrence: a regeneration that keys on the CI checkout's absolute prefix
// (every key then mismatches the sequencer's repo-relative ids and the whole
// snapshot reads as "unmodeled"), or that takes one slow runner's number.

// The shape `gh run download` yields and the nightly test-history rollup reads:
// vitest-results.json beside test-history-metadata.json (which this generator
// shares the reader of, `rowsFromArtifacts`, so its headSha rules apply).
function report(dir: string, name: string, entries: Array<[string, number]>) {
	const file = path.join(dir, name);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(
		file,
		JSON.stringify({
			testResults: entries.map(([test, seconds]) => ({
				name: test,
				startTime: 1000,
				endTime: 1000 + seconds * 1000,
			})),
		}),
	);
	fs.writeFileSync(
		path.join(path.dirname(file), "test-history-metadata.json"),
		JSON.stringify({ headSha: "a".repeat(40), runId: "1", lane: "linux" }),
	);
	return file;
}

describe("#3771 test shard weights generator", () => {
	it("keys files repo-relative whatever the checkout prefix", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-shard-gen-"));
		try {
			report(dir, "r1/vitest-results.json", [
				["/home/runner/work/pi-lens/pi-lens/tests/a/b.test.ts", 1],
				["C:\\work\\pi-lens\\tests\\c.test.ts", 2],
				["/elsewhere/not-a-test.ts", 3],
			]);
			expect(buildWeights([path.join(dir, "r1")])).toEqual({
				"tests/a/b.test.ts": 1,
				"tests/c.test.ts": 2,
			});
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("takes the per-run median, merges shards of one run and sorts the keys", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-shard-gen-"));
		try {
			const prefix = "/home/runner/work/pi-lens/pi-lens";
			report(dir, "r1/s1/vitest-results.json", [
				[`${prefix}/tests/z.test.ts`, 1],
			]);
			report(dir, "r1/s2/vitest-results.json", [
				[`${prefix}/tests/a.test.ts`, 2],
			]);
			report(dir, "r2/s1/vitest-results.json", [
				[`${prefix}/tests/z.test.ts`, 9],
				[`${prefix}/tests/a.test.ts`, 4],
			]);
			report(dir, "r3/s1/vitest-results.json", [
				[`${prefix}/tests/z.test.ts`, 3],
			]);
			const weights = buildWeights(
				["r1", "r2", "r3"].map((run) => path.join(dir, run)),
			);
			expect(Object.keys(weights)).toEqual([
				"tests/a.test.ts",
				"tests/z.test.ts",
			]);
			expect(weights["tests/z.test.ts"]).toBe(3);
			expect(weights["tests/a.test.ts"]).toBe(3);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

// #5182 item 3: the same weights, built from the nightly test-history journal
// (history/test-daily.ndjson on data/test-history), which needs no GitHub API.
// Recurrence: a stale snapshot leaves ~120 files unknown at the median cost
// (one really takes 126 s) and the shards drift 19% over the mean.
type Stat = { runs: number; durationMs: number };
function day(
	dayName: string,
	tests: Record<string, Stat>,
	lane = "linux",
): string {
	return JSON.stringify({ day: dayName, lane, tests });
}

describe("#5182 weights from the test-history journal", () => {
	const A = "tests/a.test.ts";

	it("takes the median of the per-day means over the days a file appears in", () => {
		// per-day seconds: 10000/2/1000 = 5, 3000/3/1000 = 1, 9000/1/1000 = 9
		const lines = [
			day("2026-11-06", { [A]: { runs: 2, durationMs: 10000 } }),
			day("2026-11-07", { [A]: { runs: 3, durationMs: 3000 } }),
			day("2026-11-08", { [A]: { runs: 1, durationMs: 9000 } }),
		];
		expect(buildWeightsFromJournal(lines, 5).files).toEqual({ [A]: 5 });
	});

	it("rounds to two decimals like the --run path", () => {
		const lines = [day("2026-11-08", { [A]: { runs: 3, durationMs: 1000 } })];
		expect(buildWeightsFromJournal(lines, 5).files[A]).toBe(0.33);
	});

	it("ignores a non-linux lane", () => {
		const lines = [
			day("2026-11-08", { [A]: { runs: 1, durationMs: 2000 } }),
			day("2026-11-09", { [A]: { runs: 1, durationMs: 900000 } }, "windows"),
		];
		const built = buildWeightsFromJournal(lines, 5);
		expect(built.files).toEqual({ [A]: 2 });
		expect(built.days).toEqual(["2026-11-08"]);
	});

	it("ignores a file outside tests/ and a day with runs 0", () => {
		const lines = [
			day("2026-11-07", {
				[A]: { runs: 1, durationMs: 4000 },
				"scripts/x.test.ts": { runs: 1, durationMs: 1000 },
			}),
			day("2026-11-08", { [A]: { runs: 0, durationMs: 99000 } }),
		];
		expect(buildWeightsFromJournal(lines, 5).files).toEqual({ [A]: 4 });
	});

	it("uses only the newest n linux days", () => {
		const lines = [
			day("2026-11-05", { [A]: { runs: 1, durationMs: 100000 } }),
			day("2026-11-06", { [A]: { runs: 1, durationMs: 100000 } }),
			day("2026-11-07", { [A]: { runs: 1, durationMs: 2000 } }),
			day("2026-11-08", { [A]: { runs: 1, durationMs: 6000 } }),
		];
		const built = buildWeightsFromJournal(lines, 2);
		expect(built.days).toEqual(["2026-11-07", "2026-11-08"]);
		expect(built.files).toEqual({ [A]: 4 });
	});

	it("is deterministic across input order and sorts the keys", () => {
		const lines = [
			day("2026-11-06", {
				"tests/z.test.ts": { runs: 1, durationMs: 3000 },
				[A]: { runs: 1, durationMs: 1000 },
			}),
			day("2026-11-07", { "tests/z.test.ts": { runs: 1, durationMs: 5000 } }),
			day("2026-11-08", { [A]: { runs: 1, durationMs: 3000 } }),
		];
		const one = buildWeightsFromJournal(lines, 3);
		const two = buildWeightsFromJournal([lines[2], lines[0], lines[1]], 3);
		expect(JSON.stringify(two)).toBe(JSON.stringify(one));
		expect(Object.keys(one.files)).toEqual([A, "tests/z.test.ts"]);
		expect(one.files).toEqual({ [A]: 2, "tests/z.test.ts": 4 });
	});

	it("accepts already parsed records", () => {
		const record = { day: "2026-11-08", lane: "linux", tests: {} } as const;
		expect(buildWeightsFromJournal([record], 1).days).toEqual(["2026-11-08"]);
	});

	it("names each failure", () => {
		const ok = day("2026-11-08", { [A]: { runs: 1, durationMs: 1000 } });
		expect(() => buildWeightsFromJournal([ok, "{nope"], 5)).toThrow(
			/journal line 2 is not JSON/,
		);
		expect(() =>
			buildWeightsFromJournal([day("2026-11-08", {}, "windows")], 5),
		).toThrow(/no linux record/);
		expect(() => buildWeightsFromJournal([], 5)).toThrow(/no linux record/);
		for (const bad of [0, -1, 1.5, Number.NaN]) {
			expect(() => buildWeightsFromJournal([ok], bad)).toThrow(
				/--days must be a positive integer/,
			);
		}
	});

	describe("the CLI", () => {
		const script = path.resolve("scripts/gen-test-shard-weights.mjs");
		const run = (args: string[]) =>
			spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });

		it("writes the header naming the journal and is byte-identical on rerun", () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-shard-gen-"));
			try {
				const journal = path.join(dir, "j.ndjson");
				fs.writeFileSync(
					journal,
					`${[
						day("2026-11-07", { [A]: { runs: 1, durationMs: 2000 } }),
						day("2026-11-08", { [A]: { runs: 1, durationMs: 4000 } }),
					].join("\n")}\n`,
				);
				const out1 = path.join(dir, "o1.json");
				const out2 = path.join(dir, "o2.json");
				expect(run(["--journal", journal, "--out", out1]).status).toBe(0);
				expect(run(["--journal", journal, "--out", out2]).status).toBe(0);
				const text = fs.readFileSync(out1, "utf8");
				expect(text).toBe(fs.readFileSync(out2, "utf8"));
				expect(JSON.parse(text)).toEqual({
					generatedBy: "node scripts/gen-test-shard-weights.mjs --journal",
					runs: 2,
					days: ["2026-11-07", "2026-11-08"],
					files: { [A]: 3 },
				});
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		it("refuses --journal with --run, an unreadable journal and a bad --days", () => {
			const both = run(["--journal", "x", "--run", "y"]);
			expect(both.status).not.toBe(0);
			expect(both.stderr).toMatch(/--journal and --run are mutually exclusive/);
			const missing = run(["--journal", "/nonexistent/j.ndjson"]);
			expect(missing.stderr).toMatch(/cannot read journal/);
			const days = run(["--journal", "x", "--days", "0"]);
			expect(days.stderr).toMatch(/--days must be a positive integer/);
		});
	});
});
