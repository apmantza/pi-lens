import * as fs from "node:fs";
import * as path from "node:path";

export type ToolGate = "config-first" | "smart-default" | "mixed";

export interface FormatterPolicy {
	formatterNames: string[];
	defaultFormatter?: string;
	defaultWhenUnconfigured: boolean;
	gate: ToolGate;
}

const FORMATTER_POLICY_BY_EXTENSION = new Map<string, FormatterPolicy>([
	[
		".js",
		{
			formatterNames: ["biome", "prettier", "oxfmt"],
			defaultFormatter: "biome",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".jsx",
		{
			formatterNames: ["biome", "prettier", "oxfmt"],
			defaultFormatter: "biome",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".mjs",
		{
			formatterNames: ["biome", "prettier", "oxfmt"],
			defaultFormatter: "biome",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".cjs",
		{
			formatterNames: ["biome", "prettier", "oxfmt"],
			defaultFormatter: "biome",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".ts",
		{
			formatterNames: ["biome", "prettier", "oxfmt"],
			defaultFormatter: "biome",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".tsx",
		{
			formatterNames: ["biome", "prettier", "oxfmt"],
			defaultFormatter: "biome",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".mts",
		{
			formatterNames: ["biome", "prettier", "oxfmt"],
			defaultFormatter: "biome",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".cts",
		{
			formatterNames: ["biome", "prettier", "oxfmt"],
			defaultFormatter: "biome",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".py",
		{
			formatterNames: ["black", "ruff"],
			defaultFormatter: "ruff",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".pyi",
		{
			formatterNames: ["black", "ruff"],
			defaultFormatter: "ruff",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".json",
		{
			formatterNames: ["biome", "prettier"],
			defaultFormatter: "biome",
			defaultWhenUnconfigured: false,
			gate: "mixed",
		},
	],
	[
		".jsonc",
		{
			formatterNames: ["biome", "prettier"],
			defaultFormatter: "biome",
			defaultWhenUnconfigured: false,
			gate: "mixed",
		},
	],
	[
		".css",
		{
			formatterNames: ["biome", "prettier", "oxfmt"],
			defaultFormatter: "biome",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".scss",
		{
			formatterNames: ["biome", "prettier", "oxfmt"],
			defaultFormatter: "biome",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".sass",
		{
			formatterNames: ["biome", "prettier", "oxfmt"],
			defaultFormatter: "biome",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".less",
		{
			formatterNames: ["prettier"],
			defaultFormatter: "prettier",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".html",
		{
			formatterNames: ["prettier"],
			defaultFormatter: "prettier",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".htm",
		{
			formatterNames: ["prettier"],
			defaultFormatter: "prettier",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".yaml",
		{
			formatterNames: ["prettier"],
			defaultFormatter: "prettier",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".yml",
		{
			formatterNames: ["prettier"],
			defaultFormatter: "prettier",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".md",
		{
			formatterNames: ["prettier"],
			defaultFormatter: "prettier",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".mdx",
		{
			formatterNames: ["prettier"],
			defaultFormatter: "prettier",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".graphql",
		{
			formatterNames: ["prettier"],
			defaultFormatter: "prettier",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".gql",
		{
			formatterNames: ["prettier"],
			defaultFormatter: "prettier",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".kt",
		{
			formatterNames: ["ktlint"],
			defaultFormatter: "ktlint",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".kts",
		{
			formatterNames: ["ktlint"],
			defaultFormatter: "ktlint",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".swift",
		{
			formatterNames: ["swiftformat"],
			defaultFormatter: "swiftformat",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".fs",
		{
			formatterNames: ["fantomas"],
			defaultFormatter: "fantomas",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".fsi",
		{
			formatterNames: ["fantomas"],
			defaultFormatter: "fantomas",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".fsx",
		{
			formatterNames: ["fantomas"],
			defaultFormatter: "fantomas",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".nix",
		{
			formatterNames: ["nixfmt"],
			defaultFormatter: "nixfmt",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".ex",
		{
			formatterNames: ["mix"],
			defaultFormatter: "mix",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".exs",
		{
			formatterNames: ["mix"],
			defaultFormatter: "mix",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".eex",
		{
			formatterNames: ["mix"],
			defaultFormatter: "mix",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".heex",
		{
			formatterNames: ["mix"],
			defaultFormatter: "mix",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".leex",
		{
			formatterNames: ["mix"],
			defaultFormatter: "mix",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".gleam",
		{
			formatterNames: ["gleam"],
			defaultFormatter: "gleam",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".c",
		{
			formatterNames: ["clang-format"],
			defaultFormatter: "clang-format",
			defaultWhenUnconfigured: false,
			gate: "config-first",
		},
	],
	[
		".cc",
		{
			formatterNames: ["clang-format"],
			defaultFormatter: "clang-format",
			defaultWhenUnconfigured: false,
			gate: "config-first",
		},
	],
	[
		".cpp",
		{
			formatterNames: ["clang-format"],
			defaultFormatter: "clang-format",
			defaultWhenUnconfigured: false,
			gate: "config-first",
		},
	],
	[
		".cxx",
		{
			formatterNames: ["clang-format"],
			defaultFormatter: "clang-format",
			defaultWhenUnconfigured: false,
			gate: "config-first",
		},
	],
	[
		".h",
		{
			formatterNames: ["clang-format"],
			defaultFormatter: "clang-format",
			defaultWhenUnconfigured: false,
			gate: "config-first",
		},
	],
	[
		".hpp",
		{
			formatterNames: ["clang-format"],
			defaultFormatter: "clang-format",
			defaultWhenUnconfigured: false,
			gate: "config-first",
		},
	],
	[
		".ino",
		{
			formatterNames: ["clang-format"],
			defaultFormatter: "clang-format",
			defaultWhenUnconfigured: false,
			gate: "config-first",
		},
	],
	[
		".php",
		{
			formatterNames: ["php-cs-fixer"],
			defaultFormatter: "php-cs-fixer",
			defaultWhenUnconfigured: false,
			gate: "config-first",
		},
	],
	[
		".cs",
		{
			formatterNames: ["csharpier"],
			defaultFormatter: "csharpier",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".lua",
		{
			formatterNames: ["stylua"],
			defaultFormatter: "stylua",
			defaultWhenUnconfigured: false,
			gate: "config-first",
		},
	],
	[
		".hs",
		{
			formatterNames: ["ormolu"],
			defaultFormatter: "ormolu",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".lhs",
		{
			formatterNames: ["ormolu"],
			defaultFormatter: "ormolu",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".ml",
		{
			formatterNames: ["ocamlformat"],
			defaultFormatter: "ocamlformat",
			defaultWhenUnconfigured: false,
			gate: "config-first",
		},
	],
	[
		".mli",
		{
			formatterNames: ["ocamlformat"],
			defaultFormatter: "ocamlformat",
			defaultWhenUnconfigured: false,
			gate: "config-first",
		},
	],
	[
		".go",
		{
			formatterNames: ["gofmt"],
			defaultFormatter: "gofmt",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".rs",
		{
			formatterNames: ["rustfmt"],
			defaultFormatter: "rustfmt",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".sh",
		{
			formatterNames: ["shfmt"],
			defaultFormatter: "shfmt",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".bash",
		{
			formatterNames: ["shfmt"],
			defaultFormatter: "shfmt",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".toml",
		{
			formatterNames: ["taplo"],
			defaultFormatter: "taplo",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".tf",
		{
			formatterNames: ["terraform"],
			defaultFormatter: "terraform",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".tfvars",
		{
			formatterNames: ["terraform"],
			defaultFormatter: "terraform",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".dart",
		{
			formatterNames: ["dart"],
			defaultFormatter: "dart",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".zig",
		{
			formatterNames: ["zig"],
			defaultFormatter: "zig",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".zon",
		{
			formatterNames: ["zig"],
			defaultFormatter: "zig",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
]);

const AUTO_INSTALLABLE_DEFAULT_FORMATTERS = new Map<string, string>([
	["biome", "biome"],
	["ruff", "ruff"],
	["prettier", "prettier"],
	["shfmt", "shfmt"],
	["taplo", "taplo"],
	["ktlint", "ktlint"],
]);

export function getFormatterPolicyForExtension(
	ext: string,
): FormatterPolicy | undefined {
	return FORMATTER_POLICY_BY_EXTENSION.get(ext.toLowerCase());
}

export function getFormatterPolicyForFile(
	filePath: string,
): FormatterPolicy | undefined {
	return getFormatterPolicyForExtension(path.extname(filePath));
}

export function getSmartDefaultFormatterName(
	filePath: string,
): string | undefined {
	const policy = getFormatterPolicyForFile(filePath);
	if (!policy?.defaultWhenUnconfigured) return undefined;
	return policy.defaultFormatter;
}

export function getAutoInstallToolIdForFormatter(
	formatterName: string,
): string | undefined {
	return AUTO_INSTALLABLE_DEFAULT_FORMATTERS.get(formatterName);
}

export function getToolExecutionPolicy(
	toolId: string,
): ToolExecutionPolicy | undefined {
	return TOOL_EXECUTION_POLICY.get(toolId);
}

export function shouldAutoInstallTool(toolId: string): boolean {
	return getToolExecutionPolicy(toolId)?.autoInstall ?? false;
}

export function getAutofixCapability(
	toolId: string,
): AutofixCapability | undefined {
	return AUTOFIX_CAPABILITIES.get(toolId);
}

export function canToolAutoFix(toolId: string): boolean {
	return getAutofixCapability(toolId)?.toolSupportsFix ?? false;
}

export function isSafePipelineAutofixTool(toolId: string): boolean {
	return getAutofixCapability(toolId)?.safePipelineAutofix ?? false;
}

export function getToolCommandSpec(
	toolId: string,
): ToolCommandSpec | undefined {
	return TOOL_COMMAND_SPECS.get(toolId);
}

export type AutofixToolName =
	| "biome"
	| "eslint"
	| "ruff"
	| "stylelint"
	| "sqlfluff"
	| "rubocop"
	| "ktlint"
	| "rust-clippy"
	| "dart-analyze";

export type LintRunnerName =
	| JstsLintRunnerName
	| "ruff-lint"
	| "stylelint"
	| "sqlfluff"
	| "rubocop"
	| "yamllint"
	| "markdownlint"
	| "htmlhint"
	| "hadolint"
	| "golangci-lint"
	| "phpstan"
	| "ktlint"
	| "taplo"
	| "rust-clippy"
	| "shellcheck"
	| "tflint"
	| "credo"
	| "cpp-check"
	| "dart-analyze"
	| "gleam-check"
	| "psscriptanalyzer"
	| "prisma-validate"
	| "mypy"
	| "detekt";

export interface LinterPolicy {
	runnerNames: LintRunnerName[];
	preferredRunners: LintRunnerName[];
	defaultRunner?: LintRunnerName;
	defaultWhenUnconfigured: boolean;
	gate: ToolGate;
}

export interface AutofixPolicy {
	toolNames: AutofixToolName[];
	preferredTools: AutofixToolName[];
	defaultTool?: AutofixToolName;
	defaultWhenUnconfigured: boolean;
	gate: ToolGate;
	safe: boolean;
}

export interface AutofixCapability {
	toolSupportsFix: boolean;
	safePipelineAutofix: boolean;
	fixKind: "pipeline" | "manual" | "suggestion" | "none";
}

export interface ToolExecutionPolicy {
	gate: ToolGate;
	autoInstall: boolean;
}

export interface ToolCommandSpec {
	command: string;
	windowsExt?: string;
	versionArgs?: string[];
	managedToolId?: string;
}

const AUTOFIX_CAPABILITIES = new Map<string, AutofixCapability>([
	[
		"biome",
		{ toolSupportsFix: true, safePipelineAutofix: true, fixKind: "pipeline" },
	],
	[
		"eslint",
		{ toolSupportsFix: true, safePipelineAutofix: true, fixKind: "pipeline" },
	],
	[
		"ruff",
		{ toolSupportsFix: true, safePipelineAutofix: true, fixKind: "pipeline" },
	],
	[
		"stylelint",
		{ toolSupportsFix: true, safePipelineAutofix: true, fixKind: "pipeline" },
	],
	[
		"sqlfluff",
		{ toolSupportsFix: true, safePipelineAutofix: true, fixKind: "pipeline" },
	],
	[
		"rubocop",
		{ toolSupportsFix: true, safePipelineAutofix: true, fixKind: "pipeline" },
	],
	[
		"ktlint",
		{ toolSupportsFix: true, safePipelineAutofix: true, fixKind: "pipeline" },
	],
	[
		"rust-clippy",
		{ toolSupportsFix: true, safePipelineAutofix: true, fixKind: "pipeline" },
	],
	[
		"dart-analyze",
		{ toolSupportsFix: true, safePipelineAutofix: true, fixKind: "pipeline" },
	],
]);

const TOOL_EXECUTION_POLICY = new Map<string, ToolExecutionPolicy>([
	["biome", { gate: "smart-default", autoInstall: true }],
	["ruff", { gate: "smart-default", autoInstall: true }],
	["oxlint", { gate: "smart-default", autoInstall: true }],
	["stylelint", { gate: "smart-default", autoInstall: true }],
	["sqlfluff", { gate: "smart-default", autoInstall: true }],
	["rubocop", { gate: "smart-default", autoInstall: true }],
	["yamllint", { gate: "smart-default", autoInstall: true }],
	["markdownlint", { gate: "smart-default", autoInstall: true }],
	["mypy", { gate: "config-first", autoInstall: true }],
	["taplo", { gate: "smart-default", autoInstall: true }],
	["hadolint", { gate: "smart-default", autoInstall: true }],
	["htmlhint", { gate: "smart-default", autoInstall: true }],
	["ktlint", { gate: "smart-default", autoInstall: true }],
	["golangci-lint", { gate: "config-first", autoInstall: true }],
	["phpstan", { gate: "config-first", autoInstall: false }],
	["eslint", { gate: "config-first", autoInstall: false }],
	["prettier", { gate: "smart-default", autoInstall: true }],
]);

const TOOL_COMMAND_SPECS = new Map<string, ToolCommandSpec>([
	[
		"eslint",
		{
			command: "eslint",
			windowsExt: ".cmd",
			versionArgs: ["--version"],
			managedToolId: "eslint",
		},
	],
	[
		"stylelint",
		{
			command: "stylelint",
			windowsExt: ".cmd",
			versionArgs: ["--version"],
			managedToolId: "stylelint",
		},
	],
	[
		"sqlfluff",
		{
			command: "sqlfluff",
			windowsExt: ".exe",
			versionArgs: ["--version"],
			managedToolId: "sqlfluff",
		},
	],
	[
		"oxlint",
		{
			command: "oxlint",
			windowsExt: ".exe",
			versionArgs: ["--version"],
			managedToolId: "oxlint",
		},
	],
	[
		"ruff",
		{
			command: "ruff",
			windowsExt: ".exe",
			versionArgs: ["--version"],
			managedToolId: "ruff",
		},
	],
	[
		"biome",
		{
			command: "biome",
			windowsExt: ".cmd",
			versionArgs: ["--version"],
			managedToolId: "biome",
		},
	],
	[
		"rubocop",
		{
			command: "rubocop",
			versionArgs: ["--version"],
			managedToolId: "rubocop",
		},
	],
	[
		"yamllint",
		{
			command: "yamllint",
			windowsExt: ".exe",
			versionArgs: ["--version"],
			managedToolId: "yamllint",
		},
	],
	[
		"markdownlint",
		{
			command: "markdownlint-cli2",
			windowsExt: ".cmd",
			versionArgs: ["--version"],
			managedToolId: "markdownlint",
		},
	],
	[
		"mypy",
		{
			command: "mypy",
			versionArgs: ["--version"],
			managedToolId: "mypy",
		},
	],
	[
		"phpstan",
		{
			command: "phpstan",
			windowsExt: ".bat",
			versionArgs: ["--version"],
			managedToolId: "phpstan",
		},
	],
	[
		"taplo",
		{
			command: "taplo",
			windowsExt: ".exe",
			versionArgs: ["--version"],
			managedToolId: "taplo",
		},
	],
	[
		"hadolint",
		{
			command: "hadolint",
			windowsExt: ".exe",
			versionArgs: ["--version"],
			managedToolId: "hadolint",
		},
	],
	[
		"htmlhint",
		{
			command: "htmlhint",
			versionArgs: ["--version"],
			managedToolId: "htmlhint",
		},
	],
	[
		"ktlint",
		{
			command: "ktlint",
			windowsExt: ".exe",
			versionArgs: ["--version"],
			managedToolId: "ktlint",
		},
	],
	[
		"prettier",
		{
			command: "prettier",
			windowsExt: ".cmd",
			versionArgs: ["--version"],
			managedToolId: "prettier",
		},
	],
]);

const STYLELINT_CONFIGS = [
	".stylelintrc",
	".stylelintrc.json",
	".stylelintrc.jsonc",
	".stylelintrc.yaml",
	".stylelintrc.yml",
	".stylelintrc.js",
	".stylelintrc.cjs",
	"stylelint.config.js",
	"stylelint.config.cjs",
	"stylelint.config.mjs",
];

const SQLFLUFF_CONFIGS = [
	".sqlfluff",
	"pyproject.toml",
	"setup.cfg",
	"tox.ini",
];

const RUBOCOP_CONFIGS = [".rubocop.yml", ".rubocop.yaml"];

const MYPY_CONFIGS = ["mypy.ini", ".mypy.ini", "setup.cfg", "pyproject.toml"];

const YAMLLINT_CONFIGS = [
	".yamllint",
	".yamllint.yml",
	".yamllint.yaml",
	"pyproject.toml",
	"setup.cfg",
	"tox.ini",
];

const MARKDOWNLINT_CONFIGS = [
	".markdownlint.json",
	".markdownlint.jsonc",
	".markdownlint.yaml",
	".markdownlint.yml",
	".markdownlintrc",
];

const PRETTIER_CONFIGS = [
	".prettierrc",
	".prettierrc.json",
	".prettierrc.yml",
	".prettierrc.yaml",
	".prettierrc.js",
	".prettierrc.cjs",
	".prettierrc.mjs",
	"prettier.config.js",
	"prettier.config.cjs",
	"prettier.config.mjs",
];

const RUFF_PROJECT_CONFIGS = ["ruff.toml", ".ruff.toml"];

const GOLANGCI_CONFIGS = [
	".golangci.yml",
	".golangci.yaml",
	".golangci.toml",
	".golangci.json",
];

const PHPSTAN_CONFIGS = [
	"phpstan.neon",
	"phpstan.neon.dist",
	"phpstan.dist.neon",
];

export type JstsLintRunnerName = "eslint" | "oxlint" | "biome-check-json";

export interface JstsLintPolicyContext {
	hasEslintConfig?: boolean;
	hasOxlintConfig?: boolean;
	hasBiomeConfig?: boolean;
}

export interface JstsLintPolicy extends Required<JstsLintPolicyContext> {
	preferredRunners: JstsLintRunnerName[];
	hasExplicitNonBiomeLinter: boolean;
}

export interface LinterPolicyContext {
	hasEslintConfig?: boolean;
	hasOxlintConfig?: boolean;
	hasBiomeConfig?: boolean;
	hasStylelintConfig?: boolean;
	hasSqlfluffConfig?: boolean;
	hasRubocopConfig?: boolean;
	hasYamllintConfig?: boolean;
	hasMarkdownlintConfig?: boolean;
	hasGolangciConfig?: boolean;
	hasPhpstanConfig?: boolean;
	hasMypyConfig?: boolean;
	hasDetektConfig?: boolean;
}

export interface AutofixPolicyContext {
	hasEslintConfig?: boolean;
	hasStylelintConfig?: boolean;
	hasSqlfluffConfig?: boolean;
	hasRubocopConfig?: boolean;
}

export function getLinterPolicyForFile(
	filePath: string,
	context: LinterPolicyContext = {},
): LinterPolicy | undefined {
	const ext = path.extname(filePath).toLowerCase();

	if ([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"].includes(ext)) {
		const policy = getJstsLintPolicy({
			hasEslintConfig: context.hasEslintConfig,
			hasOxlintConfig: context.hasOxlintConfig,
			hasBiomeConfig: context.hasBiomeConfig,
		});
		return {
			runnerNames: ["eslint", "oxlint", "biome-check-json"],
			preferredRunners: policy.preferredRunners,
			defaultRunner: policy.preferredRunners[0],
			defaultWhenUnconfigured:
				!policy.hasEslintConfig && !policy.hasOxlintConfig,
			gate: policy.hasEslintConfig ? "config-first" : "smart-default",
		};
	}

	if ([".py", ".pyi"].includes(ext)) {
		const preferredRunners: LintRunnerName[] = ["ruff-lint"];
		if (context.hasMypyConfig) preferredRunners.push("mypy");
		return {
			runnerNames: ["ruff-lint", "mypy"],
			preferredRunners,
			defaultRunner: "ruff-lint",
			defaultWhenUnconfigured: true,
			gate: context.hasMypyConfig ? "mixed" : "smart-default",
		};
	}

	if ([".css", ".scss", ".sass", ".less"].includes(ext)) {
		return {
			runnerNames: ["stylelint"],
			preferredRunners: ["stylelint"],
			defaultRunner: "stylelint",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		};
	}

	if (ext === ".sql") {
		return {
			runnerNames: ["sqlfluff"],
			preferredRunners: ["sqlfluff"],
			defaultRunner: "sqlfluff",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		};
	}

	if ([".rb", ".rake", ".gemspec", ".ru"].includes(ext)) {
		return {
			runnerNames: ["rubocop"],
			preferredRunners: ["rubocop"],
			defaultRunner: "rubocop",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		};
	}

	if ([".yaml", ".yml"].includes(ext)) {
		return {
			runnerNames: ["yamllint"],
			preferredRunners: ["yamllint"],
			defaultRunner: "yamllint",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		};
	}

	if ([".md", ".mdx"].includes(ext)) {
		return {
			runnerNames: ["markdownlint"],
			preferredRunners: ["markdownlint"],
			defaultRunner: "markdownlint",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		};
	}

	if ([".html", ".htm"].includes(ext)) {
		return {
			runnerNames: ["htmlhint"],
			preferredRunners: ["htmlhint"],
			defaultRunner: "htmlhint",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		};
	}

	if (path.basename(filePath).toLowerCase() === "dockerfile") {
		return {
			runnerNames: ["hadolint"],
			preferredRunners: ["hadolint"],
			defaultRunner: "hadolint",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		};
	}

	if ([".kt", ".kts"].includes(ext)) {
		const preferredRunners: LintRunnerName[] = ["ktlint"];
		if (context.hasDetektConfig) preferredRunners.push("detekt");
		return {
			runnerNames: ["ktlint", "detekt"],
			preferredRunners,
			defaultRunner: "ktlint",
			defaultWhenUnconfigured: true,
			gate: context.hasDetektConfig ? "mixed" : "smart-default",
		};
	}

	if (ext === ".toml") {
		return {
			runnerNames: ["taplo"],
			preferredRunners: ["taplo"],
			defaultRunner: "taplo",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		};
	}

	if (ext === ".go") {
		return {
			runnerNames: ["golangci-lint"],
			preferredRunners: context.hasGolangciConfig ? ["golangci-lint"] : [],
			defaultRunner: "golangci-lint",
			defaultWhenUnconfigured: false,
			gate: "config-first",
		};
	}

	if (ext === ".php") {
		return {
			runnerNames: ["phpstan"],
			preferredRunners: context.hasPhpstanConfig ? ["phpstan"] : [],
			defaultRunner: "phpstan",
			defaultWhenUnconfigured: false,
			gate: "config-first",
		};
	}

	if (ext === ".rs") {
		return {
			runnerNames: ["rust-clippy"],
			preferredRunners: ["rust-clippy"],
			defaultRunner: "rust-clippy",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		};
	}

	if ([".sh", ".bash"].includes(ext)) {
		return {
			runnerNames: ["shellcheck"],
			preferredRunners: ["shellcheck"],
			defaultRunner: "shellcheck",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		};
	}

	if ([".tf", ".tfvars"].includes(ext)) {
		return {
			runnerNames: ["tflint"],
			preferredRunners: ["tflint"],
			defaultRunner: "tflint",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		};
	}

	if ([".ex", ".exs", ".eex", ".heex", ".leex"].includes(ext)) {
		return {
			runnerNames: ["credo"],
			preferredRunners: ["credo"],
			defaultRunner: "credo",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		};
	}

	if ([".c", ".cc", ".cpp", ".cxx", ".h", ".hpp", ".ino"].includes(ext)) {
		return {
			runnerNames: ["cpp-check"],
			preferredRunners: ["cpp-check"],
			defaultRunner: "cpp-check",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		};
	}

	if (ext === ".dart") {
		return {
			runnerNames: ["dart-analyze"],
			preferredRunners: ["dart-analyze"],
			defaultRunner: "dart-analyze",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		};
	}

	if (ext === ".gleam") {
		return {
			runnerNames: ["gleam-check"],
			preferredRunners: ["gleam-check"],
			defaultRunner: "gleam-check",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		};
	}

	if ([".ps1", ".psm1", ".psd1"].includes(ext)) {
		return {
			runnerNames: ["psscriptanalyzer"],
			preferredRunners: ["psscriptanalyzer"],
			defaultRunner: "psscriptanalyzer",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		};
	}

	if (ext === ".prisma") {
		return {
			runnerNames: ["prisma-validate"],
			preferredRunners: ["prisma-validate"],
			defaultRunner: "prisma-validate",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		};
	}

	return undefined;
}

export function getLinterPolicyForCwd(
	filePath: string,
	cwd: string,
): LinterPolicy | undefined {
	return getLinterPolicyForFile(filePath, {
		hasEslintConfig: hasEslintConfig(cwd),
		hasOxlintConfig: hasOxlintConfig(cwd),
		hasBiomeConfig: hasBiomeConfig(cwd),
		hasStylelintConfig: hasStylelintConfig(cwd),
		hasSqlfluffConfig: hasSqlfluffConfig(cwd),
		hasRubocopConfig: hasRubocopConfig(cwd),
		hasYamllintConfig: hasYamllintConfig(cwd),
		hasMarkdownlintConfig: hasMarkdownlintConfig(cwd),
		hasGolangciConfig: hasGolangciConfig(cwd),
		hasPhpstanConfig: hasPhpstanConfig(cwd),
		hasMypyConfig: hasMypyConfig(cwd),
		hasDetektConfig: hasDetektConfig(cwd),
	});
}

export function getAutofixPolicyForFile(
	filePath: string,
	context: AutofixPolicyContext = {},
): AutofixPolicy | undefined {
	const ext = path.extname(filePath).toLowerCase();

	if ([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"].includes(ext)) {
		if (context.hasEslintConfig) {
			return {
				toolNames: ["eslint", "biome"],
				preferredTools: ["eslint"],
				defaultTool: "eslint",
				defaultWhenUnconfigured: false,
				gate: "config-first",
				safe: true,
			};
		}
		return {
			toolNames: ["eslint", "biome"],
			preferredTools: ["biome"],
			defaultTool: "biome",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
			safe: true,
		};
	}

	if ([".json", ".jsonc"].includes(ext)) {
		return {
			toolNames: ["biome"],
			preferredTools: ["biome"],
			defaultTool: "biome",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
			safe: true,
		};
	}

	if ([".py", ".pyi"].includes(ext)) {
		return {
			toolNames: ["ruff"],
			preferredTools: ["ruff"],
			defaultTool: "ruff",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
			safe: true,
		};
	}

	if ([".css", ".scss", ".sass", ".less"].includes(ext)) {
		return {
			toolNames: ["stylelint"],
			preferredTools: ["stylelint"],
			defaultTool: "stylelint",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
			safe: true,
		};
	}

	if (ext === ".sql") {
		return {
			toolNames: ["sqlfluff"],
			preferredTools: ["sqlfluff"],
			defaultTool: "sqlfluff",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
			safe: true,
		};
	}

	if ([".rb", ".rake", ".gemspec", ".ru"].includes(ext)) {
		return {
			toolNames: ["rubocop"],
			preferredTools: ["rubocop"],
			defaultTool: "rubocop",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
			safe: true,
		};
	}

	if ([".kt", ".kts"].includes(ext)) {
		return {
			toolNames: ["ktlint"],
			preferredTools: ["ktlint"],
			defaultTool: "ktlint",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
			safe: true,
		};
	}

	if (ext === ".rs") {
		return {
			toolNames: ["rust-clippy"],
			preferredTools: ["rust-clippy"],
			defaultTool: "rust-clippy",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
			safe: true,
		};
	}

	if (ext === ".dart") {
		return {
			toolNames: ["dart-analyze"],
			preferredTools: ["dart-analyze"],
			defaultTool: "dart-analyze",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
			safe: true,
		};
	}

	return undefined;
}

export function getPreferredAutofixTools(
	filePath: string,
	context: AutofixPolicyContext,
): AutofixToolName[] {
	return getAutofixPolicyForFile(filePath, context)?.preferredTools ?? [];
}

const ESLINT_CONFIGS = [
	".eslintrc",
	".eslintrc.js",
	".eslintrc.cjs",
	".eslintrc.json",
	".eslintrc.yaml",
	".eslintrc.yml",
	"eslint.config.js",
	"eslint.config.mjs",
	"eslint.config.cjs",
];

function findNearestPackageJsonPath(cwd: string): string | undefined {
	let dir = cwd;
	const root = path.parse(dir).root;
	while (true) {
		const pkgPath = path.join(dir, "package.json");
		if (fs.existsSync(pkgPath)) return pkgPath;
		if (dir === root) break;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return undefined;
}

export function hasNearestPackageJsonDependency(
	cwd: string,
	dependencyName: string,
): boolean {
	const pkgPath = findNearestPackageJsonPath(cwd);
	if (!pkgPath) return false;
	try {
		const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
		};
		return Boolean(
			pkg.dependencies?.[dependencyName] ??
				pkg.devDependencies?.[dependencyName],
		);
	} catch {}
	return false;
}

export function hasNearestPackageJsonField(
	cwd: string,
	fieldName: string,
): boolean {
	const pkgPath = findNearestPackageJsonPath(cwd);
	if (!pkgPath) return false;
	try {
		const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as Record<
			string,
			unknown
		>;
		return pkg[fieldName] !== undefined;
	} catch {}
	return false;
}

export function hasEslintConfig(cwd: string): boolean {
	for (const cfg of ESLINT_CONFIGS) {
		if (fs.existsSync(path.join(cwd, cfg))) return true;
	}
	try {
		const pkg = JSON.parse(
			fs.readFileSync(path.join(cwd, "package.json"), "utf-8"),
		);
		if (pkg.eslintConfig) return true;
	} catch {}
	return false;
}

export function hasBiomeConfig(cwd: string): boolean {
	return getBiomeConfigPath(cwd) !== undefined;
}

export function getBiomeConfigPath(cwd: string): string | undefined {
	const jsoncPath = path.join(cwd, "biome.jsonc");
	if (fs.existsSync(jsoncPath)) return jsoncPath;
	const jsonPath = path.join(cwd, "biome.json");
	if (fs.existsSync(jsonPath)) return jsonPath;
	return undefined;
}

export function hasOxfmtConfig(cwd: string): boolean {
	if (fs.existsSync(path.join(cwd, "oxfmt.toml"))) return true;
	try {
		const pkg = JSON.parse(
			fs.readFileSync(path.join(cwd, "package.json"), "utf-8"),
		) as Record<string, unknown>;
		const deps = {
			...(pkg.dependencies as Record<string, unknown> | undefined),
			...(pkg.devDependencies as Record<string, unknown> | undefined),
		};
		if (deps["@oxc-project/oxfmt"]) return true;
	} catch {}
	return false;
}

export function hasStylelintConfig(cwd: string): boolean {
	if (STYLELINT_CONFIGS.some((cfg) => fs.existsSync(path.join(cwd, cfg)))) {
		return true;
	}
	try {
		const pkg = JSON.parse(
			fs.readFileSync(path.join(cwd, "package.json"), "utf-8"),
		);
		if (pkg.stylelint) return true;
	} catch {}
	return false;
}

export function hasSqlfluffConfig(cwd: string): boolean {
	for (const cfg of SQLFLUFF_CONFIGS) {
		const cfgPath = path.join(cwd, cfg);
		if (!fs.existsSync(cfgPath)) continue;
		if (cfg === "pyproject.toml") {
			try {
				const content = fs.readFileSync(cfgPath, "utf-8");
				if (content.includes("[tool.sqlfluff]")) return true;
			} catch {}
			continue;
		}
		if (cfg === "setup.cfg" || cfg === "tox.ini") {
			try {
				const content = fs.readFileSync(cfgPath, "utf-8");
				if (content.includes("[sqlfluff]")) return true;
			} catch {}
			continue;
		}
		return true;
	}

	for (const depFile of ["requirements.txt", "Pipfile", "pyproject.toml"]) {
		const depPath = path.join(cwd, depFile);
		if (!fs.existsSync(depPath)) continue;
		try {
			const content = fs.readFileSync(depPath, "utf-8").toLowerCase();
			if (content.includes("sqlfluff")) return true;
		} catch {}
	}

	return false;
}

export function hasRubocopConfig(cwd: string): boolean {
	for (const cfg of RUBOCOP_CONFIGS) {
		if (fs.existsSync(path.join(cwd, cfg))) return true;
	}
	const gemfile = path.join(cwd, "Gemfile");
	if (fs.existsSync(gemfile)) {
		try {
			const content = fs.readFileSync(gemfile, "utf-8");
			return content.includes("rubocop");
		} catch {}
	}
	return false;
}

export function hasMypyConfig(cwd: string): boolean {
	for (const cfg of MYPY_CONFIGS) {
		const cfgPath = path.join(cwd, cfg);
		if (!fs.existsSync(cfgPath)) continue;
		if (cfg === "setup.cfg") {
			try {
				const content = fs.readFileSync(cfgPath, "utf-8");
				if (content.includes("[mypy]")) return true;
			} catch {}
			continue;
		}
		if (cfg === "pyproject.toml") {
			try {
				const content = fs.readFileSync(cfgPath, "utf-8");
				if (content.includes("[tool.mypy]")) return true;
			} catch {}
			continue;
		}
		return true;
	}
	return false;
}

export function hasYamllintConfig(cwd: string): boolean {
	for (const cfg of YAMLLINT_CONFIGS) {
		const cfgPath = path.join(cwd, cfg);
		if (!fs.existsSync(cfgPath)) continue;
		if (cfg === "pyproject.toml") {
			try {
				const content = fs.readFileSync(cfgPath, "utf-8");
				if (content.includes("[tool.yamllint]")) return true;
			} catch {}
			continue;
		}
		if (cfg === "setup.cfg" || cfg === "tox.ini") {
			try {
				const content = fs.readFileSync(cfgPath, "utf-8");
				if (content.includes("[yamllint]")) return true;
			} catch {}
			continue;
		}
		return true;
	}

	for (const depFile of ["requirements.txt", "Pipfile", "pyproject.toml"]) {
		const depPath = path.join(cwd, depFile);
		if (!fs.existsSync(depPath)) continue;
		try {
			const content = fs.readFileSync(depPath, "utf-8").toLowerCase();
			if (content.includes("yamllint")) return true;
		} catch {}
	}

	return false;
}

export function hasMarkdownlintConfig(cwd: string): boolean {
	return MARKDOWNLINT_CONFIGS.some((cfg) => fs.existsSync(path.join(cwd, cfg)));
}

export function hasPrettierConfig(cwd: string): boolean {
	if (PRETTIER_CONFIGS.some((cfg) => fs.existsSync(path.join(cwd, cfg)))) {
		return true;
	}
	try {
		const pkg = JSON.parse(
			fs.readFileSync(path.join(cwd, "package.json"), "utf-8"),
		);
		if (pkg.prettier) return true;
	} catch {}
	return false;
}

export function hasBlackConfig(cwd: string): boolean {
	const pyproject = path.join(cwd, "pyproject.toml");
	if (fs.existsSync(pyproject)) {
		try {
			if (fs.readFileSync(pyproject, "utf-8").includes("[tool.black]")) {
				return true;
			}
		} catch {}
	}

	for (const depFile of ["requirements.txt", "pyproject.toml", "Pipfile"]) {
		const depPath = path.join(cwd, depFile);
		if (!fs.existsSync(depPath)) continue;
		try {
			const content = fs.readFileSync(depPath, "utf-8").toLowerCase();
			if (content.includes("black")) return true;
		} catch {}
	}

	return false;
}

export function hasRuffConfig(cwd: string): boolean {
	for (const cfg of RUFF_PROJECT_CONFIGS) {
		if (fs.existsSync(path.join(cwd, cfg))) return true;
	}
	const pyproject = path.join(cwd, "pyproject.toml");
	if (fs.existsSync(pyproject)) {
		try {
			return fs.readFileSync(pyproject, "utf-8").includes("[tool.ruff]");
		} catch {}
	}
	return false;
}

export function hasGolangciConfig(cwd: string): boolean {
	return GOLANGCI_CONFIGS.some((cfg) => fs.existsSync(path.join(cwd, cfg)));
}

export function hasClangFormatConfig(cwd: string): boolean {
	return [".clang-format", "_clang-format"].some((cfg) =>
		fs.existsSync(path.join(cwd, cfg)),
	);
}

export function hasPhpCsFixerConfig(cwd: string): boolean {
	return [".php-cs-fixer.php", ".php-cs-fixer.dist.php"].some((cfg) =>
		fs.existsSync(path.join(cwd, cfg)),
	);
}

export function hasStyluaConfig(cwd: string): boolean {
	return ["stylua.toml", ".stylua.toml"].some((cfg) =>
		fs.existsSync(path.join(cwd, cfg)),
	);
}

export function hasOcamlformatConfig(cwd: string): boolean {
	return fs.existsSync(path.join(cwd, ".ocamlformat"));
}

export function hasPhpstanConfig(cwd: string): boolean {
	return PHPSTAN_CONFIGS.some((cfg) => fs.existsSync(path.join(cwd, cfg)));
}

const DETEKT_CONFIGS = [
	"detekt.yml",
	".detekt.yml",
	path.join("config", "detekt", "detekt.yml"),
	path.join("detekt", "detekt.yml"),
];

export function hasDetektConfig(cwd: string): boolean {
	return DETEKT_CONFIGS.some((cfg) => fs.existsSync(path.join(cwd, cfg)));
}

export function hasStandardrbConfig(cwd: string): boolean {
	const gemfile = path.join(cwd, "Gemfile");
	if (fs.existsSync(gemfile)) {
		try {
			return fs.readFileSync(gemfile, "utf-8").includes("standard");
		} catch {}
	}
	return false;
}

export function getRubocopCommand(cwd: string): {
	cmd: string;
	args: string[];
} {
	const gemfile = path.join(cwd, "Gemfile");
	if (fs.existsSync(gemfile)) {
		try {
			const content = fs.readFileSync(gemfile, "utf-8");
			if (content.includes("rubocop")) {
				return { cmd: "bundle", args: ["exec", "rubocop"] };
			}
		} catch {}
	}
	return { cmd: "rubocop", args: [] };
}

export function hasOxlintConfig(cwd: string): boolean {
	return (
		fs.existsSync(path.join(cwd, ".oxlintrc.json")) ||
		fs.existsSync(path.join(cwd, "oxlint.json"))
	);
}

export function getPreferredJstsLintRunners(
	context: JstsLintPolicyContext,
): JstsLintRunnerName[] {
	if (context.hasEslintConfig) return ["eslint"];
	if (context.hasOxlintConfig) return ["oxlint"];
	if (context.hasBiomeConfig) return ["biome-check-json"];
	return ["oxlint", "biome-check-json"];
}

export function getJstsLintPolicy(
	context: JstsLintPolicyContext,
): JstsLintPolicy {
	const hasEslint = !!context.hasEslintConfig;
	const hasOxlint = !!context.hasOxlintConfig;
	const hasBiome = !!context.hasBiomeConfig;
	return {
		hasEslintConfig: hasEslint,
		hasOxlintConfig: hasOxlint,
		hasBiomeConfig: hasBiome,
		preferredRunners: getPreferredJstsLintRunners({
			hasEslintConfig: hasEslint,
			hasOxlintConfig: hasOxlint,
			hasBiomeConfig: hasBiome,
		}),
		hasExplicitNonBiomeLinter: hasEslint || hasOxlint,
	};
}

export function getJstsLintPolicyForCwd(cwd: string): JstsLintPolicy {
	return getJstsLintPolicy({
		hasEslintConfig: hasEslintConfig(cwd),
		hasOxlintConfig: hasOxlintConfig(cwd),
		hasBiomeConfig: hasBiomeConfig(cwd),
	});
}
