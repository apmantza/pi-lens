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
