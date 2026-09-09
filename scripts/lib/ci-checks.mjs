/**
 * scripts/lib/ci-checks.mjs (#2539 round 2, F2): the ONE required-checks name
 * list and the ONE fail-closed "latest check-run per name" resolver, shared
 * by every consumer that reads GitHub check-runs for this repo's two gating
 * checks -- merge-train-warden.mjs (GraphQL rollup: `startedAt`, UPPERCASE
 * `status`/`conclusion`), merge-train-lane.mjs (via the warden today, moved
 * to import this module directly in this round), and ci-verdict.mjs (REST
 * `commits/<sha>/check-runs`: `started_at`, lowercase `status`/`conclusion`).
 *
 * Before this round, ci-verdict.mjs hand-rolled its own `latestRunNamed`
 * with an `id`-as-tiebreak policy that is NOT fail-closed (a superseded
 * SUCCESS with the higher id could win a tie over an unresolved duplicate),
 * while merge-train-warden.mjs already carried the correct policy. Two
 * required-check name lists and two different tie policies for the same
 * real-world duplicate-check-run shape (a rerun, or the classify-ci-failure
 * auto-rerun, #2103) is the single-source-of-truth defect this module fixes.
 */

export const REQUIRED_CHECKS = ["Unit tests", "Lint & type-check"];

export const CI_JOB_NAMES = Object.freeze({
	CHANGELOG_FRAGMENT: "Changelog fragment (fast-fail)",
	LINT_AND_TYPECHECK: "Lint & type-check",
	KNIP: "knip (advisory)",
	UNIT_TESTS: "Unit tests",
});

// How this repository ACTUALLY marks a check advisory: the workflow job name
// ends in "(advisory)". Probed 2026-08-26 against the live rollups of every
// open PR -- `PR body (advisory)`, `Vale prose lint (advisory)`,
// `OSV scan (advisory)`. Originally lived only
// in merge-train-lane.mjs; moved here in #2609 so ci-verdict.mjs (a second
// consumer of the exact same policy) imports the ONE list instead of
// hand-rolling its own -- AGENTS.md shape 38's own warning ("the cheapest
// evasion is adding a real gate to the advisory list") is a defect risk
// multiplied by every duplicate copy of this set, not just the original.
// merge-train-lane.mjs re-exports these three names unchanged for its
// existing importers.
const ADVISORY_SUFFIX = "(advisory)";
export const ADVISORY_CHECKS = new Set([
	// Third-party SonarCloud GitHub App check-run (posted via the SonarCloud
	// integration, not a workflow job in .github/workflows) -- has no
	// "(advisory)" suffix to self-identify by, so it needs an explicit entry.
	"SonarCloud Code Analysis",
	// GitHub's own code-scanning summary check (default CodeQL setup -- there
	// is no committed codeql.yml; the per-language "Analyze (<lang>)" jobs it
	// spawns are a DIFFERENT, unrelated set of check-run names this list does
	// NOT cover, and they gate like any other non-advisory check).
	"CodeQL",
	// #2706 tooling jobs have explicit advisory entries as well as the suffix.
	"jscpd (advisory)",
	"yamllint (advisory)",
	"typos (advisory)",
	"taplo (advisory)",
	"mutation (advisory)",
	"complexity (advisory)",
	// .github/workflows/greetings.yml's `greeting` job (the job KEY -- no
	// `name:` override), posted by `actions/first-interaction` on
	// `pull_request_target: types: [opened]` only. A cosmetic
	// first-time-contributor welcome bot; a token or action-version failure
	// in it must never block the train (#2618 fix-round-2 F3).
	"greeting",
]);

export function isAdvisoryCheck(name) {
	return (
		ADVISORY_CHECKS.has(name) || String(name ?? "").endsWith(ADVISORY_SUFFIX)
	);
}

// A non-advisory check in any of these states blocks a merge (#2185's real
// merge-train gate; moved here from merge-train-lane.mjs in #2609 for the
// same single-source reason as ADVISORY_CHECKS above). GraphQL's rollup
// reports these UPPERCASE; REST's check-runs API reports them lowercase --
// `isBlockingConclusion` below normalizes case so both payload shapes share
// this ONE list. Deliberately NOT exhaustive over every enum value GitHub
// documents: "success", "skipped", and "neutral" are exactly the completed
// conclusions that are NOT failures, and every one of them is a real,
// observed shape in this repo -- "skipped" is not hypothetical, it is what
// `record-post-merge-validation`'s job-level
// `if: ... && github.event_name == 'repository_dispatch'` reports on EVERY
// ordinary pull_request run (probed live on PR #2588, 2026-09-06: two
// "Record post-merge validation" rows, both "skipping"). Treating a job's
// own conditional skip as a failure would red every PR forever (#2609).
const BLOCKING_CONCLUSIONS = new Set([
	"FAILURE",
	"TIMED_OUT",
	"CANCELLED",
	"ACTION_REQUIRED",
	"STARTUP_FAILURE",
	"STALE",
]);

export function isBlockingConclusion(conclusion) {
	return BLOCKING_CONCLUSIONS.has(String(conclusion ?? "").toUpperCase());
}

// #2618 fix-round-2, F2: `CANCELLED` sits in `BLOCKING_CONCLUSIONS` above
// because a check a HUMAN cancelled genuinely is not passing -- but
// `cancel-in-progress: true` (ci.yml:15-16) cancels the PREVIOUS in-flight
// run of a concurrency group on every new push/dispatch to the SAME ref, and
// that cancelled check-run can be the ONLY row present for its name for
// several minutes before its replacement posts (live-probed 2026-09-06 on
// PR #2607's head: three "Record post-merge validation" check-suites on ONE
// commit -- 17:21:06 cancelled, 17:25:29 skipped, 17:32:15 skipped --
// `resolveLatestByName` correctly drops the cancelled one once a newer row
// exists, but at 17:21-17:25 it was the newest, and only, row). Reading that
// window as a hard FAILURE (as `isBlockingConclusion` alone would) is a
// false positive on a check that is not done reporting, not a check that
// failed -- callers gate a DISCOVERED (non-required) row's "cancelled"
// conclusion through this predicate instead, to PEND rather than fail. A
// REQUIRED row gets no such grace: it must reach a literal "success" as
// ANY other terminal state means it, or a run superseding it, was
// interrupted or is stale evidence -- see ci-verdict.mjs's `computeVerdict`.
export function isUncertainConclusion(conclusion) {
	return String(conclusion ?? "").toUpperCase() === "CANCELLED";
}

function startedAtOf(run) {
	return run?.startedAt ?? run?.started_at ?? null;
}

// Case-insensitive: GraphQL reports "COMPLETED"/"SUCCESS", REST reports
// "completed"/"success". Comparing case-insensitively here is what lets ONE
// tie policy serve both payload shapes without either caller normalizing
// its check-run records first.
function isConcludedSuccess(run) {
	const status = String(run?.status ?? "").toUpperCase();
	const conclusion = String(run?.conclusion ?? "").toUpperCase();
	return status === "COMPLETED" && conclusion === "SUCCESS";
}

/**
 * Fail-closed tie policy (#2190 incident): when two check-runs share a name
 * and neither `startedAt`/`started_at` orders them (missing, unparsable, or
 * exactly equal), the run that is NOT a concluded success wins. An
 * unorderable tie can only ever withhold a pass, never grant one.
 */
function preferCheckRun(a, b) {
	const ta = Date.parse(startedAtOf(a) ?? "");
	const tb = Date.parse(startedAtOf(b) ?? "");
	if (!Number.isNaN(ta) && !Number.isNaN(tb) && ta !== tb)
		return ta > tb ? a : b;
	if (isConcludedSuccess(a) && !isConcludedSuccess(b)) return b;
	if (isConcludedSuccess(b) && !isConcludedSuccess(a)) return a;
	return a;
}

/**
 * One check-run per NAME, newest wins via `preferCheckRun`. GitHub's own
 * rollup really does carry duplicate names on one head (a PR head listed six
 * names twice; another listed `Unit tests` as both IN_PROGRESS and
 * COMPLETED/SUCCESS at once) and the API documents no ordering guarantee
 * across reruns, so array order/position is never trusted here.
 */
export function resolveLatestByName(checkRuns) {
	const byName = new Map();
	for (const run of checkRuns ?? []) {
		const incumbent = byName.get(run.name);
		byName.set(run.name, incumbent ? preferCheckRun(incumbent, run) : run);
	}
	return byName;
}
