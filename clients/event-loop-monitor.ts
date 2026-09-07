/**
 * Production event-loop occupancy monitor (#192 Phase 2).
 *
 * pi-lens runs on pi's TUI event loop; a long synchronous block freezes
 * keystrokes. Our telemetry historically logged phase *durations*, which can't
 * distinguish a TUI-freezing synchronous burst from harmless async/subprocess
 * time — that blind spot let a ~1.5s enumeration freeze through (#188/#191).
 *
 * This wraps Node's native `perf_hooks.monitorEventLoopDelay()` — a histogram
 * of how late the loop services its own timer, i.e. how long it was blocked —
 * with **no per-event JS overhead**. `max` ≈ the worst synchronous block since
 * the last reset.
 *
 * ## System-stall contamination (#1122 / #1123)
 *
 * `monitorEventLoopDelay` measures timer lag with the monotonic clock
 * (`uv_hrtime`, backed by `QueryPerformanceCounter` on Windows). When the whole
 * process is frozen or descheduled — machine sleep / Modern Standby, or paging
 * thrash under commit-charge exhaustion — its next timer fires late by the
 * *entire* wall-clock gap, and the histogram records that gap as a "block".
 * Two distinct system stalls were confirmed against the Windows System event
 * log: (1) a 290,179 ms block that lined up exactly with a 14:33:05Z→14:37:55Z
 * Modern Standby window (Kernel-Power 506/507), reported byte-identical by two
 * independent pids because the HDR histogram quantizes ~290 s into one bucket;
 * (2) a later silent host exit with zero sleep events but twelve
 * Resource-Exhaustion-Detector (id 2004) events at 97% commit charge — the
 * process was paging, not sleeping. Both are machine artifacts, not pi-lens
 * work; latency.log also held multi-*hour* "blocks" that can only be overnight
 * sleep.
 *
 * Comparing a wall clock to a monotonic clock does NOT catch these: on Windows
 * both advance across Modern Standby (the histogram's monotonic delta already
 * equalled the wall gap). The reliable discriminator is **CPU consumption**: a
 * genuine synchronous block of D ms burns ≈ D ms of main-thread CPU, so the
 * window that contains it must have consumed at least ~D ms of CPU. A frozen or
 * thrashing process consumes ~0 CPU across the gap, so when the worst block
 * exceeds all the CPU the window could account for, it was a stall, not work.
 * We window per turn (so the CPU accounting is bounded and each block is
 * attributable to its turn) and tag system-stall-suspected samples instead of
 * letting them poison the "worst real block" high-water.
 */

import { logExtension } from "./extension-log.js";
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

const NS_PER_MS = 1e6;
const US_PER_MS = 1e3;

let histogram: IntervalHistogram | undefined;
let monitorUnavailable = false;

// Per-window (per-turn) baselines for CPU-vs-wall accounting. Captured when the
// monitor starts and re-captured on every reset, so each window's CPU budget is
// measured against exactly the histogram window it will be compared to.
let windowStartWallMs = 0;
let windowStartCpuMs = 0;

const cpuTotalMs = (): number => {
	const c = process.cpuUsage();
	return (c.user + c.system) / US_PER_MS;
};

/**
 * Start the monitor (idempotent). Call once, as early as possible, so startup
 * blocks are captured. Cheap — the sampling is native; nothing runs per event.
 *
 * Purely observational: if the runtime doesn't implement
 * `perf_hooks.monitorEventLoopDelay` (e.g. Bun < 1.3, which throws
 * `ERR_NOT_IMPLEMENTED` on the call), we degrade to "no stats" rather than let
 * the throw abort extension load. `getEventLoopStats()` already tolerates an
 * absent histogram, so every caller keeps working without telemetry.
 */
export function startEventLoopMonitor(resolutionMs = 20): void {
	if (histogram || monitorUnavailable) return;
	try {
		const h = monitorEventLoopDelay({ resolution: resolutionMs });
		h.enable();
		histogram = h;
		windowStartWallMs = Date.now();
		windowStartCpuMs = cpuTotalMs();
	} catch (err) {
		monitorUnavailable = true;
		logExtension({
			subsystem: "event-loop-monitor",
			message: `event-loop occupancy telemetry disabled (runtime lacks monitorEventLoopDelay): ${
				(err as Error)?.message ?? String(err)
			}`,
		});
	}
}

export interface EventLoopStats {
	/** Longest single loop stall (≈ worst synchronous block) since reset, ms. */
	maxMs: number;
	/** 99th-percentile loop delay, ms. */
	p99Ms: number;
	/** Mean loop delay, ms. */
	meanMs: number;
	/** Wall-clock time elapsed in the current window (since start/reset), ms. */
	windowWallMs: number;
	/**
	 * PROCESS-WIDE CPU consumed in the current window, ms — `process.cpuUsage()`
	 * sums all threads (main loop AND libuv/worker threads), not just the main
	 * thread. A main-thread synchronous block of D ms requires ≈ D ms of CPU, so
	 * `windowCpuMs` still upper-bounds any real block; a `maxMs` far above it is a
	 * freeze/suspend, not work (#1122). Caveat (false-negative): a suspend that
	 * overlaps a worker-CPU-heavy turn can be masked — the workers' CPU inflates
	 * `windowCpuMs` enough to "account for" the frozen gap, so that stall reads as
	 * genuine. Acceptable here: the big artifacts (sleep, multi-hour) dwarf any
	 * plausible worker burst, and the `lastPhase`/wall-vs-CPU metadata still lets
	 * a human catch the rare overlap.
	 */
	windowCpuMs: number;
	/**
	 * True when `maxMs` looks like a machine stall — sleep/standby or
	 * commit-charge paging thrash — rather than genuine CPU work (#1122).
	 */
	suspectSystemStall: boolean;
	/**
	 * Which stall class `maxMs` falls in, read from `windowCpuMs` (#1980). See
	 * {@link classifyLoopBlock}. `suspectSystemStall` above is unchanged and
	 * still means exactly what it meant; `stallClass === "system-stall"` is the
	 * same predicate surfaced in the ladder.
	 */
	stallClass: LoopBlockStallClass;
	/**
	 * `windowCpuMs / maxMs`, rounded to two decimals — the ratio #1980 had to
	 * compute by hand over 1221 records. Undefined when `maxMs` is 0 (no block,
	 * nothing to cover). Values above 1 are normal and not an error:
	 * `windowCpuMs` is process-wide over the WHOLE window, so it routinely
	 * exceeds one block inside that window.
	 */
	cpuCoverageRatio: number | undefined;
}

/**
 * How a `loop_block` sample splits on the CPU axis (#1980).
 *
 * - `below-floor` — shorter than {@link STALL_CLASSIFY_FLOOR_MS}. Not
 *   classified: at this scale timer slop and CPU-accounting granularity are
 *   the same order as the signal, so any verdict would be noise. Said out
 *   loud rather than defaulted to the compute label.
 * - `cpu-accounted` — the window burned enough CPU to account for the block.
 *   Deliberately NOT named "compute": `windowCpuMs` is process-wide over the
 *   whole window, so covering the block is consistent with compute but does
 *   not prove it. Only one direction of this test is sound (see below).
 * - `non-cpu-stall` — the window's TOTAL CPU cannot cover the block, so the
 *   block provably was not computing. The loop was parked: synchronous fs on
 *   a cloud-backed tree, a blocking native call, `spawnSync`, a lock. This is
 *   the class #1980 found nine of sixteen 5 s+ blocks in.
 * - `system-stall` — `non-cpu-stall` AND over the suspend floor, i.e. the
 *   pre-existing {@link isSuspendSuspectedBlock} verdict: machine sleep,
 *   Modern Standby, or commit-charge paging.
 */
type LoopBlockStallClass =
	| "below-floor"
	| "cpu-accounted"
	| "non-cpu-stall"
	| "system-stall";

/**
 * Below this, a block is not classified at all (`below-floor`). #1980 mined
 * the 5 s+ tier; 1 s is a deliberately conservative floor that still covers
 * every block that tier cares about while keeping sub-second jitter — where
 * measurement slop rivals the signal — out of the verdict.
 */
const STALL_CLASSIFY_FLOOR_MS = 1000;

/**
 * Slack allowed to the CPU budget before a block counts as unaccounted.
 * `process.cpuUsage()` and the histogram are sampled at slightly different
 * instants and the histogram quantizes, so a block whose CPU coverage is
 * within this much of exact is called `cpu-accounted`, not a stall.
 */
const STALL_CLASSIFY_SLOP_MS = 250;

/** What {@link classifyLoopBlock} decides about one sample. */
export interface LoopBlockClassification {
	stallClass: LoopBlockStallClass;
	cpuCoverageRatio: number | undefined;
}

/**
 * Split a block into compute-vs-stall from the CPU it could possibly have
 * burned (#1980). Pure, so the discrimination is testable without the native
 * histogram or a real machine stall — the same reason
 * {@link isSuspendSuspectedBlock} is pure.
 *
 * ## Why this is sound in exactly one direction
 *
 * `windowCpuMs` is the CPU the WHOLE process consumed across the WHOLE window
 * — every thread, every phase, not just this block. So it is an UPPER BOUND on
 * the CPU this one block could have burned. A synchronous compute block of D ms
 * needs ≈ D ms of main-thread CPU. Therefore:
 *
 * - `windowCpuMs + slop < maxMs` PROVES the block was not compute. Even if the
 *   block had been the only thing running, there was not enough CPU in the
 *   whole window to cover it. This is the `non-cpu-stall` verdict and it is a
 *   real inference, not a heuristic.
 * - The converse proves nothing. A window can burn 30 s of CPU in other phases
 *   and still contain a 5 s I/O park. That is why the label is
 *   `cpu-accounted` ("the budget covers it") rather than "compute": it reports
 *   the absence of proof, not the presence of compute.
 *
 * The existing 20 s suspend verdict is not re-derived here; this delegates to
 * {@link isSuspendSuspectedBlock} so there is one definition of a suspend, and
 * `system-stall` is checked BEFORE `non-cpu-stall` because a suspend is the
 * strictly more specific case of the same evidence.
 *
 * ## Known ambiguity, carried forward not silenced
 *
 * `isSuspendSuspectedBlock`'s own doc records that a >20 s synchronous syscall
 * stall is CPU-indistinguishable from a suspend. Nothing here fixes that. What
 * this adds is the tier BELOW that floor: a 5-20 s non-CPU block, which used
 * to read as ordinary compute and now reads as `non-cpu-stall` with the
 * `inFlightPhase` attribution beside it.
 */
export function classifyLoopBlock(
	maxMs: number,
	windowCpuMs: number,
	options: {
		floorMs?: number;
		slopMs?: number;
		suspendFloorMs?: number;
		suspendSlopMs?: number;
	} = {},
): LoopBlockClassification {
	const {
		floorMs = STALL_CLASSIFY_FLOOR_MS,
		slopMs = STALL_CLASSIFY_SLOP_MS,
		suspendFloorMs,
		suspendSlopMs,
	} = options;
	const cpuCoverageRatio =
		maxMs > 0 ? Math.round((windowCpuMs / maxMs) * 100) / 100 : undefined;
	if (maxMs < floorMs) return { stallClass: "below-floor", cpuCoverageRatio };
	if (
		isSuspendSuspectedBlock(maxMs, windowCpuMs, suspendFloorMs, suspendSlopMs)
	)
		return { stallClass: "system-stall", cpuCoverageRatio };
	if (windowCpuMs + slopMs < maxMs)
		return { stallClass: "non-cpu-stall", cpuCoverageRatio };
	return { stallClass: "cpu-accounted", cpuCoverageRatio };
}

const safeMs = (ns: number): number =>
	Number.isFinite(ns) ? Math.round((ns / NS_PER_MS) * 10) / 10 : 0;

/**
 * Classify a worst-block sample as genuine CPU work or a suspend/freeze
 * artifact. Pure so the discrimination is testable without the (vitest-flaky)
 * native histogram or a real machine sleep.
 *
 * A block is system-stall-suspected only when it is both (a) larger than any
 * plausible synchronous pi-lens stall (`floorMs`, default 20 s — the real tier
 * observed in latency.log tops out ~15 s) and (b) unaccounted for by the
 * window's CPU budget (`windowCpuMs + slopMs < maxMs`). The floor keeps a real
 * multi-second I/O-bound block (low CPU, but genuine) from being mislabeled,
 * while a frozen or paging process — ~0 CPU across a minutes-to-hours gap —
 * always trips. Sub-floor blocks are never auto-tagged, but the logged
 * `windowCpuMs`/`windowWallMs` still expose the CPU-vs-wall ratio so a reviewer
 * can spot a shorter paging stall by hand.
 *
 * KNOWN AMBIGUITY (honest, not fully resolvable from CPU alone): a genuine
 * pi-lens block that is BLOCKED IN A SYSCALL for >20 s — e.g. a `readdirSync` /
 * `statSync` stalled on a OneDrive/cloud-backed path fetching a dehydrated file,
 * or an antivirus-throttled read — also consumes ~0 CPU while wall time
 * advances, so it is CPU-indistinguishable from a suspend and WILL be tagged
 * `suspectSystemStall` and excluded from the health high-waters. That is the
 * conservative choice (a >20 s synchronous FS stall is itself a P0-worthy bug we
 * do NOT want silently counted as normal), and it is not silenced: such a sample
 * still re-logs every turn with its `lastPhase` attribution, which is the
 * forensic breadcrumb for exactly this class. Sharper corroboration (a magnitude
 * ceiling, a `maxMs`-vs-`windowWallMs` ratio) is tracked as a follow-up note on
 * #1123, not decided here.
 */
export function isSuspendSuspectedBlock(
	maxMs: number,
	windowCpuMs: number,
	floorMs = 20000,
	slopMs = 1000,
): boolean {
	if (maxMs < floorMs) return false;
	return windowCpuMs + slopMs < maxMs;
}

/** Current occupancy stats, or undefined if the monitor was never started. */
export function getEventLoopStats(): EventLoopStats | undefined {
	if (!histogram) return undefined;
	const maxMs = safeMs(histogram.max);
	const windowWallMs = Math.max(0, Date.now() - windowStartWallMs);
	const windowCpuMs = Math.max(0, cpuTotalMs() - windowStartCpuMs);
	// One classification pass feeds both fields, so `suspectSystemStall` and
	// `stallClass` can never disagree about the same sample (#1980).
	const classification = classifyLoopBlock(maxMs, windowCpuMs);
	return {
		maxMs,
		p99Ms: safeMs(histogram.percentile(99)),
		meanMs: safeMs(histogram.mean),
		windowWallMs: Math.round(windowWallMs),
		windowCpuMs: Math.round(windowCpuMs),
		suspectSystemStall: classification.stallClass === "system-stall",
		stallClass: classification.stallClass,
		cpuCoverageRatio: classification.cpuCoverageRatio,
	};
}

/**
 * Reset the histogram and re-baseline the CPU/wall window — called at turn
 * boundaries so each window's worst block is attributable to that turn and its
 * CPU budget is measured over the same span (#192 intent, wired in #1122).
 */
export function resetEventLoopMonitor(): void {
	histogram?.reset();
	windowStartWallMs = Date.now();
	windowStartCpuMs = cpuTotalMs();
}

/**
 * Decide whether THIS block beats the session's running high-water. Pure so
 * the threshold logic is testable without the (vitest-flaky) native
 * histogram. Requires `maxMs > lastLoggedMs + deltaMs` above a floor
 * (`minMs`) so noise near the current max doesn't keep re-triggering the
 * high-water bookkeeping.
 *
 * NOTE (#1723): this is no longer the logging gate — see
 * `shouldLogLoopBlock` for that. This function now answers a narrower
 * question ("is this a new session worst?", used for the `worstSoFar`
 * metadata flag and for deciding whether to advance the high-water), because
 * gating the LOG on it hid every sub-maximum block after a session's first
 * large one, which made loop_block-vs-pull-timeout correlation undecidable.
 */
export function shouldLogWorstBlock(
	maxMs: number,
	lastLoggedMs: number,
	minMs = 60,
	deltaMs = 25,
): boolean {
	return maxMs >= minMs && maxMs > lastLoggedMs + deltaMs;
}

/**
 * Decide whether a block is worth persisting to `latency.log` AT ALL (#1723).
 * Every block at or above the floor (`minMs`) qualifies — not only a new
 * session worst — because a session's later blocks can be smaller than an
 * early spike yet still be exactly the ones that starved an LSP pull
 * (#1549/#1713) and are otherwise invisible to the correlation.
 *
 * Volume is bounded by CALL CADENCE, not by this gate: the `turn_end` caller
 * invokes this at most once per turn (the histogram window is reset every
 * turn), so the natural cap is one `loop_block` record per turn — a jittery
 * session cannot flood the log because there is nowhere for a second sample
 * to come from within the same turn.
 */
export function shouldLogLoopBlock(maxMs: number, minMs = 60): boolean {
	return maxMs >= minMs;
}

/** Test-only: stop and clear the monitor so cases don't leak into each other. */
export function _stopEventLoopMonitorForTest(): void {
	histogram?.disable();
	histogram = undefined;
	monitorUnavailable = false;
	windowStartWallMs = 0;
	windowStartCpuMs = 0;
}
