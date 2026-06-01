import { describe, expect, it } from "vitest";
import {
	DETEKT_FIXABLE_RULES,
	parseDetektOutput,
} from "../../../../clients/dispatch/runners/detekt.js";

function detektLine(opts: {
	file: string;
	line: number;
	col: number;
	level: "warning" | "error";
	message: string;
	rule?: string;
}): string {
	const trailer = opts.rule ? ` [${opts.rule}]` : "";
	return `${opts.file}:${opts.line}:${opts.col}: ${opts.level}: ${opts.message}${trailer}`;
}

describe("parseDetektOutput — fixable propagation (#112 slice)", () => {
	it("marks formatting-ruleset findings as fixable with a --auto-correct hint", () => {
		const raw = [
			detektLine({
				file: "src/Main.kt",
				line: 12,
				col: 5,
				level: "warning",
				message: "Unexpected indentation (expected 4, was 8)",
				rule: "Indentation",
			}),
			detektLine({
				file: "src/Main.kt",
				line: 4,
				col: 1,
				level: "warning",
				message: "Imports must be ordered in lexicographic order",
				rule: "ImportOrdering",
			}),
		].join("\n");

		const diags = parseDetektOutput(raw, "src/Main.kt");
		expect(diags).toHaveLength(2);
		for (const d of diags) {
			expect(d.tool).toBe("detekt");
			expect(d.fixable).toBe(true);
			expect(d.fixSuggestion).toMatch(/detekt --auto-correct/);
			expect(d.defectClass).toBe("style");
		}
	});

	it("marks autoCorrect-capable style rules as fixable", () => {
		const raw = detektLine({
			file: "src/Main.kt",
			line: 7,
			col: 3,
			level: "warning",
			message: "Unnecessary `Unit` return type.",
			rule: "OptionalUnit",
		});
		const diags = parseDetektOutput(raw, "src/Main.kt");
		expect(diags).toHaveLength(1);
		expect(diags[0].fixable).toBe(true);
	});

	it("does not mark rules outside the allowlist as fixable", () => {
		const raw = [
			detektLine({
				file: "src/Main.kt",
				line: 3,
				col: 1,
				level: "warning",
				message: "Magic number detected.",
				rule: "MagicNumber",
			}),
			detektLine({
				file: "src/Main.kt",
				line: 9,
				col: 1,
				level: "warning",
				message: "Function is too long.",
				rule: "LongMethod",
			}),
		].join("\n");

		const diags = parseDetektOutput(raw, "src/Main.kt");
		expect(diags).toHaveLength(2);
		for (const d of diags) {
			expect(d.fixable).toBe(false);
			expect(d.fixSuggestion).toBeUndefined();
		}
	});

	it("filters out findings pointing at other files", () => {
		const raw = [
			detektLine({
				file: "src/Other.kt",
				line: 1,
				col: 1,
				level: "warning",
				message: "wrong file",
				rule: "Indentation",
			}),
			detektLine({
				file: "src/Main.kt",
				line: 2,
				col: 1,
				level: "warning",
				message: "right file",
				rule: "Indentation",
			}),
		].join("\n");

		const diags = parseDetektOutput(raw, "src/Main.kt");
		expect(diags).toHaveLength(1);
		expect(diags[0].message).toContain("right file");
	});

	it("treats a finding with no rule bracket as non-fixable", () => {
		const raw = "src/Main.kt:1:1: warning: Unrecognised diagnostic without a rule id";
		const diags = parseDetektOutput(raw, "src/Main.kt");
		expect(diags).toHaveLength(1);
		expect(diags[0].rule).toBe("detekt");
		expect(diags[0].fixable).toBe(false);
		expect(diags[0].fixSuggestion).toBeUndefined();
	});

	it("the allowlist covers the ktlint-formatting ruleset and never overlaps with known non-fix rules", () => {
		expect(DETEKT_FIXABLE_RULES.has("Indentation")).toBe(true);
		expect(DETEKT_FIXABLE_RULES.has("Wrapping")).toBe(true);
		expect(DETEKT_FIXABLE_RULES.has("NoUnusedImports")).toBe(true);
		expect(DETEKT_FIXABLE_RULES.has("MagicNumber")).toBe(false);
		expect(DETEKT_FIXABLE_RULES.has("LongMethod")).toBe(false);
		expect(DETEKT_FIXABLE_RULES.has("ComplexCondition")).toBe(false);
	});
});
