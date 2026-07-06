/**
 * Shared tree-sitter helpers for the fact providers (#402).
 *
 * The fact extractors (comment/try-catch/function/import) parse JS/TS via the
 * shared, cached tree-sitter client instead of the `typescript` compiler. This
 * module centralises the parse boilerplate + node-walk utilities so each provider
 * is just its extraction logic.
 */
import {
	getSharedTreeSitterClient,
	resolveTreeSitterLanguage,
} from "../../tree-sitter-shared.js";
import type { FactStore } from "../fact-store.js";
import type { DispatchContext } from "../types.js";

// biome-ignore lint/suspicious/noExplicitAny: web-tree-sitter node (see tree-sitter-client.ts)
export type TsNode = any;

/**
 * Parse `content` for `filePath` via the shared tree-sitter client and return the
 * root node, or null when the grammar is unavailable / parse fails / wasm aborted.
 * init() lazily loads the grammar (memoized) and must run before parseFile.
 */
export async function parseFactTree(
	filePath: string,
	content: string,
): Promise<TsNode | null> {
	const languageId = resolveTreeSitterLanguage(filePath);
	const client = getSharedTreeSitterClient();
	if (!languageId || !client || !(await client.init())) return null;
	const tree = await client.parseFile(filePath, languageId, content);
	return tree ? tree.rootNode : null;
}

/**
 * Provider shell for tree-sitter-backed fact extractors: read `file.content`,
 * parse via the shared client, and hand the root node to `extract`. On empty
 * content / parse failure / wasm abort it writes the empty `defaults` and returns
 * (there is no typescript-compiler fallback by design, #402). Centralising this
 * keeps each provider to just its extraction logic (and de-duplicates the prologue).
 */
export async function extractFactsFromTree(
	ctx: DispatchContext,
	store: FactStore,
	defaults: Record<string, unknown[]>,
	extract: (root: TsNode, content: string) => Record<string, unknown[]>,
): Promise<void> {
	const writeAll = (facts: Record<string, unknown[]>): void => {
		for (const key of Object.keys(defaults)) {
			store.setFileFact(ctx.filePath, key, facts[key] ?? defaults[key]);
		}
	};
	const content = store.getFileFact<string>(ctx.filePath, "file.content");
	if (!content) return writeAll(defaults);
	const root = await parseFactTree(ctx.filePath, content);
	if (!root) return writeAll(defaults);
	writeAll(extract(root, content));
}

export function childrenOfType(node: TsNode, type: string): TsNode[] {
	return (node.children ?? []).filter((c: TsNode) => c && c.type === type);
}

export function firstChildOfType(
	node: TsNode,
	type: string,
): TsNode | undefined {
	return (node.children ?? []).find((c: TsNode) => c && c.type === type);
}

/** Depth-first walk, calling `visit` on every node (pre-order = source order). */
export function walk(node: TsNode, visit: (n: TsNode) => void): void {
	visit(node);
	for (const child of node.children ?? []) {
		if (child) walk(child, visit);
	}
}
