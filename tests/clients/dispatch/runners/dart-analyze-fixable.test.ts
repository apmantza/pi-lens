import { describe, expect, it } from "vitest";
import {
	DART_FIXABLE_RULES,
	parseDartMachineOutput,
} from "../../../../clients/dispatch/runners/dart-analyze.js";

// dart analyze --format=machine line:
//   severity|type|code|file|line|col|length|message
function dartLine(opts: {
	severity: "WARNING" | "ERROR" | "INFO";
	code: string;
	file: string;
	line: number;
	col: number;
	message: string;
}): string {
	return [
		opts.severity,
		"LINT",
		opts.code,
		opts.file,
		String(opts.line),
		String(opts.col),
		"1",
		opts.message,
	].join("|");
}

describe("parseDartMachineOutput — fixable propagation (#112 slice)", () => {
	it("marks dart-fix-supported lints as fixable with a dart fix --apply hint", () => {
		const raw = [
			dartLine({
				severity: "WARNING",
				code: "prefer_const_constructors",
				file: "lib/main.dart",
				line: 12,
				col: 5,
				message: "Prefer const with constant constructors.",
			}),
			dartLine({
				severity: "WARNING",
				code: "prefer_single_quotes",
				file: "lib/main.dart",
				line: 8,
				col: 1,
				message: "Prefer single quotes where they won't require escape sequences.",
			}),
			dartLine({
				severity: "WARNING",
				code: "unnecessary_const",
				file: "lib/main.dart",
				line: 20,
				col: 3,
				message: "Unnecessary const keyword.",
			}),
		].join("\n");

		const diags = parseDartMachineOutput(raw, "lib/main.dart");
		expect(diags).toHaveLength(3);
		for (const d of diags) {
			expect(d.tool).toBe("dart");
			expect(d.fixable).toBe(true);
			expect(d.fixSuggestion).toMatch(/dart fix --apply/);
			expect(d.defectClass).toBe("style");
		}
	});

	it("does not mark non-allowlisted rules as fixable", () => {
		const raw = [
			dartLine({
				severity: "WARNING",
				code: "always_use_package_imports",
				file: "lib/main.dart",
				line: 1,
				col: 1,
				message: "Use package imports.",
			}),
			dartLine({
				severity: "WARNING",
				code: "avoid_dynamic_calls",
				file: "lib/main.dart",
				line: 30,
				col: 1,
				message: "Method invocation on a dynamic value.",
			}),
		].join("\n");

		const diags = parseDartMachineOutput(raw, "lib/main.dart");
		expect(diags).toHaveLength(2);
		for (const d of diags) {
			expect(d.fixable).toBe(false);
			expect(d.fixSuggestion).toBeUndefined();
		}
	});

	it("preserves blocking semantic for error severity while still flagging fixable", () => {
		const raw = dartLine({
			severity: "ERROR",
			code: "prefer_const_constructors",
			file: "lib/main.dart",
			line: 5,
			col: 5,
			message: "Promoted to error by analysis_options.",
		});
		const diags = parseDartMachineOutput(raw, "lib/main.dart");
		expect(diags).toHaveLength(1);
		expect(diags[0].severity).toBe("error");
		expect(diags[0].semantic).toBe("blocking");
		expect(diags[0].fixable).toBe(true);
	});

	it("filters out diagnostics pointing at other files", () => {
		const raw = [
			dartLine({
				severity: "WARNING",
				code: "prefer_const_constructors",
				file: "lib/other.dart",
				line: 1,
				col: 1,
				message: "wrong file",
			}),
			dartLine({
				severity: "WARNING",
				code: "prefer_const_constructors",
				file: "lib/main.dart",
				line: 2,
				col: 1,
				message: "right file",
			}),
		].join("\n");

		const diags = parseDartMachineOutput(raw, "lib/main.dart");
		expect(diags).toHaveLength(1);
		expect(diags[0].message).toContain("right file");
	});

	it("handles empty input gracefully", () => {
		expect(parseDartMachineOutput("", "lib/main.dart")).toEqual([]);
		expect(parseDartMachineOutput("\n\n", "lib/main.dart")).toEqual([]);
	});

	it("the allowlist covers core dart-fix lints and skips judgment-call rules", () => {
		expect(DART_FIXABLE_RULES.has("prefer_const_constructors")).toBe(true);
		expect(DART_FIXABLE_RULES.has("prefer_single_quotes")).toBe(true);
		expect(DART_FIXABLE_RULES.has("use_super_parameters")).toBe(true);
		expect(DART_FIXABLE_RULES.has("unnecessary_parenthesis")).toBe(true);
		expect(DART_FIXABLE_RULES.has("avoid_dynamic_calls")).toBe(false);
		expect(DART_FIXABLE_RULES.has("always_use_package_imports")).toBe(false);
		expect(DART_FIXABLE_RULES.has("cyclomatic_complexity")).toBe(false);
	});
});
