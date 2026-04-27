import * as fs from "node:fs";
import * as path from "node:path";
import type { FactStore } from "../dispatch/fact-store.js";
import { fileContentProvider } from "../dispatch/facts/file-content.js";
import {
	type FunctionSummary,
	functionFactProvider,
} from "../dispatch/facts/function-facts.js";
import {
	type ImportEntry,
	importFactProvider,
} from "../dispatch/facts/import-facts.js";
import type { DispatchContext } from "../dispatch/types.js";
import { detectFileKind } from "../file-kinds.js";
import { normalizeMapKey } from "../path-utils.js";
import { getSourceFiles } from "../scan-utils.js";
import { TreeSitterClient } from "../tree-sitter-client.js";
import {
	type ExtractedSymbols,
	TreeSitterSymbolExtractor,
} from "../tree-sitter-symbol-extractor.js";
import type { ReviewGraph, ReviewGraphEdge, ReviewGraphNode } from "./types.js";

const REVIEW_GRAPH_VERSION = "v1";
const MAIN_KINDS = new Set(["jsts", "python", "go", "rust", "ruby"]);
const CHANGED_SYMBOLS_PREFIX = "session.reviewGraph.changedSymbols:";
const treeSitterClient = new TreeSitterClient();
const extractorCache = new Map<string, TreeSitterSymbolExtractor>();

// Per-invocation Promise cache: deduplicates concurrent buildOrUpdateGraph calls
// for the same (cwd, changedFiles). Cleared at the start of each pipeline
// invocation via clearGraphCache() so each edit gets a fresh build.
const _buildCache = new Map<string, Promise<ReviewGraph>>();

export function clearGraphCache(): void {
	_buildCache.clear();
}

function makeCtx(
	filePath: string,
	cwd: string,
	facts: FactStore,
): DispatchContext {
	return {
		filePath,
		cwd,
		kind: detectFileKind(filePath),
		pi: { getFlag: () => undefined },
		autofix: false,
		deltaMode: false,
		facts,
		blockingOnly: false,
		modifiedRanges: undefined,
		hasTool: async () => false,
		log: () => {},
	};
}

function escapeRegExp(string: string): string {
	return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createEmptyGraph(): ReviewGraph {
	return {
		version: REVIEW_GRAPH_VERSION,
		builtAt: new Date().toISOString(),
		nodes: new Map(),
		edges: [],
		edgesByFrom: new Map(),
		edgesByTo: new Map(),
		fileNodes: new Map(),
		symbolNodesByFile: new Map(),
		changedSymbolsByFile: new Map(),
	};
}

function addNode(graph: ReviewGraph, node: ReviewGraphNode): void {
	graph.nodes.set(node.id, node);
	if (node.kind === "file" && node.filePath) {
		graph.fileNodes.set(node.filePath, node.id);
	}
}

function addEdge(graph: ReviewGraph, edge: ReviewGraphEdge): void {
	graph.edges.push(edge);
	const from = graph.edgesByFrom.get(edge.from) ?? [];
	from.push(edge);
	graph.edgesByFrom.set(edge.from, from);
	const to = graph.edgesByTo.get(edge.to) ?? [];
	to.push(edge);
	graph.edgesByTo.set(edge.to, to);
}

function rebuildIndexes(graph: ReviewGraph): void {
	graph.edgesByFrom = new Map();
	graph.edgesByTo = new Map();
	graph.fileNodes = new Map();
	graph.symbolNodesByFile = new Map();
	for (const node of graph.nodes.values()) {
		if (node.kind === "file" && node.filePath) {
			graph.fileNodes.set(node.filePath, node.id);
		}
		if (node.kind === "symbol" && node.filePath) {
			const ids = graph.symbolNodesByFile.get(node.filePath) ?? [];
			ids.push(node.id);
			graph.symbolNodesByFile.set(node.filePath, ids);
		}
	}
	for (const edge of graph.edges) {
		const from = graph.edgesByFrom.get(edge.from) ?? [];
		from.push(edge);
		graph.edgesByFrom.set(edge.from, from);
		const to = graph.edgesByTo.get(edge.to) ?? [];
		to.push(edge);
		graph.edgesByTo.set(edge.to, to);
	}
}

function localImportToFile(
	cwd: string,
	filePath: string,
	source: string,
): string | undefined {
	if (!source.startsWith(".")) return undefined;
	const base = path.resolve(path.dirname(filePath), source);
	const candidates = [
		base,
		`${base}.ts`,
		`${base}.tsx`,
		`${base}.js`,
		`${base}.jsx`,
		path.join(base, "index.ts"),
		path.join(base, "index.tsx"),
		path.join(base, "index.js"),
		path.join(base, "index.jsx"),
	];
	for (const candidate of candidates) {
		if (candidate.startsWith(path.resolve(cwd)) && fs.existsSync(candidate)) {
			return normalizeMapKey(candidate);
		}
	}
	return undefined;
}

function upsertChangedSymbols(
	graph: ReviewGraph,
	facts: FactStore,
	filePath: string,
): void {
	const normalized = normalizeMapKey(filePath);
	const changed = facts.getSessionFact<string[]>(
		`${CHANGED_SYMBOLS_PREFIX}${normalized}`,
	);
	if (changed && changed.length > 0) {
		graph.changedSymbolsByFile.set(normalized, [...changed]);
	} else {
		graph.changedSymbolsByFile.delete(normalized);
	}
}

async function ensureTsFacts(
	filePath: string,
	cwd: string,
	facts: FactStore,
): Promise<void> {
	const ctx = makeCtx(filePath, cwd, facts);
	await fileContentProvider.run(ctx, facts);
	importFactProvider.run(ctx, facts);
	functionFactProvider.run(ctx, facts);
}

function addJsTsFile(
	graph: ReviewGraph,
	cwd: string,
	filePath: string,
	facts: FactStore,
): void {
	const normalized = normalizeMapKey(filePath);
	const content = facts.getFileFact<string>(normalized, "file.content") ?? "";
	const fileNodeId = `file:${normalized}`;
	addNode(graph, {
		id: fileNodeId,
		kind: "file",
		language: "jsts",
		filePath: normalized,
		metadata: {
			lineCount: content.split("\n").length,
		},
	});

	const imports =
		facts.getFileFact<ImportEntry[]>(normalized, "file.imports") ?? [];
	const functions =
		facts.getFileFact<FunctionSummary[]>(
			normalized,
			"file.functionSummaries",
		) ?? [];

	for (const entry of imports) {
		const localFile = localImportToFile(cwd, normalized, entry.source);
		if (localFile) {
			const targetId = `file:${localFile}`;
			if (!graph.nodes.has(targetId)) {
				addNode(graph, {
					id: targetId,
					kind: "file",
					language: detectFileKind(localFile) ?? "jsts",
					filePath: localFile,
				});
			}
			addEdge(graph, { from: fileNodeId, to: targetId, kind: "imports" });
		} else {
			const targetId = `${entry.source.startsWith(".") ? "module" : "external"}:${entry.source}`;
			if (!graph.nodes.has(targetId)) {
				addNode(graph, {
					id: targetId,
					kind: entry.source.startsWith(".") ? "module" : "external",
					language: "jsts",
					metadata: { source: entry.source },
				});
			}
			addEdge(graph, { from: fileNodeId, to: targetId, kind: "imports" });
		}
	}

	for (const fn of functions) {
		const symbolId = `${normalized}:${fn.name}`;
		addNode(graph, {
			id: symbolId,
			kind: "symbol",
			language: "jsts",
			filePath: normalized,
			symbolName: fn.name,
			symbolKind: "function",
			exported: new RegExp(
				String.raw`export\s+(?:async\s+)?(?:function|const|let|var)\s+${escapeRegExp(fn.name)}\b`,
			).test(content),
			metadata: {
				line: fn.line,
				column: fn.column,
				cyclomaticComplexity: fn.cyclomaticComplexity,
				maxNestingDepth: fn.maxNestingDepth,
				isBoundaryWrapper: fn.isBoundaryWrapper,
				isPassThroughWrapper: fn.isPassThroughWrapper,
			},
		});
		addEdge(graph, { from: fileNodeId, to: symbolId, kind: "contains" });
		addEdge(graph, { from: fileNodeId, to: symbolId, kind: "defines" });
		for (const callee of fn.outgoingCalls) {
			const targetId = callee.includes(".")
				? `external:${callee}`
				: `symbol-name:${callee}`;
			if (!graph.nodes.has(targetId)) {
				addNode(graph, {
					id: targetId,
					kind: callee.includes(".") ? "external" : "symbol",
					language: "jsts",
					symbolName: callee.includes(".") ? undefined : callee,
					metadata: { unresolvedName: callee },
				});
			}
			addEdge(graph, {
				from: symbolId,
				to: targetId,
				kind: "calls",
				metadata: { unresolvedName: callee },
			});
		}
	}
}

function mapKindToTreeSitterLanguage(
	kind: string | undefined,
): string | undefined {
	switch (kind) {
		case "python":
			return "python";
		case "go":
			return "go";
		case "rust":
			return "rust";
		case "ruby":
			return "ruby";
		default:
			return undefined;
	}
}

async function getExtractor(
	languageId: string,
): Promise<TreeSitterSymbolExtractor | null> {
	if (extractorCache.has(languageId)) return extractorCache.get(languageId)!;
	const extractor = new TreeSitterSymbolExtractor(languageId, treeSitterClient);
	const ok = await extractor.init();
	if (!ok) return null;
	extractorCache.set(languageId, extractor);
	return extractor;
}

async function extractTreeSitterSymbols(
	filePath: string,
	languageId: string,
): Promise<ExtractedSymbols> {
	const empty: ExtractedSymbols = { symbols: [], refs: [] };
	const initialized = await treeSitterClient.init();
	if (!initialized) return empty;
	const tree = await treeSitterClient.parseFile(filePath, languageId);
	if (!tree) return empty;
	const extractor = await getExtractor(languageId);
	if (!extractor) return empty;
	const content = fs.readFileSync(filePath, "utf-8");
	return extractor.extract(tree, filePath, content);
}

function addTreeSitterFile(
	graph: ReviewGraph,
	filePath: string,
	languageId: string,
	extracted: ExtractedSymbols,
): void {
	const normalized = normalizeMapKey(filePath);
	const fileNodeId = `file:${normalized}`;
	addNode(graph, {
		id: fileNodeId,
		kind: "file",
		language: languageId,
		filePath: normalized,
	});

	for (const symbol of extracted.symbols) {
		const symbolId = `${normalized}:${symbol.name}`;
		addNode(graph, {
			id: symbolId,
			kind: "symbol",
			language: languageId,
			filePath: normalized,
			symbolName: symbol.name,
			symbolKind: symbol.kind,
			exported: symbol.isExported,
			metadata: {
				line: symbol.line,
				column: symbol.column,
				signature: symbol.signature,
			},
		});
		addEdge(graph, { from: fileNodeId, to: symbolId, kind: "contains" });
		addEdge(graph, { from: fileNodeId, to: symbolId, kind: "defines" });
	}

	for (const ref of extracted.refs) {
		const targetId = `symbol-name:${ref.symbolId.split(":").pop() ?? ref.symbolId}`;
		if (!graph.nodes.has(targetId)) {
			addNode(graph, {
				id: targetId,
				kind: "symbol",
				language: languageId,
				symbolName: ref.symbolId.split(":").pop() ?? ref.symbolId,
				metadata: { unresolvedName: ref.symbolId },
			});
		}
		addEdge(graph, {
			from: fileNodeId,
			to: targetId,
			kind: "references",
			metadata: { line: ref.line, column: ref.column },
		});
	}
}

function resolveDeferredSymbolEdges(graph: ReviewGraph): void {
	const symbolNameToIds = new Map<string, string[]>();
	for (const node of graph.nodes.values()) {
		if (node.kind !== "symbol" || !node.symbolName) continue;
		if (node.metadata?.unresolvedName) continue;
		const ids = symbolNameToIds.get(node.symbolName) ?? [];
		ids.push(node.id);
		symbolNameToIds.set(node.symbolName, ids);
	}

	graph.edges = graph.edges.map((edge) => {
		const unresolvedName = String(edge.metadata?.unresolvedName ?? "");
		if (
			!unresolvedName ||
			!graph.nodes.has(edge.to) ||
			!graph.nodes.get(edge.to)?.metadata?.unresolvedName
		) {
			return edge;
		}
		const candidates = symbolNameToIds.get(unresolvedName) ?? [];
		if (candidates.length === 1) {
			return { ...edge, to: candidates[0] };
		}
		return edge;
	});
	rebuildIndexes(graph);
}

async function _doBuildGraph(
	cwd: string,
	changedFiles: string[],
	facts: FactStore,
): Promise<ReviewGraph> {
	const graph = createEmptyGraph();
	const normalizedChanged = changedFiles.map((file) => normalizeMapKey(file));
	const filesToBuild = getSourceFiles(cwd)
		.map((file) => normalizeMapKey(file))
		.filter((file) => {
			const kind = detectFileKind(file);
			return !!kind && MAIN_KINDS.has(kind);
		});

	for (const file of filesToBuild) {
		const kind = detectFileKind(file);
		if (!kind || !MAIN_KINDS.has(kind)) continue;
		if (kind === "jsts") {
			await ensureTsFacts(file, cwd, facts);
			addJsTsFile(graph, cwd, file, facts);
		} else {
			const languageId = mapKindToTreeSitterLanguage(kind);
			if (!languageId) continue;
			const extracted = await extractTreeSitterSymbols(file, languageId);
			addTreeSitterFile(graph, file, languageId, extracted);
		}
		if (normalizedChanged.includes(file)) {
			upsertChangedSymbols(graph, facts, file);
		}
	}

	resolveDeferredSymbolEdges(graph);
	graph.version = REVIEW_GRAPH_VERSION;
	graph.builtAt = new Date().toISOString();
	facts.setSessionFact("session.reviewGraph", graph);
	return graph;
}

export function buildOrUpdateGraph(
	cwd: string,
	changedFiles: string[],
	facts: FactStore,
): Promise<ReviewGraph> {
	const cacheKey = `${cwd}|${[...changedFiles].sort().join(",")}`;
	const cached = _buildCache.get(cacheKey);
	if (cached) return cached;

	const promise = _doBuildGraph(cwd, changedFiles, facts).catch((err) => {
		_buildCache.delete(cacheKey);
		throw err as Error;
	});
	_buildCache.set(cacheKey, promise);
	return promise;
}
