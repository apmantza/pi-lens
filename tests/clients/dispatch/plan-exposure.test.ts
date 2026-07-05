import { describe, expect, it } from "vitest";
import {
	LANGUAGE_CAPABILITY_MATRIX,
	TOOL_PLANS,
} from "../../../clients/dispatch/plan.ts";

function flattenRunnerIds(plan: {
	groups: Array<{ runnerIds: string[] }>;
}): string[] {
	return plan.groups.flatMap((g) => g.runnerIds);
}

describe("dispatch plan exposure", () => {
	it("keeps write-path plan blocker-focused for jsts", () => {
		const ids = flattenRunnerIds(TOOL_PLANS.jsts);

		expect(ids).toContain("lsp");
		expect(ids).toContain("tree-sitter");
		expect(ids).toContain("ast-grep-napi");
		expect(ids).toContain("eslint");
		expect(ids).toContain("oxlint");
		expect(ids).toContain("biome-check-json");
		expect(ids).not.toContain("biome-lint");
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
			expect.arrayContaining(["types", "lint", "smells"]),
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

	it("go write plan has no duplicate runner ids (go-vet lives only in primary group)", () => {
		const ids = flattenRunnerIds(TOOL_PLANS.go);
		const counts = ids.reduce<Record<string, number>>((acc, id) => {
			acc[id] = (acc[id] ?? 0) + 1;
			return acc;
		}, {});
		expect(counts["go-vet"]).toBe(1);
		expect(Object.values(counts).every((n) => n === 1)).toBe(true);
	});

	it("rust write plan has no duplicate runner ids (rust-clippy lives only in primary group)", () => {
		const ids = flattenRunnerIds(TOOL_PLANS.rust);
		const counts = ids.reduce<Record<string, number>>((acc, id) => {
			acc[id] = (acc[id] ?? 0) + 1;
			return acc;
		}, {});
		expect(counts["rust-clippy"]).toBe(1);
		expect(Object.values(counts).every((n) => n === 1)).toBe(true);
	});

	it("maps yaml/sql to dedicated lint runners", () => {
		const yamlIds = flattenRunnerIds(TOOL_PLANS.yaml);
		const sqlIds = flattenRunnerIds(TOOL_PLANS.sql);

		expect(yamlIds).toContain("yamllint");
		expect(sqlIds).toContain("sqlfluff");
	});

	it("routes html/docker/powershell/php/prisma through aligned primary plans", () => {
		expect(flattenRunnerIds(TOOL_PLANS.html)).toEqual(["lsp", "htmlhint"]);
		expect(flattenRunnerIds(TOOL_PLANS.docker)).toEqual([
			"lsp",
			"hadolint",
			"trivy-config",
		]);
		expect(flattenRunnerIds(TOOL_PLANS.powershell)).toEqual([
			"lsp",
			"psscriptanalyzer",
		]);
		expect(flattenRunnerIds(TOOL_PLANS.php)).toEqual([
			"lsp",
			"php-lint",
			"phpstan",
		]);
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

	it("routes cxx and elixir through fallback compiler coverage", () => {
		expect(flattenRunnerIds(TOOL_PLANS.cxx)).toEqual([
			"lsp",
			"cpp-check",
			"tree-sitter",
		]);
		expect(flattenRunnerIds(TOOL_PLANS.elixir)).toEqual([
			"lsp",
			"elixir-check",
			"credo",
		]);
	});
});
