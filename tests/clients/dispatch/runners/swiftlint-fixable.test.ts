import { describe, expect, it } from "vitest";
import {
	SWIFTLINT_FIXABLE_RULES,
	parseSwiftLintOutput,
} from "../../../../clients/dispatch/runners/swiftlint.js";

function violationJson(
	violations: Array<{
		rule_id?: string;
		reason: string;
		line?: number;
		character?: number;
		severity?: string;
	}>,
): string {
	return JSON.stringify(
		violations.map((v) => ({
			rule_id: v.rule_id,
			reason: v.reason,
			line: v.line ?? 1,
			character: v.character ?? 1,
			severity: v.severity ?? "Warning",
			file: "Sources/Main.swift",
			type: v.rule_id,
		})),
	);
}

describe("parseSwiftLintOutput — fixable propagation (#112 slice)", () => {
	it("marks corrector-backed formatting rules as fixable", () => {
		const raw = violationJson([
			{
				rule_id: "trailing_whitespace",
				reason: "Lines should not have trailing whitespace.",
				line: 12,
			},
			{
				rule_id: "colon",
				reason: "Colons should be next to the identifier when specifying a type.",
				line: 8,
			},
			{
				rule_id: "redundant_void_return",
				reason: "Returning Void in a function declaration is redundant.",
				line: 20,
			},
		]);
		const diags = parseSwiftLintOutput(raw, "Sources/Main.swift");
		expect(diags).toHaveLength(3);
		for (const d of diags) {
			expect(d.tool).toBe("swiftlint");
			expect(d.fixable).toBe(true);
			expect(d.fixSuggestion).toMatch(/swiftlint --fix/);
			expect(d.defectClass).toBe("style");
		}
	});

	it("does not mark rules without a corrector as fixable", () => {
		const raw = violationJson([
			{
				rule_id: "identifier_name",
				reason: "Variable name should be between 3 and 40 characters long.",
				line: 3,
			},
			{
				rule_id: "cyclomatic_complexity",
				reason: "Function should have complexity 10 or less.",
				line: 30,
			},
			{
				rule_id: "force_cast",
				reason: "Force casts should be avoided.",
				line: 42,
			},
		]);
		const diags = parseSwiftLintOutput(raw, "Sources/Main.swift");
		expect(diags).toHaveLength(3);
		for (const d of diags) {
			expect(d.fixable).toBe(false);
			expect(d.fixSuggestion).toBeUndefined();
		}
	});

	it("treats error severity correctly while still flagging fixable rules", () => {
		const raw = violationJson([
			{
				rule_id: "trailing_newline",
				reason: "Files should have a single trailing newline.",
				line: 100,
				severity: "Error",
			},
		]);
		const diags = parseSwiftLintOutput(raw, "Sources/Main.swift");
		expect(diags).toHaveLength(1);
		expect(diags[0].severity).toBe("error");
		expect(diags[0].semantic).toBe("blocking");
		// allowlist still flips fixable, regardless of severity
		expect(diags[0].fixable).toBe(true);
	});

	it("handles empty and malformed JSON gracefully", () => {
		expect(parseSwiftLintOutput("", "Sources/Main.swift")).toEqual([]);
		expect(parseSwiftLintOutput("not json", "Sources/Main.swift")).toEqual([]);
		expect(parseSwiftLintOutput("[]", "Sources/Main.swift")).toEqual([]);
		expect(parseSwiftLintOutput("{}", "Sources/Main.swift")).toEqual([]);
	});

	it("falls back to rule_id 'swiftlint' when missing — and that fallback is not fixable", () => {
		const raw = JSON.stringify([
			{
				reason: "Some violation without a rule_id field.",
				line: 1,
				character: 1,
				severity: "Warning",
				file: "Sources/Main.swift",
			},
		]);
		const diags = parseSwiftLintOutput(raw, "Sources/Main.swift");
		expect(diags).toHaveLength(1);
		expect(diags[0].rule).toBe("swiftlint");
		expect(diags[0].fixable).toBe(false);
	});

	it("the allowlist covers corrector-backed rules and never includes opinion-based rules", () => {
		expect(SWIFTLINT_FIXABLE_RULES.has("trailing_whitespace")).toBe(true);
		expect(SWIFTLINT_FIXABLE_RULES.has("sorted_imports")).toBe(true);
		expect(SWIFTLINT_FIXABLE_RULES.has("redundant_void_return")).toBe(true);
		expect(SWIFTLINT_FIXABLE_RULES.has("identifier_name")).toBe(false);
		expect(SWIFTLINT_FIXABLE_RULES.has("force_cast")).toBe(false);
		expect(SWIFTLINT_FIXABLE_RULES.has("cyclomatic_complexity")).toBe(false);
	});
});
