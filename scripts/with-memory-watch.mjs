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
	readHostProcSample,
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
 */
function emit(line, fd = 1) {
	fs.writeSync(fd, line);
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
		`watcherPid=${process.pid}\n`,
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
			`${formatSampleLine(atMs, sample, readCgroupSample(cgroupDir), readHostProcSample())}\n`,
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
