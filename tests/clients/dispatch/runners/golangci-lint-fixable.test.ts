import { describe, expect, it } from "vitest";
import { parseGolangciJson } from "../../../../clients/dispatch/runners/golangci-lint.js";

interface IssueOpts {
	linter: string;
	text: string;
	file: string;
	line?: number;
	column?: number;
	severity?: string;
	replacement?:
		| {
				NeedOnlyDelete?: boolean;
				NewLines?: string[];
				Inline?: {
					StartCol?: number;
					Length?: number;
					NewString?: string;
				};
		  }
		| null;
}

function issueJson(...issues: IssueOpts[]): string {
	return JSON.stringify({
		Issues: issues.map((opts) => ({
			FromLinter: opts.linter,
			Text: opts.text,
			Severity: opts.severity,
			Pos: {
				Filename: opts.file,
				Line: opts.line ?? 1,
				Column: opts.column ?? 1,
			},
			Replacement: opts.replacement,
		})),
	});
}

describe("parseGolangciJson — fixable propagation (#112 slice)", () => {
	it("marks an issue with an Inline replacement as fixable and surfaces the new text", () => {
		const raw = issueJson({
			linter: "gofmt",
			text: "File is not `gofmt`-ed",
			file: "main.go",
			line: 5,
			column: 1,
			replacement: {
				Inline: { StartCol: 5, Length: 3, NewString: "fmt.Println" },
			},
		});
		const diags = parseGolangciJson(raw, "main.go");
		expect(diags).toHaveLength(1);
		expect(diags[0]).toMatchObject({
			tool: "golangci-lint",
			rule: "gofmt",
			defectClass: "correctness",
			fixable: true,
			fixSuggestion: "Replace with: fmt.Println",
		});
	});

	it("marks a NewLines-only replacement as fixable with a previewed summary", () => {
		const raw = issueJson({
			linter: "gofmt",
			text: "File is not `gofmt`-ed",
			file: "main.go",
			line: 10,
			column: 1,
			replacement: {
				NewLines: ["package main", "", "import \"fmt\""],
			},
		});
		const diags = parseGolangciJson(raw, "main.go");
		expect(diags).toHaveLength(1);
		expect(diags[0].fixable).toBe(true);
		expect(diags[0].fixSuggestion).toBe(
			"Replace with: package main (+2 more lines)",
		);
	});

	it("marks a delete-only replacement as fixable", () => {
		const raw = issueJson({
			linter: "unused",
			text: "unused variable",
			file: "main.go",
			line: 8,
			column: 5,
			replacement: { NeedOnlyDelete: true },
		});
		const diags = parseGolangciJson(raw, "main.go");
		expect(diags).toHaveLength(1);
		expect(diags[0].fixable).toBe(true);
		expect(diags[0].fixSuggestion).toBe("Delete this code");
	});

	it("does not mark an issue without a Replacement field as fixable", () => {
		const raw = issueJson({
			linter: "errcheck",
			text: "Error return value is not checked",
			file: "main.go",
			line: 12,
			column: 3,
		});
		const diags = parseGolangciJson(raw, "main.go");
		expect(diags).toHaveLength(1);
		expect(diags[0].fixable).toBe(false);
		expect(diags[0].fixSuggestion).toBeUndefined();
	});

	it("treats Replacement: null as non-fixable", () => {
		const raw = issueJson({
			linter: "errcheck",
			text: "Error return value is not checked",
			file: "main.go",
			replacement: null,
		});
		const diags = parseGolangciJson(raw, "main.go");
		expect(diags[0].fixable).toBe(false);
		expect(diags[0].fixSuggestion).toBeUndefined();
	});

	it("filters out issues that point at a different file (golangci-lint may emit project-wide)", () => {
		const raw = issueJson(
			{
				linter: "gofmt",
				text: "format me",
				file: "other.go",
				replacement: { NeedOnlyDelete: true },
			},
			{
				linter: "errcheck",
				text: "check me",
				file: "main.go",
			},
		);
		const diags = parseGolangciJson(raw, "main.go");
		expect(diags).toHaveLength(1);
		expect(diags[0].rule).toBe("errcheck");
	});

	it("handles empty / malformed output gracefully", () => {
		expect(parseGolangciJson("", "main.go")).toEqual([]);
		expect(parseGolangciJson("not json", "main.go")).toEqual([]);
		expect(parseGolangciJson(JSON.stringify({ Issues: null }), "main.go")).toEqual(
			[],
		);
	});
});
