// flake-shape: real-process-spawn — F1's defect (#3592 round 2) is a
// temporal-dead-zone crash that only exists in the driver's OWN top-level
// execution order; the driver is a top-level script this suite cannot
// import (see the "stated exception" notes below), and a source-text
// assertion alone already passed under the crash (the wiring test for
// #3592 item 2 checked the literal text existed, not that calling
// `baseMeta` before it ran was safe). Only spawning the real script against
// a real, throwaway git fixture reproduces the actual TDZ ordering bug.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gitExecFileSync } from "../../scripts/lib/git-fixture-env.mjs";
import {
	augmentAndSummarize,
	buildRunConfig,
	capMutationFiles,
	compiledJsPath,
	decideMutationOutcome,
	dedupePatterns,
	describePartialMutationOutcome,
	describeStrykerFailure,
	describeZeroMutantOutcome,
	DEFAULT_MAX_RANGES,
	DEFAULT_MAX_TESTS,
	DEFAULT_MUTATION_FIXED_OVERHEAD_MS,
	estimateAffordableMutants,
	extractSnippet,
	formatCapNotice,
	isCompiledMutationSource,
	isMutationSourceFile,
	isScriptMutationFile,
	mapRelatedTests,
	mutationLaneExclusion,
	MutationLaneExclusionError,
	MUTATION_BUDGET_MINUTES,
	mutationRangePatterns,
	parseChangedLineRanges,
	parseDryRunCost,
	planResample,
	sampleRangesDeterministically,
} from "../../scripts/lib/stryker-diff.mjs";
import yaml from "../../clients/deps/js-yaml.js";
import { stripSource } from "../support/sweep-kit.js";
import {
	buildLineIndex,
	createTracer,
	decodeSourceMapRows,
} from "../../scripts/lib/mutation-source-map.mjs";

const config = readFileSync(
	resolve(import.meta.dirname, "../../stryker.config.mjs"),
	"utf8",
);
const driver = readFileSync(
	resolve(import.meta.dirname, "../../scripts/stryker-diff.mjs"),
	"utf8",
);
const workflow = readFileSync(
	resolve(import.meta.dirname, "../../.github/workflows/mutation.yml"),
	"utf8",
);

const repositoryRoot = resolve(import.meta.dirname, "../..");
const driverPath = join(repositoryRoot, "scripts", "stryker-diff.mjs");

describe("driver early-exit paths, spawned for real (#3592 round 2 F1)", () => {
	// Recurrence this guards: `baseMeta` (called from four early-exit paths --
	// no changed mutation source, no covering test, a source-map build
	// failure, no mutation range) read a `let costEstimate` that was declared
	// LOWER in the file, past every one of those call sites. Every early exit
	// therefore called `baseMeta` while `costEstimate` sat in the temporal
	// dead zone, throwing `ReferenceError: Cannot access 'costEstimate'
	// before initialization` out of the driver with no report written and
	// exit code 1 -- the sticky comment renders that as "Stale ... a crash"
	// rather than the intended zero-mutant advisory. A source-text check on
	// the driver cannot catch this: the literal text is correct either
	// way, only the ORDER of
	// two statements in the real module differs. This spawns the actual
	// script against a real, throwaway git repo -- no relative import,
	// mock, or source-text substitute reproduces a temporal-dead-zone crash.
	it("exits 0 with a zero-mutant report when no changed line falls under a mutated glob, instead of crashing on costEstimate's TDZ", () => {
		const fixtureRepo = mkdtempSync(
			join(repositoryRoot, ".tmp-stryker-diff-fixture-"),
		);
		try {
			// One commit, no files under scripts/**/*.mjs, clients/**/*.ts,
			// tools/**/*.ts, mcp/**/*.ts, or index.ts -- `--base HEAD` then diffs
			// HEAD against itself (empty), landing on the very first early-exit
			// branch (`files.length === 0`), the earliest of the four vulnerable
			// call sites.
			writeFileSync(join(fixtureRepo, "README.md"), "fixture\n");
			gitExecFileSync(["init", "-q"], { cwd: fixtureRepo });
			gitExecFileSync(["add", "README.md"], { cwd: fixtureRepo });
			gitExecFileSync(
				[
					"-c",
					"user.email=pi-lens-test@example.com",
					"-c",
					"user.name=pi-lens-test",
					"commit",
					"-qm",
					"fixture",
				],
				{ cwd: fixtureRepo },
			);

			const result = execFileSync(
				process.execPath,
				[driverPath, "--base", "HEAD"],
				{ cwd: fixtureRepo, encoding: "utf8", timeout: 30_000 },
			);

			expect(result).toContain("no mutants evaluated");
			expect(result).not.toContain("ReferenceError");
			const report = JSON.parse(
				readFileSync(
					join(fixtureRepo, "reports", "mutation", "mutation.json"),
					"utf8",
				),
			);
			expect(report.piLensMutationDiff.zeroMutants.reason).toContain(
				"no PR-changed lines fall under",
			);
			// #3592 item 2's own field must survive an early exit too -- null,
			// since the dry-run measurement never ran, not a crash-shaped absence.
			// #3592 item 2: every report carries the dry-run total through
			// baseMeta (null here: this early exit precedes the measurement). A
			// behavioural pin, not a source-text one: the mutation lane
			// instruments this driver's changed lines, so a literal-text check
			// of them fails inside Stryker's own dry run.
			expect(report.piLensMutationDiff).toHaveProperty(
				"measuredTotalMutants",
				null,
			);
		} finally {
			rmSync(fixtureRepo, { recursive: true, force: true });
		}
	});
});

describe("stryker diff selection", () => {
	it.each([
		["extensionless", 'import "../../scripts/lib/ci-checks"'],
		["javascript extension", 'import "../../scripts/lib/ci-checks.js"'],
		["module extension", 'import "../../scripts/lib/ci-checks.mjs"'],
		["side-effect", 'import "../../scripts/lib/ci-checks"'],
		["dynamic", 'await import("../../scripts/lib/ci-checks")'],
	])("maps %s relative imports to the changed script", (_form, source) => {
		// Recurrence: extension spelling and import form must not hide a related
		// test from the incremental mutation lane.
		const result = mapRelatedTests(["scripts/lib/ci-checks.mjs"], {
			testFiles: ["tests/scripts/related.test.ts"],
			readFile: () => source,
		});

		expect(result.related.get("scripts/lib/ci-checks.mjs")).toEqual(
			new Set(["tests/scripts/related.test.ts"]),
		);
	});

	it("maps changed scripts to imported and conventional sibling tests", () => {
		// Recurrence: the mutation lane must run tests that import the changed
		// script, including scripts without a same-path test mirror.
		const result = mapRelatedTests(
			["scripts/lib/ci-checks.mjs", "scripts/guard-bash.mjs"],
			{
				testFiles: [
					"tests/scripts/ci-verdict.test.ts",
					"tests/scripts/guard-bash.test.ts",
				],
				readFile: (file) =>
					file.includes("ci-verdict")
						? 'import checks from "../../scripts/lib/ci-checks.mjs"'
						: "",
			},
		);

		expect(result.related.get("scripts/lib/ci-checks.mjs")).toEqual(
			new Set(["tests/scripts/ci-verdict.test.ts"]),
		);
		expect(result.related.get("scripts/guard-bash.mjs")).toEqual(
			new Set(["tests/scripts/guard-bash.test.ts"]),
		);
		expect(result.tests).toEqual([
			"tests/scripts/ci-verdict.test.ts",
			"tests/scripts/guard-bash.test.ts",
		]);
	});

	it("reports changed scripts with no covering test instead of silently selecting none", () => {
		// Recurrence: a changed mutation target without a related test must be a
		// review finding, not an accidental green mutation run.
		const result = mapRelatedTests(["scripts/uncovered.mjs"], {
			testFiles: ["tests/scripts/other.test.ts"],
			readFile: () => "",
		});

		expect(result.uncovered).toEqual(["scripts/uncovered.mjs"]);
		expect(result.covered).toEqual([]);
		expect(result.tests).toEqual([]);
	});

	it("caps the mutation population alphabetically and names skipped files", () => {
		// Recurrence: an unbounded changed-script population can turn the
		// advisory lane into an unbounded CI cost.
		const result = capMutationFiles(
			["scripts/z.mjs", "scripts/a.mjs", "scripts/m.mjs"],
			2,
		);

		expect(result.selected).toEqual(["scripts/a.mjs", "scripts/m.mjs"]);
		expect(result.skipped).toEqual(["scripts/z.mjs"]);
		expect(formatCapNotice(2, 3, result.skipped)).toBe(
			"capped: 2 of 3 changed files mutated; skipped: scripts/z.mjs",
		);
	});

	it("ranks the conventional sibling ahead of a direct importer and ties the cap to its measurement", () => {
		// Recurrence: the import-graph priority (sibling 0, importer 1) is the
		// tie-break the coverage ranking in mutation-test-selection.mjs reads, and
		// DEFAULT_MAX_TESTS must stay checked against the evidence it cites, or the
		// constant can silently drift from the budget (M3648-3).
		const result = mapRelatedTests(["clients/server.ts"], {
			testFiles: [
				"tests/clients/server.test.ts",
				"tests/clients/direct.test.ts",
			],
			readFile: (file) =>
				file.includes("direct") ? 'import "../../clients/server.js"' : "",
		});
		expect(result.tests).toEqual([
			"tests/clients/server.test.ts",
			"tests/clients/direct.test.ts",
		]);
		expect(result.priorities.get("tests/clients/server.test.ts")).toBe(0);
		expect(result.priorities.get("tests/clients/direct.test.ts")).toBe(1);
		const measurement = JSON.parse(
			readFileSync("tests/fixtures/mutation-test-cap-measurement.json", "utf8"),
		);
		expect(measurement.proxy.projectedElapsedSeconds).toBe(
			measurement.proxy.meanElapsedSeconds * measurement.proxy.projectedSuites,
		);
		expect(measurement.proxy.remainingHeadroomSeconds).toBe(
			measurement.proxy.budgetSeconds -
				measurement.proxy.projectedElapsedSeconds,
		);
		expect(DEFAULT_MAX_TESTS).toBe(measurement.recommendedMaxTests);
	});

	it("keeps the mutation population on scripts mjs files", () => {
		// Recurrence: mutating compiled clients or test sources produces vacuous
		// mutants because this lane activates the built runtime in memory.
		expect(isScriptMutationFile("scripts/hooks/guard-bash.mjs")).toBe(true);
		expect(isScriptMutationFile("scripts/example.test.mjs")).toBe(false);
		expect(isScriptMutationFile("clients/runtime.ts")).toBe(false);
		expect(config).toContain('testRunner: "command"');
		expect(config).toContain(
			'command: "node_modules/.bin/vitest run --configLoader runner"',
		);
		expect(config).toContain('"scripts/**/*.mjs", "!scripts/**/*.test.mjs"');
		expect(config).toContain('coverageAnalysis: "off"');
		expect(config).not.toContain("vitest:");
		// Spike 2026-09-09: TypeScript 7 lacks the API Stryker's sandbox tsconfig
		// preprocessor calls, so the lane mutates in place; the in-place reset
		// drops compiled clients/*.js, so one build runs before the dry run.
		// Neither implies a per-mutant rebuild: the population is .mjs run directly.
		expect(config).toContain('buildCommand: "npm run build"');
		expect(config).toContain("inPlace: true");
		expect(config).not.toContain("clients/");
		expect(driver).toContain('"--testTimeout"');
		expect(driver).toContain("MUTATION_TEST_TIMEOUT_MS = 30_000");
	});
});

describe("stryker diff mutation ranges", () => {
	it("reads the new-side line range of every hunk, per file", () => {
		// Recurrence: run 36098718085 instrumented 2220 whole-file mutants and
		// evaluated none inside the 90-minute cap. The lane must mutate the diff's
		// own lines, and it must read the "+" side of the hunk header: the "-"
		// side numbers lines in the base, so mutants would land on unrelated
		// HEAD lines.
		const diff = [
			"diff --git a/scripts/one.mjs b/scripts/one.mjs",
			"--- a/scripts/one.mjs",
			"+++ b/scripts/one.mjs",
			"@@ -394 +394 @@ const cache = new Map();",
			"-old",
			"+new",
			"@@ -761 +761,5 @@ function extract(value) {",
			"-old",
			"+a",
			"+b",
			"+c",
			"+d",
			"+e",
			"diff --git a/scripts/two.mjs b/scripts/two.mjs",
			"--- a/scripts/two.mjs",
			"+++ b/scripts/two.mjs",
			"@@ -10,0 +11,5 @@ import {",
			"+one",
			"",
		].join("\n");

		expect(parseChangedLineRanges(diff)).toEqual(
			new Map([
				[
					"scripts/one.mjs",
					[
						[394, 394],
						[761, 765],
					],
				],
				["scripts/two.mjs", [[11, 15]]],
			]),
		);
	});

	it("keeps a deletion-only hunk inside a one-line range Stryker accepts", () => {
		// Recurrence: "+c,0" (and "+0,0" at the top of a file) would compute an
		// end line below the start line, and Stryker rejects an inverted mutation
		// range during options validation — zero mutants, before the dry run.
		const diff = [
			"+++ b/scripts/one.mjs",
			"@@ -40,3 +39,0 @@ function gone() {",
			"-a",
			"@@ -1,2 +0,0 @@",
			"-header",
			"",
		].join("\n");

		expect(parseChangedLineRanges(diff)).toEqual(
			new Map([
				[
					"scripts/one.mjs",
					[
						[39, 39],
						[1, 1],
					],
				],
			]),
		);
	});

	it("builds one Stryker mutate pattern per range and skips files with none", () => {
		// Recurrence: a bare path in --mutate is read by Stryker as "mutate the
		// whole file", which is exactly the 2220-mutant population that made the
		// lane evaluate nothing.
		const ranges = new Map<string, Array<[number, number]>>([
			[
				"scripts/one.mjs",
				[
					[394, 394],
					[761, 765],
				],
			],
			["scripts/other.mjs", [[3, 4]]],
		]);

		expect(
			mutationRangePatterns(
				["scripts/one.mjs", "scripts/mode-only.mjs"],
				ranges,
			),
		).toEqual(["scripts/one.mjs:394-394", "scripts/one.mjs:761-765"]);
	});
});

describe("stryker diff wall-clock budget", () => {
	it("bounds the driver strictly below the advisory job cap", () => {
		// Recurrence: run 36098718085 was cancelled by the runner at
		// timeout-minutes, so the driver never regained control and its
		// "no mutants evaluated" message never printed. The driver's own bound
		// must leave the job room to report it.
		const cap = Number(/timeout-minutes:\s*(\d+)/.exec(workflow)?.[1]);

		expect(cap).toBeGreaterThan(0);
		expect(MUTATION_BUDGET_MINUTES).toBeLessThan(cap);
		expect(cap - MUTATION_BUDGET_MINUTES).toBeGreaterThanOrEqual(20);
	});

	it("names the budget as the cause when Stryker is killed at the bound", () => {
		// Recurrence: "the budget ran out" must not be reported with the same
		// wording as "the dry run failed", or issue #2991's distinction between
		// "I tested nothing" and "I tested and found nothing" is lost again.
		// Measured: spawnSync reports an expired timeout as error.code
		// ETIMEDOUT, and signal is null when the child exits on the signal
		// itself -- Stryker's UnexpectedExitHandler does exactly that.
		const expired = describeStrykerFailure(
			{
				status: 143,
				signal: null,
				error: Object.assign(new Error("spawnSync ETIMEDOUT"), {
					code: "ETIMEDOUT",
				}),
			},
			60,
		);

		expect(expired).toContain("no mutants evaluated");
		expect(expired).toContain("60-minute mutation budget expired");

		const failed = describeStrykerFailure(
			{ status: 1, signal: null, error: undefined },
			60,
		);

		expect(failed).toContain("no mutants evaluated");
		expect(failed).toContain("Stryker status 1");
		expect(failed).not.toContain("budget expired");
	});

	it("wires the budget into the Stryker child and the mutate patterns", () => {
		// Recurrence: a formatted budget message with no bound on the child is
		// inert -- the runner still cancels the job. The executable proof is the
		// quoted budget-expiry transcript in the PR body; this pins the wiring in
		// the driver, which is a top-level script and cannot be imported. Round 2:
		// the literal `timeout: budgetMs` this pinned before is gone -- the
		// driver now bounds each Stryker child by the BUDGET REMAINING after
		// time already spent (the dry-run cost measurement, the build), via
		// `remainingBudgetMs()` -- so this now pins that function's own use as
		// the timeout, not the removed literal.
		expect(driver).toContain("timeout: remainingBudgetMs()");
		expect(driver).toContain("--budget-minutes");
		expect(driver).toContain("mutationRangePatterns");
		expect(driver).toContain("describeStrykerFailure");
	});

	it("wires the resample loop through planResample and decideMutationOutcome, not a hand-rolled duplicate (#3531 round 3 R2-1/R2-2)", () => {
		// Recurrence: planResample and decideMutationOutcome are fully
		// mutation-proved as pure functions above (every branch reds under a
		// direct mutation of scripts/lib/stryker-diff.mjs -- see the PR body's
		// mutation table), but the driver ITSELF is a top-level script this
		// suite cannot import and exercise end to end. A real live replay that
		// forces the sampler onto an empty range and then proves the retry
		// fires a SECOND real Stryker child needs multi-run Stryker-scale
		// timing (the review's own #3579 replay at a 15-minute budget ran
		// ~19 minutes wall-clock end to end, s2-3579.log) -- out of proportion
		// to prove twice for a loop whose every DECISION point is already
		// pinned above. This assertion is the stated exception's closest
		// executable check: the driver actually calls the pinned functions,
		// not a re-implementation that could silently diverge from them.
		expect(driver).toContain("planResample({");
		expect(driver).toContain("decideMutationOutcome({");
		expect(driver).toContain("MAX_RESAMPLE_ATTEMPTS");
	});

	it("builds the per-run Stryker config through buildRunConfig, not a hand-rolled duplicate", () => {
		// Recurrence (round 1 T1): a driver that builds its own config inline
		// can drift from -- or simply not call -- the tested, guarded
		// `buildRunConfig` (see the "buildRunConfig" describe block below for
		// the actual buildCommand-override proof, tested against the generated
		// object rather than source text).
		expect(driver).toContain("buildRunConfig(base,");
		expect(driver).not.toContain("buildCommand:");
	});
});

describe("coverage selection and incremental cache wiring (#3810)", () => {
	// Stated exception (same as the resample-loop pin above): the driver is a
	// top-level script this suite cannot import. The decision points are pinned
	// as pure functions in mutation-test-selection.test.ts; these pin that the
	// driver calls them with the inputs the brief names. The executable check is
	// the real driver run on #3794's head quoted in the PR body
	// ("related 72 -> covering 16 -> kept 16 (3 own)") and the two-push cache
	// proof on the PR's own mutation job.
	const code = stripSource(driver);

	it("feeds the PR's own tests and the import-graph priorities into the selector, with probed coverage", () => {
		expect(code).toContain("ownTestFiles(allChangedPaths)");
		expect(code).toContain("selectMutationTests({");
		expect(code).toContain("ownTests,");
		expect(code).toContain("priorities: selection.priorities,");
		expect(code).toContain("lines: probeLines,");
		expect(code).toContain("probeAllTests(");
	});

	it("never hands vitest an empty test list (S10)", () => {
		expect(code).toMatch(
			/if \(tests\.length === 0\) \{[\s\S]*?process\.exit\(0\);/,
		);
	});

	it("reads the restored incremental file only through the fingerprint decision, pruned to the current ranges", () => {
		expect(code).toContain("decideIncrementalReuse({");
		expect(code).toContain("pruneIncrementalReport(");
		expect(code).toContain("reuse: reuse && incrementalMeta.state");
		expect(code).toContain("keptTests: tests,");
		expect(code).toContain("mutatedFiles: files,");
	});

	it("does not keep the old alphabetical cap", () => {
		expect(code).not.toContain("capRelatedTests");
		expect(driver).not.toContain("formatTestCapNotice");
	});
});

describe("mutation workflow incremental cache (#3810 item 2)", () => {
	type Step = {
		name?: string;
		uses?: string;
		run?: string;
		if?: string;
		with?: { path?: string; key?: string; "restore-keys"?: string };
	};
	const steps = (
		yaml.load(workflow) as { jobs: { mutation: { steps: Step[] } } }
	).jobs.mutation.steps;
	const restoreIndex = steps.findIndex((step) =>
		step.uses?.startsWith("actions/cache/restore@"),
	);
	const saveIndex = steps.findIndex((step) =>
		step.uses?.startsWith("actions/cache/save@"),
	);
	const driverIndex = steps.findIndex((step) =>
		step.run?.includes("scripts/stryker-diff.mjs"),
	);

	it("restores before the driver and saves after it, even when the driver fails", () => {
		expect(restoreIndex).toBeGreaterThan(-1);
		expect(restoreIndex).toBeLessThan(driverIndex);
		expect(saveIndex).toBeGreaterThan(driverIndex);
		expect(steps[saveIndex]?.if).toBe("always()");
	});

	it("keys on the PR number and the base sha, restoring by that prefix (C3, C7)", () => {
		const restore = steps[restoreIndex]?.with;
		const save = steps[saveIndex]?.with;
		const prefix =
			"mutation-incremental-${{ github.event.pull_request.number }}-${{ github.event.pull_request.base.sha }}-";
		expect(restore?.["restore-keys"]?.trim()).toBe(prefix);
		expect(restore?.key).toBe(
			`${prefix}\${{ github.event.pull_request.head.sha }}`,
		);
		expect(save?.key).toBe(restore?.key);
	});

	it("caches exactly the incremental file and its fingerprint, both ways", () => {
		for (const index of [restoreIndex, saveIndex]) {
			expect(steps[index]?.with?.path?.trim().split("\n")).toEqual([
				".stryker/incremental.json",
				".stryker/incremental.fingerprint",
			]);
		}
		expect(driverCachePaths()).toEqual([
			".stryker/incremental.json",
			".stryker/incremental.fingerprint",
		]);
	});

	it("pins both cache actions by commit sha", () => {
		for (const index of [restoreIndex, saveIndex]) {
			expect(steps[index]?.uses).toMatch(
				/^actions\/cache\/(?:restore|save)@[0-9a-f]{40}$/,
			);
		}
	});
});

function driverCachePaths(): string[] {
	// The driver's constants are the other half of the contract: the workflow
	// caches what the driver reads and writes.
	const inc = /INCREMENTAL_PATH = "([^"]+)"/.exec(driver)?.[1];
	const fp = /FINGERPRINT_PATH = "([^"]+)"/.exec(driver)?.[1];
	return [inc ?? "", fp ?? ""];
}

describe("compiled-source mutation targets (#3531 rescope)", () => {
	it("classifies clients/tools/mcp .ts sources and the root index.ts, excluding tests and .d.ts", () => {
		expect(isCompiledMutationSource("clients/atomic-write.ts")).toBe(true);
		expect(isCompiledMutationSource("clients/lsp/inferred-project.ts")).toBe(
			true,
		);
		expect(isCompiledMutationSource("tools/lens-diagnostics.ts")).toBe(true);
		expect(isCompiledMutationSource("mcp/server.ts")).toBe(true);
		expect(isCompiledMutationSource("index.ts")).toBe(true);

		expect(isCompiledMutationSource("clients/atomic-write.test.ts")).toBe(
			false,
		);
		expect(isCompiledMutationSource("clients/some-types.d.ts")).toBe(false);
		expect(isCompiledMutationSource("scripts/lib/ci-checks.mjs")).toBe(false);
		expect(isCompiledMutationSource("tests/clients/atomic-write.test.ts")).toBe(
			false,
		);
		// Recurrence: mutating the .ts source directly (rather than the
		// compiled .js the tests execute) produces vacuous mutants -- the
		// scripts-only classifier must stay false for every compiled class.
		expect(isScriptMutationFile("clients/atomic-write.ts")).toBe(false);
	});

	it("computes the compiled sibling with no outDir remap", () => {
		// Recurrence: tsconfig.build.json has no outDir, so tsc writes .js next
		// to .ts (verified against a real build, 2026-09-26) -- a compiledJsPath
		// that assumed a dist/ prefix would point at a file that never exists.
		expect(compiledJsPath("clients/atomic-write.ts")).toBe(
			"clients/atomic-write.js",
		);
		expect(compiledJsPath("clients/lsp/inferred-project.ts")).toBe(
			"clients/lsp/inferred-project.js",
		);
		expect(compiledJsPath("index.ts")).toBe("index.js");
	});

	it("is a mutation source file through the union, whether scripted or compiled", () => {
		expect(isMutationSourceFile("scripts/lib/ci-checks.mjs")).toBe(true);
		expect(isMutationSourceFile("clients/atomic-write.ts")).toBe(true);
		expect(isMutationSourceFile("docs/pi-lens-monitor.md")).toBe(false);
	});
});

describe("mapRelatedTests generalized to compiled sources", () => {
	it("excludes only source-marked tests with a checked reason", () => {
		// Recurrence: #3625 admitted grammar, real-stdio, and host-witness tests
		// into a dry run because they imported a widely-used module. The marker
		// is source-derived; the reason is independently checked and an unmarked
		// importer remains in the population.
		const result = mapRelatedTests(["clients/degradation-ledger.ts"], {
			testFiles: ["tests/marked.test.ts", "tests/plain.test.ts"],
			readFile: (file) =>
				file.includes("marked")
					? '// mutation-lane: exclude\nimport "../clients/degradation-ledger.js";'
					: 'import "../clients/degradation-ledger.js";',
			exclusions: {
				"tests/marked.test.ts": { reason: "fixture boundary" },
			},
		});

		expect(result.tests).toEqual(["tests/plain.test.ts"]);
		expect(result.excluded).toEqual([
			{ file: "tests/marked.test.ts", reason: "fixture boundary" },
		]);
	});

	it("rejects an exclusion marker without a checked reason", () => {
		// Recurrence: a marker without an independently reviewed reason would be
		// silent coverage loss rather than a bounded admission.
		expect(() =>
			mutationLaneExclusion("tests/marked.test.ts", {
				readFile: () => "// mutation-lane: exclude",
				exclusions: {},
			}),
		).toThrowError(
			expect.objectContaining({
				name: "MutationLaneExclusionError",
				message: expect.stringContaining("no checked reason"),
			}),
		);
	});

	it("keeps an excluded sole importer uncovered", () => {
		// Recurrence: an exclusion is not coverage. If it is the only importer,
		// the source must retain the no-covering-test verdict rather than becoming
		// a falsely covered mutation target.
		const result = mapRelatedTests(["clients/degradation-ledger.ts"], {
			testFiles: ["tests/marked.test.ts"],
			readFile: () =>
				'// mutation-lane: exclude\nimport "../clients/degradation-ledger.js";',
			exclusions: {
				"tests/marked.test.ts": { reason: "fixture boundary" },
			},
		});
		expect(result.covered).toEqual([]);
		expect(result.uncovered).toEqual(["clients/degradation-ledger.ts"]);
		expect(result.tests).toEqual([]);
		expect(result.excluded).toEqual([
			{ file: "tests/marked.test.ts", reason: "fixture boundary" },
		]);
	});

	it("parses failing test names from Stryker output before falling back", () => {
		// Recurrence: the dry-run failure branch must preserve the child output's
		// named failing tests, not discard it and report only the selected list.
		const reason = describeStrykerFailure(
			{ status: 1, signal: null, error: undefined },
			60,
			{
				tests: ["tests/fallback.test.ts"],
				output: "FAIL tests/first.test.ts:12\n❯ tests/second.test.ts:4",
			},
		);
		expect(reason).toContain("tests/first.test.ts, tests/second.test.ts");
		expect(reason).not.toContain("tests/fallback.test.ts");
	});

	it("uses a bounded named error for an unregistered marker", () => {
		// Recurrence: a malformed checked registry used to escape the driver as
		// an anonymous uncaught Error before it could write a bounded report.
		try {
			mutationLaneExclusion("tests/marked.test.ts", {
				readFile: () => "// mutation-lane: exclude",
				exclusions: {},
			});
		} catch (error) {
			expect(error).toBeInstanceOf(MutationLaneExclusionError);
			if (!(error instanceof Error)) throw error;
			expect(error.name).toBe("MutationLaneExclusionError");
			return;
		}
		throw new Error("expected the marker admission to fail");
	});

	it("names the related tests when the dry run fails", () => {
		const reason = describeStrykerFailure(
			{ status: 1, signal: null, error: undefined },
			60,
			{ tests: ["tests/mcp/server.smoke.test.ts"] },
		);
		expect(reason).toContain("dry run failed");
		expect(reason).toContain("tests/mcp/server.smoke.test.ts");
		expect(reason).not.toContain(
			"mutation diff: no mutants evaluated; dry run or",
		);
	});

	it("matches a compiled source's test import even though tests import the .js specifier", () => {
		// Recurrence: TypeScript's nodenext resolution (and this repo's own
		// tests, e.g. tests/index-wiring.test.ts importing "../index.js")
		// import a compiled source by its .js specifier, never .ts -- the
		// normalizer must strip both extensions to match them.
		const result = mapRelatedTests(["clients/atomic-write.ts"], {
			testFiles: ["tests/clients/gzip-stage-write.test.ts"],
			readFile: () =>
				'import { STAGE_TMP_PATTERN } from "../../clients/atomic-write.js";',
		});

		expect(result.related.get("clients/atomic-write.ts")).toEqual(
			new Set(["tests/clients/gzip-stage-write.test.ts"]),
		);
		expect(result.covered).toEqual(["clients/atomic-write.ts"]);
	});

	it("matches the conventional tests/<dir>/<name>.test.ts sibling for a compiled source", () => {
		const result = mapRelatedTests(["clients/atomic-write.ts"], {
			testFiles: ["tests/clients/atomic-write.test.ts"],
			readFile: () => "",
		});

		expect(result.related.get("clients/atomic-write.ts")).toEqual(
			new Set(["tests/clients/atomic-write.test.ts"]),
		);
	});

	it("reports a covered compiled source alongside an uncovered one in the same call", () => {
		const result = mapRelatedTests(
			["clients/atomic-write.ts", "clients/uncovered-thing.ts"],
			{
				testFiles: ["tests/clients/atomic-write.test.ts"],
				readFile: () => "",
			},
		);

		expect(result.covered).toEqual(["clients/atomic-write.ts"]);
		expect(result.uncovered).toEqual(["clients/uncovered-thing.ts"]);
	});
});

describe("sampleRangesDeterministically (#3531 budget sampling)", () => {
	it("keeps every pattern unchanged, and reports no sampling, under the limit", () => {
		const patterns = ["a.js:1-1", "b.js:2-2"];
		expect(sampleRangesDeterministically(patterns, 5, "sha-1")).toEqual({
			selected: patterns,
			sampled: false,
		});
	});

	it("is deterministic for the same seed: repeated calls select the identical subset", () => {
		const patterns = Array.from({ length: 50 }, (_, i) => `f${i}.js:${i}-${i}`);
		const first = sampleRangesDeterministically(patterns, 10, "head-sha-abc");
		const second = sampleRangesDeterministically(patterns, 10, "head-sha-abc");

		expect(first.sampled).toBe(true);
		expect(first.selected).toHaveLength(10);
		expect(second.selected).toEqual(first.selected);
	});

	it("samples a different subset for a different seed (a different head SHA)", () => {
		// Recurrence: a sample that ignores the seed is either fixed (always
		// the same slice, hiding whichever mutants sort last) or effectively
		// random (Math.random()) -- neither is reproducible per-PR-head. This
		// does not prove every seed differs, only that the seed is load-bearing
		// for at least one representative pair.
		const patterns = Array.from({ length: 50 }, (_, i) => `f${i}.js:${i}-${i}`);
		const a = sampleRangesDeterministically(patterns, 10, "sha-aaaa");
		const b = sampleRangesDeterministically(patterns, 10, "sha-bbbb");

		expect(a.selected).not.toEqual(b.selected);
	});

	it("preserves the input order of the selected patterns", () => {
		const patterns = Array.from({ length: 30 }, (_, i) => `f${i}.js:${i}-${i}`);
		const { selected } = sampleRangesDeterministically(patterns, 10, "seed");
		const indices = selected.map((pattern) => patterns.indexOf(pattern));
		expect(indices).toEqual([...indices].sort((x, y) => x - y));
	});

	it("keeps the run's own default range budget positive and finite", () => {
		expect(DEFAULT_MAX_RANGES).toBeGreaterThan(0);
		expect(Number.isFinite(DEFAULT_MAX_RANGES)).toBe(true);
	});
});

describe("extractSnippet (survivor original-text extraction)", () => {
	const sourceLines = [
		"\tif (!Number.isInteger(maxFiles) || maxFiles < 0) {",
		'\t\tthrow new RangeError("x");',
		"\t}",
	];

	it("slices the exact 1-based column span of a single-line mutant location", () => {
		// Pinned against a real Stryker report (scripts/lib/stryker-diff.mjs:56,
		// columns 6-49), 2026-09-26.
		expect(
			extractSnippet(sourceLines, {
				start: { line: 1, column: 6 },
				end: { line: 1, column: 49 },
			}),
		).toBe("!Number.isInteger(maxFiles) || maxFiles < 0");
	});

	it("truncates a multi-line span to its first line with a marker", () => {
		expect(
			extractSnippet(sourceLines, {
				start: { line: 1, column: 51 },
				end: { line: 3, column: 2 },
			}),
		).toBe("{ … (multi-line)");
	});

	it("returns undefined when the mutant carries no location", () => {
		expect(extractSnippet(sourceLines, undefined)).toBeUndefined();
	});
});

describe("buildRunConfig (#3531 round 2 T1: the generated config object, not source text)", () => {
	const fakeBase = {
		buildCommand: "npm run build",
		incremental: true,
		commandRunner: { command: "irrelevant-base-command", other: "kept" },
		mutate: ["scripts/**/*.mjs", "!scripts/**/*.test.mjs"],
	};

	it("overrides buildCommand so a rebuild can never clobber an already-instrumented mutant", () => {
		// Recurrence (round 1 T1): a test that only asserts the driver's SOURCE
		// TEXT contains "mutation-touch-build.mjs" is satisfied by a comment
		// mentioning that string and proves nothing about what Stryker
		// actually runs. This asserts the generated CONFIG OBJECT instead.
		const generated = buildRunConfig(fakeBase, {
			command: "real test command",
		});

		expect(generated.buildCommand).toBe(
			"node scripts/lib/mutation-touch-build.mjs",
		);
		expect(generated.buildCommand).not.toBe(fakeBase.buildCommand);
	});

	it("sets force:true by default and preserves the base config's other fields, including incremental", () => {
		const generated = buildRunConfig(fakeBase, {
			command: "real test command",
		});

		expect(generated.force).toBe(true);
		expect(generated.incremental).toBe(true);
		expect(generated.mutate).toBe(fakeBase.mutate);
	});

	it("lets Stryker read the restored incremental file only when the caller proved it reusable (C1)", () => {
		// Recurrence C1: Stryker's differ reuses every unchanged-location result
		// for a command runner, so `force` is the only switch that keeps a stale
		// file from a push with different tests out of the run.
		expect(buildRunConfig(fakeBase, { command: "c", reuse: true }).force).toBe(
			false,
		);
		expect(buildRunConfig(fakeBase, { command: "c", reuse: false }).force).toBe(
			true,
		);
	});

	it("turns on Stryker's file log, the only place the reuse count is written", () => {
		expect(buildRunConfig(fakeBase, { command: "c" }).fileLogLevel).toBe(
			"info",
		);
	});

	it("merges the run command into commandRunner without dropping its other fields", () => {
		const generated = buildRunConfig(fakeBase, {
			command: "real test command",
		});

		expect(generated.commandRunner).toEqual({
			command: "real test command",
			other: "kept",
		});
	});
});

describe("parseDryRunCost (#3531 round 2 S2)", () => {
	it("parses the real mutant count and net dry-run duration Stryker prints", () => {
		// Pinned against a real --dryRunOnly run, 2026-09-26
		// (clients/atomic-write.js:1-190).
		const output = [
			"Instrumented 1 source file(s) with 39 mutant(s)",
			"Initial test run succeeded. Ran 1 tests in 2 seconds (net 2758 ms, overhead 0 ms).",
		].join("\n");

		expect(parseDryRunCost(output)).toEqual({
			totalMutants: 39,
			dryRunMs: 2758,
		});
	});

	it("parses correctly regardless of which line comes first", () => {
		const output = [
			"Initial test run succeeded. Ran 768 tests in 85 seconds (net 84532 ms, overhead 120 ms).",
			"Instrumented 5 source file(s) with 290 mutant(s)",
		].join("\n");

		expect(parseDryRunCost(output)).toEqual({
			totalMutants: 290,
			dryRunMs: 84532,
		});
	});

	it("returns null when either line is missing (an unreadable/changed Stryker output format)", () => {
		expect(
			parseDryRunCost("Instrumented 1 source file(s) with 39 mutant(s)"),
		).toBeNull();
		expect(
			parseDryRunCost("Ran 1 tests in 2 seconds (net 2758 ms, overhead 0 ms)"),
		).toBeNull();
		expect(parseDryRunCost("")).toBeNull();
	});
});

describe("estimateAffordableMutants (#3531 round 2 S2)", () => {
	it("pins the fixed-overhead budget through the production driver", () => {
		// Recurrence #3686 F2: passing a test-only overhead would make the
		// estimator appear safe while the driver still used zero overhead.
		expect(stripSource(driver)).toContain(
			"fixedOverheadMs: DEFAULT_MUTATION_FIXED_OVERHEAD_MS",
		);
	});

	it("pins the measured overhead constant in the real-number estimate", () => {
		// Recurrence #3686 F1: a literal-only pin could drift from the driver's
		// exported fixed-overhead contract without changing the measured verdict.
		expect(
			estimateAffordableMutants({
				remainingMs: 3_560_000,
				dryRunMs: 17_824,
				fixedOverheadMs: DEFAULT_MUTATION_FIXED_OVERHEAD_MS,
			}),
		).toBe(128);
	});

	it("samples the #3683 run instead of admitting 270 mutants into a 60-minute budget", () => {
		// Recurrence #3683: 270 measured mutants at 17,824ms per mutant were
		// admitted as "within the remaining budget" even though the projected
		// mutation run plus fixed overhead and safety margin did not fit.
		const allowed = estimateAffordableMutants({
			remainingMs: 3_560_000,
			dryRunMs: 17_824,
			fixedOverheadMs: 300_000,
			safetyFactor: 0.7,
		});

		expect(allowed).toBeLessThan(270);
		expect(allowed).toBe(128);
		expect(allowed * 16_050 + 300_000).toBeLessThanOrEqual(3_560_000);
	});

	it("models CPU-bound vitest runners as serial even when Stryker concurrency is 2", () => {
		// Recurrence #3649: concurrency 2 achieved only 1.11x wall-clock
		// speedup (16.05s per mutant), so multiplying by 2 over-admitted work.
		expect(
			estimateAffordableMutants({
				remainingMs: 3_600_000,
				dryRunMs: 2_000,
				safetyFactor: 1,
			}),
		).toBe(1800);
	});

	it("applies the safety factor as a multiplier on the raw estimate", () => {
		expect(
			estimateAffordableMutants({
				remainingMs: 3_600_000,
				dryRunMs: 2_000,
				safetyFactor: 0.5,
			}),
		).toBe(900);
	});

	it("reproduces the #3579 replay's real blowup: 290 mutants against ~85s dry runs vastly exceeds a 60-minute budget", () => {
		// Recurrence: round 1's DEFAULT_MAX_RANGES=40 sampled 290 mutants against
		// this exact measured cost, needing ~3.4h against a 60-minute budget.
		const allowed = estimateAffordableMutants({
			remainingMs: 55 * 60_000,
			dryRunMs: 85_000,
			safetyFactor: 0.7,
		});
		expect(allowed).toBeLessThan(290);
		expect(allowed).toBeGreaterThan(0);
	});

	it("returns zero when fixed overhead consumes the remaining budget", () => {
		expect(
			estimateAffordableMutants({
				remainingMs: 240_000,
				dryRunMs: 2_000,
				fixedOverheadMs: 300_000,
			}),
		).toBe(0);
	});

	it("keeps a degenerate dry-run duration bounded", () => {
		expect(
			estimateAffordableMutants({
				remainingMs: 60_000,
				dryRunMs: 0,
			}),
		).toBe(1);
	});
});

describe("dedupePatterns (#3531 round 2 S3)", () => {
	it("removes an exact duplicate --mutate pattern, keeping first-seen order", () => {
		// Recurrence: a real #3579 replay produced
		// clients/instance-reaper.js:215-215 twice (two .ts hunks collapsing
		// onto the same .js range) -- each duplicate spent a range-budget slot
		// on a mutant Stryker would test identically the first time.
		expect(
			dedupePatterns([
				"a.js:1-1",
				"clients/instance-reaper.js:215-215",
				"b.js:2-2",
				"clients/instance-reaper.js:215-215",
			]),
		).toEqual(["a.js:1-1", "clients/instance-reaper.js:215-215", "b.js:2-2"]);
	});

	it("is a no-op on an already-unique list", () => {
		const patterns = ["a.js:1-1", "b.js:2-2"];
		expect(dedupePatterns(patterns)).toEqual(patterns);
	});
});

describe("describePartialMutationOutcome (#3531 round 3 R2-4)", () => {
	it("classifies a timed-out partial report with a bounded measured-population verdict (#3683)", () => {
		const verdict = describePartialMutationOutcome(
			{
				status: 143,
				signal: null,
				error: Object.assign(new Error("spawnSync ETIMEDOUT"), {
					code: "ETIMEDOUT",
				}),
			},
			60,
			{
				evaluated: 221,
				total: 270,
			},
		);

		expect(verdict).toBe(
			"mutation diff: budget expired after 221 of 270 mutants evaluated (M = measured mutant population)",
		);
	});

	it("bounds the timeout reason instead of duplicating the score and survivor table", () => {
		// Recurrence: the review found the partial reason quoting
		// describeStrykerFailure's "no mutants evaluated" prefix directly under
		// the render's own "Partial run -- 8 of 9 evaluated" banner --
		// self-contradictory.
		const reason = describePartialMutationOutcome(
			{
				status: 143,
				signal: null,
				error: Object.assign(new Error("spawnSync ETIMEDOUT"), {
					code: "ETIMEDOUT",
				}),
			},
			60,
			{ evaluated: 8, total: 9 },
		);

		expect(reason).not.toContain("no mutants evaluated");
		expect(reason).toBe(
			"mutation diff: budget expired after 8 of 9 mutants evaluated (M = measured mutant population)",
		);
	});

	it("still names Stryker's own status for a non-timeout interrupt", () => {
		const reason = describePartialMutationOutcome(
			{ status: 1, signal: null, error: undefined },
			60,
			{ evaluated: 8, total: 9 },
		);

		expect(reason).not.toContain("no mutants evaluated");
		expect(reason).toContain("Stryker status 1");
	});
});

describe("describeZeroMutantOutcome (#3531 round 3 R2-1)", () => {
	it("states the true global fact when the whole changed-range set was tried, unsampled", () => {
		expect(
			describeZeroMutantOutcome({
				sampled: false,
				rangesEvaluated: 5,
				rangesTotal: 5,
				totalMutants: 0,
			}),
		).toBe("Stryker found no mutable code in 5 changed range(s)");
	});

	it("names the sample size and the measured total instead of the false global claim, when sampled", () => {
		// Recurrence: a real #3579 replay at a 15-minute budget sampled 1 of 99
		// ranges (a shorthand-property line with 0 mutants) while the
		// measurement found 710 mutants across all 99 -- "Stryker found no
		// mutable code in 99 changed range(s)" was false.
		expect(
			describeZeroMutantOutcome({
				sampled: true,
				rangesEvaluated: 1,
				rangesTotal: 99,
				totalMutants: 710,
			}),
		).toBe(
			"0 mutants in 1 sampled of 99 ranges (99 ranges held 710 mutant(s))",
		);
	});
});

describe("decideMutationOutcome (#3531 round 3 R2-2: the driver's three outcome branches, unified and pure)", () => {
	it("measurement-time: cost.totalMutants === 0 reports a zero-mutant outcome, not a partial or scored one", () => {
		const outcome = decideMutationOutcome({
			interrupted: false,
			mutants: [],
			sampled: false,
			rangesEvaluated: 12,
			rangesTotal: 12,
			totalMutants: 0,
		});

		expect(outcome.partial).toBeNull();
		expect(outcome.zeroMutants).toEqual({
			reason: "Stryker found no mutable code in 12 changed range(s)",
		});
	});

	it("post-run: mutants.length === 0 after a completed run reports zero, sample-aware", () => {
		const outcome = decideMutationOutcome({
			interrupted: false,
			mutants: [],
			sampled: true,
			rangesEvaluated: 1,
			rangesTotal: 99,
			totalMutants: 710,
		});

		expect(outcome.partial).toBeNull();
		expect(outcome.zeroMutants).toEqual({
			reason:
				"0 mutants in 1 sampled of 99 ranges (99 ranges held 710 mutant(s))",
		});
	});

	it("post-run: any mutant evaluated reports neither zero nor partial (a normal scored run)", () => {
		const outcome = decideMutationOutcome({
			interrupted: false,
			mutants: [{ status: "Killed" }],
			sampled: false,
			rangesEvaluated: 1,
			rangesTotal: 1,
			totalMutants: 1,
		});

		expect(outcome.zeroMutants).toBeNull();
		expect(outcome.partial).toBeNull();
	});

	it("interrupted with mutants.length > 0 reports partial, carrying the partial-specific reason", () => {
		const outcome = decideMutationOutcome({
			interrupted: true,
			mutants: [{ status: "Killed" }, { status: "Killed" }],
			sampled: false,
			rangesEvaluated: 1,
			rangesTotal: 1,
			totalMutants: 9,
			failureReason: "mutation diff: no mutants evaluated; budget expired",
			partialReason: "mutation diff: budget expired",
		});

		expect(outcome.zeroMutants).toBeNull();
		expect(outcome.partial).toEqual({
			reason: "mutation diff: budget expired",
			evaluated: 2,
			total: 9,
		});
	});

	it("interrupted with no usable partial result (mutants.length === 0) falls back to the failure reason, not describeZeroMutantOutcome's", () => {
		const outcome = decideMutationOutcome({
			interrupted: true,
			mutants: [],
			sampled: true,
			rangesEvaluated: 1,
			rangesTotal: 99,
			totalMutants: 710,
			failureReason: "mutation diff: no mutants evaluated; budget expired",
			partialReason: "mutation diff: budget expired",
		});

		expect(outcome.partial).toBeNull();
		expect(outcome.zeroMutants).toEqual({
			reason: "mutation diff: no mutants evaluated; budget expired",
		});
	});
});

describe("planResample (#3531 round 3 R2-1 fix #3)", () => {
	it("resamples from only the ranges not yet tried, excluding every proven-empty one", () => {
		const plan = planResample({
			allPatterns: ["a.js:1-1", "b.js:2-2", "c.js:3-3", "d.js:4-4"],
			triedPatterns: ["a.js:1-1"],
			keepRangeCount: 2,
			seed: "deadbeef",
			attemptsSoFar: 0,
			maxAttempts: 3,
		});

		if (!plan.retry) throw new Error("expected plan.retry to be true");
		expect(plan.patterns).toHaveLength(2);
		expect(plan.patterns).not.toContain("a.js:1-1");
		for (const pattern of plan.patterns) {
			expect(["b.js:2-2", "c.js:3-3", "d.js:4-4"]).toContain(pattern);
		}
	});

	it("gives up once every range has been tried", () => {
		const plan = planResample({
			allPatterns: ["a.js:1-1", "b.js:2-2"],
			triedPatterns: ["a.js:1-1", "b.js:2-2"],
			keepRangeCount: 2,
			seed: "deadbeef",
			attemptsSoFar: 0,
			maxAttempts: 3,
		});

		expect(plan).toEqual({ retry: false });
	});

	it("gives up once the attempt cap is reached, even with untried ranges remaining", () => {
		const plan = planResample({
			allPatterns: ["a.js:1-1", "b.js:2-2", "c.js:3-3"],
			triedPatterns: ["a.js:1-1"],
			keepRangeCount: 1,
			seed: "deadbeef",
			attemptsSoFar: 3,
			maxAttempts: 3,
		});

		expect(plan).toEqual({ retry: false });
	});

	it("is deterministic: the same seed and tried set resample to the identical subset", () => {
		const args = {
			allPatterns: ["a.js:1-1", "b.js:2-2", "c.js:3-3", "d.js:4-4"],
			triedPatterns: ["a.js:1-1"],
			keepRangeCount: 2,
			seed: "9ebbb5da",
			attemptsSoFar: 0,
			maxAttempts: 3,
		};

		expect(planResample(args)).toEqual(planResample({ ...args }));
	});
});

describe("augmentAndSummarize (#3531 round 2: shared by the complete AND the partial-report path)", () => {
	const compiledIndex = new Map();

	it("counts and scores a normal completed report", () => {
		const report = {
			files: {
				"scripts/lib/x.mjs": {
					mutants: [
						{
							id: "0",
							status: "Killed",
							mutatorName: "BooleanLiteral",
							location: undefined,
						},
						{
							id: "1",
							status: "Survived",
							mutatorName: "StringLiteral",
							location: undefined,
						},
					],
				},
			},
		};

		const { mutants, counts, score } = augmentAndSummarize(
			report,
			compiledIndex,
			{
				readFile: () => {
					throw new Error("no such file");
				},
			},
		);

		expect(mutants).toHaveLength(2);
		expect(counts).toEqual({ Killed: 1, Survived: 1 });
		expect(score).toBe("50.00");
	});

	it("summarizes a PARTIAL (.stryker/incremental.json-shaped) report identically -- fewer mutants, same math", () => {
		// Recurrence (round 2 S2): a budget kill can leave a real, partial
		// result (Stryker's own unexpectedExitHandler saves
		// .stryker/incremental.json, the SAME {files: {mutants: [...]}} shape
		// as the completed report, just missing the untested mutants entirely
		// -- verified against a real interrupted run, 2026-09-26: 6 of 9
		// mutants present, all Killed, the other 3 simply absent from the
		// array). The driver must summarize whatever DID run, not treat an
		// incomplete mutant list as an error.
		const partial = {
			files: {
				"clients/string-utils.js": {
					mutants: [
						{
							id: "0",
							status: "Killed",
							mutatorName: "ConditionalExpression",
							location: undefined,
						},
						{
							id: "1",
							status: "Killed",
							mutatorName: "EqualityOperator",
							location: undefined,
						},
					],
					// 7 of the real 9 mutants are simply absent -- not "Pending",
					// not present-with-null-status, just missing.
				},
			},
		};

		const { mutants, counts, score } = augmentAndSummarize(
			partial,
			compiledIndex,
			{
				readFile: () => {
					throw new Error("no such file");
				},
			},
		);

		expect(mutants).toHaveLength(2);
		expect(counts).toEqual({ Killed: 2 });
		expect(score).toBe("100.00");
	});

	it("attaches original source text from the injected readFile, not the real filesystem", () => {
		const report = {
			files: {
				"a.js": {
					mutants: [
						{
							id: "0",
							status: "Survived",
							mutatorName: "BooleanLiteral",
							location: {
								start: { line: 1, column: 1 },
								end: { line: 1, column: 5 },
							},
						},
					],
				},
			},
		};

		const { mutants } = augmentAndSummarize(report, compiledIndex, {
			readFile: () => "true",
		});

		expect(mutants[0].original).toBe("true");
	});

	it("maps a survivor to its .ts location, column-aware, for a compiled target", () => {
		const rawMap = {
			version: 3,
			sources: ["fixture.ts"],
			names: [],
			mappings: "AAAA",
		};
		const index = {
			...buildLineIndex(decodeSourceMapRows(rawMap)),
			tracer: createTracer(rawMap),
		};
		const byJsFile = new Map([
			["clients/fixture.js", { index, tsFile: "clients/fixture.ts" }],
		]);
		const report = {
			files: {
				"clients/fixture.js": {
					mutants: [
						{
							id: "0",
							status: "Survived",
							mutatorName: "BooleanLiteral",
							location: {
								start: { line: 1, column: 1 },
								end: { line: 1, column: 5 },
							},
						},
					],
				},
			},
		};

		const { mutants } = augmentAndSummarize(report, byJsFile, {
			readFile: () => "true",
		});

		expect(mutants[0].tsLocation).toEqual({
			fileName: "clients/fixture.ts",
			line: 1,
		});
	});
});
