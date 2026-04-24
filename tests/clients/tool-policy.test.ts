import { describe, expect, it } from "vitest";
import {
	getAutoInstallToolIdForFormatter,
	getFormatterPolicyForFile,
	getJstsLintPolicy,
	getPreferredAutofixTools,
	getPreferredJstsLintRunners,
	getRubocopCommand,
	getSmartDefaultFormatterName,
	getToolCommandSpec,
	getToolExecutionPolicy,
	hasRubocopConfig,
	hasSqlfluffConfig,
	hasStylelintConfig,
	shouldAutoInstallTool,
} from "../../clients/tool-policy.ts";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

describe("tool-policy", () => {
	it("defines smart default formatters for unconfigured JS/TS and Python files", () => {
		expect(getSmartDefaultFormatterName("/tmp/file.ts")).toBe("biome");
		expect(getSmartDefaultFormatterName("/tmp/file.py")).toBe("ruff");
	});

	it("does not force a no-config default for config-first formats", () => {
		expect(getSmartDefaultFormatterName("/tmp/file.json")).toBeUndefined();
		expect(getSmartDefaultFormatterName("/tmp/file.sql")).toBeUndefined();
	});

	it("maps smart-default formatters to auto-installable tool ids", () => {
		expect(getAutoInstallToolIdForFormatter("biome")).toBe("biome");
		expect(getAutoInstallToolIdForFormatter("ruff")).toBe("ruff");
		expect(getAutoInstallToolIdForFormatter("prettier")).toBeUndefined();
	});

	it("returns formatter policy metadata by file path", () => {
		expect(getFormatterPolicyForFile("/tmp/file.ts")).toMatchObject({
			defaultFormatter: "biome",
			defaultWhenUnconfigured: true,
		});
		expect(getFormatterPolicyForFile("/tmp/file.py")).toMatchObject({
			defaultFormatter: "ruff",
			defaultWhenUnconfigured: true,
		});
	});

	it("chooses autofix tools from config-aware smart defaults", () => {
		expect(
			getPreferredAutofixTools("/tmp/file.ts", { hasEslintConfig: true }),
		).toEqual(["eslint"]);
		expect(
			getPreferredAutofixTools("/tmp/file.ts", { hasEslintConfig: false }),
		).toEqual(["biome"]);
		expect(getPreferredAutofixTools("/tmp/file.py", {})).toEqual(["ruff"]);
		expect(getPreferredAutofixTools("/tmp/file.sql", {})).toEqual(["sqlfluff"]);
	});

	it("chooses JS/TS dispatch linter runners from config-aware smart defaults", () => {
		expect(getPreferredJstsLintRunners({ hasEslintConfig: true })).toEqual([
			"eslint",
		]);
		expect(getPreferredJstsLintRunners({ hasOxlintConfig: true })).toEqual([
			"oxlint",
		]);
		expect(getPreferredJstsLintRunners({ hasBiomeConfig: true })).toEqual([
			"biome-check-json",
		]);
		expect(getPreferredJstsLintRunners({})).toEqual([
			"oxlint",
			"biome-check-json",
		]);
	});

	it("exposes normalized JS/TS lint policy metadata", () => {
		expect(getJstsLintPolicy({ hasEslintConfig: true })).toMatchObject({
			hasExplicitNonBiomeLinter: true,
			preferredRunners: ["eslint"],
		});
		expect(getJstsLintPolicy({ hasOxlintConfig: true })).toMatchObject({
			hasExplicitNonBiomeLinter: true,
			preferredRunners: ["oxlint"],
		});
		expect(getJstsLintPolicy({ hasBiomeConfig: true })).toMatchObject({
			hasExplicitNonBiomeLinter: false,
			preferredRunners: ["biome-check-json"],
		});
		expect(getJstsLintPolicy({})).toMatchObject({
			hasExplicitNonBiomeLinter: false,
			preferredRunners: ["oxlint", "biome-check-json"],
		});
	});

	it("centralizes stylelint, sqlfluff, and rubocop config detection", () => {
		const env = setupTestEnvironment("pi-lens-tool-policy-");
		try {
			createTempFile(env.tmpDir, ".stylelintrc", "{}");
			createTempFile(
				env.tmpDir,
				"pyproject.toml",
				"[tool.sqlfluff]\ndialect='ansi'",
			);
			createTempFile(env.tmpDir, "Gemfile", "gem 'rubocop'\n");

			expect(hasStylelintConfig(env.tmpDir)).toBe(true);
			expect(hasSqlfluffConfig(env.tmpDir)).toBe(true);
			expect(hasRubocopConfig(env.tmpDir)).toBe(true);
			expect(getRubocopCommand(env.tmpDir)).toEqual({
				cmd: "bundle",
				args: ["exec", "rubocop"],
			});
		} finally {
			env.cleanup();
		}
	});

	it("exposes centralized tool execution policy for auto-install behavior", () => {
		expect(getToolExecutionPolicy("oxlint")).toMatchObject({
			gate: "smart-default",
			autoInstall: true,
		});
		expect(getToolExecutionPolicy("eslint")).toMatchObject({
			gate: "config-first",
			autoInstall: false,
		});
		expect(getToolExecutionPolicy("prettier")).toMatchObject({
			gate: "smart-default",
			autoInstall: true,
		});
		expect(shouldAutoInstallTool("stylelint")).toBe(true);
		expect(shouldAutoInstallTool("mypy")).toBe(true);
		expect(shouldAutoInstallTool("prettier")).toBe(true);
		expect(shouldAutoInstallTool("eslint")).toBe(false);
		expect(shouldAutoInstallTool("unknown-tool")).toBe(false);
	});

	it("exposes centralized tool command specs", () => {
		expect(getToolCommandSpec("eslint")).toMatchObject({
			command: "eslint",
			windowsExt: ".cmd",
			managedToolId: "eslint",
		});
		expect(getToolCommandSpec("sqlfluff")).toMatchObject({
			command: "sqlfluff",
			windowsExt: ".exe",
			managedToolId: "sqlfluff",
		});
		expect(getToolCommandSpec("mypy")).toMatchObject({
			command: "mypy",
			managedToolId: "mypy",
		});
		expect(getToolCommandSpec("taplo")).toMatchObject({
			command: "taplo",
			windowsExt: ".exe",
			managedToolId: "taplo",
		});
		expect(getToolCommandSpec("prettier")).toMatchObject({
			command: "prettier",
			windowsExt: ".cmd",
			managedToolId: "prettier",
		});
		expect(getToolCommandSpec("unknown-tool")).toBeUndefined();
	});
});
