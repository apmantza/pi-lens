/** Observed-latency classification shared by dispatch and LSP tier seams. */

import { normalizeMapKey } from "../path-utils.js";

export type CollectLaterTier = "inline" | "collect-later";

/** A runner gets this much time before the next run moves off the write path. */
export const COLLECT_LATER_THRESHOLD_MS = 5_000;

interface ObservedRunner {
	projectRoot: string;
	runnerId: string;
}

const slowRunners = new Map<string, ObservedRunner>();

function key(projectRoot: string, runnerId: string): string {
	return `${normalizeMapKey(projectRoot)}\u0000${runnerId}`;
}

/** Read the current observed tier. Missing observations stay inline. */
export function classifyObservedRunner(
	projectRoot: string,
	runnerId: string,
): CollectLaterTier {
	return slowRunners.has(key(projectRoot, runnerId))
		? "collect-later"
		: "inline";
}

/** Record one completed latency observation and return the resulting tier. */
export function observeRunnerLatency(options: {
	projectRoot: string;
	runnerId: string;
	durationMs: number;
	timedOut?: boolean;
}): CollectLaterTier {
	const normalizedProjectRoot = normalizeMapKey(options.projectRoot);
	const runnerKey = key(normalizedProjectRoot, options.runnerId);
	if (
		options.timedOut === true ||
		options.durationMs > COLLECT_LATER_THRESHOLD_MS
	) {
		slowRunners.set(runnerKey, {
			projectRoot: normalizedProjectRoot,
			runnerId: options.runnerId,
		});
		return "collect-later";
	}
	// A fast completed run is affirmative recovery, not merely absence of a
	// failure. This deliberately prevents a process-lifetime latch.
	slowRunners.delete(runnerKey);
	return "inline";
}

/** Session boundary reset. */
export function resetObservedRunnerLatency(): void {
	slowRunners.clear();
}
