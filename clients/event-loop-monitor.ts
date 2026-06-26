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
 */

import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

const NS_PER_MS = 1e6;

let histogram: IntervalHistogram | undefined;
let monitorUnavailable = false;

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
	} catch (err) {
		monitorUnavailable = true;
		console.error(
			`[pi-lens] event-loop occupancy telemetry disabled (runtime lacks monitorEventLoopDelay): ${
				(err as Error)?.message ?? String(err)
			}`,
		);
	}
}

export interface EventLoopStats {
	/** Longest single loop stall (≈ worst synchronous block) since reset, ms. */
	maxMs: number;
	/** 99th-percentile loop delay, ms. */
	p99Ms: number;
	/** Mean loop delay, ms. */
	meanMs: number;
}

const safeMs = (ns: number): number =>
	Number.isFinite(ns) ? Math.round((ns / NS_PER_MS) * 10) / 10 : 0;

/** Current occupancy stats, or undefined if the monitor was never started. */
export function getEventLoopStats(): EventLoopStats | undefined {
	if (!histogram) return undefined;
	return {
		maxMs: safeMs(histogram.max),
		p99Ms: safeMs(histogram.percentile(99)),
		meanMs: safeMs(histogram.mean),
	};
}

/** Reset the histogram — e.g. at session/turn boundaries for per-window stats. */
export function resetEventLoopMonitor(): void {
	histogram?.reset();
}

/**
 * Decide whether a freeze is worth persisting to `latency.log`. Pure so the
 * threshold logic is testable without the (vitest-flaky) native histogram.
 * Logs only a *new* worst block (`maxMs > lastLoggedMs + deltaMs`) above a
 * floor (`minMs`), so a turn that froze worse than ever before is recorded
 * once — not the same growing max every turn.
 */
export function shouldLogWorstBlock(
	maxMs: number,
	lastLoggedMs: number,
	minMs = 60,
	deltaMs = 25,
): boolean {
	return maxMs >= minMs && maxMs > lastLoggedMs + deltaMs;
}

/** Test-only: stop and clear the monitor so cases don't leak into each other. */
export function _stopEventLoopMonitorForTest(): void {
	histogram?.disable();
	histogram = undefined;
	monitorUnavailable = false;
}
