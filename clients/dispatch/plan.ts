/**
 * Tool execution plan for pi-lens
 *
 * Defines which tools run for each file kind and in what order.
 * This is the declarative alternative to the if/else chains in index.ts.
 *
 * Modes:
 * - "all": Run all runners in the group
 * - "fallback": Run first available runner
 * - "first-success": Run until one succeeds
 */

import type { FileKind } from "../file-kinds.js";
import type { ToolPlan } from "./types.js";

/**
 * Tool plans organized by purpose
 *
 * CORE PRINCIPLE: File write only runs BLOCKING tools
 * - Type checking (LSP) - blocking errors
 * - Security/correctness lint - blocking errors
 * - Auto-format/auto-fix handled by direct calls in index.ts (not here)
 *
 * Warning-only tools run on /lens-booboo command only
 */
export const TOOL_PLANS: Record<string, ToolPlan> = {
	/**
	 * Linting tools for JS/TS files
	 */
	jsts: {
		name: "JavaScript/TypeScript Linting",
		groups: [
			// LSP type checking (unified for all languages) - priority 4, blocking errors
			{ mode: "all", runnerIds: ["lsp"], filterKinds: ["jsts"] },
			// Tree-sitter native structural analysis (blocking rules: constructor-super, dangerouslySetInnerHTML, etc.)
			{ mode: "all", runnerIds: ["tree-sitter"], filterKinds: ["jsts"] },
			// AST structural analysis (blocking: no-dupe-keys, no-hardcoded-secrets, jwt-no-verify, etc.)
			{ mode: "all", runnerIds: ["ast-grep-napi"], filterKinds: ["jsts"] },
			// Type safety checks (has some blocking errors)
			{ mode: "fallback", runnerIds: ["type-safety"], filterKinds: ["jsts"] },
			// Note: ast-grep CLI kept for ast_grep_search/ast_grep_replace tools only
			// Note: biome, oxlint handled by direct auto-fix calls in index.ts (not in dispatch)
			// Architectural rules (guidance only, not blocking) - runs via /lens-booboo only
		],
	},

	/**
	 * Python linting tools
	 */
	python: {
		name: "Python Linting",
		groups: [
			// Pyright type checking (standard mode - no LSP flag needed)
			// Provides Python type errors in standard pi mode
			{ mode: "all", runnerIds: ["pyright"], filterKinds: ["python"] },
			// LSP type checking (unified) - when --lens-lsp enabled
			{ mode: "all", runnerIds: ["lsp"], filterKinds: ["python"] },
			// Note: ruff handled by direct auto-fix calls in index.ts (not in dispatch)
			// Architectural rules (guidance only, not blocking) - runs via /lens-booboo only
		],
	},

	/**
	 * Go linting tools
	 */
	go: {
		name: "Go Linting",
		groups: [
			// LSP type checking (gopls)
			{ mode: "all", runnerIds: ["lsp"], filterKinds: ["go"] },
			// Go vet for additional checks (warning only, but low cost)
			{ mode: "fallback", runnerIds: ["go-vet"], filterKinds: ["go"] },
			// Architectural rules (guidance only, not blocking) - runs via /lens-booboo only
		],
	},

	/**
	 * Rust linting tools
	 */
	rust: {
		name: "Rust Linting",
		groups: [
			// LSP type checking (rust-analyzer)
			{ mode: "all", runnerIds: ["lsp"], filterKinds: ["rust"] },
			// Cargo clippy for additional checks
			{ mode: "fallback", runnerIds: ["rust-clippy"], filterKinds: ["rust"] },
			// Architectural rules (guidance only, not blocking) - runs via /lens-booboo only
		],
	},

	/**
	 * C/C++ linting tools
	 */
	cxx: {
		name: "C/C++ Linting",
		groups: [
			// Architectural rules (guidance only, not blocking) - runs via /lens-booboo only
		],
	},

	/**
	 * JSON/JSONC files
	 */
	json: {
		name: "JSON Processing",
		groups: [
			// Note: Biome handles JSON formatting via direct call in index.ts
			// No additional linting needed for JSON
		],
	},

	/**
	 * Markdown files
	 */
	markdown: {
		name: "Markdown Processing",
		groups: [
			// Spellcheck for typos (warning only, but useful)
			{ mode: "fallback", runnerIds: ["spellcheck"] },
		],
	},

	/**
	 * Shell scripts
	 */
	shell: {
		name: "Shell Script Linting",
		groups: [
			// Shellcheck for bash/sh/zsh linting (has blocking errors for syntax)
			{ mode: "fallback", runnerIds: ["shellcheck"] },
			// Architectural rules (guidance only, not blocking) - runs via /lens-booboo only
		],
	},

	/**
	 * CMake files
	 */
	cmake: {
		name: "CMake Processing",
		groups: [
			// Architectural rules (guidance only, not blocking) - runs via /lens-booboo only
		],
	},
};

/**
 * Get the tool plan for a specific file kind
 */
export function getToolPlan(kind: FileKind): ToolPlan | undefined {
	return TOOL_PLANS[kind];
}

/**
 * Get all registered tool plans
 */
export function getAllToolPlans(): Record<string, ToolPlan> {
	return TOOL_PLANS;
}

/**
 * Full lint plan for /lens-booboo command (includes warning-only tools)
 * This includes ALL runners for comprehensive analysis
 */
export const FULL_LINT_PLANS: Record<string, ToolPlan> = {
	...TOOL_PLANS,
	// Override jsts to include warning-only tools
	jsts: {
		name: "JavaScript/TypeScript Full Lint",
		groups: [
			{ mode: "all", runnerIds: ["lsp"], filterKinds: ["jsts"] },
			{ mode: "all", runnerIds: ["tree-sitter"], filterKinds: ["jsts"] },
			{ mode: "all", runnerIds: ["ast-grep-napi"], filterKinds: ["jsts"] },
			// Warning-only tools (for full lint, not file write)
			{
				mode: "fallback",
				runnerIds: ["biome-lint", "oxlint"],
				filterKinds: ["jsts"],
			},
			{ mode: "fallback", runnerIds: ["type-safety"], filterKinds: ["jsts"] },
			{ mode: "fallback", runnerIds: ["architect"], filterKinds: ["jsts"] },
		],
	},
	// Override python to include warning-only tools
	python: {
		name: "Python Full Lint",
		groups: [
			{ mode: "all", runnerIds: ["lsp"], filterKinds: ["python"] },
			// Warning-only tools
			{ mode: "fallback", runnerIds: ["ruff-lint"], filterKinds: ["python"] },
			{ mode: "fallback", runnerIds: ["python-slop"], filterKinds: ["python"] },
			{ mode: "fallback", runnerIds: ["architect"], filterKinds: ["python"] },
		],
	},
};
