/**
 * Tree-sitter–based read expansion for the read-before-edit guard.
 *
 * When an agent reads a small slice of a file, this module uses the tree-sitter
 * AST to expand the read to cover the entire enclosing symbol (function, method,
 * class). This gives the read guard accurate symbol-level coverage so edits
 * within the symbol pass without requiring the agent to have read every line.
 */

import * as fs from "node:fs";
import type { TreeSitterClient } from "./tree-sitter-client.js";

/** Only expand reads smaller than this (lines). Larger reads don't benefit. */
export const EXPANSION_LIMIT_LINES = 60;

/** Don't expand to a symbol larger than this. */
const EXPANDED_SIZE_CAP_LINES = 300;

/** Async budget for tree-sitter parse + walk. */
export const EXPANSION_BUDGET_MS = 200;

/** File extensions we can parse — mirrors tree-sitter runner. */
const EXT_TO_LANG: Record<string, string> = {
	".ts": "typescript",
	".mts": "typescript",
	".cts": "typescript",
	".tsx": "tsx",
	".js": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
	".jsx": "javascript",
	".py": "python",
	".go": "go",
	".rs": "rust",
	".rb": "ruby",
};

/** AST node types considered "enclosing symbols" for coverage purposes. */
const ENCLOSING_TYPES: Record<string, string[]> = {
	typescript: [
		"function_declaration",
		"function_expression",
		"arrow_function",
		"method_definition",
		"class_declaration",
	],
	tsx: [
		"function_declaration",
		"function_expression",
		"arrow_function",
		"method_definition",
		"class_declaration",
	],
	javascript: [
		"function_declaration",
		"function_expression",
		"arrow_function",
		"method_definition",
		"class_declaration",
	],
	python: ["function_definition", "class_definition", "decorated_definition"],
	go: ["function_declaration", "method_declaration"],
	rust: ["function_item", "impl_item"],
	ruby: ["method", "class", "module"],
};

export interface ExpandedRead {
	newOffset: number;
	newLimit: number;
	enclosingSymbol: {
		name: string;
		kind: string;
		startLine: number;
		endLine: number;
	};
	durationMs: number;
}

// biome-ignore lint/suspicious/noExplicitAny: tree-sitter AST node
function findEnclosingNode(node: any, targetRow: number, types: string[]): any {
	const startRow: number = node.startPosition?.row ?? 0;
	// biome-ignore lint/suspicious/noExplicitAny: endPosition not declared in local interface
	const endRow: number = (node as any).endPosition?.row ?? startRow;

	if (targetRow < startRow || targetRow > endRow) return undefined;

	// Prefer deepest match — check children first.
	for (const child of node.children ?? []) {
		const match = findEnclosingNode(child, targetRow, types);
		if (match) return match;
	}

	return types.includes(node.type) ? node : undefined;
}

// biome-ignore lint/suspicious/noExplicitAny: tree-sitter AST node
function getSymbolName(node: any): string {
	for (const child of node.children ?? []) {
		if (
			child.type === "identifier" ||
			child.type === "property_identifier" ||
			child.type === "name"
		) {
			return child.text as string;
		}
	}
	return node.type as string;
}

function withBudget<T>(
	promise: Promise<T>,
	budgetMs: number,
): Promise<T | undefined> {
	if (budgetMs <= 0) return Promise.resolve(undefined);
	let t: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		promise,
		new Promise<undefined>((resolve) => {
			t = setTimeout(() => resolve(undefined), budgetMs);
		}),
	]).finally(() => {
		if (t) clearTimeout(t);
	});
}

/**
 * Attempt to expand a partial read to its enclosing symbol using tree-sitter.
 *
 * Returns undefined when:
 * - The file extension has no grammar
 * - The read is large (> EXPANSION_LIMIT_LINES) — already covers enough
 * - No enclosing symbol found at the start line
 * - The enclosing symbol is larger than EXPANDED_SIZE_CAP_LINES
 * - Tree-sitter init/parse exceeds EXPANSION_BUDGET_MS
 */
export async function tryExpandRead(
	filePath: string,
	requestedOffset: number,
	requestedLimit: number,
	totalLines: number,
	tsClient: TreeSitterClient,
): Promise<ExpandedRead | undefined> {
	if (requestedLimit > EXPANSION_LIMIT_LINES) return undefined;
	if (requestedLimit >= totalLines) return undefined;

	const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
	const languageId = EXT_TO_LANG[ext];
	if (!languageId) return undefined;

	const enclosingTypes = ENCLOSING_TYPES[languageId];
	if (!enclosingTypes) return undefined;

	const startedAt = Date.now();

	try {
		const content = fs.readFileSync(filePath, "utf8");
		const initOk = await withBudget(tsClient.init(), EXPANSION_BUDGET_MS);
		if (!initOk) return undefined;

		const remaining = Math.max(0, EXPANSION_BUDGET_MS - (Date.now() - startedAt));
		const tree = await withBudget(
			tsClient.parseFile(filePath, languageId, content),
			remaining,
		);
		if (!tree) return undefined;

		// tree-sitter rows are 0-indexed; offsets are 1-indexed
		const targetRow = requestedOffset - 1;
		// biome-ignore lint/suspicious/noExplicitAny: tree-sitter root node
		const enclosing = findEnclosingNode(tree.rootNode as any, targetRow, enclosingTypes);
		if (!enclosing) return undefined;

		const symbolStart: number = enclosing.startPosition.row + 1;
		// biome-ignore lint/suspicious/noExplicitAny: endPosition not in local interface
		const symbolEnd: number = ((enclosing as any).endPosition?.row ?? enclosing.startPosition.row) + 1;
		const symbolSize = symbolEnd - symbolStart + 1;

		if (symbolSize > EXPANDED_SIZE_CAP_LINES) return undefined;
		if (symbolSize <= requestedLimit) return undefined;

		return {
			newOffset: symbolStart,
			newLimit: symbolSize,
			enclosingSymbol: {
				name: getSymbolName(enclosing),
				kind: enclosing.type as string,
				startLine: symbolStart,
				endLine: symbolEnd,
			},
			durationMs: Date.now() - startedAt,
		};
	} catch {
		return undefined;
	}
}
