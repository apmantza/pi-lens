import type { TestFailure, TestResult } from "../../test-runner-client.js";
import type { ProjectDiagnostic } from "../types.js";

/**
 * #628 item 4: the test-runner-findings cache (written at turn_end, see
 * `runtime-turn.ts`) is a cache-only source here — this NEVER launches a test
 * run itself (running a whole suite is explicitly out of scope, see the
 * issue's non-goal). It just reads whatever the per-edit test-fire already
 * produced, the same way the jscpd/knip/madge extractors read their caches.
 *
 * (File deliberately NOT named `test-runner*.ts` — that pattern is
 * gitignored for ad-hoc scratch scripts, same reason `high-fan-out`'s
 * `framework-call-noise.ts` sibling avoided it.)
 *
 * The cache's `content` field is a pre-formatted string for the next-turn
 * context injection; `results` (added alongside it) carries the structured
 * per-file `TestResult`s this adapter needs to emit per-file diagnostics.
 * Older caches written before `results` existed won't have it — treated as
 * "nothing to adapt", not an error.
 */
export interface TestRunnerFindingsCache {
	content: string;
	stale?: boolean;
	results?: TestResult[];
}

function failureMessage(failure: TestFailure): string {
	const firstLine = failure.message.split("\n")[0]?.slice(0, 300) ?? "";
	return firstLine ? `${failure.name}: ${firstLine}` : failure.name;
}

/**
 * One diagnostic per test failure, attributed to the test file that reported
 * it (not the source file the agent edited — that's `sourceFile` on
 * `TestResult`, but the failure itself lives in the test file). A result with
 * no individual failures listed (a parser that couldn't extract them, or a
 * runner error) still gets one diagnostic so the file isn't silently blank.
 */
export function testResultToProjectDiagnostics(
	result: TestResult,
): ProjectDiagnostic[] {
	if (result.failed === 0 && !result.error) return [];

	if (result.failures.length > 0) {
		return result.failures.map((failure) => ({
			filePath: result.file,
			severity: "error",
			semantic: "blocking",
			tool: "test-runner",
			runner: result.runner,
			rule: `test:${result.runner}`,
			message: failureMessage(failure),
			source: "project-scan",
		}));
	}

	return [
		{
			filePath: result.file,
			severity: "error",
			semantic: "blocking",
			tool: "test-runner",
			runner: result.runner,
			rule: `test:${result.runner}`,
			message: result.error
				? `Test run error: ${result.error}`
				: `${result.failed} test(s) failed`,
			source: "project-scan",
		},
	];
}

export function testRunnerFindingsToProjectDiagnostics(
	cache: TestRunnerFindingsCache,
): ProjectDiagnostic[] {
	if (!cache.results || cache.results.length === 0) return [];
	return cache.results.flatMap((r) => testResultToProjectDiagnostics(r));
}
