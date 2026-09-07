// Sampling and formatting for `scripts/with-memory-watch.mjs` (#2042).
//
// Kept separate from the wrapper so the parsing and the print policy are unit
// testable without spawning a child process.

import * as fs from "node:fs";
import * as os from "node:os";

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
