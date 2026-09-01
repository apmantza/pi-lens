import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import {
	commentMarkerExists,
	MAX_REST_PAGES,
	REST_PAGE_SIZE,
} from "../../scripts/lib/github-paging.mjs";
import {
	evaluateMergeGate,
	isAdvisoryCheck,
	laneCommentMarker,
	MERGE_GATE_REASON,
	reconcilePostMergeValidations,
	POST_MERGE_RECONCILE_GRACE_MS,
	POST_MERGE_RECONCILE_WINDOW_MS,
	POST_MERGE_RETRY_GENERATION_MS,
	POST_MERGE_VALIDATION_WORKFLOWS,
	resolveApprovalActor,
	runMergeLane,
	TRAIN_APPROVED_LABEL,
	TRAIN_SQUASH_LABEL,
} from "../../scripts/lib/merge-train-lane.mjs";
import { validateMergeTrainDispatch } from "../../scripts/lib/merge-train-dispatch-validation.mjs";
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
	resolveCheckRuns,
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
import { assertNonEmptyScan } from "../support/sweep-kit.js";

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const WORKFLOWS_DIR = join(REPO_ROOT, ".github", "workflows");
const DISPATCH_VALIDATOR = "scripts/lib/merge-train-dispatch-validation.mjs";
const REPOSITORY_DISPATCH_IF = "github.event_name == 'repository_dispatch'";
const POST_MERGE_RECORDER_IF =
	"always() && github.event_name == 'repository_dispatch' && needs.validate-merge-train-dispatch.result == 'success'";
const PAYLOAD_CHECKOUT_REF =
	"${{ github.event_name == 'repository_dispatch' && github.event.client_payload.sha || github.ref }}";
const CHECKOUT_ACTION =
	"actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";

type RecordValue = Record<string, unknown>;

function recordValue(value: unknown): RecordValue {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as RecordValue)
		: {};
}

function workflowDocuments() {
	return readdirSync(WORKFLOWS_DIR, { withFileTypes: true })
		.filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
		.map((entry) => {
			const path = join(WORKFLOWS_DIR, entry.name);
			return {
				name: entry.name,
				document: recordValue(yaml.load(readFileSync(path, "utf8"))),
			};
		})
		.filter(({ document }) => {
			const dispatch = recordValue(
				recordValue(document.on).repository_dispatch,
			);
			const types = dispatch.types;
			return Array.isArray(types) && types.includes("merge-train-post-merge");
		});
}

function stepsFor(job: unknown): RecordValue[] {
	const steps = recordValue(job).steps;
	return Array.isArray(steps) ? steps.map(recordValue) : [];
}

function needsFor(job: unknown): string[] {
	const needs = recordValue(job).needs;
	return Array.isArray(needs)
		? needs.filter((value): value is string => typeof value === "string")
		: typeof needs === "string"
			? [needs]
			: [];
}

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
			// Default the #2185 label-provenance read to "the repository owner
			// applied it", so a test about the gate does not have to restate the
			// approval story. Tests that care override this route.
			if (key.endsWith("/timeline") && method === "GET")
				return {
					ok: true,
					status: 200,
					json: async () => [
						{
							event: "labeled",
							label: { name: TRAIN_APPROVED_LABEL },
							actor: { login: "acme" },
						},
					],
				};
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

function recentMergedPage(
	records: Array<Record<string, unknown>>,
	hasNextPage = false,
	page = 1,
) {
	const edges = records.map((record, index) => ({
		cursor: `recent-${page}-${index}`,
		node: {
			number: record.number,
			state: "MERGED",
			updatedAt: record.updated_at ?? record.merged_at,
			mergedAt: record.merged_at,
			mergedBy: record.merged_by,
			mergeCommit: { oid: record.merge_commit_sha },
		},
	}));
	return {
		data: {
			repository: {
				pullRequests: {
					pageInfo: {
						hasNextPage,
						endCursor: edges.at(-1)?.cursor ?? null,
					},
					edges,
				},
			},
		},
	};
}

function recentMergedSequence(pages: unknown[]) {
	let index = 0;
	return () => ({
		ok: true,
		status: 200,
		json: async () => pages[Math.min(index++, pages.length - 1)],
	});
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
		expect(prs[0].unresolvedRequiredChecks).toEqual([
			"Unit tests",
			"Lint & type-check",
		]);
	});

	it("marks a required check missing from the rollup as unresolved, not passing", async () => {
		const page = graphqlPage([
			prNode({
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

// ---------------------------------------------------------------------------
// #2185: the label-gated merge lane
// ---------------------------------------------------------------------------

const HEALTHY = {
	classification: RUN_HEALTH.NORMAL,
	starvedRuns: [],
	stalledRuns: [],
	cancelledStalledRuns: [],
	absentWorkflows: [],
	unknownWorkflows: [],
	pendingWorkflows: [],
	ageMinutes: 20,
};

function greenChecks() {
	return [
		{ name: "Unit tests", status: "COMPLETED", conclusion: "SUCCESS" },
		{ name: "Lint & type-check", status: "COMPLETED", conclusion: "SUCCESS" },
	];
}

function approved(overrides: Record<string, unknown> = {}) {
	return pr({
		labels: new Set([TRAIN_APPROVED_LABEL]),
		checkRuns: greenChecks(),
		...overrides,
	});
}

const OWNER_APPROVED = { allowed: true, actor: "apmantza", error: null };

/** The gate, with label provenance already resolved to the repository owner. */
function gateOf(prRecord: ReturnType<typeof pr>, health = HEALTHY) {
	return evaluateMergeGate(prRecord, health, { approvedBy: OWNER_APPROVED });
}

describe("merge-lane gate (#2185)", () => {
	it("merges an approved PR whose current head concluded green", () => {
		const gate = gateOf(approved());
		expect(gate).toMatchObject({
			merge: true,
			method: "merge",
			reason: MERGE_GATE_REASON.GREEN,
		});
	});

	it("uses the squash method when the PR also carries train:squash", () => {
		const gate = gateOf(
			approved({
				labels: new Set([TRAIN_APPROVED_LABEL, TRAIN_SQUASH_LABEL]),
			}),
		);
		expect(gate).toMatchObject({ merge: true, method: "squash" });
	});

	// The label IS the review verdict. Without it the lane is invisible: no
	// merge, and no comment either.
	it("never touches or comments on an unlabeled PR", () => {
		const gate = gateOf(pr({ checkRuns: greenChecks() }));
		expect(gate).toMatchObject({
			merge: false,
			silent: true,
			reason: MERGE_GATE_REASON.NOT_APPROVED,
		});
	});

	// Review round 1, F5: anyone who can label would otherwise be able to
	// merge. Removing the provenance check must red this.
	it("refuses to merge when train:approved was applied by someone off the approver list", () => {
		const gate = evaluateMergeGate(approved(), HEALTHY, {
			approvedBy: { allowed: false, actor: "drive-by", error: null },
		});
		expect(gate).toMatchObject({
			merge: false,
			silent: false,
			reason: MERGE_GATE_REASON.NOT_APPROVED_BY_OWNER,
		});
		expect(gate.detail).toContain("drive-by");
	});

	it("refuses to merge when the label provenance could not be resolved at all", () => {
		expect(evaluateMergeGate(approved(), HEALTHY, {})).toMatchObject({
			merge: false,
			reason: MERGE_GATE_REASON.NOT_APPROVED_BY_OWNER,
		});
		expect(
			evaluateMergeGate(approved(), HEALTHY, {
				approvedBy: { allowed: false, actor: null, error: "HTTP 500" },
			}),
		).toMatchObject({ reason: MERGE_GATE_REASON.NOT_APPROVED_BY_OWNER });
	});

	// AC2 + AGENTS.md shape 11. This is also the head-change re-gate: a fix
	// round's new head has no check runs yet, so the gate reads absent.
	it("treats an absent required check as not-green (the head-change re-gate)", () => {
		const gate = gateOf(approved({ headSha: "newhead", checkRuns: [] }));
		expect(gate).toMatchObject({
			merge: false,
			silent: false,
			reason: MERGE_GATE_REASON.REQUIRED_CHECK_ABSENT,
		});
		expect(gate.detail).toContain("absent required check is not a passing one");
	});

	it("treats a required check still in progress as not-green", () => {
		const gate = gateOf(
			approved({
				checkRuns: [
					{ name: "Unit tests", status: "IN_PROGRESS", conclusion: null },
					{
						name: "Lint & type-check",
						status: "COMPLETED",
						conclusion: "SUCCESS",
					},
				],
			}),
		);
		expect(gate).toMatchObject({
			merge: false,
			reason: MERGE_GATE_REASON.REQUIRED_CHECK_UNCONCLUDED,
		});
	});

	// Mutation screen: a gate that reads STATUS instead of CONCLUSION merges a
	// PR whose required check completed and FAILED.
	it("treats a completed-but-failed required check as not-green", () => {
		const gate = gateOf(
			approved({
				checkRuns: [
					{ name: "Unit tests", status: "COMPLETED", conclusion: "FAILURE" },
					{
						name: "Lint & type-check",
						status: "COMPLETED",
						conclusion: "SUCCESS",
					},
				],
			}),
		);
		expect(gate).toMatchObject({
			merge: false,
			reason: MERGE_GATE_REASON.REQUIRED_CHECK_NOT_SUCCESS,
		});
	});

	it("treats a missing check rollup as not-green", () => {
		const gate = gateOf(approved({ checksUnknown: true }));
		expect(gate).toMatchObject({
			merge: false,
			reason: MERGE_GATE_REASON.CHECKS_UNKNOWN,
		});
	});

	// AC3: composes with #2184. Both required checks can read SUCCESS from an
	// earlier attempt while the head's current run is starved or never fired.
	it("treats a starved run health as not-green even with green required checks", () => {
		const gate = gateOf(approved(), {
			...HEALTHY,
			classification: RUN_HEALTH.STARVED,
		});
		expect(gate).toMatchObject({
			merge: false,
			reason: MERGE_GATE_REASON.RUN_HEALTH,
		});
	});

	it("treats an absent run health as not-green even with green required checks", () => {
		const gate = gateOf(approved(), {
			...HEALTHY,
			classification: RUN_HEALTH.ABSENT,
		});
		expect(gate).toMatchObject({
			merge: false,
			reason: MERGE_GATE_REASON.RUN_HEALTH,
		});
	});

	// #2203 AC4: the lane reads the new classification as not-green.
	it("treats a stalled run health as not-green even with green required checks", () => {
		const gate = gateOf(approved(), {
			...HEALTHY,
			classification: RUN_HEALTH.STALLED,
		});
		expect(gate).toMatchObject({
			merge: false,
			reason: MERGE_GATE_REASON.RUN_HEALTH,
		});
		expect(gate.detail).toContain("stalled-run");
	});

	it("blocks on a failing non-advisory check and allows a failing advisory one", () => {
		expect(
			gateOf(
				approved({
					checkRuns: [
						...greenChecks(),
						{
							name: "Install test (ubuntu)",
							status: "COMPLETED",
							conclusion: "FAILURE",
						},
					],
				}),
			),
		).toMatchObject({ merge: false, reason: MERGE_GATE_REASON.FAILING_CHECK });
		expect(
			gateOf(
				approved({
					mergeStateStatus: "UNSTABLE",
					checkRuns: [
						...greenChecks(),
						{
							name: "SonarCloud Code Analysis",
							status: "COMPLETED",
							conclusion: "FAILURE",
						},
					],
				}),
			),
		).toMatchObject({ merge: true });
	});

	// Review round 1, F3: this repository marks a check advisory by NAME
	// SUFFIX, not by a vendor allowlist. These four names are live job names,
	// and the oxfmt one was genuinely FAILURE on this PR's own head, so the
	// pre-fix gate refused to merge its own change.
	it("reads the (advisory) name suffix, not just the two vendor names", () => {
		for (const name of [
			"oxfmt format check (advisory)",
			"PR body (advisory)",
			"Vale prose lint (advisory)",
			"OSV scan (advisory)",
		]) {
			expect(isAdvisoryCheck(name)).toBe(true);
			expect(
				gateOf(
					approved({
						mergeStateStatus: "UNSTABLE",
						checkRuns: [
							...greenChecks(),
							{ name, status: "COMPLETED", conclusion: "FAILURE" },
						],
					}),
				),
			).toMatchObject({ merge: true });
		}
		// A name that merely CONTAINS the word must still block.
		expect(isAdvisoryCheck("advisory smoke test")).toBe(false);
		expect(isAdvisoryCheck("Unit tests")).toBe(false);
	});

	// Review round 1, F4: the live rollup carries duplicate names, and PR
	// #2190 carried `Unit tests` as both IN_PROGRESS and COMPLETED/SUCCESS.
	// Last-wins on array order called that green.
	it("resolves duplicate check names to the newest run, so an in-flight re-run is not green", () => {
		const gate = gateOf(
			approved({
				checkRuns: [
					{
						name: "Unit tests",
						status: "COMPLETED",
						conclusion: "SUCCESS",
						startedAt: "2026-08-26T17:21:00Z",
					},
					{
						name: "Unit tests",
						status: "IN_PROGRESS",
						conclusion: null,
						startedAt: "2026-08-26T17:38:00Z",
					},
					{
						name: "Lint & type-check",
						status: "COMPLETED",
						conclusion: "SUCCESS",
						startedAt: "2026-08-26T17:38:00Z",
					},
				],
			}),
		);
		expect(gate).toMatchObject({
			merge: false,
			reason: MERGE_GATE_REASON.REQUIRED_CHECK_UNCONCLUDED,
		});
	});

	it("keeps the newest duplicate even when it is listed FIRST (array order is not time order)", () => {
		const gate = gateOf(
			approved({
				checkRuns: [
					{
						name: "Unit tests",
						status: "IN_PROGRESS",
						conclusion: null,
						startedAt: "2026-08-26T17:38:00Z",
					},
					{
						name: "Unit tests",
						status: "COMPLETED",
						conclusion: "SUCCESS",
						startedAt: "2026-08-26T17:21:00Z",
					},
					{
						name: "Lint & type-check",
						status: "COMPLETED",
						conclusion: "SUCCESS",
						startedAt: "2026-08-26T17:38:00Z",
					},
				],
			}),
		);
		expect(gate).toMatchObject({
			merge: false,
			reason: MERGE_GATE_REASON.REQUIRED_CHECK_UNCONCLUDED,
		});
	});

	// The mutation screen for startedAt ordering ITSELF. Both tests above stay
	// green under fail-closed alone, so neither proves the ordering runs. Here
	// the NEWER duplicate is the success: a re-run that fixed a red check. Only
	// real time ordering merges this; fail-closed would pin the stale FAILURE
	// and the PR could never merge again.
	it("lets a re-run that fixed a red check win over its older failing duplicate", () => {
		const gate = gateOf(
			approved({
				checkRuns: [
					{
						name: "Unit tests",
						status: "COMPLETED",
						conclusion: "FAILURE",
						startedAt: "2026-08-26T17:21:00Z",
					},
					{
						name: "Unit tests",
						status: "COMPLETED",
						conclusion: "SUCCESS",
						startedAt: "2026-08-26T17:38:00Z",
					},
					{
						name: "Lint & type-check",
						status: "COMPLETED",
						conclusion: "SUCCESS",
						startedAt: "2026-08-26T17:38:00Z",
					},
				],
			}),
		);
		expect(gate).toMatchObject({
			merge: true,
			reason: MERGE_GATE_REASON.GREEN,
		});
	});

	it("fails closed when duplicates disagree and carry no usable startedAt", () => {
		const resolved = resolveCheckRuns([
			{ name: "Unit tests", status: "COMPLETED", conclusion: "SUCCESS" },
			{ name: "Unit tests", status: "IN_PROGRESS", conclusion: null },
		]);
		expect(resolved.get("Unit tests")).toMatchObject({ status: "IN_PROGRESS" });
		const flipped = resolveCheckRuns([
			{ name: "Unit tests", status: "IN_PROGRESS", conclusion: null },
			{ name: "Unit tests", status: "COMPLETED", conclusion: "SUCCESS" },
		]);
		expect(flipped.get("Unit tests")).toMatchObject({ status: "IN_PROGRESS" });
	});

	// Review round 1, F1: master protection is `strict: true` (probed), so
	// GitHub REFUSES to merge a BEHIND head. BEHIND is an update state.
	it("updates the branch instead of merging when a green PR is BEHIND", () => {
		const gate = gateOf(approved({ mergeStateStatus: "BEHIND" }));
		expect(gate).toMatchObject({
			merge: false,
			update: true,
			reason: MERGE_GATE_REASON.BEHIND_BASE,
		});
	});

	it("does not update the branch of a BEHIND PR that is not otherwise green", () => {
		const gate = gateOf(
			approved({ mergeStateStatus: "BEHIND", checkRuns: [] }),
		);
		expect(gate).toMatchObject({
			merge: false,
			update: false,
			reason: MERGE_GATE_REASON.REQUIRED_CHECK_ABSENT,
		});
	});

	it("merges from CLEAN and UNSTABLE, and never from DIRTY, BLOCKED, or UNKNOWN", () => {
		for (const state of ["CLEAN", "UNSTABLE"]) {
			expect(gateOf(approved({ mergeStateStatus: state }))).toMatchObject({
				merge: true,
			});
		}
		for (const state of ["DIRTY", "BLOCKED", "DRAFT", "UNKNOWN"]) {
			expect(gateOf(approved({ mergeStateStatus: state }))).toMatchObject({
				merge: false,
				update: false,
				reason: MERGE_GATE_REASON.MERGE_STATE,
			});
		}
	});
});

function lanePrNode(overrides: Record<string, unknown> = {}) {
	const {
		labels = [],
		checks = greenChecks(),
		committedDate = "2026-08-26T16:00:00Z",
		...rest
	} = overrides as {
		labels?: string[];
		checks?: Array<{ name: string; status: string; conclusion: string | null }>;
		committedDate?: string;
	} & Record<string, unknown>;
	return prNode({
		number: 7,
		mergeStateStatus: "CLEAN",
		labels: { nodes: labels.map((name) => ({ name })) },
		commits: {
			nodes: [
				{
					commit: {
						oid: "deadbeef",
						committedDate,
						statusCheckRollup: {
							contexts: {
								nodes: checks.map((c) => ({
									__typename: "CheckRun",
									name: c.name,
									status: c.status,
									conclusion: c.conclusion,
									detailsUrl: `https://example/${c.name}`,
								})),
							},
						},
					},
				},
			],
		},
		...rest,
	});
}

const HEALTHY_RUNS = [
	{
		id: 1,
		path: ".github/workflows/ci.yml",
		status: "completed",
		conclusion: "success",
		run_attempt: 1,
		created_at: "2026-08-26T16:05:00Z",
	},
	{
		id: 2,
		path: ".github/workflows/lint.yml",
		status: "completed",
		conclusion: "success",
		run_attempt: 1,
		created_at: "2026-08-26T16:05:00Z",
	},
];

describe("merge-lane sweep (#2185)", () => {
	it("merges an approved green PR with the exact head SHA and comments", async () => {
		const { fetcher, calls } = fakeGithub({
			"POST /graphql": graphqlPage([
				lanePrNode({ labels: [TRAIN_APPROVED_LABEL] }),
			]),
			"GET /repos/acme/repo/actions/runs": runsRoute(HEALTHY_RUNS),
			"PUT /repos/acme/repo/pulls/7/merge": {
				sha: MERGE_SHA,
				merged: true,
			},
		});
		const results = await runMergeLane({
			fetcher,
			owner: "acme",
			repo: "repo",
			now: NOW,
		});
		expect(results[0]).toMatchObject({ number: 7, merged: true });
		expect(calls).toContainEqual({
			method: "PUT",
			url: "https://api.github.com/repos/acme/repo/pulls/7/merge",
			body: { merge_method: "merge", sha: "deadbeef" },
		});
		expect(calls).toContainEqual({
			method: "POST",
			url: "https://api.github.com/repos/acme/repo/dispatches",
			body: {
				event_type: "merge-train-post-merge",
				client_payload: {
					repository: "acme/repo",
					sha: MERGE_SHA,
					pr_number: 7,
				},
			},
		});
		const comments = calls.filter(
			(c) => c.method === "POST" && c.url.endsWith("/issues/7/comments"),
		);
		expect(comments).toHaveLength(2);
		expect(
			comments.some((comment) =>
				String((comment.body as { body: string }).body).includes("merged"),
			),
		).toBe(true);
	});

	it("records missing post-merge validation when the merge response has no SHA", async () => {
		const { fetcher, calls } = fakeGithub({
			"POST /graphql": graphqlPage([
				lanePrNode({ labels: [TRAIN_APPROVED_LABEL] }),
			]),
			"GET /repos/acme/repo/actions/runs": runsRoute(HEALTHY_RUNS),
			"PUT /repos/acme/repo/pulls/7/merge": {},
		});
		const results = await runMergeLane({
			fetcher,
			owner: "acme",
			repo: "repo",
			now: NOW,
		});
		expect(results[0]).toMatchObject({ merged: true });
		expect(results[0].errors).toContainEqual({
			message: expect.stringContaining("post-merge validation missing"),
			benign: false,
		});
		expect(calls.some((c) => c.url.endsWith("/dispatches"))).toBe(false);
	});

	it("rejects a mutable post-merge ref instead of dispatching it", async () => {
		const { fetcher, calls } = fakeGithub({
			"POST /graphql": graphqlPage([
				lanePrNode({ labels: [TRAIN_APPROVED_LABEL] }),
			]),
			"GET /repos/acme/repo/actions/runs": runsRoute(HEALTHY_RUNS),
			"PUT /repos/acme/repo/pulls/7/merge": { sha: "master" },
		});
		const results = await runMergeLane({
			fetcher,
			owner: "acme",
			repo: "repo",
			now: NOW,
		});
		expect(results[0]).toMatchObject({ merged: true });
		expect(results[0].errors).toContainEqual({
			message: expect.stringContaining("post-merge validation missing"),
			benign: false,
		});
		expect(calls.some((c) => c.url.endsWith("/dispatches"))).toBe(false);
	});

	it("retries a transient post-merge dispatch for the same exact SHA", async () => {
		let attempts = 0;
		const { fetcher, calls } = fakeGithub({
			"POST /graphql": graphqlPage([
				lanePrNode({ labels: [TRAIN_APPROVED_LABEL] }),
			]),
			"GET /repos/acme/repo/actions/runs": runsRoute(HEALTHY_RUNS),
			"PUT /repos/acme/repo/pulls/7/merge": { sha: MERGE_SHA },
			"POST /repos/acme/repo/dispatches": () => {
				attempts += 1;
				return attempts === 1
					? { ok: false, status: 503, json: async () => ({}) }
					: { ok: true, status: 204, json: async () => ({}) };
			},
		});
		const results = await runMergeLane({
			fetcher,
			owner: "acme",
			repo: "repo",
			now: NOW,
		});
		expect(results[0]).toMatchObject({ merged: true, errors: [] });
		expect(attempts).toBe(2);
		const dispatches = calls.filter((c) => c.url.endsWith("/dispatches"));
		expect(dispatches).toHaveLength(2);
		expect(
			dispatches.every(
				(c) =>
					(c.body as { client_payload: { sha: string } }).client_payload.sha ===
					MERGE_SHA,
			),
		).toBe(true);
	});

	it("retries when dispatch loses an accepted response", async () => {
		let attempts = 0;
		const { fetcher, calls } = fakeGithub({
			"POST /graphql": graphqlPage([
				lanePrNode({ labels: [TRAIN_APPROVED_LABEL] }),
			]),
			"GET /repos/acme/repo/actions/runs": runsRoute(HEALTHY_RUNS),
			"PUT /repos/acme/repo/pulls/7/merge": { sha: MERGE_SHA },
			"POST /repos/acme/repo/dispatches": () => {
				attempts += 1;
				if (attempts === 1)
					throw new Error("request timed out after acceptance");
				return { ok: true, status: 204, json: async () => ({}) };
			},
		});
		const results = await runMergeLane({
			fetcher,
			owner: "acme",
			repo: "repo",
			now: NOW,
		});
		expect(results[0]).toMatchObject({ merged: true, errors: [] });
		expect(attempts).toBe(2);
		const dispatches = calls.filter((c) => c.url.endsWith("/dispatches"));
		expect(dispatches).toHaveLength(2);
		expect(
			dispatches.every(
				(call) =>
					(call.body as { client_payload: { sha: string } }).client_payload
						.sha === MERGE_SHA,
			),
		).toBe(true);
	});

	it("records a failed post-merge dispatch while preserving the landed merge", async () => {
		const { fetcher, calls } = fakeGithub({
			"POST /graphql": graphqlPage([
				lanePrNode({ labels: [TRAIN_APPROVED_LABEL] }),
			]),
			"GET /repos/acme/repo/actions/runs": runsRoute(HEALTHY_RUNS),
			"PUT /repos/acme/repo/pulls/7/merge": { sha: MERGE_SHA },
			"POST /repos/acme/repo/dispatches": () => ({
				ok: false,
				status: 503,
				json: async () => ({}),
			}),
		});
		const results = await runMergeLane({
			fetcher,
			owner: "acme",
			repo: "repo",
			now: NOW,
		});
		expect(results[0]).toMatchObject({ merged: true });
		expect(results[0].errors).toContainEqual({
			message: expect.stringContaining("dispatch -> HTTP 503"),
			benign: false,
		});
		const dispatches = calls.filter((c) => c.url.endsWith("/dispatches"));
		expect(dispatches).toHaveLength(2);
		expect(
			dispatches.every(
				(call) =>
					(call.body as { client_payload: { sha: string } }).client_payload
						.sha === MERGE_SHA,
			),
		).toBe(true);
	});

	it("reconciles a merged bot PR after a prior lane process exits", async () => {
		let dispatchAttempts = 0;
		const durableComments: Array<{
			body: string;
			user: { login: string };
		}> = [];
		const { fetcher, calls } = fakeGithub({
			"POST /graphql": recentMergedPage([
				{
					number: 7,
					merged_at: "2026-08-26T16:20:00Z",
					merged_by: { login: "github-actions[bot]" },
					merge_commit_sha: MERGE_SHA,
				},
			]),
			"GET /repos/acme/repo/issues/7/comments": () => ({
				ok: true,
				status: 200,
				json: async () => durableComments,
			}),
			"POST /repos/acme/repo/issues/7/comments": (body: unknown) => {
				durableComments.push({
					body: String((body as { body: string }).body),
					user: { login: "github-actions[bot]" },
				});
				return { ok: true, status: 201, json: async () => ({}) };
			},
			"POST /repos/acme/repo/dispatches": () => {
				dispatchAttempts += 1;
				if (dispatchAttempts <= 2)
					throw new Error("runner exited after acceptance");
				for (const workflow of POST_MERGE_VALIDATION_WORKFLOWS)
					durableComments.push({
						body: `<!-- merge-train-post-merge:sha=${MERGE_SHA}:workflow=${workflow}:state=succeeded -->`,
						user: { login: "github-actions[bot]" },
					});
				return { ok: true, status: 204, json: async () => ({}) };
			},
		});

		const first = await reconcilePostMergeValidations({
			fetcher,
			owner: "acme",
			repo: "repo",
			now: NOW,
		});
		expect(first[0]).toMatchObject({
			number: 7,
			sha: MERGE_SHA,
			dispatched: false,
		});
		expect(first[0].errors[0]).toContain("failed after 2 attempt(s)");

		const second = await reconcilePostMergeValidations({
			fetcher,
			owner: "acme",
			repo: "repo",
			now: NOW + POST_MERGE_RECONCILE_GRACE_MS + 1,
		});
		expect(second[0]).toMatchObject({
			number: 7,
			sha: MERGE_SHA,
			dispatched: true,
			errors: [],
		});
		expect(
			calls
				.filter((call) => call.url.endsWith("/dispatches"))
				.every(
					(call) =>
						(call.body as { client_payload: { sha: string } }).client_payload
							.sha === MERGE_SHA,
				),
		).toBe(true);

		const third = await reconcilePostMergeValidations({
			fetcher,
			owner: "acme",
			repo: "repo",
			now: NOW + 2 * POST_MERGE_RECONCILE_GRACE_MS + 2,
		});
		expect(third).toEqual([]);
		expect(dispatchAttempts).toBe(3);
	});

	it("does not replay a human merge already covered by push workflows", async () => {
		const { fetcher, calls } = fakeGithub({
			"POST /graphql": recentMergedPage([
				{
					number: 8,
					merged_at: "2026-08-26T16:20:00Z",
					merged_by: { login: "acme" },
					merge_commit_sha: MERGE_SHA,
				},
			]),
		});
		const results = await reconcilePostMergeValidations({
			fetcher,
			owner: "acme",
			repo: "repo",
			now: NOW,
		});
		expect(results).toEqual([]);
		expect(calls.some((call) => call.url.endsWith("/dispatches"))).toBe(false);
	});

	it("does not trust a user-forged completion marker", async () => {
		const { fetcher, calls } = fakeGithub({
			"POST /graphql": recentMergedPage([
				{
					number: 7,
					merged_at: "2026-08-26T16:20:00Z",
					merged_by: { login: "github-actions[bot]" },
					merge_commit_sha: MERGE_SHA,
				},
			]),
			"GET /repos/acme/repo/issues/7/comments": () => ({
				ok: true,
				status: 200,
				json: async () => [
					{
						body: `<!-- merge-train-post-merge:sha=${MERGE_SHA}:dispatched -->`,
						user: { login: "acme" },
					},
				],
			}),
		});
		const results = await reconcilePostMergeValidations({
			fetcher,
			owner: "acme",
			repo: "repo",
			now: NOW,
		});
		expect(results[0]).toMatchObject({
			number: 7,
			sha: MERGE_SHA,
			dispatched: true,
		});
		expect(calls.some((call) => call.url.endsWith("/dispatches"))).toBe(true);
	});

	it("surfaces a bot-reported validation failure instead of suppressing recovery", async () => {
		const { fetcher, calls } = fakeGithub({
			"POST /graphql": recentMergedPage([
				{
					number: 7,
					merged_at: "2026-08-26T16:20:00Z",
					merged_by: { login: "github-actions[bot]" },
					merge_commit_sha: MERGE_SHA,
				},
			]),
			"GET /repos/acme/repo/issues/7/comments": () => ({
				ok: true,
				status: 200,
				json: async () => [
					{
						body: `<!-- merge-train-post-merge:sha=${MERGE_SHA}:workflow=ci.yml:state=failed -->`,
						user: { login: "github-actions[bot]" },
					},
				],
			}),
		});
		const results = await reconcilePostMergeValidations({
			fetcher,
			owner: "acme",
			repo: "repo",
			now: NOW,
		});
		expect(results[0]).toMatchObject({
			number: 7,
			sha: MERGE_SHA,
			dispatched: false,
		});
		expect(results[0].errors[0]).toContain("ci.yml");
		expect(calls.some((call) => call.url.endsWith("/dispatches"))).toBe(false);
	});

	it("waits through the grace period after an accepted request", async () => {
		const { fetcher, calls } = fakeGithub({
			"POST /graphql": recentMergedPage([
				{
					number: 7,
					merged_at: "2026-08-26T16:20:00Z",
					merged_by: { login: "github-actions[bot]" },
					merge_commit_sha: MERGE_SHA,
				},
			]),
			"GET /repos/acme/repo/issues/7/comments": () => ({
				ok: true,
				status: 200,
				json: async () => [
					{
						body: `<!-- merge-train-post-merge:sha=${MERGE_SHA}:state=requested:attempt=1:generation=0:at=${NOW} -->`,
						user: { login: "github-actions[bot]" },
					},
				],
			}),
		});
		const results = await reconcilePostMergeValidations({
			fetcher,
			owner: "acme",
			repo: "repo",
			now: NOW + 1,
		});
		expect(results).toEqual([]);
		expect(calls.some((call) => call.url.endsWith("/dispatches"))).toBe(false);
	});

	it("reports missing validation after bounded request attempts", async () => {
		const { fetcher, calls } = fakeGithub({
			"POST /graphql": recentMergedPage([
				{
					number: 7,
					merged_at: "2026-08-26T16:20:00Z",
					merged_by: { login: "github-actions[bot]" },
					merge_commit_sha: MERGE_SHA,
				},
			]),
			"GET /repos/acme/repo/issues/7/comments": () => ({
				ok: true,
				status: 200,
				json: async () =>
					[1, 2].map((attempt) => ({
						body: `<!-- merge-train-post-merge:sha=${MERGE_SHA}:state=requested:attempt=${attempt}:generation=0:at=${NOW} -->`,
						user: { login: "github-actions[bot]" },
					})),
			}),
		});
		const results = await reconcilePostMergeValidations({
			fetcher,
			owner: "acme",
			repo: "repo",
			now: NOW + POST_MERGE_RECONCILE_GRACE_MS + 1,
		});
		expect(results[0].errors[0]).toContain(
			"missing after 2 request attempt(s)",
		);
		expect(calls.some((call) => call.url.endsWith("/dispatches"))).toBe(false);
	});

	it("persists one exhaustion record instead of repeating it each restart", async () => {
		const durableComments = [1, 2].map((attempt) => ({
			body: `<!-- merge-train-post-merge:sha=${MERGE_SHA}:state=requested:attempt=${attempt}:generation=0:at=${NOW} -->`,
			user: { login: "github-actions[bot]" },
		}));
		const { fetcher, calls } = fakeGithub({
			"POST /graphql": recentMergedPage([
				{
					number: 7,
					merged_at: "2026-08-26T16:20:00Z",
					merged_by: { login: "github-actions[bot]" },
					merge_commit_sha: MERGE_SHA,
				},
			]),
			"GET /repos/acme/repo/issues/7/comments": () => ({
				ok: true,
				status: 200,
				json: async () => durableComments,
			}),
			"POST /repos/acme/repo/issues/7/comments": (body: unknown) => {
				durableComments.push({
					body: String((body as { body: string }).body),
					user: { login: "github-actions[bot]" },
				});
				return { ok: true, status: 201, json: async () => ({}) };
			},
		});
		const options = {
			fetcher,
			owner: "acme",
			repo: "repo",
			now: NOW + POST_MERGE_RECONCILE_GRACE_MS + 1,
		};
		const first = await reconcilePostMergeValidations(options);
		const second = await reconcilePostMergeValidations(options);
		expect(first[0].errors[0]).toContain("missing after 2 request attempt(s)");
		expect(second).toEqual([]);
		expect(
			calls.filter(
				(call) => call.method === "POST" && call.url.endsWith("/comments"),
			),
		).toHaveLength(1);
	});

	it("reopens a later retry generation after an exhausted no-terminal window", async () => {
		let requestCount = 0;
		const { fetcher, calls } = fakeGithub({
			"POST /graphql": recentMergedPage([
				{
					number: 7,
					merged_at: "2026-08-26T16:20:00Z",
					merged_by: { login: "github-actions[bot]" },
					merge_commit_sha: MERGE_SHA,
				},
			]),
			"GET /repos/acme/repo/issues/7/comments": () => ({
				ok: true,
				status: 200,
				json: async () =>
					[1, 2].map((attempt) => ({
						body: `<!-- merge-train-post-merge:sha=${MERGE_SHA}:state=requested:attempt=${attempt}:generation=0:at=${NOW} -->`,
						user: { login: "github-actions[bot]" },
					})),
			}),
			"POST /repos/acme/repo/issues/7/comments": () => ({
				ok: true,
				status: 201,
				json: async () => ({}),
			}),
			"POST /repos/acme/repo/dispatches": () => {
				requestCount += 1;
				return { ok: true, status: 204, json: async () => ({}) };
			},
		});
		const results = await reconcilePostMergeValidations({
			fetcher,
			owner: "acme",
			repo: "repo",
			now: NOW + POST_MERGE_RETRY_GENERATION_MS + 1,
		});
		expect(results[0]).toMatchObject({ dispatched: true, errors: [] });
		expect(requestCount).toBe(1);
		const request = calls.find(
			(call) => call.method === "POST" && call.url.endsWith("/comments"),
		);
		expect(String((request?.body as { body: string }).body)).toContain(
			"attempt=1:generation=1",
		);
	});

	describe("recent merged-PR GraphQL window", () => {
		const recent = (
			number: number,
			updatedAt: number,
			mergedAt = updatedAt,
		) => ({
			number,
			updated_at: new Date(updatedAt).toISOString(),
			merged_at: new Date(mergedAt).toISOString(),
			merged_by: { login: "github-actions[bot]" },
			merge_commit_sha: MERGE_SHA,
		});

		it("stops after the first page once its last update is outside the window", async () => {
			const old = recent(9, NOW - POST_MERGE_RECONCILE_WINDOW_MS - 1);
			const candidate = recent(7, NOW - 60_000);
			const { fetcher, calls } = fakeGithub({
				"POST /graphql": recentMergedPage([candidate, old]),
			});
			const result = await reconcilePostMergeValidations({
				fetcher,
				owner: "acme",
				repo: "repo",
				now: NOW,
			});
			expect(result.find((entry) => entry.number === 7)).toMatchObject({
				number: 7,
				dispatched: true,
			});
			expect(
				calls.filter((call) => call.url.endsWith("/graphql")),
			).toHaveLength(1);
			const query = String((calls[0].body as { query: string }).query);
			expect(query).toContain("states: [CLOSED, MERGED]");
			expect(query).toContain(
				"orderBy: { field: UPDATED_AT, direction: DESC }",
			);
		});

		it("continues past a recently updated old merge to find a later candidate", async () => {
			const old = recent(
				9,
				NOW - 60_000,
				NOW - POST_MERGE_RECONCILE_WINDOW_MS - 60_000,
			);
			const candidate = recent(7, NOW - 2 * 60_000);
			const outside = recent(8, NOW - POST_MERGE_RECONCILE_WINDOW_MS - 1);
			const { fetcher, calls } = fakeGithub({
				"POST /graphql": recentMergedSequence([
					recentMergedPage([old], true, 1),
					recentMergedPage([candidate, outside], false, 2),
				]),
			});
			const result = await reconcilePostMergeValidations({
				fetcher,
				owner: "acme",
				repo: "repo",
				now: NOW,
			});
			expect(result.find((entry) => entry.number === 7)).toMatchObject({
				number: 7,
				dispatched: true,
			});
			expect(
				calls.filter((call) => call.url.endsWith("/graphql")),
			).toHaveLength(2);
		});

		it("keeps an update exactly at the cutoff in scope across a page boundary", async () => {
			const cutoff = NOW - POST_MERGE_RECONCILE_WINDOW_MS;
			const boundary = recent(9, cutoff, cutoff);
			const candidate = recent(7, cutoff, cutoff);
			const outside = recent(8, cutoff - 1);
			const { fetcher, calls } = fakeGithub({
				"POST /graphql": recentMergedSequence([
					recentMergedPage([boundary], true, 1),
					recentMergedPage([candidate, outside], false, 2),
				]),
			});
			const result = await reconcilePostMergeValidations({
				fetcher,
				owner: "acme",
				repo: "repo",
				now: NOW,
			});
			expect(result.find((entry) => entry.number === 7)).toMatchObject({
				number: 7,
				dispatched: true,
			});
			expect(
				calls.filter((call) => call.url.endsWith("/graphql")),
			).toHaveLength(2);
		});

		it("rejects non-monotonic updates, repeated cursors, and malformed timestamps", async () => {
			const malformed = recentMergedPage([recent(7, NOW - 60_000)]);
			malformed.data.repository.pullRequests.edges[0].node.updatedAt = "bad";
			const { fetcher } = fakeGithub({ "POST /graphql": malformed });
			const malformedResult = await reconcilePostMergeValidations({
				fetcher,
				owner: "acme",
				repo: "repo",
				now: NOW,
			});
			expect(malformedResult[0].errors[0]).toContain("invalid updatedAt");

			const nonString = recentMergedPage([recent(7, NOW - 60_000)]);
			nonString.data.repository.pullRequests.edges[0].node.updatedAt = 0;
			const nonStringResult = await reconcilePostMergeValidations({
				fetcher: fakeGithub({ "POST /graphql": nonString }).fetcher,
				owner: "acme",
				repo: "repo",
				now: NOW,
			});
			expect(nonStringResult[0].errors[0]).toContain("invalid updatedAt");

			const zero = recentMergedPage([recent(7, NOW - 60_000)]);
			zero.data.repository.pullRequests.edges[0].node.mergedAt = "0";
			const zeroResult = await reconcilePostMergeValidations({
				fetcher: fakeGithub({ "POST /graphql": zero }).fetcher,
				owner: "acme",
				repo: "repo",
				now: NOW,
			});
			expect(zeroResult[0].errors[0]).toContain("invalid mergedAt");

			const normalized = recentMergedPage([recent(7, NOW - 60_000)]);
			normalized.data.repository.pullRequests.edges[0].node.mergedAt =
				"2026-02-30T00:00:00Z";
			const normalizedResult = await reconcilePostMergeValidations({
				fetcher: fakeGithub({ "POST /graphql": normalized }).fetcher,
				owner: "acme",
				repo: "repo",
				now: NOW,
			});
			expect(normalizedResult[0].errors[0]).toContain("invalid mergedAt");

			const first = recentMergedPage([recent(7, NOW - 60_000)], true, 1);
			const second = recentMergedPage([recent(8, NOW - 120_000)], false, 1);
			const repeated = fakeGithub({
				"POST /graphql": recentMergedSequence([first, second]),
			}).fetcher;
			const repeatedResult = await reconcilePostMergeValidations({
				fetcher: repeated,
				owner: "acme",
				repo: "repo",
				now: NOW,
			});
			expect(repeatedResult[0].errors[0]).toContain("cursor did not advance");

			const descending = recentMergedPage([recent(7, NOW - 120_000)], true, 1);
			const increasing = recentMergedPage([recent(8, NOW - 60_000)], false, 2);
			const increasingResult = await reconcilePostMergeValidations({
				fetcher: fakeGithub({
					"POST /graphql": recentMergedSequence([descending, increasing]),
				}).fetcher,
				owner: "acme",
				repo: "repo",
				now: NOW,
			});
			expect(increasingResult[0].errors[0]).toContain("ordering increased");
		});

		it("fails closed on malformed mergedAt, missing cursors, GraphQL errors, and truncation", async () => {
			const malformed = recentMergedPage([recent(7, NOW - 60_000)]);
			malformed.data.repository.pullRequests.edges[0].node.mergedAt = "bad";
			const malformedResult = await reconcilePostMergeValidations({
				fetcher: fakeGithub({ "POST /graphql": malformed }).fetcher,
				owner: "acme",
				repo: "repo",
				now: NOW,
			});
			expect(malformedResult[0].errors[0]).toContain("invalid mergedAt");

			const missingCursor = recentMergedPage([recent(7, NOW - 60_000)]) as {
				data: {
					repository: {
						pullRequests: { pageInfo: { endCursor: string | null } };
					};
				};
			};
			missingCursor.data.repository.pullRequests.pageInfo.endCursor = null;
			const missingCursorResult = await reconcilePostMergeValidations({
				fetcher: fakeGithub({ "POST /graphql": missingCursor }).fetcher,
				owner: "acme",
				repo: "repo",
				now: NOW,
			});
			expect(missingCursorResult[0].errors[0]).toContain("no end cursor");

			const nullEdgeCursor = recentMergedPage([recent(7, NOW - 60_000)]);
			(
				nullEdgeCursor.data.repository.pullRequests.edges[0] as {
					cursor: string | null;
				}
			).cursor = null;
			const nullEdgeCursorResult = await reconcilePostMergeValidations({
				fetcher: fakeGithub({ "POST /graphql": nullEdgeCursor }).fetcher,
				owner: "acme",
				repo: "repo",
				now: NOW,
			});
			expect(nullEdgeCursorResult[0].errors[0]).toContain(
				"malformed edge cursor",
			);

			const repeatedEdgeCursor = recentMergedPage([
				recent(7, NOW - 60_000),
				recent(8, NOW - 120_000),
			]);
			repeatedEdgeCursor.data.repository.pullRequests.edges[1].cursor =
				repeatedEdgeCursor.data.repository.pullRequests.edges[0].cursor;
			const repeatedEdgeCursorResult = await reconcilePostMergeValidations({
				fetcher: fakeGithub({ "POST /graphql": repeatedEdgeCursor }).fetcher,
				owner: "acme",
				repo: "repo",
				now: NOW,
			});
			expect(repeatedEdgeCursorResult[0].errors[0]).toContain(
				"repeated edge cursor",
			);

			const emptyTerminal = await reconcilePostMergeValidations({
				fetcher: fakeGithub({
					"POST /graphql": recentMergedPage([]),
				}).fetcher,
				owner: "acme",
				repo: "repo",
				now: NOW,
			});
			expect(emptyTerminal).toEqual([]);

			const invalidEmptyTerminal = recentMergedPage([]);
			invalidEmptyTerminal.data.repository.pullRequests.pageInfo.endCursor =
				"unexpected";
			const invalidEmptyTerminalResult = await reconcilePostMergeValidations({
				fetcher: fakeGithub({
					"POST /graphql": invalidEmptyTerminal,
				}).fetcher,
				owner: "acme",
				repo: "repo",
				now: NOW,
			});
			expect(invalidEmptyTerminalResult[0].errors[0]).toContain(
				"invalid empty terminal cursor",
			);

			const oversized = recentMergedPage(
				Array.from({ length: 101 }, (_, index) =>
					recent(index + 1, NOW - index * 1_000),
				),
			);
			const oversizedResult = await reconcilePostMergeValidations({
				fetcher: fakeGithub({ "POST /graphql": oversized }).fetcher,
				owner: "acme",
				repo: "repo",
				now: NOW,
			});
			expect(oversizedResult[0].errors[0]).toContain("exceeded 100 records");

			const cumulative = recentMergedPage(
				Array.from({ length: 1_001 }, (_, index) =>
					recent(
						index + 1,
						NOW - index * 1_000,
						NOW - POST_MERGE_RECONCILE_WINDOW_MS - 1,
					),
				),
			);
			const cumulativeResult = await reconcilePostMergeValidations({
				fetcher: fakeGithub({ "POST /graphql": cumulative }).fetcher,
				owner: "acme",
				repo: "repo",
				now: NOW,
			});
			expect(cumulativeResult[0].errors[0]).toContain("exceeded 1000 records");

			const graphQlError = {
				ok: true,
				status: 200,
				json: async () => ({ errors: [{ message: "rate limited" }] }),
			};
			const graphQlErrorResult = await reconcilePostMergeValidations({
				fetcher: fakeGithub({ "POST /graphql": () => graphQlError }).fetcher,
				owner: "acme",
				repo: "repo",
				now: NOW,
			});
			expect(graphQlErrorResult[0].errors[0]).toContain("rate limited");

			const httpErrorResult = await reconcilePostMergeValidations({
				fetcher: fakeGithub({
					"POST /graphql": () => ({
						ok: false,
						status: 503,
						json: async () => ({}),
					}),
				}).fetcher,
				owner: "acme",
				repo: "repo",
				now: NOW,
			});
			expect(httpErrorResult[0].errors[0]).toContain("HTTP 503");

			const pages = Array.from({ length: 10 }, (_, page) =>
				recentMergedPage(
					[recent(page + 1, NOW - page * 60_000)],
					true,
					page + 1,
				),
			);
			const truncatedResult = await reconcilePostMergeValidations({
				fetcher: fakeGithub({
					"POST /graphql": recentMergedSequence(pages),
				}).fetcher,
				owner: "acme",
				repo: "repo",
				now: NOW,
			});
			expect(truncatedResult[0].errors[0]).toContain("read truncated");
		});

		it("keeps human merges out of recovery and preserves the bot merge SHA", async () => {
			const human = recent(8, NOW - 60_000);
			human.merged_by = { login: "acme" };
			const { fetcher, calls } = fakeGithub({
				"POST /graphql": recentMergedPage([human]),
			});
			expect(
				await reconcilePostMergeValidations({
					fetcher,
					owner: "acme",
					repo: "repo",
					now: NOW,
				}),
			).toEqual([]);
			expect(calls.some((call) => call.url.endsWith("/dispatches"))).toBe(
				false,
			);
		});

		it("accepts valid fractional offset timestamps", async () => {
			const valid = recentMergedPage([recent(7, NOW - 60_000)]);
			valid.data.repository.pullRequests.edges[0].node.updatedAt =
				"2026-08-26T18:29:00.123+02:00";
			valid.data.repository.pullRequests.edges[0].node.mergedAt =
				"2026-08-26T18:29:00.123+02:00";
			const result = await reconcilePostMergeValidations({
				fetcher: fakeGithub({ "POST /graphql": valid }).fetcher,
				owner: "acme",
				repo: "repo",
				now: NOW,
			});
			expect(result.find((entry) => entry.number === 7)).toMatchObject({
				number: 7,
				dispatched: true,
			});
		});
	});

	describe("fresh-runner dispatch validation seam", () => {
		function apiResponse(body: unknown, status = 200) {
			return {
				ok: status >= 200 && status < 300,
				status,
				json: async () => body,
			};
		}

		function validationFetcher(
			compare: unknown,
			commit: unknown = { sha: MERGE_SHA },
		) {
			const calls: Array<{ url: string; init?: unknown }> = [];
			const fetcher = async (url: string, init?: unknown) => {
				calls.push({ url, init });
				return url.includes("/compare/")
					? apiResponse(compare)
					: apiResponse(commit);
			};
			return { calls, fetcher };
		}

		it("authenticates the exact SHA and accepts only master ancestry", async () => {
			const { calls, fetcher } = validationFetcher({ status: "ahead" });
			await expect(
				validateMergeTrainDispatch({
					fetcher,
					repository: "acme/repo",
					payloadRepository: "acme/repo",
					payloadSha: MERGE_SHA,
					payloadPrNumber: 7,
					token: "secret",
				}),
			).resolves.toEqual({
				repository: "acme/repo",
				sha: MERGE_SHA,
				prNumber: 7,
			});
			expect(calls.map(({ url }) => url)).toEqual([
				`https://api.github.com/repos/acme/repo/compare/${MERGE_SHA}...master`,
				`https://api.github.com/repos/acme/repo/commits/${MERGE_SHA}`,
			]);
			expect(
				calls.every(
					({ init }) =>
						(init as { headers: Record<string, string> }).headers
							.Authorization === "Bearer secret",
				),
			).toBe(true);
		});

		it.each([
			["forged repository", { payloadRepository: "evil/repo" }],
			["invalid SHA", { payloadSha: "master" }],
			["invalid PR number", { payloadPrNumber: 0 }],
		])("rejects %s before making an API call", async (_label, overrides) => {
			const { calls, fetcher } = validationFetcher({ status: "ahead" });
			await expect(
				validateMergeTrainDispatch({
					fetcher,
					repository: "acme/repo",
					payloadRepository: "acme/repo",
					payloadSha: MERGE_SHA,
					payloadPrNumber: 7,
					token: "secret",
					...overrides,
				}),
			).rejects.toThrow();
			expect(calls).toEqual([]);
		});

		it("rejects a non-ancestor and never resolves its commit", async () => {
			const { calls, fetcher } = validationFetcher({ status: "behind" });
			await expect(
				validateMergeTrainDispatch({
					fetcher,
					repository: "acme/repo",
					payloadRepository: "acme/repo",
					payloadSha: MERGE_SHA,
					payloadPrNumber: 7,
					token: "secret",
				}),
			).rejects.toThrow("not an ancestor");
			expect(calls).toHaveLength(1);
		});

		it("rejects a compare-to-commit race that resolves a different SHA", async () => {
			const { calls, fetcher } = validationFetcher(
				{ status: "ahead" },
				{
					sha: "fedcba9876543210fedcba9876543210fedcba98",
				},
			);
			await expect(
				validateMergeTrainDispatch({
					fetcher,
					repository: "acme/repo",
					payloadRepository: "acme/repo",
					payloadSha: MERGE_SHA,
					payloadPrNumber: 7,
					token: "secret",
				}),
			).rejects.toThrow("exactly");
			expect(calls).toHaveLength(2);
		});
	});

	it("covers every registered post-merge workflow through its parsed contract", () => {
		const workflows = workflowDocuments();
		assertNonEmptyScan(
			"registered post-merge workflows",
			workflows.length,
			POST_MERGE_VALIDATION_WORKFLOWS.length,
		);
		expect(workflows.map(({ name }) => name).sort()).toEqual(
			[...POST_MERGE_VALIDATION_WORKFLOWS].sort(),
		);
		expect(existsSync(join(REPO_ROOT, DISPATCH_VALIDATOR))).toBe(true);

		for (const { name, document } of workflows) {
			const triggers = recordValue(document.on);
			expect(
				recordValue(triggers.push).branches,
				`${name} master trigger`,
			).toContain("master");
			expect(
				recordValue(document.concurrency)["cancel-in-progress"],
				`${name} concurrency`,
			).toBe(true);
			const jobs = recordValue(document.jobs);
			const validatorJob = jobs["validate-merge-train-dispatch"];
			expect(validatorJob, `${name} validator job`).toBeDefined();
			const validatorSteps = stepsFor(validatorJob);
			const validatorIndexes = validatorSteps
				.map((step, index) =>
					step.run === `node ${DISPATCH_VALIDATOR}` ? index : -1,
				)
				.filter((index) => index >= 0);
			expect(validatorIndexes, `${name} validator step`).toHaveLength(1);
			if (validatorIndexes.length !== 1) continue;
			const validatorStep = validatorSteps[validatorIndexes[0]];
			expect(validatorStep.if, `${name} validator gate`).toBe(
				REPOSITORY_DISPATCH_IF,
			);
			expect(validatorStep.run).toBe(`node ${DISPATCH_VALIDATOR}`);
			expect(
				recordValue(validatorStep.env),
				`${name} validator env`,
			).toMatchObject({
				PAYLOAD_REPOSITORY: "${{ github.event.client_payload.repository }}",
				PAYLOAD_SHA: "${{ github.event.client_payload.sha }}",
				PAYLOAD_PR_NUMBER: "${{ github.event.client_payload.pr_number }}",
			});

			const checkoutSteps = validatorSteps.filter((step) =>
				String(step.uses ?? "").startsWith("actions/checkout@"),
			);
			expect(checkoutSteps, `${name} validator checkout`).toHaveLength(1);
			if (checkoutSteps.length !== 1) continue;
			const checkoutStep = checkoutSteps[0];
			expect(checkoutStep.if, `${name} checkout gate`).toBe(
				REPOSITORY_DISPATCH_IF,
			);
			expect(recordValue(checkoutStep.with).ref, `${name} checkout ref`).toBe(
				"${{ github.sha }}",
			);
			expect(checkoutStep.uses, `${name} checkout action`).toBe(
				CHECKOUT_ACTION,
			);
			expect(validatorSteps.indexOf(checkoutStep)).toBeLessThan(
				validatorIndexes[0],
			);

			const payloadJobs = Object.entries(jobs).filter(([, job]) =>
				stepsFor(job).some((step) =>
					String(recordValue(step.with).ref).includes(
						"github.event.client_payload.sha",
					),
				),
			);
			expect(
				payloadJobs.length,
				`${name} payload checkout population`,
			).toBeGreaterThan(0);
			for (const [jobName, job] of payloadJobs)
				for (const step of stepsFor(job))
					if (
						String(recordValue(step.with).ref).includes(
							"github.event.client_payload.sha",
						)
					)
						expect(
							recordValue(step.with).ref,
							`${name} ${jobName} checkout ref`,
						).toBe(PAYLOAD_CHECKOUT_REF);
			for (const [jobName, job] of payloadJobs)
				expect(needsFor(job), `${name} ${jobName} dependency`).toContain(
					"validate-merge-train-dispatch",
				);

			const recorderEntries = Object.entries(jobs).filter(([jobName]) =>
				jobName.includes("record-post-merge-validation"),
			);
			expect(recorderEntries, `${name} terminal recorder`).toHaveLength(1);
			const [recorderName, recorder] = recorderEntries[0];
			expect(
				needsFor(recorder),
				`${name} ${recorderName} dependency`,
			).toContain("validate-merge-train-dispatch");
			expect(recordValue(recorder).if, `${name} recorder gate`).toBe(
				POST_MERGE_RECORDER_IF,
			);
		}
	});

	// AC1's second half, and the mutation screen for the label gate: an
	// unlabeled PR must cost ZERO calls beyond the shared list read.
	it("issues no call at all for an unlabeled PR", async () => {
		const { fetcher, calls } = fakeGithub({
			"POST /graphql": graphqlPage([lanePrNode({ labels: [] })]),
			"GET /repos/acme/repo/actions/runs": runsRoute(HEALTHY_RUNS),
		});
		const results = await runMergeLane({
			fetcher,
			owner: "acme",
			repo: "repo",
			now: NOW,
		});
		expect(results).toEqual([]);
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("https://api.github.com/graphql");
	});

	// AC2: the head moved after labeling, so the new head has no concluded
	// checks. The label survives (the lane never removes it) and the PR gets a
	// comment saying the lane is waiting.
	it("holds a labeled PR whose head changed, keeps the label, and says it is waiting", async () => {
		const { fetcher, calls } = fakeGithub({
			"POST /graphql": graphqlPage([
				lanePrNode({ labels: [TRAIN_APPROVED_LABEL], checks: [] }),
			]),
			"GET /repos/acme/repo/actions/runs": runsRoute(HEALTHY_RUNS),
		});
		const results = await runMergeLane({
			fetcher,
			owner: "acme",
			repo: "repo",
			now: NOW,
		});
		expect(results[0]).toMatchObject({
			merged: false,
			reason: MERGE_GATE_REASON.REQUIRED_CHECK_ABSENT,
		});
		expect(calls.some((c) => c.url.endsWith("/merge"))).toBe(false);
		expect(
			calls.some(
				(c) =>
					c.method === "DELETE" && c.url.includes(encodeURIComponent("train:")),
			),
		).toBe(false);
		const comment = calls.find(
			(c) => c.method === "POST" && c.url.endsWith("/issues/7/comments"),
		);
		expect(String((comment?.body as { body: string }).body)).toContain(
			"label stays on",
		);
	});

	it("does not repeat the same hold comment for the same head and reason", async () => {
		const marker = laneCommentMarker(
			"deadbeef",
			MERGE_GATE_REASON.REQUIRED_CHECK_ABSENT,
		);
		const { fetcher, calls } = fakeGithub({
			"POST /graphql": graphqlPage([
				lanePrNode({ labels: [TRAIN_APPROVED_LABEL], checks: [] }),
			]),
			"GET /repos/acme/repo/actions/runs": runsRoute(HEALTHY_RUNS),
			"GET /repos/acme/repo/issues/7/comments": [{ body: `held\n${marker}` }],
		});
		await runMergeLane({ fetcher, owner: "acme", repo: "repo", now: NOW });
		expect(
			calls.filter(
				(c) => c.method === "POST" && c.url.endsWith("/issues/7/comments"),
			),
		).toHaveLength(0);
	});

	// AC3 at the sweep level: green checks plus a starved run must not merge.
	it("refuses to merge a green-looking PR whose head run is starved", async () => {
		const { fetcher, calls } = fakeGithub({
			"POST /graphql": graphqlPage([
				lanePrNode({ labels: [TRAIN_APPROVED_LABEL] }),
			]),
			"GET /repos/acme/repo/actions/runs": runsRoute([
				{
					id: 9,
					path: ".github/workflows/ci.yml",
					status: "completed",
					conclusion: "failure",
					run_attempt: 1,
					created_at: "2026-08-26T16:05:00Z",
				},
				HEALTHY_RUNS[1],
			]),
			"GET /repos/acme/repo/actions/runs/9/jobs": { jobs: starvedJobs() },
		});
		const results = await runMergeLane({
			fetcher,
			owner: "acme",
			repo: "repo",
			now: NOW,
		});
		expect(results[0]).toMatchObject({
			merged: false,
			reason: MERGE_GATE_REASON.RUN_HEALTH,
			runHealth: RUN_HEALTH.STARVED,
		});
		expect(calls.some((c) => c.url.endsWith("/merge"))).toBe(false);
	});

	it("records a 409 from a head that moved mid-cycle as benign, and comments", async () => {
		const { fetcher, calls } = fakeGithub({
			"POST /graphql": graphqlPage([
				lanePrNode({ labels: [TRAIN_APPROVED_LABEL] }),
			]),
			"GET /repos/acme/repo/actions/runs": runsRoute(HEALTHY_RUNS),
			"PUT /repos/acme/repo/pulls/7/merge": () => ({
				ok: false,
				status: 409,
				json: async () => ({}),
			}),
		});
		const results = await runMergeLane({
			fetcher,
			owner: "acme",
			repo: "repo",
			now: NOW,
		});
		expect(results[0].merged).toBe(false);
		expect(results[0].errors).toContainEqual({
			message: expect.stringContaining("HTTP 409"),
			benign: true,
		});
		expect(
			calls.some(
				(c) => c.method === "POST" && c.url.endsWith("/issues/7/comments"),
			),
		).toBe(true);
	});

	// Review round 1, F2: the merge-failure comment wrote a marker and never
	// read one, so a persistent refusal posted an identical comment every
	// cycle. At the 10-minute cron that is 144 a day.
	it("does not repeat the merge-failure comment while one already exists for this head", async () => {
		const marker = laneCommentMarker("deadbeef", "merge-failed-405");
		const { fetcher, calls } = fakeGithub({
			"POST /graphql": graphqlPage([
				lanePrNode({ labels: [TRAIN_APPROVED_LABEL] }),
			]),
			"GET /repos/acme/repo/actions/runs": runsRoute(HEALTHY_RUNS),
			"GET /repos/acme/repo/issues/7/comments": [
				{ body: `earlier failure\n${marker}` },
			],
			"PUT /repos/acme/repo/pulls/7/merge": () => ({
				ok: false,
				status: 405,
				json: async () => ({}),
			}),
		});
		await runMergeLane({ fetcher, owner: "acme", repo: "repo", now: NOW });
		expect(
			calls.filter(
				(c) => c.method === "POST" && c.url.endsWith("/issues/7/comments"),
			),
		).toHaveLength(0);
	});

	it("posts the merge-failure comment exactly once when none exists yet", async () => {
		const { fetcher, calls } = fakeGithub({
			"POST /graphql": graphqlPage([
				lanePrNode({ labels: [TRAIN_APPROVED_LABEL] }),
			]),
			"GET /repos/acme/repo/actions/runs": runsRoute(HEALTHY_RUNS),
			"PUT /repos/acme/repo/pulls/7/merge": () => ({
				ok: false,
				status: 405,
				json: async () => ({}),
			}),
		});
		await runMergeLane({ fetcher, owner: "acme", repo: "repo", now: NOW });
		const posted = calls.filter(
			(c) => c.method === "POST" && c.url.endsWith("/issues/7/comments"),
		);
		expect(posted).toHaveLength(1);
		expect(String((posted[0].body as { body: string }).body)).toContain(
			laneCommentMarker("deadbeef", "merge-failed-405"),
		);
	});

	// Review round 1, F1, at the sweep level: every open PR in this repository
	// was BEHIND, and strict protection means the merge API refuses those.
	it("calls update-branch with the expected head, and never merges, for a green BEHIND PR", async () => {
		const { fetcher, calls } = fakeGithub({
			"POST /graphql": graphqlPage([
				lanePrNode({
					labels: [TRAIN_APPROVED_LABEL],
					mergeStateStatus: "BEHIND",
				}),
			]),
			"GET /repos/acme/repo/actions/runs": runsRoute(HEALTHY_RUNS),
		});
		const results = await runMergeLane({
			fetcher,
			owner: "acme",
			repo: "repo",
			now: NOW,
		});
		expect(results[0]).toMatchObject({
			merged: false,
			updated: true,
			reason: MERGE_GATE_REASON.BEHIND_BASE,
		});
		expect(calls.some((c) => c.url.endsWith("/pulls/7/merge"))).toBe(false);
		expect(calls).toContainEqual({
			method: "PUT",
			url: "https://api.github.com/repos/acme/repo/pulls/7/update-branch",
			body: { expected_head_sha: "deadbeef" },
		});
		expect(calls.some((c) => c.url.endsWith("/dispatches"))).toBe(false);
	});

	// Review round 2, F1: update-branch's 403 means two different things
	// depending on whose branch it is (#1959). The lane must read the response
	// through the warden's existing classifier, not a weaker local rule.
	function behindUpdateFails(isFork: boolean, status: number) {
		return fakeGithub({
			"POST /graphql": graphqlPage([
				lanePrNode({
					labels: [TRAIN_APPROVED_LABEL],
					mergeStateStatus: "BEHIND",
					isCrossRepository: isFork,
				}),
			]),
			"GET /repos/acme/repo/actions/runs": runsRoute(HEALTHY_RUNS),
			"PUT /repos/acme/repo/pulls/7/update-branch": () => ({
				ok: false,
				status,
				json: async () => ({}),
			}),
		});
	}

	it("records an update-branch 403 on a fork-owned PR as benign with the fork outcome", async () => {
		const { fetcher } = behindUpdateFails(true, 403);
		const results = await runMergeLane({
			fetcher,
			owner: "acme",
			repo: "repo",
			now: NOW,
		});
		expect(results[0].updated).toBe(false);
		expect(results[0].errors).toContainEqual({
			message: expect.stringContaining("update-branch-forbidden-fork"),
			benign: true,
		});
	});

	it("records an update-branch 403 on an own-branch PR as a fatal failure", async () => {
		const { fetcher } = behindUpdateFails(false, 403);
		const results = await runMergeLane({
			fetcher,
			owner: "acme",
			repo: "repo",
			now: NOW,
		});
		expect(results[0].errors).toContainEqual({
			message: expect.stringContaining("HTTP 403"),
			benign: false,
		});
		expect(
			results[0].errors.some((e) => e.message.includes("forbidden-fork")),
		).toBe(false);
	});

	it("keeps update-branch 409 and 422 benign for an own-branch PR", async () => {
		for (const status of [409, 422]) {
			const { fetcher } = behindUpdateFails(false, status);
			const results = await runMergeLane({
				fetcher,
				owner: "acme",
				repo: "repo",
				now: NOW,
			});
			expect(results[0].errors).toContainEqual({
				message: expect.stringContaining(`HTTP ${status}`),
				benign: true,
			});
		}
	});

	// Review round 1, F5, at the sweep level.
	it("does not merge when the timeline names a labeler outside the approver list", async () => {
		const { fetcher, calls } = fakeGithub({
			"POST /graphql": graphqlPage([
				lanePrNode({ labels: [TRAIN_APPROVED_LABEL] }),
			]),
			"GET /repos/acme/repo/actions/runs": runsRoute(HEALTHY_RUNS),
			"GET /repos/acme/repo/issues/7/timeline": [
				{
					event: "labeled",
					label: { name: TRAIN_APPROVED_LABEL },
					actor: { login: "drive-by" },
				},
			],
		});
		const results = await runMergeLane({
			fetcher,
			owner: "acme",
			repo: "repo",
			now: NOW,
		});
		expect(results[0]).toMatchObject({
			merged: false,
			reason: MERGE_GATE_REASON.NOT_APPROVED_BY_OWNER,
			approvedBy: "drive-by",
		});
		expect(calls.some((c) => c.url.endsWith("/merge"))).toBe(false);
	});

	it("reads the LAST labeled event, so a re-add by a bot loses the owner's provenance", async () => {
		const { fetcher } = fakeGithub({
			"GET /repos/acme/repo/issues/7/timeline": [
				{
					event: "labeled",
					label: { name: TRAIN_APPROVED_LABEL },
					actor: { login: "acme" },
				},
				{ event: "unlabeled", label: { name: TRAIN_APPROVED_LABEL } },
				{
					event: "labeled",
					label: { name: TRAIN_APPROVED_LABEL },
					actor: { login: "some-bot" },
				},
			],
		});
		expect(
			await resolveApprovalActor(fetcher, "acme", "repo", 7, ["acme"]),
		).toEqual({ allowed: false, actor: "some-bot", error: null });
	});

	it("ignores labeled events for other labels", async () => {
		const { fetcher } = fakeGithub({
			"GET /repos/acme/repo/issues/7/timeline": [
				{
					event: "labeled",
					label: { name: TRAIN_APPROVED_LABEL },
					actor: { login: "acme" },
				},
				{
					event: "labeled",
					label: { name: "bug" },
					actor: { login: "drive-by" },
				},
			],
		});
		expect(
			await resolveApprovalActor(fetcher, "acme", "repo", 7, ["acme"]),
		).toEqual({ allowed: true, actor: "acme", error: null });
	});

	it("fails closed when the timeline read errors", async () => {
		const { fetcher } = fakeGithub({
			"GET /repos/acme/repo/issues/7/timeline": () => ({
				ok: false,
				status: 500,
				json: async () => ({}),
			}),
		});
		const result = await resolveApprovalActor(fetcher, "acme", "repo", 7, [
			"acme",
		]);
		expect(result.allowed).toBe(false);
		expect(result.error).toContain("HTTP 500");
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
