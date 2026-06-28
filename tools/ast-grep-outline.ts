import * as path from "node:path";
import type {
	AstGrepClient,
	AstGrepOutlineFile,
	AstGrepOutlineItem,
} from "../clients/ast-grep-client.js";
import { Type } from "../clients/deps/typebox.js";
import { compactRenderResult } from "./render-compact.js";
import { LANGUAGES } from "./shared.js";

// Cap the wire payload so an outline over a large directory can't flood context.
const MAX_FILES = 50;
const MAX_ITEMS_PER_FILE = 200;

type OutlineEntry = Omit<AstGrepOutlineItem, "members"> & {
	read: { path: string; offset: number; limit: number };
	members?: OutlineEntry[];
};

/** Attach ready `read` args (1-based) to each item/member from its 0-based range. */
function withReadHandles(
	filePath: string,
	item: AstGrepOutlineItem,
): OutlineEntry {
	const { members, ...rest } = item;
	const offset = item.range.start.line + 1;
	const limit = Math.max(1, item.range.end.line - item.range.start.line + 1);
	return {
		...rest,
		read: { path: filePath, offset, limit },
		...(members
			? { members: members.map((m) => withReadHandles(filePath, m)) }
			: {}),
	};
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
			"Syntax-only code structure (symbols, imports, exports, and members) via " +
			"`ast-grep outline`. Fast, local, no index/LSP/cross-file semantics — useful " +
			"for languages or structures where pi-lens's own extractor is weak, or for a " +
			"raw second opinion.\n\n" +
			"Prefer module_report for pi-lens-aware navigation (who-uses-this, " +
			"complexity/fanout, recommendedReads, blast radius, callback handles). Use " +
			"ast_grep_outline when you want the syntax tree's own view of a file or a " +
			"whole directory.\n\n" +
			"Returns JSON: per file, `items[]` with name/symbolType/signature/range, " +
			"`isExported`/`isImport`, nested `members[]` (with `isPublic`), and ready " +
			"`read` args on every entry. NOTE: structure only — an outline is NOT a read " +
			"of a symbol's body (use read_symbol/read_enclosing for that).",
		promptSnippet:
			"Syntax-only code outline via ast-grep (no index/LSP); module_report is the richer default",
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
				maxItems: 100,
				description:
					"Files or directories to outline (workspace-relative or absolute).",
			}),
			lang: Type.Optional(
				Type.String({
					enum: [...LANGUAGES] as string[],
					description:
						"Restrict to one language. Required for stdin; for paths, ast-grep infers per file when omitted.",
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
					description: "Keep only top-level items whose name matches this regex.",
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
			const rawPaths = (params.paths ?? []).filter(
				(p): p is string => typeof p === "string" && p.trim().length > 0,
			);
			if (rawPaths.length === 0) return errorResult("paths is required");
			// Resolve relative paths against the workspace; pass absolute paths to the
			// CLI (execFile-style args — no shell interpolation).
			const absPaths = rawPaths.map((p) =>
				path.isAbsolute(p) ? p : path.resolve(cwd, p),
			);

			if (!(await astGrepClient.ensureAvailable())) {
				return errorResult(
					"ast-grep CLI not found. Install: npm i -D @ast-grep/cli",
				);
			}

			let result: { output?: AstGrepOutlineFile[]; error?: string };
			try {
				result = await astGrepClient.outline(absPaths, {
					lang: params.lang,
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

			const files = (result.output ?? []).slice(0, MAX_FILES);
			const truncatedFiles = (result.output?.length ?? 0) > MAX_FILES;
			const outline = files.map((file) => ({
				path: file.path,
				language: file.language,
				items: file.items
					.slice(0, MAX_ITEMS_PER_FILE)
					.map((item) => withReadHandles(file.path, item)),
				...(file.items.length > MAX_ITEMS_PER_FILE
					? { truncatedItems: file.items.length - MAX_ITEMS_PER_FILE }
					: {}),
			}));

			const totalItems = files.reduce((n, f) => n + f.items.length, 0);
			if (outline.length === 0) {
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
			return {
				content: [{ type: "text" as const, text: JSON.stringify({ outline }) }],
				details: {
					files: outline.length,
					items: totalItems,
					syntaxOnly: true,
					...(truncatedFiles ? { truncatedFiles: true } : {}),
				},
			};
		},
	};
}
