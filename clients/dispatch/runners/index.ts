/**
 * Runner definitions for pi-lens dispatch system
 */

import type { RunnerRegistry } from "../types.js";
import architectRunner from "./architect.js";
import astGrepNapiRunner from "./ast-grep-napi.js";
import biomeRunner from "./biome.js";
import biomeCheckJsonRunner from "./biome-check.js";
import eslintRunner from "./eslint.js";
import goVetRunner from "./go-vet.js";
import golangciRunner from "./golangci-lint.js";
import lspRunner from "./lsp.js";
import oxlintRunner from "./oxlint.js";
import pyrightRunner from "./pyright.js";
import pythonSlopRunner from "./python-slop.js";
import rubocopRunner from "./rubocop.js";
import ruffRunner from "./ruff.js";
import rustClippyRunner from "./rust-clippy.js";
import shellcheckRunner from "./shellcheck.js";
import sqlfluffRunner from "./sqlfluff.js";
// Import similarity runner
import similarityRunner from "./similarity.js";
import spellcheckRunner from "./spellcheck.js";
import yamllintRunner from "./yamllint.js";
// Import tree-sitter runner
import treeSitterRunner from "./tree-sitter.js";
import tsLspRunner from "./ts-lsp.js";
import typeSafetyRunner from "./type-safety.js";
import markdownlintRunner from "./markdownlint.js";
import mypyRunner from "./mypy.js";
import stylelintRunner from "./stylelint.js";
import shfmtRunner from "./shfmt.js";
import factRulesRunner from "./fact-rules.js";

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
	registry.register(architectRunner); // Architectural rules (priority 40)
	registry.register(eslintRunner); // ESLint (priority 12, jsts, config-gated)
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
}
