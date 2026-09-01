/**
 * Label-gated merge lane (#2185).
 *
 * The review policy is unchanged and NOT automated here: every PR still gets
 * an adversarial review and a same-reviewer verify before anything merges.
 * Only the maintainer applies `train:approved`, so the label IS the review
 * verdict, and this lane only performs the mechanical last step the
 * orchestrating session used to babysit with a polling loop.
 *
 * What the polling loop kept getting wrong, and what this lane fixes:
 *
 * - A fixed timeout expiring silently read as "still pending", forever.
 * - A starved or absent CI run (#2184) also read as "still pending", forever.
 * - A DIRTY PR silently SKIPS its required checks, so "not failing" is not
 *   "passing" (AGENTS.md shape 11).
 *
 * The gate answers those by requiring positive evidence on the EXACT current
 * head: both required checks present, COMPLETED, and SUCCESS, plus a healthy
 * run classification. Everything else is not-green. That single rule is also
 * what re-gates a fix round: a new head has no concluded checks yet, so the
 * label survives and the merge waits without any stored "approved at SHA"
 * state to drift.
 */

import { commentMarkerExists, paginate } from "./github-paging.mjs";
import {
	classifyActionFailure,
	fetchOpenPullRequests,
	REQUIRED_CHECKS,
	resolveCheckRuns,
} from "./merge-train-warden.mjs";
import { fetchHeadRunHealth, RUN_HEALTH } from "./warden-run-health.mjs";

export const TRAIN_APPROVED_LABEL = "train:approved";
export const TRAIN_SQUASH_LABEL = "train:squash";
export const POST_MERGE_EVENT = "merge-train-post-merge";
export const POST_MERGE_DISPATCH_ATTEMPTS = 2;
export const POST_MERGE_RECONCILE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const POST_MERGE_RECONCILE_GRACE_MS = 15 * 60 * 1000;
export const POST_MERGE_RETRY_GENERATION_MS = 6 * 60 * 60 * 1000;
export const POST_MERGE_RECONCILE_PAGE_SIZE = 100;
export const POST_MERGE_RECONCILE_MAX_PAGES = 10;
export const POST_MERGE_RECONCILE_MAX_RECORDS =
	POST_MERGE_RECONCILE_PAGE_SIZE * POST_MERGE_RECONCILE_MAX_PAGES;
export const POST_MERGE_VALIDATION_WORKFLOWS = Object.freeze([
	"ci.yml",
	"lint.yml",
	"install-smoke.yml",
	"labels.yml",
]);
const POST_MERGE_ERROR_CAP = 200;
const POST_MERGE_BOT_LOGIN = "github-actions[bot]";
const GRAPHQL_DATETIME_RE =
	/^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?:\.(?<fraction>\d{1,9}))?(?<zone>Z|[+-]\d{2}:\d{2})$/;

const RECENT_MERGED_PR_QUERY = `
query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(
      states: [CLOSED, MERGED]
      first: ${POST_MERGE_RECONCILE_PAGE_SIZE}
      after: $after
      orderBy: { field: UPDATED_AT, direction: DESC }
    ) {
      pageInfo { hasNextPage endCursor }
      edges {
        cursor
        node {
          number
          state
          updatedAt
          mergedAt
          mergedBy { login }
          mergeCommit { oid }
        }
      }
    }
  }
}`;

function boundedError(error) {
	return String(error instanceof Error ? error.message : error).slice(
		0,
		POST_MERGE_ERROR_CAP,
	);
}

function parseGraphqlDateTime(value, field, page, number) {
	const prefix = `recent merged-PR page ${page} #${number}`;
	if (typeof value !== "string")
		throw new Error(`${prefix} has invalid ${field}`);
	const match = GRAPHQL_DATETIME_RE.exec(value);
	if (!match?.groups) throw new Error(`${prefix} has invalid ${field}`);
	const year = Number(match.groups.year);
	const month = Number(match.groups.month);
	const day = Number(match.groups.day);
	const hour = Number(match.groups.hour);
	const minute = Number(match.groups.minute);
	const second = Number(match.groups.second);
	const fraction = match.groups.fraction ?? "";
	const zone = match.groups.zone;
	const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const daysInMonth = [
		31,
		leapYear ? 29 : 28,
		31,
		30,
		31,
		30,
		31,
		31,
		30,
		31,
		30,
		31,
	][month - 1];
	const offsetHours = zone === "Z" ? 0 : Number(zone.slice(1, 3));
	const offsetMinutes = zone === "Z" ? 0 : Number(zone.slice(4, 6));
	if (
		!daysInMonth ||
		day < 1 ||
		day > daysInMonth ||
		hour > 23 ||
		minute > 59 ||
		second > 59 ||
		offsetHours > 23 ||
		offsetMinutes > 59
	)
		throw new Error(`${prefix} has invalid ${field}`);
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp))
		throw new Error(`${prefix} has invalid ${field}`);
	const offset =
		(zone === "Z" ? 1 : zone[0] === "+" ? 1 : -1) *
		(offsetHours * 60 + offsetMinutes) *
		60_000;
	const milliseconds = fraction.padEnd(3, "0").slice(0, 3);
	const canonical = new Date(timestamp + offset).toISOString();
	const expected = `${match.groups.year}-${match.groups.month}-${match.groups.day}T${match.groups.hour}:${match.groups.minute}:${match.groups.second}.${milliseconds}Z`;
	if (canonical !== expected) throw new Error(`${prefix} has invalid ${field}`);
	return timestamp;
}

// How this repository ACTUALLY marks a check advisory: the workflow job name
// ends in "(advisory)". Probed 2026-08-26 against the live rollups of every
// open PR -- `oxfmt format check (advisory)`, `PR body (advisory)`,
// `Vale prose lint (advisory)`, `OSV scan (advisory)`. Review round 1, F3: a
// hand-written allowlist of two vendor names read `oxfmt format check
// (advisory): FAILURE` as blocking and refused to merge this PR's own head.
// The suffix is the single source of truth the repository already maintains;
// the two vendor names below carry no suffix and stay explicit.
export const ADVISORY_SUFFIX = "(advisory)";
export const ADVISORY_CHECKS = new Set(["SonarCloud Code Analysis", "CodeQL"]);

export function isAdvisoryCheck(name) {
	return (
		ADVISORY_CHECKS.has(name) || String(name ?? "").endsWith(ADVISORY_SUFFIX)
	);
}

// Only positive evidence of a settled pass. GitHub's CheckRun status is
// QUEUED / IN_PROGRESS / COMPLETED and conclusion is null until COMPLETED
// (probed 2026-08-26 against this repository's own open PRs).
export const CONCLUDED_STATUS = "COMPLETED";
export const PASSING_CONCLUSION = "SUCCESS";

// A non-advisory check in any of these states blocks the merge.
export const BLOCKING_CONCLUSIONS = new Set([
	"FAILURE",
	"TIMED_OUT",
	"CANCELLED",
	"ACTION_REQUIRED",
	"STARTUP_FAILURE",
	"STALE",
]);

// States the merge API will actually accept. Review round 1, F1: this
// repository's master protection has `strict: true` (probed 2026-08-26 via
// `GET /branches/master/protection`), so GitHub REFUSES to merge a BEHIND
// head -- and every open PR was BEHIND at the time. BEHIND therefore is not a
// merge state; it is an UPDATE state, handled below.
export const MERGEABLE_STATES = new Set(["CLEAN", "UNSTABLE"]);

// A green PR sitting BEHIND gets the branch update instead of a merge. The
// update writes a new head, which re-gates the PR naturally on the next
// cycle: the new head has no concluded checks yet, so nothing merges until
// they conclude green again. The warden's own update-branch kick cannot cover
// this, because it is gated on `autoMergeEnabled` and a train:approved PR has
// no auto-merge armed.
export const UPDATEABLE_STATES = new Set(["BEHIND"]);

export const MERGE_GATE_REASON = {
	NOT_APPROVED: "not-approved",
	CHECKS_UNKNOWN: "checks-unknown",
	REQUIRED_CHECK_ABSENT: "required-check-absent",
	REQUIRED_CHECK_UNCONCLUDED: "required-check-unconcluded",
	REQUIRED_CHECK_NOT_SUCCESS: "required-check-not-success",
	RUN_HEALTH: "run-health",
	FAILING_CHECK: "failing-check",
	MERGE_STATE: "merge-state",
	BEHIND_BASE: "behind-base",
	NOT_APPROVED_BY_OWNER: "not-approved-by-owner",
	GREEN: "green",
};

/**
 * Pure gate. `pr` is a normalized warden PR record; `health` is a
 * `classifyHeadRun` result for the same head. Returns the decision plus the
 * reason and a human-readable detail line for the PR comment.
 */
export function evaluateMergeGate(pr, health, { approvedBy } = {}) {
	// Unlabeled PRs are never touched, and never commented on: the lane must
	// be invisible to every PR the maintainer has not approved.
	if (!pr.labels.has(TRAIN_APPROVED_LABEL)) {
		return {
			merge: false,
			update: false,
			silent: true,
			method: null,
			reason: MERGE_GATE_REASON.NOT_APPROVED,
			detail: `no ${TRAIN_APPROVED_LABEL} label`,
		};
	}

	const method = pr.labels.has(TRAIN_SQUASH_LABEL) ? "squash" : "merge";
	const deny = (reason, detail) => ({
		merge: false,
		update: false,
		silent: false,
		method,
		reason,
		detail,
	});

	// Review round 1, F5: the label carries the review verdict, so WHO applied
	// it is the whole authority story. Today only the repository owner is a
	// collaborator, so nobody else can add a label at all -- but the day a
	// second collaborator exists, "anyone who can label can merge" is a much
	// larger grant than this lane is meant to hand out. The caller resolves
	// the actor from the PR's timeline; an unresolved actor is a denial, not a
	// pass, so an unreadable timeline can only hold a merge.
	if (!approvedBy?.allowed)
		return deny(
			MERGE_GATE_REASON.NOT_APPROVED_BY_OWNER,
			`\`${TRAIN_APPROVED_LABEL}\` was applied by \`${approvedBy?.actor ?? "an unresolved actor"}\`, who is not on the merge-train approver list`,
		);

	// A missing rollup is missing information, not a green head.
	if (pr.checksUnknown)
		return deny(
			MERGE_GATE_REASON.CHECKS_UNKNOWN,
			"GitHub reported no check rollup for the head commit",
		);

	const byName = resolveCheckRuns(pr.checkRuns);
	for (const name of REQUIRED_CHECKS) {
		const run = byName.get(name);
		// Absent is the DIRTY-skip and dropped-dispatch case. It is the single
		// most important not-green branch in this file.
		if (!run)
			return deny(
				MERGE_GATE_REASON.REQUIRED_CHECK_ABSENT,
				`\`${name}\` has not reported on \`${pr.headSha}\`; an absent required check is not a passing one`,
			);
		if (run.status !== CONCLUDED_STATUS)
			return deny(
				MERGE_GATE_REASON.REQUIRED_CHECK_UNCONCLUDED,
				`\`${name}\` is ${run.status ?? "unreported"} on \`${pr.headSha}\`, not concluded`,
			);
		if (run.conclusion !== PASSING_CONCLUSION)
			return deny(
				MERGE_GATE_REASON.REQUIRED_CHECK_NOT_SUCCESS,
				`\`${name}\` concluded ${run.conclusion ?? "null"} on \`${pr.headSha}\``,
			);
	}

	// Starved, stalled, and absent runs read as not-green even when a stale
	// check run from an earlier attempt looks settled (#2184, #2203). The test
	// is "not NORMAL", so a new classification is gated the day it is added,
	// not the day someone remembers to list it here.
	if (health.classification !== RUN_HEALTH.NORMAL)
		return deny(
			MERGE_GATE_REASON.RUN_HEALTH,
			`workflow run health is \`${health.classification}\` on \`${pr.headSha}\``,
		);

	// Judge the RESOLVED run per name, so a superseded duplicate cannot block
	// a head whose current run passed, and a newer failing duplicate cannot be
	// hidden by an older passing one.
	const failing = [...byName.values()].filter(
		(c) =>
			!isAdvisoryCheck(c.name) &&
			c.conclusion != null &&
			BLOCKING_CONCLUSIONS.has(c.conclusion),
	);
	if (failing.length > 0)
		return deny(
			MERGE_GATE_REASON.FAILING_CHECK,
			`non-advisory checks are failing: ${failing.map((c) => `\`${c.name}\` (${c.conclusion})`).join(", ")}`,
		);

	// BEHIND is not a refusal: it is the update lever. Everything above has
	// already passed, so the only thing between this PR and master is the
	// strict-protection requirement that the head be up to date.
	if (UPDATEABLE_STATES.has(pr.mergeStateStatus))
		return {
			merge: false,
			update: true,
			silent: false,
			method,
			reason: MERGE_GATE_REASON.BEHIND_BASE,
			detail: `every gate is green, but master protection is \`strict\`, so the head must be updated first. Updating the branch now; the new head re-gates on its own checks.`,
		};

	if (!MERGEABLE_STATES.has(pr.mergeStateStatus))
		return deny(
			MERGE_GATE_REASON.MERGE_STATE,
			`mergeable state is \`${pr.mergeStateStatus}\``,
		);

	return {
		merge: true,
		update: false,
		silent: false,
		method,
		reason: MERGE_GATE_REASON.GREEN,
		detail: `every required check concluded success on \`${pr.headSha}\``,
	};
}

/**
 * Per-head, per-reason dedupe key. The head SHA is in the marker so a fix
 * round gets a fresh wait comment, and the reason is in it so a PR that moves
 * from "waiting for checks" to "checks failed" says so once.
 */
export function laneCommentMarker(headSha, reason) {
	return `<!-- train-lane:${headSha}:${reason} -->`;
}

export function laneCommentBody(pr, gate) {
	let header = "**Merge train: holding.**";
	if (gate.merge) header = "**Merge train: merged.**";
	else if (gate.update) header = "**Merge train: updating the branch.**";
	const lines = [header, "", gate.detail, ""];
	if (!gate.merge) {
		lines.push(
			`The \`${TRAIN_APPROVED_LABEL}\` label stays on. This lane re-checks every cycle and merges once the current head's required checks conclude success. Remove the label to abort.`,
			"",
		);
	}
	lines.push(laneCommentMarker(pr.headSha, gate.reason));
	return lines.join("\n");
}

export function mergeFailureCommentBody(pr, gate, status) {
	return [
		"**Merge train: the merge call failed.**",
		"",
		`GitHub refused the \`${gate.method}\` merge of \`${pr.headSha}\` with HTTP ${status}. A 409 means the head moved between the gate read and the merge call, which is the head-change guard working; anything else needs a look.`,
		"",
		laneCommentMarker(pr.headSha, `merge-failed-${status}`),
	].join("\n");
}

async function rest(fetcher, method, url, body) {
	return fetcher(url, {
		method,
		headers: {
			accept: "application/vnd.github+json",
			"content-type": "application/json",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

async function laneCommentExists(fetcher, owner, repo, pr, reason) {
	return commentMarkerExists(
		fetcher,
		owner,
		repo,
		pr.number,
		laneCommentMarker(pr.headSha, reason),
	);
}

/**
 * Resolve WHO applied `train:approved`, from the PR's own timeline. The last
 * `labeled` event for that label is the current provenance: if a maintainer
 * removes and a bot re-adds it, the bot is the actor.
 *
 * Fails CLOSED. An unreadable timeline, a missing event, or an actor outside
 * the approver list all return `allowed: false`.
 */
export async function resolveApprovalActor(
	fetcher,
	owner,
	repo,
	prNumber,
	approvers,
) {
	const allowlist = new Set(approvers ?? []);
	let actor = null;
	try {
		const events = await paginate(
			fetcher,
			`https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/timeline`,
		);
		for (const event of events) {
			if (event?.event !== "labeled") continue;
			if (event?.label?.name !== TRAIN_APPROVED_LABEL) continue;
			actor = event?.actor?.login ?? null;
		}
	} catch (error) {
		return {
			allowed: false,
			actor: null,
			error: error instanceof Error ? error.message : String(error),
		};
	}
	return { allowed: actor != null && allowlist.has(actor), actor, error: null };
}

/**
 * The merge call itself. `sha` is the head the gate actually evaluated:
 * GitHub rejects the merge with 409 if the head moved in between, so a fix
 * round pushed mid-cycle cannot be merged on a stale verdict even in the
 * window between this lane's read and its write.
 */
export async function mergePullRequest(fetcher, owner, repo, pr, method) {
	return rest(
		fetcher,
		"PUT",
		`https://api.github.com/repos/${owner}/${repo}/pulls/${pr.number}/merge`,
		{ merge_method: method, sha: pr.headSha },
	);
}

/**
 * Ask GitHub to replay the master-push validation workflows for the commit
 * produced by the merge. `GITHUB_TOKEN` suppresses the push event that would
 * normally start them, but repository_dispatch is explicitly exempt from
 * that recursion rule. The payload carries both identities so consumers
 * cannot accidentally validate the default branch at a different commit.
 */
export async function dispatchPostMergeValidation(
	fetcher,
	owner,
	repo,
	mergeSha,
	prNumber,
) {
	return rest(
		fetcher,
		"POST",
		`https://api.github.com/repos/${owner}/${repo}/dispatches`,
		{
			event_type: POST_MERGE_EVENT,
			client_payload: {
				repository: `${owner}/${repo}`,
				sha: mergeSha,
				pr_number: prNumber,
			},
		},
	);
}

/**
 * Retry only the transient/ambiguous dispatch outcomes. A timeout can mean
 * GitHub accepted the event before the client lost its response, so retries
 * are intentionally idempotent at the workflow boundary: each consumer has
 * a per-SHA concurrency key and cancels a duplicate in-flight run.
 */
export async function dispatchPostMergeValidationWithRetry(
	fetcher,
	owner,
	repo,
	mergeSha,
	prNumber,
) {
	let lastResponse;
	let lastError;
	for (let attempt = 1; attempt <= POST_MERGE_DISPATCH_ATTEMPTS; attempt++) {
		try {
			lastResponse = await dispatchPostMergeValidation(
				fetcher,
				owner,
				repo,
				mergeSha,
				prNumber,
			);
			const retryable =
				lastResponse.status === 408 ||
				lastResponse.status === 429 ||
				lastResponse.status >= 500;
			if (
				lastResponse.ok ||
				!retryable ||
				attempt === POST_MERGE_DISPATCH_ATTEMPTS
			)
				return { response: lastResponse, attempts: attempt };
		} catch (error) {
			lastError = error;
			if (attempt === POST_MERGE_DISPATCH_ATTEMPTS) throw error;
		}
	}
	if (lastResponse) {
		return { response: lastResponse, attempts: POST_MERGE_DISPATCH_ATTEMPTS };
	}
	throw lastError ?? new Error("post-merge validation dispatch failed");
}

function postMergeRequestMarker(mergeSha, attempt, generation, requestedAt) {
	return `<!-- merge-train-post-merge:sha=${mergeSha}:state=requested:attempt=${attempt}:generation=${generation}:at=${requestedAt} -->`;
}

function postMergeExhaustedMarker(mergeSha, generation, exhaustedAt) {
	return `<!-- merge-train-post-merge:sha=${mergeSha}:state=exhausted:generation=${generation}:at=${exhaustedAt} -->`;
}

async function readIssueComments(fetcher, owner, repo, number) {
	return paginate(
		fetcher,
		`https://api.github.com/repos/${owner}/${repo}/issues/${number}/comments`,
	);
}

async function readPostMergeState(fetcher, owner, repo, number, mergeSha, now) {
	const comments = await readIssueComments(fetcher, owner, repo, number);
	const requests = [];
	const exhaustedGenerations = new Set();
	const workflows = new Map();
	const escapedSha = mergeSha.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const requestPattern = new RegExp(
		`merge-train-post-merge:sha=${escapedSha}:state=requested:attempt=(\\d+):generation=(\\d+):at=(\\d+)`,
	);
	const legacyPattern = new RegExp(
		`merge-train-post-merge:sha=${escapedSha}:dispatched`,
	);
	const exhaustedPattern = new RegExp(
		`merge-train-post-merge:sha=${escapedSha}:state=exhausted:generation=(\\d+):at=(\\d+)`,
	);
	const validationPattern = new RegExp(
		`merge-train-post-merge:sha=${escapedSha}:workflow=([^:]+):state=(succeeded|failed)`,
	);
	for (const comment of comments) {
		if (comment?.user?.login !== POST_MERGE_BOT_LOGIN) continue;
		const body = String(comment?.body ?? "");
		const request = body.match(requestPattern);
		if (request) {
			const attempt = Number(request[1]);
			const generation = Number(request[2]);
			const requestedAt = Number(request[3]);
			if (
				Number.isSafeInteger(attempt) &&
				Number.isSafeInteger(generation) &&
				Number.isSafeInteger(requestedAt) &&
				requestedAt <= now
			) {
				requests.push({ attempt, generation, requestedAt });
			}
		} else if (legacyPattern.test(body)) {
			requests.push({ attempt: 1, generation: 0, requestedAt: 0 });
		}
		const exhausted = body.match(exhaustedPattern);
		if (exhausted && Number.isSafeInteger(Number(exhausted[1])))
			exhaustedGenerations.add(Number(exhausted[1]));
		const validation = body.match(validationPattern);
		if (!validation || !POST_MERGE_VALIDATION_WORKFLOWS.includes(validation[1]))
			continue;
		const previous = workflows.get(validation[1]);
		if (previous !== "failed") workflows.set(validation[1], validation[2]);
	}
	return { requests, exhaustedGenerations, workflows };
}

async function recordPostMergeDispatch(
	fetcher,
	owner,
	repo,
	number,
	mergeSha,
	attempt,
	generation,
	requestedAt,
) {
	return rest(
		fetcher,
		"POST",
		`https://api.github.com/repos/${owner}/${repo}/issues/${number}/comments`,
		{
			body: `Post-merge validation dispatch requested for ${mergeSha} (generation ${generation}, attempt ${attempt}).\n\n${postMergeRequestMarker(mergeSha, attempt, generation, requestedAt)}`,
		},
	);
}

async function recordPostMergeExhausted(
	fetcher,
	owner,
	repo,
	number,
	mergeSha,
	generation,
	exhaustedAt,
) {
	return rest(
		fetcher,
		"POST",
		`https://api.github.com/repos/${owner}/${repo}/issues/${number}/comments`,
		{
			body: `Post-merge validation has no terminal result for ${mergeSha} after ${POST_MERGE_DISPATCH_ATTEMPTS} request attempts in generation ${generation}.\n\n${postMergeExhaustedMarker(mergeSha, generation, exhaustedAt)}`,
		},
	);
}

/**
 * Read only the recent ordered window. The REST pull-list is exhaustive and
 * omits mergedBy, so it cannot be shared with comment-marker reads: this
 * connection carries the identity and uses updatedAt only as its boundary.
 */
async function readRecentMergedPullRequests(
	fetcher,
	owner,
	repo,
	now,
	windowMs,
) {
	const cutoff = now - windowMs;
	const records = [];
	const seenNumbers = new Set();
	const seenCursors = new Set();
	let after = null;
	let previousUpdatedAt = Number.POSITIVE_INFINITY;

	for (let page = 1; page <= POST_MERGE_RECONCILE_MAX_PAGES; page++) {
		const response = await fetcher("https://api.github.com/graphql", {
			method: "POST",
			headers: {
				accept: "application/vnd.github+json",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				query: RECENT_MERGED_PR_QUERY,
				variables: { owner, name: repo, after },
			}),
		});
		if (!response.ok)
			throw new Error(
				`recent merged-PR page ${page} -> HTTP ${response.status}`,
			);
		const payload = await response.json();
		if (payload?.errors?.length)
			throw new Error(
				`recent merged-PR page ${page} -> GraphQL: ${payload.errors.map((error) => error?.message ?? String(error)).join("; ")}`,
			);
		const connection = payload?.data?.repository?.pullRequests;
		if (!connection || !Array.isArray(connection.edges))
			throw new Error(`recent merged-PR page ${page} returned no edges`);
		const pageEdges = connection.edges;
		const pageInfo = connection.pageInfo;
		if (!pageInfo || typeof pageInfo.hasNextPage !== "boolean")
			throw new Error(`recent merged-PR page ${page} has malformed page info`);
		if (pageEdges.length === 0) {
			if (pageInfo.hasNextPage)
				throw new Error(
					`recent merged-PR page ${page} has next page without records`,
				);
			if (pageInfo.endCursor !== null)
				throw new Error(
					`recent merged-PR page ${page} has invalid empty terminal cursor`,
				);
			return records;
		}
		if (records.length + pageEdges.length > POST_MERGE_RECONCILE_MAX_RECORDS)
			throw new Error(
				`recent merged-PR window exceeded ${POST_MERGE_RECONCILE_MAX_RECORDS} records; read truncated`,
			);
		if (pageEdges.length > POST_MERGE_RECONCILE_PAGE_SIZE)
			throw new Error(
				`recent merged-PR page ${page} exceeded ${POST_MERGE_RECONCILE_PAGE_SIZE} records`,
			);
		if (
			typeof pageInfo.endCursor !== "string" ||
			pageInfo.endCursor.length === 0
		)
			throw new Error(`recent merged-PR page ${page} has no end cursor`);
		if (after !== null && pageInfo.endCursor === after)
			throw new Error(`recent merged-PR page ${page} cursor did not advance`);

		for (const edge of pageEdges) {
			if (typeof edge?.cursor !== "string" || edge.cursor.length === 0)
				throw new Error(
					`recent merged-PR page ${page} has malformed edge cursor`,
				);
			if (seenCursors.has(edge.cursor))
				throw new Error(
					`recent merged-PR page ${page} has repeated edge cursor`,
				);
			seenCursors.add(edge.cursor);
			const node = edge?.node;
			if (!node || !Number.isSafeInteger(node.number))
				throw new Error(`recent merged-PR page ${page} has malformed record`);
			if (node.state !== "CLOSED" && node.state !== "MERGED")
				throw new Error(
					`recent merged-PR page ${page} #${node.number} has invalid state`,
				);
			const updatedAt = parseGraphqlDateTime(
				node.updatedAt,
				"updatedAt",
				page,
				node.number,
			);
			if (updatedAt > previousUpdatedAt)
				throw new Error(
					`recent merged-PR ordering increased at page ${page} #${node.number}`,
				);
			previousUpdatedAt = updatedAt;
			if (seenNumbers.has(node.number))
				throw new Error(
					`recent merged-PR pagination repeated #${node.number} at page ${page}`,
				);
			seenNumbers.add(node.number);
			if (node.state === "MERGED")
				parseGraphqlDateTime(node.mergedAt, "mergedAt", page, node.number);
			if (
				node.state === "MERGED" &&
				(!node.mergedBy || typeof node.mergedBy.login !== "string")
			)
				throw new Error(
					`recent merged-PR #${node.number} has invalid mergedBy`,
				);
			records.push({
				number: node.number,
				updated_at: node.updatedAt,
				merged_at: node.mergedAt,
				merged_by: node.mergedBy,
				merge_commit_sha: node.mergeCommit?.oid ?? null,
			});
		}

		const lastEdge = pageEdges[pageEdges.length - 1];
		if (lastEdge.cursor !== pageInfo.endCursor)
			throw new Error(
				`recent merged-PR page ${page} cursor does not match its edge`,
			);
		const lastUpdatedAt = previousUpdatedAt;
		if (lastUpdatedAt < cutoff) return records;
		if (!pageInfo.hasNextPage) return records;
		if (page === POST_MERGE_RECONCILE_MAX_PAGES)
			throw new Error(
				`recent merged-PR window still full at page ${POST_MERGE_RECONCILE_MAX_PAGES}; read truncated`,
			);
		after = pageInfo.endCursor;
	}
	throw new Error(
		`recent merged-PR window exceeded ${POST_MERGE_RECONCILE_MAX_RECORDS} records; read truncated`,
	);
}

/**
 * Reconcile merge-train dispatches from GitHub's durable merged-PR record.
 * The scan runs on every lane process, so a crash after merge and before the
 * dispatch, or after an accepted dispatch and before validation completes, is
 * repaired by a later run. Only merges performed by this workflow's bot are eligible;
 * ordinary human merges already receive the normal push workflows.
 */
export async function reconcilePostMergeValidations({
	fetcher,
	owner,
	repo,
	now = Date.now(),
	windowMs = POST_MERGE_RECONCILE_WINDOW_MS,
	graceMs = POST_MERGE_RECONCILE_GRACE_MS,
}) {
	let closedPrs;
	try {
		closedPrs = await readRecentMergedPullRequests(
			fetcher,
			owner,
			repo,
			now,
			windowMs,
		);
	} catch (error) {
		return [
			{
				number: null,
				sha: null,
				dispatched: false,
				errors: [`merged-PR reconciliation read -> ${boundedError(error)}`],
			},
		];
	}

	const results = [];
	for (const pr of closedPrs) {
		if (pr?.merged_by?.login !== POST_MERGE_BOT_LOGIN) continue;
		const mergedAt = Date.parse(String(pr?.merged_at ?? ""));
		if (!Number.isFinite(mergedAt) || now - mergedAt > windowMs) continue;
		const mergeSha = pr?.merge_commit_sha;
		if (typeof mergeSha !== "string" || !/^[0-9a-f]{40}$/i.test(mergeSha)) {
			results.push({
				number: pr?.number ?? null,
				sha: null,
				dispatched: false,
				errors: ["merged-PR record has no exact merge SHA"],
			});
			continue;
		}

		let state;
		try {
			state = await readPostMergeState(
				fetcher,
				owner,
				repo,
				pr.number,
				mergeSha,
				now,
			);
		} catch (error) {
			results.push({
				number: pr.number,
				sha: mergeSha,
				dispatched: false,
				errors: [`post-merge marker read -> ${boundedError(error)}`],
			});
			continue;
		}

		const failedWorkflows = POST_MERGE_VALIDATION_WORKFLOWS.filter(
			(workflow) => state.workflows.get(workflow) === "failed",
		);
		if (failedWorkflows.length > 0) {
			results.push({
				number: pr.number,
				sha: mergeSha,
				dispatched: false,
				errors: [
					`post-merge validation failed for ${failedWorkflows.join(", ")} at ${mergeSha}`,
				],
			});
			continue;
		}
		if (
			POST_MERGE_VALIDATION_WORKFLOWS.every(
				(workflow) => state.workflows.get(workflow) === "succeeded",
			)
		)
			continue;
		const generation = Math.floor(
			Math.max(0, now - mergedAt) / POST_MERGE_RETRY_GENERATION_MS,
		);
		const generationRequests = state.requests.filter(
			(request) => request.generation === generation,
		);
		const latestRequestedAt = Math.max(
			-1,
			...generationRequests.map((request) => request.requestedAt),
		);
		if (latestRequestedAt >= 0 && now - latestRequestedAt < graceMs) continue;
		const attempt =
			Math.max(0, ...generationRequests.map((request) => request.attempt)) + 1;
		if (attempt > POST_MERGE_DISPATCH_ATTEMPTS) {
			if (state.exhaustedGenerations.has(generation)) continue;
			let exhaustedMarker;
			try {
				exhaustedMarker = await recordPostMergeExhausted(
					fetcher,
					owner,
					repo,
					pr.number,
					mergeSha,
					generation,
					now,
				);
			} catch (error) {
				results.push({
					number: pr.number,
					sha: mergeSha,
					dispatched: false,
					errors: [`post-merge exhaustion marker -> ${boundedError(error)}`],
				});
				continue;
			}
			results.push({
				number: pr.number,
				sha: mergeSha,
				dispatched: false,
				errors: exhaustedMarker.ok
					? [
							`post-merge validation missing after ${POST_MERGE_DISPATCH_ATTEMPTS} request attempt(s) for ${mergeSha}`,
						]
					: [`post-merge exhaustion marker -> HTTP ${exhaustedMarker.status}`],
			});
			continue;
		}

		try {
			const marker = await recordPostMergeDispatch(
				fetcher,
				owner,
				repo,
				pr.number,
				mergeSha,
				attempt,
				generation,
				now,
			);
			if (!marker.ok) {
				results.push({
					number: pr.number,
					sha: mergeSha,
					dispatched: false,
					errors: [`post-merge request marker -> HTTP ${marker.status}`],
				});
				continue;
			}
			const dispatch = await dispatchPostMergeValidationWithRetry(
				fetcher,
				owner,
				repo,
				mergeSha,
				pr.number,
			);
			if (!dispatch.response.ok) {
				results.push({
					number: pr.number,
					sha: mergeSha,
					dispatched: false,
					errors: [`post-merge dispatch -> HTTP ${dispatch.response.status}`],
				});
				continue;
			}
			results.push({
				number: pr.number,
				sha: mergeSha,
				dispatched: true,
				errors: [],
			});
		} catch (error) {
			results.push({
				number: pr.number,
				sha: mergeSha,
				dispatched: false,
				errors: [
					`post-merge dispatch -> failed after ${POST_MERGE_DISPATCH_ATTEMPTS} attempt(s): ${boundedError(error)}`,
				],
			});
		}
	}
	return results;
}

/**
 * The strict-protection update kick (review round 1, F1). `expected_head_sha`
 * makes it as head-atomic as the merge call: if the branch moved since the
 * gate read, GitHub refuses rather than updating a head nobody evaluated.
 */
export async function updatePullRequestBranch(fetcher, owner, repo, pr) {
	return rest(
		fetcher,
		"PUT",
		`https://api.github.com/repos/${owner}/${repo}/pulls/${pr.number}/update-branch`,
		{ expected_head_sha: pr.headSha },
	);
}

/**
 * Run the lane over every open PR. Returns a per-PR record for the run
 * summary. An unlabeled PR costs zero API calls beyond the shared list read.
 */
export async function runMergeLane({
	fetcher,
	owner,
	repo,
	now = Date.now(),
	approvers = [owner],
}) {
	const { prs, errors: listErrors } = await fetchOpenPullRequests(
		fetcher,
		owner,
		repo,
	);
	const results = [];
	if (listErrors.length > 0) {
		results.push({
			number: null,
			reason: "list-error",
			merged: false,
			// #2192: `fetchOpenPullRequests` classifies its own errors now, so
			// this consumer passes them through instead of re-deciding. The two
			// consumers used to carry the same blanket `benign: false` mapping,
			// which is the shape that let a routine boundary duplicate read as
			// fatal in both of them.
			errors: listErrors,
		});
	}

	for (const pr of prs) {
		if (!pr.labels.has(TRAIN_APPROVED_LABEL)) continue;
		const errors = [];
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

		const approvedBy = await resolveApprovalActor(
			fetcher,
			owner,
			repo,
			pr.number,
			approvers,
		);
		if (approvedBy.error)
			errors.push({
				message: `PR #${pr.number}: timeline read -> ${approvedBy.error}`,
				benign: true,
			});

		const gate = evaluateMergeGate(pr, health, { approvedBy });
		let merged = false;
		let updated = false;

		if (gate.merge) {
			try {
				const response = await mergePullRequest(
					fetcher,
					owner,
					repo,
					pr,
					gate.method,
				);
				merged = response.ok;
				if (response.ok) {
					let mergeBody;
					let mergeBodyReadable = true;
					try {
						mergeBody = await response.json();
					} catch (error) {
						mergeBodyReadable = false;
						errors.push({
							message: `PR #${pr.number}: post-merge validation missing; merge response could not be read (${boundedError(error)})`,
							benign: false,
						});
					}
					const mergeSha = mergeBody?.sha;
					if (!mergeBodyReadable) {
						// The parse failure above already records the missing validation.
					} else if (
						typeof mergeSha !== "string" ||
						!/^[0-9a-f]{40}$/i.test(mergeSha)
					) {
						errors.push({
							message: `PR #${pr.number}: post-merge validation missing; merge response had no exact merge SHA`,
							benign: false,
						});
					} else {
						try {
							const marker = await recordPostMergeDispatch(
								fetcher,
								owner,
								repo,
								pr.number,
								mergeSha,
								1,
								0,
								Date.now(),
							);
							if (!marker.ok) {
								errors.push({
									message: `PR #${pr.number}: post-merge request marker -> HTTP ${marker.status} for ${mergeSha}`,
									benign: false,
								});
								continue;
							}
							const dispatchResult = await dispatchPostMergeValidationWithRetry(
								fetcher,
								owner,
								repo,
								mergeSha,
								pr.number,
							);
							const dispatch = dispatchResult.response;
							if (!dispatch.ok)
								errors.push({
									message: `PR #${pr.number}: post-merge validation dispatch -> HTTP ${dispatch.status} after ${dispatchResult.attempts} attempt(s) for ${mergeSha.slice(0, 64)}`,
									benign: false,
								});
							else {
								// The requested marker is durable state. HTTP acceptance is
								// not validation completion; terminal workflow markers are
								// written by the four repository_dispatch workflows.
							}
						} catch (error) {
							errors.push({
								message: `PR #${pr.number}: post-merge validation dispatch -> failed after ${POST_MERGE_DISPATCH_ATTEMPTS} attempt(s): ${boundedError(error)}`,
								benign: false,
							});
						}
					}
				}
				if (!response.ok) {
					errors.push({
						message: `PR #${pr.number}: merge -> HTTP ${response.status}`,
						benign: response.status === 409,
					});
					// Review round 1, F2: this comment wrote a marker and never read
					// one, so a persistent merge refusal posted an identical comment
					// every cycle -- 144 a day at the 10-minute cron. It now uses the
					// same per-head, per-reason dedupe as every other comment path.
					await postCommentOnce(
						fetcher,
						owner,
						repo,
						pr,
						`merge-failed-${response.status}`,
						mergeFailureCommentBody(pr, gate, response.status),
						errors,
					);
				}
			} catch (error) {
				errors.push({
					message: `PR #${pr.number}: merge -> ${error instanceof Error ? error.message : String(error)}`,
					benign: false,
				});
			}
		} else if (gate.update) {
			// Green but BEHIND under strict protection. Update the branch; the new
			// head re-gates on its own checks next cycle. Never merge in the same
			// pass -- the updated head has not been evaluated by anything.
			try {
				const response = await updatePullRequestBranch(
					fetcher,
					owner,
					repo,
					pr,
				);
				updated = response.ok;
				if (!response.ok) {
					// Review round 2, F1: an update-branch 403 means two different
					// things depending on whose branch it is (#1959). On a FORK
					// without maintainer edits the token correctly lacks write access
					// to someone else's repository -- expected, benign. On an
					// own-repo branch the same 403 means the token itself lacks
					// contents: write, which must stay loud. The warden already
					// encodes exactly this distinction, so read the response through
					// it rather than hand-rolling a second, weaker rule here.
					const classification = classifyActionFailure(
						{ type: "update-branch" },
						pr,
						response.status,
					);
					const suffix = classification.outcome
						? ` (${classification.outcome})`
						: "";
					errors.push({
						message: `PR #${pr.number}: update-branch -> HTTP ${response.status}${suffix}`,
						benign: classification.benign,
					});
				}
			} catch (error) {
				errors.push({
					message: `PR #${pr.number}: update-branch -> ${error instanceof Error ? error.message : String(error)}`,
					benign: false,
				});
			}
		}

		if (merged || !gate.merge) {
			try {
				// A merge success is commented unconditionally (it happens once, and
				// the PR closes). A hold is commented once per head+reason, so a PR
				// waiting three days does not accrue 432 identical comments.
				const alreadySaid =
					!merged &&
					(await laneCommentExists(fetcher, owner, repo, pr, gate.reason));
				if (!alreadySaid)
					await postComment(
						fetcher,
						owner,
						repo,
						pr,
						laneCommentBody(pr, gate),
						errors,
					);
			} catch (error) {
				errors.push({
					message: `PR #${pr.number}: comment -> ${error instanceof Error ? error.message : String(error)}`,
					benign: true,
				});
			}
		}

		results.push({
			number: pr.number,
			url: pr.url,
			reason: gate.reason,
			detail: gate.detail,
			method: gate.method,
			runHealth: health.classification,
			approvedBy: approvedBy.actor,
			merged,
			updated,
			errors,
		});
	}
	return results;
}

async function postComment(fetcher, owner, repo, pr, body, errors) {
	const response = await rest(
		fetcher,
		"POST",
		`https://api.github.com/repos/${owner}/${repo}/issues/${pr.number}/comments`,
		{ body },
	);
	if (!response.ok)
		errors.push({
			message: `PR #${pr.number}: comment -> HTTP ${response.status}`,
			benign: true,
		});
}

/**
 * Post at most one comment per head and reason. Fails CLOSED: if the comment
 * list cannot be read, assume the comment is already there rather than risk
 * the repeat-comment defect the read exists to prevent.
 */
async function postCommentOnce(fetcher, owner, repo, pr, reason, body, errors) {
	let exists = true;
	try {
		exists = await laneCommentExists(fetcher, owner, repo, pr, reason);
	} catch (error) {
		errors.push({
			message: `PR #${pr.number}: comments read -> ${error instanceof Error ? error.message : String(error)}; comment suppressed this run`,
			benign: true,
		});
		return;
	}
	if (!exists) await postComment(fetcher, owner, repo, pr, body, errors);
}
