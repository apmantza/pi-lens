/**
 * ast_grep_replace tool definition
 *
 * Extracted from index.ts for maintainability.
 */

import * as typebox from "typebox";
import type { AstGrepClient } from "../../clients/ast-grep-client.js";
import { LANGUAGES } from "../index.js";

export function createAstGrepReplaceTool(astGrepClientPromise: Promise<AstGrepClient>): {
	name: "ast_grep_replace"; label: string; description: string; promptSnippet: string; parameters: typebox.TObject<{
		pattern: typebox.TString;
		rewrite: typebox.TString;
		lang: typebox.TString;
		paths: typebox.TOptional<typebox.TArray<typebox.TString>>;
		apply: typebox.TOptional<typebox.TBoolean>;
	}>; execute(_toolCallId: string, params: Record<string, unknown>, _signal: AbortSignal, _onUpdate: unknown, ctx: { cwd?: string; }): Promise<{
		content: {
			type: "text";
			text: string;
		}[];
		isError: boolean;
		details: {
			matchCount?: undefined;
			applied?: undefined;
		};
	} | {
		content: {
			type: "text";
			text: string;
		}[];
		details: {
			matchCount: number;
			applied: boolean;
		};
		isError?: undefined;
	}>;
} {
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
		parameters: typebox.Type.Object({
			pattern: typebox.Type.String({
				description: "AST pattern to match (be specific with context)",
			}),
			rewrite: typebox.Type.String({
				description: "Replacement using meta-variables from pattern",
			}),
			lang: typebox.Type.String({
				enum: [...LANGUAGES] as string[],
				description: "Target language",
			}),
			paths: typebox.Type.Optional(
				typebox.Type.Array(typebox.Type.String(), { description: "Specific files/folders" }),
			),
			apply: typebox.Type.Optional(
				typebox.Type.Boolean({ description: "Apply changes (default: false)" }),
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
				applied?: undefined;
			};
		} | {
			content: {
				type: "text";
				text: string;
			}[];
			details: {
				matchCount: number;
				applied: boolean;
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

			const { pattern, rewrite, paths, apply } = params as {
				pattern: string;
				rewrite: string;
				lang: string;
				paths?: string[];
				apply?: boolean;
			};
			// Strip surrounding quotes if the LLM over-quoted the value (e.g. '"typescript"')
			const lang = ((params as { lang: string }).lang ?? "").replace(
				/^"|"$/g,
				"",
			);
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
