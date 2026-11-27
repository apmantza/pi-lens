// #4405: scripts/ci-shuffle-census.mjs runs every test file alone and inside
// shuffled chunks under two seeds, and diffs the order-dependent members it
// finds against scripts/shuffle-census-ratchet.json. Every case names the
// recurrence it keeps out. The vitest start is the only process boundary and
// is injected here; the real start is `ci-shuffle-changed-tests-spawn.test.ts`
// and the real whole-tree pass is the command itself (its runtime and the
// re-broken-fix reds are quoted in the PR body).
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
	extractMembers,
	issueBody,
	judgeCensus,
	listTestFiles,
	listTrackedFiles,
	loadRecords,
	MIN_START_MS,
	parseArgs,
	planCensus,
	planConfirms,
	previousStaleFrom,
	run,
	runCensus,
	START_CAP_MS,
	type CensusRecord,
	type Member,
	type Seed,
} from "../../scripts/ci-shuffle-census.mjs";
import {
	type ExecVitest,
	planRuns,
	reproCommand,
	SEEDS,
	selectChangedTestFiles,
} from "../../scripts/ci-shuffle-changed-tests.mjs";
import { setupTestEnvironment } from "../clients/test-utils.js";
import { assertNonEmptyScan } from "../support/sweep-kit.js";
import { expectPlantedStaleRow } from "../support/baseline-staleness.js";
import { scaledTestTimeout } from "../support/test-timeout-scale.js";
import {
	auditShuffleOptOuts,
	censusShuffleOptOuts,
	judgeShuffleOptOuts,
	shuffleCensusPopulation,
} from "../support/shuffle-opt-out-scan.js";
import {
	vitestCollector,
	vitestCollects,
} from "../support/vitest-collection.js";

const cleanups: Array<() => void> = [];
afterAll(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});
function scratchDir(name: string): string {
	const scratch = setupTestEnvironment(`pi-lens-4405-${name}-`);
	cleanups.push(scratch.cleanup);
	return scratch.tmpDir;
}

const quiet = () => {};
const ESC = String.fromCharCode(27);
const paint = (code: string, text: string) =>
	`${ESC}[${code}m${text}${ESC}[39m`;
/** One vitest FAIL banner as CI prints it: colour codes, project label. */
const banner = (file: string, test?: string) =>
	`${ESC}[41m${ESC}[1m FAIL ${ESC}[22m${ESC}[49m |default| ${file}${test ? `${ESC}[2m > ${ESC}[22m${test}` : ""}`;

function member(
	file: string,
	test: string,
	firstError = "Error: boom",
): Member {
	return { file, test, firstError };
}
function record(
	seed: Seed,
	files: string[],
	members: Member[],
	extra: Partial<CensusRecord> = {},
): CensusRecord {
	return {
		key: `npx vitest run ${files.join(" ")} ${seed}`,
		kind: "census",
		label: `${seed} ${files[0]}`,
		files,
		seed,
		verdict: members.length > 0 ? "red" : "ok",
		ms: 1,
		members,
		...extra,
	};
}
function confirm(seed: number, file: string, members: Member[]): CensusRecord {
	return record(seed, [file], members, {
		kind: "confirm",
		key: `confirm ${seed} ${file}`,
	});
}
/** A chunk start's rerun, keyed the way planConfirms keys it. */
const rerunOf = (chunk: CensusRecord, members: Member[]): CensusRecord =>
	record(chunk.seed, chunk.files, members, {
		kind: "rerun",
		key: `rerun:${chunk.key}`,
	});
const listed = (...files: string[]) => files.map((file) => ({ file }));

describe("extractMembers", () => {
	// Recurrence: a census that reads colour-split FAIL banners as "no failing
	// test" lists no member at all (AGENTS.md shape 63: CI runs vitest with
	// colour, and a project label sits between FAIL and the file).
	it("reads file, test and first error from coloured banners", () => {
		const out = [
			"stdout noise",
			banner("tests/a.test.ts", "suite > case one"),
			`${paint("31", "AssertionError")}: expected 1 to be 2`,
			"",
			banner("tests/b.test.ts", "case two"),
			"",
			`${paint("31", "TypeError")}: x is not a function`,
		].join("\n");
		expect(extractMembers(out)).toEqual([
			member(
				"tests/a.test.ts",
				"suite > case one",
				"AssertionError: expected 1 to be 2",
			),
			member("tests/b.test.ts", "case two", "TypeError: x is not a function"),
		]);
	});

	// Recurrence: #4405's index-integration member. Vitest prints one error
	// under the LAST of N banners that share it; reading the next line as the
	// error recorded another test's banner for 14 of 25 members.
	it("skips a following FAIL banner when it looks for the first error line", () => {
		const out = [
			banner("tests/a.test.ts", "one"),
			banner("tests/a.test.ts", "two"),
			"Error: shared cause",
		].join("\n");
		expect(extractMembers(out).map((m) => m.firstError)).toEqual([
			"Error: shared cause",
			"Error: shared cause",
		]);
	});

	// Recurrence: a suite that failed to collect (a missing import) has a
	// banner with no test name; it is still a member, under a sentinel.
	it("names a file-level failure with the (file) sentinel", () => {
		expect(
			extractMembers(
				`${banner("tests/c.test.ts")}\nError: Cannot find module './x.js'`,
			),
		).toEqual([
			member("tests/c.test.ts", "(file)", "Error: Cannot find module './x.js'"),
		]);
	});

	// Recurrence: vitest repeats a banner in its inline list and its summary;
	// counting both doubles a member and the ratchet then lists it twice.
	it("lists a repeated banner once", () => {
		const block = `${banner("tests/a.test.ts", "one")}\nError: x`;
		expect(extractMembers(`${block}\n${block}`)).toHaveLength(1);
	});
});

describe("planCensus", () => {
	const files = Array.from(
		{ length: 7 },
		(_, index) => `tests/f${index}.test.ts`,
	);

	// Recurrence: a census that drops a file at a chunk boundary, or runs one
	// twice, reports a member count that is not about the tree.
	it("covers every file once per seed and once alone", () => {
		const plan = planCensus(files, { seeds: [1, 2], chunk: 3 });
		for (const seed of [1, 2]) {
			const covered = plan
				.filter((start) => start.flags.includes(`--sequence.seed=${seed}`))
				.flatMap((start) => start.files);
			expect(covered).toEqual(files);
		}
		const alone = plan.filter((start) => start.flags.length === 0);
		expect(alone.map((start) => start.files)).toEqual(files.map((f) => [f]));
		expect(plan).toHaveLength(2 * 3 + 7);
	});

	// Recurrence: a confirm start reusing a census key would be skipped as
	// done, so a member would stay unconfirmed forever.
	it("plans one confirm start per shuffled member file and seed, never for alone", () => {
		const records = [
			record(
				202,
				["tests/a.test.ts", "tests/b.test.ts"],
				[member("tests/a.test.ts", "t1"), member("tests/a.test.ts", "t2")],
			),
			record("alone", ["tests/c.test.ts"], [member("tests/c.test.ts", "t")]),
		];
		const confirms = planConfirms(records);
		expect(
			confirms.map((start) => [start.files, start.flags, start.kind]),
		).toEqual([
			[
				["tests/a.test.ts"],
				["--sequence.shuffle", "--sequence.seed=202"],
				"confirm",
			],
		]);
		expect(confirms[0]?.key).toMatch(/^confirm:/);
	});

	// Recurrence (F3): a chunk-only failure that its confirm start cannot
	// reproduce was dropped as "chunk load?" and the report exited 0. It is
	// rerun once, under its own key (the chunk's key is taken: the rerun would
	// be skipped as done).
	it("plans one rerun of the chunk when its member is green alone", () => {
		const chunk = record(
			202,
			["tests/a.test.ts", "tests/b.test.ts"],
			[member("tests/a.test.ts", "t1")],
		);
		expect(planConfirms([chunk]).map((start) => start.kind)).toEqual([
			"confirm",
		]);
		const plan = planConfirms([chunk, confirm(202, "tests/a.test.ts", [])]);
		expect(plan.map((start) => start.kind)).toEqual(["confirm", "rerun"]);
		const again = plan[1];
		expect(again?.files).toEqual(["tests/a.test.ts", "tests/b.test.ts"]);
		expect(again?.flags).toEqual(["--sequence.shuffle", "--sequence.seed=202"]);
		expect(again?.key).toBe(`rerun:${chunk.key}`);
		// A member that reproduces alone needs no rerun.
		expect(
			planConfirms([
				chunk,
				confirm(202, "tests/a.test.ts", [member("tests/a.test.ts", "t1")]),
			]).map((start) => start.kind),
		).toEqual(["confirm"]);
	});

	// Recurrence: the nightly runs the alone pass weekly. A flag that still
	// planned alone starts would spend 37% of the nightly on a pass that found
	// no order-dependent file.
	it("leaves out the alone starts when asked", () => {
		const two = ["tests/a.test.ts", "tests/b.test.ts"];
		const without = planCensus(two, { seeds: [202], chunk: 2, alone: false });
		expect(without.map((start) => start.flags.length > 0)).toEqual([true]);
		expect(
			planCensus(two, { seeds: [202], chunk: 2 }).filter(
				(start) => start.flags.length === 0,
			),
		).toHaveLength(2);
		expect(parseArgs(["--out", ".", "--no-alone"]).alone).toBe(false);
		expect(parseArgs(["--out", "."]).alone).toBe(true);
	});
});

// #4405 round 5: the census plans from `git ls-files`, vitest runs what its
// config's projects collect. A planned file no project collects is skipped
// inside its chunk without a word (the start reads ok), and a collected file
// the census does not plan is never started. Either way a file sits outside
// every seed while the nightly reads green. A project's own `sequence` hides
// nothing: the census's command-line shuffle flags win (probed in the PR).
// Collection is read through `vitestCollector`, the suite's one reader of
// the config's include and exclude lists.
describe("census plan against vitest collection", () => {
	type Config = Parameters<typeof vitestCollector>[0];
	/** Planned files no project collects, and collected files never planned. */
	function collectionGaps(
		plan: Array<{ files: string[] }>,
		tracked: string[],
		collects: (file: string) => boolean,
	) {
		const planned = new Set(plan.flatMap((start) => start.files));
		return {
			uncollected: [...planned].filter((file) => !collects(file)).sort(),
			unplanned: tracked
				.filter((file) => !planned.has(file) && collects(file))
				.sort(),
		};
	}
	const tracked = [
		"tests/a.test.ts",
		"tests/lane/a.test.ts",
		"tests/lane/b.test.ts",
		"tests/fixtures/x.test.ts",
		"scripts/c.test.mts",
		".hidden/d.test.ts",
		"clients/e.ts",
	];
	/** The census over the fixture: the selection and planner `run` uses. */
	const fixturePlan = planCensus(
		selectChangedTestFiles(tracked, () => true),
		{
			seeds: [202],
			chunk: 2,
		},
	);
	const gaps = (projects: unknown[], exclude: string[]) =>
		collectionGaps(
			fixturePlan,
			tracked,
			vitestCollector({ test: { exclude, projects } }),
		);
	const laneSplit = (laneInclude: string[], laneExclude?: string[]) => [
		{ test: { name: "default", exclude: ["tests/lane/**"] } },
		{ test: { name: "lane", include: laneInclude, exclude: laneExclude } },
	];

	// Recurrence: a lane list that takes a file out of `default` but misses it
	// in its own include. The file runs in no project, so no seed reaches it.
	it("names a planned file that no project includes", () => {
		const found = gaps(laneSplit(["tests/lane/a.test.ts"]), [
			"tests/fixtures/**",
		]);
		expect(found.uncollected).toEqual(["tests/lane/b.test.ts"]);
	});

	// Recurrence: a project that includes a file and excludes it again (the
	// `npm run test:unit` switch drops two files from their projects this way).
	it("names a planned file that its own project excludes", () => {
		const found = gaps(laneSplit(["tests/lane/**"], ["tests/lane/a.test.ts"]), [
			"tests/fixtures/**",
		]);
		expect(found.uncollected).toEqual(["tests/lane/a.test.ts"]);
	});

	// Recurrence: vitest adds the root `exclude` to a project's own (probed
	// with `vitest list`); a reader that took only the project's would call
	// the file covered.
	it("names a planned file that the root exclude drops from its project", () => {
		const found = gaps(laneSplit(["tests/lane/**"], ["tests/lane/old/**"]), [
			"tests/fixtures/**",
			"tests/lane/b.test.ts",
		]);
		expect(found.uncollected).toEqual(["tests/lane/b.test.ts"]);
	});

	// Recurrence: `default` takes vitest's default include, which is wider
	// than the census's `tests/**/*.test.ts`. A `.test.mts`, or a test under a
	// dot directory (vitest globs with `dot`), runs in CI and never in the
	// census.
	it("names a collected file that the census does not plan", () => {
		const found = gaps(laneSplit(["tests/lane/**"]), ["tests/fixtures/**"]);
		expect(found).toEqual({
			uncollected: [],
			unplanned: [".hidden/d.test.ts", "scripts/c.test.mts"],
		});
	});

	// Recurrence: vitest adds the root `include` to a project's own (probed);
	// a reader that took only the project's would miss a file the root adds.
	it("reads a root include as part of every project's", () => {
		const collects = vitestCollector({
			test: {
				include: ["tests/a.test.ts"],
				projects: [{ test: { name: "lane", include: ["tests/lane/**"] } }],
			},
		});
		expect(collects("tests/a.test.ts")).toBe(true);
		expect(collects("tests/lane/b.test.ts")).toBe(true);
		expect(collects("scripts/c.test.mts")).toBe(false);
	});

	// Recurrence: a config shape the reader does not model would otherwise
	// read as collecting nothing, or everything, and pass.
	it("throws on a config shape it does not read", () => {
		const read = (config: Config) => () => vitestCollector(config);
		expect(read({ test: { projects: ["packages/*"] } })).toThrow(/unreadable/);
		expect(
			read({ test: { projects: [{ extends: true, test: { name: "x" } }] } }),
		).toThrow(/unreadable/);
		expect(read({ test: { dir: "pkg" } })).toThrow(/root sets test\.dir/);
		expect(
			read({
				test: { projects: [{ test: { name: "x", includeSource: [] } }] },
			}),
		).toThrow(/test\.includeSource/);
	});

	// Recurrence (#4423 r5 verify): shapes the reader read wrong without a
	// throw. Each was probed against `vitest list`. A negated include
	// over-matched, so the red named the wrong files. A negated exclude, a
	// `./` pattern and a `typecheck` block reported a false red. A project
	// `dir` moves what it collects.
	it.each([
		[
			"a negated include",
			{ test: { projects: [{ test: { include: ["!tests/lane/**"] } }] } },
			/starts with "!"/,
		],
		[
			"a negated exclude",
			{ test: { exclude: ["!tests/lane/**"], projects: [{ test: {} }] } },
			/starts with "!"/,
		],
		[
			"a ./ pattern",
			{ test: { projects: [{ test: { include: ["./tests/**"] } }] } },
			/starts with "\.\/"/,
		],
		[
			"a typecheck block",
			{
				test: {
					projects: [
						{
							test: {
								name: "types",
								typecheck: { include: ["**/*.test-d.ts"] },
							},
						},
					],
				},
			},
			/test\.typecheck/,
		],
		[
			"a project dir",
			{
				test: {
					projects: [{ test: { name: "default", dir: "tests/lane" } }],
				},
			},
			/project default sets test\.dir/,
		],
	])("throws on %s", (_shape, config, message) => {
		expect(() => vitestCollector(config as Config)).toThrow(message);
	});

	// Recurrence (#4423 r5 verify): a glob-free exclude hides a whole
	// directory in vitest (`vitest list`: `tests/x` and `tests/x/` drop
	// `tests/x/in.test.ts` and keep `tests/xy/in.test.ts`). The reader matched
	// it as one path, so the guard stayed green over a hidden directory. A
	// glob-free include is a path only: `tests/x` collects nothing in vitest.
	it("reads a glob-free exclude as its directory, and a glob-free include as one path", () => {
		const projects = [{ test: { include: ["tests/**/*.test.ts"] } }];
		for (const plain of ["tests/lane", "tests/lane/"])
			expect(gaps(projects, ["tests/fixtures/**", plain]).uncollected).toEqual([
				"tests/lane/a.test.ts",
				"tests/lane/b.test.ts",
			]);
		expect(
			gaps(projects, ["tests/fixtures/**", "tests/la"]).uncollected,
		).toEqual([]);
		const pathOnly = vitestCollector({ test: { include: ["tests/lane"] } });
		expect(pathOnly("tests/lane/a.test.ts")).toBe(false);
	});

	const ROOT = path.resolve(import.meta.dirname, "../..");
	/** The real config, evaluated under one `npm_lifecycle_event`. */
	async function realConfig(lifecycle: string | undefined): Promise<Config> {
		vi.stubEnv("npm_lifecycle_event", lifecycle);
		vi.resetModules();
		try {
			return (await import("../../vitest.config.ts")).default as Config;
		} finally {
			vi.unstubAllEnvs();
			vi.resetModules();
		}
	}

	// Recurrence: a lane list, an exclude, or a wider include in
	// `vitest.config.ts` that parts the two lists. This is the PR-time red: the
	// change that hides a file fails here, not in a nightly run later. The
	// census starts `node scripts/ci-shuffle-census.mjs` outside npm, so the
	// config is read with no `npm_lifecycle_event`.
	it("finds no gap between the census plan and the real vitest projects", async () => {
		const files = listTestFiles(ROOT);
		expect(files.length).toBeGreaterThan(1000);
		const everything = listTrackedFiles(ROOT);
		const collects = vitestCollector(await realConfig(undefined));
		expect(collectionGaps(planCensus(files), everything, collects)).toEqual({
			uncollected: [],
			unplanned: [],
		});
		// Not vacuous: a file the plan leaves out is named, and the same config
		// under `npm run test:unit` drops exactly the files `test:integration`
		// names, whichever project lists them (#5227: a move into
		// wall-clock-budget, which lacked the unit-only exclude, ran the real-LSP
		// integration suite under `test:unit`).
		const [first, ...rest] = files;
		expect(
			collectionGaps(planCensus(rest), everything, collects).unplanned,
		).toEqual([first]);
		const unit = collectionGaps(
			planCensus(files),
			everything,
			vitestCollector(await realConfig("test:unit")),
		);
		const integration = (
			JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"))
				.scripts["test:integration"] as string
		)
			.split(/\s+/)
			.filter((word) => word.endsWith(".test.ts"));
		expect(integration.length).toBeGreaterThan(0);
		// Code-unit order, the same order `.sort()` gives, stated explicitly.
		const byCodeUnit = (a: string, b: string): number =>
			a < b ? -1 : a > b ? 1 : 0;
		expect([...unit.uncollected].sort(byCodeUnit)).toEqual(
			[...integration].sort(byCodeUnit),
		);
		expect(unit.unplanned).toEqual([]);
	});
});

describe("runCensus", () => {
	const okExec: ExecVitest = () => ({ status: 0, output: "", timedOut: false });
	const plan = () =>
		planCensus(["tests/a.test.ts", "tests/b.test.ts"], {
			seeds: [202],
			chunk: 2,
		});

	// Recurrence: an hours-long pass that cannot resume restarts from zero after
	// every cut call; a rerun must skip what the records hold.
	it("records each finished start and skips recorded ones on a rerun", () => {
		const dir = scratchDir("resume");
		const outFile = path.join(dir, "census.0-of-1.jsonl");
		const starts: string[] = [];
		const exec: ExecVitest = (start) => {
			starts.push(start.files.join(","));
			return {
				status: 1,
				output: `${banner(start.files[0] ?? "", "case")}\nError: bad`,
				timedOut: false,
			};
		};
		const first = runCensus(plan(), {
			cwd: dir,
			outFile,
			done: new Set(),
			budgetMs: 10 * MIN_START_MS,
			exec,
			log: quiet,
		});
		expect(first).toEqual({ ran: 3, pending: 0 });
		const records = loadRecords(dir);
		expect(records.map((r) => r.verdict)).toEqual(["red", "red", "red"]);
		expect(records[0]?.members[0]).toEqual(
			member("tests/a.test.ts", "case", "Error: bad"),
		);
		const second = runCensus(plan(), {
			cwd: dir,
			outFile,
			done: new Set(records.map((r) => r.key)),
			budgetMs: 10 * MIN_START_MS,
			exec,
			log: quiet,
		});
		expect(second).toEqual({ ran: 0, pending: 0 });
		expect(starts).toHaveLength(3);
	});

	// Recurrence: a start the call budget cut recorded as "timeout" is counted
	// as a member-free finished start and never rerun.
	it("does not record a start the call budget cut, and leaves it pending", () => {
		const dir = scratchDir("cut");
		let clock = 0;
		const exec: ExecVitest = (_start, { timeoutMs }) => {
			clock += timeoutMs;
			return { status: null, output: "", timedOut: true };
		};
		const outFile = path.join(dir, "census.0-of-1.jsonl");
		const result = runCensus(plan(), {
			cwd: dir,
			outFile,
			done: new Set(),
			budgetMs: START_CAP_MS / 2,
			exec,
			now: () => clock,
			log: quiet,
		});
		expect(result.ran).toBe(0);
		expect(result.pending).toBe(3);
		expect(fs.existsSync(outFile)).toBe(false);
	});

	// Recurrence: a start never begun with less than MIN_START_MS left would
	// be cut mid-run and its fork left behind.
	it("begins no start under MIN_START_MS of budget", () => {
		const dir = scratchDir("min");
		let began = 0;
		const result = runCensus(plan(), {
			cwd: dir,
			outFile: path.join(dir, "census.0-of-1.jsonl"),
			done: new Set(),
			budgetMs: MIN_START_MS - 1,
			exec: (...args) => {
				began += 1;
				return okExec(...args);
			},
			log: quiet,
		});
		expect(began).toBe(0);
		expect(result.pending).toBe(3);
	});

	// Recurrence: a start that used its whole cap and timed out is a real
	// answer (a hung file), recorded so the verdict is "unproven", not retried
	// forever.
	it("records a start that timed out at the full cap", () => {
		const dir = scratchDir("cap");
		let clock = 0;
		const result = runCensus(plan().slice(0, 1), {
			cwd: dir,
			outFile: path.join(dir, "census.0-of-1.jsonl"),
			done: new Set(),
			budgetMs: 10 * START_CAP_MS,
			exec: (_start, { timeoutMs }) => {
				clock += timeoutMs;
				return { status: null, output: "", timedOut: true };
			},
			now: () => clock,
			log: quiet,
		});
		expect(result.ran).toBe(1);
		expect(loadRecords(dir)[0]?.verdict).toBe("timeout");
	});
});

describe("redo-unproven", () => {
	const A = "tests/a.test.ts";
	const writeRecords = (dir: string, records: CensusRecord[]) =>
		fs.writeFileSync(
			path.join(dir, "census.0-of-1.jsonl"),
			`${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
		);

	// Recurrence: #4405's full pass lost one alone start to a stale-build guard
	// another part tripped; without a redo the census stays "unproven" forever.
	it("reruns the starts whose record proved nothing, and only those", () => {
		const dir = scratchDir("redo");
		const out = path.join(dir, "out");
		fs.mkdirSync(out);
		const files = [A, "tests/b.test.ts"];
		const planned = planCensus(files, { seeds: [], chunk: 2 });
		const [first, second] = planned.map((start) =>
			record("alone", start.files, [], {
				key: `npx vitest run ${start.files[0]}`,
				verdict: start.files[0] === A ? "uncollected" : "ok",
				at: 1,
			}),
		) as [CensusRecord, CensusRecord];
		writeRecords(out, [first, second]);
		const starts: string[] = [];
		const exec: ExecVitest = (start) => {
			starts.push(start.files.join(","));
			return { status: 0, output: "", timedOut: false };
		};
		const args = ["--out", out, "--cwd", dir, "--files", files.join(",")];
		// Without the flag only the never-run shuffled chunk starts.
		expect(
			run([...args, "--seeds", "202"], {
				exec,
				log: quiet,
				distExists: () => true,
			}),
		).toBe(0);
		expect(starts).toEqual([files.join(",")]);
		starts.length = 0;
		expect(
			run([...args, "--seeds", "202", "--redo-unproven"], {
				exec,
				log: quiet,
				distExists: () => true,
			}),
		).toBe(0);
		expect(starts).toEqual([A]);
	});

	// Recurrence: two records for one start (the unproven one and its redo)
	// both reaching the judge would read the redo's green as a second start
	// and the old uncollected as still open.
	it("loads the latest record per start", () => {
		const dir = scratchDir("latest");
		writeRecords(dir, [
			record(202, [A], [], { key: "k", verdict: "uncollected", at: 1 }),
			record(202, [A], [], { key: "k", verdict: "ok", at: 2 }),
			record(424, [A], [], { key: "j", verdict: "ok", at: 1 }),
		]);
		expect(
			loadRecords(dir)
				.map((r) => `${r.key}:${r.verdict}`)
				.sort(),
		).toEqual(["j:ok", "k:ok"]);
	});
});

describe("judgeCensus", () => {
	const A = "tests/a.test.ts";
	const B = "tests/b.test.ts";
	const chunk202 = record(202, [A, B], [member(A, "t1")]);
	const chunk424 = record(424, [A, B], []);
	const withChunks = (...rows: CensusRecord[]) => [chunk202, chunk424, ...rows];

	it("is clean when every confirmed member file is in the ratchet", () => {
		const verdict = judgeCensus({
			records: withChunks(confirm(202, A, [member(A, "t1")])),
			ratchet: listed(A),
		});
		expect(verdict.code).toBe(0);
		expect(verdict.lines.join("\n")).toContain(
			"1 member file(s), all in the ratchet",
		);
	});

	// Recurrence (the acceptance row "a new member reds"): a test that turns
	// order-dependent after this PR lands must red the census, not slip in
	// beside the listed ones.
	it("reds a confirmed member file the ratchet does not list", () => {
		const verdict = judgeCensus({
			records: withChunks(confirm(202, A, [member(A, "t1")])),
			ratchet: listed(B),
		});
		expect(verdict.code).toBe(1);
		expect(verdict.lines).toContain(
			"new order-dependent member: tests/a.test.ts (202: t1 (Error: boom))",
		);
	});

	// Recurrence (F2, #4423 review r1): the ratchet keyed by (seed, test) went
	// stale with nothing fixed. One added passing test took
	// ast-grep-rule-manager.test.ts from 5 failing rows to 2 under seed 424.
	// A listed file stays listed while ANY row of it fails, whichever rows.
	it("keeps a listed file when a different set of its cases fails", () => {
		const verdict = judgeCensus({
			records: [
				record(202, [A], [member(A, "a different case")]),
				confirm(202, A, [member(A, "a different case")]),
				record(424, [A], []),
			],
			ratchet: listed(A),
		});
		expect(verdict.code).toBe(0);
		expect(verdict.stale).toEqual([]);
	});

	// Recurrence (the acceptance row "a removed member must leave the list"):
	// a fixed file left in the list lets it come back unseen, so the list
	// would stop shrinking. Tonight it only warns (exit 4).
	it("warns, exit 4, on a listed file clean under every seed", () => {
		const verdict = judgeCensus({
			records: [record(202, [A], []), record(424, [A], [])],
			ratchet: listed(A),
		});
		expect(verdict.code).toBe(4);
		expect(verdict.stale).toEqual([A]);
		expect(verdict.lines).toContain(
			"warning: ratchet entry clean under every seed tonight (delete it if it stays clean): tests/a.test.ts",
		);
		// #5072: the planted row is the ratchet file's own row-without-producer
		// direction, judged by the census's real comparison.
		expectPlantedStaleRow({
			baseline: "scripts/shuffle-census-ratchet.json",
			rowKey: A,
			verdict: verdict.lines,
		});
	});

	// Recurrence: a timing-seam row (a 5 s timeout) can pass on one night. The
	// second consecutive clean night is the one that reds.
	it("reds a stale file that was stale last night too", () => {
		const verdict = judgeCensus({
			records: [record(202, [A], []), record(424, [A], [])],
			ratchet: listed(A),
			previousStale: [A],
		});
		expect(verdict.code).toBe(1);
		expect(verdict.lines).toContain(
			"ratchet entry clean two nights running, delete it: tests/a.test.ts",
		);
	});

	// Recurrence: judging a half-finished pass as if it were complete warns
	// every entry whose seeds simply have not all run yet.
	it("does not call a ratchet file stale while one of its seeds has not run", () => {
		const verdict = judgeCensus({
			records: [record(202, [A], []), record(424, [B], [])],
			ratchet: listed(A),
		});
		expect(verdict.stale).toEqual([]);
		expect(verdict.code).toBe(0);
	});

	// Recurrence: a start that hung proves nothing about the file; calling its
	// entry stale would delete a real member.
	it("does not call a ratchet file stale when one of its starts did not finish", () => {
		const verdict = judgeCensus({
			records: [
				record(202, [A], []),
				record(424, [A], [], { verdict: "timeout" }),
			],
			ratchet: listed(A),
		});
		expect(verdict.stale).toEqual([]);
		expect(verdict.code).toBe(3);
	});

	// Recurrence: a chunk start can red from the load of its 24 neighbours;
	// counting it without the rerun put load flakes in the ratchet.
	it("leaves a one-off chunk failure as a warning when the rerun is green", () => {
		const verdict = judgeCensus({
			records: withChunks(confirm(202, A, []), rerunOf(chunk202, [])),
			ratchet: [],
		});
		expect(verdict.members).toEqual([]);
		expect(verdict.code).toBe(0);
		expect(verdict.lines).toContain(
			"warning: load flake, green alone and on a rerun of the chunk: 202|tests/a.test.ts|t1",
		);
	});

	// Recurrence (F3, #4423 review r1): cross-file state (B leaves something A
	// reads) is invisible to a single-file run, and "not reproducible alone"
	// exited 0. A chunk failure that repeats on a rerun is a member.
	it("reds a chunk failure that repeats on a rerun and is green alone, as cross-file", () => {
		const verdict = judgeCensus({
			records: withChunks(
				confirm(202, A, []),
				rerunOf(chunk202, [member(A, "t1")]),
			),
			ratchet: [],
		});
		expect(verdict.code).toBe(1);
		expect(verdict.members.map((row) => row.kind)).toEqual(["cross-file"]);
		expect(verdict.lines).toContain(
			"new cross-file member: tests/a.test.ts (202: t1 (Error: boom))",
		);
		// Listed, the same file is quiet.
		expect(
			judgeCensus({
				records: withChunks(
					confirm(202, A, []),
					rerunOf(chunk202, [member(A, "t1")]),
				),
				ratchet: listed(A),
			}).code,
		).toBe(0);
	});

	// Recurrence: judging before the rerun ran would call a cross-file failure
	// clean or a flake a member; it is unproven until the rerun is on record.
	it("is unproven (3) while a green-alone chunk member has not been rerun", () => {
		const verdict = judgeCensus({
			records: withChunks(confirm(202, A, [])),
			ratchet: listed(A),
		});
		expect(verdict.code).toBe(3);
		expect(verdict.stale).toEqual([]);
		expect(verdict.lines).toContain(
			"green alone, chunk not rerun yet: 202|tests/a.test.ts|t1",
		);
	});

	// Recurrence: judging before the confirm pass ran would pass a load flake
	// or red a real member as "new"; it is unproven until confirmed.
	it("is unproven (3), not clean, while a shuffled member is unconfirmed", () => {
		const verdict = judgeCensus({
			records: withChunks(),
			ratchet: listed(A),
		});
		expect(verdict.code).toBe(3);
		expect(verdict.stale).toEqual([]);
		expect(verdict.lines).toContain(
			"not confirmed yet: 202|tests/a.test.ts|t1",
		);
	});

	// Recurrence: a file that fails alone fails under every seed; listing it
	// four times (alone plus 3 seeds) is noise the fixer clears four times.
	it("reports a file that fails alone once, with the alone rows", () => {
		const verdict = judgeCensus({
			records: [
				record("alone", [A], [member(A, "t1", "Error: no oxfmt")]),
				chunk202,
				confirm(202, A, [member(A, "t1")]),
			],
			ratchet: [],
		});
		expect(verdict.members.map((row) => `${row.seed}|${row.kind}`)).toEqual([
			"alone|fails alone",
		]);
		expect(verdict.code).toBe(1);
		expect(verdict.lines).toEqual([
			"fails alone: tests/a.test.ts (alone: t1 (Error: no oxfmt))",
		]);
	});

	// Recurrence (N1, #4423 verify r2): a census part that died left its starts
	// unrecorded, and the report judged only what was on disk. A confirmed new
	// member is still red when other starts are missing (exit 1 outranks 3).
	it("stays red for a confirmed new member while planned starts are missing", () => {
		const plan = planCensus([A, B], { chunk: 1, alone: false });
		const recorded = plan[0] as (typeof plan)[number];
		const verdict = judgeCensus({
			records: [
				record(202, recorded.files, [member(A, "t1")], {
					key: reproCommand(recorded),
				}),
				confirm(202, A, [member(A, "t1")]),
			],
			ratchet: [],
			planned: plan,
		});
		expect(verdict.code).toBe(1);
		expect(verdict.lines).toContain(
			"not run: 3 of 4 planned start(s) have no record (shuffle seed 202 chunk 2/2; shuffle seed 424 chunk 1/2; shuffle seed 424 chunk 2/2)",
		);
	});

	// Recurrence #4518: the planned-start check delegates to assertEvaluated,
	// which rejects a floor of 0; an empty plan (nothing planned, nothing
	// missing) must stay a clean judgement, not a TypeError.
	it("judges an empty plan clean instead of throwing", () => {
		const verdict = judgeCensus({ records: [], ratchet: [], planned: [] });
		expect(verdict.code).toBe(0);
		expect(verdict.lines.some((line) => line.startsWith("not run:"))).toBe(
			false,
		);
	});

	// Recurrence: a hung or uncollected start proves nothing about its files.
	it("is unproven when a start timed out or was never collected", () => {
		for (const verdict of ["timeout", "uncollected"] as const) {
			const result = judgeCensus({
				records: [record(202, [A], [], { verdict })],
				ratchet: [],
			});
			expect(result.code).toBe(3);
		}
	});

	// Recurrence: a red start with no parsable failing test (a worker crash)
	// read as green would hide the very crash it exists to find.
	it("is unproven when a start is red and names no failing test", () => {
		const result = judgeCensus({
			records: [record(202, [A], [], { verdict: "red" })],
			ratchet: [],
		});
		expect(result.code).toBe(3);
	});
});

/** The author `gh issue list --json author` reports for a workflow's issue. */
const BOT = { login: "app/github-actions" };

describe("the tracking issue", () => {
	const A = "tests/a.test.ts";
	const TITLE = "nightly: shuffle census (order-dependent test files)";

	// Recurrence: the two-night rule needs last night's stale files; they ride
	// in the rolling issue's body, and an unrelated issue must not supply them.
	it("reads last night's stale files from the issue with the exact title", () => {
		const issues = JSON.stringify([
			{
				title: "other",
				body: "<!-- shuffle-census-stale: tests/x.test.ts -->",
				author: BOT,
			},
			{
				title: TITLE,
				body: "text\n<!-- shuffle-census-stale: tests/a.test.ts,tests/b.test.ts -->\n",
				author: BOT,
			},
		]);
		expect(previousStaleFrom(issues, TITLE)).toEqual([
			"tests/a.test.ts",
			"tests/b.test.ts",
		]);
		expect(previousStaleFrom("[]", TITLE)).toEqual([]);
		expect(
			previousStaleFrom(
				JSON.stringify([{ title: TITLE, body: "no marker", author: BOT }]),
				TITLE,
			),
		).toEqual([]);
	});

	// Recurrence (#4423 verify r2): a hand-written marker forced the second-night
	// red, and a decoy issue with the same title, listed first, hid the real
	// one. Only the issue the workflow wrote counts.
	it("reads the marker only from the issue the workflow wrote", () => {
		const forged = {
			title: TITLE,
			body: "<!-- shuffle-census-stale: tests/forged.test.ts -->",
			author: { login: "someone" },
		};
		const real = {
			title: TITLE,
			body: "<!-- shuffle-census-stale: tests/a.test.ts -->",
			author: BOT,
		};
		expect(previousStaleFrom(JSON.stringify([forged]), TITLE)).toEqual([]);
		expect(previousStaleFrom(JSON.stringify([forged, real]), TITLE)).toEqual([
			"tests/a.test.ts",
		]);
	});

	// Recurrence: the body is what the next night reads back; a stale file
	// missing from the marker would never reach the second night.
	it("writes a stale marker the next night reads back", () => {
		const verdict = judgeCensus({
			records: [record(202, [A], []), record(424, [A], [])],
			ratchet: listed(A),
		});
		const body = issueBody(verdict, { runUrl: "https://example.test/run/1" });
		expect(body).toContain(`<!-- shuffle-census-stale: ${A} -->`);
		expect(body).toContain("https://example.test/run/1");
		expect(
			previousStaleFrom(
				JSON.stringify([{ title: TITLE, body, author: BOT }]),
				TITLE,
			),
		).toEqual([A]);
	});
});

describe("run (report and arguments)", () => {
	const A = "tests/a.test.ts";
	const TITLE = "nightly: x";
	/** A census start of `files` under `seed`, keyed the way runCensus keys it. */
	const planned = (
		seed: number,
		files: string[],
		members: Member[],
	): CensusRecord =>
		record(seed, files, members, {
			key: reproCommand(
				planRuns(files, [seed], { alone: false })[0] as Parameters<
					typeof reproCommand
				>[0],
			),
		});
	function reportDir(name: string, records: CensusRecord[], members: unknown) {
		const dir = scratchDir(name);
		const out = path.join(dir, "out");
		fs.mkdirSync(out);
		fs.writeFileSync(
			path.join(out, "census.0-of-1.jsonl"),
			`${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
		);
		fs.writeFileSync(
			path.join(dir, "ratchet.json"),
			JSON.stringify({ members }),
		);
		return {
			dir,
			args: [
				"--out",
				out,
				"--report",
				"--cwd",
				dir,
				"--ratchet",
				"ratchet.json",
				"--files",
				A,
				"--no-alone",
			],
		};
	}

	// Recurrence: the exit code is what the nightly job reads; a report that
	// prints the members but exits 0 turns the ratchet into a log line.
	it("--report exits 1 for a member file beyond the ratchet and 0 once it is listed", () => {
		const records = [
			planned(202, [A], [member(A, "t1")]),
			planned(424, [A], []),
			confirm(202, A, [member(A, "t1")]),
		];
		const { dir, args } = reportDir("report", records, []);
		const lines: string[] = [];
		expect(run(args, { log: (line) => lines.push(line) })).toBe(1);
		expect(lines.join("\n")).toContain(
			"new order-dependent member: tests/a.test.ts",
		);
		fs.writeFileSync(
			path.join(dir, "ratchet.json"),
			JSON.stringify({ members: listed(A) }),
		);
		expect(run(args, { log: quiet })).toBe(0);
	});

	// Recurrence: a stale file must reach tomorrow's report. --stale-out and
	// --body-out are the only channel; --previous-issues feeds it back.
	it("--report carries a stale file through the body to the second night's red", () => {
		const { dir, args } = reportDir(
			"stale",
			[planned(202, [A], []), planned(424, [A], [])],
			listed(A),
		);
		const staleOut = path.join(dir, "stale.txt");
		const bodyOut = path.join(dir, "body.md");
		expect(
			run([...args, "--stale-out", staleOut, "--body-out", bodyOut], {
				log: quiet,
			}),
		).toBe(4);
		expect(fs.readFileSync(staleOut, "utf8").trim()).toBe(A);
		const issues = path.join(dir, "issues.json");
		fs.writeFileSync(
			issues,
			JSON.stringify([
				{ title: TITLE, body: fs.readFileSync(bodyOut, "utf8"), author: BOT },
			]),
		);
		expect(
			run([...args, "--previous-issues", issues, "--title", TITLE], {
				log: quiet,
			}),
		).toBe(1);
	});

	// Recurrence (N1, #4423 verify r2): an empty record dir reported "exit 0
	// (clean)" and the writer closed the tracking issue; one seed's records
	// judged the ratchet on one seed and called a listed file stale. The report
	// plans the census again: every planned start with no record is unproven.
	it("--report is unproven, never clean or stale, when planned starts have no record", () => {
		const empty = reportDir("n1-empty", [], listed(A));
		const lines: string[] = [];
		expect(run(empty.args, { log: (line) => lines.push(line) })).toBe(3);
		expect(lines).toContain(
			"[census] not run: 2 of 2 planned start(s) have no record (shuffle seed 202 chunk 1/1; shuffle seed 424 chunk 1/1)",
		);
		const oneSeed = reportDir(
			"n1-one-seed",
			[planned(202, [A], [])],
			listed(A),
		);
		const staleOut = path.join(oneSeed.dir, "stale.txt");
		expect(
			run([...oneSeed.args, "--stale-out", staleOut], { log: quiet }),
		).toBe(3);
		expect(fs.readFileSync(staleOut, "utf8").trim()).toBe("");
		// The same plan fully recorded is the stale-only exit 4.
		const full = reportDir(
			"n1-full",
			[planned(202, [A], []), planned(424, [A], [])],
			listed(A),
		);
		expect(run(full.args, { log: quiet })).toBe(4);
	});

	// Recurrence (N1, #4423 verify r2): the census job's own result is the
	// second witness. A part that failed after its records were written is
	// still not a clean census.
	it("--report is unproven when the census job did not succeed", () => {
		const { args } = reportDir(
			"n1-result",
			[planned(202, [A], []), planned(424, [A], [])],
			[],
		);
		expect(run([...args, "--census-result", "success"], { log: quiet })).toBe(
			0,
		);
		const lines: string[] = [];
		expect(
			run([...args, "--census-result", "failure"], {
				log: (line) => lines.push(line),
			}),
		).toBe(3);
		expect(lines).toContain("[census] census job result: failure");
	});

	// Recurrence (G2, #4423 verify r2): a dispatch input reached vitest's argv
	// unchecked, so `--files --config=/tmp/x.ts` planned a vitest flag.
	it("refuses --files entries that are not test paths", () => {
		expect(() =>
			parseArgs([
				"--out",
				".",
				"--files",
				"--config=/tmp/x.ts,tests/a.test.ts",
			]),
		).toThrow(/test paths .*never a flag: --config=\/tmp\/x\.ts$/);
		expect(() =>
			parseArgs(["--out", ".", "--files", "tests/fixtures/x.test.ts"]),
		).toThrow(/never a flag/);
		expect(parseArgs(["--out", ".", "--files", A]).files).toEqual([A]);
		const errors: string[] = [];
		const original = console.error;
		console.error = (line: string) => errors.push(String(line));
		try {
			expect(
				run(["--out", scratchDir("g2"), "--files", "-t,tests/a.test.ts"], {
					log: quiet,
				}),
			).toBe(2);
		} finally {
			console.error = original;
		}
		expect(errors.join("\n")).toContain("never a flag: -t");
	});

	// Recurrence: `--part 3/3` would select no start and report a clean census.
	it("rejects a part index outside k/n and a missing --out", () => {
		expect(() => parseArgs(["--out", ".", "--part", "3/3"])).toThrow(/k < n/);
		expect(() => parseArgs(["--part", "0/3"])).toThrow(/--out is required/);
		expect(parseArgs(["--out", ".", "--part", "2/3"]).part).toEqual([2, 3]);
		expect(() => parseArgs(["--out", ".", "--previous-issues", "x"])).toThrow(
			/--title/,
		);
	});

	// Recurrence: the nightly passes --no-alone; if run() dropped the option
	// on the way to the planner the daily pass would spend 37% of its runner
	// minutes on alone starts that find nothing.
	it("--no-alone reaches the plan: only shuffled starts run", () => {
		const dir = scratchDir("noalone");
		const flags: string[][] = [];
		const exec: ExecVitest = (start) => {
			flags.push([...start.flags]);
			return { status: 0, output: "", timedOut: false };
		};
		const base = [
			"--cwd",
			dir,
			"--files",
			`${A},tests/b.test.ts`,
			"--seeds",
			"202",
		];
		expect(
			run(["--out", path.join(dir, "o1"), ...base, "--no-alone"], {
				exec,
				log: quiet,
				distExists: () => true,
			}),
		).toBe(0);
		expect(flags.map((entry) => entry.length > 0)).toEqual([true]);
		flags.length = 0;
		run(["--out", path.join(dir, "o2"), ...base], {
			exec,
			log: quiet,
			distExists: () => true,
		});
		expect(flags.filter((entry) => entry.length === 0)).toHaveLength(2);
	});

	// Recurrence (F5): a census on a tree without dist/ reds the LSP fixture
	// tests inside whichever chunk holds them, and the members it prints are
	// the missing build, not order dependence. It refuses to start instead.
	it("refuses to start without dist/, with a message that names the build", () => {
		const dir = scratchDir("nodist");
		const started: string[] = [];
		const errors: string[] = [];
		const original = console.error;
		console.error = (line: string) => errors.push(String(line));
		try {
			const code = run(
				["--out", path.join(dir, "out"), "--cwd", dir, "--files", A],
				{
					exec: (start) => {
						started.push(start.files.join(","));
						return { status: 0, output: "", timedOut: false };
					},
					log: quiet,
					distExists: () => false,
				},
			);
			expect(code).toBe(2);
		} finally {
			console.error = original;
		}
		expect(started).toEqual([]);
		expect(errors.join("\n")).toContain("npm run build:dist");
	});
});

describe("the ratchet file", () => {
	const ROOT = path.resolve(import.meta.dirname, "../..");
	const parsed = JSON.parse(
		fs.readFileSync(
			path.join(ROOT, "scripts/shuffle-census-ratchet.json"),
			"utf8",
		),
	) as {
		members: Array<{ file: string; seam: string; seed: number; test: string }>;
		byDesign: Array<{ file: string; describe: string; reason: string }>;
	};
	const SEAMS = new Set([
		"declaration-order",
		"index-activation-state",
		"lsp-real-server-timing",
		"module-latch-singleton",
		"once-per-session-sink",
		"persisted-graph-store",
		"tree-sitter-wasm-state",
	]);
	// The ratchet's size, pinned both ways: adding a file raises it (a reviewer
	// sees a new order-dependent file admitted), fixing one lowers it. Lower
	// this number in the PR that fixes a file; never raise it to admit a new
	// one without a named seam and an issue.
	const PINNED_FILES = 0;
	// The by-design exemptions (#4561 D1), pinned the same way: a new one is a
	// reviewable admission, never a quiet opt-out.
	const PINNED_BY_DESIGN = 3;

	// Recurrence: a ratchet that grows silently (the point of #4405 is that it
	// can only shrink).
	it("holds exactly the pinned number of files", () => {
		expect(parsed.members).toHaveLength(PINNED_FILES);
	});

	// Recurrence: an entry for a deleted or renamed file can never reproduce,
	// so the census would warn "delete it" every night; one whose example case
	// was renamed sends the fixer to a test that is gone (F4, review r1).
	it("names existing files, a known seam and an example case still in the file, once each", () => {
		const seen = new Set<string>();
		for (const item of parsed.members) {
			const file = path.join(ROOT, item.file);
			expect(fs.existsSync(file), item.file).toBe(true);
			expect([...SEEDS], `${item.file} seed`).toContain(item.seed);
			expect(SEAMS.has(item.seam), `${item.file} seam ${item.seam}`).toBe(true);
			expect(seen.has(item.file), `duplicate ${item.file}`).toBe(false);
			seen.add(item.file);
			if (item.test === "(file)") continue;
			const name = item.test.split(" > ").at(-1) ?? "";
			expect(name.length, `${item.file} test`).toBeGreaterThan(0);
			expect(
				fs.readFileSync(file, "utf8").includes(name),
				`${item.file}: example case not found: ${name}`,
			).toBe(true);
		}
	});

	// Recurrence: the files this PR fixed must not come back as ratchet entries
	// (a copied-in stale list would hide a re-break behind an admission).
	it("does not list the files fixed at their cause", () => {
		const listedFiles = new Set(parsed.members.map((item) => item.file));
		expect(listedFiles.has("tests/index-integration.test.ts")).toBe(false);
		expect(listedFiles.has("tests/config/tmp-fixture-hygiene.test.ts")).toBe(
			false,
		);
		expect(listedFiles.has("tests/clients/bounded-pid-file-lock.test.ts")).toBe(
			false,
		);
		expect(
			listedFiles.has(
				"tests/clients/dispatch/runners/tree-sitter-runner.test.ts",
			),
		).toBe(false);
		// #4561: the three L8 files fixed at their cause. The three by-design
		// files are covered below, where the registry refuses a row that is also
		// a ratchet member (their paths stay out of this file: the lsp-spawn-heavy
		// census reads a fixture-name marker out of strings).
		for (const file of [
			"tests/clients/io-bridge.test.ts",
			"tests/index-process-bridge-registration.test.ts",
			"tests/packaging-pack-manifest.test.ts",
		])
			expect(listedFiles.has(file), file).toBe(false);
	});

	// #4561 D1: a `describe` whose subject IS the order its cases run in opts
	// out with the one admitted spelling — a literal options object holding only
	// that key, set to literal false — and is registered here: never a whole
	// file, and never an unregistered opt-out a later reader cannot see the
	// reason for. A row is only worth keeping while the describe it names still
	// runs, so the audit reads liveness too (#4611 review r1 LOW-4: a registered
	// suite wrapped in `describe.skip` kept its row valid while the run included
	// none of it).
	it("holds exactly the pinned number of by-design exemptions, each a live describe that opts out", () => {
		expect(parsed.byDesign).toHaveLength(PINNED_BY_DESIGN);
		const members = new Set(parsed.members.map((item) => item.file));
		const seen = new Set<string>();
		for (const row of parsed.byDesign) {
			const key = `${row.file}::${row.describe}`;
			expect(seen.has(key), `duplicate ${key}`).toBe(false);
			seen.add(key);
			// A registered exemption is clean by construction; listing it in the
			// ratchet as well would ask the nightly for a fix that is not one.
			expect(members.has(row.file), `${key} also a ratchet member`).toBe(false);
			const file = path.join(ROOT, row.file);
			expect(fs.existsSync(file), row.file).toBe(true);
			expect(
				vitestCollects(row.file),
				`${key} is collected by a vitest project`,
			).toBe(true);
			expect(row.reason.length, `${key} reason`).toBeGreaterThanOrEqual(40);
			const audit = auditShuffleOptOuts(fs.readFileSync(file, "utf8"));
			expect(audit.admitted, `${key} opts out from a live describe`).toContain(
				row.describe,
			);
			expect(
				audit.findings.map((finding) => finding.message),
				`${key} raises no finding`,
			).toEqual([]);
		}
	});

	// #4611 review r3 LOW-1: the population predicate itself is asserted, because
	// a census that reads no `.test.tsx` is green while the opt-out ships. The
	// witness is the path list, not a count: an extension this repo collects and
	// one it does not, beside a support module vitest never loads.
	it("reads the tracked files a vitest project collects, not one extension", () => {
		expect(
			shuffleCensusPopulation([
				"tests/scripts/ci-shuffle-census.test.ts",
				"tests/synthetic.test.tsx",
				"tests/support/shuffle-opt-out-scan.ts",
			]),
		).toEqual([
			"tests/scripts/ci-shuffle-census.test.ts",
			"tests/synthetic.test.tsx",
		]);
	});

	// The other direction, and the reason this is a sweep rather than a list: an
	// unregistered opt-out, or an option key the audit cannot attribute, reds
	// instead of passing unclassified (AGENTS.md shape 69). #4611 review r1 M2:
	// the first version read a fixed spelling set off blanked source, so a
	// quoted key, a computed key, an options object bound in a non-test module,
	// and a spread each passed. Review r2 (#4616) replaced that text census with
	// a parsed-AST read; review r3 closed its fail-open (an options object is a
	// sequence, and a callee resolves through aliases).
	//
	// The population is every tracked file under `tests/` that a vitest project
	// COLLECTS, asked of the shared collection owner rather than spelled as one
	// extension (#4611 review r3 LOW-1: `endsWith(".ts")` drops `.mts`, `.cts`,
	// `.tsx` and the JS extensions vitest collects, so a `.test.tsx` opt-out was
	// invisible). No file of those extensions holds an opt-out today; the
	// predicate keeps that from changing silently.
	//
	// The read costs a full parse of that tree on every run: measured 3.6-3.9 s
	// over 1,520 collected files (~24 MB), so the case carries a budget of its
	// own instead of the 5 s default. One line about the axis that grows:
	// `oxc-parser.parseSync` retains ~500 MB of RSS per pass in one process
	// (measured 575-660 MB for the single pass here), so a second whole-tree
	// consumer must not share this process; the 60 s budget is ~9-15x the
	// observed cost and a blow-up reds rather than passing.
	it(
		"registers every describe that opts out of shuffle, and reads every other spelling as a finding",
		{ timeout: scaledTestTimeout(60_000) },
		() => {
			const registered = new Set(
				parsed.byDesign.map((row) => `${row.file}::${row.describe}`),
			);
			const files = shuffleCensusPopulation(listTrackedFiles(ROOT, ["tests"]));
			assertNonEmptyScan(
				"tracked test files under tests/ that a vitest project collects, scanned for shuffle opt-outs",
				files.length,
				1000,
			);
			const census = censusShuffleOptOuts(
				files.map((file) => ({
					file,
					source: fs.readFileSync(path.join(ROOT, file), "utf8"),
				})),
			);
			expect(judgeShuffleOptOuts(census, registered)).toEqual([]);
		},
	);

	// #4611 review r1 M2/M3, r2 M-a/M-b, r3 MEDIUM-1: the gate's population branch
	// had no failing witness (deleting its count assertion left the suite green),
	// three spellings vitest honours passed it, and the text census behind it read
	// string contents and types as code. Each plant is a source the same census
	// and judgement read; a plant that stops red means the branch that should
	// have caught it is gone, and the no-finding controls (a harmless string, a
	// type literal, a readable opt-in) keep a text census from coming back.
	// Every red plant also names a fragment of its finding's MESSAGE
	// (`expectedReason`), because a count-only assertion let two branches that
	// only reword a neighbour's finding be deleted with the suite still green
	// (review r3 LOW-3: P4 shorthand and P10 accessor).
	// The state table in PR #4611 lists every admitted form.
	describe("planted spellings of the shuffle option (#4611 review r1, r2, r3)", () => {
		const plants = (
			JSON.parse(
				fs.readFileSync(
					path.join(ROOT, "tests/fixtures/shuffle-opt-out-plants.json"),
					"utf8",
				),
			) as {
				plants: Array<{
					name: string;
					why: string;
					measuredAs: "pass" | "red";
					expectedFindings: number;
					expectedOptOuts: number;
					expectedReason?: string;
					source: string;
				}>;
			}
		).plants;
		const censusOf = (source: string) =>
			censusShuffleOptOuts([{ file: "plant.ts", source }]);

		it("covers the admitted spellings and every refused one", () => {
			expect(
				plants
					.filter((plant) => plant.measuredAs === "pass")
					.map((plant) => plant.name),
			).toEqual([
				"accepted",
				"harmless-string",
				"type-literal",
				"literal-true-opt-in",
				"opt-in-elsewhere",
			]);
			expect(plants.filter((plant) => plant.measuredAs === "red")).toHaveLength(
				25,
			);
			expect(
				plants.every((plant) => plant.why.length >= 40),
				"every plant says why the gate must see it",
			).toBe(true);
			expect(
				plants
					.filter((plant) => plant.measuredAs === "red")
					.filter((plant) => (plant.expectedReason ?? "").length < 20),
				"every red plant pins the finding's reason, not only its count",
			).toEqual([]);
		});

		for (const plant of plants) {
			it(`reads ${plant.name} as ${plant.measuredAs}: ${plant.why}`, () => {
				const census = censusOf(plant.source);
				expect(census.findings, plant.name).toHaveLength(
					plant.expectedFindings,
				);
				expect(census.optedOut.size, plant.name).toBe(plant.expectedOptOuts);
				if (plant.expectedReason !== undefined)
					expect(
						census.findings.some((finding) =>
							finding.includes(plant.expectedReason as string),
						),
						`${plant.name}: the finding says why (${plant.expectedReason})`,
					).toBe(true);
				const registered = plant.measuredAs === "pass" ? census.optedOut : [];
				expect(
					judgeShuffleOptOuts(census, registered),
					`${plant.name}: the judgement reds exactly what the audit found`,
				).toHaveLength(plant.expectedFindings);
			});
		}

		it("names both registry directions, so a row that outlives its describe reds", () => {
			const census = censusOf(
				plants.find((plant) => plant.name === "accepted")?.source ?? "",
			);
			const key = [...census.optedOut][0] as string;
			expect(judgeShuffleOptOuts(census, [])).toEqual([
				`${key}: opts out of shuffle but is not registered`,
			]);
			expect(
				judgeShuffleOptOuts(census, [key, "tests/gone.test.ts::gone"]),
			).toEqual([
				"tests/gone.test.ts::gone: registered, but no live describe in that file opts out",
			]);
		});
	});
});

// Recurrence (#4490 M2): the census issue body is the first real caller of
// escapeMarkdownCell. A no-op escaper left the helper suite green, so each
// caller pins its exact row, through the real issueBody.
describe("issueBody table cells (#4490)", () => {
	it("writes a pipe and a backslash-before-pipe in the test and error cells escaped", () => {
		const verdict = {
			code: 1 as const,
			kind: "red" as const,
			lines: [],
			stale: [],
			members: [
				{
					file: "tests/a.test.ts",
					kind: "order-dependent" as const,
					seed: 202 as const,
					test: "a|b",
					firstError: "x\\|y",
				},
			],
		};
		const body = issueBody(verdict);
		expect(body).toContain(
			"| `tests/a.test.ts` | order-dependent | 202 | a\\|b | x\\\\\\|y |",
		);
	});
});
