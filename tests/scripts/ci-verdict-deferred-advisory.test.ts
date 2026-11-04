// #3801 / #5275: ci.yml's `heavy-gate` releases heavy advisory jobs only after
// every required check passed, and ci-verdict lists each of them as a
// deferred row (PENDING or NOT RUN) while GitHub has no check-run for it.
// `DEFERRED_ADVISORY_CHECKS` is empty since #5275 moved PR-time CodeQL, the
// last job behind the gate, to codeql.yml's daily schedule.
//
// Recurrence this file guards: a name left on the list after its job left
// ci.yml. ci-verdict would then show a PENDING (or NOT RUN) row for a job that
// never runs, on every PR head that carries the gate, forever.
import { describe, expect, it } from "vitest";
import {
	computeVerdict,
	EXIT_FAILURE,
	EXIT_PENDING,
	EXIT_SUCCESS,
	formatGatingSplit,
	formatVerdictTable,
} from "../../scripts/ci-verdict.mjs";
import {
	CHANGES_CHECK,
	DEFERRED_ADVISORY_CHECKS,
	HEAVY_GATE_CHECK,
	isAdvisoryCheck,
} from "../../scripts/lib/ci-checks.mjs";

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

const deferred = (rows: Array<{ name: string; deferred?: boolean }>) =>
	rows.filter((row) => row.deferred).map((row) => row.name);

const green = [
	checkRun("Unit tests", "completed", "success", 1),
	checkRun("Lint & type-check", "completed", "success", 2),
	checkRun(CHANGES_CHECK, "completed", "success", 3),
];

describe("ci-verdict deferred advisory rows (#3801, #5275)", () => {
	it("lists no job behind the gate, and none of them is a CodeQL row", () => {
		expect(DEFERRED_ADVISORY_CHECKS).toEqual([]);
		// Retired names, pinned: a re-added entry would defer a job that no
		// longer exists (CodeQL, #5275) or that starts on every event (the
		// promoted Windows unit leg, #4518).
		for (const name of [
			"CodeQL (actions) (advisory)",
			"CodeQL (javascript-typescript) (advisory)",
			"Unit tests Windows",
			"Unit tests Windows (advisory)",
		])
			expect(DEFERRED_ADVISORY_CHECKS).not.toContain(name);
	});

	// Every head shape a reader meets: required check running, terminal failure,
	// success with each state of the gate's own row.
	const heads: Array<[string, Array<ReturnType<typeof checkRun>>]> = [
		[
			"a required check still running",
			[
				checkRun("Unit tests", "completed", "success", 1),
				checkRun("Lint & type-check", "in_progress", null, 2),
			],
		],
		[
			"a terminal failure",
			[
				checkRun("Unit tests", "completed", "failure", 1),
				checkRun("Lint & type-check", "completed", "success", 2),
			],
		],
		["success, no gate row yet", green],
		[
			"success, gate running",
			[...green, checkRun(HEAVY_GATE_CHECK, "in_progress", null, 4)],
		],
		[
			"success, gate passed",
			[...green, checkRun(HEAVY_GATE_CHECK, "completed", "success", 4)],
		],
		[
			"success, gate skipped",
			[...green, checkRun(HEAVY_GATE_CHECK, "completed", "skipped", 4)],
		],
		[
			"success, gate red",
			[...green, checkRun(HEAVY_GATE_CHECK, "completed", "failure", 4)],
		],
	];
	it.each(heads.map(([label, check_runs]) => ({ label, check_runs })))(
		"adds no deferred row for $label",
		({ check_runs }) => {
			const verdict = computeVerdict({ check_runs });
			expect(deferred(verdict.rows)).toEqual([]);
			expect(formatVerdictTable(verdict.rows)).not.toMatch(/NOT RUN|CodeQL/);
		},
	);

	// The gate's own advisory row never moves an exit code, whatever it reads.
	it("keeps the gate row advisory: a red gate does not fail a green head", () => {
		expect(isAdvisoryCheck(HEAVY_GATE_CHECK)).toBe(true);
		const verdict = computeVerdict({
			check_runs: [
				...green,
				checkRun(HEAVY_GATE_CHECK, "completed", "failure", 4),
			],
		});
		expect(verdict.exitCode).toBe(EXIT_SUCCESS);
		expect(verdict.kind).toBe("success");
		expect(formatGatingSplit(verdict.rows, verdict.failingRows)[0]).toBe(
			"Gating: 2 checks, 0 failing",
		);
	});

	it("gates the promoted Windows unit leg as an ordinary check-run", () => {
		const verdict = computeVerdict({
			check_runs: [
				checkRun("Unit tests", "completed", "success", 1),
				checkRun("Lint & type-check", "completed", "success", 2),
				checkRun("Unit tests Windows", "completed", "failure", 3),
			],
		});
		expect(verdict.exitCode).toBe(EXIT_FAILURE);
		const row = verdict.rows.find(
			(entry: { name: string }) => entry.name === "Unit tests Windows",
		);
		expect(row?.gating).toBe(true);
	});

	it("still reports PENDING for a running required check", () => {
		const verdict = computeVerdict({ check_runs: heads[0][1] });
		expect(verdict.exitCode).toBe(EXIT_PENDING);
	});
});
