import type { CoverageVerdict } from "../../clients/dispatch/types.js";

/**
 * The verdict a `DispatchResult` test double carries when the test is about
 * something else (the delta, the blocker record, the format drain) and wants the
 * all-clear line to read clean. A completed non-language-server runner, so it
 * never turns `PipelineResult.checkedClean` on; a test that is about the clean
 * line states its own verdict (#5258).
 */
export const CHECKED_BY_FIXTURE: CoverageVerdict = {
	checked: true,
	tier: "primary",
	runnerIds: ["fixture"],
};

/**
 * The sentence an unchecked verdict gives instead of "clean", or `undefined`
 * when a check completed. The reader the coverage-notice tests assert wording
 * through (the old `unconfirmedStatus`, #5258).
 */
export const uncheckedReason = (result: {
	verdict: CoverageVerdict;
}): string | undefined =>
	result.verdict.checked ? undefined : result.verdict.reason;
