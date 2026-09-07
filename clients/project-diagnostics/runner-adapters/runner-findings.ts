import {
	isRunnerErrorResult,
	type TestFailure,
	type TestResult,
} from "../../test-runner-client.js";
import type { ProjectDiagnostic } from "../types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import type { RuntimeCoordinator } from "../../runtime-coordinator.js";
import {
	advisoryPathKey,
	validateAdvisoryProvenance,
	type AdvisoryProvenance,
} from "../../advisory-provenance.js";

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
 * The cache's `content` field is a pre-formatted string for pull diagnostics
 * and the post-agent custom entry; `results` carries the structured per-file
 * `TestResult`s this adapter needs to emit per-file diagnostics.
 * Older caches written before `results` existed won't have it — treated as
 * "nothing to adapt", not an error.
 */
/**
 * #2522 review round 2, F1: one target the turn-end batch could not finish —
 * killed when the batch hit its wall budget, or never dispatched at all.
 * Persisted by IDENTITY (not merely counted) so the next turn can run it
 * FIRST. Plain JSON only: a `RunnerConfig` carries functions and cannot
 * round-trip through the cache, so the runner is stored by key and its config
 * re-resolved from `RUNNERS` at selection time.
 */
export interface DeferredTestTarget {
	/** Absolute path to the test file that did not get to run. */
	testFile: string;
	/** `RUNNERS` key, re-resolved to a `RunnerConfig` on the next turn. */
	runner: string;
	/**
	 * How many turn-end batches this target has now been cut out of. A target
	 * whose own runtime EXCEEDS the whole batch budget would otherwise be
	 * deferred, put first, cut, and deferred again — forever, burning the full
	 * budget in spawned runners every turn. `TEST_RUNNER_MAX_DEFERRALS`
	 * (`runtime-turn.ts`) retires it instead, with a counted degradation.
	 * Absent on a record written before the cap existed, read as 0.
	 */
	attempts?: number;
	/**
	 * #2522 review round 3, F5: which session cut (or retired) this target.
	 *
	 * A deferral is a statement about ONE session's turn-end batches. The cache
	 * record outlives the session, so without an identity stamp a fresh session
	 * adopts the previous one's cut list — re-firing suites for edits it never
	 * made — and, worse, inherits its `attempts` counters, so a target can be
	 * retired on its first cut in a session that never cut it. Entries whose
	 * stamp is not the current session are dropped at selection time, which is
	 * also what re-arms a retirement at `session_start` (#2504's shape).
	 * Absent on a record written before the stamp existed; read as foreign.
	 */
	sessionId?: string;
}

export interface TestRunnerFindingsCache {
	content: string;
	stale?: boolean;
	results?: TestResult[];
	testRunGeneration?: number;
	launchedFrom?: AdvisoryProvenance;
	publishedAgainst?: AdvisoryProvenance;
	provenance?: AdvisoryProvenance;
	superseded?: boolean;
	/**
	 * #2522: true when NOTHING in `content` is a genuine failing test — every
	 * entry is either a RUNNER error (timeout, missing provider/binary, a
	 * rejected promise — `TestResult.error` with `failed === 0`) or, since
	 * review round 2, a target the batch was cut before it could finish. Read
	 * by `peekTestFindings`/`consumeTestFindings` (`runtime-context.ts`) to
	 * deliver these as advisory rather than "fix before continuing" — the
	 * agent introduced nothing here to fix. Absent on older cache writes,
	 * which fall back to the pre-#2522 blocking framing.
	 */
	runnerErrorOnly?: boolean;
	/**
	 * #2522 review round 2, F1: the targets this turn's batch could not finish.
	 * The turn-end selection loop (`runtime-turn.ts`) dispatches these FIRST on
	 * the next turn, ahead of failed-first/related/self and under the same
	 * `TEST_RUNNER_MAX_TARGETS` cap, then clears the list. A non-empty list is
	 * also what stops an unfinished batch from being recorded as a clean run.
	 */
	deferredTargets?: DeferredTestTarget[];
	/**
	 * #2522 review round 3, F1: the targets that exhausted
	 * `TEST_RUNNER_MAX_DEFERRALS` and are retired from turn-end selection for
	 * the rest of the session.
	 *
	 * Round 2 announced the retirement and then `continue`d, leaving no record
	 * of it anywhere: the same turn's candidate loop re-resolved the file
	 * through `related`/`self` and re-added it with no attempt count, so the
	 * cap reset every turn and the "too slow" suite was spawned and cut on
	 * every single turn — exactly the livelock the cap was added to end. The
	 * retirement has to outlive the turn to be a retirement at all. It is
	 * session-scoped by the `sessionId` stamp on each entry, so a new session
	 * re-arms every target rather than inheriting a verdict measured under
	 * another session's load.
	 */
	retiredTargets?: DeferredTestTarget[];
	deliveryEligible?: {
		sessionId: string;
		ownerId?: string;
		generation: number;
		eligibleAt: number;
	};
}

function failureMessage(failure: TestFailure): string {
	const firstLine = failure.message.split("\n")[0]?.slice(0, 300) ?? "";
	return firstLine ? `${failure.name}: ${firstLine}` : failure.name;
}

/**
 * `TestFailure.location` (`test-runner-client.ts`) is a free-form string that
 * varies by parser: the vitest/jest JSON parser emits a real `"relPath:line"`
 * (line only — its own `test.location.column` is dropped before it reaches
 * this string, so column is never available from that source either), while
 * the pytest text parser abuses the same field for `"file:testName"` (no
 * digits) and the mix/ExUnit parser puts a bare module name in it (no colon
 * at all). Only pull a `line`/`column` out when the trailing segment(s) are
 * actually numeric, so pytest/mix locations are left alone (no line, same as
 * before this change) instead of misparsing part of a name as a line number.
 */
const LOCATION_LINE_COL_RE = /:(\d+)(?::(\d+))?$/;

function parseLocation(location: string | undefined): {
	line?: number;
	column?: number;
} {
	if (!location) return {};
	const match = LOCATION_LINE_COL_RE.exec(location);
	if (!match) return {};
	return {
		line: Number.parseInt(match[1], 10),
		...(match[2] ? { column: Number.parseInt(match[2], 10) } : {}),
	};
}

/**
 * One diagnostic per test failure, attributed to the test file that reported
 * it (not the source file the agent edited — that's `sourceFile` on
 * `TestResult`, but the failure itself lives in the test file). A result with
 * no individual failures listed (a parser that couldn't extract them, or a
 * runner error) still gets one diagnostic so the file isn't silently blank.
 *
 * `stale` (from the cache's own `stale` flag, set at turn_end when the turn
 * advanced before the test run finished — `runtime-turn.ts`) is surfaced as a
 * message prefix, mirroring the one-shot turn-context-injection message's own
 * stale wording (`consumeTestFindings`'s cached `content`) — a mode=full
 * caller deserves the same "this may already be superseded" honesty the
 * per-edit path already gives.
 */
function testResultToProjectDiagnostics(
	result: TestResult,
	stale = false,
): ProjectDiagnostic[] {
	if (result.failed === 0 && !result.error) return [];
	const stalePrefix = stale ? "[stale — from a prior turn] " : "";

	if (result.failures.length > 0) {
		return result.failures.map((failure) => ({
			filePath: result.file,
			...parseLocation(failure.location),
			severity: "error",
			semantic: "blocking",
			tool: "test-runner",
			runner: result.runner,
			rule: `test:${result.runner}`,
			message: `${stalePrefix}${failureMessage(failure)}`,
			source: "project-scan",
		}));
	}

	// #2532: a RUNNER error (timeout, missing provider/binary, a config
	// failure — the suite itself never produced a verdict) is not a finding
	// the agent introduced, exactly like the turn-end delivery framing
	// (#2522) already treats it. `isRunnerErrorResult` is the single seam
	// both surfaces read so the identical `TestResult` cannot classify
	// differently here than it does in the turn-end message.
	if (isRunnerErrorResult(result)) {
		return [
			{
				filePath: result.file,
				severity: "info",
				semantic: "none",
				tool: "test-runner",
				runner: result.runner,
				rule: `test:${result.runner}`,
				message: `${stalePrefix}Test run error: ${result.error}`,
				source: "project-scan",
			},
		];
	}

	// #2532 review S3: a counted failure stays blocking even when `error` is
	// ALSO set (pytest exit 2 "Interrupted" after `2 failed, 1 passed` — see
	// `isRunnerErrorResult`'s doc). The pre-fix message mentioned `error`
	// here via a ternary this PR's first version dropped; restored so the
	// interruption is not silently lost from a still-blocking finding.
	return [
		{
			filePath: result.file,
			severity: "error",
			semantic: "blocking",
			tool: "test-runner",
			runner: result.runner,
			rule: `test:${result.runner}`,
			message: `${stalePrefix}${result.failed} test(s) failed${
				result.error ? ` (runner also reported: ${result.error})` : ""
			}`,
			source: "project-scan",
		},
	];
}

export function testRunnerFindingsToProjectDiagnostics(
	cache: TestRunnerFindingsCache,
	cwd?: string,
	runtime?: RuntimeCoordinator,
): ProjectDiagnostic[] {
	if (!cache.results || cache.results.length === 0) return [];
	const validation = cwd
		? validateAdvisoryProvenance(cache, cwd, runtime)
		: { status: "unknown" as const, reasons: ["validation-context-missing"] };
	const root = cwd ?? process.cwd();
	const missingKeys = new Set(
		(cache.provenance?.files ?? [])
			.filter((file) => !fs.existsSync(path.resolve(root, file.path)))
			.map((file) => advisoryPathKey(file.path, root)),
	);
	const historical =
		cache.superseded === true ||
		cache.stale === true ||
		validation.status !== "current";
	return cache.results
		.filter((result) => !missingKeys.has(advisoryPathKey(result.file, root)))
		.flatMap((result) => testResultToProjectDiagnostics(result, historical))
		.map((diagnostic) =>
			historical
				? {
						...diagnostic,
						severity: "info" as const,
						semantic: "none" as const,
						message: diagnostic.message.startsWith("[stale")
							? diagnostic.message
							: `[historical — re-run to confirm] ${diagnostic.message}`,
					}
				: diagnostic,
		);
}
