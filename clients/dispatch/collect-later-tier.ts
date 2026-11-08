/** Observed-latency classification shared by dispatch and LSP tier seams. */

import { normalizeMapKey } from "../path-utils.js";
import type { RunnerResult } from "./types.js";

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

/** One file's rerun, owed once the running run of its runner settles. */
interface QueuedRun {
	/** The latest write's run; a later write to the file replaces it. */
	start: () => Promise<RunnerResult>;
	promise: Promise<RunnerResult>;
	resolve: (result: RunnerResult) => void;
	reject: (error: unknown) => void;
}

/** The queued reruns of one (project, runner) while a run is in flight. */
interface Flight {
	queued: Map<string, QueuedRun>;
}

/**
 * #5413: the collect-later run in flight per (project, runner). Before it, a
 * slow runner started a run on every write (three writes, three runs at once,
 * each holding a child). One entry per key: a key exists only while a run is
 * in flight, its queue holds one slot per file written meanwhile, and a session
 * reset clears it with `slowRunners`.
 */
const flights = new Map<string, Flight>();

const DROPPED_BY_RESET: RunnerResult = {
	status: "skipped",
	diagnostics: [],
	semantic: "none",
};

/**
 * Start a collect-later run, or owe one (#5413). With no run of this runner in
 * flight for the project, `start` runs now. Otherwise the write queues a rerun
 * for its file, which starts after the running run settles and reads the
 * file's bytes as they are then; a later write to the same file before that
 * replaces the queued `start` and shares its answer. It never joins the
 * running run, whose answer is for older bytes and which the turn-end
 * freshness gate drops as stale (shape 70). Queued files run one at a time.
 */
export function runCollectLater(options: {
	projectRoot: string;
	runnerId: string;
	filePath: string;
	start: () => Promise<RunnerResult>;
}): { promise: Promise<RunnerResult>; coalesced: boolean } {
	const flightKey = key(options.projectRoot, options.runnerId);
	const flight = flights.get(flightKey);
	if (flight) {
		const fileKey = normalizeMapKey(options.filePath);
		const queued = flight.queued.get(fileKey);
		if (queued) {
			queued.start = options.start;
			return { promise: queued.promise, coalesced: true };
		}
		let resolve!: QueuedRun["resolve"];
		let reject!: QueuedRun["reject"];
		const promise = new Promise<RunnerResult>((res, rej) => {
			resolve = res;
			reject = rej;
		});
		flight.queued.set(fileKey, {
			start: options.start,
			promise,
			resolve,
			reject,
		});
		return { promise, coalesced: true };
	}
	const started: Flight = { queued: new Map() };
	flights.set(flightKey, started);
	const promise = options.start();
	void drainQueue(flightKey, started, promise);
	return { promise, coalesced: false };
}

/**
 * Run the queue after each settle (success, failure, timeout or abort alike),
 * then release the key. A reset that dropped this flight stops it: its queue
 * was settled by the reset and the key may belong to a new session's flight.
 */
async function drainQueue(
	flightKey: string,
	flight: Flight,
	running: Promise<RunnerResult>,
): Promise<void> {
	let current: Promise<unknown> = running;
	for (;;) {
		await current.catch(() => undefined);
		if (flights.get(flightKey) !== flight) return;
		const next = flight.queued.entries().next();
		if (next.done) {
			flights.delete(flightKey);
			return;
		}
		const [fileKey, queued] = next.value;
		flight.queued.delete(fileKey);
		current = queued.start().then(queued.resolve, queued.reject);
	}
}

/** Session boundary reset. */
export function resetObservedRunnerLatency(): void {
	slowRunners.clear();
	// #5413: a retired session's queued reruns never start. Their store entries
	// are cleared at the same session_start; settle them so nothing waits.
	for (const flight of flights.values())
		for (const queued of flight.queued.values())
			queued.resolve(DROPPED_BY_RESET);
	flights.clear();
}
