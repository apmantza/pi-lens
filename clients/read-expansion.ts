/**
 * Tree-sitter–based read expansion for the read-before-edit guard.
 *
 * When an agent reads a small slice of a file, this module uses the tree-sitter
 * AST to expand the read to cover the entire enclosing symbol (function, method,
 * class). This gives the read guard accurate symbol-level coverage so edits
 * within the symbol pass without requiring the agent to have read every line.
 */

import * as fs from "node:fs";
import { withBudget } from "./deadline-utils.js";
import type { TreeSitterClient } from "./tree-sitter-client.js";

/** Only expand reads smaller than this (lines). Larger reads don't benefit. */
export const EXPANSION_LIMIT_LINES = 100;

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
	".java": "java",
	".kt": "kotlin",
	".kts": "kotlin",
	".dart": "dart",
	".ex": "elixir",
	".exs": "elixir",
	".c": "c",
	".h": "c",
	".cc": "cpp",
	".cpp": "cpp",
	".cxx": "cpp",
	".c++": "cpp",
	".hh": "cpp",
	".hpp": "cpp",
	".hxx": "cpp",
	".cs": "csharp",
	".php": "php",
	".phtml": "php",
	".swift": "swift",
	".lua": "lua",
	".ml": "ocaml",
	".mli": "ocaml",
	".zig": "zig",
	".sh": "bash",
	".bash": "bash",
};

/**
 * Canonical set of source-code file extensions pi-lens understands, derived
 * from the same {@link EXT_TO_LANG} map the read-coverage path uses. Exported as
 * the single source of truth so language-spanning scanners (e.g.
 * production-readiness) cover every supported language instead of a hardcoded
 * subset (#262).
 */
export const CODE_FILE_EXTENSIONS: readonly string[] = Object.keys(EXT_TO_LANG);

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
	java: [
		"method_declaration",
		"constructor_declaration",
		"class_declaration",
		"interface_declaration",
		"enum_declaration",
	],
	kotlin: ["function_declaration", "class_declaration", "object_declaration"],
	dart: ["function_declaration", "method_declaration", "class_definition", "mixin_declaration"],
	elixir: ["call"],
	c: ["function_definition"],
	cpp: ["function_definition", "class_specifier", "struct_specifier"],
	csharp: [
		"method_declaration",
		"constructor_declaration",
		"class_declaration",
		"interface_declaration",
		"struct_declaration",
	],
	php: ["function_definition", "method_declaration", "class_declaration"],
	swift: ["function_declaration", "class_declaration", "protocol_declaration", "init_declaration"],
	lua: ["function_declaration", "function_definition"],
	ocaml: ["value_definition", "module_definition"],
	zig: ["function_declaration"],
	bash: ["function_definition"],
};

export interface AncestorSymbol {
	name: string;
	kind: string;
	startLine: number;
}

export interface ExpandedRead {
	newOffset: number;
	newLimit: number;
	enclosingSymbol: {
		name: string;
		kind: string;
		startLine: number;
		endLine: number;
	};
	/**
	 * Ancestor symbols from outermost to innermost, not including
	 * enclosingSymbol itself. Example: [ClassDecl, MethodDecl] when
	 * the immediate enclosing symbol is an arrow function inside a method.
	 */
	ancestry?: AncestorSymbol[];
	durationMs: number;
}

// biome-ignore lint/suspicious/noExplicitAny: tree-sitter AST node
function findEnclosingNodeForRange(
	node: any,
	startRow: number,
	endRow: number,
	types: string[],
): any {
	const nodeStartRow: number = node.startPosition?.row ?? 0;
	// biome-ignore lint/suspicious/noExplicitAny: endPosition not declared in local interface
	const nodeEndRow: number = (node as any).endPosition?.row ?? nodeStartRow;

	if (endRow < nodeStartRow || startRow > nodeEndRow) return undefined;

	// Prefer deepest overlapping match — check children first.
	for (const child of node.children ?? []) {
		const match = findEnclosingNodeForRange(child, startRow, endRow, types);
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

/**
 * Walk parent nodes from `node` upward, collecting every ancestor that is
 * one of the enclosing symbol types. Returns them outermost-first.
 */
// biome-ignore lint/suspicious/noExplicitAny: tree-sitter AST node
function buildAncestryChain(node: any, types: string[]): AncestorSymbol[] {
	const chain: AncestorSymbol[] = [];
	// biome-ignore lint/suspicious/noExplicitAny: tree-sitter parent node
	let current: any = node.parent;
	while (current) {
		if (types.includes(current.type as string)) {
			chain.push({
				name: getSymbolName(current),
				kind: current.type as string,
				startLine: (current.startPosition?.row ?? 0) + 1,
			});
		}
		current = current.parent;
	}
	return chain.reverse(); // outermost first
}


function tryExpandMarkdownSection(
	content: string,
	requestedStartRow: number,
	requestedLimit: number,
	totalLines: number,
): Omit<ExpandedRead, "durationMs"> | undefined {
	const lines = content.split(/\r?\n/);
	const lastRow = totalLines - 1;

	// Find heading at or before the requested start row
	let headingLevel = 7;
	let sectionStartRow = 0;
	let headingText = "";

	for (let i = requestedStartRow; i >= 0; i--) {
		const match = lines[i]?.match(/^(#{1,6})\s+(.*)/);
		if (match) {
			headingLevel = match[1].length;
			sectionStartRow = i;
			headingText = match[2].trim();
			break;
		}
	}

	// Find end: next heading of same or higher level (smaller or equal number)
	let sectionEndRow = lastRow;
	for (let i = sectionStartRow + 1; i <= lastRow; i++) {
		const match = lines[i]?.match(/^(#{1,6})\s+/);
		if (match && match[1].length <= headingLevel) {
			sectionEndRow = i - 1;
			break;
		}
	}

	const expandedStart = sectionStartRow + 1;
	const expandedEnd = sectionEndRow + 1;
	const expandedSize = expandedEnd - expandedStart + 1;

	if (expandedSize > EXPANDED_SIZE_CAP_LINES) return undefined;
	if (expandedSize <= requestedLimit) return undefined;

	return {
		newOffset: expandedStart,
		newLimit: expandedSize,
		enclosingSymbol: {
			name: headingText || "(untitled section)",
			kind: "markdown_section",
			startLine: expandedStart,
			endLine: expandedEnd,
		},
	};
}

/**
 * Attempt to expand a partial read to its enclosing symbol using tree-sitter.
 *
 * Returns undefined when:
 * - The file extension has no grammar
 * - The read is large (> EXPANSION_LIMIT_LINES) — already covers enough
 * - No enclosing symbol overlaps the requested read span
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
	const startedAt = Date.now();

	try {
		const content = fs.readFileSync(filePath, "utf8");

		// Fast path: Markdown section expansion (no tree-sitter needed)
		if (ext === ".md" || ext === ".mdx") {
			const requestedStartRow = requestedOffset - 1;
			const result = tryExpandMarkdownSection(
				content,
				requestedStartRow,
				requestedLimit,
				totalLines,
			);
			if (!result) return undefined;
			return { ...result, durationMs: Date.now() - startedAt };
		}

		const languageId = EXT_TO_LANG[ext];
		if (!languageId) return undefined;

		const enclosingTypes = ENCLOSING_TYPES[languageId];
		if (!enclosingTypes) return undefined;
		const initOk = await withBudget(tsClient.init(), EXPANSION_BUDGET_MS);
		if (!initOk) return undefined;

		const remaining = Math.max(
			0,
			EXPANSION_BUDGET_MS - (Date.now() - startedAt),
		);
		const tree = await withBudget(
			tsClient.parseFile(filePath, languageId, content),
			remaining,
		);
		if (!tree) return undefined;

		// tree-sitter rows are 0-indexed; offsets are 1-indexed
		const requestedStartRow = requestedOffset - 1;
		const requestedEndRow = Math.min(
			totalLines - 1,
			requestedOffset + requestedLimit - 2,
		);
		// biome-ignore lint/suspicious/noExplicitAny: tree-sitter root node
		const enclosing = findEnclosingNodeForRange(
			tree.rootNode as any,
			requestedStartRow,
			requestedEndRow,
			enclosingTypes,
		);
		if (!enclosing) return undefined;

		const symbolStart: number = enclosing.startPosition.row + 1;
		// biome-ignore lint/suspicious/noExplicitAny: endPosition not in local interface
		const symbolEnd: number =
			((enclosing as any).endPosition?.row ?? enclosing.startPosition.row) + 1;
		const requestedStartLine = requestedOffset;
		const requestedEndLine = requestedEndRow + 1;
		const expandedStart = Math.min(requestedStartLine, symbolStart);
		const expandedEnd = Math.max(requestedEndLine, symbolEnd);
		const expandedSize = expandedEnd - expandedStart + 1;

		if (expandedSize > EXPANDED_SIZE_CAP_LINES) return undefined;
		if (expandedSize <= requestedLimit) return undefined;

		const ancestry = buildAncestryChain(enclosing, enclosingTypes);
		return {
			newOffset: expandedStart,
			newLimit: expandedSize,
			enclosingSymbol: {
				name: getSymbolName(enclosing),
				kind: enclosing.type as string,
				startLine: symbolStart,
				endLine: symbolEnd,
			},
			ancestry: ancestry.length > 0 ? ancestry : undefined,
			durationMs: Date.now() - startedAt,
		};
	} catch {
		return undefined;
	}
}
