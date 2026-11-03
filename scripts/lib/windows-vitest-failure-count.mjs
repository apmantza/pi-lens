import { readFileSync } from "node:fs";
import { parseVitestSummary } from "./vitest-summary.mjs";
import { isMainModule } from "./is-main-module.mjs";

/** Return the failed-test count from a Vitest Windows runner log, if present. */
export function parseWindowsVitestFailureCount(log) {
	return parseVitestSummary(log).testsFailed;
}

/**
 * Tests that actually ran (passed plus failed; skipped excluded), or null when
 * the log has no summary. A subset whose files all skip is green with this at 0,
 * which the failure count cannot show (#4518).
 */
export function parseWindowsVitestExecutedCount(log) {
	const { testsPassed, testsFailed } = parseVitestSummary(log);
	return testsPassed === null && testsFailed === null
		? null
		: (testsPassed ?? 0) + (testsFailed ?? 0);
}

if (isMainModule(import.meta.url)) {
	const parse = process.argv.includes("--executed")
		? parseWindowsVitestExecutedCount
		: parseWindowsVitestFailureCount;
	const count = parse(readFileSync(process.argv[2], "utf8"));
	process.stdout.write(count === null ? "unknown\n" : `${count}\n`);
}
