import { describe, expect, it } from "vitest";
import { formatSlopScoreSummary } from "../../clients/session-summary.js";

describe("formatSlopScoreSummary", () => {
	it("returns empty string when there are no diagnostics", () => {
		const line = formatSlopScoreSummary({
			totalRuleDiagnostics: 0,
			totalKlocWritten: 1,
			scorePerKloc: 0,
			ruleCounts: [],
		});

		expect(line).toBe("");
	});

	it("formats score with top rule counts", () => {
		const line = formatSlopScoreSummary({
			totalRuleDiagnostics: 3,
			totalKlocWritten: 1.25,
			scorePerKloc: 2.4,
			ruleCounts: [
				{ ruleId: "error-obscuring", count: 2 },
				{ ruleId: "error-swallowing", count: 1 },
			],
		});

		expect(line).toBe(
			"Slop score: 2.4/KLOC  (error-obscuring ×2, error-swallowing ×1)",
		);
	});
});
