import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { availableParallelism } from "node:os";
import { readJsonCache } from "../clients/json-cache-read.js";
import base from "../stryker.config.mjs";
import {
	augmentAndSummarize,
	buildRunConfig,
	capMutationFiles,
	changedLineWeights,
	compiledJsPath,
	decideMutationOutcome,
	dedupePatterns,
	DEFAULT_MAX_FILES,
	DEFAULT_MAX_RANGES,
	describePartialMutationOutcome,
	describeStrykerFailure,
	estimateAffordableMutants,
	formatCapNotice,
	isCompiledMutationSource,
	isMutationSourceFile,
	isScriptMutationFile,
	mapRelatedTests,
	mutationLaneExclusion,
	DEFAULT_MAX_TESTS,
	DEFAULT_MUTATION_FIXED_OVERHEAD_MS,
	MUTATION_BUDGET_MINUTES,
	mutationRangePatterns,
	parseChangedLineRanges,
	parseDryRunCost,
	planResample,
	sampleRangesDeterministically,
} from "./lib/stryker-diff.mjs";
import {
	buildCoverageProbeArgs,
	buildFingerprint,
	changedFingerprintInputs,
	decideIncrementalReuse,
	forkPointOf,
	INCREMENTAL_FINGERPRINT_PATH,
	parseFingerprint,
	parseNameList,
	partitionOwnTests,
	planIncrementalAttempt,
	probeAllTests,
	probeConcurrency,
	probeReportsDirectory,
	PROBE_REPORTS_ROOT,
	probeTestCoverage,
	pruneIncrementalReport,
	readProbeCoverage,
	runProbeProcess,
	selectionNotes,
	selectMutationTests,
	serializeFingerprint,
	withReuseCount,
} from "./lib/mutation-test-selection.mjs";
import { formatTestSelection } from "./lib/mutation-report-render.mjs";
import {
	buildLineIndex,
	countLines,
	createTracer,
	decodeSourceMapRows,
	mapRangesToGenerated,
} from "./lib/mutation-source-map.mjs";
import { acquireSharedSlot } from "./lib/suite-lock.mjs";

const startedAt = Date.now();

// The PR-body corpus is deliberately real and its cold scan is slower under
// Stryker instrumentation than in the ordinary suite. Keep this budget local
// to the mutation command so the normal test contract remains unchanged.
const MUTATION_TEST_TIMEOUT_MS = 30_000;

// Emits `.js.map` next to each compiled `.js` (tsconfig.build.json does not),
// scoped to the directories this lane mutates through compiled output so it
// never dirties scripts/download-grammars.js, the repo's one checked-in
// build exception (see tsconfig.mutation.json).
const MUTATION_TSCONFIG = "tsconfig.mutation.json";
const REPORT_PATH = "reports/mutation/mutation.json";
const INCREMENTAL_PATH = ".stryker/incremental.json";
// Stryker's own file log (enabled by buildRunConfig), cwd-relative and not
// configurable; the driver reads the reuse count from it and deletes it.
const STRYKER_LOG_PATH = "stryker.log";
// One vitest process per related test file, run side by side: bounded by the
// runner's cores, and by the share of the budget the probes may spend.
const PROBE_CONCURRENCY = probeConcurrency(availableParallelism());
const PROBE_TIMEOUT_MS = 180_000;
const PROBE_BUDGET_SHARE = 0.25;
function argumentValue(name, fallback) {
	let value = fallback;
	for (let index = 0; index < process.argv.length - 1; index += 1) {
		if (process.argv[index] === name) value = process.argv[index + 1];
	}
	return value;
}

const baseRef = argumentValue("--base", "origin/master");
const maxFiles = Number(argumentValue("--max-files", DEFAULT_MAX_FILES));
const maxRanges = Number(argumentValue("--max-ranges", DEFAULT_MAX_RANGES));
const budgetMinutes = Number(
	argumentValue("--budget-minutes", MUTATION_BUDGET_MINUTES),
);
const budgetMs = Math.round(budgetMinutes * 60_000);
// round 2 T6: the CI merge-ref SHA (`git rev-parse HEAD` under a
// `pull_request` checkout) is neither the PR's own head commit nor stable
// across re-runs once master moves, so it cannot label a comment a reader
// can match to a PR commit, and it breaks the "same head samples the same
// subset" reproducibility claim. `--head-sha` carries
// `github.event.pull_request.head.sha` from the workflow; local runs (no
// PR event) fall back to `git rev-parse HEAD`.
const headShaArg = argumentValue("--head-sha", null);

// #3853: the driver forks vitest pools for the coverage probes and again inside
// Stryker, so its whole run takes ONE shared test-suite slot, acquired once
// (never per spawn -- no recursive acquisition). The slot covers the Stryker
// child the issue names. `PI_LENS_TEST_NO_LOCK=1`, the same bypass
// with-test-lock honors, skips it when the caller already holds one.
let mutationLock = null;
if (process.env.PI_LENS_TEST_NO_LOCK !== "1") {
	try {
		mutationLock = await acquireSharedSlot({
			log: (message) => console.error(`mutation diff: ${message}`),
		});
	} catch (error) {
		console.error(`mutation diff: ${error.message}`);
		process.exit(1);
	}
	// Stryker runs vitest, and this PR's own driver tests spawn the driver
	// again; the slot above already covers those descendants, so tell them not
	// to re-acquire. Without this the nested driver would wait on its parent.
	process.env.PI_LENS_TEST_NO_LOCK = "1";
}

function changedMutationFiles() {
	try {
		return execFileSync(
			"git",
			["diff", "--name-only", "--diff-filter=AM", `${baseRef}...HEAD`],
			{ encoding: "utf8" },
		)
			.split("\n")
			.map((file) => file.trim())
			.filter(Boolean)
			.filter(isMutationSourceFile);
	} catch (error) {
		console.error(
			`mutation diff: could not read ${baseRef}...HEAD: ${error.message}`,
		);
		process.exit(1);
	}
}

function changedPaths() {
	try {
		return parseNameList(
			execFileSync("git", ["diff", "--name-only", `${baseRef}...HEAD`], {
				encoding: "utf8",
			}),
		);
	} catch (error) {
		console.error(
			`mutation diff: could not read ${baseRef}...HEAD: ${error.message}`,
		);
		process.exit(1);
	}
}

function changedLineRanges(files, { ignoreWhitespace = false } = {}) {
	if (files.length === 0) return new Map();
	try {
		return parseChangedLineRanges(
			execFileSync(
				"git",
				[
					"diff",
					...(ignoreWhitespace ? ["-w"] : []),
					"--unified=0",
					"--diff-filter=AM",
					`${baseRef}...HEAD`,
					"--",
					...files,
				],
				{ encoding: "utf8" },
			),
		);
	} catch (error) {
		console.error(
			`mutation diff: could not read changed lines of ${baseRef}...HEAD: ${error.message}`,
		);
		process.exit(1);
	}
}

function gitHeadSha() {
	try {
		return execFileSync("git", ["rev-parse", "HEAD"], {
			encoding: "utf8",
		}).trim();
	} catch {
		return "unknown-head";
	}
}

const sha = headShaArg ?? gitHeadSha();

function shellQuote(value) {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function writeRunConfig(testFiles, { reuse = false } = {}) {
	mkdirSync(".stryker", { recursive: true });
	const command = [
		"node_modules/.bin/vitest",
		"run",
		"--configLoader",
		"runner",
		"--testTimeout",
		String(MUTATION_TEST_TIMEOUT_MS),
		...testFiles.map(shellQuote),
	].join(" ");
	const config = buildRunConfig(base, { command, reuse });
	const file = ".stryker/diff.config.mjs";
	// A plain object with no functions (verified: every stryker.config.mjs
	// field is JSON-serializable) -- see buildRunConfig's own header for why
	// this replaced a hand-built template-literal string (round 2 T1).
	writeFileSync(
		file,
		`export default ${JSON.stringify(config, null, "\t")};\n`,
	);
	return file;
}

/**
 * Writes the one canonical `reports/mutation/mutation.json` this run
 * produces, whether or not Stryker itself ran. `piLensMutationDiff` is a
 * non-standard top-level key alongside Stryker's own (schemaVersion, files,
 * …); it carries everything `scripts/mutation-report.mjs` and the sticky PR
 * comment need, most importantly `zeroMutants`, which is set on every path
 * that evaluates no mutants so a 0-mutant run can never be rendered as a
 * clean pass, and `partial`, set when a budget kill produced SOME results
 * (round 2 S2) but not all of them.
 */
function writeReport(strykerReport, meta) {
	mkdirSync("reports/mutation", { recursive: true });
	const report = {
		schemaVersion: "mutation-testing-report-schema/1",
		files: {},
		...strykerReport,
		piLensMutationDiff: meta,
	};
	writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
}

// F1 (#3592 round 2): declared here, BEFORE `baseMeta`, not down at the dry-run
// measurement site where it used to live. `baseMeta` is called from FOUR
// early-exit paths above this point (no changed mutation source, no covering
// test, a source-map build failure, no mutation range) -- every one of them
// runs before the dry-run measurement, so a `let` declared past `baseMeta`
// left every early exit in the temporal dead zone: `ReferenceError: Cannot
// access 'costEstimate' before initialization`, thrown OUT OF baseMeta itself,
// with no report ever written and the run exiting 1 as a crash rather than 0
// with a `zeroMutants` report (reproduced live at 69413b03e -- see
// "no PR-changed lines" in the spawn test below).
let costEstimate = null;
let testSelectionMeta = null;
let incrementalMeta = null;

function baseMeta(extra) {
	return {
		generatedAt: new Date().toISOString(),
		base: baseRef,
		headSha: sha,
		budgetMinutes,
		maxFiles,
		maxRanges,
		partial: null,
		// #3592 item 2: the dry-run measurement's total (set once the
		// `--dryRunOnly` measurement parses successfully -- see `costEstimate`
		// above), carried into EVERY report through this one function so the
		// renderer has something to cross-check a completed run's evaluated
		// count against, independent of whether `partial`/`zeroMutants` were
		// correctly set. null before the measurement runs (the early-exit
		// zero-mutant paths above) or when Stryker's dry-run output could not
		// be parsed (`parseDryRunCost` returned null).
		measuredTotalMutants: costEstimate?.totalMutants ?? null,
		testSelection: testSelectionMeta,
		incremental: incrementalMeta,
		...extra,
	};
}

function logSurvivors(mutants) {
	for (const mutant of mutants.filter((entry) => entry.status === "Survived")) {
		const location = mutant.tsLocation
			? `${mutant.tsLocation.fileName}:${mutant.tsLocation.line}`
			: `${mutant.fileName}:${mutant.location?.start?.line ?? "?"}`;
		console.log(`survived: ${location} ${mutant.mutatorName}`);
	}
}

const allChangedPaths = changedPaths();
const allFiles = changedMutationFiles();
// #3810 (from the #3797 review): which files the cap keeps is a matter of how
// much each changed, ignoring whitespace-only lines, not of how it sorts.
const { selected: files, skipped } = capMutationFiles(
	allFiles,
	maxFiles,
	changedLineWeights(changedLineRanges(allFiles, { ignoreWhitespace: true })),
);
if (skipped.length > 0) {
	console.log(formatCapNotice(files.length, allFiles.length, skipped));
}
if (files.length === 0) {
	const reason =
		"no PR-changed lines fall under scripts/**/*.mjs, clients/**/*.ts, tools/**/*.ts, mcp/**/*.ts, or index.ts";
	console.log(`mutation diff: no mutants evaluated; ${reason}`);
	writeReport(
		null,
		baseMeta({ zeroMutants: { reason }, filesSkippedOverCap: skipped }),
	);
	process.exit(0);
}

let selection;
let ownTests = [];
try {
	selection = mapRelatedTests(files);
	// #3810 item 4: the PR's own test files are never dropped -- they are the
	// tests whose survivors the author can act on. A file carrying the
	// mutation-lane exclusion marker is excluded for its registered reason, same
	// as a related one.
	const partition = partitionOwnTests(allChangedPaths, {
		exists: existsSync,
		exclusionOf: (file) => mutationLaneExclusion(file),
		alreadyExcluded: selection.excluded,
	});
	ownTests = partition.own;
	selection.excluded.push(...partition.excluded);
} catch (error) {
	const reason = `mutation diff: invalid mutation-lane exclusion registry (${error.name ?? "Error"}): ${error.message}`;
	console.error(reason);
	writeReport(
		null,
		baseMeta({ zeroMutants: { reason }, filesSkippedOverCap: skipped }),
	);
	process.exit(1);
}
const { covered, uncovered, excluded } = selection;
for (const { file, reason } of excluded) {
	console.log(
		`mutation diff: excluding ${file} from dry-run gating (${reason})`,
	);
}
for (const file of uncovered) {
	console.log(`mutation diff: no covering test for ${file}`);
}
if (covered.length === 0) {
	const reason =
		"no changed mutation source has a covering test (a relative import from a test file, or a conventional tests/<dir>/<name>.test.ts sibling)";
	console.log(`mutation diff: no mutants evaluated; ${reason}`);
	writeReport(
		null,
		baseMeta({
			zeroMutants: { reason },
			filesSkippedOverCap: skipped,
			filesUncovered: uncovered,
			testsExcluded: excluded,
		}),
	);
	process.exit(0);
}

const coveredScripts = covered.filter(isScriptMutationFile);
const coveredCompiled = covered.filter(isCompiledMutationSource);

// round 2 T8: build ONCE, unconditionally, before instrumentation -- even a
// scripts-only diff. A scripts-only local rerun previously skipped this
// build entirely (it ran only `if (coveredCompiled.length > 0)`), so a
// locally stale compiled `.js` from an unrelated earlier edit could defeat
// tests/support/check-build-freshness.ts's guard for the WHOLE run, not
// just the scripts lane's own targets.
console.log(
	`mutation diff: building ${MUTATION_TSCONFIG} once (with source maps) before instrumentation`,
);
const build = spawnSync(
	"node_modules/.bin/tsc",
	["--project", MUTATION_TSCONFIG],
	{ stdio: "inherit" },
);
if (build.error || build.status !== 0) {
	const reason = "the source-map build (tsconfig.mutation.json) failed";
	console.error(`mutation diff: no mutants evaluated; ${reason}`);
	writeReport(
		null,
		baseMeta({
			zeroMutants: { reason },
			filesSkippedOverCap: skipped,
			filesUncovered: uncovered,
		}),
	);
	process.exit(1);
}

// Mutate the diff's own lines, not the whole changed file: whole-file
// instrumentation of scripts/check-pr-body.mjs alone is 2075 mutants, and every
// mutant reruns the related tests, so advisory run 36098718085 evaluated none of
// its 2220 before the 90-minute cap cancelled the job.
const scriptRanges = changedLineRanges(coveredScripts);
const scriptPatterns = mutationRangePatterns(coveredScripts, scriptRanges);

// jsFile -> { index, tsFile }, kept for the reverse (survivor .js:line -> .ts:line)
// mapping after the Stryker run; `index.tracer` (round 2 S3) makes that
// mapping column-aware.
const compiledIndexByJsFile = new Map();
const compiledPatterns = [];
const compiledSkippedNoMap = [];
const compiledSkippedNoLines = [];

const compiledRanges = changedLineRanges(coveredCompiled);
for (const tsFile of coveredCompiled) {
	const jsFile = compiledJsPath(tsFile);
	const mapFile = `${jsFile}.map`;
	if (!existsSync(jsFile) || !existsSync(mapFile)) {
		compiledSkippedNoMap.push(tsFile);
		console.log(
			`mutation diff: no compiled output/source map for ${tsFile}; skipping`,
		);
		continue;
	}
	const rawMap = readJsonCache(
		mapFile,
		(parsed) => parsed,
		(error) => {
			console.log(
				`mutation diff: unreadable source map for ${tsFile} (${error.message}); skipping`,
			);
		},
	);
	if (rawMap === undefined) {
		compiledSkippedNoMap.push(tsFile);
		continue;
	}
	const rows = decodeSourceMapRows(rawMap);
	const index = { ...buildLineIndex(rows), tracer: createTracer(rawMap) };
	const jsContent = readFileSync(jsFile, "utf8");
	const totalGeneratedLines = countLines(jsContent);
	compiledIndexByJsFile.set(jsFile, { index, tsFile });

	const tsRanges = compiledRanges.get(tsFile) ?? [];
	const jsRanges = mapRangesToGenerated(index, tsRanges, totalGeneratedLines);
	if (jsRanges.length === 0 && tsRanges.length > 0) {
		compiledSkippedNoLines.push(tsFile);
		console.log(
			`mutation diff: ${tsFile} changed lines compile to no code (typings/comments only); skipping`,
		);
	}
	for (const [start, end] of jsRanges) {
		compiledPatterns.push(`${jsFile}:${start}-${end}`);
	}
}

// round 2 S3: the same collapsed generated range can arise from two
// different .ts hunks (or a scripts and a compiled pattern landing on an
// identical span); a duplicate spends a range-budget slot on a mutant
// Stryker would test identically the first time.
const allPatterns = dedupePatterns([...scriptPatterns, ...compiledPatterns]);
if (allPatterns.length === 0) {
	const reason =
		"the changed lines compile to no code (typings/comments only) or produced no mutation range";
	console.log(`mutation diff: no mutants evaluated; ${reason}`);
	writeReport(
		null,
		baseMeta({
			zeroMutants: { reason },
			filesSkippedOverCap: skipped,
			filesUncovered: uncovered,
			filesNoSourceMap: compiledSkippedNoMap,
			filesNoMutableLines: compiledSkippedNoLines,
		}),
	);
	process.exit(0);
}

function remainingBudgetMs() {
	return Math.max(0, budgetMs - (Date.now() - startedAt));
}

// #3810 item 1: keep only the test files that execute a changed line. The
// import graph (`selection.tests`) is the candidate pool; one vitest process
// per candidate measures which changed lines it executes, in the coordinates of
// the PR diff (a compiled `.js` reports the `.ts` lines through its source
// map, built above). Coverage is taken on the clean tree, before Stryker
// instruments anything.
const probeRanges = new Map(scriptRanges);
const probeInclude = [...scriptRanges.keys()];
for (const tsFile of coveredCompiled) {
	if (!compiledIndexByJsFile.has(compiledJsPath(tsFile))) continue;
	probeRanges.set(tsFile, compiledRanges.get(tsFile) ?? []);
	probeInclude.push(compiledJsPath(tsFile));
}

const probeSignal = AbortSignal.timeout(
	Math.round(remainingBudgetMs() * PROBE_BUDGET_SHARE),
);

function runProbe(test) {
	return runProbeProcess({
		command: "node_modules/.bin/vitest",
		args: buildCoverageProbeArgs(
			test,
			probeInclude,
			probeReportsDirectory(test),
			{ testTimeoutMs: MUTATION_TEST_TIMEOUT_MS },
		),
		timeoutMs: PROBE_TIMEOUT_MS,
		signal: probeSignal,
	});
}

function readCoverageOf(test) {
	return readProbeCoverage(
		{
			exists: existsSync,
			read: (file) => readFileSync(file, "utf8"),
			remove: (directory) =>
				rmSync(directory, { recursive: true, force: true }),
		},
		probeReportsDirectory(test),
	);
}

rmSync(PROBE_REPORTS_ROOT, { recursive: true, force: true });
const probePool = [...new Set([...selection.tests, ...ownTests])];
console.log(
	`mutation diff: measuring which of ${probePool.length} candidate test file(s) execute a changed line (${PROBE_CONCURRENCY} at a time)`,
);
const probeLines = await probeAllTests(
	probePool,
	(test) =>
		probeTestCoverage(test, {
			run: runProbe,
			readCoverage: readCoverageOf,
			rangesByFile: probeRanges,
		}),
	{
		concurrency: PROBE_CONCURRENCY,
		signal: probeSignal,
	},
);
const choice = selectMutationTests({
	related: selection.tests,
	ownTests,
	priorities: selection.priorities,
	lines: probeLines,
	maxTests: DEFAULT_MAX_TESTS,
});
const tests = choice.kept;
testSelectionMeta = {
	mode: choice.mode,
	pool: choice.pool,
	covering: choice.covering,
	kept: choice.kept.length,
	dropped: choice.dropped.length,
	own: choice.own.length,
	unknown: choice.unknown.length,
};
console.log(`mutation diff: ${formatTestSelection(testSelectionMeta)}`);
for (const note of selectionNotes(choice, DEFAULT_MAX_TESTS)) {
	console.log(`mutation diff: ${note}`);
}
if (tests.length === 0) {
	// Never hand vitest an empty file list: `vitest run` with no filter runs the
	// whole suite.
	const reason =
		"no related test executes a changed line, so every mutant would survive by construction; add a test that runs the changed code";
	console.log(`mutation diff: no mutants evaluated; ${reason}`);
	writeReport(
		null,
		baseMeta({
			zeroMutants: { reason },
			filesSkippedOverCap: skipped,
			filesUncovered: uncovered,
			testsExcluded: excluded,
		}),
	);
	process.exit(0);
}

// round 2 S2: measure the REAL dry-run cost (a fixed range count, however
// chosen, bounds nothing -- 40 ranges yielded 290 mutants and a ~3.4h run
// against #3579's real related-test set of 768 tests, measured 2026-09-26)
// before deciding what fits the budget, via Stryker's own `--dryRunOnly`
// (no mutation testing, no report -- console-only "Instrumented N mutant(s)"
// and "Ran … (net … ms)" lines, `parseDryRunCost` reads both).
console.log(
	`mutation diff: measuring dry-run cost for ${allPatterns.length} candidate range(s)`,
);
const measureConfigFile = writeRunConfig(tests);
const measureResult = spawnSync(
	"node_modules/.bin/stryker",
	["run", "--mutate", allPatterns.join(","), "--dryRunOnly", measureConfigFile],
	{
		stdio: ["ignore", "pipe", "pipe"],
		encoding: "utf8",
		timeout: remainingBudgetMs(),
		killSignal: "SIGTERM",
	},
);
rmSync(STRYKER_LOG_PATH, { force: true });
const measureOutput = `${measureResult.stdout ?? ""}${measureResult.stderr ?? ""}`;
console.log(measureOutput);

let patterns = allPatterns;
let sampled = false;

if (measureResult.error || measureResult.status !== 0) {
	// The measurement dry run IS the real run's own dry run (same tests, same
	// code): if it fails here, the real run would fail identically, so report
	// that failure now instead of spending a second, redundant dry run.
	const reason = describeStrykerFailure(measureResult, budgetMinutes, {
		tests,
		output: measureOutput,
	});
	console.error(reason);
	writeReport(
		null,
		baseMeta({
			zeroMutants: { reason },
			filesSkippedOverCap: skipped,
			filesUncovered: uncovered,
			rangesTotal: allPatterns.length,
			testsRun: tests,
			testsExcluded: excluded,
		}),
	);
	process.exit(1);
}

const cost = parseDryRunCost(measureOutput);
if (!cost) {
	console.log(
		"mutation diff: could not parse Stryker's dry-run cost output; falling back to the default range cap",
	);
	const fallback = sampleRangesDeterministically(allPatterns, maxRanges, sha);
	patterns = fallback.selected;
	sampled = fallback.sampled;
} else {
	costEstimate = cost;
	if (cost.totalMutants === 0) {
		// round 2 R2-2: routed through decideMutationOutcome, the same pure
		// function the post-run and partial branches use below, so this branch
		// is no longer an untested `if` of its own.
		const outcome = decideMutationOutcome({
			interrupted: false,
			mutants: [],
			sampled: false,
			rangesEvaluated: allPatterns.length,
			rangesTotal: allPatterns.length,
			totalMutants: cost.totalMutants,
		});
		console.log(
			`mutation diff: no mutants evaluated; ${outcome.zeroMutants.reason}`,
		);
		writeReport(
			null,
			baseMeta({
				zeroMutants: outcome.zeroMutants,
				filesSkippedOverCap: skipped,
				filesUncovered: uncovered,
				rangesTotal: allPatterns.length,
				testsRun: tests,
			}),
		);
		process.exit(0);
	}
	const allowedMutants = estimateAffordableMutants({
		remainingMs: remainingBudgetMs(),
		dryRunMs: cost.dryRunMs,
		fixedOverheadMs: DEFAULT_MUTATION_FIXED_OVERHEAD_MS,
	});
	if (allowedMutants === 0) {
		const reason =
			"the remaining mutation budget is smaller than the fixed run overhead; no mutant could be evaluated safely";
		console.log(`mutation diff: no mutants evaluated; ${reason}`);
		writeReport(
			null,
			baseMeta({
				zeroMutants: { reason },
				filesSkippedOverCap: skipped,
				filesUncovered: uncovered,
				rangesTotal: allPatterns.length,
				testsRun: tests,
			}),
		);
		process.exit(0);
	}
	if (cost.totalMutants > allowedMutants) {
		const keepRangeCount = Math.max(
			1,
			Math.min(
				maxRanges,
				Math.floor((allPatterns.length * allowedMutants) / cost.totalMutants),
			),
		);
		const resampled = sampleRangesDeterministically(
			allPatterns,
			keepRangeCount,
			sha,
		);
		patterns = resampled.selected;
		sampled = true;
		console.log(
			`mutation diff: measured ${cost.totalMutants} mutant(s) at ${cost.dryRunMs}ms/dry-run; the remaining budget affords ~${allowedMutants}; sampled ${patterns.length} of ${allPatterns.length} ranges deterministically (seed ${sha})`,
		);
	} else {
		console.log(
			`mutation diff: measured ${cost.totalMutants} mutant(s) at ${cost.dryRunMs}ms/dry-run; within the remaining budget, no sampling needed`,
		);
	}
}

// #3810 item 2: may the incremental file restored by the workflow's cache be
// handed to Stryker? Only when the fingerprint of everything a reused result
// depends on matches the one stored beside it (see fingerprintPaths for why
// Stryker's own differ cannot be trusted with the command runner).
const fingerprint = buildFingerprint({
	forkPoint: forkPointOf(
		(args) => execFileSync("git", args, { encoding: "utf8" }),
		baseRef,
		headShaArg ?? "HEAD",
	),
	// The major only: a runner image's patch release of node is not an input.
	nodeVersion: process.versions.node.split(".")[0],
	read: (file) => readFileSync(file, "utf8"),
	changedFiles: allChangedPaths,
	mutatedFiles: files,
	keptTests: tests,
});
const restoredFingerprint = existsSync(INCREMENTAL_FINGERPRINT_PATH)
	? parseFingerprint(readFileSync(INCREMENTAL_FINGERPRINT_PATH, "utf8"))
	: null;
const incrementalDecision = {
	...decideIncrementalReuse({
		hasIncrementalFile: existsSync(INCREMENTAL_PATH),
		previous: restoredFingerprint?.digest ?? null,
		current: fingerprint.digest,
	}),
	changed: [],
};
if (incrementalDecision.state === "cold-inputs-changed") {
	incrementalDecision.changed = changedFingerprintInputs(
		restoredFingerprint.inputs,
		fingerprint.inputs,
	);
}
console.log(
	`mutation diff: incremental cache ${incrementalDecision.state}${incrementalDecision.changed.length > 0 ? ` (${incrementalDecision.changed.join(", ")})` : ""}`,
);

// round 2 R2-1: a deterministic sample can land entirely on ranges Stryker's
// mutator set has none for -- a real #3579 replay at a 15-minute budget
// sampled 1 of 99 ranges (`clients/instance-reaper.js:931-931`, a shorthand-
// property line), while the other 98 together held all 710 measured
// mutants. When the measurement KNOWS mutants exist elsewhere, retry with a
// fresh sample that excludes every range already proven empty (planResample)
// instead of reporting that verdict for the run's very first, possibly
// unlucky, sample. Each attempt costs a full Stryker run, so this is bounded
// by both MAX_RESAMPLE_ATTEMPTS and the shrinking remaining budget.
const MAX_RESAMPLE_ATTEMPTS = 3;
const triedPatternSet = new Set();
let triedPatterns = [];
let attempt = 0;

for (;;) {
	for (const pattern of patterns) triedPatternSet.add(pattern);
	triedPatterns = [...triedPatternSet];
	// The incremental file is rewritten below regardless (force, round 2 T4),
	// but clearing it before every attempt means neither a run that never
	// reaches Stryker nor a PRIOR (empty) attempt in this same resample loop
	// leaves a STALE file for the next attempt, or some later, unrelated local
	// invocation, to trip over. The one exception is the first attempt when the
	// restored file's fingerprint matched: it is pruned to this run's ranges
	// and kept, and the fingerprint stored beside it is renewed.
	const incrementalPlan = planIncrementalAttempt({
		attempt,
		decision: incrementalDecision,
	});
	incrementalMeta = incrementalPlan.meta;
	const reuse = incrementalPlan.reuse;
	if (!reuse) rmSync(INCREMENTAL_PATH, { force: true });
	writeFileSync(
		INCREMENTAL_FINGERPRINT_PATH,
		serializeFingerprint(fingerprint),
	);
	const configFile = writeRunConfig(tests, { reuse });
	rmSync(STRYKER_LOG_PATH, { force: true });

	console.log(`mutation diff: mutating ${patterns.join(", ")}`);
	const testSummary =
		tests.join(", ").length <= 240 ? `; selected: ${tests.join(", ")}` : "";
	console.log(
		`mutation diff: running ${tests.length} test file(s), ${formatTestSelection(testSelectionMeta)}${testSummary}`,
	);
	console.log(`mutation diff: budget ${budgetMinutes} minute(s)`);
	const result = spawnSync(
		"node_modules/.bin/stryker",
		["run", "--mutate", patterns.join(","), configFile],
		{
			stdio: "inherit",
			encoding: "utf8",
			timeout: remainingBudgetMs(),
			killSignal: "SIGTERM",
		},
	);

	incrementalMeta = withReuseCount(
		incrementalMeta,
		existsSync(STRYKER_LOG_PATH) ? readFileSync(STRYKER_LOG_PATH, "utf8") : "",
	);
	rmSync(STRYKER_LOG_PATH, { force: true });

	if (result.error || result.status !== 0) {
		// round 2 S2: a budget kill (or any other interrupt) can still leave a
		// PARTIAL result Stryker itself saved (`.stryker/incremental.json`,
		// force:true keeps `incremental` enabled so this write-on-interrupt path
		// stays live -- see buildRunConfig). Report what DID run, labelled
		// partial, instead of a blanket "no mutants evaluated" that discards
		// real signal the run already paid for. No retry on an interrupt: the
		// remaining budget that would fund one is exactly what just ran out.
		let partialMutants = [];
		let partialReport = null;
		let partialCounts = {};
		let partialScore = "n/a";
		if (existsSync(INCREMENTAL_PATH)) {
			try {
				partialReport = pruneIncrementalReport(
					JSON.parse(readFileSync(INCREMENTAL_PATH, "utf8")),
					patterns,
				);
				({
					mutants: partialMutants,
					counts: partialCounts,
					score: partialScore,
				} = augmentAndSummarize(partialReport, compiledIndexByJsFile));
			} catch (error) {
				console.error(
					`mutation diff: partial report unreadable: ${error.message}`,
				);
			}
		}
		// round 2 R2-2: routed through decideMutationOutcome, the same
		// function the two zero-mutant branches use, so a mutation of any of
		// the three original independent conditions is caught by one shared
		// test surface rather than none.
		const outcome = decideMutationOutcome({
			interrupted: true,
			mutants: partialMutants,
			sampled,
			rangesEvaluated: triedPatterns.length,
			rangesTotal: allPatterns.length,
			totalMutants: costEstimate?.totalMutants ?? null,
			failureReason: describeStrykerFailure(result, budgetMinutes, { tests }),
			partialReason: describePartialMutationOutcome(result, budgetMinutes, {
				evaluated: partialMutants.length,
				total: costEstimate?.totalMutants ?? null,
			}),
		});
		if (outcome.partial) {
			console.error(outcome.partial.reason);
			console.log(
				`mutation diff: partial report -- ${outcome.partial.evaluated} of ${outcome.partial.total ?? "an unknown total of"} mutant(s) evaluated before the interrupt`,
			);
			logSurvivors(partialMutants);
			writeReport(
				partialReport,
				baseMeta({
					zeroMutants: null,
					partial: outcome.partial,
					filesSkippedOverCap: skipped,
					filesUncovered: uncovered,
					rangesTotal: allPatterns.length,
					rangesEvaluated: triedPatterns.length,
					rangesSampled: sampled,
					testsRun: tests,
					counts: partialCounts,
					score: partialScore,
				}),
			);
		} else {
			console.error(describeStrykerFailure(result, budgetMinutes, { tests }));
			writeReport(
				null,
				baseMeta({
					zeroMutants: outcome.zeroMutants,
					filesSkippedOverCap: skipped,
					filesUncovered: uncovered,
					rangesTotal: allPatterns.length,
					rangesEvaluated: triedPatterns.length,
					rangesSampled: sampled,
					testsRun: tests,
				}),
			);
		}
		process.exit(1);
	}

	if (!existsSync(REPORT_PATH)) {
		console.error("mutation diff: report not found after Stryker run");
		writeReport(
			null,
			baseMeta({
				zeroMutants: { reason: "Stryker produced no report file" },
				filesSkippedOverCap: skipped,
			}),
		);
		process.exit(1);
	}

	let strykerReport;
	try {
		// Stryker re-adds every old result whose mutant is outside this run's
		// ranges (a hunk since reverted, a range the sample left out); only the
		// mutants it just placed carry current line numbers, so the filter must run
		// on the report, not on the file it read.
		strykerReport = pruneIncrementalReport(
			JSON.parse(readFileSync(REPORT_PATH, "utf8")),
			patterns,
		);
	} catch (error) {
		console.error(`mutation diff: report unreadable: ${error.message}`);
		process.exit(1);
	}
	// The mutation-report schema keys mutants by file; the entries themselves
	// carry no file name (spike 2026-09-09 printed `survived: undefined:59`).
	const { mutants, counts, score } = augmentAndSummarize(
		strykerReport,
		compiledIndexByJsFile,
	);
	// round 4 R3-1: computed ONCE, right after augmentAndSummarize, and every
	// branch below reads ITS decision (`outcome.zeroMutants`) rather than
	// re-deriving `mutants.length > 0` as an inline duplicate -- the review
	// found that raw duplicate removable (mutated to `>= 0`) with all four
	// mutation test files still green, since nothing but this one `if` ever
	// looked at it. `renderMutationMarkdown` (`scripts/lib/mutation-report-
	// render.mjs`) also backstops this at the render seam independent of the
	// driver, in case a later branch reintroduces the same gap.
	const outcome = decideMutationOutcome({
		interrupted: false,
		mutants,
		sampled,
		rangesEvaluated: triedPatterns.length,
		rangesTotal: allPatterns.length,
		totalMutants: costEstimate?.totalMutants ?? null,
	});

	if (!outcome.zeroMutants) {
		console.log(`mutation diff score: ${score}`);
		console.log(`mutation diff counts: ${JSON.stringify(counts)}`);
		logSurvivors(mutants);
		writeReport(
			strykerReport,
			baseMeta({
				zeroMutants: null,
				filesSkippedOverCap: skipped,
				filesUncovered: uncovered,
				filesNoSourceMap: compiledSkippedNoMap,
				filesNoMutableLines: compiledSkippedNoLines,
				rangesTotal: allPatterns.length,
				rangesEvaluated: triedPatterns.length,
				rangesSampled: sampled,
				testsRun: tests,
				testsExcluded: excluded,
				counts,
				score,
			}),
		);
		break;
	}

	// round 2 S1: a full run that instruments and executes 0 mutants (every
	// changed-line token this diff produced is one Stryker's mutator set has
	// no operator for -- a property-shorthand addition, a destructuring
	// entry) must not render as a normal, scoreless "clean pass". round 2
	// R2-1: before reporting that, try a fresh sample if this run's sample is
	// the reason, not the changed lines themselves.
	const plan = sampled
		? planResample({
				allPatterns,
				triedPatterns,
				keepRangeCount: patterns.length,
				seed: sha,
				attemptsSoFar: attempt,
				maxAttempts: MAX_RESAMPLE_ATTEMPTS,
			})
		: { retry: false };
	attempt += 1;

	if (!plan.retry || remainingBudgetMs() <= 0) {
		console.log(
			`mutation diff: no mutants evaluated; ${outcome.zeroMutants.reason}`,
		);
		writeReport(
			strykerReport,
			baseMeta({
				zeroMutants: outcome.zeroMutants,
				filesSkippedOverCap: skipped,
				filesUncovered: uncovered,
				filesNoSourceMap: compiledSkippedNoMap,
				filesNoMutableLines: compiledSkippedNoLines,
				rangesTotal: allPatterns.length,
				rangesEvaluated: triedPatterns.length,
				rangesSampled: sampled,
				testsRun: tests,
			}),
		);
		process.exit(0);
	}

	console.log(
		`mutation diff: ${patterns.length} sampled range(s) held 0 mutants; retrying with ${plan.patterns.length} more of the ${allPatterns.length - triedPatterns.length} not yet tried (attempt ${attempt} of ${MAX_RESAMPLE_ATTEMPTS})`,
	);
	patterns = plan.patterns;
}

console.log("mutation diff: completed");
if (mutationLock) await mutationLock.release();
