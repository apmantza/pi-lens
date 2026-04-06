import { beforeEach, describe, expect, it } from "vitest";
import {
	createDiagnosticTracker,
	type Diagnostic,
	getDiagnosticTracker,
} from "../../clients/diagnostic-tracker.js";

describe("diagnostic-tracker", () => {
	describe("createDiagnosticTracker", () => {
		it("tracks shown diagnostics", () => {
			const tracker = createDiagnosticTracker();

			const diagnostics: Diagnostic[] = [
				{
					rule: "no-shadow",
					filePath: "/src/utils.ts",
					line: 23,
				},
				{
					rule: "prefer-optional-chain",
					filePath: "/src/utils.ts",
					line: 45,
				},
			];

			tracker.trackShown(diagnostics);

			const stats = tracker.getStats();
			expect(stats.totalShown).toBe(2);
			expect(stats.topViolations).toContainEqual({
				ruleId: "no-shadow",
				count: 1,
			});
		});

		it("accumulates across multiple trackShown calls", () => {
			const tracker = createDiagnosticTracker();

			tracker.trackShown([
				{ rule: "no-shadow", filePath: "/src/a.ts", line: 1 },
			]);
			tracker.trackShown([
				{ rule: "no-shadow", filePath: "/src/b.ts", line: 1 },
				{ rule: "prefer-optional-chain", filePath: "/src/c.ts", line: 1 },
			]);

			const stats = tracker.getStats();
			expect(stats.totalShown).toBe(3);
			expect(
				stats.topViolations.find((v) => v.ruleId === "no-shadow")?.count,
			).toBe(2);
			expect(
				stats.topViolations.find((v) => v.ruleId === "prefer-optional-chain")
					?.count,
			).toBe(1);
		});

		it("doesn't double-count same diagnostic", () => {
			const tracker = createDiagnosticTracker();

			tracker.trackShown([
				{ rule: "no-shadow", filePath: "/src/utils.ts", line: 23 },
			]);
			tracker.trackShown([
				{ rule: "no-shadow", filePath: "/src/utils.ts", line: 23 }, // same
			]);

			const stats = tracker.getStats();
			expect(stats.totalShown).toBe(1);
		});

		it("ranks top violations correctly", () => {
			const tracker = createDiagnosticTracker();

			// 3 different rules, varying frequencies
			tracker.trackShown([
				{ rule: "no-shadow", filePath: "/src/a.ts", line: 1 },
				{ rule: "no-shadow", filePath: "/src/b.ts", line: 1 },
				{ rule: "no-shadow", filePath: "/src/c.ts", line: 1 },
				{ rule: "prefer-optional-chain", filePath: "/src/d.ts", line: 1 },
				{ rule: "prefer-optional-chain", filePath: "/src/e.ts", line: 1 },
				{ rule: "no-console", filePath: "/src/f.ts", line: 1 },
			]);

			const stats = tracker.getStats();
			expect(stats.topViolations[0]).toEqual({
				ruleId: "no-shadow",
				count: 3,
			});
			expect(stats.topViolations[1]).toEqual({
				ruleId: "prefer-optional-chain",
				count: 2,
			});
			expect(stats.topViolations[2]).toEqual({
				ruleId: "no-console",
				count: 1,
			});
		});

		it("limits top violations to 10", () => {
			const tracker = createDiagnosticTracker();

			for (let i = 0; i < 15; i++) {
				tracker.trackShown([
					{ rule: `rule-${i}`, filePath: `/src/f${i}.ts`, line: 1 },
				]);
			}

			const stats = tracker.getStats();
			expect(stats.topViolations.length).toBe(10);
		});

		it("resets all state", () => {
			const tracker = createDiagnosticTracker();

			tracker.trackShown([
				{ rule: "no-shadow", filePath: "/src/a.ts", line: 1 },
				{ rule: "prefer-optional-chain", filePath: "/src/b.ts", line: 1 },
			]);

			tracker.reset();

			const stats = tracker.getStats();
			expect(stats.totalShown).toBe(0);
			expect(stats.topViolations.length).toBe(0);
		});

		it("uses singleton when using getDiagnosticTracker", () => {
			const tracker1 = getDiagnosticTracker();
			const tracker2 = getDiagnosticTracker();
			expect(tracker1).toBe(tracker2);
		});
	});
});
