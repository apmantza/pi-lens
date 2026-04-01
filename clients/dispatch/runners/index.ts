/**
 * Runner definitions for pi-lens dispatch system
 */

import { registerRunner } from "../dispatcher.js";
import architectRunner from "./architect.js";
import astGrepNapiRunner from "./ast-grep-napi.js";
import biomeRunner from "./biome.js";
import configValidationRunner from "./config-validation.js";
import goVetRunner from "./go-vet.js";
import lspRunner from "./lsp.js";
import oxlintRunner from "./oxlint.js";
import pyrightRunner from "./pyright.js";
import pythonSlopRunner from "./python-slop.js";
import ruffRunner from "./ruff.js";
import rustClippyRunner from "./rust-clippy.js";
import shellcheckRunner from "./shellcheck.js";
// Import similarity runner
import similarityRunner from "./similarity.js";
import spellcheckRunner from "./spellcheck.js";
// Import tree-sitter runner
import treeSitterRunner from "./tree-sitter.js";
import tsLspRunner from "./ts-lsp.js";
import tsSlopRunner from "./ts-slop.js";
import typeSafetyRunner from "./type-safety.js";

// Register all runners (ordered by priority)
// Unified LSP runner for all languages (TypeScript, Python, Go, Rust, etc.) - priority 4
registerRunner(lspRunner); // Unified LSP type-checking for all languages (priority 4)
registerRunner(tsLspRunner); // TypeScript type-checking (priority 5) - fallback when --lens-lsp disabled
registerRunner(pyrightRunner); // Python type-checking (priority 5) - fallback when --lens-lsp disabled
registerRunner(configValidationRunner); // Config/env validation (priority 8)
// DISABLED: ast-grep-napi causes random crashes in realtime/post-write dispatch.
// Full linter (/lens-booboo) uses CLI-based ast-grep instead.
registerRunner(astGrepNapiRunner); // TS/JS structural analysis via NAPI (priority 15, disabled by default)
registerRunner(biomeRunner); // Biome formatting/linting (priority 10)
registerRunner(oxlintRunner); // Oxlint fast JS/TS linter (priority 12)
registerRunner(treeSitterRunner); // Tree-sitter structural analysis (priority 14)
registerRunner(ruffRunner); // Python linting (priority 10)
registerRunner(tsSlopRunner); // DISABLED - TypeScript slop via CLI (disabled, use NAPI)
registerRunner(pythonSlopRunner); // Python slop via CLI (priority 25)
registerRunner(typeSafetyRunner); // Type safety checks (priority 20)
registerRunner(shellcheckRunner); // Shell script linting (priority 20)
// DISABLED: registerRunner(astGrepRunner); // Replaced by ast-grep-napi for dispatch
// CLI ast-grep kept for ast_grep_search/ast_grep_replace tools only
registerRunner(similarityRunner); // Semantic reuse detection (priority 35)
registerRunner(architectRunner); // Architectural rules (priority 40)
registerRunner(spellcheckRunner); // Spellcheck for markdown/docs (priority 30)
registerRunner(goVetRunner); // Go analysis (priority 50)
registerRunner(rustClippyRunner); // Rust analysis (priority 50)
