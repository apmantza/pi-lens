/** Observed-latency classification shared by dispatch and LSP tier seams. */

import { normalizeMapKey } from "../path-utils.js";
import type { DispatchContext, RunnerResult } from "./types.js";

export type CollectLaterTier = "inline" | "collect-later";

/** A runner gets this much time before the next run moves off the write path. */
export const COLLECT_LATER_THRESHOLD_MS = 5_000;

interface ObservedRunner {
	projectRoot: string;
	runnerId: string;
}

const slowRunners = new Map<string, ObservedRunner>();

export function runnerFlightKey(projectRoot: string, runnerId: string): string {
	return `${normalizeMapKey(projectRoot)}\u0000${runnerId}`;
}

/**
 * Read the observed tier. A run in flight also defers every dispatch but the
 * one whose inline run claimed it: a runner listed in two of one write's groups
 * (ruby's rubocop) runs inline in both (#5547 F7).
 */
export function classifyObservedRunner(
	projectRoot: string,
	runnerId: string,
	dispatch?: DispatchContext,
): CollectLaterTier {
	const runnerKey = runnerFlightKey(projectRoot, runnerId);
	const flight = flights.get(runnerKey);
	return slowRunners.has(runnerKey) ||
		(flight !== undefined &&
			(flight.owner === undefined || flight.owner !== dispatch))
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
	const runnerKey = runnerFlightKey(normalizedProjectRoot, options.runnerId);
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

/** One file's rerun, owed once the runs queued before it settle. */
interface QueuedRun {
	/** The latest write's run; a later write to the file replaces it. */
	start: () => Promise<RunnerResult>;
	promise: Promise<RunnerResult>;
}

/** The runs of one (project, runner): the last one chained, and the queue. */
interface Flight {
	tail: Promise<unknown>;
	queued: Map<string, QueuedRun>;
	/** The dispatch whose inline run claimed the key; none for collect-later. */
	owner: DispatchContext | undefined;
}

/**
 * #5413/#5547: the run in flight per key, including the first inline run. A
 * slow runner started a run on every write (three writes, three runs at once,
 * each holding a child). One entry per key: a key exists only while a run is
 * in flight or queued, its queue holds one slot per file written meanwhile,
 * and a session reset clears it with `slowRunners`.
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
 * for its file, chained after every run before it, which reads the file's
 * bytes as they are when it starts; a later write to the same file before
 * that replaces the queued `start` and shares its answer. It never joins the
 * running run, whose answer is for older bytes and which the turn-end
 * freshness gate drops as stale (shape 70). Queued files run one at a time.
 */
export function runCollectLater(options: {
	projectRoot: string;
	runnerId: string;
	filePath: string;
	start: () => Promise<RunnerResult>;
}): { promise: Promise<RunnerResult>; coalesced: boolean } {
	const flightKey = runnerFlightKey(options.projectRoot, options.runnerId);
	const flight = flights.get(flightKey);
	if (flight) {
		const fileKey = normalizeMapKey(options.filePath);
		const queued = flight.queued.get(fileKey);
		if (queued) {
			queued.start = options.start;
			return { promise: queued.promise, coalesced: true };
		}
		// Each run waits for the one before it to settle, whatever its outcome;
		// the earlier run's own caller observes its rejection.
		const slot: QueuedRun = {
			start: options.start,
			promise: Promise.allSettled([flight.tail]).then(() =>
				startQueued(flightKey, flight, fileKey, slot),
			),
		};
		flight.queued.set(fileKey, slot);
		chain(flightKey, flight, slot.promise);
		return { promise: slot.promise, coalesced: true };
	}
	const promise = options.start();
	holdFlight(flightKey, promise);
	return { promise, coalesced: false };
}

/**
 * Hold the key until `promise` settles, independently of caller budgets. A key
 * already held (its claiming dispatch's second group) is held until both
 * settle; replacing its flight would drop the reruns queued on it (#5547 F7).
 */
export function holdFlight(
	flightKey: string,
	promise: Promise<unknown>,
	owner?: DispatchContext,
): void {
	const held = flights.get(flightKey);
	if (held) {
		chain(flightKey, held, Promise.allSettled([held.tail, promise]));
		return;
	}
	const started: Flight = { tail: promise, queued: new Map(), owner };
	flights.set(flightKey, started);
	chain(flightKey, started, promise);
}

/** Whether a key is held by a live or queued run. */
export function isFlightHeld(flightKey: string): boolean {
	return flights.has(flightKey);
}

/**
 * A queued rerun's turn. A reset that dropped this flight answers it skipped
 * without starting it: its store entry was cleared at the same session_start,
 * and the key may belong to a new session's flight.
 */
function startQueued(
	flightKey: string,
	flight: Flight,
	fileKey: string,
	slot: QueuedRun,
): Promise<RunnerResult> | RunnerResult {
	if (flights.get(flightKey) !== flight) return DROPPED_BY_RESET;
	flight.queued.delete(fileKey);
	return slot.start();
}

/** Make `run` the flight's tail; release the key when the tail settles. */
function chain(flightKey: string, flight: Flight, run: Promise<unknown>): void {
	flight.tail = run;
	void Promise.allSettled([run]).then(() => {
		if (flight.tail === run && flights.get(flightKey) === flight)
			flights.delete(flightKey);
	});
}

/** Session boundary reset. */
export function resetObservedRunnerLatency(): void {
	slowRunners.clear();
	// #5413: a retired session's queued reruns never start (`startQueued`),
	// and a new session's first write does not wait behind its run.
	flights.clear();
}
