// #3801: ci.yml's `Heavy advisory gate (advisory)` job and ci-verdict's
// deferred-row list are retired. A PR head that predates the retirement still
// carries the gate's check-run, in any state. ci-verdict must keep reading
// such a head: the row classifies as advisory by its suffix, it never gates, it
// never lists a deferred row, and it never reaches the failing rows.
//
// Recurrence this file guards: a retirement that turned an old head's gate row
// (red, skipped or running) into a gating failure or a crash, so every open PR
// opened before the merge reads red until it is pushed again.
import { describe, expect, it } from "vitest";
import {
	computeVerdict,
	EXIT_FAILURE,
	EXIT_PENDING,
	EXIT_SUCCESS,
	formatGatingSplit,
	formatVerdictTable,
} from "../../scripts/ci-verdict.mjs";
import { isAdvisoryCheck } from "../../scripts/lib/ci-checks.mjs";

// The literal old name: the job no longer exists to derive it from.
const OLD_GATE = "Heavy advisory gate (advisory)";

function checkRun(
	name: string,
	status = "completed",
	conclusion: string | null = "success",
	id = 1,
) {
	return {
		name,
		status,
		conclusion,
		started_at: "2026-09-30T00:00:00Z",
		id,
		html_url: `https://github.com/apmantza/pi-lens/actions/runs/${id}`,
		details_url: `https://github.com/apmantza/pi-lens/actions/runs/${id}/job/${id}`,
	};
}

const green = [
	checkRun("Unit tests", "completed", "success", 1),
	checkRun("Lint & type-check", "completed", "success", 2),
	checkRun("Changed files (advisory)", "completed", "success", 3),
];

describe("ci-verdict on a head that still carries the retired gate row (#3801)", () => {
	it("classifies the old gate name as advisory by its suffix", () => {
		expect(isAdvisoryCheck(OLD_GATE)).toBe(true);
	});

	// Every state the old gate's row could be in on a head built before the
	// retirement. None of them may fail, hold or annotate a green head.
	it.each([
		["running", "in_progress", null],
		["passed", "completed", "success"],
		["skipped", "completed", "skipped"],
		["red", "completed", "failure"],
		["timed out", "completed", "timed_out"],
	] as const)(
		"keeps a green head green when the old gate row is %s",
		(_label, status, conclusion) => {
			const verdict = computeVerdict({
				check_runs: [...green, checkRun(OLD_GATE, status, conclusion, 4)],
			});
			expect(verdict.exitCode).toBe(EXIT_SUCCESS);
			expect(verdict.kind).toBe("success");
			expect(verdict.failingRows).toEqual([]);
			expect(
				verdict.rows.find((row: { name: string }) => row.name === OLD_GATE)
					?.gating,
			).toBe(false);
			expect(formatVerdictTable(verdict.rows)).not.toMatch(/NOT RUN|PENDING/);
			expect(formatGatingSplit(verdict.rows, verdict.failingRows)[0]).toBe(
				"Gating: 2 checks, 0 failing",
			);
		},
	);

	// A red old gate beside a red required check fails the head for the required
	// check alone: the gate row is not among the failing rows.
	it("names only the required check when both it and the old gate row are red", () => {
		const verdict = computeVerdict({
			check_runs: [
				checkRun("Unit tests", "completed", "failure", 1),
				checkRun("Lint & type-check", "completed", "success", 2),
				checkRun(OLD_GATE, "completed", "failure", 4),
			],
		});
		expect(verdict.exitCode).toBe(EXIT_FAILURE);
		expect(
			verdict.failingRows.map((row: { name: string }) => row.name),
		).toEqual(["Unit tests"]);
	});

	it("still reports PENDING for a running required check beside the old gate row", () => {
		const verdict = computeVerdict({
			check_runs: [
				checkRun("Unit tests", "completed", "success", 1),
				checkRun("Lint & type-check", "in_progress", null, 2),
				checkRun(OLD_GATE, "in_progress", null, 4),
			],
		});
		expect(verdict.exitCode).toBe(EXIT_PENDING);
	});
});
