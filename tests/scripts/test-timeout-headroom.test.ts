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

describe("scripts/check-test-timeout-headroom.mjs (#5311)", () => {
	beforeAll(() => {
		// The issue's motivating shape: a suite that declares a 30 s budget and a
		// test that spent 29.6 s of it. The sibling stays at half the budget.
		source(
			"tests/near/timeout-near.test.ts",
			`import { describe, it } from "vitest";

const CAP_MS = 30_000;

describe("session-fact bound", () => {
	it("runs at the timeout", async () => {}, { timeout: CAP_MS });
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

it("has a budget the fold cannot reach", async () => {}, { timeout: pickMs() });
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

		const reportFile = at("reports/fact-store.json");
		writeFileSync(
			reportFile,
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
		const baselineFile = at("baseline/offenders.json");
		mkdirSync(at("baseline"), { recursive: true });
		writeFileSync(
			baselineFile,
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
		const written = at("baseline/written.json");
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
		const reportFile = at("reports/committed.json");
		writeFileSync(
			reportFile,
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

		const malformed = at("reports/malformed.json");
		writeFileSync(malformed, "{ not json");
		expect(run(["--report", malformed]).lines[0]).toContain(
			"is not readable JSON",
		);
		expect(run(["--report", malformed]).code).toBe(2);

		const wrongShape = at("reports/wrong-shape.json");
		writeFileSync(wrongShape, JSON.stringify({ results: [] }));
		expect(run(["--report", wrongShape]).lines[0]).toContain(
			"not a vitest JSON report",
		);

		const badBaseline = at("reports/bad-baseline.json");
		writeFileSync(badBaseline, JSON.stringify({ schema: 99, entries: [] }));
		const reportFile = report(
			"reports/ok.json",
			"tests/default/no-declaration.test.ts",
			[{ title: "has no declared budget", duration: 10 }],
		);
		expect(
			run(["--report", reportFile, "--baseline", badBaseline]).lines[0],
		).toContain("unsupported schema");

		const duplicate = at("reports/dup-baseline.json");
		writeFileSync(
			duplicate,
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
		const shardDir = at("reports/shards");
		mkdirSync(shardDir, { recursive: true });
		writeFileSync(
			join(shardDir, "shard-2.json"),
			readFileSync(at("reports/default.json"), "utf8"),
		);
		writeFileSync(
			join(shardDir, "shard-1.json"),
			readFileSync(at("reports/setconfig.json"), "utf8"),
		);
		const { lines } = run([
			"--report",
			shardDir,
			"--baseline",
			at("none.json"),
		]);
		expect(summary(lines)).toContain("2 tests read, 2 over 60%");
		// A stray non-report in the directory is refused by name, never skipped
		// silently: a truncated artifact must not read as a clean shard.
		writeFileSync(
			join(shardDir, "sidecar.json"),
			JSON.stringify({ headSha: "x" }),
		);
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
});
