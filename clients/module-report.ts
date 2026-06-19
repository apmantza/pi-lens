/**
 * Module Report (#245) — a structured, navigable substitute for raw full-file
 * reads. An agent calls this to understand a module's shape (outline, signatures,
 * who-uses-this) before requesting exact source, so `read` becomes the fallback
 * rather than the default.
 *
 * Language-uniform by construction: the outline is extracted for EVERY supported
 * language through the one tree-sitter symbol extractor (jsts uses the
 * `typescript` query), giving the same fields — name/kind/startLine/endLine/
 * signature/exported — across all 18 SYMBOL_QUERIES languages plus jsts. The
 * review graph supplies cross-file enrichment (who-uses-this, complexity, fanout)
 * merged onto entries by symbol name; that enrichment is additive and varies by
 * language (e.g. complexity exists for jsts), which is honest rather than faked.
 *
 * Depth ladder is the latency contract:
 *   - "outline":  single-file tree-sitter extract only. No graph, cold-safe.
 *   - "standard": + review graph (who-uses, flags, imports). No live LSP. (default)
 *   - "deep":     reserved for bounded live-LSP / #236 graph-LSP enrichment.
 *
 * Guard integrity: moduleReport injects NO read records — an outline is not
 * "having seen the body". readSymbol returns the actual body lines so the host
 * can record a read that legitimately satisfies the read-guard for that symbol.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { detectFileKind } from "./file-kinds.js";
import { normalizeMapKey } from "./path-utils.js";
import type { Symbol as ExtractedSymbol } from "./symbol-types.js";
import { TreeSitterClient } from "./tree-sitter-client.js";
import { TreeSitterSymbolExtractor } from "./tree-sitter-symbol-extractor.js";
import type { ReviewGraph, ReviewGraphEdgeKind } from "./review-graph/types.js";

export type ModuleReportDepth = "outline" | "standard" | "deep";

export interface ModuleReportOptions {
	depth?: ModuleReportDepth;
	/** Cap on who-uses-this entries per symbol. */
	maxRefsPerSymbol?: number;
}

export interface ModuleSymbolUsedBy {
	file: string;
	symbol: string;
	line: number;
	relation: ReviewGraphEdgeKind;
}

export interface ModuleSymbolEntry {
	name: string;
	kind: string;
	startLine: number;
	endLine: number;
	exported: boolean;
	signature?: string;
	doc?: string;
	/** Outgoing call count (jsts graph path only). */
	fanout?: number;
	/** McCabe complexity (jsts graph path only). */
	complexity?: number;
	flags: string[];
	usedBy?: ModuleSymbolUsedBy[];
	/** Pre-computed read arguments — the agent's next call sits right here. */
	read: { path: string; offset: number; limit: number };
}

export interface RecommendedRead {
	reason: string;
	symbol?: string;
	path: string;
	offset: number;
	limit: number;
}

export interface ModuleReport {
	/** False when the file is unreadable or has no symbols and no graph node. */
	available: boolean;
	staleness: "fresh" | "snapshot-only" | "unavailable";
	path: string;
	language?: string;
	lineCount?: number;
	summary: { imports: number; exports: number; symbols: number };
	imports: { external: string[]; internal: string[] };
	api: ModuleSymbolEntry[];
	internal: ModuleSymbolEntry[];
	recommendedReads: RecommendedRead[];
	semantic: {
		source: "graph-lsp" | "live-lsp" | "none";
		references: boolean;
		implementations: boolean;
	};
}

export interface ReadSymbolResult {
	found: boolean;
	path: string;
	name: string;
	kind?: string;
	startLine?: number;
	endLine?: number;
	signature?: string;
	/** The verbatim body lines — recording this read satisfies the read-guard. */
	source?: string;
}

// kind -> tree-sitter languageId. The languageId keys BOTH the grammar map
// (tree-sitter-client) and SYMBOL_QUERIES (tree-sitter-symbol-extractor), so it
// must match a key present in both. jsts/cxx are resolved by extension below so
// the JSX-aware tsx grammar and the c-vs-cpp split are honoured. Using these
// gives the primary languages the same rich outline (classes/interfaces/types/
// signatures) as every other language, not the functions-only FunctionSummary.
const KIND_TO_TS_LANG: Record<string, string> = {
	python: "python",
	go: "go",
	rust: "rust",
	ruby: "ruby",
	java: "java",
	kotlin: "kotlin",
	dart: "dart",
	elixir: "elixir",
	csharp: "csharp",
	php: "php",
	swift: "swift",
	lua: "lua",
	ocaml: "ocaml",
	zig: "zig",
	shell: "bash",
	// cxx resolved by extension below (c vs cpp)
};

function tsLangForFile(
	filePath: string,
	kind: string | undefined,
): string | undefined {
	const ext = path.extname(filePath).toLowerCase();
	if (kind === "cxx") {
		return ext === ".c" || ext === ".h" ? "c" : "cpp";
	}
	if (kind === "jsts") {
		// Route JSX-bearing files to the tsx grammar (downloaded), plain TS/JS to
		// the typescript grammar; both share the same SYMBOL_QUERIES.
		return ext === ".tsx" || ext === ".jsx" ? "tsx" : "typescript";
	}
	return kind ? KIND_TO_TS_LANG[kind] : undefined;
}

// Shared parser + per-language extractor cache. The TreeSitterClient memoizes
// its own grammar init; extractors are cheap once their queries are compiled.
const tsClient = new TreeSitterClient();
const extractorCache = new Map<string, TreeSitterSymbolExtractor | null>();

async function getExtractor(
	languageId: string,
): Promise<TreeSitterSymbolExtractor | null> {
	const cached = extractorCache.get(languageId);
	if (cached !== undefined) return cached;
	const extractor = new TreeSitterSymbolExtractor(languageId, tsClient);
	const ok = await extractor.init();
	const result = ok ? extractor : null;
	extractorCache.set(languageId, result);
	return result;
}

async function extractFileSymbols(
	absPath: string,
	languageId: string,
	content: string,
): Promise<ExtractedSymbol[]> {
	try {
		const initialized = await tsClient.init();
		if (!initialized) return [];
		const tree = await tsClient.parseFile(absPath, languageId);
		if (!tree) return [];
		const extractor = await getExtractor(languageId);
		if (!extractor) return [];
		return extractor.extract(tree, absPath, content).symbols;
	} catch {
		return [];
	}
}

function readArgsFor(
	filePath: string,
	startLine: number,
	endLine: number,
): { path: string; offset: number; limit: number } {
	const offset = Math.max(1, startLine);
	const limit = Math.max(1, endLine - startLine + 1);
	return { path: filePath, offset, limit };
}

function resolveUsedBy(
	graph: ReviewGraph,
	symbolNodeId: string,
	cap: number,
): ModuleSymbolUsedBy[] {
	const out: ModuleSymbolUsedBy[] = [];
	const seen = new Set<string>();
	for (const edge of graph.edgesByTo.get(symbolNodeId) ?? []) {
		if (edge.kind !== "calls" && edge.kind !== "references") continue;
		const from = graph.nodes.get(edge.from);
		const file =
			from?.filePath ??
			(edge.from.startsWith("file:") ? edge.from.slice("file:".length) : "");
		if (!file) continue;
		const symbol = from?.symbolName ?? "";
		// Caller line: a symbol caller node carries metadata.line; a file-level
		// `references` edge carries the line on the edge metadata.
		const line =
			(typeof from?.metadata?.line === "number"
				? (from.metadata.line as number)
				: undefined) ??
			(typeof edge.metadata?.line === "number"
				? (edge.metadata.line as number)
				: 0);
		const key = `${file} ${symbol} ${edge.kind}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ file, symbol, line, relation: edge.kind });
		if (out.length >= cap) break;
	}
	return out;
}

function collectImports(
	graph: ReviewGraph,
	normalizedPath: string,
): { external: string[]; internal: string[] } {
	const fileNodeId = graph.fileNodes.get(normalizedPath);
	const external = new Set<string>();
	const internal = new Set<string>();
	if (fileNodeId) {
		for (const edge of graph.edgesByFrom.get(fileNodeId) ?? []) {
			if (edge.kind !== "imports") continue;
			const target = graph.nodes.get(edge.to);
			if (!target) continue;
			if (target.kind === "external") {
				external.add(String(target.metadata?.source ?? edge.to));
			} else if (target.filePath) {
				internal.add(target.filePath);
			} else {
				internal.add(String(target.metadata?.source ?? edge.to));
			}
		}
	}
	return {
		external: [...external].sort((a, b) => a.localeCompare(b)),
		internal: [...internal].sort((a, b) => a.localeCompare(b)),
	};
}

function toEntry(
	sym: ExtractedSymbol,
	displayPath: string,
	normalizedPath: string,
	graph: ReviewGraph | undefined,
	maxRefs: number,
): ModuleSymbolEntry {
	const startLine = sym.line;
	const endLine = sym.endLine ?? sym.line;
	const symbolNodeId = `${normalizedPath}:${sym.name}`;
	const node = graph?.nodes.get(symbolNodeId);
	const metadata = node?.metadata ?? {};

	const complexity =
		typeof metadata.cyclomaticComplexity === "number"
			? (metadata.cyclomaticComplexity as number)
			: undefined;
	const fanout = graph
		? (graph.edgesByFrom.get(symbolNodeId) ?? []).filter(
				(edge) => edge.kind === "calls",
			).length
		: undefined;

	const exported = sym.isExported || !!node?.exported;
	const flags: string[] = [];
	if (exported) flags.push("exported");
	if (fanout !== undefined && fanout >= 4) flags.push("high fanout");
	if (complexity !== undefined && complexity >= 8) flags.push("high complexity");
	if (metadata.isBoundaryWrapper) flags.push("boundary wrapper");

	const usedBy = graph
		? resolveUsedBy(graph, symbolNodeId, maxRefs)
		: undefined;

	return {
		name: sym.name,
		kind: sym.kind,
		startLine,
		endLine,
		exported,
		signature: sym.signature,
		doc: sym.doc,
		fanout: fanout && fanout > 0 ? fanout : undefined,
		complexity,
		flags,
		usedBy: usedBy && usedBy.length > 0 ? usedBy : undefined,
		read: readArgsFor(displayPath, startLine, endLine),
	};
}

function rankRecommendedReads(
	entries: ModuleSymbolEntry[],
	limit = 3,
): RecommendedRead[] {
	const scored = entries.map((entry) => {
		const refs = entry.usedBy?.length ?? 0;
		const score =
			refs * 2 +
			(entry.complexity ?? 0) +
			(entry.exported ? 2 : 0) +
			(entry.flags.includes("high complexity") ? 3 : 0);
		return { entry, score, refs };
	});
	scored.sort((a, b) => b.score - a.score);
	return scored
		.filter(({ score }) => score > 0)
		.slice(0, limit)
		.map(({ entry, refs }) => {
			const reasons: string[] = [];
			if (entry.exported) reasons.push("exported");
			if (refs > 0) reasons.push(`used by ${refs}`);
			if (entry.complexity !== undefined && entry.complexity >= 8) {
				reasons.push(`complexity ${entry.complexity}`);
			}
			return {
				reason: reasons.join(", ") || "public surface",
				symbol: entry.name,
				...entry.read,
			};
		});
}

function unavailableReport(displayPath: string): ModuleReport {
	return {
		available: false,
		staleness: "unavailable",
		path: displayPath,
		summary: { imports: 0, exports: 0, symbols: 0 },
		imports: { external: [], internal: [] },
		api: [],
		internal: [],
		recommendedReads: [],
		semantic: { source: "none", references: false, implementations: false },
	};
}

/**
 * Build a structured report for a single module. Read-only. At "outline" depth
 * this is a single tree-sitter parse (no graph, cold-safe); at "standard" it
 * additionally loads the 3-tier-cached review graph for who-uses-this, import,
 * and complexity/fanout enrichment. No live LSP at any depth yet (deep is
 * reserved for #236 graph-LSP / bounded live-LSP).
 */
export async function moduleReport(
	file: string,
	cwd: string,
	options?: ModuleReportOptions,
): Promise<ModuleReport> {
	const depth = options?.depth ?? "standard";
	const maxRefs = Math.max(1, options?.maxRefsPerSymbol ?? 10);
	const absPath = path.resolve(cwd, file);
	const normalizedPath = normalizeMapKey(absPath);

	let content: string;
	try {
		content = fs.readFileSync(absPath, "utf-8");
	} catch {
		return unavailableReport(absPath);
	}

	const kind = detectFileKind(absPath);
	const languageId = tsLangForFile(absPath, kind);
	const lineCount = content.split(/\r?\n/).length;

	const extracted = languageId
		? await extractFileSymbols(absPath, languageId, content)
		: [];

	let graph: ReviewGraph | undefined;
	if (depth !== "outline") {
		const { buildOrUpdateGraph } = await import("./review-graph/builder.js");
		const { FactStore } = await import("./dispatch/fact-store.js");
		graph = await buildOrUpdateGraph(cwd, [], new FactStore());
	}

	const entries = extracted.map((sym) =>
		toEntry(sym, absPath, normalizedPath, graph, maxRefs),
	);
	const api = entries.filter((entry) => entry.exported);
	const internal = entries.filter((entry) => !entry.exported);
	const imports = graph
		? collectImports(graph, normalizedPath)
		: { external: [], internal: [] };

	const hasGraphNode = graph?.fileNodes.has(normalizedPath) ?? false;

	return {
		available: entries.length > 0 || hasGraphNode,
		staleness:
			entries.length === 0 && !hasGraphNode
				? "unavailable"
				: depth === "outline"
					? "snapshot-only"
					: "fresh",
		path: absPath,
		language: kind ?? undefined,
		lineCount,
		summary: {
			imports: imports.external.length + imports.internal.length,
			exports: api.length,
			symbols: entries.length,
		},
		imports,
		api,
		internal,
		recommendedReads: rankRecommendedReads(entries),
		semantic: {
			source: "none",
			references: depth !== "outline",
			implementations: false,
		},
	};
}

/**
 * Return the verbatim body of a single symbol. Unlike moduleReport (which shows
 * shape, not content), this delivers the actual source lines — so the host can
 * record it as a read that legitimately satisfies the read-guard's coverage for
 * that symbol's range.
 */
export async function readSymbol(
	file: string,
	symbolName: string,
	cwd: string,
): Promise<ReadSymbolResult> {
	const absPath = path.resolve(cwd, file);
	let content: string;
	try {
		content = fs.readFileSync(absPath, "utf-8");
	} catch {
		return { found: false, path: absPath, name: symbolName };
	}

	const kind = detectFileKind(absPath);
	const languageId = tsLangForFile(absPath, kind);
	if (!languageId) return { found: false, path: absPath, name: symbolName };

	const symbols = await extractFileSymbols(absPath, languageId, content);
	const sym = symbols.find((candidate) => candidate.name === symbolName);
	if (!sym) return { found: false, path: absPath, name: symbolName };

	const startLine = sym.line;
	const endLine = sym.endLine ?? sym.line;
	const lines = content.split(/\r?\n/);
	const source = lines.slice(startLine - 1, endLine).join("\n");

	return {
		found: true,
		path: absPath,
		name: sym.name,
		kind: sym.kind,
		startLine,
		endLine,
		signature: sym.signature,
		source,
	};
}
