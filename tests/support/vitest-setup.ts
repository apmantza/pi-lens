// Per-worker test environment defaults (vitest `setupFiles`).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, expect } from "vitest";
import { installGitFixtureEnv } from "./git-fixture-env.js";
import { removeTempDirSync } from "../clients/test-utils.js";

// The review-graph persist is debounced in production (#260 circuit-breaker) so
// a burst of edits collapses to one write. In tests that would race disk-snapshot
// assertions, so default the debounce to 0 (synchronous write, the pre-#260
// behaviour). Tests that exercise the throttle override this in their own body
// and call `flushReviewGraphPersistsForTests()`.
process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS = "0";
process.env.PI_LENS_DISABLE_TOOL_INSTALL = "1";

// Same rationale, word index (#348 phase 2): per-edit updates schedule a
// debounced persist through the shared project-snapshot file. Default to a
// synchronous write in tests; tests exercising the throttle itself override
// this in their own body and call `flushWordIndexPersistsForTests()`.
process.env.PI_LENS_WORD_INDEX_PERSIST_DEBOUNCE_MS = "0";

// Pin the log rotation threshold to its default. It also bounds /lens-perf's
// read window, so an ambient value would resize what the perf tests parse.
process.env.PI_LENS_MAX_LOG_SIZE_MB = "10";

// Hermeticity: never let the developer's PERSONAL ~/.pi-lens/config.json leak
// into test behavior. Seen live 2026-07-11: opting into `turnSummary.enabled`
// on this machine flipped the #484 "default off-by-default" integration test
// red — the flag's default resolution consults the real global config unless
// PI_LENS_CONFIG_PATH points elsewhere. Point it at a path that never exists;
// tests that exercise config loading write their own file and set this
// themselves (loadPiLensGlobalConfig takes an explicit path parameter too).
process.env.PI_LENS_CONFIG_PATH = "/nonexistent-pi-lens-tests/config.json";

// Hermeticity (#525, same class as #515 above): never let a test write into
// the developer's REAL machine-global ~/.pi-lens (instances.json, logs,
// probe-cache.json, managed tool/bin dirs, ...). Dogfooded live 2026-07-11: a
// test-fixture instance (`Temp/pi-lens-turn-summary-*` projectRoot) from a
// test run survived in the real ~/.pi-lens/instances.json for ~17h. Every
// writer of machine-global state routes through the single helper
// `getGlobalPiLensDir()` (clients/file-utils.ts), which now respects
// PI_LENS_HOME — point it at a per-worker temp dir. Unlike PI_LENS_CONFIG_PATH
// above, a NONEXISTENT path is not fine here: the instance registry and
// loggers actively mkdir+write into this root during normal operation (e.g.
// registerInstance on session_start), so it must be a real, writable
// directory. Tests that deliberately exercise the real resolver (if any)
// should construct their own explicit override rather than unsetting this
// back to the real homedir.
// Tmp-fixture hygiene (#2912): keep the real TMPDIR so the final governance
// owner observes the same namespace as production. Workers report additions;
// the serialized owner removes entries after its assertion.
const tmpHygieneRealTmp = os.tmpdir();
const tmpHygieneBaselinePath = path.join(
	process.cwd(),
	".probe-home",
	`tmp-hygiene-baseline-${process.env.PI_LENS_TMP_HYGIENE_RUN_ID}.json`,
);
fs.mkdirSync(path.dirname(tmpHygieneBaselinePath), { recursive: true });
let tmpHygieneBefore: Set<string>;
try {
	tmpHygieneBefore = new Set(
		JSON.parse(fs.readFileSync(tmpHygieneBaselinePath, "utf8")) as string[],
	);
} catch {
	const baseline = snapshotTmpPiLensEntries(
		readTmpDirEntries(tmpHygieneRealTmp),
	);
	try {
		const fd = fs.openSync(tmpHygieneBaselinePath, "wx");
		fs.writeFileSync(fd, `${JSON.stringify(baseline)}\n`);
		fs.closeSync(fd);
		tmpHygieneBefore = new Set(baseline);
	} catch {
		for (let attempt = 0; attempt < 1000; attempt++) {
			try {
				tmpHygieneBefore = new Set(
					JSON.parse(
						fs.readFileSync(tmpHygieneBaselinePath, "utf8"),
					) as string[],
				);
				break;
			} catch {
				if (attempt === 999)
					throw new Error("tmp hygiene baseline did not settle");
			}
		}
	}
}
const tmpHygieneHome = process.env.PI_LENS_HOME
	? path.resolve(process.env.PI_LENS_HOME)
	: path.join(process.cwd(), ".probe-home");
fs.mkdirSync(tmpHygieneHome, { recursive: true });
process.env.PI_LENS_HOME = tmpHygieneHome;
installGitFixtureEnv(tmpHygieneHome);

interface TmpLeakAdmission {
	/** Test file (repo-relative) or "*" for every file. */
	file: string;
	/** Entry-name prefix exempted from the leak red (still removed). */
	prefix: string;
	/** Why the leftover cannot be self-cleaned. */
	reason: string;
	/** Issue tracking the remainder. */
	issue: string;
}

type TmpLeakBaseline = Omit<TmpLeakAdmission, "file" | "issue"> & {
	owner: string;
};

const tmpLeakBaselinePath = path.join(
	process.cwd(),
	"tests/config/tmp-fixture-hygiene-baseline.json",
);
const TMP_LEAK_BASELINE = JSON.parse(
	fs.readFileSync(tmpLeakBaselinePath, "utf8"),
) as TmpLeakBaseline[];

// Fixtures that may outlive their test file without reding the file.
// Admission suppresses the red. Cleanup removes admitted entries unless an
// explicit independent owner below still needs the live root.
const TMP_LEAK_ADMISSIONS: TmpLeakAdmission[] = [
	...TMP_LEAK_BASELINE.map(({ prefix, reason }) => ({
		file: "*",
		prefix,
		reason: `${reason} The admission is a ratchet baseline; remove it when the owner is fixed.`,
		issue: "#2912",
	})),
	{
		file: "*",
		prefix: "pi-lens-ast-grep",
		reason:
			"Production-owned bounded sgconfig baseline cache (entry cap 24 with oldest-first eviction plus a 7-day stale sweep in clients/sgconfig.ts); its lifecycle is owned by the process rather than an individual test file.",
		issue: "#2912",
	},
	{
		file: "*",
		prefix: "pi-lens-scratch",
		reason:
			"The sanctioned scripts/lib/scratch-dir.mjs process-owned root is shared by concurrent probes; its owner sweeps children, so the final test file does not remove an active sibling root.",
		issue: "#2912",
	},
	{
		file: "*",
		prefix: "pi-lens-master-",
		reason:
			"A concurrent clean-master probe owns this explicitly named root outside the Vitest worker population; removing it would mutate a sibling agent's fixture.",
		issue: "#2912",
	},
	{
		file: "*",
		prefix: "pi-lens-round2-",
		reason:
			"A concurrent round-two probe owns this explicitly named report file outside the Vitest worker population; removing it would mutate a sibling agent's evidence.",
		issue: "#2912",
	},
	{
		file: "*",
		prefix: "pi-lens-test-home-",
		reason:
			"A sibling Vitest invocation creates this worker home outside the serialized run; the current invocation pins PI_LENS_HOME and must not delete another worker's home.",
		issue: "#2912",
	},
	{
		file: "*",
		prefix: "pi-lens-mcp-",
		reason:
			"A concurrent MCP worker owns this socket or workspace prefix outside the serialized run; its child-exit cleanup is tested separately and this sweep cannot kill a sibling endpoint.",
		issue: "#2912",
	},
	{
		file: "*",
		prefix: "pi-lens-result-contract-",
		reason:
			"A concurrent result-contract worker owns this fixture outside the serialized run; removing it would mutate another worker's active MCP test.",
		issue: "#2912",
	},
	{
		file: "*",
		prefix: "pi-lens-wiring-fork-",
		reason:
			"A concurrent wiring-fork probe owns this explicitly named fixture outside the Vitest worker population; the hygiene owner cannot remove a sibling probe's live root.",
		issue: "#2912",
	},
	{
		file: "*",
		prefix: "pi-lens-lockfile-complete-",
		reason:
			"A concurrent lockfile-completeness probe owns this fixture outside the Vitest worker population; the serialized owner cannot remove its live temporary root.",
		issue: "#2912",
	},
];

function readTmpDirEntries(dir: string): string[] {
	try {
		return fs.readdirSync(dir);
	} catch {
		return [];
	}
}

function snapshotTmpPiLensEntries(entries: string[]): string[] {
	return entries.filter((name) => name.startsWith("pi-lens-"));
}

function isAdmittedTmpLeak(
	testFile: string,
	entryName: string,
	admissions: TmpLeakAdmission[] = TMP_LEAK_ADMISSIONS,
): TmpLeakAdmission | undefined {
	return admissions
		.filter(
			(admission) =>
				(admission.file === "*" || testFile.endsWith(admission.file)) &&
				entryName.startsWith(admission.prefix),
		)
		.sort((left, right) => right.prefix.length - left.prefix.length)[0];
}

export function tmpHygieneAdmissionFor(
	testFile: string,
	entryName: string,
	admissions: TmpLeakAdmission[] = TMP_LEAK_ADMISSIONS,
): TmpLeakAdmission | undefined {
	return isAdmittedTmpLeak(testFile, entryName, admissions);
}

export function tmpHygieneUnadmittedEntries(
	entries: string[],
	testFile: string,
	admissions: TmpLeakAdmission[] = TMP_LEAK_ADMISSIONS,
): string[] {
	return entries.filter(
		(name) => !isAdmittedTmpLeak(testFile, name, admissions),
	);
}

export function tmpHygieneObservedEntries(): string[] {
	return snapshotTmpPiLensEntries(readTmpDirEntries(tmpHygieneRealTmp)).filter(
		(entry) => !tmpHygieneBefore.has(entry),
	);
}

export function tmpHygieneLeakReport(): {
	testFile: string;
	leftovers: string[];
} {
	const testFile =
		String(expect.getState().testPath ?? "unknown")
			.replace(/\\/g, "/")
			.split("/tests/")
			.pop() ?? "unknown";
	const after = new Set(
		snapshotTmpPiLensEntries(readTmpDirEntries(tmpHygieneRealTmp)),
	);
	return {
		testFile,
		leftovers: tmpHygieneUnadmittedEntries(
			[...after].filter((name) => !tmpHygieneBefore.has(name)),
			testFile,
		),
	};
}

afterAll(() => {
	const { testFile, leftovers } = tmpHygieneLeakReport();
	const after = new Set(
		snapshotTmpPiLensEntries(readTmpDirEntries(tmpHygieneRealTmp)),
	);
	const allNew = [...after].filter((name) => !tmpHygieneBefore.has(name));
	if (process.env.PI_LENS_TMP_HYGIENE_TRACE === "1")
		process.stderr.write(
			`[tmp-hygiene-trace] tests/${testFile} leaked=${leftovers.length} entries=${allNew.join(",")}\n`,
		);
	const leakedCount = leftovers.length;
	if (leakedCount > 0 && process.env.PI_LENS_TMP_HYGIENE_TRACE !== "1")
		console.warn(
			`[tmp-hygiene] observed ${leakedCount} unadmitted entry(s) from ${tmpHygieneRealTmp}; the serialized governance owner cleans them`,
		);
});

export function cleanupTmpHygiene(): void {
	const after = snapshotTmpPiLensEntries(readTmpDirEntries(tmpHygieneRealTmp));
	for (const name of after) {
		if (tmpHygieneBefore.has(name)) continue;
		if (
			TMP_HYGIENE_INDEPENDENT_OWNERS.some((prefix) => name.startsWith(prefix))
		)
			continue;
		removeTempDirSync(path.join(tmpHygieneRealTmp, name));
	}
	try {
		fs.rmSync(tmpHygieneBaselinePath, { force: true });
	} catch {
		// A stale ignored baseline is harmless; the next run uses a new id.
	}
}

// These roots belong to a separate live process or shared owner. Every other
// admitted prefix is removed after the governance assertion, so admissions
// cannot become a permanent inode leak.
const TMP_HYGIENE_INDEPENDENT_OWNERS = [
	"pi-lens-ast-grep",
	"pi-lens-scratch",
	"pi-lens-master-",
	"pi-lens-round2-",
	"pi-lens-test-home-",
	"pi-lens-mcp-",
	"pi-lens-result-contract-",
	"pi-lens-wiring-fork-",
	"pi-lens-lockfile-complete-",
];

// Hand this worker the suite-wide tool template's probe cache (built once by
// prewarm-tool-home.ts globalSetup). ensureTool's probe-cache fast path then
// resolves the template's already-installed binaries instead of paying a cold
// npm install per worker. Entries point INTO the template dir — validated by
// path+mtime on every read, and executed read-only, so sharing is safe.
const toolTemplate = process.env.PI_LENS_TEST_TOOLS_TEMPLATE;
if (toolTemplate) {
	try {
		fs.copyFileSync(
			path.join(toolTemplate, "probe-cache.json"),
			path.join(process.env.PI_LENS_HOME, "probe-cache.json"),
		);
	} catch {
		// missing template file — worker simply runs cold, as before
	}
}

// #2042: per-file peak memory, for the files big enough to matter.
//
// Vitest's forks pool with `isolate: true` gives every test FILE its own child
// process (verified 2026-08-25: 20 files at `maxWorkers: 1` produced 20 distinct
// pids), so `process.resourceUsage().maxRSS` at the end of a file is that
// file's own peak, uncontaminated by its neighbours. Measured over all 740
// files of the default project: p50 93 MB, p90 389 MB, p99 1405 MB, max
// 2267 MB. The heavy tail is NATIVE memory — tree-sitter wasm grammar compiles
// and @ast-grep/napi arenas — which no V8 flag bounds and no reporter shows.
//
// What this record can and cannot say. It is an `afterAll` hook, so it only
// fires for a file that FINISHED. The file that was mid-run when the OS killed
// the job never reports its own peak. What the last lines before a kill name is
// the completed co-residents -- the memory profile of the phase the run died
// in, not the culprit. That is still far better than the nothing there was
// before, but it is circumstantial evidence, not attribution, and the
// `[mem-watch]` low-water mark is the record that says how close the run
// actually came.
//
// `maxRSS` is kilobytes on every platform: libuv normalizes the Win32 peak
// working set for `uv_getrusage`, so no per-platform scaling is needed.
const memReportThresholdMb = Number(
	process.env.PI_LENS_TEST_MEM_REPORT_MB ?? (process.env.CI ? "512" : "0"),
);
if (memReportThresholdMb > 0) {
	afterAll(() => {
		const usage = process.memoryUsage();
		const peakMb = Math.round(process.resourceUsage().maxRSS / 1024);
		if (peakMb < memReportThresholdMb) return;
		const file = String(expect.getState().testPath ?? "unknown")
			.replace(/\\/g, "/")
			.split("/tests/")
			.pop();
		// Straight to the fork's stderr, not `console.log`: vitest intercepts
		// worker console output and routes it through the reporter, which
		// attributes it to a task and can drop it entirely for a hook that runs
		// after the last test (verified 2026-08-25 — the console form printed
		// nothing). A raw write lands in the job log unconditionally, which is the
		// whole point of a line whose only reader is a post-mortem.
		process.stderr.write(
			`[mem-file] peakRssMb=${peakMb} heapUsedMb=${Math.round(usage.heapUsed / 1048576)} externalMb=${Math.round(usage.external / 1048576)} tests/${file}\n`,
		);
	});
}
