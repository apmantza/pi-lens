import { Type } from "typebox";
import type { AstGrepClient } from "../clients/ast-grep-client.js";
import { LANGUAGES } from "./shared.js";

export function createAstDumpTool(astGrepClient: AstGrepClient) {
	return {
		name: "ast_dump" as const,
		label: "AST Dump",
		description:
			"Dump the tree-sitter AST for a source snippet using ast-grep CLI. Use this when ast_grep_search returns zero matches and you need to discover exact node kinds, field names, or nesting. Named nodes only by default; includeAnonymous=true shows punctuation/CST nodes too.",
		promptSnippet:
			"Use ast_dump to inspect AST node kinds before writing difficult ast-grep patterns",
		parameters: Type.Object({
			source: Type.String({
				description: "Source code snippet to parse and dump",
			}),
			lang: Type.String({
				enum: [...LANGUAGES] as string[],
				description: "Target language",
			}),
			includeAnonymous: Type.Optional(
				Type.Boolean({
					description:
						"Show anonymous punctuation/CST nodes too (default false)",
				}),
			),
		}),
		async execute(
			_toolCallId: string,
			params: Record<string, unknown>,
			_signal: AbortSignal,
			_onUpdate: unknown,
		) {
			const source = typeof params.source === "string" ? params.source : "";
			const lang =
				typeof params.lang === "string"
					? params.lang.replace(/^"|"$/g, "")
					: "";
			const includeAnonymous = params.includeAnonymous === true;

			if (!source.trim()) {
				return {
					content: [{ type: "text" as const, text: "source is required" }],
					isError: true,
					details: { lang, includeAnonymous },
				};
			}

			if (!(await astGrepClient.ensureAvailable())) {
				return {
					content: [
						{
							type: "text" as const,
							text: "ast-grep CLI not found. Install: npm i -D @ast-grep/cli",
						},
					],
					isError: true,
					details: { lang, includeAnonymous },
				};
			}

			const result = await astGrepClient.dumpAst(source, lang, {
				includeAnonymous,
			});
			if (result.error) {
				return {
					content: [{ type: "text" as const, text: `Error: ${result.error}` }],
					isError: true,
					details: { lang, includeAnonymous },
				};
			}

			return {
				content: [{ type: "text" as const, text: result.output ?? "" }],
				details: { lang, includeAnonymous },
			};
		},
	};
}
