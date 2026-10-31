#!/usr/bin/env node
/**
 * scripts/ci-shuffle-changed-tests.mjs (#4397)
 *
 *   node scripts/ci-shuffle-changed-tests.mjs --base <sha> --head <sha>
 *   node scripts/ci-shuffle-changed-tests.mjs --files <a.test.ts,b.test.ts> [--cwd <dir>]
 *
 * The `Changed test files, alone and shuffled` step of ci.yml's
 * `Changed tests shuffled (advisory)` job (#3215 removed the targeted-selection
 * step that used to share it). A new test file that depends on order or on
 * a sibling file passes in CI's file order and reds on a reorder or a shard
 * split (#4390: a fake LSP server delayed only after its first pull, an
 * earlier case supplied it; #4391: a new spawn file failed 6 of 14 cases under
 * seed 101). Nothing ran a PR's own tests in another order, so the dependence
 * shipped and a reviewer found it by hand.
 *
 * Scope is bounded to the test files the PR adds or changes
 * (`git diff --name-only <base>...<head>`, the pre-push selector's
 * `changedFiles`). Files the PR ADDS come before files it only modifies
 * (`--diff-filter=A`, #4456): the added file is what the PR exists to prove,
 * and it sorted past the old 20-file cap when the order was alphabetical. The
 * time budget is the only bound on the set (no count cap): a 20-file plan cost
 * 167 s of a 420 s budget on PR #4491 (run 38864877898), so the count, not the
 * time, left that run unproven. Per set it runs, in this order,
 *
 *   - every ADDED file alone,
 *   - the whole set under `--sequence.shuffle` once per fixed seed in SEEDS
 *     (a cross-file dependence only shows when the files run together), and
 *   - every modified file alone, in file order (a dependence on an UNCHANGED
 *     sibling's side effect only shows when that sibling is absent).
 *
 * It does not run per-test (`-t`) isolation: one vitest start per case costs
 * a start per case. Lane settings are not copied here: the file paths go to
 * the repo's own vitest.config.ts, whose projects route an lsp-spawn-heavy or
 * wall-clock file to its own `maxWorkers` and `groupOrder`.
 *
 * Time budget: BUDGET_MS in all, each vitest start bounded by what is left. A
 * start that does not finish, a start the budget never reached and an unreadable diff are
 * UNPROVEN (exit 3), never green, and each line names the files it did not
 * prove. So is a start that vitest answers with "No test files found": it ran
 * nothing. Exit codes: 0 clean (or no test file in
 * the diff), 1 an order-dependent file or one that fails alone, 2 usage, 3
 * unproven.
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { changedFiles } from "./pre-push-targeted-tests.mjs";

/** Two fixed seeds: every run is reproducible with `--sequence.seed=<seed>`. */
export const SEEDS = Object.freeze([202, 424]);
/**
 * Total wall time: the step's `timeout-minutes: 8` less a 60 s margin for the
 * kill and the summary. Measured, not guessed (#4456): a PR that touches
 * `tests/tools/diagnostics-route-switch-matrix.test.ts` costs the plan about
 * 365 to 385 s, because that one ~60 s file is paid in both shuffled starts
 * and alone. `tests/support/shuffle-changed-budget-measurements.json` keeps
 * the raw CI lines and `tests/scripts/ci-shuffle-changed-tests.test.ts` pins
 * the budget over them. The job cap is 10 min and the setup steps before this
 * one take 23 to 43 s (23 PR runs, 2026-10-31), so 7 min leaves ~2 min.
 */
export const BUDGET_MS = 7 * 60_000;
const OUTPUT_TAIL_LINES = 60;

/**
 * The test files a diff adds or changes that vitest collects: `tests/**\/*.test.ts`
 * minus `tests/fixtures/**` (vitest.config.ts `sharedExclude`), existing on
 * disk (a deleted file is in `git diff --name-only`).
 *
 * @param {string[]} paths
 * @param {(file: string) => boolean} [exists]
 * @param {readonly string[]} [added] paths the diff adds; they come first, so
 *   the cap and the budget drop a modified file before an added one (#4456)
 * @returns {string[]} unique; added files first, each group sorted
 */
export function selectChangedTestFiles(paths, exists = existsSync, added = []) {
	const picked = new Set();
	for (const raw of paths) {
		const file = raw.split(path.sep).join("/");
		if (!/^tests\/.+\.test\.ts$/.test(file)) continue;
		if (file.startsWith("tests/fixtures/")) continue;
		if (exists(file)) picked.add(file);
	}
	const isAdded = new Set(added.map((raw) => raw.split(path.sep).join("/")));
	const rank = (file) => (isAdded.has(file) ? 0 : 1);
	return [...picked].sort(
		(a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0),
	);
}

/**
 * @param {string[]} files
 * @param {readonly number[]} [seeds]
 * @param {{ alone?: boolean, added?: readonly string[] }} [options] `alone:
 *   false` plans the shuffled starts only (the census plans its alone starts
 *   over the whole tree and its shuffled starts per chunk, #4405). `added`
 *   names the files the PR adds: their alone starts run first, ahead of the
 *   shuffled starts, so a slow file in the set cannot starve them (#4456).
 * @returns {Array<{ label: string, files: string[], flags: string[] }>}
 */
export function planRuns(
	files,
	seeds = SEEDS,
	{ alone: withAlone = true, added = [] } = {},
) {
	const shuffled = seeds.map((seed) => ({
		label: `shuffle seed ${seed}`,
		files,
		flags: ["--sequence.shuffle", `--sequence.seed=${seed}`],
	}));
	const alone = withAlone
		? files.map((file) => ({
				label: `alone ${file}`,
				files: [file],
				flags: [],
			}))
		: [];
	const isAdded = (entry) => added.includes(entry.files[0]);
	return [
		...alone.filter(isAdded),
		...shuffled,
		...alone.filter((entry) => !isAdded(entry)),
	];
}

/** The line a reader pastes to reproduce one red. */
export function reproCommand(run) {
	return `npx vitest run ${run.files.join(" ")}${run.flags.length > 0 ? ` ${run.flags.join(" ")}` : ""}`;
}

function vitestEntry() {
	const require = createRequire(import.meta.url);
	return path.join(
		path.dirname(require.resolve("vitest/package.json")),
		"vitest.mjs",
	);
}

/**
 * The one process boundary: one `vitest run` start.
 *
 * @param {{ files: string[], flags: string[] }} run
 * @param {{ cwd: string, timeoutMs: number, env?: NodeJS.ProcessEnv }} options
 * @returns {{ status: number | null, output: string, timedOut: boolean }}
 */
export function execVitest(run, { cwd, timeoutMs, env = process.env }) {
	const result = spawnSync(
		process.execPath,
		[vitestEntry(), "run", ...run.files, ...run.flags],
		{
			cwd,
			env,
			encoding: "utf8",
			timeout: timeoutMs,
			killSignal: "SIGKILL",
			maxBuffer: 64 * 1024 * 1024,
		},
	);
	return {
		status: result.status,
		output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
		timedOut: result.error?.code === "ETIMEDOUT" || result.signal === "SIGKILL",
	};
}

/**
 * Runs the plan in order and stops starting new runs once the budget is spent.
 *
 * @param {Array<{ label: string, files: string[], flags: string[] }>} plan
 * @param {{
 *   cwd: string,
 *   budgetMs?: number,
 *   exec?: typeof execVitest,
 *   now?: () => number,
 *   log?: (line: string) => void,
 * }} options
 */
export function runPlan(plan, options) {
	const {
		cwd,
		budgetMs = BUDGET_MS,
		exec = execVitest,
		now = () => performance.now(),
		log = console.log,
	} = options;
	const started = now();
	/** @type {Array<{ run: (typeof plan)[number], verdict: "ok" | "red" | "timeout" | "uncollected", output: string, ms: number }>} */
	const results = [];
	const notRun = [];
	for (const run of plan) {
		const remaining = budgetMs - (now() - started);
		if (remaining <= 0) {
			notRun.push(run);
			continue;
		}
		const runStarted = now();
		const outcome = exec(run, { cwd, timeoutMs: Math.ceil(remaining) });
		const ms = now() - runStarted;
		let verdict;
		if (outcome.timedOut) verdict = "timeout";
		else if (outcome.status === 0) verdict = "ok";
		else if (/^\s*No test files found/m.test(outcome.output))
			verdict = "uncollected";
		else verdict = "red";
		results.push({ run, verdict, output: outcome.output, ms });
		log(
			`[shuffle-changed] ${run.label}: ${verdict} (${(ms / 1000).toFixed(1)}s)`,
		);
		if (verdict === "red") {
			const tail = outcome.output.split("\n").slice(-OUTPUT_TAIL_LINES);
			log(tail.join("\n"));
			log(`[shuffle-changed] reproduce: ${reproCommand(run)}`);
		}
	}
	return { results, notRun };
}

/** A start's label, plus the files of a multi-file start: "not run" names them. */
function describeRun(run) {
	return run.files.length > 1
		? `${run.label} (${run.files.join(", ")})`
		: run.label;
}

/**
 * @param {{ files: string[], results: ReturnType<typeof runPlan>["results"], notRun: ReturnType<typeof runPlan>["notRun"] }} state
 * @returns {{ code: 0 | 1 | 3, kind: "clean" | "red" | "unproven", lines: string[] }}
 */
export function judge({ files, results, notRun }) {
	const red = results.filter((entry) => entry.verdict === "red");
	const timedOut = results.filter((entry) => entry.verdict === "timeout");
	const uncollected = results.filter(
		(entry) => entry.verdict === "uncollected",
	);
	const lines = [];
	for (const entry of red) {
		// An alone start has no order to depend on: the file simply fails.
		const kind = entry.run.label.startsWith("alone ")
			? "fails alone"
			: "order-dependent";
		lines.push(`${kind}: ${entry.run.label} (${reproCommand(entry.run)})`);
	}
	for (const entry of timedOut)
		lines.push(`did not finish in the budget: ${describeRun(entry.run)}`);
	for (const entry of uncollected)
		lines.push(`not run (no project collects it): ${describeRun(entry.run)}`);
	for (const run of notRun)
		lines.push(`not run (budget spent): ${describeRun(run)}`);
	if (red.length > 0) return { code: 1, kind: "red", lines };
	if (lines.length > 0) return { code: 3, kind: "unproven", lines };
	return {
		code: 0,
		kind: "clean",
		lines: [
			`${files.length} file(s): ${results.length} start(s), none order-dependent`,
		],
	};
}

/** @param {string[]} argv */
export function parseArgs(argv) {
	const options = { base: null, head: null, files: null, cwd: process.cwd() };
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		const value = argv[++index];
		if (value === undefined) throw new Error(`${flag} needs a value`);
		if (flag === "--base") options.base = value;
		else if (flag === "--head") options.head = value;
		else if (flag === "--files")
			options.files = value.split(",").filter(Boolean);
		else if (flag === "--cwd") options.cwd = path.resolve(value);
		else throw new Error(`unknown argument ${flag}`);
	}
	if (options.files === null && (!options.base || !options.head))
		throw new Error("--base and --head (or --files) are required");
	for (const sha of [options.base, options.head])
		if (sha !== null && !/^[0-9a-f]{7,64}$/i.test(sha))
			throw new Error(`not a commit sha: ${sha}`);
	return options;
}

/** @typedef {{ cwd?: string, env?: NodeJS.ProcessEnv }} GitOptions */

/**
 * @param {string[]} argv
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   diff?: (range: string, options: GitOptions) => string[] | null,
 *   added?: (range: string, options: GitOptions) => string[] | null,
 *   exec?: typeof execVitest,
 *   now?: () => number,
 *   budgetMs?: number,
 *   log?: (line: string) => void,
 * }} [io]
 * @returns {number} exit code
 */
export function run(argv, io = {}) {
	const {
		env = process.env,
		diff = changedFiles,
		added: addedOf = (range, git) =>
			changedFiles(range, { ...git, diffFilter: "A" }),
		exec = execVitest,
		now,
		budgetMs,
		log = console.log,
	} = io;
	let options;
	try {
		options = parseArgs(argv);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 2;
	}
	const finish = (verdict) => {
		const summary = `shuffle-changed: exit ${verdict.code} (${verdict.kind})`;
		for (const line of verdict.lines) log(`[shuffle-changed] ${line}`);
		log(summary);
		if (env.GITHUB_STEP_SUMMARY)
			appendFileSync(
				env.GITHUB_STEP_SUMMARY,
				`### Changed test files, alone and shuffled\n\n${verdict.lines.map((line) => `- ${line}`).join("\n")}\n\n${summary}\n`,
			);
		return verdict.code;
	};
	// The diff runs where the tests are (`--cwd`), under the run's own env.
	const git = { cwd: options.cwd, env };
	let paths = options.files;
	if (paths === null) {
		paths = diff(`${options.base}...${options.head}`, git);
		if (paths === null)
			return finish({
				code: 3,
				kind: "unproven",
				lines: ["the changed-file list is unreadable"],
			});
	}
	let added = [];
	if (options.files === null) {
		const range = `${options.base}...${options.head}`;
		// A rename is not an add: a delete plus a >= 50% similar add reads as
		// one (git's rename detection), so that new file counts as modified and
		// keeps its place after the added ones. Chosen, not missed (#4456 r1 F2).
		const answer = addedOf(range, git);
		// The added list only orders the plan; the diff above already answered,
		// so an unreadable list falls back to path order, once, in the log.
		if (answer === null)
			log(
				"[shuffle-changed] the added-file list is unreadable; files run in path order",
			);
		else added = answer;
	}
	const found = selectChangedTestFiles(
		paths,
		(file) => existsSync(path.join(options.cwd, file)),
		added,
	);
	if (found.length === 0)
		return finish({
			code: 0,
			kind: "clean",
			lines: ["no test file added or changed"],
		});
	const files = found;
	log(
		`[shuffle-changed] ${files.length} file(s), seeds ${SEEDS.join(", ")}, budget ${BUDGET_MS / 1000}s`,
	);
	const { results, notRun } = runPlan(planRuns(files, SEEDS, { added }), {
		cwd: options.cwd,
		budgetMs,
		exec,
		now,
		log,
	});
	return finish(judge({ files, results, notRun }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
	process.exitCode = run(process.argv.slice(2));
