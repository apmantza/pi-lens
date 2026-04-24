/**
 * Runner definitions for pi-lens dispatch system
 */

import type { RunnerRegistry } from "../types.js";
import astGrepNapiRunner from "./ast-grep-napi.js";
import biomeRunner from "./biome.js";
import biomeCheckJsonRunner from "./biome-check.js";
import cppCheckRunner from "./cpp-check.js";
import credoRunner from "./credo.js";
import dartAnalyzeRunner from "./dart-analyze.js";
import dotnetBuildRunner from "./dotnet-build.js";
import elixirCheckRunner from "./elixir-check.js";
import eslintRunner from "./eslint.js";
import factRulesRunner from "./fact-rules.js";
import gleamCheckRunner from "./gleam-check.js";
import goVetRunner from "./go-vet.js";
import golangciRunner from "./golangci-lint.js";
import hadolintRunner from "./hadolint.js";
import htmlhintRunner from "./htmlhint.js";
import javacRunner from "./javac.js";
import ktlintRunner from "./ktlint.js";
import lspRunner from "./lsp.js";
import markdownlintRunner from "./markdownlint.js";
import mypyRunner from "./mypy.js";
import oxlintRunner from "./oxlint.js";
import phpLintRunner from "./php-lint.js";
import phpstanRunner from "./phpstan.js";
import prettierCheckRunner from "./prettier-check.js";
import prismaValidateRunner from "./prisma-validate.js";
import psScriptAnalyzerRunner from "./psscriptanalyzer.js";
import pyrightRunner from "./pyright.js";
import pythonSlopRunner from "./python-slop.js";
import rubocopRunner from "./rubocop.js";
import ruffRunner from "./ruff.js";
import rustClippyRunner from "./rust-clippy.js";
import shellcheckRunner from "./shellcheck.js";
import shfmtRunner from "./shfmt.js";
// Import similarity runner
import similarityRunner from "./similarity.js";
import spellcheckRunner from "./spellcheck.js";
import sqlfluffRunner from "./sqlfluff.js";
import stylelintRunner from "./stylelint.js";
import taploRunner from "./taplo.js";
import tflintRunner from "./tflint.js";
// Import tree-sitter runner
import treeSitterRunner from "./tree-sitter.js";
import tsLspRunner from "./ts-lsp.js";
import typeSafetyRunner from "./type-safety.js";
import yamllintRunner from "./yamllint.js";
import zigCheckRunner from "./zig-check.js";

export function registerDefaultRunners(registry: RunnerRegistry): void {
	// Register all runners (ordered by priority)
	// Unified LSP runner for all languages (TypeScript, Python, Go, Rust, etc.) - priority 4
	registry.register(lspRunner); // Unified LSP type-checking for all languages (priority 4)
	registry.register(tsLspRunner); // TypeScript type-checking (priority 5) - fallback when --lens-lsp disabled
	registry.register(pyrightRunner); // Python type-checking (priority 5) - fallback when --lens-lsp disabled
	registry.register(biomeCheckJsonRunner); // Biome check with JSON output for diagnostic capture (priority 9)
	// DISABLED in post-write dispatch - ast-grep-napi can crash. Enabled via /lens-booboo plan only.
	registry.register(astGrepNapiRunner); // TS/JS structural analysis via NAPI (priority 15, post-write disabled)
	registry.register(biomeRunner); // Biome formatting/linting (priority 10)
	registry.register(treeSitterRunner); // Tree-sitter structural analysis (priority 14)
	registry.register(ruffRunner); // Python linting (priority 10)
	registry.register(pythonSlopRunner); // Python slop via CLI (priority 25)
	registry.register(typeSafetyRunner); // Type safety checks (priority 20)
	registry.register(shellcheckRunner); // Shell script linting (priority 20)
	// DISABLED: registerRunner(astGrepRunner); // Replaced by ast-grep-napi for dispatch
	// CLI ast-grep kept for ast_grep_search/ast_grep_replace tools only
	registry.register(similarityRunner); // Semantic reuse detection (priority 35)
	registry.register(eslintRunner); // ESLint (priority 12, jsts, config-gated)
	registry.register(oxlintRunner); // Oxlint (priority 12, jsts, config-aware default fallback)
	registry.register(golangciRunner); // golangci-lint (priority 20, go, config-gated)
	registry.register(rubocopRunner); // RuboCop lint (priority 10, ruby)
	registry.register(spellcheckRunner); // Spellcheck for markdown/docs (priority 30)
	registry.register(yamllintRunner); // YAML lint (priority 22)
	registry.register(sqlfluffRunner); // SQL lint (priority 24)
	registry.register(goVetRunner); // Go analysis (priority 50)
	registry.register(rustClippyRunner); // Rust analysis (priority 50)
	registry.register(markdownlintRunner); // Markdown lint (priority 30)
	registry.register(mypyRunner); // Python type checking — mypy (priority 20, config-gated)
	registry.register(stylelintRunner); // CSS/SCSS/Less lint (priority 10, config-gated)
	registry.register(shfmtRunner); // Shell formatting check (priority 10)
	registry.register(factRulesRunner); // FactRule pipeline — all registered rules (priority 21)
	registry.register(htmlhintRunner); // HTML linting — tag pairs, attribute rules (priority 20)
	registry.register(hadolintRunner); // Dockerfile linting — syntax, best practices (priority 20)
	registry.register(phpLintRunner); // PHP syntax validation via php -l (priority 20)
	registry.register(psScriptAnalyzerRunner); // PowerShell linting via PSScriptAnalyzer module (priority 20)
	registry.register(prismaValidateRunner); // Prisma schema validation via CLI (priority 20)
	registry.register(ktlintRunner); // Kotlin linting via ktlint (priority 10)
	registry.register(tflintRunner); // Terraform linting via tflint (priority 20)
	registry.register(taploRunner); // TOML linting/validation via taplo (priority 10)
	registry.register(dartAnalyzeRunner); // Dart analysis via dart analyze (priority 20)
	registry.register(javacRunner); // Java compile diagnostics via javac (priority 20)
	registry.register(dotnetBuildRunner); // C# compile diagnostics via dotnet build (priority 20)
	registry.register(cppCheckRunner); // C/C++ compile diagnostics via compiler syntax checks (priority 20)
	registry.register(zigCheckRunner); // Zig compile diagnostics via zig build-exe (priority 20)
	registry.register(gleamCheckRunner); // Gleam project diagnostics via gleam check (priority 20)
	registry.register(credoRunner); // Elixir static analysis via credo (priority 20, mix.exs-gated)
	registry.register(elixirCheckRunner); // Elixir compile/syntax diagnostics via mix/elixirc (priority 20)
	registry.register(prettierCheckRunner); // Prettier format check for CSS/HTML (priority 10, config-gated)
	registry.register(phpstanRunner); // PHP static analysis via phpstan (priority 20, config-gated)
}
