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

	it("round-trips with applyInlineSuppressions: the shifted (line+1) diagnostic is dropped", () => {
		const content = "const a = 1;\nconst target = bad();\n";
		const updated = insertSuppressComment(content, "/proj/a.ts", 2, "no-bad");
		// The flagged line moved from 2 -> 3 because a comment line was spliced in
		// immediately above it.
		const diags = [{ line: 3, rule: "no-bad" }];
		expect(applyInlineSuppressions(diags, updated)).toEqual([]);
	});

	it("throws on an out-of-range line", () => {
		const content = "const a = 1;\n";
		expect(() =>
			insertSuppressComment(content, "/proj/a.ts", 5, "no-bad"),
		).toThrow(/out of range/);
	});
});
