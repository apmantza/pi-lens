// lane: dev-box-only (the real spread is a maintainer's manual/nightly run;
// this file holds the script's own logic and drives it on the installed host).
// flake-shape: none — this file spawns nothing. The one child the script
// spawns (a Vitest run of a tier suite against one host) is the injected
// `runTierSuite` seam below, because a nested Vitest would run the whole
// config inside a worker of the outer run. The real invocation is quoted in
// the PR body from a manual `node scripts/probe-pi-host-tiers.mjs` run.
//
// PREREQUISITE: this repo's `@earendil-works/pi-coding-agent` devDependency.
// Every case that reads the installed host skips VISIBLY without it (the
// `needsInstalledHost` gate below) instead of redding on a prerequisite the
// case cannot supply, or passing vacuously against `undefined`.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
	cleanupTestEnvironmentsDrained,
	setupTestEnvironment,
} from "../clients/test-utils.js";
import { main } from "../../scripts/probe-pi-host-tiers.mjs";
import {
	EXIT,
	HOST_PACKAGE,
	certifiedHosts,
	compareVersions,
	discoverInstalledHosts,
	exitCodeForSpread,
	hostPackageCandidates,
	parseCliArgs,
	parseVerifiedHostRows,
	renderHostLine,
	renderSpreadSummary,
	resolveHostPackage,
	runSpread,
	tierVerdict,
} from "../../scripts/lib/pi-host-spread.mjs";
import type {
	SpreadRow,
	TierResult,
	TierSuite,
} from "../../scripts/lib/pi-host-spread.mjs";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const BASELINE_DOC = path.join(REPO_ROOT, "docs", "release-qa-baseline.md");
const REPO_HOST_ROOT = path.join(REPO_ROOT, "node_modules");
const BASELINE_TEXT = fs.readFileSync(BASELINE_DOC, "utf8");

/**
 * The host this repo installs, resolved the way a `--host-root` resolves it —
 * so the version the cases below report is read from the installed package,
 * never typed here.
 */
const installedHost = resolveHostPackage(REPO_HOST_ROOT);

/**
 * Three versions for the spread cases: two this box does not carry, and the one
 * it does, so both branches of `runSpread` are exercised.
 */
const certified = ["0.86.1", "0.87.1", installedHost?.version].filter(
	(version): version is string => typeof version === "string",
);
const hosts = installedHost ? [installedHost] : [];

/**
 * The cases that read the installed host need it to exist. `skipIf` (never a
 * bare return) keeps a box without `node_modules` honest: the skip is visible,
 * and no case passes by comparing `undefined` with `undefined` (#4719
 * CodeRabbit Stability & Availability).
 */
const needsInstalledHost = it.skipIf(installedHost === undefined);

/** Fixture roots this file plants; the harness removes them at file teardown. */
const fixtures: Array<{ tmpDir: string; cleanup: () => void }> = [];

function fixtureRoot(): string {
	const fixture = setupTestEnvironment("pi-lens-host-spread-");
	fixtures.push(fixture);
	return fixture.tmpDir;
}

/** A version no install of this repo carries, so a real install cannot satisfy it. */
const PLANTED_HOST_VERSION = "1.2.0";

/**
 * A host package manifest at `root/package.json`, for one install layout. The
 * layout cases below used to point at directories that do not exist and assert
 * `hostPackageCandidates` contained a string, which stayed green with the
 * resolver ignoring the layout entirely (#4719 F6, greptile P2, sourcery
 * Medium).
 */
function plantHostAt(root: string): { dir: string; version: string } {
	fs.mkdirSync(root, { recursive: true });
	fs.writeFileSync(
		path.join(root, "package.json"),
		JSON.stringify({
			name: HOST_PACKAGE,
			version: PLANTED_HOST_VERSION,
		}),
	);
	return { dir: root, version: PLANTED_HOST_VERSION };
}

afterAll(async () => {
	for (const fixture of fixtures.splice(0)) fixture.cleanup();
	await cleanupTestEnvironmentsDrained("pi-lens-host-spread-");
});

/** A tier result the injected seam returns; no Vitest run is involved. */
function tierResult(ok: boolean): TierResult {
	return { ok, passed: ok ? 4 : 1, total: 4 };
}

describe("certified hosts come from the baseline doc, fail-closed (#4632 acceptance 9)", () => {
	it("reads the doc's verified-host table as the certified set", () => {
		const { versions, unparseable } = certifiedHosts(BASELINE_TEXT);
		expect(unparseable).toEqual([]);
		// The table is the owner: at least the floor host and the newest host,
		// every one a three-part version, in ascending order.
		expect(versions.length).toBeGreaterThan(1);
		expect(versions.every((version) => /^\d+\.\d+\.\d+$/.test(version))).toBe(
			true,
		);
		expect([...versions].sort(compareVersions)).toEqual(versions);
		expect(versions).toContain("0.86.1");
	});

	it("reports a row it cannot read instead of dropping it", () => {
		// Recurrence (#4688 R2 F2): a row spelled `| 1.4 |` was a host the
		// ratchet did not carry and the window excluded, and a reader that drops
		// it turns an unreadable certified set into a shorter green one.
		const doc = [
			"### Verified hosts",
			"",
			"| host | date | pi-lens commit | result |",
			"| --- | --- | --- | --- |",
			"| 1.3.0 | 2026-10-16 | abc1234 | pass |",
			"| 1.4 | 2026-10-20 | abc1234 | pass |",
			"",
			"## Next section",
			"",
			"| 9.9.9 | not a host row |",
		].join("\n");
		const { versions, unparseable } = certifiedHosts(doc);
		expect(versions).toEqual(["1.3.0"]);
		expect(unparseable).toEqual(["| 1.4 | 2026-10-20 | abc1234 | pass |"]);
		// The table stops at the next `## ` heading, so a later table is not one.
		expect(parseVerifiedHostRows(doc).rows.map((row) => row.version)).toEqual([
			"1.3.0",
			null,
		]);
	});

	it("reads the rows UNDER the separator, so no host is lost", () => {
		// Recurrence (#4719 F4, sourcery Medium): the parser dropped the first
		// PIPE row instead of the header and separator, so a table that lost its
		// header silently un-certified its first host, and both readers called
		// the shorter set clean.
		const withHeader = [
			"### Verified hosts",
			"",
			"| host | date |",
			"| --- | --- |",
			"| 0.86.1 | 2026-10-08 |",
			"| 1.3.0 | 2026-10-16 |",
		].join("\n");
		expect(
			parseVerifiedHostRows(withHeader).rows.map((row) => row.version),
		).toEqual(["0.86.1", "1.3.0"]);
		expect(parseVerifiedHostRows(withHeader).hasHeader).toBe(true);

		const headerless = [
			"### Verified hosts",
			"",
			"| 0.86.1 | 2026-10-08 |",
			"| 1.3.0 | 2026-10-16 |",
		].join("\n");
		const parsed = parseVerifiedHostRows(headerless);
		// Nothing is dropped: the refusal is explicit, not a shorter list.
		expect(parsed.rows.map((row) => row.version)).toEqual(["0.86.1", "1.3.0"]);
		expect(parsed.hasHeader).toBe(false);
		expect(certifiedHosts(headerless).problem).toContain("no header row");
	});

	it("refuses a host row where the header belongs", () => {
		// Recurrence (#4719 F9, sourcery Medium's surviving spelling): a version
		// row directly above the separator was taken for the header and dropped,
		// so the table lost that host and both readers called the shorter set
		// clean. A header names columns, never a host.
		const doc = [
			"### Verified hosts",
			"",
			"| 0.86.1 | 2026-10-08 |",
			"| --- | --- |",
			"| 1.3.0 | 2026-10-16 |",
		].join("\n");
		const parsed = parseVerifiedHostRows(doc);
		// Nothing is dropped: the host above the separator is a host row.
		expect(parsed.rows.map((row) => row.version)).toEqual(["0.86.1", "1.3.0"]);
		expect(parsed.hasHeader).toBe(false);
		const { versions, problem } = certifiedHosts(doc);
		expect(problem).toContain("names a host, not a header");
		// The refusal is what the caller acts on; the set it also returns is the
		// full table, never a silently shorter one.
		expect(versions).toEqual(["0.86.1", "1.3.0"]);
	});

	it("orders versions numerically, not lexically", () => {
		expect(["1.10.0", "1.9.3", "0.99.2"].sort(compareVersions)).toEqual([
			"0.99.2",
			"1.9.3",
			"1.10.0",
		]);
	});
});

describe("host installs are found by version, in every layout", () => {
	needsInstalledHost("this repo's node_modules is one of the layouts", () => {
		expect(installedHost?.dir).toBe(path.join(REPO_HOST_ROOT, HOST_PACKAGE));
		expect(installedHost?.version).toMatch(/^\d+\.\d+\.\d+$/);
	});

	needsInstalledHost("resolves a node_modules root", () => {
		expect(resolveHostPackage(REPO_HOST_ROOT)).toEqual(installedHost);
	});

	needsInstalledHost("resolves the package directory", () => {
		expect(resolveHostPackage(path.join(REPO_HOST_ROOT, HOST_PACKAGE))).toEqual(
			installedHost,
		);
	});

	it("resolves a versioned install prefix", () => {
		// The orchestrator keeps hosts at `<dir>/pi-<version>`; the fixture holds
		// a manifest so a resolver that stopped reading the layout reds here
		// instead of passing on a candidate string (#4719 F6).
		const planted = plantHostAt(
			path.join(
				fixtureRoot(),
				`pi-${PLANTED_HOST_VERSION}`,
				"node_modules",
				HOST_PACKAGE,
			),
		);
		expect(
			resolveHostPackage(path.dirname(path.dirname(path.dirname(planted.dir)))),
		).toEqual(planted);
	});

	it("resolves an npm global prefix", () => {
		// An npm global install is at `<prefix>/lib/node_modules/<pkg>`, and the
		// prefix, not the install directory, is what `--host-root` may name. The
		// case resolves from the prefix itself: deriving it from the planted
		// package's own path landed on a directory whose generic candidate WAS
		// the planted install, so the case stayed green with the `lib` layout
		// removed (#4719 F10, CodeRabbit thread #8).
		const prefix = path.join(fixtureRoot(), "global");
		const planted = plantHostAt(
			path.join(prefix, "lib", "node_modules", HOST_PACKAGE),
		);
		expect(resolveHostPackage(prefix)).toEqual(planted);
		// A prefix that holds no install resolves to nothing, never to a guess.
		const empty = path.join(fixtureRoot(), "empty-prefix");
		expect(resolveHostPackage(empty)).toBeUndefined();
		expect(hostPackageCandidates(empty)).toContain(
			path.join(empty, "lib", "node_modules", HOST_PACKAGE),
		);
	});

	needsInstalledHost(
		"refuses a directory whose manifest names another package",
		() => {
			// A directory that holds SOME package's manifest is not a host: without
			// the name check, `node_modules/vitest` would report host version 5.0.5
			// and the spread would probe a tier suite against Vitest itself.
			expect(
				resolveHostPackage(path.join(REPO_HOST_ROOT, "vitest")),
			).toBeUndefined();
			// And a directory with no manifest at all resolves to nothing either.
			expect(
				resolveHostPackage(path.join(REPO_ROOT, "clients")),
			).toBeUndefined();
			// The real install still resolves, so the two refusals above are not the
			// candidate list failing to reach it.
			expect(
				resolveHostPackage(path.join(REPO_HOST_ROOT, HOST_PACKAGE))?.dir,
			).toBe(path.join(REPO_HOST_ROOT, HOST_PACKAGE));
		},
	);

	needsInstalledHost("reports a root that holds no host at all", () => {
		const { hosts, unreadable } = discoverInstalledHosts([
			path.join(REPO_ROOT, "clients"),
			REPO_HOST_ROOT,
		]);
		expect(unreadable).toEqual([path.join(REPO_ROOT, "clients")]);
		expect(hosts.map((host) => host.version)).toEqual([installedHost?.version]);
	});
});

describe.skipIf(installedHost === undefined)(
	"the spread probes the installed certified host and reports the rest",
	() => {
		it("prints one line per certified host, naming host and version", async () => {
			const calls: Array<{
				host: { version: string; dir: string };
				suite: TierSuite;
			}> = [];
			const spread = await runSpread({
				certified,
				hosts,
				runTierSuite: async (input) => {
					calls.push(input);
					return tierResult(true);
				},
			});
			expect(calls.map((call) => call.suite.tier)).toEqual(["tier1", "tier2"]);
			expect(spread.rows).toHaveLength(certified.length);
			expect(spread.rows[0]).toMatchObject({
				version: "0.86.1",
				installed: false,
				failed: false,
			});
			const lines = spread.rows.map(renderHostLine);
			expect(lines[0]).toBe(`${HOST_PACKAGE} 0.86.1: not installed`);
			const installedLine = lines.find((line) =>
				line.startsWith(`${HOST_PACKAGE} ${installedHost?.version} (`),
			);
			expect(installedLine).toBeDefined();
			expect(installedLine).toContain("tier1 pass 4/4");
			expect(installedLine).toContain("tier2 pass 4/4");
			expect(renderSpreadSummary(spread)).toBe(
				"certified hosts: 1 installed, 2 not installed, 0 failed",
			);
			// Missing hosts do not fail a run that did not demand them.
			expect(exitCodeForSpread(spread)).toBe(EXIT.ok);
			expect(exitCodeForSpread(spread, { requireAll: true })).toBe(
				EXIT.hostMissing,
			);
		});

		it("fails the run when an installed host fails a tier", async () => {
			const spread = await runSpread({
				certified,
				hosts,
				runTierSuite: async ({ suite }) => tierResult(suite.tier === "tier1"),
			});
			expect(spread.failed).toEqual([installedHost?.version]);
			const last = spread.rows[spread.rows.length - 1] as SpreadRow;
			expect(renderHostLine(last)).toContain("tier2 FAIL");
			expect(exitCodeForSpread(spread)).toBe(EXIT.tiersFailed);
			// A failing host outranks a missing one: the flag's exit code never
			// hides a red tier behind "not installed".
			expect(exitCodeForSpread(spread, { requireAll: true })).toBe(
				EXIT.tiersFailed,
			);
		});
	},
);

describe("a tier's verdict is fail-closed", () => {
	/** A summary shape as `parseVitestSummary` returns it on a green run. */
	const green = { testsPassed: 4, testsFailed: null, testsSkipped: null };

	it("passes a green run and counts its tests", () => {
		expect(tierVerdict({ status: 0, summary: green })).toEqual({
			ok: true,
			passed: 4,
			total: 4,
			timedOut: false,
		});
		expect(
			tierVerdict({ status: 0, summary: { ...green, testsSkipped: 2 } }).total,
		).toBe(6);
	});

	it.each([
		[
			"a failing test",
			{ status: 1, summary: { ...green, testsFailed: 1, testsPassed: 3 } },
		],
		["a non-zero exit with no red", { status: 1, summary: green }],
		[
			"a run that collected nothing",
			{
				status: 0,
				summary: { testsPassed: 0, testsFailed: 0, testsSkipped: 0 },
			},
		],
		[
			"a transcript with no counts at all",
			{
				status: 0,
				summary: { testsPassed: null, testsFailed: null, testsSkipped: null },
			},
		],
		[
			"a child killed by its timeout",
			{ status: null, timedOut: true, summary: { ...green, testsPassed: 0 } },
		],
	])("fails %s", (_name, input) => {
		expect(tierVerdict(input).ok).toBe(false);
	});
});

describe("the CLI's own decisions (no child spawned)", () => {
	/** Collect the two streams and record every tier call. */
	function runCli(argv: string[], boundaries: Record<string, unknown> = {}) {
		const out: string[] = [];
		const err: string[] = [];
		const calls: unknown[] = [];
		const mainStreams = {
			// #5670: a dependency patch bump is not a release certification.
			// These CLI cases need an explicitly certified installed host.
			readFile: () =>
				[
					"### Verified hosts",
					"",
					"| host |",
					"| --- |",
					...certified.map((version) => `| ${version} |`),
				].join("\n"),
			write: (text: string) => out.push(text),
			warn: (text: string) => err.push(text),
			runTierSuite: async (input: unknown) => {
				calls.push(input);
				return tierResult(true);
			},
		};
		return {
			calls,
			out,
			err,
			promise: main(argv, { ...mainStreams, ...boundaries }),
		};
	}

	it("prints the usage on --help and spawns nothing", async () => {
		const cli = runCli(["--help"]);
		expect(await cli.promise).toBe(EXIT.ok);
		expect(cli.out.join("")).toContain("--require-all");
		expect(cli.calls).toHaveLength(0);
	});

	it("refuses an unknown flag before it reads anything", async () => {
		const cli = runCli(["--requireall"]);
		expect(await cli.promise).toBe(EXIT.usage);
		expect(cli.err.join("")).toContain('unknown argument "--requireall"');
		expect(cli.calls).toHaveLength(0);
	});

	it("refuses a missing build and names the command", async () => {
		const cli = runCli([], {
			extensionEntry: path.join(REPO_ROOT, "no-such-index.js"),
		});
		expect(await cli.promise).toBe(EXIT.usage);
		expect(cli.err.join("")).toContain("npm run build");
		expect(cli.calls).toHaveLength(0);
	});

	it("refuses a missing Vitest entry", async () => {
		const cli = runCli([], {
			vitestEntry: path.join(REPO_ROOT, "no-such-vitest.mjs"),
		});
		expect(await cli.promise).toBe(EXIT.usage);
		expect(cli.err.join("")).toContain("devDependencies");
	});

	it("refuses a certified set it cannot read, naming the row", async () => {
		const doc = [
			"### Verified hosts",
			"",
			"| host | date |",
			"| --- | --- |",
			"| 1.4 | 2026-10-20 |",
		].join("\n");
		const cli = runCli([], {
			readFile: () => doc,
			baselineDoc: "synthetic.md",
		});
		expect(await cli.promise).toBe(EXIT.usage);
		expect(cli.err.join("")).toContain("| 1.4 | 2026-10-20 |");
		expect(cli.err.join("")).toContain("unreadable");
		expect(cli.calls).toHaveLength(0);
	});

	it("refuses a doc that names no certified host", async () => {
		const doc = [
			"### Verified hosts",
			"",
			"| host | date |",
			"| --- | --- |",
		].join("\n");
		const cli = runCli([], {
			readFile: () => doc,
			baselineDoc: "synthetic.md",
		});
		expect(await cli.promise).toBe(EXIT.usage);
		expect(cli.err.join("")).toContain("names no certified host");
	});

	needsInstalledHost(
		"warns about an installed host the certified set omits",
		async () => {
			// Recurrence (#4719 F3): a host the caller pointed `--host-root` at, but
			// the doc does not certify, appeared NOWHERE — the summary read
			// "0 installed" and a maintainer concluded the host was absent.
			const cli = runCli(["--host-root", REPO_HOST_ROOT], {
				readFile: (file: string) =>
					file === "synthetic.md"
						? [
								"### Verified hosts",
								"",
								"| host |",
								"| --- |",
								"| 9.9.9 |",
							].join("\n")
						: BASELINE_TEXT,
				baselineDoc: "synthetic.md",
			});
			expect(await cli.promise).toBe(EXIT.ok);
			expect(cli.err.join("")).toContain(
				`warning: ${HOST_PACKAGE} ${installedHost?.version} (${path.join(REPO_HOST_ROOT, HOST_PACKAGE)}) is installed but not in the certified set, so it is not probed`,
			);
			// Named, not probed: the spread has no certified host to run.
			expect(cli.calls).toHaveLength(0);
		},
	);

	it("refuses a certified table with no header row", async () => {
		// Recurrence (#4719 F4): without its header the table's first host was
		// dropped and the shorter set read as certified.
		const doc = [
			"### Verified hosts",
			"",
			"| 0.86.1 | 2026-10-08 | abc1234 | pass |",
			"| 1.3.0 | 2026-10-16 | abc1234 | pass |",
		].join("\n");
		const cli = runCli([], {
			readFile: () => doc,
			baselineDoc: "synthetic.md",
		});
		expect(await cli.promise).toBe(EXIT.usage);
		expect(cli.err.join("")).toContain("no header row above their separator");
		expect(cli.calls).toHaveLength(0);
	});

	needsInstalledHost(
		"warns about a root that holds no host and keeps probing",
		async () => {
			const cli = runCli([
				"--host-root",
				path.join(REPO_ROOT, "clients"),
				"--host-root",
				REPO_HOST_ROOT,
			]);
			expect(await cli.promise).toBe(EXIT.ok);
			expect(cli.err.join("")).toContain(`holds no ${HOST_PACKAGE}`);
			// One line per fixture-certified host, plus the
			// header and the summary line.
			const docCertified = certified;
			const lines = cli.out.join("").trimEnd().split("\n");
			expect(lines).toHaveLength(1 + docCertified.length + 1);
			expect(
				lines.some((line) =>
					line.startsWith(`${HOST_PACKAGE} ${installedHost?.version} (`),
				),
			).toBe(true);
			expect(lines.at(-1)).toBe(
				`certified hosts: ${hosts.length} installed, ${docCertified.length - hosts.length} not installed, 0 failed`,
			);
		},
	);

	needsInstalledHost(
		"prints a failed tier's transcript and exits 1",
		async () => {
			const cli = runCli(["--host-root", REPO_HOST_ROOT], {
				runTierSuite: async ({ suite }: { suite: TierSuite }) =>
					suite.tier === "tier1"
						? tierResult(true)
						: { ok: false, passed: 1, total: 2, detail: "boom from the child" },
			});
			expect(await cli.promise).toBe(EXIT.tiersFailed);
			const out = cli.out.join("");
			expect(out).toContain("tier2 FAIL 1/2");
			expect(out).toContain("boom from the child");
		},
	);

	needsInstalledHost(
		"exits 3 when --require-all demands a host this box lacks",
		async () => {
			// A certified list with one version no install carries: the spread still
			// runs the installed host and then refuses the answer.
			const cli = runCli(["--require-all", "--host-root", REPO_HOST_ROOT], {
				readFile: (file: string) =>
					file === "synthetic.md"
						? [
								"### Verified hosts",
								"",
								"| host |",
								"| --- |",
								"| 9.9.9 |",
							].join("\n")
						: BASELINE_TEXT,
				baselineDoc: "synthetic.md",
			});
			expect(await cli.promise).toBe(EXIT.hostMissing);
			expect(cli.out.join("")).toContain(
				`${HOST_PACKAGE} 9.9.9: not installed`,
			);
		},
	);
});

describe("argv is parsed fail-closed", () => {
	it("parses the supported flags", () => {
		expect(
			parseCliArgs([
				"--host-root",
				"/a",
				"--host-root",
				"/b",
				"--require-all",
				"--timeout-ms",
				"1000",
			]),
		).toEqual({
			hostRoots: [path.resolve("/a"), path.resolve("/b")],
			requireAll: true,
			timeoutMs: 1000,
			help: false,
		});
		expect(parseCliArgs([])).toEqual({
			hostRoots: [],
			requireAll: false,
			timeoutMs: 300_000,
			help: false,
		});
	});

	it.each([
		["an unknown flag", ["--requireall"]],
		["a value-less flag", ["--host-root"]],
		["a long flag swallowed as a value", ["--host-root", "--require-all"]],
		// Recurrence (#4719 F5): `-h` became a directory named `-h`, the spread
		// ran, and the run exited 0 — a typo read as a successful spread.
		["a short flag swallowed as a value", ["--host-root", "-h"]],
		["a malformed timeout", ["--timeout-ms", "5s"]],
	])("refuses %s", (_name, argv) => {
		expect(() => parseCliArgs(argv)).toThrow();
	});
});
