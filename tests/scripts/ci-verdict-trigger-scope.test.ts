import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	computeVerdict,
	EXIT_FAILURE,
	EXIT_PENDING,
	EXIT_SUCCESS,
	run,
} from "../../scripts/ci-verdict.mjs";
import { isNonPrCiEvent } from "../../scripts/lib/ci-checks.mjs";

/**
 * #4090: ci-verdict gated on every check-run attached to a commit, including
 * the ones a schedule or a workflow_dispatch run attached to it. Seen
 * 2026-10-07: the daily `untriaged-issues.yml` run left `Detect untriaged
 * issues` (failure) on master's head eb25d80cb (`ci-verdict` exit 1, MASTER-RED
 * fired), and #4076's required dispatch of `stryker-nightly.yml` left
 * `Stryker shard 0 (12 files)` (failure) on the PR head (`ci-verdict 4076` exit
 * 1). Both are real shapes captured from the live API: a check-run carries
 * `check_suite.id`, `app.slug` and `head_sha`; the workflow run for the head
 * carries the same `check_suite_id` and the `event` that triggered it.
 *
 * Red-first: every `run()` case below is red on master's `ci-verdict.mjs`
 * except the ones that pin the fail-safe direction (they pin today's gating,
 * which the fix must keep).
 */

const FULL_SHA = "eb25d80cb2".padEnd(40, "0");
const REQUIRED = ["Unit tests", "Lint & type-check"];

type Row = {
	name: string;
	suite: number;
	conclusion?: string | null;
	status?: string;
	app?: string;
};

const checkRun = ({
	name,
	suite,
	conclusion = "success",
	status = "completed",
	app = "github-actions",
}: Row) => ({
	id: suite * 10 + name.length,
	name,
	status,
	conclusion,
	started_at: "2026-10-07T00:00:00Z",
	head_sha: FULL_SHA,
	check_suite: { id: suite },
	app: { slug: app },
	html_url: `https://github.com/acme/repo/actions/runs/${suite}`,
	details_url: `https://github.com/acme/repo/actions/runs/${suite}/job/1`,
});

const workflowRun = (suite: number, event: string) => ({
	id: suite + 1,
	name: `workflow-${suite}`,
	event,
	head_sha: FULL_SHA,
	check_suite_id: suite,
	status: "completed",
	conclusion: "success",
	run_attempt: 1,
	created_at: "2026-10-07T00:00:00Z",
});

const REQUIRED_GREEN: Row[] = [
	{ name: "Unit tests", suite: 1 },
	{ name: "Lint & type-check", suite: 2 },
];
const REQUIRED_RUNS = [
	workflowRun(1, "pull_request"),
	workflowRun(2, "pull_request"),
];

async function verdictOf({
	rows,
	runs,
	target = "eb25d80cb",
	runsThrow = false,
	author,
}: {
	rows: Row[];
	runs: Array<Record<string, unknown>>;
	target?: string;
	runsThrow?: boolean;
	author?: { login: string; is_bot?: boolean };
}) {
	return verdictRaw({
		checkRuns: rows.map(checkRun),
		runs,
		target,
		runsThrow,
		author,
	});
}

async function verdictRaw({
	checkRuns,
	runs,
	target = "eb25d80cb",
	runsThrow = false,
	required = REQUIRED,
	author,
}: {
	checkRuns: Array<Record<string, unknown>>;
	runs: Array<Record<string, unknown>>;
	target?: string;
	runsThrow?: boolean;
	required?: string[];
	author?: { login: string; is_bot?: boolean };
}) {
	const sha = String(checkRuns[0]?.head_sha);
	const calls: string[] = [];
	const ghExec = (args: string[]) => {
		calls.push(args.join(" "));
		if (args[0] === "repo") return "acme/repo";
		if (args[0] === "pr")
			return JSON.stringify({
				headRefOid: sha,
				mergeable: "MERGEABLE",
				author,
			});
		const endpoint = args[1] ?? "";
		if (endpoint.endsWith("/protection"))
			return JSON.stringify({ required_status_checks: { contexts: required } });
		if (endpoint.includes("/check-runs"))
			return JSON.stringify({
				total_count: checkRuns.length,
				check_runs: checkRuns,
			});
		if (endpoint.includes("/actions/runs")) {
			// A short-SHA target must still ask with the FULL head sha: the API
			// never matches a short one.
			expect(endpoint).toContain(`head_sha=${sha}`);
			if (runsThrow) throw new Error("HTTP 502");
			return JSON.stringify({
				total_count: runs.length,
				workflow_runs: runs,
			});
		}
		throw new Error(`unmocked gh call: ${args.join(" ")}`);
	};
	const lines: string[] = [];
	const result = await run({
		argv: [target],
		ghExec,
		stdout: (line: string) => lines.push(line),
		stderr: () => {},
	});
	return { ...result, out: lines.join("\n"), calls };
}

describe("ci-verdict gates only on checks from this commit's PR/push CI (#4090)", () => {
	it("a failing check from a schedule-only run is advisory: exit 0 and a line naming it", async () => {
		// Recurrence: master head eb25d80cb, `Detect untriaged issues` (failure)
		// from the daily untriaged-issues.yml schedule read as MASTER-RED.
		const v = await verdictOf({
			rows: [
				...REQUIRED_GREEN,
				{ name: "Detect untriaged issues", suite: 3, conclusion: "failure" },
			],
			runs: [...REQUIRED_RUNS, workflowRun(3, "schedule")],
		});
		expect(v.code).toBe(EXIT_SUCCESS);
		expect(v.out).toContain(
			"Advisory by trigger (schedule run, not this commit's PR/push CI): Detect untriaged issues (failure)",
		);
		expect(v.out).toContain("Gating: 2 checks, 0 failing");
	});

	it("a failing check from a workflow_dispatch run on a PR head is advisory", async () => {
		// Recurrence: #4076's required dispatch of stryker-nightly.yml left
		// `Stryker shard 0 (12 files)` (failure) on the PR head, so the merge
		// gate read the PR red.
		const v = await verdictOf({
			target: "4076",
			rows: [
				...REQUIRED_GREEN,
				{ name: "Stryker shard 0 (12 files)", suite: 3, conclusion: "failure" },
			],
			runs: [...REQUIRED_RUNS, workflowRun(3, "workflow_dispatch")],
		});
		expect(v.code).toBe(EXIT_SUCCESS);
		expect(v.out).toContain(
			"Advisory by trigger (workflow_dispatch run, not this commit's PR/push CI): Stryker shard 0 (12 files) (failure)",
		);
	});

	// Recurrence: #5062. A PR a workflow opens with GITHUB_TOKEN has no
	// pull_request run; the nightly dispatches ci.yml and lint.yml on its branch,
	// so every non-required check is a dispatch row. Read as advisory (#4090),
	// `Dependency boundaries` and `Production install build` red gave `success`.
	describe("dispatch runs on a bot-opened PR are its CI (#5062)", () => {
		const RED_DISPATCH: Row[] = [
			{ name: "Dependency boundaries", suite: 3, conclusion: "failure" },
			{
				name: "Production install build (--omit=dev, from source)",
				suite: 3,
				conclusion: "failure",
			},
		];
		const BOT = { login: "app/github-actions", is_bot: true };

		it("gates a red non-required dispatch check on a bot PR: exit 1", async () => {
			const v = await verdictOf({
				target: "5066",
				author: BOT,
				rows: [...REQUIRED_GREEN, ...RED_DISPATCH],
				runs: [...REQUIRED_RUNS, workflowRun(3, "workflow_dispatch")],
			});
			expect(v.code).toBe(EXIT_FAILURE);
			expect(v.out).toContain("Dependency boundaries (failure)");
			expect(v.out).not.toContain("Advisory by trigger");
		});

		it("holds a still-running non-required dispatch check on a bot PR pending: exit 3", async () => {
			const v = await verdictOf({
				target: "5066",
				author: BOT,
				rows: [
					...REQUIRED_GREEN,
					{
						name: "Dependency boundaries",
						suite: 3,
						status: "in_progress",
						conclusion: null,
					},
				],
				runs: [...REQUIRED_RUNS, workflowRun(3, "workflow_dispatch")],
			});
			expect(v.code).toBe(EXIT_PENDING);
		});

		it("keeps the same dispatch rows advisory on a human PR: exit 0", async () => {
			const v = await verdictOf({
				target: "5066",
				author: { login: "apmantza", is_bot: false },
				rows: [...REQUIRED_GREEN, ...RED_DISPATCH],
				runs: [...REQUIRED_RUNS, workflowRun(3, "workflow_dispatch")],
			});
			expect(v.code).toBe(EXIT_SUCCESS);
			expect(v.out).toContain(
				"Advisory by trigger (workflow_dispatch run, not this commit's PR/push CI): Dependency boundaries (failure)",
			);
		});

		it("keeps a bare-SHA target advisory: it carries no author", async () => {
			const v = await verdictOf({
				rows: [...REQUIRED_GREEN, ...RED_DISPATCH],
				runs: [...REQUIRED_RUNS, workflowRun(3, "workflow_dispatch")],
				author: BOT,
			});
			expect(v.code).toBe(EXIT_SUCCESS);
		});

		it.each(["schedule", "workflow_run", "repository_dispatch"])(
			"keeps a %s run advisory on a bot PR: only dispatch flips",
			async (event) => {
				const v = await verdictOf({
					target: "5066",
					author: BOT,
					rows: [...REQUIRED_GREEN, ...RED_DISPATCH],
					runs: [...REQUIRED_RUNS, workflowRun(3, event)],
				});
				expect(v.code).toBe(EXIT_SUCCESS);
			},
		);

		it("keeps an (advisory) name advisory even from a bot PR's dispatch run", async () => {
			const v = await verdictOf({
				target: "5066",
				author: BOT,
				rows: [
					...REQUIRED_GREEN,
					{ name: "OSV scan (advisory)", suite: 3, conclusion: "failure" },
				],
				runs: [...REQUIRED_RUNS, workflowRun(3, "workflow_dispatch")],
			});
			expect(v.code).toBe(EXIT_SUCCESS);
		});
	});

	it("a still-running dispatch check does not hold the verdict pending", async () => {
		// Recurrence: #4076's `Build combined nightly report` was in_progress
		// for the length of the Stryker run; a pending gating row exits 3.
		const v = await verdictOf({
			rows: [
				...REQUIRED_GREEN,
				{
					name: "Build combined nightly report",
					suite: 3,
					status: "in_progress",
					conclusion: null,
				},
			],
			runs: [...REQUIRED_RUNS, workflowRun(3, "workflow_dispatch")],
		});
		expect(v.code).toBe(EXIT_SUCCESS);
	});

	it("a failing check from a pull_request run still gates: exit 1", async () => {
		// The fix must not loosen PR CI: `PR metadata` is a pull_request
		// workflow and its failure stays red.
		const v = await verdictOf({
			rows: [
				...REQUIRED_GREEN,
				{ name: "PR metadata", suite: 3, conclusion: "failure" },
			],
			runs: [...REQUIRED_RUNS, workflowRun(3, "pull_request")],
		});
		expect(v.code).toBe(EXIT_FAILURE);
		expect(v.out).toContain("PR metadata (failure)");
		expect(v.out).not.toContain("Advisory by trigger");
	});

	it.each(["push", "merge_group", "pull_request_target"])(
		"a failing check from a %s run still gates",
		async (event) => {
			const v = await verdictOf({
				rows: [
					...REQUIRED_GREEN,
					{ name: "Some CI job", suite: 3, conclusion: "failure" },
				],
				runs: [...REQUIRED_RUNS, workflowRun(3, event)],
			});
			expect(v.code).toBe(EXIT_FAILURE);
		},
	);

	it("a required check always gates, even when its only run was a dispatch", async () => {
		// Fail-safe: branch protection's required names are never excused by
		// the trigger scope (a dispatched ci.yml that failed `Unit tests`).
		const v = await verdictOf({
			rows: [
				{ name: "Unit tests", suite: 1, conclusion: "failure" },
				{ name: "Lint & type-check", suite: 2 },
			],
			runs: [
				workflowRun(1, "workflow_dispatch"),
				workflowRun(2, "pull_request"),
			],
		});
		expect(v.code).toBe(EXIT_FAILURE);
		expect(v.out).toContain("Unit tests (failure)");
		expect(v.out).not.toContain("Advisory by trigger");
	});

	it("a name that also ran from a pull_request run keeps gating (install-smoke shape)", async () => {
		// install-smoke.yml is on push, pull_request, schedule and dispatch at
		// once: a name with ANY PR/push run gates, whichever run is latest.
		const v = await verdictOf({
			rows: [
				...REQUIRED_GREEN,
				{ name: "install-smoke", suite: 3, conclusion: "success" },
				{ name: "install-smoke", suite: 4, conclusion: "failure" },
			],
			runs: [
				...REQUIRED_RUNS,
				workflowRun(3, "pull_request"),
				workflowRun(4, "workflow_dispatch"),
			],
		});
		expect(v.code).toBe(EXIT_FAILURE);
	});

	it("a failing third-party app check with no workflow run keeps today's gating, silently", async () => {
		const v = await verdictOf({
			rows: [
				...REQUIRED_GREEN,
				{
					name: "Some Third Party Check",
					suite: 9,
					conclusion: "failure",
					app: "some-app",
				},
			],
			runs: REQUIRED_RUNS,
		});
		expect(v.code).toBe(EXIT_FAILURE);
		expect(v.out).not.toContain("Trigger scope:");
	});

	it("an Actions check whose workflow run was not returned gates and says so once", async () => {
		// Fail-safe observability: a run past the first page of the head's runs
		// is unclassified, so it gates as before and the line names it.
		const v = await verdictOf({
			rows: [
				...REQUIRED_GREEN,
				{ name: "Orphan job", suite: 7, conclusion: "failure" },
			],
			runs: REQUIRED_RUNS,
		});
		expect(v.code).toBe(EXIT_FAILURE);
		expect(v.out).toContain(
			"Trigger scope: could not classify 1 check(s) (no workflow run matched); they gate as before: Orphan job",
		);
	});

	it("an unreadable runs list fails open to today's gating and says why", async () => {
		const v = await verdictOf({
			rows: [
				...REQUIRED_GREEN,
				{ name: "Detect untriaged issues", suite: 3, conclusion: "failure" },
			],
			runs: [],
			runsThrow: true,
		});
		expect(v.code).toBe(EXIT_FAILURE);
		expect(v.out).toContain(
			"Trigger scope: could not classify 1 check(s) (the workflow-run read failed: HTTP 502); they gate as before: Detect untriaged issues",
		);
	});

	it("a green head makes no workflow-run read", async () => {
		// Recurrence guard: `--all` and `--watch-open` call run() per PR on
		// every poll; the extra read is only worth it when a row could change
		// the verdict.
		const v = await verdictOf({
			rows: [...REQUIRED_GREEN, { name: "tla", suite: 3 }],
			runs: [...REQUIRED_RUNS, workflowRun(3, "pull_request")],
		});
		expect(v.code).toBe(EXIT_SUCCESS);
		expect(v.calls.filter((c) => c.includes("/actions/runs"))).toEqual([]);
	});
});

describe("a missing workflow-run event never makes a PR check advisory (#4090 round 2, F1)", () => {
	it("a PR run reported without an event gates and says it could not classify", async () => {
		// Recurrence guard: `readHeadRunsPayload` keeps only runs that carry an
		// `event`. If a run without one were defaulted to a schedule-like event
		// instead, a pull_request check would turn advisory and a real PR red
		// would read green.
		const v = await verdictOf({
			rows: [
				...REQUIRED_GREEN,
				{ name: "PR job", suite: 3, conclusion: "failure" },
			],
			runs: [
				...REQUIRED_RUNS,
				{ ...workflowRun(3, "pull_request"), event: null },
			],
		});
		expect(v.code).toBe(EXIT_FAILURE);
		expect(v.out).toContain(
			"Trigger scope: could not classify 1 check(s) (no workflow run matched); they gate as before: PR job",
		);
		expect(v.out).not.toContain("Advisory by trigger");
	});
});

// #4084 head 18271874a (2026-10-07): CI run 37636737624 was cancelled by the
// event-scoped cancel-in-progress when run 37637101565 started. Until the newer
// run posted its own `Unit tests` row, the cancelled run's failed `Unit tests`
// row was the only one for that required name, so `ci-verdict` read the PR red
// while the replacement was still running. The fixture is the two runs'
// real payloads and the check-runs of both suites up to the moment the newer
// run was still open.
describe("a failing row from a cancelled run superseded by an open newer run is pending (#4090 round 2, F4)", () => {
	const fixture = JSON.parse(
		readFileSync(
			join(process.cwd(), "tests/fixtures/ci-verdict/superseded-4084.json"),
			"utf8",
		),
	);
	const CANCELLED = 37636737624;
	const NEWER = 37637101565;
	type WorkflowRunFixture = Record<string, unknown> & {
		id: number;
		workflow_id?: number;
	};
	const withRuns = (edit: (runs: Array<WorkflowRunFixture>) => void) => {
		const runs = structuredClone(fixture.workflowRuns);
		edit(runs);
		return verdictRaw({
			target: "4084",
			checkRuns: structuredClone(fixture.checkRuns),
			runs,
			required: ["Unit tests", "Lint & type-check", "TLA+ models"],
		});
	};
	const runById = (runs: Array<WorkflowRunFixture>, id: number) =>
		runs.find((r) => r.id === id)!;

	it("the real shape reads pending, naming the row and the newer run", async () => {
		const v = await withRuns(() => {});
		expect(v.code).toBe(EXIT_PENDING);
		expect(v.out).toContain(
			`superseded by a newer run still in progress (the cancelled run's rows are not final): Unit tests (failure, newer run ${NEWER})`,
		);
	});

	it("a superseded cancelled row reads as superseded, not as a rerun hint", async () => {
		// Recurrence guard: the cancelled-row branch prints a rerun command, which
		// is wrong advice while the newer run is still posting its own rows.
		const v = await verdictRaw({
			target: "4084",
			checkRuns: structuredClone(fixture.checkRuns).filter(
				(c: { name: string; check_suite: { id: number } }) =>
					!(
						c.name === "Lint & type-check" && c.check_suite.id === 101957801991
					),
			),
			runs: structuredClone(fixture.workflowRuns),
			required: ["Unit tests", "Lint & type-check", "TLA+ models"],
		});
		expect(v.code).toBe(EXIT_PENDING);
		expect(v.out).toContain(
			`Lint & type-check (cancelled, newer run ${NEWER})`,
		);
		expect(v.out).not.toContain("superseded run cancelled and not replaced");
	});

	it("rows of the cancelled run that would not fail do not hold the verdict", async () => {
		// Recurrence guard: only a row that would fail or read cancelled is
		// pending; the cancelled run's green rows stay green.
		const checkRuns = structuredClone(fixture.checkRuns);
		for (const c of checkRuns) {
			if (c.name === "Unit tests" && c.check_suite.id === 101956758794)
				c.conclusion = "success";
		}
		const v = await verdictRaw({
			target: "4084",
			checkRuns,
			runs: structuredClone(fixture.workflowRuns),
			required: ["Unit tests", "Lint & type-check", "TLA+ models"],
		});
		expect(v.code).toBe(EXIT_SUCCESS);
	});

	it("a cancelled run with no newer run stays red", async () => {
		const v = await withRuns((runs) => {
			runs.splice(runs.indexOf(runById(runs, NEWER)), 1);
		});
		expect(v.code).toBe(EXIT_FAILURE);
		expect(v.out).toContain("Unit tests (failure)");
	});

	it("a newer run that completed red stays red", async () => {
		const v = await withRuns((runs) => {
			Object.assign(runById(runs, NEWER), {
				status: "completed",
				conclusion: "failure",
			});
		});
		expect(v.code).toBe(EXIT_FAILURE);
	});

	it("a non-cancelled failure is never masked by an open newer run", async () => {
		const v = await withRuns((runs) => {
			runById(runs, CANCELLED).conclusion = "failure";
		});
		expect(v.code).toBe(EXIT_FAILURE);
		expect(v.out).toContain("Unit tests (failure)");
	});

	it.each([
		["a different workflow", { workflow_id: 1 }],
		["a different event", { event: "workflow_dispatch" }],
		["an older created_at", { created_at: "2026-10-07T14:00:00Z" }],
	])("an open run of %s does not supersede it", async (_label, patch) => {
		const v = await withRuns((runs) => {
			Object.assign(runById(runs, NEWER), patch);
		});
		expect(v.code).toBe(EXIT_FAILURE);
	});

	it("runs without a workflow_id never supersede each other", async () => {
		const v = await withRuns((runs) => {
			for (const r of runs) delete r.workflow_id;
		});
		expect(v.code).toBe(EXIT_FAILURE);
	});

	it("a lone red required row still triggers the workflow-run read and reads pending", async () => {
		// Recurrence guard: `Unit tests` is a required name, which the lazy read
		// used to skip, so the superseded stamp could never reach it. Every other
		// row of the cancelled run is dropped so no discovered row asks for the
		// read.
		const v = await verdictRaw({
			target: "4084",
			checkRuns: structuredClone(fixture.checkRuns).filter(
				(c: { name: string; check_suite: { id: number } }) =>
					c.check_suite.id !== 101956758794 || c.name === "Unit tests",
			),
			runs: structuredClone(fixture.workflowRuns),
			required: ["Unit tests", "Lint & type-check", "TLA+ models"],
		});
		expect(v.calls.filter((c) => c.includes("/actions/runs"))).toHaveLength(1);
		expect(v.code).toBe(EXIT_PENDING);
	});
});

describe("ci-verdict trigger scope on the REST transport (#4090)", () => {
	// Recurrence: #5066 r2 verify F6. run() passing `botAuthored: false` on the
	// REST arm kept every test green, so a bot PR read over REST would have
	// excused its dispatch reds again (#5062).
	it.each([
		{
			name: "excuses a dispatch-only red exactly as the gh transport does",
			user: undefined,
			code: EXIT_SUCCESS,
			excused: true,
		},
		{
			name: "gates the same dispatch-only red on a bot-opened PR (#5062)",
			user: { login: "github-actions[bot]", type: "Bot" },
			code: EXIT_FAILURE,
			excused: false,
		},
	])("$name", async ({ user, code, excused }) => {
		const original = {
			PATH: process.env.PATH,
			GH_TOKEN: process.env.GH_TOKEN,
			GITHUB_TOKEN: process.env.GITHUB_TOKEN,
		};
		process.env.PATH = "";
		process.env.GH_TOKEN = "test-token";
		delete process.env.GITHUB_TOKEN;
		const rows: Row[] = [
			...REQUIRED_GREEN,
			{ name: "Stryker shard 0 (12 files)", suite: 3, conclusion: "failure" },
		];
		const runs = [...REQUIRED_RUNS, workflowRun(3, "workflow_dispatch")];
		const fetchImpl = async (url: string) => {
			if (url.includes("/pulls/4076"))
				return new Response(
					JSON.stringify({
						head: { sha: FULL_SHA },
						mergeable: true,
						mergeable_state: "clean",
						user,
					}),
				);
			if (url.includes("/branches/master/protection"))
				return new Response("", { status: 403 });
			if (url.includes("/actions/runs"))
				return new Response(
					JSON.stringify({ total_count: runs.length, workflow_runs: runs }),
				);
			return new Response(
				JSON.stringify({
					total_count: rows.length,
					check_runs: rows.map(checkRun),
				}),
			);
		};
		const lines: string[] = [];
		try {
			const result = await run({
				argv: ["4076"],
				gitExec: () => "https://github.com/acme/repo.git\n",
				fetchImpl,
				stdout: (line: string) => lines.push(line),
				stderr: () => {},
			});
			expect(result.code).toBe(code);
		} finally {
			process.env.PATH = original.PATH;
			if (original.GH_TOKEN === undefined) delete process.env.GH_TOKEN;
			else process.env.GH_TOKEN = original.GH_TOKEN;
			if (original.GITHUB_TOKEN !== undefined)
				process.env.GITHUB_TOKEN = original.GITHUB_TOKEN;
		}
		expect(lines).toContain("Transport: rest");
		const advisory =
			"Advisory by trigger (workflow_dispatch run, not this commit's PR/push CI): Stryker shard 0 (12 files) (failure)";
		expect(lines.join("\n").includes(advisory)).toBe(excused);
	});
});

describe("computeVerdict reads the stamped workflow_event (#4090)", () => {
	const stamped = (name: string, event: string | undefined, id: number) => ({
		...checkRun({ name, suite: id, conclusion: "failure" }),
		...(event === undefined ? {} : { workflow_event: event }),
	});
	const payload = (...rows: ReturnType<typeof stamped>[]) => ({
		check_runs: [
			{ ...checkRun({ name: "Unit tests", suite: 1 }), workflow_event: "push" },
			{
				...checkRun({ name: "Lint & type-check", suite: 2 }),
				workflow_event: "push",
			},
			...rows,
		],
	});

	it("excuses a non-PR-only name and marks the row with its event", () => {
		const verdict = computeVerdict(payload(stamped("nightly", "schedule", 3)));
		expect(verdict.exitCode).toBe(EXIT_SUCCESS);
		const row = verdict.rows.find(
			(r: { name: string }) => r.name === "nightly",
		);
		expect(row).toMatchObject({ gating: false, triggerEvent: "schedule" });
	});

	it("keeps an unstamped row gating (no event, no excuse)", () => {
		const verdict = computeVerdict(payload(stamped("nightly", undefined, 3)));
		expect(verdict.exitCode).toBe(EXIT_FAILURE);
		const row = verdict.rows.find(
			(r: { name: string }) => r.name === "nightly",
		);
		expect(row).toMatchObject({ gating: true });
		expect(row).not.toHaveProperty("triggerEvent");
	});

	it("never excuses a required name", () => {
		const verdict = computeVerdict({
			check_runs: [
				{
					...checkRun({ name: "Unit tests", suite: 1, conclusion: "failure" }),
					workflow_event: "schedule",
				},
				{ ...checkRun({ name: "Lint & type-check", suite: 2 }) },
			],
		});
		expect(verdict.exitCode).toBe(EXIT_FAILURE);
	});
});

describe("isNonPrCiEvent (#4090)", () => {
	it.each([
		["schedule", true],
		["workflow_dispatch", true],
		["repository_dispatch", true],
		["workflow_run", true],
		["pull_request", false],
		["pull_request_target", false],
		["push", false],
		["merge_group", false],
		["issues", false],
		["", false],
		[undefined, false],
	])("%s -> %s", (event, expected) => {
		expect(isNonPrCiEvent(event)).toBe(expected);
	});
});
