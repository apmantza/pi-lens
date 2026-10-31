import type {
	AstGrepClient,
	AstGrepOutlineFile,
	AstGrepOutlineItem,
} from "../clients/ast-grep-client.js";
import { Type } from "../clients/deps/typebox.js";
import { toProjectRelativePath } from "../clients/path-utils.js";
import { compactRenderResult } from "./render-compact.js";
import {
	MAX_PATHS_ENTRIES,
	readAstGrepLang,
	readPathsArgument,
} from "./shared.js";

// Cap the wire payload so an outline over a large directory can't flood context.
const MAX_FILES = 50;
const MAX_ITEMS_PER_FILE = 200;

/**
 * One text line per symbol, range first as `module_report` view `compact`
 * does: `start-end [import|export ]kind name[ — signature]`, 1-based inclusive
 * (the CLI emits 0-based lines), two spaces per nesting level. A signature that
 * is empty or only echoes the name is dropped (#5071). A name or signature the
 * source splits over lines (a Java import) keeps its line break in the CLI JSON,
 * so every whitespace run collapses to one space and the item stays one line.
 */
function renderItem(item: AstGrepOutlineItem, depth: number): string[] {
	const range = `${item.range.start.line + 1}-${item.range.end.line + 1}`;
	const marker = item.isImport ? "import " : item.isExported ? "export " : "";
	const flat = (text: string) => text.replace(/\s+/g, " ").trim();
	const name = flat(item.name);
	const flatSignature = item.signature ? flat(item.signature) : "";
	const signature =
		flatSignature && flatSignature !== name ? ` \u2014 ${flatSignature}` : "";
	return [
		`${"  ".repeat(depth)}${range} ${marker}${item.symbolType} ${name}${signature}`,
		...(item.members ?? []).flatMap((m) => renderItem(m, depth + 1)),
	];
}

function errorResult(text: string) {
	return {
		content: [{ type: "text" as const, text }],
		isError: true,
		details: {},
	};
}

export function createAstGrepOutlineTool(astGrepClient: AstGrepClient) {
	return {
		name: "ast_grep_outline" as const,
		label: "AST-Grep Outline",
		description:
			"Return syntax-only symbols, imports, exports, and members with ast-grep, one `start-end kind name` line each; read a range with offset=start, limit=end-start+1. An outline shows structure, not a symbol body, and does not satisfy read-before-edit; use read_symbol or read_enclosing for body coverage. Example: outline `src/` before choosing a symbol to read.",
		promptSnippet: "Inspect syntax without index or LSP",
		renderResult: compactRenderResult<{
			files?: number;
			items?: number;
			truncatedFiles?: boolean;
		}>(({ details, isError, text }) => {
			if (isError) {
				return `ast_grep_outline — ${text.split("\n")[0] ?? "error"}`;
			}
			const files = details?.files ?? 0;
			const items = details?.items ?? 0;
			const trunc = details?.truncatedFiles ? " (truncated)" : "";
			return `ast_grep_outline — ${items} symbols across ${files} file${files === 1 ? "" : "s"}${trunc}`;
		}),
		parameters: Type.Object({
			paths: Type.Array(Type.String(), {
				minItems: 1,
				maxItems: MAX_PATHS_ENTRIES,
				description:
					"Files or directories to outline (workspace-relative or absolute).",
			}),
			lang: Type.Optional(
				Type.String({
					description:
						"Language id, e.g. typescript, python; inferred per file when omitted.",
				}),
			),
			items: Type.Optional(
				Type.String({
					enum: ["auto", "structure", "exports", "imports", "all"],
					description:
						"Which top-level items to include. auto = `structure` for a file, `exports` for a directory (default).",
				}),
			),
			view: Type.Optional(
				Type.String({
					enum: ["auto", "names", "signatures", "digest", "expanded"],
					description:
						"Text presentation level for the underlying outline; `expanded` shows members.",
				}),
			),
			type: Type.Optional(
				Type.Array(Type.String(), {
					description:
						'Keep only these symbol types, e.g. ["class","function"].',
				}),
			),
			match: Type.Optional(
				Type.String({
					description:
						"Keep only top-level items whose name matches this regex.",
				}),
			),
			pubMembers: Type.Optional(
				Type.Boolean({
					description: "Show only public members in member views.",
				}),
			),
			globs: Type.Optional(
				Type.Array(Type.String(), {
					description:
						'Include/exclude file globs for directory input, e.g. ["*.ts","!**/dist/**"].',
				}),
			),
		}),
		async execute(
			_toolCallId: string,
			params: {
				paths?: string[];
				lang?: string;
				items?: string;
				view?: string;
				type?: string[];
				match?: string;
				pubMembers?: boolean;
				globs?: string[];
			},
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: { cwd?: string },
		) {
			const cwd = ctx.cwd || ".";
			// #5041: the shared `paths` reader owns the entry rules (non-string,
			// blank, empty list, cap) and the host-path spelling for every tool.
			const pathsRead = readPathsArgument(params.paths, { cwd });
			if (pathsRead.refusal) return errorResult(`Error: ${pathsRead.refusal}`);
			if (pathsRead.entries.length === 0)
				return errorResult("paths is required");
			const { lang, refusal: langError } = readAstGrepLang(params.lang, false);
			if (langError) return errorResult(`Error: ${langError}`);
			// The CLI receives absolute targets (execFile-style args — no shell
			// interpolation).
			const absPaths = pathsRead.entries;

			if (!(await astGrepClient.ensureAvailable())) {
				return errorResult(
					"ast-grep CLI not found. Install: npm i -D @ast-grep/cli",
				);
			}

			let result: { output?: AstGrepOutlineFile[]; error?: string };
			try {
				result = await astGrepClient.outline(absPaths, {
					lang: lang || undefined,
					items: params.items,
					view: params.view,
					types: params.type,
					match: params.match,
					pubMembers: params.pubMembers,
					globs: params.globs,
				});
			} catch (err) {
				return errorResult(
					`Error: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			if (result.error) return errorResult(`Error: ${result.error}`);

			// Each header is the project-relative POSIX path (absolute outside the
			// project), and the sort runs on that header before the cap: the CLI's
			// walker order differs per run, and a sort on the absolute path kept a
			// different 50 files on a `\` host than on a `/` host (#5071 r2 F1).
			const all = (result.output ?? [])
				.map((file) => ({
					file,
					header: toProjectRelativePath(file.path, cwd),
				}))
				.sort((a, b) =>
					a.header < b.header ? -1 : a.header > b.header ? 1 : 0,
				);
			const files = all.slice(0, MAX_FILES);
			const truncatedFiles = all.length > MAX_FILES;
			const totalItems = files.reduce((n, f) => n + f.file.items.length, 0);
			if (files.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: "No outline items found (syntax-only — try module_report, or check lang/paths).",
						},
					],
					details: { files: 0, items: 0 },
				};
			}
			const lines = files.flatMap(({ file, header }) => [
				header,
				...file.items
					.slice(0, MAX_ITEMS_PER_FILE)
					.flatMap((item) => renderItem(item, 0)),
				...(file.items.length > MAX_ITEMS_PER_FILE
					? [
							`... ${file.items.length - MAX_ITEMS_PER_FILE} more items not shown (cap ${MAX_ITEMS_PER_FILE})`,
						]
					: []),
			]);
			if (truncatedFiles) {
				lines.push(
					`... ${all.length - MAX_FILES} more files not shown (cap ${MAX_FILES})`,
				);
			}
			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: {
					files: files.length,
					items: totalItems,
					syntaxOnly: true,
					...(truncatedFiles ? { truncatedFiles: true } : {}),
				},
			};
		},
	};
}
