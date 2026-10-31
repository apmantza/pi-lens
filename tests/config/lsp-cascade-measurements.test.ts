// #1712: the committed first measured table (the #1549 budget input) is the
// lane's own artifact, so it has to keep describing the lane that produced it.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	CASCADE_CONCLUSIVE_DEADLINE_MS,
	CASCADE_FIXTURES,
	cascadeTimesRecord,
} from "../../scripts/lib/lsp-cascade-smoke.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const table = JSON.parse(
	readFileSync(
		resolve(REPO_ROOT, "tests/fixtures/lsp-cascade/measurements.json"),
		"utf8",
	),
) as {
	schema: number;
	command: string;
	date: string;
	runner: { ci: boolean; runId: string | null } & Record<string, unknown>;
	rows: {
		lang: string;
		state: string;
		detail?: string;
		timeToConclusiveMs: number | null;
	}[];
};

type Row = (typeof table.rows)[number];

/** What is wrong with one committed row for its fixture, or null. */
function rowProblem(
	row: Row | undefined,
	fixture: { lang: string; expectDefect?: unknown },
): string | null {
	if (row?.state === "known-defect") {
		if (!fixture.expectDefect) return `${fixture.lang} may be a known defect`;
		if (row.timeToConclusiveMs !== null) return "a known defect has no time";
		if (!row.detail?.includes("known defect"))
			return "a known defect names its cause";
		return null;
	}
	if (row?.state !== "pass")
		return `${fixture.lang} must be a pass or a known defect`;
	return typeof row.timeToConclusiveMs === "number"
		? null
		: "a pass has a time";
}

describe("tests/fixtures/lsp-cascade/measurements.json (#1712)", () => {
	it("is a record of the schema the lane writes, taken on a CI runner", () => {
		// Recurrence: a table typed by hand, or taken on a laptop, would set the
		// #1549 budget from a machine the nightly never runs on.
		const written = cascadeTimesRecord([], {}, {});
		expect(table.schema).toBe(written.schema);
		expect(table.command).toBe(written.command);
		expect(Object.keys(table.runner).sort()).toEqual(
			Object.keys(written.runner).sort(),
		);
		expect(table.runner.ci).toBe(true);
		expect(table.runner.runId).toMatch(/^\d+$/);
		expect(table.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	it("has one row per fixture: a pass with a time, or a declared known defect with none", () => {
		// Recurrence: a fixture added without a measurement, a night where the
		// declared defect showed and the row carries a time it never had, or an
		// unavailable server (`skip`) committed as if it had been measured.
		expect(table.rows.map((r) => r.lang)).toEqual(
			CASCADE_FIXTURES.map((f) => f.lang),
		);
		for (const fixture of CASCADE_FIXTURES) {
			const row = table.rows.find((r) => r.lang === fixture.lang);
			expect(rowProblem(row, fixture), fixture.lang).toBeNull();
		}
	});

	it("reads a known-defect row only for a declaring fixture, with its cause and no time", () => {
		// Recurrence: #1712 review M2. `known-defect` is the declared defect's own
		// state: a row for a fixture that declares nothing, one carrying a time,
		// and one without its cause are each a table the lane cannot have written;
		// `skip` means unavailable and is never a committed row.
		const declares = { lang: "java", expectDefect: { skipReason: "non_code" } };
		const row = {
			lang: "java",
			state: "known-defect",
			detail: "known defect (held out): cascade skipped: non_code",
			timeToConclusiveMs: null,
		};
		expect(rowProblem(row, declares)).toBeNull();
		expect(rowProblem(row, { lang: "java" })).toMatch(/may be a known defect/);
		expect(rowProblem({ ...row, timeToConclusiveMs: 1803 }, declares)).toMatch(
			/no time/,
		);
		expect(rowProblem({ ...row, detail: "" }, declares)).toMatch(/its cause/);
		expect(rowProblem({ ...row, state: "skip" }, declares)).toMatch(
			/must be a pass/,
		);
	});

	it("leaves every conclusive deadline at least ten times the measured time", () => {
		// Recurrence: #1549, a budget set on the edge of a measurement reds the
		// nightly on runner noise.
		for (const row of table.rows) {
			if (row.timeToConclusiveMs === null) continue;
			const fixture = CASCADE_FIXTURES.find((f) => f.lang === row.lang);
			// A declared fixture's deadline is the short one that bounds a structural
			// skip; the sample row above predates the hold and measures no budget.
			if (fixture?.expectDefect) continue;
			const deadline =
				fixture?.conclusiveDeadlineMs ?? CASCADE_CONCLUSIVE_DEADLINE_MS;
			expect(deadline).toBeGreaterThanOrEqual(10 * row.timeToConclusiveMs);
		}
	});
});
