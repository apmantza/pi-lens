import { describe, expect, it } from "vitest";
import { parseSqlfluffOutput } from "../../../../clients/dispatch/runners/sqlfluff.js";

function violationJson(
	violations: Array<{
		code: string;
		description: string;
		line_no?: number;
		line_pos?: number;
	}>,
): string {
	return JSON.stringify([
		{
			filepath: "queries/example.sql",
			violations,
		},
	]);
}

describe("parseSqlfluffOutput — fixable propagation (#112 slice)", () => {
	it("marks layout / capitalisation rules as fixable with a fixSuggestion", () => {
		const raw = violationJson([
			{
				code: "LT01",
				description: "Expected single whitespace between identifiers.",
				line_no: 3,
				line_pos: 5,
			},
			{
				code: "CP01",
				description: "Keywords must be upper case.",
				line_no: 1,
				line_pos: 1,
			},
		]);
		const diags = parseSqlfluffOutput(raw, "queries/example.sql");
		expect(diags).toHaveLength(2);
		for (const d of diags) {
			expect(d.tool).toBe("sqlfluff");
			expect(d.fixable).toBe(true);
			expect(d.fixSuggestion).toMatch(/sqlfluff fix/);
		}
	});

	it("does not mark rules outside the allowlist as fixable", () => {
		const raw = violationJson([
			{
				code: "AM01",
				description: "Ambiguous use of DISTINCT in select with GROUP BY.",
				line_no: 4,
				line_pos: 8,
			},
			{
				code: "ST05",
				description: "Move subquery to CTE.",
				line_no: 10,
				line_pos: 3,
			},
		]);
		const diags = parseSqlfluffOutput(raw, "queries/example.sql");
		expect(diags).toHaveLength(2);
		for (const d of diags) {
			expect(d.fixable).toBe(false);
			expect(d.fixSuggestion).toBeUndefined();
		}
	});

	it("handles empty and malformed JSON gracefully", () => {
		expect(parseSqlfluffOutput("", "queries/example.sql")).toEqual([]);
		expect(parseSqlfluffOutput("not json", "queries/example.sql")).toEqual([]);
		expect(parseSqlfluffOutput("{}", "queries/example.sql")).toEqual([]);
	});

	it("falls back to code 'SQL' when sqlfluff omits a code (never matches the allowlist)", () => {
		const raw = JSON.stringify([
			{
				filepath: "queries/example.sql",
				violations: [
					{
						description: "Some violation without a code field.",
						line_no: 1,
						line_pos: 1,
					},
				],
			},
		]);
		const diags = parseSqlfluffOutput(raw, "queries/example.sql");
		expect(diags).toHaveLength(1);
		expect(diags[0].rule).toBe("SQL");
		expect(diags[0].fixable).toBe(false);
	});
});
