// #3700: the orchestrator's hand-rolled CI reads (the `--watch-open` poller,
// the failing-test extraction from job logs, the rerun / update-branch hints,
// post-merge noise, the advisory split, the `--all` snapshot) centralised on
// scripts/ci-verdict.mjs. Every test drives the real CLI entry, `run()`, with
// a `gh` double that replays RECORDED GitHub payloads -- job JSON and job logs
// fetched from apmantza/pi-lens on 2026-09-30 (tests/fixtures/ci-verdict/jobs;
// the logs are excerpts, the elided span marked in the file) -- and no network.
//
// Recurrences this file guards (each test names its own):
//  - #3688 went red in a fix round with nothing notified (--watch-open watched
//    auto-merge PRs only);
//  - a stale `action_required` run pinning a green head at pending (#3697 F2);
//  - the --wait loop caching the push time once (#3697 round-3 verify);
//  - 2026-09-30: a rerun replayed a stale merge commit (#3660) and a
//    post-merge `refs/pull/N/merge` checkout failure was read as a red lane.
import {
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	EXIT_FAILURE,
	EXIT_USAGE,
	EXIT_PENDING,
	EXIT_SUCCESS,
	EXIT_TRANSPORT,
	formatAbsentRequiredReason,
	JOB_LOG_MAX_BUFFER,
	MAX_FAILURE_LINES,
	run,
	WATCH_POLL_INTERVAL_SECONDS,
} from "../../scripts/ci-verdict.mjs";

const FIXTURES = join(process.cwd(), "tests/fixtures");
const JOBS = join(FIXTURES, "ci-verdict/jobs");
const NOW = Date.parse("2026-09-30T12:00:00Z");
const minutesBefore = (minutes: number) =>
	new Date(NOW - minutes * 60_000).toISOString();

interface Job {
	id: number;
	json: { id: number; name: string; html_url: string };
	log: string;
}
function job(stem: string, logOverride?: string): Job {
	const json = JSON.parse(readFileSync(join(JOBS, `${stem}.json`), "utf8"));
	return {
		id: json.id,
		json,
		log: logOverride ?? readFileSync(join(JOBS, `${stem}.log`), "utf8"),
	};
}
// Recorded jobs: a Unit tests failure in `Run tests` (base 01442e98...), a
// Lint & type-check failure in `Install dependencies`, and an Install test that
// died in checkout on `refs/pull/2623/merge` after PR #2623 merged.
const UNIT_FAIL = () => job("unit-tests-fail-101554674114");
const LINT_INSTALL_FAIL = () => job("lint-install-fail-101496353689");
const POST_MERGE = () => job("checkout-fail-post-merge-101528749222");
const UNIT_FAIL_MERGE_BASE = "01442e987f8c2f88b68d08878027d7148b1b7038";

function row(
	name: string,
	conclusion: string | null,
	id: number,
	detailsUrl?: string,
	status = "completed",
) {
	const url =
		detailsUrl ??
		`https://github.com/apmantza/pi-lens/actions/runs/1/job/${id}`;
	return {
		name,
		status,
		conclusion,
		started_at: "2026-09-30T11:00:00Z",
		id,
		html_url: url,
		details_url: url,
	};
}
const jobRow = (j: Job, conclusion = "failure") =>
	row(j.json.name, conclusion, j.id, j.json.html_url);
const GREEN = [
	row("Unit tests", "success", 11),
	row("Lint & type-check", "success", 12),
];

interface PrFixture {
	number: number;
	login?: string;
	sha?: string;
	mergeable?: string;
	autoMerge?: boolean;
	state?: "OPEN" | "MERGED" | "CLOSED";
	checkRuns?: unknown[];
	workflowRuns?: unknown[];
	suites?: { created_at: string }[] | null;
	headReadThrows?: boolean;
}
interface World {
	owner: string;
	viewer: string | null;
	master: string | null;
	prs: PrFixture[];
	jobs: Job[];
	logThrows?: boolean;
	listThrows?: boolean;
	listTransientFailures?: number;
	prStateThrows?: boolean;
	/** #3754: whether master has a merge queue (the GraphQL `mergeQueue{id}` read). */
	mergeQueueEnabled?: boolean;
	/** #3754: an unreadable queue read (`readMergeQueueState` returns null). */
	graphqlThrows?: boolean;
	/** closing issues per merged PR number, and each issue's state. */
	closing?: Record<number, number[]>;
	issueStates?: Record<number, string>;
	/** every mutating gh call (`gh run rerun`, `gh api -X POST`), in order. */
	mutations: string[];
	rerunThrows?: boolean;
	approveThrows?: number[];
	runsThrow?: boolean;
	calls: string[];
	logCalls: { args: string[]; options?: Record<string, unknown> }[];
}
const shaOf = (number: number) => String(number).padStart(40, "a");
const sha9 = (number: number) => shaOf(number).slice(0, 9);

function world(partial: Partial<World> & { prs: PrFixture[] }): World {
	return {
		owner: "apmantza",
		viewer: null,
		master: null,
		jobs: [],
		calls: [],
		mutations: [],
		logCalls: [],
		...partial,
	};
}

/** A `gh` that answers from a mutable World, refusing anything unrecorded. */
function ghFor(w: World) {
	const pr = (n: string) => {
		const found = w.prs.find((p) => String(p.number) === n);
		if (!found) throw new Error(`HTTP 404: no PR ${n}`);
		return found;
	};
	return (
		args: string[],
		options?: { timeoutMs?: number; maxBuffer?: number },
	) => {
		w.calls.push(args.join(" "));
		if (args[0] === "repo") return `${w.owner}/pi-lens`;
		if (args[0] === "api" && args[1] === "graphql") {
			if (w.graphqlThrows) throw new Error("HTTP 502: graphql unavailable");
			return JSON.stringify({
				data: {
					repository: {
						mergeQueue: w.mergeQueueEnabled ? { id: "MQ_test" } : null,
						pullRequest: { isInMergeQueue: false, mergeQueueEntry: null },
					},
				},
			});
		}
		if (args[0] === "run" && args[1] === "rerun") {
			w.mutations.push(args.join(" "));
			if (w.rerunThrows) throw new Error("HTTP 403: rerun refused");
			return "";
		}
		if (args[0] === "api" && args[1] === "-X" && args[2] === "POST") {
			w.mutations.push(args.join(" "));
			const id = Number(/actions\/runs\/(\d+)\/approve/.exec(args[3])?.[1]);
			if (w.approveThrows?.includes(id)) throw new Error("HTTP 403: forbidden");
			return "";
		}
		if (args[0] === "issue" && args[1] === "view") {
			if (args[3] !== "--json" || args[4] !== "state")
				throw new Error(`unmocked gh call: ${args.join(" ")}`);
			return JSON.stringify({
				state: w.issueStates?.[Number(args[2])] ?? "OPEN",
			});
		}
		if (args[0] === "pr" && args[1] === "list") {
			if (w.listThrows) throw new Error("HTTP 404: not found");
			if ((w.listTransientFailures ?? 0) > 0) {
				w.listTransientFailures = (w.listTransientFailures ?? 0) - 1;
				throw Object.assign(new Error("gh failed"), { stderr: "HTTP 502" });
			}
			return JSON.stringify(
				w.prs
					.filter((p) => (p.state ?? "OPEN") === "OPEN")
					.map((p) => ({
						number: p.number,
						author: { login: p.login ?? w.owner },
						headRefOid: p.sha ?? shaOf(p.number),
						autoMergeRequest: p.autoMerge ? { enabledAt: "x" } : null,
					})),
			);
		}
		if (args[0] === "pr" && args[1] === "view") {
			const p = pr(args[2]);
			const fields = args[4];
			if (fields === "closingIssuesReferences")
				return JSON.stringify({
					closingIssuesReferences: (w.closing?.[p.number] ?? []).map(
						(number) => ({ number }),
					),
				});
			if (fields === "state") {
				if (w.prStateThrows) throw new Error("HTTP 502");
				return JSON.stringify({ state: p.state ?? "OPEN" });
			}
			if (fields === "autoMergeRequest")
				return JSON.stringify({
					autoMergeRequest: p.autoMerge ? { enabledAt: "x" } : null,
				});
			if (fields === "headRefOid,labels,comments")
				return JSON.stringify({
					headRefOid: p.sha ?? shaOf(p.number),
					labels: [],
					comments: [],
				});
			if (p.headReadThrows) throw new Error("HTTP 404: Not Found");
			return JSON.stringify({
				headRefOid: p.sha ?? shaOf(p.number),
				mergeable: p.mergeable ?? "MERGEABLE",
			});
		}
		if (args[0] === "api" && args[1] === "user") {
			if (w.viewer === null) throw new Error("HTTP 401");
			return JSON.stringify({ login: w.viewer });
		}
		const endpoint = args.find((arg) => arg.startsWith("repos/")) ?? "";
		const bySha = (sha: string) =>
			w.prs.find((p) => (p.sha ?? shaOf(p.number)) === sha);
		if (endpoint.endsWith("/branches/master/protection"))
			throw new Error("HTTP 404: Not Found");
		if (endpoint.endsWith("/branches/master")) {
			if (w.master === null) throw new Error("HTTP 502");
			return JSON.stringify({ commit: { sha: w.master } });
		}
		let m = /\/commits\/([0-9a-f]+)\/check-runs/.exec(endpoint);
		if (m) {
			const runs = bySha(m[1])?.checkRuns ?? [];
			return JSON.stringify({ total_count: runs.length, check_runs: runs });
		}
		m = /\/actions\/runs\?head_sha=([0-9a-f]+)/.exec(endpoint);
		if (m && w.runsThrow) throw new Error("HTTP 404: runs unreadable");
		if (m)
			return JSON.stringify({
				workflow_runs: bySha(m[1])?.workflowRuns ?? [],
			});
		m = /\/commits\/([0-9a-f]+)\/check-suites/.exec(endpoint);
		if (m) {
			const suites = bySha(m[1])?.suites ?? null;
			if (suites === null) throw new Error("HTTP 502");
			return JSON.stringify({
				total_count: suites.length,
				check_suites: suites,
			});
		}
		m = /\/actions\/jobs\/(\d+)\/logs$/.exec(endpoint);
		if (m) {
			w.logCalls.push({ args, options });
			// Production-faithful on the flag under test: without it real gh
			// sanitises the escape sequences the failure lines are wrapped in.
			if (!args.includes("--allow-escape-sequences"))
				throw new Error("log read without --allow-escape-sequences");
			if (w.logThrows) throw new Error("HTTP 410: Gone");
			const found = w.jobs.find((j) => String(j.id) === m?.[1]);
			if (!found) throw new Error("HTTP 404: no such job");
			return found.log;
		}
		m = /\/actions\/jobs\/(\d+)$/.exec(endpoint);
		if (m) {
			const found = w.jobs.find((j) => String(j.id) === m?.[1]);
			if (!found) throw new Error("HTTP 404: no such job");
			return JSON.stringify(found.json);
		}
		throw new Error(`unmocked gh call: ${args.join(" ")}`);
	};
}

function clock(w?: { onSleep?: (index: number) => void }, startMs = NOW) {
	let t = startMs;
	const sleeps: number[] = [];
	return {
		sleeps,
		now: () => t,
		sleepImpl: async (ms: number) => {
			sleeps.push(ms);
			t += ms;
			w?.onSleep?.(sleeps.length);
		},
	};
}

async function cli(
	argv: string[],
	w: World,
	hooks: {
		onSleep?: (index: number) => void;
		gitExec?: (bin: string, args: string[], options?: unknown) => string;
	} = {},
) {
	const time = clock(hooks);
	const lines: string[] = [];
	const errors: string[] = [];
	const { code: exitCode, kind } = await run({
		argv,
		ghExec: ghFor(w),
		...(hooks.gitExec ? { gitExec: hooks.gitExec } : {}),
		now: time.now,
		sleepImpl: time.sleepImpl,
		stdout: (line: string) => lines.push(line),
		stderr: (line: string) => errors.push(line),
	});
	return {
		exitCode,
		kind,
		lines,
		out: lines.join("\n"),
		reason: lines.at(-1) ?? "",
		errors,
		sleeps: time.sleeps,
	};
}

const ESC = String.fromCharCode(27);

/** The last seen `<sha>:<kind>` per PR in a saved watch state file. */
const savedKeys = (file: string) =>
	Object.fromEntries(
		Object.entries(JSON.parse(readFileSync(file, "utf8"))).map(
			([number, entry]) => [number, (entry as { key: string }).key],
		),
	);

describe("run — failing-test extraction from the recorded job log (#3700)", () => {
	// Recurrence: 2026-09-30 the orchestrator read `gh run view --job --log` by
	// hand, stripped the colour codes and grepped ` FAIL ` / `Tests` every time.
	it("names the failed step, the FAIL and assertion lines and the Tests summary, with no ANSI", async () => {
		const unit = UNIT_FAIL();
		const w = world({
			prs: [{ number: 5, checkRuns: [jobRow(unit), GREEN[1]] }],
			jobs: [unit],
		});
		const { exitCode, out } = await cli(["5"], w);
		expect(exitCode).toBe(EXIT_FAILURE);
		expect(out).toContain(
			"Unit tests (job 101554674114): failed step: Run tests",
		);
		expect(out).toContain(
			"  FAIL   default  tests/clients/instance-reaper-backstop.test.ts > #1864 review F2: a grace-spared candidate is re-examined > arms one follow-",
		);
		expect(out).toContain(
			"  AssertionError: expected undefined to be 5 // Object.is equality",
		);
		expect(out).toContain(
			"  Test Files  1 failed | 985 passed | 13 skipped (999)",
		);
		expect(out).toContain(
			"  Tests  1 failed | 13035 passed | 67 skipped (13103)",
		);
		expect(out).not.toContain(ESC);
		// Costs nothing extra: no PR-state read (only a noise candidate needs it).
		expect(w.calls.some((call) => call.includes("--json state"))).toBe(false);
		// vitest prints the assertion twice (`##[error]` repeats it): listed once.
		expect(
			out.match(/AssertionError: expected undefined to be 5/g),
		).toHaveLength(1);
	});

	it("reads the log the way the orchestrator did: gh api --allow-escape-sequences, with a buffer for a megabyte log", async () => {
		const unit = UNIT_FAIL();
		const w = world({
			prs: [{ number: 5, checkRuns: [jobRow(unit), GREEN[1]] }],
			jobs: [unit],
		});
		await cli(["5"], w);
		expect(w.logCalls).toHaveLength(1);
		expect(w.logCalls[0].args).toEqual([
			"api",
			"--allow-escape-sequences",
			"repos/apmantza/pi-lens/actions/jobs/101554674114/logs",
		]);
		expect(w.logCalls[0].options?.maxBuffer).toBe(JOB_LOG_MAX_BUFFER);
		expect(JOB_LOG_MAX_BUFFER).toBeGreaterThan(1024 * 1024);
	});

	it("strips the real ANSI-wrapped FAIL line of a vitest colour log", async () => {
		const unit = job(
			"unit-tests-fail-101554674114",
			readFileSync(
				join(FIXTURES, "ci-failure-logs/real-assertion-failure.real.log"),
				"utf8",
			),
		);
		expect(unit.log).toContain(`${ESC}[41m`);
		const w = world({
			prs: [{ number: 5, checkRuns: [jobRow(unit), GREEN[1]] }],
			jobs: [unit],
		});
		const { out } = await cli(["5"], w);
		expect(out).toContain(
			"  FAIL   default  tests/clients/word-index-lifecycle.test.ts > word-index lifecycle — full mode (#348) > reuses a fresh persisted snapshot without rebuilding",
		);
		expect(out).toContain(
			"  Tests  1 failed | 9837 passed | 48 skipped (9886)",
		);
		expect(out).not.toContain(ESC);
	});

	// Recurrence: a passing test titled "does not FAIL when ..." must not be
	// reported as a failure (the composite log's own trap).
	it("does not report a passing test whose title contains FAIL", async () => {
		const unit = job(
			"unit-tests-fail-101554674114",
			readFileSync(
				join(
					FIXTURES,
					"ci-failure-logs/fabricated-fail-in-passing-title.composite.log",
				),
				"utf8",
			),
		);
		const w = world({
			prs: [{ number: 5, checkRuns: [jobRow(unit), GREEN[1]] }],
			jobs: [unit],
		});
		const { out } = await cli(["5"], w);
		expect(out).not.toContain("does not FAIL");
	});

	it(`caps the listing at ${MAX_FAILURE_LINES} failing lines and counts the rest`, async () => {
		const many = Array.from(
			{ length: MAX_FAILURE_LINES + 5 },
			(_, i) =>
				`2026-09-30T00:00:00.0000000Z  FAIL   default  t${i}.test.ts > case`,
		).join("\n");
		const unit = job("unit-tests-fail-101554674114", many);
		const w = world({
			prs: [{ number: 5, checkRuns: [jobRow(unit), GREEN[1]] }],
			jobs: [unit],
		});
		const { out } = await cli(["5"], w);
		expect(out.match(/^ {2}FAIL {3}default/gm)).toHaveLength(MAX_FAILURE_LINES);
		expect(out).toContain("... and 5 more failing lines");
	});

	// Recurrence: "Ast-grep self-scan" / "Audit production dependencies" fail
	// BEFORE the tests run; a reader looking for FAIL lines finds none.
	it("names a failed step that is not the test step, with no invented test lines", async () => {
		const lint = LINT_INSTALL_FAIL();
		const w = world({
			prs: [{ number: 5, checkRuns: [GREEN[0], jobRow(lint)] }],
			jobs: [lint],
		});
		const { exitCode, out } = await cli(["5"], w);
		expect(exitCode).toBe(EXIT_FAILURE);
		expect(out).toContain(
			"Lint & type-check (job 101496353689): failed step: Install dependencies",
		);
		expect(out).not.toContain("Test Files");
		expect(out).not.toMatch(/^ {2}FAIL/m);
	});

	it("keeps the red verdict, with a note, when the job log cannot be read", async () => {
		const unit = UNIT_FAIL();
		const w = world({
			prs: [{ number: 5, checkRuns: [jobRow(unit), GREEN[1]] }],
			jobs: [unit],
			logThrows: true,
		});
		const { exitCode, out } = await cli(["5"], w);
		expect(exitCode).toBe(EXIT_FAILURE);
		expect(out).toContain("could not read the job: HTTP 410: Gone");
	});

	it("says so for a failed check that is not a GitHub Actions job, and reads no log", async () => {
		const w = world({
			prs: [
				{
					number: 5,
					checkRuns: [
						GREEN[0],
						GREEN[1],
						row(
							"Vendor scan",
							"failure",
							77,
							"https://vendor.example/checks/77",
						),
					],
				},
			],
		});
		const { exitCode, out } = await cli(["5"], w);
		expect(exitCode).toBe(EXIT_FAILURE);
		expect(out).toContain(
			"Vendor scan: not a GitHub Actions job: no log to read",
		);
		expect(w.logCalls).toHaveLength(0);
		// No merge base was found, so master's head is not read either.
		expect(w.calls.some((call) => call.endsWith("/branches/master"))).toBe(
			false,
		);
	});

	it("reads no job or log for a green head", async () => {
		const w = world({ prs: [{ number: 5, checkRuns: GREEN }] });
		const { exitCode } = await cli(["5"], w);
		expect(exitCode).toBe(EXIT_SUCCESS);
		expect(w.calls.some((call) => call.includes("/actions/jobs/"))).toBe(false);
	});
});

describe("run — gating and advisory reported apart (#3700)", () => {
	// Recurrence: 2026-09-07 a loop text-matched `failure` in the table and
	// stopped on a green PR whose only red was an advisory row.
	it("lists advisory reds on their own line and never lets them fail the verdict", async () => {
		const w = world({
			prs: [
				{
					number: 5,
					checkRuns: [
						...GREEN,
						row("mutation (advisory)", "failure", 21),
						row("OSV scan (advisory)", "timed_out", 22),
						row("PR body (advisory)", "success", 23),
					],
				},
			],
		});
		const { exitCode, lines } = await cli(["5"], w);
		expect(exitCode).toBe(EXIT_SUCCESS);
		expect(lines).toContain("Gating: 2 checks, 0 failing");
		expect(lines).toContain(
			"Advisory (never gates): 3 checks, 2 red: OSV scan (advisory) (timed_out), mutation (advisory) (failure)",
		);
	});

	it("keeps a gating red out of the advisory line and an advisory red out of the gating line", async () => {
		const w = world({
			prs: [
				{
					number: 5,
					checkRuns: [
						row("Unit tests", "failure", 11),
						GREEN[1],
						row("mutation (advisory)", "failure", 21),
					],
				},
			],
		});
		const { exitCode, lines } = await cli(["5"], w);
		expect(exitCode).toBe(EXIT_FAILURE);
		expect(lines).toContain(
			"Gating: 2 checks, 1 failing: Unit tests (failure)",
		);
		expect(lines).toContain(
			"Advisory (never gates): 1 checks, 1 red: mutation (advisory) (failure)",
		);
	});
});

describe("run — sharded Unit tests (#3753)", () => {
	// Recurrence: `Unit tests` is now an aggregate over `Unit tests (shard k/3)`
	// jobs. The failing test lines live in the SHARD's log; the aggregate's own
	// log only says a shard failed. Red on the pre-fix tree only if ci-verdict
	// stopped reading a failed row's log by the row's own job id.
	it("names the failing test from the red shard's log and the aggregate's own step", async () => {
		const shard = UNIT_FAIL();
		shard.json.name = "Unit tests (shard 2/3)";
		const aggregate: Job = {
			id: 11,
			json: {
				id: 11,
				name: "Unit tests",
				html_url: "https://github.com/apmantza/pi-lens/actions/runs/1/job/11",
				steps: [
					{
						name: "Require every Unit tests shard to succeed",
						conclusion: "failure",
					},
				],
			} as Job["json"],
			log: "Unit tests shard jobs (test): failure\n",
		};
		const w = world({
			prs: [
				{
					number: 5,
					checkRuns: [
						row("Unit tests", "failure", 11),
						jobRow(shard),
						GREEN[1],
					],
				},
			],
			jobs: [aggregate, shard],
		});
		const { exitCode, out } = await cli(["5"], w);
		expect(exitCode).toBe(EXIT_FAILURE);
		expect(out).toContain(
			"Unit tests (shard 2/3) (job 101554674114): failed step: Run tests",
		);
		expect(out).toContain(
			"  FAIL   default  tests/clients/instance-reaper-backstop.test.ts > #1864 review F2: a grace-spared candidate is re-examined > arms one follow-",
		);
		expect(out).toContain(
			"Unit tests (job 11): failed step: Require every Unit tests shard to succeed",
		);
	});
});

describe("run — rerun and update-branch remedies (#3700)", () => {
	// Recurrence (#3660, 2026-09-30): `gh run rerun` replays the ORIGINAL merge
	// commit, so a lane red on a base master has since moved past reds again.
	it("hints gh pr update-branch when the failed merge's base is no longer master", async () => {
		const unit = UNIT_FAIL();
		const w = world({
			prs: [{ number: 3688, checkRuns: [jobRow(unit), GREEN[1]] }],
			jobs: [unit],
			master: "b".repeat(40),
		});
		const { out } = await cli(["3688"], w);
		expect(out).toContain(
			`hint: master moved since this failure's merge base (${UNIT_FAIL_MERGE_BASE.slice(0, 9)} -> bbbbbbbbb): gh run rerun replays the old merge commit and cannot pick up what master gained -- use gh pr update-branch 3688`,
		);
	});

	// #3754 recurrence: the update-branch hint told the orchestrator to push to a
	// PR that a merge queue tests on the latest master anyway; the push re-runs
	// every check and ejects a queued PR.
	it("withdraws the update-branch hint when master has a merge queue", async () => {
		const unit = UNIT_FAIL();
		const w = world({
			prs: [{ number: 3688, checkRuns: [jobRow(unit), GREEN[1]] }],
			jobs: [unit],
			master: "b".repeat(40),
			mergeQueueEnabled: true,
		});
		const { out } = await cli(["3688"], w);
		expect(out).toContain(
			`hint: master moved since this failure's merge base (${UNIT_FAIL_MERGE_BASE.slice(0, 9)} -> bbbbbbbbb): the merge queue tests the PR on the latest master, so do not update-branch 3688`,
		);
		expect(out).not.toContain("use gh pr update-branch 3688");
	});

	// #3754: the queue read is optional; an unreadable one (`?.enabled` on null)
	// must keep the pre-queue update-branch hint instead of throwing the verdict
	// into a transport error.
	it("keeps the update-branch hint when the queue read is unreadable", async () => {
		const unit = UNIT_FAIL();
		const w = world({
			prs: [{ number: 3688, checkRuns: [jobRow(unit), GREEN[1]] }],
			jobs: [unit],
			master: "b".repeat(40),
			graphqlThrows: true,
		});
		const { exitCode, out } = await cli(["3688"], w);
		expect(exitCode).toBe(EXIT_FAILURE);
		expect(out).toContain("use gh pr update-branch 3688");
	});

	it("gives no update-branch hint when the merge base is still master's head", async () => {
		const unit = UNIT_FAIL();
		const w = world({
			prs: [{ number: 3688, checkRuns: [jobRow(unit), GREEN[1]] }],
			jobs: [unit],
			master: UNIT_FAIL_MERGE_BASE,
		});
		const { exitCode, out } = await cli(["3688"], w);
		expect(exitCode).toBe(EXIT_FAILURE);
		expect(out).not.toContain("update-branch");
	});

	it("gives no update-branch hint when master's head cannot be read", async () => {
		const unit = UNIT_FAIL();
		const w = world({
			prs: [{ number: 3688, checkRuns: [jobRow(unit), GREEN[1]] }],
			jobs: [unit],
			master: null,
		});
		const { exitCode, out } = await cli(["3688"], w);
		expect(exitCode).toBe(EXIT_FAILURE);
		expect(out).not.toContain("update-branch");
	});

	it("gives no update-branch hint for a bare-SHA target (no PR to update)", async () => {
		const unit = UNIT_FAIL();
		const w = world({
			prs: [{ number: 3688, checkRuns: [jobRow(unit), GREEN[1]] }],
			jobs: [unit],
			master: "b".repeat(40),
		});
		const { exitCode, out } = await cli([shaOf(3688)], w);
		expect(exitCode).toBe(EXIT_FAILURE);
		expect(out).not.toContain("update-branch");
	});

	// Confirmed and pinned (2026-09-30, "superseded run cancelled and not
	// replaced"): the exact rerun command, from the recorded #3382 check-runs.
	it("prints the exact gh run rerun command for a cancelled run that was not replaced", async () => {
		const cancelled = JSON.parse(
			readFileSync(join(FIXTURES, "ci-verdict/pr-3382-cancelled.json"), "utf8"),
		);
		const w = world({
			prs: [
				{
					number: 3382,
					sha: cancelled.source.head,
					checkRuns: [
						row("Unit tests", "success", 11),
						...cancelled.check_runs,
					],
				},
			],
		});
		const { exitCode, reason } = await cli(["3382"], w);
		expect(exitCode).toBe(EXIT_PENDING);
		expect(reason).toBe(
			"superseded run cancelled and not replaced: rerun 36022234159 (gh run rerun 36022234159)",
		);
	});
});

describe("run — post-merge noise is not a failure (#3700)", () => {
	// Recurrence: a PR's checkout job re-run after the merge cannot fetch
	// `refs/pull/N/merge` (the ref is gone); the red row was read as a real one.
	const noisy = () => {
		const j = POST_MERGE();
		return { j, rows: [...GREEN, jobRow(j)] };
	};

	it("reports a checkout that could not fetch refs/pull/N/merge on a MERGED PR as noise, exit 0", async () => {
		const { j, rows } = noisy();
		const w = world({
			prs: [{ number: 2623, state: "MERGED", checkRuns: rows }],
			jobs: [j],
		});
		const { exitCode, out, reason } = await cli(["2623"], w);
		expect(exitCode).toBe(EXIT_SUCCESS);
		expect(reason).toContain("post-merge noise, not a failure");
		expect(reason).toContain("Install test (macos-latest)");
		expect(out).toContain("Gating: 3 checks, 0 failing");
	});

	it("keeps the same red a FAILURE while the PR is open (there it means a conflicted PR)", async () => {
		const { j, rows } = noisy();
		const w = world({
			prs: [{ number: 2623, state: "OPEN", checkRuns: rows }],
			jobs: [j],
		});
		const { exitCode, reason } = await cli(["2623"], w);
		expect(exitCode).toBe(EXIT_FAILURE);
		expect(reason).toContain("Install test (macos-latest) (failure)");
	});

	it("keeps it a failure when the PR state cannot be read", async () => {
		const { j, rows } = noisy();
		const w = world({
			prs: [{ number: 2623, state: "MERGED", checkRuns: rows }],
			jobs: [j],
			prStateThrows: true,
		});
		const { exitCode } = await cli(["2623"], w);
		expect(exitCode).toBe(EXIT_FAILURE);
	});

	// Recurrence (review r1, F1): the excuse fired on ANY log line quoting the
	// ref text, so a MERGED PR whose Unit tests really failed (and whose output
	// happens to contain the text) read as exit 0 "post-merge noise".
	it("keeps a MERGED PR's real test failure a failure when the same log also quotes the missing merge ref", async () => {
		const unit = job(
			"unit-tests-fail-101554674114",
			`${readFileSync(join(JOBS, "unit-tests-fail-101554674114.log"), "utf8")}\n2026-09-06T20:44:10.0300000Z fatal: couldn't find remote ref refs/pull/5/merge\n`,
		);
		const w = world({
			prs: [
				{
					number: 5,
					state: "MERGED",
					checkRuns: [jobRow(unit), GREEN[1]],
				},
			],
			jobs: [unit],
		});
		const { exitCode, out, reason } = await cli(["5"], w);
		expect(exitCode).toBe(EXIT_FAILURE);
		expect(reason).not.toContain("post-merge noise");
		expect(out).toContain("Gating: 2 checks, 1 failing: Unit tests (failure)");
	});

	it("keeps it a failure when the ref that could not be fetched is another PR's", async () => {
		const { j, rows } = noisy();
		const w = world({
			prs: [{ number: 2624, state: "MERGED", checkRuns: rows }],
			jobs: [j],
		});
		const { exitCode } = await cli(["2624"], w);
		expect(exitCode).toBe(EXIT_FAILURE);
	});

	it("keeps it a failure when the failed step is not the checkout", async () => {
		const lint = job(
			"lint-install-fail-101496353689",
			readFileSync(
				join(JOBS, "checkout-fail-post-merge-101528749222.log"),
				"utf8",
			),
		);
		const w = world({
			prs: [
				{
					number: 2623,
					state: "MERGED",
					checkRuns: [GREEN[0], jobRow(lint)],
				},
			],
			jobs: [lint],
		});
		const { exitCode } = await cli(["2623"], w);
		expect(exitCode).toBe(EXIT_FAILURE);
	});

	it("keeps it a failure when the checkout step failed but the log also carries failing test lines", async () => {
		const mixed = job(
			"checkout-fail-post-merge-101528749222",
			`${readFileSync(join(JOBS, "checkout-fail-post-merge-101528749222.log"), "utf8")}\n2026-09-06T17:32:37.0000000Z  FAIL   default  tests/x.test.ts > real bug\n`,
		);
		const w = world({
			prs: [
				{
					number: 2623,
					state: "MERGED",
					checkRuns: [...GREEN, jobRow(mixed)],
				},
			],
			jobs: [mixed],
		});
		const { exitCode } = await cli(["2623"], w);
		expect(exitCode).toBe(EXIT_FAILURE);
	});

	it("keeps it a failure when the job names no failed step at all", async () => {
		const { j, rows } = noisy();
		const bare = { ...j, json: { ...j.json, steps: [] } };
		const w = world({
			prs: [{ number: 2623, state: "MERGED", checkRuns: rows }],
			jobs: [bare],
		});
		const { exitCode } = await cli(["2623"], w);
		expect(exitCode).toBe(EXIT_FAILURE);
	});

	it("drops only the noise row when a real failure sits beside it", async () => {
		const { j } = noisy();
		const unit = UNIT_FAIL();
		const w = world({
			prs: [
				{
					number: 2623,
					state: "MERGED",
					checkRuns: [jobRow(unit), GREEN[1], jobRow(j)],
				},
			],
			jobs: [j, unit],
		});
		const { exitCode, lines } = await cli(["2623"], w);
		expect(exitCode).toBe(EXIT_FAILURE);
		expect(lines).toContain(
			"Gating: 3 checks, 1 failing: Unit tests (failure)",
		);
	});

	it("does not turn a still-running check into a pass when noise is dropped", async () => {
		const { j } = noisy();
		const w = world({
			prs: [
				{
					number: 2623,
					state: "MERGED",
					checkRuns: [
						row("Unit tests", null, 11, undefined, "in_progress"),
						GREEN[1],
						jobRow(j),
					],
				},
			],
			jobs: [j],
		});
		const { exitCode } = await cli(["2623"], w);
		expect(exitCode).toBe(EXIT_PENDING);
	});
});

describe("run --all — one line per open PR (#3700)", () => {
	it("prints author, auto-merge, head, state and the first failing check for every open PR", async () => {
		const unit = UNIT_FAIL();
		const w = world({
			prs: [
				{
					number: 10,
					login: "apmantza",
					autoMerge: true,
					checkRuns: [jobRow(unit), GREEN[1]],
				},
				{ number: 11, login: "stranger", checkRuns: GREEN },
				{ number: 12, login: "stranger", checkRuns: [], workflowRuns: [] },
				{ number: 13, login: "stranger", headReadThrows: true },
				{ number: 14, login: "stranger", state: "MERGED" },
				{
					number: 15,
					login: "stranger",
					checkRuns: [GREEN[0], row("Lint & type-check", "cancelled", 12)],
				},
				{
					number: 16,
					login: "stranger",
					mergeable: "CONFLICTING",
					checkRuns: GREEN,
				},
			],
			jobs: [unit],
		});
		const { exitCode, kind, lines } = await cli(["--all"], w);
		expect(exitCode).toBe(EXIT_SUCCESS);
		// F4: `--all` is a snapshot, not a green verdict.
		expect(kind).toBe("all");
		expect(lines).toEqual([
			`#10 apmantza auto-merge=on head=${sha9(10)} gating=failed first-failure=Unit tests`,
			`#11 stranger auto-merge=off head=${sha9(11)} gating=success`,
			`#12 stranger auto-merge=off head=${sha9(12)} gating=pending`,
			`#13 stranger auto-merge=off head=${sha9(13)} gating=unreadable`,
			`#15 stranger auto-merge=off head=${sha9(15)} gating=cancelled`,
			`#16 stranger auto-merge=off head=${sha9(16)} gating=dirty`,
		]);
	});
});

describe("run --watch-open — every PR the maintainer or orchestrator owns (#3700)", () => {
	let dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
		dirs = [];
	});
	const stateFile = () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lens-ci-verdict-watch-"));
		dirs.push(dir);
		return join(dir, "state.json");
	};
	const failedRuns = () => {
		const unit = UNIT_FAIL();
		return { unit, runs: [jobRow(unit), GREEN[1]] };
	};

	// Recurrence: #3688 sat red in a fix round (no auto-merge armed) and the
	// watcher, which listed auto-merge PRs only, said nothing.
	it("reports a red PR of the maintainer that has no auto-merge, as `#<pr> <event> @<sha>: <reason>` plus the failure detail", async () => {
		const { unit, runs } = failedRuns();
		const w = world({
			prs: [{ number: 3688, login: "apmantza", checkRuns: runs }],
			jobs: [unit],
		});
		const { exitCode, kind, lines } = await cli(["--watch-open"], w);
		expect(exitCode).toBe(EXIT_SUCCESS);
		expect(kind).toBe("watch");
		expect(lines[0]).toBe(
			`#3688 failed @${sha9(3688)}: gating check(s) completed with a non-success conclusion: Unit tests (failure)`,
		);
		expect(lines).toContain(
			"  Unit tests (job 101554674114): failed step: Run tests",
		);
		expect(lines.some((line) => line.startsWith("    Tests  1 failed"))).toBe(
			true,
		);
	});

	it("does not watch a stranger's PR without auto-merge, and never reads it", async () => {
		const { unit, runs } = failedRuns();
		const w = world({
			prs: [{ number: 40, login: "stranger", checkRuns: runs }],
			jobs: [unit],
		});
		const { exitCode, out } = await cli(["--watch-open", "--wait", "0"], w);
		expect(exitCode).toBe(EXIT_PENDING);
		expect(out).toBe("watch window elapsed with no event");
		expect(w.calls.some((call) => call.startsWith("pr view 40"))).toBe(false);
	});

	it("watches a stranger's PR once auto-merge is armed", async () => {
		const { unit, runs } = failedRuns();
		const w = world({
			prs: [
				{ number: 40, login: "stranger", autoMerge: true, checkRuns: runs },
			],
			jobs: [unit],
		});
		const { exitCode, lines } = await cli(["--watch-open"], w);
		expect(exitCode).toBe(EXIT_SUCCESS);
		expect(lines[0]).toContain("#40 failed");
	});

	it("watches a PR authored by the gh viewer (the orchestrator account)", async () => {
		const { unit, runs } = failedRuns();
		const w = world({
			prs: [{ number: 41, login: "orchestrator-bot", checkRuns: runs }],
			jobs: [unit],
			viewer: "orchestrator-bot",
		});
		const { lines } = await cli(["--watch-open"], w);
		expect(lines[0]).toContain("#41 failed");
	});

	it("reports a PR that turns red between polls on that transition, not before", async () => {
		const { unit, runs } = failedRuns();
		const pr: PrFixture = {
			number: 3688,
			login: "apmantza",
			checkRuns: [
				row("Unit tests", null, 11, undefined, "in_progress"),
				GREEN[1],
			],
		};
		const w = world({ prs: [pr], jobs: [unit] });
		const { exitCode, lines, sleeps } = await cli(["--watch-open"], w, {
			onSleep: () => {
				pr.checkRuns = runs;
			},
		});
		expect(exitCode).toBe(EXIT_SUCCESS);
		expect(sleeps).toEqual([WATCH_POLL_INTERVAL_SECONDS * 1000]);
		expect(lines[0]).toContain("#3688 failed");
	});

	it("does not report the same failure on the same head again after a re-arm (state file)", async () => {
		const { unit, runs } = failedRuns();
		const file = stateFile();
		const w = world({
			prs: [{ number: 3688, login: "apmantza", checkRuns: runs }],
			jobs: [unit],
		});
		const first = await cli(["--watch-open", "--state-file", file], w);
		expect(first.lines[0]).toContain("#3688 failed");
		expect(savedKeys(file)).toEqual({
			"3688": `${shaOf(3688)}:failed`,
		});
		const second = await cli(
			["--watch-open", "--wait", "0", "--state-file", file],
			w,
		);
		expect(second.exitCode).toBe(EXIT_PENDING);
		expect(second.out).toBe("watch window elapsed with no event");
	});

	it("reports the failure again for a new head, and again after a rerun passes through pending", async () => {
		const { unit, runs } = failedRuns();
		const file = stateFile();
		writeFileSync(file, JSON.stringify({ "3688": `${"c".repeat(40)}:failed` }));
		const pr: PrFixture = { number: 3688, login: "apmantza", checkRuns: runs };
		const w = world({ prs: [pr], jobs: [unit] });
		// New head (aaaa... vs the recorded cccc...) with the same kind: an event.
		const newHead = await cli(["--watch-open", "--state-file", file], w);
		expect(newHead.lines[0]).toContain("#3688 failed");
		// Same head, failed -> pending (a rerun) -> failed: the return is an event.
		pr.checkRuns = [row("Unit tests", null, 11, undefined, "queued"), GREEN[1]];
		const again = await cli(["--watch-open", "--state-file", file], w, {
			onSleep: () => {
				pr.checkRuns = runs;
			},
		});
		expect(again.exitCode).toBe(EXIT_SUCCESS);
		expect(again.sleeps).toHaveLength(1);
		expect(again.lines[0]).toContain("#3688 failed");
	});

	it("reports a merged and a closed PR once, and forgets one that merely left the watch set", async () => {
		const file = stateFile();
		writeFileSync(
			file,
			JSON.stringify({
				"7": `${shaOf(7)}:pending`,
				"8": `${shaOf(8)}:pending`,
				"9": `${shaOf(9)}:pending`,
			}),
		);
		const w = world({
			prs: [
				{ number: 7, state: "MERGED" },
				{ number: 8, state: "CLOSED" },
				{ number: 9, login: "stranger", checkRuns: GREEN },
			],
		});
		const { exitCode, lines } = await cli(
			["--watch-open", "--state-file", file],
			w,
		);
		expect(exitCode).toBe(EXIT_SUCCESS);
		expect(lines).toEqual(["#7 merged", "#8 closed"]);
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({});
	});

	// Recurrence (#3697 F2): a stale action_required run must never pin a green
	// head at pending, and must not raise an approval event on one.
	it("raises no event for a green head that still lists stale action_required runs", async () => {
		const w = world({
			prs: [
				{
					number: 3443,
					login: "apmantza",
					checkRuns: GREEN,
					workflowRuns: [
						{
							id: 36566476498,
							name: "CI",
							head_sha: shaOf(3443),
							status: "completed",
							conclusion: "action_required",
						},
					],
				},
			],
		});
		const { exitCode, out } = await cli(["--watch-open", "--wait", "0"], w);
		expect(exitCode).toBe(EXIT_PENDING);
		expect(out).toBe("watch window elapsed with no event");
	});

	it("reports fork approval awaited, with the approve command", async () => {
		const w = world({
			prs: [
				{
					number: 3443,
					login: "stranger",
					autoMerge: true,
					checkRuns: [],
					workflowRuns: [
						{
							id: 36566476498,
							name: "CI",
							head_sha: shaOf(3443),
							status: "completed",
							conclusion: "action_required",
						},
					],
				},
			],
		});
		const { lines } = await cli(["--watch-open"], w);
		expect(lines[0]).toBe(
			`#3443 fork-approval @${sha9(3443)}: awaiting fork approval (maintainer decision, never automatic): gh api -X POST repos/apmantza/pi-lens/actions/runs/36566476498/approve`,
		);
	});

	it("reports required checks absent past the threshold on an armed PR, and not before it", async () => {
		const pr: PrFixture = {
			number: 3679,
			login: "stranger",
			autoMerge: true,
			checkRuns: [],
			workflowRuns: [],
			suites: [{ created_at: minutesBefore(45) }],
		};
		const old = await cli(["--watch-open"], world({ prs: [pr] }));
		expect(old.lines[0]).toBe(
			`#3679 absent-rearm @${sha9(3679)}: ${formatAbsentRequiredReason(shaOf(3679), 45)}`,
		);
		pr.suites = [{ created_at: minutesBefore(2) }];
		const fresh = await cli(
			["--watch-open", "--wait", "0"],
			world({ prs: [pr] }),
		);
		expect(fresh.exitCode).toBe(EXIT_PENDING);
		expect(fresh.out).toBe("watch window elapsed with no event");
	});

	it("keeps polling every 90 s until the window ends, then says nothing happened", async () => {
		const w = world({
			prs: [{ number: 3688, login: "apmantza", checkRuns: GREEN }],
		});
		const { exitCode, out, sleeps } = await cli(
			["--watch-open", "--wait", "300"],
			w,
		);
		expect(exitCode).toBe(EXIT_PENDING);
		expect(out).toBe("watch window elapsed with no event");
		expect(sleeps).toEqual([90_000, 90_000, 90_000, 30_000]);
	});

	it("skips a PR whose read failed instead of dying or inventing an event", async () => {
		const w = world({
			prs: [
				{ number: 50, login: "apmantza", headReadThrows: true },
				{ number: 51, login: "apmantza", checkRuns: GREEN },
			],
		});
		const { exitCode, out, errors } = await cli(
			["--watch-open", "--wait", "0"],
			w,
		);
		expect(exitCode).toBe(EXIT_PENDING);
		expect(out).toBe("watch window elapsed with no event");
		expect(errors.join("\n")).toContain("HTTP 404");
	});

	// Recurrence (#2935): two GitHub outages killed seven armed waits at once; a
	// watch armed for 20 minutes must ride out a 502 on its list read too.
	it("waits out a transient error on the open-PR list read instead of exiting 70", async () => {
		const { unit, runs } = failedRuns();
		const w = world({
			prs: [{ number: 3688, login: "apmantza", checkRuns: runs }],
			jobs: [unit],
			listTransientFailures: 1,
		});
		const { exitCode, lines, errors, sleeps } = await cli(["--watch-open"], w);
		expect(exitCode).toBe(EXIT_SUCCESS);
		expect(sleeps).toEqual([30_000]);
		expect(errors.join("\n")).toContain("transient gh error, retrying in 30s");
		expect(lines[0]).toContain("#3688 failed");
	});

	it("starts empty from a corrupt or non-object state file, and rewrites it as an object", async () => {
		const { unit, runs } = failedRuns();
		for (const content of ["not json", "null", '["3688"]']) {
			const file = stateFile();
			writeFileSync(file, content);
			const w = world({
				prs: [{ number: 3688, login: "apmantza", checkRuns: runs }],
				jobs: [unit],
			});
			const { exitCode, lines } = await cli(
				["--watch-open", "--state-file", file],
				w,
			);
			expect(exitCode).toBe(EXIT_SUCCESS);
			expect(lines[0]).toContain("#3688 failed");
			expect(savedKeys(file)).toEqual({
				"3688": `${shaOf(3688)}:failed`,
			});
		}
	});

	// Recurrence (review r1, F2): a merge-conflicted armed PR (its gates are
	// skipped, AGENTS.md shape 11) sat silent for the whole window.
	it("reports a merge-conflicted armed PR once per head", async () => {
		const file = stateFile();
		const w = world({
			prs: [
				{
					number: 6,
					login: "stranger",
					autoMerge: true,
					mergeable: "CONFLICTING",
					checkRuns: [],
				},
			],
		});
		const first = await cli(["--watch-open", "--state-file", file], w);
		expect(first.exitCode).toBe(EXIT_SUCCESS);
		expect(first.lines[0]).toContain(
			`#6 dirty @${sha9(6)}: one or more required checks are absent and the PR is merge-conflicted (mergeable=CONFLICTING)`,
		);
		const again = await cli(
			["--watch-open", "--wait", "0", "--state-file", file],
			w,
		);
		expect(again.exitCode).toBe(EXIT_PENDING);
	});

	it("reaches absent-rearm for an armed PR whose head has no check suite, measured from when the watch first saw it", async () => {
		const w = world({
			prs: [
				{
					number: 3679,
					login: "stranger",
					autoMerge: true,
					checkRuns: [],
					workflowRuns: [],
					suites: [],
				},
			],
		});
		const { exitCode, lines, sleeps } = await cli(
			["--watch-open", "--wait", "900"],
			w,
		);
		expect(exitCode).toBe(EXIT_SUCCESS);
		expect(lines[0]).toBe(
			`#3679 absent-rearm @${sha9(3679)}: ${formatAbsentRequiredReason(shaOf(3679), 10)}`,
		);
		// 7 sleeps of 90 s = 630 s: the first poll at which 10 whole minutes passed.
		expect(sleeps).toHaveLength(7);
	});

	it("restarts the no-suite clock for a new head of the same PR", async () => {
		const pr: PrFixture = {
			number: 3679,
			login: "stranger",
			autoMerge: true,
			checkRuns: [],
			workflowRuns: [],
			suites: [],
		};
		const w = world({ prs: [pr] });
		const newSha = "b".repeat(40);
		const { lines, sleeps } = await cli(["--watch-open", "--wait", "1200"], w, {
			onSleep: (index) => {
				if (index === 2) pr.sha = newSha;
			},
		});
		// First head seen at 0 s, the new one at 180 s: 10 minutes later is 780 s
		// -> the first 90 s poll at or after it is 810 s = 9 sleeps.
		expect(sleeps).toHaveLength(9);
		expect(lines[0]).toContain(`@${newSha.slice(0, 9)}`);
	});

	it("reaches the re-arm text under --wait for a head with no check suite, and stays quiet on a one-shot read", async () => {
		const pr: PrFixture = {
			number: 3679,
			autoMerge: true,
			checkRuns: [],
			workflowRuns: [],
			suites: [],
		};
		const waited = await cli(["3679", "--wait", "1200"], world({ prs: [pr] }));
		expect(waited.reason).toBe(formatAbsentRequiredReason(shaOf(3679), 20));
		const once = await cli(["3679"], world({ prs: [pr] }));
		expect(once.reason).toContain("CI likely hasn't registered yet");
	});

	// Recurrence (review r1, F3): a truncated state file reads as empty, so
	// every PR reported again; a bad path lost the poll's own report.
	it("writes the state file atomically into a directory it creates", async () => {
		const { unit, runs } = failedRuns();
		const dir = join(dirname(stateFile()), "nested", "deeper");
		const file = join(dir, "state.json");
		const w = world({
			prs: [{ number: 3688, login: "apmantza", checkRuns: runs }],
			jobs: [unit],
		});
		await cli(["--watch-open", "--state-file", file], w);
		expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false);
		expect(savedKeys(file)).toEqual({
			"3688": `${shaOf(3688)}:failed`,
		});
	});

	it("replaces the state file rather than writing through it (a hard link keeps its old content)", async () => {
		const { unit, runs } = failedRuns();
		const file = stateFile();
		const other = `${file}.other`;
		writeFileSync(other, "keep");
		linkSync(other, file);
		const w = world({
			prs: [{ number: 3688, login: "apmantza", checkRuns: runs }],
			jobs: [unit],
		});
		await cli(["--watch-open", "--state-file", file], w);
		expect(readFileSync(other, "utf8")).toBe("keep");
		expect(savedKeys(file)).toEqual({
			"3688": `${shaOf(3688)}:failed`,
		});
	});

	it("prints the events before it persists the state, and keeps them when the state cannot be saved", async () => {
		const { unit, runs } = failedRuns();
		const w = world({
			prs: [{ number: 3688, login: "apmantza", checkRuns: runs }],
			jobs: [unit],
		});
		const file = stateFile();
		const seenOnFirstLine: boolean[] = [];
		const time = clock();
		const errors: string[] = [];
		const { code: exitCode } = await run({
			argv: ["--watch-open", "--state-file", file],
			ghExec: ghFor(w),
			now: time.now,
			sleepImpl: time.sleepImpl,
			stdout: () => seenOnFirstLine.push(existsSync(file)),
			stderr: (line: string) => errors.push(line),
		});
		expect(exitCode).toBe(EXIT_SUCCESS);
		expect(seenOnFirstLine.length).toBeGreaterThan(0);
		expect(seenOnFirstLine.every((exists) => !exists)).toBe(true);
		expect(existsSync(file)).toBe(true);
		// A path whose parent is a regular file cannot be written at all.
		const bad = await cli(
			["--watch-open", "--state-file", join(file, "x.json")],
			w,
		);
		expect(bad.exitCode).toBe(EXIT_SUCCESS);
		expect(bad.lines[0]).toContain("#3688 failed");
		expect(bad.errors.join("\n")).toContain("could not save the watch state");
	});

	it("exits 70, not a verdict code, when the open-PR list cannot be read", async () => {
		const w = world({ prs: [], listThrows: true });
		const { exitCode, kind, errors } = await cli(["--watch-open"], w);
		expect(exitCode).toBe(EXIT_TRANSPORT);
		// F4: a watch-mode transport failure names transport, not `(watch)`.
		expect(kind).toBe("transport");
		expect(errors.join("\n")).toContain("HTTP 404");
	});
});

describe("run --wait — the head's push time and auto-merge are re-read (#3700, the #3697 round-3 verify)", () => {
	// Recurrence: probed `--wait 1200` with no check suite on poll 1: the whole
	// window stayed on the quiet text because the push time was cached once.
	const absent = { checkRuns: [], workflowRuns: [] };
	const reArm = formatAbsentRequiredReason(shaOf(3679), 45);
	const suiteCalls = (w: World) =>
		w.calls.filter((call) => call.includes("/check-suites")).length;

	it("re-reads the check suites while none exists, so a suite that appears later arms the message", async () => {
		const pr: PrFixture = {
			number: 3679,
			autoMerge: true,
			...absent,
			suites: [],
		};
		const w = world({ prs: [pr] });
		const { exitCode, reason } = await cli(["3679", "--wait", "30"], w, {
			onSleep: () => {
				pr.suites = [{ created_at: minutesBefore(45) }];
			},
		});
		expect(exitCode).toBe(EXIT_PENDING);
		expect(reason).toBe(reArm);
	});

	it("re-reads the auto-merge state every poll, so arming mid-wait changes the message", async () => {
		const pr: PrFixture = {
			number: 3679,
			autoMerge: false,
			...absent,
			suites: [{ created_at: minutesBefore(45) }],
		};
		const w = world({ prs: [pr] });
		const { reason } = await cli(["3679", "--wait", "30"], w, {
			onSleep: () => {
				pr.autoMerge = true;
			},
		});
		expect(reason).toBe(reArm);
	});

	it("reads the check suites once the push time is known, not every poll", async () => {
		const pr: PrFixture = {
			number: 3679,
			autoMerge: true,
			...absent,
			suites: [{ created_at: minutesBefore(45) }],
		};
		const w = world({ prs: [pr] });
		const { sleeps } = await cli(["3679", "--wait", "120"], w);
		expect(sleeps.length).toBeGreaterThanOrEqual(3);
		expect(suiteCalls(w)).toBe(1);
	});

	it("keeps re-reading while the suites stay empty or unreadable", async () => {
		for (const suites of [[], null]) {
			const w = world({
				prs: [{ number: 3679, autoMerge: true, ...absent, suites }],
			});
			const { sleeps } = await cli(["3679", "--wait", "120"], w);
			expect(suiteCalls(w)).toBe(sleeps.length + 1);
		}
	});
});

// ---------------------------------------------------------------------------
// #3722: `--watch-open --stream`, `--rerun-cancelled`, `--approve-fork`,
// `--sync-main`, and the #3726 round-2 residuals. Same double, same `run()`.
// ---------------------------------------------------------------------------

/** A main checkout answering the git commands `--sync-main` issues, and
 * faithful on the axes under test: `status` lists an untracked file unless it
 * is asked with `--untracked-files=no`, and `pull --ff-only` can refuse. */
interface Checkout {
	branch: string;
	dirtyTracked?: boolean;
	untracked?: boolean;
	head: string;
	remoteHead: string;
	lockChanged?: boolean;
	pullFails?: boolean;
	/** commits on the checkout that origin does not have. */
	ahead?: number;
	pullStderr?: string;
	commands: string[];
}
function gitFor(checkout: Checkout) {
	return (bin: string, args: string[]) => {
		const [, , ...rest] = args;
		checkout.commands.push(`${bin} ${rest.join(" ")}`);
		if (bin !== "git") throw new Error(`unexpected binary ${bin}`);
		if (rest.join(" ") === "rev-parse --abbrev-ref HEAD")
			return `${checkout.branch}\n`;
		if (rest.join(" ") === "rev-parse HEAD") return `${checkout.head}\n`;
		if (rest[0] === "status") {
			const lines = [];
			if (checkout.dirtyTracked) lines.push(" M package.json");
			if (checkout.untracked && !rest.includes("--untracked-files=no"))
				lines.push("?? .vitest/");
			return lines.join("\n");
		}
		if (rest.join(" ") === "pull --ff-only") {
			if (checkout.pullFails)
				throw Object.assign(new Error("git failed"), {
					stderr:
						checkout.pullStderr ??
						"From /path/origin\n * branch            master     -> FETCH_HEAD\nhint: Diverging branches can't be fast-forwarded.\nfatal: Not possible to fast-forward, aborting.\n",
				});
			checkout.head = checkout.remoteHead;
			return "";
		}
		if (rest.join(" ") === "rev-list --count origin/master..HEAD")
			return `${checkout.ahead ?? 0}\n`;
		if (rest[0] === "diff")
			return checkout.lockChanged ? "package-lock.json\n" : "";
		throw new Error(`unmocked git call: ${rest.join(" ")}`);
	};
}
const OLD_HEAD = "1".repeat(40);
const NEW_HEAD = "2".repeat(40);
const checkoutAt = (extra: Partial<Checkout> = {}): Checkout => ({
	branch: "master",
	head: OLD_HEAD,
	remoteHead: NEW_HEAD,
	commands: [],
	...extra,
});

describe("run --watch-open --stream — one line per event, until the window ends (#3722)", () => {
	let dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
		dirs = [];
	});
	const stateFile = () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lens-ci-verdict-stream-"));
		dirs.push(dir);
		return join(dir, "state.json");
	};
	const failedRuns = () => {
		const unit = UNIT_FAIL();
		return { unit, runs: [jobRow(unit), GREEN[1]] };
	};
	const cancelled = JSON.parse(
		readFileSync(join(FIXTURES, "ci-verdict/pr-3382-cancelled.json"), "utf8"),
	);
	const cancelledRuns = [GREEN[0], ...cancelled.check_runs];

	it("keeps running after an event, prints it as `FAIL #<pr>@<sha>` with the test names, and reports the head once", async () => {
		const { unit, runs } = failedRuns();
		const w = world({
			prs: [{ number: 3688, login: "apmantza", checkRuns: runs }],
			jobs: [unit],
		});
		const { exitCode, kind, lines, sleeps } = await cli(
			["--watch-open", "--stream", "--wait", "300"],
			w,
		);
		expect(exitCode).toBe(EXIT_SUCCESS);
		expect(kind).toBe("stream");
		expect(sleeps).toEqual([90_000, 90_000, 90_000, 30_000]);
		expect(lines[0]).toBe(
			`FAIL #3688@${sha9(3688)}: gating check(s) completed with a non-success conclusion: Unit tests (failure)`,
		);
		expect(lines).toContain(
			"  Unit tests (job 101554674114): failed step: Run tests",
		);
		expect(lines.filter((line) => line.startsWith("FAIL #3688"))).toHaveLength(
			1,
		);
	});

	it("reports a new head of the same PR again while it streams", async () => {
		const { unit, runs } = failedRuns();
		const pr: PrFixture = { number: 3688, login: "apmantza", checkRuns: runs };
		const w = world({ prs: [pr], jobs: [unit] });
		const newSha = "b".repeat(40);
		const { lines } = await cli(
			["--watch-open", "--stream", "--wait", "300"],
			w,
			{
				onSleep: (index) => {
					if (index === 1) pr.sha = newSha;
				},
			},
		);
		const fails = lines.filter((line) => line.startsWith("FAIL #3688"));
		expect(fails).toHaveLength(2);
		expect(fails[1]).toContain(`@${newSha.slice(0, 9)}`);
	});

	it("exits 3 with the plain window message when nothing happened", async () => {
		const w = world({
			prs: [{ number: 3688, login: "apmantza", checkRuns: GREEN }],
		});
		const { exitCode, out } = await cli(
			["--watch-open", "--stream", "--wait", "0"],
			w,
		);
		expect(exitCode).toBe(EXIT_PENDING);
		expect(out).toBe("watch window elapsed with no event");
	});

	it("prints DIRTY for a merge-conflicted PR", async () => {
		const w = world({
			prs: [
				{
					number: 6,
					login: "apmantza",
					mergeable: "CONFLICTING",
					checkRuns: GREEN,
				},
			],
		});
		const { lines } = await cli(["--watch-open", "--stream", "--wait", "0"], w);
		expect(lines[0]).toContain(
			`DIRTY #6@${sha9(6)}: the PR is merge-conflicted`,
		);
	});

	// Recurrence (#3726 verify): GitHub answers UNKNOWN while it recomputes
	// mergeability, which read as pending and re-armed the same head's report.
	it("does not report a head dirty again when mergeability flaps CONFLICTING -> UNKNOWN -> CONFLICTING", async () => {
		const pr: PrFixture = {
			number: 6,
			login: "apmantza",
			mergeable: "CONFLICTING",
			checkRuns: GREEN,
		};
		const w = world({ prs: [pr] });
		const { lines } = await cli(
			["--watch-open", "--stream", "--wait", "270"],
			w,
			{
				onSleep: (index) => {
					pr.mergeable = index === 1 ? "UNKNOWN" : "CONFLICTING";
				},
			},
		);
		expect(lines.filter((line) => line.startsWith("DIRTY #6"))).toHaveLength(1);
	});

	it("still reports a real failure on a head that is UNKNOWN after being dirty", async () => {
		const { unit, runs } = failedRuns();
		const pr: PrFixture = {
			number: 6,
			login: "apmantza",
			mergeable: "CONFLICTING",
			checkRuns: GREEN,
		};
		const w = world({ prs: [pr], jobs: [unit] });
		const { lines } = await cli(
			["--watch-open", "--stream", "--wait", "100"],
			w,
			{
				onSleep: () => {
					pr.mergeable = "UNKNOWN";
					pr.checkRuns = runs;
				},
			},
		);
		expect(lines.some((line) => line.startsWith("FAIL #6"))).toBe(true);
	});

	it("prints CANCELLED-NOT-REPLACED with the exact rerun command, and re-runs nothing without --rerun-cancelled", async () => {
		const w = world({
			prs: [
				{
					number: 3382,
					login: "apmantza",
					sha: cancelled.source.head,
					checkRuns: cancelledRuns,
				},
			],
		});
		const { lines } = await cli(["--watch-open", "--stream", "--wait", "0"], w);
		expect(lines[0]).toBe(
			`CANCELLED-NOT-REPLACED #3382@${cancelled.source.head.slice(0, 9)}: superseded run cancelled and not replaced: rerun 36022234159 (gh run rerun 36022234159)`,
		);
		expect(w.mutations).toEqual([]);
	});

	it("deduplicates one CANCELLED-NOT-REPLACED hint per Actions run", async () => {
		const run = "https://github.com/apmantza/pi-lens/actions/runs/500";
		const w = world({
			prs: [
				{
					number: 3382,
					login: "apmantza",
					sha: cancelled.source.head,
					checkRuns: [
						GREEN[0],
						row("Unit tests", "cancelled", 11, `${run}/job/11`),
						row("Lint & type-check", "cancelled", 12, `${run}/job/12`),
					],
				},
			],
		});
		const { lines } = await cli(["--watch-open", "--stream", "--wait", "0"], w);
		expect(lines).toEqual([
			`CANCELLED-NOT-REPLACED #3382@${cancelled.source.head.slice(0, 9)}: superseded run cancelled and not replaced: rerun 500 (gh run rerun 500)`,
		]);
	});

	it("--rerun-cancelled re-runs the cancelled run itself, once per head", async () => {
		const pr: PrFixture = {
			number: 3382,
			login: "apmantza",
			sha: cancelled.source.head,
			checkRuns: cancelledRuns,
		};
		const w = world({ prs: [pr] });
		const { lines } = await cli(
			[
				"--watch-open",
				"--stream",
				"--rerun-cancelled",
				"--state-file",
				stateFile(),
				"--wait",
				"270",
			],
			w,
			{
				onSleep: (index) => {
					// queued after the re-run, then cancelled again on the same head
					pr.checkRuns =
						index === 1
							? [
									GREEN[0],
									row("Lint & type-check", null, 12, undefined, "queued"),
								]
							: cancelledRuns;
				},
			},
		);
		expect(w.mutations).toEqual(["run rerun 36022234159"]);
		expect(lines).toContain(
			`RERUN #3382@${cancelled.source.head.slice(0, 9)}: gh run rerun 36022234159`,
		);
		// The second cancellation of the same head is reported but not re-run.
		expect(
			lines.filter((line) => line.startsWith("CANCELLED-NOT-REPLACED")),
		).toHaveLength(2);
	});

	// Recurrence (review r1, F1): the re-run sat inside the transition gate, so a
	// refusal on a head that STAYS cancelled was attempted once and never again.
	it("--rerun-cancelled retries a refused re-run on a steady cancelled head, with a backoff", async () => {
		const pr: PrFixture = {
			number: 3382,
			login: "apmantza",
			sha: cancelled.source.head,
			checkRuns: cancelledRuns,
		};
		const w = world({ prs: [pr], rerunThrows: true });
		const { lines, sleeps } = await cli(
			[
				"--watch-open",
				"--stream",
				"--rerun-cancelled",
				"--state-file",
				stateFile(),
				"--wait",
				"360",
			],
			w,
			{
				onSleep: (index) => {
					// the refusal lifts after the first retry window opens
					if (index === 2) w.rerunThrows = false;
				},
			},
		);
		// 5 polls (0, 90, 180, 270, 360 s): attempts at 0 s and, after the 180 s
		// backoff, at 180 s -- not at every poll.
		expect(sleeps).toHaveLength(4);
		expect(w.mutations).toEqual([
			"run rerun 36022234159",
			"run rerun 36022234159",
		]);
		expect(
			lines.filter((line) => line.startsWith("RERUN FAILED")),
		).toHaveLength(1);
		expect(lines.filter((line) => line.startsWith("RERUN #3382"))).toHaveLength(
			1,
		);
	});

	it("--rerun-cancelled stops after three refused attempts on one head, backing off between them", async () => {
		const pr: PrFixture = {
			number: 3382,
			login: "apmantza",
			sha: cancelled.source.head,
			checkRuns: cancelledRuns,
		};
		const w = world({ prs: [pr], rerunThrows: true });
		const times: number[] = [];
		const file = stateFile();
		const gh = ghFor(w);
		const time = clock();
		await run({
			argv: [
				"--watch-open",
				"--stream",
				"--rerun-cancelled",
				"--state-file",
				file,
				"--wait",
				"1800",
			],
			ghExec: (args: string[], options?: { timeoutMs?: number }) => {
				if (args[0] === "run") times.push((time.now() - NOW) / 1000);
				return gh(args, options);
			},
			now: time.now,
			sleepImpl: time.sleepImpl,
			stdout: () => {},
			stderr: () => {},
		});
		// 0 s, then +180 s, then +360 s: three attempts, none after.
		expect(times).toEqual([0, 180, 540]);
		// A re-armed watch long after the last backoff (state file kept) is
		// still bound by the cap.
		const later = clock(undefined, NOW + 3 * 3600_000);
		await run({
			argv: [
				"--watch-open",
				"--stream",
				"--rerun-cancelled",
				"--state-file",
				file,
				"--wait",
				"600",
			],
			ghExec: gh,
			now: later.now,
			sleepImpl: later.sleepImpl,
			stdout: () => {},
			stderr: () => {},
		});
		expect(w.mutations).toHaveLength(3);
	});

	it("--rerun-cancelled starts a new head's attempts from zero", async () => {
		const pr: PrFixture = {
			number: 3382,
			login: "apmantza",
			sha: cancelled.source.head,
			checkRuns: cancelledRuns,
		};
		const w = world({ prs: [pr], rerunThrows: true });
		const newSha = "e".repeat(40);
		await cli(
			[
				"--watch-open",
				"--stream",
				"--rerun-cancelled",
				"--state-file",
				stateFile(),
				"--wait",
				"1800",
			],
			w,
			{
				onSleep: (index) => {
					// three attempts are spent by 540 s (poll 6); the head then moves
					if (index === 7) pr.sha = newSha;
				},
			},
		);
		// 3 on the first head + 3 on the second.
		expect(w.mutations).toHaveLength(6);
	});

	it("--rerun-cancelled keeps a successful re-run's mark across a re-armed watch", async () => {
		const file = stateFile();
		const pr: PrFixture = {
			number: 3382,
			login: "apmantza",
			sha: cancelled.source.head,
			checkRuns: cancelledRuns,
		};
		const w = world({ prs: [pr] });
		await cli(["--watch-open", "--rerun-cancelled", "--state-file", file], w);
		const again = await cli(
			[
				"--watch-open",
				"--rerun-cancelled",
				"--wait",
				"0",
				"--state-file",
				file,
			],
			w,
		);
		expect(again.exitCode).toBe(EXIT_PENDING);
		expect(w.mutations).toEqual(["run rerun 36022234159"]);
	});

	// Recurrence (review r1, F2): re-arming a watch with no state re-ran the same
	// cancelled head once per re-arm.
	it("--rerun-cancelled without --state-file is a usage error that reads and re-runs nothing", async () => {
		const w = world({
			prs: [
				{
					number: 3382,
					login: "apmantza",
					sha: cancelled.source.head,
					checkRuns: cancelledRuns,
				},
			],
		});
		for (const argv of [
			["--watch-open", "--rerun-cancelled"],
			["--watch-open", "--stream", "--rerun-cancelled", "--wait", "0"],
		]) {
			const { exitCode, kind, errors, lines } = await cli(argv, w);
			expect(exitCode).toBe(EXIT_USAGE);
			// F4: a watch-mode usage error names usage, not `(watch)`.
			expect(kind).toBe("usage");
			expect(errors.join("\n")).toContain(
				"--rerun-cancelled requires --state-file",
			);
			expect(lines).toEqual([]);
		}
		expect(w.calls).toEqual([]);
		expect(w.mutations).toEqual([]);
	});

	it("--rerun-cancelled keeps the head unmarked when the re-run is refused, so the next poll tries again", async () => {
		const pr: PrFixture = {
			number: 3382,
			login: "apmantza",
			sha: cancelled.source.head,
			checkRuns: cancelledRuns,
		};
		const w = world({ prs: [pr], rerunThrows: true });
		const { lines } = await cli(
			[
				"--watch-open",
				"--stream",
				"--rerun-cancelled",
				"--state-file",
				stateFile(),
				"--wait",
				"270",
			],
			w,
			{
				onSleep: (index) => {
					pr.checkRuns =
						index === 1
							? [
									GREEN[0],
									row("Lint & type-check", null, 12, undefined, "queued"),
								]
							: cancelledRuns;
					if (index === 2) w.rerunThrows = false;
				},
			},
		);
		expect(lines.some((line) => line.startsWith("RERUN FAILED #3382"))).toBe(
			true,
		);
		expect(w.mutations).toEqual([
			"run rerun 36022234159",
			"run rerun 36022234159",
		]);
	});

	it("--rerun-cancelled re-runs a run once even when two of its jobs were cancelled, and skips a check that is not an Actions job", async () => {
		const run = "https://github.com/apmantza/pi-lens/actions/runs/500";
		const w = world({
			prs: [
				{
					number: 3382,
					login: "apmantza",
					checkRuns: [
						row("Unit tests", "cancelled", 11, `${run}/job/11`),
						row("Lint & type-check", "cancelled", 12, `${run}/job/12`),
						row(
							"Vendor scan",
							"cancelled",
							77,
							"https://vendor.example/checks/77",
						),
					],
				},
			],
		});
		await cli(
			[
				"--watch-open",
				"--stream",
				"--rerun-cancelled",
				"--state-file",
				stateFile(),
				"--wait",
				"0",
			],
			w,
		);
		expect(w.mutations).toEqual(["run rerun 500"]);
	});

	it("prints MERGED with the closing issues' states, and a plain closed line for a closed PR", async () => {
		const file = stateFile();
		writeFileSync(
			file,
			JSON.stringify({
				"7": { key: `${shaOf(7)}:pending` },
				"8": { key: `${shaOf(8)}:pending` },
			}),
		);
		const w = world({
			prs: [
				{ number: 7, state: "MERGED" },
				{ number: 8, state: "CLOSED" },
			],
			closing: { 7: [3700, 3722] },
			issueStates: { 3700: "CLOSED", 3722: "OPEN" },
		});
		const { lines } = await cli(
			["--watch-open", "--stream", "--wait", "0", "--state-file", file],
			w,
		);
		expect(lines).toEqual([
			"MERGED #7",
			"  closes #3700: CLOSED",
			"  closes #3722: OPEN",
			"CLOSED #8",
		]);
	});

	it("never approves a fork run while watching, whatever the flags", async () => {
		const w = world({
			prs: [
				{
					number: 3443,
					login: "stranger",
					autoMerge: true,
					checkRuns: [],
					workflowRuns: [
						{
							id: 36566476498,
							name: "CI",
							head_sha: shaOf(3443),
							status: "completed",
							conclusion: "action_required",
						},
					],
				},
			],
		});
		const { lines } = await cli(
			[
				"--watch-open",
				"--stream",
				"--rerun-cancelled",
				"--state-file",
				stateFile(),
				"--wait",
				"0",
			],
			w,
		);
		expect(lines[0]).toContain("FORK-APPROVAL #3443");
		expect(w.mutations).toEqual([]);
	});
});

describe("run --approve-fork <PR> — explicit and per PR (#3722)", () => {
	const actionRequired = (id: number, sha: string) => ({
		id,
		name: "CI",
		head_sha: sha,
		status: "completed",
		conclusion: "action_required",
	});

	it("approves each action_required run of that PR's current head, and nothing else", async () => {
		const w = world({
			prs: [
				{
					number: 3443,
					checkRuns: [],
					workflowRuns: [
						actionRequired(101, shaOf(3443)),
						actionRequired(102, shaOf(3443)),
						actionRequired(103, "c".repeat(40)),
						{ ...actionRequired(104, shaOf(3443)), conclusion: "success" },
					],
				},
				{
					number: 3444,
					checkRuns: [],
					workflowRuns: [actionRequired(201, shaOf(3444))],
				},
			],
		});
		const { exitCode, kind, lines } = await cli(["--approve-fork", "3443"], w);
		expect(exitCode).toBe(EXIT_SUCCESS);
		// F4: approval is its own mode, not a CI verdict.
		expect(kind).toBe("approve");
		expect(w.mutations).toEqual([
			"api -X POST repos/apmantza/pi-lens/actions/runs/101/approve",
			"api -X POST repos/apmantza/pi-lens/actions/runs/102/approve",
		]);
		expect(lines).toEqual([
			`APPROVED run 101 of #3443@${sha9(3443)}`,
			`APPROVED run 102 of #3443@${sha9(3443)}`,
		]);
	});

	it("says so and posts nothing when the head has nothing to approve", async () => {
		const w = world({
			prs: [{ number: 3443, checkRuns: [], workflowRuns: [] }],
		});
		const { exitCode, out } = await cli(["--approve-fork", "3443"], w);
		expect(exitCode).toBe(EXIT_SUCCESS);
		expect(out).toBe(`no action_required runs on ${shaOf(3443)} of #3443`);
		expect(w.mutations).toEqual([]);
	});

	it("keeps going after one refused approval and exits 1", async () => {
		const w = world({
			prs: [
				{
					number: 3443,
					checkRuns: [],
					workflowRuns: [
						actionRequired(101, shaOf(3443)),
						actionRequired(102, shaOf(3443)),
					],
				},
			],
			approveThrows: [101],
		});
		const { exitCode, kind, lines, errors } = await cli(
			["--approve-fork", "3443"],
			w,
		);
		expect(exitCode).toBe(EXIT_FAILURE);
		// A refused approval is still the approve mode, never `(red)`.
		expect(kind).toBe("approve");
		expect(errors.join("\n")).toContain("could not approve run 101: HTTP 403");
		expect(lines).toEqual([`APPROVED run 102 of #3443@${sha9(3443)}`]);
	});

	it("does not read an unreadable run list as 'nothing to approve'", async () => {
		const w = world({
			prs: [{ number: 3443, checkRuns: [] }],
			runsThrow: true,
		});
		const { exitCode, kind, out, errors } = await cli(
			["--approve-fork", "3443"],
			w,
		);
		expect(exitCode).toBe(EXIT_TRANSPORT);
		expect(kind).toBe("transport");
		expect(out).toBe("");
		expect(errors.join("\n")).toContain("HTTP 404");
	});

	it("takes a PR number, not a SHA or nothing", async () => {
		const w = world({ prs: [{ number: 3443, checkRuns: [] }] });
		for (const argv of [["--approve-fork", shaOf(3443)], ["--approve-fork"]]) {
			const { exitCode, kind, errors } = await cli(argv, w);
			expect(exitCode).toBe(EXIT_USAGE);
			expect(kind).toBe("usage");
			expect(errors.join("\n")).toContain("--approve-fork takes a PR number");
		}
		expect(w.mutations).toEqual([]);
	});
});

describe("run --watch-open --sync-main <path> — fast-forward the main checkout on a merge (#3722)", () => {
	const merged = () =>
		world({
			prs: [{ number: 7, state: "MERGED" }],
		});
	let dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
		dirs = [];
	});
	const mergedState = () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lens-ci-verdict-sync-"));
		dirs.push(dir);
		const file = join(dir, "state.json");
		writeFileSync(
			file,
			JSON.stringify({ "7": { key: `${shaOf(7)}:pending` } }),
		);
		return file;
	};
	const sync = (checkout: Checkout, w: World = merged()) =>
		cli(
			[
				"--watch-open",
				"--wait",
				"0",
				"--state-file",
				mergedState(),
				"--sync-main",
				"/repo/main",
			],
			w,
			{ gitExec: gitFor(checkout) },
		);

	it("pulls --ff-only, prints the new head, and says nothing about the lockfile when it did not move", async () => {
		const checkout = checkoutAt();
		const { lines } = await sync(checkout);
		expect(lines).toEqual([
			"#7 merged",
			"SYNCED /repo/main: 111111111 -> 222222222",
		]);
		expect(checkout.commands).toContain("git pull --ff-only");
		// The head moved, so there is no "ahead of origin" question to ask.
		expect(checkout.commands.join("\n")).not.toContain("rev-list");
	});

	it("flags a moved package-lock.json and never runs npm ci", async () => {
		const checkout = checkoutAt({ lockChanged: true });
		const { lines } = await sync(checkout);
		expect(lines).toContain(
			"LOCKFILE CHANGED: run npm ci when no worker is live",
		);
		expect(
			checkout.commands.every((command) => command.startsWith("git ")),
		).toBe(true);
		expect(checkout.commands.join("\n")).not.toContain("npm");
	});

	it("does not look at the lockfile when the checkout was already up to date", async () => {
		const checkout = checkoutAt({ remoteHead: OLD_HEAD, lockChanged: true });
		const { lines } = await sync(checkout);
		expect(lines).toContain("SYNCED /repo/main: already at 111111111");
		expect(lines.join("\n")).not.toContain("LOCKFILE");
	});

	it("refuses, saying why, when the checkout is not on master, and pulls nothing", async () => {
		const checkout = checkoutAt({ branch: "feat/x" });
		const { lines } = await sync(checkout);
		expect(lines).toContain("SYNC REFUSED /repo/main: on feat/x, not master");
		expect(checkout.commands).not.toContain("git pull --ff-only");
	});

	it("refuses when tracked files are modified, but not for an untracked file", async () => {
		const dirty = checkoutAt({ dirtyTracked: true });
		expect((await sync(dirty)).lines).toContain(
			"SYNC REFUSED /repo/main: tracked files are modified",
		);
		expect(dirty.commands).not.toContain("git pull --ff-only");
		const untracked = checkoutAt({ untracked: true });
		expect((await sync(untracked)).lines).toContain(
			"SYNCED /repo/main: 111111111 -> 222222222",
		);
	});

	it("refuses with git's own reason when the pull cannot fast-forward", async () => {
		const { lines } = await sync(checkoutAt({ pullFails: true }));
		expect(lines).toContain(
			"SYNC REFUSED /repo/main: fatal: Not possible to fast-forward, aborting.",
		);
	});

	it("names a local-only commit when the checkout is already up to date but ahead of origin", async () => {
		const one = await sync(checkoutAt({ remoteHead: OLD_HEAD, ahead: 1 }));
		expect(one.lines).toContain(
			"SYNCED /repo/main: already at 111111111 (1 local commit not on origin)",
		);
		const two = await sync(checkoutAt({ remoteHead: OLD_HEAD, ahead: 2 }));
		expect(two.lines).toContain(
			"SYNCED /repo/main: already at 111111111 (2 local commits not on origin)",
		);
	});

	it("prints the diverged line of a refusal that says so in other words", async () => {
		const { lines } = await sync(
			checkoutAt({
				pullFails: true,
				pullStderr:
					"From /path/origin\nfatal: local and remote have diverged\nhint: reconcile first\n",
			}),
		);
		expect(lines).toContain(
			"SYNC REFUSED /repo/main: fatal: local and remote have diverged",
		);
	});

	it("prints every stderr line of a refusal that names no known cause", async () => {
		const { lines } = await sync(
			checkoutAt({
				pullFails: true,
				pullStderr:
					"error: cannot lock ref 'refs/remotes/origin/master'\nfatal: unable to update local ref\n",
			}),
		);
		expect(lines).toContain(
			"SYNC REFUSED /repo/main: error: cannot lock ref 'refs/remotes/origin/master' | fatal: unable to update local ref",
		);
	});

	it("does nothing to the checkout without --sync-main, or without a merge", async () => {
		const checkout = checkoutAt();
		await cli(
			["--watch-open", "--wait", "0", "--state-file", mergedState()],
			merged(),
			{ gitExec: gitFor(checkout) },
		);
		const idle = checkoutAt();
		await cli(
			["--watch-open", "--wait", "0", "--sync-main", "/repo/main"],
			world({
				prs: [{ number: 3688, login: "apmantza", checkRuns: GREEN }],
			}),
			{ gitExec: gitFor(idle) },
		);
		expect(checkout.commands).toEqual([]);
		expect(idle.commands).toEqual([]);
	});
});

describe("run --watch-open — #3726 verify residuals (#3722)", () => {
	let dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
		dirs = [];
	});
	const stateFile = () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lens-ci-verdict-resid-"));
		dirs.push(dir);
		return join(dir, "state.json");
	};

	it("keeps the no-suite absence clock across a re-armed watch (state file)", async () => {
		const file = stateFile();
		const pr: PrFixture = {
			number: 3679,
			login: "stranger",
			autoMerge: true,
			checkRuns: [],
			workflowRuns: [],
			suites: [],
		};
		// Armed 9 minutes ago by an earlier watch: one 90 s poll reaches 10.
		writeFileSync(
			file,
			JSON.stringify({
				"3679": {
					key: `${shaOf(3679)}:pending`,
					since: { sha: shaOf(3679), ms: NOW - 9 * 60_000 },
				},
			}),
		);
		const w = world({ prs: [pr] });
		const { exitCode, lines, sleeps } = await cli(
			["--watch-open", "--wait", "900", "--state-file", file],
			w,
		);
		expect(exitCode).toBe(EXIT_SUCCESS);
		expect(sleeps).toHaveLength(1);
		expect(lines[0]).toContain("#3679 absent-rearm");
		// ...and a clock recorded for another head is not this head's.
		const other = stateFile();
		writeFileSync(
			other,
			JSON.stringify({
				"3679": {
					key: "x:pending",
					since: { sha: "d".repeat(40), ms: NOW - 9 * 60_000 },
				},
			}),
		);
		const fresh = await cli(
			["--watch-open", "--wait", "900", "--state-file", other],
			world({ prs: [pr] }),
		);
		expect(fresh.sleeps).toHaveLength(7);
	});

	it("saves the absence clock so the next watch inherits it", async () => {
		const file = stateFile();
		const w = world({
			prs: [
				{
					number: 3679,
					login: "stranger",
					autoMerge: true,
					checkRuns: [],
					workflowRuns: [],
					suites: [],
				},
			],
		});
		await cli(["--watch-open", "--wait", "0", "--state-file", file], w);
		expect(JSON.parse(readFileSync(file, "utf8"))["3679"].since).toEqual({
			sha: shaOf(3679),
			ms: NOW,
		});
	});

	it("loads a first-round state file that kept the bare key string", async () => {
		const { unit, runs } = {
			unit: UNIT_FAIL(),
			runs: [jobRow(UNIT_FAIL()), GREEN[1]],
		};
		const file = stateFile();
		writeFileSync(file, JSON.stringify({ "3688": `${shaOf(3688)}:failed` }));
		const w = world({
			prs: [{ number: 3688, login: "apmantza", checkRuns: runs }],
			jobs: [unit],
		});
		const { exitCode } = await cli(
			["--watch-open", "--wait", "0", "--state-file", file],
			w,
		);
		expect(exitCode).toBe(EXIT_PENDING);
	});

	it("leaves no temp file behind when the rename fails", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lens-ci-verdict-resid-"));
		dirs.push(dir);
		// A directory where the state file should be: rename onto it fails.
		const target = join(dir, "state.json");
		mkdirSync(target);
		const w = world({
			prs: [{ number: 3688, login: "apmantza", checkRuns: GREEN }],
		});
		const { errors } = await cli(
			["--watch-open", "--wait", "0", "--state-file", target],
			w,
		);
		expect(errors.join("\n")).toContain("could not save the watch state");
		expect(existsSync(`${target}.${process.pid}.tmp`)).toBe(false);
	});
});

describe("run — FAIL and assertion lines beyond vitest's .test.ts (#3722)", () => {
	// The repo has none of these today (#3726 verify); the shared regexes now
	// read them so a first `.mjs` / `.spec.ts` / node:assert failure is not blank.
	it("lists FAIL lines for .spec.ts and .test.mjs files and AssertionError [ERR_ASSERTION], but not a non-test path", async () => {
		const log = [
			"2026-09-30T00:00:00.0000000Z  FAIL  scripts/lib/thing.mjs",
			"2026-09-30T00:00:00.0000000Z  FAIL  default  tests/a.spec.ts > suite > case",
			"2026-09-30T00:00:00.0000000Z  FAIL  tests/b.test.mjs",
			"2026-09-30T00:00:00.0000000Z AssertionError [ERR_ASSERTION]: expected 1 to equal 2",
		].join("\n");
		const unit = job("unit-tests-fail-101554674114", log);
		const w = world({
			prs: [{ number: 5, checkRuns: [jobRow(unit), GREEN[1]] }],
			jobs: [unit],
		});
		const { out } = await cli(["5"], w);
		// A non-test path after FAIL is not a failing test (it flipped infra logs to real).
		expect(out).not.toContain("scripts/lib/thing.mjs");
		expect(out).toContain("  FAIL  default  tests/a.spec.ts > suite > case");
		expect(out).toContain("  FAIL  tests/b.test.mjs");
		expect(out).toContain(
			"  AssertionError [ERR_ASSERTION]: expected 1 to equal 2",
		);
	});
});
