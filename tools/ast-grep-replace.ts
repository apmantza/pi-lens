/**
 * ast_grep_replace tool definition
 *
 * Extracted from index.ts for maintainability.
 */

import { Type } from "typebox";
import type { AstGrepClient } from "../clients/ast-grep-client.js";
import {
	classifyAstGrepError,
	logAstGrepToolEvent,
	type AstGrepToolOutcome,
} from "../clients/ast-grep-tool-logger.js";
import { LANGUAGES } from "./shared.js";

function lineCount(value: string): number {
	if (!value) return 0;
	let lines = 1;
	for (let i = 0; i < value.length; i++) {
		if (value.charCodeAt(i) === 10) lines++;
	}
	return lines;
}

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
			lang: Type.String({
				enum: [...LANGUAGES] as string[],
				description: "Target language",
			}),
			paths: Type.Optional(
				Type.Array(Type.String(), { description: "Specific files/folders" }),
			),
			apply: Type.Optional(
				Type.Boolean({ description: "Apply changes (default: false)" }),
			),
			strictness: Type.Optional(
				Type.String({
					enum: ["smart", "relaxed", "ast", "cst", "signature", "template"],
					description:
						"Pattern matching strictness. 'smart' (default) ignores comments and whitespace. 'relaxed' also ignores unnamed nodes like punctuation. 'ast' ignores all whitespace.",
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
			const startedAt = Date.now();
			const { pattern, rewrite, paths, apply, strictness } = params as {
				pattern: string;
				rewrite: string;
				lang: string;
				paths?: string[];
				apply?: boolean;
				strictness?: string;
			};
			const lang = ((params as { lang: string }).lang ?? "").replace(
				/^"|"$/g,
				"",
			);
			const pathsCount = paths?.length ?? 1;
			const applyFlag = apply ?? false;

			function logOutcome(
				outcome: AstGrepToolOutcome,
				details: {
					matchCount?: number;
					truncated?: boolean;
					errorRaw?: string;
				} = {},
			): void {
				try {
					logAstGrepToolEvent({
						tool: "ast_grep_replace",
						lang,
						pattern,
						patternLineCount: lineCount(pattern),
						rewrite,
						rewriteLineCount: lineCount(rewrite ?? ""),
						pathsCount,
						applied: applyFlag,
						outcome,
						errorKind:
							outcome === "error"
								? classifyAstGrepError(details.errorRaw)
								: undefined,
						errorRaw: details.errorRaw,
						matchCount: details.matchCount ?? 0,
						truncated: details.truncated ?? false,
						durationMs: Date.now() - startedAt,
					});
				} catch {
					// Telemetry must never break the tool path.
				}
			}

			if (!(await astGrepClient.ensureAvailable())) {
				logOutcome("error", { errorRaw: "ast-grep CLI not found" });
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
			const searchPaths = paths?.length ? paths : [ctx.cwd || "."];
			const result = await astGrepClient.replace(
				pattern,
				rewrite,
				lang,
				searchPaths,
				applyFlag,
				{ strictness },
			);

			if (result.stalePreview) {
				logOutcome("error", { errorRaw: "stale_preview" });
				return {
					content: [
						{
							type: "text" as const,
							text: "Stale preview — the pattern no longer matches any files. The file content has changed since your last apply: false preview. Re-run with apply: false to get a fresh preview before applying.",
						},
					],
					isError: true,
					details: { stalePreview: true },
				};
			}

			if (result.error) {
				logOutcome("error", { errorRaw: result.error });
				return {
					content: [{ type: "text" as const, text: `Error: ${result.error}` }],
					isError: true,
					details: {},
				};
			}

			const isDryRun = !applyFlag;
			const output = astGrepClient.formatMatches(
				result.matches,
				isDryRun,
				true, // showModeIndicator
			);

			logOutcome(result.matches.length === 0 ? "no_matches" : "success", {
				matchCount: result.matches.length,
				truncated: result.truncated,
			});

			return {
				content: [{ type: "text" as const, text: output }],
				details: {
					matchCount: result.matches.length,
					totalMatches: result.totalMatches,
					truncated: result.truncated,
					applied: applyFlag,
				},
			};
		},
	};
}
