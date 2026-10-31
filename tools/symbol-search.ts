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
import { readPathsArgument } from "./shared.js";

export function createSymbolSearchTool(getProjectRoot: () => string) {
	return {
		name: "symbol_search" as const,
		label: "Symbol Search",
		description:
			"Find relevant files by ranked identifier search. On a cold cache, project_report and symbol_search return available: false with a retry hint and start a non-blocking background build; module_report degrades to outline-only with cache freshness explicit. Example: search `authenticate user` before module_report.",
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
				description:
					"Identifier-ish query, e.g. 'authenticate user'. Mix in composable prefix filters: lang:<kind> (e.g. lang:jsts, lang:python — kinds from file-kinds.ts), file:<substr> (path substring), ext:<ext> (e.g. ext:ts or ext:.ts), each optionally negated with a leading '-' (-file:test). Filters apply before ranking; e.g. 'lang:jsts file:clients/ -file:test rank'. Unknown prefixes/kinds error with the supported list.",
			}),
			limit: Type.Optional(
				Type.Number({
					description: "Max files to return (default 20).",
				}),
			),
			paths: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Glob array scoping hits to matching files — same shape/semantics as ast_grep_search's `paths` (a bare directory/file entry scopes its whole subtree). Filters before ranking, so scores within the scoped set are unaffected.",
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
			const pathsRead = readPathsArgument(params.paths, { cwd });
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
