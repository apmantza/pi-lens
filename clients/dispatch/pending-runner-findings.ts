/** Turn-end handoff for runners moved off the post-write critical path. */

import type { RunnerResult } from "./types.js";
import { incrementDegradationCount } from "../degradation-ledger.js";

export interface PendingRunnerFindings {
	filePath: string;
	cwd: string;
	projectRoot: string;
	runnerId: string;
	markedAtMs: number;
	writeIndex?: number;
	result?: RunnerResult;
}

interface PendingRunnerPromise extends Omit<PendingRunnerFindings, "result"> {
	promise: Promise<RunnerResult>;
	settled: boolean;
	result?: RunnerResult;
}

const pending: PendingRunnerPromise[] = [];
const MAX_PENDING_RUNNER_FINDINGS = 50;

export function deferRunnerFindings(
	entry: Omit<PendingRunnerFindings, "result"> & {
		promise: Promise<RunnerResult>;
	},
): void {
	const tracked: PendingRunnerPromise = { ...entry, settled: false };
	// Attach exactly once at ownership time. Re-attaching at every turn end
	// accumulates handlers on a promise that may never settle (#2122 F8).
	void tracked.promise.then(
		(result) => {
			tracked.result = result;
			tracked.settled = true;
		},
		(error: unknown) => {
			tracked.result = {
				status: "failed",
				diagnostics: [],
				semantic: "warning",
				failureKind: "exception",
				failureMessage: String(error).slice(0, 200),
			};
			tracked.settled = true;
		},
	);
	pending.push(tracked);
	if (pending.length > MAX_PENDING_RUNNER_FINDINGS) {
		const evicted = pending.shift();
		if (evicted) {
			incrementDegradationCount({
				kind: "runner-findings-evicted",
				subject: `${evicted.runnerId}:${evicted.filePath}`,
				reason: `pending runner cap ${MAX_PENDING_RUNNER_FINDINGS}`,
			});
		}
	}
}

/**
 * Resolve already-finished runner work for this turn. Unfinished work remains
 * owned by the store and is retried at the next turn boundary.
 */
export async function drainPendingRunnerFindings(
	maxWaitMs = 2_000,
): Promise<PendingRunnerFindings[]> {
	if (pending.length === 0) return [];
	const current = pending.splice(0, pending.length);
	const results: PendingRunnerFindings[] = [];
	// Give already-resolved promises one microtask turn without introducing a
	// wall-clock wait. This observes completed work while preserving the F5
	// zero-budget contract for in-flight runners.
	if (maxWaitMs === 0) await Promise.resolve();
	if (maxWaitMs > 0 && current.some((entry) => !entry.settled)) {
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, maxWaitMs);
			timer.unref?.();
		});
	}
	for (const entry of current) {
		if (entry.settled && entry.result) {
			results.push({
				filePath: entry.filePath,
				cwd: entry.cwd,
				projectRoot: entry.projectRoot,
				runnerId: entry.runnerId,
				markedAtMs: entry.markedAtMs,
				writeIndex: entry.writeIndex,
				result: entry.result,
			});
		} else {
			pending.push(entry);
		}
	}
	return results;
}

/** Drop a stale answer and record the lost re-run coverage. */
export function dropStaleRunnerFindings(entry: PendingRunnerFindings): void {
	if (!entry.result) return;
	incrementDegradationCount({
		kind: "runner-findings-stale",
		subject: `${entry.runnerId}:${entry.filePath}`,
		reason: "completed result was older than the latest file edit",
	});
}

export function resetPendingRunnerFindings(): void {
	pending.length = 0;
}

export function pendingRunnerFindingsSize(): number {
	return pending.length;
}
