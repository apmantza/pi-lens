import { describe, expect, it } from "vitest";
import {
	type AutofixPolicyContext,
	getAutofixCapability,
	getAutofixPolicyForFile,
	getLinterPolicyForFile,
	listSafePipelineAutofixTools,
} from "../../clients/tool-policy.js";

// Guards the consistency the safe-autofix pipeline depends on (refs #209):
//   1. every tool the autofix policy can select is declared safePipelineAutofix
//      capable (and vice-versa — no orphan capability, no phantom tool);
//   2. the autofix gate for a language matches that language's LINT policy gate
//      (a config-first linter must not become a smart-default autofixer, etc.).
// Without this, the three hand-coded policy maps (lint / autofix / capabilities)
// drift silently.

// Representative file + context per language, with the config flags that select
// each config-gated tool. Keep in sync with getAutofixPolicyForFile branches.
const CASES: Array<{
	label: string;
	file: string;
	ctx: AutofixPolicyContext;
	expect: string;
}> = [
	{ label: "js+eslint", file: "a.ts", ctx: { hasEslintConfig: true }, expect: "eslint" },
	{ label: "js+oxlint", file: "a.ts", ctx: { hasOxlintConfig: true }, expect: "oxlint" },
	{ label: "js default", file: "a.ts", ctx: {}, expect: "biome" },
	{ label: "python", file: "a.py", ctx: {}, expect: "ruff" },
	{ label: "css", file: "a.css", ctx: {}, expect: "stylelint" },
	{ label: "sql", file: "a.sql", ctx: {}, expect: "sqlfluff" },
	{ label: "ruby", file: "a.rb", ctx: {}, expect: "rubocop" },
	{ label: "kotlin default", file: "a.kt", ctx: {}, expect: "ktlint" },
	{ label: "kotlin+detekt", file: "a.kt", ctx: { hasDetektConfig: true }, expect: "detekt" },
	{ label: "rust", file: "a.rs", ctx: {}, expect: "rust-clippy" },
	{ label: "dart", file: "a.dart", ctx: {}, expect: "dart-analyze" },
	{ label: "go", file: "a.go", ctx: { hasGolangciConfig: true }, expect: "golangci-lint" },
	{ label: "markdown", file: "a.md", ctx: {}, expect: "markdownlint" },
];

describe("autofix policy ↔ capabilities ↔ lint policy consistency", () => {
	it("selects the expected tool for each language/context", () => {
		for (const c of CASES) {
			const policy = getAutofixPolicyForFile(c.file, c.ctx);
			expect(policy, c.label).toBeDefined();
			expect(policy?.preferredTools, c.label).toContain(c.expect);
		}
	});

	it("every selectable autofix tool is declared safePipelineAutofix capable", () => {
		for (const c of CASES) {
			for (const tool of getAutofixPolicyForFile(c.file, c.ctx)?.preferredTools ?? []) {
				expect(getAutofixCapability(tool)?.safePipelineAutofix, `${c.label}:${tool}`).toBe(true);
			}
		}
	});

	it("every safePipelineAutofix-capable tool is reachable from the policy", () => {
		const reachable = new Set<string>();
		for (const c of CASES) {
			for (const tool of getAutofixPolicyForFile(c.file, c.ctx)?.preferredTools ?? []) {
				reachable.add(tool);
			}
		}
		for (const tool of listSafePipelineAutofixTools()) {
			expect(reachable.has(tool), `capability '${tool}' not wired into any autofix policy`).toBe(true);
		}
	});

	it("autofix gate matches the lint policy gate per language", () => {
		// config-first and smart-default must not cross; "mixed" lint gate is
		// compatible with either (it offers both a default and a config-gated tool).
		for (const c of CASES) {
			const autofix = getAutofixPolicyForFile(c.file, c.ctx);
			const lint = getLinterPolicyForFile(c.file, c.ctx);
			if (!autofix || !lint) continue; // some langs (rs/dart) have no lint policy
			if (lint.gate === "mixed") continue;
			expect(autofix.gate, `${c.label}: autofix ${autofix.gate} vs lint ${lint.gate}`).toBe(
				lint.gate,
			);
		}
	});
});
