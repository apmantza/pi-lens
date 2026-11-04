/**
 * ast_grep_replace tool definition
 *
 * Extracted from index.ts for maintainability.
 */

import { Type } from "../clients/deps/typebox.js";
import type { AstGrepClient } from "../clients/ast-grep-client.js";
import type { LineageHandle } from "../clients/session-scope.js";
import {
	astGrepRemediationHint,
	classifyAstGrepError,
	logAstGrepToolEvent,
	type AstGrepToolOutcome,
} from "../clients/ast-grep-tool-logger.js";
import {
	hasStructuralIntent,
	synthesizeReplaceRule,
} from "../clients/ast-grep-yaml-synth.js";
import { compactRenderResult } from "./render-compact.js";

/**
 * Build the agent-facing error text, appending a remediation hint derived from
 * the same classification we log. Curated spawn errors return null from the
 * hint map (their message already carries guidance), so this only adds value
 * for the raw-stderr categories.
 */
function errorTextWithHint(raw: string): string {
	const hint = astGrepRemediationHint(classifyAstGrepError(raw));
	return hint ? `Error: ${raw}\n\n${hint}` : `Error: ${raw}`;
}
import {
	defaultedCwdHomeRefusal,
	readAstGrepLang,
	readPathsArgument,
} from "./shared.js";

function lineCount(value: string): number {
	if (!value) return 0;
	let lines = 1;
	for (let i = 0; i < value.length; i++) {
		if (value.charCodeAt(i) === 10) lines++;
	}
	return lines;
}

/**
 * `captureLineage`: the host's session capture (#3763). The tool takes it at
 * `execute` entry, before its first await, and the apply records under it.
 */
export function createAstGrepReplaceTool(
	astGrepClient: AstGrepClient,
	captureLineage?: () => LineageHandle,
) {
	return {
		name: "ast_grep_replace" as const,
		label: "AST Replace",
		description:
			'Find and rewrite code by AST structure; preview by default. Example: `{pattern: "var $X", rewrite: "let $X", apply: false}`.',
		promptSnippet: "Preview an AST-aware code rewrite",
		renderResult: compactRenderResult<{
			matchCount?: number;
			applied?: boolean;
			stalePreview?: boolean;
		}>(({ details, isError, text }) => {
			if (details?.stalePreview) {
				return `ast_grep_replace — stale preview, re-run with apply:false`;
			}
			if (isError) {
				return `ast_grep_replace — ${text.split("\n")[0] ?? "error"}`;
			}
			const n = details?.matchCount ?? 0;
			const state = details?.applied ? "applied" : "preview";
			return `ast_grep_replace — ${n} match${n === 1 ? "" : "es"}, ${state}`;
		}),
		parameters: Type.Object({
			pattern: Type.String({
				description: "AST pattern to match (be specific with context)",
			}),
			rewrite: Type.String({
				description: "Replacement using meta-variables from pattern",
			}),
			lang: Type.String({
				description: "Language id, e.g. typescript, tsx, python, go.",
			}),
			paths: Type.Optional(
				Type.Array(Type.String(), { description: "Specific files/folders" }),
			),
			insideKind: Type.Optional(
				Type.String({
					description: "Ancestor AST node kind filter.",
				}),
			),
			hasKind: Type.Optional(
				Type.String({
					description: "Immediate child AST node kind filter.",
				}),
			),
			hasDescendantKind: Type.Optional(
				Type.String({
					description: "Recursive descendant AST node kind filter.",
				}),
			),
			follows: Type.Optional(
				Type.String({
					description: "Preceding sibling pattern filter.",
				}),
			),
			precedes: Type.Optional(
				Type.String({
					description: "Following sibling pattern filter.",
				}),
			),
			apply: Type.Optional(
				Type.Boolean({ description: "Apply changes (default: false)" }),
			),
			strictness: Type.Optional(
				Type.String({
					enum: ["smart", "relaxed", "ast", "cst", "signature", "template"],
					description: "Match strictness; default smart.",
				}),
			),
		}),
		async execute(
			_toolCallId: string,
			params: Record<string, unknown>,
			_signal: AbortSignal,
			_onUpdate: unknown,
			ctx: {
				cwd?: string;
				resultMaxItems?: number;
				sessionManager?: { getSessionId?: () => string };
			},
		) {
			const lineage = captureLineage?.();
			// #4943: the calling session owns the deferred pass of the apply.
			const sessionId = ctx.sessionManager?.getSessionId?.();
			const startedAt = Date.now();
			const {
				pattern,
				rewrite,
				paths,
				apply,
				strictness,
				insideKind,
				hasKind,
				hasDescendantKind,
				follows,
				precedes,
			} = params as {
				pattern: string;
				rewrite: string;
				lang: string;
				paths?: string[];
				apply?: boolean;
				strictness?: string;
				insideKind?: string;
				hasKind?: string;
				hasDescendantKind?: string;
				follows?: string;
				precedes?: string;
			};
			const { lang, refusal: langError } = readAstGrepLang(
				(params as { lang?: unknown }).lang,
				true,
			);
			const pathsCount = paths?.length ?? 1;
			const applyFlag = apply ?? false;
			// MCP passes Infinity so the shared result seam receives the complete
			// tool rendering. Pi keeps the historical 50-item content contract.
			const resultMaxItems = ctx.resultMaxItems ?? 50;

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

			if (langError) {
				logOutcome("error", { errorRaw: langError });
				return {
					content: [{ type: "text" as const, text: `Error: ${langError}` }],
					isError: true,
					details: {},
				};
			}
			// #5041: replace used to forward `paths` unchecked, so a non-string
			// entry, a blank entry or an over-cap list reached the CLI as argv.
			const pathsRead = readPathsArgument(paths, {
				cwd: ctx.cwd,
				absent: "cwd",
			});
			if (pathsRead.refusal) {
				logOutcome("error", { errorRaw: pathsRead.refusal });
				return {
					content: [
						{ type: "text" as const, text: `Error: ${pathsRead.refusal}` },
					],
					isError: true,
					details: {},
				};
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
			// #5039: a write tool needs the home ceiling more than a read tool does.
			// Decided before any target is resolved, so it covers the dry run and the
			// apply alike (`apply` only flips a flag on this same dispatch), through
			// the seam #747/#250's guard became when it was lifted out of
			// ast_grep_search. It runs AFTER the `paths` reader above: an empty list
			// (`paths: []`) is the reader's refusal even at home, and only an absent
			// `paths` reaches this ceiling (keyed on the raw argument, not on
			// `pathsRead.entries`, which `absent: "cwd"` always fills).
			const homeRefusal = defaultedCwdHomeRefusal(paths, ctx.cwd);
			if (homeRefusal) {
				logOutcome("error", { errorRaw: homeRefusal.reason });
				return {
					content: [{ type: "text" as const, text: homeRefusal.text }],
					isError: true,
					details: {},
				};
			}
			const searchPaths = pathsRead.entries;

			// Phase 3: structural-intent params → synthesize YAML with fix: field
			if (
				hasStructuralIntent({
					insideKind,
					hasKind,
					hasDescendantKind,
					follows,
					precedes,
				})
			) {
				let ruleYaml: string;
				try {
					ruleYaml = synthesizeReplaceRule({
						pattern,
						lang,
						rewrite,
						insideKind,
						hasKind,
						hasDescendantKind,
						follows,
						precedes,
					});
				} catch (err) {
					logOutcome("error", { errorRaw: String(err) });
					return {
						content: [
							{
								type: "text" as const,
								text: `Error synthesizing rule: ${err}`,
							},
						],
						isError: true,
						details: {},
					};
				}
				const ruleResult = await astGrepClient.replaceWithRule(
					ruleYaml,
					searchPaths,
					applyFlag,
					{ lineage, toolCallId: _toolCallId, sessionId },
				);
				if (ruleResult.stalePreview) {
					logOutcome("error", { errorRaw: "stale_preview" });
					return {
						content: [
							{
								type: "text" as const,
								text: "Stale preview — pattern no longer matches. Re-run with apply: false.",
							},
						],
						isError: true,
						details: { stalePreview: true },
					};
				}
				if (ruleResult.error) {
					logOutcome("error", { errorRaw: ruleResult.error });
					return {
						content: [
							{
								type: "text" as const,
								text: errorTextWithHint(ruleResult.error),
							},
						],
						isError: true,
						details: {},
					};
				}
				const output = astGrepClient.formatMatches(
					ruleResult.matches,
					!applyFlag,
					true,
					resultMaxItems,
				);
				logOutcome(ruleResult.matches.length === 0 ? "no_matches" : "success", {
					matchCount: ruleResult.matches.length,
				});
				return {
					content: [{ type: "text" as const, text: output }],
					details: {
						matchCount: ruleResult.matches.length,
						applied: applyFlag,
						// #5239: the files the apply rewrote, for the `tool_result`
						// handler's dispatch.
						appliedFiles: ruleResult.appliedFiles ?? [],
					},
				};
			}

			const result = await astGrepClient.replace(
				pattern,
				rewrite,
				lang,
				searchPaths,
				applyFlag,
				{ strictness, lineage, toolCallId: _toolCallId, sessionId },
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
					content: [
						{ type: "text" as const, text: errorTextWithHint(result.error) },
					],
					isError: true,
					details: {},
				};
			}

			const isDryRun = !applyFlag;
			const output = astGrepClient.formatMatches(
				result.matches,
				isDryRun,
				true, // showModeIndicator
				resultMaxItems,
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
					// #5239: the files the apply rewrote, for the `tool_result`
					// handler's dispatch.
					appliedFiles: result.appliedFiles ?? [],
				},
			};
		},
	};
}
