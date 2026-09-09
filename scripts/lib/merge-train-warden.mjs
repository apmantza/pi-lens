/**
 * Merge-train warden (#1844): the mechanical version of the checks a human
 * was running session-side across the 2026-08-20 release drive -- polling
 * open PRs for merge conflicts, stale auto-merge, and red required checks.
 *
 * The warden OBSERVES AND ANNOTATES ONLY. It never resolves conflicts,
 * never merges, and never pushes to a PR branch. Two exceptions, both
 * GitHub-sanctioned buttons a human clicks in the UI:
 *
 * - "update branch" for a PR that already has auto-merge armed and has
 *   fallen BEHIND.
 * - "re-run workflow" for a run this sweep classified as STARVED (#2184) --
 *   at most once per run, keyed on GitHub's own `run_attempt` counter.
 *
 * Merging stays out of this file by construction; the label-gated merge lane
 * lives in scripts/lib/merge-train-lane.mjs with its own workflow and its own
 * permissions (#2185).
 */

import {
	commentMarkerExists,
	presentCommentMarkers,
} from "./github-paging.mjs";
import {
	isAdvisoryCheck,
	isBlockingConclusion,
	isUncertainConclusion,
	REQUIRED_CHECKS,
	resolveLatestByName,
} from "./ci-checks.mjs";
import {
	absentRunCommentMarker,
	decideRunHealthActions,
	fetchHeadRunHealth,
	stalledRunCommentMarker,
} from "./warden-run-health.mjs";

export const CONFLICT_LABEL = "conflict";
export const RED_CI_LABEL = "red-ci";
export const PAGE_SIZE = 50;
export const MAX_PAGES = 4; // 200 open PRs is far above this repo's steady state; bail rather than loop forever.
// Recorded-but-ok REST failures (review round 1, F4): a closed/deleted PR
// (404), a label-add racing another tick (409), or update-branch on a fork
// with maintainer edits off / already up to date (422) are expected noise on
// a 10-minute cadence, not warden bugs. Only a status OUTSIDE this set marks
// the scheduled run red, so the run doesn't email every 10 minutes for
// benign races.
const BENIGN_HTTP_STATUSES = new Set([404, 409, 422]);

// One check run per NAME, newest wins, fail-closed on an unorderable tie
// (#2190 -- PR #2191's own head listed six names twice; PR #2190 listed
// `Unit tests` as both IN_PROGRESS and COMPLETED/SUCCESS at once). The
// resolution policy itself now lives in ci-checks.mjs (#2539 round 2, F2) as
// `resolveLatestByName`, imported above, so this file, merge-train-lane.mjs's
// gate, and ci-verdict.mjs share exactly one implementation instead of three
// copies that could drift.

const PR_QUERY = `
query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: ${PAGE_SIZE}, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        url
        mergeStateStatus
        autoMergeRequest { enabledAt }
        isCrossRepository
        labels(first: 50) { nodes { name } }
        commits(last: 1) {
          nodes {
            commit {
              oid
              committedDate
              statusCheckRollup {
                contexts(first: 100) {
                  nodes {
                    __typename
                    ... on CheckRun {
                      name
                      status
                      conclusion
                      startedAt
                      detailsUrl
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
`;

// Returns the raw GraphQL payload ({ data, errors }) instead of throwing on
// `errors` (review round 1, F6): GraphQL can return PARTIAL data alongside
// errors, and the caller decides how to treat that -- collapsing straight to
// a throw would crash the bare top-level await in the CLI entry point and
// lose the whole run's summary instead of skipping the affected page.
async function graphql(fetcher, query, variables) {
	const response = await fetcher("https://api.github.com/graphql", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ query, variables }),
	});
	if (!response.ok) throw new Error(`GitHub GraphQL API ${response.status}`);
	return response.json();
}

function normalizePr(node) {
	const labels = new Set((node.labels?.nodes ?? []).map((l) => l.name));
	const headCommit = node.commits?.nodes?.[0]?.commit;
	const rollup = headCommit?.statusCheckRollup;
	// A null/absent rollup (review round 1, F2) is NOT the same as "zero
	// failing checks" -- it means GitHub hasn't told us anything about the
	// head commit's checks yet (permissions gap, brand-new commit, API hiccup).
	// Collapsing that to "clean" would strip an existing red-ci label on pure
	// absence of information. checksUnknown lets decideActions distinguish
	// "confirmed no failures" from "we don't know".
	const checksUnknown = rollup == null;
	const contexts = rollup?.contexts?.nodes ?? [];
	const checkRuns = [];
	for (const c of contexts) {
		if (c.__typename !== "CheckRun") continue;
		// The full list (name + status + conclusion) is what the warden's
		// "zero non-advisory failing checks" signal reads, matching the merge
		// lane and ci-verdict policy.
		// startedAt orders duplicate names on one head: GitHub's rollup really
		// carries them (review round 1, F4), and array order is not time order.
		checkRuns.push({
			name: c.name,
			status: c.status ?? null,
			conclusion: c.conclusion ?? null,
			startedAt: c.startedAt ?? null,
			url: c.detailsUrl,
		});
	}
	const failingRequiredChecks = [];
	// A required check that hasn't reported yet (absent from the rollup) or is
	// mid-run (conclusion null: queued/in-progress/re-queued) is UNRESOLVED,
	// not "not failing". The same required-name override and advisory allowlist
	// as ci-verdict make every discovered non-advisory check a gating signal.
	// Resolved newest-per-name: a superseded duplicate must not decide whether
	// a gating check is failing or unresolved.
	const checkRunsByName = resolveLatestByName(checkRuns);
	const unresolvedRequiredChecks = [];
	const gatingNames = new Set([...REQUIRED_CHECKS, ...checkRunsByName.keys()]);
	for (const name of gatingNames) {
		if (!REQUIRED_CHECKS.includes(name) && isAdvisoryCheck(name)) continue;
		const run = checkRunsByName.get(name);
		if (!run) {
			unresolvedRequiredChecks.push(name);
			continue;
		}
		const conclusion = String(run.conclusion ?? "").toUpperCase();
		if (
			!conclusion ||
			(!REQUIRED_CHECKS.includes(name) && isUncertainConclusion(conclusion))
		) {
			unresolvedRequiredChecks.push(name);
		} else if (
			(REQUIRED_CHECKS.includes(name) && conclusion !== "SUCCESS") ||
			(!REQUIRED_CHECKS.includes(name) && isBlockingConclusion(conclusion))
		) {
			// `url`, not `detailsUrl`: the resolver returns the NORMALIZED record
			// built above, not the raw GraphQL node.
			failingRequiredChecks.push({ name, url: run.url });
		}
	}
	return {
		number: node.number,
		url: node.url,
		headSha: headCommit?.oid,
		// GraphQL's `pushedDate` is deprecated and reads null on every real PR
		// in this repository (probed 2026-08-26 against #2180/#2181), so the
		// committer date is the available age signal for "the dispatch should
		// have landed by now" (#2184).
		headCommittedDate: headCommit?.committedDate ?? null,
		mergeStateStatus: node.mergeStateStatus,
		autoMergeEnabled: Boolean(node.autoMergeRequest),
		// isCrossRepository is GitHub's own fork signal: true when the PR's head
		// repository differs from this (base) repository. update-branch's PUT
		// creates a commit ON the head branch, so a fork-owned head is the
		// expected 403 case -- the workflow token can label/comment on the PR
		// without ever having write access to someone else's repository (#1959).
		isFork: Boolean(node.isCrossRepository),
		labels,
		checksUnknown,
		checkRuns,
		failingRequiredChecks,
		unresolvedRequiredChecks,
	};
}

/**
 * How many repeated PR numbers one duplicate record names before it stops
 * listing them and reports a remainder count (#2192). The record has to stay
 * one line in a workflow summary; the COUNT is the signal, the first few
 * numbers are the breadcrumb.
 */
export const DUPLICATE_REPORT_CAP = 5;

/**
 * Single paginated list call (per PR, bounded by MAX_PAGES): rate-limit
 * conscious by construction. If GitHub returns a non-array/malformed page,
 * a request throws, or a page comes back with partial `errors`, bail
 * gracefully with whatever PRs were already collected plus a recorded error
 * -- never throw out of this function (review round 1, F6).
 *
 * Returns `errors` as `{ message, benign }` RECORDS, not strings (#2192).
 * Both consumers -- `runWarden` below and the merge lane -- used to map every
 * list error to `benign: false` on the way in, which is exactly the bug: a
 * cross-page duplicate is routine, not fatal. The query orders by UPDATED_AT
 * desc, so any open PR touched mid-pagination shifts the window and pushes a
 * PR from page N onto page N+1. On a 10-minute cadence that is expected noise,
 * and this file's own design note (BENIGN_HTTP_STATUSES above) says such races
 * must not mark the scheduled run red. An intra-page duplicate is malformed
 * API data and stays fatal (#2289). Classifying at the SOURCE also means the
 * two consumers stop carrying identical mapping code that can drift apart.
 */
export async function fetchOpenPullRequests(fetcher, owner, name) {
	const prs = [];
	const errors = [];
	const record = (message, benign = false) => errors.push({ message, benign });
	const seenNumbers = new Set();
	let after;
	for (let page = 0; page < MAX_PAGES; page++) {
		let payload;
		try {
			payload = await graphql(fetcher, PR_QUERY, { owner, name, after });
		} catch (error) {
			record(
				`GraphQL request failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			break;
		}
		if (payload?.errors?.length)
			record(
				`GraphQL errors: ${payload.errors.map((e) => e.message).join("; ")}`,
			);
		const connection = payload?.data?.repository?.pullRequests;
		if (!connection || !Array.isArray(connection.nodes)) break;
		// Collected, not recorded per node (#2192): the old code pushed one
		// FATAL error per repeated node, so a fully shifted window emitted up
		// to MAX_PAGES x PAGE_SIZE = 200 identical lines into one summary. One
		// record per page, naming the count, is the same information at 1/50th
		// the volume.
		const seenOnPage = new Set();
		const boundaryDuplicates = [];
		const intraPageDuplicates = [];
		for (const node of connection.nodes) {
			if (seenOnPage.has(node.number)) {
				intraPageDuplicates.push(node.number);
				continue;
			}
			seenOnPage.add(node.number);
			if (seenNumbers.has(node.number)) {
				boundaryDuplicates.push(node.number);
				continue;
			}
			seenNumbers.add(node.number);
			prs.push(normalizePr(node));
		}

		const hasNextPage = Boolean(connection.pageInfo?.hasNextPage);
		const nextCursor = connection.pageInfo?.endCursor;
		// Read BEFORE the breaks below, because it decides how a cross-page
		// duplicate is classified. An intra-page duplicate cannot be a boundary
		// slide, regardless of cursor state, and is recorded separately above.
		const cursorAdvanced =
			!hasNextPage || (nextCursor != null && nextCursor !== after);
		if (boundaryDuplicates.length > 0) {
			const shown = boundaryDuplicates.slice(0, DUPLICATE_REPORT_CAP);
			const remainder = boundaryDuplicates.length - shown.length;
			record(
				`GraphQL pagination repeated ${boundaryDuplicates.length} PR number(s) on page ${page + 1} ` +
					`(${shown.map((n) => `#${n}`).join(", ")}${remainder > 0 ? `, +${remainder} more` : ""}); ` +
					(cursorAdvanced
						? "the open-PR window shifted during pagination, so this is a routine boundary repeat"
						: "the cursor did not advance, so the collection is truncated"),
				cursorAdvanced,
			);
		}
		if (intraPageDuplicates.length > 0) {
			const shown = intraPageDuplicates.slice(0, DUPLICATE_REPORT_CAP);
			const remainder = intraPageDuplicates.length - shown.length;
			record(
				`GraphQL returned malformed page ${page + 1}: repeated ${intraPageDuplicates.length} PR number(s) within the page ` +
					`(${shown.map((n) => `#${n}`).join(", ")}${remainder > 0 ? `, +${remainder} more` : ""})`,
			);
		}

		if (!hasNextPage) break;
		if (!cursorAdvanced) {
			record("GraphQL pagination truncated because cursor did not advance");
			break;
		}
		if (page === MAX_PAGES - 1) {
			record(
				`GraphQL pagination truncated after ${MAX_PAGES} pages while hasNextPage=true`,
			);
			break;
		}
		after = nextCursor;
	}
	return { prs, errors };
}

/**
 * Decide what the warden should do for one PR. Pure function, no I/O --
 * this is what a test drives without a network mock. Dedupe is structural:
 * a comment is proposed only on the transition INTO a labeled state (label
 * absent -> label needed), never while the label already sits on the PR.
 * A human removing the label manually re-arms the next comment -- that is
 * the label's whole job as the dedupe key, so the comment body itself
 * carries no separate marker to scan for (review round 1, F9).
 */
export function decideActions(pr) {
	const actions = [];
	const isDirty = pr.mergeStateStatus === "DIRTY";
	// Recovery requires a POSITIVELY KNOWN non-DIRTY state (review round 1,
	// F1). GitHub reports mergeStateStatus: UNKNOWN for every open PR for a
	// few seconds after each push while it recomputes mergeability -- treating
	// that as "clean again" would strip the conflict label and then
	// immediately re-add it plus re-comment on the very next tick.
	const isConfirmedNotDirty =
		pr.mergeStateStatus !== "DIRTY" && pr.mergeStateStatus !== "UNKNOWN";
	const hasConflictLabel = pr.labels.has(CONFLICT_LABEL);
	if (isDirty && !hasConflictLabel) {
		actions.push({ type: "add-label", label: CONFLICT_LABEL });
		actions.push({
			type: "comment",
			body: "This PR is merge-conflicted; required checks are silently skipped until resolved.",
		});
	} else if (isConfirmedNotDirty && hasConflictLabel) {
		actions.push({ type: "remove-label", label: CONFLICT_LABEL });
	}
	// mergeStateStatus: UNKNOWN + label present falls through both branches
	// above: no action either direction, by construction.

	if (pr.autoMergeEnabled && pr.mergeStateStatus === "BEHIND") {
		actions.push({ type: "update-branch" });
	}

	const hasRedCiLabel = pr.labels.has(RED_CI_LABEL);
	if (pr.checksUnknown) {
		// Can't tell clean from errored (review round 1, F2): never strip an
		// existing red-ci label on missing data, and record why so the run
		// summary distinguishes "confirmed green" from "didn't check".
		if (hasRedCiLabel) {
			actions.push({
				type: "note",
				benign: true,
				message: `PR #${pr.number}: statusCheckRollup missing on the head commit; red-ci recovery check skipped this run`,
			});
		}
	} else if (pr.failingRequiredChecks.length > 0 && !hasRedCiLabel) {
		actions.push({ type: "add-label", label: RED_CI_LABEL });
		const lines = pr.failingRequiredChecks.map(
			(c) => `- **${c.name}** failed${c.url ? ` — ${c.url}` : ""}`,
		);
		actions.push({
			type: "comment",
			body: `A required check is failing on the current head:\n\n${lines.join("\n")}`,
		});
	} else if (
		pr.failingRequiredChecks.length === 0 &&
		pr.unresolvedRequiredChecks.length === 0 &&
		hasRedCiLabel
	) {
		// Only remove once every required check has a SETTLED non-failure
		// conclusion. A re-queued check (conclusion null) stays in
		// unresolvedRequiredChecks, so this branch does not fire and the label
		// does not flap while the re-run is in flight (review round 1, F3).
		actions.push({ type: "remove-label", label: RED_CI_LABEL });
	}

	return actions;
}

// update-branch's 403 nuance (#1959): a 403 on a fork-owned PR is the
// workflow token correctly lacking write access to someone else's
// repository -- expected, not a bug, so it is recorded as a distinct benign
// outcome rather than folded into the generic BENIGN_HTTP_STATUSES set (a
// blanket 403->benign would also swallow the real bug this issue reports: a
// 403 on an OWN-branch PR means the token itself lacks contents: write, and
// that must stay loud and fail the run. Every other action/status pair falls
// through to the existing benign-status set unchanged.
//
// Pure and separate from decideActions on purpose: decideActions decides
// WHAT to do (never sees HTTP responses); this decides how to read a
// response AFTER the fact, so it is unit-testable without a network mock,
// same as decideActions.
export function classifyActionFailure(action, pr, status) {
	if (action.type === "update-branch" && status === 403 && pr.isFork) {
		return { benign: true, outcome: "update-branch-forbidden-fork" };
	}
	return { benign: BENIGN_HTTP_STATUSES.has(status), outcome: null };
}

async function restJson(fetcher, method, url, body) {
	const response = await fetcher(url, {
		method,
		headers: {
			accept: "application/vnd.github+json",
			"content-type": "application/json",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return response;
}

/**
 * Apply one decided action against the REST API. Every failure is caught by
 * the caller (runWarden) and recorded per-PR -- one PR's API hiccup must
 * never abort the run for every other open PR. "note" actions carry no API
 * call and are recorded directly by runWarden.
 */
export async function applyAction(fetcher, owner, repo, pr, action) {
	const base = `https://api.github.com/repos/${owner}/${repo}`;
	switch (action.type) {
		case "add-label":
			return restJson(fetcher, "POST", `${base}/issues/${pr.number}/labels`, {
				labels: [action.label],
			});
		case "remove-label":
			return restJson(
				fetcher,
				"DELETE",
				`${base}/issues/${pr.number}/labels/${encodeURIComponent(action.label)}`,
			);
		case "comment":
			return restJson(fetcher, "POST", `${base}/issues/${pr.number}/comments`, {
				body: action.body,
			});
		case "update-branch":
			return restJson(
				fetcher,
				"PUT",
				`${base}/pulls/${pr.number}/update-branch`,
				{ expected_head_sha: pr.headSha },
			);
		case "rerun-run":
			// Full rerun, not rerun-failed-jobs: a starved run has no failed jobs
			// to re-run, because nothing ever executed (#2184).
			return restJson(
				fetcher,
				"POST",
				`${base}/actions/runs/${action.runId}/rerun`,
			);
		case "cancel-run":
			// #2203. GitHub refuses `rerun` on a run that has not completed, so a
			// zombie stuck in `queued` must be cancelled before it can be re-run.
			// A second cancel of the same run returns 409, which is already
			// classified benign.
			return restJson(
				fetcher,
				"POST",
				`${base}/actions/runs/${action.runId}/cancel`,
			);
		default:
			throw new Error(`unknown warden action type: ${action.type}`);
	}
}

/**
 * Run the warden over every open PR. Returns a per-PR log so the caller can
 * print a run summary; a PR whose API calls fail is recorded but does not
 * stop the sweep over the rest of the list. Each recorded error carries a
 * `benign` flag (review round 1, F4): a benign HTTP status (see
 * BENIGN_HTTP_STATUSES) or a "note" is expected noise, never cause for the
 * scheduled run itself to go red; anything else is a real failure.
 */
/**
 * Does the absent-run comment for THIS head already exist? Per-head dedupe
 * needs a per-head key, and the warden's usual label-as-dedupe-key idiom
 * cannot carry one: a label says "absent" but not "absent for which head", so
 * a second consecutive dropped dispatch would go unreported. The comment
 * itself carries the head SHA as an HTML marker, and this reads it back.
 *
 * Called ONLY for a head already classified absent, so the extra REST call
 * lands on the anomalous minority of PRs, never on the healthy sweep.
 */
async function hasAbsentRunComment(fetcher, owner, repo, pr) {
	// Paginated (review round 1, F6): a first-page-only read stops finding its
	// own marker past 100 comments and starts repeating the notice.
	return commentMarkerExists(
		fetcher,
		owner,
		repo,
		pr.number,
		absentRunCommentMarker(pr.headSha),
	);
}

/**
 * Which stalled runs on this head already carry the warden's marker comment?
 * One paged comment read per head, and ONLY for a head that already has a
 * stalled run, so the healthy sweep pays nothing (#2203).
 *
 * Returns null when the read failed: the caller must not treat "we could not
 * look" as "no marker", which would repost the notice and, worse, re-attribute
 * a person's cancellation to the warden.
 */
async function readStalledRunMarkers(fetcher, owner, repo, pr, health) {
	const runs = [
		...(health.stalledRuns ?? []),
		...(health.cancelledStalledRuns ?? []),
	];
	if (runs.length === 0) return new Set();
	return presentCommentMarkers(
		fetcher,
		owner,
		repo,
		pr.number,
		runs.map((run) => stalledRunCommentMarker(run.id)),
	);
}

function describeApplied(action) {
	if (action.type === "rerun-run" || action.type === "cancel-run")
		return `${action.type}:${action.workflowPath}#${action.runId}`;
	return action.type + (action.label ? `:${action.label}` : "");
}

export async function runWarden({ fetcher, owner, repo, now = Date.now() }) {
	const { prs, errors: listErrors } = await fetchOpenPullRequests(
		fetcher,
		owner,
		repo,
	);
	const results = [];
	if (listErrors.length > 0) {
		results.push({
			number: null,
			url: null,
			mergeStateStatus: null,
			applied: [],
			// #2192: the classification is the READER's, not this caller's --
			// `fetchOpenPullRequests` already returns `{ message, benign }`. The
			// old blanket `benign: false` here is what made a routine
			// window-slide duplicate mark the 10-minute run red.
			errors: listErrors,
			runHealth: null,
		});
	}
	for (const pr of prs) {
		const applied = [];
		const errors = [];
		// #2184: run health is read for EVERY open PR head, so the sweep record
		// can name a classification per PR even when nothing needed doing. A
		// stalled train is then visible in one warden cycle instead of at a
		// session gate's timeout.
		const { health, errors: healthErrors } = await fetchHeadRunHealth(
			fetcher,
			owner,
			repo,
			pr.headSha,
			pr.headCommittedDate,
			now,
		);
		for (const message of healthErrors)
			errors.push({ message: `PR #${pr.number}: ${message}`, benign: true });

		let absentCommentExists = false;
		if (health.absentWorkflows.length > 0) {
			try {
				absentCommentExists = await hasAbsentRunComment(
					fetcher,
					owner,
					repo,
					pr,
				);
			} catch (error) {
				// Fail CLOSED on an unreadable comment list: assume the comment is
				// already there rather than risk re-posting the loud dropped-dispatch
				// notice on every tick of an API outage.
				absentCommentExists = true;
				errors.push({
					message: `PR #${pr.number}: ${error instanceof Error ? error.message : String(error)}; absent-run comment suppressed this run`,
					benign: true,
				});
			}
		}

		let stalledRunMarkers = new Set();
		try {
			stalledRunMarkers = await readStalledRunMarkers(
				fetcher,
				owner,
				repo,
				pr,
				health,
			);
		} catch (error) {
			// null, not an empty Set: the ladder must stand still for a cycle
			// rather than act on a guess (#2203).
			stalledRunMarkers = null;
			errors.push({
				message: `PR #${pr.number}: ${error instanceof Error ? error.message : String(error)}; stalled-run markers unreadable this run`,
				benign: true,
			});
		}

		const actions = [
			...decideActions(pr),
			...decideRunHealthActions(pr, health, {
				absentCommentExists,
				stalledRunMarkers,
			}),
		];
		for (const action of actions) {
			if (action.type === "note") {
				errors.push({ message: action.message, benign: action.benign ?? true });
				continue;
			}
			try {
				const response = await applyAction(fetcher, owner, repo, pr, action);
				if (!response.ok) {
					const classification = classifyActionFailure(
						action,
						pr,
						response.status,
					);
					const suffix = classification.outcome
						? ` (${classification.outcome})`
						: "";
					const message =
						`${action.type} ${action.label ?? ""} -> HTTP ${response.status}${suffix}`.trim();
					errors.push({ message, benign: classification.benign });
				} else {
					applied.push(describeApplied(action));
				}
			} catch (error) {
				errors.push({
					message: `${action.type} -> ${error instanceof Error ? error.message : String(error)}`,
					benign: false,
				});
			}
		}
		results.push({
			number: pr.number,
			url: pr.url,
			mergeStateStatus: pr.mergeStateStatus,
			applied,
			errors,
			runHealth: summarizeRunHealth(health),
		});
	}
	return results;
}

/**
 * The sweep record for one head (#2184 AC3): a classification plus the exact
 * workflows behind it, short enough for one line of the run summary.
 */
function summarizeRunHealth(health) {
	const detail = [];
	for (const run of health.starvedRuns)
		detail.push(
			`starved ${run.path} run ${run.id} (attempt ${run.runAttempt})`,
		);
	// #2203 AC4: the sweep record must name the stuck run and how long it has
	// been stuck, so a stalled train is one grep away in the warden run log.
	for (const run of health.stalledRuns ?? [])
		detail.push(
			`stalled ${run.path} run ${run.id} ${run.status} ${Math.round(run.stalledForMinutes ?? 0)}m with zero executed steps (attempt ${run.runAttempt})`,
		);
	for (const run of health.cancelledStalledRuns ?? [])
		detail.push(
			`cancelled zero-step ${run.path} run ${run.id} (attempt ${run.runAttempt})`,
		);
	if (health.absentWorkflows.length > 0)
		detail.push(`no run for ${health.absentWorkflows.join(", ")}`);
	if (health.unknownWorkflows.length > 0)
		detail.push(`unreadable ${health.unknownWorkflows.join(", ")}`);
	if (health.pendingWorkflows.length > 0)
		detail.push(`in flight ${health.pendingWorkflows.join(", ")}`);
	return {
		classification: health.classification,
		detail: detail.join("; "),
	};
}
