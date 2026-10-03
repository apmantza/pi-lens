/**
 * Collect-later runner BLOCKING findings, delivered to the commit gate (#3814).
 *
 * A runner slower than `COLLECT_LATER_THRESHOLD_MS` is deferred off the write
 * path (`dispatcher.ts` -> `deferRunnerFindings`). Its answer reached the agent
 * only as the turn-end late-runner advisory (#3796/#3808) and never entered the
 * state `lens-guard` reads, so a type error a slow runner raised did not stop
 * `git commit` while the same error from a fast runner did.
 *
 * The blocker state the gate reads is `RuntimeCoordinator`'s inline-blocker map
 * (its latch, the turn-end replay, the retire/clear lifecycle). This module only
 * feeds that map from the deferred store; it adds no second store and no second
 * verdict:
 *
 * - {@link judgeDeferredRunnerFindings} is the one freshness-then-policy verdict
 *   on a settled answer. The turn-end late-runner lane (`runtime-turn.ts`) and
 *   the commit gate both call it; an answer is current by the same two shared
 *   seams in the same order: `gateFindingsByPathFreshness` (a later edit makes
 *   it stale) and `applyPushedFindingPolicy` (inline ignore, stored
 *   disposition, rule policy);
 * - the lane runs BEFORE the blocker replay and records the blocking survivors
 *   through {@link recordDeferredRunnerBlockers}, so the replay delivers them as
 *   the one blocker section a finding gets (an advisory copy beside it was r1
 *   M2) and the composer persists them with the rest of the turn's blockers
 *   (r1 M3);
 * - the commit gate (`evaluateGitGuard`) asks {@link absorbSettledRunnerBlockers}
 *   first, because a commit in the turn after the edit sees an answer that has
 *   settled but no turn end has drained yet. It judges quietly: the lane owns
 *   the delivery records, so one answer writes one set (r1 L1).
 *
 * A run still in flight has answered nothing, so it does not gate: refusing every
 * commit while a 5 s+ runner runs would block the agent on nothing it can fix.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { gateFindingsByPathFreshness } from "./advisory-provenance.js";
import {
	peekSettledRunnerFindings,
	type PendingRunnerFindings,
} from "./dispatch/pending-runner-findings.js";
import { applyPushedFindingPolicy } from "./dispatch/finding-policy.js";
import type { Diagnostic } from "./dispatch/types.js";
import { logLatency } from "./latency-logger.js";
import type { RuntimeCoordinator } from "./runtime-coordinator.js";

/** Runner ids one bounded row names; the counts stay exact. */
const MAX_LOGGED_RUNNER_IDS = 5;

export interface DeferredBlockerRecording {
	/** Findings new to the blocker map (0 = nothing blocking, or a replay). */
	recorded: number;
	runnerIds: string[];
	fileCount: number;
}

export interface DeferredRunnerVerdict {
	/** Findings the freshness gate called stale: the answer is about older bytes. */
	stale: number;
	/** Findings the freshness gate called current. */
	live: number;
	/** Current findings that survived the finding policy: what the agent is shown. */
	kept: Diagnostic[];
	/** Current findings the finding policy dropped. */
	suppressed: number;
	/** The file's bytes the policy read; `undefined` when unreadable. */
	bytes: Buffer | undefined;
}

/**
 * The one verdict on a settled collect-later answer: freshness, then policy.
 * `quiet` skips the delivery records (see `gateFindingsByPathFreshness`); a
 * caller that only peeks passes it.
 */
export function judgeDeferredRunnerFindings(
	pending: PendingRunnerFindings,
	cwd: string,
	options: { quiet?: boolean } = {},
): DeferredRunnerVerdict {
	const findings = pending.result?.diagnostics ?? [];
	if (findings.length === 0) {
		return { stale: 0, live: 0, kept: [], suppressed: 0, bytes: undefined };
	}
	const { "late-runner-findings": gate } = gateFindingsByPathFreshness({
		cwd,
		sources: {
			"late-runner-findings": {
				findings,
				scannedAt: pending.markedAtMs,
				citedPath: (finding: Diagnostic) => finding.filePath,
			},
		},
		...(options.quiet === true ? { quiet: true } : {}),
	});
	if (gate.live.length === 0) {
		return {
			stale: gate.stale.length,
			live: 0,
			kept: [],
			suppressed: 0,
			bytes: undefined,
		};
	}
	const bytes = readBytes(pending.filePath);
	const { kept, suppressed } = applyPushedFindingPolicy(gate.live, {
		cwd,
		filePath: pending.filePath,
		content: bytes?.toString("utf-8"),
	});
	return {
		stale: gate.stale.length,
		live: gate.live.length,
		kept,
		suppressed,
		bytes,
	};
}

/**
 * Record the blocking findings of one settled deferred answer, after the caller
 * applied the freshness gate and the finding policy to it.
 *
 * `bytes` are the file's bytes the policy read: they become the record's
 * content baseline, which is true because the freshness gate just called the
 * answer current.
 */
export function recordDeferredRunnerBlockers(
	runtime: RuntimeCoordinator,
	pending: PendingRunnerFindings,
	survivors: readonly Diagnostic[],
	bytes: Buffer | undefined,
): number {
	const blocking = survivors.flatMap((d) =>
		d.semantic === "blocking" ? [d] : [],
	);
	if (blocking.length === 0) return 0;
	const recorded = runtime.recordDeferredInlineBlockers(
		pending.filePath,
		blocking,
		{
			recordedAtMs: pending.markedAtMs,
			...(bytes
				? {
						contentBaseline: {
							size: bytes.byteLength,
							sha256: createHash("sha256").update(bytes).digest("hex"),
						},
					}
				: {}),
		},
	);
	// Same recompute every recording seam does: the latch re-derives from the map.
	if (recorded > 0) runtime.updateGitGuardStatus(false, "");
	return recorded;
}

function readBytes(filePath: string): Buffer | undefined {
	try {
		return fs.readFileSync(filePath);
	} catch {
		return undefined;
	}
}

/**
 * Judge every settled deferred answer for the commit gate and record the
 * blocking survivors. Synchronous and non-draining: the turn-end drain still
 * delivers every answer, including the non-blocking ones. The store keeps no
 * per-entry state for this, so every attempt judges every settled answer again;
 * a replay records nothing (the recorder is idempotent) and, judging quietly,
 * writes no freshness record.
 */
export function absorbSettledRunnerBlockers(
	runtime: RuntimeCoordinator,
	cwd: string,
): DeferredBlockerRecording {
	const total: DeferredBlockerRecording = {
		recorded: 0,
		runnerIds: [],
		fileCount: 0,
	};
	const files = new Set<string>();
	for (const pending of peekSettledRunnerFindings()) {
		const verdict = judgeDeferredRunnerFindings(pending, cwd, { quiet: true });
		const recorded = recordDeferredRunnerBlockers(
			runtime,
			pending,
			verdict.kept,
			verdict.bytes,
		);
		if (recorded === 0) continue;
		total.recorded += recorded;
		files.add(pending.filePath);
		if (
			!total.runnerIds.includes(pending.runnerId) &&
			total.runnerIds.length < MAX_LOGGED_RUNNER_IDS
		) {
			total.runnerIds.push(pending.runnerId);
		}
	}
	total.fileCount = files.size;
	if (total.recorded > 0) {
		// One row per gate consult that recorded something new; a repeat consult
		// finds every finding recorded and writes nothing.
		logLatency({
			type: "phase",
			toolName: "git-guard",
			filePath: cwd,
			phase: "deferred_runner_blockers",
			durationMs: 0,
			metadata: {
				site: "commit_gate",
				recorded: total.recorded,
				runnerIds: total.runnerIds,
				fileCount: total.fileCount,
			},
		});
	}
	return total;
}
