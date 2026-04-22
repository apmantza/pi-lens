/**
 * ast_grep_replace tool definition
 *
 * Extracted from index.ts for maintainability.
 */

import { Type } from "typebox";
import type { AstGrepClient } from "../clients/ast-grep-client.js";
import { LANGUAGES } from "./shared.js";

export function createAstGrepReplaceTool(astGrepClient: AstGrepClient) {
	return {
		name: "ast_grep_replace" as const,
		label: "AST Replace",
		description:
			"Replace code using AST-aware pattern matching. IMPORTANT: Use specific AST patterns, not text. Dry-run by default (use apply=true to apply).\n\n" +
			"✅ GOOD patterns (single AST node):\n" +
			"  - pattern='console.log($MSG)' rewrite='logger.info($MSG)'\n" +
			"  - pattern='var $X' rewrite='let $X'\n" +
			"  - pattern='function $NAME() { }' rewrite='' (delete)\n\n" +
			"❌ BAD patterns (will error):\n" +
			"  - Raw text without code structure\n" +
			'  - Missing parentheses: use it($TEST) not it"text"\n' +
			"  - Incomplete code fragments\n\n" +
			"Always use 'paths' to scope to specific files/folders. Dry-run first to preview changes.",
		promptSnippet: "Use ast_grep_replace for AST-aware find-and-replace",
		parameters: Type.Object({
			pattern: Type.String({
				description: "AST pattern to match (be specific with context)",
			}),
			rewrite: Type.String({
				description: "Replacement using meta-variables from pattern",
			}),
			lang: Type.Union(
				LANGUAGES.map((l: (typeof LANGUAGES)[number]) => Type.Literal(l)),
				{ description: "Target language" },
			),
			paths: Type.Optional(
				Type.Array(Type.String(), { description: "Specific files/folders" }),
			),
			apply: Type.Optional(
				Type.Boolean({ description: "Apply changes (default: false)" }),
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

			const { pattern, rewrite, lang, paths, apply } = params as {
				pattern: string;
				rewrite: string;
				lang: string;
				paths?: string[];
				apply?: boolean;
			};
			const searchPaths = paths?.length ? paths : [ctx.cwd || "."];
			const result = await astGrepClient.replace(
				pattern,
				rewrite,
				lang,
				searchPaths,
				apply ?? false,
			);

			if (result.error) {
				return {
					content: [{ type: "text" as const, text: `Error: ${result.error}` }],
					isError: true,
					details: {},
				};
			}

			const isDryRun = !apply;
			const output = astGrepClient.formatMatches(
				result.matches,
				isDryRun,
				true, // showModeIndicator
			);

			return {
				content: [{ type: "text" as const, text: output }],
				details: { matchCount: result.matches.length, applied: apply ?? false },
			};
		},
	};
}
