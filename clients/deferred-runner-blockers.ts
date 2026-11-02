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

import * as fs from "node:fs";
import { resolve } from "node:path";
import { gateFindingsByPathFreshness } from "./advisory-provenance.js";
import { hashContentBytes } from "./content-stamp.js";
import {
	peekSettledRunnerFindings,
	type PendingRunnerFindings,
} from "./dispatch/pending-runner-findings.js";
import { applyPushedFindingPolicy } from "./dispatch/finding-policy.js";
import { laneCopyStandsFor } from "./dispatch/lane-copies.js";
import { type Diagnostic, reachedNoVerdict } from "./dispatch/types.js";
import { stampLineHashes } from "./line-alignment.js";
import { logLatency } from "./latency-logger.js";
import type { RuntimeCoordinator } from "./runtime-coordinator.js";

/** Runner ids one bounded row names; the counts stay exact. */
const MAX_LOGGED_RUNNER_IDS = 5;

export interface DeferredBlockerRecording {
	/** Findings new to the blocker map (0 = nothing blocking, or a replay). */
	recorded: number;
	/** #4484 r2: recorded blockers a settled run of their runner retired. */
	retired: number;
	/** #4484 r2: the files those retired blockers were recorded on. */
	retiredFiles: string[];
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
	// #4130: the run's fault reaches the agent once, as turn end's failure note.
	const findings = (pending.result?.diagnostics ?? []).flatMap((d) =>
		d.runnerFault === true ? [] : [d],
	);
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
	// #4484 r2: stamped with the runner, as the dispatcher stamps its own, so
	// the next write carries the blocker while this runner is in flight again.
	// Round 5: and with its line's text in the settled bytes, as the pipeline
	// stamps its record (`stampLineHashes`).
	const blocking = stampLineHashes(
		withoutLaneCopies(runtime, pending, survivors).flatMap((d) =>
			d.semantic === "blocking"
				? [{ ...d, runnerId: d.runnerId ?? pending.runnerId }]
				: [],
		),
		bytes?.toString("utf-8"),
		(d) => !d.filePath || resolve(d.filePath) === resolve(pending.filePath),
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
							sha256: hashContentBytes(bytes),
						},
					}
				: {}),
		},
		// #4943: the producing write's session, stamped by the dispatch.
		pending.sessionId,
	);
	// Same recompute every recording seam does: the latch re-derives from the map.
	if (recorded > 0) runtime.updateGitGuardStatus(false, "");
	return recorded;
}

/**
 * #4484 round 2: retire the blockers a settled run of their own runner no
 * longer observes. `kept` is the run's policy survivors from
 * {@link judgeDeferredRunnerFindings}. A run that reached no verdict retires
 * nothing. The coordinator requires the run to be about the recorded bytes
 * (read time and content hash), which also refuses an answer about older
 * bytes.
 *
 * @returns how many recorded blockers the run retired.
 */
export function retireSettledRunnerBlockers(
	runtime: RuntimeCoordinator,
	pending: PendingRunnerFindings,
	verdict: Pick<DeferredRunnerVerdict, "kept">,
): number {
	const result = pending.result;
	// #4484 round 7: a settled skip that defers to a covering lane retires
	// nothing. That lane's answer for these bytes is not known here, and its
	// evidence may cover only the edit; the next inline write judges.
	// #4509: a covered run read the bytes itself, so it retires as any run.
	if (
		!result ||
		reachedNoVerdict(result) ||
		(result.coveredBy !== undefined &&
			result.skipReason === "covered-by-primary")
	)
		return 0;
	const bytes = readBytes(pending.filePath);
	const retired = runtime.retireUnobservedRunnerBlockers(pending.filePath, {
		runnerId: pending.runnerId,
		// #4484 round 3: what the run's edit-range gate withheld is still
		// observed, at its own line.
		observed: [
			...withoutLaneCopies(runtime, pending, verdict.kept),
			...(result.outOfEditScope ?? []),
		].flatMap((d) => (d.semantic === "blocking" ? [d] : [])),
		markedAtMs: pending.markedAtMs,
		sha256: bytes ? hashContentBytes(bytes) : undefined,
		...(result.unconfirmedServerIds !== undefined && {
			unconfirmedServerIds: result.unconfirmedServerIds,
		}),
	});
	if (retired > 0) runtime.updateGitGuardStatus(false, "");
	return retired;
}

/**
 * #4529 review R3: a settled covered run's findings, less those its lane's
 * recorded copies stand for (`laneCopyStandsFor`), as the dispatcher drops
 * them from a run it waited for. Such a finding is neither recorded nor
 * observed, so the run's own entry for it retires and the lane's copy stands.
 */
function withoutLaneCopies(
	runtime: RuntimeCoordinator,
	pending: PendingRunnerFindings,
	findings: readonly Diagnostic[],
): readonly Diagnostic[] {
	const lane = pending.result?.coveredBy;
	if (lane === undefined) return findings;
	const standsFor = laneCopyStandsFor(
		(runtime.getInlineBlockerDiagnostics(pending.filePath) ?? []).flatMap((d) =>
			d.runnerId === lane.runnerId &&
			(lane.serverId === undefined || d.serverId === lane.serverId)
				? [d]
				: [],
		),
	);
	return findings.flatMap((d) => (standsFor(d) ? [] : [d]));
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
		retired: 0,
		retiredFiles: [],
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
		const retired = retireSettledRunnerBlockers(runtime, pending, verdict);
		if (recorded === 0 && retired === 0) continue;
		total.recorded += recorded;
		total.retired += retired;
		if (retired > 0 && !total.retiredFiles.includes(pending.filePath)) {
			total.retiredFiles.push(pending.filePath);
		}
		files.add(pending.filePath);
		if (
			!total.runnerIds.includes(pending.runnerId) &&
			total.runnerIds.length < MAX_LOGGED_RUNNER_IDS
		) {
			total.runnerIds.push(pending.runnerId);
		}
	}
	total.fileCount = files.size;
	if (total.recorded > 0 || total.retired > 0) {
		// One row per gate consult that recorded or retired something; a repeat
		// consult finds every finding recorded and nothing left to retire.
		logLatency({
			type: "phase",
			toolName: "git-guard",
			filePath: cwd,
			phase: "deferred_runner_blockers",
			durationMs: 0,
			metadata: {
				site: "commit_gate",
				recorded: total.recorded,
				retired: total.retired,
				runnerIds: total.runnerIds,
				fileCount: total.fileCount,
			},
		});
	}
	return total;
}
