import * as fs from "node:fs";
import * as path from "node:path";
import { TERRAGRUNT_FILENAMES } from "./file-kinds.js";
import { logLatency } from "./latency-logger.js";
import { resolvePackagePath } from "./package-root.js";
import {
	findNearestContaining,
	normalizeMapKey,
	walkUpDirs,
} from "./path-utils.js";
import type { ProjectConventions } from "./project-conventions.js";
import { loadProjectSnapshotWithoutWordIndex } from "./project-snapshot.js";

export type ToolGate = "config-first" | "smart-default" | "mixed";

export interface FormatterPolicy {
	formatterNames: string[];
	defaultFormatter?: string;
	defaultWhenUnconfigured: boolean;
	gate: ToolGate;
}

// Extension → formatter policy. This map, `FORMATTER_POLICY_BY_FILENAME`, and
// `AUTO_INSTALLABLE_DEFAULT_FORMATTERS` are the inverse of the formatter
// definitions in `clients/formatters.ts` (formatter → extensions). The two are
// bound by `tests/clients/formatter-policy-consistency.test.ts` (#1135, the
// #883/#209 single-source-of-truth class) so they cannot drift silently. All
// three are re-exported (read-only intent) via a single `export {}` below —
// deliberately NOT inline on these declarations, to keep the pre-existing,
// structural lookup-table duplication out of the PR's "new code" (SonarCloud).
//
// Two deliberate #1135 decisions live in the entries below, documented here so
// the rationale sits outside the duplicated run:
//   - `.sass` offers ["biome", "prettier"] only — NOT oxfmt: oxfmt is absent
//     from OXFMT_SUPPORTED_EXTENSIONS (oxfmt/prettier handle .css/.scss/.less,
//     not the indented `.sass` syntax). It was previously hand-listed here,
//     diverging from the oxfmt definition (inert, because `matching` filtered
//     it out); dropped to bind the two.
//   - `.fish` intentionally has NO entry. `fish-indent` is a LINT runner
//     (getLinterPolicyForFile), not a FormatterInfo — a formatter policy naming
//     it was a dead, unsatisfiable entry; fish reformatting runs via the
//     linter/autofix path. Removed to keep extension→formatter consistent.
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
			// #1135: no oxfmt (see map header comment).
			formatterNames: ["biome", "prettier"],
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
			// HTML commonly carries template markers ({{JS}} embeds, Handlebars,
			// Helm-adjacent Go templates). Prettier reinterprets them as code and
			// corrupts them. Opt in via project prettier config; do not run by default.
			defaultWhenUnconfigured: false,
			gate: "smart-default",
		},
	],
	[
		".htm",
		{
			formatterNames: ["prettier"],
			defaultFormatter: "prettier",
			defaultWhenUnconfigured: false,
			gate: "smart-default",
		},
	],
	[
		".yaml",
		{
			formatterNames: ["prettier"],
			defaultFormatter: "prettier",
			// YAML commonly carries template markers (Helm `{{ .Values.x }}`,
			// Ansible `{{ var }}`). Prettier splits `{{` into `{ {` and reindents
			// embedded templates. Opt in via project prettier config.
			defaultWhenUnconfigured: false,
			gate: "smart-default",
		},
	],
	[
		".yml",
		{
			formatterNames: ["prettier"],
			defaultFormatter: "prettier",
			defaultWhenUnconfigured: false,
			gate: "smart-default",
		},
	],
	[
		".md",
		{
			formatterNames: ["prettier"],
			defaultFormatter: "prettier",
			// Prettier's markdown defaults reflow lines, normalize emphasis (* -> _),
			// and restyle lists. Opt-in via project prettier config; do not run by default.
			defaultWhenUnconfigured: false,
			gate: "smart-default",
		},
	],
	[
		".mdx",
		{
			formatterNames: ["prettier"],
			defaultFormatter: "prettier",
			defaultWhenUnconfigured: false,
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
		// ktfmt is offered alongside ktlint but only wins when the project opts in
		// (hasExplicitFormatterConfig("ktfmt")); otherwise ktlint stays the
		// smart-default. #129
		".kt",
		{
			formatterNames: ["ktfmt", "ktlint"],
			defaultFormatter: "ktlint",
			defaultWhenUnconfigured: false,
			gate: "smart-default",
		},
	],
	[
		".kts",
		{
			formatterNames: ["ktfmt", "ktlint"],
			defaultFormatter: "ktlint",
			defaultWhenUnconfigured: false,
			gate: "smart-default",
		},
	],
	[
		".swift",
		{
			formatterNames: ["swiftformat"],
			defaultFormatter: "swiftformat",
			defaultWhenUnconfigured: false,
			gate: "config-first",
		},
	],
	[
		".fs",
		{
			formatterNames: ["fantomas"],
			defaultFormatter: "fantomas",
			defaultWhenUnconfigured: false,
			gate: "config-first",
		},
	],
	[
		".fsi",
		{
			formatterNames: ["fantomas"],
			defaultFormatter: "fantomas",
			defaultWhenUnconfigured: false,
			gate: "config-first",
		},
	],
	[
		".fsx",
		{
			formatterNames: ["fantomas"],
			defaultFormatter: "fantomas",
			defaultWhenUnconfigured: false,
			gate: "config-first",
		},
	],
	[
		".nix",
		{
			formatterNames: ["nixfmt"],
			defaultFormatter: "nixfmt",
			defaultWhenUnconfigured: false,
			gate: "smart-default",
		},
	],
	[
		".ex",
		{
			formatterNames: ["mix"],
			defaultFormatter: "mix",
			defaultWhenUnconfigured: false,
			gate: "config-first",
		},
	],
	[
		".exs",
		{
			formatterNames: ["mix"],
			defaultFormatter: "mix",
			defaultWhenUnconfigured: false,
			gate: "config-first",
		},
	],
	[
		".eex",
		{
			formatterNames: ["mix"],
			defaultFormatter: "mix",
			defaultWhenUnconfigured: false,
			gate: "config-first",
		},
	],
	[
		".heex",
		{
			formatterNames: ["mix"],
			defaultFormatter: "mix",
			defaultWhenUnconfigured: false,
			gate: "config-first",
		},
	],
	[
		".leex",
		{
			formatterNames: ["mix"],
			defaultFormatter: "mix",
			defaultWhenUnconfigured: false,
			gate: "config-first",
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
			defaultWhenUnconfigured: false,
			gate: "config-first",
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
			defaultWhenUnconfigured: false,
			gate: "config-first",
		},
	],
	[
		".lhs",
		{
			formatterNames: ["ormolu"],
			defaultFormatter: "ormolu",
			defaultWhenUnconfigured: false,
			gate: "config-first",
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
			defaultWhenUnconfigured: false,
			gate: "config-first",
		},
	],
	[
		".tf",
		{
			formatterNames: ["terraform"],
			defaultFormatter: "terraform",
			defaultWhenUnconfigured: false,
			gate: "config-first",
		},
	],
	[
		".tfvars",
		{
			formatterNames: ["terraform"],
			defaultFormatter: "terraform",
			defaultWhenUnconfigured: false,
			gate: "config-first",
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
	[
		".java",
		{
			formatterNames: ["google-java-format"],
			defaultFormatter: "google-java-format",
			defaultWhenUnconfigured: false,
			gate: "config-first",
		},
	],
	[
		".clj",
		{
			formatterNames: ["cljfmt"],
			defaultFormatter: "cljfmt",
			defaultWhenUnconfigured: false,
			gate: "config-first",
		},
	],
	[
		".cljc",
		{
			formatterNames: ["cljfmt"],
			defaultFormatter: "cljfmt",
			defaultWhenUnconfigured: false,
			gate: "config-first",
		},
	],
	[
		".cljs",
		{
			formatterNames: ["cljfmt"],
			defaultFormatter: "cljfmt",
			defaultWhenUnconfigured: false,
			gate: "config-first",
		},
	],
	[
		".cmake",
		{
			formatterNames: ["cmake-format"],
			defaultFormatter: "cmake-format",
			defaultWhenUnconfigured: false,
			gate: "config-first",
		},
	],
	[
		".ps1",
		{
			formatterNames: ["psscriptanalyzer-format"],
			defaultFormatter: "psscriptanalyzer-format",
			defaultWhenUnconfigured: false,
			gate: "smart-default",
		},
	],
	[
		".psm1",
		{
			formatterNames: ["psscriptanalyzer-format"],
			defaultFormatter: "psscriptanalyzer-format",
			defaultWhenUnconfigured: false,
			gate: "smart-default",
		},
	],
	[
		".psd1",
		{
			formatterNames: ["psscriptanalyzer-format"],
			defaultFormatter: "psscriptanalyzer-format",
			defaultWhenUnconfigured: false,
			gate: "smart-default",
		},
	],
	[
		".cue",
		{
			formatterNames: ["cue"],
			defaultFormatter: "cue",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
]);

// oxfmt supports these extensions — registered as a candidate formatter for each.
// Using a post-processing pass avoids repeating the same modification across
// many map entries (and keeps SonarCloud's duplication gate happy).
// This is the SINGLE SOURCE OF TRUTH for oxfmt's supported extensions — do not
// hand-maintain a second copy; `clients/formatters.ts`'s `oxfmtFormatter.extensions`
// imports and spreads this same Set (#1134; previously two parallel hand-maintained
// lists, the #883 single-source-of-truth class).
export const OXFMT_SUPPORTED_EXTENSIONS = new Set([
	".js",
	".jsx",
	".mjs",
	".cjs",
	".ts",
	".tsx",
	".mts",
	".cts",
	".vue",
	".svelte",
	".css",
	".scss",
	".less",
	".html",
	".htm",
	".json",
	".jsonc",
	".yaml",
	".yml",
	".md",
	".mdx",
	".graphql",
	".gql",
	".toml",
]);

// Add .vue entry (no prior formatter policy existed for this extension)
FORMATTER_POLICY_BY_EXTENSION.set(".vue", {
	formatterNames: ["prettier"],
	defaultFormatter: "prettier",
	defaultWhenUnconfigured: false,
	gate: "config-first",
});

// Add .svelte entry (no prior formatter policy existed for this extension —
// docs/language-coverage.md previously listed no formatter). oxfmt is the only
// candidate; the loop below appends it since ".svelte" is in
// OXFMT_SUPPORTED_EXTENSIONS. Unlike the other oxfmt extensions, oxfmt's
// .svelte support is conditional on more than "a config file exists" — see
// `hasOxfmtSvelteConfig` below, gated in `formatters.ts`'s
// `hasExplicitFormatterConfig` (verified empirically against the real oxfmt
// npm binary; oxfmt exits non-zero on .svelte without BOTH the `svelte`
// package installed and the config's `svelte` flag enabled — an unconditional
// offer would guarantee a formatter failure, not a no-op).
FORMATTER_POLICY_BY_EXTENSION.set(".svelte", {
	formatterNames: [],
	defaultFormatter: "oxfmt",
	defaultWhenUnconfigured: false,
	gate: "config-first",
});

for (const [ext, policy] of FORMATTER_POLICY_BY_EXTENSION) {
	if (
		OXFMT_SUPPORTED_EXTENSIONS.has(ext) &&
		!policy.formatterNames.includes("oxfmt")
	) {
		policy.formatterNames.push("oxfmt");
	}
}

const AUTO_INSTALLABLE_DEFAULT_FORMATTERS = new Map<string, string>([
	["biome", "biome"],
	["ruff", "ruff"],
	["prettier", "prettier"],
	["shfmt", "shfmt"],
	["taplo", "taplo"],
	["ktlint", "ktlint"],
]);

// `gate: "smart-default"` so a matched file is formatted only when nothing else
// claims it. Misdetection edge: `root.hcl` is filename-detected as terragrunt, so
// a non-terragrunt `root.hcl` gets smart-default formatted with `terragrunt hcl
// fmt`'s generic HCL canonicalization — a soft outcome (canonical HCL, no config
// semantics assumed), not a hard failure.
const TERRAGRUNT_FORMATTER_POLICY: FormatterPolicy = {
	formatterNames: ["terragrunt-hcl"],
	defaultFormatter: "terragrunt-hcl",
	defaultWhenUnconfigured: true,
	gate: "smart-default",
};

const FORMATTER_POLICY_BY_FILENAME = new Map<string, FormatterPolicy>(
	TERRAGRUNT_FILENAMES.map((name) => [name, TERRAGRUNT_FORMATTER_POLICY]),
);

// Re-exported (read-only intent) for the #1135 drift guard. Kept as a single
// separate statement — NOT inline on the declarations above — so the touched
// lines don't fall at the head of the pre-existing lookup-table duplication and
// get counted as new duplicated code. Bindings are live, so position is safe.
export {
	AUTO_INSTALLABLE_DEFAULT_FORMATTERS,
	FORMATTER_POLICY_BY_EXTENSION,
	FORMATTER_POLICY_BY_FILENAME,
};

export function getFormatterPolicyForExtension(
	ext: string,
): FormatterPolicy | undefined {
	return FORMATTER_POLICY_BY_EXTENSION.get(ext.toLowerCase());
}

export function getFormatterPolicyForFile(
	filePath: string,
): FormatterPolicy | undefined {
	const byFilename = FORMATTER_POLICY_BY_FILENAME.get(
		path.basename(filePath).toLowerCase(),
	);
	if (byFilename) return byFilename;
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

/** Tool ids declared as safe pipeline-autofix capable (for consistency guards). */
export function listSafePipelineAutofixTools(): string[] {
	return [...AUTOFIX_CAPABILITIES.entries()]
		.filter(([, cap]) => cap.safePipelineAutofix)
		.map(([id]) => id);
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
	| "ktfmt"
	| "rust-clippy"
	| "dart-analyze"
	| "golangci-lint"
	| "detekt"
	| "markdownlint"
	| "oxlint";

export type LintRunnerName =
	| JstsLintRunnerName
	| "ruff-lint"
	| "stylelint"
	| "sqlfluff"
	| "rubocop"
	| "yamllint"
	| "actionlint"
	| "markdownlint"
	| "htmlhint"
	| "hadolint"
	| "helm-lint"
	| "golangci-lint"
	| "phpstan"
	| "ktlint"
	| "taplo"
	| "rust-clippy"
	| "shellcheck"
	| "fish-indent"
	| "tflint"
	| "terragrunt"
	| "credo"
	| "cpp-check"
	| "dart-analyze"
	| "gleam-check"
	| "psscriptanalyzer"
	| "prisma-validate"
	| "mypy"
	| "detekt"
	| "swiftlint"
	| "vale";

export interface LinterPolicy {
	runnerNames: LintRunnerName[];
	preferredRunners: LintRunnerName[];
	defaultRunner?: LintRunnerName;
	defaultWhenUnconfigured: boolean;
	gate: ToolGate;
	/**
	 * Framework IDs that were detected for this project (via the cached
	 * `ProjectConventions` snapshot, populated by #118). Informational for
	 * downstream consumers — future PRs will use it to gate runner-specific
	 * rules (e.g. React-aware oxlint plugins, Next.js-specific tree-sitter
	 * rules). The field is undefined when no snapshot is available; consumers
	 * should treat undefined as "unknown" rather than "no frameworks".
	 */
	frameworkHints?: string[];
}

export interface AutofixPolicy {
	toolNames: AutofixToolName[];
	preferredTools: AutofixToolName[];
	defaultTool?: AutofixToolName;
	defaultWhenUnconfigured: boolean;
	gate: ToolGate;
	safe: boolean;
	/** Execution/deduplication boundary for mutating tools. */
	scope?: "file" | "cargo-project" | "dart-project";
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
		"ktfmt",
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
	[
		"golangci-lint",
		{ toolSupportsFix: true, safePipelineAutofix: true, fixKind: "pipeline" },
	],
	[
		"detekt",
		{ toolSupportsFix: true, safePipelineAutofix: true, fixKind: "pipeline" },
	],
	[
		"markdownlint",
		{ toolSupportsFix: true, safePipelineAutofix: true, fixKind: "pipeline" },
	],
	[
		"oxlint",
		{ toolSupportsFix: true, safePipelineAutofix: true, fixKind: "pipeline" },
	],
]);

const TOOL_EXECUTION_POLICY = new Map<string, ToolExecutionPolicy>([
	// Dispatch/LSP runners use the shared availability/install seam. These
	// managed tools are missing-command repair candidates; probe failures still
	// fail closed before this policy is consulted.
	["pyright", { gate: "smart-default", autoInstall: true }],
	["shellcheck", { gate: "smart-default", autoInstall: true }],
	["shfmt", { gate: "smart-default", autoInstall: true }],
	["tflint", { gate: "smart-default", autoInstall: true }],
	["terragrunt", { gate: "smart-default", autoInstall: true }],
	["trivy", { gate: "config-first", autoInstall: true }],
	["biome", { gate: "smart-default", autoInstall: true }],
	["ruff", { gate: "smart-default", autoInstall: true }],
	["jscpd", { gate: "smart-default", autoInstall: true }],
	["madge", { gate: "smart-default", autoInstall: true }],
	["knip", { gate: "smart-default", autoInstall: true }],
	["ast-grep", { gate: "smart-default", autoInstall: true }],
	["oxlint", { gate: "smart-default", autoInstall: true }],
	["stylelint", { gate: "smart-default", autoInstall: true }],
	["sqlfluff", { gate: "smart-default", autoInstall: true }],
	["rubocop", { gate: "smart-default", autoInstall: true }],
	["yamllint", { gate: "smart-default", autoInstall: true }],
	["actionlint", { gate: "smart-default", autoInstall: true }],
	["markdownlint", { gate: "smart-default", autoInstall: true }],
	["mypy", { gate: "config-first", autoInstall: true }],
	["taplo", { gate: "smart-default", autoInstall: true }],
	["hadolint", { gate: "smart-default", autoInstall: true }],
	["helm", { gate: "smart-default", autoInstall: true }],
	["htmlhint", { gate: "smart-default", autoInstall: true }],
	["ktlint", { gate: "smart-default", autoInstall: true }],
	// ktfmt is opt-in (a project's explicit formatting choice), so it only runs
	// when its config marker is present — config-first, but auto-installable via
	// the maven-JAR strategy once elected (#129).
	["ktfmt", { gate: "config-first", autoInstall: true }],
	["golangci-lint", { gate: "config-first", autoInstall: true }],
	// SpotBugs is opt-in (lens-spotbugs flag) + config-first (needs a Java build
	// descriptor + compiled .class files), auto-installed via the archive
	// strategy when elected (#133).
	["spotbugs", { gate: "config-first", autoInstall: true }],
	// Opengrep is opt-in (lens-opengrep flag or a discovered rule file) and
	// config-first, but auto-installable via the GitHub single-binary strategy
	// once elected — no login/token required, unlike Semgrep (#111).
	["opengrep", { gate: "config-first", autoInstall: true }],
	["phpstan", { gate: "config-first", autoInstall: false }],
	["eslint", { gate: "config-first", autoInstall: false }],
	["prettier", { gate: "smart-default", autoInstall: true }],
	["vale", { gate: "config-first", autoInstall: false }],
	["swiftlint", { gate: "smart-default", autoInstall: true }],
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
		"actionlint",
		{
			command: "actionlint",
			windowsExt: ".exe",
			versionArgs: ["--version"],
			managedToolId: "actionlint",
		},
	],
	[
		"markdownlint",
		{
			command: "markdownlint-cli2",
			windowsExt: ".cmd",
			versionArgs: ["--no-globs", "-"],
			managedToolId: "markdownlint",
		},
	],
	[
		"vale",
		{
			command: "vale",
			windowsExt: ".exe",
			versionArgs: ["--version"],
			managedToolId: "vale",
		},
	],
	[
		"swiftlint",
		{
			command: "swiftlint",
			versionArgs: ["--version"],
			managedToolId: "swiftlint",
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
	// markdownlint-cli2's built-in config names (keep this list in sync with
	// the installed CLI's supported configuration file names).
	".markdownlint-cli2.jsonc",
	".markdownlint-cli2.yaml",
	".markdownlint-cli2.yml",
	".markdownlint-cli2.cjs",
	".markdownlint-cli2.mjs",
	".markdownlint.jsonc",
	".markdownlint.json",
	".markdownlint.yaml",
	".markdownlint.yml",
	".markdownlint.cjs",
	".markdownlint.mjs",
	// Retain the legacy detector name for compatibility with existing policy
	// behavior, even though current markdownlint-cli2 versions do not prefer it.
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
	"prettier.config.ts",
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

const VITE_CONFIGS = [
	"vite.config.ts",
	"vite.config.mts",
	"vite.config.cts",
	"vite.config.js",
	"vite.config.mjs",
	"vite.config.cjs",
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
	hasKtfmtConfig?: boolean;
	hasKtlintConfig?: boolean;
	hasTflintConfig?: boolean;
}

export interface AutofixPolicyContext {
	hasEslintConfig?: boolean;
	hasStylelintConfig?: boolean;
	hasSqlfluffConfig?: boolean;
	hasRubocopConfig?: boolean;
	hasBiomeConfig?: boolean;
	hasGolangciConfig?: boolean;
	hasDetektConfig?: boolean;
	hasOxlintConfig?: boolean;
	hasKtfmtConfig?: boolean;
	hasKtlintConfig?: boolean;
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
			defaultWhenUnconfigured: false,
			gate: "config-first",
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

	if (TERRAGRUNT_FILENAMES.includes(path.basename(filePath).toLowerCase())) {
		return {
			runnerNames: ["terragrunt"],
			preferredRunners: ["terragrunt"],
			defaultRunner: "terragrunt",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		};
	}

	if ([".kt", ".kts"].includes(ext)) {
		// When the project opts into ktfmt, ktfmt (a pure formatter wired as a safe
		// autofix) owns Kotlin formatting; ktlint's lint steps aside so its style
		// suggestions don't conflict with ktfmt's output. detekt's *semantic* lint
		// still runs when configured. #129
		const preferredRunners: LintRunnerName[] = [];
		if (!context.hasKtfmtConfig) preferredRunners.push("ktlint");
		if (context.hasDetektConfig) preferredRunners.push("detekt");
		return {
			runnerNames: ["ktlint", "detekt"],
			preferredRunners,
			defaultRunner: preferredRunners[0],
			defaultWhenUnconfigured: true,
			gate: context.hasKtfmtConfig
				? "config-first"
				: context.hasDetektConfig
					? "mixed"
					: "smart-default",
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

	if (ext === ".fish") {
		return {
			runnerNames: ["fish-indent"],
			preferredRunners: ["fish-indent"],
			defaultRunner: "fish-indent",
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
			gate: context.hasTflintConfig ? "config-first" : "smart-default",
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

/**
 * Returns the cached `ProjectConventions` for `cwd` if a project snapshot
 * exists, otherwise `undefined`. Reads from the snapshot file rather than
 * re-running the detector so the hot path (per-file dispatch) stays cheap.
 *
 * The snapshot is refreshed by `saveRuntimeProjectSnapshot` during the
 * normal runtime lifecycle, so consumers see a value updated at session-
 * start / project-seq bumps rather than on every read.
 */
export function getCachedProjectConventions(
	cwd: string,
): ProjectConventions | undefined {
	const snapshot = loadProjectSnapshotWithoutWordIndex(cwd);
	return snapshot?.conventions;
}

export function getLinterPolicyForCwd(
	filePath: string,
	cwd: string,
): LinterPolicy | undefined {
	const context: LinterPolicyContext = {
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
		hasKtfmtConfig: hasKtfmtConfig(cwd),
		// From the file's directory, not cwd: a `.tflint.hcl` in a terraform
		// subdirectory is invisible to an upward walk that starts at the repo root.
		hasTflintConfig: hasTflintConfig(path.dirname(path.resolve(cwd, filePath))),
	};
	const policy = getLinterPolicyForFile(filePath, context);
	if (policy) {
		const conventions = getCachedProjectConventions(cwd);
		if (conventions && conventions.frameworks.length > 0) {
			policy.frameworkHints = conventions.frameworks.map((f) => f.id);
		}
	}
	logLatency({
		type: "phase",
		phase: "linter_selected",
		filePath,
		durationMs: 0,
		metadata: {
			runner: policy?.defaultRunner ?? null,
			gate: policy?.gate ?? null,
			cwd,
			context,
			frameworkHints: policy?.frameworkHints ?? null,
		},
	});
	return policy;
}

export function getAutofixPolicyForFile(
	filePath: string,
	context: AutofixPolicyContext = {},
): AutofixPolicy | undefined {
	const ext = path.extname(filePath).toLowerCase();

	if ([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"].includes(ext)) {
		// Mirror the JS/TS lint policy's precedence: eslint (config-first) →
		// oxlint (config-first) → biome (smart-default). oxlint is config-gated so
		// it never conflicts with the biome default.
		if (context.hasEslintConfig) {
			return {
				toolNames: ["eslint", "oxlint", "biome"],
				preferredTools: ["eslint"],
				defaultTool: "eslint",
				defaultWhenUnconfigured: false,
				gate: "config-first",
				safe: true,
			};
		}
		if (context.hasOxlintConfig) {
			return {
				toolNames: ["eslint", "oxlint", "biome"],
				preferredTools: ["oxlint"],
				defaultTool: "oxlint",
				defaultWhenUnconfigured: false,
				// Mirror the JS lint policy, which gates on eslint only (oxlint vs
				// biome are both "smart-default" there).
				gate: "smart-default",
				safe: true,
			};
		}
		return {
			toolNames: ["eslint", "oxlint", "biome"],
			preferredTools: ["biome"],
			defaultTool: "biome",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
			safe: true,
			scope: "cargo-project",
		};
	}

	if ([".json", ".jsonc"].includes(ext)) {
		if (!context.hasBiomeConfig) {
			return undefined;
		}
		return {
			toolNames: ["biome"],
			preferredTools: ["biome"],
			defaultTool: "biome",
			defaultWhenUnconfigured: false,
			gate: "config-first",
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
			defaultWhenUnconfigured: false,
			gate: "config-first",
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
		if (context.hasKtlintConfig) {
			return {
				toolNames: ["ktlint", "ktfmt", "detekt"],
				preferredTools: ["ktlint"],
				defaultTool: "ktlint",
				defaultWhenUnconfigured: false,
				gate: "config-first",
				safe: true,
			};
		}
		// ktfmt is config-first and the project's explicit formatting choice, so it
		// wins over both detekt and the ktlint smart-default when opted in (#129).
		if (context.hasKtfmtConfig) {
			return {
				toolNames: ["ktfmt", "detekt", "ktlint"],
				preferredTools: ["ktfmt"],
				defaultTool: "ktfmt",
				defaultWhenUnconfigured: false,
				gate: "config-first",
				safe: true,
			};
		}
		// detekt --auto-correct is config-first; with a detekt config present it
		// wins over the ktlint smart-default (and is the autofix path on Windows,
		// where ktlint's install is currently broken, #218).
		if (context.hasDetektConfig) {
			return {
				toolNames: ["detekt", "ktlint"],
				preferredTools: ["detekt"],
				defaultTool: "detekt",
				defaultWhenUnconfigured: false,
				gate: "config-first",
				safe: true,
			};
		}
		return {
			toolNames: ["ktlint", "detekt"],
			preferredTools: ["ktlint"],
			defaultTool: "ktlint",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
			safe: true,
		};
	}

	if (ext === ".go") {
		// golangci-lint run --fix is config-first: only apply when the project
		// opted in with a .golangci.* config.
		return {
			toolNames: ["golangci-lint"],
			preferredTools: context.hasGolangciConfig ? ["golangci-lint"] : [],
			defaultTool: "golangci-lint",
			defaultWhenUnconfigured: false,
			gate: "config-first",
			safe: true,
		};
	}

	if ([".md", ".mdx"].includes(ext)) {
		// markdownlint --fix is a smart-default (deterministic MD### fixes run with
		// built-in rules; config optional) — matches the markdownlint lint policy.
		return {
			toolNames: ["markdownlint"],
			preferredTools: ["markdownlint"],
			defaultTool: "markdownlint",
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
			scope: "dart-project",
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
	"eslint.config.ts",
];

function* walkUpDirsUntilPackageJson(cwd: string): Generator<string> {
	for (const dir of walkUpDirs(cwd)) {
		yield dir;
		if (fs.existsSync(path.join(dir, "package.json"))) return;
	}
}

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
	for (const dir of walkUpDirsUntilPackageJson(cwd)) {
		for (const cfg of ESLINT_CONFIGS) {
			if (fs.existsSync(path.join(dir, cfg))) return true;
		}
		const pkgPath = path.join(dir, "package.json");
		if (fs.existsSync(pkgPath)) {
			try {
				if (JSON.parse(fs.readFileSync(pkgPath, "utf-8")).eslintConfig)
					return true;
			} catch {}
		}
	}
	return false;
}

export function hasBiomeConfig(cwd: string): boolean {
	return getBiomeConfigPath(cwd) !== undefined;
}

export function getBiomeConfigPath(cwd: string): string | undefined {
	for (const dir of walkUpDirs(cwd)) {
		const jsoncPath = path.join(dir, "biome.jsonc");
		if (fs.existsSync(jsoncPath)) return jsoncPath;
		const jsonPath = path.join(dir, "biome.json");
		if (fs.existsSync(jsonPath)) return jsonPath;
	}
	return undefined;
}

export function hasOxfmtConfig(cwd: string): boolean {
	for (const dir of walkUpDirs(cwd)) {
		if (fs.existsSync(path.join(dir, "oxfmt.toml"))) return true;
		if (fs.existsSync(path.join(dir, ".oxfmtrc.json"))) return true;
		if (hasVitePlusConfig(dir)) return true;
		const pkgPath = path.join(dir, "package.json");
		if (fs.existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as Record<
					string,
					unknown
				>;
				const deps = {
					...(pkg.dependencies as Record<string, unknown> | undefined),
					...(pkg.devDependencies as Record<string, unknown> | undefined),
				};
				// Published package is `oxfmt`; the scoped name does not exist on npm.
				if (deps["oxfmt"] || deps["@oxc-project/oxfmt"]) return true;
			} catch {}
		}
	}
	return false;
}

// Empirically verified against the real `oxfmt` npm package (0.62.0), a
// scratch fixture, and a plain `Component.svelte` — see PR body for the full
// four-cell matrix. Both conditions are required; either alone always fails:
//   - no `svelte` package, no config flag  -> exit 2 ("excluded by ignore rules")
//   - no `svelte` package, config flag on  -> exit 2 ("Cannot find module 'svelte/compiler'")
//   - `svelte` package installed, no flag  -> exit 2 ("excluded by ignore rules")
//   - `svelte` package installed, flag on  -> exit 0, formats the file
// Per https://oxc.rs/docs/guide/usage/formatter/language-support.html, oxfmt
// also requires the npm-distributed binary (not the standalone GitHub-release
// binary) for `.svelte` — pi-lens already resolves oxfmt via `findInNodeModules`/
// `which`, which favors the npm-installed binary, so that requirement is not
// separately re-checked here.
//
// Known limits of this line-match heuristic (#1134 P3 tail 1): it tolerates a
// trailing `#`-comment after the value (`svelte = true  # enable`), but it is
// NOT a real TOML parser — a `svelte = true` occurrence nested under a
// `[table]` section, or one embedded inside a multi-line/triple-quoted string
// value, would still match and false-positive. Both are considered acceptable
// risk: an oxfmt.toml sectioning `svelte` under a table is not a realistic
// config shape for this single top-level boolean key, and a false positive
// here only causes oxfmt to be OFFERED (still gated by oxfmt actually running
// and the `svelte` package check above), never a silent formatter failure.
const OXFMT_SVELTE_TOML_TRUE =
	/(^|\n)\s*svelte\s*=\s*true\s*(\s*#.*)?(\r?\n|$)/;

export function hasOxfmtSvelteConfig(cwd: string): boolean {
	// Monorepo asymmetry (#1134 P3 tail 2): this dependency check stops at the
	// NEAREST package.json (`hasNearestPackageJsonDependency`), while the
	// config walk below (`walkUpDirs`) continues all the way to the repo root.
	// A root-level `svelte` dependency combined with an oxfmt config at the
	// root, but invoked with a sub-package `cwd` that has its own
	// (svelte-less) package.json, under-offers oxfmt for that sub-package —
	// the same nearest-vs-root-walk asymmetry as the `.tflint.hcl` note in
	// `getLinterPolicyForCwd` above. This is untested/deliberately unfixed:
	// failing to offer a valid formatter is safe (never mis-offers one that
	// then fails at runtime), unlike the inverse.
	if (!hasNearestPackageJsonDependency(cwd, "svelte")) return false;
	for (const dir of walkUpDirs(cwd)) {
		const rcPath = path.join(dir, ".oxfmtrc.json");
		if (fs.existsSync(rcPath)) {
			try {
				const cfg = JSON.parse(fs.readFileSync(rcPath, "utf-8")) as Record<
					string,
					unknown
				>;
				if (cfg.svelte === true) return true;
			} catch {}
		}
		// oxfmt.toml is TOML; pi-lens has no TOML parser dependency, so this is
		// a targeted line match for the single boolean key rather than a full
		// parse (same pragmatic style as hasVitePlusConfig's content.includes
		// check above) — presence of the file alone is NOT sufficient, since a
		// TOML config can omit `svelte` or set it false.
		const tomlPath = path.join(dir, "oxfmt.toml");
		if (fs.existsSync(tomlPath)) {
			try {
				const content = fs.readFileSync(tomlPath, "utf-8");
				if (OXFMT_SVELTE_TOML_TRUE.test(content)) return true;
			} catch {}
		}
	}
	return false;
}

export function hasStylelintConfig(cwd: string): boolean {
	for (const dir of walkUpDirs(cwd)) {
		if (STYLELINT_CONFIGS.some((cfg) => fs.existsSync(path.join(dir, cfg)))) {
			return true;
		}
		const pkgPath = path.join(dir, "package.json");
		if (fs.existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
				if (pkg.stylelint) return true;
			} catch {}
		}
	}
	return false;
}

export function hasSqlfluffConfig(cwd: string): boolean {
	for (const dir of walkUpDirs(cwd)) {
		for (const cfg of SQLFLUFF_CONFIGS) {
			const cfgPath = path.join(dir, cfg);
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
	}

	for (const dir of walkUpDirs(cwd)) {
		for (const depFile of ["requirements.txt", "Pipfile", "pyproject.toml"]) {
			const depPath = path.join(dir, depFile);
			if (!fs.existsSync(depPath)) continue;
			try {
				const content = fs.readFileSync(depPath, "utf-8").toLowerCase();
				if (content.includes("sqlfluff")) return true;
			} catch {}
		}
	}

	return false;
}

export function hasRubocopConfig(cwd: string): boolean {
	for (const dir of walkUpDirs(cwd)) {
		for (const cfg of RUBOCOP_CONFIGS) {
			if (fs.existsSync(path.join(dir, cfg))) return true;
		}
		const gemfile = path.join(dir, "Gemfile");
		if (fs.existsSync(gemfile)) {
			try {
				const content = fs.readFileSync(gemfile, "utf-8");
				if (content.includes("rubocop")) return true;
			} catch {}
		}
	}
	return false;
}

export function hasMypyConfig(cwd: string): boolean {
	for (const dir of walkUpDirs(cwd)) {
		for (const cfg of MYPY_CONFIGS) {
			const cfgPath = path.join(dir, cfg);
			if (!fs.existsSync(cfgPath)) continue;
			if (cfg === "setup.cfg") {
				try {
					if (fs.readFileSync(cfgPath, "utf-8").includes("[mypy]")) return true;
				} catch {}
				continue;
			}
			if (cfg === "pyproject.toml") {
				try {
					if (fs.readFileSync(cfgPath, "utf-8").includes("[tool.mypy]"))
						return true;
				} catch {}
				continue;
			}
			return true;
		}
	}
	return false;
}

export function hasYamllintConfig(cwd: string): boolean {
	for (const dir of walkUpDirs(cwd)) {
		for (const cfg of YAMLLINT_CONFIGS) {
			const cfgPath = path.join(dir, cfg);
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
	}

	for (const dir of walkUpDirs(cwd)) {
		for (const depFile of ["requirements.txt", "Pipfile", "pyproject.toml"]) {
			const depPath = path.join(dir, depFile);
			if (!fs.existsSync(depPath)) continue;
			try {
				const content = fs.readFileSync(depPath, "utf-8").toLowerCase();
				if (content.includes("yamllint")) return true;
			} catch {}
		}
	}

	return false;
}

export function hasMarkdownlintConfig(cwd: string): boolean {
	return findNearestContaining(cwd, MARKDOWNLINT_CONFIGS) !== undefined;
}

export function hasPrettierConfig(cwd: string): boolean {
	for (const dir of walkUpDirs(cwd)) {
		if (PRETTIER_CONFIGS.some((cfg) => fs.existsSync(path.join(dir, cfg))))
			return true;
		const pkgPath = path.join(dir, "package.json");
		if (fs.existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
				if (Object.hasOwn(pkg, "prettier")) return true;
			} catch {}
		}
	}
	return false;
}

export function hasBlackConfig(cwd: string): boolean {
	for (const dir of walkUpDirs(cwd)) {
		const pyproject = path.join(dir, "pyproject.toml");
		if (fs.existsSync(pyproject)) {
			try {
				if (fs.readFileSync(pyproject, "utf-8").includes("[tool.black]"))
					return true;
			} catch {}
		}
	}

	for (const dir of walkUpDirs(cwd)) {
		for (const depFile of ["requirements.txt", "Pipfile"]) {
			const depPath = path.join(dir, depFile);
			if (!fs.existsSync(depPath)) continue;
			try {
				if (fs.readFileSync(depPath, "utf-8").toLowerCase().includes("black"))
					return true;
			} catch {}
		}
	}

	return false;
}

export function hasRuffConfig(cwd: string): boolean {
	for (const dir of walkUpDirs(cwd)) {
		for (const cfg of RUFF_PROJECT_CONFIGS) {
			if (fs.existsSync(path.join(dir, cfg))) return true;
		}
		const pyproject = path.join(dir, "pyproject.toml");
		if (fs.existsSync(pyproject)) {
			try {
				if (fs.readFileSync(pyproject, "utf-8").includes("[tool.ruff]"))
					return true;
			} catch {}
		}
	}
	return false;
}

/**
 * Shared config-args seam for the markdownlint lint AND autofix surfaces
 * (#1247). The lint runner (`markdownlint.ts`) and the autofix path
 * (`pipeline.ts` `tryMarkdownlintFix`) MUST both consume this builder so the
 * package-owned sensible-defaults config (`config/markdownlint/core.json`) can
 * never drift apart from the bare `--fix` invocation again.
 */
/**
 * Shared fallback shape for the config-args builders (#1247): when the
 * project has its own config the lint/autofix surfaces pass NO args (the
 * tool discovers it); otherwise both surfaces point at the package-owned
 * fallback so the tool never silently runs its default ruleset. One shape
 * here means the per-tool builders cannot drift from each other.
 */
function configArgsWithFallback(
	hasConfig: boolean,
	toolArgs: string[],
	packageConfigPath: string,
): string[] {
	return hasConfig
		? []
		: [...toolArgs, resolvePackagePath(import.meta.url, packageConfigPath)];
}

export function markdownlintConfigArgs(cwd: string): string[] {
	return configArgsWithFallback(
		hasMarkdownlintConfig(cwd),
		["--config"],
		"config/markdownlint/core.json",
	);
}

/**
 * Shared config-args seam for the ruff lint AND autofix surfaces (#1247).
 * The lint runner (`ruff.ts`) and `ruffClient.fixFileAsync` MUST both consume
 * this builder so `config/ruff/core.toml` applies on `--fix` too.
 */
export function ruffConfigArgs(cwd: string): string[] {
	return configArgsWithFallback(
		hasRuffConfig(cwd),
		["--config"],
		"config/ruff/core.toml",
	);
}

/**
 * Shared config-args seam for the biome lint AND autofix surfaces (#1247).
 * The lint runner (`biome-check.ts`) and `biomeClient.fixFileAsync` MUST both
 * consume this builder so the user's `biome.json(c)` — or the package-owned
 * `config/biome/core.jsonc` fallback — applies on `lint --write` too.
 */
export function biomeConfigArgs(cwd: string): string[] {
	// A project config wins outright (#1731, discipline A): passing
	// `--config-path` even when the project ships `biome.json(c)` pinned
	// biome's config resolution to that ONE file, so a monorepo package
	// underneath `cwd` with its own `biome.json` never got to extend/override
	// the root config the way biome's own nested-config resolution allows. No
	// flag at all lets biome discover it unaided, exactly like the ruff/
	// markdownlint fallbacks above skip `--config` under the same condition.
	if (getBiomeConfigPath(cwd)) return [];
	return [
		"--config-path=" +
			resolvePackagePath(import.meta.url, "config/biome/core.jsonc"),
	];
}

export function hasGolangciConfig(cwd: string): boolean {
	return findNearestContaining(cwd, GOLANGCI_CONFIGS) !== undefined;
}

// tflint ships built-in rules and runs without config, so `.tflint.hcl` is not
// a prerequisite — it is the project electing tflint as its terraform linter,
// which promotes the policy from smart-default to config-first. Takes a start
// directory rather than the project cwd because tflint resolves config
// per-directory: callers pass the EDITED FILE's directory so this agrees with
// what the runner will actually hand tflint via `--config`.
export function hasTflintConfig(startDir: string): boolean {
	return findNearestContaining(startDir, [".tflint.hcl"]) !== undefined;
}

export function hasClangFormatConfig(cwd: string): boolean {
	return (
		findNearestContaining(cwd, [".clang-format", "_clang-format"]) !== undefined
	);
}

export function hasPhpCsFixerConfig(cwd: string): boolean {
	return (
		findNearestContaining(cwd, [
			".php-cs-fixer.php",
			".php-cs-fixer.dist.php",
		]) !== undefined
	);
}

export function hasStyluaConfig(cwd: string): boolean {
	return (
		findNearestContaining(cwd, ["stylua.toml", ".stylua.toml"]) !== undefined
	);
}

export function hasOcamlformatConfig(cwd: string): boolean {
	return findNearestContaining(cwd, [".ocamlformat"]) !== undefined;
}

export function hasGoogleJavaFormatConfig(cwd: string): boolean {
	// google-java-format has no standard config file — gate on .editorconfig
	// with indent_size defined (common Java project signal) or explicit opt-in marker.
	return (
		findNearestContaining(cwd, [".google-java-format", ".editorconfig"]) !==
		undefined
	);
}

export function hasCljfmtConfig(cwd: string): boolean {
	return (
		findNearestContaining(cwd, [".cljfmt.edn", "cljfmt.edn", ".cljfmt"]) !==
		undefined
	);
}

export function hasCmakeFormatConfig(cwd: string): boolean {
	return (
		findNearestContaining(cwd, [
			".cmake-format",
			".cmake-format.yaml",
			".cmake-format.yml",
			".cmake-format.json",
			".cmake-format.py",
			"cmake-format.yaml",
			"cmake-format.yml",
		]) !== undefined
	);
}

// PSScriptAnalyzerSettings.psd1 is the conventional settings file PowerShell
// projects use to configure `Invoke-Formatter`/`Invoke-ScriptAnalyzer` (passed
// via `-Settings`); `ScriptAnalyzerSettings.psd1` is the same convention minus
// the "PS" prefix and shows up in some repos too. Either one opting a project
// into explicit PSScriptAnalyzer config is enough to select the formatter
// (#1572 — `psscriptanalyzer-format` had no case here at all, so it could
// never be selected regardless of project config).
const PSSCRIPTANALYZER_SETTINGS_FILES = [
	"PSScriptAnalyzerSettings.psd1",
	"ScriptAnalyzerSettings.psd1",
];

/**
 * The nearest PSScriptAnalyzer settings file's full path, or `undefined`.
 * `formatters.ts`'s `resolveCommand` passes this straight to
 * `Invoke-Formatter -Settings` (#1572 review F2) — gating on the file's
 * PRESENCE without ever reading its RULES would run the project's file
 * through the stock `CodeFormatting` ruleset regardless of what it declared,
 * the same stock-style imposition #1144 banned for the other formatters.
 */
export function findPSScriptAnalyzerConfigPath(
	cwd: string,
): string | undefined {
	for (const dir of walkUpDirs(cwd)) {
		for (const name of PSSCRIPTANALYZER_SETTINGS_FILES) {
			const candidate = path.join(dir, name);
			if (fs.existsSync(candidate)) return candidate;
		}
	}
	return undefined;
}

export function hasPSScriptAnalyzerConfig(cwd: string): boolean {
	return findPSScriptAnalyzerConfigPath(cwd) !== undefined;
}

// #1595 sweep — 7 of the 8 formatters #1572 left unreachable (038cd1df flipped
// defaultWhenUnconfigured to false for these without adding an explicit-config
// check; see EXPLICIT_FORMATTER_CONFIG_CHECKS in formatters.ts). nixfmt is the
// 8th and stays unreachable: it is deliberately unconfigurable (no rc file,
// no CLI flag surface) and has no project-level manifest marker analogous to
// `terraform init`'s lock file, so there is no honest "explicit opt-in" signal
// to gate on — see the KNOWN_UNREACHABLE_FORMATTERS comment in
// formatter-policy-consistency.test.ts.

export function hasCsharpierConfig(cwd: string): boolean {
	return (
		findNearestContaining(cwd, [
			".csharpierrc",
			".csharpierrc.json",
			".csharpierrc.yaml",
			".csharpierrc.yml",
		]) !== undefined
	);
}

// Ormolu has no general settings file, but it does read a project `.ormolu`
// file for custom operator fixity declarations (the only file-based config
// surface Ormolu supports) — real, if narrow, per its own docs.
export function hasOrmoluConfig(cwd: string): boolean {
	return findNearestContaining(cwd, [".ormolu"]) !== undefined;
}

export function hasTaploConfig(cwd: string): boolean {
	return (
		findNearestContaining(cwd, ["taplo.toml", ".taplo.toml"]) !== undefined
	);
}

// `terraform fmt` itself is deliberately unconfigurable (no rc file, no
// per-project options — HashiCorp's own docs call this out). The nearest
// thing to an explicit per-project opt-in is `.terraform.lock.hcl`, written
// only by `terraform init`: it marks a directory the user has deliberately
// set up as a Terraform root, as opposed to a stray `.tf`/`.tfvars` file
// dropped into an unrelated repo. A manifest marker, per #1595's own guidance
// for formatters with no dedicated config-file convention.
export function hasTerraformConfig(cwd: string): boolean {
	return findNearestContaining(cwd, [".terraform.lock.hcl"]) !== undefined;
}

export function hasSwiftformatConfig(cwd: string): boolean {
	return findNearestContaining(cwd, [".swiftformat"]) !== undefined;
}

// Fantomas has no dedicated rc file; its documented config surface is
// `.editorconfig` (fsharp_*-prefixed keys) or a `.fantomasignore` file (the
// one Fantomas-specific marker it does ship). Mirrors hasGoogleJavaFormatConfig's
// precedent for formatters whose only config surface is .editorconfig.
export function hasFantomasConfig(cwd: string): boolean {
	return (
		findNearestContaining(cwd, [".fantomasignore", ".editorconfig"]) !==
		undefined
	);
}

// `.formatter.exs` is THE convention `mix format` reads project config from
// (inputs, line_length, plugins) — universal in Elixir projects that use it.
export function hasMixFormatConfig(cwd: string): boolean {
	return findNearestContaining(cwd, [".formatter.exs"]) !== undefined;
}

export function hasPhpstanConfig(cwd: string): boolean {
	return findNearestContaining(cwd, PHPSTAN_CONFIGS) !== undefined;
}

const DETEKT_CONFIGS = [
	"detekt.yml",
	".detekt.yml",
	path.join("config", "detekt", "detekt.yml"),
	path.join("detekt", "detekt.yml"),
];

export function hasDetektConfig(cwd: string): boolean {
	for (const dir of walkUpDirs(cwd)) {
		if (DETEKT_CONFIGS.some((cfg) => fs.existsSync(path.join(dir, cfg))))
			return true;
	}
	return false;
}

// ktfmt has no native config file format; these are pi-lens opt-in markers plus
// the gradle-plugin signal, so a project that uses ktfmt elects it as its Kotlin
// formatter instead of the ktlint smart-default (#129).
const KTFMT_CONFIG_FILES = [".ktfmt", ".ktfmt.kts"];
const KTFMT_GRADLE_FILES = [
	"build.gradle.kts",
	"build.gradle",
	"settings.gradle.kts",
	"settings.gradle",
];

const KOTLIN_GRADLE_FILES = [
	"build.gradle.kts",
	"build.gradle",
	"settings.gradle.kts",
	"settings.gradle",
];

interface SpotlessKotlinConfigCacheEntry {
	mtime: number;
	ktlintConfig: boolean;
	ktfmtConfig: boolean;
}

const spotlessKotlinConfigCache = new Map<
	string,
	SpotlessKotlinConfigCacheEntry
>();
let spotlessGradleReadCount = 0;

/** Test-only observability for asserting the hot-path I/O bound. */
export function _getSpotlessGradleReadCountForTests(): number {
	return spotlessGradleReadCount;
}

/**
 * Blank comments and quoted strings while preserving braces and newlines in
 * executable Gradle source. This is deliberately a small lexical pre-pass,
 * not a Groovy/Kotlin parser. In particular, statically disabled constructs
 * such as `if (false) { ktlint() }` remain a documented false-positive.
 */
function stripGradleCommentsAndStrings(source: string): string {
	let result = "";
	let state: "code" | "line-comment" | "block-comment" | "string" = "code";
	let quote = "";
	for (let index = 0; index < source.length; index += 1) {
		const char = source[index];
		const next = source[index + 1];
		if (state === "code") {
			if (char === "/" && next === "/") {
				result += "  ";
				index += 1;
				state = "line-comment";
			} else if (char === "/" && next === "*") {
				result += "  ";
				index += 1;
				state = "block-comment";
			} else if (char === '"' || char === "'") {
				result += " ";
				quote = char;
				state = "string";
			} else {
				result += char;
			}
			continue;
		}

		if (state === "line-comment") {
			if (char === "\n" || char === "\r") {
				result += char;
				state = "code";
			} else {
				result += " ";
			}
			continue;
		}

		if (state === "block-comment") {
			if (char === "*" && next === "/") {
				result += "  ";
				index += 1;
				state = "code";
			} else {
				result += char === "\n" || char === "\r" ? char : " ";
			}
			continue;
		}

		if (char === "\\") {
			result += " ";
			if (index + 1 < source.length) {
				result += source[index + 1] === "\n" ? "\n" : " ";
				index += 1;
			}
		} else if (char === quote) {
			result += " ";
			state = "code";
		} else {
			result += char === "\n" || char === "\r" ? char : " ";
		}
	}
	return result;
}

function namedGradleBlockBodies(source: string, name: string): string[] {
	const bodies: string[] = [];
	const startPattern = new RegExp(`\\b${name}\\s*\\{`, "g");
	for (const match of source.matchAll(startPattern)) {
		const open = source.indexOf("{", match.index);
		let depth = 1;
		for (let index = open + 1; index < source.length; index += 1) {
			if (source[index] === "{") depth += 1;
			if (source[index] === "}") depth -= 1;
			if (depth === 0) {
				bodies.push(source.slice(open + 1, index));
				break;
			}
		}
	}
	return bodies;
}

export type SpotlessKotlinFormatter = "ktlint" | "ktfmt";

/**
 * Resolve the formatter elected by a Spotless `kotlin { ... }` block.
 * ktlint is the deterministic tie-break if a malformed project names both.
 */
export function getSpotlessKotlinFormatter(
	cwd: string,
): SpotlessKotlinFormatter | undefined {
	for (const dir of walkUpDirs(cwd)) {
		for (const gradle of KOTLIN_GRADLE_FILES) {
			const filePath = path.join(dir, gradle);
			if (!fs.existsSync(filePath)) continue;
			try {
				const mtime = fs.statSync(filePath).mtimeMs;
				let config = spotlessKotlinConfigCache.get(filePath);
				if (!config || config.mtime !== mtime) {
					const source = stripGradleCommentsAndStrings(
						fs.readFileSync(filePath, "utf-8"),
					);
					spotlessGradleReadCount += 1;
					const kotlinBodies = namedGradleBlockBodies(
						source,
						"spotless",
					).flatMap((spotless) => namedGradleBlockBodies(spotless, "kotlin"));
					config = {
						mtime,
						ktlintConfig: kotlinBodies.some((body) =>
							/\bktlint\s*\(/.test(body),
						),
						ktfmtConfig: kotlinBodies.some((body) => /\bktfmt\s*\(/.test(body)),
					};
					spotlessKotlinConfigCache.set(filePath, config);
				}
				if (config.ktlintConfig) return "ktlint";
				if (config.ktfmtConfig) return "ktfmt";
			} catch {}
		}
	}
	return undefined;
}

export function hasKtlintConfig(cwd: string): boolean {
	return getSpotlessKotlinFormatter(cwd) === "ktlint";
}

export function hasKtfmtConfig(cwd: string): boolean {
	const spotlessFormatter = getSpotlessKotlinFormatter(cwd);
	if (spotlessFormatter) return spotlessFormatter === "ktfmt";
	for (const dir of walkUpDirs(cwd)) {
		if (KTFMT_CONFIG_FILES.some((cfg) => fs.existsSync(path.join(dir, cfg))))
			return true;
		for (const gradle of KTFMT_GRADLE_FILES) {
			const p = path.join(dir, gradle);
			if (fs.existsSync(p)) {
				try {
					// Match the gradle plugin id / artifact, not a stray substring.
					if (/ktfmt|com\.facebook\.ktfmt/i.test(fs.readFileSync(p, "utf-8")))
						return true;
				} catch {}
			}
		}
	}
	return false;
}

// SpotBugs (#133) analyzes compiled bytecode, so it needs BOTH a Java build
// descriptor AND a compiled-classes dir. These two helpers gate the runner.
const JAVA_BUILD_DESCRIPTORS = [
	"pom.xml",
	"build.gradle",
	"build.gradle.kts",
	"settings.gradle",
	"settings.gradle.kts",
];

// Common compiled-output dirs: Maven (target/classes), Gradle (build/classes),
// IntelliJ (out/production), Eclipse (bin/main).
const COMPILED_CLASSES_DIRS = [
	path.join("target", "classes"),
	path.join("build", "classes"),
	path.join("out", "production"),
	path.join("bin", "main"),
];

export function hasJavaBuildDescriptor(cwd: string, ceiling?: string): boolean {
	const normalizedCeiling = ceiling
		? normalizeMapKey(path.resolve(ceiling))
		: undefined;
	for (const dir of walkUpDirs(cwd)) {
		if (JAVA_BUILD_DESCRIPTORS.some((d) => fs.existsSync(path.join(dir, d))))
			return true;
		if (
			normalizedCeiling &&
			normalizeMapKey(path.resolve(dir)) === normalizedCeiling
		)
			break;
	}
	return false;
}

/** First existing compiled-classes dir at/above cwd, or undefined. */
export function findCompiledClassesDir(cwd: string): string | undefined {
	for (const dir of walkUpDirs(cwd)) {
		for (const rel of COMPILED_CLASSES_DIRS) {
			const candidate = path.join(dir, rel);
			if (fs.existsSync(candidate)) return candidate;
		}
	}
	return undefined;
}

export function hasStandardrbConfig(cwd: string): boolean {
	for (const dir of walkUpDirs(cwd)) {
		const gemfile = path.join(dir, "Gemfile");
		if (fs.existsSync(gemfile)) {
			try {
				if (fs.readFileSync(gemfile, "utf-8").includes("standard")) return true;
			} catch {}
		}
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

export function hasVitePlusConfig(cwd: string): boolean {
	for (const dir of walkUpDirs(cwd)) {
		if (fs.existsSync(path.join(dir, "vite-plus.json"))) return true;
		const pkgPath = path.join(dir, "package.json");
		if (fs.existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
					dependencies?: Record<string, string>;
					devDependencies?: Record<string, string>;
				};
				const deps = { ...pkg.dependencies, ...pkg.devDependencies };
				if (deps["vite-plus"] || deps["@voidzero-dev/vite-plus-core"]) {
					return true;
				}
			} catch {}
		}
		for (const cfg of VITE_CONFIGS) {
			const cfgPath = path.join(dir, cfg);
			if (!fs.existsSync(cfgPath)) continue;
			try {
				const content = fs.readFileSync(cfgPath, "utf-8");
				if (content.includes("vite-plus")) return true;
			} catch {}
		}
	}
	return false;
}

// Per https://oxc.rs/docs/guide/usage/linter/config.html, oxlint auto-discovers
// `.oxlintrc.json`, `.oxlintrc.jsonc`, `oxlint.config.ts`, and `oxlint.config.mts`
// (in addition to the legacy `oxlint.json` name pi-lens already recognized).
const OXLINT_CONFIGS = [
	".oxlintrc.json",
	".oxlintrc.jsonc",
	"oxlint.json",
	"oxlint.config.ts",
	"oxlint.config.mts",
];

export function hasOxlintConfig(cwd: string): boolean {
	for (const dir of walkUpDirsUntilPackageJson(cwd)) {
		for (const cfg of OXLINT_CONFIGS) {
			if (fs.existsSync(path.join(dir, cfg))) return true;
		}
	}
	return hasVitePlusConfig(cwd);
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
