// flake-shape: real-process-spawn — the committed CLI's exit code is what makes the CI step advisory, and only the child's process status shows it; runCli's return value is a different contract.
// Slice: #5311 flags the tests whose CI duration already spent most of the
// timeout that would have killed them. Entry point is `runCli`, the same
// function the `if (isMainModule)` wrapper calls, plus one real child process
// witness for the process-level exit code. No mock replaces the reader, the
// fold, or the baseline: fixtures are real source files and real report JSON.
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../../scripts/check-test-timeout-headroom.mjs";
import {
	assessReports,
	baselineEntries,
	DEFAULT_TEST_TIMEOUT_MS,
	fileDefaultMs,
	fileFloorMs,
	indexTestFile,
	loadBaseline,
	parseTestReport,
	resolveCap,
} from "../../scripts/lib/test-timeout-headroom.mjs";
import { expectPlantedStaleRow } from "../support/baseline-staleness.js";
import { scaledTestTimeout } from "../support/test-timeout-scale.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const CLI = join(ROOT, "scripts/check-test-timeout-headroom.mjs");

/** An assertion row of a Vitest JSON report. */
type Assertion = {
	title: string;
	ancestors?: string[];
	status?: string;
	duration?: number;
};

const dir = mkdtempSync(join(tmpdir(), "pi-lens-5311-"));
const at = (rel: string) => join(dir, rel);

/** Write `<file>` under the fixture root and return its repo-relative path. */
function source(rel: string, body: string): string {
	const file = at(rel);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, body);
	return rel;
}

/**
 * Create `<rel>` as a directory under the fixture root and return its path.
 * Every case calls this for the directories it writes into, so no case depends
 * on a directory an earlier one happened to create (the shuffled-seed reds).
 */
function dirAt(rel: string): string {
	const path = at(rel);
	mkdirSync(path, { recursive: true });
	return path;
}

/**
 * Write `text` to `<rel>` under the fixture root, creating its parent, and
 * return the path. The bare `writeFileSync` would lean on whichever earlier
 * case happened to create the directory.
 */
function writeJson(rel: string, text: string): string {
	const file = at(rel);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text);
	return file;
}

/** Write a one-file Vitest JSON report and return its path. */
function report(rel: string, file: string, assertions: Assertion[]): string {
	const path = at(rel);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(
		path,
		JSON.stringify({
			testResults: [
				{
					name: at(file),
					assertionResults: assertions.map((a) => ({
						title: a.title,
						ancestorTitles: a.ancestors ?? [],
						status: a.status ?? "passed",
						duration: a.duration,
					})),
				},
			],
		}),
	);
	return path;
}

/** Run the CLI against the fixture root and capture every logged line. */
function run(args: string[]): { code: number; lines: string[] } {
	const lines: string[] = [];
	const code = runCli(["--root", dir, ...args], {
		log: (line: string) => lines.push(line),
	});
	return { code, lines };
}

const summary = (lines: string[]) =>
	lines.find(
		(line) =>
			line.startsWith("timeout-headroom: ") && line.includes("tests read"),
	) ?? "";

/**
 * The emitted offender rows of a run (`NEW` for one outside the baseline,
 * `known` for one inside it), without the annotations that repeat their text.
 */
const rowLines = (lines: string[], file?: string) =>
	lines.filter(
		(line) =>
			/^(?:NEW|known) {2}\S/.test(line) &&
			(file === undefined || line.includes(file)),
	);

describe("scripts/check-test-timeout-headroom.mjs (#5311)", () => {
	beforeAll(() => {
		// The issue's motivating shape: a suite that declares a 30 s budget and a
		// test that spent 29.6 s of it. The sibling stays at half the budget.
		source(
			"tests/near/timeout-near.test.ts",
			`import { describe, it } from "vitest";

const CAP_MS = 30_000;

describe("session-fact bound", () => {
	it("runs at the timeout", { timeout: CAP_MS }, async () => {});
	it("runs at half the timeout", async () => {}, CAP_MS / 2);
});
`,
		);
		source(
			"tests/inherited/describe-timeout.test.ts",
			`import { describe, it } from "vitest";

describe("suite budget", { timeout: 12_000 }, () => {
	it("inherits the suite budget", async () => {});
	it("overrides it", async () => {}, 2_000);
});
`,
		);
		source(
			"tests/setconfig/vitest-set-config.test.ts",
			`import { it, vi } from "vitest";

vi.setConfig({ testTimeout: 9_000 });

it("runs under the file config", async () => {});
`,
		);
		source(
			"tests/default/no-declaration.test.ts",
			`import { it } from "vitest";

it("has no declared budget", async () => {});
`,
		);
		source(
			"tests/scaled/scaled-timeout.test.ts",
			`import { it } from "vitest";
import { scaledTestTimeout } from "../../tests/support/test-timeout-scale.js";

it("runs under a scaled budget", async () => {}, scaledTestTimeout(10_000));
`,
		);
		source(
			"tests/unresolved/dynamic-timeout.test.ts",
			`import { it } from "vitest";

function pickMs(): number {
	return 60_000;
}

it("has a budget the fold cannot reach", { timeout: pickMs() }, async () => {});
`,
		);
		// The same reader from the other side: here nothing in the file folds, so the
		// cap and the floor are both missing and the row cannot be judged at all.
		source(
			"tests/setconfig-unresolved/dynamic-config.test.ts",
			`import { it, vi } from "vitest";

function pickMs(): number {
	return 60_000;
}

vi.setConfig({ testTimeout: pickMs() });

it("ran under the config the fold cannot reach", async () => {});
`,
		);
		// Comments are named nodes in the tree, so a comment inside a test call is
		// the one thing that can sit in an argument slot without being an argument.
		source(
			"tests/comment/gated.test.ts",
			`import { it } from "vitest";

it("has a comment before its handler", /* ci-only gate */ async () => {}, 2_000);

it("has a comment inside its options", {
	timeout: /* widened on the cold cache */ 2_000,
}, async () => {});
`,
		);
		// Two budgets of one file folded through the same imported constant: the
		// second fold reuses the cached table, so an import budget kept on the table
		// would starve it.
		source("tests/imported/caps.ts", `export const CAP_MS = 2_000;\n`);
		source(
			"tests/imported/shared-cap.test.ts",
			`import { it } from "vitest";
import { CAP_MS } from "./caps.js";

it("first test on the shared cap", async () => {}, CAP_MS);
it("second test on the shared cap", async () => {}, CAP_MS);
`,
		);
		// The options object as a name the file declares: 16 declarations of this
		// shape folded 5000 on a real run against a real 180_000, so the cap of a
		// named options object is read from the binding, and a binding declared below
		// the test still counts (r1 CR2).
		source(
			"tests/named-options/named.test.ts",
			`import { it } from "vitest";

const LANE_OPTIONS = { timeout: 180_000 };

it("runs under a named options object", LANE_OPTIONS, async () => {});
it("runs under options declared below it", LATER_OPTIONS, async () => {});

const LATER_OPTIONS = { timeout: 40_000 };
`,
		);
		// One name with two values: which assignment ran decides the cap, so nothing
		// is provable and the fold must not take whichever initializer came first.
		source(
			"tests/named-options/reassigned.test.ts",
			`import { it } from "vitest";

let OPTION_BAG = { timeout: 40_000 };
OPTION_BAG = { retry: 2 };

it("runs under a reassigned options name", OPTION_BAG, async () => {});
`,
		);
		// A spread written after the pair can overwrite the declared budget, so that
		// pair is not the cap either.
		source(
			"tests/named-options/spread-after.test.ts",
			`import { it } from "vitest";

const WIDE = { timeout: 40_000, ...extraOptions() };

it("runs under options a spread can overwrite", WIDE, async () => {});

function extraOptions() {
	return {};
}
`,
		);
		// `vi.setConfig` inside a hook is not the file's default: vitest reads the
		// config while it collects the module, so the tests here ran on the 5000 ms
		// default while the fold reported 90_000 (r1 F5).
		source(
			"tests/setconfig-nested/hook-config.test.ts",
			`import { beforeEach, it, vi } from "vitest";

beforeEach(() => {
	vi.setConfig({ testTimeout: 90_000 });
});

it("spends most of the default", async () => {});
it("stays inside the default", async () => {});
`,
		);
		// The suite-level budget, in the spelling the runner takes: options before
		// the factory. Probed against the pinned vitest 5.1.0, that shape collects
		// and enforces the budget (a 600 ms test under `{ timeout: 300 }` fails
		// "Test timed out in 300ms"), while options written AFTER the factory are
		// refused on both `describe` and `it` -- the file reports zero tests -- so
		// the fold reads the suite's options from the slot the runner reads (r2 F8).
		source(
			"tests/inherited/describe-tail-options.test.ts",
			`import { describe, it } from "vitest";

describe("suite budget written last", { timeout: 8_000 }, () => {
	it("inherits the tail options budget", async () => {});
});
`,
		);
	});

	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("flags the issue's shape and names the file, the suite, the duration and the cap", () => {
		const file = "tests/near/timeout-near.test.ts";
		const reportFile = report("reports/near.json", file, [
			{
				title: "runs at the timeout",
				ancestors: ["session-fact bound"],
				duration: 29_600,
			},
			{
				title: "runs at half the timeout",
				ancestors: ["session-fact bound"],
				duration: 7_500,
			},
		]);
		const { code, lines } = run([
			"--report",
			reportFile,
			"--baseline",
			at("none.json"),
		]);
		const row = lines.find((line) => line.startsWith("NEW  "));
		expect(row).toBeDefined();
		expect(row).toContain(file);
		expect(row).toContain("session-fact bound > runs at the timeout");
		expect(row).toContain("29600 ms is 99% of the 30000 ms cap");
		// Advisory: a new offender is an annotation, not a red step.
		expect(code).toBe(0);
		expect(lines).toContain(
			"timeout-headroom: advisory mode (exit 0); pass --fail-on-new to block on a new offender",
		);
		// The half-budget sibling stays out of the report entirely.
		expect(lines.join("\n")).not.toContain("runs at half the timeout");
		expect(summary(lines)).toContain(
			"2 tests read, 1 over 60% (0 known, 1 new)",
		);
	});

	it("resolves the cap of the issue's own file, which hard-codes it past the lane scale", () => {
		// #5307: this test spends about 30 s on CI against a 30_000 ms literal, so
		// the lane's `PI_LENS_TEST_TIMEOUT_SCALE=3` does not enlarge its cap. The
		// fold is run on the real in-tree source, not a fixture copy.
		const file = "tests/clients/dispatch/fact-store-session-bound.test.ts";
		const title =
			"stops retaining an early file's delta baseline once a large batch exceeds the session-fact cap";
		const chain = ["FactStore session-fact bound (#2282)"];
		const table = indexTestFile(join(ROOT, file), { scale: 1 });
		expect(resolveCap(table, { chain, title })).toEqual({
			status: "resolved",
			capMs: 30_000,
		});

		const reportFile = writeJson(
			"reports/fact-store.json",
			JSON.stringify({
				testResults: [
					{
						name: join(ROOT, file),
						assertionResults: [
							{
								title,
								ancestorTitles: chain,
								status: "passed",
								duration: 29_600,
							},
						],
					},
				],
			}),
		);
		const lines: string[] = [];
		const code = runCli(
			[
				"--report",
				reportFile,
				"--root",
				ROOT,
				"--baseline",
				at("none.json"),
				"--scale",
				"3",
			],
			{ log: (line: string) => lines.push(line) },
		);
		expect(code).toBe(0);
		expect(summary(lines)).toContain("1 over 60% (0 known, 1 new)");
		expect(lines.join("\n")).toContain("29600 ms is 99% of the 30000 ms cap");
	});

	it("judges a test against the describe budget it inherits, and its own when it declares one", () => {
		const file = "tests/inherited/describe-timeout.test.ts";
		const reportFile = report("reports/inherited.json", file, [
			{
				title: "inherits the suite budget",
				ancestors: ["suite budget"],
				duration: 9_000,
			},
			{ title: "overrides it", ancestors: ["suite budget"], duration: 1_500 },
		]);
		const { lines } = run([
			"--report",
			reportFile,
			"--baseline",
			at("none.json"),
		]);
		expect(summary(lines)).toContain("2 over 60%");
		expect(lines.join("\n")).toContain("9000 ms is 75% of the 12000 ms cap");
		// 1500 of its own 2000 ms cap is over the ratio, judged against the `it`
		// value, never the suite's 12000.
		expect(lines.join("\n")).toContain("1500 ms is 75% of the 2000 ms cap");
	});

	it("takes vi.setConfig's testTimeout as the cap when no declaration carries one", () => {
		const reportFile = report(
			"reports/setconfig.json",
			"tests/setconfig/vitest-set-config.test.ts",
			[{ title: "runs under the file config", duration: 6_300 }],
		);
		const { lines } = run([
			"--report",
			reportFile,
			"--baseline",
			at("none.json"),
		]);
		expect(lines.join("\n")).toContain("6300 ms is 70% of the 9000 ms cap");
	});

	it("falls back to Vitest's 5000 ms default and says so in the row", () => {
		const reportFile = report(
			"reports/default.json",
			"tests/default/no-declaration.test.ts",
			[{ title: "has no declared budget", duration: 4_000 }],
		);
		const { lines } = run([
			"--report",
			reportFile,
			"--baseline",
			at("none.json"),
		]);
		expect(lines.join("\n")).toContain(
			`4000 ms is 80% of the ${String(DEFAULT_TEST_TIMEOUT_MS)} ms cap`,
		);
	});

	it("folds scaledTestTimeout with the scale the suite helper applies to the same env", () => {
		const previous = process.env.PI_LENS_TEST_TIMEOUT_SCALE;
		process.env.PI_LENS_TEST_TIMEOUT_SCALE = "3";
		try {
			// The two parses must agree on the number the run applied: the helper
			// owns the rule, and the script's cap must be the same budget.
			expect(scaledTestTimeout(10_000)).toBe(30_000);
			const reportFile = report(
				"reports/scaled.json",
				"tests/scaled/scaled-timeout.test.ts",
				[{ title: "runs under a scaled budget", duration: 20_000 }],
			);
			const { lines } = run([
				"--report",
				reportFile,
				"--baseline",
				at("none.json"),
			]);
			expect(lines.join("\n")).toContain("20000 ms is 67% of the 30000 ms cap");
		} finally {
			if (previous === undefined) delete process.env.PI_LENS_TEST_TIMEOUT_SCALE;
			else process.env.PI_LENS_TEST_TIMEOUT_SCALE = previous;
		}
	});

	it("reports an unfolded cap against the file floor instead of assuming a budget", () => {
		const reportFile = report(
			"reports/unresolved.json",
			"tests/unresolved/dynamic-timeout.test.ts",
			[{ title: "has a budget the fold cannot reach", duration: 4_000 }],
		);
		const { lines } = run([
			"--report",
			reportFile,
			"--baseline",
			at("none.json"),
		]);
		expect(summary(lines)).toContain(
			"1 with an unresolved cap (timeout-unfoldable 1)",
		);
		// The floor is this file's own smallest resolvable budget -- no declaration
		// resolves, so the default -- and the row names it as the floor, never as a
		// cap the file actually declared.
		expect(lines.join("\n")).toContain(
			"4000 ms is 80% of the cap unresolved (timeout-unfoldable, floor 5000 ms)",
		);
		expect(
			lines.some((line) =>
				line.startsWith("::warning title=test-timeout-headroom::"),
			),
		).toBe(true);
	});

	it("judges no row in a file whose only budget is an unfoldable file config", () => {
		const file = "tests/setconfig-unresolved/dynamic-config.test.ts";
		const reportFile = report("reports/setconfig-unresolved.json", file, [
			{ title: "ran under the config the fold cannot reach", duration: 4_000 },
		]);
		const { lines } = run([
			"--report",
			reportFile,
			"--baseline",
			at("none.json"),
		]);
		// Nothing folds, so there is neither a cap nor a floor to compare against:
		// the run says the test was read and emits no row. Replacing the missing
		// config with the 5000 ms default the file never declares would turn an
		// unmeasured run into a measured offender with a fabricated budget.
		expect(summary(lines)).toContain(
			"1 tests read, 0 over 60% (0 known, 0 new)",
		);
		expect(lines.filter((line) => line.includes("4000 ms"))).toEqual([]);
	});

	it("judges an options bag with no budget against the file floor", () => {
		const file = "tests/named-options/retry-bag.test.ts";
		source(
			file,
			`import { it, vi } from "vitest";

vi.setConfig({ testTimeout: 7_000 });

const RETRY = { retry: 2 };

it("runs on the chain beside a named retry bag", RETRY, async () => {});
it("runs on the chain beside a trailing retry bag", async () => {}, RETRY);
`,
		);
		const reportFile = report("reports/retry-bag.json", file, [
			{
				title: "runs on the chain beside a named retry bag",
				duration: 4_900,
			},
			{
				title: "runs on the chain beside a trailing retry bag",
				duration: 4_900,
			},
		]);
		const { lines } = run([
			"--report",
			reportFile,
			"--baseline",
			at("none.json"),
		]);
		// The slot holds an object, so it is the budget expression, and that object
		// says nothing about a timeout: the cap is unresolved and the row is judged
		// against this file's floor (its own 7000 ms config), counted as unmeasured.
		// The alternative -- quietly adopting the file default as the cap -- would
		// report a budget the declaration never named (r2 F7).
		expect(summary(lines)).toContain(
			"2 tests read, 2 over 60% (0 known, 2 new), 2 with an unresolved cap (timeout-unfoldable 2)",
		);
		expect(lines.join("\n")).toContain(
			"4900 ms is 70% of the cap unresolved (timeout-unfoldable, floor 7000 ms)",
		);
	});

	it("leaves a budget that could only come from a spread unresolved", () => {
		const file = "tests/named-options/spread-only.test.ts";
		source(
			file,
			`import { it, vi } from "vitest";

vi.setConfig({ testTimeout: 7_000 });

const SPREAD = { ...laneOptions() };

it("runs under options this file cannot read", SPREAD, async () => {});

function laneOptions() {
	return { timeout: 120_000 };
}
`,
		);
		const reportFile = report("reports/spread-only.json", file, [
			{ title: "runs under options this file cannot read", duration: 4_900 },
		]);
		const { lines } = run([
			"--report",
			reportFile,
			"--baseline",
			at("none.json"),
		]);
		// The pair lives behind the spread, so the budget is whatever `laneOptions`
		// returns. This is the other half of the object rule: a spread member is
		// where a budget can hide, so the file's own config is not the cap either --
		// it is only the floor the unresolved row is judged against.
		expect(summary(lines)).toContain(
			"1 tests read, 1 over 60% (0 known, 1 new), 1 with an unresolved cap (timeout-unfoldable 1)",
		);
	});

	it("reads the pair of an object whose spread comes first", () => {
		const file = "tests/named-options/spread-before.test.ts";
		source(
			file,
			`import { it } from "vitest";

const LEAD = { ...laneOptions(), timeout: 20_000 };

it("runs under options whose spread comes first", LEAD, async () => {});

function laneOptions() {
	return { retries: 1 };
}
`,
		);
		const reportFile = report("reports/spread-before.json", file, [
			{
				title: "runs under options whose spread comes first",
				duration: 13_000,
			},
		]);
		const { lines } = run([
			"--report",
			reportFile,
			"--baseline",
			at("none.json"),
		]);
		// A spread before the pair cannot overwrite it, so the pair is the cap. A
		// rule that poisoned the object on any spread would lose this row (r2 F7,
		// mutant L3) and report a 20 s test as unmeasured.
		expect(summary(lines)).toContain(
			"1 tests read, 1 over 60% (0 known, 1 new), 0 with an unresolved cap",
		);
		expect(lines.join("\n")).toContain("13000 ms is 65% of the 20000 ms cap");
	});

	it("leaves the file default unresolved when two module-scope configs disagree", () => {
		const file = "tests/setconfig/conflicting-config.test.ts";
		source(
			file,
			`import { it, vi } from "vitest";

vi.setConfig({ testTimeout: 9_000 });
vi.setConfig({ testTimeout: 4_000 });

it("ran under whichever config took effect", async () => {});
`,
		);
		const table = indexTestFile(at(file), { scale: 1 });
		// Vitest applies the last call, but the fold reads the file, not the runner,
		// and a file that sets two different budgets has no single default. Taking
		// the first would judge every test in the file against 9000 ms while the
		// runner killed it at 4000 (r2 F7, mutant L7).
		expect(fileDefaultMs(table)).toEqual({
			ms: undefined,
			reason: "file-timeout-unresolved",
		});
		expect(fileFloorMs(table)).toEqual({
			ms: undefined,
			reason: "file-timeout-unresolved",
		});
	});

	it("leaves the floor unresolved when the file default is unprovable", () => {
		const file = "tests/setconfig-nested/hook-config-explicit.test.ts";
		source(
			file,
			`import { beforeEach, it, vi } from "vitest";

beforeEach(() => {
	vi.setConfig({ testTimeout: 90_000 });
});

it("names its own budget", { timeout: 30_000 }, async () => {});
`,
		);
		const table = indexTestFile(at(file), { scale: 1 });
		// Every declaration here overrides, so the narrowest declared cap would
		// otherwise become the floor -- but the file's own default is unknowable, and
		// a floor this narrow would report a test that had 90 s as a comfortable
		// pass (r2 F7, mutant L8).
		expect(fileFloorMs(table)).toEqual({
			ms: undefined,
			reason: "file-timeout-nested-setConfig",
		});
	});

	it("refuses a ratio outside (0, 1) before judging any row", () => {
		// The CLI checks `--ratio` on its own arm, so this guard is the one every
		// other caller gets: a ratio of 0 flags every test and one of 1 flags none.
		expect(() =>
			assessReports({ reportValues: [], root: dir, ratio: 0 }),
		).toThrow(/fraction in \(0, 1\): 0/);
		expect(() =>
			assessReports({ reportValues: [], root: dir, ratio: 1 }),
		).toThrow(/fraction in \(0, 1\): 1/);
	});

	it("reads scale 1 from a lane env scale of zero or garbage", () => {
		const previous = process.env.PI_LENS_TEST_TIMEOUT_SCALE;
		const reportFile = report(
			"reports/env-scale.json",
			"tests/default/no-declaration.test.ts",
			[{ title: "has no declared budget", duration: 4_000 }],
		);
		try {
			for (const declared of ["0", "-2", "not-a-number"]) {
				process.env.PI_LENS_TEST_TIMEOUT_SCALE = declared;
				const { lines } = run([
					"--report",
					reportFile,
					"--baseline",
					at("none.json"),
				]);
				// A zero or unreadable multiplier must not fold every cap to zero, and
				// the summary says which multiplier it used (r2 F7, mutant C4: the
				// positivity arm of the env parse).
				expect(summary(lines)).toContain(", scale 1");
			}
		} finally {
			if (previous === undefined) delete process.env.PI_LENS_TEST_TIMEOUT_SCALE;
			else process.env.PI_LENS_TEST_TIMEOUT_SCALE = previous;
		}
	});

	it("reads the budget past a comment standing in a test call's argument slot", () => {
		const file = "tests/comment/gated.test.ts";
		const reportFile = report("reports/comment.json", file, [
			{ title: "has a comment before its handler", duration: 4_000 },
			{ title: "has a comment inside its options", duration: 4_000 },
		]);
		const { lines } = run([
			"--report",
			reportFile,
			"--baseline",
			at("none.json"),
		]);
		// Both caps are 2000 ms, so both rows are 200% of their own budget. Read the
		// comment as an argument and the budget is gone, and 4000 ms lands on the
		// file default of 5000 instead: 80%, a different row and a wrong cap.
		expect(summary(lines)).toContain(
			"2 over 60% (0 known, 2 new), 0 with an unresolved cap",
		);
		expect(
			lines.filter(
				(line) =>
					line.startsWith("NEW  ") && line.includes("of the 2000 ms cap"),
			),
		).toHaveLength(2);
		expect(lines.join("\n")).not.toContain("floor");
	});

	it("folds every cap of a file through one imported constant, not just the first", () => {
		const file = "tests/imported/shared-cap.test.ts";
		const table = indexTestFile(at(file), { scale: 1 });
		// One cached table, two resolutions: the import budget belongs to a single
		// fold, so the second test's cap still resolves to the imported constant.
		for (const title of [
			"first test on the shared cap",
			"second test on the shared cap",
		]) {
			expect(resolveCap(table, { chain: [], title })).toEqual({
				status: "resolved",
				capMs: 2_000,
			});
		}
		const reportFile = report("reports/imported.json", file, [
			{ title: "first test on the shared cap", duration: 4_000 },
			{ title: "second test on the shared cap", duration: 4_000 },
		]);
		const { lines } = run([
			"--report",
			reportFile,
			"--baseline",
			at("none.json"),
		]);
		expect(summary(lines)).toContain(
			"2 over 60% (0 known, 2 new), 0 with an unresolved cap",
		);
		expect(
			lines.filter(
				(line) =>
					line.startsWith("NEW  ") && line.includes("of the 2000 ms cap"),
			),
		).toHaveLength(2);
	});

	it("counts a duration exactly at the ratio as inside the budget, and one ms past as over", () => {
		const file = "tests/near/timeout-near.test.ts";
		const boundary = report("reports/boundary.json", file, [
			{
				title: "runs at the timeout",
				ancestors: ["session-fact bound"],
				duration: 18_000,
			},
		]);
		expect(
			summary(run(["--report", boundary, "--baseline", at("none.json")]).lines),
		).toContain("0 over 60%");
		const past = report("reports/past.json", file, [
			{
				title: "runs at the timeout",
				ancestors: ["session-fact bound"],
				duration: 18_001,
			},
		]);
		expect(
			summary(run(["--report", past, "--baseline", at("none.json")]).lines),
		).toContain("1 over 60%");
	});

	it("ignores the assertions that never ran and the ones that carry no duration", () => {
		const file = "tests/near/timeout-near.test.ts";
		const reportFile = report("reports/skipped.json", file, [
			{
				title: "runs at the timeout",
				ancestors: ["session-fact bound"],
				status: "skipped",
				duration: 29_600,
			},
			{
				title: "runs at half the timeout",
				ancestors: ["session-fact bound"],
				duration: undefined,
			},
		]);
		const { lines } = run([
			"--report",
			reportFile,
			"--baseline",
			at("none.json"),
		]);
		expect(summary(lines)).toContain("0 tests read");
		expect(summary(lines)).toContain("1 without a duration");
	});

	it("keeps a baselined offender quiet and calls only the new one NEW", () => {
		const file = "tests/near/timeout-near.test.ts";
		const baselineFile = writeJson(
			"baseline/offenders.json",
			JSON.stringify({
				schema: 1,
				entries: [
					{
						file,
						test: "session-fact bound > runs at the timeout",
						capStatus: "resolved",
						capMs: 30_000,
						durationMs: 29_600,
					},
				],
			}),
		);
		const reportFile = report("reports/baseline.json", file, [
			{
				title: "runs at the timeout",
				ancestors: ["session-fact bound"],
				duration: 29_600,
			},
			{
				title: "runs at half the timeout",
				ancestors: ["session-fact bound"],
				duration: 7_500,
			},
		]);
		const { lines } = run(["--report", reportFile, "--baseline", baselineFile]);
		// The baselined row prints as `known`; the half-budget sibling is not an
		// offender at all, so it is not a `known` row either.
		expect(lines.filter((line) => line.startsWith("known  "))).toHaveLength(1);
		expect(lines.filter((line) => line.startsWith("NEW  "))).toHaveLength(0);
		expect(summary(lines)).toContain("1 over 60% (1 known, 0 new)");
		// A baseline entry keyed on a different identity suppresses nothing.
		const other = report("reports/other.json", file, [
			{
				title: "unbaselined neighbour",
				ancestors: ["session-fact bound"],
				duration: 29_600,
			},
		]);
		expect(
			run(["--report", other, "--baseline", baselineFile]).lines.filter(
				(line) => line.startsWith("NEW  "),
			),
		).toHaveLength(1);
	});

	it("names a baseline row whose test the reports no longer carry", () => {
		// The planted row: same file, a test no scan produces. The committed
		// ledger's own rows are the ones the check normally reports against.
		const file = "tests/near/timeout-near.test.ts";
		const planted = "session-fact bound > a test this suite no longer has";
		const reportFile = report("reports/stale.json", file, [
			{
				title: "runs at the timeout",
				ancestors: ["session-fact bound"],
				duration: 29_600,
			},
			{
				title: "kept as a skip",
				ancestors: ["session-fact bound"],
				duration: 120,
				status: "skipped",
			},
		]);
		const baselineFile = writeJson(
			"baseline/stale.json",
			JSON.stringify({
				schema: 1,
				entries: [
					{
						file,
						test: "session-fact bound > runs at the timeout",
						capStatus: "resolved",
						capMs: 30_000,
						durationMs: 29_600,
					},
					{
						file,
						test: planted,
						capStatus: "resolved",
						capMs: 30_000,
						durationMs: 29_100,
					},
					{
						file,
						test: "session-fact bound > kept as a skip",
						capStatus: "resolved",
						capMs: 30_000,
						durationMs: 29_000,
					},
				],
			}),
		);
		const { lines } = run(["--report", reportFile, "--baseline", baselineFile]);
		// The skipped test still counts as carried, so only the planted row is stale.
		expect(lines.filter((line) => line.startsWith("stale  "))).toEqual([
			`stale  ${file} > ${planted}`,
		]);
		expect(
			lines.some((line) => line.includes("name no test these reports carried")),
		).toBe(true);
		// A shard that never ran the file calls nothing stale.
		const elsewhere = report(
			"reports/elsewhere.json",
			"tests/near/other.test.ts",
			[{ title: "unrelated", ancestors: [], duration: 10 }],
		);
		expect(
			run(["--report", elsewhere, "--baseline", baselineFile]).lines.filter(
				(line) => line.startsWith("stale  "),
			),
		).toHaveLength(0);
		expectPlantedStaleRow({
			baseline: "scripts/test-timeout-headroom-baseline.json",
			rowKey: planted,
			verdict: lines,
		});
	});

	it("writes a baseline that reads back sorted and reports the same run as all known", () => {
		const file = "tests/near/timeout-near.test.ts";
		const reportFile = report("reports/write.json", file, [
			{
				title: "runs at half the timeout",
				ancestors: ["session-fact bound"],
				duration: 20_000,
			},
			{
				title: "runs at the timeout",
				ancestors: ["session-fact bound"],
				duration: 29_600,
			},
		]);
		const written = join(dirAt("baseline"), "written.json");
		expect(
			run(["--report", reportFile, "--baseline", written, "--write-baseline"])
				.code,
		).toBe(0);
		const document = JSON.parse(readFileSync(written, "utf8"));
		expect(document.entries.map((e: { test: string }) => e.test)).toEqual([
			"session-fact bound > runs at half the timeout",
			"session-fact bound > runs at the timeout",
		]);
		expect(document.ratio).toBe(0.6);
		// The baseline is a ratchet over identities: the cap it records is
		// provenance, so the same test at a different cap is still known.
		expect(baselineEntries(document).size).toBe(2);
		expect(
			summary(run(["--report", reportFile, "--baseline", written]).lines),
		).toContain("2 known, 0 new");
	});

	it("annotates ten new offenders and counts the rest in the log", () => {
		// The annotation cap is a rate limit on GitHub's check run, not on the
		// population: a shard with more new offenders than the cap has to say how
		// many there are (round 1 F7: widening the cap to 10000 survived with no
		// red, so the truncation itself was unobserved).
		const titles = Array.from(
			{ length: 12 },
			(_, i) => `spends most of its budget ${i + 1}`,
		);
		const file = source(
			"annot/capped.test.ts",
			[
				'import { it } from "vitest";',
				"",
				...titles.map((t) => `it("${t}", { timeout: 1_000 }, async () => {});`),
				"",
			].join("\n"),
		);
		const reportFile = report(
			"reports/annot.json",
			file,
			titles.map((title) => ({ title, duration: 700 })),
		);
		const { lines } = run([
			"--report",
			reportFile,
			"--baseline",
			at("baseline/none-annot.json"),
		]);
		const warnings = lines.filter(
			(line) =>
				line.startsWith("::warning title=test-timeout-headroom::") &&
				line.includes("spends most of its budget"),
		);
		expect(warnings.length).toBe(10);
		expect(
			lines.some((line) =>
				line.includes("2 further new offenders (see the step log)"),
			),
		).toBe(true);
	});

	it("says the ledger is absent when no baseline file exists", () => {
		// Round 1 F7: the missing-baseline notice had no red, so dropping it kept
		// the run silent about why every row was new.
		const file = source(
			"missing/no-baseline.test.ts",
			`import { it } from "vitest";

it("runs long with no ledger beside it", { timeout: 1_000 }, async () => {});
`,
		);
		const reportFile = report("reports/missing-baseline.json", file, [
			{ title: "runs long with no ledger beside it", duration: 800 },
		]);
		const { lines } = run([
			"--report",
			reportFile,
			"--baseline",
			at("baseline/absent-notice.json"),
		]);
		expect(
			lines.some(
				(line) =>
					line.includes("no baseline at") &&
					line.includes("every row below is new"),
			),
		).toBe(true);
	});

	it("says an assertion that carried no duration could not be judged", () => {
		// Round 1 F7: the undated count had no red either, and an unjudged
		// assertion must not read as a passing one (shape 10).
		const file = source(
			"undated/no-duration.test.ts",
			`import { it } from "vitest";

it("finishes without reporting a duration", { timeout: 1_000 }, async () => {});
`,
		);
		const reportFile = report("reports/undated.json", file, [
			{ title: "finishes without reporting a duration" },
		]);
		const { lines } = run([
			"--report",
			reportFile,
			"--baseline",
			at("baseline/none-undated.json"),
		]);
		expect(rowLines(lines, file).length).toBe(0);
		expect(
			lines.some((line) =>
				line.includes(
					"1 ran assertions carried no duration and could not be judged",
				),
			),
		).toBe(true);
	});

	it("leaves a title two declarations disagree about unresolved", () => {
		// Round 1 F7: the fail-closed ambiguity guard had no red. Two declarations
		// can answer one reported title (an exact `it` and a template that fills to
		// the same text); agreeing budgets are one answer, disagreeing ones are no
		// answer, and the row is then judged against the file floor.
		const file = source(
			"ambiguous/two-caps.test.ts",
			`import { it } from "vitest";

it("shares one title across two budgets", { timeout: 20_000 }, async () => {});
it("shares one title across two budgets", { timeout: 5_000 }, async () => {});
`,
		);
		const reportFile = report("reports/ambiguous.json", file, [
			{ title: "shares one title across two budgets", duration: 14_000 },
		]);
		const { lines } = run([
			"--report",
			reportFile,
			"--baseline",
			at("baseline/none-ambiguous.json"),
		]);
		expect(summary(lines)).toContain("1 with an unresolved cap");
		const rows = rowLines(lines, file);
		expect(rows.length).toBe(1);
		expect(rows[0]).toContain("14000 ms");
	});

	it("floors an unresolved cap at the file default when the file also runs tests at it", () => {
		// The floor is the file default whenever any test in the file relies on it,
		// not the narrowest declared cap (round 1 F7: dropping that check survived,
		// because no case mixed a defaulted test with a narrow declared one).
		const file = source(
			"floor/absent-decl.test.ts",
			[
				'import { it, vi } from "vitest";',
				"",
				"vi.setConfig({ testTimeout: 20_000 });",
				"",
				'it("keeps a declared budget", { timeout: 8_000 }, async () => {});',
				'it("runs at the file default", async () => {});',
				"const reboundBudget = { timeout: 15_000 };",
				"reboundBudget.timeout = 30_000;",
				'it("spends a budget it cannot settle", reboundBudget, async () => {});',
				"",
			].join("\n"),
		);
		const reportFile = report("reports/floor-absent.json", file, [
			{ title: "spends a budget it cannot settle", duration: 11_500 },
		]);
		// --scale 1 keeps the numbers of this case the ones the branch decides on,
		// whatever the lane's scale is.
		const { lines } = run([
			"--report",
			reportFile,
			"--baseline",
			at("baseline/none-floor.json"),
			"--scale",
			"1",
		]);
		expect(summary(lines)).toContain("1 with an unresolved cap");
		expect(rowLines(lines, file)).toEqual([]);
	});

	it("floors an unresolved cap at the narrowest budget of a fully declared file", () => {
		// The other side of the same rule: where every test of the file names a
		// budget narrower than the file default, an unresolvable one is judged
		// against the narrowest, not against the default.
		const file = source(
			"floor/all-declared.test.ts",
			[
				'import { it, vi } from "vitest";',
				"",
				"vi.setConfig({ testTimeout: 20_000 });",
				"",
				'it("keeps a declared budget", { timeout: 8_000 }, async () => {});',
				'it("keeps a wider one", { timeout: 9_000 }, async () => {});',
				"",
			].join("\n"),
		);
		const reportFile = report("reports/floor-all.json", file, [
			{
				title: "reported under a title the source does not carry",
				duration: 11_500,
			},
		]);
		const { lines } = run([
			"--report",
			reportFile,
			"--baseline",
			at("baseline/none-all.json"),
			"--scale",
			"1",
		]);
		expect(summary(lines)).toContain("1 over 60%");
		const rows = rowLines(lines, file);
		expect(rows.length).toBe(1);
		expect(rows[0]).toContain("floor 8000 ms");
	});

	it("leaves the committed baseline self-consistent", () => {
		const committed = join(ROOT, "scripts/test-timeout-headroom-baseline.json");
		const loaded = loadBaseline(committed);
		expect(loaded.missing).toBe(false);
		expect(loaded.entries.size).toBeGreaterThan(0);
		for (const entry of loaded.entries.values())
			expect(entry.file.startsWith("tests/")).toBe(true);
		// One fabricated passing test against the committed ledger: what this shows
		// is that the shipped file parses and the run reports nothing for it. That a
		// baseline row still matches a real offender is `names a baseline row whose
		// test the reports no longer carry` and the CI run's own ledger (r1 F10).
		const reportFile = writeJson(
			"reports/committed.json",
			JSON.stringify({
				testResults: [
					{
						name: join(ROOT, "tests/scripts/test-timeout-headroom.test.ts"),
						assertionResults: [
							{
								title: "leaves the committed baseline self-consistent",
								ancestorTitles: [
									"scripts/check-test-timeout-headroom.mjs (#5311)",
								],
								status: "passed",
								duration: 1,
							},
						],
					},
				],
			}),
		);
		expect(
			summary(run(["--report", reportFile, "--baseline", committed]).lines),
		).toContain("0 over 60% (0 known, 0 new)");
	});

	it("refuses a report or baseline it cannot measure, with exit 2", () => {
		const missing = run(["--report", at("reports/absent.json")]);
		expect(missing.code).toBe(2);
		expect(missing.lines[0]).toContain("--report path does not exist");

		const malformed = writeJson("reports/malformed.json", "{ not json");
		expect(run(["--report", malformed]).lines[0]).toContain(
			"is not readable JSON",
		);
		expect(run(["--report", malformed]).code).toBe(2);

		const wrongShape = writeJson(
			"reports/wrong-shape.json",
			JSON.stringify({ results: [] }),
		);
		expect(run(["--report", wrongShape]).lines[0]).toContain(
			"not a vitest JSON report",
		);

		const badBaseline = writeJson(
			"reports/bad-baseline.json",
			JSON.stringify({ schema: 99, entries: [] }),
		);
		const reportFile = report(
			"reports/ok.json",
			"tests/default/no-declaration.test.ts",
			[{ title: "has no declared budget", duration: 10 }],
		);
		expect(
			run(["--report", reportFile, "--baseline", badBaseline]).lines[0],
		).toContain("unsupported schema");

		const duplicate = writeJson(
			"reports/dup-baseline.json",
			JSON.stringify({
				schema: 1,
				entries: [
					{
						file: "tests/a.test.ts",
						test: "t",
						capStatus: "resolved",
						capMs: 5000,
						durationMs: 4000,
					},
					{
						file: "tests/a.test.ts",
						test: "t",
						capStatus: "resolved",
						capMs: 5000,
						durationMs: 4000,
					},
				],
			}),
		);
		expect(
			run(["--report", reportFile, "--baseline", duplicate]).lines[0],
		).toContain("duplicate baseline entry");

		expect(run(["--report", reportFile, "--ratio", "1.5"]).lines[0]).toContain(
			"--ratio must be a fraction",
		);
		expect(run(["--nope"]).lines[0]).toContain("unknown argument");
		expect(run([]).lines[0]).toContain("--report is required");
	});

	it("reads every .json under a directory and counts both shards", () => {
		// Both shard reports are this case's own input: copying a file an earlier
		// case happened to write is what made the run order-dependent.
		const shardDir = dirAt("reports/shards");
		report(
			"reports/shards/shard-2.json",
			"tests/default/no-declaration.test.ts",
			[{ title: "has no declared budget", duration: 4_000 }],
		);
		report(
			"reports/shards/shard-1.json",
			"tests/setconfig/vitest-set-config.test.ts",
			[{ title: "runs under the file config", duration: 6_300 }],
		);
		const { lines } = run([
			"--report",
			shardDir,
			"--baseline",
			at("none.json"),
		]);
		expect(summary(lines)).toContain("2 tests read, 2 over 60%");
		expect(lines.join("\n")).toContain("4000 ms is 80% of the 5000 ms cap");
		expect(lines.join("\n")).toContain("6300 ms is 70% of the 9000 ms cap");
		// A stray non-report in the directory is refused by name, never skipped
		// silently: a truncated artifact must not read as a clean shard.
		writeJson("reports/shards/sidecar.json", JSON.stringify({ headSha: "x" }));
		const stray = run(["--report", shardDir, "--baseline", at("none.json")]);
		expect(stray.code).toBe(2);
		expect(stray.lines[0]).toContain("sidecar.json");
		rmSync(join(shardDir, "sidecar.json"));
	});

	it("parses a real report's identity through the shared reader", () => {
		const parsed = parseTestReport(
			{
				testResults: [
					{
						name: "/home/runner/work/pi-lens/pi-lens/tests/clients/formatters-live-flight.test.ts",
						assertionResults: [
							{
								title: "spawns one child",
								ancestorTitles: ["formatFile live child flight"],
								status: "passed",
								duration: 15_029,
							},
						],
					},
				],
			},
			{ source: "shard-1.json" },
		);
		expect(parsed.rows[0]?.file).toBe(
			"tests/clients/formatters-live-flight.test.ts",
		);
		expect(parsed.rows[0]?.chain).toEqual(["formatFile live child flight"]);
	});

	it("exits 0 as a child process on a new offender and 1 with --fail-on-new", () => {
		const reportFile = report(
			"reports/child.json",
			"tests/near/timeout-near.test.ts",
			[
				{
					title: "runs at the timeout",
					ancestors: ["session-fact bound"],
					duration: 29_600,
				},
			],
		);
		const common = [
			"--root",
			dir,
			"--report",
			reportFile,
			"--baseline",
			at("none.json"),
		];
		const advisory = spawnSync(process.execPath, [CLI, ...common], {
			cwd: ROOT,
			encoding: "utf8",
		});
		expect(advisory.status).toBe(0);
		expect(advisory.stdout).toContain("NEW  tests/near/timeout-near.test.ts");
		const strict = spawnSync(
			process.execPath,
			[CLI, ...common, "--fail-on-new"],
			{
				cwd: ROOT,
				encoding: "utf8",
			},
		);
		expect(strict.status).toBe(1);
		const broken = spawnSync(
			process.execPath,
			[CLI, "--report", at("reports/absent.json")],
			{
				cwd: ROOT,
				encoding: "utf8",
			},
		);
		expect(broken.status).toBe(2);
	});

	it("reads a budget from an options object the file declares as a name", () => {
		const file = "tests/named-options/named.test.ts";
		const reportFile = report("reports/named.json", file, [
			{ title: "runs under a named options object", duration: 175_000 },
			{ title: "runs under options declared below it", duration: 38_000 },
		]);
		const { code, lines } = run(["--report", reportFile]);
		expect(code).toBe(0);
		const rows = rowLines(lines, file).join("\n");
		expect(rows).toContain("180000 ms cap");
		expect(rows).toContain("40000 ms cap");
		// A skipped options argument fell through to the 5000 ms default, which
		// turned a 180 s budget into two false offenders against a 5 s cap.
		expect(rows).not.toContain("cap unresolved");
		expect(rows).not.toContain("5000 ms cap");
	});

	it("leaves a cap unresolved when the file re-binds the options name", () => {
		const file = "tests/named-options/reassigned.test.ts";
		const reportFile = report("reports/reassigned.json", file, [
			{ title: "runs under a reassigned options name", duration: 4_200 },
		]);
		const rows = rowLines(run(["--report", reportFile]).lines, file);
		// Which `OPTION_BAG = …` ran decides the cap, so the file proves no budget:
		// the row is judged against the floor and says so, not against 40000.
		expect(rows.length).toBe(1);
		expect(rows[0]).toContain("cap unresolved (timeout-unfoldable");
		expect(rows[0]).not.toContain("40000 ms cap");
	});

	it("leaves a cap unresolved when a spread after the pair can overwrite it", () => {
		const file = "tests/named-options/spread-after.test.ts";
		const reportFile = report("reports/spread-after.json", file, [
			{ title: "runs under options a spread can overwrite", duration: 4_200 },
		]);
		const rows = rowLines(run(["--report", reportFile]).lines, file);
		expect(rows.length).toBe(1);
		expect(rows[0]).toContain("cap unresolved (timeout-unfoldable");
	});

	it("leaves a shadowed budget name unresolved rather than naming one binding", () => {
		const file = "tests/named-options/inner-name.test.ts";
		source(
			file,
			`import { describe, it } from "vitest";

const BUDGET_MS = 20_000;

describe("narrower inside", () => {
	const BUDGET_MS = 2_000;
	it("uses the inner binding", async () => {}, BUDGET_MS);
});
`,
		);
		const reportFile = report("reports/inner-name.json", file, [
			{
				title: "uses the inner binding",
				ancestors: ["narrower inside"],
				duration: 4_200,
			},
		]);
		const { lines } = run(["--report", reportFile]);
		const rows = rowLines(lines, file);
		// The two bindings disagree (20_000 and 2_000) and the fold reads the file
		// flatly, so naming either cap would be a guess: the row is judged against
		// the file floor and says which reason.
		expect(rows.length).toBe(1);
		expect(rows[0]).toContain("cap unresolved (timeout-unfoldable");
		expect(summary(lines)).toContain("1 with an unresolved cap");
	});

	it("resolves a test budget written after the handler", () => {
		// `it(name, fn, 300)` is the other half of the boundary: the runner keeps it
		// (probed: a 600 ms test under `it(name, fn, 300)` fails "Test timed out in
		// 300ms"), and the in-tree
		// `tests/clients/dispatch/fact-store-session-bound.test.ts` uses it, so the
		// trailing expression stays a budget expression.
		const file = "tests/inherited/it-tail-number.test.ts";
		source(
			file,
			`import { it } from "vitest";

it("runs under a trailing number", async () => {}, 20_000);
`,
		);
		const reportFile = report("reports/it-tail-number.json", file, [
			{ title: "runs under a trailing number", duration: 15_000 },
		]);
		const rows = rowLines(
			run(["--report", reportFile, "--baseline", at("none.json")]).lines,
			file,
		);
		expect(rows.length).toBe(1);
		expect(rows[0]).toContain("15000 ms is 75% of the 20000 ms cap");
	});

	it("refuses the trailing options the runner refuses", () => {
		const file = "tests/inherited/tail-options-refused.test.ts";
		source(
			file,
			`import { it } from "vitest";

it("declares its budget where the runner will not read it", async () => {}, {
	timeout: 20_000,
});
`,
		);
		const reportFile = report("reports/tail-options-refused.json", file, [
			{
				title: "declares its budget where the runner will not read it",
				duration: 4_500,
			},
		]);
		const rows = rowLines(
			run(["--report", reportFile, "--baseline", at("none.json")]).lines,
			file,
		);
		// vitest 5.1.0 rejects this signature at collection and reports zero tests,
		// so no real row can carry this cap: reading the object would invent a 20 s
		// budget for a file the runner never runs. The fold judges the test against
		// the file chain it would get with no options at all (r2 F8).
		expect(rows.length).toBe(1);
		expect(rows[0]).toContain(
			`4500 ms is 90% of the ${DEFAULT_TEST_TIMEOUT_MS} ms cap`,
		);
	});

	it("resolves a suite budget written before the factory", () => {
		const file = "tests/inherited/describe-tail-options.test.ts";
		const reportFile = report("reports/tail-options.json", file, [
			{
				title: "inherits the tail options budget",
				ancestors: ["suite budget written last"],
				duration: 7_600,
			},
		]);
		const rows = rowLines(run(["--report", reportFile]).lines, file);
		expect(rows.length).toBe(1);
		expect(rows[0]).toContain("8000 ms cap");
	});

	it("counts every judged test with an unresolved cap, not only the emitted rows", () => {
		// Two files whose cap the fold refuses: a hook-scoped `vi.setConfig` (which
		// sets no budget any test runs under) and a reassigned options name. One of
		// the three tests stays well inside its file's floor, so it emits no row —
		// and still belongs in the count, because an unmeasured test is not a
		// measured-healthy one (r1 F4: 419 unresolved tests printed as a clean 0).
		const nested = "tests/setconfig-nested/hook-config.test.ts";
		const nestedReport = report("reports/nested-config.json", nested, [
			{ title: "spends most of the default", duration: 4_200 },
			{ title: "stays inside the default", duration: 900 },
		]);
		const reassignedReport = report(
			"reports/nested-reassigned.json",
			"tests/named-options/reassigned.test.ts",
			[{ title: "runs under a reassigned options name", duration: 1_000 }],
		);
		const { code, lines } = run([
			"--report",
			nestedReport,
			"--report",
			reassignedReport,
		]);
		expect(code).toBe(0);
		expect(summary(lines)).toContain("3 with an unresolved cap");
		expect(summary(lines)).toContain("file-timeout-nested-setConfig 2");
		expect(rowLines(lines, nested)).toEqual([]);
	});

	it("writes one baseline entry per identity when overlapping reports repeat one", () => {
		const file = "tests/near/timeout-near.test.ts";
		const slower = report("reports/overlap-slow.json", file, [
			{
				title: "runs at the timeout",
				ancestors: ["session-fact bound"],
				duration: 29_600,
			},
		]);
		const faster = report("reports/overlap-fast.json", file, [
			{
				title: "runs at the timeout",
				ancestors: ["session-fact bound"],
				duration: 20_000,
			},
		]);
		const written = join(dirAt("baseline-overlap"), "overlap.json");
		expect(
			run([
				"--report",
				slower,
				"--report",
				faster,
				"--report",
				slower,
				"--baseline",
				written,
				"--write-baseline",
			]).code,
		).toBe(0);
		const document = JSON.parse(readFileSync(written, "utf8"));
		expect(document.entries).toHaveLength(1);
		expect(document.entries[0].durationMs).toBe(29_600);
		// The reader refuses a duplicate identity, so a document with one would
		// have made the whole baseline unreadable and every offender new.
		expect(baselineEntries(document).size).toBe(1);
		expect(
			summary(run(["--report", slower, "--baseline", written]).lines),
		).toContain("1 known, 0 new");
	});

	it("refuses a value-taking flag with no value after it", () => {
		const invalid: Array<[string, string[]]> = [
			["--baseline", ["--baseline"]],
			["--ratio", ["--ratio", "--report", "reports/none.json"]],
			["--report", ["--report"]],
		];
		for (const [flag, args] of invalid) {
			const { code, lines } = run(args);
			expect(code, flag).toBe(2);
			expect(lines.join("\n"), flag).toContain(
				`::warning title=test-timeout-headroom::could not measure: ${flag} requires a value`,
			);
		}
	});

	it("refuses a scale or ratio that would judge every test against zero", () => {
		const file = "tests/near/zero-budget.test.ts";
		source(
			file,
			`import { it } from "vitest";
it("runs once", async () => {}, 2_000);
`,
		);
		const reportFile = report("reports/zero-budget.json", file, [
			{ title: "runs once", ancestors: [], duration: 10 },
		]);
		// A zero scale folded every cap to 0 ms and a zero ratio flagged every test
		// at any duration: both print a run that measured nothing, so the values are
		// refused rather than served.
		const degenerate: Array<[string, string]> = [
			["--scale", "--scale must be a positive number: 0"],
			["--ratio", "--ratio must be a fraction in (0, 1): 0"],
		];
		for (const [flag, message] of degenerate) {
			const { code, lines } = run([
				"--report",
				reportFile,
				flag,
				"0",
				"--baseline",
				at("baseline-none.json"),
			]);
			expect(code, flag).toBe(2);
			expect(lines.join("\n"), flag).toContain(
				`::warning title=test-timeout-headroom::could not measure: ${message}`,
			);
		}
		// The guard is on the degenerate value, not on the flags.
		expect(
			run([
				"--report",
				reportFile,
				"--scale",
				"2",
				"--ratio",
				"0.5",
				"--baseline",
				at("baseline-none.json"),
			]).code,
		).toBe(0);
	});
});
