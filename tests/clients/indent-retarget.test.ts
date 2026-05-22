import { describe, expect, it } from "vitest";
import { retargetReplacementIndentation } from "../../clients/indent-retarget.js";

describe("retargetReplacementIndentation", () => {
	// ── basic remapping ────────────────────────────────────────────────────────

	it("remaps spaces to tabs when oldText and newText share the same nesting depth", () => {
		const oldText = "function foo() {\n    return 1;\n}";
		const corrected = "function foo() {\n\treturn 1;\n}";
		const newText = "function foo() {\n    return 2;\n}";
		expect(retargetReplacementIndentation(newText, oldText, corrected)).toBe(
			"function foo() {\n\treturn 2;\n}",
		);
	});

	it("remaps tabs to spaces", () => {
		const oldText = "function foo() {\n\treturn 1;\n}";
		const corrected = "function foo() {\n    return 1;\n}";
		const newText = "function foo() {\n\treturn 2;\n}";
		expect(retargetReplacementIndentation(newText, oldText, corrected)).toBe(
			"function foo() {\n    return 2;\n}",
		);
	});

	// ── deeper nesting not present in oldText ──────────────────────────────────

	it("remaps deeper nesting in newText using n × baseUnit extension", () => {
		// oldText only has 1 level (4 spaces); newText adds a nested block (8 spaces).
		const oldText = "function foo() {\n    const x = 1;\n}";
		const corrected = "function foo() {\n\tconst x = 1;\n}";
		const newText =
			"function foo() {\n    if (x > 0) {\n        return x;\n    }\n}";
		expect(retargetReplacementIndentation(newText, oldText, corrected)).toBe(
			"function foo() {\n\tif (x > 0) {\n\t\treturn x;\n\t}\n}",
		);
	});

	it("remaps three nesting levels when only one was in oldText", () => {
		const oldText = "class A {\n    method() {}\n}";
		const corrected = "class A {\n\tmethod() {}\n}";
		// newText has 3 levels — none deeper than 1 appeared in oldText
		const newText =
			"class A {\n    method() {\n        if (x) {\n            return 1;\n        }\n    }\n}";
		expect(retargetReplacementIndentation(newText, oldText, corrected)).toBe(
			"class A {\n\tmethod() {\n\t\tif (x) {\n\t\t\treturn 1;\n\t\t}\n\t}\n}",
		);
	});

	it("handles all levels already present in oldText via direct map", () => {
		// Both "    " and "        " appear in oldText → direct map hits for both.
		const oldText =
			"function foo() {\n    if (cond) {\n        return 1;\n    }\n}";
		const corrected =
			"function foo() {\n\tif (cond) {\n\t\treturn 1;\n\t}\n}";
		const newText =
			"function foo() {\n    if (cond) {\n        return 2;\n    }\n}";
		expect(retargetReplacementIndentation(newText, oldText, corrected)).toBe(
			"function foo() {\n\tif (cond) {\n\t\treturn 2;\n\t}\n}",
		);
	});

	// ── abort on unresolvable indentation ─────────────────────────────────────

	it("returns undefined when a newText line has indentation that is not a multiple of the base unit", () => {
		// baseFrom = "    " (4 spaces); newText has a 3-space indent — not a multiple.
		const oldText = "function foo() {\n    const x = 1;\n}";
		const corrected = "function foo() {\n\tconst x = 1;\n}";
		const newText =
			"function foo() {\n   if (x) {\n    const x = 2;\n   }\n}";
		expect(
			retargetReplacementIndentation(newText, oldText, corrected),
		).toBeUndefined();
	});

	it("returns undefined and does not partially remap when deeper lines use a different indent style", () => {
		// newText mixes 4-space (remappable) and tab (not in map and not a multiple of 4-space).
		const oldText = "function foo() {\n    const x = 1;\n}";
		const corrected = "function foo() {\n\tconst x = 1;\n}";
		const newText = "function foo() {\n    if (x) {\n\t\treturn x;\n    }\n}";
		expect(
			retargetReplacementIndentation(newText, oldText, corrected),
		).toBeUndefined();
	});

	// ── edge cases ─────────────────────────────────────────────────────────────

	it("returns undefined when oldText and correctedOldText have different line counts", () => {
		expect(
			retargetReplacementIndentation("foo\nbar", "foo", "  foo"),
		).toBeUndefined();
	});

	it("returns undefined when there are no indentation differences between oldText and correctedOldText", () => {
		expect(
			retargetReplacementIndentation(
				"function foo() {\n    return 1;\n}",
				"function foo() {\n    return 1;\n}",
				"function foo() {\n    return 1;\n}",
			),
		).toBeUndefined();
	});

	it("preserves blank and whitespace-only lines", () => {
		const oldText = "function foo() {\n    const x = 1;\n}";
		const corrected = "function foo() {\n\tconst x = 1;\n}";
		const newText = "function foo() {\n    const x = 1;\n\n    return x;\n}";
		expect(retargetReplacementIndentation(newText, oldText, corrected)).toBe(
			"function foo() {\n\tconst x = 1;\n\n\treturn x;\n}",
		);
	});

	it("preserves CRLF line endings in the output", () => {
		const oldText = "function foo() {\r\n    return 1;\r\n}";
		const corrected = "function foo() {\r\n\treturn 1;\r\n}";
		const newText = "function foo() {\r\n    return 2;\r\n}";
		expect(retargetReplacementIndentation(newText, oldText, corrected)).toBe(
			"function foo() {\r\n\treturn 2;\r\n}",
		);
	});

	it("returns undefined when no line in newText actually needs changing", () => {
		// newText already uses the corrected indentation — no change should be applied.
		const oldText = "function foo() {\n    return 1;\n}";
		const corrected = "function foo() {\n\treturn 1;\n}";
		const newText = "function foo() {\n\treturn 2;\n}"; // already tabs
		// resolveIndent("\t"): not in map, not a multiple of "    " → abort → undefined
		expect(
			retargetReplacementIndentation(newText, oldText, corrected),
		).toBeUndefined();
	});
});
