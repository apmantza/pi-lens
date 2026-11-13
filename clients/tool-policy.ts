import * as fs from "node:fs";
import * as path from "node:path";
import { normalizeToml } from "./cargo-manifest.js";
import { isJstsFactFile, TERRAGRUNT_FILENAMES } from "./file-kinds.js";
import { recordDegradationOnce } from "./degradation-ledger.js";
import { logLatency } from "./latency-logger.js";
import { resolvePackagePath } from "./package-root.js";
import { relativeInside, walkUpDirs } from "./path-utils.js";
import { hasToolConfig, toolConfigDirs } from "./tool-config-presence.js";
import type { ProjectConventions } from "./project-conventions.js";
import { loadProjectSnapshotWithoutWordIndex } from "./project-snapshot.js";

type ToolGate = "config-first" | "smart-default" | "mixed";

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
//
// #1595 sweep — 7 of the 8 formatters #1572 left unreachable (038cd1df flipped
// defaultWhenUnconfigured to false for these without adding an explicit-config
// check; see EXPLICIT_FORMATTER_CONFIG_CHECKS in formatters.ts). nixfmt is the
// 8th and stays unreachable: it is deliberately unconfigurable (no rc file,
// no CLI flag surface) and has no project-level manifest marker analogous to
// `terraform init`'s lock file, so there is no honest "explicit opt-in" signal
// to gate on — see the KNOWN_UNREACHABLE_FORMATTERS comment in
// formatter-policy-consistency.test.ts.
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
		// (hasExplicitFormatterConfig("ktfmt")). ktlint is the default formatter
		// name, yet as a FORMATTER it also waits for its own Spotless config
		// (`defaultWhenUnconfigured: false`): only ktlint's LINT policy is a
		// smart default. #129, #5408
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
		".typ",
		{
			formatterNames: ["typstyle"],
			defaultFormatter: "typstyle",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		},
	],
	[
		".typc",
		{
			formatterNames: ["typstyle"],
			defaultFormatter: "typstyle",
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
	["typstyle", "typstyle"],
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

// Re-exported (read-only intent) for the #1135 drift guard and the #5418
// registry-parity guard. Kept as a single separate statement — NOT inline on
// the declarations above — so the touched lines don't fall at the head of the
// pre-existing lookup-table duplication and get counted as new duplicated
// code. Bindings are live, so position is safe.
export {
	AUTO_INSTALLABLE_DEFAULT_FORMATTERS,
	FORMATTER_POLICY_BY_EXTENSION,
	FORMATTER_POLICY_BY_FILENAME,
	TOOL_COMMAND_SPECS,
	TOOL_EXECUTION_POLICY,
};

function getFormatterPolicyForExtension(
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

type LintRunnerName =
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
	scope?: "file" | "dart-project";
}

export interface AutofixCapability {
	toolSupportsFix: boolean;
	safePipelineAutofix: boolean;
	fixKind: "pipeline" | "manual" | "suggestion" | "none";
}

export interface ToolExecutionPolicy {
	/**
	 * How this tool's invocation is decided on a project with NO config:
	 * `smart-default` runs on pi-lens's built-in defaults, `config-first` waits
	 * for the project's own config, `mixed` runs by default and widens with
	 * config. This is a per-TOOL statement and is deliberately not the per-file
	 * policy gate (`LinterPolicy.gate`, `FormatterPolicy.gate` and
	 * `AutofixPolicy.gate` answer that for one file, and they can differ: mypy's
	 * row is `config-first` while the Python linter policy for a
	 * mypy-config-free project is `smart-default`). #5418 renamed the field away
	 * from `gate` so one word does not carry both meanings.
	 */
	configEligibility: ToolGate;
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
	["pyright", { configEligibility: "smart-default", autoInstall: true }],
	["shellcheck", { configEligibility: "smart-default", autoInstall: true }],
	["shfmt", { configEligibility: "smart-default", autoInstall: true }],
	["tflint", { configEligibility: "smart-default", autoInstall: true }],
	["terragrunt", { configEligibility: "smart-default", autoInstall: true }],
	["trivy", { configEligibility: "config-first", autoInstall: true }],
	["biome", { configEligibility: "smart-default", autoInstall: true }],
	["ruff", { configEligibility: "smart-default", autoInstall: true }],
	["jscpd", { configEligibility: "smart-default", autoInstall: true }],
	["madge", { configEligibility: "smart-default", autoInstall: true }],
	["knip", { configEligibility: "smart-default", autoInstall: true }],
	["ast-grep", { configEligibility: "smart-default", autoInstall: true }],
	["oxlint", { configEligibility: "smart-default", autoInstall: true }],
	["stylelint", { configEligibility: "smart-default", autoInstall: true }],
	["sqlfluff", { configEligibility: "smart-default", autoInstall: true }],
	["rubocop", { configEligibility: "smart-default", autoInstall: true }],
	["yamllint", { configEligibility: "smart-default", autoInstall: true }],
	["actionlint", { configEligibility: "smart-default", autoInstall: true }],
	["markdownlint", { configEligibility: "smart-default", autoInstall: true }],
	["mypy", { configEligibility: "config-first", autoInstall: true }],
	["taplo", { configEligibility: "smart-default", autoInstall: true }],
	["hadolint", { configEligibility: "smart-default", autoInstall: true }],
	["helm", { configEligibility: "smart-default", autoInstall: true }],
	["htmlhint", { configEligibility: "smart-default", autoInstall: true }],
	["ktlint", { configEligibility: "smart-default", autoInstall: true }],
	// ktfmt is opt-in (a project's explicit formatting choice), so it only runs
	// when its config marker is present — config-first, but auto-installable via
	// the maven-JAR strategy once elected (#129).
	["ktfmt", { configEligibility: "config-first", autoInstall: true }],
	["golangci-lint", { configEligibility: "config-first", autoInstall: true }],
	// SpotBugs is opt-in (lens-spotbugs flag) + config-first (needs a Java build
	// descriptor + compiled .class files), auto-installed via the archive
	// strategy when elected (#133).
	["spotbugs", { configEligibility: "config-first", autoInstall: true }],
	// Opengrep is opt-in (lens-opengrep flag or a discovered rule file) and
	// config-first, but auto-installable via the GitHub single-binary strategy
	// once elected — no login/token required, unlike Semgrep (#111).
	["opengrep", { configEligibility: "config-first", autoInstall: true }],
	["phpstan", { configEligibility: "config-first", autoInstall: false }],
	["eslint", { configEligibility: "config-first", autoInstall: false }],
	["prettier", { configEligibility: "smart-default", autoInstall: true }],
	["vale", { configEligibility: "config-first", autoInstall: false }],
	["swiftlint", { configEligibility: "smart-default", autoInstall: true }],
	// typstyle is the default Typst formatter, so it carries the same
	// smart-default/auto-install row its AUTO_INSTALLABLE_DEFAULT_FORMATTERS
	// entry implies. The formatter path in `clients/formatters.ts` is what
	// installs it; the row exists so the policy table does not disagree with the
	// formatter table about a tool it names (#5418). The row states what already
	// runs, and changes no install decision: whether typstyle should auto-install
	// at all is an open product decision this branch deliberately leaves open.
	["typstyle", { configEligibility: "smart-default", autoInstall: true }],
]);

const TOOL_COMMAND_SPECS = new Map<string, ToolCommandSpec>([
	[
		// No managedToolId: the installer registry has no `eslint` entry (the
		// runner resolves the project's own `node_modules/.bin/eslint` first), so
		// a pointer here named an install path that does not exist (#5418).
		"eslint",
		{
			command: "eslint",
			windowsExt: ".cmd",
			versionArgs: ["--version"],
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
			windowsExt: ".exe",
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
		// No managedToolId: no installer entry for `phpstan` exists, so the
		// pointer resolved to nothing (#5418; auto-install stays an open decision).
		"phpstan",
		{
			command: "phpstan",
			windowsExt: ".bat",
			versionArgs: ["--version"],
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
		// helm 4 has no --version flag ("Error: unknown flag: --version", exit 1);
		// the version lives under a subcommand (#4453).
		"helm",
		{
			command: "helm",
			windowsExt: ".exe",
			versionArgs: ["version", "--short"],
			managedToolId: "helm",
		},
	],
	[
		"trivy",
		{
			command: "trivy",
			windowsExt: ".exe",
			versionArgs: ["--version"],
			managedToolId: "trivy",
		},
	],
	[
		"golangci-lint",
		{
			command: "golangci-lint",
			windowsExt: ".exe",
			versionArgs: ["--version"],
			managedToolId: "golangci-lint",
		},
	],
	[
		// No managedToolId: no installer entry for `detekt` exists, and it has no
		// execution-policy row, so nothing installs it (#5410).
		"detekt",
		{
			command: "detekt",
			windowsExt: ".bat",
			versionArgs: ["--version"],
		},
	],
	[
		// The runtime SpotBugs needs, not a lint tool. The JVM prints its version
		// under `-version`; it has no `--version` flag. No managedToolId: pi-lens
		// never installs a JRE.
		"java",
		{
			command: "java",
			windowsExt: ".exe",
			versionArgs: ["-version"],
		},
	],
	[
		"htmlhint",
		{
			command: "htmlhint",
			windowsExt: ".cmd",
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
	// The formatter binaries (#5410): the formatters resolve these through the
	// runners' ladder machinery (version-checked, one latch per cwd), in their
	// own order, PATH before managed (#5492 r2). Each id is also its installer
	// entry and its binary name.
	...(
		[
			["shfmt", ".exe"],
			["typstyle", ".exe"],
			["ktfmt"],
			["black", ".exe"],
			["google-java-format"],
			["cljfmt", ".exe"],
			["cmake-format", ".exe"],
			["stylua", ".cmd"],
			["oxfmt", ".cmd"],
			["php-cs-fixer", ".bat"],
		] as ReadonlyArray<readonly [string, string?]>
	).map(([id, windowsExt]): [string, ToolCommandSpec] => [
		id,
		{
			command: id,
			...(windowsExt !== undefined && { windowsExt }),
			versionArgs: ["--version"],
			managedToolId: id,
		},
	]),
]);

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

	if (isJstsFactFile(filePath)) {
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
		// The runner lints an unconfigured project on the ANSI dialect (#1937),
		// so the label states that. The formatter is the config-gated surface:
		// `sqlfluff fix` writes, and refuses a project with no `hasSqlfluffConfig`.
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
		// The policy selects credo without config; the runner (`credo.ts`) still
		// skips a directory with no `mix.exs` (a Mix project is the gate there).
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
		hasEslintConfig: hasToolConfig("eslint", cwd),
		hasOxlintConfig: hasToolConfig("oxlint", cwd),
		hasBiomeConfig: hasToolConfig("biome", cwd),
		hasStylelintConfig: hasToolConfig("stylelint", cwd),
		hasSqlfluffConfig: hasToolConfig("sqlfluff", cwd),
		hasRubocopConfig: hasToolConfig("rubocop", cwd),
		hasYamllintConfig: hasToolConfig("yamllint", cwd),
		hasMarkdownlintConfig: hasToolConfig("markdownlint", cwd),
		hasGolangciConfig: hasToolConfig("golangci-lint", cwd),
		hasPhpstanConfig: hasToolConfig("phpstan", cwd),
		hasMypyConfig: hasToolConfig("mypy", cwd),
		hasDetektConfig: hasToolConfig("detekt", cwd),
		hasKtfmtConfig: hasKtfmtConfig(cwd),
		// From the file's directory, not cwd: a `.tflint.hcl` in a terraform
		// subdirectory is invisible to an upward walk that starts at the repo root.
		hasTflintConfig: hasToolConfig(
			"tflint",
			path.dirname(path.resolve(cwd, filePath)),
		),
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

	if (isJstsFactFile(filePath)) {
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

function findNearestPackageJsonPath(cwd: string): string | undefined {
	for (const dir of walkUpDirs(cwd)) {
		const pkgPath = path.join(dir, "package.json");
		if (fs.existsSync(pkgPath)) return pkgPath;
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
// The flag is a top-level TOML key: read from comment-stripped text before the
// first table heading, so `svelte = true` under a `[table]`, in a comment or
// after a `#` is not the flag (#5408; #1134 P3 tail 1 had accepted the first
// as a false positive). A `svelte = true` line inside a multi-line string
// value still matches; that can only OFFER oxfmt, which then runs or fails
// visibly, never a silent formatter failure.
const OXFMT_SVELTE_TOML_TRUE = /^[ \t]*svelte[ \t]*=[ \t]*true[ \t]*$/m;
const TOML_TABLE_HEADING_LINE = /^[ \t]*\[{1,2}[^\]\n]+\]{1,2}[ \t]*$/m;

/** The text of a TOML document before its first table heading, comments stripped. */
function tomlTopLevel(content: string): string {
	const normalized = normalizeToml(content);
	const heading = TOML_TABLE_HEADING_LINE.exec(normalized);
	return heading ? normalized.slice(0, heading.index) : normalized;
}

export function hasOxfmtSvelteConfig(cwd: string): boolean {
	// Monorepo asymmetry (#1134 P3 tail 2): this dependency check stops at the
	// NEAREST package.json (`hasNearestPackageJsonDependency`), while the
	// config walk below (`toolConfigDirs`) continues up to the seam's stop rule.
	// A root-level `svelte` dependency combined with an oxfmt config at the
	// root, but invoked with a sub-package `cwd` that has its own
	// (svelte-less) package.json, under-offers oxfmt for that sub-package —
	// the same nearest-vs-root-walk asymmetry as the `.tflint.hcl` note in
	// `getLinterPolicyForCwd` above. This is untested/deliberately unfixed:
	// failing to offer a valid formatter is safe (never mis-offers one that
	// then fails at runtime), unlike the inverse.
	if (!hasNearestPackageJsonDependency(cwd, "svelte")) return false;
	for (const dir of toolConfigDirs(cwd)) {
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
		// a top-level line match for the single boolean key rather than a full
		// parse — presence of the file alone is NOT sufficient, since a TOML
		// config can omit `svelte` or set it false.
		const tomlPath = path.join(dir, "oxfmt.toml");
		if (fs.existsSync(tomlPath)) {
			try {
				const content = fs.readFileSync(tomlPath, "utf-8");
				if (OXFMT_SVELTE_TOML_TRUE.test(tomlTopLevel(content))) return true;
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
		hasToolConfig("markdownlint", cwd),
		["--config"],
		"config/markdownlint/core.json",
	);
}

/**
 * Shared file-argument seam for the markdownlint lint AND autofix surfaces
 * (#5544). cli2 matches its `ignores` globs against the string it is handed, so
 * both surfaces name the file relative to the dispatch cwd (an absolute path in
 * a lane under `.claude/` matched a glob naming its own ancestor and answered a
 * clean file for lint, and `Linting: 0 files / 0 fixes` for `--fix`); a file the
 * project does
 * not hold keeps the absolute path, because a `../` climb would move config
 * discovery too. A root-level name that cli2's glob parser reads as a modifier
 * (`#` ignore, `!` negation) gets a `./` prefix: the bare name selected nothing
 * and exited 0, so the run reported a silent clean; a nested path never reaches
 * that parser state, so only the root-level name is prefixed.
 */
export function markdownlintTargetArg(cwd: string, filePath: string): string {
	const target = relativeInside(cwd, filePath) ?? filePath;
	return /^[#!]/.test(target) ? `./${target}` : target;
}

/**
 * Shared config-args seam for the ruff lint AND autofix surfaces (#1247).
 * The lint runner (`ruff.ts`) and `ruffClient.fixFileAsync` MUST both consume
 * this builder so `config/ruff/core.toml` applies on `--fix` too.
 */
export function ruffConfigArgs(cwd: string): string[] {
	return configArgsWithFallback(
		hasToolConfig("ruff", cwd),
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
	if (hasToolConfig("biome", cwd)) return [];
	return [
		"--config-path=" +
			resolvePackagePath(import.meta.url, "config/biome/core.jsonc"),
	];
}

// A project that uses ktfmt elects it as its Kotlin formatter instead of the
// ktlint smart-default (#129): the pi-lens opt-in markers (`hasToolConfig
// ("ktfmt")`), a Spotless block, or a mention in these Gradle files.
const KOTLIN_GRADLE_FILES = [
	"build.gradle.kts",
	"build.gradle",
	"settings.gradle.kts",
	"settings.gradle",
];
const GRADLE_KTLINT_PLUGIN_PATTERN =
	/(?:id\s*\(\s*|id\s+|apply\s+plugin\s*:\s*)["']org\.jlleitschuh\.gradle\.ktlint["']/g;
const GRADLE_BUILD_LOGIC_DIRS = ["buildSrc", "build-logic"];
const GRADLE_BUILD_LOGIC_EXTENSIONS = [".gradle", ".gradle.kts", ".kt"];
const GRADLE_INCLUDE_BUILD_PATTERN = /\bincludeBuild\s*\(\s*["']([^"']+)["']/g;
/**
 * Bound the synchronous ownership probe so a large convention tree cannot
 * stall every autofix. Exceeding it is an unknown ownership result, not proof
 * of no owner, and callers must decline the write (#3004).
 */
export const GRADLE_BUILD_LOGIC_SCAN_MAX_ENTRIES = 10_000;

export type GradleKtlintOwnership =
	| { kind: "owned" }
	| { kind: "not-owned" }
	| { kind: "indeterminate" };

interface SpotlessKotlinConfigCacheEntry {
	mtime: number;
	/** Byte length from the same stat: mtime alone misses a same-tick rewrite (#1105). */
	size: number;
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
 * executable Gradle source (`keep: "strings"` blanks only the comments, for a
 * reader that counts a mention in a string such as a plugin id). This is deliberately a small lexical pre-pass,
 * not a Groovy/Kotlin parser. In particular, statically disabled constructs
 * such as `if (false) { ktlint() }` remain a documented false-positive.
 *
 * Exported (with `gradleBlockRanges` below) so `clients/gradle-ktfmt-
 * style.ts` (#2468) reuses this exact pre-pass for the `ktfmt { }` extension
 * block instead of a second hand-rolled Gradle lexer — the same
 * single-source-of-truth reuse `clients/cargo-manifest.ts` did for TOML
 * parsing (#2466).
 */
export function stripGradleCommentsAndStrings(
	source: string,
	/** `"strings"` keeps string contents and blanks only comments. */
	keep?: "strings",
): string {
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
				result += keep === "strings" ? char : " ";
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

		const blank = (kept: string | undefined) =>
			keep === "strings" ? (kept ?? "") : " ";
		if (char === "\\") {
			result += blank(char);
			if (index + 1 < source.length) {
				const escaped = source[index + 1];
				result += escaped === "\n" ? "\n" : blank(escaped);
				index += 1;
			}
		} else if (char === quote) {
			result += blank(char);
			state = "code";
		} else {
			result += char === "\n" || char === "\r" ? char : blank(char);
		}
	}
	return result;
}

/** Half-open `[start, end)` offsets of a named block's body in `source`. */
interface GradleBlockRange {
	start: number;
	end: number;
}

/**
 * A `GradleBlockRange` plus the identifier that introduced it — `""` when the
 * brace pair has none (a bare lambda, an `if (…) { }` body, or the block of a
 * call whose argument list ends in `)`, e.g. `project(":app") { }`).
 */
export interface NamedGradleBlockRange extends GradleBlockRange {
	name: string;
}

const GRADLE_IDENTIFIER_CHAR = /[A-Za-z0-9_$]/;

/**
 * The identifier immediately preceding a `{`, or `""`. Mirrors the
 * `\b<name>\s*\{` shape the named lookup used before it became a filter over
 * this scanner: whitespace (including newlines) between the name and the
 * brace is skipped, and `.` ends the identifier so `com.ncorti.ktfmt { }`
 * still reads as `ktfmt` while `something_ktfmt { }` does not.
 */
function gradleBlockNameBefore(source: string, open: number): string {
	let index = open - 1;
	while (index >= 0 && /\s/.test(source[index])) index -= 1;
	const end = index + 1;
	while (index >= 0 && GRADLE_IDENTIFIER_CHAR.test(source[index])) index -= 1;
	return source.slice(index + 1, end);
}

/**
 * Body ranges of EVERY brace pair in `source`, in source order, each labelled
 * with the identifier that introduced it.
 *
 * This is the repo's only Gradle brace scanner: `namedGradleBlockRanges` and
 * `namedGradleBlockBodies` are filters over it. Scanning every pair — rather
 * than only the pairs whose name a caller thought to ask about — is what lets
 * `clients/gradle-ktfmt-style.ts` (#2468 review round 3) answer "what block
 * ENCLOSES this one?" instead of only "is it inside the one name I checked?".
 * The distinction is load-bearing there: `configure(subprojects.filter { … })
 * { ktfmt { } }`, `project(":app") { ktfmt { } }` and a convention-plugin
 * wrapper all have to be recognized as *some* enclosing scope the resolver
 * cannot evaluate, so it can fail closed rather than treat the block as
 * top-level.
 *
 * Unbalanced braces are best-effort: an unmatched `}` is ignored and an
 * unclosed `{` yields no range, exactly as the previous per-name depth scan
 * behaved.
 */
export function gradleBlockRanges(source: string): NamedGradleBlockRange[] {
	const ranges: NamedGradleBlockRange[] = [];
	const opens: number[] = [];
	for (let index = 0; index < source.length; index += 1) {
		const char = source[index];
		if (char === "{") {
			opens.push(index);
			continue;
		}
		if (char !== "}") continue;
		const open = opens.pop();
		if (open === undefined) continue;
		ranges.push({
			name: gradleBlockNameBefore(source, open),
			start: open + 1,
			end: index,
		});
	}
	// Pairs are completed innermost-first; callers want source order.
	return ranges.sort((a, b) => a.start - b.start);
}

/**
 * Body ranges of every `<name> { ... }` block, in source order.
 *
 * The offsets exist so a caller can ask where a block sits RELATIVE to
 * another one — `clients/gradle-ktfmt-style.ts` (#2468) needs to know which
 * block encloses a `ktfmt { }` one, because Gradle's `subprojects { }`
 * applies it to the children and NOT to the project declaring it, while
 * `allprojects { }` applies to both. Containment of two ranges is the only
 * reliable way to answer that; matching body TEXT would collide whenever two
 * blocks happen to have identical bodies. `namedGradleBlockBodies` stays the
 * ergonomic form for callers that only need the text.
 */
function namedGradleBlockRanges(
	source: string,
	name: string,
): GradleBlockRange[] {
	return gradleBlockRanges(source).filter((range) => range.name === name);
}

function namedGradleBlockBodies(source: string, name: string): string[] {
	return namedGradleBlockRanges(source, name).map((range) =>
		source.slice(range.start, range.end),
	);
}

export type SpotlessKotlinFormatter = "ktlint" | "ktfmt";

/**
 * Resolve the formatter elected by a Spotless `kotlin { ... }` block.
 * ktlint is the deterministic tie-break if a malformed project names both.
 */
export function getSpotlessKotlinFormatter(
	cwd: string,
): SpotlessKotlinFormatter | undefined {
	for (const dir of toolConfigDirs(cwd)) {
		for (const gradle of KOTLIN_GRADLE_FILES) {
			const filePath = path.join(dir, gradle);
			if (!fs.existsSync(filePath)) continue;
			try {
				const { mtimeMs: mtime, size } = fs.statSync(filePath);
				let config = spotlessKotlinConfigCache.get(filePath);
				if (!config || config.mtime !== mtime || config.size !== size) {
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
						size,
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

/**
 * Whether Gradle build logic applies the ktlint Gradle plugin. The plugin
 * establishes project ownership of ktlint, but its plugin version is not a
 * ktlint CLI version and must never be used as one (#3000).
 */
export function hasGradleKtlintPlugin(cwd: string): GradleKtlintOwnership {
	const files = new Set<string>();
	const scan = { entries: 0, exceeded: false, indeterminate: false };
	for (const dir of toolConfigDirs(cwd)) {
		for (const gradle of KOTLIN_GRADLE_FILES) {
			const filePath = path.join(dir, gradle);
			if (fs.existsSync(filePath)) files.add(filePath);
		}
		for (const buildLogicDir of GRADLE_BUILD_LOGIC_DIRS) {
			if (
				!addGradleBuildLogicFiles(path.join(dir, buildLogicDir), files, scan)
			) {
				scan.exceeded = true;
			}
		}
		for (const settings of ["settings.gradle.kts", "settings.gradle"]) {
			const settingsPath = path.join(dir, settings);
			if (!fs.existsSync(settingsPath)) continue;
			try {
				const raw = fs.readFileSync(settingsPath, "utf-8");
				const stripped = stripGradleCommentsAndStrings(raw);
				GRADLE_INCLUDE_BUILD_PATTERN.lastIndex = 0;
				let match: RegExpExecArray | null;
				while ((match = GRADLE_INCLUDE_BUILD_PATTERN.exec(raw)) !== null) {
					const code = stripped.slice(
						match.index,
						match.index + match[0].length,
					);
					const includedBuild = match[1];
					if (includedBuild && /^\s*includeBuild\s*\(\s*/.test(code)) {
						if (
							!addGradleBuildLogicFiles(
								path.resolve(dir, includedBuild),
								files,
								scan,
							)
						) {
							scan.exceeded = true;
						}
					}
				}
			} catch {
				scan.indeterminate = true;
			}
		}
	}
	if (scan.exceeded) {
		recordDegradationOnce({
			kind: "gradle-ktlint-scan-budget-exceeded",
			subject: "ktlint:gradle-build-logic",
			reason:
				`Gradle build-logic ownership scan exceeded its ${GRADLE_BUILD_LOGIC_SCAN_MAX_ENTRIES}-entry budget; ` +
				"ownership cannot be established, so ktlint autofix is declined",
		});
		return { kind: "indeterminate" };
	}
	if (scan.indeterminate) return { kind: "indeterminate" };
	for (const filePath of files) {
		try {
			const raw = fs.readFileSync(filePath, "utf-8");
			const stripped = stripGradleCommentsAndStrings(raw);
			GRADLE_KTLINT_PLUGIN_PATTERN.lastIndex = 0;
			let match: RegExpExecArray | null;
			while ((match = GRADLE_KTLINT_PLUGIN_PATTERN.exec(raw)) !== null) {
				const code = stripped.slice(match.index, match.index + match[0].length);
				if (!/^\s*$/.test(code)) return { kind: "owned" };
			}
		} catch {
			return { kind: "indeterminate" };
		}
	}
	return { kind: "not-owned" };
}

function addGradleBuildLogicFiles(
	root: string,
	files: Set<string>,
	scan: { entries: number; indeterminate: boolean },
): boolean {
	if (!fs.existsSync(root)) return true;
	const pending = [root];
	while (pending.length > 0) {
		const dir = pending.pop();
		if (!dir) continue;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			scan.indeterminate = true;
			continue;
		}
		for (const entry of entries) {
			scan.entries += 1;
			if (scan.entries > GRADLE_BUILD_LOGIC_SCAN_MAX_ENTRIES) return false;
			const entryPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				pending.push(entryPath);
			} else if (
				entry.isFile() &&
				GRADLE_BUILD_LOGIC_EXTENSIONS.some((extension) =>
					entry.name.endsWith(extension),
				)
			) {
				files.add(entryPath);
			}
		}
	}
	return true;
}

export function hasKtfmtConfig(cwd: string): boolean {
	const spotlessFormatter = getSpotlessKotlinFormatter(cwd);
	if (spotlessFormatter) return spotlessFormatter === "ktfmt";
	if (hasToolConfig("ktfmt", cwd)) return true;
	for (const dir of toolConfigDirs(cwd)) {
		for (const gradle of KOTLIN_GRADLE_FILES) {
			const p = path.join(dir, gradle);
			if (fs.existsSync(p)) {
				try {
					// A mention in code or in a string (the plugin id, the artifact, a
					// version-catalog alias) counts; one in a comment does not.
					if (
						/ktfmt/i.test(
							stripGradleCommentsAndStrings(
								fs.readFileSync(p, "utf-8"),
								"strings",
							),
						)
					)
						return true;
				} catch {}
			}
		}
	}
	return false;
}

// SpotBugs (#133) analyzes compiled bytecode, so it needs BOTH a Java build
// descriptor (`javaBuild` in `tool-config-presence.ts`) AND a compiled-classes
// dir (this helper). Common compiled-output dirs: Maven (target/classes), Gradle (build/classes),
// IntelliJ (out/production), Eclipse (bin/main).
const COMPILED_CLASSES_DIRS = [
	path.join("target", "classes"),
	path.join("build", "classes"),
	path.join("out", "production"),
	path.join("bin", "main"),
];

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
		hasEslintConfig: hasToolConfig("eslint", cwd),
		hasOxlintConfig: hasToolConfig("oxlint", cwd),
		hasBiomeConfig: hasToolConfig("biome", cwd),
	});
}
