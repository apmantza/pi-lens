/**
 * ast_grep_search tool definition
 *
 * Extracted from index.ts for maintainability.
 */

import * as typebox from "typebox";
import type { AstGrepClient } from "../../clients/ast-grep-client.js";
import { LANGUAGES } from "../index.js";

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

export function createAstGrepSearchTool(astGrepClientPromise: Promise<AstGrepClient>): {
	name: "ast_grep_search"; label: string; description: string; promptSnippet: string; parameters: typebox.TObject<{
		pattern: typebox.TString;
		lang: typebox.TString;
		paths: typebox.TOptional<typebox.TArray<typebox.TString>>;
		selector: typebox.TOptional<typebox.TString>;
		context: typebox.TOptional<typebox.TNumber>;
	}>; execute(_toolCallId: string, params: Record<string, unknown>, _signal: AbortSignal, _onUpdate: unknown, ctx: { cwd?: string; }): Promise<{
		content: {
			type: "text";
			text: string;
		}[];
		isError: boolean;
		details: {
			matchCount?: undefined;
		};
	} | {
		content: {
			type: "text";
			text: string;
		}[];
		details: {
			matchCount: number;
		};
		isError?: undefined;
	}>;
} {
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
		parameters: typebox.Type.Object({
			pattern: typebox.Type.String({
				description: "AST pattern (use function/class/call context, not text)",
			}),
			lang: typebox.Type.String({
				enum: [...LANGUAGES] as string[],
				description: "Target language",
			}),
			paths: typebox.Type.Optional(
				typebox.Type.Array(typebox.Type.String(), {
					description: "Specific files/folders to search",
				}),
			),
			selector: typebox.Type.Optional(
				typebox.Type.String({
					description:
						"Extract specific AST node kind (e.g., 'name', 'body', 'parameter'). Use with patterns like '$NAME($$$)' to extract just the name.",
				}),
			),
			context: typebox.Type.Optional(
				typebox.Type.Number({
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
		): Promise<{
			content: {
				type: "text";
				text: string;
			}[];
			isError: boolean;
			details: {
				matchCount?: undefined;
			};
		} | {
			content: {
				type: "text";
				text: string;
			}[];
			details: {
				matchCount: number;
			};
			isError?: undefined;
		}> {
			const astGrepClient = await astGrepClientPromise;
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
