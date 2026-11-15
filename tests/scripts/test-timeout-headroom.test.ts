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
	baselineEntries,
	DEFAULT_TEST_TIMEOUT_MS,
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
		// The suite spelling that keeps the third-argument options read: the suite API
		// accepts options after the factory, unlike `it`.
		source(
			"tests/inherited/describe-tail-options.test.ts",
			`import { describe, it } from "vitest";

describe("suite budget written last", () => {
	it("inherits the tail options budget", async () => {});
}, { timeout: 8_000 });
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

	it("leaves the committed baseline self-consistent", () => {
		const committed = join(ROOT, "scripts/test-timeout-headroom-baseline.json");
		const loaded = loadBaseline(committed);
		expect(loaded.missing).toBe(false);
		expect(loaded.entries.size).toBeGreaterThan(0);
		for (const entry of loaded.entries.values())
			expect(entry.file.startsWith("tests/")).toBe(true);
		// The check that ran on the run the baseline came from reads clean.
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

	it("resolves a suite budget written after the factory", () => {
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
