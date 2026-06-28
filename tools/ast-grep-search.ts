/**
 * ast_grep_search tool definition
 *
 * Extracted from index.ts for maintainability.
 */

import { Type } from "../clients/deps/typebox.js";
import type { AstGrepClient } from "../clients/ast-grep-client.js";
import type { AstGrepMatch } from "../clients/ast-grep-types.js";
import {
	astGrepRemediationHint,
	classifyAstGrepError,
	logAstGrepToolEvent,
	type AstGrepToolOutcome,
} from "../clients/ast-grep-tool-logger.js";
import {
	hasStructuralIntent,
	synthesizeRule,
} from "../clients/ast-grep-yaml-synth.js";
import type { SearchReadLocation } from "../clients/search-read-registration.js";
import { compactRenderResult } from "./render-compact.js";
import { LANGUAGES } from "./shared.js";

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

export function _telemetryErrorForTest(
	raw: string | undefined,
): string | undefined {
	if (!raw) return undefined;
	return raw.replace(/\0/g, "\\0").slice(0, 2_000);
}

export function _telemetryClassificationErrorForTest(
	raw: string | undefined,
): string | undefined {
	return raw?.replace(/\0/g, "");
}

/** Map matches to the 1-based line spans shown, for read-guard registration (#169). */
function toSearchReads(matches: AstGrepMatch[]): SearchReadLocation[] {
	const out: SearchReadLocation[] = [];
	for (const m of matches) {
		const span = toLineSpan(m);
		if (!span) continue;
		out.push({
			file: span.file,
			startLine: span.startLine,
			endLine: span.endLine,
		});
	}
	return out;
}

// Default and ceiling for matches returned per call. `maxMatches` lets a caller
// trade volume for completeness within these bounds (the default preserves the
// historical page size).
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/**
 * Compact, file-grouped rendering for high-volume searches (refs #345). Instead
 * of each match's full body, emit one line per file with its 1-based
 * `L<line>:<col>` locations — a distribution view that drills in via the read
 * slices already surfaced in `details.matchLocations`/`searchReads`.
 */
function formatGroupedByFile(matches: AstGrepMatch[]): string {
	const byFile = new Map<string, AstGrepMatch[]>();
	for (const m of matches) {
		if (!m.file) continue;
		const list = byFile.get(m.file);
		if (list) list.push(m);
		else byFile.set(m.file, [m]);
	}
	const total = matches.length;
	const fileCount = byFile.size;
	const lines = [
		`${fileCount} file${fileCount === 1 ? "" : "s"}, ${total} match${total === 1 ? "" : "es"}:`,
	];
	for (const [file, group] of byFile) {
		const locs = group
			.map((m) => {
				const line = (m.range?.start?.line ?? 0) + 1;
				const col = (m.range?.start?.column ?? 0) + 1;
				return `L${line}:${col}`;
			})
			.join(", ");
		lines.push(`${file} (${group.length}): ${locs}`);
	}
	return lines.join("\n");
}

type MatchLocation = {
	file: string;
	line: number;
	endLine: number;
	readSlice: { path: string; offset: number; limit: number };
};

const DEFAULT_READ_SLICE_MARGIN = 3;
const MAX_READ_SLICE_MARGIN = 20;
const MAX_RAW_RULE_CHARS = 100_000;

function rawRuleValidationError(rule: string | undefined): string | null {
	if (rule === undefined) return null;
	if (rule.includes("\0")) return "rule contains a NUL byte";
	if (rule.length > MAX_RAW_RULE_CHARS) return "rule is too long";
	return null;
}

function patternValidationError(pattern: string): string | null {
	if (pattern.includes("\0")) return "pattern contains a NUL byte";
	if (pattern.length > 4_000) return "pattern is too long";
	return null;
}

function toLineSpan(
	match: AstGrepMatch,
): { file: string; startLine: number; endLine: number } | null {
	const start = match.range?.start?.line; // ast-grep ranges are 0-based
	if (!match.file || typeof start !== "number") return null;
	const end = match.range?.end?.line;
	return {
		file: match.file,
		startLine: start + 1,
		endLine: (typeof end === "number" ? end : start) + 1,
	};
}

function toMatchLocations(
	matches: AstGrepMatch[],
	contextLines: number | undefined,
): MatchLocation[] {
	const margin =
		typeof contextLines === "number" && Number.isFinite(contextLines)
			? Math.min(MAX_READ_SLICE_MARGIN, Math.max(0, Math.floor(contextLines)))
			: DEFAULT_READ_SLICE_MARGIN;
	const out: MatchLocation[] = [];
	for (const match of matches) {
		const span = toLineSpan(match);
		if (!span) continue;
		const offset = Math.max(1, span.startLine - margin);
		out.push({
			file: span.file,
			line: span.startLine,
			endLine: span.endLine,
			readSlice: {
				path: span.file,
				offset,
				limit: span.endLine - offset + 1 + margin,
			},
		});
	}
	return out;
}

function suggestedDump(lang: string): {
	tool: "ast_grep_dump";
	lang: string;
	note: string;
} {
	return {
		tool: "ast_grep_dump",
		lang,
		note: "Run ast_grep_dump on a small representative source snippet (not a whole file) to inspect AST node kinds before retrying ast_grep_search.",
	};
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

	return "Hint: No matches. Retry once with a smaller valid AST pattern scoped to the same paths (for example a call like `foo($$$ARGS)`, an import statement, or `function $NAME($$$ARGS) { $$$BODY }`). If that also fails, use grep for text search, lsp_navigation for symbol lookup, or ast_grep_dump on a small representative snippet to inspect node kinds.";
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
			"Use 'context' to show surrounding lines. If zero matches, retry once with a simpler AST pattern, then use ast_grep_dump on a small representative snippet before falling back to grep.",
		promptSnippet: "AST-aware structural code search",
		renderResult: compactRenderResult<{
			matchCount?: number;
			totalMatches?: number;
			truncated?: boolean;
			valid?: boolean;
			validateOnly?: boolean;
			mode?: string;
			applied?: boolean;
		}>(({ details, isError, text }) => {
			if (details?.validateOnly) {
				const mode = details.mode ?? "pattern";
				return details.valid
					? `ast_grep_search — valid ${mode}`
					: `ast_grep_search — invalid ${mode}`;
			}
			if (isError) {
				return `ast_grep_search — ${text.split("\n")[0] ?? "error"}`;
			}
			const count = details?.matchCount ?? 0;
			const total = details?.totalMatches;
			const ofTotal =
				typeof total === "number" && total > count ? ` of ${total}` : "";
			const applied = details?.applied ? " (applied)" : "";
			return `ast_grep_search — ${count}${ofTotal} match${count === 1 && !ofTotal ? "" : "es"}${applied}`;
		}),
		parameters: Type.Object({
			pattern: Type.Optional(
				Type.String({
					description:
						"AST pattern (use function/class/call context, not text). Required unless `rule` is provided.",
				}),
			),
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
						'Restrict matches to nodes inside an ancestor of this AST node kind. Example: `insideKind: "function_declaration"` finds the pattern only when it appears inside a function body. Searches all ancestors (stopBy: end), not just the immediate parent. Synthesizes a YAML rule — takes precedence over `selector` and `strictness`.',
				}),
			),
			hasKind: Type.Optional(
				Type.String({
					description:
						'Restrict matches to nodes that contain a descendant of this AST node kind. Example: `hasKind: "await_expression"` finds the pattern only when it contains an await inside it.',
				}),
			),
			follows: Type.Optional(
				Type.String({
					description:
						'Restrict matches to nodes that immediately follow a sibling matching this pattern. Example: `follows: "return $X"` finds the pattern only when preceded by a return statement.',
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
			maxMatches: Type.Optional(
				Type.Number({
					description: `Cap on matches returned per call (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}). Lower it to keep a broad search compact; raise it to page less. Also sets the pagination step for skip.`,
				}),
			),
			groupByFile: Type.Optional(
				Type.Boolean({
					description:
						"Render results grouped by file (one line per file with L<line>:<col> locations) instead of each match's body. Compact distribution view for high-volume searches; match read-slices remain in details.matchLocations.",
				}),
			),
			strictness: Type.Optional(
				Type.String({
					enum: ["smart", "relaxed", "ast", "cst", "signature", "template"],
					description:
						"Pattern matching strictness. 'smart' (default) ignores comments and whitespace. 'relaxed' also ignores unnamed nodes like punctuation — useful when optional trailing commas cause misses. 'ast' ignores all whitespace. 'signature' matches only structural shape, ignoring bodies.",
				}),
			),
			validateOnly: Type.Optional(
				Type.Boolean({
					description:
						"Validate/compile the pattern or rule without scanning project files. Helps distinguish a bad pattern/rule from a real no-match result.",
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
			const {
				paths,
				selector,
				context,
				skip,
				maxMatches,
				groupByFile,
				strictness,
				rule,
				insideKind,
				hasKind,
				follows,
				precedes,
				validateOnly,
			} = params as {
				pattern?: string;
				lang?: string;
				paths?: string[];
				selector?: string;
				context?: number;
				skip?: number;
				maxMatches?: number;
				groupByFile?: boolean;
				strictness?: string;
				rule?: string;
				insideKind?: string;
				hasKind?: string;
				follows?: string;
				precedes?: string;
				validateOnly?: boolean;
			};
			const pattern = typeof params.pattern === "string" ? params.pattern : "";
			const rawLang = typeof params.lang === "string" ? params.lang : "";
			const skipOffset = Math.max(0, Math.floor(skip ?? 0));
			const lang = rawLang.replace(/^"|"$/g, "");
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
					const errorRaw = _telemetryErrorForTest(details.errorRaw);
					const classificationError = _telemetryClassificationErrorForTest(
						details.errorRaw,
					);
					logAstGrepToolEvent({
						tool: "ast_grep_search",
						lang,
						pattern,
						patternLineCount: lineCount(pattern),
						pathsCount: searchPathsCount,
						outcome,
						errorKind:
							outcome === "error"
								? classifyAstGrepError(classificationError)
								: undefined,
						errorRaw,
						matchCount: details.matchCount ?? 0,
						truncated: details.truncated ?? false,
						durationMs: Date.now() - startedAt,
					});
				} catch (err) {
					// Telemetry must never break the tool path. Surface failures through
					// Node's warning channel instead of console output.
					try {
						process.emitWarning(`ast_grep_search telemetry failed: ${err}`, {
							code: "PI_LENS_AST_GREP_SEARCH_TELEMETRY_FAILED",
						});
					} catch {
						void err;
					}
				}
			}

			function abortError() {
				logOutcome("error", { errorRaw: "operation aborted" });
				return {
					content: [
						{ type: "text" as const, text: "Error: operation aborted" },
					],
					isError: true,
					details: {},
				};
			}

			try {
				const rawRule = typeof rule === "string" ? rule : undefined;
				const hasRawRule = !!rawRule?.trim();
				const rawRuleError = rawRuleValidationError(rawRule);
				if (rawRuleError) {
					logOutcome("error", { errorRaw: rawRuleError });
					return {
						content: [
							{ type: "text" as const, text: `Error: ${rawRuleError}` },
						],
						isError: true,
						details: {},
					};
				}

				if (!pattern.trim() && !hasRawRule) {
					logOutcome("error", { errorRaw: "pattern is required" });
					return {
						content: [
							{ type: "text" as const, text: "Error: pattern is required" },
						],
						isError: true,
						details: {},
					};
				}
				const patternError = patternValidationError(pattern);
				if (pattern.trim() && patternError) {
					logOutcome("error", { errorRaw: patternError });
					return {
						content: [
							{ type: "text" as const, text: `Error: ${patternError}` },
						],
						isError: true,
						details: {},
					};
				}

				if (!lang.trim()) {
					logOutcome("error", { errorRaw: "lang is required" });
					return {
						content: [
							{ type: "text" as const, text: "Error: lang is required" },
						],
						isError: true,
						details: {},
					};
				}

				if (_signal.aborted) return abortError();

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
				if (_signal.aborted) return abortError();

				if (!hasRawRule && looksLikeRuleYamlOrPlainText(pattern)) {
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
				const PAGE_SIZE = Math.max(
					1,
					Math.min(
						MAX_PAGE_SIZE,
						Number.isFinite(maxMatches as number)
							? Math.floor(maxMatches as number)
							: DEFAULT_PAGE_SIZE,
					),
				);

				// Phase 3: synthesize YAML from structural-intent params
				let effectiveRule = hasRawRule ? rawRule : undefined;
				if (
					!effectiveRule &&
					hasStructuralIntent({ insideKind, hasKind, follows, precedes })
				) {
					try {
						effectiveRule = synthesizeRule({
							pattern,
							lang,
							insideKind,
							hasKind,
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
				}

				if (validateOnly) {
					const validation = effectiveRule?.trim()
						? await astGrepClient.validateRule(effectiveRule)
						: await astGrepClient.validatePattern(pattern, lang, {
								selector,
								strictness,
							});
					if (!validation.valid) {
						logOutcome("error", { errorRaw: validation.error });
						return {
							content: [
								{
									type: "text" as const,
									text: `Invalid ast-grep ${effectiveRule ? "rule" : "pattern"}: ${validation.error ?? "unknown error"}`,
								},
							],
							isError: true,
							details: { valid: false, validateOnly: true },
						};
					}
					logOutcome("success", { matchCount: 0 });
					const warning =
						"warning" in validation ? validation.warning : undefined;
					return {
						content: [
							{
								type: "text" as const,
								text: `Valid ast-grep ${effectiveRule ? "rule" : "pattern"}.${warning ? ` Warning: ${warning}` : ""}`,
							},
						],
						details: {
							valid: true,
							validateOnly: true,
							mode: effectiveRule ? "rule" : "pattern",
							...(warning ? { warning } : {}),
						},
					};
				}

				// Phase 4: raw YAML rule passthrough — routes through sg scan --config
				if (effectiveRule && effectiveRule.trim().length > 0) {
					if (_signal.aborted) return abortError();
					const ruleResult = await astGrepClient.searchWithRule(
						effectiveRule,
						searchPaths,
					);
					if (_signal.aborted) return abortError();
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
					const afterSkip = ruleResult.matches.slice(skipOffset);
					const page = afterSkip.slice(0, PAGE_SIZE);
					const hasMore = afterSkip.length > PAGE_SIZE;
					const output = groupByFile
						? formatGroupedByFile(page)
						: astGrepClient.formatMatches(page);
					const paginationNote =
						hasMore && page.length > 0
							? `\n\n(Showing ${page.length} of ${ruleResult.matches.length - skipOffset} remaining matches. Use skip=${skipOffset + PAGE_SIZE} for the next page.)`
							: "";
					logOutcome(page.length === 0 ? "no_matches" : "success", {
						matchCount: page.length,
						truncated: hasMore,
					});
					const matchLocations = toMatchLocations(page, context);
					return {
						content: [
							{ type: "text" as const, text: `${output}${paginationNote}` },
						],
						details: {
							matchCount: page.length,
							totalMatches: ruleResult.totalMatches,
							truncated: hasMore,
							hasMore,
							skip: skipOffset,
							groupByFile: groupByFile === true,
							// Lines shown to the agent — the read-guard registers these so a
							// follow-up edit to a match isn't blocked (#169). 1-based.
							searchReads: toSearchReads(page),
							// Agent-facing follow-up handles for bounded context reads.
							matchLocations,
							suggestedDump:
								page.length === 0 ? suggestedDump(lang) : undefined,
						},
					};
				}

				if (_signal.aborted) return abortError();
				const result = await astGrepClient.search(pattern, lang, searchPaths, {
					selector,
					context,
					strictness,
				});
				if (_signal.aborted) return abortError();

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

				const output = groupByFile
					? formatGroupedByFile(page)
					: astGrepClient.formatMatches(page);
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
				const matchLocations = toMatchLocations(page, context);
				return {
					content: [{ type: "text" as const, text: finalOutput }],
					details: {
						matchCount: page.length,
						totalMatches: result.matches.length,
						truncated: hasMore,
						hasMore,
						skip: skipOffset,
						groupByFile: groupByFile === true,
						// Lines shown to the agent — registered as reads by the read-guard
						// so a follow-up edit to a match isn't blocked (#169). 1-based.
						searchReads: toSearchReads(page),
						// Agent-facing follow-up handles for bounded context reads.
						matchLocations,
						suggestedDump: page.length === 0 ? suggestedDump(lang) : undefined,
					},
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				logOutcome("error", { errorRaw: message });
				return {
					content: [{ type: "text" as const, text: `Error: ${message}` }],
					isError: true,
					details: {},
				};
			}
		},
	};
}
