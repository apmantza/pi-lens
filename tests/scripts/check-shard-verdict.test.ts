// #4672: the ONE shard-verdict seam both sharded required aggregates use
// (`TLA+ models` over `tla-shards`, `Unit tests` over `test`).
//
// Fixtures under tests/fixtures/ci-shard-verdict/:
//   - tla-cancelled-complete.real.json: the four `TLA+ models (shard k/N)` job
//     rows of master push run 39380875926 attempt 1 (head e3767bd78), plus the
//     `TLA+ models` aggregate row, captured verbatim from
//     `gh api repos/apmantza/pi-lens/actions/runs/39380875926/attempts/1/jobs`
//     (AGENTS.md shape 16: a real external payload, not hand-written). Shard
//     4/4 (job 118491126416) is the witness: started 06:36:59Z, `cancelled` at
//     06:49:14Z -- 735 s against a 720 s `timeout-minutes` -- with every step
//     `success`, the model check itself from 06:37:06Z to 06:49:12Z. Rows for
//     the run's other jobs were dropped from the capture; nothing in them was
//     edited.
//   - tla-cancelled-in-flight.synthetic.json: SYNTHETIC, documented as such.
//     The same payload with shard 4/4's model-check step re-concluded
//     `cancelled`, no `completed_at`, and every later step (and the job's own
//     `completed_at`) truncated away -- what a shard killed DURING its model
//     check looks like. This is the direction that must stay red.
//   - tla-failure.synthetic.json: SYNTHETIC. The same payload with shard 2/4
//     concluding `failure` on its model-check step.
//   - tla-skipped-formal-unchanged.real.json: the four shard rows of run
//     39374931372 attempt 1, captured the same way -- `formal/` was unchanged,
//     so the shard jobs concluded `success` with their model-check step
//     `skipped`. Must stay a pass.
//   - unit-cancelled-complete.synthetic.json: SYNTHETIC, built from a real
//     `Unit tests (shard 1/5)` row of run 39374931372 attempt 1 (the same real
//     step list, names renumbered): shards 1 and 2 `success`, shard 3
//     `cancelled` with `Run tests` concluded `success`, which is #4672's race
//     on the other aggregate. Rows 4/5 and 5/5 were added in round 4 as copies
//     of shard 2's row (name, id and urls renumbered), because a warning now
//     needs the whole matrix: every `k` of `(shard k/N)` exactly once.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
	classifyShardJob,
	evaluateShardVerdict,
	parseArgs,
	readJobs,
	runShardVerdict,
} from "../../scripts/check-shard-verdict.mjs";

const FIXTURES = join(
	import.meta.dirname,
	"..",
	"fixtures",
	"ci-shard-verdict",
);

/** The exact names the two aggregates use in .github/workflows/ci.yml. */
const TLA_PATTERN = /^TLA\+ models \(shard [0-9]+\/[0-9]+\)$/;
const TLA_CHECK_STEP =
	"Model-check formal/ against each config's expected verdict";
const UNIT_PATTERN = /^Unit tests \(shard [0-9]+\/[0-9]+\)$/;
const UNIT_CHECK_STEP = "Run tests";

type ShardJob = {
	id?: number;
	name?: string;
	conclusion?: string | null;
	steps?: Array<{ name?: string; conclusion?: string | null }>;
};

function jobsOf(name: string): ShardJob[] {
	return JSON.parse(readFileSync(join(FIXTURES, name), "utf8"))
		.jobs as ShardJob[];
}

/** A verdict line, through the same shape the aggregate step prints. */
function verdictLine(options: {
	label: string;
	result: string;
	pattern: RegExp;
	checkStep: string;
	checkSteps?: string[];
	jobs: ShardJob[];
}) {
	return evaluateShardVerdict({
		label: options.label,
		result: options.result,
		shardPattern: options.pattern,
		checkStep: options.checkStep,
		checkSteps: options.checkSteps ?? [options.checkStep],
		jobs: options.jobs,
	});
}

/** A shard row that concluded `success`, for building a whole matrix. */
function succeededShard(label: string, index: number, total: number): ShardJob {
	return {
		id: index,
		name: `${label} (shard ${index}/${total})`,
		conclusion: "success",
		steps: [{ name: "Run tests", conclusion: "success" }],
	};
}

describe("#4672 a cancelled shard that finished its work is a pass with a warning", () => {
	// The defect (master run 39380875926): `needs.tla-shards.result` was
	// `cancelled` because shard 4/4 lost the race against its own
	// `timeout-minutes` AFTER its model check concluded `success`. The old
	// aggregate step compared that string against `success` and failed the
	// required `TLA+ models` check on master's tip with no model violation.
	it("keeps the aggregate green for the real cancelled-complete shard, with the warning's reason", () => {
		const verdict = verdictLine({
			label: "TLA+ models",
			result: "cancelled",
			pattern: TLA_PATTERN,
			checkStep: TLA_CHECK_STEP,
			jobs: jobsOf("tla-cancelled-complete.real.json"),
		});
		expect(verdict.outcome).toBe("warn");
		// The reason names the shard and the step that had already finished, so a
		// reader of the aggregate log never has to open the cancelled job.
		expect(verdict.line).toContain("TLA+ models (shard 4/4)");
		expect(verdict.line).toContain("`Model-check");
		expect(verdict.line).toContain("concluded success");
		expect(verdict.line).toContain("726 s");
		expect(verdict.line).not.toContain("violation\n");
	});

	// AGENTS.md shape 11, the direction the fix must NOT bend: a shard killed
	// while its model check was still running ran a fraction of its configs, so
	// its aggregate has to stay red. Reading it as green would let a real model
	// violation land.
	it("stays red for a shard cancelled inside its model-check step", () => {
		const verdict = verdictLine({
			label: "TLA+ models",
			result: "cancelled",
			pattern: TLA_PATTERN,
			checkStep: TLA_CHECK_STEP,
			jobs: jobsOf("tla-cancelled-in-flight.synthetic.json"),
		});
		expect(verdict.outcome).toBe("fail");
		expect(verdict.line).toContain("TLA+ models (shard 4/4)");
		expect(verdict.line).toContain("cancelled before `Model-check");
		expect(verdict.line).toContain("step conclusion cancelled");
	});

	it("stays red for a genuinely failing shard", () => {
		const verdict = verdictLine({
			label: "TLA+ models",
			result: "failure",
			pattern: TLA_PATTERN,
			checkStep: TLA_CHECK_STEP,
			jobs: jobsOf("tla-failure.synthetic.json"),
		});
		expect(verdict.outcome).toBe("fail");
		expect(verdict.line).toContain("TLA+ models (shard 2/4)");
		expect(verdict.line).toContain("concluded failure");
	});

	// Historical shape (the fixture is a pre-#5082 run): the `formal/`-unchanged
	// rule then skipped the model check at STEP level and the shard job still
	// concluded `success`, so this arrives through the `success` short-circuit.
	// It must stay a pass, and it must not be read as "a cancelled shard".
	it("stays a pass when formal/ was unchanged and the shards skipped their checks", () => {
		const verdict = verdictLine({
			label: "TLA+ models",
			result: "success",
			pattern: TLA_PATTERN,
			checkStep: TLA_CHECK_STEP,
			jobs: jobsOf("tla-skipped-formal-unchanged.real.json"),
		});
		expect(verdict.outcome).toBe("pass");
		expect(verdict.line).toContain("every shard job succeeded");
		// Classifying the same rows WITHOUT the short-circuit (the aggregate
		// result was not `success`, e.g. a `skipped` matrix) still reads them as
		// passes, never as warnings: their check step is `skipped`, not
		// `success`, so the cancelled-race reading cannot apply.
		const classified = jobsOf("tla-skipped-formal-unchanged.real.json")
			.filter((job) => TLA_PATTERN.test(String(job.name)))
			.map((job) => classifyShardJob(job, TLA_CHECK_STEP).outcome);
		expect(classified).toEqual(["pass", "pass", "pass", "pass"]);
	});

	it("keeps the Unit tests aggregate green for its own cancelled-complete shard", () => {
		const verdict = verdictLine({
			label: "Unit tests",
			result: "cancelled",
			pattern: UNIT_PATTERN,
			checkStep: UNIT_CHECK_STEP,
			jobs: jobsOf("unit-cancelled-complete.synthetic.json"),
		});
		expect(verdict.outcome).toBe("warn");
		expect(verdict.line).toContain("Unit tests (shard 3/5)");
		expect(verdict.line).toContain("`Run tests` concluded success");
	});

	// V2a: the warn arm is reachable ONLY for a `cancelled` aggregate result.
	// A `failure` aggregate says a shard did not do its work; a visible row list
	// in which every row merely lost a race with its own timeout has not shown
	// that, and reading it as a warning is the row-count check's own harm class
	// arriving from the other side. Reproduced before the fix: the shipped code
	// answered `warn` here.
	it("stays red when the aggregate result is `failure` and every visible row is a teardown cancel", () => {
		const rows = jobsOf("tla-cancelled-complete.real.json").filter(
			(job) =>
				TLA_PATTERN.test(String(job.name)) && job.conclusion === "cancelled",
		);
		expect(rows).toHaveLength(1);
		const verdict = verdictLine({
			label: "TLA+ models",
			result: "failure",
			pattern: TLA_PATTERN,
			checkStep: TLA_CHECK_STEP,
			jobs: rows,
		});
		expect(verdict.outcome).toBe("fail");
		expect(verdict.line).toContain("needs result failure");
		expect(verdict.line).toContain(
			"A teardown race explains a `cancelled` aggregate",
		);
		expect(verdict.line).toContain("unreadable evidence is not a pass");
		// The reason still names the shard it read, so the reader is not left
		// guessing which row produced the line.
		expect(verdict.line).toContain("TLA+ models (shard 4/4)");
	});

	it.each(["failure", "timed_out", "skipped"])(
		"never warns for a `%s` aggregate result",
		(result) => {
			const verdict = verdictLine({
				label: "TLA+ models",
				result,
				pattern: TLA_PATTERN,
				checkStep: TLA_CHECK_STEP,
				jobs: jobsOf("tla-cancelled-complete.real.json"),
			});
			expect(verdict.outcome).not.toBe("warn");
			expect(verdict.outcome).toBe("fail");
		},
	);

	// V2b: `--check-step` is a list, and EVERY listed step must have concluded.
	// In the `test` job `Tmp-fixture hygiene owner` runs AFTER `Run tests`, so a
	// cancel between the two left the aggregate green while a gate in that very
	// job never finished. The shipped fixture has exactly that shape.
	it("stays red when a gating step after the work step never ran", () => {
		const jobs = jobsOf("unit-cancelled-complete.synthetic.json");
		const cancelled = jobs.filter(
			(job) =>
				UNIT_PATTERN.test(String(job.name)) && job.conclusion === "cancelled",
		);
		expect(cancelled).toHaveLength(1);
		const verdict = verdictLine({
			label: "Unit tests",
			result: "cancelled",
			pattern: UNIT_PATTERN,
			checkStep: UNIT_CHECK_STEP,
			checkSteps: [UNIT_CHECK_STEP, "Tmp-fixture hygiene owner"],
			jobs,
		});
		expect(verdict.outcome).toBe("fail");
		expect(verdict.line).toContain("Unit tests (shard 3/5)");
		expect(verdict.line).toContain("`Tmp-fixture hygiene owner`");
		expect(verdict.line).toMatch(
			/cancelled before `Tmp-fixture hygiene owner` finished after `Run tests` concluded success/,
		);
		// And the same rows stay a warning for the single-step list, which is
		// what `tla-shards` passes: the difference is the required step list, not
		// the row.
		expect(
			verdictLine({
				label: "Unit tests",
				result: "cancelled",
				pattern: UNIT_PATTERN,
				checkStep: UNIT_CHECK_STEP,
				jobs,
			}).outcome,
		).toBe("warn");
	});

	// The other direction: a cancel whose EVERY required step concluded stays a
	// warning, so the second step never turns a real teardown race red.
	it("keeps warning when every listed step concluded before the cancel", () => {
		const job = {
			id: 7,
			name: "Unit tests (shard 3/5)",
			conclusion: "cancelled",
			steps: [
				{ name: "Build", conclusion: "success" },
				{ name: "Run tests", conclusion: "success" },
				{ name: "Tmp-fixture hygiene owner", conclusion: "success" },
				{ name: "Upload per-file test results", conclusion: "success" },
			],
		};
		const verdict = verdictLine({
			label: "Unit tests",
			result: "cancelled",
			pattern: UNIT_PATTERN,
			checkStep: UNIT_CHECK_STEP,
			checkSteps: [UNIT_CHECK_STEP, "Tmp-fixture hygiene owner"],
			jobs: [
				...[1, 2, 4, 5].map((k) => succeededShard("Unit tests", k, 5)),
				job,
			],
		});
		expect(verdict.outcome).toBe("warn");
		expect(verdict.line).toContain(
			"`Run tests` and `Tmp-fixture hygiene owner`",
		);
	});

	// Unreadable evidence is not a pass: a non-success aggregate result that no
	// row explains means at least one shard row is missing from what we were
	// given (an absent row is not a passing row -- shape 11).
	it("fails closed when every visible shard passed but the aggregate result did not", () => {
		const rows = jobsOf("tla-cancelled-complete.real.json").filter(
			(job) => !String(job.name).includes("shard 4/4"),
		);
		const verdict = verdictLine({
			label: "TLA+ models",
			result: "cancelled",
			pattern: TLA_PATTERN,
			checkStep: TLA_CHECK_STEP,
			jobs: rows,
		});
		expect(verdict.outcome).toBe("fail");
		expect(verdict.line).toContain("concluded success");
		expect(verdict.line).toContain("a shard row is missing from the evidence");
		expect(verdict.line).toContain("unreadable evidence is not a pass");
		// F7: the line must name what the rows ACTUALLY concluded. Three shards
		// succeeded here, so "succeeded" is true; a skipped matrix cell is the
		// case where the old wording pointed at a green shard that never ran.
		expect(verdict.line).not.toContain("every one of the");
	});

	// #4680 r4 state table, Table A "missing" row: a teardown cancel explains a
	// `cancelled` result, and the warning used to need nothing else -- so with
	// shard 4/4's row absent and shard 3/4 cancelled at teardown the aggregate
	// read `warn` and exit 0 for a shard it never saw. Reproduced before the fix
	// (probes-r4/cells-a.mjs: `missing (3 teardown, 4 absent) ... warn exit 0`).
	// The warning now needs the whole matrix: every `k` of `(shard k/N)` once.
	it("fails closed when a teardown cancel sits beside a missing shard row", () => {
		const rows = jobsOf("tla-cancelled-complete.real.json")
			.filter((job) => TLA_PATTERN.test(String(job.name)))
			.filter((job) => !String(job.name).includes("shard 1/4"));
		expect(rows.map((job) => job.conclusion).sort()).toEqual([
			"cancelled",
			"success",
			"success",
		]);
		const verdict = verdictLine({
			label: "TLA+ models",
			result: "cancelled",
			pattern: TLA_PATTERN,
			checkStep: TLA_CHECK_STEP,
			jobs: rows,
		});
		expect(verdict.outcome).toBe("fail");
		expect(verdict.line).toContain("missing shard 1 of 4");
		expect(verdict.line).toContain("unreadable evidence is not a pass");
	});

	it.each([
		[
			"a shard index appears twice",
			(rows: ShardJob[]) => [...rows, { ...rows[0] }],
			"shard 2 of 4 appears 2 times",
		],
		[
			"the rows disagree on the shard count",
			(rows: ShardJob[]) =>
				rows.map((job) =>
					String(job.name).includes("shard 2/4")
						? { ...job, name: "TLA+ models (shard 2/5)" }
						: job,
				),
			"disagree on the shard count",
		],
		[
			"a shard index lies outside 1..N",
			(rows: ShardJob[]) => [
				...rows,
				{ id: 98, name: "TLA+ models (shard 5/4)", conclusion: "success" },
			],
			"shard 5 lies outside 1..4",
		],
		[
			"a matched name carries no `(shard k/N)`",
			(rows: ShardJob[]) => [
				...rows,
				{ id: 99, name: "TLA+ models (shard x)", conclusion: "success" },
			],
			"no `(shard k/N)`",
		],
	])(
		"fails closed when %s",
		(_why, edit: (rows: ShardJob[]) => ShardJob[], expected: string) => {
			const rows = jobsOf("tla-cancelled-complete.real.json").filter((job) =>
				TLA_PATTERN.test(String(job.name)),
			);
			// The pattern a caller passes decides what is a shard row, so the
			// unrecognised name is admitted by a looser pattern here.
			const loose = /^TLA\+ models \(shard .+\)$/;
			const verdict = verdictLine({
				label: "TLA+ models",
				result: "cancelled",
				pattern: loose,
				checkStep: TLA_CHECK_STEP,
				jobs: edit(rows),
			});
			expect(verdict.outcome).toBe("fail");
			expect(verdict.line).toContain(expected);
		},
	);

	// F7, the misnamed case: a skipped matrix cell (a failed upstream `changes`
	// job skips every shard) makes the aggregate's own result `skipped`, and the
	// rows it reads conclude `skipped`. Nothing "succeeded" -- the old line said
	// "every one of the 1 shard job(s) ... succeeded", which pointed a reader at
	// a green shard that ran nothing.
	it("says a skipped shard ran nothing instead of calling it succeeded", () => {
		const verdict = verdictLine({
			label: "TLA+ models",
			result: "skipped",
			pattern: TLA_PATTERN,
			checkStep: TLA_CHECK_STEP,
			jobs: [
				{
					id: 1,
					name: "TLA+ models (shard 1/4)",
					conclusion: "skipped",
					steps: [],
				},
			],
		});
		expect(verdict.outcome).toBe("fail");
		expect(verdict.line).toContain("concluded skipped");
		expect(verdict.line).toContain("ran nothing");
		expect(verdict.line).toContain("`formal/`-unchanged rule");
		expect(verdict.line).not.toContain("succeeded");
	});

	it("fails closed when no job in the list matches the shard pattern", () => {
		const verdict = verdictLine({
			label: "TLA+ models",
			result: "cancelled",
			pattern: TLA_PATTERN,
			checkStep: TLA_CHECK_STEP,
			jobs: [{ id: 1, name: "Lint & type-check", conclusion: "success" }],
		});
		expect(verdict.outcome).toBe("fail");
		expect(verdict.line).toContain("no job in the run's job list matched");
	});

	// The aggregate's own row must never be classified as a shard: the patterns
	// are anchored to `(shard k/N)`, so `TLA+ models` and `Unit tests` alone do
	// not match.
	it("does not read the aggregate row as a shard row", () => {
		const rows = jobsOf("tla-cancelled-complete.real.json");
		expect(
			rows.filter((job) => TLA_PATTERN.test(String(job.name))),
		).toHaveLength(4);
		expect(TLA_PATTERN.test("TLA+ models")).toBe(false);
		expect(UNIT_PATTERN.test("Unit tests")).toBe(false);
	});
});

describe("#4672 the aggregate step's own boundary: argv, fetch failures, annotations", () => {
	const good = jobsOf("tla-cancelled-complete.real.json");

	async function run(argv: string[], options: Record<string, unknown> = {}) {
		const lines: string[] = [];
		const result = await runShardVerdict({
			argv,
			env: {},
			stdout: (line: string) => lines.push(line),
			...options,
		});
		return { ...result, lines };
	}

	const BASE = [
		"--label",
		"TLA+ models",
		"--shard-pattern",
		TLA_PATTERN.source,
		"--check-step",
		TLA_CHECK_STEP,
	];

	it("passes on a `success` result without reading any evidence", async () => {
		let fetched = false;
		const result = await run([...BASE, "--result", "success"], {
			fetchImpl: async () => {
				fetched = true;
				throw new Error("must not fetch on a green run");
			},
		});
		expect(result.code).toBe(0);
		expect(result.outcome).toBe("pass");
		expect(fetched).toBe(false);
		expect(result.lines).toEqual([
			"pass - TLA+ models: every shard job succeeded (needs result success)",
		]);
	});

	it("classifies a cancelled result from a --jobs-file and exits 0 with a warn line", async () => {
		const result = await run([
			...BASE,
			"--result",
			"cancelled",
			"--jobs-file",
			join(FIXTURES, "tla-cancelled-complete.real.json"),
		]);
		expect(result.code).toBe(0);
		expect(result.outcome).toBe("warn");
		expect(result.lines).toHaveLength(1);
		expect(result.lines[0].startsWith("warn - ")).toBe(true);
	});

	it("exits 1 with a fail line for the cancelled-in-flight shard", async () => {
		const result = await run([
			...BASE,
			"--result",
			"cancelled",
			"--jobs-file",
			join(FIXTURES, "tla-cancelled-in-flight.synthetic.json"),
		]);
		expect(result.code).toBe(1);
		expect(result.outcome).toBe("fail");
		expect(result.lines[0].startsWith("fail - ")).toBe(true);
	});

	// The aggregate must fail closed when the job list cannot be read: a 403
	// (a job without `actions: read`), a network failure and a malformed body
	// are all "unreadable evidence", never a pass.
	it("fails closed, in one bounded line, when the API refuses the job list", async () => {
		const result = await run([...BASE, "--result", "cancelled"], {
			env: {
				GITHUB_REPOSITORY: "acme/repo",
				GITHUB_RUN_ID: "42",
				GITHUB_TOKEN: "t",
			},
			fetchImpl: async () => ({ ok: false, status: 403 }),
		});
		expect(result.code).toBe(1);
		expect(result.outcome).toBe("fail");
		expect(result.lines).toHaveLength(1);
		expect(result.lines[0]).toContain("HTTP 403");
		expect(result.lines[0]).toContain("unreadable evidence is not a pass");
		expect(result.lines[0].length).toBeLessThan(400);
	});

	it("fails closed when the fetched body has no jobs array", async () => {
		const result = await run([...BASE, "--result", "cancelled"], {
			env: {
				GITHUB_REPOSITORY: "acme/repo",
				GITHUB_RUN_ID: "42",
				GITHUB_TOKEN: "t",
			},
			fetchImpl: async () => ({
				ok: true,
				status: 200,
				json: async () => ({}),
			}),
		});
		expect(result.code).toBe(1);
		expect(result.lines[0]).toContain("returned no jobs array");
	});

	it("reads the jobs URL it was given, with the run's own token", async () => {
		const seen: Array<{ url: string; headers: unknown }> = [];
		const result = await run([...BASE, "--result", "cancelled"], {
			env: {
				GITHUB_REPOSITORY: "acme/repo",
				GITHUB_RUN_ID: "42",
				GITHUB_TOKEN: "tok",
			},
			fetchImpl: async (
				url: string,
				init: { headers: Record<string, string> },
			) => {
				seen.push({ url: String(url), headers: init.headers });
				return { ok: true, status: 200, json: async () => ({ jobs: good }) };
			},
		});
		expect(result.outcome).toBe("warn");
		// F3: the endpoint's default page is 30 rows and this repo's own runs
		// already have 25 jobs, so the fetch asks for the maximum page -- the
		// spelling `scripts/ci-verdict.mjs` already uses for a jobs listing.
		expect(seen[0].url).toBe(
			"https://api.github.com/repos/acme/repo/actions/runs/42/jobs?per_page=100",
		);
		// The header block is `scripts/lib/github-rest.mjs`'s own (the bearer
		// ratchet's one spelling), not a second copy in this script.
		expect(seen[0].headers).toMatchObject({
			Accept: "application/vnd.github+json",
			Authorization: "Bearer tok",
			"X-GitHub-Api-Version": "2022-11-28",
		});
	});

	// F3: the aggregate reads `GET /actions/runs/<id>/jobs`, whose default page is
	// 30 rows. This repo's ci.yml runs already carry 25 jobs, and #3753
	// re-shards exactly this matrix, so a run that outgrows one default page
	// would hide its shard rows and the aggregate would redden a required check
	// on "no row matched". The fake below models GitHub's paging: it returns the
	// `per_page` rows asked for, and `total_count` always describes the whole
	// run.
	it("reads the shard rows of a run that has more than one default page of jobs", async () => {
		let requested = "";
		const filler = Array.from({ length: 30 }, (_, index) => ({
			id: 1000 + index,
			name: `Filler job ${index}`,
			conclusion: "success",
			steps: [{ name: "run", conclusion: "success" }],
		}));
		const shardRows = jobsOf("tla-cancelled-complete.real.json").filter((job) =>
			TLA_PATTERN.test(String(job.name)),
		);
		const all = [...filler, ...shardRows];
		expect(all).toHaveLength(34);
		const result = await run([...BASE, "--result", "cancelled"], {
			env: {
				GITHUB_REPOSITORY: "acme/repo",
				GITHUB_RUN_ID: "42",
				GITHUB_TOKEN: "t",
			},
			fetchImpl: async (url: string) => {
				requested = String(url);
				const perPage = Number(
					new URL(String(url)).searchParams.get("per_page") ?? "30",
				);
				return {
					ok: true,
					status: 200,
					json: async () => ({
						total_count: all.length,
						jobs: all.slice(0, perPage),
					}),
				};
			},
		});
		expect(requested).toContain("per_page=100");
		expect(result.outcome).toBe("warn");
		expect(result.lines[0]).toContain("TLA+ models (shard 4/4)");
	});

	// The other side of the same read: a listing the payload itself marks as
	// incomplete must fail with THAT diagnosis, not with "no shard row matched",
	// so a future run past even the maximum page is actionable (shape 11).
	it("fails closed, naming an incomplete listing, when the page is short of total_count", async () => {
		const result = await run([...BASE, "--result", "cancelled"], {
			env: {
				GITHUB_REPOSITORY: "acme/repo",
				GITHUB_RUN_ID: "42",
				GITHUB_TOKEN: "t",
			},
			fetchImpl: async () => ({
				ok: true,
				status: 200,
				json: async () => ({
					total_count: 140,
					jobs: Array.from({ length: 100 }, (_, index) => ({
						id: index,
						name: `Filler job ${index}`,
						conclusion: "success",
					})),
				}),
			}),
		});
		expect(result.code).toBe(1);
		expect(result.outcome).toBe("fail");
		expect(result.lines[0]).toContain("incomplete listing");
		expect(result.lines[0]).toContain("100 of 140 jobs");
		expect(result.lines[0]).toContain("unreadable evidence is not a pass");
	});

	it("emits the GitHub annotation beside the same line", async () => {
		const result = await run(
			[
				...BASE,
				"--result",
				"cancelled",
				"--jobs-file",
				join(FIXTURES, "tla-cancelled-complete.real.json"),
			],
			{ env: { GITHUB_ACTIONS: "true" } },
		);
		expect(result.lines).toHaveLength(2);
		expect(result.lines[1]).toBe(`::warning::${result.line}`);
	});

	// A typo must never classify a run: an unknown flag, a missing value and a
	// missing required flag all exit non-zero before any read (#3920's rule,
	// applied to this seam).
	it.each([
		[
			"an unknown flag",
			[...BASE, "--result", "cancelled", "--shrad-pattern", "x"],
		],
		["a missing value", ["--label", "TLA+ models", "--result"]],
	])("rejects %s", async (_label, argv) => {
		expect(() => parseArgs(argv as string[])).toThrow();
		const result = await run(argv as string[]);
		expect(result.code).toBe(2);
		expect(result.outcome).toBe("fail");
	});

	// #4680 r4 F4 (coderabbit "Fail closed when the required step list is
	// empty"): `--check-step "${SHARD_CHECK_STEP}"` with the variable unset
	// passes ONE empty value, which the step filter dropped -- so a shard
	// cancelled with its work step still running read `warn`, exit 0, because
	// "every required step concluded" is vacuously true of no step. Reproduced
	// before the fix (probes-r4/cells-a.mjs: four `empty ("")` cells warned). A
	// blank value is a usage error before any branch, `success` included.
	it.each([
		["an empty value", ["--check-step", ""]],
		["a whitespace value", ["--check-step", "  "]],
		[
			"an empty value beside a real one",
			["--check-step", TLA_CHECK_STEP, "--check-step", ""],
		],
	])("rejects %s for --check-step", async (_label, steps) => {
		for (const result of ["cancelled", "success"]) {
			const result_ = await run([
				"--label",
				"TLA+ models",
				"--shard-pattern",
				TLA_PATTERN.source,
				...steps,
				"--result",
				result,
				"--jobs-file",
				join(FIXTURES, "tla-cancelled-in-flight.synthetic.json"),
			]);
			expect(result_.code).toBe(2);
			expect(result_.outcome).toBe("fail");
			expect(result_.lines[0]).toContain("--check-step needs a step name");
		}
	});

	// The seam's own half of F4, for a direct caller: no required step means
	// nothing vouches for a cancelled row's work.
	it("fails a cancelled row when no required step is named", () => {
		const cancelled = jobsOf("tla-cancelled-complete.real.json").find(
			(job) => job.conclusion === "cancelled",
		);
		expect(cancelled).toBeDefined();
		for (const steps of [[], [""], ""]) {
			const verdict = classifyShardJob(cancelled as ShardJob, steps);
			expect(verdict.outcome).toBe("fail");
			expect(verdict.reason).toContain("no required step was named");
		}
	});

	it("names every missing required flag", async () => {
		const result = await run(["--result", "cancelled"]);
		expect(result.code).toBe(2);
		expect(result.lines[0]).toContain("--label");
		expect(result.lines[0]).toContain("--shard-pattern");
		expect(result.lines[0]).toContain("--check-step");
	});

	it("rejects a --shard-pattern that is not a regular expression", async () => {
		const result = await run([
			"--label",
			"x",
			"--result",
			"cancelled",
			"--shard-pattern",
			"([",
			"--check-step",
			"y",
		]);
		expect(result.code).toBe(2);
		expect(result.lines[0]).toContain("not a regular expression");
	});

	// V5b, AGENTS.md shape 44: importing this module must not run the entry
	// point. The retired guard compared `process.argv[1]` against a FILENAME
	// SUFFIX, so any wrapper whose name ended in `check-shard-verdict.mjs` ran
	// `main()` with the wrapper's argv and set the wrapper's exit code. The guard
	// now compares `import.meta.url` with `pathToFileURL(process.argv[1]).href`,
	// the form the sibling scripts use.
	//
	// Driven IN PROCESS: the wrapper is a path this test puts in `process.argv[1]`
	// and the module is re-imported under it, so the platform guard itself is what
	// answers. No child process: a real spawn here is the flake shape #2547
	// ratchets (`real-process-spawn`), and the spawn proved nothing the guard's
	// own comparison does not.
	it("does not run the entry point when a wrapper imports the module", async () => {
		const moduleUrl = pathToFileURL(
			resolve(import.meta.dirname, "../../scripts/check-shard-verdict.mjs"),
		).href;
		const wrapperArgv1 = resolve(
			import.meta.dirname,
			"wrapper-check-shard-verdict.mjs",
		);
		const argvBefore = process.argv[1];
		const exitCodeBefore = process.exitCode;
		const printed: string[] = [];
		const log = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
			printed.push(String(line));
		});
		try {
			process.argv[1] = wrapperArgv1;
			// A fresh module instance, so the entry guard runs again under the
			// wrapper's argv. The query keeps it distinct even outside vitest's
			// module registry.
			vi.resetModules();
			await import(`${moduleUrl}?wrapper-check`);
		} finally {
			process.argv[1] = argvBefore;
			process.exitCode = exitCodeBefore;
			log.mockRestore();
		}
		// `main()` prints its own usage line and sets the exit code; a wrapper
		// import must do neither.
		expect(printed.join("\n")).not.toContain("check-shard-verdict:");
		expect(printed).toEqual([]);
		expect(process.exitCode).toBe(exitCodeBefore);
	});

	// #4680 r4 F3: the other direction of the same guard. The test above pins
	// "a wrapper import does not run main()", and nothing pinned "running the
	// script does": replacing the guard with `false` left all 112 tests green
	// while `node scripts/check-shard-verdict.mjs --result failure ...` printed
	// nothing and exited 0 -- both REQUIRED aggregates green on any shard
	// result. Driven in process like its sibling: `process.argv[1]` is the
	// script's own path and the module is imported by its plain URL, so the
	// guard's comparison is what answers.
	it("runs the entry point when the script itself is argv[1]", async () => {
		const script = resolve(
			import.meta.dirname,
			"../../scripts/check-shard-verdict.mjs",
		);
		const argvBefore = [...process.argv];
		const exitCodeBefore = process.exitCode;
		const printed: string[] = [];
		const log = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
			printed.push(String(line));
		});
		let exitCode: number | string | null | undefined;
		try {
			// No flags at all: `main()` must print its usage line and exit 2.
			process.argv.splice(0, process.argv.length, argvBefore[0], script);
			vi.resetModules();
			await import(pathToFileURL(script).href);
			// `main()` reaches its usage line through microtasks alone (no I/O,
			// no timer), so a bounded microtask drain joins it deterministically.
			for (let tick = 0; tick < 50 && process.exitCode !== 2; tick += 1)
				await Promise.resolve();
			exitCode = process.exitCode;
		} finally {
			process.argv.splice(0, process.argv.length, ...argvBefore);
			process.exitCode = exitCodeBefore;
			log.mockRestore();
		}
		expect(exitCode).toBe(2);
		expect(printed.join("\n")).toContain(
			"check-shard-verdict: missing --label, --result, --shard-pattern, --check-step",
		);
	});

	it("refuses a jobs file with no jobs array", async () => {
		await expect(
			readJobs({
				jobsFile: join(FIXTURES, "..", "not-a-run.json"),
				readFileSync: () => '{"nope":true}',
			}),
		).rejects.toThrow(/has no jobs array/);
	});
});
