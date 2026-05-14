/**
 * Regression test for apmantza/pi-lens#78.
 *
 * The original report describes a false positive where pi-lens classifies a
 * module-scope regex literal as unused, even though the symbol is referenced
 * later in the same file through property-access expressions on the regex
 * (matcher invocations and `.lastIndex` resets). This test pins the
 * `isUnusedValueDiagnostic` classifier in dispatcher.ts so a future fix that
 * filters property-access usage out of unused-symbol findings can be added
 * with a concrete before/after pair.
 */

import { describe, expect, it } from "vitest";
import { isUnusedValueDiagnostic } from "../../../clients/dispatch/dispatcher.js";
import type { Diagnostic } from "../../../clients/dispatch/types.js";

const baseDiagnostic: Diagnostic = {
	id: "regression-fixture",
	message: "",
	filePath: "/tmp/sample.ts",
	line: 1,
	column: 1,
	severity: "warning",
	semantic: "warning",
	tool: "regression-fixture",
};

describe("inline-skill-token regression (#78)", () => {
	it("flags TS6133 `is declared but its value is never read`", () => {
		const d: Diagnostic = {
			...baseDiagnostic,
			id: "ts(6133)",
			rule: "TS6133",
			message: "'SAME_LINE_SKILL_TOKEN' is declared but its value is never read.",
		};
		expect(isUnusedValueDiagnostic(d)).toBe(true);
	});

	it("flags noUnusedLocals findings from biome/eslint", () => {
		const d: Diagnostic = {
			...baseDiagnostic,
			id: "biome:no-unused-variables",
			rule: "noUnusedVariables",
			message: "This variable is unused.",
		};
		expect(isUnusedValueDiagnostic(d)).toBe(true);
	});

	it("flags TS6196 `declared but never used`", () => {
		const d: Diagnostic = {
			...baseDiagnostic,
			id: "ts(6196)",
			rule: "TS6196",
			message:
				"'SAME_LINE_SKILL_TOKEN' is declared but never used.",
		};
		expect(isUnusedValueDiagnostic(d)).toBe(true);
	});

	it("does not flag rule ids that merely contain 'use' (e.g. unsafe-regex)", () => {
		const d: Diagnostic = {
			...baseDiagnostic,
			id: "typescript-unsafe-regex",
			rule: "unsafe-regex",
			message: "RegExp constructor receives a dynamic pattern.",
		};
		expect(isUnusedValueDiagnostic(d)).toBe(false);
	});

	it("does not flag arbitrary regex-related info diagnostics", () => {
		const d: Diagnostic = {
			...baseDiagnostic,
			id: "ts(0)",
			rule: "regex-tokenizer",
			message:
				"SAME_LINE_SKILL_TOKEN matcher consumed; reset .lastIndex before reuse.",
			severity: "info",
		};
		expect(isUnusedValueDiagnostic(d)).toBe(false);
	});
});
