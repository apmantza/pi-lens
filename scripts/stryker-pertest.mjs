#!/usr/bin/env node
/**
 * Per-test Stryker campaign on one clients/ module (#4365).
 *
 * `.github/workflows/stryker-pertest.yml` runs Stryker's vitest runner with
 * `coverageAnalysis: "perTest"` over the compiled `.js` twin of ONE runtime
 * module (tests load the twin, never the `.ts`). This script owns the steps
 * around that run:
 *
 *   node scripts/stryker-pertest.mjs patch-runner [--dir DIR]
 *     Patches the installed runner for vitest 5's test-name separator.
 *
 *   node scripts/stryker-pertest.mjs plan --module clients/x.ts [--also A,B]
 *     Prints GITHUB_OUTPUT lines `module=`, `target=<compiled .js>` and
 *     `tests=<comma-joined test files>`; the excluded tests go to stderr.
 *
 *   node scripts/stryker-pertest.mjs pick --index N
 *     Prints `module=<clients/x.ts>`: the Nth eligible module, wrapping (the
 *     workflow passes its run number when no module is named).
 *
 *   node scripts/stryker-pertest.mjs preflight --tests A,B --report JSON
 *     Drops the tests a vitest pre-flight run (threads pool, JSON reporter)
 *     failed or never reported. Prints `tests=<kept>`; the dropped go to stderr.
 *
 *   node scripts/stryker-pertest.mjs candidates --report JSON --out MD
 *     [--module M] [--json-out JSON]
 *     Lists the tests that cover mutated code but kill no mutant.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import {
	eligibleModules,
	findWorthlessTests,
	patchVitestRunner,
	pickModule,
	planPertest,
	renderCandidates,
	splitRunnableTests,
	summarizeReport,
} from "./lib/stryker-pertest.mjs";
import { isMainModule } from "./lib/is-main-module.mjs";

const RUNNER_DIR = "node_modules/@stryker-mutator/vitest-runner";

function valueAfter(argv, flag, fallback) {
	const at = argv.indexOf(flag);
	if (at !== -1 && argv[at + 1] !== undefined) return argv[at + 1];
	if (fallback !== undefined) return fallback;
	throw new Error(`stryker-pertest: missing ${flag}`);
}

/** @param {string[]} [argv] */
export function main(argv = process.argv.slice(2)) {
	const [command, ...rest] = argv;
	if (command === "patch-runner") {
		return patchVitestRunner(valueAfter(rest, "--dir", RUNNER_DIR));
	}
	if (command === "pick") {
		const modules = readdirSync("clients", { recursive: true })
			.map((entry) => `clients/${String(entry).replaceAll("\\", "/")}`)
			.filter((file) => file.endsWith(".ts"));
		const testFiles = readdirSync("tests", { recursive: true })
			.map((entry) => `tests/${String(entry).replaceAll("\\", "/")}`)
			.filter((file) => file.endsWith(".test.ts"));
		return {
			module: pickModule(
				eligibleModules(modules, { testFiles }),
				Number(valueAfter(rest, "--index")),
			),
		};
	}
	if (command === "plan") {
		return planPertest(valueAfter(rest, "--module"), {
			also: valueAfter(rest, "--also", "").split(",").filter(Boolean),
		});
	}
	if (command === "preflight") {
		const split = splitRunnableTests(
			valueAfter(rest, "--tests").split(",").filter(Boolean),
			JSON.parse(readFileSync(valueAfter(rest, "--report"), "utf8")),
			process.cwd(),
		);
		if (split.kept.length === 0) {
			throw new Error(
				`no planned test runs under the runner's pool: ${JSON.stringify(split.dropped)}`,
			);
		}
		return split;
	}
	if (command === "candidates") {
		const report = JSON.parse(
			readFileSync(valueAfter(rest, "--report"), "utf8"),
		);
		const moduleFile = valueAfter(rest, "--module", "");
		const candidates = findWorthlessTests(report, moduleFile);
		const summary = summarizeReport(report);
		writeFileSync(
			valueAfter(rest, "--out"),
			renderCandidates(candidates, summary, { module: moduleFile }),
		);
		if (rest.includes("--json-out")) {
			writeFileSync(
				valueAfter(rest, "--json-out"),
				`${JSON.stringify({ summary, candidates }, null, 2)}\n`,
			);
		}
		return { summary, candidates };
	}
	throw new Error(
		"usage: stryker-pertest.mjs patch-runner|plan|candidates ...",
	);
}

if (isMainModule(import.meta.url)) {
	try {
		const result = main();
		if (process.argv[2] === "plan") {
			for (const { file, reason } of result.excluded) {
				console.error(`excluded ${file}: ${reason}`);
			}
			console.log(
				`module=${result.module}\ntarget=${result.target}\ntests=${result.tests.join(",")}`,
			);
		} else if (process.argv[2] === "preflight") {
			for (const { file, failures } of result.dropped) {
				console.error(`dropped ${file}: ${failures.join("; ")}`);
			}
			console.log(`tests=${result.kept.join(",")}`);
		} else if (process.argv[2] === "pick") {
			console.log(`module=${result.module}`);
		} else if (process.argv[2] === "patch-runner") {
			console.log(`patched=${result.patched}`);
		}
	} catch (error) {
		console.error(`stryker-pertest: failed: ${error?.message ?? error}`);
		process.exitCode = 1;
	}
}
