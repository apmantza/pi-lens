import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	canToolAutoFix,
	getAutofixCapability,
	getAutofixPolicyForFile,
	getAutoInstallToolIdForFormatter,
	getBiomeConfigPath,
	getFormatterPolicyForFile,
	getJstsLintPolicy,
	getLinterPolicyForCwd,
	getLinterPolicyForFile,
	getPreferredAutofixTools,
	getPreferredJstsLintRunners,
	getRubocopCommand,
	getSmartDefaultFormatterName,
	getToolCommandSpec,
	getToolExecutionPolicy,
	hasBiomeConfig,
	hasBlackConfig,
	hasClangFormatConfig,
	hasCljfmtConfig,
	hasCmakeFormatConfig,
	findCompiledClassesDir,
	hasDetektConfig,
	hasJavaBuildDescriptor,
	hasKtfmtConfig,
	hasKtlintConfig,
	getSpotlessKotlinFormatter,
	hasEslintConfig,
	hasGolangciConfig,
	hasGoogleJavaFormatConfig,
	hasMarkdownlintConfig,
	hasMypyConfig,
	hasNearestPackageJsonDependency,
	hasNearestPackageJsonField,
	hasOcamlformatConfig,
	hasOxfmtConfig,
	hasOxfmtSvelteConfig,
	hasOxlintConfig,
	hasPhpCsFixerConfig,
	hasPhpstanConfig,
	hasPrettierConfig,
	hasRubocopConfig,
	hasRuffConfig,
	hasSqlfluffConfig,
	hasStandardrbConfig,
	hasStylelintConfig,
	hasStyluaConfig,
	hasTflintConfig,
	hasVitePlusConfig,
	hasYamllintConfig,
	isSafePipelineAutofixTool,
	shouldAutoInstallTool,
	_getSpotlessGradleReadCountForTests,
} from "../../clients/tool-policy.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

describe("tool-policy", () => {
	it("defines smart default formatters for unconfigured JS/TS, Python, web/content, and expanded language set", () => {
		expect(getSmartDefaultFormatterName("/tmp/file.ts")).toBe("biome");
		expect(getSmartDefaultFormatterName("/tmp/file.py")).toBe("ruff");
		expect(getSmartDefaultFormatterName("/tmp/file.css")).toBe("biome");
		expect(getSmartDefaultFormatterName("/tmp/file.less")).toBe("prettier");
		expect(getSmartDefaultFormatterName("/tmp/file.gleam")).toBe("gleam");
		expect(getSmartDefaultFormatterName("/tmp/file.go")).toBe("gofmt");
		expect(getSmartDefaultFormatterName("/tmp/file.rs")).toBe("rustfmt");
		expect(getSmartDefaultFormatterName("/tmp/file.sh")).toBe("shfmt");
		expect(getSmartDefaultFormatterName("/tmp/file.kt")).toBeUndefined();
		expect(getSmartDefaultFormatterName("/tmp/file.swift")).toBeUndefined();
		expect(getSmartDefaultFormatterName("/tmp/file.fs")).toBeUndefined();
		expect(getSmartDefaultFormatterName("/tmp/file.nix")).toBeUndefined();
		expect(getSmartDefaultFormatterName("/tmp/file.ex")).toBeUndefined();
		expect(getSmartDefaultFormatterName("/tmp/file.cs")).toBeUndefined();
		expect(getSmartDefaultFormatterName("/tmp/file.hs")).toBeUndefined();
		expect(getSmartDefaultFormatterName("/tmp/file.toml")).toBeUndefined();
		expect(getSmartDefaultFormatterName("/tmp/file.tf")).toBeUndefined();
		expect(getSmartDefaultFormatterName("/tmp/file.dart")).toBe("dart");
		expect(getSmartDefaultFormatterName("/tmp/file.zig")).toBe("zig");
	});

	it("does not force a no-config default for config-first formats", () => {
		expect(getSmartDefaultFormatterName("/tmp/file.json")).toBeUndefined();
		expect(getSmartDefaultFormatterName("/tmp/file.sql")).toBeUndefined();
		expect(getSmartDefaultFormatterName("/tmp/file.cpp")).toBeUndefined();
		expect(getSmartDefaultFormatterName("/tmp/file.php")).toBeUndefined();
		expect(getSmartDefaultFormatterName("/tmp/file.lua")).toBeUndefined();
		expect(getSmartDefaultFormatterName("/tmp/file.ml")).toBeUndefined();
	});

	it("does not auto-apply prettier to markdown without a project prettier config", () => {
		// Prettier's markdown defaults reflow lines, normalize emphasis markers, and
		// restyle lists. Users opt in via project `.prettierrc`; the smart-default gate
		// still honours an explicit config, but no auto-format on empty configuration.
		expect(getSmartDefaultFormatterName("/tmp/file.md")).toBeUndefined();
		expect(getSmartDefaultFormatterName("/tmp/file.mdx")).toBeUndefined();
		expect(getFormatterPolicyForFile("/tmp/file.md")).toMatchObject({
			formatterNames: ["prettier", "oxfmt"],
			defaultFormatter: "prettier",
			defaultWhenUnconfigured: false,
			gate: "smart-default",
		});
		expect(getFormatterPolicyForFile("/tmp/file.mdx")).toMatchObject({
			formatterNames: ["prettier", "oxfmt"],
			defaultFormatter: "prettier",
			defaultWhenUnconfigured: false,
			gate: "smart-default",
		});
	});

	// #2384: unconfigured HTML/YAML commonly carry template markers ({{JS}}
	// embeds, Helm `{{ .Values.x }}`). Real Prettier reinterprets them as code
	// and corrupts them. Users opt in via project `.prettierrc`; the smart-
	// default gate still honours an explicit config.
	it.each([".html", ".htm", ".yaml", ".yml"])(
		"does not auto-apply prettier to unconfigured %s files (#2384)",
		(ext) => {
			expect(getSmartDefaultFormatterName(`/tmp/file${ext}`)).toBeUndefined();
			expect(getFormatterPolicyForFile(`/tmp/file${ext}`)).toMatchObject({
				formatterNames: ["prettier", "oxfmt"],
				defaultFormatter: "prettier",
				defaultWhenUnconfigured: false,
				gate: "smart-default",
			});
		},
	);

	it("maps managed smart-default formatters to auto-installable tool ids", () => {
		expect(getAutoInstallToolIdForFormatter("biome")).toBe("biome");
		expect(getAutoInstallToolIdForFormatter("ruff")).toBe("ruff");
		expect(getAutoInstallToolIdForFormatter("prettier")).toBe("prettier");
		expect(getAutoInstallToolIdForFormatter("shfmt")).toBe("shfmt");
		expect(getAutoInstallToolIdForFormatter("taplo")).toBe("taplo");
		expect(getAutoInstallToolIdForFormatter("gofmt")).toBeUndefined();
		expect(getAutoInstallToolIdForFormatter("rustfmt")).toBeUndefined();
		expect(getAutoInstallToolIdForFormatter("terraform")).toBeUndefined();
		expect(getAutoInstallToolIdForFormatter("dart")).toBeUndefined();
		expect(getAutoInstallToolIdForFormatter("zig")).toBeUndefined();
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
		expect(getFormatterPolicyForFile("/tmp/file.go")).toMatchObject({
			defaultFormatter: "gofmt",
			defaultWhenUnconfigured: true,
		});
		expect(getFormatterPolicyForFile("/tmp/file.css")).toMatchObject({
			defaultFormatter: "biome",
			defaultWhenUnconfigured: true,
		});
		expect(getFormatterPolicyForFile("/tmp/file.html")).toMatchObject({
			defaultFormatter: "prettier",
			defaultWhenUnconfigured: false,
		});
		expect(getFormatterPolicyForFile("/tmp/file.kt")).toMatchObject({
			defaultFormatter: "ktlint",
			defaultWhenUnconfigured: false,
		});
		expect(getFormatterPolicyForFile("/tmp/file.swift")).toMatchObject({
			defaultFormatter: "swiftformat",
			defaultWhenUnconfigured: false,
		});
		expect(getFormatterPolicyForFile("/tmp/file.fs")).toMatchObject({
			defaultFormatter: "fantomas",
			defaultWhenUnconfigured: false,
		});
		expect(getFormatterPolicyForFile("/tmp/file.nix")).toMatchObject({
			defaultFormatter: "nixfmt",
			defaultWhenUnconfigured: false,
		});
		expect(getFormatterPolicyForFile("/tmp/file.ex")).toMatchObject({
			defaultFormatter: "mix",
			defaultWhenUnconfigured: false,
		});
		expect(getFormatterPolicyForFile("/tmp/file.gleam")).toMatchObject({
			defaultFormatter: "gleam",
			defaultWhenUnconfigured: true,
		});
		expect(getFormatterPolicyForFile("/tmp/file.cs")).toMatchObject({
			defaultFormatter: "csharpier",
			defaultWhenUnconfigured: false,
		});
		expect(getFormatterPolicyForFile("/tmp/file.hs")).toMatchObject({
			defaultFormatter: "ormolu",
			defaultWhenUnconfigured: false,
		});
		expect(getFormatterPolicyForFile("/tmp/file.cpp")).toMatchObject({
			defaultFormatter: "clang-format",
			defaultWhenUnconfigured: false,
		});
		expect(getFormatterPolicyForFile("/tmp/file.php")).toMatchObject({
			defaultFormatter: "php-cs-fixer",
			defaultWhenUnconfigured: false,
		});
		expect(getFormatterPolicyForFile("/tmp/file.lua")).toMatchObject({
			defaultFormatter: "stylua",
			defaultWhenUnconfigured: false,
		});
		expect(getFormatterPolicyForFile("/tmp/file.ml")).toMatchObject({
			defaultFormatter: "ocamlformat",
			defaultWhenUnconfigured: false,
		});
		expect(getFormatterPolicyForFile("/tmp/file.toml")).toMatchObject({
			defaultFormatter: "taplo",
			defaultWhenUnconfigured: false,
		});
		expect(getFormatterPolicyForFile("/tmp/terragrunt.hcl")).toMatchObject({
			defaultFormatter: "terragrunt-hcl",
			defaultWhenUnconfigured: true,
		});
		expect(getFormatterPolicyForFile("/tmp/root.hcl")).toMatchObject({
			defaultFormatter: "terragrunt-hcl",
			defaultWhenUnconfigured: true,
		});
		expect(getFormatterPolicyForFile("/tmp/Terragrunt.HCL")).toMatchObject({
			defaultFormatter: "terragrunt-hcl",
			defaultWhenUnconfigured: true,
		});
		expect(getFormatterPolicyForFile("/tmp/foo.hcl")).toBeUndefined();
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

	it("exposes centralized autofix policy metadata", () => {
		expect(
			getAutofixPolicyForFile("/tmp/file.ts", { hasEslintConfig: true }),
		).toMatchObject({
			preferredTools: ["eslint"],
			gate: "config-first",
			safe: true,
		});
		expect(
			getAutofixPolicyForFile("/tmp/file.ts", { hasEslintConfig: false }),
		).toMatchObject({
			preferredTools: ["biome"],
			gate: "smart-default",
			safe: true,
		});
		expect(getAutofixPolicyForFile("/tmp/file.sql", {})).toMatchObject({
			preferredTools: ["sqlfluff"],
			defaultWhenUnconfigured: false,
			gate: "config-first",
			safe: true,
		});
		expect(getAutofixPolicyForFile("/tmp/file.kt", {})).toMatchObject({
			preferredTools: ["ktlint"],
			safe: true,
		});
		// detekt is the config-first Kotlin alternate.
		expect(
			getAutofixPolicyForFile("/tmp/file.kt", { hasDetektConfig: true }),
		).toMatchObject({ preferredTools: ["detekt"], gate: "config-first" });
		// ktfmt is config-first and outranks both detekt and the ktlint default
		// when the project opts in (#129).
		expect(
			getAutofixPolicyForFile("/tmp/file.kt", { hasKtfmtConfig: true }),
		).toMatchObject({ preferredTools: ["ktfmt"], gate: "config-first" });
		expect(
			getAutofixPolicyForFile("/tmp/file.kt", {
				hasKtlintConfig: true,
				hasKtfmtConfig: true,
			}),
		).toMatchObject({ preferredTools: ["ktlint"], gate: "config-first" });
		expect(
			getAutofixPolicyForFile("/tmp/file.kt", {
				hasKtfmtConfig: true,
				hasDetektConfig: true,
			}),
		).toMatchObject({ preferredTools: ["ktfmt"], gate: "config-first" });
		// markdownlint is smart-default (no config needed).
		expect(getAutofixPolicyForFile("/tmp/file.md", {})).toMatchObject({
			preferredTools: ["markdownlint"],
			gate: "smart-default",
		});
		// oxlint mirrors the JS lint precedence when configured.
		expect(
			getAutofixPolicyForFile("/tmp/file.ts", { hasOxlintConfig: true }),
		).toMatchObject({ preferredTools: ["oxlint"] });
		// Go autofix is config-first: a policy exists, but selects nothing until a
		// .golangci.* config opts in.
		expect(getAutofixPolicyForFile("/tmp/file.go", {})).toMatchObject({
			preferredTools: [],
			gate: "config-first",
		});
		expect(
			getAutofixPolicyForFile("/tmp/file.go", { hasGolangciConfig: true }),
		).toMatchObject({ preferredTools: ["golangci-lint"] });
	});

	it("exposes centralized autofix capability metadata", () => {
		expect(getAutofixCapability("ruff")).toMatchObject({
			toolSupportsFix: true,
			safePipelineAutofix: true,
			fixKind: "pipeline",
		});
		expect(getAutofixCapability("ktlint")).toMatchObject({
			toolSupportsFix: true,
			safePipelineAutofix: true,
			fixKind: "pipeline",
		});
		expect(getAutofixCapability("prettier-check")).toBeUndefined();
		expect(canToolAutoFix("rubocop")).toBe(true);
		expect(isSafePipelineAutofixTool("rubocop")).toBe(true);
		expect(canToolAutoFix("phpstan")).toBe(false);
		expect(isSafePipelineAutofixTool("phpstan")).toBe(false);
	});

	it("exposes centralized linter policy metadata", () => {
		expect(
			getLinterPolicyForFile("/tmp/file.ts", { hasEslintConfig: true }),
		).toMatchObject({
			preferredRunners: ["eslint"],
			gate: "config-first",
		});
		expect(getLinterPolicyForFile("/tmp/file.ts", {})).toMatchObject({
			preferredRunners: ["oxlint", "biome-check-json"],
			gate: "smart-default",
		});
		expect(getLinterPolicyForFile("/tmp/file.css", {})).toMatchObject({
			preferredRunners: ["stylelint"],
			gate: "smart-default",
		});
		expect(getLinterPolicyForFile("/tmp/file.sql", {})).toMatchObject({
			preferredRunners: ["sqlfluff"],
			defaultWhenUnconfigured: false,
			gate: "config-first",
		});
		expect(getLinterPolicyForFile("/tmp/file.yaml", {})).toMatchObject({
			preferredRunners: ["yamllint"],
			gate: "smart-default",
		});
		expect(getLinterPolicyForFile("/tmp/terragrunt.hcl", {})).toMatchObject({
			preferredRunners: ["terragrunt"],
			defaultRunner: "terragrunt",
			gate: "smart-default",
		});
		expect(getLinterPolicyForFile("/tmp/root.hcl", {})).toMatchObject({
			preferredRunners: ["terragrunt"],
			defaultRunner: "terragrunt",
			gate: "smart-default",
		});
		expect(getLinterPolicyForFile("/tmp/Root.HCL", {})).toMatchObject({
			preferredRunners: ["terragrunt"],
			defaultRunner: "terragrunt",
			gate: "smart-default",
		});
		expect(getLinterPolicyForFile("/tmp/foo.hcl", {})).toBeUndefined();
		expect(getLinterPolicyForFile("/tmp/file.md", {})).toMatchObject({
			preferredRunners: ["markdownlint"],
			gate: "smart-default",
		});
		// Kotlin: ktlint is the smart-default linter. Opting into ktfmt (a pure
		// formatter wired as autofix, NOT a lint runner) makes ktlint's lint step
		// aside so it won't conflict, while detekt's semantic lint is unaffected (#129).
		expect(getLinterPolicyForFile("/tmp/file.kt", {})).toMatchObject({
			preferredRunners: ["ktlint"],
			defaultRunner: "ktlint",
			gate: "smart-default",
		});
		expect(
			getLinterPolicyForFile("/tmp/file.kt", { hasKtfmtConfig: true }),
		).toMatchObject({ preferredRunners: [], gate: "config-first" });
		expect(
			getLinterPolicyForFile("/tmp/file.kt", {
				hasKtfmtConfig: true,
				hasDetektConfig: true,
			}),
		).toMatchObject({ preferredRunners: ["detekt"], gate: "config-first" });
		expect(getLinterPolicyForFile("/tmp/file.html", {})).toMatchObject({
			preferredRunners: ["htmlhint"],
			gate: "smart-default",
		});
		expect(getLinterPolicyForFile("/tmp/Dockerfile", {})).toMatchObject({
			preferredRunners: ["hadolint"],
			gate: "smart-default",
		});
		expect(getLinterPolicyForFile("/tmp/file.kt", {})).toMatchObject({
			preferredRunners: ["ktlint"],
			gate: "smart-default",
		});
		expect(getLinterPolicyForFile("/tmp/file.toml", {})).toMatchObject({
			preferredRunners: ["taplo"],
			gate: "smart-default",
		});
		expect(getLinterPolicyForFile("/tmp/file.go", {})).toMatchObject({
			preferredRunners: [],
			gate: "config-first",
		});
		expect(
			getLinterPolicyForFile("/tmp/file.go", { hasGolangciConfig: true }),
		).toMatchObject({
			preferredRunners: ["golangci-lint"],
			gate: "config-first",
		});
		// Terraform: tflint has built-in rules, so it stays a smart default with no
		// config. A project `.tflint.hcl` is an explicit opt-in, which promotes it
		// to config-first the same way `.golangci.yml` does for Go.
		expect(getLinterPolicyForFile("/tmp/file.tf", {})).toMatchObject({
			preferredRunners: ["tflint"],
			defaultRunner: "tflint",
			gate: "smart-default",
		});
		expect(
			getLinterPolicyForFile("/tmp/file.tfvars", { hasTflintConfig: true }),
		).toMatchObject({
			preferredRunners: ["tflint"],
			gate: "config-first",
		});
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

	it("centralizes config detection for mypy, yamllint, markdownlint, prettier, golangci, phpstan, ruff, biome, black, standardrb, and final-batch formatters", () => {
		const env = setupTestEnvironment("pi-lens-tool-policy-more-config-");
		try {
			createTempFile(
				env.tmpDir,
				"pyproject.toml",
				"[tool.mypy]\nstrict = true\n\n[tool.black]\nline-length = 88\n",
			);
			createTempFile(env.tmpDir, ".yamllint", "extends: default\n");
			createTempFile(env.tmpDir, ".markdownlint.json", "{}\n");
			createTempFile(env.tmpDir, ".golangci.yml", "run:\n  timeout: 1m\n");
			createTempFile(env.tmpDir, "phpstan.neon", "parameters:\n  level: 5\n");
			createTempFile(env.tmpDir, "ruff.toml", "line-length = 100\n");
			createTempFile(env.tmpDir, "biome.jsonc", "{}\n");
			createTempFile(env.tmpDir, "Gemfile", "gem 'standard'\n");
			createTempFile(env.tmpDir, ".clang-format", "BasedOnStyle: LLVM\n");
			createTempFile(
				env.tmpDir,
				".php-cs-fixer.dist.php",
				"<?php return [];\n",
			);
			createTempFile(env.tmpDir, "stylua.toml", "column_width = 100\n");
			createTempFile(env.tmpDir, ".ocamlformat", "profile = conventional\n");
			createTempFile(
				env.tmpDir,
				"package.json",
				JSON.stringify({ prettier: { semi: false } }),
			);

			expect(hasMypyConfig(env.tmpDir)).toBe(true);
			expect(hasYamllintConfig(env.tmpDir)).toBe(true);
			expect(hasMarkdownlintConfig(env.tmpDir)).toBe(true);
			expect(hasPrettierConfig(env.tmpDir)).toBe(true);
			expect(hasBlackConfig(env.tmpDir)).toBe(true);
			expect(hasGolangciConfig(env.tmpDir)).toBe(true);
			expect(hasPhpstanConfig(env.tmpDir)).toBe(true);
			expect(hasRuffConfig(env.tmpDir)).toBe(true);
			expect(hasStandardrbConfig(env.tmpDir)).toBe(true);
			expect(hasClangFormatConfig(env.tmpDir)).toBe(true);
			expect(hasPhpCsFixerConfig(env.tmpDir)).toBe(true);
			expect(hasStyluaConfig(env.tmpDir)).toBe(true);
			expect(hasOcamlformatConfig(env.tmpDir)).toBe(true);
			expect(getBiomeConfigPath(env.tmpDir)).toMatch(/biome\.jsonc$/);
		} finally {
			env.cleanup();
		}
	});

	it.each([
		".markdownlint-cli2.jsonc",
		".markdownlint-cli2.yaml",
		".markdownlint-cli2.yml",
		".markdownlint-cli2.cjs",
		".markdownlint-cli2.mjs",
		".markdownlint.cjs",
		".markdownlint.mjs",
	])("detects markdownlint-cli2 config filename %s", (configName) => {
		const env = setupTestEnvironment(
			`pi-lens-markdownlint-config-${configName}`,
		);
		try {
			createTempFile(env.tmpDir, configName, "{}\n");
			expect(hasMarkdownlintConfig(env.tmpDir)).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("formatter config detectors walk past package.json boundaries consistently", () => {
		const env = setupTestEnvironment("pi-lens-tool-policy-fmt-config-walkup-");
		try {
			const nestedDir = path.join(env.tmpDir, "packages", "ui", "src");
			createTempFile(
				path.dirname(nestedDir),
				"package.json",
				JSON.stringify({ name: "ui" }),
			);
			fs.mkdirSync(nestedDir, { recursive: true });

			const cases: Array<[string, string, string, () => boolean]> = [
				["biome", "biome.json", "{}\n", () => hasBiomeConfig(nestedDir)],
				["oxfmt", ".oxfmtrc.json", "{}\n", () => hasOxfmtConfig(nestedDir)],
				["prettier", ".prettierrc", "{}\n", () => hasPrettierConfig(nestedDir)],
				[
					"stylelint",
					".stylelintrc",
					"{}\n",
					() => hasStylelintConfig(nestedDir),
				],
				[
					"black",
					"pyproject.toml",
					"[tool.black]\nline-length = 88\n",
					() => hasBlackConfig(nestedDir),
				],
				[
					"ruff",
					"ruff.toml",
					"line-length = 100\n",
					() => hasRuffConfig(nestedDir),
				],
				[
					"mypy",
					"mypy.ini",
					"[mypy]\nstrict = true\n",
					() => hasMypyConfig(nestedDir),
				],
				[
					"sqlfluff",
					".sqlfluff",
					"[sqlfluff]\ndialect = ansi\n",
					() => hasSqlfluffConfig(nestedDir),
				],
				[
					"yamllint",
					".yamllint",
					"extends: default\n",
					() => hasYamllintConfig(nestedDir),
				],
				[
					"markdownlint",
					".markdownlint.json",
					"{}\n",
					() => hasMarkdownlintConfig(nestedDir),
				],
				[
					"rubocop",
					".rubocop.yml",
					"AllCops: {}\n",
					() => hasRubocopConfig(nestedDir),
				],
				[
					"standardrb",
					"Gemfile",
					"gem 'standard'\n",
					() => hasStandardrbConfig(nestedDir),
				],
				[
					"golangci",
					".golangci.yml",
					"run:\n  timeout: 1m\n",
					() => hasGolangciConfig(nestedDir),
				],
				[
					"phpstan",
					"phpstan.neon",
					"parameters:\n  level: 5\n",
					() => hasPhpstanConfig(nestedDir),
				],
				[
					"detekt",
					"detekt.yml",
					"build:\n  maxIssues: 0\n",
					() => hasDetektConfig(nestedDir),
				],
				[
					"clang-format",
					".clang-format",
					"BasedOnStyle: LLVM\n",
					() => hasClangFormatConfig(nestedDir),
				],
				[
					"php-cs-fixer",
					".php-cs-fixer.dist.php",
					"<?php return [];\n",
					() => hasPhpCsFixerConfig(nestedDir),
				],
				[
					"stylua",
					"stylua.toml",
					"column_width = 100\n",
					() => hasStyluaConfig(nestedDir),
				],
				[
					"ocamlformat",
					".ocamlformat",
					"profile = conventional\n",
					() => hasOcamlformatConfig(nestedDir),
				],
				[
					"google-java-format",
					".google-java-format",
					"{}\n",
					() => hasGoogleJavaFormatConfig(nestedDir),
				],
				["cljfmt", ".cljfmt.edn", "{}\n", () => hasCljfmtConfig(nestedDir)],
				[
					"cmake-format",
					".cmake-format",
					"# cmake-format config\n",
					() => hasCmakeFormatConfig(nestedDir),
				],
				[
					"tflint",
					".tflint.hcl",
					'plugin "terraform" {\n  enabled = true\n}\n',
					() => hasTflintConfig(nestedDir),
				],
			];

			for (const [name, configFile, content, detector] of cases) {
				createTempFile(env.tmpDir, configFile, content);
				expect(detector(), name).toBe(true);
				fs.rmSync(path.join(env.tmpDir, configFile));
			}
		} finally {
			env.cleanup();
		}
	});

	// The tflint runner resolves `.tflint.hcl` by walking up from the EDITED
	// FILE's directory, so the policy has to ask the same question from the same
	// place. Keyed off the project cwd it would miss every config that lives in a
	// terraform subdirectory — the common monorepo layout — and report
	// smart-default for a project that had explicitly configured tflint.
	it("detects a .tflint.hcl that lives below the project root", () => {
		const env = setupTestEnvironment("pi-lens-tflint-policy-root-");
		try {
			const stackDir = path.join(env.tmpDir, "infra", "stack");
			fs.mkdirSync(stackDir, { recursive: true });
			fs.writeFileSync(
				path.join(env.tmpDir, "infra", ".tflint.hcl"),
				'plugin "terraform" {\n  enabled = true\n}\n',
			);

			expect(
				getLinterPolicyForCwd(path.join(stackDir, "main.tf"), env.tmpDir),
			).toMatchObject({ preferredRunners: ["tflint"], gate: "config-first" });
		} finally {
			env.cleanup();
		}
	});

	it("leaves the terraform policy at smart-default with no .tflint.hcl anywhere", () => {
		const env = setupTestEnvironment("pi-lens-tflint-policy-none-");
		try {
			const stackDir = path.join(env.tmpDir, "infra", "stack");
			fs.mkdirSync(stackDir, { recursive: true });

			expect(
				getLinterPolicyForCwd(path.join(stackDir, "main.tf"), env.tmpDir),
			).toMatchObject({ preferredRunners: ["tflint"], gate: "smart-default" });
		} finally {
			env.cleanup();
		}
	});

	it("supports nearest package.json dependency and field checks", () => {
		const env = setupTestEnvironment("pi-lens-tool-policy-nearest-pkg-");
		try {
			createTempFile(
				env.tmpDir,
				"package.json",
				JSON.stringify({ devDependencies: { prettier: "^3.0.0" } }),
			);
			const subPkgDir = path.join(env.tmpDir, "packages", "ui");
			createTempFile(
				subPkgDir,
				"package.json",
				JSON.stringify({ name: "ui", prettier: { semi: false } }),
			);

			expect(hasNearestPackageJsonDependency(env.tmpDir, "prettier")).toBe(
				true,
			);
			expect(hasNearestPackageJsonDependency(subPkgDir, "prettier")).toBe(
				false,
			);
			expect(hasNearestPackageJsonField(subPkgDir, "prettier")).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("hasPrettierConfig detects config file in a parent directory", () => {
		const env = setupTestEnvironment("pi-lens-tool-policy-prettier-walkup-");
		try {
			createTempFile(env.tmpDir, ".prettierrc", "{}");
			const subDir = path.join(env.tmpDir, "src", "components");
			fs.mkdirSync(subDir, { recursive: true });
			expect(hasPrettierConfig(subDir)).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("hasPrettierConfig returns true when package.json has prettier set to false (field exists)", () => {
		const env = setupTestEnvironment("pi-lens-tool-policy-prettier-false-");
		try {
			createTempFile(
				env.tmpDir,
				"package.json",
				JSON.stringify({ prettier: false }),
			);
			// The field exists — this is an explicit config (even if it opts out).
			// Old code used `if (pkg.prettier)` which would wrongly return false here.
			expect(hasPrettierConfig(env.tmpDir)).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("hasPrettierConfig returns true when package.json has prettier set to null (field exists)", () => {
		const env = setupTestEnvironment("pi-lens-tool-policy-prettier-null-");
		try {
			createTempFile(
				env.tmpDir,
				"package.json",
				JSON.stringify({ prettier: null }),
			);
			expect(hasPrettierConfig(env.tmpDir)).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("hasEslintConfig detects config file in a parent directory", () => {
		const env = setupTestEnvironment("pi-lens-tool-policy-eslint-walkup-");
		try {
			createTempFile(env.tmpDir, "eslint.config.js", "export default [];\n");
			const subDir = path.join(env.tmpDir, "src");
			fs.mkdirSync(subDir, { recursive: true });
			expect(hasEslintConfig(subDir)).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("hasEslintConfig detects eslintConfig field in parent package.json", () => {
		const env = setupTestEnvironment("pi-lens-tool-policy-eslint-pkg-walkup-");
		try {
			createTempFile(
				env.tmpDir,
				"package.json",
				JSON.stringify({ eslintConfig: { rules: {} } }),
			);
			const subDir = path.join(env.tmpDir, "src");
			fs.mkdirSync(subDir, { recursive: true });
			expect(hasEslintConfig(subDir)).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("hasBiomeConfig / getBiomeConfigPath detects biome.json in a parent directory", () => {
		const env = setupTestEnvironment("pi-lens-tool-policy-biome-walkup-");
		try {
			createTempFile(env.tmpDir, "biome.json", "{}\n");
			const subDir = path.join(env.tmpDir, "src");
			fs.mkdirSync(subDir, { recursive: true });
			expect(hasBiomeConfig(subDir)).toBe(true);
			expect(getBiomeConfigPath(subDir)).toMatch(/biome\.json$/);
		} finally {
			env.cleanup();
		}
	});

	it("hasStylelintConfig detects config file in a parent directory", () => {
		const env = setupTestEnvironment("pi-lens-tool-policy-stylelint-walkup-");
		try {
			createTempFile(env.tmpDir, ".stylelintrc", "{}\n");
			createTempFile(
				env.tmpDir,
				"package.json",
				JSON.stringify({ name: "root" }),
			);
			const subDir = path.join(env.tmpDir, "src");
			fs.mkdirSync(subDir, { recursive: true });
			expect(hasStylelintConfig(subDir)).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("hasOxlintConfig detects .oxlintrc.json in a parent directory", () => {
		const env = setupTestEnvironment("pi-lens-tool-policy-oxlint-walkup-");
		try {
			createTempFile(env.tmpDir, ".oxlintrc.json", "{}\n");
			const subDir = path.join(env.tmpDir, "src");
			fs.mkdirSync(subDir, { recursive: true });
			expect(hasOxlintConfig(subDir)).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("hasOxlintConfig detects .oxlintrc.jsonc in a parent directory", () => {
		const env = setupTestEnvironment(
			"pi-lens-tool-policy-oxlint-jsonc-walkup-",
		);
		try {
			createTempFile(env.tmpDir, ".oxlintrc.jsonc", "{\n// comment\n}\n");
			const subDir = path.join(env.tmpDir, "src");
			fs.mkdirSync(subDir, { recursive: true });
			expect(hasOxlintConfig(subDir)).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("hasOxlintConfig detects oxlint.config.ts in a parent directory", () => {
		const env = setupTestEnvironment(
			"pi-lens-tool-policy-oxlint-config-ts-walkup-",
		);
		try {
			createTempFile(
				env.tmpDir,
				"oxlint.config.ts",
				'import { defineConfig } from "oxlint";\nexport default defineConfig({});\n',
			);
			const subDir = path.join(env.tmpDir, "src");
			fs.mkdirSync(subDir, { recursive: true });
			expect(hasOxlintConfig(subDir)).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("hasOxlintConfig detects oxlint.config.mts in a parent directory", () => {
		const env = setupTestEnvironment(
			"pi-lens-tool-policy-oxlint-config-mts-walkup-",
		);
		try {
			createTempFile(
				env.tmpDir,
				"oxlint.config.mts",
				'import { defineConfig } from "oxlint";\nexport default defineConfig({});\n',
			);
			const subDir = path.join(env.tmpDir, "src");
			fs.mkdirSync(subDir, { recursive: true });
			expect(hasOxlintConfig(subDir)).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("detects Vite+ as oxfmt/oxlint project configuration", () => {
		const env = setupTestEnvironment("pi-lens-tool-policy-vite-plus-");
		try {
			createTempFile(
				env.tmpDir,
				"package.json",
				JSON.stringify({ devDependencies: { "vite-plus": "^0.1.0" } }),
			);
			const subDir = path.join(env.tmpDir, "src");
			fs.mkdirSync(subDir, { recursive: true });

			expect(hasVitePlusConfig(subDir)).toBe(true);
			expect(hasOxfmtConfig(subDir)).toBe(true);
			expect(hasOxlintConfig(subDir)).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	// oxfmt's .svelte support is conditional beyond the generic hasOxfmtConfig
	// check — verified empirically against the real oxfmt npm binary (see
	// PR #1134 body for the full four-cell matrix). Both the `svelte` package
	// AND the config's `svelte` flag are required; either alone always fails.
	describe("hasOxfmtSvelteConfig (#1134)", () => {
		it('is true with the svelte package and {"svelte": true} in .oxfmtrc.json', () => {
			const env = setupTestEnvironment(
				"pi-lens-tool-policy-oxfmt-svelte-json-",
			);
			try {
				createTempFile(
					env.tmpDir,
					"package.json",
					JSON.stringify({
						devDependencies: { oxfmt: "^0.54.0", svelte: "^5.0.0" },
					}),
				);
				createTempFile(
					env.tmpDir,
					".oxfmtrc.json",
					JSON.stringify({ svelte: true }),
				);
				expect(hasOxfmtSvelteConfig(env.tmpDir)).toBe(true);
			} finally {
				env.cleanup();
			}
		});

		it("is true with the svelte package and `svelte = true` in oxfmt.toml", () => {
			const env = setupTestEnvironment(
				"pi-lens-tool-policy-oxfmt-svelte-toml-",
			);
			try {
				createTempFile(
					env.tmpDir,
					"package.json",
					JSON.stringify({ devDependencies: { svelte: "^5.0.0" } }),
				);
				createTempFile(env.tmpDir, "oxfmt.toml", "svelte = true\n");
				expect(hasOxfmtSvelteConfig(env.tmpDir)).toBe(true);
			} finally {
				env.cleanup();
			}
		});

		it("is false without the svelte package, even with the config flag on", () => {
			const env = setupTestEnvironment(
				"pi-lens-tool-policy-oxfmt-svelte-nopackage-",
			);
			try {
				createTempFile(
					env.tmpDir,
					".oxfmtrc.json",
					JSON.stringify({ svelte: true }),
				);
				expect(hasOxfmtSvelteConfig(env.tmpDir)).toBe(false);
			} finally {
				env.cleanup();
			}
		});

		it("is false with the svelte package but no config flag", () => {
			const env = setupTestEnvironment(
				"pi-lens-tool-policy-oxfmt-svelte-noflag-",
			);
			try {
				createTempFile(
					env.tmpDir,
					"package.json",
					JSON.stringify({ devDependencies: { svelte: "^5.0.0" } }),
				);
				expect(hasOxfmtSvelteConfig(env.tmpDir)).toBe(false);
			} finally {
				env.cleanup();
			}
		});

		it("is false when the config flag is explicitly false", () => {
			const env = setupTestEnvironment(
				"pi-lens-tool-policy-oxfmt-svelte-false-",
			);
			try {
				createTempFile(
					env.tmpDir,
					"package.json",
					JSON.stringify({ devDependencies: { svelte: "^5.0.0" } }),
				);
				createTempFile(
					env.tmpDir,
					".oxfmtrc.json",
					JSON.stringify({ svelte: false }),
				);
				expect(hasOxfmtSvelteConfig(env.tmpDir)).toBe(false);
			} finally {
				env.cleanup();
			}
		});

		it("is false for a generic oxfmt.toml that doesn't set the svelte key", () => {
			const env = setupTestEnvironment(
				"pi-lens-tool-policy-oxfmt-svelte-generic-toml-",
			);
			try {
				createTempFile(
					env.tmpDir,
					"package.json",
					JSON.stringify({ devDependencies: { svelte: "^5.0.0" } }),
				);
				createTempFile(env.tmpDir, "oxfmt.toml", "# oxfmt config\n");
				expect(hasOxfmtSvelteConfig(env.tmpDir)).toBe(false);
			} finally {
				env.cleanup();
			}
		});

		// #1134 P3 tail 1: an inline trailing comment on the `svelte = true` line
		// used to false-negative because the line-match regex required the value
		// to be immediately followed by end-of-line/end-of-file.
		it("is true with `svelte = true  # comment` in oxfmt.toml (tail 1 — trailing comment)", () => {
			const env = setupTestEnvironment(
				"pi-lens-tool-policy-oxfmt-svelte-toml-comment-",
			);
			try {
				createTempFile(
					env.tmpDir,
					"package.json",
					JSON.stringify({ devDependencies: { svelte: "^5.0.0" } }),
				);
				createTempFile(env.tmpDir, "oxfmt.toml", "svelte = true  # enable\n");
				expect(hasOxfmtSvelteConfig(env.tmpDir)).toBe(true);
			} finally {
				env.cleanup();
			}
		});
	});

	it("hasMypyConfig detects [tool.mypy] in a parent directory pyproject.toml", () => {
		const env = setupTestEnvironment("pi-lens-tool-policy-mypy-walkup-");
		try {
			createTempFile(
				env.tmpDir,
				"pyproject.toml",
				"[tool.mypy]\nstrict = true\n",
			);
			const subDir = path.join(env.tmpDir, "src");
			fs.mkdirSync(subDir, { recursive: true });
			expect(hasMypyConfig(subDir)).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("hasDetektConfig detects detekt.yml in a parent directory", () => {
		const env = setupTestEnvironment("pi-lens-tool-policy-detekt-walkup-");
		try {
			createTempFile(env.tmpDir, "detekt.yml", "build:\n  maxIssues: 0\n");
			const subDir = path.join(env.tmpDir, "src");
			fs.mkdirSync(subDir, { recursive: true });
			expect(hasDetektConfig(subDir)).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("hasKtfmtConfig detects the .ktfmt opt-in marker in a parent directory", () => {
		const env = setupTestEnvironment("pi-lens-tool-policy-ktfmt-marker-");
		try {
			createTempFile(env.tmpDir, ".ktfmt", "");
			const subDir = path.join(env.tmpDir, "src");
			fs.mkdirSync(subDir, { recursive: true });
			expect(hasKtfmtConfig(subDir)).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("hasKtfmtConfig detects the ktfmt gradle plugin in build.gradle.kts", () => {
		const env = setupTestEnvironment("pi-lens-tool-policy-ktfmt-gradle-");
		try {
			createTempFile(
				env.tmpDir,
				"build.gradle.kts",
				'plugins {\n  id("com.ncorti.ktfmt.gradle") version "0.21.0"\n}\n',
			);
			expect(hasKtfmtConfig(env.tmpDir)).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("pins Spotless kotlin ktlint and excludes ktfmt (#1306)", () => {
		const env = setupTestEnvironment("pi-lens-tool-policy-spotless-ktlint-");
		try {
			createTempFile(
				env.tmpDir,
				"build.gradle",
				"spotless {\n  kotlin {\n    ktlint()\n  }\n}\n",
			);
			expect(getSpotlessKotlinFormatter(env.tmpDir)).toBe("ktlint");
			expect(hasKtlintConfig(env.tmpDir)).toBe(true);
			expect(hasKtfmtConfig(env.tmpDir)).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("pins Spotless kotlin ktfmt and excludes ktlint (#1306)", () => {
		const env = setupTestEnvironment("pi-lens-tool-policy-spotless-ktfmt-");
		try {
			createTempFile(
				env.tmpDir,
				"build.gradle.kts",
				"spotless {\n  kotlin {\n    ktfmt()\n  }\n}\n",
			);
			expect(getSpotlessKotlinFormatter(env.tmpDir)).toBe("ktfmt");
			expect(hasKtlintConfig(env.tmpDir)).toBe(false);
			expect(hasKtfmtConfig(env.tmpDir)).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it.each([
		["line comment", "spotless {\n  kotlin {\n    // ktlint()\n  }\n}\n"],
		["block comment", "spotless {\n  kotlin {\n    /* ktlint() */\n  }\n}\n"],
		[
			"string literal",
			'spotless {\n  kotlin {\n    val example = "ktlint()"\n  }\n}\n',
		],
	])("ignores ktlint() in a %s (#1306)", (_kind, source) => {
		const env = setupTestEnvironment("pi-lens-tool-policy-spotless-lexical-");
		try {
			createTempFile(env.tmpDir, "build.gradle.kts", source);
			expect(getSpotlessKotlinFormatter(env.tmpDir)).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("documents disabled Gradle blocks as a lexical-scanner limitation (#1306)", () => {
		const env = setupTestEnvironment("pi-lens-tool-policy-spotless-disabled-");
		try {
			createTempFile(
				env.tmpDir,
				"build.gradle.kts",
				"spotless {\n  kotlin {\n    if (false) { ktlint() }\n  }\n}\n",
			);
			expect(getSpotlessKotlinFormatter(env.tmpDir)).toBe("ktlint");
		} finally {
			env.cleanup();
		}
	});

	it("detects Spotless Kotlin configuration in settings.gradle.kts (#1306)", () => {
		const env = setupTestEnvironment("pi-lens-tool-policy-spotless-settings-");
		try {
			createTempFile(
				env.tmpDir,
				"settings.gradle.kts",
				"spotless {\n  kotlin {\n    ktfmt()\n  }\n}\n",
			);
			const subDir = path.join(env.tmpDir, "modules", "app");
			fs.mkdirSync(subDir, { recursive: true });
			expect(getSpotlessKotlinFormatter(subDir)).toBe("ktfmt");
		} finally {
			env.cleanup();
		}
	});

	it("memoizes Spotless detection by Gradle path and mtime (#1306)", () => {
		const env = setupTestEnvironment("pi-lens-tool-policy-spotless-memo-");
		const gradlePath = createTempFile(
			env.tmpDir,
			"build.gradle.kts",
			"spotless {\n  kotlin {\n    ktlint()\n  }\n}\n",
		);
		try {
			const readsBefore = _getSpotlessGradleReadCountForTests();
			for (let selection = 0; selection < 8; selection += 1) {
				expect(getSpotlessKotlinFormatter(env.tmpDir)).toBe("ktlint");
			}
			expect(_getSpotlessGradleReadCountForTests() - readsBefore).toBe(1);

			const nextMtime = new Date(fs.statSync(gradlePath).mtimeMs + 2_000);
			fs.utimesSync(gradlePath, nextMtime, nextMtime);
			expect(getSpotlessKotlinFormatter(env.tmpDir)).toBe("ktlint");
			expect(_getSpotlessGradleReadCountForTests() - readsBefore).toBe(2);
		} finally {
			env.cleanup();
		}
	});

	it("hasKtfmtConfig is false for a plain Kotlin project (ktlint stays default)", () => {
		const env = setupTestEnvironment("pi-lens-tool-policy-ktfmt-absent-");
		try {
			createTempFile(env.tmpDir, "build.gradle.kts", "plugins {\n}\n");
			expect(hasKtfmtConfig(env.tmpDir)).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("hasJavaBuildDescriptor detects pom.xml / build.gradle{.kts} walking up (#133)", () => {
		for (const descriptor of ["pom.xml", "build.gradle", "build.gradle.kts"]) {
			const env = setupTestEnvironment("pi-lens-java-descriptor-");
			try {
				createTempFile(env.tmpDir, descriptor, "");
				const subDir = path.join(env.tmpDir, "src", "main", "java");
				fs.mkdirSync(subDir, { recursive: true });
				expect(hasJavaBuildDescriptor(subDir), descriptor).toBe(true);
			} finally {
				env.cleanup();
			}
		}
	});

	it("hasJavaBuildDescriptor is false for a non-Java project (#133)", () => {
		const env = setupTestEnvironment("pi-lens-java-none-");
		try {
			createTempFile(env.tmpDir, "package.json", "{}");
			expect(hasJavaBuildDescriptor(env.tmpDir)).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("findCompiledClassesDir returns the compiled dir when present, else undefined (#133)", () => {
		const env = setupTestEnvironment("pi-lens-java-classes-");
		try {
			// No compiled output yet → undefined (runner skips with a dbg note).
			expect(findCompiledClassesDir(env.tmpDir)).toBeUndefined();
			const classes = path.join(env.tmpDir, "target", "classes");
			fs.mkdirSync(classes, { recursive: true });
			expect(findCompiledClassesDir(env.tmpDir)).toBe(classes);
		} finally {
			env.cleanup();
		}
	});

	it("hasBlackConfig detects [tool.black] in a parent directory pyproject.toml", () => {
		const env = setupTestEnvironment("pi-lens-tool-policy-black-walkup-");
		try {
			createTempFile(
				env.tmpDir,
				"pyproject.toml",
				"[tool.black]\nline-length = 88\n",
			);
			const subDir = path.join(env.tmpDir, "src");
			fs.mkdirSync(subDir, { recursive: true });
			expect(hasBlackConfig(subDir)).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("hasRuffConfig detects ruff.toml in a parent directory", () => {
		const env = setupTestEnvironment("pi-lens-tool-policy-ruff-walkup-toml-");
		try {
			createTempFile(env.tmpDir, "ruff.toml", "line-length = 100\n");
			const subDir = path.join(env.tmpDir, "src");
			fs.mkdirSync(subDir, { recursive: true });
			expect(hasRuffConfig(subDir)).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("hasRuffConfig detects [tool.ruff] in a parent directory pyproject.toml", () => {
		const env = setupTestEnvironment(
			"pi-lens-tool-policy-ruff-walkup-pyproject-",
		);
		try {
			createTempFile(
				env.tmpDir,
				"pyproject.toml",
				"[tool.ruff]\nline-length = 100\n",
			);
			const subDir = path.join(env.tmpDir, "src");
			fs.mkdirSync(subDir, { recursive: true });
			expect(hasRuffConfig(subDir)).toBe(true);
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
		expect(getToolExecutionPolicy("golangci-lint")).toMatchObject({
			gate: "config-first",
			autoInstall: true,
		});
		expect(getToolExecutionPolicy("phpstan")).toMatchObject({
			gate: "config-first",
			autoInstall: false,
		});
		expect(getToolExecutionPolicy("ruff")).toMatchObject({
			gate: "smart-default",
			autoInstall: true,
		});
		expect(getToolExecutionPolicy("biome")).toMatchObject({
			gate: "smart-default",
			autoInstall: true,
		});
		expect(shouldAutoInstallTool("stylelint")).toBe(true);
		expect(shouldAutoInstallTool("mypy")).toBe(true);
		expect(shouldAutoInstallTool("prettier")).toBe(true);
		expect(shouldAutoInstallTool("golangci-lint")).toBe(true);
		expect(shouldAutoInstallTool("phpstan")).toBe(false);
		expect(shouldAutoInstallTool("ruff")).toBe(true);
		expect(shouldAutoInstallTool("jscpd")).toBe(true);
		expect(shouldAutoInstallTool("biome")).toBe(true);
		expect(shouldAutoInstallTool("eslint")).toBe(false);
		expect(shouldAutoInstallTool("unknown-tool")).toBe(false);
	});

	it("exposes centralized tool command specs", () => {
		expect(getToolCommandSpec("markdownlint")?.versionArgs).toEqual([
			"--no-globs",
			"-",
		]);
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
		expect(getToolCommandSpec("ruff")).toMatchObject({
			command: "ruff",
			windowsExt: ".exe",
			managedToolId: "ruff",
		});
		expect(getToolCommandSpec("biome")).toMatchObject({
			command: "biome",
			windowsExt: ".cmd",
			managedToolId: "biome",
		});
		expect(getToolCommandSpec("mypy")).toMatchObject({
			command: "mypy",
			managedToolId: "mypy",
		});
		expect(getToolCommandSpec("phpstan")).toMatchObject({
			command: "phpstan",
			windowsExt: ".bat",
			managedToolId: "phpstan",
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
