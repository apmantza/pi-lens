import { describe, expect, it } from "vitest";
import { parseSimpleYaml } from "../../../../clients/dispatch/runners/yaml-rule-parser.js";

describe("yaml-rule-parser fix metadata", () => {
	it("parses note and fix fields (including multiline) from ast-grep YAML", () => {
		const yaml = [
			"id: no-global-eval-js",
			"language: JavaScript",
			"severity: error",
			'message: "Avoid eval"',
			"note: |",
			"  Dynamic code execution is dangerous.",
			"  Prefer explicit parsers.",
			'fix: "Replace eval with safe APIs"',
			"rule:",
			"  pattern: eval($CODE)",
		].join("\n");

		const rule = parseSimpleYaml(yaml);
		expect(rule).not.toBeNull();
		expect(rule?.note).toContain("Dynamic code execution is dangerous.");
		expect(rule?.note).toContain("Prefer explicit parsers.");
		expect(rule?.fix).toBe("Replace eval with safe APIs");
	});
});

// #206: the parser is now js-yaml, so the full ast-grep rule grammar survives
// intact and feeds napi directly. The old hand-rolled parser flattened nested
// any/has and dropped constraints — these guard against regressing to that.
describe("yaml-rule-parser faithful structure (#206)", () => {
	it("preserves nested any-of-{kind,has} without flattening", () => {
		const rule = parseSimpleYaml(
			[
				"id: nested",
				"language: TypeScript",
				"rule:",
				"  any:",
				"    - kind: if_statement",
				"      has:",
				"        field: condition",
				"        kind: 'true'",
				"    - kind: ternary_expression",
				"rule_tail: ignore",
			].join("\n"),
		);
		expect(rule?.rule?.any).toHaveLength(2);
		// nesting intact: first alternative keeps its own has (not hoisted/flattened)
		expect(rule?.rule?.any?.[0].kind).toBe("if_statement");
		expect(rule?.rule?.any?.[0].has?.field).toBe("condition");
		expect(rule?.rule?.any?.[0].has?.kind).toBe("true"); // quoted scalar, not boolean
		expect(rule?.rule?.any?.[1].kind).toBe("ternary_expression");
	});

	it("keeps the metavariable key in constraints", () => {
		const rule = parseSimpleYaml(
			[
				"id: secret",
				"language: TypeScript",
				"rule:",
				"  pattern: process.env.$KEY",
				"constraints:",
				"  KEY:",
				'    regex: "SECRET|TOKEN"',
			].join("\n"),
		);
		expect(rule?.constraints?.KEY?.regex).toBe("SECRET|TOKEN");
	});

	it("returns null (not throw) on a malformed document", () => {
		expect(parseSimpleYaml("id: bad\nmessage: !!value oops\n")).toBeNull();
	});
});
