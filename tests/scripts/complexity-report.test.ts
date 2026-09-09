import { describe, expect, it } from "vitest";
import {
	requireAnalyzedFiles,
	shapeComplexityReport,
} from "../../scripts/complexity-report.mjs";

describe("complexity report shaper", () => {
	it("orders metrics and identifies file/function split candidates", () => {
		const report = shapeComplexityReport([
			{
				filePath: "clients/small.ts",
				linesOfCode: 20,
				maxCyclomaticComplexity: 16,
				cognitiveComplexity: 9,
				functionCount: 1,
				functions: [
					{
						name: "hard",
						line: 4,
						length: 8,
						cyclomatic: 16,
						cognitive: 9,
						nestingDepth: 2,
					},
				],
			},
			{
				filePath: "clients/tree-sitter-client.ts",
				linesOfCode: 1200,
				maxCyclomaticComplexity: 8,
				cognitiveComplexity: 30,
				functionCount: 1,
				functions: [
					{
						name: "wide",
						line: 40,
						length: 100,
						cyclomatic: 8,
						cognitive: 20,
						nestingDepth: 4,
					},
				],
			},
			{
				filePath: "clients/quiet.ts",
				linesOfCode: 10,
				maxCyclomaticComplexity: 2,
				cognitiveComplexity: 1,
				functionCount: 1,
				functions: [
					{
						name: "quiet",
						line: 1,
						length: 2,
						cyclomatic: 2,
						cognitive: 1,
						nestingDepth: 1,
					},
				],
			},
		]);
		expect(report.indexOf("hard")).toBeLessThan(report.indexOf("wide"));
		expect(report).toContain("clients/tree-sitter-client.ts:40");
		expect(report).toContain(
			"- **File:** `clients/tree-sitter-client.ts` (1200 lines)",
		);
		expect(report).toContain("- **Function:** `hard` at `clients/small.ts:4`");
		expect(report).not.toContain("Function: `wide`");
	});

	it("treats a function at the dispatch threshold as a split candidate", () => {
		const report = shapeComplexityReport([
			{
				filePath: "clients/boundary.ts",
				linesOfCode: 20,
				maxCyclomaticComplexity: 15,
				cognitiveComplexity: 1,
				functionCount: 1,
				functions: [
					{
						name: "boundary",
						line: 1,
						length: 4,
						cyclomatic: 15,
						cognitive: 1,
						nestingDepth: 1,
					},
				],
			},
		]);
		expect(report).toContain(
			"- **Function:** `boundary` at `clients/boundary.ts:1` (cyclomatic 15)",
		);
	});

	it("rejects a report with zero analyzed files", () => {
		expect(() => requireAnalyzedFiles([])).toThrow(
			"complexity analysis produced zero analyzed files",
		);
	});
});
