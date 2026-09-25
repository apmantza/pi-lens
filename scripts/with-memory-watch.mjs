#!/usr/bin/env node
/**
 * scripts/with-memory-watch.mjs (#2042)
 *
 * Runs a command while sampling host memory, so an OOM kill leaves evidence.
 *
 * The problem it solves is not memory use, it is memory ATTRIBUTION. The CI
 * Unit-tests job was SIGKILLed repeatedly with `Killed npm test` and exit 137
 * and zero failing assertions. That output names no file, no process, and no
 * number, so every occurrence reads as infrastructure noise and costs a judged
 * rerun. This wrapper prints the host's memory low-water mark and a verdict
 * line, so the next exit 137 is a claim about memory that a reader can check.
 *
 * It never changes what runs, and it forwards the child's exit code and signal
 * unchanged -- a killed run still fails the job.
 *
 * Usage:
 *   node scripts/with-memory-watch.mjs -- <command> [args...]
 *
 * Env:
 *   PI_LENS_MEM_WATCH_INTERVAL_MS   Sampling period (default 2000).
 *   PI_LENS_MEM_WATCH_LOW_MB        Print every sample at or below this many
 *                                   MB available (default 1024).
 *   PI_LENS_MEM_WATCH_STEP_MB       Print when available memory has fallen this
 *                                   far since the last printed line
 *                                   (default 1024).
 *   PI_LENS_MEM_WATCH_SAMPLE_FILE   Path for the per-sample record (the #2042
 *                                   2026-09-15 diagnosis's "cheapest probe").
 *                                   Default: <tmpdir>/pi-lens-mem-watch-
 *                                   samples.log. Appended to, one line per
 *                                   tick, never rewritten — round-2 review F2:
 *                                   an in-memory ring plus a full-file
 *                                   rewrite each tick measured 122.7 MB of
 *                                   writes over one 12-minute run and, worse,
 *                                   held only its OWN fixed window: on a run
 *                                   whose low-water mark preceded the job's
 *                                   end by more than that window, the window
 *                                   had already scrolled past it by the time
 *                                   anything read the file. `appendFileSync`
 *                                   can never lose an earlier line, and the
 *                                   CI reader step bounds what it PRINTS with
 *                                   `tail`, not what the sampler writes.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import {
	formatSampleLine,
	formatVerdict,
	readCgroupSample,
	readMemory,
	resolveCgroupDir,
	shouldPrint,
} from "./lib/memory-watch.mjs";

/**
 * Every line this wrapper emits goes through a BLOCKING write, never
 * `process.stdout.write` or `process.stderr.write`.
 *
 * When stdout is a pipe, Node buffers writes and flushes them asynchronously,
 * and `process.exit()` discards whatever is still queued. A reader that has
 * fallen behind — a log collector under memory pressure, which is precisely the
 * scenario this file exists for — fills the pipe, so the verdict line is queued
 * rather than written, and then thrown away microseconds later. The #2093
 * review reproduced that 3/3 with a slow reader: correct exit code, no verdict
 * line. On Linux, `fs.writeSync` blocks until the bytes reach the OS, so the
 * record survives.
 *
 * On Windows this is NOT sufficient: pipe-buffered bytes can be discarded at
 * process teardown even after `fs.writeSync` reports a complete write (the
 * #2093 verify reproduced the loss post-fix, `ok bytes=86 of 86` and no line at
 * the reader). That is a separate OS teardown behavior no write mechanism here
 * closes. The wrapper's durability guarantee is CI-grade (Linux) only.
 *
 * #3097: fd 1 is not reliably blocking, and the wrapper does not get a vote.
 * `stdio: "inherit"` hands the child the SAME open file description, and libuv
 * sets O_NONBLOCK on it as soon as the child initialises its own
 * `process.stdout` on a pipe -- after this wrapper has started, so nothing
 * clearable at startup helps. A `writeSync` to a full pipe then throws EAGAIN
 * instead of blocking, and on CI run 35067086859 that throw came out of the
 * sampler's `setInterval` callback and killed the wrapper with exit 1, under
 * exactly the reader backpressure it exists to survive. Retrying on EAGAIN is
 * what restores the blocking semantics the paragraph above describes: it
 * retries for as long as a blocking write would have waited -- indefinitely,
 * because a blocking `writeSync` to a pipe whose reader never drains never
 * returns either (probed on this same wrapper, exit=null after 3 s). A cap
 * would be strictly LESS durable than the blocking write it emulates: the
 * verdict line would be dropped in the one case #2093 exists to cover, a
 * reader that is slow rather than gone. A reader that is GONE closes the pipe,
 * which is EPIPE, not EAGAIN, and takes the degradation path below.
 */
const WRITE_RETRY_SLEEP_MS = 5;
// Nothing in the stdlib waits for a fd to become writable synchronously, and a
// bare retry loop would spin a core on the memory-pressured host this wrapper
// is measuring. `Atomics.wait` is the one sleep that yields the CPU.
const retryPark = new Int32Array(new SharedArrayBuffer(4));
let writeFailureNoted = false;

/**
 * #3141: the EAGAIN retry above only bounds a write while the shared
 * description is non-blocking, and the child decides that, not this
 * wrapper. Once the wrapped command has exited, its libuv teardown restores
 * the blocking flag on the description it shared via `stdio: "inherit"`, so
 * the next `writeSync` to a full pipe blocks outright -- no deadline between
 * retries can preempt a syscall that never returns. The verdict line at child
 * exit is exactly that write, so master hung 3/3 with stdout dead and stderr
 * full (#3129 round-2 verify).
 *
 * The wrapper therefore writes through its OWN open file description: when
 * fd 1 or 2 is a pipe, `/proc/self/fd/<n>` is reopened with O_NONBLOCK. That
 * is a new description on the same pipe (Linux reopens a pipe through its
 * /proc link), so its flags are private to this process, and every write
 * either lands, fails with EAGAIN (and parks, bounded or not, in `emit()`),
 * or fails with EPIPE. Bytes still enter the same pipe buffer in write order,
 * so interleaving with the child's output is unchanged.
 *
 * Only pipes: reopening a regular file would start a second, independent
 * offset that overwrites the child's output, and a TTY never parks a write
 * the way a full pipe does. Everything else -- and any platform without
 * /proc, or a reopen that fails (ENXIO when the reader is already gone) --
 * keeps writing to the inherited fd, as before. Cost: up to two extra fds,
 * opened once at startup.
 */
function ownWriteFd(fd) {
	try {
		if (!fs.fstatSync(fd).isFIFO()) return fd;
		return fs.openSync(
			`/proc/self/fd/${fd}`,
			fs.constants.O_WRONLY | fs.constants.O_NONBLOCK,
		);
	} catch {
		return fd;
	}
}
const writeFds = { 1: ownWriteFd(1), 2: ownWriteFd(2) };

/**
 * #3141: `ownWriteFd` engages only on a pipe; a UNIX socket cannot be
 * reopened through /proc and keeps the inherited description, whose blocking
 * flag the child still controls. Which one CI hands this wrapper decides
 * whether that fix is live there, so the startup line names it for every
 * run: `stdout:pipe/private` is the fixed shape, `…:socket/inherited` is the
 * open one.
 */
function stdioShape(fd) {
	let kind = "other";
	try {
		const stat = fs.fstatSync(fd);
		if (stat.isFIFO()) kind = "pipe";
		else if (stat.isSocket()) kind = "socket";
		else if (stat.isFile()) kind = "file";
		else if (stat.isCharacterDevice()) kind = "chardev";
	} catch {
		kind = "closed";
	}
	return `${kind}/${writeFds[fd] === fd ? "inherited" : "private"}`;
}

/**
 * #3110 round 2 review F1: routing the once-only note through `emit()`
 * inherits its UNBOUNDED EAGAIN park (the paragraph above -- correct for the
 * verdict line, which #2093 requires never drop). The note is a different
 * contract: it exists to survive a reader that is merely SLOW (#3110), not
 * one that never drains at all. With stdout dead and stderr live-but-never-
 * draining, an unbounded retry INSIDE the sampler's `setInterval` callback
 * blocks the event loop forever -- `child.on("exit")` never runs, the
 * wrapper never forwards the exit code, and CI sees a job timeout with no
 * exit status, which is worse than the dropped note #3110 fixes. Only the
 * note's own `emit()` call takes this cap (below); the verdict line and every
 * other call keep the unbounded park unconditionally.
 *
 * 400ms: generous next to the #3110 recovery shape this cap exists for (a
 * reader that resumes on a ~100ms cadence gets several chances well inside
 * it), and short next to a typical wrapped command's own runtime. Measured,
 * not guessed: with the WRAPPED COMMAND still alive, the retry loop parks
 * cleanly on EAGAIN and gives up exactly at the deadline for any cap tried
 * (500ms-2000ms, hundreds of iterations, no stall). The moment the wrapped
 * command itself has already exited while the retry is still in flight,
 * further `writeSync` calls on the fd it shared via `stdio: "inherit"` were
 * observed to stop returning EAGAIN and block outright -- a real hang no
 * `Date.now()` check between retries can preempt, reproduced 3/3 at every
 * cap from 1000ms up against a probe whose command exits at 600ms, clean 5/5
 * at every cap from 500ms down. 400ms keeps a safety margin under that
 * boundary rather than riding it.
 */
const NOTE_WRITE_MAX_WAIT_MS = 400;

/**
 * A write failure that is not EAGAIN is permanent (EPIPE, EBADF): retrying
 * cannot help and throwing kills the wrapped job. Record it once -- once per
 * process, not once per tick, because every later tick hits the same dead fd --
 * and let the child's exit code stay the story.
 *
 * #3110: this used to write the note with a raw, un-retried `fs.writeSync(2,
 * ...)` in a bare catch. Fd 1 dying (EPIPE) says nothing about fd 2's health --
 * a slow reader on stderr leaves it merely FULL, which is EAGAIN, not EPIPE --
 * and a raw write there dropped the note for good (reproduced 3/3: full stderr
 * pipe + destroyed stdout -> noteCount 0, catch code EAGAIN). `emit()` already
 * retries EAGAIN until the pipe drains; routing through it here is recursion
 * safe ONLY because `writeFailureNoted` is set BEFORE calling it -- a
 * genuinely dead stderr (EPIPE from emit's own catch) re-enters this function
 * and returns immediately instead of looping. Setting the latch after the
 * call reopens the #3097 unbounded-recursion failure mode (round 2 review
 * F2): swapping the two lines below is what plants that mutation.
 */
function noteWriteFailureOnce(error) {
	if (writeFailureNoted) return;
	writeFailureNoted = true;
	emit(
		`[mem-watch] record dropped: ${error.message}\n`,
		2,
		NOTE_WRITE_MAX_WAIT_MS,
	);
}

/**
 * @param {string} line
 * @param {number} [fd]
 * @param {number} [maxWaitMs] Give up (and degrade through
 *   `noteWriteFailureOnce`) once this many milliseconds have been spent
 *   parked on EAGAIN. Default `Infinity` preserves #2093's unconditional
 *   blocking-write guarantee for every caller except the note (round 2
 *   review F1).
 */
function emit(line, fd = 1, maxWaitMs = Number.POSITIVE_INFINITY) {
	const deadline = Date.now() + maxWaitMs;
	for (;;) {
		try {
			fs.writeSync(writeFds[fd] ?? fd, line);
			return;
		} catch (error) {
			// A `writeSync` that throws wrote nothing (the syscall returned -1),
			// so the whole line is retried without risking a duplicated prefix.
			if (error?.code === "EAGAIN" && Date.now() < deadline) {
				Atomics.wait(retryPark, 0, 0, WRITE_RETRY_SLEEP_MS);
				continue;
			}
			noteWriteFailureOnce(error);
			return;
		}
	}
}

const separator = process.argv.indexOf("--");
const command = separator === -1 ? [] : process.argv.slice(separator + 1);
if (command.length === 0) {
	emit("usage: node scripts/with-memory-watch.mjs -- <command> [args...]\n", 2);
	process.exit(2);
}

const intervalMs = Number(process.env.PI_LENS_MEM_WATCH_INTERVAL_MS) || 2000;
const thresholdMb = Number(process.env.PI_LENS_MEM_WATCH_LOW_MB) || 1024;
const stepMb = Number(process.env.PI_LENS_MEM_WATCH_STEP_MB) || 1024;
const sampleFile =
	process.env.PI_LENS_MEM_WATCH_SAMPLE_FILE ||
	`${os.tmpdir()}/pi-lens-mem-watch-samples.log`;
// Resolved once: the cgroup a process belongs to does not change mid-run, and
// re-walking /proc/self/cgroup every 200ms would be pure overhead.
const cgroupDir = resolveCgroupDir();

const first = readMemory();
emit(
	`[mem-watch] host cpus=${os.availableParallelism?.() ?? os.cpus().length} ` +
		`totalMb=${first.totalMb} availableMb=${first.availableMb} ` +
		`source=${first.source} intervalMs=${intervalMs} ` +
		// #2042 round 2: the kernel's own record names a pid and a comm
		// ("Killed process 2477 (npm)"). Without these pids in the log there is
		// nothing to match it against, and the two observed victims are exactly
		// these two processes: the wrapper itself (run 32908647308) and its
		// `npm` child (run 33010136296).
		`watcherPid=${process.pid} ` +
		`stdio=stdout:${stdioShape(1)},stderr:${stdioShape(2)}\n`,
);

const watch = {
	totalMb: first.totalMb,
	lowWaterMb: first.availableMb,
	lowWaterAt: null,
	childPid: null,
	// The verdict states what this cadence cannot see, so it has to carry it.
	intervalMs,
};
const state = { lastPrintedMb: null, thresholdMb, stepMb };

const timer = setInterval(() => {
	const sample = readMemory();
	const now = new Date();
	const at = now.toISOString().slice(11, 19);
	if (sample.availableMb < watch.lowWaterMb) {
		watch.lowWaterMb = sample.availableMb;
		watch.lowWaterAt = at;
	}
	if (shouldPrint(sample, state)) {
		state.lastPrintedMb = sample.availableMb;
		emit(
			`[mem-watch] ${at} availableMb=${sample.availableMb} of ${sample.totalMb}\n`,
		);
	}
	// Round-2 review F1: `at` above is second-resolution and shared with the
	// verdict's `lowWaterAt=`, which tests pin verbatim
	// (tests/scripts/memory-watch.test.ts, ci-failure-classifier.test.ts) — it
	// is never widened. The 200ms cadence needs its own, higher-resolution
	// stamp, used ONLY here.
	const atMs = now.toISOString().slice(11, 23);
	// The #2042 2026-09-15 cheapest probe: everything a 200ms MemAvailable poll
	// cannot see. Never printed to the job's console — that would bury the test
	// output — only appended to the on-disk record below, which an
	// `if: always()` CI step reads even when this very wrapper is the kill's
	// victim (the master 1701d01 red: no verdict line, because the wrapper
	// itself died — this file is the record that survives that case).
	try {
		fs.appendFileSync(
			sampleFile,
			`${formatSampleLine(atMs, sample, readCgroupSample(cgroupDir))}\n`,
		);
	} catch {
		// Best-effort: a disk-full or permissions failure here must never take
		// down the sampler or the wrapped command.
	}
}, intervalMs);
// The watcher must never be the reason the process stays alive.
timer.unref?.();

// CI-only, and CI is Linux. The win32 branch is a courtesy for running the
// wrapper by hand on a dev box: Windows cannot exec `npm` without a shell, and
// `shell: true` concatenates rather than escapes the arguments, so a path with
// a space or a shell metacharacter would be mis-parsed. Do not build a Windows
// job on this.
const child = spawn(command[0], command.slice(1), {
	stdio: "inherit",
	shell: process.platform === "win32",
});
watch.childPid = child.pid ?? null;

child.on("error", (error) => {
	clearInterval(timer);
	emit(`[mem-watch] failed to spawn: ${error.message}\n`, 2);
	process.exit(1);
});

child.on("exit", (code, signal) => {
	clearInterval(timer);
	emit(`${formatVerdict({ code, signal }, watch)}\n`);
	// Re-raising the signal would make this wrapper's own death the story. Map
	// it to the shell's 128+n instead, which is the code CI already reports.
	if (signal) process.exit(128 + (os.constants.signals[signal] ?? 0));
	process.exit(code ?? 1);
});
