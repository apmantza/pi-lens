// Per-worker test environment defaults (vitest `setupFiles`).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeEach, expect, vi } from "vitest";
import { installGitFixtureEnv } from "./git-fixture-env.js";
import { installKillGuard, killGuardReport } from "./kill-guard.js";
import { reportPeakRss } from "./worker-peak-rss.js";
import { removeTempDirSync } from "../clients/test-utils.js";
import {
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
const tmpHygieneHome = process.env.PI_LENS_HOME
	? path.resolve(process.env.PI_LENS_HOME)
	: path.join(process.cwd(), ".probe-home");
fs.mkdirSync(tmpHygieneHome, { recursive: true });
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
beforeEach(() => touchTmpHygieneOwnerMarker());
afterEach(() => touchTmpHygieneOwnerMarker());

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
}

let tmpHygieneBefore: Set<string>;
let backstopRootBefore: Record<string, number>;

function adoptBaseline(baseline: TmpHygieneBaseline): void {
	tmpHygieneBefore = new Set(baseline.tmp);
	backstopRootBefore = baseline.backstopRoot;
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
process.env.PI_LENS_HOME = tmpHygieneHome;

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
	const peakMb = Math.round(process.resourceUsage().maxRSS / 1024);
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

/** ONE record per hygiene run (not one per marker): the owner-marker census the
 *  hygiene owner acted on, so a suppressed or attributed entry is explicable
 *  from the run's own output. */
export function formatTmpHygieneOwnerSummary(
	scan: TmpHygieneOwnerScan,
	otherInvocationEntries = 0,
	reaped = 0,
): string {
	const { counts } = scan;
	return `[tmp-hygiene-owners] live=${counts.live} orphaned=${counts.orphaned} malformed=${counts.malformed} foreign=${counts.foreign} self=${counts.self} otherInvocationEntries=${otherInvocationEntries} reaped=${reaped}`;
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
	const manifestPrefix = "tmp-hygiene-files-";
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
		if (!name.startsWith(manifestPrefix) || !name.endsWith(".log")) continue;
		if (runId !== undefined && name === `${manifestPrefix}${runId}.log`)
			continue;
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
 */
export function tmpHygieneForeignRunEntries(
	entries: readonly string[],
	ownersFor: (entry: string) => readonly string[],
	runFiles: ReadonlySet<string>,
): string[] {
	if (runFiles.size === 0) return [];
	return entries.filter((entry) => {
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

afterAll(() => {
	try {
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
		removeTempDirSync(path.join(tmpHygieneRealTmp, name));
	}
	removeRunBackstopDirs();
	const reaped = reapStaleTmpHygieneRecords();
	try {
		fs.rmSync(tmpHygieneBaselinePath, { force: true });
		fs.rmSync(tmpHygieneRunFilesPath, { force: true });
	} catch {
		// A stale ignored baseline is harmless; the next run uses a new id.
	}
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
