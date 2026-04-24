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
			formatterNames: ["biome", "prettier"],
			defaultFormatter: "biome",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".jsx",
		{
			formatterNames: ["biome", "prettier"],
			defaultFormatter: "biome",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".mjs",
		{
			formatterNames: ["biome", "prettier"],
			defaultFormatter: "biome",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".cjs",
		{
			formatterNames: ["biome", "prettier"],
			defaultFormatter: "biome",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".ts",
		{
			formatterNames: ["biome", "prettier"],
			defaultFormatter: "biome",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".tsx",
		{
			formatterNames: ["biome", "prettier"],
			defaultFormatter: "biome",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".mts",
		{
			formatterNames: ["biome", "prettier"],
			defaultFormatter: "biome",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".cts",
		{
			formatterNames: ["biome", "prettier"],
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
]);

const AUTO_INSTALLABLE_DEFAULT_FORMATTERS = new Map<string, string>([
	["biome", "biome"],
	["ruff", "ruff"],
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
	| "rubocop";

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

export function getPreferredAutofixTools(
	filePath: string,
	context: {
		hasEslintConfig?: boolean;
		hasStylelintConfig?: boolean;
		hasSqlfluffConfig?: boolean;
		hasRubocopConfig?: boolean;
	},
): AutofixToolName[] {
	const ext = path.extname(filePath).toLowerCase();

	if ([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"].includes(ext)) {
		if (context.hasEslintConfig) return ["eslint"];
		return ["biome"];
	}

	if ([".json", ".jsonc"].includes(ext)) {
		return ["biome"];
	}

	if ([".py", ".pyi"].includes(ext)) {
		return ["ruff"];
	}

	if ([".css", ".scss", ".sass", ".less"].includes(ext)) {
		return context.hasStylelintConfig ? ["stylelint"] : ["stylelint"];
	}

	if (ext === ".sql") {
		return context.hasSqlfluffConfig ? ["sqlfluff"] : ["sqlfluff"];
	}

	if ([".rb", ".rake", ".gemspec", ".ru"].includes(ext)) {
		return context.hasRubocopConfig ? ["rubocop"] : ["rubocop"];
	}

	return [];
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
	return (
		fs.existsSync(path.join(cwd, "biome.json")) ||
		fs.existsSync(path.join(cwd, "biome.jsonc"))
	);
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
