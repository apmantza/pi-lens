import { describe, expect, it } from "vitest";
import { REQUIRED_CHECKS } from "../../scripts/lib/ci-checks.mjs";
import {
	commentMarkerExists,
	MAX_REST_PAGES,
	REST_PAGE_SIZE,
} from "../../scripts/lib/github-paging.mjs";
import {
	applyAction,
	CONFLICT_LABEL,
	classifyActionFailure,
	decideActions,
	DUPLICATE_REPORT_CAP,
	fetchOpenPullRequests,
	MAX_PAGES,
	PAGE_SIZE,
	RED_CI_LABEL,
	runWarden,
} from "../../scripts/lib/merge-train-warden.mjs";
import {
	absentRunCommentMarker,
	classifyHeadRun,
	countExecutedSteps,
	decideRunHealthActions,
	fetchHeadRunHealth,
	isCancelledStalledRun,
	isStalledRun,
	isStarvedRun,
	RUN_HEALTH,
	STALLED_RUN_MINUTES,
	stalledRunCommentMarker,
} from "../../scripts/lib/warden-run-health.mjs";

function pr(overrides: Record<string, unknown> = {}) {
	return {
		number: 1,
		url: "https://github.com/acme/repo/pull/1",
		headSha: "abc123",
		headCommittedDate: null as string | null,
		mergeStateStatus: "CLEAN",
		autoMergeEnabled: false,
		isFork: false,
		labels: new Set<string>(),
		checksUnknown: false,
		checkRuns: [] as Array<{
			name: string;
			status: string | null;
			conclusion: string | null;
			url?: string;
		}>,
		failingRequiredChecks: [] as Array<{ name: string; url?: string }>,
		unresolvedRequiredChecks: [] as string[],
		...overrides,
	};
}

describe("merge-train warden decision logic (#1844)", () => {
	it("labels and comments once when a clean PR turns DIRTY", () => {
		const actions = decideActions(pr({ mergeStateStatus: "DIRTY" }));
		expect(actions).toEqual([
			{ type: "add-label", label: CONFLICT_LABEL },
			expect.objectContaining({
				type: "comment",
				body: expect.stringContaining("merge-conflicted"),
			}),
		]);
	});

	// Dedupe by label presence: mutating this to `false` (always re-add/comment)
	// must turn this test red -- that is the vacuous-guard screen.
	it("does not re-label or re-comment a PR already labeled conflict", () => {
		const actions = decideActions(
			pr({ mergeStateStatus: "DIRTY", labels: new Set([CONFLICT_LABEL]) }),
		);
		expect(actions).toEqual([]);
	});

	it("removes the conflict label once the PR is confirmed clean again", () => {
		const actions = decideActions(
			pr({ mergeStateStatus: "CLEAN", labels: new Set([CONFLICT_LABEL]) }),
		);
		expect(actions).toEqual([{ type: "remove-label", label: CONFLICT_LABEL }]);
	});

	// Review round 1, F1: GitHub reports UNKNOWN for every open PR for a few
	// seconds after each push while it recomputes mergeability. Treating that
	// as "clean again" would strip the label, then immediately re-add it and
	// re-comment on the very next 10-minute tick.
	it("takes no conflict action while mergeStateStatus is UNKNOWN, even with the label present", () => {
		const actions = decideActions(
			pr({ mergeStateStatus: "UNKNOWN", labels: new Set([CONFLICT_LABEL]) }),
		);
		expect(actions).toEqual([]);
	});

	it("takes no conflict action while mergeStateStatus is UNKNOWN and unlabeled", () => {
		const actions = decideActions(pr({ mergeStateStatus: "UNKNOWN" }));
		expect(actions).toEqual([]);
	});

	it("kicks update-branch only when auto-merge is armed AND the PR is BEHIND", () => {
		expect(
			decideActions(pr({ mergeStateStatus: "BEHIND", autoMergeEnabled: true })),
		).toContainEqual({ type: "update-branch" });
		expect(
			decideActions(
				pr({ mergeStateStatus: "BEHIND", autoMergeEnabled: false }),
			),
		).not.toContainEqual({ type: "update-branch" });
		expect(
			decideActions(pr({ mergeStateStatus: "CLEAN", autoMergeEnabled: true })),
		).not.toContainEqual({ type: "update-branch" });
	});

	// #3754 recurrence: a queued PR that the warden pushes an update-branch
	// commit to is re-tested from scratch and ejected from the queue; and with a
	// queue on master, BEHIND is no reason to push at all.
	it("never kicks update-branch for a PR in the merge queue, or anywhere master has a queue", () => {
		const behind = { mergeStateStatus: "BEHIND", autoMergeEnabled: true };
		expect(
			decideActions(pr({ ...behind, inMergeQueue: true })),
		).not.toContainEqual({ type: "update-branch" });
		expect(
			decideActions(pr({ ...behind, mergeQueueEnabled: true })),
		).not.toContainEqual({ type: "update-branch" });
		expect(decideActions(pr(behind))).toContainEqual({ type: "update-branch" });
	});

	it("labels and comments once when a required check fails, naming it with its run link", () => {
		const actions = decideActions(
			pr({
				failingRequiredChecks: [
					{ name: "Unit tests", url: "https://example/run/9" },
				],
			}),
		);
		expect(actions).toEqual([
			{ type: "add-label", label: RED_CI_LABEL },
			expect.objectContaining({
				type: "comment",
				body: expect.stringContaining("Unit tests"),
			}),
		]);
		const commentAction = actions[1] as { body: string };
		expect(commentAction.body).toContain("https://example/run/9");
	});

	it("does not re-label or re-comment a PR already labeled red-ci", () => {
		const actions = decideActions(
			pr({
				failingRequiredChecks: [{ name: "Unit tests" }],
				labels: new Set([RED_CI_LABEL]),
			}),
		);
		expect(actions).toEqual([]);
	});

	it("removes red-ci once every required check has a settled non-failure conclusion", () => {
		const actions = decideActions(
			pr({
				failingRequiredChecks: [],
				unresolvedRequiredChecks: [],
				labels: new Set([RED_CI_LABEL]),
			}),
		);
		expect(actions).toEqual([{ type: "remove-label", label: RED_CI_LABEL }]);
	});

	// Review round 1, F3: a re-queued required check reports conclusion null
	// while it reruns. Reading that as "not failing" (empty
	// failingRequiredChecks) would flap the label off and re-comment on the
	// next failure, once per re-run.
	it("does not remove red-ci while a previously-failing required check is unresolved (re-queued)", () => {
		const actions = decideActions(
			pr({
				failingRequiredChecks: [],
				unresolvedRequiredChecks: ["Unit tests"],
				labels: new Set([RED_CI_LABEL]),
			}),
		);
		expect(actions).toEqual([]);
	});

	// Review round 1, F2: a null/absent statusCheckRollup is missing
	// information, not evidence of a clean run. Must not silently strip an
	// existing red-ci label; must record why so "confirmed green" and
	// "didn't check" stay distinguishable in the run summary (an
	// empty-vs-errored guard).
	it("does not remove red-ci when the rollup is unknown, and records why", () => {
		const actions = decideActions(
			pr({
				checksUnknown: true,
				failingRequiredChecks: [],
				unresolvedRequiredChecks: [],
				labels: new Set([RED_CI_LABEL]),
			}),
		);
		expect(actions).toEqual([
			{
				type: "note",
				benign: true,
				message: expect.stringContaining("statusCheckRollup missing"),
			},
		]);
	});

	it("takes no red-ci action when the rollup is unknown and the PR is not labeled (nothing to protect)", () => {
		const actions = decideActions(
			pr({
				checksUnknown: true,
				failingRequiredChecks: [],
				unresolvedRequiredChecks: [],
			}),
		);
		expect(actions).toEqual([]);
	});

	it("still removes red-ci on a genuinely all-green rollup (checksUnknown false) -- distinct from the unknown-rollup case", () => {
		const actions = decideActions(
			pr({
				checksUnknown: false,
				failingRequiredChecks: [],
				unresolvedRequiredChecks: [],
				labels: new Set([RED_CI_LABEL]),
			}),
		);
		expect(actions).toEqual([{ type: "remove-label", label: RED_CI_LABEL }]);
	});

	// #1959: a 403 on update-branch means two very different things depending
	// on whose branch it is. Deleting the `pr.isFork` check here (so every
	// update-branch 403 reads as benign) must turn the own-branch case below
	// red -- that is the mutation-proof screen for this branch.
	it("classifies an update-branch 403 on a fork-owned PR as the distinct benign fork outcome", () => {
		const result = classifyActionFailure(
			{ type: "update-branch" },
			pr({ isFork: true }),
			403,
		);
		expect(result).toEqual({
			benign: true,
			outcome: "update-branch-forbidden-fork",
		});
	});

	it("classifies an update-branch 403 on an own-branch PR as fatal, not benign", () => {
		const result = classifyActionFailure(
			{ type: "update-branch" },
			pr({ isFork: false }),
			403,
		);
		expect(result).toEqual({ benign: false, outcome: null });
	});

	it("leaves every other action/status pair on the existing benign-status set", () => {
		expect(
			classifyActionFailure(
				{ type: "add-label", label: CONFLICT_LABEL },
				pr({ isFork: true }),
				403,
			),
		).toEqual({ benign: false, outcome: null });
		expect(
			classifyActionFailure(
				{ type: "update-branch" },
				pr({ isFork: true }),
				422,
			),
		).toEqual({ benign: true, outcome: null });
		expect(
			classifyActionFailure(
				{ type: "update-branch" },
				pr({ isFork: false }),
				404,
			),
		).toEqual({ benign: true, outcome: null });
	});

	it("never proposes a merge or a push -- only label, comment, note, and the sanctioned update-branch kick", () => {
		const allowed = new Set([
			"add-label",
			"remove-label",
			"comment",
			"update-branch",
			"note",
		]);
		for (const state of [
			"DIRTY",
			"BEHIND",
			"CLEAN",
			"BLOCKED",
			"UNSTABLE",
			"UNKNOWN",
		]) {
			for (const auto of [true, false]) {
				const actions = decideActions(
					pr({
						mergeStateStatus: state,
						autoMergeEnabled: auto,
						failingRequiredChecks: [{ name: "Unit tests" }],
					}),
				);
				for (const action of actions)
					expect(allowed.has(action.type)).toBe(true);
			}
		}
	});
});

function fakeGithub(routes: Record<string, unknown>) {
	const calls: Array<{ method: string; url: string; body?: unknown }> = [];
	const fetcher = async (
		url: string,
		init?: { method?: string; body?: string },
	) => {
		const method = init?.method ?? "GET";
		const body = init?.body ? JSON.parse(init.body) : undefined;
		calls.push({ method, url, body });
		const key = `${method} ${url.replace("https://api.github.com", "").split("?")[0]}`;
		const entry = routes[key];
		if (entry === undefined) {
			if (key.endsWith("/merge") && method === "PUT")
				return {
					ok: true,
					status: 200,
					json: async () => ({ sha: MERGE_SHA, merged: true }),
				};
			// Default the #2184 run-health reads to well-formed empty payloads, so
			// a test that only cares about labels/comments does not accidentally
			// assert on an "unreadable runs list" error.
			if (key.includes("/actions/runs"))
				return {
					ok: true,
					status: 200,
					json: async () =>
						key.endsWith("/jobs") ? { jobs: [] } : { workflow_runs: [] },
				};
			if (key.endsWith("/comments") && method === "GET")
				return { ok: true, status: 200, json: async () => [] };
			return { ok: true, status: 200, json: async () => ({}) };
		}
		if (typeof entry === "function") return entry(body);
		return { ok: true, status: 200, json: async () => entry };
	};
	return { fetcher, calls };
}

function checkRun(
	name: string,
	conclusion: string | null,
	detailsUrl = `https://example/${name}`,
) {
	return { __typename: "CheckRun", name, conclusion, detailsUrl };
}

function graphqlPage(
	nodes: unknown[],
	hasNextPage = false,
	endCursor: string | null = null,
) {
	return {
		data: {
			repository: {
				pullRequests: { pageInfo: { hasNextPage, endCursor }, nodes },
			},
		},
	};
}

function prNode(overrides: Record<string, unknown> = {}) {
	return {
		number: 7,
		url: "https://github.com/acme/repo/pull/7",
		mergeStateStatus: "DIRTY",
		autoMergeRequest: null,
		labels: { nodes: [] },
		commits: {
			nodes: [
				{
					commit: {
						oid: "deadbeef",
						statusCheckRollup: { contexts: { nodes: [] } },
					},
				},
			],
		},
		...overrides,
	};
}

describe("merge-train warden GraphQL fetch + REST apply (#1844)", () => {
	it("normalizes a GraphQL page into flat PR records with failing required checks", async () => {
		const page = graphqlPage([
			prNode({
				commits: {
					nodes: [
						{
							commit: {
								oid: "deadbeef",
								statusCheckRollup: {
									contexts: {
										nodes: [
											checkRun(
												"Unit tests",
												"FAILURE",
												"https://example/run/1",
											),
											checkRun(
												"Lint & type-check",
												"SUCCESS",
												"https://example/run/2",
											),
										],
									},
								},
							},
						},
					],
				},
			}),
		]);
		const { fetcher } = fakeGithub({ "POST /graphql": page });
		const { prs, errors } = await fetchOpenPullRequests(
			fetcher,
			"acme",
			"repo",
		);
		expect(errors).toEqual([]);
		expect(prs).toEqual([
			expect.objectContaining({
				number: 7,
				mergeStateStatus: "DIRTY",
				headSha: "deadbeef",
				autoMergeEnabled: false,
				checksUnknown: false,
				failingRequiredChecks: [
					{ name: "Unit tests", url: "https://example/run/1" },
				],
				unresolvedRequiredChecks: [],
			}),
		]);
	});

	// Review round 1, F5: the required-checks filter must actually filter.
	// Deleting the `REQUIRED_CHECKS.includes(c.name)` guard in normalizePr
	// (so any failing check counts, including non-required ones) must turn
	// this test red.
	it("ignores a failing check that is not in REQUIRED_CHECKS (e.g. SonarCloud)", async () => {
		const page = graphqlPage([
			prNode({
				commits: {
					nodes: [
						{
							commit: {
								oid: "deadbeef",
								statusCheckRollup: {
									contexts: {
										nodes: [checkRun("SonarCloud Code Analysis", "FAILURE")],
									},
								},
							},
						},
					],
				},
			}),
		]);
		const { fetcher } = fakeGithub({ "POST /graphql": page });
		const { prs } = await fetchOpenPullRequests(fetcher, "acme", "repo");
		expect(prs[0].failingRequiredChecks).toEqual([]);
		expect(prs[0].unresolvedRequiredChecks).toEqual(REQUIRED_CHECKS);
	});

	// #3754: the queue fields come from GraphQL: `repository.mergeQueue{id}`
	// (real shape: tests/fixtures/ci-verdict/merge-group-runs.real.json) and the
	// PR's `isInMergeQueue` / `mergeQueueEntry{state position}`.
	it("reads the merge-queue state of master and of each PR", async () => {
		const page = graphqlPage([
			prNode({
				number: 7,
				isInMergeQueue: true,
				mergeQueueEntry: { state: "AWAITING_CHECKS", position: 1 },
			}),
			prNode({ number: 8, isInMergeQueue: false, mergeQueueEntry: null }),
		]);
		page.data.repository = {
			...page.data.repository,
			mergeQueue: { id: "MQ_kwDOC01lZ80xjw" },
		} as typeof page.data.repository;
		const { fetcher } = fakeGithub({ "POST /graphql": page });
		const { prs } = await fetchOpenPullRequests(fetcher, "acme", "repo");
		expect(prs.map((entry) => entry.inMergeQueue)).toEqual([true, false]);
		expect(prs[0].mergeQueueState).toBe("AWAITING_CHECKS");
		expect(prs.map((entry) => entry.mergeQueueEnabled)).toEqual([true, true]);
		const noQueue = await fetchOpenPullRequests(
			fakeGithub({ "POST /graphql": graphqlPage([prNode()]) }).fetcher,
			"acme",
			"repo",
		);
		expect(noQueue.prs[0].mergeQueueEnabled).toBe(false);
	});

	it("labels a failing non-advisory check when the required pair is green", async () => {
		const page = graphqlPage([
			prNode({
				commits: {
					nodes: [
						{
							commit: {
								oid: "deadbeef",
								statusCheckRollup: {
									contexts: {
										nodes: [
											checkRun("Unit tests", "SUCCESS"),
											checkRun("Lint & type-check", "SUCCESS"),
											checkRun("Changelog fragment (fast-fail)", "FAILURE"),
										],
									},
								},
							},
						},
					],
				},
			}),
		]);
		const { fetcher } = fakeGithub({ "POST /graphql": page });
		const { prs } = await fetchOpenPullRequests(fetcher, "acme", "repo");
		const actions = decideActions(prs[0]);
		expect(prs[0].failingRequiredChecks).toEqual([
			expect.objectContaining({ name: "Changelog fragment (fast-fail)" }),
		]);
		expect(actions).toContainEqual({ type: "add-label", label: RED_CI_LABEL });
	});

	it("does not label a failing advisory check", async () => {
		const page = graphqlPage([
			prNode({
				mergeStateStatus: "CLEAN",
				commits: {
					nodes: [
						{
							commit: {
								oid: "deadbeef",
								statusCheckRollup: {
									contexts: {
										nodes: [
											checkRun("Unit tests", "SUCCESS"),
											checkRun("Lint & type-check", "SUCCESS"),
											checkRun("Vale prose lint (advisory)", "FAILURE"),
										],
									},
								},
							},
						},
					],
				},
			}),
		]);
		const { fetcher } = fakeGithub({ "POST /graphql": page });
		const { prs } = await fetchOpenPullRequests(fetcher, "acme", "repo");
		expect(decideActions(prs[0])).toEqual([]);
	});

	// MEDIUM-1: a discovered CANCELLED check is unresolved evidence, not a
	// failure and not a settled pass. Keep the GraphQL normalization and the
	// red-ci action decision in one fixture so removing the uncertainty guard
	// cannot silently make the warden label or clear the PR.
	it("keeps a discovered CANCELLED check unresolved without changing red-ci", async () => {
		const page = graphqlPage([
			prNode({
				mergeStateStatus: "CLEAN",
				labels: { nodes: [{ name: RED_CI_LABEL }] },
				commits: {
					nodes: [
						{
							commit: {
								oid: "deadbeef",
								statusCheckRollup: {
									contexts: {
										nodes: [
											checkRun("Unit tests", "SUCCESS"),
											checkRun("Lint & type-check", "SUCCESS"),
											checkRun("discovered cancellation", "CANCELLED"),
										],
									},
								},
							},
						},
					],
				},
			}),
		]);
		const { fetcher } = fakeGithub({ "POST /graphql": page });
		const { prs } = await fetchOpenPullRequests(fetcher, "acme", "repo");
		const normalized = prs[0];

		expect(normalized.unresolvedRequiredChecks).toContain(
			"discovered cancellation",
		);
		expect(normalized.failingRequiredChecks).toEqual([]);
		expect(decideActions(normalized)).not.toContainEqual({
			type: "add-label",
			label: RED_CI_LABEL,
		});
		expect(decideActions(normalized)).not.toContainEqual({
			type: "remove-label",
			label: RED_CI_LABEL,
		});
	});

	it("marks a required check missing from the rollup as unresolved, not passing", async () => {
		const page = graphqlPage([
			prNode({
				mergeStateStatus: "CLEAN",
				labels: { nodes: [{ name: RED_CI_LABEL }] },
				commits: {
					nodes: [
						{
							commit: {
								oid: "deadbeef",
								statusCheckRollup: {
									contexts: { nodes: [checkRun("Unit tests", "SUCCESS")] },
								},
							},
						},
					],
				},
			}),
		]);
		const { fetcher } = fakeGithub({ "POST /graphql": page });
		const { prs } = await fetchOpenPullRequests(fetcher, "acme", "repo");
		expect(prs[0].failingRequiredChecks).toEqual([]);
		expect(prs[0].unresolvedRequiredChecks).toEqual(["Lint & type-check"]);
		expect(decideActions(prs[0])).toEqual([]);
	});

	it("marks a re-queued required check (conclusion null) as unresolved", async () => {
		const page = graphqlPage([
			prNode({
				commits: {
					nodes: [
						{
							commit: {
								oid: "deadbeef",
								statusCheckRollup: {
									contexts: { nodes: [checkRun("Unit tests", null)] },
								},
							},
						},
					],
				},
			}),
		]);
		const { fetcher } = fakeGithub({ "POST /graphql": page });
		const { prs } = await fetchOpenPullRequests(fetcher, "acme", "repo");
		expect(prs[0].unresolvedRequiredChecks).toContain("Unit tests");
		expect(prs[0].failingRequiredChecks).toEqual([]);
	});

	it("flags checksUnknown when statusCheckRollup is null", async () => {
		const page = graphqlPage([
			prNode({
				commits: {
					nodes: [{ commit: { oid: "deadbeef", statusCheckRollup: null } }],
				},
			}),
		]);
		const { fetcher } = fakeGithub({ "POST /graphql": page });
		const { prs } = await fetchOpenPullRequests(fetcher, "acme", "repo");
		expect(prs[0].checksUnknown).toBe(true);
	});

	it("bails gracefully on a malformed page instead of throwing", async () => {
		const { fetcher } = fakeGithub({
			"POST /graphql": {
				data: { repository: { pullRequests: { nodes: "not-an-array" } } },
			},
		});
		await expect(
			fetchOpenPullRequests(fetcher, "acme", "repo"),
		).resolves.toEqual({ prs: [], errors: [] });
	});

	// Review round 1, F6: GraphQL can return partial `data` alongside
	// `errors`. This must be skip-and-record, not an uncaught throw out of
	// the bare top-level await in the CLI entry point.
	it("records GraphQL errors instead of throwing, keeping any partial data collected", async () => {
		const { fetcher } = fakeGithub({
			"POST /graphql": {
				data: {
					repository: {
						pullRequests: {
							pageInfo: { hasNextPage: false, endCursor: null },
							nodes: [prNode({ number: 1 })],
						},
					},
				},
				errors: [{ message: "some field errored" }],
			},
		});
		const { prs, errors } = await fetchOpenPullRequests(
			fetcher,
			"acme",
			"repo",
		);
		expect(prs).toHaveLength(1);
		// #2192: list errors are { message, benign } records now, so the
		// classification lives at the source instead of at each consumer.
		expect(errors[0].message).toContain("some field errored");
		expect(errors[0].benign).toBe(false);
	});

	it("records a thrown GraphQL request failure instead of propagating", async () => {
		const fetcher = async () => {
			throw new Error("network down");
		};
		const { prs, errors } = await fetchOpenPullRequests(
			fetcher,
			"acme",
			"repo",
		);
		expect(prs).toEqual([]);
		expect(errors[0].message).toContain("network down");
		expect(errors[0].benign).toBe(false);
	});

	// #2134: a full final page with hasNextPage is not an exhausted result.
	// The page-aware fixture makes a cursor bug visible instead of returning
	// the same page for every request.
	it("records truncation when MAX_PAGES pages still claim another page", async () => {
		const pages = Array.from({ length: MAX_PAGES }, (_, pageIndex) =>
			graphqlPage(
				Array.from({ length: PAGE_SIZE }, (_, itemIndex) =>
					prNode({ number: pageIndex * PAGE_SIZE + itemIndex + 1 }),
				),
				true,
				`cursor-${pageIndex}`,
			),
		);
		const calls: unknown[] = [];
		const fetcher = async (_url: string, init?: { body?: string }) => {
			const body = JSON.parse(init?.body ?? "{}");
			calls.push(body);
			const after = body.variables?.after;
			const pageIndex = after ? Number(after.replace("cursor-", "")) + 1 : 0;
			return { ok: true, status: 200, json: async () => pages[pageIndex] };
		};
		const result = await fetchOpenPullRequests(fetcher, "acme", "repo");
		expect(calls).toHaveLength(MAX_PAGES);
		expect(result.prs).toHaveLength(MAX_PAGES * PAGE_SIZE);
		expect(result.errors).toEqual([
			{
				message: `GraphQL pagination truncated after ${MAX_PAGES} pages while hasNextPage=true`,
				benign: false,
			},
		]);
	});

	// The page limit is healthy when the final page exhausts the connection.
	// Hoisting the truncation guard above the hasNextPage break must make this
	// complete population report a false error.
	it("accepts MAX_PAGES full pages when the last page is exhausted", async () => {
		const pages = Array.from({ length: MAX_PAGES }, (_, pageIndex) =>
			graphqlPage(
				Array.from({ length: PAGE_SIZE }, (_, itemIndex) =>
					prNode({ number: pageIndex * PAGE_SIZE + itemIndex + 1 }),
				),
				pageIndex < MAX_PAGES - 1,
				`cursor-${pageIndex}`,
			),
		);
		const calls: unknown[] = [];
		const fetcher = async (_url: string, init?: { body?: string }) => {
			const body = JSON.parse(init?.body ?? "{}");
			calls.push(body);
			const after = body.variables?.after;
			const pageIndex = after ? Number(after.replace("cursor-", "")) + 1 : 0;
			return { ok: true, status: 200, json: async () => pages[pageIndex] };
		};
		const result = await fetchOpenPullRequests(fetcher, "acme", "repo");
		expect(calls).toHaveLength(MAX_PAGES);
		expect(result.prs).toHaveLength(MAX_PAGES * PAGE_SIZE);
		expect(result.errors).toEqual([]);
	});

	// #2150: a repeating/null endCursor must not make the collector replay a
	// page. The error keeps the partial result visibly truncated.
	it("stops on a non-advancing cursor and keeps one copy of the PR", async () => {
		const { fetcher, calls } = fakeGithub({
			"POST /graphql": graphqlPage([prNode()], true, null),
		});
		const result = await fetchOpenPullRequests(fetcher, "acme", "repo");
		expect(calls).toHaveLength(1);
		expect(result.prs).toHaveLength(1);
		expect(result.errors).toEqual([
			{
				message: "GraphQL pagination truncated because cursor did not advance",
				benign: false,
			},
		]);
	});

	it("does not return or process the same PR twice across distinct pages", async () => {
		const pages = [
			graphqlPage(
				[prNode({ number: 7 }), prNode({ number: 8 })],
				true,
				"cursor-1",
			),
			graphqlPage(
				[prNode({ number: 8 }), prNode({ number: 9 })],
				false,
				"cursor-2",
			),
		];
		const calls: unknown[] = [];
		const fetcher = async (_url: string, init?: { body?: string }) => {
			const body = JSON.parse(init?.body ?? "{}");
			calls.push(body);
			return {
				ok: true,
				status: 200,
				json: async () => pages[calls.length - 1],
			};
		};
		const result = await fetchOpenPullRequests(fetcher, "acme", "repo");
		expect(result.prs).toHaveLength(3);
		expect(result.prs.map(({ number }) => number)).toEqual([7, 8, 9]);
		// #2192: ONE record for the page, and benign -- the second page
		// exhausted the connection, so a repeat there is the UPDATED_AT window
		// sliding, not truncation.
		expect(result.errors).toEqual([
			{
				message: expect.stringContaining(
					"repeated 1 PR number(s) on page 2 (#8)",
				),
				benign: true,
			},
		]);
	});

	/**
	 * #2192: the duplicate record was FATAL-channel and PER-NODE. Both halves
	 * are wrong once pagination actually arms (today's 8 open PRs never reach
	 * page 2 at PAGE_SIZE 50, so this is latent, not live).
	 *
	 * The query orders by UPDATED_AT desc. Any open PR updated while the
	 * warden pages shifts the window and pushes PRs from page N onto page
	 * N+1 -- routine on a 10-minute cadence, and this file's own design note
	 * says such races must not mark the run red.
	 */
	describe("#2192 cross-page duplicates", () => {
		/** Serve a fixed list of pages in request order. */
		function servePages(pages: unknown[]) {
			const calls: unknown[] = [];
			const fetcher = async (_url: string, init?: { body?: string }) => {
				calls.push(JSON.parse(init?.body ?? "{}"));
				return {
					ok: true,
					status: 200,
					json: async () => pages[calls.length - 1],
				};
			};
			return { fetcher, calls };
		}

		it("classifies a boundary duplicate as benign when the cursor advanced", async () => {
			const pages = [
				graphqlPage([prNode({ number: 7 }), prNode({ number: 8 })], true, "c1"),
				graphqlPage([prNode({ number: 8 }), prNode({ number: 9 })], true, "c2"),
				graphqlPage([prNode({ number: 10 })], false, "c3"),
			];
			const { fetcher } = servePages(pages);
			const result = await fetchOpenPullRequests(fetcher, "acme", "repo");

			expect(result.prs.map(({ number }) => number)).toEqual([7, 8, 9, 10]);
			expect(result.errors).toHaveLength(1);
			// Pre-fix: benign is false, so a routine window slide reddens the
			// scheduled run every ten minutes.
			expect(result.errors[0].benign).toBe(true);
			expect(result.errors[0].message).toContain("window shifted");
		});

		it("keeps an intra-page duplicate fatal and names the malformed page", async () => {
			const pages = [
				graphqlPage(
					[prNode({ number: 7 }), prNode({ number: 7 }), prNode({ number: 8 })],
					false,
					"c1",
				),
			];
			const { fetcher } = servePages(pages);
			const result = await fetchOpenPullRequests(fetcher, "acme", "repo");

			expect(result.prs.map(({ number }) => number)).toEqual([7, 8]);
			expect(result.errors).toEqual([
				{
					message: expect.stringContaining(
						"malformed page 1: repeated 1 PR number(s) within the page (#7)",
					),
					benign: false,
				},
			]);
			expect(result.errors[0].message).not.toContain("window shifted");
		});

		it("reports intra-page and cross-page duplicates separately", async () => {
			const pages = [
				graphqlPage([prNode({ number: 7 })], true, "c1"),
				graphqlPage(
					[prNode({ number: 7 }), prNode({ number: 8 }), prNode({ number: 8 })],
					false,
					"c2",
				),
			];
			const { fetcher } = servePages(pages);
			const result = await fetchOpenPullRequests(fetcher, "acme", "repo");

			expect(result.errors).toHaveLength(2);
			expect(result.errors).toEqual(
				expect.arrayContaining([
					{
						message: expect.stringContaining("routine boundary repeat"),
						benign: true,
					},
					{
						message: expect.stringContaining("malformed page 2"),
						benign: false,
					},
				]),
			);
		});

		it("keeps a duplicate fatal when the cursor did not advance (real truncation)", async () => {
			// Page 2 repeats page 1 AND hands back the same cursor: the
			// collector was about to replay, which is genuine truncation.
			const pages = [
				graphqlPage([prNode({ number: 7 })], true, "c1"),
				graphqlPage([prNode({ number: 7 })], true, "c1"),
			];
			const { fetcher } = servePages(pages);
			const result = await fetchOpenPullRequests(fetcher, "acme", "repo");

			const duplicate = result.errors.find((e) =>
				e.message.includes("repeated"),
			);
			expect(duplicate?.benign).toBe(false);
			expect(duplicate?.message).toContain("cursor did not advance");
		});

		it("emits ONE record per page naming the count, not one per repeated node", async () => {
			// A fully shifted window: every node on page 2 was already seen.
			const first = Array.from({ length: PAGE_SIZE }, (_, i) =>
				prNode({ number: i + 1 }),
			);
			const pages = [
				graphqlPage(first, true, "c1"),
				graphqlPage(first, false, "c2"),
			];
			const { fetcher } = servePages(pages);
			const result = await fetchOpenPullRequests(fetcher, "acme", "repo");

			// Pre-fix: PAGE_SIZE (50) identical fatal lines in one summary, and
			// up to MAX_PAGES x PAGE_SIZE = 200 across a whole run.
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0].message).toContain(
				`repeated ${PAGE_SIZE} PR number(s) on page 2`,
			);
			expect(result.errors[0].benign).toBe(true);
			// Still one copy of each PR: the dedupe itself is untouched.
			expect(result.prs).toHaveLength(PAGE_SIZE);
		});

		it("caps how many numbers the record lists and says how many it dropped", async () => {
			const first = Array.from({ length: PAGE_SIZE }, (_, i) =>
				prNode({ number: i + 1 }),
			);
			const pages = [
				graphqlPage(first, true, "c1"),
				graphqlPage(first, false, "c2"),
			];
			const { fetcher } = servePages(pages);
			const result = await fetchOpenPullRequests(fetcher, "acme", "repo");

			const message = result.errors[0].message;
			// Mutation guard on the cap itself: remove the slice and every one
			// of the 50 numbers lands in the line.
			const listed = message.match(/#\d+/g) ?? [];
			expect(listed).toHaveLength(DUPLICATE_REPORT_CAP);
			expect(message).toContain(`+${PAGE_SIZE - DUPLICATE_REPORT_CAP} more`);
		});

		it("does not redden a warden run over a routine boundary duplicate", async () => {
			// The end-to-end claim: benign must survive the trip through
			// runWarden into the summary the workflow reads for its exit code.
			const pages = [
				graphqlPage([prNode({ number: 7 })], true, "c1"),
				graphqlPage([prNode({ number: 7 })], false, "c2"),
			];
			const { fetcher } = servePages(pages);
			const results = await runWarden({ fetcher, owner: "acme", repo: "repo" });

			const listErrors = results.find(({ number }) => number === null)?.errors;
			expect(listErrors).toHaveLength(1);
			expect(listErrors?.[0].benign).toBe(true);
			expect(results.some((r) => r.errors.some((e) => !e.benign))).toBe(false);
		});
	});

	it("decides actions once when pagination repeats a PR", async () => {
		const { fetcher, calls } = fakeGithub({
			"POST /graphql": graphqlPage([prNode()], true, null),
		});
		await runWarden({ fetcher, owner: "acme", repo: "repo" });
		expect(
			calls.filter(
				({ method, url }) =>
					method === "POST" && url.endsWith("/issues/7/labels"),
			),
		).toHaveLength(1);
		expect(
			calls.filter(
				({ method, url }) =>
					method === "POST" && url.endsWith("/issues/7/comments"),
			),
		).toHaveLength(1);
	});

	it("applyAction issues the exact REST call for each action type", async () => {
		const { fetcher, calls } = fakeGithub({});
		const record = pr({ number: 5, headSha: "abc123" });
		await applyAction(fetcher, "acme", "repo", record, {
			type: "add-label",
			label: CONFLICT_LABEL,
		});
		await applyAction(fetcher, "acme", "repo", record, {
			type: "remove-label",
			label: CONFLICT_LABEL,
		});
		await applyAction(fetcher, "acme", "repo", record, {
			type: "comment",
			body: "hi",
		});
		await applyAction(fetcher, "acme", "repo", record, {
			type: "update-branch",
		});
		expect(calls).toEqual([
			{
				method: "POST",
				url: "https://api.github.com/repos/acme/repo/issues/5/labels",
				body: { labels: [CONFLICT_LABEL] },
			},
			{
				method: "DELETE",
				url: "https://api.github.com/repos/acme/repo/issues/5/labels/conflict",
				body: undefined,
			},
			{
				method: "POST",
				url: "https://api.github.com/repos/acme/repo/issues/5/comments",
				body: { body: "hi" },
			},
			{
				method: "PUT",
				url: "https://api.github.com/repos/acme/repo/pulls/5/update-branch",
				body: { expected_head_sha: "abc123" },
			},
		]);
	});

	it("records one PR's API failure without aborting the sweep over the rest", async () => {
		const page = graphqlPage([
			prNode({ number: 1, url: "u1" }),
			prNode({ number: 2, url: "u2" }),
		]);
		const { fetcher } = fakeGithub({
			"POST /graphql": page,
			"POST /repos/acme/repo/issues/1/labels": () => ({
				ok: false,
				status: 500,
				json: async () => ({}),
			}),
		});
		const results = await runWarden({ fetcher, owner: "acme", repo: "repo" });
		expect(results).toHaveLength(2);
		expect(results[0].errors).toEqual([
			{ message: expect.stringContaining("HTTP 500"), benign: false },
		]);
		expect(results[1].errors).toEqual([]);
		expect(results[1].applied).toContain(`add-label:${CONFLICT_LABEL}`);
	});

	// Review round 1, F4: a closed/deleted PR (404), a racing label add (409),
	// or an update-branch on a fork with maintainer edits off (422) are
	// expected noise on a 10-minute cadence -- they must be recorded but must
	// NOT be counted as a reason for the scheduled run to exit non-zero.
	it("classifies 404/409/422 REST failures as benign, and everything else as fatal", async () => {
		const page = graphqlPage([prNode({ number: 1 })]);
		const { fetcher } = fakeGithub({
			"POST /graphql": page,
			"POST /repos/acme/repo/issues/1/labels": () => ({
				ok: false,
				status: 404,
				json: async () => ({}),
			}),
		});
		const results = await runWarden({ fetcher, owner: "acme", repo: "repo" });
		expect(results[0].errors).toEqual([
			{ message: expect.stringContaining("HTTP 404"), benign: true },
		]);
	});

	// #1959, AC2: the run-level classification must actually reach runWarden's
	// error stream, not just the pure classifyActionFailure unit above.
	it("records an update-branch 403 on a fork-owned BEHIND PR as benign with the fork outcome, not a failure", async () => {
		const page = graphqlPage([
			prNode({
				number: 1,
				mergeStateStatus: "BEHIND",
				autoMergeRequest: { enabledAt: "2026-01-01" },
				isCrossRepository: true,
			}),
		]);
		const { fetcher, calls } = fakeGithub({
			"POST /graphql": page,
			"PUT /repos/acme/repo/pulls/1/update-branch": () => ({
				ok: false,
				status: 403,
				json: async () => ({}),
			}),
		});
		const results = await runWarden({ fetcher, owner: "acme", repo: "repo" });
		expect(results[0].errors).toEqual([
			{
				message: expect.stringContaining("update-branch-forbidden-fork"),
				benign: true,
			},
		]);
		// Review round 2, F2: this is the wiring guard for isFork itself.
		// Deleting `isCrossRepository` from PR_QUERY leaves normalizePr's
		// `Boolean(node.isCrossRepository)` silently reading `undefined` as
		// `false` on every real PR -- the whole fork branch above would then
		// go dead in production while every one of these tests (which fake
		// the GraphQL response by hand) stays green. Assert the query text
		// itself requests the field, so removing it fails here first.
		const graphqlCall = calls.find((c) => c.url.endsWith("/graphql"));
		expect(
			String((graphqlCall?.body as { query?: string } | undefined)?.query),
		).toContain("isCrossRepository");
	});

	it("records an update-branch 403 on an own-branch BEHIND PR as a fatal failure", async () => {
		const page = graphqlPage([
			prNode({
				number: 1,
				mergeStateStatus: "BEHIND",
				autoMergeRequest: { enabledAt: "2026-01-01" },
				isCrossRepository: false,
			}),
		]);
		const { fetcher } = fakeGithub({
			"POST /graphql": page,
			"PUT /repos/acme/repo/pulls/1/update-branch": () => ({
				ok: false,
				status: 403,
				json: async () => ({}),
			}),
		});
		const results = await runWarden({ fetcher, owner: "acme", repo: "repo" });
		expect(results[0].errors).toEqual([
			{ message: expect.stringContaining("HTTP 403"), benign: false },
		]);
	});

	it("records a list-level GraphQL error as its own result entry with number: null", async () => {
		const { fetcher } = fakeGithub({
			"POST /graphql": {
				data: null,
				errors: [{ message: "resource not accessible" }],
			},
		});
		const results = await runWarden({ fetcher, owner: "acme", repo: "repo" });
		expect(results).toEqual([
			{
				number: null,
				url: null,
				mergeStateStatus: null,
				applied: [],
				errors: [
					{
						message: expect.stringContaining("resource not accessible"),
						benign: false,
					},
				],
				runHealth: null,
			},
		]);
	});
});

// ---------------------------------------------------------------------------
// #2184: starved and absent workflow runs
// ---------------------------------------------------------------------------

/**
 * The starved-run fixture is transcribed from the REAL incident run
 * 32986328966 (`.github/workflows/ci.yml` on head 8e32f127, conclusion
 * `failure`, `run_attempt` 1), read with `gh api` on 2026-08-26: six jobs at
 * `status: "queued"` with no steps, plus one matrix job GitHub marked
 * `completed`/`skipped` with no steps. That last job is why "every job is
 * queued" is the WRONG predicate.
 */
function starvedJobs() {
	return [
		{
			name: "Lint & type-check",
			status: "queued",
			conclusion: null,
			steps: [],
		},
		{ name: "Unit tests", status: "queued", conclusion: null, steps: [] },
		{
			name: "Close-keyword syntax",
			status: "queued",
			conclusion: null,
			steps: [],
		},
		{
			name: "Dependency boundaries",
			status: "queued",
			conclusion: null,
			steps: [],
		},
		{
			name: "Changelog fragment (fast-fail)",
			status: "queued",
			conclusion: null,
			steps: [],
		},
		{
			name: "Production install build (--omit=dev, from source)",
			status: "queued",
			conclusion: null,
			steps: [],
		},
		{
			name: "Install test (${{ matrix.os }})",
			status: "completed",
			conclusion: "skipped",
			steps: [],
		},
	];
}

function executedJobs() {
	return [
		{
			name: "Unit tests",
			status: "completed",
			conclusion: "failure",
			steps: [
				{ name: "Set up job", status: "completed", conclusion: "success" },
				{ name: "npm test", status: "completed", conclusion: "failure" },
			],
		},
	];
}

function headRun(overrides: Record<string, unknown> = {}) {
	return {
		id: 32986328966,
		path: ".github/workflows/ci.yml",
		name: "CI",
		status: "completed",
		conclusion: "failure",
		runAttempt: 1,
		url: "https://github.com/acme/repo/actions/runs/32986328966",
		createdAt: "2026-08-26T15:54:50Z",
		jobs: starvedJobs(),
		...overrides,
	};
}

const NOW = Date.parse("2026-08-26T16:30:00Z");
const MERGE_SHA = "0123456789abcdef0123456789abcdef01234567";

describe("starved-run detection (#2184)", () => {
	it("counts only steps GitHub actually executed", () => {
		expect(countExecutedSteps(starvedJobs())).toBe(0);
		expect(countExecutedSteps(executedJobs())).toBe(2);
		expect(countExecutedSteps(null)).toBe(0);
	});

	// The red-first anchor for the whole starved class: this is the real
	// incident run's shape, and nothing in the pre-#2184 warden classified it.
	it("classifies the real incident run (failure, zero executed steps) as starved", () => {
		expect(isStarvedRun(headRun())).toBe(true);
		const health = classifyHeadRun({
			runs: [headRun(), headRun({ id: 2, path: ".github/workflows/lint.yml" })],
			headCommittedDate: "2026-08-26T15:54:00Z",
			now: NOW,
		});
		expect(health.classification).toBe(RUN_HEALTH.STARVED);
		expect(health.starvedRuns.map((r) => r.path)).toEqual([
			".github/workflows/ci.yml",
			".github/workflows/lint.yml",
		]);
	});

	// Mutation screen for the zero-executed-steps guard: widening the
	// predicate to "concluded failure" alone makes every genuinely red PR look
	// starved and re-runs it, which is exactly the failure this feature must
	// not introduce.
	it("does NOT call a genuinely failing run starved -- its jobs executed steps", () => {
		expect(isStarvedRun(headRun({ jobs: executedJobs() }))).toBe(false);
		const health = classifyHeadRun({
			runs: [
				headRun({ jobs: executedJobs() }),
				headRun({
					id: 2,
					path: ".github/workflows/lint.yml",
					conclusion: "success",
					jobs: executedJobs(),
				}),
			],
			headCommittedDate: "2026-08-26T15:54:00Z",
			now: NOW,
		});
		expect(health.classification).toBe(RUN_HEALTH.NORMAL);
		expect(health.starvedRuns).toEqual([]);
	});

	// A human cancelling a run also produces zero executed steps. Re-running it
	// would fight the person who cancelled it.
	it("does NOT call a cancelled zero-step run starved", () => {
		expect(isStarvedRun(headRun({ conclusion: "cancelled" }))).toBe(false);
	});

	it("treats a startup_failure with no jobs at all as starved", () => {
		expect(
			isStarvedRun(headRun({ conclusion: "startup_failure", jobs: [] })),
		).toBe(true);
	});

	// Shape 10: an unreadable jobs list is missing information, not evidence.
	it("classifies a failed run whose jobs could not be read as unknown, not starved", () => {
		expect(isStarvedRun(headRun({ jobs: null }))).toBe(false);
		const health = classifyHeadRun({
			runs: [
				headRun({ jobs: null }),
				headRun({
					id: 2,
					path: ".github/workflows/lint.yml",
					conclusion: "success",
					jobs: executedJobs(),
				}),
			],
			headCommittedDate: "2026-08-26T15:54:00Z",
			now: NOW,
		});
		expect(health.classification).toBe(RUN_HEALTH.UNKNOWN);
		expect(health.unknownWorkflows).toEqual([".github/workflows/ci.yml"]);
	});

	// The incident head carried an earlier lint.yml SUCCESS and a later
	// lint.yml starved failure. Reading the older one wins the wrong answer.
	it("judges the newest run per workflow, not the first one GitHub returns", () => {
		const health = classifyHeadRun({
			runs: [
				headRun({
					id: 1,
					path: ".github/workflows/lint.yml",
					conclusion: "success",
					createdAt: "2026-08-26T15:40:00Z",
					jobs: executedJobs(),
				}),
				headRun({
					id: 2,
					path: ".github/workflows/lint.yml",
					createdAt: "2026-08-26T15:54:50Z",
				}),
				headRun({ id: 3, jobs: executedJobs(), conclusion: "success" }),
			],
			headCommittedDate: "2026-08-26T15:39:00Z",
			now: NOW,
		});
		expect(health.classification).toBe(RUN_HEALTH.STARVED);
		expect(health.starvedRuns.map((r) => r.id)).toEqual([2]);
	});
});

describe("absent-run detection (#2184)", () => {
	it("classifies a head with no tracked run past the grace window as absent", () => {
		const health = classifyHeadRun({
			runs: [],
			headCommittedDate: "2026-08-26T16:00:00Z",
			now: NOW,
		});
		expect(health.classification).toBe(RUN_HEALTH.ABSENT);
		expect(health.absentWorkflows).toEqual([
			".github/workflows/ci.yml",
			".github/workflows/lint.yml",
		]);
		expect(health.ageMinutes).toBe(30);
	});

	// Mutation screen for the grace window: deleting it makes the warden shout
	// "dropped dispatch" at every PR in the seconds between push and dispatch.
	it("classifies a freshly pushed head with no run yet as pending, not absent", () => {
		const health = classifyHeadRun({
			runs: [],
			headCommittedDate: "2026-08-26T16:28:00Z",
			now: NOW,
		});
		expect(health.classification).toBe(RUN_HEALTH.PENDING);
		expect(health.absentWorkflows).toEqual([]);
		expect(health.pendingWorkflows).toHaveLength(2);
	});

	it("classifies a head with no readable commit date as unknown, not absent", () => {
		const health = classifyHeadRun({
			runs: [],
			headCommittedDate: null,
			now: NOW,
		});
		expect(health.classification).toBe(RUN_HEALTH.UNKNOWN);
		expect(health.absentWorkflows).toEqual([]);
	});

	it("reports absence per workflow when only one of the two dispatched", () => {
		const health = classifyHeadRun({
			runs: [headRun({ conclusion: "success", jobs: executedJobs() })],
			headCommittedDate: "2026-08-26T16:00:00Z",
			now: NOW,
		});
		expect(health.classification).toBe(RUN_HEALTH.ABSENT);
		expect(health.absentWorkflows).toEqual([".github/workflows/lint.yml"]);
	});

	it("classifies an in-flight run as pending, never as concluded normally", () => {
		const health = classifyHeadRun({
			runs: [
				headRun({ status: "in_progress", conclusion: null, jobs: [] }),
				headRun({
					id: 2,
					path: ".github/workflows/lint.yml",
					conclusion: "success",
					jobs: executedJobs(),
				}),
			],
			headCommittedDate: "2026-08-26T16:00:00Z",
			now: NOW,
		});
		expect(health.classification).toBe(RUN_HEALTH.PENDING);
	});
});

describe("run-health recovery actions (#2184)", () => {
	const starvedHealth = () => ({
		classification: RUN_HEALTH.STARVED,
		starvedRuns: [headRun()],
		stalledRuns: [],
		cancelledStalledRuns: [],
		absentWorkflows: [],
		unknownWorkflows: [],
		pendingWorkflows: [],
		ageMinutes: 36,
	});

	it("re-runs a starved run on its first attempt", () => {
		expect(decideRunHealthActions(pr(), starvedHealth(), {})).toEqual([
			{
				type: "rerun-run",
				runId: 32986328966,
				workflowPath: ".github/workflows/ci.yml",
			},
		]);
	});

	// Mutation screen for rerun idempotence: GitHub's own run_attempt counter
	// is the dedupe key. Deleting the check re-runs the same starved run every
	// 10 minutes for as long as the outage lasts.
	it("does NOT re-run a starved run the warden already re-ran (attempt 2)", () => {
		const health = starvedHealth();
		health.starvedRuns = [headRun({ runAttempt: 2 })];
		const actions = decideRunHealthActions(pr(), health, {});
		expect(actions).toEqual([
			{
				type: "note",
				benign: false,
				message: expect.stringContaining("STARVED again on attempt 2"),
			},
		]);
		expect(actions.some((a) => a.type === "rerun-run")).toBe(false);
	});

	it("comments once per head when the dispatch is absent, carrying the head marker", () => {
		const actions = decideRunHealthActions(
			pr({ headSha: "cafe1234" }),
			{
				classification: RUN_HEALTH.ABSENT,
				starvedRuns: [],
				stalledRuns: [],
				cancelledStalledRuns: [],
				absentWorkflows: [".github/workflows/ci.yml"],
				unknownWorkflows: [],
				pendingWorkflows: [],
				ageMinutes: 30,
			},
			{ absentCommentExists: false },
		);
		expect(actions).toEqual([
			{
				type: "comment",
				body: expect.stringContaining(absentRunCommentMarker("cafe1234")),
			},
		]);
		expect((actions[0] as { body: string }).body).toContain("never dispatched");
	});

	// Mutation screen for absent-comment dedupe.
	it("does not repeat the absent-run comment while one already exists for this head", () => {
		const actions = decideRunHealthActions(
			pr({ headSha: "cafe1234" }),
			{
				classification: RUN_HEALTH.ABSENT,
				starvedRuns: [],
				stalledRuns: [],
				cancelledStalledRuns: [],
				absentWorkflows: [".github/workflows/ci.yml"],
				unknownWorkflows: [],
				pendingWorkflows: [],
				ageMinutes: 30,
			},
			{ absentCommentExists: true },
		);
		expect(actions).toEqual([
			{
				type: "note",
				benign: true,
				message: expect.stringContaining("comment already posted"),
			},
		]);
	});

	it("proposes nothing for a healthy head", () => {
		expect(
			decideRunHealthActions(
				pr(),
				{
					classification: RUN_HEALTH.NORMAL,
					starvedRuns: [],
					stalledRuns: [],
					cancelledStalledRuns: [],
					absentWorkflows: [],
					unknownWorkflows: [],
					pendingWorkflows: [],
					ageMinutes: 5,
				},
				{},
			),
		).toEqual([]);
	});
});

describe("run-health reads (#2184)", () => {
	it("reads jobs only for FAILED tracked runs, never for healthy ones", async () => {
		const { fetcher, calls } = fakeGithub({
			"GET /repos/acme/repo/actions/runs": {
				workflow_runs: [
					{
						id: 1,
						path: ".github/workflows/ci.yml",
						status: "completed",
						conclusion: "failure",
						run_attempt: 1,
						created_at: "2026-08-26T15:54:50Z",
					},
					{
						id: 2,
						path: ".github/workflows/lint.yml",
						status: "completed",
						conclusion: "success",
						run_attempt: 1,
						created_at: "2026-08-26T15:54:50Z",
					},
					{
						id: 3,
						path: ".github/workflows/osv-scan.yml",
						status: "completed",
						conclusion: "failure",
						run_attempt: 1,
						created_at: "2026-08-26T15:54:50Z",
					},
				],
			},
			"GET /repos/acme/repo/actions/runs/1/jobs": { jobs: starvedJobs() },
		});
		const { health, errors } = await fetchHeadRunHealth(
			fetcher,
			"acme",
			"repo",
			"8e32f127",
			"2026-08-26T15:54:00Z",
			NOW,
		);
		expect(errors).toEqual([]);
		expect(health.classification).toBe(RUN_HEALTH.STARVED);
		const jobCalls = calls.filter((c) => c.url.includes("/jobs"));
		expect(jobCalls).toHaveLength(1);
		expect(jobCalls[0].url).toContain("/actions/runs/1/jobs");
	});

	// Shape 10 again, at the network seam: an API outage must not turn every
	// open PR into a loud "GitHub dropped your dispatch" comment.
	it("classifies an errored runs read as unknown, never as absent", async () => {
		const { fetcher } = fakeGithub({
			"GET /repos/acme/repo/actions/runs": () => ({
				ok: false,
				status: 500,
				json: async () => ({}),
			}),
		});
		const { health, errors } = await fetchHeadRunHealth(
			fetcher,
			"acme",
			"repo",
			"8e32f127",
			"2026-08-26T15:00:00Z",
			NOW,
		);
		expect(health.classification).toBe(RUN_HEALTH.UNKNOWN);
		expect(health.absentWorkflows).toEqual([]);
		expect(errors[0]).toContain("HTTP 500");
	});
});

function runsRoute(runs: unknown[]) {
	return { workflow_runs: runs };
}

describe("warden sweep with run health (#2184)", () => {
	const starvedRunPayload = {
		id: 77,
		path: ".github/workflows/ci.yml",
		status: "completed",
		conclusion: "failure",
		run_attempt: 1,
		created_at: "2026-08-26T15:54:50Z",
	};

	it("re-runs a starved run once and records the classification in the sweep", async () => {
		const page = graphqlPage([
			prNode({
				number: 7,
				mergeStateStatus: "CLEAN",
				commits: {
					nodes: [
						{
							commit: {
								oid: "deadbeef",
								committedDate: "2026-08-26T15:54:00Z",
								statusCheckRollup: { contexts: { nodes: [] } },
							},
						},
					],
				},
			}),
		]);
		const { fetcher, calls } = fakeGithub({
			"POST /graphql": page,
			"GET /repos/acme/repo/actions/runs": runsRoute([
				starvedRunPayload,
				{
					id: 78,
					path: ".github/workflows/lint.yml",
					status: "completed",
					conclusion: "success",
					run_attempt: 1,
					created_at: "2026-08-26T15:54:50Z",
				},
			]),
			"GET /repos/acme/repo/actions/runs/77/jobs": { jobs: starvedJobs() },
		});
		const results = await runWarden({
			fetcher,
			owner: "acme",
			repo: "repo",
			now: NOW,
		});
		const reruns = calls.filter(
			(c) => c.method === "POST" && c.url.endsWith("/actions/runs/77/rerun"),
		);
		expect(reruns).toHaveLength(1);
		expect(results[0].runHealth).toEqual({
			classification: RUN_HEALTH.STARVED,
			detail: expect.stringContaining(
				"starved .github/workflows/ci.yml run 77",
			),
		});
		expect(results[0].applied).toContain(
			"rerun-run:.github/workflows/ci.yml#77",
		);
	});

	it("does not re-run a starved run already on attempt 2, and marks the run red", async () => {
		const page = graphqlPage([
			prNode({
				number: 7,
				mergeStateStatus: "CLEAN",
				commits: {
					nodes: [
						{
							commit: {
								oid: "deadbeef",
								committedDate: "2026-08-26T15:54:00Z",
								statusCheckRollup: { contexts: { nodes: [] } },
							},
						},
					],
				},
			}),
		]);
		const { fetcher, calls } = fakeGithub({
			"POST /graphql": page,
			"GET /repos/acme/repo/actions/runs": runsRoute([
				{ ...starvedRunPayload, run_attempt: 2 },
			]),
			"GET /repos/acme/repo/actions/runs/77/jobs": { jobs: starvedJobs() },
		});
		const results = await runWarden({
			fetcher,
			owner: "acme",
			repo: "repo",
			now: NOW,
		});
		expect(calls.some((c) => c.url.includes("/rerun"))).toBe(false);
		expect(results[0].errors).toContainEqual({
			message: expect.stringContaining("STARVED again on attempt 2"),
			benign: false,
		});
	});

	it("comments once on an absent dispatch and never twice for the same head", async () => {
		const page = graphqlPage([
			prNode({
				number: 7,
				mergeStateStatus: "CLEAN",
				commits: {
					nodes: [
						{
							commit: {
								oid: "deadbeef",
								committedDate: "2026-08-26T15:00:00Z",
								statusCheckRollup: { contexts: { nodes: [] } },
							},
						},
					],
				},
			}),
		]);
		const first = fakeGithub({
			"POST /graphql": page,
			"GET /repos/acme/repo/actions/runs": runsRoute([]),
		});
		await runWarden({
			fetcher: first.fetcher,
			owner: "acme",
			repo: "repo",
			now: NOW,
		});
		const posted = first.calls.filter(
			(c) => c.method === "POST" && c.url.endsWith("/issues/7/comments"),
		);
		expect(posted).toHaveLength(1);
		expect(String((posted[0].body as { body: string }).body)).toContain(
			absentRunCommentMarker("deadbeef"),
		);

		const second = fakeGithub({
			"POST /graphql": page,
			"GET /repos/acme/repo/actions/runs": runsRoute([]),
			"GET /repos/acme/repo/issues/7/comments": [
				{ body: (posted[0].body as { body: string }).body },
			],
		});
		await runWarden({
			fetcher: second.fetcher,
			owner: "acme",
			repo: "repo",
			now: NOW,
		});
		expect(
			second.calls.filter(
				(c) => c.method === "POST" && c.url.endsWith("/issues/7/comments"),
			),
		).toHaveLength(0);
	});

	it("names a run-health classification for every swept PR, even a quiet one", async () => {
		const page = graphqlPage([
			prNode({
				number: 7,
				mergeStateStatus: "CLEAN",
				commits: {
					nodes: [
						{
							commit: {
								oid: "deadbeef",
								committedDate: "2026-08-26T16:29:00Z",
								statusCheckRollup: {
									contexts: {
										nodes: [
											checkRun("Unit tests", "SUCCESS"),
											checkRun("Lint & type-check", "SUCCESS"),
										],
									},
								},
							},
						},
					],
				},
			}),
		]);
		const { fetcher } = fakeGithub({
			"POST /graphql": page,
			"GET /repos/acme/repo/actions/runs": runsRoute([]),
		});
		const results = await runWarden({
			fetcher,
			owner: "acme",
			repo: "repo",
			now: NOW,
		});
		expect(results[0].applied).toEqual([]);
		expect(results[0].runHealth?.classification).toBe(RUN_HEALTH.PENDING);
	});
});

// ---------------------------------------------------------------------------
// #2203: the third degradation signature -- a run stuck `queued`
// ---------------------------------------------------------------------------

/** A run GitHub queued and never scheduled: no jobs, no steps, no progress. */
function queuedRun(overrides: Record<string, unknown> = {}) {
	return headRun({
		id: 32993037596,
		status: "queued",
		conclusion: null,
		createdAt: "2026-08-26T15:00:00Z", // 90 minutes before NOW
		jobs: [],
		...overrides,
	});
}

/** A head whose lint.yml is healthy, so only the ci.yml run is under test. */
function healthyLintRun() {
	return headRun({
		id: 999,
		path: ".github/workflows/lint.yml",
		conclusion: "success",
		jobs: executedJobs(),
	});
}

type StalledFixture = ReturnType<typeof queuedRun> & {
	stalledForMinutes?: number;
};

function stalledHealthOf(
	runs: StalledFixture[],
	cancelled: ReturnType<typeof queuedRun>[] = [],
) {
	return {
		classification: RUN_HEALTH.STALLED,
		starvedRuns: [],
		stalledRuns: runs,
		cancelledStalledRuns: cancelled,
		absentWorkflows: [],
		unknownWorkflows: [],
		pendingWorkflows: [],
		ageMinutes: 90,
	};
}

describe("stalled-run detection (#2203)", () => {
	// The red-first anchor. Before #2203 a queued run classified PENDING
	// forever, however old, and the sweep printed "runs-in-progress" every
	// cycle -- which reads as healthy waiting.
	it("classifies a run queued past the threshold with zero steps as stalled", () => {
		expect(isStalledRun(queuedRun(), NOW)).toBe(true);
		const health = classifyHeadRun({
			runs: [queuedRun(), healthyLintRun()],
			headCommittedDate: "2026-08-26T15:00:00Z",
			now: NOW,
		});
		expect(health.classification).toBe(RUN_HEALTH.STALLED);
		expect(
			health.stalledRuns.map((r: { id: number | string }) => r.id),
		).toEqual([32993037596]);
		expect(health.pendingWorkflows).toEqual([]);
	});

	// Mutation screen for the threshold: delete the age test and every run in
	// the seconds between dispatch and pickup is "stalled", so the warden
	// cancels healthy CI on every open PR.
	it("classifies a freshly queued run as in progress, not stalled", () => {
		const young = queuedRun({ createdAt: "2026-08-26T16:25:00Z" });
		expect(isStalledRun(young, NOW)).toBe(false);
		const health = classifyHeadRun({
			runs: [young, healthyLintRun()],
			headCommittedDate: "2026-08-26T16:25:00Z",
			now: NOW,
		});
		expect(health.classification).toBe(RUN_HEALTH.PENDING);
		expect(health.stalledRuns).toEqual([]);
	});

	// Mutation screen for the zero-executed-steps guard: a long matrix job is
	// genuinely in progress no matter how old the run is. Widening the
	// predicate to "old and not completed" would cancel live CI.
	it("does NOT call a long-running run with executed steps stalled", () => {
		const working = queuedRun({
			status: "in_progress",
			createdAt: "2026-08-26T10:00:00Z", // six and a half hours old
			jobs: executedJobs(),
		});
		expect(isStalledRun(working, NOW)).toBe(false);
		const health = classifyHeadRun({
			runs: [working, healthyLintRun()],
			headCommittedDate: "2026-08-26T10:00:00Z",
			now: NOW,
		});
		expect(health.classification).toBe(RUN_HEALTH.PENDING);
	});

	it("treats the threshold as inclusive at exactly the boundary", () => {
		const atBoundary = queuedRun({ createdAt: "2026-08-26T15:30:00Z" });
		expect(STALLED_RUN_MINUTES).toBe(60);
		expect(isStalledRun(atBoundary, NOW)).toBe(true);
		expect(
			isStalledRun(queuedRun({ createdAt: "2026-08-26T15:30:30Z" }), NOW),
		).toBe(false);
	});

	// Shape 10: "we could not read the jobs" is not evidence of a zombie, and
	// cancelling on a guess would kill a live run.
	it("classifies an aged queued run whose jobs are unreadable as unknown", () => {
		expect(isStalledRun(queuedRun({ jobs: null }), NOW)).toBe(false);
		const health = classifyHeadRun({
			runs: [queuedRun({ jobs: null }), healthyLintRun()],
			headCommittedDate: "2026-08-26T15:00:00Z",
			now: NOW,
		});
		expect(health.classification).toBe(RUN_HEALTH.UNKNOWN);
		expect(health.unknownWorkflows).toEqual([".github/workflows/ci.yml"]);
		expect(health.stalledRuns).toEqual([]);
	});

	// The second rung's input: the run the warden cancelled is completed, but a
	// cancelled required check is not a passing one and it resolves on its own
	// never. Before #2203 this classified NORMAL.
	it("classifies a cancelled zero-step run as stalled, not normal", () => {
		const cancelled = queuedRun({
			status: "completed",
			conclusion: "cancelled",
			jobs: starvedJobs(),
		});
		expect(isCancelledStalledRun(cancelled)).toBe(true);
		const health = classifyHeadRun({
			runs: [cancelled, healthyLintRun()],
			headCommittedDate: "2026-08-26T15:00:00Z",
			now: NOW,
		});
		expect(health.classification).toBe(RUN_HEALTH.STALLED);
		expect(
			health.cancelledStalledRuns.map((r: { id: number | string }) => r.id),
		).toEqual([32993037596]);
	});

	it("does NOT call a cancelled run that executed steps stalled", () => {
		expect(
			isCancelledStalledRun(
				queuedRun({
					status: "completed",
					conclusion: "cancelled",
					jobs: executedJobs(),
				}),
			),
		).toBe(false);
	});

	it("reads jobs for an aged in-flight run, and never for a young one", async () => {
		const routes = (createdAt: string) => ({
			"GET /repos/acme/repo/actions/runs": runsRoute([
				{
					id: 1,
					path: ".github/workflows/ci.yml",
					status: "queued",
					conclusion: null,
					run_attempt: 1,
					created_at: createdAt,
				},
			]),
			"GET /repos/acme/repo/actions/runs/1/jobs": { jobs: [] },
		});
		const aged = fakeGithub(routes("2026-08-26T15:00:00Z"));
		const agedHealth = await fetchHeadRunHealth(
			aged.fetcher,
			"acme",
			"repo",
			"8e32f127",
			"2026-08-26T15:00:00Z",
			NOW,
		);
		expect(agedHealth.health.classification).toBe(RUN_HEALTH.STALLED);
		expect(aged.calls.filter((c) => c.url.includes("/jobs"))).toHaveLength(1);

		const young = fakeGithub(routes("2026-08-26T16:25:00Z"));
		await fetchHeadRunHealth(
			young.fetcher,
			"acme",
			"repo",
			"8e32f127",
			"2026-08-26T16:25:00Z",
			NOW,
		);
		expect(young.calls.filter((c) => c.url.includes("/jobs"))).toHaveLength(0);
	});
});

describe("stalled-run recovery ladder (#2203)", () => {
	it("announces the stuck run first, and cancels nothing in that cycle", () => {
		const actions = decideRunHealthActions(
			pr(),
			stalledHealthOf([{ ...queuedRun(), stalledForMinutes: 90 }]),
			{ stalledRunMarkers: new Set<string>() },
		);
		expect(actions).toEqual([
			{
				type: "comment",
				body: expect.stringContaining(stalledRunCommentMarker(32993037596)),
			},
		]);
		expect((actions[0] as { body: string }).body).toContain("32993037596");
		expect((actions[0] as { body: string }).body).toContain("90 minutes");
		expect(actions.some((a) => a.type === "cancel-run")).toBe(false);
	});

	// Mutation screen for the comment dedupe: without it the ladder reposts the
	// notice every 10 minutes and never advances to the cancel.
	it("cancels the stuck run once its marker exists, without repeating the comment", () => {
		const actions = decideRunHealthActions(
			pr(),
			stalledHealthOf([{ ...queuedRun(), stalledForMinutes: 90 }]),
			{
				stalledRunMarkers: new Set([stalledRunCommentMarker(32993037596)]),
			},
		);
		expect(actions).toEqual([
			{
				type: "cancel-run",
				runId: 32993037596,
				workflowPath: ".github/workflows/ci.yml",
			},
		]);
	});

	it("re-runs a run the warden itself cancelled", () => {
		const cancelled = queuedRun({
			status: "completed",
			conclusion: "cancelled",
			jobs: starvedJobs(),
		});
		const actions = decideRunHealthActions(
			pr(),
			stalledHealthOf([], [cancelled]),
			{
				stalledRunMarkers: new Set([stalledRunCommentMarker(32993037596)]),
			},
		);
		expect(actions).toEqual([
			{
				type: "rerun-run",
				runId: 32993037596,
				workflowPath: ".github/workflows/ci.yml",
			},
		]);
	});

	// Mutation screen for the marker gate: drop it and the warden re-runs work
	// a person deliberately cancelled.
	it("does NOT re-run a cancelled run the warden did not cancel", () => {
		const cancelled = queuedRun({
			status: "completed",
			conclusion: "cancelled",
			jobs: starvedJobs(),
		});
		expect(
			decideRunHealthActions(pr(), stalledHealthOf([], [cancelled]), {
				stalledRunMarkers: new Set<string>(),
			}),
		).toEqual([]);
	});

	// Mutation screen for the run_attempt bound: delete it and the ladder
	// cancels and re-runs the same run every cycle for the whole outage.
	it("stops after one recovery, and marks the warden run red", () => {
		const actions = decideRunHealthActions(
			pr(),
			stalledHealthOf([
				{ ...queuedRun({ runAttempt: 2 }), stalledForMinutes: 90 },
			]),
			{
				stalledRunMarkers: new Set([stalledRunCommentMarker(32993037596)]),
			},
		);
		expect(actions).toEqual([
			{
				type: "note",
				benign: false,
				message: expect.stringContaining("STALLED again on attempt 2"),
			},
		]);
		expect(actions.some((a) => a.type === "cancel-run")).toBe(false);
	});

	// Fail closed: without the markers the warden cannot tell its own
	// cancellation from a person's.
	it("takes no stalled action when the marker read failed", () => {
		const actions = decideRunHealthActions(
			pr(),
			stalledHealthOf([{ ...queuedRun(), stalledForMinutes: 90 }]),
			{ stalledRunMarkers: null },
		);
		expect(actions).toEqual([
			{
				type: "note",
				benign: true,
				message: expect.stringContaining("markers were unreadable"),
			},
		]);
	});
});

describe("warden sweep over a stalled run (#2203)", () => {
	const stalledPayload = {
		id: 77,
		path: ".github/workflows/ci.yml",
		status: "queued",
		conclusion: null,
		run_attempt: 1,
		created_at: "2026-08-26T15:00:00Z",
	};
	// The head's OTHER tracked workflow ran normally, so the sweep is testing
	// the stalled ladder and not the absent-dispatch comment.
	const healthyLintPayload = {
		id: 78,
		path: ".github/workflows/lint.yml",
		status: "completed",
		conclusion: "success",
		run_attempt: 1,
		created_at: "2026-08-26T15:00:00Z",
	};

	function sweepPage() {
		return graphqlPage([
			prNode({
				number: 7,
				mergeStateStatus: "CLEAN",
				commits: {
					nodes: [
						{
							commit: {
								oid: "deadbeef",
								committedDate: "2026-08-26T15:00:00Z",
								statusCheckRollup: { contexts: { nodes: [] } },
							},
						},
					],
				},
			}),
		]);
	}

	it("comments, then cancels on the next cycle, and names the run in the sweep", async () => {
		const first = fakeGithub({
			"POST /graphql": sweepPage(),
			"GET /repos/acme/repo/actions/runs": runsRoute([
				stalledPayload,
				healthyLintPayload,
			]),
			"GET /repos/acme/repo/actions/runs/77/jobs": { jobs: [] },
		});
		const firstResults = await runWarden({
			fetcher: first.fetcher,
			owner: "acme",
			repo: "repo",
			now: NOW,
		});
		const posted = first.calls.filter(
			(c) => c.method === "POST" && c.url.endsWith("/issues/7/comments"),
		);
		expect(posted).toHaveLength(1);
		expect(String((posted[0].body as { body: string }).body)).toContain(
			stalledRunCommentMarker(77),
		);
		expect(first.calls.some((c) => c.url.includes("/cancel"))).toBe(false);
		expect(firstResults[0].runHealth).toEqual({
			classification: RUN_HEALTH.STALLED,
			detail: expect.stringContaining(
				"stalled .github/workflows/ci.yml run 77 queued 90m with zero executed steps",
			),
		});

		const second = fakeGithub({
			"POST /graphql": sweepPage(),
			"GET /repos/acme/repo/actions/runs": runsRoute([
				stalledPayload,
				healthyLintPayload,
			]),
			"GET /repos/acme/repo/actions/runs/77/jobs": { jobs: [] },
			"GET /repos/acme/repo/issues/7/comments": [
				{ body: (posted[0].body as { body: string }).body },
			],
		});
		const secondResults = await runWarden({
			fetcher: second.fetcher,
			owner: "acme",
			repo: "repo",
			now: NOW,
		});
		expect(
			second.calls.filter(
				(c) => c.method === "POST" && c.url.endsWith("/actions/runs/77/cancel"),
			),
		).toHaveLength(1);
		expect(
			second.calls.filter(
				(c) => c.method === "POST" && c.url.endsWith("/issues/7/comments"),
			),
		).toHaveLength(0);
		expect(secondResults[0].applied).toContain(
			"cancel-run:.github/workflows/ci.yml#77",
		);
	});

	it("re-runs the run it cancelled once the cancellation lands", async () => {
		const marker = stalledRunCommentMarker(77);
		const { fetcher, calls } = fakeGithub({
			"POST /graphql": sweepPage(),
			"GET /repos/acme/repo/actions/runs": runsRoute([
				{ ...stalledPayload, status: "completed", conclusion: "cancelled" },
				healthyLintPayload,
			]),
			"GET /repos/acme/repo/actions/runs/77/jobs": { jobs: starvedJobs() },
			"GET /repos/acme/repo/issues/7/comments": [{ body: `x ${marker}` }],
		});
		const results = await runWarden({
			fetcher,
			owner: "acme",
			repo: "repo",
			now: NOW,
		});
		expect(
			calls.filter(
				(c) => c.method === "POST" && c.url.endsWith("/actions/runs/77/rerun"),
			),
		).toHaveLength(1);
		expect(results[0].applied).toContain(
			"rerun-run:.github/workflows/ci.yml#77",
		);
	});

	it("issues the cancel against the runs cancel endpoint", async () => {
		const { fetcher, calls } = fakeGithub({});
		await applyAction(fetcher, "acme", "repo", pr({ number: 7 }), {
			type: "cancel-run",
			runId: 77,
			workflowPath: ".github/workflows/ci.yml",
		});
		expect(calls[0].method).toBe("POST");
		expect(calls[0].url).toBe(
			"https://api.github.com/repos/acme/repo/actions/runs/77/cancel",
		);
	});
});

// Review round 1, F6: the comment-dedupe reads were first-page-only.
describe("bounded REST paging (#2185)", () => {
	function pagedComments(total: number, markerOnLast: string) {
		return (_body: unknown, url: string) => {
			const page = Number(new URL(url).searchParams.get("page") ?? "1");
			const start = (page - 1) * REST_PAGE_SIZE;
			const slice = Array.from(
				{ length: Math.max(0, Math.min(REST_PAGE_SIZE, total - start)) },
				(_, i) => ({
					body:
						start + i === total - 1
							? `last\n${markerOnLast}`
							: `filler ${start + i}`,
				}),
			);
			return { ok: true, status: 200, json: async () => slice };
		};
	}

	it("finds a marker that lives past the first page of comments", async () => {
		const marker = "<!-- warden:absent-run:deadbeef -->";
		const calls: string[] = [];
		const fetcher = async (url: string) => {
			calls.push(url);
			return pagedComments(250, marker)(undefined, url);
		};
		expect(await commentMarkerExists(fetcher, "acme", "repo", 7, marker)).toBe(
			true,
		);
		expect(calls).toHaveLength(3);
		expect(calls[2]).toContain("page=3");
	});

	it("reports a truncated read instead of silently returning a partial list", async () => {
		const fetcher = async (url: string) =>
			pagedComments(REST_PAGE_SIZE * (MAX_REST_PAGES + 1), "never")(
				undefined,
				url,
			);
		await expect(
			commentMarkerExists(fetcher, "acme", "repo", 7, "<!-- nope -->"),
		).rejects.toThrow(/truncated/);
	});
});
