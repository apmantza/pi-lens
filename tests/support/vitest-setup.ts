// Per-worker test environment defaults (vitest `setupFiles`).
import * as fs from "node:fs";
import nodeFs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeEach, expect, vi } from "vitest";
import { installGitFixtureEnv } from "./git-fixture-env.js";
import { installKillGuard, killGuardReport } from "./kill-guard.js";
import { currentPeakRssMb, reportPeakRss } from "./worker-peak-rss.js";
import {
	fixtureHomeRoot,
	fixtureHomeRootIn,
	removeTempDirSync,
	restorePinnedFixtureHomes,
} from "../clients/test-utils.js";
import {
	formatTmpRootCreators,
	formatTmpRootSweep,
	formatTmpRootSweepRecords,
	getTmpRootRegistry,
	installTmpRootInterposer,
	REPO_ROOT_CREATE_PREFIX,
	sampleTmpRoots,
	sweepTmpRoots,
	TMP_ROOT_SWEEP_PREFIX,
	type TmpRootFsTarget,
} from "./tmp-root-registry.js";
// The tail's dependency leaf, never `instance-registry.js`: this file loads
// before every test file's `vi.mock`, so whatever it imports is cached before
// the mock registers (#3703 round 1: 56 files red).
import { _settleRegistryMutationsForTests } from "../../clients/instance-registry-tail.js";
import {
	claimScratchDir,
	SCRATCH_DIR_ROOT,
	SWEEP_ANY_AGE,
	sweepScratchDirs,
} from "../../scripts/lib/scratch-dir.mjs";

// #2042: before anything else in the worker, so the guard is already in place
// when a test's own `process.once("exit")` handler fires at fork teardown.
installKillGuard();

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

// #4673: pi builds its jiti with `{ moduleCache: false }` and no `cache` --
// its `createJiti(import.meta.url, …)` call at
// `@earendil-works/pi-coding-agent/dist/core/extensions/loader.js:477` -- so
// on the first by-path extension load jiti's `prepareCacheDir` finds no
// `node_modules` sibling of the loader file and mkdirs
// `path.join(os.tmpdir(), "jiti")` IN THIS PROCESS. The shared setup's
// tmp-root interposer records that write as a #4560 fixture sibling created by
// whichever file was loading, so a run that pairs
// `tests/clients/skills-package-filter.test.ts` with the hygiene census reds
// on a name neither file spells. Disable the cache instead of relocating it:
// jiti's env knobs are booleans (`JITI_CACHE=/tmp/x` still derives
// `<tmpdir>/jiti`), a cache DIRECTORY is the caller's option and pi passes
// none, and `TMPDIR` is the census root itself (AGENTS.md: never move the
// harness home through it). Both are FORCED, not defaulted, because an ambient
// value must not put the sibling back (same reason `PI_LENS_STARTUP_MODE` is
// deleted below), and `JITI_FS_CACHE` wins over `JITI_CACHE` inside jiti, so
// setting only the latter is not enough. Mirrored in `vitest.config.ts` for
// the pre-fork process; `tests/config/tmp-fixture-hygiene.test.ts` drives the
// load and pins both halves.
process.env.JITI_FS_CACHE = "0";
process.env.JITI_CACHE = "0";

// Hermeticity: never let the developer's PERSONAL ~/.pi-lens/config.json leak
// into test behavior. Seen live 2026-07-11: opting into `turnSummary.enabled`
// on this machine flipped the #484 "default off-by-default" integration test
// red — the flag's default resolution consults the real global config unless
// PI_LENS_CONFIG_PATH points elsewhere. Point it at a path that never exists;
// tests that exercise config loading write their own file and set this
// themselves (loadPiLensGlobalConfig takes an explicit path parameter too).
process.env.PI_LENS_CONFIG_PATH = "/nonexistent-pi-lens-tests/config.json";

// Same class: resolveStartupMode reads PI_LENS_STARTUP_MODE before any config,
// so a developer shell's "minimal" changed session_start for every test that
// drives it (seen 2026-10-16: six golden witnesses gained the startup guidance
// block). Tests that exercise a mode set it themselves.
delete process.env.PI_LENS_STARTUP_MODE;

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
/** The checkout root a worker runs in (#4864): the same default
 *  `unadmittedRepoRootEntries` judges, captured once so a case that `chdir`s
 *  into its own fixture repo cannot move which parent is judged. */
const tmpHygieneRepoRoot = process.cwd();

const tmpHygieneHome = process.env.PI_LENS_HOME
	? path.resolve(process.env.PI_LENS_HOME)
	: path.join(process.cwd(), ".probe-home");
fs.mkdirSync(tmpHygieneHome, { recursive: true });
/** The run-shared directory: harness state every worker and the serialized
 *  hygiene owner must see (owner markers, baselines, the tmp-hygiene records,
 *  `install.log`, the agent dir). Since #3721 it is NOT what `PI_LENS_HOME`
 *  names inside a worker: that is {@link TMP_HYGIENE_WORKER_HOME}. Tests whose
 *  subject is the run-shared directory read it from here. */
export const TMP_HYGIENE_HOME = tmpHygieneHome;
// #3721: the log sinks bind their paths at module load from PI_LENS_HOME, and
// one home for every worker meant the 33 files that run with
// PI_LENS_TEST_MODE=0 shared one `latency.log`: a neighbour's rows leaked into
// this file's reads ("got 5") and its `clearLatencyLog()` cut this file's rows
// ("got 1", "got 2"; #3880: 15 of 15 runs red for
// test-runner-python-environment beside session-root-config-eviction at 4
// workers). Vitest's forks pool with isolate:true gives every test FILE its
// own process, so the process id names the worker, and a directory per worker
// makes cross-worker sharing impossible by construction instead of file by file.
// Removed by this worker's own teardown; the serialized owner sweeps what a
// deferred writer recreated and what a killed run left (`removeRunBackstopDirs`).
const tmpHygieneWorkerHomePrefix = `worker-home-${process.env.PI_LENS_TMP_HYGIENE_RUN_ID}-`;
export const TMP_HYGIENE_WORKER_HOME = path.join(
	tmpHygieneHome,
	`${tmpHygieneWorkerHomePrefix}${process.pid}`,
);
fs.mkdirSync(TMP_HYGIENE_WORKER_HOME, { recursive: true });
const tmpHygieneBaselinePath = path.join(
	process.cwd(),
	".probe-home",
	`tmp-hygiene-baseline-${process.env.PI_LENS_TMP_HYGIENE_RUN_ID}.json`,
);
fs.mkdirSync(path.dirname(tmpHygieneBaselinePath), { recursive: true });

// #3186: a process-shared marker lets the serialized hygiene owner distinguish
// a root whose test file is still running from one whose cleanup drain ended.
// The marker is deliberately per worker and run-scoped. PID alone is not an
// identity: a killed worker can leave an orphan whose PID is still live or is
// later reused.
//
// Round 3 (HIGH-3297-V1): the identity is the marker's OWN mtime, refreshed by
// this worker's test lifecycle — a heartbeat no other process can forge and no
// platform can withhold. `/proc/<pid>/stat`'s start time stays as an EXTRA
// check where the platform supplies one; round 2 made it the sole gate, which
// on darwin/win32 wrote every marker without a start time and then rejected
// every marker, disabling the live-owner arm for all workers.
const tmpHygieneOwnerDir = path.join(tmpHygieneHome, "tmp-hygiene-owners");
fs.mkdirSync(tmpHygieneOwnerDir, { recursive: true });
const tmpHygieneOwnerMarker = path.join(
	tmpHygieneOwnerDir,
	`${process.env.PI_LENS_TMP_HYGIENE_RUN_ID}-${process.pid}.json`,
);
/** This worker's test file in the ONE spelling the whole hygiene seam uses:
 *  the path below `tests/`, forward slashes. The owner marker, the run-file
 *  manifest and the leak report all name a file this way, and the owner index
 *  in `tests/config/tmp-fixture-hygiene.test.ts` maps a tmp prefix to the same
 *  spelling — one derivation, so the four can never disagree. */
function tmpHygieneFileOf(testPath: unknown): string {
	return (
		String(testPath ?? "unknown")
			.replace(/\\/g, "/")
			.split("/tests/")
			.pop() ?? "unknown"
	);
}
const tmpHygieneOwnFile = tmpHygieneFileOf(expect.getState().testPath);
const tmpHygieneOwnerMarkerBody = JSON.stringify({
	pid: process.pid,
	startTime: readTmpHygieneProcessStartTime(process.pid),
	file: tmpHygieneOwnFile,
});
fs.writeFileSync(tmpHygieneOwnerMarker, tmpHygieneOwnerMarkerBody);

/**
 * #3314: the run-file manifest — every test file a worker of THIS run id
 * loaded, appended once at module load.
 *
 * The marker above answers "is this owner alive right now?" and is removed at
 * teardown. This record answers a different question the census has never been
 * able to ask: "did this invocation run the file that owns this tmp entry at
 * all?" Two vitest invocations share one TMPDIR whenever they share a shell's
 * `TMPDIR` — `npm run test:targeted` takes one of two SHARED slots
 * (scripts/with-test-lock.mjs), so this is the daily case, not a corner — and
 * the run baseline cannot separate them: a root the sibling invocation creates
 * after our snapshot is new to us, is attributed to whatever prefix matches (or
 * to nothing at all), and is then DELETED by our own `cleanupTmpHygiene`.
 *
 * Append-only, one short line per worker, so ~1150 concurrent appends need no
 * lock. A line somehow torn by a concurrent append simply fails to match a file
 * name, which puts the entry back in the judged set — the fail-closed
 * direction. The manifest is run-id scoped by NAME, so a previous or concurrent
 * run's manifest is never read (F7), and it is removed beside this run's
 * baseline record in `cleanupTmpHygiene` below.
 */
const tmpHygieneRunFilesPath = path.join(
	path.dirname(tmpHygieneBaselinePath),
	`tmp-hygiene-files-${process.env.PI_LENS_TMP_HYGIENE_RUN_ID}.log`,
);
try {
	fs.appendFileSync(tmpHygieneRunFilesPath, `${tmpHygieneOwnFile}\n`);
} catch {
	// An unwritable shared home costs attribution precision only: with an empty
	// manifest the census judges every entry, exactly as it did before #3314.
}

/** The test files this run's workers loaded (#3314). An EMPTY set means the
 *  manifest could not be read, and every consumer must then judge everything —
 *  an entry is never ignored on the strength of a record that is not there. */
export function tmpHygieneRunFiles(
	manifestPath: string = tmpHygieneRunFilesPath,
): Set<string> {
	try {
		return new Set(
			fs
				.readFileSync(manifestPath, "utf8")
				.split("\n")
				.filter((line) => line.length > 0),
		);
	} catch {
		return new Set();
	}
}

/**
 * #2912 (2026-10-10 follow-up): the test file each worker was running when it
 * observed a tmp entry appear, one `<entry>\t<file>` line per entry.
 *
 * The prefix index answers "which file brackets a NAME"; that misattributed the
 * jscpd leak on #4122/#4285, where a real-pi CHILD of
 * `tests/real-harness/outside-root.test.ts` made `pi-lens-jscpd-*` but the
 * report named `tests/clients/jscpd-client.test.ts`, the file that declares the
 * prefix. The interposer sees creations only inside a test process, so this
 * record names the real creator where one exists and is silent where a child
 * process made the entry.
 *
 * Run-id scoped by name beside the manifest, appended at each worker's teardown
 * from the registry (one record per entry, never one per mkdtemp call), and
 * removed with the other per-run records in `cleanupTmpHygiene`.
 */
export const tmpHygieneCreatorsPath = path.join(
	path.dirname(tmpHygieneBaselinePath),
	`tmp-hygiene-creators-${process.env.PI_LENS_TMP_HYGIENE_RUN_ID}.log`,
);
const flushedTmpRootCreators = new Set<string>();
/** Set by `cleanupTmpHygiene` (the serialized owner removed the record) so the
 *  setup's own afterAll, which runs AFTER the owner's, cannot recreate the file
 *  it just removed. */
let tmpHygieneCreatorsClosed = false;

function flushTmpRootCreators(): void {
	if (tmpHygieneCreatorsClosed) return;
	const formatted = formatTmpRootCreators(tmpRootRegistry);
	if (formatted === undefined) return;
	const fresh = formatted
		.split("\n")
		.filter((line) => line.length > 0 && !flushedTmpRootCreators.has(line));
	if (fresh.length === 0) return;
	try {
		fs.appendFileSync(tmpHygieneCreatorsPath, `${fresh.join("\n")}\n`);
		for (const line of fresh) flushedTmpRootCreators.add(line);
	} catch {
		// An unwritable shared home costs creator attribution only: the owner
		// then labels the entry as created outside the test process, which is the
		// fail-safe direction (an innocent prefix owner is never named).
	}
}

/** The wall clock as this module saw it at load. A case that installs fake
 *  timers replaces the global `Date`, and a sweep that runs inside that scope
 *  would stamp its record with the fake clock; the census compares the stamp
 *  with filesystem times, which are the kernel's (#4591). */
const hygieneNow = Date.now.bind(Date);
/** Append this sweep's per-root records (#4591) to the run's creators record.
 *  Each fork sweeps once per `via` (afterAll, then SIGTERM), so there is no
 *  repeat to dedupe. Closed with the creators record, so the setup's own
 *  afterAll, which runs after the owner's cleanup, cannot recreate the file
 *  the owner removed. */
function flushTmpRootSweepRecords(lines: readonly string[]): void {
	if (tmpHygieneCreatorsClosed || lines.length === 0) return;
	try {
		fs.appendFileSync(tmpHygieneCreatorsPath, `${lines.join("\n")}\n`);
	} catch {
		// Costs the diagnosis only: the census then prints the entry without a
		// sweep record, which it names as such.
	}
}

/** Remove the run's creators record and close the flush. `cleanupTmpHygiene`
 *  runs in the owner's afterAll, which runs BEFORE the setup's own afterAll
 *  under the stack hook order; without the closed latch the setup flush would
 *  recreate the record it just removed. Exported so the teardown test drives
 *  the latch directly (#4307 sweep). */
export function closeTmpHygieneCreators(): void {
	try {
		fs.rmSync(tmpHygieneCreatorsPath, { force: true });
	} catch {
		// A stale ignored record is harmless; the next run uses a new id.
	} finally {
		tmpHygieneCreatorsClosed = true;
	}
}

/** Test seam (#4307 sweep, #5081 review F4): run both of the setup's flushes
 *  (the creators record, then `sweepLines` as a sweep's records) so a test can
 *  prove the closed latch suppresses each. */
export function flushTmpHygieneRecordsForTests(
	sweepLines: readonly string[],
): void {
	flushTmpRootCreators();
	flushTmpRootSweepRecords(sweepLines);
}

/**
 * #4864: the directories a test process NAMED directly at the repository root
 * this run, keyed by entry name with the creating file. Read from the same
 * per-run record as `tmpHygieneCreators`, on the `repo-root:` prefix that
 * marks the kind, so a transient fixture counts: the leftover census above
 * cannot see one that its own cell removed before the run ended.
 */
export function tmpHygieneRepoRootCreates(
	creatorsPath: string = tmpHygieneCreatorsPath,
): Map<string, string> {
	const creates = new Map<string, string>();
	for (const [entry, file] of tmpHygieneCreators(creatorsPath))
		if (entry.startsWith(REPO_ROOT_CREATE_PREFIX))
			creates.set(entry.slice(REPO_ROOT_CREATE_PREFIX.length), file);
	return creates;
}

/** The observed creator of each leaked entry, keyed by entry name. An EMPTY map
 *  means nothing was recorded (a dead run, an unwritable home, or every entry
 *  made outside a test process), and the owner then labels the entry by both
 *  causes rather than a prefix guess. */
export function tmpHygieneCreators(
	creatorsPath: string = tmpHygieneCreatorsPath,
): Map<string, string> {
	const creators = new Map<string, string>();
	let raw: string;
	try {
		raw = fs.readFileSync(creatorsPath, "utf8");
	} catch {
		return creators;
	}
	for (const line of raw.split("\n")) {
		const tab = line.indexOf("\t");
		if (tab <= 0) continue;
		const entry = line.slice(0, tab);
		// One record per entry; a torn or duplicated append keeps the first.
		if (!creators.has(entry)) creators.set(entry, line.slice(tab + 1));
	}
	return creators;
}

/**
 * How one leaked entry is described in the hygiene owner's failure message:
 * the prefix owner beside the test file that ACTUALLY created it. An entry no
 * test-process interposer saw is labelled by BOTH causes that leave no creator
 * on record -- a child process the run spawned, or a creators record this run
 * could not read -- instead of being given the prefix owner, whose guess is
 * exactly what sent #4122/#4285 to the wrong file. The two causes are one
 * `creator === undefined` state here, so the label names both rather than
 * asserting a child the record cannot prove (#4307-4).
 */
export function formatTmpHygieneLeakEntry(
	entry: string,
	prefixOwner: string | undefined,
	creator: string | undefined,
): string {
	if (creator === undefined)
		return `${entry} (created outside the test process, or the creators record was unreadable)`;
	return `${entry} (owner: tests/${prefixOwner ?? "unknown"}; created by tests/${creator})`;
}

function removeTmpHygieneOwnerMarker(): void {
	try {
		fs.rmSync(tmpHygieneOwnerMarker, { force: true });
	} catch {
		// The marker is only a liveness hint; a later run uses a new run id.
	}
}

/**
 * Refresh this worker's heartbeat (#3186 round 3). Driven by the test
 * lifecycle, NOT by a timer: a `setInterval` here would be a new
 * `raw-timer-wait` on the support seam every test file imports, and
 * `tests/support/vitest-setup.ts` cannot join the serialized
 * `wallClockBudgetInclude` lane an admission requires.
 *
 * Two deliberate choices, both about fake timers — most of this suite installs
 * them, and this hook runs inside their scope:
 *
 * - the throttle reads `process.hrtime.bigint()`, not `Date.now()`, which
 *   Vitest's default `toFake` list replaces;
 * - the beat REWRITES the marker instead of calling `utimes` with a computed
 *   timestamp, so the mtime the reader compares comes from the kernel clock and
 *   a test's fake `Date` can never stamp a live worker as an orphan.
 *
 * There is deliberately NO "already drained" guard here: `isolate: true` gives
 * every test FILE its own fork (see vitest.config.ts), so no `afterEach` can
 * run after the file-level `afterAll` that removed the marker, and a guard for
 * that could not be made to red.
 */
const TMP_HYGIENE_OWNER_HEARTBEAT_MS = 250;
const TMP_HYGIENE_OWNER_HEARTBEAT_NS =
	BigInt(TMP_HYGIENE_OWNER_HEARTBEAT_MS) * 1_000_000n;
let tmpHygieneLastHeartbeatNs = process.hrtime.bigint();
export function touchTmpHygieneOwnerMarker(
	minIntervalNs = TMP_HYGIENE_OWNER_HEARTBEAT_NS,
): void {
	const now = process.hrtime.bigint();
	if (now - tmpHygieneLastHeartbeatNs < minIntervalNs) return;
	tmpHygieneLastHeartbeatNs = now;
	try {
		fs.writeFileSync(tmpHygieneOwnerMarker, tmpHygieneOwnerMarkerBody);
	} catch {
		// The shared home can be gone under a teardown race; a missed beat only
		// ages this marker toward the orphan bound, which fails safe.
	}
}
/**
 * Lets the next lifecycle beat through the throttle. The registration case in
 * tests/config/tmp-fixture-hygiene.test.ts needs a beat it can wait for: under
 * a shuffle it can run within 250 ms of this file's load, when no hook has
 * beaten yet (#4405 census, seed 606).
 */
export function resetTmpHygieneHeartbeatThrottle(): void {
	tmpHygieneLastHeartbeatNs =
		process.hrtime.bigint() - TMP_HYGIENE_OWNER_HEARTBEAT_NS;
}
beforeEach(() => touchTmpHygieneOwnerMarker());
afterEach(() => touchTmpHygieneOwnerMarker());

/**
 * #2912: the worker's own tmp roots are removed by THIS file, at teardown and on
 * SIGTERM, not only by the owner at the end of the run. See
 * `tests/support/tmp-root-registry.ts` for the two rules and the recurrences.
 *
 * The interposer is published to ESM importers (`import { mkdtempSync }`, `import
 * * as fs`) by `syncBuiltinESMExports`. The `fs` functions are captured here,
 * at load, so a test that spies or mocks `node:fs` later cannot redirect the
 * sweep. The hook below is registered first, so under the default `stack`
 * hook order it runs AFTER the test file's own `afterEach`: a root the file
 * just removed is seen absent, which is what marks a later reappearance as a
 * straggler.
 */
const tmpRootRegistry = getTmpRootRegistry();
installTmpRootInterposer(
	tmpRootRegistry,
	nodeFs as unknown as TmpRootFsTarget,
	tmpHygieneRealTmp,
	() => tmpHygieneOwnFile,
	// #4864: the repository root is judged by the same rule as the tmp root, so
	// a fixture NAMED there is recorded and the hygiene owner can fail it. It
	// is the worker's own working directory, which is the checkout root (the
	// same default `unadmittedRepoRootEntries` reads).
	tmpHygieneRepoRoot,
);
syncBuiltinESMExports();
const tmpRootIo = {
	exists: (dir: string): boolean => fs.existsSync(dir),
	remove: (dir: string): void =>
		fs.rmSync(dir, { recursive: true, force: true }),
};
const tmpRootExists = tmpRootIo.exists;
afterEach(() => sampleTmpRoots(tmpRootRegistry, tmpRootExists));

/**
 * #4591: a case that throws between `pinFixtureHome` and its own fixture work
 * never reaches the call site's `finally`, and HOME would stay pointed at that
 * case's fixture directory for every case after it in this worker. The pin
 * registers its undo with the harness seam, so this hook closes the window
 * whether the case passed, failed, or threw during setup.
 */
afterEach(() => restorePinnedFixtureHomes());

function sweepOwnTmpRoots(via: "afterAll" | "SIGTERM"): void {
	// #2912 (2026-10-10): publish the creators record at every teardown, before
	// the registry is gone with the fork, so the serialized owner can name the
	// test file behind a leak. One line per entry; a second teardown is a no-op.
	flushTmpRootCreators();
	const sweep = sweepTmpRoots(tmpRootRegistry, tmpRootIo);
	// #4591: which roots the registry held when this sweep ran, and what it found
	// at each, so a root that reappears afterwards is attributable.
	flushTmpRootSweepRecords(
		formatTmpRootSweepRecords(tmpRootRegistry, sweep, via, hygieneNow()),
	);
	const line = formatTmpRootSweep(
		tmpHygieneOwnFile,
		sweep,
		tmpRootRegistry,
		via,
	);
	// Synchronous and unbuffered: this can be the last thing the fork does.
	if (line)
		try {
			fs.writeSync(2, line);
		} catch {
			// stderr closed under a teardown race; the sweep itself already ran.
		}
}

// Vitest SIGTERMs a fork after its file ends, with no `exit` event and a 500 ms
// SIGKILL fallback; a deferred write can land in that window. Sweep, then
// re-raise as `clients/safe-spawn.ts` does so the fork still dies at once.
process.once("SIGTERM", () => {
	sweepOwnTmpRoots("SIGTERM");
	// #3721: the worker home too: a deferred writer (the probe cache's 300ms
	// timer) can recreate it between the file's teardown and this signal, and a
	// nested vitest run a test launched has no owner to sweep its homes.
	try {
		tmpRootIo.remove(TMP_HYGIENE_WORKER_HOME);
		tmpRootIo.remove(workerPinnedHomeRoot);
	} catch {
		// Best effort, like the sweep above: the owner reclaims what is left.
	}
	try {
		process.kill(process.pid, "SIGTERM");
	} catch {
		// Already dying; the sweep has run.
	}
});

/** Root-level `orphan-backstop*` entries of a home, each with its mtime: the
 *  stamp, the transient lock, and the `orphan-backstop.lock.quarantine-…/`
 *  directory a contended lock leaves behind. One definition, used by the
 *  snapshot, the per-file detector and the stale sweep, so they can never
 *  disagree (#3083).
 *
 *  Name AND mtime, because the name alone does not identify an ENTRY, and the
 *  stamp's path is FIXED. Measured (round 4): with a stale
 *  `orphan-backstop.json` in the baseline and the pin mutated away, the real
 *  session_start writer overwrote that exact path during the run (mtime 08:04 →
 *  11:05); a name-only baseline then reported only the uniquely-named
 *  quarantine directory beside it and never named the rewritten stamp. A writer
 *  that takes an UNCONTENDED lock leaves no quarantine directory, so name-only
 *  would have reported nothing at all. Not a second clause — one rule with a
 *  faithful notion of identity: the entry I saw at setup is the entry with that
 *  name AND that mtime. */
function rootBackstopSnapshot(
	dir: string = tmpHygieneHome,
): Record<string, number> {
	const snapshot: Record<string, number> = {};
	for (const entry of readTmpDirEntries(dir))
		if (entry.startsWith("orphan-backstop"))
			snapshot[entry] =
				fs.statSync(path.join(dir, entry), { throwIfNoEntry: false })
					?.mtimeMs ?? 0;
	return snapshot;
}

/** PR #3100 round 3 F4: the backstop detector below used to assert the shared
 *  root is ABSOLUTELY empty, while the tmp gate twelve lines down has always
 *  compared against what was there at setup. Residue this run did not write —
 *  most realistically master's own writer from a run before this branch was
 *  checked out, the expected FIRST state for this change — then redded every
 *  test file, for ever, naming an innocent file as the writer. CI never sees it
 *  (fresh checkout), the same blind spot as the leak F1 fixed. One baseline
 *  record, one write, one settle loop, now carrying both populations. */
interface TmpHygieneBaseline {
	tmp: string[];
	backstopRoot: Record<string, number>;
	/** The repo root's top-level names at run start (#3715). Optional: a record
	 *  written by a run of an older checkout has none, and the census then says
	 *  so instead of guessing. */
	repoRoot?: string[];
	/** Non-`pi-lens-` entries at the real tmp root at run start (#4560), so a
	 *  write at the tmp root — a sibling of the fixtures,
	 *  `path.join(<fixture>, "..")` — is judged against what the host already
	 *  had. Optional: a record written by an older checkout has none, and the
	 *  widened census then reports `unknown` instead of a clean zero. */
	tmpRootWrites?: string[];
}

let tmpHygieneBefore: Set<string>;
let backstopRootBefore: Record<string, number>;
let repoRootBefore: readonly string[] | undefined;
let tmpRootWritesBefore: ReadonlySet<string> | undefined;

function adoptBaseline(baseline: TmpHygieneBaseline): void {
	tmpHygieneBefore = new Set(baseline.tmp);
	backstopRootBefore = baseline.backstopRoot;
	repoRootBefore = baseline.repoRoot;
	tmpRootWritesBefore =
		baseline.tmpRootWrites === undefined
			? undefined
			: new Set(baseline.tmpRootWrites);
}

try {
	adoptBaseline(
		JSON.parse(
			fs.readFileSync(tmpHygieneBaselinePath, "utf8"),
		) as TmpHygieneBaseline,
	);
} catch {
	const baseline: TmpHygieneBaseline = {
		tmp: snapshotTmpPiLensEntries(readTmpDirEntries(tmpHygieneRealTmp)),
		backstopRoot: rootBackstopSnapshot(),
		repoRoot: readTmpDirEntries(process.cwd()),
		tmpRootWrites: readTmpDirEntries(tmpHygieneRealTmp).filter(
			(name) => !name.startsWith("pi-lens-"),
		),
	};
	try {
		const fd = fs.openSync(tmpHygieneBaselinePath, "wx");
		fs.writeFileSync(fd, `${JSON.stringify(baseline)}\n`);
		fs.closeSync(fd);
		adoptBaseline(baseline);
	} catch {
		for (let attempt = 0; attempt < 1000; attempt++) {
			try {
				adoptBaseline(
					JSON.parse(
						fs.readFileSync(tmpHygieneBaselinePath, "utf8"),
					) as TmpHygieneBaseline,
				);
				break;
			} catch {
				if (attempt === 999)
					throw new Error("tmp hygiene baseline did not settle");
			}
		}
	}
}
process.env.PI_LENS_HOME = TMP_HYGIENE_WORKER_HOME;
// #4591: `pinFixtureHome` places a pinned fixture HOME beside this worker's own
// home, and needs the run-shared home to name that place. Published before any
// test module loads, so every call site reads one value, and the resolved root
// is published beside it: the teardown below then removes the directory the
// cases actually used, not one re-derived from an environment a test may have
// changed in-process (the census suite mutates the run id on purpose).
//
// The published value is derived from THIS worker's identity, never read back
// through `fixtureHomeRoot()` (#4591 V1): a nested Vitest child inherits this
// whole environment, so reading the inherited value would make the child
// publish its parent's root and remove it at its own teardown, with the home directories
// a case had pinned inside it. Both derivations share `fixtureHomeRootIn`.
process.env.PI_LENS_TMP_HYGIENE_HOME = tmpHygieneHome;
process.env.PI_LENS_TMP_HYGIENE_FIXTURE_HOME = fixtureHomeRootIn(
	tmpHygieneHome,
	process.env.PI_LENS_TMP_HYGIENE_RUN_ID ?? "local",
	process.pid,
);
// #4789: pinning PI_LENS_HOME alone left HOME and the XDG directories at the
// maintainer's REAL home, so every tool a test spawns that resolves its own
// config from them wrote there (2026-10-23: the #4780 verify left
// `$HOME/.config/.opengrep` and `$HOME/.config/.semgrep` behind). The whole set
// is pinned here once, in the worker, so every child inherits it. `USERPROFILE`
// is `os.homedir()`'s source on Windows. The XDG directories take the layout a
// tool falls back to without them (`~/.config`, `~/.cache`, `~/.local/share`),
// so a tool that reads the variable and one that reads the default agree.
//
// The home is the worker's own directory under the sanctioned scratch root
// (`claimScratchDir`: owner.pid, swept when its owner is dead), NOT under the
// checkout's `.probe-home` beside the worker home: the repo root is every
// test's `cwd`, a home inside it makes that cwd an ANCESTOR of HOME, and the
// home-ceiling guards (`isAtOrAboveHomeDir`) then refuse it (32 cases in
// `ast-grep-search.test.ts` went red on exactly that). The real home sits above
// the checkout, so the pin keeps that relation. A test that needs a project
// file under HOME uses `pinFixtureHome`, as AGENTS.md requires: a path under a
// `pi-*` temp directory is pi-owned housekeeping to `isPiOwnedTempPath`.
//
// The pinned home follows TMPDIR (`os.tmpdir()`), so on a host whose TMPDIR is
// /tmp it is under /tmp: a suite that applies a /tmp rule to what `~` expands to
// (tests/scripts/guard-bash-hook.test.ts) gives its classifier its own HOME.
// A test that needs another home sets HOME itself and wins. Assigned once for
// the process and never restored, like PI_LENS_HOME above: restoring between
// cases would re-open the real home.
//
// `REAL_HOME` is the opt-out: the maintainer's real home as the passwd entry
// names it (`os.userInfo()` does not read `HOME`), captured BEFORE the pin. A
// test that reads it on purpose is a row in `tests/support/real-home-readers.ts`
// with a header reason, and `tests/config/real-home-reader-registry.test.ts`
// fails any other file that spells it, or `userInfo`.
export const REAL_HOME: string = (() => {
	try {
		return os.userInfo().homedir;
	} catch {
		// No passwd entry for this uid (a container): the ambient value is the
		// best answer left, and still the real one, as nothing has pinned yet.
		return os.homedir();
	}
})();
sweepScratchDirs(SCRATCH_DIR_ROOT, "vitest-home-", {
	maxAgeMs: 6 * 60 * 60 * 1000,
});
const workerPinnedHomeRoot = claimScratchDir(SCRATCH_DIR_ROOT, "vitest-home");
const workerPinnedHome = path.join(workerPinnedHomeRoot, "home");
for (const dir of [
	workerPinnedHome,
	path.join(workerPinnedHome, ".config"),
	path.join(workerPinnedHome, ".cache"),
	path.join(workerPinnedHome, ".local", "share"),
])
	fs.mkdirSync(dir, { recursive: true });
process.env.HOME = workerPinnedHome;
process.env.USERPROFILE = workerPinnedHome;
process.env.XDG_CONFIG_HOME = path.join(workerPinnedHome, ".config");
process.env.XDG_CACHE_HOME = path.join(workerPinnedHome, ".cache");
process.env.XDG_DATA_HOME = path.join(workerPinnedHome, ".local", "share");
// #2651: scripts/warm-loader-cache.mjs appends to PI_LENS_INSTALL_LOG before
// it falls back to PI_LENS_HOME/install.log, so an ambient value (a
// developer's shell pointing it at the real ~/.pi-lens/install.log) would
// reach every child a test spawns with `...process.env` -- the #2634 class.
// Pinned here once, for every worker and every inheriting child, instead of
// one `env:` pin per call site. A test that exercises the fallback deletes it
// from the child's env explicitly.
process.env.PI_LENS_INSTALL_LOG = path.join(
	TMP_HYGIENE_WORKER_HOME,
	"install.log",
);

// Hermeticity, same class as PI_LENS_CONFIG_PATH above: the global-config-
// location PR (refs #2457) reads the host's config dir in the resolution's
// agent-dir tier, and an ambient value (a pi host sets PI_CODING_AGENT_DIR)
// must not decide which file a test reads — or where a test that resolves-
// then-writes the resolved path lands: seen live 2026-09-21, an un-neutralized
// ambient value redirected a suite's config write into the maintainer's REAL
// dotfiles-managed extensions/pi-lens.json.
//
// UNLIKE PI_LENS_CONFIG_PATH above, the path must be REAL and WRITABLE: the
// real-pi harness children inherit this env and pi initializes its config
// layout in it, so a nonexistent path killed every real-harness suite on CI
// (pi child died at startup; seen live on PR #3251). Pointing it under the
// pinned PI_LENS_HOME keeps the harness children deterministic instead of
// maintainer-specific, and keeps the tier's file out of the real home.
process.env.PI_CODING_AGENT_DIR = path.join(tmpHygieneHome, "agent");
fs.mkdirSync(path.join(tmpHygieneHome, "agent"), { recursive: true });
installGitFixtureEnv(tmpHygieneHome);

// #3083: session_start reaches the backstop transitively through index.js.
// Pin the filesystem location once for every file, without a caller registry
// or changing #2912's shared home. Explicit per-case homes remain authoritative.
// A module mock survives resetModules; no scheduler, store or lock is mocked.
//
// PR #3100 review F1: the question this asks is "is this the run-shared home?",
// and that is a question about a DIRECTORY, not about a string. `PI_LENS_HOME`
// pointed at a symlink of the run-shared home produced a different string, so a
// string compare called it a separate explicit home and the real stamp and lock
// landed at the shared root anyway. One rule — same st_dev + st_ino — answers
// every spelling: the same path, a trailing slash or `..` (already normalised by
// getGlobalPiLensDir's path.resolve), a symlink alias, and a second mount of the
// same directory, which realpath alone would NOT catch. A path that does not
// exist cannot be the run-shared home (mkdir'd above), so an absent stat is a
// pass-through and no separate clause is needed for it.
const backstopRunPrefix = `backstop-${process.env.PI_LENS_TMP_HYGIENE_RUN_ID}-`;
let backstopPrivateDir: string | undefined;

function isRunSharedHome(candidate: string): boolean {
	const self = fs.statSync(candidate, { throwIfNoEntry: false });
	const shared = fs.statSync(tmpHygieneHome, { throwIfNoEntry: false });
	return (
		self !== undefined &&
		shared !== undefined &&
		self.dev === shared.dev &&
		self.ino === shared.ino
	);
}

vi.mock("../../clients/instance-reaper-state.js", () => ({
	resolveBackstopStateDir: (machineHome: string): string => {
		if (!isRunSharedHome(machineHome)) return machineHome;
		// On first use, not at import: most files that pull in the reaper never
		// reach the backstop. Measured over the eight-file reaper batch (PR #3100
		// round 2): mkdtemp in the factory left 8 directories, 7 of them empty;
		// on first use it leaves the 1 that holds a stamp.
		backstopPrivateDir ??= fs.mkdtempSync(
			path.join(tmpHygieneHome, backstopRunPrefix),
		);
		return backstopPrivateDir;
	},
}));

// #3917: by default no test reaches the HOST process table through the orphan
// backstop. `index.ts` arms `scheduleUntrackedOrphanSweep` on every real
// primary `session_start`; 30 s later the sweep enumerates the machine's whole
// process table and kills a foreign orphan whose owner is dead, and the #2042
// kill guard then fails the file at teardown although every test passed. The
// sweep arms in 36 of the 49 files that load `index.ts`; eight reached the
// table in the r1 census.
//
// The backstop's enumeration is the only `queryProcessTable` caller that
// filters on the image `Name` (the sampler filters `ProcessId`, the Windows
// marker search `CommandLine`), so that column is the scope: the sweep still
// runs end to end (lock, stamp, partition) over an empty table and every other
// process-table query reaches the real seam. A suite whose subject needs the
// real table opts in with one greppable line, the module's own per-file
// switch: `vi.unmock("../clients/process-snapshot.js")`.
// tests/index-3917-orphan-sweep-scope.test.ts witnesses both arms.
vi.mock("../../clients/process-snapshot.js", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("../../clients/process-snapshot.js")>();
	return {
		...original,
		queryProcessTable: (
			request: Parameters<typeof original.queryProcessTable>[0],
			options: Parameters<typeof original.queryProcessTable>[1],
		): ReturnType<typeof original.queryProcessTable> =>
			request.filter?.column === "Name"
				? Promise.resolve({
						rows: [],
						status: "ok" as const,
						serverSideFiltered: true,
					})
				: original.queryProcessTable(request, options),
	};
});

/**
 * PR #3100 review F2. The run-shared home is NOT removed at run end: nothing in
 * the repo removes `<cwd>/.probe-home`, and `cleanupTmpHygiene` below sweeps
 * `os.tmpdir()` only. Round 1's `process.once("exit")` never fired either —
 * vitest terminates a fork with SIGTERM — so two green runs left one, then two,
 * private directories holding real stamps. Cleanup therefore belongs to the
 * #2912 serialized hygiene owner (`tests/config/tmp-fixture-hygiene.test.ts`,
 * groupOrder 6, maxWorkers 1), which runs after every other project has drained:
 * no live worker's delayed callback can recreate a directory it removes, which a
 * per-file `afterAll` could not promise. Scoped to this run's id because a
 * concurrent sibling vitest invocation in the same checkout shares `.probe-home`
 * and owns its own directories — the same reasoning as the `pi-lens-test-home-`
 * admission below.
 *
 * Round 3 F1: a run-id-only sweep means a run only ever cleans ITSELF, so every
 * invocation that excludes the hygiene owner — the targeted-run loop this repo
 * runs all day — left one more directory with a real stamp under the persistent
 * home, for ever. Master overwrote ONE stamp per run; that must not become
 * unbounded growth, and the #2912 owner's own rule below says it: "so admissions
 * cannot become a permanent inode leak". The cleanup axis has four cells and one
 * rule covers them, expressed through the repo's existing stale-scratch seam
 * (`scripts/lib/scratch-dir.mjs`, already imported by
 * `tests/support/real-pi-harness.ts`) rather than a second hand-rolled loop:
 *
 * - this run's directories — `backstopRunPrefix`, `SWEEP_ANY_AGE`: the run is
 *   finishing and no worker of it is alive, so the prefix alone is the rule and
 *   no clock comparison enters it (round 5: `maxAgeMs: 0` means "age >= 0" and
 *   skipped a directory whose mtime landed ahead of the process clock, which
 *   redded CI run 35072411511);
 * - a LIVE sibling invocation's — matches neither arm (different run id, and its
 *   directories were written minutes ago at most), so it keeps its cooldown
 *   stamp and its own owner removes them at the end of ITS run;
 * - an ABANDONED foreign run's (a targeted run without the owner file) and
 *   a KILLED run's (OOM/SIGKILL — seen on this host) — the same age arm
 *   reclaims both, since in neither case will an owner ever run for them.
 *
 * `BACKSTOP_STALE_MS` is deliberately generous. Sweeping a live sibling's
 * directory is the F2 flake class (its next sweep loses its cooldown stamp);
 * reclaiming late only delays recovery. The longest observed whole-`ci.yml`
 * workflow on master is 16 minutes (runs 35057763476, 35050766324), so six hours
 * is ~22x the longest invocation this repo produces.
 *
 * `home` exists so the owner's own guard can drive this rule over a fixture
 * directory. The sweep is destructive and the guard runs inside the LAST
 * worker, so a guard aimed at the live home would perform the cleanup itself
 * and hide whether `cleanupTmpHygiene` still calls this at all — measured:
 * with the call deleted, a guard on the live home held the leftover count at 0.
 * That wiring is pinned by a source scan in the owner's file instead (round 3
 * F3).
 */
const BACKSTOP_STALE_MS = 6 * 60 * 60 * 1000;

export function removeRunBackstopDirs(
	home: string = tmpHygieneHome,
	baselineDir: string = path.dirname(tmpHygieneBaselinePath),
): void {
	sweepScratchDirs(home, backstopRunPrefix, { maxAgeMs: SWEEP_ANY_AGE });
	sweepScratchDirs(home, "backstop-", { maxAgeMs: BACKSTOP_STALE_MS });
	// #3721: the per-worker homes, same two arms and same reasons: this run's
	// (a deferred writer recreated one after its worker removed it) by prefix
	// alone, any other run's (killed, or a targeted run without this owner) by
	// the generous stale window so a live sibling invocation keeps its own.
	sweepScratchDirs(home, tmpHygieneWorkerHomePrefix, {
		maxAgeMs: SWEEP_ANY_AGE,
	});
	sweepScratchDirs(home, "worker-home-", { maxAgeMs: BACKSTOP_STALE_MS });
	// Round 4 F4, second half: the baseline stops root-level residue accusing an
	// innocent file, but only this reclaims it — otherwise it sits under the
	// persistent home for ever, exactly the leak F1 closed one directory over.
	// Not `sweepScratchDirs`: the stamp is a FILE and that seam only considers
	// directories, so it would reclaim the quarantine directory and leave the
	// stamp. Young residue is left alone — the detector has already redded the
	// file that wrote it, and this runs while that evidence still matters.
	for (const [name, mtimeMs] of Object.entries(rootBackstopSnapshot(home))) {
		if (Date.now() - mtimeMs < BACKSTOP_STALE_MS) continue;
		removeTempDirSync(path.join(home, name));
	}
	// #3109: the last member of this class in this directory. The baseline
	// record above (`tmpHygieneBaselinePath`) is written once per run and only
	// ever consumed by `cleanupTmpHygiene`'s own `fs.rmSync` below — an
	// owner-less (targeted) run never reaches that line, so its file
	// accumulates under the persistent home for the checkout's lifetime, the
	// same unbounded shape as the two rows above. Same window, same rule: a
	// file this run did not just write and that is older than
	// `BACKSTOP_STALE_MS` belongs to a run whose owner never ran. This run's
	// OWN file is always younger than the window at this point in
	// `cleanupTmpHygiene` (it was read or written at setup, moments ago), so it
	// is untouched here and removed explicitly afterward.
	for (const name of readTmpDirEntries(baselineDir)) {
		// `tmp-hygiene-` covers both per-run records written beside each other:
		// the `tmp-hygiene-baseline-<run>.json` snapshot and #3314's
		// `tmp-hygiene-files-<run>.log` manifest. Same owner, same lifetime, same
		// unbounded-growth failure if an owner-less run never reclaims them.
		if (!name.startsWith("tmp-hygiene-")) continue;
		const entryPath = path.join(baselineDir, name);
		const mtimeMs = fs.statSync(entryPath, { throwIfNoEntry: false })?.mtimeMs;
		if (mtimeMs === undefined || Date.now() - mtimeMs < BACKSTOP_STALE_MS)
			continue;
		removeTempDirSync(entryPath);
	}
}

/** The root-level backstop residue this RUN is answerable for: what is there
 *  now, minus what was already there when the run started. `before` is a
 *  parameter so the owner's guard can drive the real directory against a
 *  synthetic baseline — the F4 case cannot be reached otherwise, since the real
 *  baseline is captured at setup, before any test can plant anything. */
export function unadmittedRootBackstopEntries(
	before: Readonly<Record<string, number>> = backstopRootBefore,
	home: string = tmpHygieneHome,
): string[] {
	return Object.entries(rootBackstopSnapshot(home))
		.filter(([name, mtimeMs]) => before[name] !== mtimeMs)
		.map(([name]) => name);
}

/**
 * #3715: the top-level entries a run added to the REPO ROOT: what is there now,
 * minus what was there at run start (`repoRootBaseline()`), `undefined` when the
 * baseline predates the census. `before` and `root` are parameters so the owner's guard can drive the
 * real directory read against a synthetic baseline and a fixture directory
 * (the real baseline is captured at setup, before any test can plant anything).
 *
 * The recurrence: `workspace-diagnostics-language-neutral` created its probe
 * home under the cwd and left a `.probe-lsp-language-<id>` directory holding a
 * `.pi-lens-home` in the worktree root (seen twice on 2026-09-30, #3699 and #3706); nothing observed
 * the repo root, because the tmp census watches `os.tmpdir()` only and the
 * mkdtemp-parent sweep ALLOWS repo-rooted parents (a dozen fixtures legitimately
 * live there and clean up after themselves).
 */
export function newRepoRootEntries(
	before: readonly string[] | undefined,
	root: string = process.cwd(),
): string[] | undefined {
	if (before === undefined) return undefined;
	const known = new Set(before);
	return readTmpDirEntries(root)
		.filter((name) => !known.has(name))
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The repo-root names this run's baseline recorded at start, or `undefined`
 *  when the record predates the census. */
export function repoRootBaseline(): readonly string[] | undefined {
	return repoRootBefore;
}

/**
 * The subset of `names` (top-level entries of `root`) that git neither tracks
 * nor ignores: what a later `git status` shows and what #3715 reported.
 * Run-created ignored entries (`.probe-home`, `.tmp`, `reports`, `dist`, ...)
 * are legitimate and filtered by git itself, not by a name list that would
 * drift from `.gitignore`. A name that is tracked is not new. One spawn, and
 * only when the run added something, so a clean run pays nothing.
 *
 * Returns `undefined` when git cannot answer (not a checkout, git absent): the
 * caller reports that, it does not read it as clean.
 */
export function untrackedUnignoredEntries(
	names: readonly string[],
	root: string = process.cwd(),
	/** Names the caller KNOWS are directories. The repo-root ledger records a
	 *  `mkdir` creation, so its entries are directories even though the creating
	 *  cell has usually removed the bytes by judgment time. A directory-only
	 *  ignore rule (`coverage/`, `dist/`, `.probe-home/`) matches only when git is
	 *  asked with a trailing slash or the directory is still on disk, so
	 *  re-deriving the kind from `lstatSync` reports an admitted creation as a
	 *  leak once it is gone (#4864 F4). */
	directories?: ReadonlySet<string>,
): string[] | undefined {
	if (names.length === 0) return [];
	const withSlash = names.map((name) => {
		if (directories?.has(name)) return `${name}/`;
		const stat = fs.lstatSync(path.join(root, name), { throwIfNoEntry: false });
		return stat?.isDirectory() ? `${name}/` : name;
	});
	const run = (args: string[], input?: string) =>
		spawnSync("git", args, {
			cwd: root,
			encoding: "utf8",
			timeout: 15_000,
			input,
		});
	const ignored = run(
		["check-ignore", "--stdin", "-z"],
		`${withSlash.join("\0")}\0`,
	);
	// 0: some ignored, 1: none ignored, anything else: git could not answer.
	if (ignored.status !== 0 && ignored.status !== 1) return undefined;
	const ignoredNames = new Set(
		String(ignored.stdout)
			.split("\0")
			.filter(Boolean)
			.map((entry) => entry.replace(/\/$/, "")),
	);
	const tracked = run(["ls-files", "-z", "--", ...names]);
	if (tracked.status !== 0) return undefined;
	const trackedTop = new Set(
		String(tracked.stdout)
			.split("\0")
			.filter(Boolean)
			.map((entry) => entry.split("/")[0]),
	);
	return names.filter(
		(name) => !ignoredNames.has(name) && !trackedTop.has(name),
	);
}

/**
 * Build output a test run must never create in the checkout (#4003). Git
 * ignores these, so the untracked-and-unignored census cannot see them, yet a
 * run that writes `dist/` makes every later `dist/`-dependent file pass by
 * ordering (the `npm pack` that ran `prepare` -> `build:dist` in place), and a
 * surviving `.pack-backup/` means a pack left the live manifest stripped.
 */
export const REPO_ROOT_BUILD_OUTPUT: readonly string[] = [
	"dist",
	".pack-backup",
];

/** What this run left in the repo root (#3715), or `undefined` when it cannot
 *  be known, with the reason in `unknown`. A new build-output name counts as
 *  leaked whether or not git ignores it (#4003). */
export function unadmittedRepoRootEntries(
	before: readonly string[] | undefined,
	root: string = process.cwd(),
): { leaked: string[]; unknown?: string } {
	const added = newRepoRootEntries(before, root);
	if (added === undefined)
		return {
			leaked: [],
			unknown: "the run's baseline predates the repo-root census",
		};
	const built = added.filter((name) => REPO_ROOT_BUILD_OUTPUT.includes(name));
	const rest = added.filter((name) => !REPO_ROOT_BUILD_OUTPUT.includes(name));
	const leaked = untrackedUnignoredEntries(rest, root);
	if (leaked === undefined)
		return {
			leaked: built,
			unknown: `git could not classify ${rest.length} new entr${rest.length === 1 ? "y" : "ies"} (${rest.join(", ")})`,
		};
	return { leaked: [...built, ...leaked].sort() };
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
// `maxRSS` is kilobytes on linux and win32 (libuv normalizes the Win32 peak
// working set); `currentPeakRssMb` owns the conversion, and enforcement stays
// linux-only because darwin reports bytes.
//
// #3139 (#3137 review): this used to be its own top-level `afterAll`,
// registered FIRST so Vitest's LIFO afterAll order ran it LAST — the reading
// then included every other hook's teardown allocation. That fixed the OLD
// direction (an over-budget file's own throw here used to preempt the #3083
// backstop, tmp-hygiene and kill-guard hooks, which ran AFTER it under the
// old bottom-of-file position) but created the INVERSE: Vitest's
// `callSuiteHook` for `afterAll` under `sequence.hooks: "stack"` (this repo's
// default) has no per-hook try/catch — confirmed directly against the
// installed vitest@5.0.0 source (node_modules/vitest/dist/chunks/
// run.CQOUYP-x.js:3544-3548 reverses afterAll order for "stack"; :3566-3569's
// execution loop, `for (const hook of hooks) callbacks.push(await
// runHook(hook))`, has no try/catch around `runHook`) — so any one of those
// three throwing aborted the remaining hooks in that pass, dropping the
// `[mem-file]` line for exactly the file worth investigating.
//
// The fix is not a fourth position for a fourth top-level hook: it is
// collapsing to the single `afterAll` below (`runTeardownWithMemReport`),
// so there is only ever ONE suite-level afterAll in this file and no
// registration order for Vitest's LIFO to apply to. `maxRSS` is a running
// high-water mark, so this function still reads it AFTER the other checks'
// teardown (see `runTeardownWithMemReport`'s own doc comment) — the ordering
// guarantee moved from "register first" to "call last, from `finally`".
const memReportThresholdMb = Number(
	process.env.PI_LENS_TEST_MEM_REPORT_MB ?? (process.env.CI ? "512" : "0"),
);
function emitMemReport(): void {
	if (memReportThresholdMb <= 0) return;
	const usage = process.memoryUsage();
	const peakMb = currentPeakRssMb();
	if (peakMb < memReportThresholdMb) return;
	const file = String(expect.getState().testPath ?? "unknown")
		.replace(/\\/g, "/")
		.split("/tests/")
		.pop();
	// #3058: the record, and the budget it is measured against, both live
	// in tests/support/worker-peak-rss.ts so the ceiling has a seam a test
	// can drive. A file over it fails its own suite here, naming itself,
	// instead of surfacing five days later as a rising SIGKILL rate.
	//
	// Straight to the fork's stderr, not `console.log`: vitest intercepts
	// worker console output and routes it through the reporter, which
	// attributes it to a task and can drop it entirely for a hook that runs
	// after the last test (verified 2026-08-25 — the console form printed
	// nothing). A raw write lands in the job log unconditionally, which is the
	// whole point of a line whose only reader is a post-mortem.
	reportPeakRss({
		file: `tests/${file}`,
		peakRssMb: peakMb,
		heapUsedMb: Math.round(usage.heapUsed / 1048576),
		externalMb: Math.round(usage.external / 1048576),
		write: (line) => process.stderr.write(line),
	});
}

// #3083, master red 038e28b: catch a new transitive writer in whichever
// file introduced it. The runtime hermeticity test also observes released locks.
// By PREFIX, not by the two exact names (PR #3100 round 2): reverting the
// identity rule left `orphan-backstop.lock.quarantine-<pid>-release-…/` at the
// shared root beside the stamp — durable residue of a contended lock that
// neither exact name covers, and the only residue left by a writer that
// quarantines a lock without reaching the stamp.
//
// Against the setup snapshot, not against emptiness (round 4 F4): residue this
// run did not write is not this file's doing, and accusing it made the whole
// suite unrunnable on any checkout that had run master first.
function checkBackstop(): void {
	expect(
		unadmittedRootBackstopEntries(),
		"#3083: test wrote run-shared orphan-backstop state",
	).toEqual([]);
}

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

// Fixtures that may outlive their test file without turning the file red.
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

/** New non-`pi-lens-` entries at the real tmp root (#4560): a fixture sibling
 *  written at `path.join(<fixture>, "..")`, which the `pi-lens-`-only census
 *  never saw. Observation only — the destructive sweep stays on the pi-lens
 *  census, so an entry another host process wrote is reported, never removed.
 *  `undefined` when the run's baseline predates this census, so the owner can
 *  say `unknown` rather than a clean zero. */
export function tmpHygieneTmpRootWrites(): string[] | undefined {
	if (tmpRootWritesBefore === undefined) return undefined;
	return readTmpDirEntries(tmpHygieneRealTmp).filter(
		(name) => !name.startsWith("pi-lens-") && !tmpRootWritesBefore?.has(name),
	);
}

export function tmpHygieneLeakReport(): {
	testFile: string;
	leftovers: string[];
} {
	const testFile = tmpHygieneFileOf(expect.getState().testPath);
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

const TMP_HYGIENE_OWNER_DRAIN_BUDGET_MS = 5_000;
/** Vitest's `hookTimeout` — 60 s in every project of `vitest.config.ts`. It is
 *  the hard ceiling on the one window a live worker spends with no
 *  `beforeEach`/`afterEach` in it (a single `beforeAll`/`afterAll`), so it is
 *  the longest a LIVE worker can legitimately go without beating. */
const TMP_HYGIENE_OWNER_HOOK_TIMEOUT_MS = 60_000;
/** A marker whose heartbeat is older than this is an orphan on EVERY platform:
 *  the ceiling above, plus the owner's own drain budget (it re-reads the mtime
 *  up to that long after it started waiting), plus two heartbeat intervals of
 *  slack for the throttle. This is what bounds suppression where no process
 *  start time exists (darwin/win32) — the bound the platform cannot withhold. */
export const TMP_HYGIENE_OWNER_STALE_MS =
	TMP_HYGIENE_OWNER_HOOK_TIMEOUT_MS +
	TMP_HYGIENE_OWNER_DRAIN_BUDGET_MS +
	2 * TMP_HYGIENE_OWNER_HEARTBEAT_MS;

function readTmpHygieneProcessStartTime(pid: number): string | undefined {
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		const commEnd = stat.lastIndexOf(")");
		if (commEnd < 0) return undefined;
		return stat
			.slice(commEnd + 2)
			.trim()
			.split(/\s+/)[19];
	} catch {
		return undefined;
	}
}

/** The process-boundary facts the owner classifier needs about a marker's pid.
 *  This is the ONE seam a test doubles to reach a platform it is not running
 *  on: the darwin/win32 cell of the state table is "no process start time
 *  exists", and it is reached by doubling this boundary — never by mocking
 *  `fs`, which would also fake the heartbeat the cell is about. */
export type TmpHygieneProcessProbe = {
	/** Does this platform supply a process start time at all? Measured against
	 *  THIS process, so it can never be true while every marker is written
	 *  without one (HIGH-3297-V1).
	 *
	 *  Same shape as `PROC_PPID_READABLE` in `clients/safe-spawn.ts` (#3091 F4),
	 *  and for the same reason it gives: `process.platform === "linux"` is a
	 *  different question, because a container or a hardened host runs Linux
	 *  with no `/proc` mounted. Computed per call rather than at module load, so
	 *  it is not a module-load platform const (AGENTS.md shape 30). */
	startTimeSupported: boolean;
	startTimeOf: (pid: number) => string | undefined;
	isAlive: (pid: number) => boolean;
};

export function realTmpHygieneProcessProbe(): TmpHygieneProcessProbe {
	return {
		startTimeSupported:
			readTmpHygieneProcessStartTime(process.pid) !== undefined,
		startTimeOf: readTmpHygieneProcessStartTime,
		isAlive: (pid) => {
			try {
				process.kill(pid, 0);
				return true;
			} catch (err) {
				// EPERM: the process exists, this user may not signal it.
				return (err as NodeJS.ErrnoException).code === "EPERM";
			}
		},
	};
}

export type TmpHygieneOwnerVerdict =
	| "foreign"
	| "self"
	| "malformed"
	| "orphaned"
	| "live";

export type TmpHygieneOwnerFacts = {
	/** The marker filename carries the run id (G1). */
	runMatches: boolean;
	/** Parsed marker, or `undefined` when it did not read or parse. */
	marker: unknown;
	markerMtimeMs: number | undefined;
	nowMs: number;
	selfPid: number;
	probe: TmpHygieneProcessProbe;
	staleAfterMs: number;
};

/**
 * Classify one owner marker. Pure, so the whole platform × owner-state table of
 * #3186 round 3 is executable on one host.
 *
 * Only `live` suppresses. `orphaned` and `malformed` are ATTRIBUTED — a marker
 * that cannot authenticate itself must never hide a leak (MEDIUM-3297-2), and a
 * platform that cannot authenticate at all must never reject every live worker
 * (HIGH-3297-V1). The heartbeat (G3) is the check that holds on every platform;
 * the start time (G5) is an extra where one exists.
 */
export function classifyTmpHygieneOwner(
	facts: TmpHygieneOwnerFacts,
): TmpHygieneOwnerVerdict {
	// Every field is normalised to a total type BEFORE the guards, so each guard
	// below can be neutered on its own in a mutation run without the ones after
	// it losing their narrowing — the shape the "mutate it both ways" rule needs.
	// `-1` and `""` are sentinels no real marker can carry.
	const marker = facts.marker as {
		pid?: unknown;
		startTime?: unknown;
		file?: unknown;
	} | null;
	const pid = typeof marker?.pid === "number" ? marker.pid : -1;
	const file = typeof marker?.file === "string" ? marker.file : "";
	const startTime =
		typeof marker?.startTime === "string" ? marker.startTime : undefined;
	const heartbeatAgeMs =
		facts.markerMtimeMs === undefined
			? Number.POSITIVE_INFINITY
			: facts.nowMs - facts.markerMtimeMs;

	if (!facts.runMatches) return "foreign"; // G1
	if (pid === -1 || file === "") return "malformed"; // G2
	if (pid === facts.selfPid) return "self";
	if (heartbeatAgeMs > facts.staleAfterMs) return "orphaned"; // G3 — beat stopped
	if (!facts.probe.isAlive(pid)) return "orphaned"; // G4
	if (facts.probe.startTimeSupported) {
		// G5 — where the platform has start times, a marker without one is not
		// something this run's setup wrote, and a different one is PID reuse.
		// This block is an EXTRA on top of G3/G4, never the sole gate: making it
		// unconditional is exactly HIGH-3297-V1.
		if (startTime === undefined) return "orphaned";
		if (facts.probe.startTimeOf(pid) !== startTime) return "orphaned";
	}
	return "live";
}

export type TmpHygieneOwnerScan = {
	live: Set<string>;
	counts: Record<TmpHygieneOwnerVerdict, number>;
};

function scanTmpHygieneOwners(
	probe: TmpHygieneProcessProbe,
	ownerDir: string = tmpHygieneOwnerDir,
): TmpHygieneOwnerScan {
	const live = new Set<string>();
	const counts: Record<TmpHygieneOwnerVerdict, number> = {
		foreign: 0,
		self: 0,
		malformed: 0,
		orphaned: 0,
		live: 0,
	};
	const runPrefix = `${process.env.PI_LENS_TMP_HYGIENE_RUN_ID}-`;
	for (const name of readTmpDirEntries(ownerDir)) {
		const markerPath = path.join(ownerDir, name);
		let marker: unknown;
		try {
			marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
		} catch {
			// Unreadable, half-written or not JSON: classified `malformed` below,
			// which attributes rather than suppresses.
			marker = undefined;
		}
		const verdict = classifyTmpHygieneOwner({
			runMatches: name.startsWith(runPrefix),
			marker,
			markerMtimeMs: fs.statSync(markerPath, { throwIfNoEntry: false })
				?.mtimeMs,
			nowMs: Date.now(),
			selfPid: process.pid,
			probe,
			staleAfterMs: TMP_HYGIENE_OWNER_STALE_MS,
		});
		counts[verdict] += 1;
		const file = (marker as { file?: unknown } | null | undefined)?.file;
		if (verdict === "live" && typeof file === "string") live.add(file);
	}
	return { live, counts };
}

/** Wait for every owner worker to finish its own afterEach/afterAll drain.
 *
 *  `ownerDir` is the marker NAMESPACE this scan judges, and it is a parameter
 *  for one reason (#3316): a caller that supplies a platform double answers
 *  `isAlive` for EVERY marker in the directory it scans, including markers of
 *  sibling test files it never wrote — a fully skipped file leaves one behind,
 *  since vitest runs no `afterAll` for a file with no executed test. The
 *  production owner keeps the default, the run-shared directory; a case that
 *  doubles the process boundary passes its own directory so its double can only
 *  ever speak about pids that case invented. */
export async function tmpHygieneWaitForOwnerDrain(
	budgetMs = TMP_HYGIENE_OWNER_DRAIN_BUDGET_MS,
	probe: TmpHygieneProcessProbe = realTmpHygieneProcessProbe(),
	ownerDir: string = tmpHygieneOwnerDir,
): Promise<TmpHygieneOwnerScan> {
	const deadline = Date.now() + budgetMs;
	let scan = scanTmpHygieneOwners(probe, ownerDir);
	while (scan.live.size > 0 && Date.now() < deadline) {
		await new Promise<void>((resolve) => setImmediate(resolve));
		scan = scanTmpHygieneOwners(probe, ownerDir);
	}
	return scan;
}

/** Which verdict a hygiene run's census reached: the three assertions ran, or
 *  the win32 quarantine declined them (#4591, named where the guard lives). The
 *  value carries no issue id: it is a log field, bounded and greppable, and the
 *  issue identity belongs to the guard and its pin. */
export type TmpHygieneCensusVerdict = "asserted" | "declined";

/** ONE record per hygiene run (not one per marker): the owner-marker census the
 *  hygiene owner acted on, so a suppressed or attributed entry is explicable
 *  from the run's own output. */
export function formatTmpHygieneOwnerSummary(
	scan: TmpHygieneOwnerScan,
	otherInvocationEntries = 0,
	reaped = 0,
	/** #4560: fixture siblings at the tmp root, `judged` (a test process created
	 *  it, so it is asserted) over `observed` (the widened census saw it at all),
	 *  or `unknown` when the run's baseline predates the widened census. Both
	 *  numbers: a judged zero over an observed entry is exactly the shape a
	 *  closed report hides (AGENTS: a child's own tmp cache is counted, not
	 *  asserted). */
	tmpRootWrites: { judged: number; observed: number } | "unknown" = {
		judged: 0,
		observed: 0,
	},
	/** #4592 review F4: WHICH verdict this run reached. A lane that declines the
	 *  census must not print a line indistinguishable from an asserting lane's,
	 *  or a skipped verdict reads as a clean one (shapes 10 and 31). Required, so
	 *  a caller that forgets to state it is a compile error rather than a silent
	 *  `asserted`. */
	verdict: TmpHygieneCensusVerdict,
): string {
	const { counts } = scan;
	const tmpRootWriteCount =
		tmpRootWrites === "unknown"
			? "unknown"
			: `${tmpRootWrites.judged}/${tmpRootWrites.observed}`;
	return `[tmp-hygiene-owners] live=${counts.live} orphaned=${counts.orphaned} malformed=${counts.malformed} foreign=${counts.foreign} self=${counts.self} otherInvocationEntries=${otherInvocationEntries} reaped=${reaped} tmpRootWrites=${tmpRootWriteCount} verdict=${verdict}`;
}

/** Reclaim abandoned owner records at the serialized census. A run id is the
 * ownership discriminator; mtime is the liveness bound for a worker killed
 * before its teardown can remove its records. Fresh foreign records belong to
 * a concurrent invocation and must remain untouched (#3332, #3314). */
export function reapStaleTmpHygieneRecords(
	ownerDir: string = tmpHygieneOwnerDir,
	recordDir: string = path.dirname(tmpHygieneBaselinePath),
	nowMs = Date.now(),
): number {
	const runId = process.env.PI_LENS_TMP_HYGIENE_RUN_ID;
	const ownerPrefix = `${runId}-`;
	// Both per-run records written beside each other: #3314's file manifest and
	// #2912's creators record. Same owner, same lifetime, same reaping window.
	const recordPrefixes = ["tmp-hygiene-files-", "tmp-hygiene-creators-"];
	let reaped = 0;
	const reap = (entryPath: string): void => {
		const mtimeMs = fs.statSync(entryPath, { throwIfNoEntry: false })?.mtimeMs;
		if (mtimeMs === undefined || nowMs - mtimeMs <= TMP_HYGIENE_OWNER_STALE_MS)
			return;
		removeTempDirSync(entryPath);
		if (!fs.existsSync(entryPath)) reaped += 1;
	};
	for (const name of readTmpDirEntries(ownerDir)) {
		if (name.startsWith(ownerPrefix)) continue;
		reap(path.join(ownerDir, name));
	}
	for (const name of readTmpDirEntries(recordDir)) {
		const prefix = recordPrefixes.find((candidate) =>
			name.startsWith(candidate),
		);
		if (prefix === undefined || !name.endsWith(".log")) continue;
		if (runId !== undefined && name === `${prefix}${runId}.log`) continue;
		reap(path.join(recordDir, name));
	}
	return reaped;
}

/**
 * The leftovers this invocation is NOT answerable for (#3314): entries whose
 * every candidate owner file is a test file no worker of this run loaded, so
 * another vitest invocation sharing this TMPDIR created them. They are neither
 * attributed nor swept — reporting them names an innocent file, and removing
 * them mutates a sibling invocation's live fixture.
 *
 * `ownersFor` returns EVERY tests/ file whose declared tmp prefix matches the
 * entry, not just the longest-prefix winner: with two candidates, one of which
 * ran here, the entry stays judged. Fail-closed is the rule on both axes — an
 * unreadable manifest (`runFiles` empty) and an entry no file claims are both
 * judged exactly as before this record existed.
 *
 * An entry the creators record names (#4354) is never foreign: the record is
 * run-id scoped, so a test file of THIS run created it, and the prefix-owner
 * question this filter asks cannot excuse what the run's own file made. The
 * #4347 jscpd leak stayed hidden because its creator ran in the fork while its
 * prefix owner (`jscpd-client.test.ts`) did not.
 */
export function tmpHygieneForeignRunEntries(
	entries: readonly string[],
	ownersFor: (entry: string) => readonly string[],
	runFiles: ReadonlySet<string>,
	creators: ReadonlyMap<string, string>,
): string[] {
	if (runFiles.size === 0) return [];
	return entries.filter((entry) => {
		if (creators.has(entry)) return false;
		const owners = ownersFor(entry);
		return owners.length > 0 && owners.every((owner) => !runFiles.has(owner));
	});
}

export function tmpHygieneExcludeLiveOwnerEntries(
	entries: readonly string[],
	ownerFor: (entry: string) => string | undefined,
	liveOwners: ReadonlySet<string>,
): string[] {
	return entries.filter((entry) => {
		const owner = ownerFor(entry);
		return owner === undefined || !liveOwners.has(owner);
	});
}

/** How many first-level children a leak-origin line names. Bounded: a leaked
 *  root can hold a whole npm cache, and one record per entry is the contract. */
const TMP_HYGIENE_ORIGIN_CHILD_LIMIT = 4;

/** What one census entry reports about itself; an `undefined` field is the
 *  unreadable arm. */
export interface TmpHygieneLeakOriginFacts {
	birthtimeMs?: number;
	children?: string[];
}

/** The bounded first-level children of a leaked entry, the one phrase the
 *  origin line and the census diagnosis share. */
function describeLeakChildren(children: string[] | undefined): string {
	if (children === undefined) return "first-level children unavailable";
	if (children.length === 0) return "first-level children: none";
	const shown = children.slice(0, TMP_HYGIENE_ORIGIN_CHILD_LIMIT).join(",");
	return children.length > TMP_HYGIENE_ORIGIN_CHILD_LIMIT
		? `first-level children: ${shown} (+${children.length - TMP_HYGIENE_ORIGIN_CHILD_LIMIT} more)`
		: `first-level children: ${shown}`;
}

/** The shipped reader. The parameter exists so a test can drive the arm this
 *  host's filesystems never produce — a stat that succeeds with a zero birth
 *  time — instead of leaving it unproven; `unadmittedRootBackstopEntries` and
 *  `removeRunBackstopDirs` take their inputs the same way. */
function readTmpHygieneLeakOrigin(dir: string): TmpHygieneLeakOriginFacts {
	let birthtimeMs: number | undefined;
	let children: string[] | undefined;
	try {
		birthtimeMs = fs.statSync(dir).birthtimeMs;
	} catch {
		birthtimeMs = undefined;
	}
	try {
		// Sorted so one directory always produces one line: `readdir` order is
		// filesystem-dependent, and two runs of the same leak must compare.
		children = fs.readdirSync(dir).sort();
	} catch {
		children = undefined;
	}
	return { birthtimeMs, children };
}

/**
 * #4591: what a leaked census entry holds and when it was created, one line per
 * leaked entry, printed by the destructive owner BEFORE it removes the entry.
 *
 * The census reds on a leaked root but says nothing about its origin, so the
 * `pi-lens-4577-resolver-*` root that reappeared after its file's sweep could
 * not be attributed: a birth time after the owning file's
 * `[tmp-hygiene-sweep]` line with a `home/…` child is an out-of-process HOME
 * writer, `workspace/…` is a `cwd` writer, and a birth BEFORE that line means
 * the sweep removed a different root and this one was invisible to it. NTFS
 * keeps a real creation time; a filesystem that reports none says so instead of
 * printing a fabricated zero.
 */
export function formatTmpHygieneLeakOrigin(
	dir: string,
	now: number = Date.now(),
	facts: TmpHygieneLeakOriginFacts = readTmpHygieneLeakOrigin(dir),
): string {
	const name = path.basename(dir);
	const { birthtimeMs, children } = facts;
	const listed = describeLeakChildren(children);
	if (birthtimeMs === undefined || !(birthtimeMs > 0))
		return `[tmp-hygiene-origin] ${name} birth time unavailable (${listed})\n`;
	const ageMs = Math.max(0, Math.round(now - birthtimeMs));
	return `[tmp-hygiene-origin] ${name} born ${ageMs}ms before this line (created at ${new Date(birthtimeMs).toISOString()}; ${listed})\n`;
}

/** One sweep's finding at one recorded root (#4591), parsed back from the
 *  creators record `formatTmpRootSweepRecords` wrote. */
export interface TmpHygieneSweepRecord {
	via: "afterAll" | "SIGTERM";
	kind: "registered" | "observed";
	outcome: "removed" | "failed" | "held" | "absent";
	/** Epoch ms of the sweep, read from the clock the filesystem shares. */
	at: number;
}

const SWEEP_VIAS: readonly string[] = ["afterAll", "SIGTERM"];
const SWEEP_KINDS: readonly string[] = ["registered", "observed"];
const SWEEP_OUTCOMES: readonly string[] = [
	"removed",
	"failed",
	"held",
	"absent",
];

/** The sweep records per entry name, from the creators map (the persisted
 *  record carries them under `TMP_ROOT_SWEEP_PREFIX`). Admits the one shape the
 *  writer produces and drops everything else, so a torn or foreign line is
 *  absent from the diagnosis rather than misread as a sweep. */
export function tmpHygieneSweepRecords(
	creators: ReadonlyMap<string, string>,
): Map<string, TmpHygieneSweepRecord[]> {
	const records = new Map<string, TmpHygieneSweepRecord[]>();
	for (const [key, value] of creators) {
		if (!key.startsWith(TMP_ROOT_SWEEP_PREFIX)) continue;
		const rest = key.slice(TMP_ROOT_SWEEP_PREFIX.length);
		const colon = rest.indexOf(":");
		const [kind, outcome, at, ...extra] = value.split(",");
		const stamp = Number(at);
		if (
			colon <= 0 ||
			colon === rest.length - 1 ||
			extra.length > 0 ||
			!SWEEP_VIAS.includes(rest.slice(0, colon)) ||
			!SWEEP_KINDS.includes(kind) ||
			!SWEEP_OUTCOMES.includes(outcome) ||
			!(at !== undefined && at.length > 0 && Number.isFinite(stamp))
		)
			continue;
		const name = rest.slice(colon + 1);
		const list = records.get(name) ?? [];
		list.push({
			via: rest.slice(0, colon) as TmpHygieneSweepRecord["via"],
			kind: kind as TmpHygieneSweepRecord["kind"],
			outcome: outcome as TmpHygieneSweepRecord["outcome"],
			at: stamp,
		});
		records.set(name, list);
	}
	return records;
}

/** What a leaked entry reports about itself for the diagnosis: its times and
 *  first-level children. An `undefined` field is the unreadable arm. */
export interface TmpHygieneLeakTimes {
	birthtimeMs?: number;
	mtimeMs?: number;
	ctimeMs?: number;
	children?: string[];
}

function readTmpHygieneLeakTimes(dir: string): TmpHygieneLeakTimes {
	const times: TmpHygieneLeakTimes = {};
	try {
		const stat = fs.statSync(dir);
		times.birthtimeMs = stat.birthtimeMs;
		times.mtimeMs = stat.mtimeMs;
		times.ctimeMs = stat.ctimeMs;
	} catch {
		// Gone since the census listed it: the facts stay undefined and say so.
	}
	times.children = readTmpHygieneLeakOrigin(dir).children;
	return times;
}

/**
 * #4591: which of the two producer candidates a leaked census entry matches,
 * with the facts that decide it, one bounded string per entry for the census
 * failure message.
 *
 *  - candidate 1 (`recreated-after-sweep`): the registry held the root at sweep
 *    time and the sweep recorded it, yet the entry was born after the sweep, so
 *    a deferred writer under the pinned HOME or cwd recreated it. Its first-level
 *    children name the writer (`home` is HOME, `workspace` is cwd).
 *  - candidate 2 (`unrecorded`): no creator on record and no sweep record, so the
 *    interposer never saw the root and the sweep never owned it.
 *  - the other verdicts keep the remaining cells explicit instead of folding them
 *    into one of the two: a root the creator recorded but no sweep ever listed
 *    (`recorded-not-swept`: a sibling `mkdir`, or a worker killed before any
 *    sweep), a root already present when its last sweep ran (`present-at-sweep`),
 *    and an entry whose birth time the filesystem withholds (`order-unknown`).
 * Times are signed milliseconds from the LAST sweep record, so `+9034ms` reads
 * "9034 ms after the sweep".
 */
export function diagnoseTmpHygieneLeak(
	entry: string,
	creator: string | undefined,
	records: readonly TmpHygieneSweepRecord[],
	times: TmpHygieneLeakTimes,
): string {
	const children = describeLeakChildren(times.children);
	const sweeps =
		records.length === 0
			? "no sweep record"
			: `sweeps: ${records
					.map(
						(r) =>
							`${r.via} ${r.kind} ${r.outcome} at ${new Date(r.at).toISOString()}`,
					)
					.join("; ")}`;
	const registry =
		records.length > 0
			? "in the registry at sweep time"
			: creator === undefined
				? "not in the registry (no creator on record)"
				: "creator on record, never a sweep root";
	const last = records.reduce<TmpHygieneSweepRecord | undefined>(
		(latest, r) => (latest === undefined || r.at > latest.at ? r : latest),
		undefined,
	);
	const born = times.birthtimeMs;
	const bornKnown = born !== undefined && born > 0;
	const delta = (ms: number | undefined): string =>
		ms === undefined || last === undefined || !(ms > 0)
			? "unavailable"
			: `${ms >= last.at ? "+" : "-"}${Math.abs(Math.round(ms - last.at))}ms`;
	let verdict: string;
	if (last === undefined)
		verdict = creator === undefined ? "unrecorded" : "recorded-not-swept";
	else if (!bornKnown) verdict = "order-unknown";
	else if (born > last.at) verdict = "recreated-after-sweep";
	else verdict = `present-at-sweep(${last.outcome})`;
	const against =
		last === undefined
			? ""
			: `; vs last sweep: birth ${delta(born)}, mtime ${delta(times.mtimeMs)}, ctime ${delta(times.ctimeMs)}`;
	return `${entry} [${verdict}] ${registry}; ${sweeps}${against}; ${children}`;
}

/** The diagnosis for each leaked entry, bounded: a census that leaked a whole
 *  run's roots names the first few and counts the rest. */
export const TMP_HYGIENE_DIAGNOSIS_LIMIT = 6;

export function diagnoseTmpHygieneLeaks(
	entries: readonly string[],
	creators: ReadonlyMap<string, string>,
	tmpRoot: string = tmpHygieneRealTmp,
	readTimes: (dir: string) => TmpHygieneLeakTimes = readTmpHygieneLeakTimes,
): string {
	const records = tmpHygieneSweepRecords(creators);
	const shown = entries
		.slice(0, TMP_HYGIENE_DIAGNOSIS_LIMIT)
		.map((entry) =>
			diagnoseTmpHygieneLeak(
				entry,
				creators.get(entry),
				records.get(entry) ?? [],
				readTimes(path.join(tmpRoot, entry)),
			),
		);
	const more = entries.length - shown.length;
	return `${shown.join(" | ")}${more > 0 ? ` | (+${more} more)` : ""}`;
}

export function writeTmpHygieneLeakNotice(
	tmpRoot: string,
	leakedCount: number,
): void {
	process.stderr.write(
		`[tmp-hygiene] observed ${leakedCount} unadmitted entry(s) from ${tmpRoot}; the serialized governance owner cleans them\n`,
	);
}

let tmpHygieneAfterAllProbeForTests: (() => void) | undefined;
export function setTmpHygieneAfterAllProbeForTests(
	probe: (() => void) | undefined,
): void {
	tmpHygieneAfterAllProbeForTests = probe;
}

function checkTmpHygiene(): void {
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
		writeTmpHygieneLeakNotice(tmpHygieneRealTmp, leakedCount);
}

// #2042: fail the FILE that handed a pid it does not own to production kill or
// spawn code, naming the pid and the stack. See tests/support/kill-guard.ts.
function checkKillGuard(): void {
	const report = killGuardReport();
	if (report) throw new Error(report);
}

/**
 * Run every other per-file teardown check, then emit the `[mem-file]` record
 * from `finally` — reached whether a check threw or not (#3139). This is the
 * ONE top-level `afterAll` this file registers: see the comment above
 * `emitMemReport` for why a second suite-level hook, in any position, is the
 * wrong shape again.
 *
 * `checks` runs in registration order and a throw still aborts the checks
 * after it — the same relationship Vitest's real (no per-hook try/catch)
 * afterAll loop already gave them, so this is not a behavior change for the
 * three checks themselves, only for whether the mem line survives it. The
 * first check's error (if any) is re-thrown after the mem report runs, so
 * the file still fails exactly as it always has.
 *
 * #3148: when the mem report ALSO throws (a file over the peak-RSS budget),
 * a throwing `finally` would replace the check's pending error -- and
 * kill-guard's pid+stack report exists nowhere but that Error. Both are
 * kept: one `AggregateError` whose message names both, since a reporter may
 * print only the message.
 */
export function runTeardownWithMemReport(
	checks: ReadonlyArray<() => void>,
	emitMemReport: () => void,
): void {
	const failures: unknown[] = [];
	try {
		for (const check of checks) check();
	} catch (error) {
		failures.push(error);
	}
	try {
		emitMemReport();
	} catch (error) {
		failures.push(error);
	}
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1) {
		const messages = failures.map((error) =>
			error instanceof Error ? error.message : String(error),
		);
		throw new AggregateError(
			failures,
			`teardown check and [mem-file] report both failed: ${messages.join(" | ")}`,
		);
	}
}

// Captured when the worker loads this file, before the test file can install
// fake timers: the bound below must still fire in a file that leaves them on.
const realSetTimeout = globalThis.setTimeout;

/**
 * How long the teardown waits for the registry tail (#3703 round 2): one
 * lease-waiting lock (`LOCK_WAIT_THROUGH_LEASE_MS`, 5.5 s) plus 1 s, so a
 * queued op waiting out a peer's lease still lands. It stays under Vitest's
 * default 10 s hook timeout, so the checks after it keep 3.5 s.
 */
export const REGISTRY_SETTLE_BOUND_MS = 6_500;

/**
 * Join the real registry tail before the fork is SIGTERM'd (#3617), for at
 * most {@link REGISTRY_SETTLE_BOUND_MS}. A file that leaves fake timers on,
 * or mocks a write that never settles, keeps a queued op pending forever; an
 * unbounded join timed the hook out and skipped every check after it. On
 * give-up it writes one stderr line and returns.
 */
async function settleRegistryMutationsBeforeTeardown(): Promise<void> {
	// Not cleared on success: the pool kills the fork right after this hook.
	const gaveUp = new Promise<true>((resolve) => {
		realSetTimeout(() => resolve(true), REGISTRY_SETTLE_BOUND_MS);
	});
	const timedOut = await Promise.race([
		_settleRegistryMutationsForTests().then(() => false),
		gaveUp,
	]);
	if (timedOut) {
		process.stderr.write(
			`[registry-settle] a registry mutation was still pending after ${REGISTRY_SETTLE_BOUND_MS}ms (fake timers left on, or a write that never settles); teardown continues without it (#3617)\n`,
		);
	}
}

afterAll(async () => {
	try {
		// #3617: Vitest SIGTERMs fork workers without a Node `exit` event. Join
		// the real registry mutation tail before teardown, including the quiet-
		// window heartbeat's queued updateHeartbeat, so no live worker's lock
		// generation is left behind for the next file to take over. Bounded,
		// and it never throws, so the checks below always run.
		await settleRegistryMutationsBeforeTeardown();
		// #2912: before the checks, so the leak notice below names what is left.
		sweepOwnTmpRoots("afterAll");
		runTeardownWithMemReport(
			[checkKillGuard, checkTmpHygiene, checkBackstop],
			emitMemReport,
		);
	} finally {
		try {
			tmpHygieneAfterAllProbeForTests?.();
		} finally {
			tmpHygieneAfterAllProbeForTests = undefined;
			removeTmpHygieneOwnerMarker();
			// #4591: the pinned fixture HOME directories are this worker's scratch,
			// beside its own home, so they go when it does.
			removeTempDirSync(fixtureHomeRoot());
			removeTempDirSync(TMP_HYGIENE_WORKER_HOME);
			removeTempDirSync(workerPinnedHomeRoot);
		}
	}
});

/** Which observed tmp entries this run may DELETE. Separated from the sweep
 *  below because the sweep is destructive and its only caller is the last
 *  worker of the run: a guard that called it would perform the run's own
 *  cleanup inside its assertion (the same reason `removeRunBackstopDirs` takes
 *  a `home`).
 *
 *  `spare` is #3314's other direction. Ignoring a sibling invocation's root in
 *  the report is half the fix; deleting it from under a LIVE sibling is the
 *  half that breaks the other run. */
export function tmpHygieneSweepableEntries(
	entries: readonly string[],
	before: ReadonlySet<string> = tmpHygieneBefore,
	spare: ReadonlySet<string> = new Set<string>(),
): string[] {
	return entries.filter(
		(name) =>
			!before.has(name) &&
			!spare.has(name) &&
			!TMP_HYGIENE_INDEPENDENT_OWNERS.some((prefix) => name.startsWith(prefix)),
	);
}

export function cleanupTmpHygiene(
	spare: ReadonlySet<string> = new Set<string>(),
): number {
	const after = snapshotTmpPiLensEntries(readTmpDirEntries(tmpHygieneRealTmp));
	for (const name of tmpHygieneSweepableEntries(
		after,
		tmpHygieneBefore,
		spare,
	)) {
		const entryDir = path.join(tmpHygieneRealTmp, name);
		// #4591: record the origin before the entry is gone, so a leak that
		// reappeared after its file's own sweep can be attributed to HOME or cwd.
		process.stderr.write(formatTmpHygieneLeakOrigin(entryDir));
		removeTempDirSync(entryDir);
	}
	removeRunBackstopDirs();
	const reaped = reapStaleTmpHygieneRecords();
	try {
		fs.rmSync(tmpHygieneBaselinePath, { force: true });
		fs.rmSync(tmpHygieneRunFilesPath, { force: true });
	} catch {
		// A stale ignored baseline is harmless; the next run uses a new id.
	}
	closeTmpHygieneCreators();
	return reaped;
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
