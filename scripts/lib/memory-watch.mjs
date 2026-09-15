// Sampling and formatting for `scripts/with-memory-watch.mjs` (#2042).
//
// Kept separate from the wrapper so the parsing and the print policy are unit
// testable without spawning a child process.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MB = 1024 * 1024;

/**
 * Available memory, in MB, as the OS reports it.
 *
 * `/proc/meminfo`'s MemAvailable is the number the Linux OOM killer's pressure
 * actually tracks: `os.freemem()` excludes reclaimable page cache and reads
 * alarmingly low on a healthy runner, which would make every sample look like
 * an emergency. Fall back to `os.freemem()` off Linux, where this wrapper is
 * only ever a no-op passthrough anyway.
 *
 * @param {string} [meminfoPath]
 * @returns {{ totalMb: number, availableMb: number, source: "meminfo" | "os" }}
 */
export function readMemory(meminfoPath = "/proc/meminfo") {
	try {
		return parseMeminfo(fs.readFileSync(meminfoPath, "utf8"));
	} catch {
		return {
			totalMb: Math.round(os.totalmem() / MB),
			availableMb: Math.round(os.freemem() / MB),
			source: "os",
		};
	}
}

/**
 * @param {string} text
 * @returns {{ totalMb: number, availableMb: number, source: "meminfo" }}
 */
export function parseMeminfo(text) {
	const field = (name) => {
		const match = new RegExp(`^${name}:\\s+(\\d+) kB$`, "m").exec(text);
		if (!match) throw new Error(`meminfo has no ${name}`);
		return Math.round(Number(match[1]) / 1024);
	};
	return {
		totalMb: field("MemTotal"),
		availableMb: field("MemAvailable"),
		source: "meminfo",
	};
}

/**
 * Print policy. A sample every few seconds for a five-minute suite would bury
 * the test output, so a sample is only worth a line when it says something new:
 * the first one, a fall past the low-water threshold, or a big step down from
 * the last line printed.
 *
 * @param {{ availableMb: number }} sample
 * @param {{ lastPrintedMb: number | null, thresholdMb: number, stepMb: number }} state
 * @returns {boolean}
 */
export function shouldPrint(sample, state) {
	if (state.lastPrintedMb === null) return true;
	if (sample.availableMb <= state.thresholdMb) return true;
	return state.lastPrintedMb - sample.availableMb >= state.stepMb;
}

/**
 * How little memory must remain at the low-water mark before a SIGKILL can be
 * blamed on memory. A fraction of the box, floored, so one rule holds on a
 * 7 GB runner and on a 16 GB one.
 */
const EXHAUSTION_AVAILABLE_FRACTION = 0.1;
const EXHAUSTION_AVAILABLE_FLOOR_MB = 512;

/**
 * Is the low-water mark consistent with memory exhaustion?
 *
 * #2042 round 2. The first version of this wrapper asserted "the OS reclaimed
 * memory" for EVERY exit-137, which is a conclusion, not a reading. Three real
 * kills that carried a verdict (runs 33010136296, 32975604997, 32943340609)
 * landed with 13,260 / 13,057 / 13,073 MB of 15,990 MB still available, and
 * the green run alongside them (33012307631) went LOWER, to 13,096 MB. The
 * record was contradicting its own numbers, and every diagnosis downstream
 * inherited the error.
 *
 * An unreadable total or mark defaults to the memory verdict: never quieter
 * than the evidence supports.
 *
 * @param {{ totalMb: number, lowWaterMb: number }} watch
 * @returns {boolean}
 */
function looksMemoryExhausted(watch) {
	if (!Number.isFinite(watch.totalMb) || watch.totalMb <= 0) return true;
	if (!Number.isFinite(watch.lowWaterMb)) return true;
	const limit = Math.max(
		EXHAUSTION_AVAILABLE_FLOOR_MB,
		Math.round(watch.totalMb * EXHAUSTION_AVAILABLE_FRACTION),
	);
	return watch.lowWaterMb <= limit;
}

/**
 * The verdict line. Exit 137 with no failing assertion is the whole problem
 * this wrapper exists for: on its own it reads as infrastructure noise and
 * costs a judged rerun. Naming the low-water mark turns it into a claim about
 * memory that the next reader can act on — and, when the mark says the box was
 * never short of memory, into a claim that memory was NOT the cause.
 *
 * Both kill heads start with "[mem-watch] KILLED" on purpose. The CI failure
 * classifier (scripts/lib/ci-failure-classifier.mjs:114) matches that prefix
 * and quotes the whole matched line as its posted detail, so an honest verdict
 * makes the classifier's detail honest with no change to the classifier.
 *
 * @param {{ code: number | null, signal: string | null }} exit
 * @param {{ totalMb: number, lowWaterMb: number, lowWaterAt: string | null, childPid?: number | null, intervalMs?: number | null }} watch
 * @returns {string}
 */
export function formatVerdict(exit, watch) {
	const status =
		exit.signal !== null
			? `signal=${exit.signal}`
			: `exitCode=${exit.code ?? "null"}`;
	const oomShaped = exit.signal === "SIGKILL" || exit.code === 137;
	let head;
	if (!oomShaped) {
		head = "[mem-watch] done.";
	} else if (looksMemoryExhausted(watch)) {
		head =
			"[mem-watch] KILLED — no failing assertion means the OS reclaimed memory, not a test failure.";
	} else {
		// Round-2 review F4: claim only what a periodic sampler can see. A spike
		// shorter than the interval is invisible to it, and so is a systemd-oomd
		// kill, which fires on pressure while memory still reads available and IS
		// memory-shaped. The kernel evidence step closes both gaps, so this line
		// points at it instead of ruling memory out on its own authority.
		const cadence = watch.intervalMs
			? ` (${watch.intervalMs}ms sampling: a shorter spike, or a pressure-based kill by systemd-oomd, would not show up here)`
			: "";
		head =
			"[mem-watch] KILLED WITH HEADROOM — no failing assertion, and no " +
			`sample fell below ${watch.lowWaterMb} MB of ${watch.totalMb} MB, so ` +
			"the box was not short of memory at any sample point" +
			`${cadence}. Read the kernel kill evidence step for the signal's ` +
			"sender.";
	}
	return (
		`${head} ${status} totalMb=${watch.totalMb} ` +
		`lowWaterAvailableMb=${watch.lowWaterMb}` +
		(watch.lowWaterAt ? ` lowWaterAt=${watch.lowWaterAt}` : "") +
		// Which process actually died. `dmesg`'s "Killed process <pid> (<comm>)"
		// is only attributable next to the pid this wrapper was watching: in run
		// 33010136296 the victim was `npm`, the SMALLEST node process in the
		// tree, which is by itself evidence against the kernel OOM killer.
		(watch.childPid ? ` childPid=${watch.childPid}` : "")
	);
}

// --- Per-sample cgroup attribution (#2042 2026-09-15) -----------------------
//
// The 2026-09-15 diagnosis's "cheapest probe" (section A): a 2s (now 200ms)
// `MemAvailable` poll cannot see per-process RSS, PID-count churn, or PSI
// stall. cgroup v2 can, with no sampling error at all for `memory.peak`. This
// reads the SAME cgroup the "Kernel kill evidence" CI step already resolves,
// so the two records describe the same box the same way.

/**
 * Resolve this process's own cgroup v2 directory by walking `/proc/self/cgroup`
 * upward until an ancestor exposes a readable `memory.events` — the same
 * criterion, and the same walk direction, the "Kernel kill evidence" step uses
 * in bash. cgroup v2's root union hierarchy never populates `memory.events`
 * (or `memory.max`), so reading the literal root silently prints nothing on
 * every run — the defect the "Runner capacity" step repeated four lines away
 * from the #2230 fix until 2026-09-15.
 *
 * @param {string} [cgroupRoot]
 * @param {string} [procCgroupPath]
 * @returns {string | null}
 */
export function resolveCgroupDir(
	cgroupRoot = "/sys/fs/cgroup",
	procCgroupPath = "/proc/self/cgroup",
) {
	let cg;
	try {
		const text = fs.readFileSync(procCgroupPath, "utf8");
		const line = text.split("\n").find((entry) => entry.startsWith("0:"));
		cg = line ? line.split(":").slice(2).join(":").trim() : null;
	} catch {
		return null;
	}
	if (!cg) return null;

	let p = cg;
	for (;;) {
		const dir = path.join(cgroupRoot, p === "/" ? "" : p);
		try {
			fs.accessSync(path.join(dir, "memory.events"), fs.constants.R_OK);
			return dir;
		} catch {
			// not this one — walk up
		}
		if (p === "/" || p === "") return null;
		p = path.dirname(p);
	}
}

/**
 * @param {string} text raw PSI file content (`some avg10=.. total=N\nfull ...`)
 * @returns {number | null} the "some" line's cumulative stall total, in µs
 */
function parsePressureSomeTotal(text) {
	const some = text.split("\n").find((line) => line.startsWith("some "));
	const match = some ? /total=(\d+)/.exec(some) : null;
	return match ? Number(match[1]) : null;
}

/**
 * This run's cgroup memory/PID/PSI counters — the axis a host-memory poll
 * cannot see: `memory.peak` is an exact per-cgroup high-water mark, and PSI's
 * `total` is a cumulative stall counter, so a stall between polls still shows
 * up in the next one. Every field is independently best-effort: an absent or
 * unreadable file (a non-cgroup-v2 host, a sandbox without pids/PSI
 * controllers delegated) yields `null` for that field alone, never a thrown
 * error that would take the sampler down.
 *
 * @param {string | null} cgroupDir
 * @returns {{ memCurrentMb: number|null, memPeakMb: number|null, pidsCurrent: number|null, memPressureSomeTotal: number|null, cpuPressureSomeTotal: number|null }}
 */
export function readCgroupSample(cgroupDir) {
	const readNum = (name) => {
		if (!cgroupDir) return null;
		try {
			const n = Number(
				fs.readFileSync(path.join(cgroupDir, name), "utf8").trim(),
			);
			return Number.isFinite(n) ? n : null;
		} catch {
			return null;
		}
	};
	const readPressureTotal = (name) => {
		if (!cgroupDir) return null;
		try {
			return parsePressureSomeTotal(
				fs.readFileSync(path.join(cgroupDir, name), "utf8"),
			);
		} catch {
			return null;
		}
	};
	const readRaw = (name) => {
		if (!cgroupDir) return null;
		try {
			return fs.readFileSync(path.join(cgroupDir, name), "utf8").trim();
		} catch {
			return null;
		}
	};
	const current = readNum("memory.current");
	const peak = readNum("memory.peak");
	return {
		memCurrentMb: current === null ? null : Math.round(current / MB),
		memPeakMb: peak === null ? null : Math.round(peak / MB),
		pidsCurrent: readNum("pids.current"),
		// #2042 H3 (fork-count exhaustion): the ceiling `pids.current` is
		// measured against. cgroup v2 writes the literal string "max" when the
		// controller is uncapped, which is not a number -- kept raw so the
		// record never silently turns "uncapped" into a null that reads like an
		// unreadable file.
		pidsMax: readRaw("pids.max"),
		memPressureSomeTotal: readPressureTotal("memory.pressure"),
		cpuPressureSomeTotal: readPressureTotal("cpu.pressure"),
	};
}

/**
 * Host-wide process-table and file-descriptor counters (#2042 H3). These are
 * NOT per-cgroup: `/proc/sys/kernel/ns_last_pid` is the last pid the kernel
 * handed out in this pid namespace, so it only ever climbs until it wraps at
 * `pid_max` -- wraparound is the only way a pid can be recycled inside one
 * job, which is the precondition H4's stale-pid kill needs. `/proc/sys/fs/
 * file-nr` is "allocated free max"; only the first number moves.
 *
 * Every field is independently best-effort, like `readCgroupSample`: an
 * unreadable file yields null for that field alone and never throws.
 *
 * @param {string} [procRoot]
 * @returns {{ pidMax: number|null, nsLastPid: number|null, fileNrAllocated: number|null }}
 */
export function readHostProcSample(procRoot = "/proc") {
	const readNum = (rel) => {
		try {
			const n = Number(
				fs.readFileSync(path.join(procRoot, rel), "utf8").trim().split(/\s+/)[0],
			);
			return Number.isFinite(n) ? n : null;
		} catch {
			return null;
		}
	};
	return {
		pidMax: readNum("sys/kernel/pid_max"),
		nsLastPid: readNum("sys/kernel/ns_last_pid"),
		fileNrAllocated: readNum("sys/fs/file-nr"),
	};
}

/**
 * One line of the on-disk sample tail, appended (never rewritten — see
 * `scripts/with-memory-watch.mjs`) once per tick. Kept separate from the
 * host-memory step-print policy above: this line is never printed to the
 * job's console directly, only appended to the file, so it can afford to
 * carry every field every tick.
 *
 * The `[mem-sample] ` prefix (round-2 review F3) is deliberately distinct
 * from `[mem-watch]`: `scripts/lib/ci-failure-classifier.mjs` matches only
 * `[mem-watch] … availableMb=N of M` today, so these lines are NOT yet
 * consumed by the failure classifier — the prefix exists so a future
 * classifier change has a grep-able handle, not because one reads it yet.
 *
 * `at` carries milliseconds (round-2 review F1): the shared `[mem-watch]`
 * `at` (HH:MM:SS, asserted verbatim in `formatVerdict`'s `lowWaterAt=` and by
 * `ci-failure-classifier.test.ts`) is second-resolution, but the cadence here
 * is 200ms — on the 2026-09-15 head's own CI run, 58 of the tail's 300 lines
 * shared a wall-clock second with four to five siblings, indistinguishable
 * without the milliseconds. The caller passes a SEPARATE, higher-resolution
 * timestamp here; the shared `at` local is never widened.
 *
 * @param {string} atMs HH:MM:SS.mmm
 * @param {{ availableMb: number, totalMb: number }} hostSample
 * @param {ReturnType<typeof readCgroupSample>} cgroupSample
 * @returns {string}
 */
export function formatSampleLine(
	atMs,
	hostSample,
	cgroupSample,
	hostProcSample = {},
) {
	const n = (v) => (v === null || v === undefined ? "?" : v);
	return (
		`[mem-sample] ${atMs} availableMb=${hostSample.availableMb} totalMb=${hostSample.totalMb} ` +
		`memCurrentMb=${n(cgroupSample.memCurrentMb)} memPeakMb=${n(cgroupSample.memPeakMb)} ` +
		`pids=${n(cgroupSample.pidsCurrent)} pidsMax=${n(cgroupSample.pidsMax)} ` +
		`memPressureSomeTotal=${n(cgroupSample.memPressureSomeTotal)} ` +
		`cpuPressureSomeTotal=${n(cgroupSample.cpuPressureSomeTotal)} ` +
		`pidMax=${n(hostProcSample.pidMax)} nsLastPid=${n(hostProcSample.nsLastPid)} ` +
		`fileNrAllocated=${n(hostProcSample.fileNrAllocated)}`
	);
}
