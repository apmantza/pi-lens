// #3801: ci.yml starts the heavy advisory jobs (mutation, the Windows Vitest
// subset) only after every required check passed, so until then GitHub has no
// check-run for them. ci-verdict lists each as PENDING while the verdict is
// pending, and never lets one move an exit code.
//
// Recurrences this file guards:
//  - a deferred job reading as "absent" (indistinguishable from a lane that
//    was deleted) while the required checks are still running;
//  - a deferred advisory row gating: pending it must not hold a verdict that
//    is otherwise success, and absent it must not fail one;
//  - an older head (no heavy-gate in its workflow) being relabelled PENDING
//    forever once its verdict is terminal.
import { describe, expect, it } from "vitest";
import {
	computeVerdict,
	EXIT_FAILURE,
	EXIT_PENDING,
	EXIT_SUCCESS,
	formatGatingSplit,
	formatMutationLine,
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

describe("ci-verdict deferred advisory rows (#3801)", () => {
	it("names every deferred heavy job PENDING while a required check is still running", () => {
		const verdict = computeVerdict({
			check_runs: [
				checkRun("Unit tests", "completed", "success", 1),
				checkRun("Lint & type-check", "in_progress", null, 2),
			],
		});
		expect(verdict.exitCode).toBe(EXIT_PENDING);
		expect(deferred(verdict.rows)).toEqual([...DEFERRED_ADVISORY_CHECKS]);
		const table = formatVerdictTable(verdict.rows);
		// Columns are CHECK / STATUS / CONCLUSION / URL, separated by 2+ spaces.
		const columns = table
			.split("\n")
			.map((line) => line.split(/\s{2,}/).slice(0, 3));
		for (const name of DEFERRED_ADVISORY_CHECKS) {
			expect(columns).toContainEqual([name, "PENDING", "-"]);
		}
	});

	it("keeps them advisory: rows never gate, and a success with every heavy job absent stays success", () => {
		const base = [
			checkRun("Unit tests", "completed", "success", 1),
			checkRun("Lint & type-check", "completed", "success", 2),
		];
		const success = computeVerdict({ check_runs: base });
		expect(success.exitCode).toBe(EXIT_SUCCESS);
		expect(deferred(success.rows)).toEqual([]);

		const pending = computeVerdict({
			check_runs: [base[0], checkRun("Lint & type-check", "queued", null, 2)],
		});
		const gating = pending.rows.filter(
			(row: { gating: boolean }) => row.gating,
		);
		expect(gating.map((row: { name: string }) => row.name)).toEqual([
			"Unit tests",
			"Lint & type-check",
		]);
		for (const name of DEFERRED_ADVISORY_CHECKS)
			expect(isAdvisoryCheck(name)).toBe(true);
		// The split counts them on the advisory side only.
		expect(formatGatingSplit(pending.rows, pending.failingRows)[0]).toBe(
			"Gating: 2 checks, 0 failing",
		);
	});

	it("does not relabel a terminal verdict: a failed head lists no deferred rows", () => {
		const failed = computeVerdict({
			check_runs: [
				checkRun("Unit tests", "completed", "failure", 1),
				checkRun("Lint & type-check", "completed", "success", 2),
			],
		});
		expect(failed.exitCode).toBe(EXIT_FAILURE);
		expect(deferred(failed.rows)).toEqual([]);
	});

	it("does not duplicate a deferred job that already has a check-run", () => {
		const verdict = computeVerdict({
			check_runs: [
				checkRun("Unit tests", "completed", "success", 1),
				checkRun("Lint & type-check", "in_progress", null, 2),
				checkRun("mutation (advisory)", "in_progress", null, 3),
			],
		});
		expect(
			verdict.rows.filter(
				(row: { name: string }) => row.name === "mutation (advisory)",
			),
		).toHaveLength(1);
		expect(deferred(verdict.rows)).toEqual(
			DEFERRED_ADVISORY_CHECKS.filter((name) => name !== "mutation (advisory)"),
		);
	});

	// Recurrence: the MUTATION line read a deferred job as "not running" and
	// printed STALE for the previous head's comment while the new head's job was
	// only waiting on the required checks.
	it("makes the MUTATION line say PENDING, not STALE, for a deferred job", () => {
		const verdict = computeVerdict({
			check_runs: [
				checkRun("Unit tests", "completed", "success", 1),
				checkRun("Lint & type-check", "in_progress", null, 2),
			],
		});
		const head = "b".repeat(40);
		expect(formatMutationLine([], head, verdict.rows)).toMatch(
			/PENDING -- no Mutation diff comment on this PR yet$/,
		);
		const previousHead = "a".repeat(40);
		const comment = {
			id: 9,
			user: { login: "github-actions[bot]" },
			body: `<!-- pi-lens-mutation-diff -->\n### Mutation diff (advisory)\n\n- **Head:** \`${previousHead}\`\n\nNo survivors.`,
		};
		const line = formatMutationLine([comment], head, verdict.rows);
		expect(line).toContain(
			"PENDING -- the mutation job is waiting for the required checks on PR head",
		);
	});

	// Recurrence (review r1 F3): the deferred rows vanished exactly when the
	// verdict turned success, so "mutation starts when the gate gets a runner",
	// "the gate decided not-ready" and "mutation will never run" all read the
	// same (exit 0, MUTATION: STALE). Every gate state must be distinguishable
	// AFTER the required checks are green, and never move the exit code.
	describe("after the required checks are green (the window a merger reads)", () => {
		const green = [
			checkRun("Unit tests", "completed", "success", 1),
			checkRun("Lint & type-check", "completed", "success", 2),
			checkRun(CHANGES_CHECK, "completed", "success", 3),
		];
		const head = "b".repeat(40);
		const stale = {
			id: 9,
			user: { login: "github-actions[bot]" },
			body: `<!-- pi-lens-mutation-diff -->\n### Mutation diff (advisory)\n\n- **Head:** \`${"a".repeat(40)}\`\n\nNo survivors.`,
		};
		const read = (gate: ReturnType<typeof checkRun> | null) => {
			const verdict = computeVerdict({
				check_runs: gate ? [...green, gate] : green,
			});
			const table = formatVerdictTable(verdict.rows);
			const status = (name: string) =>
				table
					.split("\n")
					.map((line) => line.split(/\s{2,}/))
					.find((columns) => columns[0] === name)?.[1];
			return {
				verdict,
				status,
				line: formatMutationLine([stale], head, verdict.rows),
			};
		};

		const gateStates: Array<
			[string, ReturnType<typeof checkRun> | null, string, RegExp]
		> = [
			[
				"no gate row yet",
				null,
				"PENDING",
				/PENDING -- the mutation job is waiting for the required checks/,
			],
			[
				"gate queued",
				checkRun(HEAVY_GATE_CHECK, "queued", null, 4),
				"PENDING",
				/PENDING -- the mutation job is waiting for the required checks/,
			],
			[
				"gate running",
				checkRun(HEAVY_GATE_CHECK, "in_progress", null, 4),
				"PENDING",
				/PENDING -- the mutation job is waiting for the required checks/,
			],
			[
				"gate passed, jobs not queued yet",
				checkRun(HEAVY_GATE_CHECK, "completed", "success", 4),
				"PENDING",
				/PENDING -- the mutation job is the gate passed and the job is about to be queued/,
			],
			[
				"gate skipped",
				checkRun(HEAVY_GATE_CHECK, "completed", "skipped", 4),
				"NOT RUN",
				/NOT RUN -- the heavy gate was skipped .*STALE \(PR head is b{12}\)/,
			],
			[
				"gate red (ready=false)",
				checkRun(HEAVY_GATE_CHECK, "completed", "failure", 4),
				"NOT RUN",
				/NOT RUN -- the heavy gate concluded failure .*lint\.yml required check was red or unfinished/,
			],
		];
		it.each(
			gateStates.map(([label, gate, state, mutationLine]) => ({
				label,
				gate,
				state,
				mutationLine,
			})),
		)("$label -> $state", ({ gate, state, mutationLine }) => {
			const { verdict, status, line } = read(gate);
			expect(verdict.exitCode).toBe(EXIT_SUCCESS);
			expect(verdict.kind).toBe("success");
			for (const name of DEFERRED_ADVISORY_CHECKS) {
				expect(status(name), name).toBe(state);
			}
			expect(line).toMatch(mutationLine);
		});

		// An older workflow (neither the gate nor `changes` exists) must not be
		// relabelled once its verdict is terminal.
		it("lists nothing for a head of the older shape", () => {
			const verdict = computeVerdict({
				check_runs: green.filter((run) => run.name !== CHANGES_CHECK),
			});
			expect(deferred(verdict.rows)).toEqual([]);
		});
	});

	// Recurrence (verify r2 V2): once the heavy gate is red or skipped, GitHub
	// writes a completed `skipped` check-run for the mutation job, so it is a
	// PRESENT row and the NOT RUN branch (written for absent rows) never fired in
	// production: the line read "STALE" or "no report (job skipped)" without the
	// cause. The line must name the gate's state when the mutation row is skipped.
	describe("when the mutation job has a completed skipped check-run", () => {
		const base = [
			checkRun("Unit tests", "completed", "success", 1),
			checkRun("Lint & type-check", "completed", "success", 2),
			checkRun(CHANGES_CHECK, "completed", "success", 3),
			checkRun("mutation (advisory)", "completed", "skipped", 5),
			checkRun("Unit tests Windows (advisory)", "completed", "skipped", 6),
		];
		const head = "b".repeat(40);
		const comment = {
			id: 9,
			user: { login: "github-actions[bot]" },
			body: `<!-- pi-lens-mutation-diff -->\n### Mutation diff (advisory)\n\n- **Head:** \`${"a".repeat(40)}\`\n\nNo survivors.`,
		};
		const line = (
			gate: ReturnType<typeof checkRun> | null,
			withComment = true,
		) => {
			const verdict = computeVerdict({
				check_runs: gate ? [...base, gate] : base,
			});
			return formatMutationLine(
				withComment ? [comment] : [],
				head,
				verdict.rows,
			);
		};

		it("names a red gate as the cause, with the stale comment's head", () => {
			expect(
				line(checkRun(HEAVY_GATE_CHECK, "completed", "failure", 4)),
			).toMatch(
				/NOT RUN -- the heavy gate concluded failure .*lint\.yml required check was red or unfinished.*STALE \(PR head is b{12}\)/,
			);
		});

		it("names a skipped gate as the cause, with and without a sticky comment", () => {
			const gate = checkRun(HEAVY_GATE_CHECK, "completed", "skipped", 4);
			expect(line(gate)).toMatch(
				/NOT RUN -- the heavy gate was skipped .*STALE/,
			);
			expect(line(gate, false)).toMatch(
				/NOT RUN -- the heavy gate was skipped .*; no Mutation diff comment on this PR$/,
			);
		});

		it("says so when the job was skipped although the gate passed", () => {
			expect(
				line(checkRun(HEAVY_GATE_CHECK, "completed", "success", 4)),
			).toMatch(
				/NOT RUN -- the job was skipped although the heavy gate passed/,
			);
		});

		// The reinterpretation is for a SKIPPED mutation row only: a mutation job
		// that ran keeps its own wording whatever the gate's row says.
		it("leaves a mutation job that ran alone", () => {
			const ran = base.map((run) =>
				run.name === "mutation (advisory)"
					? checkRun(run.name, "completed", "success", 5)
					: run,
			);
			const verdict = computeVerdict({
				check_runs: [
					...ran,
					checkRun(HEAVY_GATE_CHECK, "completed", "success", 4),
				],
			});
			expect(formatMutationLine([], head, verdict.rows)).toBe(
				"MUTATION (advisory, never gates): no report (job success) -- no Mutation diff comment on this PR",
			);
			expect(formatMutationLine([comment], head, verdict.rows)).toMatch(
				/STALE \(PR head is b{12}\)$/,
			);
		});

		// Without a gate row (an older workflow) the line keeps its old wording.
		it("keeps the old wording when there is no gate row", () => {
			expect(line(null, false)).toBe(
				"MUTATION (advisory, never gates): no report (job skipped) -- no Mutation diff comment on this PR",
			);
		});
	});
});
