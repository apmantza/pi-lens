import { Type } from "../clients/deps/typebox.js";
import type { AstGrepClient } from "../clients/ast-grep-client.js";
import { compactRenderResult } from "./render-compact.js";
import { LANGUAGES } from "./shared.js";

function createAstDumpToolWithName(
	astGrepClient: AstGrepClient,
	name: "ast_grep_dump",
) {
	return {
		name,
		label: "AST-Grep Dump",
		description:
			"Dump the tree-sitter AST for a source snippet using ast-grep CLI. Use when ast_grep_search returns zero matches and you need exact node kinds, field names, or nesting. Named nodes only by default; includeAnonymous=true shows punctuation/CST nodes too.",
		promptSnippet: "Inspect AST node kinds before writing ast-grep patterns",
		renderResult: compactRenderResult<{ lang?: string }>(
			({ details, args, isError, lineCount, text }) => {
				const lang =
					details?.lang ?? (typeof args.lang === "string" ? args.lang : "");
				if (isError) {
					return `${name} ${lang} — ${text.split("\n")[0] ?? "error"}`.trim();
				}
				return `${name} ${lang} — ${lineCount} AST nodes`.replace(/\s+/g, " ");
			},
		),
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

			try {
				if (!source.trim()) {
					return {
						content: [{ type: "text" as const, text: "source is required" }],
						isError: true,
						details: { lang, includeAnonymous },
					};
				}

				if (_signal.aborted) {
					return {
						content: [
							{ type: "text" as const, text: "Error: operation aborted" },
						],
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

				if (_signal.aborted) {
					return {
						content: [
							{ type: "text" as const, text: "Error: operation aborted" },
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
						content: [
							{ type: "text" as const, text: `Error: ${result.error}` },
						],
						isError: true,
						details: { lang, includeAnonymous },
					};
				}

				return {
					content: [{ type: "text" as const, text: result.output ?? "" }],
					details: { lang, includeAnonymous },
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: `Error: ${message}` }],
					isError: true,
					details: { lang, includeAnonymous },
				};
			}
		},
	};
}

export function createAstGrepDumpTool(astGrepClient: AstGrepClient) {
	return createAstDumpToolWithName(astGrepClient, "ast_grep_dump");
}
