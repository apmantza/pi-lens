/**
 * Head run health (#2184): classify what GitHub Actions actually did with a
 * PR's current head commit.
 *
 * The 2026-08-26 Actions degradation stalled the merge train for hours behind
 * two signatures that every existing gate read as "pending forever":
 *
 * - STARVED RUN: the run concludes `failure`/`startup_failure` while no job
 *   ever executed a step. Verified against the real incident run 32986328966
 *   (`.github/workflows/ci.yml`, conclusion `failure`, `run_attempt` 1): six
 *   jobs sat at `status: "queued"` with `steps: []`, and one matrix job read
 *   `status: "completed", conclusion: "skipped"` with `steps: []`. So "every
 *   job is queued" is NOT the signature — a skipped matrix job breaks it. The
 *   discriminating fact is ZERO EXECUTED STEPS across every job of a run that
 *   nonetheless concluded failed. A genuine test failure always has steps.
 *
 * - ABSENT RUN: no run for a tracked workflow exists on the head at all,
 *   minutes after the commit. GitHub dropped the `pull_request` dispatch.
 *
 * - STALLED RUN (#2203): the run EXISTS and never leaves `queued`. Nothing in
 *   the two signatures above bounds how long a non-`completed` run may sit,
 *   so a head with a zombie run classified `runs-in-progress` on every cycle
 *   forever, which reads as healthy waiting. The discriminator is again ZERO
 *   EXECUTED STEPS: a long matrix job is genuinely in progress no matter how
 *   old it is, but a run that has executed nothing after an hour was never
 *   picked up by a runner.
 *
 * Both are shape 11 in AGENTS.md wearing a new coat: an absent or starved
 * required check is not a passing one. The classifier therefore also emits
 * PENDING and UNKNOWN rather than collapsing "nothing yet" and "we could not
 * read it" into a verdict (shape 10: an empty result must distinguish clean
 * from unavailable).
 */

const TRACKED_WORKFLOW_PATHS = [
	".github/workflows/ci.yml",
	".github/workflows/lint.yml",
];

// A dispatch that has not appeared within this window is dropped, not slow.
// GitHub queues a `pull_request` run within seconds when the webhook lands;
// the warden's own cadence is 10 minutes, so 12 minutes means "at least one
// full warden cycle has already passed with nothing to see".
const ABSENT_RUN_GRACE_MINUTES = 12;

// Only a run that is BOTH completed and failed can be starved. `cancelled`
// is excluded on purpose: a human cancelling a run also produces zero
// executed steps, and re-running it would fight the person who cancelled it.
const STARVED_RUN_CONCLUSIONS = new Set(["failure", "startup_failure"]);

// #2203, AC2: measured, not guessed. Over the 60 most recent COMPLETED
// `ci.yml` runs (read 2026-08-26 from `actions/workflows/ci.yml/runs`), wall
// time from `run_started_at` to `updated_at` was median 9 minutes, p95 14,
// max 17. This threshold applies only to a run that has executed ZERO steps,
// so the yardstick is queue delay rather than workflow duration, and GitHub
// normally queues a `pull_request` run onto a runner within seconds. 60
// minutes is over three times the whole workflow's worst case, and six
// warden cycles, so an ordinary backlog gets six chances to clear before the
// warden escalates.
export const STALLED_RUN_MINUTES = 60;

export const RUN_HEALTH = {
	NORMAL: "runs-concluded-normally",
	STARVED: "starved-run",
	STALLED: "stalled-run",
	ABSENT: "absent-run",
	PENDING: "runs-in-progress",
	UNKNOWN: "run-health-unknown",
};

/**
 * Steps GitHub actually executed for a run. A step is executed once it
 * carries a conclusion; a queued job reports `steps: []`, and a job that
 * GitHub created but never started reports steps with a null conclusion.
 */
export function countExecutedSteps(jobs) {
	if (!Array.isArray(jobs)) return 0;
	let executed = 0;
	for (const job of jobs) {
		for (const step of job?.steps ?? []) {
			if (step?.conclusion != null) executed += 1;
		}
	}
	return executed;
}

/**
 * The starved-run predicate. `run.jobs` must be a KNOWN array: a null jobs
 * list means the jobs read failed, and "we could not look" is not evidence
 * of starvation (that path classifies UNKNOWN instead).
 */
export function isStarvedRun(run) {
	if (!run || run.status !== "completed") return false;
	if (!STARVED_RUN_CONCLUSIONS.has(run.conclusion)) return false;
	if (!Array.isArray(run.jobs)) return false;
	return countExecutedSteps(run.jobs) === 0;
}

/** Minutes since GitHub created this run, or null when the date is unreadable. */
function runAgeMinutes(run, now) {
	const createdMs = Date.parse(run?.createdAt ?? "");
	return Number.isNaN(createdMs) ? null : (now - createdMs) / 60000;
}

/**
 * The stalled-run predicate (#2203). Three conditions, each load-bearing:
 *
 * - the run has NOT completed, so this never re-judges a concluded run;
 * - its jobs are a KNOWN array with ZERO executed steps, so a genuinely
 *   running job is never cancelled out from under itself, however long it
 *   runs, and an unreadable jobs list stays UNKNOWN rather than becoming
 *   evidence (shape 10);
 * - it has been that way for at least `thresholdMinutes`.
 */
export function isStalledRun(run, now, thresholdMinutes = STALLED_RUN_MINUTES) {
	if (!run || run.status === "completed") return false;
	if (!Array.isArray(run.jobs)) return false;
	if (countExecutedSteps(run.jobs) > 0) return false;
	const age = runAgeMinutes(run, now);
	return age !== null && age >= thresholdMinutes;
}

/**
 * The second rung of the stalled ladder: a run the warden cancelled is now
 * `completed`/`cancelled` with zero executed steps. It is still not a passing
 * check and still resolves on its own never, so it keeps the STALLED
 * classification. Only the ACTION differs, and the caller gates that on the
 * warden's own per-run comment marker: without the marker this is a human's
 * cancellation and the warden must not fight it.
 */
export function isCancelledStalledRun(run) {
	if (!run || run.status !== "completed") return false;
	if (run.conclusion !== "cancelled") return false;
	if (!Array.isArray(run.jobs)) return false;
	return countExecutedSteps(run.jobs) === 0;
}

/**
 * GitHub returns every run for a head, including superseded ones: the
 * incident head 8e32f127 carried two `lint.yml` runs, an earlier success and
 * a later starved failure. Only the newest run per workflow describes the
 * head's current state.
 */
function latestRunPerWorkflowPath(runs) {
	const latest = new Map();
	for (const run of runs ?? []) {
		if (!run?.path) continue;
		const current = latest.get(run.path);
		if (!current || runIsNewer(run, current)) latest.set(run.path, run);
	}
	return latest;
}

function runIsNewer(candidate, incumbent) {
	const a = Date.parse(candidate.createdAt ?? "");
	const b = Date.parse(incumbent.createdAt ?? "");
	if (Number.isNaN(a) || Number.isNaN(b))
		return Number(candidate.id) > Number(incumbent.id);
	if (a !== b) return a > b;
	return Number(candidate.id) > Number(incumbent.id);
}

/**
 * Classify one head. Pure: the caller supplies the runs (each already
 * carrying its jobs, or `jobs: null` when the jobs read failed), the head's
 * commit date, and the clock.
 *
 * Precedence is STARVED > STALLED > ABSENT > UNKNOWN > PENDING > NORMAL,
 * because it orders by how actionable the finding is: a starved run has a
 * rerun lever, a stalled run has a cancel-then-rerun lever, an absent run has
 * a push lever a bot cannot pull, and the rest are waits. The returned record
 * carries EVERY populated bucket, so one head can both rerun a starved
 * `ci.yml` and be told its `lint.yml` never dispatched.
 */
export function classifyHeadRun({
	runs,
	headCommittedDate,
	now,
	graceMinutes = ABSENT_RUN_GRACE_MINUTES,
	stalledMinutes = STALLED_RUN_MINUTES,
	trackedPaths = TRACKED_WORKFLOW_PATHS,
}) {
	const latest = latestRunPerWorkflowPath(runs);
	const starvedRuns = [];
	const stalledRuns = [];
	const cancelledStalledRuns = [];
	const absentWorkflows = [];
	const unknownWorkflows = [];
	const pendingWorkflows = [];
	const committedMs = Date.parse(headCommittedDate ?? "");
	const ageMinutes = Number.isNaN(committedMs)
		? null
		: (now - committedMs) / 60000;

	for (const path of trackedPaths) {
		const run = latest.get(path);
		if (!run) {
			// Absence is only meaningful once the grace window has passed AND we
			// know how old the head is. An unparseable commit date is missing
			// information, not a dropped dispatch.
			if (ageMinutes === null) unknownWorkflows.push(path);
			else if (ageMinutes >= graceMinutes) absentWorkflows.push(path);
			else pendingWorkflows.push(path);
			continue;
		}
		if (run.status !== "completed") {
			// #2203: an in-flight run needs an age dimension. Only a run past the
			// threshold is even a candidate, and only one that has executed nothing.
			const runAge = runAgeMinutes(run, now);
			if (runAge === null || runAge < stalledMinutes) {
				pendingWorkflows.push(path);
				continue;
			}
			if (!Array.isArray(run.jobs)) {
				// Aged, but we could not read its jobs, so "stuck" and "working" are
				// indistinguishable. Say so rather than cancel a live run.
				unknownWorkflows.push(path);
				continue;
			}
			if (isStalledRun(run, now, stalledMinutes))
				stalledRuns.push({ ...run, stalledForMinutes: runAge });
			else pendingWorkflows.push(path);
			continue;
		}
		if (isCancelledStalledRun(run)) {
			cancelledStalledRuns.push(run);
			continue;
		}
		if (!Array.isArray(run.jobs)) {
			// A failed run whose jobs we could not read is exactly the case where
			// starved and genuinely-red are indistinguishable. Say so.
			if (STARVED_RUN_CONCLUSIONS.has(run.conclusion))
				unknownWorkflows.push(path);
			continue;
		}
		if (isStarvedRun(run)) starvedRuns.push(run);
	}

	let classification = RUN_HEALTH.NORMAL;
	if (starvedRuns.length > 0) classification = RUN_HEALTH.STARVED;
	else if (stalledRuns.length > 0 || cancelledStalledRuns.length > 0)
		classification = RUN_HEALTH.STALLED;
	else if (absentWorkflows.length > 0) classification = RUN_HEALTH.ABSENT;
	else if (unknownWorkflows.length > 0) classification = RUN_HEALTH.UNKNOWN;
	else if (pendingWorkflows.length > 0) classification = RUN_HEALTH.PENDING;

	return {
		classification,
		starvedRuns,
		stalledRuns,
		cancelledStalledRuns,
		absentWorkflows,
		unknownWorkflows,
		pendingWorkflows,
		ageMinutes,
	};
}

function normalizeRun(run) {
	return {
		id: run.id,
		path: run.path,
		name: run.name,
		status: run.status,
		conclusion: run.conclusion,
		runAttempt: run.run_attempt,
		url: run.html_url,
		createdAt: run.created_at,
		jobs: null,
	};
}

/**
 * Which runs need a jobs read? Only the anomalous minority, so the healthy
 * sweep still costs one runs call per head and nothing else:
 *
 * - a run that concluded failure/startup_failure (starved candidate, #2184);
 * - a run that concluded cancelled with the warden's ladder possibly behind
 *   it (#2203);
 * - a run still in flight PAST the stalled threshold. A run younger than the
 *   threshold cannot be stalled, so it is never read: every ordinary in-flight
 *   run on an open PR is younger than an hour.
 */
function needsJobsRead(run, now) {
	if (run.status !== "completed") {
		const age = runAgeMinutes(run, now);
		return age !== null && age >= STALLED_RUN_MINUTES;
	}
	if (run.conclusion === "cancelled") return true;
	return STARVED_RUN_CONCLUSIONS.has(run.conclusion);
}

/**
 * Read the head's runs, then the jobs of any run that concluded failed.
 * Bounded by construction: one runs call per PR head, plus one jobs call per
 * anomalous tracked run (see `needsJobsRead`), never per healthy run.
 *
 * Never throws: every failure is recorded and leaves the affected run's
 * `jobs` at null, which the classifier reads as UNKNOWN rather than as
 * evidence of anything.
 */
export async function fetchHeadRunHealth(
	fetcher,
	owner,
	repo,
	headSha,
	headCommittedDate,
	now,
) {
	const errors = [];
	if (!headSha) {
		return {
			health: {
				classification: RUN_HEALTH.UNKNOWN,
				starvedRuns: [],
				stalledRuns: [],
				cancelledStalledRuns: [],
				absentWorkflows: [],
				unknownWorkflows: [...TRACKED_WORKFLOW_PATHS],
				pendingWorkflows: [],
				ageMinutes: null,
			},
			errors: ["head SHA unavailable; run health not readable"],
		};
	}
	const base = `https://api.github.com/repos/${owner}/${repo}`;
	let runs = [];
	try {
		const response = await fetcher(
			`${base}/actions/runs?head_sha=${encodeURIComponent(headSha)}&per_page=50`,
			{ headers: { accept: "application/vnd.github+json" } },
		);
		if (!response.ok) {
			errors.push(`runs read for ${headSha} -> HTTP ${response.status}`);
		} else {
			const payload = await response.json();
			const list = payload?.workflow_runs;
			if (!Array.isArray(list))
				errors.push(`runs read for ${headSha} returned no workflow_runs array`);
			else runs = list.map(normalizeRun);
		}
	} catch (error) {
		errors.push(
			`runs read for ${headSha} -> ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	// An errored runs read must not masquerade as "no runs exist" (shape 10),
	// which would classify a readable-but-unreachable head as ABSENT and post a
	// loud dropped-dispatch comment on every open PR during an API outage.
	if (errors.length > 0) {
		return {
			health: {
				classification: RUN_HEALTH.UNKNOWN,
				starvedRuns: [],
				stalledRuns: [],
				cancelledStalledRuns: [],
				absentWorkflows: [],
				unknownWorkflows: [...TRACKED_WORKFLOW_PATHS],
				pendingWorkflows: [],
				ageMinutes: null,
			},
			errors,
		};
	}

	for (const run of runs) {
		if (!TRACKED_WORKFLOW_PATHS.includes(run.path)) continue;
		if (!needsJobsRead(run, now)) continue;
		try {
			const response = await fetcher(
				`${base}/actions/runs/${run.id}/jobs?per_page=100`,
				{ headers: { accept: "application/vnd.github+json" } },
			);
			if (!response.ok) {
				errors.push(`jobs read for run ${run.id} -> HTTP ${response.status}`);
				continue;
			}
			const payload = await response.json();
			run.jobs = Array.isArray(payload?.jobs) ? payload.jobs : null;
			if (run.jobs === null)
				errors.push(`jobs read for run ${run.id} returned no jobs array`);
		} catch (error) {
			errors.push(
				`jobs read for run ${run.id} -> ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	return {
		health: classifyHeadRun({ runs, headCommittedDate, now }),
		errors,
	};
}

/** Per-head dedupe key for the absent-run comment. */
export function absentRunCommentMarker(headSha) {
	return `<!-- warden:absent-run:${headSha} -->`;
}

function absentRunCommentBody(headSha, workflows, ageMinutes) {
	const age =
		ageMinutes === null
			? "an unknown time"
			: `${Math.round(ageMinutes)} minutes`;
	return [
		"**Merge-train warden: GitHub never dispatched CI for this head.**",
		"",
		`No run exists for ${workflows.map((w) => `\`${w}\``).join(" or ")} on \`${headSha}\`, ${age} after the head commit. The \`pull_request\` dispatch was dropped.`,
		"",
		"The required checks here are ABSENT, not passing. Nothing may read this PR as green until a run exists and concludes.",
		"",
		"The warden cannot push, so it cannot recover this itself. Re-dispatch with an empty commit on the branch, or close and reopen the PR.",
		"",
		absentRunCommentMarker(headSha),
	].join("\n");
}

/**
 * The stalled-run ladder (#2203). Three rungs, each gated on state GitHub
 * itself reports, so the warden keeps no ledger of its own:
 *
 * 1. NO MARKER YET -> post the loud comment naming the stuck run. Nothing is
 *    cancelled in this cycle: the marker has to exist FIRST, because it is
 *    what tells the next cycle that the cancellation was the warden's.
 * 2. MARKER, RUN STILL QUEUED -> cancel it. A cancel is idempotent by
 *    construction: it moves the run out of the non-completed state, so the
 *    run can never be selected for a second cancel.
 * 3. MARKER, RUN CANCELLED WITH ZERO STEPS -> re-run it once. `rerun` is the
 *    lever a starved run gets, bounded by the same GitHub-owned counter,
 *    `run_attempt`. It is applied here rather than at rung 2 because GitHub
 *    refuses `rerun` on a run that has not completed.
 *
 * A cancelled zero-step run with NO marker is a person's cancellation. The
 * warden leaves it alone: it stays STALLED, so nothing reads it as green, but
 * no lever fires against the human who pulled it.
 */
function decideStalledRunActions(pr, health, stalledRunMarkers) {
	const stalled = health.stalledRuns ?? [];
	const cancelled = health.cancelledStalledRuns ?? [];
	if (stalled.length === 0 && cancelled.length === 0) return [];
	// Fail CLOSED on an unreadable comment list: without the markers the
	// warden cannot tell its own cancellation from a person's, and guessing
	// either way is worse than waiting one cycle.
	if (!(stalledRunMarkers instanceof Set))
		return [
			{
				type: "note",
				benign: true,
				message: `PR #${pr.number}: stalled runs found but the comment markers were unreadable; no stalled-run action this cycle`,
			},
		];

	const actions = [];
	const attemptSpent = (run) =>
		(run.runAttempt ?? 1) > 1
			? {
					type: "note",
					benign: false,
					message: `PR #${pr.number}: ${run.path} run ${run.id} is STALLED again on attempt ${run.runAttempt}; the warden already recovered it once for this head`,
				}
			: null;

	for (const run of stalled) {
		if (!stalledRunMarkers.has(stalledRunCommentMarker(run.id))) {
			actions.push({
				type: "comment",
				body: stalledRunCommentBody(run, run.stalledForMinutes ?? null),
			});
			continue;
		}
		const spent = attemptSpent(run);
		if (spent) {
			actions.push(spent);
			continue;
		}
		actions.push({
			type: "cancel-run",
			runId: run.id,
			workflowPath: run.path,
		});
	}

	for (const run of cancelled) {
		if (!stalledRunMarkers.has(stalledRunCommentMarker(run.id))) continue;
		const spent = attemptSpent(run);
		if (spent) {
			actions.push(spent);
			continue;
		}
		actions.push({
			type: "rerun-run",
			runId: run.id,
			workflowPath: run.path,
		});
	}
	return actions;
}

/**
 * Per-RUN dedupe key for the stalled-run escalation (#2203). Per-run, not
 * per-head, because the ladder needs it for two jobs at once: it deduplicates
 * the loud comment, and it is the only GitHub-owned evidence that the
 * cancellation of this run was the warden's and not a person's. A per-head
 * key could not distinguish two stuck runs on the same head.
 */
export function stalledRunCommentMarker(runId) {
	return `<!-- warden:stalled-run:${runId} -->`;
}

function stalledRunCommentBody(run, minutes) {
	const age = minutes === null ? "an unknown time" : `${Math.round(minutes)}`;
	return [
		"**Merge-train warden: this run has been queued for hours and has executed nothing.**",
		"",
		`\`${run.path}\` run [${run.id}](${run.url}) is \`${run.status}\` ${age} minutes after GitHub created it, with zero executed steps across every job. GitHub queued it and never scheduled it.`,
		"",
		`A run that never concludes is not a run that is fine. The required checks on this head are UNRESOLVED, not passing, so nothing may read this PR as green.`,
		"",
		"The warden cancels this run on its next cycle, then re-runs it once. If the re-run stalls too, the warden stops and marks its own run red.",
		"",
		stalledRunCommentMarker(run.id),
	].join("\n");
}

/**
 * Decide the recovery actions for one head's run health. Pure, like
 * `decideActions`: the caller resolves whether the absent-run comment already
 * exists and hands in the boolean.
 *
 * Rerun idempotence uses GitHub's OWN per-head counter, `run_attempt`, rather
 * than a hand-maintained ledger the warden would have to keep in sync. A run
 * the warden has already re-run reports attempt 2, so the rerun branch cannot
 * fire twice for the same run — and a run that is STILL starved on attempt 2
 * is a real outage, recorded as a non-benign error so the warden's own run
 * goes red and the stall is visible within one cycle.
 */
export function decideRunHealthActions(
	pr,
	health,
	{ absentCommentExists, stalledRunMarkers } = {},
) {
	const actions = [];
	actions.push(...decideStalledRunActions(pr, health, stalledRunMarkers));
	for (const run of health.starvedRuns ?? []) {
		if ((run.runAttempt ?? 1) > 1) {
			actions.push({
				type: "note",
				benign: false,
				message: `PR #${pr.number}: ${run.path} run ${run.id} is STARVED again on attempt ${run.runAttempt}; a rerun (warden or infra-kill classifier) already fired once for this head`,
			});
			continue;
		}
		actions.push({
			type: "rerun-run",
			runId: run.id,
			workflowPath: run.path,
		});
	}
	if ((health.absentWorkflows ?? []).length > 0) {
		if (absentCommentExists) {
			actions.push({
				type: "note",
				benign: true,
				message: `PR #${pr.number}: dispatch still absent for ${health.absentWorkflows.join(", ")}; comment already posted for head ${pr.headSha}`,
			});
		} else {
			actions.push({
				type: "comment",
				body: absentRunCommentBody(
					pr.headSha,
					health.absentWorkflows,
					health.ageMinutes,
				),
			});
		}
	}
	return actions;
}
