// flake-shape: real-process-spawn — F1's defect (#3592 round 2) is a
// temporal-dead-zone crash that only exists in the driver's OWN top-level
// execution order; the driver is a top-level script this suite cannot
// import (see the "stated exception" notes below), and a source-text
// assertion alone already passed under the crash (the wiring test for
// #3592 item 2 checked the literal text existed, not that calling
// `baseMeta` before it ran was safe). Only spawning the real script against
// a real, throwaway git fixture reproduces the actual TDZ ordering bug.
// #4108 round 2 adds one more: Stryker's in-place rewrite of every tracked file
// is the real Stryker's own behaviour (run 37650871948), so only the real
// Stryker binary over a throwaway fixture reproduces it.
import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import yaml from "../../clients/deps/js-yaml.js";
import { gitExecFileSync } from "../../scripts/lib/git-fixture-env.mjs";
import { acquireTestLock, getLockPath } from "../../scripts/lib/suite-lock.mjs";
import { probeReportsDirectory } from "../../scripts/lib/mutation-test-selection.mjs";
import {
	augmentAndSummarize,
	buildRunConfig,
	capMutationFiles,
	collectChangedRanges,
	changedLineWeights,
	compiledJsPath,
	decideMutationOutcome,
	dedupePatterns,
	describePartialMutationOutcome,
	describeSampledMutants,
	describeStrykerFailure,
	describeZeroMutantOutcome,
	DEFAULT_MAX_RANGES,
	DEFAULT_MAX_TESTS,
	DEFAULT_MUTATION_FIXED_OVERHEAD_MS,
	estimateAffordableMutants,
	extractSnippet,
	fitSampleToMutantAllowance,
	formatCapNotice,
	formatQueueEntry,
	isCompiledMutationSource,
	isDryRunTimeout,
	isMutationSourceFile,
	isQueueablePath,
	isScriptMutationFile,
	mapRelatedTests,
	MAX_DRY_RUN_SECONDS,
	mutationLaneExclusion,
	MutationLaneExclusionError,
	MUTATION_BUDGET_MINUTES,
	mutationRangePatterns,
	parseChangedLineRanges,
	parseDryRunCost,
	parseQueueEntry,
	planResample,
	sampleRangesDeterministically,
	selectMutationFiles,
	TEST_FILE_OVERHEAD_SECONDS,
	UNKNOWN_TEST_SECONDS,
} from "../../scripts/lib/stryker-diff.mjs";
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
// #4005: the driver's only scheduled caller is the nightly job; the cap is read
// from that job, never from the first `timeout-minutes:` in the file.
const mutationJob = (
	yaml.load(
		readFileSync(
			resolve(
				import.meta.dirname,
				"../../.github/workflows/stryker-nightly.yml",
			),
			"utf8",
		),
	) as { jobs: Record<string, { "timeout-minutes"?: number }> }
).jobs.mutate;

// lane: the nightly Stryker report -- dry run and mutant runs. That lane mutates the
// driver in place (stryker.config.mjs `inPlace: true`) and every expression of
// an instrumented file is rewritten to
// `stryMutAct_<ns>("<id>") ? <mutant> : (stryCov_<ns>("<id>"), <original>)`
// under a `function stryNS_<ns>()` header, so a text pin on a changed driver
// line false-reds the lane's own dry run (#3108) and the lane reports "dry run
// failed" for any PR that edits the driver. The pins stay live in the ordinary
// Unit tests lane, where the driver is plain source; the behaviour they stand
// for is pinned by the spawned driver test above, which runs the instrumented
// driver itself and so also kills its mutants. The condition is the
// instrumentation's own marks, read from the very text being pinned: the
// `function stryNS_<ns>()` header (a file that holds mutants) or the
// `// @ts-nocheck` line Stryker's preprocessor prepends to every file it
// rewrites (also a file whose ranges held none, which it still re-prints). A
// skip keyed on the STRYKER_MUTATOR_WORKER environment variable did not skip on
// CI run 36787524136 (the pins ran against the instrumented driver and red the
// dry run), and one keyed on the header alone missed the no-mutant case on run
// 36805707289.
const isInstrumented = (text: string) =>
	/^\s*\/\/ @ts-nocheck\b/.test(text) || /\bstryNS_\w+/.test(text);
const underStryker = isInstrumented(driver);

const repositoryRoot = resolve(import.meta.dirname, "../..");
const driverPath = join(repositoryRoot, "scripts", "stryker-diff.mjs");

/** A throwaway fixture root for a real `git` repo (#4867). It lives inside the
 *  checkout under the git-ignored `.probe-home`, never at the checkout root
 *  (#4864): the plegma Bash guard refuses a git write outside the worker's
 *  worktree, and a checkout fixture does not belong on tmpfs (AGENTS.md, #3526). */
function strykerFixtureDir(prefix: string): string {
	mkdirSync(join(repositoryRoot, ".probe-home"), { recursive: true });
	return mkdtempSync(join(repositoryRoot, ".probe-home", prefix));
}

/** git in a throwaway fixture repo, with an identity so a commit works. */
function fixtureGit(cwd: string, args: string[]) {
	return gitExecFileSync(
		[
			"-c",
			"user.email=pi-lens-test@example.com",
			"-c",
			"user.name=pi-lens-test",
			...args,
		],
		{ cwd },
	);
}

/** One real run of the driver against a fixture repo: this file's only spawn of it. */
function runDriver(cwd: string, args: string[], timeout: number) {
	return execFileSync(process.execPath, [driverPath, ...args], {
		cwd,
		encoding: "utf8",
		timeout,
	});
}

/** A real driver run that is allowed to exit non-zero (the partial path). */
function runDriverResult(
	cwd: string,
	args: string[],
	timeout: number,
	env?: NodeJS.ProcessEnv,
) {
	return spawnSync(process.execPath, [driverPath, ...args], {
		cwd,
		encoding: "utf8",
		timeout,
		...(env ? { env } : {}),
	});
}

/** A real driver run with an explicit environment (the lock/#3853 arms). */
function runDriverWithEnv(
	cwd: string,
	args: string[],
	timeout: number,
	env: NodeJS.ProcessEnv,
) {
	return execFileSync(process.execPath, [driverPath, ...args], {
		cwd,
		encoding: "utf8",
		timeout,
		env,
	});
}

/**
 * A fake external Stryker installed at the true process boundary
 * (`node_modules/.bin/stryker`): the driver's own spawn target. It records every
 * invocation (argv, parsed config, whether the incremental file was present on
 * entry) and emits the artifacts the driver reads, so the real driver reaches
 * its fingerprint, incremental, config and run-loop stages. Real filesystem,
 * git, tsc and vitest stay real; only the Stryker binary is doubled.
 */
const FAKE_STRYKER = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const dryRun = args.includes("--dryRunOnly");
const mutateAt = args.indexOf("--mutate");
const patterns = ((mutateAt === -1 ? "" : args[mutateAt + 1]) || "")
	.split(",")
	.filter(Boolean);
const configFile = args[args.length - 1];
let config = {};
try {
	const raw = fs.readFileSync(configFile, "utf8");
	config = JSON.parse(raw.replace(/^export default /, "").replace(/;\s*$/, ""));
} catch (error) {
	console.error("fake stryker: unreadable config " + error.message);
	process.exit(97);
}
const command = config.commandRunner ? config.commandRunner.command : null;
fs.mkdirSync(".fake-stryker", { recursive: true });
const incrementalPresent = fs.existsSync(".stryker/incremental.json");
fs.appendFileSync(
	".fake-stryker/invocations.jsonl",
	JSON.stringify({
		dryRun,
		patterns,
		configFile,
		force: config.force === undefined ? null : config.force,
		incremental: config.incremental === undefined ? null : config.incremental,
		command,
		incrementalPresent,
		noLock: process.env.PI_LENS_TEST_NO_LOCK ?? null,
	}) + "\n",
);
let control = {};
try {
	control = JSON.parse(fs.readFileSync(".fake-stryker/control.json", "utf8"));
} catch {}
// #4989: a pass the driver's kill bound must reach (control.dryRunHangMs), and a
// first real run that spends budget so the admission after it sees a budget too
// small to afford a mutant (control.firstRealRunClockSkewMs). The spend is a
// clock offset the driver's test-only preload adds to Date.now (#3801), not a
// real sleep: the driver reads its budget from Date.now alone.
const sleep = (ms) => {
	if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};
// The two dry-run failures Stryker 10.0.0 logs at ERROR (3-dry-run-executor.js
// logTimeoutInitialRun / logFailedTestsInInitialRun), then exits 1.
const DRY_RUN_ERRORS = {
	timeout: "14:00:14 (1) ERROR DryRunExecutor Initial test run timed out!",
	tests: "14:00:14 (1) ERROR DryRunExecutor One or more tests failed in the initial test run:",
};
// R2 F1 of #4108: Stryker's command runner puts the whole vitest output into the
// failed-tests log, and this lane's own tests assert the timeout line, so a
// vitest diff (and a console echo of a child's stderr) carries it. Shaped like
// vitest's own diff, with one copy at the start of a line.
DRY_RUN_ERRORS.testsQuotingTimeout = [
	DRY_RUN_ERRORS.tests,
	" FAIL  tests/scripts/stryker-diff.test.ts > describeStrykerFailure",
	"AssertionError: expected 'x' to be 'y'",
	"- Expected",
	"+ 14:00:14 (1) ERROR DryRunExecutor Initial test run timed out!",
	"stderr | tests/scripts/stryker-diff.test.ts > a child",
	DRY_RUN_ERRORS.timeout,
].join("\n");
if (dryRun) {
	sleep(control.dryRunHangMs || 0);
	if (control.dryRunFails) {
		console.error(DRY_RUN_ERRORS[control.dryRunFails]);
		process.exit(1);
	}
	// #4171: control.density maps a pattern to the mutants it holds (default 3), so
	// a fixture can give ranges the uneven density a real Stryker run measures.
	const density = control.density || {};
	const mutantTotal = patterns.reduce((sum, pattern) => sum + (density[pattern] ?? 3), 0);
	console.log("Instrumented 3 source file(s) with " + mutantTotal + " mutant(s)");
	console.log("Initial test run succeeded. Ran 1 tests in 1 seconds (net 12 ms, overhead 0 ms).");
	process.exit(0);
}
if (control.realRunFails) {
	fs.writeFileSync("stryker.log", DRY_RUN_ERRORS[control.realRunFails] + "\n");
	process.exit(1);
}
// #4989: only the FIRST real run spends the budget, so the retry after it faces
// what is left.
const countFile = ".fake-stryker/real-runs";
let realRuns = 1;
try {
	realRuns = Number(fs.readFileSync(countFile, "utf8")) + 1;
} catch {}
fs.writeFileSync(countFile, String(realRuns));
if (realRuns === 1 && control.firstRealRunClockSkewMs)
	fs.writeFileSync(".fake-stryker/clock-offset-ms", String(control.firstRealRunClockSkewMs));
const files = {};
for (const pattern of patterns) {
	const match = /^(.*):(\d+)-(\d+)$/.exec(pattern);
	if (!match) continue;
	if ((control.density || {})[pattern] === 0) continue;
	const file = match[1];
	const start = Number(match[2]);
	if (!files[file]) files[file] = { mutants: [] };
	const statuses = ["Killed", "Survived", "Timeout"];
	for (let offset = 0; offset < statuses.length; offset += 1) {
		files[file].mutants.push({
			id: pattern + "-" + offset,
			mutatorName: "FakeMutator",
			replacement: "0",
			status: statuses[offset],
			location: {
				start: { line: start, column: 1 },
				end: { line: start, column: 2 },
			},
		});
	}
}
if (control.writeIncremental !== false) {
	fs.mkdirSync(".stryker", { recursive: true });
	fs.writeFileSync(
		".stryker/incremental.json",
		JSON.stringify({ schemaVersion: "1.0", files, thresholds: {} }),
	);
}
if (config.force === false) {
	fs.writeFileSync(
		"stryker.log",
		"Result: 1 of " + patterns.length * 3 + " mutant result(s) are reused.\n",
	);
}
if (control.writeReport !== false) {
	fs.mkdirSync("reports/mutation", { recursive: true });
	fs.writeFileSync(
		"reports/mutation/mutation.json",
		JSON.stringify({ schemaVersion: "1.0", files, thresholds: { high: 60, low: 20 } }),
	);
}
process.exit(control.exitCode === undefined ? 0 : control.exitCode);
`;

/**
 * A fake external vitest at the driver's coverage-probe spawn target. It records
 * every argv the driver builds (so the option bag and include list are the
 * driver's own, not the test's reassumption) and, by default, exits 0 without
 * writing a coverage report -- exactly the successful probe with no report that
 * distinguishes `rmSync(..., { force: true })` from `force: false`.
 */
const FAKE_VITEST = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.mkdirSync(".fake-vitest", { recursive: true });
const reportsDirectory = (args.find((a) => a.startsWith("--coverage.reportsDirectory=")) || "").slice("--coverage.reportsDirectory=".length);
const testPath = args.find((a) => a.startsWith("tests/")) || "";
fs.appendFileSync(
	".fake-vitest/invocations.jsonl",
	JSON.stringify({
		args,
		reportsDirectory,
		includes: args
			.filter((a) => a.startsWith("--coverage.include="))
			.map((a) => a.slice("--coverage.include=".length)),
	}) + "\n",
);
let control = {};
try {
	control = JSON.parse(fs.readFileSync(".fake-vitest/control.json", "utf8"));
} catch {}
const exit = () => {
	const forThis = (control.writeCoverageFor || []).some((needle) => testPath.includes(needle));
	if ((control.writeCoverage || forThis) && reportsDirectory) {
		fs.mkdirSync(reportsDirectory, { recursive: true });
		fs.writeFileSync(reportsDirectory + "/coverage-final.json", "{}");
	}
	process.exit(control.exitCode === undefined ? 0 : control.exitCode);
};
if (control.sleepMs > 0) setTimeout(exit, control.sleepMs);
else exit();
`;

/** Every fake-vitest invocation this fixture recorded, oldest first. */
function fakeVitestInvocations(root: string) {
	const file = join(root, ".fake-vitest", "invocations.jsonl");
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

/** Link the repo's real packages into a fixture, with a fake Stryker in `.bin`. */
function linkRealNodeModules(
	nm: string,
	{ fakeVitest = false }: { fakeVitest?: boolean } = {},
) {
	const realNM = join(repositoryRoot, "node_modules");
	mkdirSync(nm);
	const linkTarget = (target: string) =>
		process.platform === "win32"
			? statSync(target).isDirectory()
				? "junction"
				: "file"
			: undefined;
	for (const entry of readdirSync(realNM)) {
		if (entry === ".bin") continue;
		const target = join(realNM, entry);
		symlinkSync(target, join(nm, entry), linkTarget(target));
	}
	mkdirSync(join(nm, ".bin"));
	for (const bin of readdirSync(join(realNM, ".bin"))) {
		if (bin.startsWith("stryker")) continue;
		if (fakeVitest && /^vitest(\.cmd)?$/i.test(bin)) continue;
		const target = join(realNM, ".bin", bin);
		symlinkSync(target, join(nm, ".bin", bin), linkTarget(target));
	}
	writeFileSync(join(nm, ".bin", "stryker"), FAKE_STRYKER, { mode: 0o755 });
	if (fakeVitest) {
		writeFileSync(join(nm, ".bin", "vitest"), FAKE_VITEST, { mode: 0o755 });
		if (process.platform === "win32") {
			writeFileSync(
				join(nm, ".bin", "vitest.cmd"),
				'@echo off\r\nnode "%~dp0vitest" %*\r\n',
			);
		}
	}
	if (process.platform === "win32") {
		writeFileSync(
			join(nm, ".bin", "stryker.cmd"),
			'@echo off\r\nnode "%~dp0stryker" %*\r\n',
		);
	}
}

type DriverFixtureOptions = {
	/** true: the PR's test calls the changed function, so coverage keeps it. */
	covering: boolean;
	/** true: add a compiled `clients/thing.ts` mutation source and its test. */
	includeCompiled: boolean;
	/** true: replace the probe binary with {@link FAKE_VITEST}. */
	fakeVitest?: boolean;
	/** true: a changed `clients/skipped.ts` with no compiled output/map. */
	skippedCompiled?: boolean;
	/** true: a changed `clients/corrupt.ts` whose `.js.map` is unparseable. */
	corruptCompiled?: boolean;
	/** true: a changed `scripts/ws.mjs` whose only change is whitespace. */
	whitespaceCovered?: boolean;
	/** N: a covered `scripts/many.mjs` with N separate one-line changed hunks. */
	manyRanges?: number;
};

/**
 * A throwaway git repo shaped like the real mutation lane: a changed script and
 * (optionally) a compiled `clients/` source, the repo's real `node_modules`
 * linked in, and {@link FAKE_STRYKER} at the driver's spawn target. Two arms:
 * `covering` makes the change behavior-preserving with a test that executes the
 * changed line; the other arm changes a return value the test never calls.
 */
function buildDriverFixture({
	covering,
	includeCompiled,
	fakeVitest = false,
	skippedCompiled = false,
	corruptCompiled = false,
	whitespaceCovered = false,
	manyRanges = 0,
}: DriverFixtureOptions) {
	const root = strykerFixtureDir("stryker-diff-fixture-");
	mkdirSync(join(root, "scripts"));
	mkdirSync(join(root, "src"));
	mkdirSync(join(root, "tests", "scripts"), { recursive: true });
	mkdirSync(join(root, "tests", "config"));
	if (includeCompiled || skippedCompiled || corruptCompiled) {
		mkdirSync(join(root, "clients"), { recursive: true });
		mkdirSync(join(root, "tests", "clients"), { recursive: true });
	}
	writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
	// Its own vitest config: without one vitest walks up to the repo's, whose
	// globalSetup belongs to the repo's suite, not this fixture.
	writeFileSync(join(root, "vitest.config.mjs"), "export default {};\n");
	writeFileSync(
		join(root, "tsconfig.mutation.json"),
		JSON.stringify({
			compilerOptions: { sourceMap: true, module: "nodenext" },
			files: includeCompiled
				? ["src/empty.ts", "clients/thing.ts"]
				: ["src/empty.ts"],
		}),
	);
	writeFileSync(join(root, "src", "empty.ts"), "export {};\n");
	writeFileSync(
		join(root, "scripts", "thing.mjs"),
		"export function used() {\n\treturn 1;\n}\nexport function changed() {\n\treturn 2;\n}\n",
	);
	// A second changed script whose only change is indentation: five changed
	// lines to a plain diff, none to `git diff -w`. The cap of one file must
	// keep the script whose single line really changed (the #3797 review).
	writeFileSync(
		join(root, "scripts", "a-reflowed.mjs"),
		"export const a = 1;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\nexport const e = 5;\n",
	);
	// A changed script whose change is whitespace-only, with a test that really
	// executes it: the cap's weighting ignores whitespace, but the mutated
	// ranges must not.
	if (whitespaceCovered) {
		writeFileSync(join(root, "scripts", "ws.mjs"), "export const ws = 1;\n");
		writeFileSync(
			join(root, "tests", "scripts", "ws.test.ts"),
			'import { expect, it } from "vitest";\nimport { ws } from "../../scripts/ws.mjs";\nit("reads ws", () => {\n\texpect(ws).toBe(1);\n});\n',
		);
	}
	writeFileSync(
		join(root, "tests", "scripts", "thing.test.ts"),
		covering
			? 'import { expect, it } from "vitest";\nimport { changed } from "../../scripts/thing.mjs";\nit("executes the changed line", () => {\n\texpect(changed()).toBe(2);\n});\n'
			: 'import { expect, it } from "vitest";\nimport { used } from "../../scripts/thing.mjs";\nit("uses the unchanged function", () => {\n\texpect(used()).toBe(1);\n});\n',
	);
	// A second related test: the probes run side by side, and a pool of one
	// cannot tell a bounded pool from a broken one.
	writeFileSync(
		join(root, "tests", "scripts", "thing-other.test.ts"),
		'import { expect, it } from "vitest";\nimport { used } from "../../scripts/thing.mjs";\nit("also uses the unchanged function", () => {\n\texpect(used() + 1).toBe(2);\n});\n',
	);
	if (includeCompiled) {
		writeFileSync(
			join(root, "clients", "thing.ts"),
			"export function changed(): number {\n\treturn 2;\n}\n",
		);
		writeFileSync(
			join(root, "tests", "clients", "thing.test.ts"),
			'import { expect, it } from "vitest";\nimport { changed } from "../../clients/thing.js";\nit("executes the compiled changed line", () => {\n\texpect(changed()).toBe(2);\n});\n',
		);
	}
	// A PR-own test the exclusion registry excludes for a reason.
	writeFileSync(
		join(root, "tests", "scripts", "own.test.ts"),
		'// mutation-lane: exclude\nimport { it } from "vitest";\nit("is scheduling-sensitive", () => {});\n',
	);
	writeFileSync(
		join(root, "tests", "config", "stryker-diff-exclusions.json"),
		JSON.stringify({
			"tests/scripts/own.test.ts": { reason: "fixture: scheduling-sensitive" },
		}),
	);
	// A probe directory a killed earlier run left behind.
	mkdirSync(join(root, ".stryker", "coverage", "stale"), { recursive: true });
	writeFileSync(
		join(root, ".stryker", "coverage", "stale", "coverage-final.json"),
		"{}",
	);
	// A changed compiled source tsc never emits (not in the tsconfig `files`),
	// and one whose emitted `.js.map` exists but is unparseable. Each exercises
	// the driver's skipped-compiled branch without a fake build.
	if (skippedCompiled) {
		writeFileSync(
			join(root, "clients", "skipped.ts"),
			"export const skipped = 1;\n",
		);
		writeFileSync(
			join(root, "tests", "clients", "skipped.test.ts"),
			'import { it } from "vitest";\nit("sibling", () => {});\n',
		);
	}
	if (corruptCompiled) {
		writeFileSync(
			join(root, "clients", "corrupt.ts"),
			"export const corrupt = 1;\n",
		);
		writeFileSync(
			join(root, "tests", "clients", "corrupt.test.ts"),
			'import { it } from "vitest";\nit("sibling", () => {});\n',
		);
	}
	// #4171: N one-line exports, a kept line between each so `git diff -U0`
	// yields N separate ranges; one test calls them all so every range is covered.
	const manyBody = (value: (index: number) => number) =>
		Array.from(
			{ length: manyRanges },
			(_, index) =>
				`export const f${index} = () => ${value(index)};\n// keep\n`,
		).join("");
	if (manyRanges > 0) {
		writeFileSync(
			join(root, "scripts", "many.mjs"),
			manyBody((i) => i),
		);
		writeFileSync(
			join(root, "tests", "scripts", "many.test.ts"),
			`import { expect, it } from "vitest";\nimport * as many from "../../scripts/many.mjs";\nit("calls every function", () => {\n\texpect(Object.values(many).map((f) => (f as () => number)())).toHaveLength(${manyRanges});\n});\n`,
		);
	}
	linkRealNodeModules(join(root, "node_modules"), { fakeVitest });
	const git = (args: string[]) => fixtureGit(root, args);
	git(["init", "-q", "-b", "main"]);
	git(["add", "."]);
	git(["commit", "-qm", "base"]);
	git(["checkout", "-qb", "feature"]);
	writeFileSync(
		join(root, "scripts", "thing.mjs"),
		covering
			? "export function used() {\n\treturn 1;\n}\nexport function changed() {\n\tconst two = 2;\n\treturn two;\n}\n"
			: "export function used() {\n\treturn 1;\n}\nexport function changed() {\n\treturn 3;\n}\n",
	);
	if (includeCompiled) {
		writeFileSync(
			join(root, "clients", "thing.ts"),
			"export function changed(): number {\n\tconst two = 2;\n\treturn two;\n}\n",
		);
	}
	writeFileSync(
		join(root, "scripts", "a-reflowed.mjs"),
		"  export const a = 1;\n  export const b = 2;\n  export const c = 3;\n  export const d = 4;\n  export const e = 5;\n",
	);
	writeFileSync(
		join(root, "tests", "scripts", "own.test.ts"),
		'// mutation-lane: exclude\nimport { it } from "vitest";\nit("is scheduling-sensitive", () => {});\n// touched by the PR\n',
	);
	if (skippedCompiled) {
		writeFileSync(
			join(root, "clients", "skipped.ts"),
			"export const skipped = 2;\n",
		);
	}
	if (corruptCompiled) {
		writeFileSync(
			join(root, "clients", "corrupt.ts"),
			"export const corrupt = 2;\n",
		);
		// Present on disk, unparseable: the `existsSync` guard passes and the
		// JSON read is what fails.
		writeFileSync(
			join(root, "clients", "corrupt.js"),
			"exports.corrupt = 2;\n",
		);
		writeFileSync(join(root, "clients", "corrupt.js.map"), "{ not json");
	}
	if (whitespaceCovered) {
		writeFileSync(join(root, "scripts", "ws.mjs"), "  export const ws = 1;\n");
	}
	if (manyRanges > 0) {
		writeFileSync(
			join(root, "scripts", "many.mjs"),
			manyBody((i) => i + 100),
		);
	}
	git(["commit", "-qam", "change the function"]);
	return {
		root,
		git,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

/** Every fake-Stryker invocation this fixture recorded, oldest first. */
function fakeStrykerInvocations(root: string) {
	const file = join(root, ".fake-stryker", "invocations.jsonl");
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

const sha256 = (value: string) =>
	createHash("sha256").update(value).digest("hex");

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
		const fixtureRepo = strykerFixtureDir("stryker-diff-fixture-");
		try {
			// One commit, no files under scripts/**/*.mjs, clients/**/*.ts,
			// tools/**/*.ts, mcp/**/*.ts, or index.ts -- `--base HEAD` then diffs
			// HEAD against itself (empty), landing on the very first early-exit
			// branch (`files.length === 0`), the earliest of the four vulnerable
			// call sites.
			writeFileSync(join(fixtureRepo, "README.md"), "fixture\n");
			fixtureGit(fixtureRepo, ["init", "-q"]);
			fixtureGit(fixtureRepo, ["add", "README.md"]);
			fixtureGit(fixtureRepo, ["commit", "-qm", "fixture"]);

			const result = runDriver(fixtureRepo, ["--base", "HEAD"], 30_000);

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

// #4005: the nightly passes --runtime-only so changed scripts/**/*.mjs stop
// competing for the --max-files slots with the runtime files the report is
// about. Recurrence: a busy window (real data, 2026-10-01: 81 eligible runtime
// files and 42 scripts, top-12 = 5 runtime + 7 scripts) leaving runtime files
// over the cap behind a marker that advanced. Real spawn against a throwaway
// repo: the flag is read in the driver's own top-level flow.
describe.skipIf(underStryker)("--runtime-only (#4005)", () => {
	const reasonFor = (extraArgs: string[]) => {
		const fixtureRepo = strykerFixtureDir("stryker-diff-fixture-");
		try {
			writeFileSync(join(fixtureRepo, "README.md"), "fixture\n");
			fixtureGit(fixtureRepo, ["init", "-q"]);
			fixtureGit(fixtureRepo, ["add", "README.md"]);
			fixtureGit(fixtureRepo, ["commit", "-qm", "base"]);
			mkdirSync(join(fixtureRepo, "scripts"));
			writeFileSync(
				join(fixtureRepo, "scripts", "only.mjs"),
				"export const a = 1;\n",
			);
			fixtureGit(fixtureRepo, ["add", "scripts/only.mjs"]);
			fixtureGit(fixtureRepo, ["commit", "-qm", "scripts only"]);
			runDriver(fixtureRepo, ["--base", "HEAD~1", ...extraArgs], 30_000);
			return JSON.parse(
				readFileSync(
					join(fixtureRepo, "reports", "mutation", "mutation.json"),
					"utf8",
				),
			).piLensMutationDiff.zeroMutants.reason as string;
		} finally {
			rmSync(fixtureRepo, { recursive: true, force: true });
		}
	};

	it("drops a changed script from the mutation population", () => {
		expect(reasonFor(["--runtime-only"])).toContain(
			"no PR-changed lines fall under clients/**/*.ts",
		);
	});

	// Recurrence (#4005): the queue is read from an issue body a maintainer can
	// edit; the driver must take the valid existing runtime entries, in order,
	// and nothing else, before the cap.
	it("mutates queued files first and drops every invalid or vanished queue entry", () => {
		const fixtureRepo = strykerFixtureDir("stryker-diff-fixture-");
		try {
			mkdirSync(join(fixtureRepo, "clients"));
			mkdirSync(join(fixtureRepo, "scripts"));
			for (const file of ["clients/q1.ts", "clients/q2.ts", "scripts/s.mjs"])
				writeFileSync(join(fixtureRepo, file), "export const a = 1;\n");
			writeFileSync(join(fixtureRepo, "README.md"), "fixture\n");
			fixtureGit(fixtureRepo, ["init", "-q"]);
			fixtureGit(fixtureRepo, ["add", "."]);
			fixtureGit(fixtureRepo, ["commit", "-qm", "base"]);
			writeFileSync(join(fixtureRepo, "README.md"), "changed\n");
			fixtureGit(fixtureRepo, ["commit", "-qam", "readme only"]);
			const pending = join(fixtureRepo, "pending.txt");
			writeFileSync(
				pending,
				[
					"clients/q2.ts",
					"../outside.ts",
					"clients/gone.ts",
					"scripts/s.mjs",
					"clients/q1.ts",
					"clients/q2.ts",
				].join("\n"),
			);
			runDriver(
				fixtureRepo,
				["--base", "HEAD~1", "--runtime-only", "--pending-file", pending],
				30_000,
			);
			const meta = JSON.parse(
				readFileSync(
					join(fixtureRepo, "reports", "mutation", "mutation.json"),
					"utf8",
				),
			).piLensMutationDiff;
			expect(meta.filesSelected).toEqual(["clients/q2.ts", "clients/q1.ts"]);
		} finally {
			rmSync(fixtureRepo, { recursive: true, force: true });
		}
	});

	// Recurrence (#4005 r4): one shared queue base pinned to the first
	// overloaded night. The driver must read a queued file against the base
	// its own entry carries (the sha reaches git), take a well-formed entry
	// whose base git knows, and refuse a malformed base suffix outright.
	it("reads each queued file against its own entry's base", () => {
		const fixtureRepo = strykerFixtureDir("stryker-diff-fixture-");
		try {
			mkdirSync(join(fixtureRepo, "clients"));
			for (const file of ["clients/q1.ts", "clients/q2.ts"])
				writeFileSync(join(fixtureRepo, file), "export const a = 1;\n");
			fixtureGit(fixtureRepo, ["init", "-q"]);
			fixtureGit(fixtureRepo, ["add", "."]);
			fixtureGit(fixtureRepo, ["commit", "-qm", "base"]);
			const first = String(
				fixtureGit(fixtureRepo, ["rev-parse", "HEAD"]),
			).trim();
			writeFileSync(join(fixtureRepo, "README.md"), "readme\n");
			fixtureGit(fixtureRepo, ["add", "README.md"]);
			fixtureGit(fixtureRepo, ["commit", "-qm", "readme only"]);
			const pending = join(fixtureRepo, "pending.txt");
			const unknown = "e".repeat(40);
			writeFileSync(
				pending,
				[`clients/q1.ts@${first}`, "clients/q2.ts@--output"].join("\n"),
			);
			runDriver(
				fixtureRepo,
				["--base", "HEAD~1", "--runtime-only", "--pending-file", pending],
				30_000,
			);
			expect(
				JSON.parse(
					readFileSync(
						join(fixtureRepo, "reports", "mutation", "mutation.json"),
						"utf8",
					),
				).piLensMutationDiff.filesSelected,
			).toEqual(["clients/q1.ts"]);
			writeFileSync(pending, `clients/q1.ts@${unknown}\n`);
			const result = runDriverResult(
				fixtureRepo,
				["--base", "HEAD~1", "--runtime-only", "--pending-file", pending],
				30_000,
			);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain(
				`could not read changed lines of ${unknown}...HEAD`,
			);
		} finally {
			rmSync(fixtureRepo, { recursive: true, force: true });
		}
	});

	it("still takes the script without the flag (the PR-time behaviour)", () => {
		expect(reasonFor([])).toContain(
			"no changed mutation source has a covering test",
		);
	});
});

// #4005: the nightly's carry-over queue. Recurrence: on a busy streak the
// same top-weight files won every night and the rest were never mutated.
describe("selectMutationFiles (#4005)", () => {
	const weights = new Map([
		["clients/heavy.ts", 90],
		["clients/mid.ts", 20],
		["clients/light.ts", 1],
	]);

	it("takes queued files first, in queue order, then the window by weight, under one cap", () => {
		expect(
			selectMutationFiles({
				pending: ["clients/light.ts", "clients/queued.ts"],
				windowFiles: ["clients/mid.ts", "clients/heavy.ts", "clients/light.ts"],
				maxFiles: 3,
				weights,
			}),
		).toEqual({
			selected: ["clients/light.ts", "clients/queued.ts", "clients/heavy.ts"],
			skipped: ["clients/mid.ts"],
		});
	});

	it("skips queued files beyond the cap, oldest-first order kept, before any window file", () => {
		expect(
			selectMutationFiles({
				pending: ["clients/q1.ts", "clients/q2.ts", "clients/q3.ts"],
				windowFiles: ["clients/heavy.ts"],
				maxFiles: 2,
				weights,
			}),
		).toEqual({
			selected: ["clients/q1.ts", "clients/q2.ts"],
			skipped: ["clients/q3.ts", "clients/heavy.ts"],
		});
	});

	it("is the plain by-weight cap when nothing is queued", () => {
		const windowFiles = [
			"clients/light.ts",
			"clients/heavy.ts",
			"clients/mid.ts",
		];
		expect(selectMutationFiles({ windowFiles, maxFiles: 2, weights })).toEqual(
			capMutationFiles(windowFiles, 2, weights),
		);
	});
});

describe("collectChangedRanges (#4005)", () => {
	// Recurrence: a queued file's earlier changes are outside the current
	// window, so reading it against the window base left it with no lines; and
	// (r4) one shared queue base re-read every carried file from the oldest
	// contributing night.
	it("reads each queued file against its own base, every other file against the window base, one diff per base", () => {
		const calls: Array<[string, string[]]> = [];
		const diff = (base: string, files: string[]) => {
			calls.push([base, files]);
			return new Map(
				files.map((file) => [file, [[1, 1]] as Array<[number, number]>]),
			);
		};
		const ranges = collectChangedRanges({
			files: [
				"clients/q1.ts",
				"clients/q2.ts",
				"clients/w.ts",
				"clients/q3.ts",
			],
			baseRef: "window-base",
			baseOf: new Map([
				["clients/q1.ts", "night-1"],
				["clients/q2.ts", "night-2"],
				["clients/q3.ts", "night-1"],
			]),
			diff,
		});
		expect(calls).toEqual([
			["window-base", ["clients/w.ts"]],
			["night-1", ["clients/q1.ts", "clients/q3.ts"]],
			["night-2", ["clients/q2.ts"]],
		]);
		expect([...ranges.keys()].sort()).toEqual([
			"clients/q1.ts",
			"clients/q2.ts",
			"clients/q3.ts",
			"clients/w.ts",
		]);
	});

	it("uses the window base for a queued file whose entry has no base", () => {
		const calls: string[] = [];
		collectChangedRanges({
			files: ["clients/q.ts"],
			baseRef: "window-base",
			diff: (base) => {
				calls.push(base);
				return new Map();
			},
		});
		expect(calls).toEqual(["window-base"]);
	});
});

describe("parseQueueEntry (#4005 r4)", () => {
	const SHA = "a".repeat(40);
	it.each([
		[`clients/a.ts@${SHA}`, { file: "clients/a.ts", base: SHA }],
		["clients/a.ts", { file: "clients/a.ts", base: null }],
		[" index.ts ", { file: "index.ts", base: null }],
		["clients/@scope/x.ts", { file: "clients/@scope/x.ts", base: null }],
		[`clients/@scope/x.ts@${SHA}`, { file: "clients/@scope/x.ts", base: SHA }],
	])("reads %s", (spelling, entry) => {
		expect(parseQueueEntry(spelling)).toEqual(entry);
		expect(parseQueueEntry(formatQueueEntry(entry))).toEqual(entry);
	});

	// Recurrence: the base suffix reaches `git diff <base>...HEAD` as an
	// argument; only a full lowercase sha may be split off, and a spelling whose
	// suffix is anything else is not a runtime path at all.
	it.each([
		"clients/a.ts@--output",
		"clients/a.ts@abc123",
		`clients/a.ts@${"A".repeat(40)}`,
		`clients/a.ts@${SHA}@${SHA}`,
		`../index.ts@${SHA}`,
		`scripts/a.mjs@${SHA}`,
		`@${SHA}`,
		"",
		undefined,
	])("refuses %s", (spelling) => {
		expect(parseQueueEntry(spelling)).toBeNull();
	});
});

describe("isQueueablePath (#4005)", () => {
	it("admits runtime sources spelled as plain relative paths", () => {
		for (const file of [
			"index.ts",
			"clients/a.ts",
			"clients/lsp/x.ts",
			"tools/t.ts",
			"mcp/m.ts",
		])
			expect(isQueueablePath(file), file).toBe(true);
	});

	// Recurrence: the queue is an editable issue body whose entries reach git
	// and Stryker's --mutate.
	it.each([
		"clients/../index.ts",
		"/clients/a.ts",
		"clients//a.ts",
		"clients/a.ts,tools/b.ts",
		"clients/a.ts -->",
		"clients\\a.ts",
		"scripts/a.mjs",
		"clients/a.test.ts",
		"clients/a.d.ts",
		"",
		undefined,
	])("refuses %s", (file) => {
		expect(isQueueablePath(file)).toBe(false);
	});
});

describe("instrumentation detection (#3810)", () => {
	// Recurrence: a skip condition that is always true switches the wiring pins
	// off in the ordinary lane without a red; one that is never true lets them
	// red the mutation lane's dry run (CI run 36787524136).
	it("recognises Stryker's instrumentation header and not plain source", () => {
		expect(isInstrumented("function stryNS_9fa48() {\n}\nconst a = 1;")).toBe(
			true,
		);
		// A file the lane rewrote but placed no mutant in (its ranges held none) has
		// no header, only the `// @ts-nocheck` Stryker's preprocessor prepends, and
		// its text is still re-printed (CI run 36805707289 red the dry run on it).
		expect(isInstrumented('// @ts-nocheck\nimport x from "y";')).toBe(true);
		expect(isInstrumented("const a = 1; // no header here")).toBe(false);
		expect(isInstrumented('import x from "y"; // @ts-nocheck later')).toBe(
			false,
		);
	});
});

describe("driver selection stage, spawned for real (#3810)", () => {
	// Recurrence this guards: a selector that hands vitest an EMPTY file list
	// (every probe succeeded, none executes a changed line) runs the WHOLE
	// suite as the mutation command, and a driver that wires the probe, the
	// selector and the zero-mutant exit in the wrong order cannot be seen from
	// the pure functions. The driver is a top-level script, so this spawns it
	// against a throwaway git repo whose only test imports the changed file but
	// never calls the changed function: the real tsc build, the real vitest
	// coverage probe (one process, v8, source-mapped), the real selector, and
	// the file cap reading the real `git diff -w`.
	it("probes real coverage, keeps no test when none executes a changed line, and reports a zero-mutant run instead of running the suite", () => {
		const fixtureRepo = strykerFixtureDir("stryker-diff-fixture-");
		try {
			mkdirSync(join(fixtureRepo, "scripts"));
			mkdirSync(join(fixtureRepo, "src"));
			mkdirSync(join(fixtureRepo, "tests", "scripts"), { recursive: true });
			mkdirSync(join(fixtureRepo, "tests", "config"));
			writeFileSync(join(fixtureRepo, "package.json"), '{"type":"module"}\n');
			// Its own vitest config: without one vitest walks up to the repo's,
			// whose globalSetup belongs to the repo's suite, not this fixture.
			writeFileSync(
				join(fixtureRepo, "vitest.config.mjs"),
				"export default {};\n",
			);
			writeFileSync(
				join(fixtureRepo, "tsconfig.mutation.json"),
				JSON.stringify({
					compilerOptions: { sourceMap: true, module: "nodenext" },
					files: ["src/empty.ts"],
				}),
			);
			writeFileSync(join(fixtureRepo, "src", "empty.ts"), "export {};\n");
			writeFileSync(
				join(fixtureRepo, "scripts", "thing.mjs"),
				"export function used() {\n\treturn 1;\n}\nexport function changed() {\n\treturn 2;\n}\n",
			);
			// A second changed script whose only change is indentation: five changed
			// lines to a plain diff, none to `git diff -w`. The cap of one file must
			// keep the script whose single line really changed (the #3797 review).
			writeFileSync(
				join(fixtureRepo, "scripts", "a-reflowed.mjs"),
				"export const a = 1;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\nexport const e = 5;\n",
			);
			writeFileSync(
				join(fixtureRepo, "tests", "scripts", "thing.test.ts"),
				'import { expect, it } from "vitest";\nimport { used } from "../../scripts/thing.mjs";\nit("uses the unchanged function", () => {\n\texpect(used()).toBe(1);\n});\n',
			);
			// A second related test: the probes run side by side, and a pool of one
			// cannot tell a bounded pool from a broken one.
			writeFileSync(
				join(fixtureRepo, "tests", "scripts", "thing-other.test.ts"),
				'import { expect, it } from "vitest";\nimport { used } from "../../scripts/thing.mjs";\nit("also uses the unchanged function", () => {\n\texpect(used() + 1).toBe(2);\n});\n',
			);
			// A probe directory a killed earlier run left behind.
			mkdirSync(join(fixtureRepo, ".stryker", "coverage", "stale"), {
				recursive: true,
			});
			writeFileSync(
				join(
					fixtureRepo,
					".stryker",
					"coverage",
					"stale",
					"coverage-final.json",
				),
				"{}",
			);
			// A PR-own test the exclusion registry excludes for a reason.
			writeFileSync(
				join(fixtureRepo, "tests", "scripts", "own.test.ts"),
				'// mutation-lane: exclude\nimport { it } from "vitest";\nit("is scheduling-sensitive", () => {});\n',
			);
			writeFileSync(
				join(fixtureRepo, "tests", "config", "stryker-diff-exclusions.json"),
				JSON.stringify({
					"tests/scripts/own.test.ts": {
						reason: "fixture: scheduling-sensitive",
					},
				}),
			);
			symlinkSync(
				join(repositoryRoot, "node_modules"),
				join(fixtureRepo, "node_modules"),
			);
			const git = (args: string[]) => fixtureGit(fixtureRepo, args);
			git(["init", "-q", "-b", "main"]);
			git(["add", "."]);
			git(["commit", "-qm", "base"]);
			git(["checkout", "-qb", "feature"]);
			writeFileSync(
				join(fixtureRepo, "scripts", "thing.mjs"),
				"export function used() {\n\treturn 1;\n}\nexport function changed() {\n\treturn 3;\n}\n",
			);
			writeFileSync(
				join(fixtureRepo, "scripts", "a-reflowed.mjs"),
				"  export const a = 1;\n  export const b = 2;\n  export const c = 3;\n  export const d = 4;\n  export const e = 5;\n",
			);
			writeFileSync(
				join(fixtureRepo, "tests", "scripts", "own.test.ts"),
				'// mutation-lane: exclude\nimport { it } from "vitest";\nit("is scheduling-sensitive", () => {});\n// touched by the PR\n',
			);
			git(["commit", "-qam", "change the function nobody calls"]);

			const output = runDriver(
				fixtureRepo,
				["--base", "main", "--max-files", "1"],
				120_000,
			);

			expect(output).toContain("related 2 → covering 0 → kept 0");
			expect(output).toContain("no mutants evaluated");
			const report = JSON.parse(
				readFileSync(
					join(fixtureRepo, "reports", "mutation", "mutation.json"),
					"utf8",
				),
			);
			expect(report.piLensMutationDiff.zeroMutants.reason).toContain(
				"no related test executes a changed line",
			);
			expect(report.piLensMutationDiff.filesSkippedOverCap).toEqual([
				"scripts/a-reflowed.mjs",
			]);
			// Every probe's scratch directory is gone, and so is the stale one.
			for (const gone of [
				join(fixtureRepo, ".stryker", "coverage", "stale"),
				join(fixtureRepo, probeReportsDirectory("tests/scripts/thing.test.ts")),
				join(
					fixtureRepo,
					probeReportsDirectory("tests/scripts/thing-other.test.ts"),
				),
			]) {
				expect(existsSync(gone), gone).toBe(false);
			}
			expect(report.piLensMutationDiff.testsExcluded).toEqual([
				{
					file: "tests/scripts/own.test.ts",
					reason: "fixture: scheduling-sensitive",
				},
			]);
			expect(report.piLensMutationDiff.testSelection).toEqual({
				mode: "coverage",
				pool: 2,
				covering: 0,
				kept: 0,
				dropped: 0,
				overBudget: 0,
				estimatedSeconds: 0,
				own: 0,
				unknown: 0,
			});
		} finally {
			rmSync(fixtureRepo, { recursive: true, force: true });
		}
	}, 150_000);
});

describe("driver Stryker stage, spawned for real (#3856 F3)", () => {
	it("narrows a sampled source command and fingerprints the source it does not mutate", () => {
		// #3973: real Git/build/Vitest coverage are required to witness the
		// post-sampling command; only the external Stryker cost/result is controlled.
		const fixture = buildDriverFixture({
			covering: true,
			includeCompiled: true,
		});
		try {
			const binary = join(fixture.root, "node_modules", ".bin", "stryker");
			writeFileSync(
				binary,
				readFileSync(binary, "utf8").replace(
					"in 1 seconds (net 12 ms",
					"in 5000 seconds (net 5000000 ms",
				),
			);
			const first = runDriver(fixture.root, ["--base", "main"], 120_000);
			expect(first).toContain("1 of 2 measured tests retained");
			expect(first).not.toContain("source scoping found no kept tests");
			const calls = fakeStrykerInvocations(fixture.root);
			const attempt = calls.find((call) => !call.dryRun);
			expect(attempt.patterns).toHaveLength(1);
			const scriptActive = attempt.patterns[0].startsWith("scripts/thing.mjs:");
			const kept = scriptActive
				? "tests/scripts/thing.test.ts"
				: "tests/clients/thing.test.ts";
			const omitted = scriptActive
				? "tests/clients/thing.test.ts"
				: "tests/scripts/thing.test.ts";
			expect(attempt.command).toContain(kept);
			expect(attempt.command).not.toContain(omitted);
			const report = JSON.parse(
				readFileSync(
					join(fixture.root, "reports", "mutation", "mutation.json"),
					"utf8",
				),
			);
			expect(report.piLensMutationDiff.testsRun).toEqual([kept]);
			expect(report.piLensMutationDiff.testSelection.kept).toBe(1);
			const other = join(
				fixture.root,
				scriptActive ? "clients/thing.ts" : "scripts/thing.mjs",
			);
			writeFileSync(
				other,
				readFileSync(other, "utf8") + "\nexport const dependency = 1;\n",
			);
			const next = runDriver(fixture.root, ["--base", "main"], 120_000);
			expect(next).toContain("incremental cache cold-inputs-changed");
			const finalAttempt = fakeStrykerInvocations(fixture.root)
				.filter((call) => !call.dryRun)
				.at(-1);
			expect(finalAttempt.force).toBe(true);
			// The same real sample can select a source whose probe now proves zero;
			// keep the measured nonempty command instead of launching the whole suite.
			writeFileSync(
				join(fixture.root, kept),
				`import { expect, it } from "vitest";\nimport { changed } from "${scriptActive ? "../../scripts/thing.mjs" : "../../clients/thing.js"}";\nit("loads without calling the changed body", () => expect(typeof changed).toBe("function"));\n`,
			);
			const empty = runDriver(fixture.root, ["--base", "main"], 120_000);
			expect(empty).toContain(
				"source scoping found no kept tests; retaining the measured nonempty population",
			);
			const fallbackReport = JSON.parse(
				readFileSync(
					join(fixture.root, "reports", "mutation", "mutation.json"),
					"utf8",
				),
			);
			expect(fallbackReport.piLensMutationDiff.testsRun).toEqual([omitted]);
			expect(fallbackReport.piLensMutationDiff.testSelection.kept).toBe(1);
		} finally {
			fixture.cleanup();
		}
		// Real Git/build/V8 command witnesses need three serial driver runs. CI's
		// implicit 5s expires this new case (#3978); use the mutation-comparable 30s,
		// without changing the campaign, per-mutant, or coverage-probe budgets.
	}, 30_000);
	// Recurrence this guards (#4171, run 40847865852, 2026-10-29): the sampler
	// kept floor(ranges x allowance / mutants) ranges, assuming every range holds
	// the same number of mutants; 3 of 172 ranges held 55 against an allowance of
	// ~24, the budget expired after 48 of 1197 mutants, and the job exited 1.
	// Fixture: 13 ranges, the 2 densest rank first.
	it("holds a sampled run to the mutant allowance when range density is uneven (#4171)", () => {
		const fixture = buildDriverFixture({
			covering: true,
			includeCompiled: false,
			manyRanges: 12,
		});
		try {
			const head = String(fixture.git(["rev-parse", "HEAD"])).trim();
			const ranges = [
				"scripts/thing.mjs:5-6",
				...Array.from(
					{ length: 12 },
					(_, i) => `scripts/many.mjs:${2 * i + 1}-${2 * i + 1}`,
				),
			];
			const allowance = 10;
			const binary = join(fixture.root, "node_modules", ".bin", "stryker");
			// (3_600_000 - 300_000 fixed overhead) x 0.7 / 220_000 ms = 10.5, so 10
			// mutants however many seconds the run has already spent.
			writeFileSync(
				binary,
				readFileSync(binary, "utf8").replace(
					"in 1 seconds (net 12 ms",
					"in 220 seconds (net 220000 ms",
				),
			);
			const densest = sampleRangesDeterministically(ranges, 2, head).selected;
			const density = Object.fromEntries(
				ranges.map((range) => [range, densest.includes(range) ? 8 : 2]),
			);
			const total = Object.values(density).reduce((a, b) => a + b, 0);
			// The uniform estimate keeps floor(13 x 10 / 38) = 3 ranges: 8 + 8 + 2 = 18
			// mutants against an allowance of 10.
			expect(Math.floor((ranges.length * allowance) / total)).toBe(3);
			mkdirSync(join(fixture.root, ".fake-stryker"), { recursive: true });
			writeFileSync(
				join(fixture.root, ".fake-stryker", "control.json"),
				JSON.stringify({ density }),
			);
			const output = runDriver(fixture.root, ["--base", "main"], 120_000);
			const calls = fakeStrykerInvocations(fixture.root);
			const measured = calls.find((call) => call.dryRun);
			expect([...measured.patterns].sort()).toEqual([...ranges].sort());
			const real = calls.find((call) => !call.dryRun);
			const held = real.patterns.reduce(
				(sum: number, range: string) => sum + density[range],
				0,
			);
			expect(held).toBeLessThanOrEqual(allowance);
			expect(real.patterns).toHaveLength(1);
			expect(output).toContain(
				`sampled mutants ${held} of ${allowance} allowed`,
			);
			// Counting a sample must not run the related tests: every dry run after
			// the measurement is a no-test pass (3 s each, not a 1-minute dry run).
			const countPasses = calls.filter((call) => call.dryRun).slice(1);
			expect(countPasses.length).toBeGreaterThan(0);
			for (const pass of countPasses) {
				expect(pass.command).not.toContain("vitest");
			}
		} finally {
			fixture.cleanup();
		}
	}, 60_000);
	// Recurrence this guards (#4171): the resample retry after a zero-mutant sample
	// kept `keepRangeCount` untried ranges with no mutant bound, so it could
	// overshoot the allowance the first sample was held to.
	it("holds the resample retry to the mutant allowance too (#4171)", () => {
		const fixture = buildDriverFixture({
			covering: true,
			includeCompiled: false,
			manyRanges: 12,
		});
		try {
			const head = String(fixture.git(["rev-parse", "HEAD"])).trim();
			const ranges = [
				"scripts/thing.mjs:5-6",
				...Array.from(
					{ length: 12 },
					(_, i) => `scripts/many.mjs:${2 * i + 1}-${2 * i + 1}`,
				),
			];
			const allowance = 10;
			const binary = join(fixture.root, "node_modules", ".bin", "stryker");
			writeFileSync(
				binary,
				readFileSync(binary, "utf8").replace(
					"in 1 seconds (net 12 ms",
					"in 220 seconds (net 220000 ms",
				),
			);
			// The 2 best-ranked ranges hold no mutants, so the first sample runs
			// empty and the driver retries. The retry ranks the untried ranges under
			// its own seed; its 2 best hold 8 each, so its uniform estimate (2
			// ranges, 16 mutants) overshoots 10. Every other range holds 4.
			const empty = sampleRangesDeterministically(ranges, 2, head).selected;
			const untried = ranges.filter((range) => !empty.includes(range));
			const heavy = sampleRangesDeterministically(
				untried,
				2,
				`${head}:retry0`,
			).selected;
			const density = Object.fromEntries(
				ranges.map((range) => [
					range,
					empty.includes(range) ? 0 : heavy.includes(range) ? 8 : 4,
				]),
			);
			const total = Object.values(density).reduce((a, b) => a + b, 0);
			expect(Math.floor((ranges.length * allowance) / total)).toBe(2);
			mkdirSync(join(fixture.root, ".fake-stryker"), { recursive: true });
			writeFileSync(
				join(fixture.root, ".fake-stryker", "control.json"),
				JSON.stringify({ density }),
			);
			const output = runDriver(fixture.root, ["--base", "main"], 120_000);
			const realRuns = fakeStrykerInvocations(fixture.root).filter(
				(call) => !call.dryRun,
			);
			expect(realRuns[0].patterns.slice().sort()).toEqual(empty.slice().sort());
			const retry = realRuns[1];
			expect(retry.patterns).toHaveLength(1);
			expect(density[retry.patterns[0]]).toBeLessThanOrEqual(allowance);
			expect(output).toContain(
				"retry sample of 1 range(s); sampled mutants 8 of 10 allowed",
			);
		} finally {
			fixture.cleanup();
		}
	}, 60_000);
	// Recurrence this guards (#4989 F1): `remainingBudgetMs()` bottoms out at
	// exactly 0 and `spawnSync` reads `timeout: 0` as NO timeout, so a spent
	// budget launched the measurement pass with no kill bound. Probe:
	// `timeout:1 -> error=ETIMEDOUT` against `timeout:0 -> ` a 20 s child that
	// ran to completion. The fake Stryker hangs its dry run, so only a real kill
	// bound ends this driver run instead of the harness timeout.
	it("kills a Stryker child a spent budget would leave unbounded (#4989 F1)", () => {
		const fixture = buildDriverFixture({
			covering: true,
			includeCompiled: false,
		});
		try {
			mkdirSync(join(fixture.root, ".fake-stryker"), { recursive: true });
			writeFileSync(
				join(fixture.root, ".fake-stryker", "control.json"),
				JSON.stringify({ dryRunHangMs: 20_000 }),
			);
			// A 0-minute budget is spent before the first Stryker child.
			const result = runDriverResult(
				fixture.root,
				["--base", "main", "--budget-minutes", "0"],
				10_000,
			);
			expect(result.error).toBeUndefined();
			expect(result.status).toBe(1);
			expect(`${result.stdout}${result.stderr}`).toContain(
				"the 0-minute mutation budget expired before Stryker produced a result",
			);
		} finally {
			fixture.cleanup();
		}
	}, 60_000);
	// Recurrence this guards (#4989, "skip the retry when the retry allowance is
	// zero"): the first sample stops when the remaining budget affords no mutant
	// (`allowedMutants === 0`), but the retry did not -- it spawned its count
	// passes and another full run the budget could not pay for. The fake Stryker
	// spends the first real run's wall clock, so the budget that reaches the
	// retry is below the fixed run overhead.
	it("spends no retry when the remaining budget affords no mutant (#4989)", () => {
		const fixture = buildDriverFixture({
			covering: true,
			includeCompiled: false,
			manyRanges: 12,
		});
		try {
			const head = String(fixture.git(["rev-parse", "HEAD"])).trim();
			const ranges = [
				"scripts/thing.mjs:5-6",
				...Array.from(
					{ length: 12 },
					(_, i) => `scripts/many.mjs:${2 * i + 1}-${2 * i + 1}`,
				),
			];
			const binary = join(fixture.root, "node_modules", ".bin", "stryker");
			// 5 minutes of fixed overhead, and a 220 s dry run: the remaining budget
			// (5.5 minutes minus what the run has spent) affords exactly one mutant,
			// so the sample keeps the one range that holds none.
			writeFileSync(
				binary,
				readFileSync(binary, "utf8").replace(
					"in 1 seconds (net 12 ms",
					"in 220 seconds (net 220000 ms",
				),
			);
			const empty = sampleRangesDeterministically(ranges, 1, head).selected;
			const density = Object.fromEntries(
				ranges.map((range) => [range, empty.includes(range) ? 0 : 4]),
			);
			const total = Object.values(density).reduce((a, b) => a + b, 0);
			// The uniform estimate keeps no range at all: 13 x 1 / 48 = 0, floored up
			// to the one range that holds the sample's whole mutant count.
			expect(Math.floor((ranges.length * 1) / total)).toBe(0);
			mkdirSync(join(fixture.root, ".fake-stryker"), { recursive: true });
			writeFileSync(
				join(fixture.root, ".fake-stryker", "control.json"),
				JSON.stringify({ density, firstRealRunClockSkewMs: 40_000 }),
			);
			// #3801: the first real run used to sleep 40 s of real time. The preload
			// (the driver process only, not its tsc/vitest/Stryker children) adds the
			// offset the fake Stryker writes to Date.now, which is all the driver's
			// budget reads (scripts/stryker-diff.mjs remainingBudgetMs).
			const preload = join(fixture.root, ".fake-stryker", "clock-skew.mjs");
			writeFileSync(
				preload,
				[
					'import { readFileSync } from "node:fs";',
					'import { basename } from "node:path";',
					'if (basename(process.argv[1] ?? "") === "stryker-diff.mjs") {',
					"	const realNow = Date.now.bind(Date);",
					"	let offset = 0;",
					"	Date.now = () => {",
					"		if (offset === 0) {",
					"			try {",
					'				offset = Number(readFileSync(".fake-stryker/clock-offset-ms", "utf8")) || 0;',
					"			} catch {}",
					"		}",
					"		return realNow() + offset;",
					"	};",
					"}",
					"",
				].join("\n"),
			);
			const result = runDriverResult(
				fixture.root,
				["--base", "main", "--budget-minutes", "5.5"],
				120_000,
				{
					...process.env,
					NODE_OPTIONS: `--import ${pathToFileURL(preload).href}`,
				},
			);
			expect(result.error).toBeUndefined();
			const calls = fakeStrykerInvocations(fixture.root);
			const firstReal = calls.findIndex((call) => !call.dryRun);
			expect(firstReal).toBeGreaterThan(0);
			// Nothing is spawned after the zero-mutant run: no count pass, no retry.
			expect(calls).toHaveLength(firstReal + 1);
			expect(result.status).toBe(0);
			expect(result.stdout).toContain(
				`sampled 1 of ${ranges.length} ranges deterministically`,
			);
			expect(result.stdout).not.toContain("retry sample of");
		} finally {
			fixture.cleanup();
		}
	}, 120_000);
	// Recurrence this guards (#3810 F3): the driver's fingerprint, incremental
	// decision, generated Stryker config and run loop sat past the zero-mutant
	// exits, so mutants on those added lines survived. This fixture installs a
	// fake external Stryker at the driver's real spawn target and runs the real
	// driver cold, then warm, then with a changed fingerprinted input -- real
	// git, real tsc build, real vitest coverage probes, real cache files.
	it("runs the real Stryker stage cold, warm, and on a changed fingerprint input", () => {
		const fixture = buildDriverFixture({
			covering: true,
			includeCompiled: true,
		});
		try {
			const mergeBase = String(
				fixture.git(["merge-base", "main", "HEAD"]),
			).trim();
			const testSelection = {
				mode: "coverage",
				pool: 3,
				covering: 2,
				kept: 2,
				dropped: 0,
				overBudget: 0,
				// Measured by the real probes, so it differs run to run.
				estimatedSeconds: expect.any(Number),
				own: 0,
				unknown: 0,
			};

			const cold = runDriver(fixture.root, ["--base", "main"], 120_000);
			expect(cold).toContain(
				"mutation diff: related 3 → covering 2 → kept 2\n",
			);
			expect(cold).toContain(
				"mutation diff: measuring which of 3 candidate test file(s) execute a changed line",
			);
			expect(cold).toContain(
				"mutation diff: running 2 test file(s), related 3",
			);
			expect(cold).toContain("incremental cache cold-no-cache\n");
			expect(cold).not.toContain("incremental cache cold-no-cache (");
			expect(cold).toContain("mutation diff: mutating scripts/thing.mjs:");
			expect(cold).toContain("clients/thing.js:");
			expect(cold).toContain("mutation diff: completed");
			const coldReport = JSON.parse(
				readFileSync(
					join(fixture.root, "reports", "mutation", "mutation.json"),
					"utf8",
				),
			);
			expect(coldReport.piLensMutationDiff.zeroMutants).toBeNull();
			expect(coldReport.piLensMutationDiff.testSelection).toEqual(
				testSelection,
			);
			expect(coldReport.piLensMutationDiff.rangesTotal).toBe(2);
			expect(coldReport.piLensMutationDiff.counts).toEqual({
				Killed: 2,
				Survived: 2,
				Timeout: 2,
			});
			expect(coldReport.piLensMutationDiff.incremental).toEqual({
				state: "cold-no-cache",
			});

			// The fingerprint's inputs are recomputed independently, not mirrored.
			const coldFingerprint = JSON.parse(
				readFileSync(
					join(fixture.root, ".stryker", "incremental.fingerprint"),
					"utf8",
				),
			);
			expect(coldFingerprint.inputs["fork-point"]).toBe(sha256(mergeBase));
			expect(coldFingerprint.inputs.node).toBe(
				sha256(process.versions.node.split(".")[0]),
			);
			expect(coldFingerprint.inputs["stryker.config.mjs"]).toBe(
				sha256("<absent>"),
			);
			expect(coldFingerprint.inputs["tests/scripts/thing.test.ts"]).toBe(
				sha256(
					readFileSync(
						join(fixture.root, "tests", "scripts", "thing.test.ts"),
						"utf8",
					),
				),
			);

			// The fake Stryker saw the real config, commands and cache state.
			const coldInvocations = fakeStrykerInvocations(fixture.root);
			expect(coldInvocations).toHaveLength(2);
			expect(coldInvocations[0]).toMatchObject({
				dryRun: true,
				force: true,
				configFile: ".stryker/diff.config.mjs",
			});
			expect(coldInvocations[0].command).toContain("--testTimeout 30000");
			expect(coldInvocations[1]).toMatchObject({
				dryRun: false,
				force: true,
				incremental: true,
				configFile: ".stryker/diff.config.mjs",
				incrementalPresent: false,
			});
			expect(coldInvocations[1].command).toContain(
				"tests/scripts/thing.test.ts",
			);
			expect(coldInvocations[1].command).toContain(
				"tests/clients/thing.test.ts",
			);

			// The artifacts the cold run wrote make the second run reusable.
			const warm = runDriver(fixture.root, ["--base", "main"], 120_000);
			expect(warm).toContain("incremental cache warm\n");
			const warmReport = JSON.parse(
				readFileSync(
					join(fixture.root, "reports", "mutation", "mutation.json"),
					"utf8",
				),
			);
			expect(warmReport.piLensMutationDiff.incremental).toEqual({
				state: "warm",
				reused: 1,
				total: 6,
			});
			const warmInvocations = fakeStrykerInvocations(fixture.root);
			expect(warmInvocations).toHaveLength(4);
			expect(warmInvocations[2]).toMatchObject({ dryRun: true, force: true });
			expect(warmInvocations[3]).toMatchObject({
				dryRun: false,
				force: false,
				incrementalPresent: true,
			});

			// Same changed-file SET, different content: a cold-inputs-changed run.
			// TWO fingerprinted inputs change, so the change-list separator is
			// observable (a one-element join hides it).
			const ownTest = join(fixture.root, "tests", "scripts", "own.test.ts");
			writeFileSync(
				ownTest,
				`${readFileSync(ownTest, "utf8")}// changed after the warm run\n`,
			);
			const compiledTest = join(
				fixture.root,
				"tests",
				"clients",
				"thing.test.ts",
			);
			writeFileSync(
				compiledTest,
				`${readFileSync(compiledTest, "utf8")}// changed after the warm run\n`,
			);
			const changed = runDriver(fixture.root, ["--base", "main"], 120_000);
			expect(changed).toContain(
				"incremental cache cold-inputs-changed (tests/clients/thing.test.ts, tests/scripts/own.test.ts)\n",
			);
			const changedReport = JSON.parse(
				readFileSync(
					join(fixture.root, "reports", "mutation", "mutation.json"),
					"utf8",
				),
			);
			expect(changedReport.piLensMutationDiff.incremental).toEqual({
				state: "cold-inputs-changed",
				changed: ["tests/clients/thing.test.ts", "tests/scripts/own.test.ts"],
			});
			const changedInvocations = fakeStrykerInvocations(fixture.root);
			expect(changedInvocations).toHaveLength(6);
			expect(changedInvocations[5]).toMatchObject({
				dryRun: false,
				force: true,
				incrementalPresent: false,
			});
		} finally {
			fixture.cleanup();
		}
	}, 300_000);

	it("treats a restored incremental file with no fingerprint as cold and clears it before the run", () => {
		const fixture = buildDriverFixture({
			covering: true,
			includeCompiled: true,
		});
		try {
			writeFileSync(
				join(fixture.root, ".stryker", "incremental.json"),
				JSON.stringify({ schemaVersion: "1.0", files: {}, thresholds: {} }),
			);
			const output = runDriver(fixture.root, ["--base", "main"], 120_000);
			expect(output).toContain("incremental cache cold-no-cache\n");
			const invocations = fakeStrykerInvocations(fixture.root);
			expect(invocations).toHaveLength(2);
			expect(invocations[1]).toMatchObject({
				dryRun: false,
				force: true,
				incrementalPresent: false,
			});
		} finally {
			fixture.cleanup();
		}
	}, 150_000);

	it("prints the selection note for a probe with no coverage answer", () => {
		const fixture = buildDriverFixture({
			covering: true,
			includeCompiled: true,
		});
		try {
			// A related test whose probe exits non-zero is `unknown`, never 0: the
			// driver must print the note that says so, and it must clear a probe
			// directory a killed earlier run left behind even when absent.
			writeFileSync(
				join(fixture.root, "tests", "scripts", "broken.test.ts"),
				'import { it } from "vitest";\nimport { changed } from "../../scripts/thing.mjs";\nit("fails its probe", () => {\n\tthrow new Error("probe fails");\n});\n',
			);
			rmSync(join(fixture.root, ".stryker", "coverage"), {
				recursive: true,
				force: true,
			});
			const output = runDriver(fixture.root, ["--base", "main"], 120_000);
			expect(output).toContain(
				"mutation diff: no coverage answer for: tests/scripts/broken.test.ts\n",
			);
			const report = JSON.parse(
				readFileSync(
					join(fixture.root, "reports", "mutation", "mutation.json"),
					"utf8",
				),
			);
			expect(report.piLensMutationDiff.testSelection).toMatchObject({
				unknown: 1,
				covering: 2,
			});
		} finally {
			fixture.cleanup();
		}
	}, 150_000);

	// Recurrence (#4092, run 37629970371): the count cap never bound the run --
	// the window's own test files are exempt from it -- so both shards ran 122
	// test files and the initial test run outlasted Stryker's bound. The kept
	// tests are now fitted into an estimated-seconds cap from the time each
	// coverage probe measured, through the real probes, selector and run loop.
	const fitsTheRuntimeCap = (own: boolean) => {
		const fixture = buildDriverFixture({
			covering: true,
			includeCompiled: true,
		});
		try {
			// Both covering tests take about 1.2 s in vitest's own timing, so about
			// 1.7 s each with the per-file overhead: a cap of three seconds fits
			// one. A probe whose time went unread would cost the unknown default
			// (3.7 s), which no estimate below can be.
			const slow = (importLine: string, call: string) =>
				`import { expect, it } from "vitest";\n${importLine}\nit("executes the changed line slowly", async () => {\n\texpect(${call}).toBe(2);\n\tawait new Promise((done) => setTimeout(done, 1200));\n});\n`;
			writeFileSync(
				join(fixture.root, "tests", "scripts", "thing.test.ts"),
				slow('import { changed } from "../../scripts/thing.mjs";', "changed()"),
			);
			writeFileSync(
				join(fixture.root, "tests", "clients", "thing.test.ts"),
				slow('import { changed } from "../../clients/thing.js";', "changed()"),
			);
			if (own) fixture.git(["commit", "-qam", "make both tests slow"]);
			const output = runDriver(
				fixture.root,
				["--base", "main", "--max-dry-run-seconds", "3"],
				120_000,
			);
			expect(output).toMatch(
				/runtime-capped at 3 s of estimated test time \(kept \d+ s\); dropped, in rank order: tests\/(scripts|clients)\/thing\.test\.ts\n/,
			);
			const report = JSON.parse(
				readFileSync(
					join(fixture.root, "reports", "mutation", "mutation.json"),
					"utf8",
				),
			);
			const meta = report.piLensMutationDiff;
			expect(meta.testsRun).toHaveLength(1);
			expect(meta.testSelection).toMatchObject({
				kept: 1,
				overBudget: 1,
				own: own ? 1 : 0,
			});
			expect(meta.testSelection.estimatedSeconds).toBeGreaterThanOrEqual(2);
			expect(meta.testSelection.estimatedSeconds).toBeLessThanOrEqual(3);
			const command = fakeStrykerInvocations(fixture.root).find(
				(call) => !call.dryRun,
			).command;
			expect(command).toContain(meta.testsRun[0]);
			expect(
				["tests/scripts/thing.test.ts", "tests/clients/thing.test.ts"].filter(
					(test) => command.includes(test),
				),
			).toEqual(meta.testsRun);
		} finally {
			fixture.cleanup();
		}
	};
	it("fits the kept tests into the runtime cap from the seconds the real probes measured, for related tests", () => {
		fitsTheRuntimeCap(false);
	}, 150_000);
	// Committed, so they are the PR's own tests: exempt from the count cap and
	// from the zero-coverage drop, and re-added to the pool of the run loop's
	// second selection, which must apply the cap again.
	it("fits the kept tests into the runtime cap from the seconds the real probes measured, for the PR's own tests", () => {
		fitsTheRuntimeCap(true);
	}, 150_000);

	// Recurrence (R2 of #4108, run 37650871948): Stryker's in-place mode wrote
	// `// @ts-nocheck` into every tracked file before the initial run, so
	// tests/scripts/mutate.test.ts ("mutate.mjs: refusing dirty file") failed 16
	// of 33 cases and both shards sat in the initial run for 460 and 525 s. The
	// REAL Stryker (only its sandbox is small) runs the repo's own config over a
	// fixture whose test fails if a tracked file was rewritten.
	// lane: Unit tests (ubuntu shards); the mutation lane runs on ubuntu only.
	it.skipIf(process.platform === "win32")(
		"leaves tracked files unrewritten in the real Stryker's initial run",
		() => {
			const fixture = buildDriverFixture({
				covering: true,
				includeCompiled: false,
			});
			try {
				writeFileSync(
					join(fixture.root, "tracked.ts"),
					"export const t = 1;\n",
				);
				writeFileSync(
					join(fixture.root, "tests", "scripts", "untouched.test.ts"),
					'import { readFileSync } from "node:fs";\nimport { expect, it } from "vitest";\nit("finds a tracked file as committed", () => {\n\texpect(readFileSync("tracked.ts", "utf8")).toBe("export const t = 1;\\n");\n});\n',
				);
				fixture.git(["add", "tracked.ts", "tests/scripts/untouched.test.ts"]);
				fixture.git(["commit", "-qm", "tracked file and its test"]);
				const configFile = join(fixture.root, ".stryker-real.config.mjs");
				writeFileSync(
					configFile,
					[
						`import base from ${JSON.stringify(pathToFileURL(join(repositoryRoot, "stryker.config.mjs")).href)};`,
						`import { buildRunConfig } from ${JSON.stringify(pathToFileURL(join(repositoryRoot, "scripts", "lib", "stryker-diff.mjs")).href)};`,
						'export default { ...buildRunConfig(base, { command: "node_modules/.bin/vitest run --configLoader runner tests/scripts/untouched.test.ts" }), buildCommand: "node -e 0" };',
						"",
					].join("\n"),
				);
				const result = spawnSync(
					process.execPath,
					[
						join(
							repositoryRoot,
							"node_modules",
							"@stryker-mutator",
							"core",
							"bin",
							"stryker.js",
						),
						"run",
						"--mutate",
						"scripts/thing.mjs:1-3",
						"--dryRunOnly",
						configFile,
					],
					{ cwd: fixture.root, encoding: "utf8", timeout: 120_000 },
				);
				const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
				expect(output).toContain("Initial test run succeeded");
				expect(result.status).toBe(0);
			} finally {
				fixture.cleanup();
			}
		},
		150_000,
	);

	// Recurrence (#4092): a mistyped cap read as NaN, and every comparison with
	// NaN is false, so the runtime cap would have silently stopped binding.
	it.each(["abc", "0", "-5"])(
		"refuses --max-dry-run-seconds %s before touching the repo",
		(value) => {
			const cwd = mkdtempSync(join(tmpdir(), "pi-lens-stryker-flag-"));
			try {
				const result = runDriverResult(
					cwd,
					["--max-dry-run-seconds", value],
					30_000,
				);
				expect(result.status).toBe(1);
				expect(result.stderr).toContain(
					"--max-dry-run-seconds must be a positive number",
				);
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		},
	);

	// Recurrence (#4092): a dry run past `dryRunTimeoutMinutes` exited 1 with the
	// words of any dry-run failure, and the night could not tell it from a crash.
	// Stryker logs "Initial test run timed out!" -- the only discriminator -- on
	// the console for the measuring dry run and in stryker.log for the real run.
	it.each([
		["the measuring dry run", { dryRunFails: "timeout" }],
		["the real run", { realRunFails: "timeout" }],
	])(
		"records a named dry-run timeout when %s outlasts Stryker's bound",
		(_where, control) => {
			const fixture = buildDriverFixture({
				covering: true,
				includeCompiled: true,
			});
			try {
				mkdirSync(join(fixture.root, ".fake-stryker"), { recursive: true });
				writeFileSync(
					join(fixture.root, ".fake-stryker", "control.json"),
					JSON.stringify(control),
				);
				const result = runDriverResult(
					fixture.root,
					["--base", "main"],
					120_000,
				);
				expect(result.status).toBe(1);
				const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
				expect(output).toContain(
					"mutation diff: dry run timed out; no mutants evaluated; the initial test run exceeded Stryker's dryRunTimeoutMinutes (10) before any mutant was evaluated",
				);
				const meta = JSON.parse(
					readFileSync(
						join(fixture.root, "reports", "mutation", "mutation.json"),
						"utf8",
					),
				).piLensMutationDiff;
				expect(meta.dryRunTimeout).toEqual({
					minutes: 10,
					tests: meta.testsRun.length,
					estimatedSeconds: meta.testSelection.estimatedSeconds,
				});
				expect(meta.dryRunTimeout.tests).toBeGreaterThan(0);
				expect(meta.zeroMutants.reason).toContain("dry run timed out");
			} finally {
				fixture.cleanup();
			}
		},
		150_000,
	);

	it.each([
		["the measuring dry run", { dryRunFails: "tests" }],
		["the real run", { realRunFails: "tests" }],
		[
			"the measuring dry run, vitest output quoting the timeout line",
			{ dryRunFails: "testsQuotingTimeout" },
		],
		[
			"the real run, vitest output quoting the timeout line",
			{ realRunFails: "testsQuotingTimeout" },
		],
	])(
		"leaves a failed initial test run that did not time out unnamed (%s)",
		(_where, control) => {
			const fixture = buildDriverFixture({
				covering: true,
				includeCompiled: true,
			});
			try {
				mkdirSync(join(fixture.root, ".fake-stryker"), { recursive: true });
				writeFileSync(
					join(fixture.root, ".fake-stryker", "control.json"),
					JSON.stringify(control),
				);
				const result = runDriverResult(
					fixture.root,
					["--base", "main"],
					120_000,
				);
				expect(result.status).toBe(1);
				const meta = JSON.parse(
					readFileSync(
						join(fixture.root, "reports", "mutation", "mutation.json"),
						"utf8",
					),
				).piLensMutationDiff;
				expect(meta.dryRunTimeout ?? null).toBeNull();
				expect(meta.zeroMutants.reason).toContain("dry run failed");
				expect(meta.zeroMutants.reason).not.toContain("dryRunTimeoutMinutes");
			} finally {
				fixture.cleanup();
			}
		},
		150_000,
	);

	it("reports a partial run when the Stryker child fails after writing an incremental report", () => {
		const fixture = buildDriverFixture({
			covering: true,
			includeCompiled: true,
		});
		try {
			mkdirSync(join(fixture.root, ".fake-stryker"), { recursive: true });
			writeFileSync(
				join(fixture.root, ".fake-stryker", "control.json"),
				JSON.stringify({
					exitCode: 1,
					writeReport: false,
					writeIncremental: true,
				}),
			);
			const result = runDriverResult(fixture.root, ["--base", "main"], 120_000);
			expect(result.status).toBe(1);
			const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
			expect(output).toContain("partial report");
			expect(output).toContain("survived:");
			const report = JSON.parse(
				readFileSync(
					join(fixture.root, "reports", "mutation", "mutation.json"),
					"utf8",
				),
			);
			expect(report.piLensMutationDiff.partial).not.toBeNull();
			expect(report.piLensMutationDiff.zeroMutants).toBeNull();
		} finally {
			fixture.cleanup();
		}
	}, 150_000);
});

describe("driver stage dispositions, spawned for real (#3856 F3 arm)", () => {
	it("names the wait with its own log sink, then refuses behind an exclusive holder (F3 arm)", async () => {
		// #3853's block is only live while an exclusive holder waits: the heartbeat
		// goes through the driver's OWN `log` option (its own `mutation diff:`
		// prefix) and the timeout throw goes through its catch. A run that takes the
		// lock silently cannot tell either from a skipped lock.
		const fixture = buildDriverFixture({
			covering: true,
			includeCompiled: false,
		});
		const home = join(fixture.root, "home");
		mkdirSync(home, { recursive: true });
		const previousHome = process.env.PI_LENS_HOME;
		process.env.PI_LENS_HOME = home;
		const exclusive = await acquireTestLock({
			lockPath: getLockPath(),
			slots: 2,
			pollIntervalMs: 10,
			heartbeatIntervalMs: 3_600_000,
		});
		try {
			const env: NodeJS.ProcessEnv = {
				...process.env,
				PI_LENS_HOME: home,
				PI_LENS_TEST_LOCK_TIMEOUT_MS: "800",
				PI_LENS_TEST_LOCK_HEARTBEAT_MS: "100",
				PI_LENS_TEST_LOCK_POLL_MS: "20",
			};
			delete env.PI_LENS_TEST_NO_LOCK;
			const result = spawnSync(
				process.execPath,
				[driverPath, "--base", "HEAD"],
				{ cwd: fixture.root, encoding: "utf8", timeout: 30_000, env },
			);
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain(
				"mutation diff: waiting for a shared test-suite slot: exclusive test-suite lock held by",
			);
			expect(result.stderr).toContain(
				"mutation diff: timed out after 800ms waiting for test-suite lock",
			);
			expect(result.stderr).toContain("exclusive test-suite lock held by PID");
		} finally {
			await exclusive.release();
			if (previousHome === undefined) delete process.env.PI_LENS_HOME;
			else process.env.PI_LENS_HOME = previousHome;
			fixture.cleanup();
		}
	}, 120_000);

	it("skips the lock when the bypass is set, even behind an exclusive holder (F3 arm)", async () => {
		const fixture = buildDriverFixture({
			covering: true,
			includeCompiled: false,
		});
		const home = join(fixture.root, "home");
		mkdirSync(home, { recursive: true });
		const previousHome = process.env.PI_LENS_HOME;
		process.env.PI_LENS_HOME = home;
		const exclusive = await acquireTestLock({
			lockPath: getLockPath(),
			slots: 2,
			pollIntervalMs: 10,
			heartbeatIntervalMs: 3_600_000,
		});
		try {
			const result = spawnSync(
				process.execPath,
				[driverPath, "--base", "HEAD"],
				{
					cwd: fixture.root,
					encoding: "utf8",
					timeout: 30_000,
					env: {
						...process.env,
						PI_LENS_HOME: home,
						PI_LENS_TEST_NO_LOCK: "1",
						PI_LENS_TEST_LOCK_TIMEOUT_MS: "300",
					},
				},
			);
			expect(result.status).toBe(0);
			expect(result.stderr).not.toContain(
				"exclusive test-suite lock held by PID",
			);
		} finally {
			await exclusive.release();
			if (previousHome === undefined) delete process.env.PI_LENS_HOME;
			else process.env.PI_LENS_HOME = previousHome;
			fixture.cleanup();
		}
	}, 120_000);

	it("hands the nested-driver bypass to the Stryker child (F3 arm)", () => {
		// The slot above already covers the vitest pools the Stryker child forks,
		// and the driver's own test file spawns the driver again; without this the
		// nested driver would wait on its parent. The Stryker child records the
		// environment it inherited.
		const fixture = buildDriverFixture({
			covering: true,
			includeCompiled: true,
		});
		const home = join(fixture.root, "home");
		mkdirSync(home, { recursive: true });
		const previousHome = process.env.PI_LENS_HOME;
		process.env.PI_LENS_HOME = home;
		try {
			const env: NodeJS.ProcessEnv = { ...process.env, PI_LENS_HOME: home };
			delete env.PI_LENS_TEST_NO_LOCK;
			runDriverWithEnv(fixture.root, ["--base", "main"], 120_000, env);
			const invocations = fakeStrykerInvocations(fixture.root);
			expect(invocations[0].noLock).toBe("1");
		} finally {
			if (previousHome === undefined) delete process.env.PI_LENS_HOME;
			else process.env.PI_LENS_HOME = previousHome;
			fixture.cleanup();
		}
	}, 150_000);

	it("keeps an aborted probe out of coverage mode when the budget signal fires (F3 arm)", () => {
		// The probe deadline is a share of the remaining budget. A probe that runs
		// longer than the share aborts, so every candidate becomes `unknown` and
		// the driver falls back to the import graph. A deadline four times larger
		// lets the same probe finish and switches to coverage mode.
		const fixture = buildDriverFixture({
			covering: true,
			includeCompiled: true,
		});
		try {
			writeFileSync(
				join(fixture.root, "tests", "scripts", "thing.test.ts"),
				'import { expect, it } from "vitest";\nimport { changed } from "../../scripts/thing.mjs";\nit("sleeps past the probe share", async () => {\n\tawait new Promise((resolve) => setTimeout(resolve, 4000));\n\texpect(changed()).toBe(2);\n});\n',
			);
			runDriver(
				fixture.root,
				["--base", "main", "--budget-minutes", "0.2"],
				120_000,
			);
			const report = JSON.parse(
				readFileSync(
					join(fixture.root, "reports", "mutation", "mutation.json"),
					"utf8",
				),
			);
			// The fast sibling finishes, the sleeper aborts: one unknown, coverage
			// mode. With a four-times-larger deadline the sleeper finishes too and no
			// probe is unknown.
			expect(report.piLensMutationDiff.testSelection.mode).toBe("coverage");
			expect(report.piLensMutationDiff.testSelection.unknown).toBe(1);
		} finally {
			fixture.cleanup();
		}
	}, 150_000);

	it("treats a successful probe with no coverage report as zero, not a crash (F3 arm)", () => {
		// A probe that exits 0 without writing a report is `0` covered lines, and
		// its scratch directory is removed even though vitest never made it. A
		// `force: false` removal throws on that absent directory, and a
		// `recursive: false` removal throws on the non-empty one a written report
		// makes -- both turn a clean probe into `unknown`.
		const fixture = buildDriverFixture({
			covering: true,
			includeCompiled: false,
			fakeVitest: true,
		});
		try {
			const absent = runDriver(fixture.root, ["--base", "main"], 120_000);
			expect(absent).toContain("mutation diff: measuring which of");
			expect(absent).not.toContain("no coverage answer for");
			mkdirSync(join(fixture.root, ".fake-vitest"), { recursive: true });
			writeFileSync(
				join(fixture.root, ".fake-vitest", "control.json"),
				JSON.stringify({ writeCoverage: true }),
			);
			const present = runDriver(fixture.root, ["--base", "main"], 120_000);
			expect(present).not.toContain("no coverage answer for");
		} finally {
			fixture.cleanup();
		}
	}, 120_000);

	// Recurrence (R2 F2 of #4108): probing is sequential and stops at its budget
	// share, so the pool's tail goes unprobed (194 of 565 in shard 1 of run
	// 37629970371). The own tests were last in the pool, and they are the tests
	// the runtime cap most needs timed.
	it("probes the PR's own tests before the import-related ones", () => {
		const fixture = buildDriverFixture({
			covering: true,
			includeCompiled: false,
			fakeVitest: true,
		});
		try {
			// The related tests list as thing-other.test.ts then thing.test.ts
			// (directory order); thing.test.ts becomes the PR's own.
			const own = join(fixture.root, "tests", "scripts", "thing.test.ts");
			writeFileSync(own, `${readFileSync(own, "utf8")}// touched by the PR\n`);
			fixture.git(["commit", "-qam", "touch a test"]);
			runDriver(fixture.root, ["--base", "main"], 120_000);
			const probed = fakeVitestInvocations(fixture.root).map((invocation) =>
				invocation.args.find((arg: string) => arg.startsWith("tests/")),
			);
			expect(probed.slice(0, 2)).toEqual([
				"tests/scripts/thing.test.ts",
				"tests/scripts/thing-other.test.ts",
			]);
		} finally {
			fixture.cleanup();
		}
	}, 120_000);

	it("skips a compiled source with no emitted output instead of probing a missing js (F3 arm)", () => {
		// A changed `clients/` source tsc never emits (it is not in the
		// tsconfig `files`) has no index entry. Its `probeInclude`/`probeRanges`
		// entry must be skipped, never handed to the probe as a missing `.js`.
		const fixture = buildDriverFixture({
			covering: true,
			includeCompiled: true,
			skippedCompiled: true,
			fakeVitest: true,
		});
		try {
			// One probe writes a report and the rest do not: `lines` is then a real
			// answer, so a probe whose scratch directory cannot be removed is a
			// named `unknown`, never a silent clean zero.
			mkdirSync(join(fixture.root, ".fake-vitest"), { recursive: true });
			writeFileSync(
				join(fixture.root, ".fake-vitest", "control.json"),
				JSON.stringify({ writeCoverageFor: ["tests/scripts/thing.test.ts"] }),
			);
			const output = runDriver(fixture.root, ["--base", "main"], 120_000);
			const invocations = fakeVitestInvocations(fixture.root);
			expect(invocations.length).toBeGreaterThan(0);
			for (const invocation of invocations) {
				expect(invocation.includes).toContain("clients/thing.js");
				expect(invocation.includes).not.toContain("clients/skipped.js");
			}
			expect(output).not.toContain("no coverage answer for");
		} finally {
			fixture.cleanup();
		}
	}, 120_000);

	it("reports an unparseable source map and skips the compiled source (F3 arm)", () => {
		// The `.js` and `.js.map` exist, so the `existsSync` guard passes and the
		// JSON read is what fails: the error is logged, the source is recorded as
		// skipped, and the run continues.
		const fixture = buildDriverFixture({
			covering: true,
			includeCompiled: true,
			corruptCompiled: true,
		});
		try {
			const output = runDriver(fixture.root, ["--base", "main"], 120_000);
			expect(output).toContain("unreadable source map for clients/corrupt.ts");
			const report = JSON.parse(
				readFileSync(
					join(fixture.root, "reports", "mutation", "mutation.json"),
					"utf8",
				),
			);
			// Only the corrupt source is skipped; the readable compiled one is not.
			expect(report.piLensMutationDiff.filesNoSourceMap).toEqual([
				"clients/corrupt.ts",
			]);
		} finally {
			fixture.cleanup();
		}
	}, 120_000);

	it("mutates a covered file whose only change is whitespace (F3 arm)", () => {
		// The changed-line ranges the lane mutates are read WITHOUT `-w`; only the
		// cap's weighting ignores whitespace. A covered whitespace-only file must
		// still contribute its ranges.
		const fixture = buildDriverFixture({
			covering: true,
			includeCompiled: false,
			whitespaceCovered: true,
		});
		try {
			const output = runDriver(fixture.root, ["--base", "main"], 120_000);
			expect(output).toContain("mutation diff: mutating ");
			expect(output).toContain("scripts/ws.mjs:");
		} finally {
			fixture.cleanup();
		}
	}, 120_000);
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

	it("admits a `<script>-*.test.ts` sibling beside the conventional one (F1)", () => {
		// #3810 F1 (from the #3879 verify): scripts/analyze-pi-lens-logs.mjs has
		// two suites, only one named after the script. Candidate discovery kept
		// just the exact sibling, so the detector suite was never probed -- and
		// coverage ranking cannot recover a test that is never admitted.
		const result = mapRelatedTests(["scripts/analyze-pi-lens-logs.mjs"], {
			testFiles: [
				"tests/scripts/analyze-pi-lens-logs.test.ts",
				"tests/scripts/analyze-pi-lens-logs-detectors.test.ts",
				"tests/scripts/unrelated.test.ts",
			],
			readFile: () => "",
		});

		expect(result.related.get("scripts/analyze-pi-lens-logs.mjs")).toEqual(
			new Set([
				"tests/scripts/analyze-pi-lens-logs.test.ts",
				"tests/scripts/analyze-pi-lens-logs-detectors.test.ts",
			]),
		);
		expect(result.uncovered).toEqual([]);
	});

	it("admits a test that resolves the script by path instead of importing it (F1)", () => {
		// The detector suite reaches the script through
		// `path.resolve(HERE, \"../../scripts/analyze-pi-lens-logs.mjs\")`, which the
		// import-specifier scan alone misses.
		const result = mapRelatedTests(["scripts/analyze-pi-lens-logs.mjs"], {
			testFiles: ["tests/scripts/resolver.test.ts"],
			readFile: () =>
				'const SCRIPT = process.env.SCRIPT ?? path.resolve(HERE, "../../scripts/analyze-pi-lens-logs.mjs");',
		});

		expect(result.related.get("scripts/analyze-pi-lens-logs.mjs")).toEqual(
			new Set(["tests/scripts/resolver.test.ts"]),
		);
	});

	it("finds the real detector suite for the real logs script through the real discovery", () => {
		// End-to-end acceptance for F1: the real test tree, the real default
		// reader. Normalise separators so the assertion holds on Windows too.
		const result = mapRelatedTests(["scripts/analyze-pi-lens-logs.mjs"]);
		const found = [
			...(result.related.get("scripts/analyze-pi-lens-logs.mjs") ?? []),
		].map((test) => test.split("\\").join("/"));
		expect(found).toContain(
			"tests/scripts/analyze-pi-lens-logs-detectors.test.ts",
		);
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

	it("caps the mutation population to the files that changed most and names the skipped ones", () => {
		// Recurrence: an unbounded changed-script population can turn the
		// advisory lane into an unbounded CI cost. And (#3810, from the #3797
		// review) the old alphabetical cut skipped the four files holding #3706's
		// actual change while it mutated label plumbing and a formatter reflow:
		// the heaviest files must survive the cap whatever their names.
		const weights = new Map([
			["scripts/z-core.mjs", 120],
			["scripts/a-reflow.mjs", 3],
			["scripts/m-mid.mjs", 40],
		]);
		const result = capMutationFiles(
			["scripts/a-reflow.mjs", "scripts/z-core.mjs", "scripts/m-mid.mjs"],
			2,
			weights,
		);

		expect(result.selected).toEqual([
			"scripts/z-core.mjs",
			"scripts/m-mid.mjs",
		]);
		expect(result.skipped).toEqual(["scripts/a-reflow.mjs"]);
		expect(formatCapNotice(2, 3, result.skipped)).toBe(
			"capped: 2 of 3 changed files mutated; skipped: scripts/a-reflow.mjs",
		);
	});

	it("breaks a weight tie by path so the same diff always mutates the same files", () => {
		const result = capMutationFiles(
			["scripts/z.mjs", "scripts/a.mjs", "scripts/m.mjs"],
			2,
			new Map([
				["scripts/z.mjs", 5],
				["scripts/a.mjs", 5],
				["scripts/m.mjs", 5],
			]),
		);
		expect(result.selected).toEqual(["scripts/a.mjs", "scripts/m.mjs"]);
		expect(
			capMutationFiles(["scripts/b.mjs", "scripts/a.mjs"], 1).selected,
		).toEqual(["scripts/a.mjs"]);
	});

	it("orders equal-weight files by path whatever order they arrive in", () => {
		// Enough shuffled entries to make the engine ask the comparator in both
		// directions: a tie-break that only works one way sorts [b, a] right and
		// a longer shuffled list wrong.
		const names = [
			"q",
			"b",
			"m",
			"a",
			"z",
			"c",
			"x",
			"d",
			"k",
			"e",
			"t",
			"f",
		].map((n) => `scripts/${n}.mjs`);
		const sorted = [...names].sort();
		for (const input of [names, [...names].reverse()]) {
			expect(capMutationFiles(input, input.length).selected).toEqual(sorted);
		}
	});

	it("weighs a file by the lines its diff changed, counting a deletion-only hunk as one line", () => {
		const diff = [
			"+++ b/scripts/one.mjs",
			"@@ -394 +394 @@ const cache = new Map();",
			"@@ -761 +761,5 @@ function extract(value) {",
			"+++ b/scripts/two.mjs",
			"@@ -40,3 +39,0 @@ function gone() {",
			"",
		].join("\n");
		expect(changedLineWeights(parseChangedLineRanges(diff))).toEqual(
			new Map([
				["scripts/one.mjs", 6],
				["scripts/two.mjs", 1],
			]),
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

	// Recurrence (#4092): `dryRunTimeoutMinutes` was Stryker's default (5), under
	// the 358 s (4 cores) and 449 s (2 cores) the nightly's 122-file initial run
	// measured, and nothing tied the selection's size to the bound. The constants
	// and the config value must stay the ones the recorded measurement sizes.
	it("sizes the runtime cap and Stryker's initial-run bound from the recorded measurement", () => {
		const measured = JSON.parse(
			readFileSync(
				resolve(
					import.meta.dirname,
					"../fixtures/mutation-dry-run-measurement.json",
				),
				"utf8",
			),
		);
		const minutes = Number(/dryRunTimeoutMinutes:\s*(\d+)/.exec(config)?.[1]);
		expect(minutes).toBe(measured.recommended.dryRunTimeoutMinutes);
		expect(MAX_DRY_RUN_SECONDS).toBe(measured.recommended.maxDryRunSeconds);
		expect(UNKNOWN_TEST_SECONDS).toBe(measured.recommended.unknownTestSeconds);
		expect(TEST_FILE_OVERHEAD_SECONDS).toBe(
			measured.recommended.testFileOverheadSeconds,
		);
		// The failing selection outlasted the default bound at both core counts.
		for (const run of measured.local.runs) {
			expect(run.wallSeconds).toBeGreaterThan(
				measured.ci.failing.defaultTimeoutSeconds,
			);
			expect(minutes * 60).toBeGreaterThan(run.wallSeconds);
		}
		// The cap sits where the CI dry runs that passed sat, and the bound keeps
		// a stated margin over it.
		const passing = Object.values<number[]>(measured.ci.passing.dryRunNetMs)
			.flat()
			.map((ms) => ms / 1000);
		expect(MAX_DRY_RUN_SECONDS).toBeGreaterThanOrEqual(Math.min(...passing));
		expect(MAX_DRY_RUN_SECONDS).toBeLessThanOrEqual(Math.max(...passing));
		expect(minutes * 60).toBeGreaterThanOrEqual(2 * MAX_DRY_RUN_SECONDS);
		// The capped replay of the failing selection ran inside both bounds.
		expect(measured.cappedReplay.estimatedSeconds).toBeLessThanOrEqual(
			MAX_DRY_RUN_SECONDS,
		);
		// The real Stryker over the capped replay: inside the bound with margin.
		expect(measured.cappedReplay.strykerDryRun.wallSeconds).toBeLessThan(
			(minutes * 60) / 2,
		);
		expect(measured.cappedReplay.wallSeconds).toBeLessThan(
			measured.ci.failing.defaultTimeoutSeconds,
		);
		// The recorded constants follow from the recorded raw files.
		const seconds = Object.values<number>(measured.local.fileSecondsAtTwoCores);
		const sum = seconds.reduce((a, b) => a + b, 0);
		expect(seconds).toHaveLength(measured.local.runs[0].files);
		expect(sum).toBeCloseTo(measured.local.runs[0].sumFileSeconds, 0);
		// The unknown cost is the p95 of the measured files, not their mean (R2 F2).
		const sorted = [...seconds].sort((a, b) => a - b);
		expect(UNKNOWN_TEST_SECONDS).toBe(
			Math.round(sorted[Math.floor(0.95 * (sorted.length - 1))]),
		);
		expect(measured.derived.p95FileSeconds).toBe(UNKNOWN_TEST_SECONDS);
		expect(TEST_FILE_OVERHEAD_SECONDS).toBeGreaterThanOrEqual(
			(measured.local.runs[0].wallSeconds - sum) / seconds.length - 0.1,
		);
	});

	it("tells Stryker's initial-run timeout from its other dry-run failures by the line it logs", () => {
		// Stryker 10.0.0, 3-dry-run-executor.js logTimeoutInitialRun and
		// logFailedTestsInInitialRun.
		expect(
			isDryRunTimeout(
				"14:00:14 (44599) ERROR DryRunExecutor Initial test run timed out!",
			),
		).toBe(true);
		expect(
			isDryRunTimeout(
				"10:00:32 (21575) ERROR DryRunExecutor One or more tests failed in the initial test run:",
			),
		).toBe(false);
		expect(isDryRunTimeout("")).toBe(false);
		expect(isDryRunTimeout()).toBe(false);
		// The line as run 37629970371 logged it (job 112823805274, cat -v), colour
		// codes around the logger prefix: the one real shape.
		expect(
			isDryRunTimeout(
				"\u001b[91m14:00:14 (44599) ERROR DryRunExecutor\u001b[39m Initial test run timed out!\n",
			),
		).toBe(true);
		// Recurrence (R2 F1 of #4108): vitest output inside the failed-tests log
		// carries the literal (this lane's tests assert it); only the logger's own
		// line, and no failed-tests line, is a timeout.
		const vitestDiff = [
			"+ 14:00:14 (1) ERROR DryRunExecutor Initial test run timed out!",
			"    at tests/scripts/stryker-diff.test.ts:1  Initial test run timed out!",
			"Initial test run timed out!",
		].join("\n");
		expect(isDryRunTimeout(vitestDiff)).toBe(false);
		const failedTests = [
			"14:00:14 (1) ERROR DryRunExecutor One or more tests failed in the initial test run:",
			"14:00:14 (1) ERROR DryRunExecutor Initial test run timed out!",
		].join("\n");
		expect(isDryRunTimeout(failedTests)).toBe(false);
		expect(
			describeStrykerFailure({ status: 1 }, 60, {
				output: vitestDiff,
				dryRunTimeoutMinutes: 10,
			}),
		).toContain("dry run failed");
		const failure = { status: 1 };
		expect(
			describeStrykerFailure(failure, 60, {
				output:
					"14:00:14 (44599) ERROR DryRunExecutor Initial test run timed out!",
				dryRunTimeoutMinutes: 10,
				tests: ["tests/a.test.ts"],
			}),
		).toBe(
			"mutation diff: dry run timed out; no mutants evaluated; the initial test run exceeded Stryker's dryRunTimeoutMinutes (10) before any mutant was evaluated; tests involved: tests/a.test.ts",
		);
		expect(
			describeStrykerFailure(failure, 60, {
				output:
					"ERROR DryRunExecutor One or more tests failed in the initial test run:",
				dryRunTimeoutMinutes: 10,
			}),
		).toBe(
			"mutation diff: dry run failed; no mutants evaluated; dry run or mutation execution failed (Stryker status 1); no related test file was identified",
		);
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
	it("bounds the driver strictly below the nightly job cap", () => {
		// Recurrence: run 36098718085 was cancelled by the runner at
		// timeout-minutes, so the driver never regained control and its
		// "no mutants evaluated" message never printed. The driver's own bound
		// must leave the job room to report it.
		const cap = Number(mutationJob?.["timeout-minutes"]);

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
		// each Stryker child is killed at the budget REMAINING after time already
		// spent (the dry-run cost measurement, the build), via `childBudgetMs()`,
		// which floors a spent budget at the 1 ms `spawnSync` accepts -- it reads
		// `timeout: 0` as NO timeout (#4989 F1; the spawned case above kills a
		// hanging child at a 0-minute budget). Pinned over the WHOLE population:
		// a fourth Stryker child, or one site reverted to the bare remaining
		// budget, reds here as well as in the spawned case.
		expect(driver.match(/timeout: childBudgetMs\(\),/g) ?? []).toHaveLength(3);
		expect(driver).not.toContain("timeout: remainingBudgetMs(),");
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

describe("mutation concurrency is pinned to its CI measurement (#3810 item 3)", () => {
	// Recurrence: a bare `concurrency: N` drifts from the evidence that chose it,
	// and Stryker kills a mutant run at timeoutMS + 1.5 x the dry run: a value
	// whose per-mutant time reaches that bound turns load into Timeout mutants.
	const measurement = JSON.parse(
		readFileSync(
			resolve(
				import.meta.dirname,
				"../fixtures/mutation-concurrency-measurement.json",
			),
			"utf8",
		),
	);
	type Arm = {
		concurrency?: number;
		driverWallSeconds: number;
		mutationPhaseSeconds: number;
		dryRunNetMs: number;
		mutantsEvaluated: number;
		counts: Record<string, number>;
	};
	const arms = Object.values(measurement.arms as Record<string, Arm>).filter(
		(arm) => arm.concurrency !== undefined,
	);
	const chosen = arms.find(
		(arm) => arm.concurrency === measurement.recommendedConcurrency,
	) as Arm;

	it("runs Stryker at the measured concurrency", () => {
		expect(config).toContain(
			`concurrency: ${measurement.recommendedConcurrency},`,
		);
	});

	it("chose an arm within 1% of the fastest, with no Timeout and a round inside Stryker's kill bound", () => {
		const fastest = Math.min(...arms.map((arm) => arm.driverWallSeconds));
		expect(chosen.driverWallSeconds / fastest).toBeLessThanOrEqual(1.01);
		for (const arm of arms) expect(arm.counts.Timeout ?? 0).toBe(0);
		const rounds = Math.ceil(chosen.mutantsEvaluated / chosen.concurrency!);
		const killBoundSeconds =
			(measurement.strykerTimeout.timeoutMS +
				measurement.strykerTimeout.timeoutFactor * chosen.dryRunNetMs) /
			1000;
		expect(chosen.mutationPhaseSeconds / rounds).toBeLessThan(killBoundSeconds);
		// The bound above uses the fixture's copy of Stryker's two timeout knobs;
		// they must still be the config's.
		expect(measurement.strykerTimeout.timeoutMS).toBe(
			Number(/timeoutMS: (\d+)/.exec(config)?.[1]),
		);
		expect(measurement.strykerTimeout.timeoutFactor).toBe(
			Number(/timeoutFactor: ([\d.]+)/.exec(config)?.[1]),
		);
	});
});

describe.skipIf(underStryker)(
	"coverage selection and incremental cache wiring (#3810)",
	() => {
		// Stated exception (same as the resample-loop pin above): the driver is a
		// top-level script this suite cannot import. The decision points are pinned
		// as pure functions in mutation-test-selection.test.ts; these pin that the
		// driver calls them with the inputs the brief names. The executable check is
		// the real driver run on #3794's head quoted in the PR body
		// ("related 72 -> covering 16 -> kept 16 (3 own)") and the two-push cache
		// proof on the PR's own mutation job.
		const code = stripSource(driver);

		it("feeds the PR's own tests and the import-graph priorities into the selector, with probed coverage", () => {
			expect(code).toContain("partitionOwnTests(allChangedPaths,");
			// A test both related and own is reported once: the partition must see what
			// the related scan already excluded.
			expect(code).toContain("alreadyExcluded: selection.excluded,");
			expect(code).toContain("selectMutationTests({");
			expect(code).toContain("ownTests,");
			expect(code).toContain("priorities: selection.priorities,");
			expect(code).toContain("lines: probeLines,");
			expect(code).toContain("probeAllTests(");
			// The probes share the job's budget; they must not be able to eat it all,
			// and both the first probe (alone) and the concurrent pass get that same
			// signal so an over-budget probe is cancelled and tree-killed (F2).
			expect(code).toContain("const probeSignal = AbortSignal.timeout(");
			expect(code).toContain("PROBE_BUDGET_SHARE");
			expect(code.match(/signal: probeSignal,/g)).toHaveLength(2);
		});

		it("caps the changed files by changed-line weight with whitespace-only lines ignored (#3797 review)", () => {
			expect(code).toMatch(
				/weights: changedLineWeights\(\s*changedLineRanges\(allFiles, \{ ignoreWhitespace: true \}\),?\s*\)/,
			);
			expect(code).toMatch(/\.\.\.\(ignoreWhitespace \? \["\s*"\] : \[\]\)/);
		});

		it("never hands vitest an empty test list (S10)", () => {
			expect(code).toMatch(
				/if \(tests\.length === 0\) \{[\s\S]*?process\.exit\(0\);/,
			);
		});

		it("reads the restored incremental file only through the fingerprint decision, pruned to the current ranges", () => {
			expect(code).toContain("decideIncrementalReuse({");
			// Only the first attempt may read the restored file (a resample retry
			// runs different ranges against a file the previous attempt rewrote):
			// planIncrementalAttempt owns that rule and the driver must ask it.
			expect(code).toMatch(
				/planIncrementalAttempt\(\{\s*attempt,\s*decision: incrementalDecision,/,
			);
			expect(code).toContain("decision: incrementalDecision,");
			// The restored file is read by Stryker as is (or removed), and the REPORT is
			// filtered to this run's ranges: a pre-filter on the old file dropped every
			// result a line shift above it let Stryker reuse.
			expect(code).toContain("if (!reuse) rmSync(INCREMENTAL_PATH");
			expect(code.match(/pruneIncrementalReport\(/g)).toHaveLength(2);
			expect(code).toContain("writeRunConfig(tests, { reuse })");
			// The fork point, not the base tip: a merge train moves the tip every few
			// minutes and would make every push cold.
			expect(code).toContain("forkPointOf(");
			expect(code).toContain("parseFingerprint(");
			expect(code).toContain("serializeFingerprint(fingerprint)");
			expect(code).toContain("changedFingerprintInputs(");
			// The node MAJOR: a runner image's patch release is not an input (CI runs
			// 36802587909 and 36803778786 differed only in v22.23.3 against v22.23.2).
			expect(code).toMatch(/process\.versions\.node\.split\("\s*"\)\[0\]/);
			expect(code).toMatch(/headShaArg \?\? "\s*"/);
			expect(code).not.toContain("gitRevision(");
			// The real spawned cold/warm/input-change and sampled-source cases
			// now pin fingerprint ownership; textual operand spellings cannot.
		});

		it("does not keep the old alphabetical cap", () => {
			expect(code).not.toContain("capRelatedTests");
			expect(driver).not.toContain("formatTestCapNotice");
		});
	},
);

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

describe("fitSampleToMutantAllowance (#4171)", () => {
	// Recurrence these cases guard: run 40847865852 (2026-10-29) sampled by range
	// count, kept 3 of 172 ranges for an allowance of ~24 of 1197 measured
	// mutants, and those 3 held 55; the budget expired after 48 mutants.
	const seed = "22b094239254d3983395f220d417d81ac6dd3a9e";
	const patterns = Array.from(
		{ length: 172 },
		(_, index) => `clients/f${index}.js:1-1`,
	);
	/** The `count` highest-ranked ranges, best first (the sampler's own order). */
	const topRanked = (count: number, pool = patterns) => {
		const ranked: string[] = [];
		for (let limit = 1; limit <= count; limit += 1) {
			const next = sampleRangesDeterministically(pool, limit, seed).selected;
			ranked.push(next.find((pattern) => !ranked.includes(pattern)) as string);
		}
		return ranked;
	};
	const counter = (density: Map<string, number>, fallback: number) => {
		const calls: string[][] = [];
		const countMutants = (selection: string[]) => {
			calls.push(selection);
			return selection.reduce(
				(sum, pattern) => sum + (density.get(pattern) ?? fallback),
				0,
			);
		};
		return { calls, countMutants };
	};
	/** 172 ranges holding 1197 mutants, the 3 best-ranked holding 55 (20+20+15). */
	const productionDensity = () => {
		const [first, second, third] = topRanked(3);
		const density = new Map([
			[first, 20],
			[second, 20],
			[third, 15],
		]);
		const rest = patterns.filter((pattern) => !density.has(pattern));
		rest.forEach((pattern, index) => density.set(pattern, index < 128 ? 7 : 6));
		return { density, first, second, third };
	};

	it("keeps the sample inside the allowance where the uniform estimate overshoots it", () => {
		const { density, first } = productionDensity();
		const { countMutants } = counter(density, 0);
		const all = countMutants(patterns);
		const estimate = Math.floor((patterns.length * 24) / all);
		expect([all, estimate]).toEqual([1197, 3]);
		const oldSample = sampleRangesDeterministically(patterns, estimate, seed);
		expect(countMutants(oldSample.selected)).toBe(55);

		const fit = fitSampleToMutantAllowance({
			patterns,
			startCount: estimate,
			allowedMutants: 24,
			seed,
			countMutants,
		});

		expect(fit.selected).toEqual([first]);
		expect(fit.mutants).toBe(20);
		expect(fit).toMatchObject({ exceedsAllowance: false, unverified: false });
	});

	it("keeps the largest prefix that fits, never fewer ranges than the allowance affords", () => {
		const { density, first, second } = productionDensity();
		const { countMutants } = counter(density, 0);
		// 20 + 20 = 40 fits an allowance of 40; the third range (15) would not.
		const fit = fitSampleToMutantAllowance({
			patterns,
			startCount: 3,
			allowedMutants: 40,
			seed,
			countMutants,
		});
		expect(new Set(fit.selected)).toEqual(new Set([first, second]));
		expect(fit.mutants).toBe(40);
	});

	it("takes one count pass when the uniform estimate already fits", () => {
		const { calls, countMutants } = counter(new Map(), 1);
		const fit = fitSampleToMutantAllowance({
			patterns,
			startCount: 24,
			allowedMutants: 24,
			seed,
			countMutants,
		});
		expect(fit.selected).toHaveLength(24);
		expect(fit.mutants).toBe(24);
		expect(fit.passes).toBe(1);
		expect(calls).toHaveLength(1);
	});

	it("bounds the count passes by the logarithm of the starting sample", () => {
		const { calls, countMutants } = counter(new Map(), 1);
		const fit = fitSampleToMutantAllowance({
			patterns,
			startCount: 40,
			allowedMutants: 5,
			seed,
			countMutants,
		});
		expect(fit.selected).toHaveLength(5);
		expect(fit.passes).toBe(calls.length);
		expect(fit.passes).toBeLessThanOrEqual(1 + Math.ceil(Math.log2(40)));
	});

	it("selects the same ranges for the same seed and different ranges for another", () => {
		const run = (runSeed: string) =>
			fitSampleToMutantAllowance({
				patterns,
				startCount: 3,
				allowedMutants: 60,
				seed: runSeed,
				countMutants: counter(new Map(), 7).countMutants,
			}).selected;
		expect(run(seed)).toEqual(run(seed));
		expect(run(seed)).not.toEqual(run("another-head"));
	});

	it("keeps one range and says so when a single range alone exceeds the allowance", () => {
		const { calls, countMutants } = counter(new Map(), 50);
		const fit = fitSampleToMutantAllowance({
			patterns,
			startCount: 3,
			allowedMutants: 24,
			seed,
			countMutants,
		});
		expect(fit.selected).toEqual(topRanked(1));
		expect(fit).toMatchObject({
			mutants: 50,
			exceedsAllowance: true,
			unverified: false,
		});
		expect(calls.length).toBe(fit.passes);
	});

	it("keeps one range and flags it unverified when the first count pass fails", () => {
		const fit = fitSampleToMutantAllowance({
			patterns,
			startCount: 3,
			allowedMutants: 24,
			seed,
			countMutants: () => null,
		});
		expect(fit.selected).toEqual(topRanked(1));
		expect(fit).toMatchObject({ mutants: null, unverified: true });
	});

	it("falls back to the largest sample already proven to fit when a later pass fails", () => {
		const { density, first } = productionDensity();
		const { countMutants } = counter(density, 0);
		let pass = 0;
		const fit = fitSampleToMutantAllowance({
			patterns,
			startCount: 3,
			allowedMutants: 24,
			seed,
			// Pass 1 (k=3) overshoots, pass 2 (k=1) fits, pass 3 (k=2) fails.
			countMutants: (selection) => {
				pass += 1;
				return pass === 3 ? null : countMutants(selection);
			},
		});
		expect(fit.selected).toEqual([first]);
		expect(fit).toMatchObject({ mutants: 20, unverified: true });
	});
});

describe("describeSampledMutants (#4171)", () => {
	it("states the sampled mutants against the allowance in every outcome", () => {
		const fit = {
			selected: ["a.js:1-1"],
			mutants: 20,
			passes: 3,
			exceedsAllowance: false,
			unverified: false,
		};
		expect(describeSampledMutants(fit, 24)).toBe(
			"sampled mutants 20 of 24 allowed (3 count pass(es))",
		);
		expect(
			describeSampledMutants(
				{ ...fit, mutants: 50, exceedsAllowance: true },
				24,
			),
		).toBe(
			"sampled mutants 50 of 24 allowed (3 count pass(es)); over the allowance because one range alone holds more",
		);
		expect(
			describeSampledMutants({ ...fit, mutants: null, unverified: true }, 24),
		).toBe(
			"sampled mutants unverified against the allowance of 24 (a count pass failed; kept one range)",
		);
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

	it("draws the retry from the injected sampler, with the retry seed and the untried pool (#4171)", () => {
		// Recurrence: a retry kept `keepRangeCount` ranges with no mutant bound, so
		// it could overshoot the allowance the first sample was held to.
		const calls: Array<[string[], number, string]> = [];
		const plan = planResample({
			allPatterns: ["a.js:1-1", "b.js:2-2", "c.js:3-3", "d.js:4-4"],
			triedPatterns: ["a.js:1-1"],
			keepRangeCount: 5,
			seed: "deadbeef",
			attemptsSoFar: 1,
			maxAttempts: 3,
			sample: (pool, limit, seed) => {
				calls.push([pool, limit, seed]);
				return { selected: ["c.js:3-3"] };
			},
		});
		expect(plan).toEqual({ retry: true, patterns: ["c.js:3-3"] });
		expect(calls).toEqual([
			[["b.js:2-2", "c.js:3-3", "d.js:4-4"], 3, "deadbeef:retry1"],
		]);
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

describe("shared test-suite slot (#3853)", () => {
	it("waits behind a live exclusive holder and refuses to run the Stryker child", async () => {
		// The driver forks vitest pools, so it takes one shared slot for its whole
		// run. A full-suite (exclusive) holder must make it wait and then refuse,
		// never run concurrently: a real in-process store plus the real spawned
		// CLI, no mocked lock.
		const fixtureRepo = strykerFixtureDir("stryker-diff-lock-");
		const home = join(fixtureRepo, "home");
		mkdirSync(home, { recursive: true });
		const previousHome = process.env.PI_LENS_HOME;
		process.env.PI_LENS_HOME = home;
		const exclusive = await acquireTestLock({
			lockPath: getLockPath(),
			slots: 2,
			pollIntervalMs: 10,
			heartbeatIntervalMs: 5_000,
		});
		try {
			const env: NodeJS.ProcessEnv = {
				...process.env,
				PI_LENS_HOME: home,
				PI_LENS_TEST_LOCK_TIMEOUT_MS: "250",
			};
			delete env.PI_LENS_TEST_NO_LOCK;
			const result = spawnSync(
				process.execPath,
				[driverPath, "--base", "HEAD"],
				{ cwd: fixtureRepo, encoding: "utf8", timeout: 30_000, env },
			);
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("exclusive test-suite lock held by PID");
			expect(result.stdout).not.toContain("no mutants evaluated");
		} finally {
			await exclusive.release();
			if (previousHome === undefined) delete process.env.PI_LENS_HOME;
			else process.env.PI_LENS_HOME = previousHome;
			rmSync(fixtureRepo, { recursive: true, force: true });
		}
	});
});
