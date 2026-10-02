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
 * `isAdvisoryCheck` -- the SAME list the merge-train warden (#2185) already
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
 * ANYTHING else (skipped, neutral, or a real failure) is non-zero, while a
 * latest cancellation gets the explicit rerun-pending verdict below, because
 * a required check that skipped or was cancelled is stale or interrupted
 * evidence, never proof of a pass (round 1's bug: it exempted skipped/neutral on EVERY gating row, so a required `Unit tests` skipped by
 * a failed `needs:` dependency read as a clean pass). A DISCOVERED row's
 * "skipped"/"neutral" conclusion is a genuine non-failure (a job-level
 * `if:` that evaluated false -- see computeVerdict's own doc comment), and
 * its "cancelled" conclusion is UNCERTAIN rather than failing: this repo's
 * event-scoped `cancel-in-progress` leaves a stale cancelled row as
 * the only entry for its name for several minutes before a replacement
 * posts, and reading that window as a hard failure is a false positive on a
 * check still in flight, not one that failed.
 *
 *   node scripts/ci-verdict.mjs <pr-number|sha> [--wait <seconds>]
 *   node scripts/ci-verdict.mjs --all
 *   node scripts/ci-verdict.mjs --watch-open [--wait <seconds>] [--state-file <path>]
 *
 * #3700: `--all` and `--watch-open` (a notifying wait: exit 0 on the first poll
 * with a per-PR event, 3 when the window ends with none) read every PR through
 * `run()` itself, and a FAILED verdict now names the failed step, the failing
 * test lines and a remedy hint -- see `readFailureDetails` and `watchOpenPrs`.
 *
 * Exit codes:
 *   0  -- every gating check-run concluded "success", or (discovered rows
 *         only) a non-blocking terminal conclusion: "skipped"/"neutral"
 *   1  -- a gating check-run completed with a conclusion that fails it: any
 *         non-"success" conclusion on a REQUIRED row, or (on a discovered
 *         row) a blocking one -- failure/timed_out/action_required/stale/
 *         startup_failure; a latest cancelled row is pending with a rerun hint
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
 *         required checks are absent and the head is not confirmed conflicting
 *   64 -- usage error (no target given) -- sysexits EX_USAGE, never confused
 *         with a verdict code
 *   70 -- transport/unexpected error (gh not on PATH, a `gh` call timed out
 *         or failed, malformed JSON, ...) -- sysexits EX_SOFTWARE, never
 *         confused with exit 1 ("CI failed"): a script that could not even
 *         ask GitHub is not the same fact as GitHub answering "red". Under
 *         `--wait`, a TRANSIENT check-runs failure (network, 5xx, a `gh`
 *         call that hit its own timeout) backs off and keeps waiting
 *         instead (#2935); exit 70 then means the budget ran out while
 *         GitHub was still unreachable
 *
 * #3779: a PR-number target on the `gh` transport also prints one advisory
 * `MUTATION` line (the Mutation diff comment's survivor count and covered head;
 * STALE / PENDING, see `formatMutationLine`). It is read after the verdict and
 * is never an input to it: no exit code above depends on it.
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
 * `rows`, and `run()` always prints the merge state line so a reviewer never
 * has to infer it from `reason` text.
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
 *
 * #3497: the Claude Code cloud container carries `GH_TOKEN`/`GITHUB_TOKEN`
 * but has no `gh` binary, so this script exited 70 (transport) unconditionally
 * there -- a `check_suite.completed` wake was misread as a green head on
 * PR #3491 in exactly that gap (its own verify reviewer read CI by hand
 * instead). When the real `gh` is confirmed missing (an `ENOENT` probe, not
 * merely erroring) AND a token is available, `run()` switches to a REST
 * transport that reads the SAME endpoints (`gh api X` is itself a thin fetch
 * wrapper around `https://api.github.com/X`) via an authenticated `fetch`,
 * resolving the repository from the checkout's own `git remote` instead of
 * `gh repo view`. The verdict line names which transport produced it
 * (`Transport: gh` / `Transport: rest`). See `resolveTransport`,
 * `restResolveHeadSha`, `restFetchCheckRunsPayload` and
 * `restResolveRequiredCheckNames` below.
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
	ASSERTION_LINE,
	BARE_FAIL_LINE,
	stripAnsi,
	stripLineTimestamps,
} from "./lib/ci-failure-classifier.mjs";
import {
	CHANGES_CHECK,
	DEFERRED_ADVISORY_CHECKS,
	HEAVY_GATE_CHECK,
	isAdvisoryCheck,
	isBlockingConclusion,
	isUncertainConclusion,
	isUnitTestsJobName,
	REQUIRED_CHECKS,
	resolveLatestByName,
} from "./lib/ci-checks.mjs";
import { findStickyCommentId } from "./lib/mutation-pr-comment.mjs";
import { STICKY_MARKER } from "./lib/mutation-report-render.mjs";

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

// The verdict EXIT CODE -> KIND table. Every other mode names its own kind at
// its `run()` exit site, so the printed line never claims a CI verdict the run
// did not reach (#3883 F4).
const VERDICT_KIND_BY_EXIT = new Map([
	[EXIT_SUCCESS, "green"],
	[EXIT_FAILURE, "red"],
	[EXIT_DIRTY, "DIRTY"],
	[EXIT_PENDING, "pending"],
	[EXIT_USAGE, "usage"],
	[EXIT_TRANSPORT, "transport"],
]);

/** The kind a plain verdict exit code prints; modes override with their own.
 * The exit-code table is deliberately coarse: `cancelled`, `infra-rerun`,
 * `absent-rearm` and `fork-approval` all print `(pending)`, which existing
 * shell and warden readers match on. The one verdict kind the CLI documents
 * as readable on this surface is `in-queue` (#3754): a queued PR is exit 3,
 * and the plain line must not read as an ordinary `pending` (#3883 F4). */
function verdictExitKind(exitCode, verdictKind) {
	if (exitCode === EXIT_PENDING && verdictKind === "in-queue")
		return "in-queue";
	return VERDICT_KIND_BY_EXIT.get(exitCode) ?? "unknown";
}

/**
 * The kind `--all`/`--watch-open` prints. Watch mode's 0/3 describe whether
 * an event was observed, so they keep their own label; its usage and
 * transport exits still name the real failure instead of hiding behind
 * `(watch)` (#3883 F4).
 */
function watchExitKind({ watchOpen, stream, code }) {
	if (code === EXIT_USAGE) return "usage";
	if (code === EXIT_TRANSPORT) return "transport";
	if (!watchOpen) return "all";
	return stream ? "stream" : "watch";
}

/**
 * The status line a shell pipeline can retain without consulting `$?`.
 * Takes the `{ code, kind }` `run()` resolved where the exit code was decided,
 * so the line can never contradict the verdict (#3883 F4): an unexpected
 * error is `error`, `--all` is `all`, `--approve-fork` is `approve`, and
 * watch mode keeps `watch`/`stream` except for its `usage`/`transport` exits.
 */
export function formatExitLine({ code, kind }) {
	return `ci-verdict: exit ${code} (${kind})`;
}

/**
 * The `{ code, kind }` a non-verdict emission prints. They live here, named
 * once, so the formatter contract's own unit tests cover them rather than
 * only an old-Node spawn (version-too-old) or a forced crash (top-level
 * catch) that a test cannot reach (#3883 F4).
 */
export function transportExit() {
	return { code: EXIT_TRANSPORT, kind: "transport" };
}

export function crashExit() {
	return { code: EXIT_FAILURE, kind: "error" };
}

/** Minutes a required check may stay unregistered on a head with auto-merge
 * armed before the verdict says "re-arm" (#3694). CI normally registers within
 * a minute or two; ten is well past that without hiding a stuck retarget. */
export const ABSENT_REQUIRED_REARM_MINUTES = 10;

// The ci.yml workflow's own name, the one `fetchRerunState` and the absent-run
// lookup both key on (#3861).
const CI_WORKFLOW_NAME = "CI";

export function formatAbsentRequiredReason(sha, minutes = 0) {
	return `required checks absent for ${Math.max(0, Math.floor(Number(minutes) || 0))} min on ${sha} (auto-merge on) — push or merge master to re-arm`;
}

/**
 * #3861: the head's `ci.yml` run is already registered, so "push or merge
 * master to re-arm" is wrong advice -- the run exists and the queue is just
 * slow. Report the run identity and its age instead; only a POSITIVE no-run
 * answer authorizes re-arm (`formatAbsentRequiredReason`).
 *
 * #3861 F3: a TERMINAL run (`completed` / `cancelled`) cannot produce the
 * missing check-runs, so "no re-arm is needed" is false comfort. Name the
 * terminal state and the manual inspect/rerun, and say plainly that nothing
 * re-arms automatically (#3795 item 3 stays held).
 */
export function formatAbsentRunReason({ state, id, ageMinutes, sha }) {
	const label =
		state === "in_progress" ? "in progress" : String(state ?? "registered");
	const idText = id == null ? "an unnamed run" : `run ${id}`;
	const ageText = Number.isFinite(ageMinutes)
		? ` (${Math.max(0, Math.floor(ageMinutes))} min old)`
		: "";
	if (state === "completed" || state === "cancelled") {
		const rerunText =
			id == null ? "" : ` or re-run it manually (gh run rerun ${id})`;
		return `ci.yml ${idText} is ${label}${ageText} for ${sha}: the run is terminal and cannot produce the missing check-runs -- inspect it${rerunText}; the verdict never re-arms automatically`;
	}
	return `ci.yml ${idText} is ${label}${ageText} for ${sha}: the run is registered, so no re-arm is needed`;
}

/**
 * #3861: the run lookup itself failed. An unreadable lookup is not evidence
 * of a missing run, so it must never authorize the re-arm advice; the
 * bounded line names the gap and stops there.
 */
export function formatAbsentRunUnknownReason(sha, minutes = 0) {
	return `required checks absent for ${Math.max(0, Math.floor(Number(minutes) || 0))} min on ${sha} and the ci.yml run lookup was unreadable: no re-arm advice without a run answer`;
}

/** Never approves: GitHub shows a fork PR's first runs as `action_required`
 * until a maintainer approves them, so the verdict names the command and stops
 * (#3694). `repository` is the real `<owner>/<repo>`, so it pastes as is. */
export function formatForkApprovalReason(repository, runs) {
	return `awaiting fork approval (maintainer decision, never automatic): ${runs
		.map(
			(run) =>
				`gh api -X POST repos/${repository}/actions/runs/${run.id}/approve`,
		)
		.join(", ")}`;
}

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

// #2935: under `--wait`, a transient `gh` failure on the check-runs read backs
// off from this delay, doubling up to the cap, instead of exiting 70. Two
// GitHub API outages on 2026-09-10 killed seven armed waits at once.
export const TRANSIENT_BACKOFF_INITIAL_SECONDS = 30;
export const TRANSIENT_BACKOFF_MAX_SECONDS = 5 * 60;

// `gh`'s own spellings of an unreachable or failing GitHub: the connect
// error it printed during the #2935 outages, Go's net/http transport errors,
// and a 5xx status. Auth/repo errors (401/403/404, `gh auth login`) never
// match, so they keep the immediate exit 70.
const TRANSIENT_GH_STDERR =
	/error connecting to|connection (?:reset|refused)|i\/o timeout|TLS handshake timeout|unexpected EOF|no such host|HTTP 5\d\d\b/i;

/**
 * True when a thrown `gh` failure is worth waiting out (#2935): a network or
 * 5xx error in its stderr, or the call hitting its own `timeout` (a hung `gh`
 * during an outage). Everything else -- `gh` missing, malformed JSON, an
 * auth or repo error -- is not, so a `--wait` can't park on a failure that
 * retrying never fixes.
 */
export function isTransientGhError(error) {
	if (!(error instanceof Error)) return false;
	if (error.code === "ETIMEDOUT") return true;
	const stderr = error.stderr == null ? "" : String(error.stderr);
	return TRANSIENT_GH_STDERR.test(stderr);
}

/**
 * True when a thrown failure is specifically "the `gh` binary itself is not
 * on PATH" (#3497): `execFileSync("gh", ...)` reports this as `ENOENT`, the
 * exact shape the pre-existing "gh not on PATH" case in the
 * `isTransientGhError` test table already carries. This is deliberately
 * NARROWER than "any gh failure" -- an auth error, a malformed response, or
 * a hung process all stay on the `gh` transport and keep today's immediate
 * exit 70, because only a genuinely missing binary is what the REST
 * fallback below exists to route around.
 */
export function isGhMissingError(error) {
	return error instanceof Error && error.code === "ENOENT";
}

/**
 * The token this script uses for the REST transport (#3497), checked in the
 * same order `gh` itself documents for `GH_TOKEN`/`GITHUB_TOKEN` -- `GH_TOKEN`
 * first. Returns `null` for an unset or empty value so a caller can treat
 * "no token" and "no gh" as the single combined "cannot reach GitHub at all"
 * case (today's exit 70).
 */
export function resolveGithubToken(env = process.env) {
	const token = env.GH_TOKEN || env.GITHUB_TOKEN;
	return typeof token === "string" && token.length > 0 ? token : null;
}

/**
 * The REST API base this script talks to for the REST transport (#3497):
 * `GITHUB_API_URL` when set (GitHub Enterprise Server), else the public
 * default -- the same variable `scripts/check-pr-body.mjs`'s `fetchLivePrBody`
 * already reads for the identical reason.
 */
export function resolveGithubApiBase(env = process.env) {
	return env.GITHUB_API_URL || "https://api.github.com";
}

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
 * The state of a deferred heavy job that has no check-run, from the heavy
 * gate's own check-run (see ci-checks.mjs `HEAVY_GATE_CHECK`).
 *
 * @param {{ status?: string|null, conclusion?: string|null }|undefined} gate
 * @returns {{ deferredState: "PENDING"|"NOT RUN", deferredWhy: string }}
 */
function deferredStateFor(gate) {
	if (!gate || gate.status !== "completed")
		return {
			deferredState: "PENDING",
			deferredWhy: "waiting for the required checks",
		};
	if (gate.conclusion === "success")
		return {
			deferredState: "PENDING",
			deferredWhy: "the gate passed and the job is about to be queued",
		};
	if (gate.conclusion === "skipped")
		return {
			deferredState: "NOT RUN",
			deferredWhy:
				"the heavy gate was skipped (a required check did not succeed, or the diff is docs-only)",
		};
	return {
		deferredState: "NOT RUN",
		deferredWhy: `the heavy gate concluded ${gate.conclusion} (a lint.yml required check was red or unfinished at its deadline)`,
	};
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
 * Precedence when a payload matches more than one condition: DIRTY beats
 * FAILURE beats PENDING beats SUCCESS.
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
 * a conditionally skipped workflow job can report "skipped" on an ordinary
 * pull_request run. Reading `!== "success"` as failure the way the pre-#2609
 * script did would have turned that routine skip into a permanent false
 * FAILURE the moment discovered rows were added.
 */
export function computeVerdict(
	checkRunsPayload,
	requiredChecks = REQUIRED_CHECKS,
	mergeable = null,
	classification = null,
	rerunState = null,
	absentContext = null,
	noiseRowIds = null,
	queueContext = null,
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
				id: null,
				status: null,
				conclusion: null,
				url: null,
				gating,
			};
		}
		return {
			name,
			present: true,
			id: run.id ?? null,
			status: run.status ?? null,
			conclusion: run.conclusion ?? null,
			url: run.html_url ?? run.details_url ?? null,
			detailsUrl: run.details_url ?? null,
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
	const mergeState = mergeable ?? "n/a";

	// #2618 fix-round-2, F1: a REQUIRED row gets NO conclusion exemption --
	// it must reach a literal "success". `isBlockingConclusion`'s skip/neutral
	// exemption applies only to non-cancelled DISCOVERED rows. Applying it to
	// required rows too (round 1's bug) let
	// a required `Unit tests` that reported "skipped" (reachable: ci.yml:253's
	// a failed dependency skips it outright) read as a clean pass -- the
	// required-row loop already demands `run.conclusion === PASSING_CONCLUSION`
	// with no such exemption.
	//
	// #3373: a latest cancelled row is actionable uncertainty for every gating
	// name, including required names. It is reported with its run id below so a
	// reviewer can rerun the superseded check instead of waiting indefinitely.
	const infraRerunArmed =
		classification === "infra-kill" || classification === "infra-net";
	const infraRerunPending =
		infraRerunArmed &&
		rerunState?.originalFailed === true &&
		rerunState?.latestAttempt?.run_attempt > 1 &&
		rerunState.latestAttempt.status !== "completed";
	const cancelledLatestRows = rows.filter(
		(row) =>
			row.gating &&
			row.present &&
			row.status === "completed" &&
			isUncertainConclusion(row.conclusion),
	);
	// #3700: a row the caller proved is post-merge noise (its job could not
	// fetch `refs/pull/N/merge` after the PR merged) is not a failure. The proof
	// needs the job log, which this pure function never reads.
	const isNoiseRow = (row) => noiseRowIds?.has(row.id) === true;
	const failingGatingRows = rows.filter((row) => {
		if (!row.gating || !row.present || row.status !== "completed") return false;
		if (isUncertainConclusion(row.conclusion)) return false;
		if (isNoiseRow(row)) return false;
		// #3753: the aggregate AND every `Unit tests (shard k/N)` row: the kill
		// that armed the rerun sits in a shard, and the rerun replays it.
		if (infraRerunPending && isUnitTestsJobName(row.name)) return false;
		if (requiredNameSet.has(row.name)) return row.conclusion !== "success";
		return isBlockingConclusion(row.conclusion);
	});
	const noiseRows = rows.filter((row) => row.gating && isNoiseRow(row));
	const pendingGatingRows = rows.filter((row) => {
		if (!row.gating) return false;
		if (row.status !== "completed") return true;
		return false;
	});

	let exitCode;
	let reason;
	let queueFailedRows = null;
	// #3700: the machine-readable state `--watch-open` and `--all` key on, so
	// neither has to text-match `reason`.
	let kind;
	if (mergeable === "CONFLICTING") {
		exitCode = EXIT_DIRTY;
		kind = "dirty";
		reason = anyAbsent
			? "one or more required checks are absent and the PR is merge-conflicted (mergeable=CONFLICTING): a merge-conflicted PR can't build its merge-ref, so the real gates are skipped, not failed -- AGENTS.md shape 11"
			: "the PR is merge-conflicted (mergeable=CONFLICTING) even though the required checks show present -- that's stale evidence from before the head turned conflicting, not proof it can merge (round 3, F1)";
	} else if (infraRerunPending) {
		exitCode = EXIT_PENDING;
		kind = "infra-rerun";
		reason =
			"infra (rerun armed): Unit tests was classified as infrastructure and is awaiting its one permitted rerun";
	} else if (cancelledLatestRows.length > 0) {
		exitCode = EXIT_PENDING;
		kind = "cancelled";
		const seenRerunHints = new Set();
		const rerunHints = cancelledLatestRows
			.map((row) => {
				const args = rerunArgsFor(row);
				const key = args?.join(" ") ?? formatRerunHint(row);
				if (seenRerunHints.has(key)) return null;
				seenRerunHints.add(key);
				return formatRerunHint(row);
			})
			.filter((hint) => hint !== null);
		reason = `superseded run cancelled and not replaced: ${rerunHints.join(", ")}`;
	} else if (failingGatingRows.length > 0) {
		exitCode = EXIT_FAILURE;
		kind = "failed";
		reason = `gating check(s) completed with a non-success conclusion: ${failingGatingRows.map((row) => `${row.name} (${row.conclusion})`).join(", ")}`;
	} else if (pendingGatingRows.length > 0) {
		exitCode = EXIT_PENDING;
		kind = "pending";
		if (anyAbsent) {
			// Both messages below are reachable only here: CONFLICTING was
			// answered above (its reason must never be rewritten), and a
			// failing/cancelled/infra-rerun state outranks "absent". #3694.
			const context =
				typeof absentContext === "function" ? absentContext() : absentContext;
			const approvalRuns = Array.isArray(context?.actionRequiredRuns)
				? context.actionRequiredRuns
				: [];
			// #3861: a re-arm is authorized ONLY by a POSITIVE "no ci.yml run
			// for the head" answer. A registered run, an unreadable lookup, and a
			// missing head-run answer (the REST transport has no run context)
			// are all NOT evidence of a missing run, so none of them prints the
			// re-arm advice: neither the absent-rearm line nor the fallback's
			// conditional retarget clause.
			const headRun = context?.headRun ?? null;
			const rearmAuthorized = headRun?.state === "none";
			if (approvalRuns.length > 0) {
				kind = "fork-approval";
				reason = formatForkApprovalReason(context.repository, approvalRuns);
			} else if (
				rearmAuthorized &&
				context?.autoMerge === true &&
				context.absentMinutes >= ABSENT_REQUIRED_REARM_MINUTES
			) {
				kind = "absent-rearm";
				reason = formatAbsentRequiredReason(context.sha, context.absentMinutes);
			} else if (
				headRun &&
				context?.autoMerge === true &&
				context.absentMinutes >= ABSENT_REQUIRED_REARM_MINUTES
			) {
				// A run is registered, or the lookup failed: name that fact
				// instead of the re-arm advice #3861 removed.
				reason =
					headRun.state === "unknown"
						? formatAbsentRunUnknownReason(context.sha, context.absentMinutes)
						: formatAbsentRunReason({
								state: headRun.state,
								id: headRun.id,
								ageMinutes: headRun.ageMinutes,
								sha: context.sha,
							});
			} else if (mergeable == null) {
				reason =
					"one or more required checks are absent and there is no PR context (bare-SHA target) to confirm they are not merge-conflicted; treating as pending, not DIRTY -- pass a PR number, or wait for CI to register";
			} else if (rearmAuthorized) {
				reason = `one or more required checks are absent but the PR is not merge-conflicted (mergeable=${mergeable}); CI likely hasn't registered yet -- treating as pending, not DIRTY -- if the base was retargeted after this PR opened, push a commit or close/reopen to re-arm ci.yml`;
			} else if (headRun && headRun.state !== "unknown") {
				// A registered run below the re-arm threshold, or with auto-merge
				// off: name it instead of the retarget clause (the same fact the
				// over-threshold branch prints).
				reason = formatAbsentRunReason({
					state: headRun.state,
					id: headRun.id,
					ageMinutes: headRun.ageMinutes,
					sha: context.sha,
				});
			} else {
				// An unreadable lookup, a missing head-run answer, or no context:
				// the quiet pending text, with no re-arm advice.
				reason = `one or more required checks are absent but the PR is not merge-conflicted (mergeable=${mergeable}); CI likely hasn't registered yet -- treating as pending, not DIRTY`;
			}
		} else {
			// Only non-completed rows reach this branch; latest cancellations have
			// already been reported with an explicit rerun command above.
			const stillRunning = pendingGatingRows.filter(
				(row) => row.status !== "completed",
			);
			const parts = [];
			if (stillRunning.length > 0) {
				parts.push(
					`still queued or in progress: ${stillRunning.map((row) => row.name).join(", ")}`,
				);
			}
			reason = `gating check(s) ${parts.join("; ")}`;
		}
	} else {
		// #3754: the head's own gating checks are green, which only makes the PR
		// ELIGIBLE for the merge queue. Read lazily (only here, so a red or
		// pending head costs no extra call): a PR in the queue is waiting on the
		// `merge_group` run, and a PR whose queue run failed was ejected.
		const queue =
			typeof queueContext === "function" ? queueContext() : queueContext;
		if (queue?.entry) {
			exitCode = EXIT_PENDING;
			kind = "in-queue";
			reason = formatInQueueReason(queue.entry);
		} else if (queue?.failedRows?.length > 0) {
			exitCode = EXIT_FAILURE;
			kind = "failed";
			queueFailedRows = queue.failedRows;
			reason = formatQueueFailedReason(queue);
		} else {
			exitCode = EXIT_SUCCESS;
			kind = "success";
			reason =
				noiseRows.length > 0
					? `post-merge noise, not a failure: ${noiseRows.map((row) => row.name).join(", ")} could not fetch refs/pull/N/merge after the PR merged; every other gating check concluded success`
					: "every gating check concluded success";
		}
	}
	// #3801: the heavy advisory jobs do not exist as check-runs until the
	// required checks passed (ci.yml's `heavy-gate`). Each absent one is listed
	// with its REAL state, read off the gate's own check-run, both while the
	// verdict is pending and after it turns success (when the merger starts
	// reading): PENDING while the gate has not concluded or has just passed,
	// NOT RUN when the gate was skipped or went red. A head with neither the
	// gate nor the `changes` row is of an older workflow, which this must not
	// relabel, so it lists them only while pending. The rows are advisory
	// (`gating: false`), so no exit code reads them.
	const gate = byName.get(HEAVY_GATE_CHECK);
	const gatedShape = gate !== undefined || byName.has(CHANGES_CHECK);
	const deferredState = deferredStateFor(gate);
	const deferredRows =
		gatedShape || kind === "pending"
			? DEFERRED_ADVISORY_CHECKS.filter((name) => !byName.has(name)).map(
					(name) => ({ ...buildRow(name), deferred: true, ...deferredState }),
				)
			: [];
	return {
		exitCode,
		rows: [...rows, ...deferredRows],
		reason,
		mergeState,
		kind,
		failingRows: queueFailedRows ?? failingGatingRows,
		cancelledRows: cancelledLatestRows,
	};
}

/**
 * A check-run id is the Actions job id, not the workflow run id accepted by
 * `gh run rerun`. GitHub's check-run details URL carries both identities, so
 * keep the existing check-runs read as the only resolution seam. The job
 * fallback is admitted only when that same URL proves its job segment matches
 * the check-run id.
 */
export function rerunArgsFor(row) {
	const detailsUrl = typeof row?.detailsUrl === "string" ? row.detailsUrl : "";
	const runId = detailsUrl.match(/\/actions\/runs\/(\d+)(?:\/|$)/)?.[1];
	if (runId) return ["run", "rerun", runId];

	const jobId = detailsUrl.match(/\/job\/(\d+)(?:\/|$)/)?.[1];
	if (jobId && String(row?.id) === jobId)
		return ["run", "rerun", "--job", jobId];
	return null;
}

export function formatRerunHint(row) {
	const detailsUrl = typeof row?.detailsUrl === "string" ? row.detailsUrl : "";
	const rerun = rerunArgsFor(row);
	if (rerun) return `rerun ${rerun.at(-1)} (gh ${rerun.join(" ")})`;

	return `${row?.name ?? "unknown check"} cannot be rerun via gh (not a GitHub Actions job; details: ${detailsUrl || "unavailable"})`;
}

/** Fixed-column table: CHECK / STATUS / CONCLUSION / URL. Exported for tests
 * so the rendering itself is pinned, not just eyeballed from CLI output. */
export function formatVerdictTable(rows) {
	const header = ["CHECK", "STATUS", "CONCLUSION", "URL"];
	const data = rows.map((row) => [
		row.name,
		row.present
			? (row.status ?? "unknown")
			: row.deferred
				? row.deferredState
				: "absent",
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
 * #2935: call `call(remainingMs)` and, while a `deadline` is set, wait out a
 * failure `isTransientGhError` accepts -- 30 s, doubling to 5 min, never
 * sleeping past the deadline -- with one `onRetry` line per retry. The
 * failure is rethrown (exit 70) at once without a deadline (a one-shot
 * read), for a non-transient error, or once the deadline has passed. Shared
 * by the check-runs poll and `run()`'s startup lookups so every `gh` read
 * under `--wait` spends one budget, not one each.
 */
export async function callWithTransientRetry(
	call,
	{
		deadline,
		now = () => Date.now(),
		sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		onRetry = () => {},
	} = {},
) {
	let backoffSeconds = TRANSIENT_BACKOFF_INITIAL_SECONDS;
	for (;;) {
		const remainingMs =
			deadline === undefined ? undefined : Math.max(0, deadline - now());
		try {
			return await call(remainingMs);
		} catch (error) {
			if (!remainingMs || !isTransientGhError(error)) throw error;
			const delayMs = Math.min(backoffSeconds * 1000, remainingMs);
			onRetry(
				`transient gh error, retrying in ${Math.ceil(delayMs / 1000)}s (${Math.ceil(remainingMs / 1000)}s of --wait left): ${firstLine(error)}`,
			);
			await sleepImpl(delayMs);
			backoffSeconds = Math.min(
				backoffSeconds * 2,
				TRANSIENT_BACKOFF_MAX_SECONDS,
			);
		}
	}
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
 * #2935: under a `--wait` budget, a `fetchPayload` failure that
 * `isTransientGhError` accepts is not fatal: the loop sleeps (30 s, doubling
 * to 5 min, never past the deadline), reports one `onRetry` line, and reads
 * again. The failure is rethrown -- exit 70 -- once the deadline has passed,
 * or at once for a one-shot read or a non-transient error.
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
	absentContext = null,
	queueContext = null,
	sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	now = () => Date.now(),
	onRetry = () => {},
}) {
	const capSeconds = resolveWaitCapSeconds(waitSeconds);
	const deadline = now() + capSeconds * 1000;
	let verdict;
	let polls = 0;
	for (;;) {
		const payload = await callWithTransientRetry(fetchPayload, {
			deadline: capSeconds > 0 ? deadline : undefined,
			now,
			sleepImpl,
			onRetry,
		});
		const currentRerunState =
			typeof rerunState === "function" ? rerunState() : rerunState;
		verdict = computeVerdict(
			payload,
			requiredChecks,
			mergeable,
			classification,
			currentRerunState,
			absentContext,
			null,
			queueContext,
		);
		polls += 1;
		if (verdict.exitCode !== EXIT_PENDING) break;
		if (now() >= deadline) break;
		await sleepImpl(POLL_INTERVAL_SECONDS * 1000);
	}
	return { verdict, polls };
}

function firstLine(error) {
	const stderr = error?.stderr == null ? "" : String(error.stderr).trim();
	return (stderr || String(error?.message ?? error)).split("\n")[0];
}

// ---------------------------------------------------------------------------
// Thin `gh` shell. No fetch, no token, no GITHUB_* env var -- `gh` on PATH is
// the only dependency (acceptance criterion), and every function below takes
// an injectable `ghExec` so the CLI orchestration stays testable too.
// ---------------------------------------------------------------------------

function gh(args, { timeoutMs = DEFAULT_GH_TIMEOUT_MS, maxBuffer } = {}) {
	// `timeout` + `killSignal` (F4): with neither, a hung `gh` process parks
	// this call -- and everything waiting on it, including `--wait`'s own
	// budget -- indefinitely. A probe measured a hung `gh` blocking 51s past
	// a 30s `--wait` budget before this fix.
	return execFileSync("gh", args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: timeoutMs,
		killSignal: "SIGTERM",
		...(maxBuffer ? { maxBuffer } : {}),
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
		try {
			const parsed = JSON.parse(raw);
			return { sha: parsed.headRefOid, mergeable: parsed.mergeable ?? null };
		} catch (error) {
			throw new Error(
				`could not parse the PR view JSON for ${target}: ${error instanceof Error ? error.message : error}`,
			);
		}
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
			ghExec(
				["pr", "view", String(target), "--json", "headRefOid,labels,comments"],
				{ timeoutMs },
			),
		);
		const currentSha = parsed.headRefOid;
		if (typeof currentSha !== "string") return undefined;
		const currentMarker = (
			Array.isArray(parsed.comments) ? parsed.comments : []
		)
			.map((comment) => (typeof comment?.body === "string" ? comment.body : ""))
			.map((body) =>
				/ci-classifier:\s+(real|infra-kill|infra-net)[^\n]*<!--\s*ci-classifier:sha=([0-9a-fA-F]{7,40})\s/.exec(
					body,
				),
			)
			.reverse()
			.find((match) => match?.[2] === currentSha);
		const classification = currentMarker
			? currentMarker[1] === "real"
				? "real"
				: "infra-kill"
			: null;
		return classification;
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
	const checkRuns = [];
	let totalCount;
	let page = 1;
	for (;;) {
		const raw = ghExec(
			[
				"api",
				`repos/${repository}/commits/${sha}/check-runs?per_page=100&page=${page}`,
			],
			{ timeoutMs },
		);
		let payload;
		try {
			payload = JSON.parse(raw);
		} catch (error) {
			throw new Error(
				`could not parse the check-runs JSON for ${sha} (page ${page}): ${error instanceof Error ? error.message : error}`,
			);
		}
		if (typeof payload?.total_count === "number")
			totalCount = payload.total_count;
		if (Array.isArray(payload?.check_runs))
			checkRuns.push(...payload.check_runs);
		if (
			typeof totalCount !== "number" ||
			checkRuns.length >= totalCount ||
			payload?.check_runs?.length === 0
		)
			break;
		page += 1;
	}
	return { total_count: totalCount ?? checkRuns.length, check_runs: checkRuns };
}

/** A run state the absent-required message can name (#3861). `unknown` is a
 * failed or unrecognized lookup: it never authorizes the re-arm advice. */
function summarizeHeadRun(runs) {
	const ciRuns = runs.filter(
		(run) => run?.name === CI_WORKFLOW_NAME && run?.event !== "merge_group",
	);
	if (ciRuns.length === 0)
		return { state: "none", id: null, startedAtMs: null };
	const sorted = [...ciRuns].sort(
		(a, b) =>
			Number(a.run_attempt ?? 1) - Number(b.run_attempt ?? 1) ||
			Date.parse(a.created_at ?? "") - Date.parse(b.created_at ?? ""),
	);
	const latest = sorted.at(-1);
	const startedAtMs = Date.parse(
		latest?.run_started_at ?? latest?.created_at ?? "",
	);
	return {
		state: runStateFromStatus(String(latest?.status ?? ""), latest?.conclusion),
		id: latest?.id ?? null,
		startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : null,
	};
}

function runStateFromStatus(status, conclusion) {
	if (status === "in_progress") return "in_progress";
	if (status === "queued" || status === "waiting" || status === "requested")
		return "queued";
	if (status === "completed")
		return conclusion === "cancelled" ? "cancelled" : "completed";
	return "unknown";
}

/**
 * The head's workflow runs, read once (#3861): the fork-approval runs AND the
 * `ci.yml` run state the absent-required message needs to decide whether a
 * re-arm is even meaningful. The single `actions/runs?head_sha=` read is
 * already the fork-approval seam (#3694); this reuses it rather than adding a
 * second call. A failed read fails open to an empty approval list and an
 * `unknown` run state, so an unreadable lookup never authorizes the re-arm
 * advice; `failOpen: false` rethrows for `--approve-fork`.
 */
export function fetchHeadRuns(
	repository,
	sha,
	ghExec = gh,
	timeoutMs = DEFAULT_GH_TIMEOUT_MS,
	failOpen = true,
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
		if (!Array.isArray(payload?.workflow_runs)) {
			// #3861 F1: a 200 that violates the documented shape (no
			// `workflow_runs` array) is a contract violation, not the empty
			// success answer; the catch below fails open to `unknown`, which
			// never authorizes a re-arm. A genuine "no run for the head" answer
			// carries `workflow_runs: []` (verified live), which the array path
			// below still resolves to `none`.
			throw new Error(
				"malformed actions/runs response: workflow_runs is not an array",
			);
		}
		const runs = payload.workflow_runs.filter((run) => run?.head_sha === sha);
		return {
			actionRequiredRuns: runs
				.filter((run) => run?.conclusion === "action_required")
				.map((run) => ({ id: run.id })),
			headRun: summarizeHeadRun(runs),
		};
	} catch (error) {
		// The verdict text fails open to "unknown"; an approval must not.
		if (!failOpen) throw error;
		return {
			actionRequiredRuns: [],
			headRun: { state: "unknown", id: null, startedAtMs: null },
		};
	}
}

/** Fork-approval runs for `sha`. GitHub reports one as `status: "completed"`
 * with `conclusion: "action_required"` -- never `status: "action_required"` --
 * and its head has no CI check-run rows at all (#3694). */
export function fetchActionRequiredRuns(
	repository,
	sha,
	ghExec = gh,
	timeoutMs = DEFAULT_GH_TIMEOUT_MS,
	failOpen = true,
) {
	return fetchHeadRuns(repository, sha, ghExec, timeoutMs, failOpen)
		.actionRequiredRuns;
}

/**
 * What the absent-required message needs beyond the check-run rows (#3694):
 * whether auto-merge is armed on the PR, and when the head was pushed: the
 * earliest `created_at` among the head's check suites. Every app subscribed
 * to pushes opens a suite within seconds of the push (PR #3679's head: 14
 * suites, the first 22 s after the push, a rerun's suite 20 min later), so the
 * earliest is the push clock. The commit date is not: an old commit pushed
 * just now would read as long-absent at once (PR #3697 round 2, finding A).
 * Every read fails open to "unknown" -- no auto-merge, no push time -- which
 * selects the original, quieter text. A caller polling under `--wait` reads
 * again every poll and passes the push time back once it is finite
 * (`knownPushedMs`), so a first poll before any check suite exists cannot pin
 * the whole window on the quiet text (#3700, the #3697 round-3 verify).
 */
export function fetchAutoMergeAge(
	target,
	repository,
	sha,
	ghExec = gh,
	timeoutMs = DEFAULT_GH_TIMEOUT_MS,
	knownPushedMs = null,
) {
	let autoMerge = false;
	if (isPrNumber(target)) {
		try {
			autoMerge = Boolean(
				JSON.parse(
					ghExec(["pr", "view", String(target), "--json", "autoMergeRequest"], {
						timeoutMs,
					}),
				)?.autoMergeRequest,
			);
		} catch {
			/* unknown => not armed */
		}
	}
	// No suite yet (`Math.min()` is Infinity) or an undated one (NaN) never
	// reaches the threshold, so both read as the quiet text, like a failed read.
	// A push time the caller already holds is final (#3700): only an unknown one
	// is read again.
	let pushedMs = Number.isFinite(knownPushedMs) ? knownPushedMs : null;
	if (pushedMs === null) {
		try {
			pushedMs = Math.min(
				...JSON.parse(
					ghExec(
						[
							"api",
							`repos/${repository}/commits/${sha}/check-suites?per_page=100`,
						],
						{ timeoutMs },
					),
				).check_suites.map((suite) => Date.parse(suite.created_at)),
			);
		} catch {
			/* unknown => no age */
		}
	}
	return { autoMerge, pushedMs };
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
			.filter((run) => run?.name === CI_WORKFLOW_NAME && run?.head_sha === sha)
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

// ---------------------------------------------------------------------------
// #3754: the GitHub merge queue. Once enabled, a PR whose head checks are green
// is ENQUEUED (`gh pr merge --auto`), and the queue tests it merged onto the
// latest master in a `gh-readonly-queue/<base>/pr-<N>-<sha>` ref via a
// `merge_group` workflow run. Three states the head's check-runs cannot show:
// in the queue (waiting, not absent and not done), ejected after a failed
// queue run (a FAIL event), and neither (plain eligible/success).
// ---------------------------------------------------------------------------

const MERGE_QUEUE_STATE_QUERY =
	"query($owner:String!,$name:String!,$branch:String!,$number:Int!){repository(owner:$owner,name:$name){mergeQueue(branch:$branch){id} pullRequest(number:$number){isInMergeQueue mergeQueueEntry{state position}}}}";

function formatInQueueReason(entry) {
	const position = Number.isFinite(entry?.position)
		? `, position ${entry.position}`
		: "";
	// F1: the entry is read defensively now that `isInMergeQueue` (not the
	// `mergeQueueEntry` object) decides queue membership, so a non-string state
	// renders as the default rather than as its own stringified junk.
	const state =
		typeof entry?.state === "string" ? entry.state.toLowerCase() : "queued";
	return `in the merge queue (${state}${position}): every gating check on the head passed and the merge_group run decides the merge -- waiting is correct; it is neither absent nor done`;
}

function formatQueueFailedReason(queue) {
	return `merge queue run failed and ejected the PR: ${queue.failedRuns
		.map((failed) => failed.url)
		.join(
			", ",
		)} -- failing: ${queue.failedRows.map((row) => row.name).join(", ")}`;
}

function graphqlFieldArgs(query, fields) {
	return [
		"api",
		"graphql",
		"-f",
		`query=${query}`,
		...Object.entries(fields).flatMap(([name, value]) => [
			typeof value === "number" ? "-F" : "-f",
			`${name}=${value}`,
		]),
	];
}

/**
 * One GraphQL read answering both questions: does `PROTECTED_BRANCH` have a
 * merge queue, and is this PR in it. `null` when unreadable or not a PR
 * target: every caller then behaves as before the queue existed, and a
 * repository without a queue costs exactly this one read (#3694's "a healthy
 * head costs nothing extra" guard, which the queue must not break).
 */
export function readMergeQueueState(
	target,
	repository,
	ghExec = gh,
	timeoutMs = DEFAULT_GH_TIMEOUT_MS,
) {
	if (!isPrNumber(target)) return null;
	const [owner, name] = String(repository).split("/");
	try {
		const found = JSON.parse(
			ghExec(
				graphqlFieldArgs(MERGE_QUEUE_STATE_QUERY, {
					owner,
					name,
					branch: PROTECTED_BRANCH,
					number: Number(target),
				}),
				{ timeoutMs },
			),
		)?.data?.repository;
		if (!found) return null;
		const pullRequest = found.pullRequest;
		// #3754 F1: `isInMergeQueue` is the authoritative state; the entry is a
		// detail read defensively. Gating the entry on `mergeQueueEntry` (a
		// nullable object the schema may omit) turned a queued PR into a green
		// success when the flag was true and the object absent.
		return {
			enabled: Boolean(found.mergeQueue),
			entry: pullRequest?.isInMergeQueue
				? {
						state: pullRequest.mergeQueueEntry?.state ?? null,
						position: pullRequest.mergeQueueEntry?.position ?? null,
					}
				: null,
		};
	} catch {
		return null;
	}
}

/**
 * The failed `merge_group` runs of this PR's LATEST queue attempt that began
 * after the head was pushed, as gating rows (one per failed job, with its job
 * URL, so `readFailureDetails` names the failing tests exactly as for a PR
 * run). A queue attempt's branch is `gh-readonly-queue/<base>/pr-<N>-<sha>`;
 * a run that began before the push is an earlier head's ejection. Fails open
 * to "none".
 */
export function fetchFailedQueueRuns(
	target,
	repository,
	pushedMs,
	ghExec = gh,
	timeoutMs = DEFAULT_GH_TIMEOUT_MS,
) {
	const none = { failedRuns: [], failedRows: [] };
	if (!isPrNumber(target) || !Number.isFinite(pushedMs)) return none;
	const prefix = `gh-readonly-queue/${PROTECTED_BRANCH}/pr-${Number(target)}-`;
	try {
		const runs = (
			JSON.parse(
				ghExec(
					[
						"api",
						`repos/${repository}/actions/runs?event=merge_group&status=completed&per_page=50`,
					],
					{ timeoutMs },
				),
			).workflow_runs ?? []
		)
			.filter(
				(candidate) =>
					String(candidate?.head_branch ?? "").startsWith(prefix) &&
					candidate.conclusion === "failure" &&
					Date.parse(candidate.created_at) >= pushedMs,
			)
			.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
		const latestBranch = runs[0]?.head_branch;
		const failedRuns = runs
			.filter((candidate) => candidate.head_branch === latestBranch)
			.map((candidate) => ({ id: candidate.id, url: candidate.html_url }));
		const failedRows = failedRuns.flatMap((failed) =>
			(
				JSON.parse(
					ghExec(
						[
							"api",
							`repos/${repository}/actions/runs/${failed.id}/jobs?per_page=100`,
						],
						{ timeoutMs },
					),
				).jobs ?? []
			)
				.filter((job) => job?.conclusion === "failure")
				.map((job) => ({
					name: job.name,
					present: true,
					id: job.id,
					status: "completed",
					conclusion: "failure",
					url: job.html_url,
					detailsUrl: job.html_url,
					gating: true,
				})),
		);
		return failedRows.length > 0 ? { failedRuns, failedRows } : none;
	} catch {
		return none;
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
/**
 * The pure `required_status_checks` -> names extraction, shared (#3497) by
 * both the `gh api` path above's doc comment and the REST path below --
 * they read the identical branch-protection response shape, differing only
 * in how the bytes got here (`gh` shelling out vs. an authenticated
 * `fetch`). Split out of `resolveRequiredCheckNames` unchanged: same inputs,
 * same `null`-or-string-array output, so its existing tests keep passing
 * against this call-through.
 */
export function extractRequiredCheckNames(requiredStatusChecks) {
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
}

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
		return extractRequiredCheckNames(JSON.parse(raw)?.required_status_checks);
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// #3700: what the orchestrator used to read by hand once a gating job failed:
// the failed STEP, the failing test lines, and whether a rerun can help. All
// of it reads through the same `ghExec` seam as everything above.
// ---------------------------------------------------------------------------

/** Most FAIL / AssertionError lines one failed job prints; the rest are
 * counted, not listed (a mass failure would otherwise print the whole log). */
export const MAX_FAILURE_LINES = 20;

/** `execFileSync` defaults to a 1 MiB buffer and a Unit tests log is ~450 KB
 * on a good day: without this a big red log ENOBUFS and prints no failure. */
export const JOB_LOG_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * What one job log says (the lines the orchestrator pulled out by hand from
 * `gh api --allow-escape-sequences .../jobs/<id>/logs`): the vitest `FAIL`
 * lines and `AssertionError` lines (the `##[error]` annotation vitest repeats
 * the message in starts with `#`, so it never matches), the `Test Files` /
 * `Tests` summary, the merge
 * commit's base from the checkout's `HEAD is now at <sha> Merge <head> into
 * <base>` line, and whether the checkout could not fetch the PR's merge ref.
 * `FAIL` must START the line: a passing test titled "does not FAIL when ..."
 * is not a failure (fabricated-fail-in-passing-title.composite.log).
 */
export function parseJobLog(logText) {
	const failures = [];
	const summary = [];
	let mergeBase = null;
	let missingMergeRefPr = null;
	for (const raw of String(logText ?? "").split("\n")) {
		const line = stripLineTimestamps(stripAnsi(raw)).trimEnd();
		const text = line.trim();
		if (BARE_FAIL_LINE.test(line) || ASSERTION_LINE.test(line)) {
			failures.push(text);
		} else if (/^(?:Test Files|Tests)\s+\d/.test(text)) {
			summary.push(text);
		}
		const base =
			/HEAD is now at \S+ Merge [0-9a-f]{40} into ([0-9a-f]{40})$/.exec(line);
		if (base) mergeBase = base[1];
		missingMergeRefPr =
			/couldn't find remote ref refs\/pull\/(\d+)\/merge/.exec(line)?.[1] ??
			missingMergeRefPr;
	}
	return {
		failures: failures.slice(0, MAX_FAILURE_LINES),
		extraFailures: Math.max(0, failures.length - MAX_FAILURE_LINES),
		summary,
		mergeBase,
		missingMergeRefPr,
	};
}

/**
 * One failed gating row's job: the failed step names (`gh api
 * repos/<r>/actions/jobs/<id>`) plus its parsed log. The job id comes from the
 * check-run's own details URL (a check-run id is a job id only for Actions
 * jobs; a third-party check has neither). Every read fails open to a `note`,
 * never a throw: a missing log must not turn a red verdict into exit 70.
 */
export function readFailedJob(
	repository,
	row,
	ghExec = gh,
	timeoutMs = DEFAULT_GH_TIMEOUT_MS,
) {
	const detail = {
		name: row.name,
		rowId: row.id,
		jobId: null,
		steps: [],
		...parseJobLog(""),
		note: null,
	};
	detail.jobId =
		(typeof row.detailsUrl === "string"
			? row.detailsUrl.match(/\/job\/(\d+)(?:\/|$)/)?.[1]
			: null) ?? null;
	if (!detail.jobId) {
		detail.note = "not a GitHub Actions job: no log to read";
		return detail;
	}
	try {
		const job = JSON.parse(
			ghExec(["api", `repos/${repository}/actions/jobs/${detail.jobId}`], {
				timeoutMs,
			}),
		);
		detail.steps = (Array.isArray(job?.steps) ? job.steps : [])
			.filter((step) => step?.conclusion === "failure")
			.map((step) => String(step.name));
		Object.assign(
			detail,
			parseJobLog(
				ghExec(
					[
						"api",
						"--allow-escape-sequences",
						`repos/${repository}/actions/jobs/${detail.jobId}/logs`,
					],
					{ timeoutMs, maxBuffer: JOB_LOG_MAX_BUFFER },
				),
			),
		);
	} catch (error) {
		detail.note = `could not read the job: ${firstLine(error)}`;
	}
	return detail;
}

function readPrState(target, ghExec, timeoutMs) {
	try {
		return (
			JSON.parse(
				ghExec(["pr", "view", String(target), "--json", "state"], {
					timeoutMs,
				}),
			)?.state ?? null
		);
	} catch {
		return null;
	}
}

function readMasterSha(repository, ghExec, timeoutMs) {
	try {
		return (
			JSON.parse(
				ghExec(["api", `repos/${repository}/branches/${PROTECTED_BRANCH}`], {
					timeoutMs,
				}),
			)?.commit?.sha ?? null
		);
	} catch {
		return null;
	}
}

/**
 * Failure detail plus remedy hints for a FAILED verdict's rows (#3700):
 *  - post-merge noise: a job whose checkout step could not fetch this PR's
 *    `refs/pull/N/merge`, with no failing test line, on a PR that is MERGED
 *    (the ref is gone; the job never ran). Only MERGED excuses it: on an open PR the same line means the PR is
 *    conflicted, which is real. The ids come back so the caller recomputes the
 *    verdict without them.
 *  - update-branch: the failed run's merge commit was built on a base that is
 *    no longer master's head. `gh run rerun` replays that old merge commit
 *    (#3660), so a rerun cannot pick up anything master gained since.
 */
export function readFailureDetails({
	rows,
	target,
	repository,
	ghExec = gh,
	timeoutMs = DEFAULT_GH_TIMEOUT_MS,
}) {
	const details = rows.map((row) =>
		readFailedJob(repository, row, ghExec, timeoutMs),
	);
	const hints = [];
	let noiseRowIds = null;
	if (isPrNumber(target)) {
		// The excuse is tied to the failure it excuses: the job's own failed step
		// is the checkout, it printed no failing test line, and the ref it could
		// not fetch is THIS PR's. A test that quotes the ref text in its output
		// (this repo's own fixtures do) must not turn a red run green.
		const noisy = details.filter(
			(detail) =>
				detail.missingMergeRefPr === String(target).trim() &&
				detail.failures.length === 0 &&
				detail.steps.length > 0 &&
				detail.steps.every((step) => step.startsWith("Run actions/checkout")),
		);
		if (
			noisy.length > 0 &&
			readPrState(target, ghExec, timeoutMs) === "MERGED"
		) {
			noiseRowIds = new Set(noisy.map((detail) => detail.rowId));
		}
		const mergeBase = details.find((detail) => detail.mergeBase)?.mergeBase;
		const masterSha = mergeBase
			? readMasterSha(repository, ghExec, timeoutMs)
			: null;
		if (mergeBase && masterSha && masterSha !== mergeBase) {
			const moved = `master moved since this failure's merge base (${mergeBase.slice(0, 9)} -> ${masterSha.slice(0, 9)})`;
			// #3754: with a merge queue on master the queue tests the PR against the
			// latest master itself, and an update-branch push re-runs every check
			// (and ejects a queued PR): the update-branch remedy is moot.
			hints.push(
				readMergeQueueState(target, repository, ghExec, timeoutMs)?.enabled
					? `${moved}: the merge queue tests the PR on the latest master, so do not update-branch ${target} (it re-runs every check and ejects a queued PR); fix the failure and let the queue run`
					: `${moved}: gh run rerun replays the old merge commit and cannot pick up what master gained -- use gh pr update-branch ${target}`,
			);
		}
	}
	return { details, hints, noiseRowIds };
}

/** The lines `run()` prints for a failed verdict's `details` and `hints`, and
 * `--watch-open` repeats under its event line. */
export function formatFailureLines(verdict) {
	const lines = [];
	for (const detail of verdict.details ?? []) {
		if (detail.note && !detail.jobId) {
			lines.push(`${detail.name}: ${detail.note}`);
			continue;
		}
		lines.push(
			`${detail.name} (job ${detail.jobId}): failed step: ${detail.steps.length > 0 ? detail.steps.join(", ") : "unknown"}${detail.note ? ` (${detail.note})` : ""}`,
		);
		for (const failure of detail.failures) lines.push(`  ${failure}`);
		if (detail.extraFailures > 0)
			lines.push(`  ... and ${detail.extraFailures} more failing lines`);
		for (const line of detail.summary) lines.push(`  ${line}`);
	}
	for (const hint of verdict.hints ?? []) lines.push(`hint: ${hint}`);
	return lines;
}

/** Gating rows and advisory rows reported apart (#3700): an advisory red
 * (mutation, OSV, PR body) is information that never gates, and it must not
 * read as the reason a verdict is red -- nor vanish into the table. */
export function formatGatingSplit(rows, failingRows = []) {
	const label = (row) => `${row.name} (${row.conclusion})`;
	const gating = rows.filter((row) => row.gating);
	const advisory = rows.filter((row) => !row.gating);
	const reds = advisory.filter(
		(row) =>
			row.present &&
			row.status === "completed" &&
			isBlockingConclusion(row.conclusion),
	);
	return [
		`Gating: ${gating.length} checks, ${failingRows.length} failing${failingRows.length > 0 ? `: ${failingRows.map(label).join(", ")}` : ""}`,
		`Advisory (never gates): ${advisory.length} checks, ${reds.length} red${reds.length > 0 ? `: ${reds.map(label).join(", ")}` : ""}`,
	];
}

const MUTATION_CHECK = "mutation (advisory)";
const MUTATION_PREFIX = "MUTATION (advisory, never gates):";

/** The Mutation diff sticky comment's own lines (scripts/lib/
 * mutation-report-render.mjs): the head it covers, and what it says about it. */
function readStickyBody(body) {
	// Every form is anchored on a line start: a survivor cell quotes source text,
	// and this repo's renderer literals are source text (#3779 round 2).
	const head =
		/^- \*\*Head:\*\* `([0-9a-f]{7,40})`/m.exec(body)?.[1] ??
		/^\*\*Stale\.\*\* This head \(`([0-9a-f]{7,40})`\)/m.exec(body)?.[1] ??
		null;
	let count = "unparsed comment";
	if (/^\*\*Stale\.\*\*/m.test(body))
		count = "no report for that head (crash, cancel or time cap)";
	else if (/^\*\*0 mutants evaluated\.\*\*/m.test(body))
		count = "0 mutants evaluated (not a clean pass)";
	else if (/^\*\*Incomplete run\.\*\*/m.test(body))
		count = "incomplete run (not a clean pass)";
	else if (/^#### Survivors \(\d+\)$/m.test(body))
		count = `${/^#### Survivors \((\d+)\)$/m.exec(body)[1]} survivors`;
	else if (/^No survivors\.$/m.test(body)) count = "0 survivors";
	const flags = [
		/^\*\*Partial run\*\*/m.test(body) ? ", partial run" : "",
		/^\*\*Score:.*truncated test population/m.test(body)
			? ", truncated test population"
			: "",
	].join("");
	return { head, count: `${count}${flags}` };
}

/**
 * The one advisory `MUTATION` line (#3779): the Mutation diff comment's
 * survivor count and the head it covers; STALE when that head is not the PR's
 * head, PENDING when there is no comment or the job has not reported on this
 * head. Information only -- `computeVerdict` never sees it, so it cannot move
 * an exit code (the advisory split above, #3700).
 *
 * @param {Array<{id: number, body?: string, user?: {login?: string}}>} comments
 * @param {string} prHead
 * @param {Array<{name: string, status: string|null, conclusion?: string|null}>} rows
 */
export function formatMutationLine(comments, prHead, rows = []) {
	const found = rows.find((row) => row.name === MUTATION_CHECK);
	// #3801 (verify r2 V2): once the heavy gate is red or skipped, GitHub writes a
	// completed `skipped` check-run for the mutation job, so it is never an absent
	// row. Name the cause from the gate's row the way an absent row does.
	const gate = rows.find((row) => row.name === HEAVY_GATE_CHECK);
	const job =
		found?.present === true &&
		found.status === "completed" &&
		found.conclusion === "skipped" &&
		gate?.present === true &&
		gate.status === "completed"
			? {
					...found,
					deferred: true,
					...(gate.conclusion === "success"
						? {
								deferredState: "NOT RUN",
								deferredWhy:
									"the job was skipped although the heavy gate passed",
							}
						: deferredStateFor(gate)),
				}
			: found;
	const notRun = job?.deferred === true && job.deferredState === "NOT RUN";
	const inFlight = job && job.status !== "completed" && !notRun;
	const id = findStickyCommentId(comments, STICKY_MARKER);
	if (id === null)
		return notRun
			? `${MUTATION_PREFIX} NOT RUN -- ${job.deferredWhy}; no Mutation diff comment on this PR`
			: inFlight || !job
				? `${MUTATION_PREFIX} PENDING -- no Mutation diff comment on this PR yet`
				: `${MUTATION_PREFIX} no report (job ${job.conclusion}) -- no Mutation diff comment on this PR`;
	const { head, count } = readStickyBody(
		comments.find((comment) => comment.id === id)?.body ?? "",
	);
	const covers = head ?? "unknown";
	if (prHead.startsWith(covers))
		return `${MUTATION_PREFIX} ${count}, head ${covers}`;
	const prShort = prHead.slice(0, 12);
	if (notRun)
		return `${MUTATION_PREFIX} NOT RUN -- ${job.deferredWhy}; the last comment covers ${covers}, STALE (PR head is ${prShort})`;
	if (inFlight)
		return `${MUTATION_PREFIX} PENDING -- the mutation job is ${job.deferred ? job.deferredWhy : job.status} on PR head ${prShort}; the last comment covers ${covers}`;
	return `${MUTATION_PREFIX} ${count}, head ${covers}, STALE (PR head is ${prShort})`;
}

/** The PR's comments through the same `ghExec` seam as every read above; one
 * call, only for a `gh`-transport PR target, and never part of a poll. */
export function readMutationLine({
	repository,
	target,
	sha,
	rows,
	ghExec = gh,
	timeoutMs = DEFAULT_GH_TIMEOUT_MS,
}) {
	try {
		const comments = JSON.parse(
			ghExec(
				["api", `repos/${repository}/issues/${target}/comments`, "--paginate"],
				{
					timeoutMs,
					maxBuffer: JOB_LOG_MAX_BUFFER,
				},
			),
		);
		return formatMutationLine(comments, sha, rows);
	} catch (error) {
		return `${MUTATION_PREFIX} unreadable -- ${firstLine(error)}`;
	}
}

// ---------------------------------------------------------------------------
// #3497: the REST transport. Used only when the real `gh` binary is not on
// PATH (the Claude Code cloud container's own shape -- `GH_TOKEN`/
// `GITHUB_TOKEN` set, no `gh`) -- see `probeGhAvailable` and `run()` below.
// Every function here reads the SAME endpoints the `gh api` calls above hit
// (`gh api X` is itself a thin authenticated-fetch wrapper around
// `https://api.github.com/X`), so the verdict this produces is the same
// verdict the `gh` path would have produced for the same SHA -- the
// acceptance criterion is parity, not a second policy.
// ---------------------------------------------------------------------------

export const TRANSPORT_GH = "gh";
export const TRANSPORT_REST = "rest";

/**
 * Parses `owner/repo` out of a `git remote get-url origin` value -- both the
 * SSH (`git@github.com:owner/repo.git`) and HTTPS
 * (`https://github.com/owner/repo.git`) forms this repo's own clones use.
 * `gh repo view` resolves the current repository the same way (from the
 * checkout's remote), so this is the REST transport's equivalent when `gh`
 * itself cannot be asked to do it.
 */
export function parseOwnerRepoFromGitRemote(remoteUrl) {
	const match = /github\.com[:/]{1,2}([^/\s]+)\/([^/\s.]+?)(?:\.git)?\/?$/.exec(
		String(remoteUrl ?? "").trim(),
	);
	return match ? `${match[1]}/${match[2]}` : null;
}

/**
 * REST equivalent of `resolveRepository` (#3497): `gh repo view` has no REST
 * analogue that resolves "the repo of the current checkout" the way the CLI
 * does, so this reads the same fact from the checkout's own git remote
 * instead of a GitHub API call. Synchronous, like `resolveRepository`, since
 * `git remote get-url` is a local read with no network round trip.
 */
export function resolveRepositoryViaGit(execFileSyncImpl = execFileSync) {
	const url = execFileSyncImpl("git", ["remote", "get-url", "origin"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 10_000,
	}).trim();
	const repository = parseOwnerRepoFromGitRemote(url);
	if (!repository)
		throw new Error(
			`could not parse an owner/repo from git remote "origin" (${url})`,
		);
	return repository;
}

/**
 * One authenticated `fetch` against the REST API, normalized to the SAME
 * failure shapes `isTransientGhError` already understands, so `--wait`'s
 * backoff loop (#2935) works identically for both transports without any
 * change to that loop: a 5xx or connect failure carries an `.stderr` string
 * matching `TRANSIENT_GH_STDERR`'s "HTTP 5\d\d" / "error connecting to"
 * alternatives, and a `fetch` abort-timeout carries `.code === "ETIMEDOUT"`,
 * mirroring the `gh` CLI's own hung-process `ETIMEDOUT` (F4). A 4xx (auth or
 * repo error) carries an `.stderr` of "HTTP 4xx: ..." that the SAME regex
 * does NOT match, so it keeps the immediate exit 70 the `gh` path already
 * gives those.
 */
async function restGet(
	path,
	{
		token,
		fetchImpl = fetch,
		timeoutMs = DEFAULT_GH_TIMEOUT_MS,
		apiBase = resolveGithubApiBase(),
	} = {},
) {
	let response;
	try {
		response = await fetchImpl(`${apiBase}/${path}`, {
			signal: AbortSignal.timeout(timeoutMs),
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${token}`,
				"X-GitHub-Api-Version": "2022-11-28",
			},
		});
	} catch (error) {
		if (error?.name === "TimeoutError" || error?.name === "AbortError") {
			throw Object.assign(new Error(`REST request timed out: ${path}`), {
				code: "ETIMEDOUT",
			});
		}
		throw Object.assign(
			new Error(
				`REST request failed: ${path}: ${error instanceof Error ? error.message : error}`,
			),
			{
				stderr: `error connecting to api.github.com: ${error instanceof Error ? error.message : error}`,
			},
		);
	}
	const text = await response.text();
	if (!response.ok) {
		// F2 (review round 2): the status and a body excerpt now live in
		// `.message` too, not only `.stderr` -- `run()`'s outer catch prints
		// only `error.message` (never `.stderr`), so a bare "GitHub REST API
		// error for <path>" with no status was indistinguishable from any
		// other REST failure. This is what made F1's 401 opaque: the printed
		// line never said "401". Probed: the token is never in this excerpt
		// (GitHub's own error bodies never echo the Authorization header).
		const excerpt = text.slice(0, 300);
		throw Object.assign(
			new Error(
				`GitHub REST API error for ${path}: HTTP ${response.status}: ${excerpt}`,
			),
			{ stderr: `HTTP ${response.status}: ${excerpt} (${path})` },
		);
	}
	if (text.length === 0) return {};
	try {
		return JSON.parse(text);
	} catch (error) {
		// A non-JSON body from an `application/vnd.github+json` request is a
		// contract violation, not an empty answer; name the path so `run()`'s
		// catch prints which call broke (AGENTS.md shape 13).
		throw Object.assign(
			new Error(
				`GitHub REST API returned invalid JSON for ${path}: ${error instanceof Error ? error.message : error}`,
			),
			{ stderr: `invalid JSON from ${path} (HTTP ${response.status})` },
		);
	}
}

/**
 * GitHub's REST `mergeable`/`mergeable_state` fields down to the
 * three-value set `computeVerdict` already understands from
 * `gh pr view --json mergeable` ("MERGEABLE", "CONFLICTING", "UNKNOWN"). Only
 * the CONFLICTING mapping matters to `computeVerdict` (its own doc comment:
 * everything else defers to the check rows) -- "clean"/"unstable"/"blocked"/
 * "unknown"/"draft"/"has_hooks" (with `mergeable` true or null) all fall
 * through to "UNKNOWN" rather than risk a wrong-direction MERGEABLE guess
 * for a state this script has never needed to distinguish.
 *
 * F6 (review round 2): `mergeable === false` ALSO maps to CONFLICTING, not
 * only `mergeable_state === "dirty"`. GitHub's REST docs document
 * `mergeable_state` as covering more values than the classic `dirty`/`clean`
 * pair (`"draft"` for an undrafted-but-unmergeable PR, `"blocked"` for one
 * held by branch protection, neither of which is a genuine merge conflict)
 * -- `mergeable: false` is the one boolean GitHub gives that means "these
 * two branches cannot be merged" regardless of which `mergeable_state`
 * string happens to be attached. Reading only `dirty` risked a stale-green
 * read on a conflicted PR reported through one of those other states, the
 * exact #2552 shape this file's `gh`-path CONFLICTING handling already
 * guards against.
 */
export function mapRestMergeableState(pullRequest) {
	if (
		pullRequest?.mergeable_state === "dirty" ||
		pullRequest?.mergeable === false
	)
		return "CONFLICTING";
	if (pullRequest?.mergeable === true) return "MERGEABLE";
	return "UNKNOWN";
}

/** REST equivalent of `resolveHeadSha` (#3497): `GET .../pulls/<n>` carries
 * both `head.sha` and `mergeable`/`mergeable_state` in one request, same as
 * the single `gh pr view` call it replaces. */
export async function restResolveHeadSha(repository, target, options = {}) {
	if (!isPrNumber(target))
		return { sha: String(target).trim(), mergeable: null };
	const pullRequest = await restGet(
		`repos/${repository}/pulls/${target}`,
		options,
	);
	return {
		sha: pullRequest?.head?.sha,
		mergeable: mapRestMergeableState(pullRequest),
	};
}

/** REST equivalent of `fetchCheckRunsPayload` (#3497): identical pagination
 * over the identical endpoint `gh api` was already calling, so the merge
 * loop below is unchanged from that function's -- only the page fetch
 * itself (`restGet` vs. `ghExec`) differs. */
export async function restFetchCheckRunsPayload(repository, sha, options = {}) {
	const checkRuns = [];
	let totalCount;
	let page = 1;
	for (;;) {
		const payload = await restGet(
			`repos/${repository}/commits/${sha}/check-runs?per_page=100&page=${page}`,
			options,
		);
		if (typeof payload?.total_count === "number")
			totalCount = payload.total_count;
		if (Array.isArray(payload?.check_runs))
			checkRuns.push(...payload.check_runs);
		if (
			typeof totalCount !== "number" ||
			checkRuns.length >= totalCount ||
			payload?.check_runs?.length === 0
		)
			break;
		page += 1;
	}
	return { total_count: totalCount ?? checkRuns.length, check_runs: checkRuns };
}

/** REST equivalent of `resolveRequiredCheckNames` (#3497): same endpoint,
 * same `extractRequiredCheckNames` parse, same `null`-on-any-failure
 * fail-open-to-the-static-allowlist contract. */
export async function restResolveRequiredCheckNames(repository, options = {}) {
	try {
		const payload = await restGet(
			`repos/${repository}/branches/${PROTECTED_BRANCH}/protection`,
			options,
		);
		return extractRequiredCheckNames(payload?.required_status_checks);
	} catch {
		return null;
	}
}

/**
 * Decides ONCE, before any repository/PR resolution, whether this run uses
 * the REST transport (#3497): only when `usesDefaultGhExec` is true -- i.e.
 * the caller left `run()`'s `ghExec` at its real default, never for an
 * injected test double, so every existing `gh`-path test (which always
 * injects its own `ghExec`) is unaffected regardless of whether the real
 * `gh` binary or a `GH_TOKEN` happen to be present in the process running
 * the suite -- AND the real `gh --version` probe fails with ENOENT
 * (confirmed missing, not merely erroring) AND a token is available. `gh`
 * present but broken some OTHER way (a permission error on the probe, say)
 * stays on the `gh` transport so the real call below reproduces that
 * failure exactly as it did before this change, rather than this function
 * guessing "missing" from an error shape `isGhMissingError` does not
 * confirm. `probe` takes no arguments -- it is only ever invoked once
 * `usesDefaultGhExec` is already confirmed true, so it probes the real `gh`
 * wrapper directly rather than needing that private reference passed in,
 * which keeps this function callable from a test with no access to `gh`
 * (module-private by design, see the "Thin `gh` shell" section above).
 */
export function resolveTransport(usesDefaultGhExec, token, probe = probeGh) {
	if (!usesDefaultGhExec || !token) return TRANSPORT_GH;
	return probe() ? TRANSPORT_GH : TRANSPORT_REST;
}

/** The `gh --version` probe `resolveTransport` runs against the real `gh`
 * wrapper. Not injectable by design (see `resolveTransport`'s doc comment);
 * a test drives this indirectly by injecting `resolveTransport`'s own
 * `probe` parameter instead. */
function probeGh() {
	try {
		gh(["--version"], { timeoutMs: MIN_GH_TIMEOUT_MS });
		return true;
	} catch (error) {
		return !isGhMissingError(error);
	}
}

// ---------------------------------------------------------------------------
// F1 (review round 2): Node's global `fetch` ignores `HTTPS_PROXY` by
// default. In the Claude Code cloud container -- the exact environment
// #3497 is about -- `GH_TOKEN` is a short-lived PLACEHOLDER the egress proxy
// swaps for the real credential in flight; a `fetch` that bypasses the proxy
// sends the placeholder straight to GitHub and gets a real, well-formed 401.
// Live-probed in this session: `GH_TOKEN=<placeholder> node -e 'fetch(...)'`
// -> 401; the identical call under `NODE_USE_ENV_PROXY=1` -> 200. That flag
// cannot be set mid-process (probed: assigning `process.env.NODE_USE_ENV_PROXY`
// after startup has no effect -- Node reads it once at bootstrap), so a
// confirmed-REST run that finds a proxy configured re-execs itself once with
// the flag set, via `spawnSync` + `stdio: "inherit"` so the child's real
// stdout/stderr/exit code pass straight through.
//
// The flag itself is NEWER than this repo's own `engines` floor: probed
// directly against Node v22.19.0 (`package.json`'s `>=22.19.0`) via a
// throwaway `nvm install 22.19.0` in this session -- `node --use-env-proxy`
// reports "bad option" and `NODE_USE_ENV_PROXY=1` is silently ignored (still
// 401) -- while v22.22.2 (this session's own runtime) honors it. The agent
// proxy's own operator README (`/root/.ccr/README.md`, "Tool ignores the
// proxy entirely") independently states the same boundary: "Node's built-in
// fetch (run that command with NODE_USE_ENV_PROXY=1 on Node >= 22.21)". A
// re-exec below that version would silently no-op back into the exact 401
// misread it exists to fix, so `nodeSupportsUseEnvProxy` gates it: below the
// boundary, `main()` fails closed with an explicit, actionable message
// instead of a re-exec that changes nothing.
// ---------------------------------------------------------------------------

/**
 * True when the running Node honors `NODE_USE_ENV_PROXY` for the global
 * `fetch` (probed boundary: v22.19.0 does not, v22.22.2 does; the agent
 * proxy's own README independently states ">= 22.21"). Any LATER major is
 * assumed to carry it forward (Node does not remove flags across majors),
 * so only `major < 22` or `major === 22 && (minor, patch) < (21, 0)` read
 * false.
 */
export function nodeSupportsUseEnvProxy(versionString = process.version) {
	const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(versionString ?? ""));
	if (!match) return false;
	const major = Number(match[1]);
	const minor = Number(match[2]);
	// N1 (verify round): NOT a simple "any later major carries a flag
	// forward" boundary -- live-probed (a real Bearer `fetch` against
	// `api.github.com/user` with `NODE_USE_ENV_PROXY=1`, both in this
	// session via a throwaway `nvm install 23.11.0` and independently by the
	// verify reviewer against several 23.x/24.x builds): 22.21.0 and every
	// probed 24.x -> 200 (flag honored), but 23.11.0 -> still 401 (flag
	// silently ignored, same as below the 22.21 floor). Node 23 was never an
	// LTS line, and this flag's rollout evidently skipped it. `major >= 24`
	// is therefore its own explicit clause, not folded into `major > 22`.
	if (major >= 24) return true;
	if (major === 22) return minor >= 21;
	return false;
}

export const REEXEC_RUN = "run";
export const REEXEC_REEXEC = "reexec";
export const REEXEC_VERSION_TOO_OLD = "version-too-old";

/**
 * Pure decision for `main()` (#3497 F1): re-exec with `NODE_USE_ENV_PROXY=1`
 * only when this run will actually use the REST transport (a `gh`-transport
 * run never needs the proxy fix and must not pay a re-exec), a proxy is
 * actually configured, the flag is not already set (no re-exec loop), and
 * this Node version honors the flag once set. `envProxyFlagAlreadySet` is
 * checked before `nodeSupportsUseEnvProxy` so a caller who sets the flag
 * explicitly (or a future Node that flips a still-experimental default)
 * never gets redirected to the version-too-old branch by mistake.
 */
export function resolveReexecPlan({
	usesRestTransport,
	proxyUrl,
	envProxyFlagAlreadySet,
	nodeVersion = process.version,
}) {
	if (!usesRestTransport || !proxyUrl || envProxyFlagAlreadySet)
		return REEXEC_RUN;
	return nodeSupportsUseEnvProxy(nodeVersion)
		? REEXEC_REEXEC
		: REEXEC_VERSION_TOO_OLD;
}

// ---------------------------------------------------------------------------
// #3700: `--all` and `--watch-open`. Both read every PR through `run()` itself
// (its `onVerdict` seam), so a PR's state here is the verdict a one-PR read
// prints -- never a second CI reader that could disagree with it.
// ---------------------------------------------------------------------------

/** Seconds between `--watch-open` polls: each poll costs about five `gh`
 * reads per watched PR, so this stays well above `POLL_INTERVAL_SECONDS`. */
export const WATCH_POLL_INTERVAL_SECONDS = 90;

// The verdict kinds `--watch-open` reports; every other kind is progress.
const WATCH_EVENT_KINDS = new Set([
	"failed",
	"fork-approval",
	"absent-rearm",
	"dirty",
	"cancelled",
]);

// `--rerun-cancelled` tries a head at most this many times, waiting twice as
// long after each refusal (180 s, 360 s): a run GitHub keeps refusing is left
// to the human, not hammered every poll.
export const RERUN_MAX_ATTEMPTS = 3;
export const RERUN_BACKOFF_SECONDS = 180;

// `--stream` names an event the way the orchestrator reads it: `FAIL #N@sha`.
const STREAM_EVENT_NAMES = {
	failed: "FAIL",
	dirty: "DIRTY",
	cancelled: "CANCELLED-NOT-REPLACED",
	"fork-approval": "FORK-APPROVAL",
	"absent-rearm": "ABSENT-REARM",
};

function formatEventLine(stream, number, kind, sha, reason) {
	const head = sha ? `@${sha.slice(0, 9)}` : "";
	if (!stream)
		return `#${number} ${kind}${head ? ` ${head}` : ""}${reason ? `: ${reason}` : ""}`;
	const name = STREAM_EVENT_NAMES[kind] ?? kind.toUpperCase();
	return `${name} #${number}${head}${reason ? `: ${reason}` : ""}`;
}

export function readOpenPrs(ghExec = gh, timeoutMs = DEFAULT_GH_TIMEOUT_MS) {
	const raw = ghExec(
		[
			"pr",
			"list",
			"--state",
			"open",
			"--limit",
			"100",
			"--json",
			"number,author,headRefOid,autoMergeRequest",
		],
		{ timeoutMs },
	);
	try {
		return JSON.parse(raw);
	} catch (error) {
		throw new Error(
			`could not parse the open PR list JSON: ${error instanceof Error ? error.message : error}`,
		);
	}
}

function readViewerLogin(ghExec, timeoutMs) {
	try {
		return JSON.parse(ghExec(["api", "user"], { timeoutMs }))?.login ?? null;
	} catch {
		return null;
	}
}

/** One PR's `{ repository, sha, verdict }`, or `null` when its read failed
 * (`run()` already said why on `stderr`). */
async function readPrVerdict(
	pr,
	{ ghExec, stderr, sleepImpl, now, absentSinceMs },
) {
	let captured = null;
	const result = await run({
		argv: [String(pr)],
		ghExec,
		stdout: () => {},
		stderr,
		...(sleepImpl ? { sleepImpl } : {}),
		...(now ? { now } : {}),
		absentSinceMs,
		mutation: false,
		onVerdict: (info) => {
			captured = info;
		},
	});
	return result.code === EXIT_TRANSPORT ? null : captured;
}

/** `--all`: one line per open PR -- author, auto-merge, head, verdict kind,
 * and the first failing gating check. Always exits 0: it is a snapshot. */
export async function snapshotOpenPrs({
	ghExec = gh,
	stdout = console.log,
	stderr = console.error,
	sleepImpl,
	now,
}) {
	for (const pr of readOpenPrs(ghExec)) {
		const info = await readPrVerdict(pr.number, {
			ghExec,
			stderr,
			sleepImpl,
			now,
		});
		const first = info?.verdict.failingRows[0];
		stdout(
			`#${pr.number} ${pr.author?.login ?? "?"} auto-merge=${pr.autoMergeRequest ? "on" : "off"} head=${String(pr.headRefOid ?? "").slice(0, 9)} gating=${info ? info.verdict.kind : "unreadable"}${first ? ` first-failure=${first.name}` : ""}`,
		);
	}
	return EXIT_SUCCESS;
}

/** One PR's state: `key` is the last seen `<sha>:<kind>`, `since` when the
 * watch first saw the head (`{ sha, ms }`: the absence clock of a head with no
 * check suite), `rerun` the re-run attempts on the head (`{ sha, attempts,
 * nextMs, done }`). The
 * first round kept the bare key string; it still loads. */
function normalizeWatchEntry(value) {
	if (typeof value === "string") return { key: value };
	return value && typeof value === "object" && !Array.isArray(value)
		? value
		: {};
}

function loadWatchState(stateFile) {
	if (!stateFile) return {};
	try {
		const parsed = JSON.parse(readFileSync(stateFile, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? Object.fromEntries(
					Object.entries(parsed).map(([number, value]) => [
						number,
						normalizeWatchEntry(value),
					]),
				)
			: {};
	} catch {
		return {};
	}
}

/** Temp file then rename, directory created: a kill mid-write leaves the old
 * state, never a truncated one (which the loader would read as empty and every
 * PR would report again). A failure is a note, not an exit: the poll's events
 * are already printed. */
function saveWatchState(stateFile, seen, stderr) {
	if (!stateFile) return;
	const temporary = `${stateFile}.${process.pid}.tmp`;
	try {
		mkdirSync(dirname(stateFile), { recursive: true });
		writeFileSync(temporary, `${JSON.stringify(seen, null, 2)}\n`);
		renameSync(temporary, stateFile);
	} catch (error) {
		stderr(`could not save the watch state: ${firstLine(error)}`);
		try {
			rmSync(temporary, { force: true });
		} catch {
			/* nothing more to clean */
		}
	}
}

/** Closing issues of a merged PR with their states: `closes #3700: CLOSED`.
 * Fails open to none: the merge is reported either way. */
function readClosingIssues(number, ghExec, timeoutMs) {
	try {
		const refs = JSON.parse(
			ghExec(
				["pr", "view", String(number), "--json", "closingIssuesReferences"],
				{ timeoutMs },
			),
		)?.closingIssuesReferences;
		return (Array.isArray(refs) ? refs : []).map((ref) => {
			let state = "unknown";
			try {
				state =
					JSON.parse(
						ghExec(["issue", "view", String(ref.number), "--json", "state"], {
							timeoutMs,
						}),
					)?.state ?? state;
			} catch {
				/* state stays unknown */
			}
			return `closes #${ref.number}: ${state}`;
		});
	} catch {
		return [];
	}
}

/**
 * `--sync-main <path>`: fast-forward the main checkout after a merge, because
 * every worktree symlinks its node_modules (a checkout 5 days behind fed a
 * fixer an old dependency, 2026-09-30). Refuses -- with the reason -- when the
 * checkout is not on the protected branch or has modified tracked files, and
 * says when `package-lock.json` moved. It NEVER runs `npm ci`: live workers
 * share that install.
 */
export function syncMainCheckout(checkout, gitExec = execFileSync) {
	const git = (...args) =>
		String(
			gitExec("git", ["-C", checkout, ...args], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				timeout: 120_000,
			}),
		).trim();
	try {
		const branch = git("rev-parse", "--abbrev-ref", "HEAD");
		if (branch !== PROTECTED_BRANCH)
			return [
				`SYNC REFUSED ${checkout}: on ${branch}, not ${PROTECTED_BRANCH}`,
			];
		if (git("status", "--porcelain", "--untracked-files=no") !== "")
			return [`SYNC REFUSED ${checkout}: tracked files are modified`];
		const before = git("rev-parse", "HEAD");
		git("pull", "--ff-only");
		const after = git("rev-parse", "HEAD");
		const ahead =
			before === after
				? Number(git("rev-list", "--count", `origin/${PROTECTED_BRANCH}..HEAD`))
				: 0;
		const lines = [
			before === after
				? `SYNCED ${checkout}: already at ${after.slice(0, 9)}${ahead > 0 ? ` (${ahead} local commit${ahead === 1 ? "" : "s"} not on origin)` : ""}`
				: `SYNCED ${checkout}: ${before.slice(0, 9)} -> ${after.slice(0, 9)}`,
		];
		if (
			before !== after &&
			git("diff", "--name-only", before, after, "--", "package-lock.json") !==
				""
		)
			lines.push("LOCKFILE CHANGED: run npm ci when no worker is live");
		return lines;
	} catch (error) {
		return [`SYNC REFUSED ${checkout}: ${gitReason(error)}`];
	}
}

/** Why a git command refused: the line that says so (`Not possible to
 * fast-forward`, `diverged`), else every stderr line -- git leads with a
 * `From <url>` progress line that says nothing. */
function gitReason(error) {
	const stderr = error?.stderr == null ? "" : String(error.stderr);
	const lines = stderr
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	return (
		lines.find((line) => /Not possible to fast-forward|diverged/.test(line)) ??
		(lines.length > 0 ? lines.join(" | ") : firstLine(error))
	);
}

/** `--approve-fork <PR>`: approve that PR's `action_required` runs on its
 * current head. Explicit and per PR; nothing else in this file calls it. */
export async function approveForkRuns({
	target,
	ghExec = gh,
	stdout = console.log,
	stderr = console.error,
}) {
	if (!isPrNumber(target)) {
		stderr("--approve-fork takes a PR number");
		return EXIT_USAGE;
	}
	const repository = resolveRepository(ghExec);
	const { sha } = resolveHeadSha(target, ghExec);
	const runs = fetchActionRequiredRuns(
		repository,
		sha,
		ghExec,
		DEFAULT_GH_TIMEOUT_MS,
		false,
	);
	if (runs.length === 0) {
		stdout(`no action_required runs on ${sha} of #${target}`);
		return EXIT_SUCCESS;
	}
	let failed = false;
	for (const { id } of runs) {
		try {
			ghExec(
				["api", "-X", "POST", `repos/${repository}/actions/runs/${id}/approve`],
				{ timeoutMs: DEFAULT_GH_TIMEOUT_MS },
			);
			stdout(`APPROVED run ${id} of #${target}@${sha.slice(0, 9)}`);
		} catch (error) {
			failed = true;
			stderr(`could not approve run ${id}: ${firstLine(error)}`);
		}
	}
	return failed ? EXIT_FAILURE : EXIT_SUCCESS;
}

/**
 * `--watch-open [--stream] [--rerun-cancelled] [--sync-main <path>]
 * [--wait <seconds>] [--state-file <path>]`: every open PR that
 * has auto-merge armed OR is authored by the repository owner (the maintainer)
 * or the `gh` viewer (the orchestrator) -- a PR in a fix round has no
 * auto-merge and still must not go red unseen (#3688). Per PR, an event is a
 * TRANSITION from its last seen state: a failed gating check, a merge conflict
 * (`dirty`), a cancelled run nobody replaced, fork approval awaited, required
 * checks absent past the re-arm threshold (all verdict kinds, keyed by head
 * SHA so a new push re-arms), or the PR merging or closing. A merged PR also
 * lists its closing issues' states.
 *
 * Without `--stream` it exits 0 on the first poll that has events
 * (`#<pr> <event> @<sha>: <reason>`, then the failure detail) and 3 when the
 * window ends with none. With `--stream` it never exits on an event: each poll
 * prints its events as `FAIL #<pr>@<sha>: <reason>` and the watch runs to the
 * end of the window (0 if any event was printed, 3 if none).
 * `--state-file` keeps the last seen state, the no-suite absence clock and the
 * re-run marks between invocations. `--rerun-cancelled` re-runs a cancelled,
 * unreplaced run once per head (`gh run rerun`); `--sync-main <path>`
 * fast-forwards that checkout after a merge (see `syncMainCheckout`).
 */
export async function watchOpenPrs({
	ghExec = gh,
	gitExec = execFileSync,
	waitSeconds = null,
	stateFile = null,
	stream = false,
	rerunCancelled = false,
	syncMain = null,
	stdout = console.log,
	stderr = console.error,
	sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	now = () => Date.now(),
}) {
	const capSeconds =
		waitSeconds === null
			? HARD_CAP_SECONDS
			: resolveWaitCapSeconds(waitSeconds);
	const deadline = now() + capSeconds * 1000;
	const retry = (call) =>
		callWithTransientRetry(call, {
			deadline: capSeconds > 0 ? deadline : undefined,
			now,
			sleepImpl,
			onRetry: stderr,
		});
	const owner = (
		await retry((remainingMs) =>
			resolveRepository(ghExec, resolveGhTimeoutMs(remainingMs)),
		)
	).split("/")[0];
	const viewer = readViewerLogin(ghExec, DEFAULT_GH_TIMEOUT_MS);
	const seen = loadWatchState(stateFile);
	let printed = 0;
	for (;;) {
		const events = [];
		let merged = false;
		const open = await retry((remainingMs) =>
			readOpenPrs(ghExec, resolveGhTimeoutMs(remainingMs)),
		);
		const watched = open.filter(
			(pr) =>
				pr.autoMergeRequest ||
				pr.author?.login === owner ||
				pr.author?.login === viewer,
		);
		for (const pr of watched) {
			const entry = normalizeWatchEntry(seen[pr.number]);
			// The head's first sighting is its absence clock when no check suite
			// exists; it survives a re-armed watch through the state file.
			if (entry.since?.sha !== pr.headRefOid)
				entry.since = { sha: pr.headRefOid, ms: now() };
			seen[pr.number] = entry;
			const info = await readPrVerdict(pr.number, {
				ghExec,
				stderr,
				sleepImpl,
				now,
				absentSinceMs: entry.since.ms,
			});
			if (!info) continue;
			const { kind, mergeState } = info.verdict;
			const key = `${info.sha}:${kind}`;
			// GitHub answers UNKNOWN while it recomputes mergeability; with nothing
			// else to report that is no news about a head already reported
			// conflicted (a real failure on it still is).
			if (
				mergeState === "UNKNOWN" &&
				!WATCH_EVENT_KINDS.has(kind) &&
				entry.key === `${info.sha}:dirty`
			)
				continue;
			if (WATCH_EVENT_KINDS.has(kind) && entry.key !== key) {
				events.push([
					formatEventLine(
						stream,
						pr.number,
						kind,
						info.sha,
						info.verdict.reason,
					),
					...formatFailureLines(info.verdict).map((line) => `  ${line}`),
				]);
			}
			// Decided every poll, not only on the transition: a refused re-run of
			// a head that stays cancelled must be tried again.
			if (kind === "cancelled" && rerunCancelled) {
				const attempt = entry.rerun?.sha === info.sha ? entry.rerun : null;
				const state = attempt ?? { sha: info.sha, attempts: 0, nextMs: 0 };
				if (
					!state.done &&
					state.attempts < RERUN_MAX_ATTEMPTS &&
					now() >= state.nextMs
				) {
					const rerun = rerunCancelledRows({
						number: pr.number,
						sha: info.sha,
						rows: info.verdict.cancelledRows,
						ghExec,
					});
					state.attempts += 1;
					if (rerun.ok) state.done = true;
					else
						state.nextMs =
							now() + RERUN_BACKOFF_SECONDS * 1000 * 2 ** (state.attempts - 1);
					events.push(rerun.lines);
				}
				entry.rerun = state;
			}
			entry.key = key;
		}
		const watchedNumbers = new Set(watched.map((pr) => String(pr.number)));
		for (const number of Object.keys(seen)) {
			if (watchedNumbers.has(number)) continue;
			const state = readPrState(number, ghExec, DEFAULT_GH_TIMEOUT_MS);
			if (state === "MERGED" || state === "CLOSED") {
				merged ||= state === "MERGED";
				events.push([
					formatEventLine(stream, number, state.toLowerCase()),
					...(state === "MERGED"
						? readClosingIssues(number, ghExec, DEFAULT_GH_TIMEOUT_MS).map(
								(line) => `  ${line}`,
							)
						: []),
				]);
				delete seen[number];
			} else if (state === "OPEN") {
				// Left the watch set (auto-merge disarmed, not the maintainer's).
				delete seen[number];
			}
		}
		if (merged && syncMain) events.push(syncMainCheckout(syncMain, gitExec));
		// Events first: a state file that cannot be written must not swallow the
		// report the poll just produced.
		for (const lines of events) for (const line of lines) stdout(line);
		printed += events.length;
		saveWatchState(stateFile, seen, stderr);
		if (events.length > 0 && !stream) return EXIT_SUCCESS;
		if (now() >= deadline) break;
		await sleepImpl(
			Math.min(WATCH_POLL_INTERVAL_SECONDS * 1000, deadline - now()),
		);
	}
	if (printed > 0) return EXIT_SUCCESS;
	stdout("watch window elapsed with no event");
	return EXIT_PENDING;
}

/** Re-runs each cancelled, unreplaced gating run of one head through `gh run
 * rerun`; `ok` is false when any could not be, so the head stays unmarked. */
function rerunCancelledRows({ number, sha, rows, ghExec }) {
	const lines = [];
	let ok = true;
	const done = new Set();
	for (const row of rows) {
		const args = rerunArgsFor(row);
		if (!args || done.has(args.join(" "))) continue;
		const label = args.join(" ");
		done.add(label);
		try {
			ghExec(args, { timeoutMs: DEFAULT_GH_TIMEOUT_MS });
			lines.push(`RERUN #${number}@${sha.slice(0, 9)}: gh ${label}`);
		} catch (error) {
			ok = false;
			lines.push(
				`RERUN FAILED #${number}@${sha.slice(0, 9)}: gh ${label}: ${firstLine(error)}`,
			);
		}
	}
	return { ok, lines };
}

export function parseArgs(argv) {
	const rest = [];
	let waitSeconds = null;
	let all = false;
	let watchOpen = false;
	let stateFile = null;
	let stream = false;
	let rerunCancelled = false;
	let syncMain = null;
	let approveFork = null;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--wait") {
			waitSeconds = Number(argv[++i]);
		} else if (argv[i] === "--all") {
			all = true;
		} else if (argv[i] === "--watch-open") {
			watchOpen = true;
		} else if (argv[i] === "--state-file") {
			stateFile = argv[++i] ?? null;
		} else if (argv[i] === "--stream") {
			stream = true;
		} else if (argv[i] === "--rerun-cancelled") {
			rerunCancelled = true;
		} else if (argv[i] === "--sync-main") {
			syncMain = argv[++i] ?? null;
		} else if (argv[i] === "--approve-fork") {
			approveFork = argv[++i] ?? "";
		} else {
			rest.push(argv[i]);
		}
	}
	return {
		target: rest[0] ?? null,
		waitSeconds,
		all,
		watchOpen,
		stateFile,
		stream,
		rerunCancelled,
		syncMain,
		approveFork,
	};
}

/**
 * The whole CLI, minus the process-exit side effect: resolves `{ code, kind }`
 * instead of setting `process.exitCode` or throwing, so tests can drive it
 * with an injectable `ghExec` and injectable output sinks, and `main()` never
 * has to guess the label from argv. `main()` below is the only caller that
 * touches `process`.
 */
export async function run({
	argv = process.argv.slice(2),
	ghExec = gh,
	// #3497: injectable REST-transport seams, mirroring `ghExec` above --
	// `gitExec` for `resolveRepositoryViaGit`'s local `git remote` read,
	// `fetchImpl` for every `restGet` call. Both default to the real thing,
	// so production behavior is unchanged; a test drives the REST branch
	// deterministically by overriding these two plus `PATH`/`GH_TOKEN` (to
	// make the `gh --version` probe ENOENT on demand) without touching a
	// real network or a real git remote.
	gitExec = execFileSync,
	fetchImpl = fetch,
	stdout = console.log,
	stderr = console.error,
	sleepImpl,
	now,
	// #3700: receives `{ repository, sha, verdict }` just before the report
	// prints; `--all` and `--watch-open` read every PR through it.
	onVerdict = () => {},
	// #3700: when `--watch-open` first saw this head; the absence clock of a
	// head with no check suite.
	absentSinceMs = null,
	// #3779: false for a `--watch-open` poll (`readPrVerdict`), whose stdout is
	// discarded: the MUTATION read is for a report someone reads.
	mutation = true,
} = {}) {
	const {
		target,
		waitSeconds,
		all,
		watchOpen,
		stateFile,
		stream,
		rerunCancelled,
		syncMain,
		approveFork,
	} = parseArgs(argv);
	if (approveFork !== null) {
		try {
			const code = await approveForkRuns({
				target: approveFork,
				ghExec,
				stdout,
				stderr,
			});
			return { code, kind: code === EXIT_USAGE ? "usage" : "approve" };
		} catch (error) {
			stderr(error instanceof Error ? error.message : String(error));
			return { code: EXIT_TRANSPORT, kind: "transport" };
		}
	}
	if (watchOpen && rerunCancelled && !stateFile) {
		// Without the state a re-armed watch (the normal shape: a non-stream
		// watch exits at its first event) re-runs the same head every time.
		stderr("--rerun-cancelled requires --state-file");
		return { code: EXIT_USAGE, kind: "usage" };
	}
	if (all || watchOpen) {
		try {
			const code = watchOpen
				? await watchOpenPrs({
						ghExec,
						gitExec,
						waitSeconds,
						stateFile,
						stream,
						rerunCancelled,
						syncMain,
						stdout,
						stderr,
						...(sleepImpl ? { sleepImpl } : {}),
						...(now ? { now } : {}),
					})
				: await snapshotOpenPrs({ ghExec, stdout, stderr, sleepImpl, now });
			return { code, kind: watchExitKind({ watchOpen, stream, code }) };
		} catch (error) {
			stderr(error instanceof Error ? error.message : String(error));
			return { code: EXIT_TRANSPORT, kind: "transport" };
		}
	}
	if (!target) {
		stderr(
			"usage: node scripts/ci-verdict.mjs <pr-number|sha> [--wait <seconds>] | --all | --approve-fork <pr> | --watch-open [--stream] [--rerun-cancelled] [--sync-main <path>] [--wait <seconds>] [--state-file <path>]",
		);
		return { code: EXIT_USAGE, kind: "usage" };
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
		// #2935 remainder: the two lookups that throw run under the same
		// transient retry and the same deadline as the poll, so a wait armed
		// while GitHub is already down waits instead of exiting 70, and the
		// time it spends here comes out of the poll's budget.
		const clock = now ?? (() => Date.now());
		const deadline = capSeconds > 0 ? clock() + capSeconds * 1000 : undefined;
		const retryStartup = (call) =>
			callWithTransientRetry(call, {
				deadline,
				now: clock,
				onRetry: stderr,
				...(sleepImpl ? { sleepImpl } : {}),
			});
		// #3497: decided once, before any repository/PR resolution, and never
		// for an injected test `ghExec` (see `resolveTransport`'s own doc
		// comment) -- every call below branches on this ONE flag rather than
		// each guessing per-call, and the `gh`-branch call shapes are
		// byte-for-byte what they were before this transport existed.
		const transport = resolveTransport(ghExec === gh, resolveGithubToken());
		const restOptions = { token: resolveGithubToken(), fetchImpl };
		const repository =
			transport === TRANSPORT_REST
				? resolveRepositoryViaGit(gitExec)
				: await retryStartup((remainingMs) =>
						resolveRepository(ghExec, resolveGhTimeoutMs(remainingMs)),
					);
		const { sha, mergeable, classification } =
			transport === TRANSPORT_REST
				? {
						...(await retryStartup((remainingMs) =>
							restResolveHeadSha(repository, target, {
								...restOptions,
								timeoutMs: resolveGhTimeoutMs(remainingMs),
							}),
						)),
						classification: null,
					}
				: await retryStartup((remainingMs) =>
						resolveHeadSha(target, ghExec, resolveGhTimeoutMs(remainingMs)),
					);
		// The rerun-classifier comment marker and the Actions-attempts read
		// below are both `gh pr view`/`gh api` reads with no REST path added
		// in this change (#3497's acceptance criteria are PR head/mergeable,
		// check-runs and required-check names only) -- the REST transport
		// simply carries no classification, which `computeVerdict` already
		// treats as "no infra-rerun grace", the same as a target with no
		// `ci-classifier:` comment on the `gh` transport.
		const ciClassification =
			transport === TRANSPORT_REST
				? null
				: (classification ??
					resolveClassification(target, ghExec, initialTimeoutMs));
		const rerunState =
			transport === TRANSPORT_GH && ciClassification && isPrNumber(target)
				? () => fetchRerunState(repository, sha, ghExec, initialTimeoutMs)
				: null;
		// #3694: read lazily, only when computeVerdict reaches its absent-required
		// branch, so a healthy head costs no extra API call. The push time is
		// kept once it is known; auto-merge is read again every poll (armed
		// mid-`--wait`), the push time too while no check suite exists yet, and
		// approval runs every poll (a maintainer approving mid-`--wait` must
		// clear the message). #3700: the first poll before any suite exists must
		// not pin the whole window on the quiet text.
		let headInfo = { autoMerge: false, pushedMs: null };
		// #3700: a head with no check suite has no push clock (GitHub never opened
		// one), so absence is measured from when this read -- or the watch that
		// passed `absentSinceMs` -- first saw it absent.
		let firstAbsentMs = null;
		const absentContext =
			transport === TRANSPORT_GH
				? () => {
						headInfo = fetchAutoMergeAge(
							target,
							repository,
							sha,
							ghExec,
							initialTimeoutMs,
							headInfo.pushedMs,
						);
						const { actionRequiredRuns, headRun } = fetchHeadRuns(
							repository,
							sha,
							ghExec,
							initialTimeoutMs,
						);
						const nowMs = clock();
						return {
							repository,
							sha,
							actionRequiredRuns,
							autoMerge: headInfo.autoMerge,
							absentMinutes: Math.max(
								0,
								Math.floor(
									(nowMs -
										(Number.isFinite(headInfo.pushedMs)
											? headInfo.pushedMs
											: (absentSinceMs ?? (firstAbsentMs ??= nowMs)))) /
										60_000,
								),
							),
							headRun: {
								state: headRun.state,
								id: headRun.id,
								ageMinutes: Number.isFinite(headRun.startedAtMs)
									? Math.max(
											0,
											Math.floor((nowMs - headRun.startedAtMs) / 60_000),
										)
									: null,
							},
						};
					}
				: null;
		// #3754: read lazily, only when computeVerdict reaches its green branch
		// (a red or pending head costs no extra call): whether the PR sits in the
		// merge queue, else whether a queue run of this head failed and ejected
		// it. PR targets on the gh transport only (the queue state is GraphQL).
		const queueContext =
			transport === TRANSPORT_GH && isPrNumber(target)
				? () => {
						const state = readMergeQueueState(
							target,
							repository,
							ghExec,
							initialTimeoutMs,
						);
						if (state?.entry) return { entry: state.entry };
						// No queue on the repository (or an unreadable answer): the green
						// head is plain success, at the cost of the one read above.
						if (!state?.enabled) return null;
						headInfo = fetchAutoMergeAge(
							target,
							repository,
							sha,
							ghExec,
							initialTimeoutMs,
							headInfo.pushedMs,
						);
						return fetchFailedQueueRuns(
							target,
							repository,
							headInfo.pushedMs,
							ghExec,
							initialTimeoutMs,
						);
					}
				: null;
		// #2609: read once, before polling starts (branch protection does not
		// change between polls of the same head). `null` means unreadable --
		// `requiredChecks` then falls back to the constant default, and every
		// OTHER discovered check still gates via computeVerdict's own
		// advisory-allowlist check (see its doc comment).
		const liveRequiredChecks =
			transport === TRANSPORT_REST
				? await restResolveRequiredCheckNames(repository, {
						...restOptions,
						timeoutMs: initialTimeoutMs,
					})
				: resolveRequiredCheckNames(repository, ghExec, initialTimeoutMs);
		const requiredChecks = liveRequiredChecks ?? REQUIRED_CHECKS;
		const gatingSource = liveRequiredChecks
			? `branch protection required_status_checks on ${PROTECTED_BRANCH} (${liveRequiredChecks.join(", ")}) -- every other check-run gates unless it is on the advisory allowlist`
			: `advisory allowlist only -- branch protection on ${PROTECTED_BRANCH} was unreadable, falling back to the constant required-check list (${REQUIRED_CHECKS.join(", ")})`;

		let lastPayload = null;
		let { verdict, polls } = await pollVerdict({
			fetchPayload: async (remainingMs) => {
				lastPayload = await (transport === TRANSPORT_REST
					? restFetchCheckRunsPayload(repository, sha, {
							...restOptions,
							timeoutMs: resolveGhTimeoutMs(remainingMs),
						})
					: fetchCheckRunsPayload(
							repository,
							sha,
							ghExec,
							resolveGhTimeoutMs(remainingMs),
						));
				return lastPayload;
			},
			waitSeconds:
				deadline === undefined
					? waitSeconds
					: Math.max(0, (deadline - clock()) / 1000),
			mergeable,
			requiredChecks,
			classification: ciClassification,
			rerunState,
			absentContext,
			queueContext,
			onRetry: stderr,
			...(sleepImpl ? { sleepImpl } : {}),
			...(now ? { now } : {}),
		});

		// #3700: failing gating rows are named (step, test lines), the rows that
		// are post-merge noise are dropped, and the right remedy is hinted -- also
		// under a DIRTY or rerun-pending verdict that outranks the failure. gh
		// only: the REST transport has no `gh api --allow-escape-sequences` read.
		if (verdict.failingRows.length > 0 && transport === TRANSPORT_GH) {
			const found = readFailureDetails({
				rows: verdict.failingRows,
				target,
				repository,
				ghExec,
				timeoutMs: initialTimeoutMs,
			});
			if (found.noiseRowIds) {
				verdict = computeVerdict(
					lastPayload,
					requiredChecks,
					mergeable,
					ciClassification,
					typeof rerunState === "function" ? rerunState() : rerunState,
					absentContext,
					found.noiseRowIds,
					queueContext,
				);
			}
			verdict = { ...verdict, details: found.details, hints: found.hints };
		}
		onVerdict({ repository, sha, verdict });

		stdout(
			`CI verdict for ${repository}@${sha}${polls > 1 ? ` (${polls} reads)` : ""}`,
		);
		stdout(formatVerdictTable(verdict.rows));
		for (const line of formatGatingSplit(verdict.rows, verdict.failingRows)) {
			stdout(line);
		}
		for (const line of formatFailureLines(verdict)) stdout(line);
		// Merge state is always printed, not just when it drives the verdict
		// (round 3, F1) -- a reviewer reading the report should never have to
		// infer it from `reason` text alone. `"n/a"` for a bare-SHA target
		// documents that DIRTY is PR-only.
		stdout(`Merge state: ${verdict.mergeState}`);
		// #3497: names which transport produced this verdict, so a reviewer
		// reading the output never has to infer it from context.
		stdout(`Transport: ${transport}`);
		stdout(`Gating source: ${gatingSource}`);
		if (mutation && transport === TRANSPORT_GH && isPrNumber(target))
			stdout(
				readMutationLine({
					repository,
					target,
					sha,
					rows: verdict.rows,
					ghExec,
					// What the polls left of --wait, not the startup allowance.
					timeoutMs: resolveGhTimeoutMs(
						deadline === undefined ? undefined : deadline - clock(),
					),
				}),
			);
		stdout(verdict.reason);
		return {
			code: verdict.exitCode,
			kind: verdictExitKind(verdict.exitCode, verdict.kind),
		};
	} catch (error) {
		// Transport/unexpected (F3): `gh` missing from PATH, a call that hit its
		// own timeout, malformed JSON, or anything else that means this script
		// never got a real answer from GitHub. Distinct from EXIT_FAILURE (1),
		// which means GitHub DID answer and the answer was red.
		stderr(error instanceof Error ? error.message : String(error));
		return { code: EXIT_TRANSPORT, kind: "transport" };
	}
}

/**
 * The `REEXEC_VERSION_TOO_OLD` stderr message (N3, verify round). Takes NO
 * proxy-URL parameter -- deliberately, not just by omission: a proxy URL can
 * carry HTTP Basic userinfo (`http://user:pass@host`), probed live on Node
 * 22.20.0 with `HTTPS_PROXY=http://alice:s3cretpw@127.0.0.1:9` printing that
 * verbatim to stderr before this fix. The URL is dropped from the message
 * ENTIRELY rather than redacted: a redaction has to anticipate every shape a
 * credential can take in a proxy URL (userinfo, a query-string token, a
 * non-standard scheme), and getting that wrong once is the same leak with
 * extra confidence. Naming that `HTTPS_PROXY`/`https_proxy` is set is enough
 * for a human to act on; the value adds nothing this message needs. Exported
 * as its own function (never taking the URL, not just never printing it) so
 * a future edit cannot reintroduce the leak by simply adding an argument
 * here without ALSO changing this signature, which a reviewer reads.
 */
export function formatVersionTooOldMessage(nodeVersion = process.version) {
	return `ci-verdict: HTTPS_PROXY is set but this Node (${nodeVersion}) does not honor NODE_USE_ENV_PROXY (requires >=22.21.0) -- the REST transport cannot reach GitHub through the proxy. Upgrade Node, or run where \`gh\` is on PATH.`;
}

async function main() {
	// F1: decided with the SAME `resolveTransport` call `run()` itself will
	// make (`usesDefaultGhExec: true`, since `main()` never overrides
	// `ghExec`) -- so this prediction never diverges from what `run()`
	// actually does two lines later.
	const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || null;
	const plan = resolveReexecPlan({
		usesRestTransport:
			resolveTransport(true, resolveGithubToken()) === TRANSPORT_REST,
		proxyUrl,
		envProxyFlagAlreadySet: process.env.NODE_USE_ENV_PROXY === "1",
	});
	if (plan === REEXEC_VERSION_TOO_OLD) {
		console.error(formatVersionTooOldMessage(process.version));
		console.log(formatExitLine(transportExit()));
		process.exitCode = EXIT_TRANSPORT;
		return;
	}
	if (plan === REEXEC_REEXEC) {
		const result = spawnSync(
			process.execPath,
			[
				"--no-warnings",
				fileURLToPath(import.meta.url),
				...process.argv.slice(2),
			],
			{ stdio: "inherit", env: { ...process.env, NODE_USE_ENV_PROXY: "1" } },
		);
		process.exitCode = result.status ?? EXIT_TRANSPORT;
		if (result.status === null) console.log(formatExitLine(transportExit()));
		return;
	}
	const result = await run();
	console.log(formatExitLine(result));
	process.exitCode = result.code;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	main().catch((error) => {
		console.error(error);
		// An unexpected throw is not a verdict: EXIT_FAILURE's contract is
		// "GitHub answered and the answer was red" (#3883 F4).
		console.log(formatExitLine(crashExit()));
		process.exitCode = EXIT_FAILURE;
	});
}
