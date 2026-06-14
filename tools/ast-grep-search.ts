/**
 * ast_grep_search tool definition
 *
 * Extracted from index.ts for maintainability.
 */

import { Type } from "typebox";
import type { AstGrepClient } from "../clients/ast-grep-client.js";
import type { AstGrepMatch } from "../clients/ast-grep-types.js";
import {
	astGrepRemediationHint,
	classifyAstGrepError,
	logAstGrepToolEvent,
	type AstGrepToolOutcome,
} from "../clients/ast-grep-tool-logger.js";
import { hasStructuralIntent, synthesizeRule } from "../clients/ast-grep-yaml-synth.js";

/**
 * Build the agent-facing error text, appending a remediation hint derived from
 * the same classification we log. The two curated spawn errors return null from
 * the hint map (their message already carries guidance), so this never doubles
 * up — it only adds value for the raw-stderr categories (#ast-grep tool errors).
 */
function errorTextWithHint(raw: string): string {
	const hint = astGrepRemediationHint(classifyAstGrepError(raw));
	return hint ? `Error: ${raw}\n\n${hint}` : `Error: ${raw}`;
}
import type { SearchReadLocation } from "../clients/search-read-registration.js";
import { LANGUAGES } from "./shared.js";

/** Map matches to the 1-based line spans shown, for read-guard registration (#169). */
function toSearchReads(matches: AstGrepMatch[]): SearchReadLocation[] {
	const out: SearchReadLocation[] = [];
	for (const m of matches) {
		const start = m.range?.start?.line; // ast-grep ranges are 0-based
		if (!m.file || typeof start !== "number") continue;
		const end = m.range?.end?.line;
		out.push({
			file: m.file,
			startLine: start + 1,
			endLine: (typeof end === "number" ? end : start) + 1,
		});
	}
	return out;
}

function lineCount(value: string): number {
	if (!value) return 0;
	let lines = 1;
	for (let i = 0; i < value.length; i++) {
		if (value.charCodeAt(i) === 10) lines++;
	}
	return lines;
}

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
			insideKind: Type.Optional(
				Type.String({
					description:
						"Restrict matches to nodes inside an ancestor of this AST node kind. Example: `insideKind: \"function_declaration\"` finds the pattern only when it appears inside a function body. Searches all ancestors (stopBy: end), not just the immediate parent. Synthesizes a YAML rule — takes precedence over `selector` and `strictness`.",
				}),
			),
			hasKind: Type.Optional(
				Type.String({
					description:
						"Restrict matches to nodes that contain a descendant of this AST node kind. Example: `hasKind: \"await_expression\"` finds the pattern only when it contains an await inside it.",
				}),
			),
			follows: Type.Optional(
				Type.String({
					description:
						"Restrict matches to nodes that immediately follow a sibling matching this pattern. Example: `follows: \"return $X\"` finds the pattern only when preceded by a return statement.",
				}),
			),
			precedes: Type.Optional(
				Type.String({
					description:
						"Restrict matches to nodes that immediately precede a sibling matching this pattern.",
				}),
			),
			rule: Type.Optional(
				Type.String({
					description:
						"Raw ast-grep YAML rule. When provided, routes through `sg scan --config` instead of `sg run -p`, unlocking the full rule DSL. Takes precedence over `pattern` and structural-intent params. The YAML must include `id` and `language` fields.",
				}),
			),
			skip: Type.Optional(
				Type.Number({
					description:
						"Match offset for pagination. Skip the first N matches and return the next page. Use when results are truncated — increment by the page size to retrieve subsequent pages.",
				}),
			),
			strictness: Type.Optional(
				Type.String({
					enum: ["smart", "relaxed", "ast", "cst", "signature", "template"],
					description:
						"Pattern matching strictness. 'smart' (default) ignores comments and whitespace. 'relaxed' also ignores unnamed nodes like punctuation — useful when optional trailing commas cause misses. 'ast' ignores all whitespace. 'signature' matches only structural shape, ignoring bodies.",
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
			const { pattern, paths, selector, context, skip, strictness, rule,
				insideKind, hasKind, follows, precedes } = params as {
				pattern: string;
				lang: string;
				paths?: string[];
				selector?: string;
				context?: number;
				skip?: number;
				strictness?: string;
				rule?: string;
				insideKind?: string;
				hasKind?: string;
				follows?: string;
				precedes?: string;
			};
			const skipOffset = Math.max(0, Math.floor(skip ?? 0));
			const lang = ((params as { lang: string }).lang ?? "").replace(
				/^"|"$/g,
				"",
			);
			const searchPathsCount = paths?.length ?? 1;

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
						tool: "ast_grep_search",
						lang,
						pattern,
						patternLineCount: lineCount(pattern),
						pathsCount: searchPathsCount,
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
				logOutcome("error", {
					errorRaw: "ast-grep CLI not found",
				});
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

			if (looksLikeRuleYamlOrPlainText(pattern)) {
				logOutcome("error", {
					errorRaw:
						"pattern looks like rule YAML or plain text (rejected pre-spawn)",
				});
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
			const PAGE_SIZE = 50;

			// Phase 3: synthesize YAML from structural-intent params
			let effectiveRule = rule;
			if (!effectiveRule && hasStructuralIntent({ insideKind, hasKind, follows, precedes })) {
				try {
					effectiveRule = synthesizeRule({ pattern, lang, insideKind, hasKind, follows, precedes });
				} catch (err) {
					logOutcome("error", { errorRaw: String(err) });
					return {
						content: [{ type: "text" as const, text: `Error synthesizing rule: ${err}` }],
						isError: true,
						details: {},
					};
				}
			}

			// Phase 4: raw YAML rule passthrough — routes through sg scan --config
			if (effectiveRule && effectiveRule.trim().length > 0) {
				const ruleResult = await astGrepClient.searchWithRule(effectiveRule, searchPaths);
				if (ruleResult.error) {
					logOutcome("error", { errorRaw: ruleResult.error });
					return {
						content: [
							{ type: "text" as const, text: errorTextWithHint(ruleResult.error) },
						],
						isError: true,
						details: {},
					};
				}
				const afterSkip = ruleResult.matches.slice(skipOffset);
				const page = afterSkip.slice(0, PAGE_SIZE);
				const hasMore = afterSkip.length > PAGE_SIZE;
				const output = astGrepClient.formatMatches(page);
				const paginationNote = hasMore && page.length > 0
					? `\n\n(Showing ${page.length} of ${ruleResult.matches.length - skipOffset} remaining matches. Use skip=${skipOffset + PAGE_SIZE} for the next page.)`
					: "";
				logOutcome(page.length === 0 ? "no_matches" : "success", {
					matchCount: page.length,
					truncated: hasMore,
				});
				return {
					content: [{ type: "text" as const, text: `${output}${paginationNote}` }],
					details: {
						matchCount: page.length,
						totalMatches: ruleResult.totalMatches,
						truncated: hasMore,
						hasMore,
						skip: skipOffset,
						// Lines shown to the agent — the read-guard registers these so a
						// follow-up edit to a match isn't blocked (#169). 1-based.
						searchReads: toSearchReads(page),
					},
				};
			}

			const result = await astGrepClient.search(pattern, lang, searchPaths, {
				selector,
				context,
				strictness,
			});

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

			// Apply skip-based pagination over the full in-memory match list.
			const afterSkip = result.matches.slice(skipOffset);
			const page = afterSkip.slice(0, PAGE_SIZE);
			const hasMore = afterSkip.length > PAGE_SIZE || result.truncated;

			const output = astGrepClient.formatMatches(page);
			const hint =
				page.length === 0 && !result.error
					? getPatternHint(pattern, lang, selector)
					: undefined;
			const paginationNote =
				hasMore && page.length > 0
					? `\n\n(Showing ${page.length} of ${result.matches.length - skipOffset} remaining matches. Use skip=${skipOffset + PAGE_SIZE} for the next page.)`
					: "";
			const finalOutput = hint
				? `${output}\n\n${hint}`
				: `${output}${paginationNote}`;
			logOutcome(page.length === 0 ? "no_matches" : "success", {
				matchCount: page.length,
				truncated: hasMore,
			});
			return {
				content: [{ type: "text" as const, text: finalOutput }],
				details: {
					matchCount: page.length,
					totalMatches: result.matches.length,
					truncated: hasMore,
					hasMore,
					skip: skipOffset,
					// Lines shown to the agent — registered as reads by the read-guard
					// so a follow-up edit to a match isn't blocked (#169). 1-based.
					searchReads: toSearchReads(page),
				},
			};
		},
	};
}
