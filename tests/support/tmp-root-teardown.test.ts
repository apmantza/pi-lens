// flake-shape: real-process-spawn — the subject is Vitest's own fork teardown: the pool SIGTERMs each fork after the shared afterAll, and no in-process double reproduces a test timeout, a worker kill or a write landing in the window before that SIGTERM.
/**
 * The shared setup's tmp-root sweep, driven through the REAL hooks (#2912).
 *
 * Recurrences it names, all seen in the required Unit tests job on
 * 2026-09-30 with "live owners: none", on PRs that did not touch the leaking
 * file: `pi-lens-sym-cpp-*` (a test timed out holding its registered root,
 * #3706), `pi-lens-install-attempt-*` (#3705) and
 * `pi-lens-tool-discovery-home-*` (#3699), both raw roots the file removed and
 * a deferred write recreated. Each fixture file below reproduces one shape,
 * deterministically, in its own fork of a child Vitest run that loads the real
 * `tests/support/vitest-setup.ts` and a PRIVATE `TMPDIR`; the assertions read
 * what the forks left there once the pool tore them down. `genuine-leak`
 * pins the other direction: a forgotten cleanup and a directory this worker did
 * not create must still be there for the hygiene owner to red.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestEnvironment } from "../clients/test-utils.js";
import {
	closeTmpHygieneCreators,
	flushTmpHygieneRecordsForTests,
	formatTmpHygieneLeakEntry,
	tmpHygieneCreators,
	tmpHygieneCreatorsPath,
	tmpHygieneSweepRecords,
	tmpHygieneUnadmittedEntries,
} from "./vitest-setup.js";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const FIXTURE_DIR = "tests/fixtures/tmp-teardown";

interface FixtureReport {
	testResults: Array<{
		name: string;
		status: string;
		assertionResults: Array<{ status: string }>;
	}>;
}

const env = setupTestEnvironment("pi-lens-tmp-root-teardown-");
const RUN_ID = `tmp-root-teardown-${process.pid}-${Date.now()}`;
let childTmp = "";
let stderr = "";
let report: FixtureReport = { testResults: [] };

function outcomeOf(fixture: string): string | undefined {
	return report.testResults.find((entry) =>
		entry.name.replace(/\\/g, "/").endsWith(`${FIXTURE_DIR}/${fixture}`),
	)?.status;
}

/** Status of the fixture file's first test as the JSON reporter saw it. A test
 *  whose worker died before it reported stays "pending". */
function firstTestStatusOf(fixture: string): string | undefined {
	return report.testResults.find((entry) =>
		entry.name.replace(/\\/g, "/").endsWith(`${FIXTURE_DIR}/${fixture}`),
	)?.assertionResults[0]?.status;
}

/** What the child's forks left in its private tmpdir. */
function leftovers(prefix = "pi-lens-2912-"): string[] {
	return fs.readdirSync(childTmp).filter((name) => name.startsWith(prefix));
}

function sweepLine(fixture: string, via: string): string {
	const line = stderr
		.split("\n")
		.find(
			(candidate) =>
				candidate.includes(`[tmp-hygiene-sweep] ${FIXTURE_DIR}/${fixture}`) &&
				candidate.includes(`via=${via}`),
		);
	return line?.slice(line.indexOf("[tmp-hygiene-sweep]")) ?? "";
}

beforeAll(async () => {
	childTmp = path.join(env.tmpDir, "tmp");
	fs.mkdirSync(childTmp, { recursive: true });
	const outputFile = path.join(env.tmpDir, "report.json");
	stderr = await new Promise<string>((resolve) => {
		execFile(
			process.execPath,
			[
				path.join(REPO, "node_modules/vitest/vitest.mjs"),
				"run",
				"--config",
				`${FIXTURE_DIR}/vitest.config.ts`,
				"--reporter=json",
				`--outputFile=${outputFile}`,
			],
			{
				cwd: REPO,
				timeout: 90_000,
				env: {
					...process.env,
					TMPDIR: childTmp,
					TMP: childTmp,
					TEMP: childTmp,
					PI_LENS_HOME: path.join(env.tmpDir, "home"),
					PI_LENS_TMP_HYGIENE_RUN_ID: RUN_ID,
				},
			},
			(_error, _stdout, childStderr) => resolve(String(childStderr)),
		);
	});
	try {
		report = JSON.parse(fs.readFileSync(outputFile, "utf8")) as FixtureReport;
	} catch {
		// A killed worker can leave the reporter without a file; the tests that
		// need an outcome say so by name.
	}
}, 120_000);

afterAll(() => {
	// The child's setup keeps its baseline and manifest beside this run's,
	// under the cwd it inherited; they are named by the run id above.
	const records = path.join(REPO, ".probe-home");
	for (const name of fs.existsSync(records) ? fs.readdirSync(records) : [])
		if (name.includes(RUN_ID))
			fs.rmSync(path.join(records, name), { recursive: true, force: true });
	env.cleanup();
});

describe("shared setup tmp-root sweep, through the real hooks (#2912)", () => {
	it("removes a registered root whose test timed out holding it", () => {
		expect(outcomeOf("timeout-holding-root.fixture.ts")).toBe("failed");
		expect(leftovers("pi-lens-2912-timeout-")).toEqual([]);
		expect(sweepLine("timeout-holding-root.fixture.ts", "afterAll")).toContain(
			"registered=1",
		);
	});

	it("removes a registered root whose test failed an assertion before cleanup", () => {
		expect(outcomeOf("assertion-before-cleanup.fixture.ts")).toBe("failed");
		expect(leftovers("pi-lens-2912-assert-")).toEqual([]);
		expect(
			sweepLine("assertion-before-cleanup.fixture.ts", "afterAll"),
		).toContain("registered=1");
	});

	// lane: Unit tests (ubuntu). Windows cannot deliver SIGTERM to a JS handler (a kill there is TerminateProcess), so only the afterAll sweep applies on that platform.
	it("removes a registered root when the worker is SIGTERM'd mid-file", (context) => {
		context.skip(
			process.platform === "win32",
			"SIGTERM is not deliverable to a handler on win32",
		);
		// The handler re-raises, so the fork really dies and its one test never
		// reports ("pending"); a swallowed signal would let the 10 s wait end and it would.
		expect(firstTestStatusOf("killed-mid-file.fixture.ts")).toBe("pending");
		expect(leftovers("pi-lens-2912-killed-")).toEqual([]);
		expect(sweepLine("killed-mid-file.fixture.ts", "SIGTERM")).toContain(
			"registered=1",
		);
	});

	it("removes a registered root created through a re-evaluated test-utils", () => {
		expect(outcomeOf("reset-modules.fixture.ts")).toBe("passed");
		expect(leftovers("pi-lens-2912-reset-")).toEqual([]);
		expect(sweepLine("reset-modules.fixture.ts", "afterAll")).toContain(
			"registered=1",
		);
	});

	it("removes a raw root a deferred write recreated before the file's afterAll", () => {
		expect(outcomeOf("straggler-before-afterall.fixture.ts")).toBe("passed");
		expect(leftovers("pi-lens-2912-straggler-early-")).toEqual([]);
		expect(
			sweepLine("straggler-before-afterall.fixture.ts", "afterAll"),
		).toContain("stragglers=1");
	});

	// lane: Unit tests (ubuntu). Windows cannot deliver SIGTERM to a JS handler (a kill there is TerminateProcess), so only the afterAll sweep applies on that platform.
	it("removes a raw root a deferred write recreated after the file's afterAll, on SIGTERM", (context) => {
		context.skip(
			process.platform === "win32",
			"SIGTERM is not deliverable to a handler on win32",
		);
		expect(outcomeOf("straggler-after-afterall.fixture.ts")).toBe("passed");
		expect(leftovers("pi-lens-2912-straggler-late-")).toEqual([]);
		expect(
			sweepLine("straggler-after-afterall.fixture.ts", "SIGTERM"),
		).toContain("stragglers=1");
	});

	it("leaves a forgotten raw root and a root it did not create for the hygiene owner", () => {
		expect(outcomeOf("genuine-leak.fixture.ts")).toBe("passed");
		const left = leftovers();
		expect(left).toHaveLength(2);
		expect(left).toContain("pi-lens-2912-genuine-mkdir-sibling");
		expect(
			left.filter((name) => name.startsWith("pi-lens-2912-genuine-raw-")),
		).toHaveLength(1);
		// The hygiene owner's own admission logic reds on both.
		expect(
			tmpHygieneUnadmittedEntries(
				left,
				"fixtures/tmp-teardown/genuine-leak.fixture.ts",
			).length,
		).toBe(2);
		expect(sweepLine("genuine-leak.fixture.ts", "afterAll")).toBe("");
	});

	it("persists the creating test file for a raw root and an mkdir sibling, and omits a child's (cross-process)", () => {
		// #2912 (2026-10-10): the interposer runs in the FIXTURE's fork, so the
		// creators record only crosses to the serialized owner through this
		// run-id-scoped file. #4560 widened it: a fixture sibling a test process
		// made with `mkdir` at the tmp root is named too (it still never joins the
		// sweep registry). A child process's own directory has no interposer, so
		// the owner keeps labelling it as created outside the test process.
		const creators = tmpHygieneCreators(
			path.join(REPO, ".probe-home", `tmp-hygiene-creators-${RUN_ID}.log`),
		);
		const rawLeak = leftovers("pi-lens-2912-genuine-raw-")[0];
		expect(rawLeak).toBeDefined();
		expect(creators.get(rawLeak)).toBe(
			"fixtures/tmp-teardown/genuine-leak.fixture.ts",
		);
		expect(creators.get("pi-lens-2912-genuine-mkdir-sibling")).toBe(
			"fixtures/tmp-teardown/genuine-leak.fixture.ts",
		);
		// #4307-1: the record is appended at BOTH teardowns -- the file's afterAll
		// and the pool's SIGTERM -- so `flushTmpRootCreators` dedupes per line. A
		// regression there doubles the raw record; `tmpHygieneCreators` first-wins
		// would hide it, so assert on the RAW persisted lines.
		const recordPath = path.join(
			REPO,
			".probe-home",
			`tmp-hygiene-creators-${RUN_ID}.log`,
		);
		const lines = fs
			.readFileSync(recordPath, "utf8")
			.split("\n")
			.filter((line) => line.length > 0);
		expect(lines.length).toBeGreaterThan(0);
		expect(new Set(lines).size, lines.join("|")).toBe(lines.length);
	});

	it("persists what each sweep found at every registered root, so the census can name the producer (#4591)", () => {
		// The census runs in another worker after the file's fork is gone, so the
		// registry's view at sweep time only crosses through the run's record. The
		// Windows lane reds about one run in ten on a root that reappeared after
		// its file's sweep; the record separates a registered root a deferred writer
		// recreated from a root the sweep never owned.
		const records = tmpHygieneSweepRecords(
			tmpHygieneCreators(
				path.join(REPO, ".probe-home", `tmp-hygiene-creators-${RUN_ID}.log`),
			),
		);
		// The afterAll sweep is the one every platform runs; the SIGTERM sweep is
		// not deliverable on win32, so it is not asserted here.
		const recordFor = (prefix: string) =>
			[...records].find(([name]) => name.startsWith(prefix))?.[1];
		const afterAllFor = (prefix: string) =>
			recordFor(prefix)?.find((record) => record.via === "afterAll");
		// A registered root the test timed out holding: the sweep removed it.
		expect(afterAllFor("pi-lens-2912-timeout-")).toEqual(
			expect.objectContaining({ kind: "registered", outcome: "removed" }),
		);
		// A raw root the file never removed: the registry held it and the sweep
		// left it for the owner, which is "held", not "removed".
		expect(afterAllFor("pi-lens-2912-genuine-raw-")).toEqual(
			expect.objectContaining({ kind: "observed", outcome: "held" }),
		);
		// A directory a child process made was never in the registry at all.
		expect(recordFor("pi-lens-2912child-")).toBeUndefined();
		// A file that left fake timers installed at its sweep: the stamp is still
		// this run's wall clock (the census compares it with filesystem times),
		// never the fake clock's epoch.
		const stamp = afterAllFor("pi-lens-4591-faketimers-")?.at ?? 0;
		expect(stamp).toBeGreaterThan(Date.now() - 10 * 60_000);
		expect(stamp).toBeLessThanOrEqual(Date.now());
	});

	it("labels an entry a grandchild process made as created outside the test process", () => {
		// #2912 (2026-10-10): the real-pi jscpd shape — a process the fixture
		// spawned makes the root, so no interposer in the run observes it. The
		// creators record is silent and the owner must not fall back to a prefix
		// owner; it names the outside-process origin instead.
		const entries = leftovers("pi-lens-2912child-");
		expect(entries).toHaveLength(1);
		const entry = entries[0];
		const creators = tmpHygieneCreators(
			path.join(REPO, ".probe-home", `tmp-hygiene-creators-${RUN_ID}.log`),
		);
		expect(creators.has(entry)).toBe(false);
		expect(formatTmpHygieneLeakEntry(entry, undefined, undefined)).toBe(
			`${entry} (created outside the test process, or the creators record was unreadable)`,
		);
	});

	it("does not recreate the creators record after cleanup has closed the flush", () => {
		// #4307 sweep: the owner's cleanup runs BEFORE the setup's own afterAll
		// flush under the stack hook order, so the closed latch is what keeps the
		// flush from recreating the record it removed. This worker's registry
		// already holds a created entry (`setupTestEnvironment` at module load),
		// so a missing latch in the creators flush would write the file back;
		// #5081 review F4: so would a missing latch in the sweep-record flush,
		// which is handed a real sweep line here.
		closeTmpHygieneCreators();
		flushTmpHygieneRecordsForTests([
			`sweep:afterAll:pi-lens-4591-latch\tregistered,removed,${Date.now()}`,
		]);
		expect(fs.existsSync(tmpHygieneCreatorsPath)).toBe(false);
	});
});
