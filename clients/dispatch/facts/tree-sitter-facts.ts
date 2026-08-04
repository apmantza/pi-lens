/**
 * Fact-provider-specific tree-sitter helper (#402).
 *
 * The generic node-walk utilities (`walk`, `childrenOfType`, `firstChildOfType`,
 * `withTreeSitterRoot`, `TsNode`) live in `clients/tree-sitter-shared.ts` so both
 * the fact extractors and the complexity client share them. This module re-exports
 * them for the extractors and adds the FactProvider-specific `extractFactsFromTree`
 * shell.
 */
import {
	childrenOfType,
	firstChildOfType,
	withTreeSitterRoot,
	type TsNode,
	walk,
} from "../../tree-sitter-shared.js";
import type { FactStore } from "../fact-store.js";
import type { DispatchContext } from "../types.js";

export {
	childrenOfType,
	firstChildOfType,
	type TsNode,
	walk,
};

export const withFactTree = withTreeSitterRoot;

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
	coverageFact?: string,
): Promise<void> {
	const writeAll = (facts: Record<string, unknown[]>, complete: boolean): void => {
		for (const key of Object.keys(defaults)) {
			store.setFileFact(ctx.filePath, key, facts[key] ?? defaults[key]);
		}
		if (coverageFact) {
			store.setFileFact(ctx.filePath, coverageFact, complete ? "complete" : "unavailable");
		}
	};
	const content = store.getFileFact<string | null>(ctx.filePath, "file.content");
	if (content == null) return writeAll(defaults, false);
	const parsed = await withFactTree(ctx.filePath, content, (root) =>
		extract(root, content),
	);
	writeAll(parsed.parsed ? parsed.value : defaults, parsed.parsed);
}
