// Per-worker test environment defaults (vitest `setupFiles`).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, expect } from "vitest";
import { installGitFixtureEnv } from "./git-fixture-env.js";

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
process.env.PI_LENS_HOME = fs.mkdtempSync(
	path.join(os.tmpdir(), "pi-lens-test-home-"),
);
installGitFixtureEnv(process.env.PI_LENS_HOME);

// Tmp-fixture hygiene (#2912): every temp dir a test file creates under the
// OS temp root is contained in a per-file private root and removed when the
// file finishes, even when tests fail. `os.tmpdir()` reads TMPDIR/TMP/TEMP on
// every call (probed 2026-09-11), so pointing those at the private root before
// the test file loads contains every `fs.mkdtempSync(path.join(os.tmpdir(),
// ...))` site without touching any call site. The setup `afterAll` below runs
// AFTER the test file's own `afterAll` hooks (probed 2026-09-11), so it sees
// the file's final state: leftovers are removed and, unless admitted below,
// fail the file. Pre-existing /tmp junk is excluded by the before-snapshot.
const tmpHygieneRealTmp = os.tmpdir();
const tmpHygieneBefore = new Set(
	snapshotTmpPiLensEntries(readTmpDirEntries(tmpHygieneRealTmp)),
);
const tmpHygieneRoot = fs.mkdtempSync(
	path.join(os.tmpdir(), "pi-lens-test-file-"),
);
process.env.TMPDIR = tmpHygieneRoot;
process.env.TMP = tmpHygieneRoot;
process.env.TEMP = tmpHygieneRoot;

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

// Fixtures that may outlive their test file without reding the file.
// An admitted entry is STILL removed by the afterAll below; admission only
// suppresses the red, never the hygiene.
const TMP_LEAK_ADMISSIONS: TmpLeakAdmission[] = [
	{
		file: "*",
		prefix: "pi-lens-ast-grep",
		reason:
			"Production-owned bounded sgconfig baseline cache (entry cap 24 with oldest-first eviction plus a 7-day stale sweep in clients/sgconfig.ts); no test-owned cleanup seam exists for it, and the hook removes the directory with the private root regardless.",
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
): TmpLeakAdmission | undefined {
	return TMP_LEAK_ADMISSIONS.find(
		(admission) =>
			(admission.file === "*" || testFile.endsWith(admission.file)) &&
			entryName.startsWith(admission.prefix),
	);
}

afterAll(() => {
	const testFile = String(expect.getState().testPath ?? "unknown")
		.replace(/\\/g, "/")
		.split("/tests/")
		.pop() ?? "unknown";
	let leftovers: string[] = [];
	try {
		leftovers = fs
			.readdirSync(tmpHygieneRoot)
			.filter((name) => !isAdmittedTmpLeak(testFile, name));
	} catch {
		// Private root already gone; nothing to check.
	}
	const leakedCount = leftovers.length;
	try {
		fs.rmSync(tmpHygieneRoot, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 200,
		});
	} catch (err) {
		console.warn(
			`[test cleanup] could not remove temp root ${tmpHygieneRoot}: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}
	if (leakedCount > 0) {
		const sample = leftovers.slice(0, 8).join(", ");
		throw new Error(
			`[tmp-hygiene] ${leakedCount} leaked temp entr${leakedCount === 1 ? "y" : "ies"} in ${tmpHygieneRoot}: ${sample}. ` +
				`Remove each mkdtemp dir in an afterEach/afterAll through removeTempDirSync (tests/clients/test-utils.ts). ` +
				`See tests/config/tmp-fixture-hygiene.test.ts.`,
		);
	}
	// Informational only, never a red: parallel workers share /tmp, so this
	// delta cannot attribute ownership. The static sweep owns hardcoded-/tmp
	// sites; the private-root check above owns the rest.
	const after = new Set(
		snapshotTmpPiLensEntries(readTmpDirEntries(tmpHygieneRealTmp)),
	);
	let globalDelta = 0;
	for (const name of after) {
		if (!tmpHygieneBefore.has(name) && !name.startsWith("pi-lens-test-file-")) {
			globalDelta += 1;
		}
	}
	if (globalDelta > 0) {
		process.stderr.write(
			`[tmp-hygiene] tests/${testFile}: ${globalDelta} new /tmp/pi-lens-* entries outside the private root (not attributed, not a failure)\n`,
		);
	}
});

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
