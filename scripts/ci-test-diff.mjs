#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
	normalizeVitestOutput,
	parseVitestSummary,
} from "./lib/vitest-summary.mjs";
import { isMainModule } from "./lib/is-main-module.mjs";

const DEFAULT_REPOSITORY = "apmantza/pi-lens";
export function stripLogDecorations(log) {
	const withoutFallbackPrefix = log.replace(
		/^[^\t\r\n]+\t[^\t\r\n]+\t(?=\d{4}-\d\d-\d\dT)/gm,
		"",
	);
	return normalizeVitestOutput(withoutFallbackPrefix)
		.replace(/^\uFEFF/, "")
		.replace(/^[ \t]+(?=FAIL\b)/gm, "");
}

export function extractFailingTestIds(log) {
	return parseVitestSummary(log).failureIds;
}

export function summarizeLog(log, side = "job") {
	const parsed = parseVitestSummary(log);
	if (
		parsed.testsFailed === null &&
		parsed.testsPassed === null &&
		parsed.testsSkipped === null
	) {
		throw new Error(`${side} log incomplete (no Vitest Tests summary)`);
	}
	const testsFailed = parsed.testsFailed ?? 0;
	if (
		parsed.failedTestsHeader !== null &&
		parsed.failedTestsHeader !== testsFailed
	) {
		throw new Error(`${side} log has mismatched Vitest failure summaries`);
	}
	return {
		testsFailed,
		suitesFailed: parsed.suitesFailed ?? 0,
		unhandledErrors: parsed.unhandledErrors ?? 0,
	};
}

export function validateLog(log, side = "job") {
	const summary = summarizeLog(log, side);
	const ids = extractFailingTestIds(log);
	const expected = summary.testsFailed + summary.suitesFailed;
	if (ids.length !== expected) {
		throw new Error(
			`${side} log has ${ids.length} failure IDs; Vitest summary reports ${expected}`,
		);
	}
	return { ids, ...summary };
}

export function compareFailureSets(previous, current) {
	const oldSet = new Set(previous);
	const newSet = new Set(current);
	return {
		fixed: [...oldSet].filter((id) => !newSet.has(id)).sort(),
		newFailures: [...newSet].filter((id) => !oldSet.has(id)).sort(),
		unchanged: [...oldSet].filter((id) => newSet.has(id)).sort(),
	};
}

function fetchJobLog(repository, jobId) {
	try {
		return execFileSync(
			"gh",
			[
				"api",
				`repos/${repository}/actions/jobs/${jobId}/logs`,
				"--allow-escape-sequences",
			],
			{ encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
		);
	} catch (error) {
		try {
			return execFileSync(
				"gh",
				["run", "view", "--job", jobId, "--log", "--repo", repository],
				{ encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
			);
		} catch (fallbackError) {
			const message =
				fallbackError instanceof Error
					? fallbackError.message
					: String(fallbackError);
			throw new Error(`could not fetch logs for job ${jobId}: ${message}`, {
				cause: error,
			});
		}
	}
}

function printSet(label, values) {
	console.log(`${label} (${values.length})`);
	for (const value of values) console.log(`  ${value}`);
}

export function parseArgs(argv) {
	if (argv.length < 2 || argv.length > 4) {
		throw new Error(
			"usage: ci-test-diff.mjs <jobA> <jobB> [--repo owner/name]",
		);
	}
	const [jobA, jobB, option, repository] = argv;
	if (!/^\d+$/.test(jobA) || !/^\d+$/.test(jobB)) {
		throw new Error("job IDs must be numeric");
	}
	if (option && option !== "--repo") {
		throw new Error(
			"usage: ci-test-diff.mjs <jobA> <jobB> [--repo owner/name]",
		);
	}
	if (option && (!repository || !/^[^/\s]+\/[^/\s]+$/.test(repository))) {
		throw new Error("--repo requires owner/name");
	}
	return { jobA, jobB, repository: repository ?? DEFAULT_REPOSITORY };
}

export function main(argv = process.argv.slice(2)) {
	const { jobA, jobB, repository } = parseArgs(argv);
	const previousReport = validateLog(
		stripLogDecorations(fetchJobLog(repository, jobA)),
		`job ${jobA}`,
	);
	const currentReport = validateLog(
		stripLogDecorations(fetchJobLog(repository, jobB)),
		`job ${jobB}`,
	);
	const previous = previousReport.ids;
	const current = currentReport.ids;
	const diff = compareFailureSets(previous, current);
	const newUnhandledErrors = Math.max(
		currentReport.unhandledErrors - previousReport.unhandledErrors,
		0,
	);
	for (let index = 1; index <= newUnhandledErrors; index += 1) {
		diff.newFailures.push(`unhandled error ${index}`);
	}
	console.log(
		`Input: ${jobA} tests=${previousReport.testsFailed} suites=${previousReport.suitesFailed} errors=${previousReport.unhandledErrors}; ${jobB} tests=${currentReport.testsFailed} suites=${currentReport.suitesFailed} errors=${currentReport.unhandledErrors}`,
	);
	printSet("FIXED", diff.fixed);
	printSet("NEW", diff.newFailures);
	printSet("UNCHANGED", diff.unchanged);
	console.log(
		`Summary: fixed=${diff.fixed.length} new=${diff.newFailures.length} unchanged=${diff.unchanged.length}`,
	);
	return diff.newFailures.length ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
	try {
		process.exitCode = main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 2;
	}
}
