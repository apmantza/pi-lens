import { describe, expect, it } from "vitest";
import {
	FULL_LINT_PLANS,
	LANGUAGE_CAPABILITY_MATRIX,
	TOOL_PLANS,
} from "../../../clients/dispatch/plan.js";

function flattenRunnerIds(plan: { groups: Array<{ runnerIds: string[] }> }): string[] {
	return plan.groups.flatMap((g) => g.runnerIds);
}

describe("dispatch plan exposure", () => {
	it("keeps write-path plan blocker-focused for jsts", () => {
		const ids = flattenRunnerIds(TOOL_PLANS.jsts);

		expect(ids).toContain("lsp");
		expect(ids).toContain("tree-sitter");
		expect(ids).toContain("ast-grep-napi");
		expect(ids).not.toContain("biome-lint");
		expect(ids).not.toContain("oxlint");
	});

	it("exposes warning-heavy linters in full plan for jsts/python", () => {
		const jstsIds = flattenRunnerIds(FULL_LINT_PLANS.jsts);
		const pythonIds = flattenRunnerIds(FULL_LINT_PLANS.python);

		expect(jstsIds).toContain("biome-lint");
		expect(jstsIds).toContain("oxlint");
		expect(pythonIds).toContain("ruff-lint");
		expect(pythonIds).toContain("python-slop");
	});

	it("ensures python and ruby write-path plans include lsp+lint coverage", () => {
		const pythonIds = flattenRunnerIds(TOOL_PLANS.python);
		const rubyIds = flattenRunnerIds(TOOL_PLANS.ruby);

		expect(pythonIds).toContain("lsp");
		expect(pythonIds).toContain("ruff-lint");
		expect(rubyIds).toContain("lsp");
		expect(rubyIds).toContain("rubocop");
	});

	it("defines a capability matrix for supported main languages", () => {
		expect(LANGUAGE_CAPABILITY_MATRIX.jsts.capabilities).toEqual(
			expect.arrayContaining(["types", "security", "smells", "lint"]),
		);
		expect(LANGUAGE_CAPABILITY_MATRIX.python.capabilities).toEqual(
			expect.arrayContaining(["types", "lint", "architecture"]),
		);
		expect(LANGUAGE_CAPABILITY_MATRIX.go.capabilities).toEqual(
			expect.arrayContaining(["types", "lint"]),
		);
		expect(LANGUAGE_CAPABILITY_MATRIX.rust.capabilities).toEqual(
			expect.arrayContaining(["types", "lint"]),
		);
		expect(LANGUAGE_CAPABILITY_MATRIX.ruby.capabilities).toEqual(
			expect.arrayContaining(["types", "lint"]),
		);
	});

	it("maps yaml/sql to dedicated lint runners", () => {
		const yamlIds = flattenRunnerIds(TOOL_PLANS.yaml);
		const sqlIds = flattenRunnerIds(TOOL_PLANS.sql);

		expect(yamlIds).toContain("yamllint");
		expect(sqlIds).toContain("sqlfluff");
	});

	it("routes html/docker/powershell/php/prisma through aligned primary plans", () => {
		expect(flattenRunnerIds(TOOL_PLANS.html)).toEqual(["lsp", "htmlhint", "prettier-check"]);
		expect(flattenRunnerIds(TOOL_PLANS.docker)).toEqual(["lsp", "hadolint"]);
		expect(flattenRunnerIds(TOOL_PLANS.powershell)).toEqual([
			"lsp",
			"psscriptanalyzer",
		]);
		expect(flattenRunnerIds(TOOL_PLANS.php)).toEqual(["lsp", "php-lint", "phpstan"]);
		expect(flattenRunnerIds(TOOL_PLANS.prisma)).toEqual([
			"lsp",
			"prisma-validate",
		]);
	});

	it("marks JSON as lint-capable when its write path includes diagnostics", () => {
		expect(LANGUAGE_CAPABILITY_MATRIX.json.capabilities).toEqual(
			expect.arrayContaining(["format", "lint"]),
		);
	});

	it("promotes additional LSP-backed languages into the capability matrix", () => {
		expect(LANGUAGE_CAPABILITY_MATRIX.java.capabilities).toEqual(
			expect.arrayContaining(["types", "lint"]),
		);
		expect(LANGUAGE_CAPABILITY_MATRIX.kotlin.capabilities).toEqual(
			expect.arrayContaining(["types", "lint"]),
		);
		expect(LANGUAGE_CAPABILITY_MATRIX.elixir.capabilities).toEqual(
			expect.arrayContaining(["types", "lint"]),
		);
		expect(LANGUAGE_CAPABILITY_MATRIX.swift.capabilities).toEqual(
			expect.arrayContaining(["types", "lint"]),
		);
		expect(LANGUAGE_CAPABILITY_MATRIX.zig.capabilities).toEqual(
			expect.arrayContaining(["types", "lint"]),
		);
	});

	it("routes java and csharp through fallback compiler coverage", () => {
		expect(flattenRunnerIds(TOOL_PLANS.java)).toEqual(["lsp", "javac"]);
		expect(flattenRunnerIds(TOOL_PLANS.csharp)).toEqual([
			"lsp",
			"dotnet-build",
		]);
	});
});
