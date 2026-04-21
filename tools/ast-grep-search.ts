/**
 * ast_grep_search tool definition
 *
 * Extracted from index.ts for maintainability.
 */

import { Type } from "@sinclair/typebox";
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

	const hasAstSignals = /[$(){}\[\].;:'"`]/.test(text);
	const hasWhitespace = /\s/.test(text);
	if (hasWhitespace && !hasAstSignals) return true;

	return false;
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
			"Use 'selector' to extract specific nodes (e.g., just the function name). " +
			"Use 'context' to show surrounding lines.",
		promptSnippet: "Use ast_grep_search for AST-aware code search",
		parameters: Type.Object({
			pattern: Type.String({
				description: "AST pattern (use function/class/call context, not text)",
			}),
			lang: Type.Union(
				LANGUAGES.map((l: (typeof LANGUAGES)[number]) => Type.Literal(l)),
				{ description: "Target language" },
			),
			paths: Type.Optional(
				Type.Array(Type.String(), {
					description: "Specific files/folders to search",
				}),
			),
			selector: Type.Optional(
				Type.String({
					description:
						"Extract specific AST node kind (e.g., 'name', 'body', 'parameter'). Use with patterns like '$NAME($$$)' to extract just the name.",
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

			const { pattern, lang, paths, selector, context } = params as {
				pattern: string;
				lang: string;
				paths?: string[];
				selector?: string;
				context?: number;
			};

			if (looksLikeRuleYamlOrPlainText(pattern)) {
				return {
					content: [
						{
							type: "text" as const,
							text:
								"Error: ast_grep_search expects a valid AST code pattern, not plain text/rule YAML. Use patterns like `function $NAME($$$ARGS) { $$$BODY }` or use grep/read for plain text diagnostics.",
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
			return {
				content: [{ type: "text" as const, text: output }],
				details: { matchCount: result.matches.length },
			};
		},
	};
}
