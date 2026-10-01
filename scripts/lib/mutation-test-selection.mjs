import { createHash } from "node:crypto";
import path from "node:path";
import { mapWithConcurrency } from "../../clients/map-with-concurrency.js";

/**
 * Coverage-based test selection and the incremental-cache rules for the
 * mutation diff lane (#3810).
 *
 * The lane's test command (`vitest run <files>`) runs every kept test file for
 * every mutant, so the kept set is the lane's whole cost. The import graph
 * over-approximates it (243 related files for #3757, 72 for #3794), and the old
 * cap kept the first 47 by path: #3794's own new test file was dropped and its
 * 37 survivors were false. The rules here replace that: a test is kept only if
 * V8 coverage shows it executing a changed line, ranked by how many changed
 * lines it executes, and the PR's own test files are never dropped.
 */

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/**
 * The number of changed lines one test executed in one file, from an istanbul
 * `coverage-final.json` entry (vitest's v8 provider, remapped through source
 * maps, so a compiled `.js` reports its `.ts` lines -- the same coordinates as
 * the PR diff).
 *
 * A line counts as executed when a statement STARTING on it ran; a line no
 * statement starts on (a continuation of a multi-line expression) takes the
 * verdict of the innermost statement spanning it, so an unexecuted function
 * body nested inside an executed `const f = () => {...}` is not credited to the
 * test. A line no statement touches (comment, type, blank) is not executable
 * and counts for nothing.
 *
 * @param {{statementMap: Record<string, {start: {line: number}, end: {line: number}}>, s: Record<string, number>}} entry
 * @param {Array<[number, number]>} ranges inclusive new-side line ranges
 * @returns {number}
 */
export function coveredChangedLines(entry, ranges) {
	const statements = Object.entries(entry.statementMap ?? {}).map(
		([id, location]) => ({
			start: location.start.line,
			end: location.end.line,
			hit: (entry.s?.[id] ?? 0) > 0,
		}),
	);
	const startHit = new Map();
	for (const statement of statements) {
		startHit.set(
			statement.start,
			startHit.get(statement.start) || statement.hit,
		);
	}
	let covered = 0;
	for (const [first, last] of ranges) {
		for (let line = first; line <= last; line += 1) {
			if (startHit.has(line)) {
				if (startHit.get(line)) covered += 1;
				continue;
			}
			let innermost = null;
			for (const statement of statements) {
				if (statement.start < line && statement.end >= line) {
					if (
						!innermost ||
						statement.start > innermost.start ||
						(statement.start === innermost.start &&
							statement.end < innermost.end)
					) {
						innermost = statement;
					}
				}
			}
			if (innermost?.hit) covered += 1;
		}
	}
	return covered;
}

/**
 * Changed lines one test executed across the files of a whole
 * `coverage-final.json`, keyed by absolute path in the JSON and matched to the
 * repo-relative changed files.
 *
 * @param {Record<string, object>} coverage parsed coverage-final.json
 * @param {Map<string, Array<[number, number]>>} rangesByFile repo-relative path -> changed ranges
 * @param {string} [root]
 */
export function coveredChangedLinesInReport(
	coverage,
	rangesByFile,
	root = process.cwd(),
) {
	let total = 0;
	for (const [file, entry] of Object.entries(coverage)) {
		const relative = path.relative(root, file).replaceAll("\\", "/");
		const ranges = rangesByFile.get(relative);
		if (ranges) total += coveredChangedLines(entry, ranges);
		else if (rangesByFile.has(relative.replace(/\.js$/, ".ts"))) {
			// The compiled sibling of a changed `.ts` reported under its own `.js`
			// name: no source map was applied, so its line numbers are not the
			// diff's. Reading that as "0 changed lines executed" would drop every
			// test, so it is a probe failure, not a coverage answer.
			throw new Error(`coverage of ${relative} is not source-mapped`);
		}
	}
	return total;
}

/**
 * Written beside `.stryker/incremental.json` (the workflow caches both): the
 * fingerprint of the inputs that file's results were computed under.
 */
export const INCREMENTAL_FINGERPRINT_PATH = ".stryker/incremental.fingerprint";

export const PROBE_REPORTS_ROOT = ".stryker/coverage";

/**
 * One scratch directory per probed test file, for its coverage report.
 *
 * @param {string} test repo-relative test file
 */
export function probeReportsDirectory(test) {
	return `${PROBE_REPORTS_ROOT}/${sha256(test).slice(0, 12)}`;
}

/**
 * The vitest command line that measures one test file's coverage of the
 * changed files. `autoAttachSubprocess` is load-bearing: a test that reaches
 * the script only through `spawnSync(process.execPath, [script])` executes it in
 * a child, and without the flag vitest reports 0 of its 51 statements (measured
 * against scripts/classify-ci-failure.mjs, 41 covered with it) -- the test would
 * read as not covering anything and be dropped.
 *
 * @param {string} test repo-relative test file
 * @param {string[]} includeFiles repo-relative files as vitest loads them (`.js` for a compiled source)
 * @param {string} reportsDirectory
 * @param {{testTimeoutMs?: number}} [options]
 */
export function buildCoverageProbeArgs(
	test,
	includeFiles,
	reportsDirectory,
	{ testTimeoutMs = 30_000 } = {},
) {
	return [
		"run",
		"--configLoader",
		"runner",
		"--testTimeout",
		String(testTimeoutMs),
		test,
		"--coverage.enabled",
		"--coverage.provider=v8",
		"--coverage.autoAttachSubprocess=true",
		"--coverage.reporter=json",
		`--coverage.reportsDirectory=${reportsDirectory}`,
		...includeFiles.map((file) => `--coverage.include=${file}`),
	];
}

/**
 * Probe one test. `run` spawns vitest and reports `{status, timedOut}`;
 * `readCoverage` returns the parsed coverage-final.json or null when vitest
 * wrote none. A passing test with no coverage file executed no included file
 * (0 lines); a failing or timed-out probe says nothing about coverage, so it is
 * `unknown`, never 0 (S9: a flaky probe must not turn into a dropped test).
 *
 * @returns {Promise<{lines: number} | {unknown: string}>}
 */
export async function probeTestCoverage(
	test,
	{ run, readCoverage, rangesByFile, root },
) {
	const result = await run(test);
	if (result.timedOut) return { unknown: "probe timed out" };
	if (result.status !== 0) {
		return { unknown: `probe exited ${result.status}` };
	}
	let coverage = null;
	try {
		coverage = readCoverage(test);
	} catch {
		return { unknown: "coverage report unreadable" };
	}
	if (!coverage) return { lines: 0 };
	try {
		return { lines: coveredChangedLinesInReport(coverage, rangesByFile, root) };
	} catch (error) {
		return { unknown: error.message };
	}
}

/**
 * Probe every test, the first alone: vitest's globalSetup pre-fetches missing
 * grammars on a cold checkout, and several cold probes racing on that download
 * is the one shared-state hazard of running them side by side.
 *
 * @param {string[]} tests
 * @param {(test: string) => Promise<{lines: number} | {unknown: string}>} probe
 * @param {{concurrency: number, signal?: AbortSignal}} options
 * @returns {Promise<Map<string, number | null>>} lines, or null when unknown / never probed
 */
export async function probeAllTests(tests, probe, { concurrency, signal }) {
	const lines = new Map(tests.map((test) => [test, null]));
	const record = async (test) => {
		const result = await probe(test);
		lines.set(test, "lines" in result ? result.lines : null);
	};
	if (tests.length === 0) return lines;
	await record(tests[0]);
	await mapWithConcurrency(tests.slice(1), concurrency, record, signal);
	return lines;
}

/**
 * The PR's own test files among its changed paths (#3810 item 4). Fixtures are
 * inputs, not tests: vitest's config excludes `tests/fixtures/**`, and naming
 * one on the command line is "No test files found", a failed run.
 *
 * @param {string[]} changedPaths
 */
export function ownTestFiles(changedPaths) {
	return changedPaths.filter((file) =>
		/^tests\/(?!fixtures\/).*\.test\.ts$/.test(file),
	);
}

/**
 * Split the PR's own test files into those the run keeps and those the
 * mutation-lane exclusion registry excludes (for its registered reason). A file
 * the related-test scan already excluded is not reported twice; a file deleted
 * by the PR is neither.
 *
 * @param {string[]} changedPaths
 * @param {{
 *   exists: (file: string) => boolean,
 *   exclusionOf: (file: string) => {file: string, reason: string} | null,
 *   alreadyExcluded?: Array<{file: string}>,
 * }} deps
 * @returns {{own: string[], excluded: Array<{file: string, reason: string}>}}
 */
export function partitionOwnTests(
	changedPaths,
	{ exists, exclusionOf, alreadyExcluded = [] },
) {
	const own = [];
	const excluded = [];
	for (const file of ownTestFiles(changedPaths)) {
		if (!exists(file)) continue;
		const exclusion = exclusionOf(file);
		if (!exclusion) own.push(file);
		else if (!alreadyExcluded.some((entry) => entry.file === file)) {
			excluded.push(exclusion);
		}
	}
	return { own, excluded };
}

/**
 * How many coverage probes run side by side: the runner's cores, at most four
 * (each is a whole vitest process), at least one.
 *
 * @param {number} cpus
 */
export function probeConcurrency(cpus) {
	return Math.min(4, Math.max(1, cpus));
}

/**
 * Choose the tests the mutation run executes.
 *
 * Ranking is by relevance, never by name: covered changed lines (descending),
 * then the import-graph priority (sibling before importer), then a hash of the
 * path -- a tie-break that depends on nothing a rename or a directory listing
 * can reorder. The PR's own tests are kept first and are exempt from the cap.
 * A test whose probe failed (`null`) stays a candidate, ranked after every test
 * proven to cover a changed line, so a flaky probe cannot drop evidence.
 *
 * `lines` null, or a map in which every probe failed, selects by the
 * import-graph priority alone: `mode: "import-graph"`.
 *
 * @param {{
 *   related: string[],
 *   ownTests?: string[],
 *   priorities?: Map<string, number>,
 *   lines: Map<string, number | null> | null,
 *   maxTests: number,
 * }} args
 * @returns {{
 *   mode: "coverage" | "import-graph",
 *   pool: number,
 *   covering: number | null,
 *   kept: string[],
 *   dropped: string[],
 *   own: string[],
 *   unknown: string[],
 * }}
 */
export function selectMutationTests({
	related,
	ownTests = [],
	priorities = new Map(),
	lines: probed,
	maxTests,
}) {
	if (!Number.isInteger(maxTests) || maxTests < 0) {
		throw new RangeError("maxTests must be a non-negative integer");
	}
	// Every probe failing is no coverage evidence at all, not "nothing covers".
	const lines =
		probed && [...probed.values()].some((count) => count !== null)
			? probed
			: null;
	const pool = [...new Set([...related, ...ownTests])];
	const ownSet = new Set(ownTests);
	const known = (test) => lines?.get(test) ?? null;
	const rank = (a, b) =>
		(known(b) ?? -1) - (known(a) ?? -1) ||
		(priorities.get(a) ?? 2) - (priorities.get(b) ?? 2);
	// Tests the rank cannot separate keep the order of a hash of their path:
	// the sort below is stable, so this pre-order is the tie-break.
	const byPathHash = pool
		.map((test) => `${sha256(test)}\0${test}`)
		.sort()
		.map((entry) => entry.slice(entry.indexOf("\0") + 1));
	// A null answer (no probe, or a failed one) is not 0: only a proven zero drops.
	const candidates = byPathHash.filter(
		(test) => ownSet.has(test) || known(test) !== 0,
	);
	const own = candidates.filter((test) => ownSet.has(test)).sort(rank);
	const rest = candidates.filter((test) => !ownSet.has(test)).sort(rank);
	const slots = Math.max(0, maxTests - own.length);
	return {
		mode: lines === null ? "import-graph" : "coverage",
		pool: pool.length,
		covering:
			lines === null
				? null
				: pool.filter((test) => (known(test) ?? 0) > 0).length,
		kept: [...own, ...rest.slice(0, slots)],
		dropped: rest.slice(slots),
		own,
		unknown: lines === null ? [] : pool.filter((test) => known(test) === null),
	};
}

const IGNORED_FOR_FINGERPRINT = /^\.changelog\/|\.md$/;

/**
 * The files whose content decides whether a previous run's mutant results still
 * hold. Stryker's own differ reuses EVERY unchanged-location result when the
 * test runner reports no per-test coverage (`mutantCanBeReused` returns true
 * when `!testCoverage.hasCoverage`), which is always the case for the command
 * runner: a changed test would not invalidate a stale "Survived". So the driver
 * keys reuse itself: the kept tests, and every other file the PR changes
 * except the sources being mutated (Stryker diffs those) and prose.
 *
 * @param {{changedFiles: string[], mutatedFiles: string[], keptTests: string[]}} args
 * @returns {string[]} sorted, unique
 */
export function fingerprintPaths({ changedFiles, mutatedFiles, keptTests }) {
	const mutated = new Set(mutatedFiles);
	return [
		...new Set([
			...keptTests,
			...changedFiles.filter(
				(file) => !mutated.has(file) && !IGNORED_FOR_FINGERPRINT.test(file),
			),
		]),
	].sort();
}

/**
 * @param {Array<[string, string]>} entries [label, content] pairs
 */
export function fingerprintEntries(entries) {
	return sha256(
		entries
			.map(([label, content]) => `${label}\0${sha256(content)}`)
			.sort()
			.join("\n"),
	);
}

const ABSENT_FILE = "<absent>";

/**
 * The fingerprint of everything a reused result depends on that Stryker does
 * not watch: where the PR forked from the base, the node version, the Stryker
 * config and the lockfile (vitest and Stryker versions), the kept tests, and
 * every other changed file. `read` returns a file's text and throws for a
 * missing one, which is fingerprinted as absent.
 *
 * @param {{
 *   forkPoint: string,
 *   nodeVersion: string,
 *   read: (file: string) => string,
 *   changedFiles: string[],
 *   mutatedFiles: string[],
 *   keptTests: string[],
 * }} args
 */
export function buildFingerprint({
	forkPoint,
	nodeVersion,
	read: readFile,
	changedFiles,
	mutatedFiles,
	keptTests,
}) {
	const read = (file) => {
		try {
			return readFile(file);
		} catch {
			return ABSENT_FILE;
		}
	};
	const entries = [
		["fork-point", forkPoint],
		["node", nodeVersion],
		["stryker.config.mjs", read("stryker.config.mjs")],
		["package-lock.json", read("package-lock.json")],
		...fingerprintPaths({ changedFiles, mutatedFiles, keptTests }).map(
			(file) => [file, read(file)],
		),
	];
	return {
		digest: fingerprintEntries(entries),
		inputs: Object.fromEntries(
			entries.map(([label, content]) => [label, sha256(content)]),
		),
	};
}

/**
 * The inputs whose hash differs between two fingerprints (changed, added or
 * removed), sorted: what to name when a restored cache is refused, so a cold
 * run says WHY (a hot file master also edits, a runner image's node) instead
 * of only that something differs.
 *
 * @param {Record<string, string>} previous
 * @param {Record<string, string>} current
 * @returns {string[]}
 */
export function changedFingerprintInputs(previous, current) {
	return [...new Set([...Object.keys(previous), ...Object.keys(current)])]
		.filter((label) => previous[label] !== current[label])
		.sort();
}

/**
 * The fingerprint file the driver writes beside the incremental file.
 *
 * @param {{digest: string, inputs: Record<string, string>}} fingerprint
 */
export function serializeFingerprint({ digest, inputs }) {
	return JSON.stringify({ digest, inputs });
}

/**
 * @param {string} text the fingerprint file's text
 * @returns {{digest: string, inputs: Record<string, string>} | null} null for
 *   anything but what `serializeFingerprint` wrote (an older format, a
 *   truncated file): the restored cache is then not trusted
 */
export function parseFingerprint(text) {
	try {
		const parsed = JSON.parse(text);
		return typeof parsed.digest === "string" &&
			parsed.inputs !== null &&
			typeof parsed.inputs === "object"
			? { digest: parsed.digest, inputs: parsed.inputs }
			: null;
	} catch {
		return null;
	}
}

/**
 * Whether the restored incremental file may be handed to Stryker.
 *
 * @param {{hasIncrementalFile: boolean, previous: string | null, current: string}} args
 * @returns {{reuse: boolean, state: "cold-no-cache" | "cold-inputs-changed" | "warm"}}
 */
export function decideIncrementalReuse({
	hasIncrementalFile,
	previous,
	current,
}) {
	if (!hasIncrementalFile || previous === null) {
		return { reuse: false, state: "cold-no-cache" };
	}
	if (previous !== current) {
		return { reuse: false, state: "cold-inputs-changed" };
	}
	return { reuse: true, state: "warm" };
}

/**
 * Drop the restored results Stryker would carry into the report although the
 * current `--mutate` ranges no longer hold them (a reverted hunk, a range the
 * sample left out): its differ re-adds every old mutant outside the mutated
 * scope, so without this a survivor on a line the PR no longer changes keeps
 * rendering on the PR.
 *
 * @param {{files: Record<string, {mutants: Array<{location: {start: {line: number}, end: {line: number}}}>}>}} report
 * @param {string[]} patterns `file:start-end`
 */
export function pruneIncrementalReport(report, patterns) {
	const rangesByFile = new Map();
	for (const pattern of patterns) {
		const match = /^(.*):(\d+)-(\d+)$/.exec(pattern);
		if (!match) continue;
		const ranges = rangesByFile.get(match[1]) ?? [];
		ranges.push([Number(match[2]), Number(match[3])]);
		rangesByFile.set(match[1], ranges);
	}
	const files = {};
	for (const [file, entry] of Object.entries(report.files)) {
		const ranges = rangesByFile.get(file);
		if (!ranges) continue;
		files[file] = {
			...entry,
			mutants: entry.mutants.filter((mutant) =>
				ranges.some(
					([start, end]) =>
						mutant.location.start.line >= start &&
						mutant.location.end.line <= end,
				),
			),
		};
	}
	return { ...report, files };
}

const REUSED_RESULTS_RE = /(\d+) of (\d+) mutant result\(s\) are reused/;

/**
 * Stryker's own "N of M mutant result(s) are reused" info line, from the file
 * log the driver enables (it is not in the JSON report).
 *
 * @param {string} log
 * @returns {{reused: number, total: number} | null}
 */
export function parseIncrementalReuse(log) {
	const match = REUSED_RESULTS_RE.exec(log);
	return match ? { reused: Number(match[1]), total: Number(match[2]) } : null;
}

/**
 * Where the PR forked from the base, not the base's tip: the tip moves with
 * every merge to master while the PR stands still (a merge train moves it every
 * few minutes), which would make every push cold. A rebase or a merge of the
 * base into the PR moves the fork point, and that does start cold.
 *
 * @param {(args: string[]) => string} git runs git, returns stdout
 * @param {string} ref the base ref
 * @param {string} head the PR head
 */
export function forkPointOf(git, ref, head) {
	try {
		return git(["merge-base", ref, head]).trim();
	} catch {
		return "<unresolved>";
	}
}

/**
 * The lines of `git diff --name-only` output: no blank, no padding.
 *
 * @param {string} output
 */
export function parseNameList(output) {
	return output
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

/**
 * Run one coverage probe and say how it ended: the exit status, and whether the
 * time limit (not the test) ended it. A spawn error is no status at all.
 *
 * @param {{
 *   spawn: (command: string, args: string[], options: object) => {
 *     on: (event: string, listener: (...args: any[]) => void) => unknown,
 *     kill: (signal: string) => unknown,
 *   },
 *   command: string,
 *   args: string[],
 *   timeoutMs: number,
 * }} options
 * @returns {Promise<{status: number | null, timedOut: boolean}>}
 */
export function runProbeProcess({ spawn, command, args, timeoutMs }) {
	return new Promise((resolve) => {
		const child = spawn(command, args, { stdio: "ignore" });
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
		}, timeoutMs);
		child.on("error", () => {
			clearTimeout(timer);
			resolve({ status: null, timedOut });
		});
		child.on("close", (status) => {
			clearTimeout(timer);
			resolve({ status, timedOut });
		});
	});
}

/**
 * One probe's coverage report, or null when vitest wrote none; the probe's
 * scratch directory is removed either way, even when the report is unreadable.
 *
 * @param {{exists: (file: string) => boolean, read: (file: string) => string, remove: (directory: string) => void}} io
 * @param {string} directory
 */
export function readProbeCoverage({ exists, read, remove }, directory) {
	const file = `${directory}/coverage-final.json`;
	try {
		return exists(file) ? JSON.parse(read(file)) : null;
	} finally {
		remove(directory);
	}
}

/**
 * The log lines that explain a selection beyond its counts.
 *
 * @param {{dropped: string[], unknown: string[]}} choice
 * @param {number} maxTests
 * @returns {string[]}
 */
export function selectionNotes(choice, maxTests) {
	const notes = [];
	if (choice.dropped.length > 0) {
		notes.push(
			`capped at ${maxTests} tests; dropped, by covered changed lines: ${choice.dropped.join(", ")}`,
		);
	}
	if (choice.unknown.length > 0) {
		notes.push(`no coverage answer for: ${choice.unknown.join(", ")}`);
	}
	return notes;
}

/**
 * Whether one Stryker attempt may read the restored incremental file, and the
 * meta that says so. A resample retry runs against a file the previous attempt
 * cleared, so it is cold whatever the first attempt's decision was.
 *
 * @param {{attempt: number, decision: {reuse: boolean, state: string, changed?: string[]}}} args
 * @returns {{reuse: boolean, meta: {state: string, changed?: string[]}}}
 */
export function planIncrementalAttempt({ attempt, decision }) {
	if (attempt > 0) return { reuse: false, meta: { state: "cold-no-cache" } };
	return {
		reuse: decision.reuse,
		meta: {
			state: decision.state,
			...(decision.changed?.length ? { changed: decision.changed } : {}),
		},
	};
}

/**
 * Leave the incremental file ready for the attempt: pruned to the attempt's
 * ranges when it may be read, removed otherwise (or when it cannot be pruned,
 * which starts cold). Returns whether Stryker may read what is left.
 *
 * @param {{
 *   reuse: boolean,
 *   patterns: string[],
 *   read: () => string,
 *   write: (text: string) => void,
 *   remove: () => void,
 * }} args
 */
export function prepareIncrementalFile({
	reuse,
	patterns,
	read,
	write,
	remove,
}) {
	if (!reuse) {
		remove();
		return false;
	}
	try {
		write(JSON.stringify(pruneIncrementalReport(JSON.parse(read()), patterns)));
		return true;
	} catch {
		remove();
		return false;
	}
}

/**
 * The incremental meta after the run: a warm attempt gains the reuse count
 * Stryker logged (null when the line is missing), any other state is unchanged.
 *
 * @param {{state: string}} meta
 * @param {string} log Stryker's file log
 */
export function withReuseCount(meta, log) {
	if (meta.state !== "warm") return meta;
	return {
		state: "warm",
		...(parseIncrementalReuse(log) ?? { reused: null, total: null }),
	};
}
