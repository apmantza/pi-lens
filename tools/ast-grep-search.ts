/**
 * ast_grep_search tool definition
 *
 * Extracted from index.ts for maintainability.
 */

import { Type } from "typebox";
import type { AstGrepClient } from "../clients/ast-grep-client.js";
import { LANGUAGES } from "./shared.js";

function looksLikeRuleYamlOrPlainText(pattern: string): boolean {
	const text = pattern.trim();
	if (!text) return true;

	const lower = text.toLowerCase();
	if (
		/(^|\n)\s*(id|language|rule|rules|kind|pattern|message|severity)\s*:/.test(
			lower,
		)
	) {
		return true;
	}

	if (
		/\b(id|language|rule|rules|kind|pattern|message|severity)\s*:\s*[a-z0-9_-]+/i.test(
			text,
		)
	) {
		return true;
	}

	if (/^[-*]\s+/.test(text)) return true;

	const hasAstSignals = /[$(){}[\].;:'"`]/.test(text);
	const hasWhitespace = /\s/.test(text);
	if (hasWhitespace && !hasAstSignals) return true;

	return false;
}

/**
 * Detect common mistakes in ast-grep patterns and return a hint.
 * Helps the LLM self-correct when a search returns zero matches.
 */
function getPatternHint(
	pattern: string,
	lang: string,
	selector?: string,
): string | null {
	const src = pattern.trim();

	if (selector) {
		return `Hint: selector=${JSON.stringify(selector)} narrows the AST node kind searched; it does not extract fields from matches. Retry once without selector, or use a selector that is the outer node kind you want to match.`;
	}

	// --- regex misuse ---
	if (/\\[wWdDsSbB]/.test(src)) {
		return 'Hint: "\\w", "\\d", "\\s", "\\b" are regex escapes. ast-grep matches AST nodes, not text — use $VAR for identifiers, $$$ for node lists, or switch to grep for text search.';
	}
	if (/\[[a-zA-Z0-9]-[a-zA-Z0-9]\]/.test(src)) {
		return 'Hint: "[a-z]" and similar character classes are regex, not AST. Use $VAR to match any identifier, or switch to grep for text search.';
	}
	if (!src.includes("$") && /\w\.[*+]/.test(src)) {
		return 'Hint: ".*" and ".+" are regex wildcards. In ast-grep use $$$ for multiple AST nodes and $VAR for a single node. For text patterns, switch to grep.';
	}
	if (/^[-\w.*]+\|[-\w.*|]+$/.test(src)) {
		return 'Hint: "|" is regex alternation and does NOT work in ast-grep patterns. Options: (a) fire one ast_grep_search per alternative, or (b) switch to grep with a regex pattern like "foo|bar".';
	}

	// --- language-specific mistakes ---
	if (lang === "python") {
		if (
			(src.startsWith("def ") || src.startsWith("async def ")) &&
			src.endsWith(":")
		) {
			return `Hint: Remove trailing colon from Python patterns. Try: "${src.slice(0, -1)}"`;
		}
		if (src.startsWith("class ") && src.endsWith(":")) {
			return `Hint: Remove trailing colon from class patterns. Try: "${src.slice(0, -1)}"`;
		}
	}
	if (["javascript", "typescript", "tsx"].includes(lang)) {
		if (/^(export\s+)?(async\s+)?function\s+\$[A-Z_]+\s*$/i.test(src)) {
			return 'Hint: Function patterns need params and body. Try "function $NAME($$$) { $$$ }"';
		}
	}
	if (lang === "go") {
		if (/^func\s+\$[A-Z_]+\s*$/i.test(src)) {
			return 'Hint: Go function patterns need params and body. Try "func $NAME($$$) { $$$ }"';
		}
	}
	if (lang === "rust") {
		if (/^fn\s+\$[A-Z_]+\s*$/i.test(src)) {
			return 'Hint: Rust fn patterns need params and body. Try "fn $NAME($$$) { $$$ }"';
		}
	}

	return "Hint: No matches. Retry once with a smaller valid AST pattern scoped to the same paths (for example a call like `foo($$$ARGS)`, an import statement, or `function $NAME($$$ARGS) { $$$BODY }`). If that also fails, use grep for text search or lsp_navigation for symbol lookup.";
}

export function createAstGrepSearchTool(astGrepClient: AstGrepClient) {
	return {
		name: "ast_grep_search" as const,
		label: "AST Search",
		description:
			"Search code using AST-aware pattern matching. IMPORTANT: Use specific AST patterns, NOT text search.\n\n" +
			"✅ GOOD patterns (single AST node):\n" +
			"  - function $NAME() { $$$BODY }     (function declaration)\n" +
			"  - fetchMetrics($ARGS)               (function call)\n" +
			'  - import { $NAMES } from "$PATH"   (import statement)\n' +
			"  - console.log($MSG)                  (method call)\n\n" +
			"❌ BAD patterns (multiple nodes / raw text):\n" +
			'  - it"test name"                    (missing parens - use it($TEST))\n' +
			"  - console.log without args          (incomplete code)\n" +
			"  - arbitrary text without code structure\n\n" +
			"Always prefer specific patterns with context over bare identifiers. " +
			"Use 'paths' to scope to specific files/folders. " +
			"Avoid 'selector' unless you know the exact AST node kind; it narrows search roots and does not extract fields. " +
			"Use 'context' to show surrounding lines. If zero matches, retry once with a simpler AST pattern before falling back to grep.",
		promptSnippet: "Use ast_grep_search for AST-aware code search",
		parameters: Type.Object({
			pattern: Type.String({
				description: "AST pattern (use function/class/call context, not text)",
			}),
			lang: Type.String({
				enum: [...LANGUAGES] as string[],
				description: "Target language",
			}),
			paths: Type.Optional(
				Type.Array(Type.String(), {
					description: "Specific files/folders to search",
				}),
			),
			selector: Type.Optional(
				Type.String({
					description:
						"Advanced: restrict search to a specific AST node kind (for example 'call_expression' or 'function_declaration'). This narrows matching; it does not extract fields from matches.",
				}),
			),
			context: Type.Optional(
				Type.Number({
					description: "Show N lines before/after each match for context",
				}),
			),
		}),
		async execute(
			_toolCallId: string,
			params: Record<string, unknown>,
			_signal: AbortSignal,
			_onUpdate: unknown,
			ctx: { cwd?: string },
		) {
			if (!(await astGrepClient.ensureAvailable())) {
				return {
					content: [
						{
							type: "text" as const,
							text: "ast-grep CLI not found. Install: npm i -D @ast-grep/cli",
						},
					],
					isError: true,
					details: {},
				};
			}

			const { pattern, paths, selector, context } = params as {
				pattern: string;
				lang: string;
				paths?: string[];
				selector?: string;
				context?: number;
			};
			// Strip surrounding quotes if the LLM over-quoted the value (e.g. '"typescript"')
			const lang = ((params as { lang: string }).lang ?? "").replace(
				/^"|"$/g,
				"",
			);

			if (looksLikeRuleYamlOrPlainText(pattern)) {
				return {
					content: [
						{
							type: "text" as const,
							text: "Error: ast_grep_search expects a valid AST code pattern, not plain text/rule YAML. Use patterns like `function $NAME($$$ARGS) { $$$BODY }` or use grep/read for plain text diagnostics.",
						},
					],
					isError: true,
					details: {},
				};
			}

			const searchPaths = paths?.length ? paths : [ctx.cwd || "."];
			const result = await astGrepClient.search(pattern, lang, searchPaths, {
				selector,
				context,
			});

			if (result.error) {
				return {
					content: [{ type: "text" as const, text: `Error: ${result.error}` }],
					isError: true,
					details: {},
				};
			}

			const output = astGrepClient.formatMatches(result.matches);
			const hint =
				result.matches.length === 0 && !result.error
					? getPatternHint(pattern, lang, selector)
					: undefined;
			const finalOutput = hint ? `${output}\n\n${hint}` : output;
			return {
				content: [{ type: "text" as const, text: finalOutput }],
				details: {
					matchCount: result.matches.length,
					totalMatches: result.totalMatches,
					truncated: result.truncated,
				},
			};
		},
	};
}
