#!/usr/bin/env node
/**
 * scripts/ci-shuffle-census.mjs (#4405)
 *
 *   node scripts/ci-shuffle-census.mjs --out <dir> [--part k/n] [--chunk 25]
 *       [--budget-ms N] [--seeds 202,424] [--files tests/a.test.ts,tests/b.test.ts] [--no-alone]
 *   node scripts/ci-shuffle-census.mjs --out <dir> --confirm [--part k/n] [--budget-ms N]
 *   node scripts/ci-shuffle-census.mjs --out <dir> --redo-unproven [--part k/n] [--budget-ms N]
 *   node scripts/ci-shuffle-census.mjs --out <dir> --report [--ratchet <file>]
 *       [--seeds ...] [--files ...] [--no-alone] [--census-result <result>]
 *       [--previous-issues <gh issue list json> --title <t>] [--stale-out <file>]
 *       [--body-out <file>] [--run-url <url>]
 *
 * The whole-tree twin of `ci-shuffle-changed-tests.mjs` (#4397). That job runs
 * a PR's changed test files alone and shuffled; an order-dependent test in a
 * file no PR touches stays hidden until a later PR edits the file, and that PR
 * then pays for a defect it did not write (#4398's verify found 3 of the 44
 * files in `tests/tools/` order-dependent). The census runs every test file
 *
 *   - alone, in file order (a dependence on a sibling's side effect), and
 *   - inside shuffled chunks of CHUNK_FILES files, once per seed of the
 *     changed-files job (a dependence on the order of cases or files),
 *
 * through the changed-files job's own planner, runner and process boundary
 * (`planRuns`, `runPlan`, `execVitest`), not a second runner. Chunks keep a
 * start inside the foreground time cap and the memory budget; a vitest fork
 * per file already isolates one file's module state from another's, so a chunk
 * is not a weaker shuffle of one file's cases.
 *
 * A full pass takes hours on a 3-worker budget, so every finished start is
 * appended to `<out>/census.<part>.jsonl` and a rerun skips what is recorded
 * (`--budget-ms` bounds one call; `--part k/n` takes every n-th start so n
 * calls with PI_LENS_TEST_MAX_WORKERS=1 spend the same three workers). A
 * member seen in a shuffled chunk is re-run with its file alone and its seed
 * (`--confirm`) before it counts: a chunk start can red from the load of its
 * neighbours, and a reproducible `vitest run <file> --sequence.seed=<seed>`
 * is what a fixer needs.
 *
 * The parts share one worktree, so a test that touches a source file can trip
 * another part's stale-build guard in vitest's global setup (seen once in 1624
 * starts, #4405). That start is `uncollected`, never green; `--redo-unproven`
 * runs the starts whose record proved nothing again, and the later record wins.
 *
 * Requires a built tree: `npm run build` and `npm run build:dist` first. The
 * LSP fixture tests import `dist/`, and without it they red inside whichever
 * chunk holds them; the census refuses to start (exit 2) when
 * `dist/index.js` is missing.
 *
 * The ratchet (`scripts/shuffle-census-ratchet.json`) is keyed by FILE: a
 * file stays listed until it is clean under every seed. Which cases of a file
 * fail under a seed moves with its case count (one added passing test took a
 * file from 5 failing rows to 2), so a (seed, test) row would go stale with
 * nothing fixed. `--report` plans the census again with the same flags
 * (`--seeds`, `--files`, `--no-alone`) and judges the records against that
 * plan, so a planned start with no record (a part that died, was cancelled or
 * stopped at its budget, an artifact that never arrived) is never read as
 * clean. It exits
 *
 *   1  a confirmed member the ratchet does not list (`order-dependent`,
 *      `cross-file`, or `fails alone`), or a stale entry that was stale last
 *      night too (`--previous-issues`),
 *   3  a planned start with no record, a start that did not finish, a member
 *      not yet confirmed or rerun, or a `--census-result` other than
 *      `success` (the workflow passes `needs.census.result`),
 *   4  only stale entries: a listed file the census found clean under every
 *      seed this run (warn; the nightly job reds on a second night),
 *   0  clean.
 *
 * A chunk member that is green alone is rerun once (`--confirm` plans the
 * rerun): a repeat is a `cross-file` member, state one file leaves for another
 * that a single-file run cannot see; a one-off is reported as a load flake and
 * counted nowhere. `--no-alone` leaves out the alone starts (the nightly runs
 * them weekly: they found no order-dependent file in the first pass).
 */

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { assertEvaluated } from "./lib/assert-evaluated.mjs";
import { gitExecFileSync } from "./lib/git-fixture-env.mjs";
import { escapeMarkdownCell } from "./lib/markdown-cell.mjs";
import {
	execVitest,
	planRuns,
	reproCommand,
	runPlan,
	SEEDS,
	selectChangedTestFiles,
} from "./ci-shuffle-changed-tests.mjs";
import {
	normalizeVitestOutput,
	parseVitestSummary,
} from "./lib/vitest-summary.mjs";
import { isMainModule } from "./lib/is-main-module.mjs";

/** Files per shuffled start: 13-170 s at one worker over the tree (#4405), under the 10 min call cap. */
export const CHUNK_FILES = 25;
/** One start never gets more than this, whatever the call budget has left. */
export const START_CAP_MS = 8 * 60_000;
/** A start is not begun with less than this left: it would be cut and wasted. */
export const MIN_START_MS = 90_000;
export const RATCHET_PATH = "scripts/shuffle-census-ratchet.json";
const FILE_SENTINEL = "(file)";
const TAIL_LINES = 30;
/** The author `gh issue list --json author` names for a workflow's issue. */
const WORKFLOW_AUTHOR = "app/github-actions";

/** The record key of a planned start: what `runCensus` writes, `--report` reads. */
const startKey = (entry) => entry.key ?? reproCommand(entry);

/** The paths git tracks under `pathspecs` (every path when none), repo-relative. */
export function listTrackedFiles(cwd, pathspecs = []) {
	return gitExecFileSync(["ls-files", "-z", "--", ...pathspecs], {
		cwd,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	})
		.split("\0")
		.filter(Boolean);
}

/**
 * Every vitest-collected test file the repo tracks. The census test holds
 * this list to what the `vitest.config.ts` projects collect, both ways.
 */
export function listTestFiles(cwd) {
	return selectChangedTestFiles(listTrackedFiles(cwd, ["tests"]), (file) =>
		existsSync(path.join(cwd, file)),
	);
}

/** @param {{ flags: string[] }} run @returns {number | "alone"} */
export function seedOf(run) {
	const flag = run.flags.find((entry) => entry.startsWith("--sequence.seed="));
	return flag === undefined ? "alone" : Number(flag.split("=")[1]);
}

/**
 * Shuffled chunks per seed, then every file alone. Starts carry `kind` so a
 * confirm start never reads as a census start.
 *
 * @param {string[]} files
 * @param {{ seeds?: readonly number[], chunk?: number, alone?: boolean }} [options]
 */
export function planCensus(
	files,
	{ seeds = SEEDS, chunk = CHUNK_FILES, alone: withAlone = true } = {},
) {
	const chunks = [];
	for (let at = 0; at < files.length; at += chunk)
		chunks.push(files.slice(at, at + chunk));
	const shuffled = seeds.flatMap((seed) =>
		chunks.flatMap((part, index) =>
			planRuns(part, [seed], { alone: false }).map((entry) => ({
				...entry,
				label: `${entry.label} chunk ${index + 1}/${chunks.length}`,
				kind: "census",
			})),
		),
	);
	const alone = planRuns(files, [], { alone: withAlone }).map((entry) => ({
		...entry,
		kind: "census",
	}));
	return [...shuffled, ...alone];
}

/**
 * The failing tests a vitest transcript names: file, test, first error line.
 * Reads the transcript through the shared parser (AGENTS.md shape 63), one
 * `FAIL` banner at a time so a long failure list is not truncated.
 *
 * @param {string} output
 * @returns {Array<{ file: string, test: string, firstError: string }>}
 */
export function extractMembers(output) {
	const lines = normalizeVitestOutput(output).split("\n");
	const seen = new Map();
	for (const [index, line] of lines.entries()) {
		if (!/^\s*FAIL\b/.test(line)) continue;
		const id = parseVitestSummary(line).failureIds[0];
		if (id === undefined) continue;
		const bare = id.replace(/^[^\s:]*::/, "");
		const split = bare.indexOf(" › ");
		const file = split < 0 ? bare : bare.slice(0, split);
		const test = split < 0 ? FILE_SENTINEL : bare.slice(split + 3);
		const key = `${file}\0${test}`;
		if (seen.has(key)) continue;
		const firstError =
			lines
				.slice(index + 1)
				.map((entry) => entry.trim())
				.find(
					(entry) =>
						entry !== "" && !/^[⎯-]+/.test(entry) && !/^FAIL\b/.test(entry),
				) ?? "";
		seen.set(key, { file, test, firstError: firstError.slice(0, 240) });
	}
	return [...seen.values()];
}

/**
 * Every recorded start, the latest record per start (`--redo-unproven` appends
 * a second record for a start whose first one proved nothing).
 *
 * @param {string} dir
 */
export function loadRecords(dir) {
	if (!existsSync(dir)) return [];
	const latest = new Map();
	for (const name of readdirSync(dir).filter((entry) =>
		/^census\.[\w-]+\.jsonl$/.test(entry),
	))
		for (const line of readFileSync(path.join(dir, name), "utf8")
			.split("\n")
			.filter(Boolean)) {
			const record = JSON.parse(line);
			const kept = latest.get(record.key);
			if (kept === undefined || (record.at ?? 0) >= (kept.at ?? 0))
				latest.set(record.key, record);
		}
	return [...latest.values()];
}

/** A start that finished without proving anything about its files. */
export function isUnproven(record) {
	return (
		record.verdict === "timeout" ||
		record.verdict === "uncollected" ||
		(record.verdict === "red" && record.members.length === 0)
	);
}

/**
 * Runs the starts this part has not recorded, one at a time, until the call
 * budget cannot cover another. A start the budget cut is not recorded: it
 * reruns whole on the next call.
 *
 * @param {ReturnType<typeof planCensus>} plan
 * @param {{
 *   cwd: string,
 *   outFile: string,
 *   done: Set<string>,
 *   budgetMs: number,
 *   exec?: typeof execVitest,
 *   now?: () => number,
 *   log?: (line: string) => void,
 * }} options
 */
export function runCensus(plan, options) {
	const {
		cwd,
		outFile,
		done,
		budgetMs,
		exec = execVitest,
		now = () => performance.now(),
		log = console.log,
	} = options;
	const started = now();
	let ran = 0;
	let pending = 0;
	for (const entry of plan) {
		const key = startKey(entry);
		if (done.has(key)) continue;
		const remaining = budgetMs - (now() - started);
		if (remaining < MIN_START_MS) {
			pending += 1;
			continue;
		}
		const cap = Math.min(remaining, START_CAP_MS);
		const { results } = runPlan([entry], {
			cwd,
			budgetMs: cap,
			exec,
			now,
			log: () => {},
		});
		const result = results[0];
		if (result.verdict === "timeout" && cap < START_CAP_MS) {
			pending += 1;
			continue;
		}
		const members =
			result.verdict === "red" ? extractMembers(result.output) : [];
		const record = {
			key,
			kind: entry.kind,
			label: entry.label,
			files: entry.files,
			seed: seedOf(entry),
			verdict: result.verdict,
			at: Date.now(),
			ms: Math.round(result.ms),
			members,
			tail:
				result.verdict !== "ok" && members.length === 0
					? result.output.split("\n").slice(-TAIL_LINES).join("\n")
					: undefined,
		};
		appendFileSync(outFile, `${JSON.stringify(record)}\n`);
		done.add(key);
		ran += 1;
		log(
			`[census] ${entry.label}: ${result.verdict} (${(result.ms / 1000).toFixed(1)}s, ${members.length} member(s))`,
		);
	}
	return { ran, pending };
}

/**
 * The `--confirm` starts. First each shuffled member's file, alone, under its
 * seed. Then, once that confirm is on record and the member did not reproduce,
 * the chunk start again (`rerun`): a repeat is a cross-file dependence, a
 * one-off a load flake.
 */
export function planConfirms(records) {
	const wanted = new Map();
	const reruns = new Map();
	const confirmed = new Map();
	for (const record of records)
		if (record.kind === "confirm")
			confirmed.set(`${record.seed}\0${record.files[0]}`, record);
	for (const record of records) {
		if (record.kind !== "census" || record.seed === "alone") continue;
		for (const member of record.members) {
			wanted.set(`${record.seed}\0${member.file}`, [member.file, record.seed]);
			const confirm = confirmed.get(`${record.seed}\0${member.file}`);
			if (
				confirm !== undefined &&
				!confirm.members.some((other) => other.test === member.test)
			)
				reruns.set(record.key, record);
		}
	}
	const confirms = [...wanted.values()]
		.sort((a, b) => (`${a[1]}${a[0]}` < `${b[1]}${b[0]}` ? -1 : 1))
		.flatMap(([file, seed]) =>
			planRuns([file], [seed], { alone: false }).map((entry) => ({
				...entry,
				label: `confirm ${entry.label} ${file}`,
				kind: "confirm",
				key: `confirm:${reproCommand(entry)}`,
			})),
		);
	const again = [...reruns.values()].map((record) => ({
		...planRuns(record.files, [record.seed], { alone: false })[0],
		label: `rerun ${record.label}`,
		kind: "rerun",
		key: rerunKey(record),
	}));
	return [...confirms, ...again];
}

const rerunKey = (record) => `rerun:${record.key}`;

const MEMBER_LABEL = {
	"order-dependent": "new order-dependent member",
	"cross-file": "new cross-file member",
	"fails alone": "fails alone",
};

/** The first failing row of a file, for the one-line report. */
function firstRow(rows) {
	const first = rows[0];
	return `${first.seed}: ${first.test} (${first.firstError})`;
}

/**
 * `planned` is the census plan `--report` recomputes: a planned start with no
 * record is unproven, and a ratchet entry is stale only once its file finished
 * under every seed the plan holds. Without it (unit cases) the seeds come
 * from the records. A `censusResult` other than `success` is unproven too.
 *
 * @param {{
 *   records: any[],
 *   ratchet: Array<{ file: string }>,
 *   previousStale?: Iterable<string>,
 *   planned?: Array<{ key?: string, label: string, files: string[], flags: string[] }>,
 *   censusResult?: string,
 * }} state
 * @returns {{
 *   code: 0 | 1 | 3 | 4,
 *   kind: "clean" | "red" | "unproven" | "stale",
 *   members: Array<{ file: string, kind: string, seed: number | "alone", test: string, firstError: string }>,
 *   stale: string[],
 *   lines: string[],
 * }}
 */
export function judgeCensus({
	records,
	ratchet,
	previousStale = [],
	planned,
	censusResult,
}) {
	const census = records.filter((record) => record.kind === "census");
	const confirms = new Map();
	for (const record of records.filter((entry) => entry.kind === "confirm"))
		confirms.set(`${record.seed}\0${record.files[0]}`, record);
	const reruns = new Map(
		records
			.filter((entry) => entry.kind === "rerun")
			.map((record) => [record.key, record]),
	);
	/** file -> rows of confirmed members */
	const found = new Map();
	const add = (kind, file, seed, member) => {
		if (!found.has(file)) found.set(file, []);
		found.get(file).push({ kind, file, seed, ...member });
	};
	const lines = [];
	// Files with a member seen and not yet confirmed or rerun: neither a member
	// nor a fixed one, so their ratchet entry is not judged stale.
	const pending = new Set();
	let unproven = false;
	if (planned !== undefined) {
		const recorded = new Set(census.map((record) => record.key));
		const missing = planned.filter((entry) => !recorded.has(startKey(entry)));
		// The count-vs-plan comparison is the shared proof-of-work helper's
		// (#4518): every planned start must have evaluated (left a record).
		const evaluatedStarts =
			planned.length > 0
				? assertEvaluated({
						producer: "shuffle-census",
						evaluated: planned.length - missing.length,
						expectedAtLeast: planned.length,
					})
				: null;
		if (evaluatedStarts && !evaluatedStarts.ok) {
			const first = missing.slice(0, 3).map((entry) => entry.label);
			lines.push(
				`not run: ${missing.length} of ${planned.length} planned start(s) have no record (${first.join("; ")}${missing.length > 3 ? "; ..." : ""})`,
			);
			unproven = true;
		}
	}
	if (censusResult !== undefined && censusResult !== "success") {
		lines.push(`census job result: ${censusResult || "(empty)"}`);
		unproven = true;
	}
	for (const record of census) {
		if (record.verdict === "timeout" || record.verdict === "uncollected") {
			lines.push(`${record.verdict}: ${record.label}`);
			unproven = true;
		} else if (record.verdict === "red" && record.members.length === 0) {
			lines.push(`red with no failing test named: ${record.label}`);
			unproven = true;
		}
		for (const member of record.members) {
			if (record.seed === "alone") {
				add("fails alone", member.file, "alone", member);
				continue;
			}
			const confirm = confirms.get(`${record.seed}\0${member.file}`);
			if (confirm === undefined) {
				lines.push(
					`not confirmed yet: ${record.seed}|${member.file}|${member.test}`,
				);
				pending.add(member.file);
				unproven = true;
			} else if (confirm.members.some((other) => other.test === member.test)) {
				add("order-dependent", member.file, record.seed, member);
			} else {
				const rerun = reruns.get(rerunKey(record));
				const label = `${record.seed}|${member.file}|${member.test}`;
				if (rerun === undefined) {
					lines.push(`green alone, chunk not rerun yet: ${label}`);
					pending.add(member.file);
					unproven = true;
				} else if (
					rerun.members.some(
						(other) => other.file === member.file && other.test === member.test,
					)
				) {
					add("cross-file", member.file, record.seed, member);
				} else {
					lines.push(
						`warning: load flake, green alone and on a rerun of the chunk: ${label}`,
					);
				}
			}
		}
	}
	// A file that fails alone fails under every seed: report the alone rows.
	for (const [file, rows] of found)
		if (rows.some((row) => row.kind === "fails alone"))
			found.set(
				file,
				rows.filter((row) => row.kind === "fails alone"),
			);
	const listed = new Set(ratchet.map((entry) => entry.file));
	// A ratchet entry is stale only when its file finished under EVERY seed
	// this run planned (alone starts are not required: the nightly skips them).
	const seedsPlanned = new Set(
		(planned === undefined
			? census.map((record) => record.seed)
			: planned.map(seedOf)
		).filter((seed) => seed !== "alone"),
	);
	const finished = new Map();
	for (const record of census)
		if (record.verdict === "ok" || record.verdict === "red")
			for (const file of record.files) {
				if (!finished.has(file)) finished.set(file, new Set());
				finished.get(file).add(record.seed);
			}
	const covered = (file) =>
		seedsPlanned.size > 0 &&
		[...seedsPlanned].every((seed) => finished.get(file)?.has(seed));
	let red = false;
	for (const [file, rows] of found)
		if (!listed.has(file)) {
			lines.push(`${MEMBER_LABEL[rows[0].kind]}: ${file} (${firstRow(rows)})`);
			red = true;
		}
	const previous = new Set(previousStale);
	const stale = [];
	for (const file of listed)
		if (!found.has(file) && !pending.has(file) && covered(file)) {
			stale.push(file);
			if (previous.has(file)) {
				lines.push(
					`ratchet entry clean two nights running, delete it: ${file}`,
				);
				red = true;
			} else {
				lines.push(
					`warning: ratchet entry clean under every seed tonight (delete it if it stays clean): ${file}`,
				);
			}
		}
	const members = [...found.values()].flat();
	const base = { members, stale: stale.sort() };
	if (red) return { code: 1, kind: "red", ...base, lines };
	if (unproven) return { code: 3, kind: "unproven", ...base, lines };
	const total = new Set(census.flatMap((record) => record.files)).size;
	lines.push(
		`${total} file(s), ${census.length} start(s), ${found.size} member file(s), all in the ratchet`,
	);
	if (stale.length > 0) return { code: 4, kind: "stale", ...base, lines };
	return { code: 0, kind: "clean", ...base, lines };
}

const STALE_MARKER = /^<!-- shuffle-census-stale: (.*) -->$/m;

/**
 * The stale files last night's tracking issue recorded in its body. Only the
 * workflow's own issue counts: a marker in an issue a person wrote or relabelled
 * would force the second-night red, or hide it by being listed first.
 */
export function previousStaleFrom(issuesJson, title) {
	/** @type {Array<{ title?: string, body?: string, author?: { login?: string } }>} */
	const issues = JSON.parse(issuesJson);
	const issue = issues.find(
		(entry) => entry.title === title && entry.author?.login === WORKFLOW_AUTHOR,
	);
	const match = STALE_MARKER.exec(issue?.body ?? "");
	return match?.[1] ? match[1].split(",").filter(Boolean) : [];
}

/** The tracking issue body: the verdict, the member rows, the reproduce line. */
export function issueBody(verdict, { runUrl = "" } = {}) {
	const out = [
		`Last run: ${runUrl || "(local)"}`,
		"",
		`Verdict: exit ${verdict.code} (${verdict.kind})`,
		"",
	];
	for (const line of verdict.lines) out.push(`- ${line}`);
	if (verdict.members.length > 0) {
		out.push(
			"",
			"| file | kind | seed | first failing test | first error |",
			"|---|---|---|---|---|",
		);
		for (const row of verdict.members)
			out.push(
				`| \`${row.file}\` | ${row.kind} | ${row.seed} | ${escapeMarkdownCell(row.test)} | ${escapeMarkdownCell(row.firstError)} |`,
			);
		out.push(
			"",
			"Reproduce: `npx vitest run <file> --sequence.shuffle --sequence.seed=<seed>`",
		);
	}
	if (verdict.stale.length > 0)
		out.push("", `<!-- shuffle-census-stale: ${verdict.stale.join(",")} -->`);
	return `${out.join("\n")}\n`;
}

/** @param {string[]} argv */
export function parseArgs(argv) {
	const options = {
		out: null,
		part: [0, 1],
		chunk: CHUNK_FILES,
		budgetMs: 9 * 60_000,
		seeds: [...SEEDS],
		files: null,
		confirm: false,
		report: false,
		redoUnproven: false,
		alone: true,
		previousIssues: null,
		title: null,
		staleOut: null,
		bodyOut: null,
		runUrl: "",
		censusResult: undefined,
		ratchet: RATCHET_PATH,
		cwd: process.cwd(),
	};
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		if (flag === "--no-alone") {
			options.alone = false;
			continue;
		}
		if (
			flag === "--confirm" ||
			flag === "--report" ||
			flag === "--redo-unproven"
		) {
			options[flag === "--redo-unproven" ? "redoUnproven" : flag.slice(2)] =
				true;
			continue;
		}
		const value = argv[++index];
		if (value === undefined) throw new Error(`${flag} needs a value`);
		if (flag === "--out") options.out = path.resolve(value);
		else if (flag === "--part") {
			const match = /^(\d+)\/(\d+)$/.exec(value);
			if (!match || Number(match[1]) >= Number(match[2]))
				throw new Error(`--part wants k/n with k < n: ${value}`);
			options.part = [Number(match[1]), Number(match[2])];
		} else if (flag === "--chunk") options.chunk = Number(value);
		else if (flag === "--budget-ms") options.budgetMs = Number(value);
		else if (flag === "--seeds") options.seeds = value.split(",").map(Number);
		else if (flag === "--files")
			options.files = value.split(",").filter(Boolean);
		else if (flag === "--ratchet") options.ratchet = value;
		else if (flag === "--previous-issues") options.previousIssues = value;
		else if (flag === "--title") options.title = value;
		else if (flag === "--stale-out") options.staleOut = value;
		else if (flag === "--body-out") options.bodyOut = value;
		else if (flag === "--run-url") options.runUrl = value;
		else if (flag === "--census-result") options.censusResult = value;
		else if (flag === "--cwd") options.cwd = path.resolve(value);
		else throw new Error(`unknown argument ${flag}`);
	}
	if (options.out === null) throw new Error("--out is required");
	if (options.previousIssues !== null && options.title === null)
		throw new Error("--previous-issues needs --title");
	// A dispatch input lands here: only test paths reach vitest's argv.
	if (options.files !== null) {
		const paths = new Set(selectChangedTestFiles(options.files, () => true));
		const refused = options.files.filter((file) => !paths.has(file));
		if (refused.length > 0)
			throw new Error(
				`--files takes test paths (tests/**/*.test.ts), never a flag: ${refused.join(", ")}`,
			);
	}
	if (
		!(options.chunk >= 1) ||
		!(options.budgetMs > 0) ||
		options.seeds.some((seed) => !Number.isInteger(seed))
	)
		throw new Error(
			"--chunk, --budget-ms and --seeds must be positive numbers",
		);
	return options;
}

/**
 * @param {string[]} argv
 * @param {{
 *   exec?: typeof execVitest,
 *   now?: () => number,
 *   log?: (line: string) => void,
 *   distExists?: (file: string) => boolean,
 * }} [io]
 * @returns {number} exit code
 */
export function run(argv, io = {}) {
	const { exec, now, log = console.log, distExists = existsSync } = io;
	let options;
	try {
		options = parseArgs(argv);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 2;
	}
	mkdirSync(options.out, { recursive: true });
	if (options.report) {
		const ratchetFile = path.resolve(options.cwd, options.ratchet);
		const ratchet = existsSync(ratchetFile)
			? JSON.parse(readFileSync(ratchetFile, "utf8")).members
			: [];
		const previousStale =
			options.previousIssues !== null && existsSync(options.previousIssues)
				? previousStaleFrom(
						readFileSync(options.previousIssues, "utf8"),
						options.title,
					)
				: [];
		const verdict = judgeCensus({
			records: loadRecords(options.out),
			ratchet,
			previousStale,
			planned: planCensus(options.files ?? listTestFiles(options.cwd), {
				seeds: options.seeds,
				chunk: options.chunk,
				alone: options.alone,
			}),
			censusResult: options.censusResult,
		});
		for (const member of verdict.members)
			log(
				`[census] member | ${member.file} | ${member.kind} | seed ${member.seed} | ${member.test} | ${member.firstError}`,
			);
		for (const line of verdict.lines) log(`[census] ${line}`);
		if (options.staleOut !== null)
			writeFileSync(options.staleOut, `${verdict.stale.join("\n")}\n`);
		if (options.bodyOut !== null)
			writeFileSync(
				options.bodyOut,
				issueBody(verdict, { runUrl: options.runUrl }),
			);
		log(`shuffle-census: exit ${verdict.code} (${verdict.kind})`);
		return verdict.code;
	}
	if (!distExists(path.join(options.cwd, "dist", "index.js"))) {
		console.error(
			"dist/ is not built: run `npm run build` and `npm run build:dist` first (the LSP fixture tests import dist/)",
		);
		return 2;
	}
	const [part, parts] = options.part;
	const mine = (plan) => plan.filter((_, index) => index % parts === part);
	const records = loadRecords(options.out);
	const plan = options.confirm
		? planConfirms(records)
		: planCensus(options.files ?? listTestFiles(options.cwd), {
				seeds: options.seeds,
				chunk: options.chunk,
				alone: options.alone,
			});
	const done = new Set(
		records
			.filter((record) => !(options.redoUnproven && isUnproven(record)))
			.map((record) => record.key),
	);
	const { ran, pending } = runCensus(mine(plan), {
		cwd: options.cwd,
		outFile: path.join(options.out, `census.${part}-of-${parts}.jsonl`),
		done,
		budgetMs: options.budgetMs,
		exec,
		now,
		log,
	});
	log(
		`[census] part ${part}/${parts}: ${ran} start(s) this call, ${pending} still to run`,
	);
	return pending > 0 ? 3 : 0;
}

if (isMainModule(import.meta.url))
	process.exitCode = run(process.argv.slice(2));
