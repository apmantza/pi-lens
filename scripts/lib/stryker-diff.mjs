import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { mapGeneratedLineToOriginal } from "./mutation-source-map.mjs";

const IMPORT_SPECIFIER_RE =
	/(?:from\s+|import\s*(?:\(\s*)?|require\(\s*)["']([^"']+)["']/g;
const MUTATION_LANE_EXCLUSION_RE = /^\s*\/\/\s*mutation-lane:\s*exclude\s*$/m;
const MUTATION_LANE_EXCLUSIONS_PATH =
	"tests/config/stryker-diff-exclusions.json";

export class MutationLaneExclusionError extends Error {
	constructor(file) {
		super(`mutation lane exclusion marker has no checked reason: ${file}`);
		this.name = "MutationLaneExclusionError";
	}
}

function mutationLaneExclusions() {
	try {
		return JSON.parse(readFileSync(MUTATION_LANE_EXCLUSIONS_PATH, "utf8"));
	} catch {
		return {};
	}
}

/** @param {string} file @param {{readFile?: (file: string) => string, exclusions?: Record<string, {reason?: string}>}} [options] */
export function mutationLaneExclusion(
	file,
	{
		readFile = (candidate) => readFileSync(candidate, "utf8"),
		exclusions = mutationLaneExclusions(),
	} = {},
) {
	let source;
	try {
		source = readFile(file);
	} catch {
		return null;
	}
	if (!MUTATION_LANE_EXCLUSION_RE.test(source)) return null;
	const admission = exclusions[file];
	if (!admission?.reason) {
		throw new MutationLaneExclusionError(file);
	}
	return { file, reason: admission.reason };
}

export const DEFAULT_MAX_FILES = 6;

/**
 * Ceiling on the combined mutate-pattern (changed-range) population, across
 * both scripts and compiled sources, in one PR's mutation run. `--max-files`
 * bounds how many CHANGED FILES enter the run; a single large file's diff can
 * still produce far more ranges than the budget affords, so this bounds the
 * ranges themselves.
 */
export const DEFAULT_MAX_RANGES = 40;

// Bounded 2026-09-29 command-run measurement and its raw output are recorded
// in tests/fixtures/mutation-test-cap-measurement.json. Three fixed LSP suites
// 1.51 seconds per suite process; 47 therefore projects to about 71 seconds,
// leaving about 58 minutes 49 seconds of the 60-minute budget for mutants and
// build/report overhead. Stryker's dry-run server was EPERM-blocked in this
// sandbox, so this is explicitly a bounded process-cost proxy, not a claim
// about mutant execution cost.
export const DEFAULT_MAX_TESTS = 47;

/**
 * Wall-clock bound the driver puts on the Stryker child, in minutes. It must
 * stay strictly below .github/workflows/mutation.yml's `timeout-minutes`, or
 * the runner cancels the job first and the driver never gets to say that it
 * evaluated nothing (advisory run 36098718085). The margin also covers
 * `npm ci`, `npm run build`, Stryker's in-place sandbox restore on SIGTERM,
 * and the report upload.
 */
export const MUTATION_BUDGET_MINUTES = 60;
export const DEFAULT_MUTATION_FIXED_OVERHEAD_MS = 5 * 60_000;

// `git diff --unified=0` headers. Only the "+" side is used: it numbers lines
// in HEAD, which is the tree Stryker mutates in place.
const DIFF_FILE_RE = /^\+\+\+ b\/(.+)$/;
const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

export const isScriptMutationFile = (file) =>
	/^scripts\/.*\.mjs$/.test(file) && !file.endsWith(".test.mjs");

/**
 * A `.ts` source this lane mutates through its compiled `.js` output (#3531
 * rescope): `clients/`, `tools/`, `mcp/`, and the root `index.ts`. Tests
 * execute the compiled `.js`, never the `.ts`, so these are mutated there
 * (mutation-source-map.mjs maps the PR's `.ts` diff onto it) and reported
 * back at `.ts` file:line.
 */
export const isCompiledMutationSource = (file) =>
	(/^(?:clients|tools|mcp)\/.*\.ts$/.test(file) || file === "index.ts") &&
	!file.endsWith(".test.ts") &&
	!file.endsWith(".d.ts");

export const isMutationSourceFile = (file) =>
	isScriptMutationFile(file) || isCompiledMutationSource(file);

/**
 * The compiled sibling `tsc --project tsconfig.build.json` emits for a
 * `.ts` mutation source. No `outDir` is configured, so tsc writes `.js`
 * (and, under tsconfig.mutation.json, `.js.map`) next to the `.ts` source
 * (verified: `clients/atomic-write.js` sits beside `clients/atomic-write.ts`
 * after a real build, 2026-09-26).
 */
export const compiledJsPath = (file) => `${file.slice(0, -3)}.js`;

function collectTestFiles(dir, out = []) {
	if (!existsSync(dir)) return out;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) collectTestFiles(full, out);
		else if (entry.name.endsWith(".test.ts")) out.push(full);
	}
	return out;
}

function extractRelativeSpecifiers(content) {
	const specifiers = [];
	IMPORT_SPECIFIER_RE.lastIndex = 0;
	let match = IMPORT_SPECIFIER_RE.exec(content);
	while (match) {
		if (match[1].startsWith(".")) specifiers.push(match[1]);
		match = IMPORT_SPECIFIER_RE.exec(content);
	}
	return specifiers;
}

function normalized(file) {
	return path
		.resolve(file)
		.replace(/\\/g, "/")
		.replace(/\.(?:mjs|js|cjs|ts)$/, "");
}

/**
 * The heaviest `maxFiles` files by changed-line weight (#3810, from the #3797
 * review): the old alphabetical cut skipped the four files holding #3706's
 * actual change and mutated its label plumbing and an oxfmt reflow. Equal
 * weights fall back to the path so the choice stays deterministic.
 *
 * @param {string[]} files
 * @param {number} [maxFiles]
 * @param {Map<string, number>} [weights] changed lines per file (see changedLineWeights)
 */
export function capMutationFiles(
	files,
	maxFiles = DEFAULT_MAX_FILES,
	weights = new Map(),
) {
	if (!Number.isInteger(maxFiles) || maxFiles < 0) {
		throw new RangeError("maxFiles must be a non-negative integer");
	}
	// Path order first, then a stable sort by weight: equal weights keep it.
	const ordered = [...files]
		.sort()
		.sort((a, b) => (weights.get(b) ?? 0) - (weights.get(a) ?? 0));
	return {
		selected: ordered.slice(0, maxFiles),
		skipped: ordered.slice(maxFiles),
	};
}

/**
 * Group the new-side changed line ranges of a `git diff --unified=0` payload by
 * file. An omitted hunk count means one line; a deletion-only hunk ("+c,0", and
 * "+0,0" at the top of a file) collapses to the single line at the deletion
 * point, because Stryker rejects an inverted or sub-line-1 mutation range during
 * options validation.
 *
 * @param {string} diffText
 * @returns {Map<string, Array<[number, number]>>}
 */
export function parseChangedLineRanges(diffText) {
	const ranges = new Map();
	// git always emits the "+++ b/<path>" header before that file's hunks, so
	// `file` is set by the time a hunk header matches.
	let file;
	for (const line of diffText.split("\n")) {
		const fileMatch = DIFF_FILE_RE.exec(line);
		if (fileMatch) {
			file = fileMatch[1];
			ranges.set(file, []);
			continue;
		}
		const hunk = HUNK_HEADER_RE.exec(line);
		if (!hunk) continue;
		const newStart = Number(hunk[1]);
		const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
		const start = Math.max(1, newStart);
		ranges.get(file).push([start, Math.max(start, newStart + count - 1)]);
	}
	return ranges;
}

/**
 * Changed lines per file, from the ranges of `parseChangedLineRanges`.
 *
 * @param {Map<string, Array<[number, number]>>} rangesByFile
 * @returns {Map<string, number>}
 */
export function changedLineWeights(rangesByFile) {
	return new Map(
		[...rangesByFile].map(([file, ranges]) => [
			file,
			ranges.reduce((sum, [start, end]) => sum + (1 + end - start), 0),
		]),
	);
}

/**
 * Turn the selected files and their changed ranges into Stryker `--mutate`
 * patterns. A bare path means "mutate the whole file", which is the 2220-mutant
 * population that made the lane evaluate nothing, so a file with no changed
 * ranges contributes no pattern at all.
 *
 * @param {string[]} files
 * @param {Map<string, Array<[number, number]>>} rangesByFile
 * @returns {string[]}
 */
export function mutationRangePatterns(files, rangesByFile) {
	return files.flatMap((file) =>
		(rangesByFile.get(file) ?? []).map(
			([start, end]) => `${file}:${start}-${end}`,
		),
	);
}

/**
 * Deterministically sample `--mutate` patterns down to `limit` when a PR's
 * changed lines produce more than the run's range budget affords. Seeded by
 * the head SHA (not `Math.random()`): the same PR head always samples the
 * same subset, so a re-run reports the same survivors instead of a
 * different, non-reproducible slice each time; a different head (a new
 * commit) samples differently. Order-independent of the input: patterns are
 * ranked by `sha256(seed:pattern)` rather than by array position, so
 * reordering the same changed-file set (a different `git diff` file order)
 * still selects the same sample.
 *
 * @param {string[]} patterns
 * @param {number} limit
 * @param {string} seed typically the head SHA
 * @returns {{selected: string[], sampled: boolean}}
 */
export function sampleRangesDeterministically(patterns, limit, seed) {
	if (patterns.length <= limit) return { selected: patterns, sampled: false };
	const ranked = patterns
		.map((pattern) => ({
			pattern,
			key: createHash("sha256").update(`${seed}:${pattern}`).digest("hex"),
		}))
		.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	const keep = new Set(ranked.slice(0, limit).map((entry) => entry.pattern));
	return {
		selected: patterns.filter((pattern) => keep.has(pattern)),
		sampled: true,
	};
}

/**
 * The pre-mutation source text a mutant's location spans, read from the
 * (by the time the driver calls this, restored-to-original) source file --
 * Stryker's own report schema stores only the replacement, never what it
 * replaced. Columns are 1-based (verified against a real report: a
 * ConditionalExpression mutant at columns 6-49 of
 * `scripts/lib/stryker-diff.mjs:56` sliced to exactly
 * `!Number.isInteger(maxFiles) || maxFiles < 0`, 2026-09-26). A multi-line
 * span is truncated to its first line with a marker rather than joined,
 * since joining would misrepresent the original formatting.
 *
 * @param {string[]} sourceLines
 * @param {{start: {line:number, column:number}, end: {line:number, column:number}} | undefined} location
 */
export function extractSnippet(sourceLines, location) {
	if (!location?.start || !location?.end) return undefined;
	const { start, end } = location;
	const line = sourceLines[start.line - 1] ?? "";
	if (start.line === end.line) {
		return line.slice(start.column - 1, end.column - 1);
	}
	return `${line.slice(start.column - 1)} … (multi-line)`;
}

/**
 * The bare cause clause a Stryker child's failed/interrupted exit maps to
 * (round 2 R2-4), shared by `describeStrykerFailure` (a full, zero-mutant
 * failure -- prefixed "no mutants evaluated") and
 * a PARTIAL result -- some mutants WERE evaluated, so that prefix would
 * contradict the "N of M evaluated" banner shown right above it).
 * `spawnSync` marks an expired budget with
 * `error.code === "ETIMEDOUT"`; `signal` is null when the child exits on the
 * signal itself, which Stryker's UnexpectedExitHandler does, so the signal is
 * not a usable discriminator.
 *
 * @param {{status: number|null, signal?: string|null, error?: Error & {code?: string}}} result
 * @param {number} budgetMinutes
 */
function strykerFailureCause(result, budgetMinutes) {
	return result.error?.code === "ETIMEDOUT"
		? `the ${budgetMinutes}-minute mutation budget expired before Stryker produced a result`
		: `dry run or mutation execution failed (Stryker status ${result.status ?? "unknown"}${result.error ? `: ${result.error.message}` : ""})`;
}

/**
 * @param {{status: number|null, signal?: string|null, error?: Error & {code?: string}}} result
 * @param {number} budgetMinutes
 */
export function describeStrykerFailure(
	result,
	budgetMinutes,
	{ tests = [], output = "" } = {},
) {
	const failed = [
		...new Set(
			[...output.matchAll(/(?:FAIL|×|❯)\s+(tests\/[^\s:]+)/g)].map(
				(match) => match[1],
			),
		),
	];
	const named = failed.length > 0 ? failed : tests;
	const suffix =
		named.length > 0
			? `; tests involved: ${named.join(", ")}`
			: "; no related test file was identified";
	return `mutation diff: dry run failed; no mutants evaluated; ${strykerFailureCause(result, budgetMinutes)}${suffix}`;
}

/**
 * The user-facing verdict for a partial report. A timed-out child has already
 * completed its initial test run, so the zero-mutant dry-run failure wording
 * is false and hides the score and survivors that the incremental report
 * contains (#3683).
 *
 * @param {{status: number|null, signal?: string|null, error?: Error & {code?: string}}} result
 * @param {number} budgetMinutes
 * @param {{evaluated: number, total: number|null}} partial
 */
export function describePartialMutationOutcome(
	result,
	budgetMinutes,
	{ evaluated, total },
) {
	const totalText =
		total === null ? "an unknown number of mutants" : `${total} mutants`;
	if (result.error?.code === "ETIMEDOUT") {
		return `mutation diff: budget expired after ${evaluated} of ${totalText} evaluated (M = measured mutant population)`;
	}
	return `mutation diff: partial run interrupted after ${evaluated} of ${totalText} evaluated (M = measured mutant population); ${strykerFailureCause(result, budgetMinutes)}`;
}

export function formatCapNotice(selectedCount, totalCount, skipped) {
	return `capped: ${selectedCount} of ${totalCount} changed files mutated; skipped: ${skipped.join(", ")}`;
}

/**
 * The conventional test-file location a mutation source's basename maps to,
 * mirroring the file's top-level directory: `scripts/lib/ci-checks.mjs` ->
 * `tests/scripts/ci-checks.test.ts`, `clients/lsp/inferred-project.ts` ->
 * `tests/clients/inferred-project.test.ts`. This is only a supplementary
 * signal on top of the relative-import scan below: `clients/` and `tools/`
 * mirror this convention unevenly (some tests nest under the source's own
 * subdirectory, e.g. `tests/clients/dispatch/rules/`; some sources have no
 * directly-named test at all and are covered only through the import scan),
 * so a miss here is expected and never treated as "uncovered" on its own.
 *
 * @param {string} file
 */
function conventionalTestSibling(file) {
	const [topDir] = file.split("/");
	const base = path.basename(file).replace(/\.(?:mjs|ts)$/, "");
	return topDir === file
		? `tests/${base}.test.ts`
		: `tests/${topDir}/${base}.test.ts`;
}

/**
 * Select tests that cover changed mutation sources (scripts/**\/*.mjs and
 * the compiled-source classes in isCompiledMutationSource) through one-hop
 * relative imports or the conventional tests/<dir>/<name>.test.ts sibling.
 * Compiled sources are matched the same way scripts are: test files import
 * them with a relative specifier (typically ending in `.js`, since that is
 * what TypeScript's `nodenext` resolution and the repo's own tests use to
 * reach a compiled `clients/*.ts` module -- e.g. `tests/index-wiring.test.ts`
 * imports `../index.js`), which `normalized()` compares extension-agnostically.
 *
 * @param {string[]} changedFiles
 * @param {{ testFiles?: string[], readFile?: (file: string) => string }} [options]
 */
export function mapRelatedTests(
	changedFiles,
	{
		testFiles = collectTestFiles("tests"),
		readFile = (file) => readFileSync(file, "utf8"),
		exclusions = mutationLaneExclusions(),
	} = {},
) {
	const sources = changedFiles.filter(isMutationSourceFile);
	const related = new Map(sources.map((file) => [file, new Set()]));
	const priorities = new Map();
	const excluded = new Map();
	const testContents = testFiles.map((test) => {
		let content;
		try {
			content = readFile(test);
		} catch {
			return [test, null, null];
		}
		const exclusion = mutationLaneExclusion(test, {
			readFile: () => content,
			exclusions,
		});
		return [test, content, exclusion];
	});

	for (const file of sources) {
		const sibling = conventionalTestSibling(file);
		const siblingEntry = testContents.find(
			([test]) => normalized(test) === normalized(sibling),
		);
		if (siblingEntry) {
			const siblingExclusion = siblingEntry[2];
			if (siblingExclusion) excluded.set(sibling, siblingExclusion);
			else {
				related.get(file).add(sibling);
				priorities.set(sibling, 0);
			}
		}
		const target = normalized(file);
		for (const [test, content, exclusion] of testContents) {
			if (content === null) continue;
			for (const specifier of extractRelativeSpecifiers(content)) {
				const imported = normalized(
					path.resolve(path.dirname(test), specifier),
				);
				if (imported !== target) continue;
				if (exclusion) excluded.set(test, exclusion);
				else {
					related.get(file).add(test);
					if (!priorities.has(test)) priorities.set(test, 1);
				}
			}
		}
	}

	return {
		related,
		covered: sources.filter((file) => related.get(file).size > 0),
		uncovered: sources.filter((file) => related.get(file).size === 0),
		tests: [...new Set([...related.values()].flatMap((files) => [...files]))],
		priorities,
		excluded: [...excluded.values()],
	};
}

/**
 * Build the per-run Stryker config object as PLAIN DATA (round 2 T1): every
 * field on `stryker.config.mjs`'s default export is JSON-serializable
 * (verified -- no functions, no `undefined`), so the driver writes this
 * object straight to `.stryker/diff.config.mjs` via `JSON.stringify` rather
 * than hand-building the file as a template-literal string. That makes the
 * override itself directly testable: a test that only asserts the driver's
 * SOURCE TEXT contains a string (`driver.toContain("mutation-touch-
 * build.mjs")`) is satisfied by a comment mentioning that string and proves
 * nothing about what Stryker actually runs (round-1 finding T1) -- this
 * function's return value is exactly the config object Stryker reads.
 *
 * `buildCommand` is ALWAYS overridden, never inherited from `baseConfig`:
 * Stryker writes the instrumented (mutation-switch-embedded) `.js` to disk
 * during sandbox init, BEFORE `buildCommand` runs, so the base config's
 * `"npm run build"` would silently discard every mutant for a compiled
 * target before a single test executes (see scripts/lib/mutation-touch-
 * build.mjs's own header). `force` keeps `incremental` enabled (so a
 * budget-killed run still saves a partial report, round 2 S2) while making
 * Stryker treat any existing incremental file as absent on the read side,
 * without disabling the write-on-interrupt behavior that depends on
 * `options.incremental` alone. It is true unless the caller proved the file
 * belongs to this run's tests and inputs (`reuse`, #3810): otherwise a STALE
 * `.stryker/incremental.json` from an earlier, unrelated local run (round 2
 * T4) or an earlier push with different tests would be read. `fileLogLevel`
 * makes Stryker write its "N of M mutant result(s) are reused" line to
 * `stryker.log`, the only place the reuse count exists.
 *
 * @param {object} baseConfig stryker.config.mjs's default export
 * @param {{command: string, reuse?: boolean}} options the per-run test command
 */
export function buildRunConfig(baseConfig, { command, reuse = false }) {
	return {
		...baseConfig,
		force: !reuse,
		fileLogLevel: "info",
		buildCommand: "node scripts/lib/mutation-touch-build.mjs",
		commandRunner: { ...baseConfig.commandRunner, command },
	};
}

const INSTRUMENTED_MUTANT_COUNT_RE =
	/Instrumented \d+ source file\(s\) with (\d+) mutant\(s\)/;
const DRY_RUN_NET_MS_RE = /Ran \d+ tests? in .*?\(net (\d+) ms/;

/**
 * Parse the total mutant count and the dry run's net duration out of
 * Stryker's own `--dryRunOnly` console output (round 2 S2). Neither number
 * is in the JSON report -- `--dryRunOnly` produces no report at all, since
 * no mutation testing occurred -- so the console text is the only source,
 * matched against a real run's captured lines:
 * `Instrumented 1 source file(s) with 39 mutant(s)` and `Initial test run
 * succeeded. Ran 1 tests in 2 seconds (net 2758 ms, overhead 0 ms).`
 * (2026-09-26, `clients/atomic-write.js:1-190`).
 *
 * @param {string} output combined stdout+stderr of a `--dryRunOnly` run
 * @returns {{totalMutants: number, dryRunMs: number} | null} null when
 *   either line is missing (a Stryker output format the driver cannot read)
 */
export function parseDryRunCost(output) {
	const mutantMatch = INSTRUMENTED_MUTANT_COUNT_RE.exec(output);
	const dryRunMatch = DRY_RUN_NET_MS_RE.exec(output);
	if (!mutantMatch || !dryRunMatch) return null;
	return {
		totalMutants: Number(mutantMatch[1]),
		dryRunMs: Number(dryRunMatch[1]),
	};
}

/**
 * How many mutants the remaining budget affords, from a real measured dry
 * run. Vitest runners are CPU-bound in this lane: the #3649 measurement saw
 * only 1.11x wall-clock speedup at Stryker concurrency 2 (#3810 measured the
 * CI runner again: concurrency 3 and 4 ran the mutation phase 1.10x and 1.13x
 * faster than 2), so this estimator deliberately models one effective worker. `safetyFactor` (< 1) reserves
 * headroom for timing variance and fixed run overhead.
 *
 * @param {{remainingMs: number, dryRunMs: number, fixedOverheadMs?: number, safetyFactor?: number}} args
 * @returns {number} zero when fixed overhead leaves no capacity, otherwise at least 1
 */
export function estimateAffordableMutants({
	remainingMs,
	dryRunMs,
	fixedOverheadMs = 0,
	safetyFactor = 0.7,
}) {
	if (dryRunMs <= 0) return 1;
	const budgetAfterOverhead = remainingMs - fixedOverheadMs;
	if (budgetAfterOverhead <= 0) return 0;
	const affordable = Math.floor(
		((budgetAfterOverhead / 1000) * safetyFactor) / (dryRunMs / 1000),
	);
	return Math.max(1, affordable);
}

/**
 * Removes exact duplicate `--mutate` patterns (round 2 S3): the same
 * collapsed generated range can be produced by two different `.ts` hunks
 * mapping onto the SAME `.js` line span (verified on a real #3579 replay:
 * `clients/instance-reaper.js:215-215` appeared twice), and each duplicate
 * otherwise spends a slot in the range budget on a range Stryker would
 * instrument and test identically the first time.
 *
 * @param {string[]} patterns
 * @returns {string[]} in first-seen order
 */
export function dedupePatterns(patterns) {
	return [...new Set(patterns)];
}

/**
 * The zero-mutant reason text (round 2 R2-1). Unsampled, this states the
 * true global fact ("Stryker found no mutable code in M ranges"). SAMPLED,
 * that same sentence is false whenever the measurement found mutants
 * elsewhere: a real #3579 replay at a 15-minute budget sampled 1 of 99
 * ranges -- `clients/instance-reaper.js:931-931`, a shorthand-property line
 * with 0 mutants -- and reported "Stryker found no mutable code in 99
 * changed range(s))" although the other 98 ranges together held 710
 * (measured 2026-09-26). The sampled phrasing names the sample size and the
 * measured total instead, so the reader sees "we tried a subset and it came
 * up empty", never "there is nothing here".
 *
 * @param {{sampled: boolean, rangesEvaluated: number, rangesTotal: number, totalMutants: number|null}} args
 */
export function describeZeroMutantOutcome({
	sampled,
	rangesEvaluated,
	rangesTotal,
	totalMutants,
}) {
	if (!sampled) {
		return `Stryker found no mutable code in ${rangesTotal} changed range(s)`;
	}
	return `0 mutants in ${rangesEvaluated} sampled of ${rangesTotal} ranges (${rangesTotal} ranges held ${totalMutants} mutant(s))`;
}

/**
 * The single decision point for the driver's three previously-independent
 * "did this attempt produce a usable result" branches (round 2 R2-2): the
 * measurement-time `cost.totalMutants === 0` check, the post-run
 * `mutants.length === 0` check, and the partial path's `mutants.length > 0`
 * check. Before this, mutating all three of those conditions to `< 0` left
 * the whole suite green (98/98, verified 2026-09-26) -- nothing exercised
 * the driver's own branches, only the library functions they called. Pure,
 * so each branch is now pinned with a literal-input test rather than a real
 * Stryker run.
 *
 * @param {{
 *   interrupted: boolean,
 *   mutants: Array<{status: string}>,
 *   sampled: boolean,
 *   rangesEvaluated: number,
 *   rangesTotal: number,
 *   totalMutants: number | null,
 *   failureReason?: string,
 *   partialReason?: string,
 * }} args `failureReason` (`describeStrykerFailure`'s output) and
 *   `partialReason` (`describePartialMutationOutcome`'s output) matter only
 *   when `interrupted` is true.
 * @returns {{
 *   zeroMutants: {reason: string} | null,
 *   partial: {reason: string, evaluated: number, total: number|null} | null,
 * }}
 */
export function decideMutationOutcome({
	interrupted,
	mutants,
	sampled,
	rangesEvaluated,
	rangesTotal,
	totalMutants,
	failureReason,
	partialReason,
}) {
	if (interrupted && mutants.length > 0) {
		return {
			zeroMutants: null,
			partial: {
				reason: partialReason,
				evaluated: mutants.length,
				total: totalMutants,
			},
		};
	}
	if (interrupted) {
		return { zeroMutants: { reason: failureReason }, partial: null };
	}
	if (mutants.length === 0) {
		return {
			zeroMutants: {
				reason: describeZeroMutantOutcome({
					sampled,
					rangesEvaluated,
					rangesTotal,
					totalMutants,
				}),
			},
			partial: null,
		};
	}
	return { zeroMutants: null, partial: null };
}

/**
 * Whether, and with what, the driver should retry a sampled attempt that
 * evaluated 0 mutants (round 2 R2-1 fix #3): re-sample from the ranges NOT
 * yet tried, excluding every range already proven empty, so a retry can
 * never land on the same empty sample twice. `maxAttempts` and the caller's
 * own remaining-budget check both bound the retry, since each attempt costs
 * a full Stryker run.
 *
 * @param {{
 *   allPatterns: string[],
 *   triedPatterns: string[],
 *   keepRangeCount: number,
 *   seed: string,
 *   attemptsSoFar: number,
 *   maxAttempts: number,
 * }} args
 * @returns {{retry: false} | {retry: true, patterns: string[]}}
 */
export function planResample({
	allPatterns,
	triedPatterns,
	keepRangeCount,
	seed,
	attemptsSoFar,
	maxAttempts,
}) {
	if (attemptsSoFar >= maxAttempts) return { retry: false };
	const tried = new Set(triedPatterns);
	const remaining = allPatterns.filter((pattern) => !tried.has(pattern));
	if (remaining.length === 0) return { retry: false };
	const { selected } = sampleRangesDeterministically(
		remaining,
		Math.min(keepRangeCount, remaining.length),
		`${seed}:retry${attemptsSoFar}`,
	);
	return { retry: true, patterns: selected };
}

/**
 * Augments each mutant of a Stryker-shaped report (the completed
 * `reports/mutation/mutation.json`, or the `.stryker/incremental.json` a
 * budget kill leaves behind -- both share the same
 * `{files: {name: {mutants: [...]}}}` shape) IN PLACE with the pre-mutation
 * source snippet and, for a compiled target, the `.ts` location the `.js`
 * survivor maps back to (round 2 S3: column-aware via
 * `mapGeneratedLineToOriginal`'s column argument). Returns the flattened
 * mutant list (each carrying its own `fileName`) and the killed/survived/…
 * counts, shared by both the normal-completion and partial-report paths in
 * the driver so neither drifts from the other, and unit-testable here
 * against literal report fixtures (an injectable `readFile` takes the place
 * of the real filesystem read for the source snippet).
 *
 * @param {object} strykerReport
 * @param {Map<string, {index: object, tsFile: string}>} compiledIndexByJsFile
 * @param {{readFile?: (file: string) => string}} [options]
 */
export function augmentAndSummarize(
	strykerReport,
	compiledIndexByJsFile,
	{ readFile = (file) => readFileSync(file, "utf8") } = {},
) {
	for (const [fileName, file] of Object.entries(strykerReport.files ?? {})) {
		const compiled = compiledIndexByJsFile.get(fileName);
		let sourceLines = null;
		try {
			sourceLines = readFile(fileName).split("\n");
		} catch {
			sourceLines = null;
		}
		for (const mutant of file.mutants ?? []) {
			if (sourceLines)
				mutant.original = extractSnippet(sourceLines, mutant.location);
			if (compiled && mutant.location?.start?.line != null) {
				const column =
					mutant.location.start.column != null
						? mutant.location.start.column - 1
						: undefined;
				const tsLine = mapGeneratedLineToOriginal(
					compiled.index,
					mutant.location.start.line,
					column,
				);
				if (tsLine != null) {
					mutant.tsLocation = { fileName: compiled.tsFile, line: tsLine };
				}
			}
		}
	}

	const mutants = Object.entries(strykerReport.files ?? {}).flatMap(
		([fileName, file]) =>
			(file.mutants ?? []).map((mutant) => ({ ...mutant, fileName })),
	);
	const counts = mutants.reduce((out, mutant) => {
		out[mutant.status] = (out[mutant.status] ?? 0) + 1;
		return out;
	}, {});
	// The mutation-report schema stores no score; Stryker's definition is
	// (killed + timeout) / (total - ignored - no coverage).
	const killed = (counts.Killed ?? 0) + (counts.Timeout ?? 0);
	const denominator =
		mutants.length - (counts.Ignored ?? 0) - (counts.NoCoverage ?? 0);
	const score =
		denominator > 0 ? ((killed / denominator) * 100).toFixed(2) : "n/a";
	return { mutants, counts, score };
}
