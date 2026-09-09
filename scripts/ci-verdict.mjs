#!/usr/bin/env node
/**
 * scripts/ci-verdict.mjs (#2539): ONE REST read of EVERY check-run on an
 * EXACT head SHA, replacing the ad hoc `gh api` filters the fixer/reviewer
 * playbooks were hand-writing and the tail of `gh pr checks`, which hid a
 * failed Unit tests behind a passing Lint (#2527 review round 2 merge-
 * blocked on exactly that). Sibling to scripts/check-pr-body.mjs: a pure
 * verdict function over the check-runs JSON, exported for tests, and a thin
 * `gh` CLI shell around it -- no GITHUB_TOKEN/GITHUB_API_URL plumbing, just
 * `gh` on PATH (the issue's acceptance criterion).
 *
 * #2609: originally this script only ever looked at the fixed
 * `REQUIRED_CHECKS` pair (`Unit tests`, `Lint & type-check`), so a red
 * "Production install build" or "Install test" job on PR #2588's head
 * e32d814e never entered the computation at all -- exit 0, "both required
 * checks concluded success", while a real code defect (a widened peer range
 * containing spaces, word-split by `read -ra`) sat red. Every check-run
 * GitHub reports on the head is now a row, and every row GATES unless it is
 * on the advisory allowlist (`scripts/lib/ci-checks.mjs`'s
 * `isAdvisoryCheck` -- the SAME list #2185's real merge-train gate already
 * uses). `run()` also attempts a LIVE read of `master`'s branch-protection
 * required-status-check names via `gh api`, and treats those names as
 * gating unconditionally (never excusable by the static advisory allowlist)
 * when that read succeeds; when it does not (no permission, no ruleset,
 * transport error), the constant `REQUIRED_CHECKS` pair is the fallback --
 * either way, "every check-run not on the advisory allowlist gates" holds.
 *
 * #2618 fix-round-2: a gating row's conclusion is judged differently
 * depending on whether it is one of those confirmed-required names or
 * merely discovered. A REQUIRED row must reach a literal "success" --
 * ANYTHING else (skipped, neutral, cancelled, a real failure) is non-zero,
 * because a required check that skipped or was cancelled is stale or
 * interrupted evidence, never proof of a pass (round 1's bug: it exempted
 * skipped/neutral on EVERY gating row, so a required `Unit tests` skipped by
 * a failed `needs:` dependency read as a clean pass). A DISCOVERED row's
 * "skipped"/"neutral" conclusion is a genuine non-failure (a job-level
 * `if:` that evaluated false -- see computeVerdict's own doc comment), and
 * its "cancelled" conclusion is UNCERTAIN rather than failing: this repo's
 * `cancel-in-progress: true` (ci.yml:15-16) leaves a stale cancelled row as
 * the only entry for its name for several minutes before a replacement
 * posts, and reading that window as a hard failure is a false positive on a
 * check still in flight, not one that failed.
 *
 *   node scripts/ci-verdict.mjs <pr-number|sha> [--wait <seconds>]
 *
 * Exit codes:
 *   0  -- every gating check-run concluded "success", or (discovered rows
 *         only) a non-blocking terminal conclusion: "skipped"/"neutral"
 *   1  -- a gating check-run completed with a conclusion that fails it: any
 *         non-"success" conclusion on a REQUIRED row, or (on a discovered
 *         row) a blocking one -- failure/timed_out/action_required/stale/
 *         startup_failure, or cancelled with no uncertainty grace applied
 *   2  -- the PR's head is genuinely merge-conflicted (`gh pr view --json
 *         mergeable` reads "CONFLICTING"), regardless of whether the required
 *         checks are present or absent in check-runs (round 3, F1): a
 *         merge-conflicted PR can't build its merge-ref, so its real gates
 *         are skipped, not failed (AGENTS.md recurring-defect shape 11) --
 *         and even when checks ARE present and green, that's stale evidence
 *         from before the head turned conflicting, not proof the PR can
 *         merge. Exit 2 is PR-only: a bare-SHA target carries no `mergeable`
 *         (`null`, never `"CONFLICTING"`) and can never produce DIRTY -- an
 *         absent check there reads as pending (3) instead, see below. An
 *         absent check on a PR that is NOT conflicting also reads as pending
 *         (3) -- see "Absent is not automatically DIRTY" below -- since the
 *         common cause is CI not yet registered (a fresh push), not a
 *         conflict.
 *   3  -- either required check is still queued/in_progress, OR is absent but
 *         not confirmed merge-conflicted (see exit 2), OR the check-runs
 *         response was paginated and truncated so an "absent" required check
 *         cannot be trusted (F7 -- see "Truncated response" below)
 *   64 -- usage error (no target given) -- sysexits EX_USAGE, never confused
 *         with a verdict code
 *   70 -- transport/unexpected error (gh not on PATH, a `gh` call timed out
 *         or failed, malformed JSON, ...) -- sysexits EX_SOFTWARE, never
 *         confused with exit 1 ("CI failed"): a script that could not even
 *         ask GitHub is not the same fact as GitHub answering "red"
 *
 * Absent is not automatically DIRTY (#2539 round 2, F1): the common cause of
 * an absent required check is CI not yet registered on a fresh push or a
 * push that just landed (partial registration), not a merge conflict.
 * Reading absent as unconditional DIRTY meant `--wait` could never bridge
 * that registration delay -- `pollVerdict` breaks the loop on ANY
 * non-pending verdict, so a same-second-as-push read would permanently
 * misreport a perfectly healthy PR as merge-conflicted. For a PR-number
 * target, this script now also reads `mergeable` from the same `gh pr view`
 * call that already resolves the head SHA, and only reports DIRTY when
 * `mergeable === "CONFLICTING"`. A bare-SHA target carries no PR context at
 * all, so an absent check there is always reported as pending, with a note.
 *
 * DIRTY is not gated on absence either (#2539 round 3, F1): round 2 still
 * required `anyAbsent && mergeable === "CONFLICTING"`, so the DOMINANT DIRTY
 * shape -- a head that went green, then turned conflicted afterward, same
 * head SHA, old green check-runs still attached -- read as a pass (exit 0,
 * "both required checks concluded success") instead of DIRTY. A live probe
 * on #2552 confirmed it: present-and-green checks plus `mergeable ===
 * "CONFLICTING"` exited 0. `computeVerdict` now checks `mergeable ===
 * "CONFLICTING"` on its own, independent of whether any row is present --
 * the verdict record always carries `mergeState` (`mergeable ?? "n/a"`) and
 * `truncated` alongside `rows`, and `run()` always prints the merge state
 * line so a reviewer never has to infer it from `reason` text. A truncated
 * check-runs response (F7) still takes precedence over DIRTY: `mergeable`
 * itself is never paginated (it comes from the same untruncated `gh pr view`
 * call that resolves the head SHA), but an uncertain check-runs page is
 * still uncertain data and this script's whole premise is not adding a
 * second paginated read to resolve it.
 *
 * Truncated response (F7): the REST payload's own `total_count` is compared
 * against the number of check-runs actually returned. `per_page=100` is not
 * paginated here (100 check-runs on one commit is far outside this repo's
 * steady state), but if GitHub ever reports more than it returned, an
 * "absent" required check cannot be trusted -- it may simply be sitting past
 * the first page -- so that case reads as pending (3), not DIRTY, with a
 * note, rather than either silently claiming absence or adding a second
 * paginated read this script's whole premise is to avoid.
 *
 * #2664: filed against a live `2654` read that printed the exact reason text
 * below and reported exit 0 for it. Reproduced directly against this
 * function (both required rows absent, `mergeable: "MERGEABLE"`) and via the
 * full `run()` CLI path with a mocked `ghExec`: both already returned
 * `EXIT_PENDING` (3), matching test A1 in tests/scripts/ci-verdict.test.ts,
 * which has asserted exactly this since #2539 round 2 -- the reported exit 0
 * does not reproduce on any commit in this file's history, including the
 * original #2609 introduction of the discovered-rows table. The one real gap
 * was the optional hint the issue asked for: the reason text below now ends
 * with a CONDITIONAL "if the base was retargeted..." clause for the
 * mergeable-known absent case, since a base retarget after a PR opens
 * (ci.yml has no `edited` trigger) is the concrete scenario #2664 named. Not
 * phrased as a bare imperative (verify round 1, F5): an absent-check verdict
 * is also the ROUTINE outcome of a fresh push, where CI simply has not
 * registered yet (this function's own #2539 round 2 doc comment above) --
 * that is the FAR more common case, so an unconditional "push a commit"
 * directive would tell the common case's reader to push ANOTHER commit and
 * restart all of CI for no reason. There is no cheap way for a one-shot `gh`
 * read to know whether the base actually changed since the PR opened (this
 * script keeps no state between runs, by design), so the hint stays
 * conditional prose rather than a fact this read can confirm.
 *
 * `--wait <seconds>` polls at a fixed, non-configurable >=30s interval, for
 * the orchestrator only -- never in a tight loop. The requested budget is
 * clamped to a hard cap so a large ask can't itself become the next
 * 5000/hr-API-budget incident (12 agents polling `gh pr checks --watch` in
 * one day, #2539's own motivating history) plus the fabricated-CI-quote and
 * hidden-Unit-tests-failure incidents this script exists to replace.
 *
 * Every `gh` call carries an explicit `timeout` (#2539 round 2, F4): a probe
 * found a hung `gh` process blocks `execFileSync` for as long as the process
 * hangs, with NO relationship to `--wait`'s own budget -- a 30s `--wait`
 * budget was blocked 51s past its cap by one unbounded call. Each call's
 * timeout is derived from the remaining `--wait` budget -- `resolveRepository`
 * and `resolveHeadSha` from the full clamped budget before polling starts,
 * each check-runs read from what's left when it fires -- or a flat 60s
 * default for a one-shot read (no `--wait`).
 *
 * That derivation has a floor (#2539 round 3, F2): clamping straight to the
 * literal remaining budget, with no floor, meant a hang could NOT blow past
 * the cap -- but a healthy call could get killed by its OWN timeout instead.
 * A probe on `--wait 31` derived a 50ms timeout for the last poll and killed
 * a healthy ~950ms `gh` call, misreporting a green head as exit 70
 * (transport failure). A budget that had already reached its deadline
 * (`remainingMs <= 0`) fell through to the opposite failure: the full 60s
 * default, on the very call meant to end the wait, which could itself blow
 * the `--wait` budget it was derived from. `resolveGhTimeoutMs` now floors
 * every derived timeout at `MIN_GH_TIMEOUT_MS` -- a hang still can't blow far
 * past the hard cap (the floor is a small fraction of it), and a healthy
 * call near the end of a small budget still gets a fighting chance.
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
	isAdvisoryCheck,
	isBlockingConclusion,
	isUncertainConclusion,
	REQUIRED_CHECKS,
	resolveLatestByName,
} from "./lib/ci-checks.mjs";

export { REQUIRED_CHECKS };

export const EXIT_SUCCESS = 0;
export const EXIT_FAILURE = 1;
export const EXIT_DIRTY = 2;
export const EXIT_PENDING = 3;
// sysexits-derived (F3): distinct from the four verdict codes above so a
// usage mistake or a transport failure can never be misread as a CI
// conclusion (a bare `catch` used to report exit 1 -- "CI failed" -- for a
// `gh` invocation that never even reached GitHub).
export const EXIT_USAGE = 64;
export const EXIT_TRANSPORT = 70;

export const POLL_INTERVAL_SECONDS = 30;
export const HARD_CAP_SECONDS = 20 * 60;

// Every `gh` call gets this unless a smaller remaining `--wait` budget
// applies (see `resolveGhTimeoutMs`).
export const DEFAULT_GH_TIMEOUT_MS = 60_000;

// The floor `resolveGhTimeoutMs` clamps a derived timeout up to (#2539
// round 3, F2): a remaining `--wait` budget smaller than this would starve a
// healthy `gh` call of the time it actually needs (measured ~950ms for a
// check-runs read) before the call itself ever gets a chance to answer.
export const MIN_GH_TIMEOUT_MS = 5_000;

/**
 * True for a bare PR number ("2539"); false for anything sha-shaped
 * (abbreviated or full hex). `gh pr view <n>` and this repo's own SHAs never
 * collide with an all-decimal PR number in practice, so the numeric shape
 * alone is enough to disambiguate.
 */
export function isPrNumber(arg) {
	return /^\d+$/.test(String(arg ?? "").trim());
}

/**
 * Pure verdict over one commit's check-runs payload -- the literal
 * `gh api repos/<owner>/<repo>/commits/<sha>/check-runs` response shape,
 * `{ total_count, check_runs: [...] }`. No I/O, no `gh`, no fetch; exported
 * so the exit codes are unit-testable against a mocked payload.
 *
 * `mergeable` is `gh pr view --json mergeable`'s own value ("MERGEABLE",
 * "CONFLICTING", "UNKNOWN") for a PR-number target, or `null` for a bare-SHA
 * target with no PR context. `mergeable === "CONFLICTING"` earns the DIRTY
 * verdict ON ITS OWN (round 3, F1) -- independent of whether the required
 * checks are present, absent, green, or failing: a merge-conflicted head
 * can't build its merge-ref, so whatever check-runs show is either skipped
 * entirely or stale evidence from before the conflict, and neither is proof
 * the PR can merge. Everything else -- `null`, `"MERGEABLE"`, `"UNKNOWN"` --
 * defers entirely to the check rows, so an absent check with no confirmed
 * conflict reads as pending, not DIRTY, because the far more common cause is
 * CI not yet registered. Exit 2 is PR-only: `mergeable` is `null` for a
 * bare-SHA target and `null !== "CONFLICTING"`, so DIRTY can never fire
 * there.
 *
 * Precedence when a payload matches more than one condition: a truncated
 * response (F7) beats DIRTY beats FAILURE beats PENDING beats SUCCESS.
 * Truncation wins even over a confirmed conflict: `mergeable` itself is
 * never paginated, but this function's job is to report a trustworthy READ,
 * and an unfetched page of check-runs is untrustworthy data regardless of
 * what else is already known. DIRTY, once truncation is ruled out, is the
 * next most severe signal, so it wins over an independently failed or
 * still-running sibling check.
 *
 * #2609: `rows` used to be built ONLY from `requiredChecks` (the fixed
 * `["Unit tests", "Lint & type-check"]` pair), so a red "Production install
 * build" or "Install test" job on PR #2588's head e32d814e never appeared at
 * all -- `run()` reported "both required checks concluded success" while a
 * real code defect sat red. `rows` now also carries one row for every OTHER
 * check-run name GitHub reports on the head (`discoveredRows` below,
 * appended after the required rows, sorted by name for a deterministic
 * table). `requiredChecks` NAMES are still the only ones that can be
 * reported ABSENT (a name not yet in `byName` at all just isn't a row --
 * there is no fixed manifest of what a PR "should" run, unlike the
 * always-eventually-present required pair).
 *
 * Every row carries `gating`: `!isAdvisoryCheck(row.name)`, OR'd with
 * membership in `requiredChecks` itself. The OR matters only when
 * `requiredChecks` came from a live branch-protection read (`run()` passes
 * that instead of the constant default when `gh api .../protection` is
 * readable) and GitHub's own required-check list names something this
 * script's static `ADVISORY_CHECKS`/`ADVISORY_SUFFIX` allowlist would
 * otherwise excuse -- a live "required by GitHub" signal always overrides a
 * static "advisory" guess (AGENTS.md shape 38: the cheapest evasion is
 * quietly adding a real gate to the advisory list; this override is the
 * belt-and-suspenders check that catches it even if it happens).
 *
 * A NON-gating row (advisory) is excluded from both the FAILURE and PENDING
 * checks below regardless of its own status/conclusion -- an advisory lane
 * still red or still running must never hold up or fail the verdict.
 *
 * `isBlockingConclusion` (scripts/lib/ci-checks.mjs), not a bare `!==
 * "success"` comparison, decides whether a COMPLETED gating row is a
 * failure: "skipped" and "neutral" are terminal-but-not-failing conclusions,
 * and NOT hypothetical here -- this repository's own
 * `record-post-merge-validation` job (defined in both ci.yml and lint.yml)
 * carries a job-level `if: ... event_name == 'repository_dispatch'` and
 * reports "skipped" on every ordinary pull_request run (confirmed live on
 * PR #2588, 2026-09-06 -- two "Record post-merge validation" rows, both
 * "skipping" in `gh pr checks`). Reading `!== "success"` as failure the way
 * the pre-#2609 script did would have turned that routine skip into a
 * permanent false FAILURE the moment discovered rows were added.
 */
export function computeVerdict(
	checkRunsPayload,
	requiredChecks = REQUIRED_CHECKS,
	mergeable = null,
	classification = null,
	rerunState = null,
) {
	const checkRuns = Array.isArray(checkRunsPayload?.check_runs)
		? checkRunsPayload.check_runs
		: [];
	const byName = resolveLatestByName(checkRuns);
	const requiredNameSet = new Set(requiredChecks);

	const buildRow = (name) => {
		const run = byName.get(name);
		// requiredNameSet.has(name): see the doc comment above -- a name GitHub
		// itself confirms as required always gates, even if it were also (by
		// mistake) on the static advisory allowlist.
		const gating = requiredNameSet.has(name) || !isAdvisoryCheck(name);
		if (!run) {
			return {
				name,
				present: false,
				status: null,
				conclusion: null,
				url: null,
				gating,
			};
		}
		return {
			name,
			present: true,
			status: run.status ?? null,
			conclusion: run.conclusion ?? null,
			url: run.html_url ?? run.details_url ?? null,
			gating,
		};
	};

	const requiredRows = requiredChecks.map(buildRow);
	const discoveredNames = [...byName.keys()]
		.filter((name) => !requiredNameSet.has(name))
		.sort();
	const rows = [...requiredRows, ...discoveredNames.map(buildRow)];

	// Only the required rows can be legitimately "absent" -- discovered rows
	// are, by construction, names that DID appear in the payload.
	const anyAbsent = requiredRows.some((row) => !row.present);
	const totalCount = checkRunsPayload?.total_count;
	const truncated =
		typeof totalCount === "number" && totalCount > checkRuns.length;
	const mergeState = mergeable ?? "n/a";

	// #2618 fix-round-2, F1: a REQUIRED row gets NO conclusion exemption --
	// it must reach a literal "success". `isBlockingConclusion`'s skip/neutral
	// exemption (and F2's cancelled-uncertain exemption below) apply ONLY to
	// DISCOVERED rows. Applying them to required rows too (round 1's bug) let
	// a required `Unit tests` that reported "skipped" (reachable: ci.yml:253's
	// `test` job has `needs: validate-merge-train-dispatch` with no `if:`, so
	// a failed dependency skips it outright) read as a clean pass --
	// `merge-train-lane.mjs`'s real gate never had this bug: its required-row
	// loop already demands `run.conclusion === PASSING_CONCLUSION` (line
	// ~262) with no such exemption.
	//
	// #2618 fix-round-2, F2: a DISCOVERED row's "cancelled" conclusion is
	// UNCERTAIN, not a failure -- `isUncertainConclusion` (ci-checks.mjs)
	// excludes it here and instead routes it into `pendingGatingRows` below,
	// because `cancel-in-progress: true` (ci.yml:15-16) leaves a stale
	// cancelled check-run as the ONLY row for its name for several minutes
	// before a replacement posts (live-probed on PR #2607's
	// "Record post-merge validation": three check-suites on one commit, the
	// oldest cancelled). A REQUIRED row's "cancelled" conclusion gets NO such
	// grace -- it fails the literal-success test above like any other
	// non-success conclusion, so it stays non-zero.
	const infraRerunArmed =
		classification === "infra-kill" || classification === "infra-net";
	const infraRerunPending =
		infraRerunArmed &&
		rerunState?.originalFailed === true &&
		rerunState?.latestAttempt?.run_attempt > 1 &&
		rerunState.latestAttempt.status !== "completed";
	const failingGatingRows = rows.filter((row) => {
		if (!row.gating || !row.present || row.status !== "completed") return false;
		if (infraRerunPending && row.name === "Unit tests") return false;
		if (requiredNameSet.has(row.name)) return row.conclusion !== "success";
		if (isUncertainConclusion(row.conclusion)) return false;
		return isBlockingConclusion(row.conclusion);
	});
	const pendingGatingRows = rows.filter((row) => {
		if (!row.gating) return false;
		if (row.status !== "completed") return true;
		// No `requiredNameSet` check needed here (unlike `failingGatingRows`
		// above): a required row's "cancelled" conclusion is ALREADY caught by
		// `failingGatingRows`'s literal-success rule, and `failingGatingRows`
		// is checked first in the exit-code precedence below, so this branch
		// never gets a chance to downgrade it to pending regardless of what it
		// returns here (probed: removing this guard changes no test outcome).
		// Only a DISCOVERED row's "cancelled" conclusion actually turns on
		// this rule.
		return isUncertainConclusion(row.conclusion);
	});

	let exitCode;
	let reason;
	if (truncated) {
		exitCode = EXIT_PENDING;
		reason = `the check-runs response was truncated (total_count=${totalCount} > ${checkRuns.length} fetched); a missing required check cannot be trusted as absent -- treating as pending, not DIRTY (F7)`;
	} else if (mergeable === "CONFLICTING") {
		exitCode = EXIT_DIRTY;
		reason = anyAbsent
			? "one or more required checks are absent and the PR is merge-conflicted (mergeable=CONFLICTING): a merge-conflicted PR can't build its merge-ref, so the real gates are skipped, not failed -- AGENTS.md shape 11"
			: "the PR is merge-conflicted (mergeable=CONFLICTING) even though the required checks show present -- that's stale evidence from before the head turned conflicting, not proof it can merge (round 3, F1)";
	} else if (infraRerunPending) {
		exitCode = EXIT_PENDING;
		reason =
			"infra (rerun armed): Unit tests was classified as infrastructure and is awaiting its one permitted rerun";
	} else if (failingGatingRows.length > 0) {
		exitCode = EXIT_FAILURE;
		reason = `gating check(s) completed with a non-success conclusion: ${failingGatingRows.map((row) => `${row.name} (${row.conclusion})`).join(", ")}`;
	} else if (pendingGatingRows.length > 0) {
		exitCode = EXIT_PENDING;
		if (anyAbsent) {
			reason =
				mergeable == null
					? "one or more required checks are absent and there is no PR context (bare-SHA target) to confirm they are not merge-conflicted; treating as pending, not DIRTY -- pass a PR number, or wait for CI to register"
					: `one or more required checks are absent but the PR is not merge-conflicted (mergeable=${mergeable}); CI likely hasn't registered yet -- treating as pending, not DIRTY -- if the base was retargeted after this PR opened, push a commit or close/reopen to re-arm ci.yml`;
		} else {
			// Split by STATUS, not just "pending": an uncertain (cancelled,
			// discovered) row is already COMPLETED -- reporting it as "still
			// queued or in progress" alongside the table's own `completed
			// cancelled` row two lines up would read as a contradiction. It gets
			// its own clause explaining WHY a completed row still pends (#2618
			// fix round 3).
			const stillRunning = pendingGatingRows.filter(
				(row) => row.status !== "completed",
			);
			const uncertain = pendingGatingRows.filter(
				(row) => row.status === "completed",
			);
			const parts = [];
			if (stillRunning.length > 0) {
				parts.push(
					`still queued or in progress: ${stillRunning.map((row) => row.name).join(", ")}`,
				);
			}
			if (uncertain.length > 0) {
				parts.push(
					`cancelled and not yet re-reported (a superseded run; pends until the replacement posts -- this does not time out on its own): ${uncertain.map((row) => row.name).join(", ")}`,
				);
			}
			reason = `gating check(s) ${parts.join("; ")}`;
		}
	} else {
		exitCode = EXIT_SUCCESS;
		reason = "every gating check concluded success";
	}
	return { exitCode, rows, reason, mergeState, truncated };
}

/** Fixed-column table: CHECK / STATUS / CONCLUSION / URL. Exported for tests
 * so the rendering itself is pinned, not just eyeballed from CLI output. */
export function formatVerdictTable(rows) {
	const header = ["CHECK", "STATUS", "CONCLUSION", "URL"];
	const data = rows.map((row) => [
		row.name,
		row.present ? (row.status ?? "unknown") : "absent",
		row.present ? (row.conclusion ?? "-") : "-",
		row.present ? (row.url ?? "-") : "-",
	]);
	const widths = header.map((head, index) =>
		Math.max(head.length, ...data.map((row) => row[index].length)),
	);
	const formatRow = (cells) =>
		cells.map((cell, i) => cell.padEnd(widths[i])).join("  ");
	return [formatRow(header), ...data.map(formatRow)].join("\n");
}

/** Clamp a requested `--wait` budget to the hard cap. A non-finite or
 * non-positive value means "no waiting" (the default one-shot read). */
export function resolveWaitCapSeconds(waitSecondsArg) {
	if (!Number.isFinite(waitSecondsArg) || waitSecondsArg <= 0) return 0;
	return Math.min(waitSecondsArg, HARD_CAP_SECONDS);
}

/**
 * The `timeout` (ms) one `gh` call should carry (F4, floored round 3 F2):
 * the remaining `--wait` budget when it is smaller than the default, so a
 * hang near the end of the budget cannot itself blow far past the hard cap;
 * the flat `DEFAULT_GH_TIMEOUT_MS` when there is no meaningful budget to
 * derive from (no `--wait`, or anything that isn't a finite number).
 *
 * The derived value is floored at `MIN_GH_TIMEOUT_MS` (F2): clamping
 * straight to the literal remainder let a nearly-exhausted budget (a small
 * positive remainder, or exactly 0 on the deadline-reached last poll) starve
 * a healthy `gh` call of the time it needs, or -- for the `remainingMs <= 0`
 * case specifically -- previously fell through to the untouched
 * `remainingMs > 0` guard and got the FULL 60s default instead, which could
 * itself blow the `--wait` budget on the very call meant to end it. Flooring
 * both cases at the same small constant fixes both directions at once.
 */
export function resolveGhTimeoutMs(remainingMs) {
	if (typeof remainingMs !== "number" || !Number.isFinite(remainingMs)) {
		return DEFAULT_GH_TIMEOUT_MS;
	}
	return Math.max(
		MIN_GH_TIMEOUT_MS,
		Math.min(DEFAULT_GH_TIMEOUT_MS, remainingMs),
	);
}

/**
 * Poll `fetchPayload` (returns a check-runs JSON payload) until the computed
 * verdict is no longer PENDING or the wait budget is exhausted, at a fixed
 * `POLL_INTERVAL_SECONDS` interval. `sleepImpl` and `now` are injectable so
 * this is testable against a fake clock, with no real 30s wait and no
 * dependency on wall-clock timing.
 *
 * `fetchPayload` is called with the remaining wait-budget in ms (`undefined`
 * on a one-shot read with no `--wait`), so a caller wiring `gh` underneath
 * can derive that call's own timeout via `resolveGhTimeoutMs` (F4).
 * `mergeable` threads straight through to `computeVerdict` (F1).
 *
 * @returns {Promise<{ verdict: ReturnType<typeof computeVerdict>, polls: number }>}
 */
export async function pollVerdict({
	fetchPayload,
	waitSeconds,
	mergeable = null,
	requiredChecks = REQUIRED_CHECKS,
	classification = null,
	rerunState = null,
	sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	now = () => Date.now(),
}) {
	const capSeconds = resolveWaitCapSeconds(waitSeconds);
	const deadline = now() + capSeconds * 1000;
	let verdict;
	let polls = 0;
	for (;;) {
		const remainingMs =
			capSeconds > 0 ? Math.max(0, deadline - now()) : undefined;
		const currentRerunState =
			typeof rerunState === "function" ? rerunState() : rerunState;
		verdict = computeVerdict(
			await fetchPayload(remainingMs),
			requiredChecks,
			mergeable,
			classification,
			currentRerunState,
		);
		polls += 1;
		if (verdict.exitCode !== EXIT_PENDING) break;
		if (now() >= deadline) break;
		await sleepImpl(POLL_INTERVAL_SECONDS * 1000);
	}
	return { verdict, polls };
}

// ---------------------------------------------------------------------------
// Thin `gh` shell. No fetch, no token, no GITHUB_* env var -- `gh` on PATH is
// the only dependency (acceptance criterion), and every function below takes
// an injectable `ghExec` so the CLI orchestration stays testable too.
// ---------------------------------------------------------------------------

function gh(args, { timeoutMs = DEFAULT_GH_TIMEOUT_MS } = {}) {
	// `timeout` + `killSignal` (F4): with neither, a hung `gh` process parks
	// this call -- and everything waiting on it, including `--wait`'s own
	// budget -- indefinitely. A probe measured a hung `gh` blocking 51s past
	// a 30s `--wait` budget before this fix.
	return execFileSync("gh", args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: timeoutMs,
		killSignal: "SIGTERM",
	});
}

// #2539 round 3, F2: both resolvers used to call `ghExec` with no options at
// all, so they fell back to the `gh()` wrapper's own default parameter --
// the flat `DEFAULT_GH_TIMEOUT_MS` (60s) -- with NO relationship to `--wait`,
// exactly the gap `resolveGhTimeoutMs` exists to close for the check-runs
// read. `run()` now derives a timeout from the full clamped `--wait` budget
// (nothing has been spent yet when these two fire first) and passes it here.
export function resolveRepository(
	ghExec = gh,
	timeoutMs = DEFAULT_GH_TIMEOUT_MS,
) {
	return ghExec(
		["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
		{ timeoutMs },
	).trim();
}

/**
 * Resolves a target to `{ sha, mergeable }`. For a PR number, ONE
 * `gh pr view` call returns both `headRefOid` and `mergeable` (F1) -- adding
 * `mergeable` to the existing call, not a second call, keeps this a
 * one-request resolve. `mergeable` is GitHub's own enum ("MERGEABLE",
 * "CONFLICTING", "UNKNOWN"). For a bare SHA target, there is no PR to ask,
 * so `mergeable` is `null` -- `computeVerdict` treats that the same as
 * "not CONFLICTING" (pending, not DIRTY, on an absent check), and DIRTY can
 * never fire for a bare-SHA target since `null !== "CONFLICTING"`.
 */
export function resolveHeadSha(
	target,
	ghExec = gh,
	timeoutMs = DEFAULT_GH_TIMEOUT_MS,
) {
	if (isPrNumber(target)) {
		const raw = ghExec(
			["pr", "view", String(target), "--json", "headRefOid,mergeable"],
			{ timeoutMs },
		);
		const parsed = JSON.parse(raw);
		return { sha: parsed.headRefOid, mergeable: parsed.mergeable ?? null };
	}
	return { sha: String(target).trim(), mergeable: null };
}

export function resolveClassification(
	target,
	ghExec = gh,
	timeoutMs = DEFAULT_GH_TIMEOUT_MS,
) {
	if (!isPrNumber(target)) return null;
	try {
		const parsed = JSON.parse(
			ghExec(["pr", "view", String(target), "--json", "labels"], { timeoutMs }),
		);
		const names = Array.isArray(parsed.labels)
			? parsed.labels.map((label) => label?.name)
			: [];
		return names.includes("ci:infra")
			? "infra-kill"
			: names.includes("ci:real")
				? "real"
				: null;
	} catch {
		return null;
	}
}

export function fetchCheckRunsPayload(
	repository,
	sha,
	ghExec = gh,
	timeoutMs = DEFAULT_GH_TIMEOUT_MS,
) {
	return JSON.parse(
		ghExec(
			["api", `repos/${repository}/commits/${sha}/check-runs?per_page=100`],
			{ timeoutMs },
		),
	);
}

/** Read Actions attempts through the existing ghExec seam. Check-runs do not
 * expose run_attempt, so this read distinguishes a queued/running rerun from
 * a terminal latest attempt. */
export function fetchRerunState(
	repository,
	sha,
	ghExec = gh,
	timeoutMs = DEFAULT_GH_TIMEOUT_MS,
) {
	try {
		const payload = JSON.parse(
			ghExec(
				[
					"api",
					`repos/${repository}/actions/runs?head_sha=${sha}&per_page=100`,
				],
				{ timeoutMs },
			),
		);
		const attempts = (
			Array.isArray(payload?.workflow_runs) ? payload.workflow_runs : []
		)
			.filter((run) => run?.name === "CI" && run?.head_sha === sha)
			.filter((run) => Number(run?.run_attempt) > 0)
			.sort((a, b) => Number(a.run_attempt) - Number(b.run_attempt));
		const original = attempts.find((run) => Number(run.run_attempt) === 1);
		const latest = attempts.at(-1);
		return {
			originalFailed: original?.conclusion === "failure",
			latestAttempt: latest
				? {
						status: latest.status ?? null,
						conclusion: latest.conclusion ?? null,
						run_attempt: Number(latest.run_attempt),
					}
				: null,
		};
	} catch {
		return null;
	}
}

// The only branch this repository protects (ci.yml/lint.yml/etc. all trigger
// on `branches: [master]`); every PR this script is ever pointed at targets
// it. Not derived per-target because a bare-SHA target carries no base-branch
// context at all, and deriving it for a PR-number target would need a SECOND
// `gh pr view` field read for a value that never varies in this repo.
export const PROTECTED_BRANCH = "master";

/**
 * Reads the LIVE required-status-check names GitHub enforces on
 * `PROTECTED_BRANCH`, via `gh api repos/<repo>/branches/<branch>/protection`
 * (classic branch protection; this repository has no ruleset configured --
 * `gh api repos/.../rulesets` returned `[]` when probed 2026-09-06). Returns
 * `null` on ANY failure -- insufficient permission, 404, malformed JSON, an
 * unexpected response shape, a `gh` timeout -- never throws, so an
 * unreadable ruleset always falls back to `run()`'s constant
 * `REQUIRED_CHECKS` default rather than aborting the whole verdict read
 * (#2609's acceptance criterion: "the required checks from the repository
 * ruleset / branch protection via `gh api` WHEN READABLE, else an explicit
 * ADVISORY allowlist").
 *
 * `required_status_checks.checks[].context` is read in PREFERENCE to the
 * legacy `.contexts` string array (#2618 fix-round-2 reviewer note): GitHub's
 * own docs mark `contexts` deprecated, and a check added purely through the
 * newer per-app `checks` shape (an `app_id`-scoped context, as opposed to a
 * plain commit-status context) is not guaranteed to also appear in the
 * legacy array -- reading only `contexts` risks silently missing such a
 * required name, which would then never gate via the branch-protection
 * source at all and could pend forever waiting on a check this function
 * never told the caller to expect. `.contexts` remains the fallback when
 * `.checks` is absent (older API responses, or a repository whose
 * protection predates the field) -- this repository's own live response
 * carries both today and they agree (probed 2026-09-06: `checks: [{context:
 * "Lint & type-check", ...}, {context: "Unit tests", ...}]`).
 */
export function resolveRequiredCheckNames(
	repository,
	ghExec = gh,
	timeoutMs = DEFAULT_GH_TIMEOUT_MS,
) {
	try {
		const raw = ghExec(
			["api", `repos/${repository}/branches/${PROTECTED_BRANCH}/protection`],
			{ timeoutMs },
		);
		const requiredStatusChecks = JSON.parse(raw)?.required_status_checks;
		const checks = requiredStatusChecks?.checks;
		const contextsFromChecks = Array.isArray(checks)
			? checks.map((check) => check?.context).filter(Boolean)
			: [];
		// An empty (or absent) `.checks` falls all the way back to the legacy
		// array -- an empty modern array is more likely an unpopulated field on
		// an older API response than a repository with zero required checks.
		const contexts =
			contextsFromChecks.length > 0
				? contextsFromChecks
				: requiredStatusChecks?.contexts;
		if (!Array.isArray(contexts) || contexts.length === 0) return null;
		return contexts.map(String);
	} catch {
		return null;
	}
}

export function parseArgs(argv) {
	const rest = [];
	let waitSeconds = null;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--wait") {
			waitSeconds = Number(argv[++i]);
		} else {
			rest.push(argv[i]);
		}
	}
	return { target: rest[0] ?? null, waitSeconds };
}

/**
 * The whole CLI, minus the process-exit side effect: resolves an exit code
 * instead of setting `process.exitCode` or throwing, so tests can drive it
 * with an injectable `ghExec` and injectable output sinks. `main()` below is
 * the only caller that touches `process`.
 */
export async function run({
	argv = process.argv.slice(2),
	ghExec = gh,
	stdout = console.log,
	stderr = console.error,
} = {}) {
	const { target, waitSeconds } = parseArgs(argv);
	if (!target) {
		stderr(
			"usage: node scripts/ci-verdict.mjs <pr-number|sha> [--wait <seconds>]",
		);
		return EXIT_USAGE;
	}

	try {
		// #2539 round 3, F2: `resolveRepository`/`resolveHeadSha` fire before
		// any budget has been spent, so their timeout derives from the FULL
		// clamped `--wait` cap (or `undefined` for a one-shot read, same as
		// the flat default `resolveGhTimeoutMs` already falls back to).
		const capSeconds = resolveWaitCapSeconds(waitSeconds);
		const initialTimeoutMs = resolveGhTimeoutMs(
			capSeconds > 0 ? capSeconds * 1000 : undefined,
		);
		const repository = resolveRepository(ghExec, initialTimeoutMs);
		const { sha, mergeable, classification } = resolveHeadSha(
			target,
			ghExec,
			initialTimeoutMs,
		);
		const ciClassification =
			classification ?? resolveClassification(target, ghExec, initialTimeoutMs);
		const rerunState =
			ciClassification && isPrNumber(target)
				? () => fetchRerunState(repository, sha, ghExec, initialTimeoutMs)
				: null;
		// #2609: read once, before polling starts (branch protection does not
		// change between polls of the same head). `null` means unreadable --
		// `requiredChecks` then falls back to the constant default, and every
		// OTHER discovered check still gates via computeVerdict's own
		// advisory-allowlist check (see its doc comment).
		const liveRequiredChecks = resolveRequiredCheckNames(
			repository,
			ghExec,
			initialTimeoutMs,
		);
		const requiredChecks = liveRequiredChecks ?? REQUIRED_CHECKS;
		const gatingSource = liveRequiredChecks
			? `branch protection required_status_checks on ${PROTECTED_BRANCH} (${liveRequiredChecks.join(", ")}) -- every other check-run gates unless it is on the advisory allowlist`
			: `advisory allowlist only -- branch protection on ${PROTECTED_BRANCH} was unreadable, falling back to the constant required-check list (${REQUIRED_CHECKS.join(", ")})`;

		const { verdict, polls } = await pollVerdict({
			fetchPayload: (remainingMs) =>
				fetchCheckRunsPayload(
					repository,
					sha,
					ghExec,
					resolveGhTimeoutMs(remainingMs),
				),
			waitSeconds,
			mergeable,
			requiredChecks,
			classification: ciClassification,
			rerunState,
		});

		stdout(
			`CI verdict for ${repository}@${sha}${polls > 1 ? ` (${polls} reads)` : ""}`,
		);
		stdout(formatVerdictTable(verdict.rows));
		// Merge state is always printed, not just when it drives the verdict
		// (round 3, F1) -- a reviewer reading the report should never have to
		// infer it from `reason` text alone. `"n/a"` for a bare-SHA target
		// documents that DIRTY is PR-only.
		stdout(`Merge state: ${verdict.mergeState}`);
		stdout(`Gating source: ${gatingSource}`);
		stdout(verdict.reason);
		return verdict.exitCode;
	} catch (error) {
		// Transport/unexpected (F3): `gh` missing from PATH, a call that hit its
		// own timeout, malformed JSON, or anything else that means this script
		// never got a real answer from GitHub. Distinct from EXIT_FAILURE (1),
		// which means GitHub DID answer and the answer was red.
		stderr(error instanceof Error ? error.message : String(error));
		return EXIT_TRANSPORT;
	}
}

async function main() {
	process.exitCode = await run();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	main().catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
}
