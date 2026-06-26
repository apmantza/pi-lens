/**
 * YAML rule synthesis for ast_grep_search / ast_grep_replace (Issue #125 Phase 3).
 *
 * Takes a pattern + structural-intent parameters and produces a valid
 * ast-grep YAML rule that routes through `sg scan --config`.
 *
 * This lets agents express cross-context queries without writing raw YAML:
 *   insideKind: "function_declaration"   → rule.inside: { kind, stopBy: "end" }
 *   hasKind: "await_expression"          → rule.has: { kind }
 *   follows: "return $X"                 → rule.follows: { pattern }
 *   precedes: "return $X"                → rule.precedes: { pattern }
 *
 * Multiple constraints are combined directly on the rule object — ast-grep
 * evaluates all of them as an implicit AND.
 */

import { dump } from "./deps/js-yaml.js";

export interface StructuralIntent {
	pattern: string;
	lang: string;
	insideKind?: string;
	hasKind?: string;
	follows?: string;
	precedes?: string;
}

/**
 * Returns true when at least one structural-intent field is present.
 */
export function hasStructuralIntent(intent: Omit<StructuralIntent, "pattern" | "lang">): boolean {
	return !!(intent.insideKind || intent.hasKind || intent.follows || intent.precedes);
}

/**
 * Synthesize an ast-grep YAML rule for replace operations.
 * Adds a `fix:` field so `sg scan --update-all` applies the rewrite.
 */
export function synthesizeReplaceRule(intent: StructuralIntent & { rewrite: string }): string {
	const base = synthesizeRule(intent);
	// js-yaml dump ends with \n; append fix field
	return `${base}fix: ${JSON.stringify(intent.rewrite)}\n`;
}

/**
 * Synthesize an ast-grep YAML rule from a pattern and structural constraints.
 *
 * The generated rule uses `stopBy: end` on `inside` so the search climbs
 * all ancestors, not just the immediate parent.
 *
 * @throws if pattern is empty
 */
export function synthesizeRule(intent: StructuralIntent): string {
	if (!intent.pattern.trim()) {
		throw new Error("pattern is required for YAML synthesis");
	}

	// Canonical language name for the YAML header (ast-grep is case-sensitive here).
	const language = canonicalLanguage(intent.lang);

	const rule: Record<string, unknown> = {
		pattern: intent.pattern,
	};

	if (intent.insideKind) {
		rule.inside = { kind: intent.insideKind, stopBy: "end" };
	}
	if (intent.hasKind) {
		rule.has = { kind: intent.hasKind };
	}
	if (intent.follows) {
		rule.follows = { pattern: intent.follows };
	}
	if (intent.precedes) {
		rule.precedes = { pattern: intent.precedes };
	}

	const doc = {
		id: "agent-rule",
		language,
		rule,
	};

	return dump(doc, { lineWidth: -1 });
}

/**
 * Map a user-supplied lang value (e.g. "typescript", "TypeScript") to the
 * capitalisation ast-grep expects in the YAML `language:` field.
 */
function canonicalLanguage(lang: string): string {
	const map: Record<string, string> = {
		typescript: "TypeScript",
		tsx: "Tsx",
		javascript: "JavaScript",
		jsx: "JavaScript",
		python: "Python",
		rust: "Rust",
		go: "Go",
		java: "Java",
		kotlin: "Kotlin",
		swift: "Swift",
		csharp: "CSharp",
		cpp: "Cpp",
		c: "C",
		ruby: "Ruby",
		php: "Php",
		dart: "Dart",
		elixir: "Elixir",
		lua: "Lua",
		ocaml: "OCaml",
		zig: "Zig",
		bash: "Bash",
		css: "Css",
		html: "Html",
		json: "Json",
		yaml: "Yaml",
		toml: "Toml",
		vue: "Vue",
	};
	return map[lang.toLowerCase()] ?? lang;
}
