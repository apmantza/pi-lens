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

const MAX_SYNTHESIZED_PATTERN_CHARS = 4_000;
const MAX_NODE_KIND_CHARS = 80;
const NODE_KIND_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
	assertSafePattern(intent.pattern, "pattern");

	// Canonical language name for the YAML header (ast-grep is case-sensitive here).
	const language = canonicalLanguage(intent.lang);

	const rule: Record<string, unknown> = {
		pattern: intent.pattern,
	};

	if (intent.insideKind) {
		rule.inside = { kind: assertSafeNodeKind(intent.insideKind, "insideKind"), stopBy: "end" };
	}
	if (intent.hasKind) {
		rule.has = { kind: assertSafeNodeKind(intent.hasKind, "hasKind") };
	}
	if (intent.follows) {
		assertSafePattern(intent.follows, "follows");
		rule.follows = { pattern: intent.follows };
	}
	if (intent.precedes) {
		assertSafePattern(intent.precedes, "precedes");
		rule.precedes = { pattern: intent.precedes };
	}

	const doc = {
		id: "agent-rule",
		language,
		rule,
	};

	return dump(doc, { lineWidth: -1 });
}

function assertSafePattern(value: string, field: string): void {
	if (!value.trim()) {
		throw new Error(`${field} is required for YAML synthesis`);
	}
	if (value.length > MAX_SYNTHESIZED_PATTERN_CHARS) {
		throw new Error(`${field} is too long for YAML synthesis`);
	}
	if (value.includes("\0")) {
		throw new Error(`${field} contains a NUL byte`);
	}
}

function assertSafeNodeKind(value: string, field: string): string {
	const kind = value.trim();
	if (kind.length === 0) {
		throw new Error(`${field} is required for YAML synthesis`);
	}
	if (kind.length > MAX_NODE_KIND_CHARS || !NODE_KIND_RE.test(kind)) {
		throw new Error(
			`${field} must be a single AST node kind like function_declaration`,
		);
	}
	return kind;
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
