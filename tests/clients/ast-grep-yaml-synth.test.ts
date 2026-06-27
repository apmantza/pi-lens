import { describe, expect, it } from "vitest";
import {
	hasStructuralIntent,
	synthesizeRule,
	synthesizeReplaceRule,
} from "../../clients/ast-grep-yaml-synth.js";

describe("hasStructuralIntent", () => {
	it("returns false when no structural params", () => {
		expect(hasStructuralIntent({})).toBe(false);
	});

	it("returns true for insideKind", () => {
		expect(hasStructuralIntent({ insideKind: "function_declaration" })).toBe(
			true,
		);
	});

	it("returns true for hasKind", () => {
		expect(hasStructuralIntent({ hasKind: "await_expression" })).toBe(true);
	});

	it("returns true for follows", () => {
		expect(hasStructuralIntent({ follows: "return $X" })).toBe(true);
	});

	it("returns true for precedes", () => {
		expect(hasStructuralIntent({ precedes: "throw $E" })).toBe(true);
	});
});

describe("synthesizeRule", () => {
	it("throws on empty pattern", () => {
		expect(() => synthesizeRule({ pattern: "", lang: "typescript" })).toThrow();
		expect(() =>
			synthesizeRule({ pattern: "   ", lang: "typescript" }),
		).toThrow();
	});

	it("emits id, language, and rule.pattern", () => {
		const yaml = synthesizeRule({ pattern: "foo($X)", lang: "typescript" });
		expect(yaml).toContain("id: agent-rule");
		expect(yaml).toContain("language: TypeScript");
		expect(yaml).toContain("pattern:");
		expect(yaml).toContain("foo($X)");
	});

	it("canonicalises language to ast-grep capitalisation", () => {
		expect(synthesizeRule({ pattern: "x", lang: "python" })).toContain(
			"language: Python",
		);
		expect(synthesizeRule({ pattern: "x", lang: "JavaScript" })).toContain(
			"language: JavaScript",
		);
		expect(synthesizeRule({ pattern: "x", lang: "TYPESCRIPT" })).toContain(
			"language: TypeScript",
		);
	});

	it("adds inside with stopBy:end for insideKind", () => {
		const yaml = synthesizeRule({
			pattern: "foo($X)",
			lang: "typescript",
			insideKind: "function_declaration",
		});
		expect(yaml).toContain("inside:");
		expect(yaml).toContain("kind: function_declaration");
		expect(yaml).toContain("stopBy: end");
	});

	it("adds has without stopBy for hasKind", () => {
		const yaml = synthesizeRule({
			pattern: "foo($X)",
			lang: "typescript",
			hasKind: "await_expression",
		});
		expect(yaml).toContain("has:");
		expect(yaml).toContain("kind: await_expression");
		expect(yaml).not.toContain("stopBy");
	});

	it("rejects unsafe node-kind structural parameters", () => {
		expect(() =>
			synthesizeRule({
				pattern: "foo($X)",
				lang: "typescript",
				insideKind: "function_declaration\nutils:",
			}),
		).toThrow(/insideKind/);
		expect(() =>
			synthesizeRule({
				pattern: "foo($X)",
				lang: "typescript",
				hasKind: "../secret",
			}),
		).toThrow(/hasKind/);
		expect(() =>
			synthesizeRule({
				pattern: "foo($X)",
				lang: "typescript",
				hasKind: "   ",
			}),
		).toThrow(/hasKind/);
	});

	it("accepts node kinds at the max length boundary", () => {
		const kind = `a${"b".repeat(79)}`;
		const yaml = synthesizeRule({
			pattern: "foo($X)",
			lang: "typescript",
			hasKind: kind,
		});
		expect(yaml).toContain(`kind: ${kind}`);
	});

	it("rejects overlong node kinds", () => {
		expect(() =>
			synthesizeRule({
				pattern: "foo($X)",
				lang: "typescript",
				hasKind: `a${"b".repeat(80)}`,
			}),
		).toThrow(/hasKind/);
	});

	it("rejects NUL bytes, empty structural patterns, and overlong synthesized patterns", () => {
		expect(() =>
			synthesizeRule({
				pattern: "foo($X)",
				lang: "typescript",
				follows: "return $X\0",
			}),
		).toThrow(/NUL/);
		expect(() =>
			synthesizeRule({
				pattern: "foo($X)",
				lang: "typescript",
				follows: "   ",
			}),
		).toThrow(/follows/);
		expect(() =>
			synthesizeRule({
				pattern: "foo($X)",
				lang: "typescript",
				precedes: "   ",
			}),
		).toThrow(/precedes/);
		expect(() =>
			synthesizeRule({
				pattern: "x".repeat(4_001),
				lang: "typescript",
			}),
		).toThrow(/too long/);
	});

	it("adds follows with pattern", () => {
		const yaml = synthesizeRule({
			pattern: "bar($X)",
			lang: "typescript",
			follows: "return $Y",
		});
		expect(yaml).toContain("follows:");
		expect(yaml).toContain("return $Y");
	});

	it("adds precedes with pattern", () => {
		const yaml = synthesizeRule({
			pattern: "foo()",
			lang: "typescript",
			precedes: "throw $E",
		});
		expect(yaml).toContain("precedes:");
		expect(yaml).toContain("throw $E");
	});

	it("combines multiple constraints on one rule", () => {
		const yaml = synthesizeRule({
			pattern: "console.log($MSG)",
			lang: "typescript",
			insideKind: "function_declaration",
			hasKind: "identifier",
		});
		expect(yaml).toContain("inside:");
		expect(yaml).toContain("has:");
	});

	it("does not add constraint keys that are absent", () => {
		const yaml = synthesizeRule({ pattern: "x", lang: "go" });
		expect(yaml).not.toContain("inside:");
		expect(yaml).not.toContain("has:");
		expect(yaml).not.toContain("follows:");
		expect(yaml).not.toContain("precedes:");
	});
});

describe("synthesizeReplaceRule", () => {
	it("includes fix field with the rewrite value", () => {
		const yaml = synthesizeReplaceRule({
			pattern: "var $X",
			lang: "javascript",
			rewrite: "let $X",
		});
		expect(yaml).toContain("fix:");
		expect(yaml).toContain("let $X");
	});

	it("includes structural constraints alongside fix", () => {
		const yaml = synthesizeReplaceRule({
			pattern: "var $X",
			lang: "javascript",
			rewrite: "let $X",
			insideKind: "function_declaration",
		});
		expect(yaml).toContain("inside:");
		expect(yaml).toContain("fix:");
	});
});
