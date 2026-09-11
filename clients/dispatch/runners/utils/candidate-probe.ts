/**
 * Shared PATH-candidate availability sweep (#1476 Sonar follow-up, S3776).
 *
 * `go-client.ts` and `rust-client.ts` resolve their toolchain the same way:
 * walk a platform candidate list, treat a candidate with a path separator as
 * an existence check, and probe a bare command with a version flag on a
 * fixed host-side budget, classifying any failure through the shared policy
 * so a host stall cannot be mistaken for "the tool is not installed". The
 * migration to `availability-policy.ts` wrote that sweep out twice, and the
 * duplication was also what pushed both call sites over the Cognitive
 * Complexity limit. This is that sweep, written once.
 */

import * as fs from "node:fs";
import { probeToolAsync } from "../../../tool-probe.js";
import {
	type AvailabilityCause,
	type ProbeEvidence,
	classifyProbeFailure,
	startHostStallSampler,
} from "./availability-policy.js";

export interface CandidateSweepResult {
	/** The candidate that answered, or `null` if none did. */
	foundPath: string | null;
	/** Whether any candidate in the sweep failed transiently. */
	sawTransient: boolean;
	/** The cause of the last transient failure seen, for the retry decision. */
	transientCause: AvailabilityCause;
	/** Total host event-loop stall observed across the sweep, ms. */
	hostStallMs: number;
	/**
	 * What the last classified candidate actually returned, named by `command`
	 * (#1500). Without it the caller's decision record says a toolchain is
	 * missing and nothing about which candidate reported what.
	 */
	evidence?: ProbeEvidence;
}

/**
 * Walk `candidates` in order. A candidate containing a path separator is
 * resolved with `fs.existsSync`; a bare command is probed by spawning it with
 * `probeArgs` on a `timeoutMs` host-side budget. Returns on the first
 * candidate that answers; a candidate that throws is skipped, matching the
 * original per-client sweeps.
 */
export async function probeAvailabilityCandidates(
	candidates: readonly string[],
	probeArgs: readonly string[],
	timeoutMs: number,
): Promise<CandidateSweepResult> {
	let sawTransient = false;
	let transientCause: AvailabilityCause = "probe-timeout";
	let hostStallMs = 0;
	let evidence: ProbeEvidence | undefined;

	for (const candidate of candidates) {
		try {
			if (candidate.includes("\\") || candidate.includes("/")) {
				if (fs.existsSync(candidate)) {
					return {
						foundPath: candidate,
						sawTransient,
						transientCause,
						hostStallMs,
						evidence,
					};
				}
				continue;
			}
			// Host-side budget: measure the loop stall that overlapped the probe so
			// the shared policy can tell "no toolchain" from "the host was busy".
			const sampler = startHostStallSampler();
			let result: Awaited<ReturnType<typeof probeToolAsync>>;
			let stallMs: number;
			try {
				result = await probeToolAsync(candidate, probeArgs, {
					timeout: timeoutMs,
				});
			} finally {
				stallMs = sampler.stop();
				hostStallMs += stallMs;
			}
			if (!result.error && result.status === 0) {
				return {
					foundPath: candidate,
					sawTransient,
					transientCause,
					hostStallMs,
					evidence,
				};
			}
			const classified = classifyProbeFailure(result, {
				hostStallMs: stallMs,
				command: candidate,
			});
			evidence = classified.evidence;
			if (classified.outcome === "transient") {
				sawTransient = true;
				transientCause = classified.cause;
			}
		} catch {
			// A candidate that throws is one this host does not have — the sweep's
			// normal case, not an error worth surfacing. The verdict comes from
			// whether any LATER candidate answers, and a genuine host problem
			// still reaches the caller as a transient through `classifyProbeFailure`
			// above rather than through a thrown spawn.
		}
	}

	return {
		foundPath: null,
		sawTransient,
		transientCause,
		hostStallMs,
		evidence,
	};
}
