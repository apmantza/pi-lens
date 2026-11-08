/**
 * symbol_search pi tool (#348) — the entry point of the discovery funnel:
 * symbol_search finds ranked candidate files by identifier, module_report
 * explains one, read_symbol reads the exact body. Thin wrapper over the
 * existing symbolSearch() engine seam (clients/lens-engine.ts), mirroring the
 * MCP pilens_symbol_search tool. Both surfaces render through the same
 * `renderCompactSymbolSearch` (clients/lens-engine.ts), so the ranked table,
 * its rows and its footer cannot drift apart (#5104).
 */

import { Type } from "../clients/deps/typebox.js";
import {
	renderCompactSymbolSearch,
	symbolSearch,
	type SymbolSearchResult,
} from "../clients/lens-engine.js";
import { compactRenderResult } from "./render-compact.js";
import { PATHS_GLOB_CLAUSE, readPathsArgument } from "./shared.js";

/**
 * `symbol_search`'s model-facing description, owned HERE (the tool definition)
 * and imported by the MCP mirror so both surfaces resolve to one sentence
 * (#5135). PR 3's schema projection replaces the import with the projected
 * `parameters` object, so nothing temporary is invented in `tools/shared.ts`.
 */
export const SYMBOL_SEARCH_DESCRIPTION =
	"Find relevant files by ranked identifier search. On a cold cache, project_report and symbol_search return available: false with a retry hint and start a non-blocking background build; module_report degrades to outline-only with cache freshness explicit. Example: search `authenticate user` before module_report. Read a listed line with offset=<line>, limit=1. An `ext:` filter matches a path suffix, so `ext:test.ts` matches `foo.test.ts`.";

/**
 * The `query` parameter's contract sentence: the three filter keys, the
 * literal-prefix rule (an unknown `key:` prefix is a search term, not an
 * error), and the listing semantics (a scope with no terms lists the scoped
 * files). Owned here and imported by the MCP mirror (#5135).
 */
export const SYMBOL_SEARCH_QUERY_DESCRIPTION =
	"Identifier-ish query, e.g. 'authenticate user'. Scope hits before ranking with composable prefix filters: lang:<kind|id> (e.g. lang:jsts, lang:typescript), file:<substr> (path substring), ext:<ext> (e.g. ext:ts or ext:.ts), each optionally negated with a leading '-' (-file:test). An unknown key: prefix is a literal search term, not an error; an unknown lang value refuses with the supported list. A scope with no terms lists the scoped files.";

export function createSymbolSearchTool(getProjectRoot: () => string) {
	return {
		name: "symbol_search" as const,
		label: "Symbol Search",
		description: SYMBOL_SEARCH_DESCRIPTION,
		promptSnippet: "Find files by identifier",
		renderResult: compactRenderResult<{
			available?: boolean;
			query?: string;
			count?: number;
			hint?: string;
			unavailableReason?: string;
		}>(({ details, isError }) => {
			if (isError || details?.available === false) {
				return `symbol_search "${details?.query ?? ""}" — unavailable${details?.hint ? `: ${details.hint}` : ""}`;
			}
			return `symbol_search "${details?.query ?? ""}"  ${details?.count ?? 0} file(s)`;
		}),
		parameters: Type.Object({
			query: Type.String({
				description: SYMBOL_SEARCH_QUERY_DESCRIPTION,
			}),
			limit: Type.Optional(
				Type.Number({
					description: "Max files to return (default 20).",
				}),
			),
			paths: Type.Optional(
				Type.Array(Type.String(), {
					description: `Files, directories or globs scoping hits to matching files (a bare directory entry scopes its whole subtree). ${PATHS_GLOB_CLAUSE} Filters before ranking, so scores within the scoped set are unaffected.`,
				}),
			),
			lang: Type.Optional(
				Type.String({
					description:
						"Restrict hits to one language, using the same identifiers as ast_grep_search's `lang` param (e.g. 'typescript', 'python', 'go').",
				}),
			),
		}),
		async execute(
			_toolCallId: string,
			params: {
				query: string;
				limit?: number;
				paths?: string[];
				lang?: string;
			},
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: { cwd?: string },
		) {
			const cwd = getProjectRoot() || ctx.cwd || ".";
			// #5041: one reader owns the `paths` entry rules and the host-path
			// spelling. #5038: the entries reach the engine as host paths, so `src`,
			// `./src` and the absolute directory now scope the same files.
			const pathsRead = await readPathsArgument(params.paths, { cwd });
			if (pathsRead.refusal) {
				return {
					content: [{ type: "text" as const, text: pathsRead.refusal }],
					isError: true,
					details: { available: true, query: params.query },
				};
			}
			let result: SymbolSearchResult;
			try {
				result = await symbolSearch(params.query, cwd, params.limit, {
					...(pathsRead.entries.length > 0 ? { paths: pathsRead.entries } : {}),
					lang: params.lang,
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [
						{
							type: "text" as const,
							text: `Symbol search failed for "${params.query}": ${message}`,
						},
					],
					isError: true,
					details: { available: false, query: params.query },
				};
			}
			// #5135: no terms and no scope is a malformed request, not an empty
			// result — the engine returns the one shared refusal sentence both
			// surfaces print.
			if (result.refusal) {
				return {
					content: [{ type: "text" as const, text: result.refusal }],
					isError: true,
					details: { available: true, query: result.query },
				};
			}

			if (!result.available) {
				return {
					content: [
						{
							type: "text" as const,
							text:
								result.hint ??
								"No word index for this workspace yet — retry shortly.",
						},
					],
					isError: true,
					details: {
						available: false,
						query: result.query,
						hint: result.hint,
						unavailableReason: result.unavailableReason,
					},
				};
			}
			return {
				content: [
					{
						type: "text" as const,
						text: renderCompactSymbolSearch(result, { cwd }),
					},
				],
				details: {
					available: true,
					query: result.query,
					count: result.results.length,
					coverage: result.coverage,
				},
			};
		},
	};
}
