#!/usr/bin/env node
// #4672: ONE shard-verdict seam for every sharded required aggregate in
// ci.yml (`TLA+ models` over `tla-shards`, `Unit tests` over `test`).
//
// The defect this replaces: each aggregate ran a `run:` step comparing
// `needs.<job>.result` against the single string `success`, so a shard that
// finished its own work and then lost the race against its own
// `timeout-minutes` was reported `cancelled` and reddened a REQUIRED check on
// master with no model violation and no failing test. Master push run
// 39380875926 (head e3767bd78) is the witness: `TLA+ models (shard 4/4)`
// (job 118491126416) started 06:36:59Z, was `cancelled` at 06:49:14Z -- 735 s
// against a 720 s cap -- and every one of its steps concluded `success`,
// including `Model-check formal/ against each config's expected verdict`
// (06:37:06Z -> 06:49:12Z, 726 s). Three occurrences now: #3591 raised the
// single job's cap 10 -> 20 min as a stopgap, #3918/#3919 sharded it, and
// ci.yml already recorded "PR heads cancelled at 736 s, 881 s and 12m15s".
//
// THE RULE, and why the other direction stays red. A cancelled shard is read
// as a pass-with-warning ONLY when EVERY step that job must finish concluded
// `success` (V2b): `--check-step` is repeatable, so `test` names both `Run
// tests` and `Tmp-fixture hygiene owner` -- which runs AFTER it (ci.yml) and
// reds on tmp entries another file leaked. One step is not enough: a cancel
// between the two left the aggregate green while a gate in that very job never
// concluded. A shard cancelled BEFORE any of them finished -- the step is
// `cancelled`, `failed`, or never started -- is a real timeout: its shard's
// configs or tests were not all run, so the aggregate must stay red.
//
// And the warning is only ever reachable for a `cancelled` aggregate result
// (V2a): `needs.<job>.result` of `failure` says a shard FAILED, and a list
// whose visible rows are all cancelled-teardown races has not shown that
// failure -- so it stays red. A `failure` that reads green is exactly the
// direction the row-count check below exists to catch.
// AGENTS.md "Recurring defect shapes" 11 forbids the opposite reading
// ("absent required checks are not passing checks"): a genuine timeout must
// never read as green, and the harm from a false green here is a model
// violation or a failing test that lands on master.
//
// Two inputs this seam does not recognise fail closed (#4680 r4 state table).
// A blank `--check-step` value -- what `--check-step "${SHARD_CHECK_STEP}"`
// passes when the variable is unset -- is a usage error (exit 2): "every
// required step concluded" is vacuously true of no step, and it read a shard
// cancelled mid-check as `warn`. And the warning needs the WHOLE matrix: the
// shard rows must carry `(shard k/N)` with one N and each k from 1 to N once,
// because a teardown cancel beside a shard row the listing does not show
// explains nothing about the shard it does not show.
//
// Evidence that cannot be read is NOT a pass. If the run's job list cannot be
// fetched or parsed, this prints one bounded `fail` line with the reason and
// exits non-zero ("unreadable evidence is not a pass"): the aggregate must
// fail closed, exactly as the raw string comparison it replaces did.
//
// Usage (the aggregate step):
//
//   node scripts/check-shard-verdict.mjs \
//     --label "TLA+ models" \
//     --result "$SHARDS_RESULT" \
//     --shard-pattern '^TLA\+ models \(shard [0-9]+/[0-9]+\)$' \
//     --check-step "Model-check formal/ against each config's expected verdict" \
//     --repository "$GITHUB_REPOSITORY" --run "$GITHUB_RUN_ID"
//
// Repeat `--check-step` once per gating step the job must finish.
//
// `--result` is `needs.<shard-job>.result`, the same input the old step read.
// A `success` result short-circuits to `pass` without touching the API, so the
// green path costs nothing. Any other result reads
// `GET /repos/<repository>/actions/runs/<run>/jobs` with the run's own
// `GITHUB_TOKEN` (the aggregate job needs `actions: read` for that) and
// classifies each shard row.
//
// Exit codes: 0 for `pass` and `warn` (the run's work is complete), 1 for
// `fail` (bad argv, unreadable evidence, a real cancellation or a real
// failure).

import fs from "node:fs";
import { parseArgs as parseNodeArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { githubHeaders } from "./lib/github-rest.mjs";

/** The steps whose conclusions decide whether a cancelled shard finished its
 * work. `--check-step` is repeatable, so `test` names both its work step and
 * the gate that runs after it; `tla-shards` names one. */
const REQUIRED_FLAGS = ["label", "result", "shard-pattern", "check-step"];

const CLI_OPTIONS = Object.freeze({
	label: { type: "string" },
	result: { type: "string" },
	"shard-pattern": { type: "string" },
	"check-step": { type: "string", multiple: true },
	repository: { type: "string" },
	run: { type: "string" },
	"jobs-file": { type: "string" },
	"jobs-url": { type: "string" },
});

/**
 * Parse the flags strictly: `node:util` handles the space and the equals form
 * alike (`--run 1` and `--run=1`), and `strict` rejects an unknown flag, a
 * missing value and a positional argument by throwing -- the same reasoning as
 * `scripts/check-tla-models.mjs`'s parser (#3920): a typo must fail loudly,
 * never silently classify with a default.
 */
export function parseArgs(argv) {
	const { values } = parseNodeArgs({
		args: [...argv],
		options: CLI_OPTIONS,
		strict: true,
		allowPositionals: false,
	});
	return { ...values };
}

/** A conclusion that means "this step ran to its end". */
const STEP_DONE = new Set(["success"]);

/** A step name that names something: a blank one never matches a step. */
function isStepName(step) {
	return typeof step === "string" && step.trim() !== "";
}

/** `checkSteps` as the list of steps this job must finish, first one first. */
function requiredSteps(checkSteps) {
	return (Array.isArray(checkSteps) ? checkSteps : [checkSteps]).filter(
		isStepName,
	);
}

/**
 * Classify ONE shard job row against the steps that do its work.
 *
 * A cancelled job warns only when EVERY required step concluded `success`:
 * the first one is the work itself, and any after it are gates that run later
 * in the SAME job (`test`'s `Tmp-fixture hygiene owner` runs after its `Run
 * tests`). The step array's own order is what names an unfinished later gate,
 * so the diagnosis says which step the cancellation cut off.
 *
 * @param {object} job a job object from `GET /actions/runs/<id>/jobs`'s `jobs`
 * @param {string | string[]} checkSteps the step name(s) whose conclusions vouch for the work
 * @returns {{ outcome: "pass" | "warn" | "fail", reason: string }}
 */
export function classifyShardJob(job, checkSteps) {
	const name = String(job?.name ?? "(unnamed job)");
	const conclusion = String(job?.conclusion ?? "");
	const steps = Array.isArray(job?.steps) ? job.steps : [];
	const required = requiredSteps(checkSteps);
	const work = required[0];

	// #4680 r4 F4: with no required step, nothing vouches for the work, and the
	// cancelled branch below would warn on a vacuous "every step concluded".
	if (required.length === 0) {
		return {
			outcome: "fail",
			reason: `${name} cannot be judged: no required step was named (an unset --check-step variable passes an empty one)`,
		};
	}
	if (conclusion === "success") {
		return { outcome: "pass", reason: `${name} succeeded` };
	}
	if (conclusion === "skipped") {
		// A `skipped` shard job is its own row shape: since #5082 the
		// `formal/`-unchanged rule skips the whole job (before, it skipped the
		// steps and the job concluded `success`). It ran nothing, so the
		// aggregate cannot read it as a violation (and the aggregate only
		// reaches this branch when its own result was not `success`, which the
		// row-count check below then refuses).
		return { outcome: "pass", reason: `${name} was skipped` };
	}
	if (conclusion === "cancelled") {
		for (const [at, stepName] of required.entries()) {
			const step = steps.find((entry) => entry?.name === stepName);
			const stepConclusion =
				step === undefined
					? "absent"
					: String(step.conclusion ?? "in progress");
			if (step !== undefined && STEP_DONE.has(stepConclusion)) continue;
			// An earlier required step finished and this one did not: the job's
			// work is unfinished, whatever the earlier step's success suggests.
			const after =
				at === 0 ? "" : ` after \`${required[at - 1]}\` concluded success`;
			return {
				outcome: "fail",
				reason: `${name} was cancelled before \`${stepName}\` finished${after} (step ${step === undefined ? "absent from the job" : `conclusion ${stepConclusion}`})`,
			};
		}
		const seconds = stepSeconds(steps.find((entry) => entry?.name === work));
		return {
			outcome: "warn",
			reason: `${name} was cancelled at its own job timeout after ${required.map((stepName) => `\`${stepName}\``).join(" and ")} concluded success${seconds === null ? "" : ` (${seconds} s in the work step)`}`,
		};
	}
	return {
		outcome: "fail",
		reason: `${name} concluded ${conclusion || "no conclusion"} (every step: ${describeStepConclusions(steps)})`,
	};
}

/** Whole seconds a step ran, or null when GitHub omitted its timestamps. */
function stepSeconds(step) {
	const start = Date.parse(String(step?.started_at ?? ""));
	const end = Date.parse(String(step?.completed_at ?? ""));
	if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
		return null;
	return Math.round((end - start) / 1000);
}

/** `success, success, skipped` -- so an unexpected conclusion names its steps. */
function describeStepConclusions(steps) {
	if (steps.length === 0) return "none recorded";
	return steps
		.map((step) => String(step?.conclusion ?? "in progress"))
		.join(", ");
}

/**
 * The aggregate's verdict over every shard row, as `{ outcome, line }`.
 *
 * `result` is `needs.<shard-job>.result`. A `success` result is a pass with no
 * API read at all. Every other result is classified from the rows, and a
 * non-success result that no row explains (every row succeeded, yet the shard
 * job reports `cancelled`) is a FAIL: a matrix cell is missing from the
 * evidence we were given, and shape 11 says an absent row is not a passing
 * one.
 *
 * @param {{ label: string, result: string, shardPattern: RegExp, checkStep?: string, checkSteps?: string | string[], jobs: object[] }} args
 */
export function evaluateShardVerdict({
	label,
	result,
	shardPattern,
	checkStep,
	checkSteps = checkStep,
	jobs,
}) {
	if (result === "success") {
		return {
			outcome: "pass",
			line: `${label}: every shard job succeeded (needs result success)`,
		};
	}
	const rows = (Array.isArray(jobs) ? jobs : []).filter(
		(job) => job && typeof job.name === "string" && shardPattern.test(job.name),
	);
	if (rows.length === 0) {
		return {
			outcome: "fail",
			line: `${label}: needs result ${result} and no job in the run's job list matched ${shardPattern}; unreadable evidence is not a pass`,
		};
	}
	const classified = rows.map((job) => ({
		job,
		...classifyShardJob(job, checkSteps),
	}));
	const failed = classified.filter((entry) => entry.outcome === "fail");
	if (failed.length > 0) {
		return {
			outcome: "fail",
			line: `${label}: needs result ${result}; ${failed.map((entry) => entry.reason).join("; ")}`,
		};
	}
	const warned = classified.filter((entry) => entry.outcome === "warn");
	// V2a: a teardown cancellation explains a `cancelled` aggregate result and
	// NOTHING ELSE. `failure` (or `timed_out`, or `skipped`) says a shard did
	// not do its work; a visible list in which every row merely lost a race with
	// its own timeout has not shown that, so the aggregate stays red. Reading
	// it as a warning is the one direction the row-count check below exists to
	// catch, arriving from the other side.
	if (warned.length > 0 && result !== "cancelled") {
		return {
			outcome: "fail",
			line: `${label}: needs result ${result}; ${warned.map((entry) => entry.reason).join("; ")}. A teardown race explains a \`cancelled\` aggregate, not a \`${result}\` one, and no visible shard row reports that result, so it is unexplained; unreadable evidence is not a pass`,
		};
	}
	const gap = matrixGap(rows);
	if (warned.length > 0 && gap !== null) {
		return {
			outcome: "fail",
			line: `${label}: needs result ${result}; ${warned.map((entry) => entry.reason).join("; ")}. But ${gap}, so the rows cannot vouch for the whole matrix; unreadable evidence is not a pass`,
		};
	}
	if (warned.length > 0) {
		return {
			outcome: "warn",
			line: `${label}: needs result ${result}; ${warned.map((entry) => entry.reason).join("; ")}. Every step that does this shard's work finished, so the cancellation is a teardown race with the job's own timeout, not a violation; kept as a pass and recorded here`,
		};
	}
	// Every row passed, yet the shard job did not report `success`. That is not
	// a green: at least one shard row is missing from what we can read. The
	// line names what the rows ACTUALLY concluded -- a `skipped` matrix cell
	// ran nothing (the `formal/`-unchanged rule or a failed upstream `needs`),
	// so calling it "succeeded" would point a reader at a green shard that does
	// not exist.
	const conclusions = [
		...new Set(classified.map((entry) => seenConclusion(entry.job))),
	];
	return {
		outcome: "fail",
		line: `${label}: needs result ${result}; the ${rows.length} shard row(s) in the run's job list concluded ${conclusions.join(", ")} and none explains that result, so a shard row is missing from the evidence${conclusions.includes("skipped") ? " (a `skipped` shard job ran nothing: the `formal/`-unchanged rule skipped it, or its `needs` failed)" : ""}; unreadable evidence is not a pass`,
	};
}

/** `(shard k/N)` at the end of a matrix row's name, as GitHub expands it. */
const SHARD_SUFFIX = /\(shard ([0-9]+)\/([0-9]+)\)$/;

/**
 * Why the matched rows are not one whole matrix, or `null` when they are:
 * every row names `(shard k/N)` with the same N, and k covers 1..N exactly
 * once. The warning is a claim about every shard, so a row the listing does
 * not show (or shows twice, or names in a form this cannot read) refuses it
 * (#4680 r4 state table, "missing").
 *
 * @param {object[]} rows the shard rows the pattern matched
 * @returns {string | null}
 */
function matrixGap(rows) {
	const seen = new Map();
	let total = null;
	for (const job of rows) {
		const match = SHARD_SUFFIX.exec(job.name);
		if (match === null)
			return `\`${job.name}\` carries no \`(shard k/N)\`, so its matrix cannot be checked`;
		const count = Number(match[2]);
		if (total !== null && count !== total)
			return `the shard rows disagree on the shard count (${total} and ${count})`;
		total = count;
		const index = Number(match[1]);
		seen.set(index, (seen.get(index) ?? 0) + 1);
	}
	for (const [index, times] of seen) {
		if (index < 1 || index > total)
			return `shard ${index} lies outside 1..${total}`;
		if (times !== 1) return `shard ${index} of ${total} appears ${times} times`;
	}
	const missing = [];
	for (let index = 1; index <= total; index += 1)
		if (!seen.has(index)) missing.push(index);
	return missing.length === 0
		? null
		: `missing shard ${missing.join(", ")} of ${total} from the run's job list`;
}

/** The conclusion a shard row actually reports, for the message above. */
function seenConclusion(job) {
	const conclusion = String(job?.conclusion ?? "");
	return conclusion || "no conclusion";
}

/**
 * The endpoint's maximum page, and the repo's own spelling for a jobs listing
 * (`scripts/ci-verdict.mjs`). The default page is 30 rows and this run already
 * has 25 jobs; #3753 re-shards exactly this matrix, so a shard row past row 30
 * would make the aggregate read "no row matched" and redden a required check
 * on unreadable evidence -- a false red, the harm class this seam exists
 * against.
 */
const JOBS_PER_PAGE = 100;

/** The jobs URL the aggregate reads. */
export function jobsUrl({ repository, run, jobsUrlOverride }) {
	if (jobsUrlOverride) return jobsUrlOverride;
	if (!repository || !run) return null;
	return `https://api.github.com/repos/${repository}/actions/runs/${run}/jobs?per_page=${JOBS_PER_PAGE}`;
}

/**
 * Refuse a listing that the payload itself says is incomplete: a `total_count`
 * larger than the rows returned means the read saw one page, and a shard row
 * could be on a page it did not see. Failing with that diagnosis beats both a
 * false pass and a false "no row matched".
 */
function assertCompleteListing(payload, source) {
	const total = payload?.total_count;
	if (typeof total === "number" && total > payload.jobs.length) {
		throw new Error(
			`${source} returned ${payload.jobs.length} of ${total} jobs (incomplete listing)`,
		);
	}
}

/**
 * Read the run's job list from `--jobs-file`, else from the API.
 * @returns {Promise<object[]>} the `jobs` array
 */
export async function readJobs({
	jobsFile,
	url,
	token,
	fetchImpl = globalThis.fetch,
	readFileSync = fs.readFileSync,
}) {
	if (jobsFile) {
		const text = String(readFileSync(jobsFile, "utf8"));
		const payload = JSON.parse(text);
		if (!Array.isArray(payload?.jobs)) {
			throw new Error(`${jobsFile} has no jobs array`);
		}
		assertCompleteListing(payload, jobsFile);
		return payload.jobs;
	}
	if (!url) {
		throw new Error(
			"no --jobs-file, --run or --repository to read the job list from",
		);
	}
	if (!token) {
		throw new Error(`no GITHUB_TOKEN/GH_TOKEN to read ${url}`);
	}
	// The header block is the repo's ONE builder (#4427):
	// `tests/config/github-bearer-ratchet.test.ts` reds on a second spelling.
	const response = await fetchImpl(url, { headers: githubHeaders(token) });
	if (!response?.ok) {
		throw new Error(`GET ${url} -> HTTP ${response?.status ?? "no response"}`);
	}
	const payload = await response.json();
	if (!Array.isArray(payload?.jobs)) {
		throw new Error(`GET ${url} returned no jobs array`);
	}
	assertCompleteListing(payload, `GET ${url}`);
	return payload.jobs;
}

/**
 * One run of the check, with every boundary injectable so tests never touch
 * the network, the filesystem or the real stdout.
 *
 * @returns {Promise<{ code: number, outcome: string, line: string }>}
 */
export async function runShardVerdict({
	argv = process.argv.slice(2),
	env = process.env,
	stdout = (line) => console.log(line),
	fetchImpl = globalThis.fetch,
	readFileSync = fs.readFileSync,
} = {}) {
	let parsed;
	try {
		parsed = parseArgs(argv);
	} catch (error) {
		return fail(
			{ code: 2 },
			`check-shard-verdict: ${firstLine(error)}`,
			stdout,
		);
	}
	const missing = REQUIRED_FLAGS.filter((flag) =>
		flag === "check-step"
			? !Array.isArray(parsed[flag]) || parsed[flag].length === 0
			: !parsed[flag],
	);
	if (missing.length > 0) {
		return fail(
			{ code: 2 },
			`check-shard-verdict: missing ${missing.map((flag) => `--${flag}`).join(", ")}; usage: node scripts/check-shard-verdict.mjs --label <name> --result <needs result> --shard-pattern <regexp> --check-step <step name> [--check-step <step name> ...] [--repository <owner/repo> --run <id> | --jobs-file <path>]`,
			stdout,
		);
	}
	// #4680 r4 F4: a blank value is what an unset workflow variable passes, and
	// it names no step; refuse it before any branch, `success` included.
	if (!parsed["check-step"].every(isStepName)) {
		return fail(
			{ code: 2 },
			'check-shard-verdict: --check-step needs a step name (an empty or blank value names no step; an unset variable in `--check-step "${VAR}"` passes one)',
			stdout,
		);
	}
	let shardPattern;
	try {
		shardPattern = new RegExp(parsed["shard-pattern"]);
	} catch (error) {
		return fail(
			{ code: 2 },
			`check-shard-verdict: --shard-pattern is not a regular expression (${firstLine(error)})`,
			stdout,
		);
	}
	const label = parsed.label;
	if (parsed.result === "success") {
		return emit(
			evaluateShardVerdict({
				label,
				result: parsed.result,
				shardPattern,
				checkStep: requiredSteps(parsed["check-step"])[0],
				checkSteps: parsed["check-step"],
				jobs: [],
			}),
			env,
			stdout,
		);
	}
	let jobs;
	try {
		jobs = await readJobs({
			jobsFile: parsed["jobs-file"],
			url: jobsUrl({
				repository: parsed.repository ?? env.GITHUB_REPOSITORY,
				run: parsed.run ?? env.GITHUB_RUN_ID,
				jobsUrlOverride: parsed["jobs-url"],
			}),
			token: env.GITHUB_TOKEN || env.GH_TOKEN,
			fetchImpl,
			readFileSync,
		});
	} catch (error) {
		// One bounded line. Unreadable evidence is not a pass, and the aggregate
		// must fail closed rather than green-by-accident (shape 11).
		return fail(
			{ code: 1 },
			`${label}: needs result ${parsed.result} and the run's job list could not be read (${firstLine(error).replace(/\s+/g, " ").slice(0, 200)}); unreadable evidence is not a pass`,
			stdout,
			env,
		);
	}
	return emit(
		evaluateShardVerdict({
			label,
			result: parsed.result,
			shardPattern,
			checkStep: requiredSteps(parsed["check-step"])[0],
			checkSteps: parsed["check-step"],
			jobs,
		}),
		env,
		stdout,
	);
}

function emit(verdict, env, stdout) {
	if (verdict.outcome === "fail")
		return fail({ code: 1 }, verdict.line, stdout, env);
	if (verdict.outcome === "warn") {
		stdout(`warn - ${verdict.line}`);
		if (env.GITHUB_ACTIONS === "true") stdout(`::warning::${verdict.line}`);
		return { code: 0, outcome: "warn", line: verdict.line };
	}
	stdout(`pass - ${verdict.line}`);
	return { code: 0, outcome: "pass", line: verdict.line };
}

function fail({ code }, line, stdout, env = process.env) {
	stdout(`fail - ${line}`);
	if (env.GITHUB_ACTIONS === "true") stdout(`::error::${line}`);
	return { code, outcome: "fail", line };
}

function firstLine(error) {
	const text = error instanceof Error ? error.message : String(error);
	return text.split("\n")[0];
}

export async function main() {
	const result = await runShardVerdict();
	process.exitCode = result.code;
}

// AGENTS.md shape 44: `import.meta.url` against `pathToFileURL(process.argv[1])`,
// not a filename suffix. A suffix check runs `main()` when ANY wrapper whose
// name happens to end in `check-shard-verdict.mjs` imports this module, with
// the wrapper's argv and this module's exit code -- reproduced as a wrapper
// exiting 2 on the module's own "missing --label" usage line (V5b). The
// sibling scripts (`check-close-keywords.mjs`, `gen-tla-model-costs.mjs`)
// already use the portable form.
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main().catch((error) => {
		console.error(
			`check-shard-verdict failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exitCode = 1;
	});
}
