import { describe, expect, it } from "vitest";
import { applyInlineSuppressions } from "../../../clients/dispatch/inline-suppressions.js";
import { insertSuppressComment } from "../../../clients/dispatch/suppress-writer.js";

describe("insertSuppressComment (#690)", () => {
	it("writes a `// pi-lens-ignore: rule` comment above the line for a .ts file", () => {
		const content = "const a = 1;\nconst target = bad();\n";
		const updated = insertSuppressComment(content, "/proj/a.ts", 2, "no-bad");
		expect(updated.split("\n")).toEqual([
			"const a = 1;",
			"// pi-lens-ignore: no-bad",
			"const target = bad();",
			"",
		]);
	});

	it("writes a `# pi-lens-ignore: rule` comment above the line for a .py file", () => {
		const content = "a = 1\ntarget = bad()\n";
		const updated = insertSuppressComment(content, "/proj/a.py", 2, "no-bad");
		expect(updated.split("\n")).toEqual([
			"a = 1",
			"# pi-lens-ignore: no-bad",
			"target = bad()",
			"",
		]);
	});

	it("matches the flagged line's indentation", () => {
		const content = "function f() {\n    const target = bad();\n}\n";
		const updated = insertSuppressComment(content, "/proj/a.ts", 2, "no-bad");
		expect(updated.split("\n")[1]).toBe("    // pi-lens-ignore: no-bad");
	});

	it("appends to an existing pi-lens-ignore comment on the line above instead of duplicating", () => {
		const content = "// pi-lens-ignore: other-rule\nconst target = bad();\n";
		const updated = insertSuppressComment(content, "/proj/a.ts", 2, "no-bad");
		const lines = updated.split("\n");
		expect(lines[0]).toBe("// pi-lens-ignore: other-rule, no-bad");
		expect(lines).toHaveLength(3); // no new comment LINE was added
	});

	it("does not double-add a rule already listed on the line above", () => {
		const content = "// pi-lens-ignore: no-bad\nconst target = bad();\n";
		const updated = insertSuppressComment(content, "/proj/a.ts", 2, "no-bad");
		expect(updated.split("\n")[0]).toBe("// pi-lens-ignore: no-bad");
	});

	it("recognizes a rule before its trailing reason when appending", () => {
		const content =
			"// pi-lens-ignore: no-bad -- controlled fixture\nconst target = bad();\n";
		const updated = insertSuppressComment(content, "/proj/a.ts", 2, "no-bad");
		expect(updated.split("\n")[0]).toBe(
			"// pi-lens-ignore: no-bad -- controlled fixture",
		);
	});

	it("appends a new rule before a trailing reason on a multi-rule comment", () => {
		// Regression: appending after the raw suffix stranded the reason between
		// rule ids, so the updated comment no longer round-tripped.
		const content =
			"// pi-lens-ignore: no-a, no-b -- controlled fixture\nconst target = bad();\n";
		const updated = insertSuppressComment(content, "/proj/a.ts", 2, "no-c");
		expect(updated.split("\n")[0]).toBe(
			"// pi-lens-ignore: no-a, no-b, no-c -- controlled fixture",
		);
	});

	it("round-trips with applyInlineSuppressions: the shifted (line+1) diagnostic is dropped", () => {
		const content = "const a = 1;\nconst target = bad();\n";
		const updated = insertSuppressComment(content, "/proj/a.ts", 2, "no-bad");
		// The flagged line moved from 2 -> 3 because a comment line was spliced in
		// immediately above it.
		const diags = [{ line: 3, rule: "no-bad" }];
		expect(applyInlineSuppressions(diags, updated)).toEqual([]);
	});

	it("keeps CRLF line endings; the new line takes the flagged line's ending (#5686)", () => {
		const updated = insertSuppressComment(
			"a\r\nb\r\nc\r\n",
			"/proj/a.ts",
			2,
			"no-bad",
		);
		expect(updated).toBe("a\r\n// pi-lens-ignore: no-bad\r\nb\r\nc\r\n");
	});

	it("keeps mixed endings; the new line takes the flagged line's ending (#5686)", () => {
		const updated = insertSuppressComment(
			"a\nb\r\nc\r\n",
			"/proj/a.ts",
			3,
			"no-bad",
		);
		expect(updated).toBe("a\nb\r\n// pi-lens-ignore: no-bad\r\nc\r\n");
	});

	it("appends to an existing CRLF comment above without rewriting endings (#5686)", () => {
		const updated = insertSuppressComment(
			"// pi-lens-ignore: other\r\nconst target = bad();\r\n",
			"/proj/a.ts",
			2,
			"no-bad",
		);
		expect(updated).toBe(
			"// pi-lens-ignore: other, no-bad\r\nconst target = bad();\r\n",
		);
	});

	it("keeps an unterminated last line unterminated when inserting above it (#5686)", () => {
		const updated = insertSuppressComment("a\r\nb", "/proj/a.ts", 2, "no-bad");
		expect(updated).toBe("a\r\n// pi-lens-ignore: no-bad\r\nb");
	});

	it("throws on an out-of-range line", () => {
		const content = "const a = 1;\n";
		expect(() =>
			insertSuppressComment(content, "/proj/a.ts", 5, "no-bad"),
		).toThrow(/out of range/);
	});
});
