import { createHash } from "node:crypto";
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
import { featureHintMetadata } from "../feature-hints.js";
import { detectFileKind } from "../file-kinds.js";
import { detectFileRole } from "../file-role.js";
import { getProjectDataDir } from "../file-utils.js";
import { normalizeMapKey } from "../path-utils.js";
import { collectProjectSourceFilesAsync } from "../project-scan-policy.js";
import { RUNTIME_CONFIG } from "../runtime-config.js";
import { TreeSitterClient } from "../tree-sitter-client.js";
import {
	type ExtractedSymbols,
	TreeSitterSymbolExtractor,
} from "../tree-sitter-symbol-extractor.js";
import type { ReviewGraph, ReviewGraphEdge, ReviewGraphNode } from "./types.js";

const REVIEW_GRAPH_VERSION = "v2";
const MAIN_KINDS = new Set([
	"jsts",
	"python",
	"go",
	"rust",
	"ruby",
	"cxx",
	// Languages added in #152: WASMs + symbol queries now available
	"java",
	"kotlin",
	"dart",
	"elixir",
	"csharp",
	"php",
	"swift",
	"lua",
	"ocaml",
	"zig",
	"shell",
]);
const CHANGED_SYMBOLS_PREFIX = "session.reviewGraph.changedSymbols:";
const treeSitterClient = new TreeSitterClient();
const extractorCache = new Map<string, TreeSitterSymbolExtractor>();

// Per-invocation Promise cache: deduplicates concurrent buildOrUpdateGraph calls
// for the same (cwd, changedFiles). Cleared at the start of each pipeline
// invocation. A separate workspace cache below preserves the expensive parsed
// graph across invocations when source file mtimes/sizes have not changed.
const _buildCache = new Map<string, Promise<ReviewGraph>>();
const _workspaceGraphCache = new Map<
	string,
	{
		signature: string;
		fileSignatures: Map<string, string>;
		fileHashes?: Map<string, string>;
		graph: ReviewGraph;
	}
>();
type GraphBuildInfo = {
	reused: boolean;
	mode: "full" | "cached" | "incremental" | "skipped";
	skipReason?: string;
	sourceFileCount?: number;
	maxFileCount?: number;
};

let _lastGraphBuildInfo: GraphBuildInfo = {
	reused: false,
	mode: "full",
};

export function clearGraphCache(): void {
	_buildCache.clear();
}

export function clearReviewGraphWorkspaceCache(): void {
	_buildCache.clear();
	_workspaceGraphCache.clear();
	_lastGraphBuildInfo = { reused: false, mode: "full" };
}

export function getLastGraphBuildInfo(): GraphBuildInfo {
	return _lastGraphBuildInfo;
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
		fileRole: detectFileRole(filePath),
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

function cloneGraph(graph: ReviewGraph): ReviewGraph {
	return {
		version: graph.version,
		builtAt: graph.builtAt,
		nodes: new Map(graph.nodes),
		edges: graph.edges.map((edge) => ({ ...edge })),
		edgesByFrom: new Map(),
		edgesByTo: new Map(),
		fileNodes: new Map(),
		symbolNodesByFile: new Map(),
		changedSymbolsByFile: new Map(graph.changedSymbolsByFile),
	};
}

function sourceSignatureEntry(file: string): string {
	try {
		const stat = fs.statSync(file);
		return `${stat.size}:${stat.mtimeMs}`;
	} catch {
		return "missing";
	}
}

// Chunked-yield budget for the per-edit signature/stat loops. 100 stat calls
// per chunk keeps each synchronous burst well under pi's typing window while
// adding negligible scheduling overhead. The work and its output are identical
// to a tight synchronous loop — only the loop yields the event loop between
// chunks so a large project's cascade graph rebuild can't freeze the TUI.
const STAT_YIELD_EVERY = 100;

const yieldToLoop = (): Promise<void> =>
	new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Async, chunked-yield twin of the per-file source-signature map. Produces the
 * exact same `file -> "size:mtimeMs"` map as a synchronous loop, but yields to
 * the event loop every {@link STAT_YIELD_EVERY} stats. Used on the per-edit
 * cascade path where statting every project file synchronously would otherwise
 * block the loop for hundreds of ms on a large repo.
 */
async function sourceSignatureMapAsync(
	files: string[],
): Promise<Map<string, string>> {
	const signatures = new Map<string, string>();
	let sinceYield = 0;
	for (const file of files) {
		signatures.set(file, sourceSignatureEntry(file));
		if (++sinceYield >= STAT_YIELD_EVERY) {
			sinceYield = 0;
			await yieldToLoop();
		}
	}
	return signatures;
}

function sourceSignatureFromMap(signatures: Map<string, string>): string {
	return [...signatures.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([file, signature]) => `${file}:${signature}`)
		.join("|");
}

function contentHashEntry(file: string): string {
	try {
		// sha256, not for security — a content fingerprint for change detection;
		// avoids SonarCloud's weak-hash (sha1/md5) flag.
		return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
	} catch {
		return "missing";
	}
}

/**
 * Async, chunked-yield content-hash map for a set of files. Used at full build
 * to record per-file content hashes so a later run can tell a *content* change
 * apart from pure mtime/size drift (formatter no-op, git checkout) — see
 * {@link confirmContentChanged}. Reads file bytes, so it runs only on the
 * (rare) full-build path, not the per-edit signature loop.
 */
async function sourceHashMapAsync(
	files: string[],
): Promise<Map<string, string>> {
	const hashes = new Map<string, string>();
	let sinceYield = 0;
	for (const file of files) {
		hashes.set(file, contentHashEntry(file));
		if (++sinceYield >= STAT_YIELD_EVERY) {
			sinceYield = 0;
			await yieldToLoop();
		}
	}
	return hashes;
}

/**
 * #202: confirm which mtime/size-changed candidates actually changed CONTENT. A
 * candidate whose content hash matches the prior hash is pure mtime drift —
 * reusing its already-parsed graph nodes is safe. Returns the truly
 * content-changed subset plus the merged hash map (prior hashes + freshly
 * computed candidate hashes) for persisting. When prior hashes are absent (a
 * pre-#202 cache), every candidate reports as changed, so behavior degrades
 * exactly to the old mtime-only logic — never a false reuse.
 */
async function confirmContentChanged(
	candidates: string[],
	previousHashes: Map<string, string> | undefined,
): Promise<{ trulyChanged: string[]; hashes: Map<string, string> }> {
	const prior = previousHashes ?? new Map<string, string>();
	const hashes = new Map(prior);
	const trulyChanged: string[] = [];
	let sinceYield = 0;
	for (const file of candidates) {
		const hash = contentHashEntry(file);
		hashes.set(file, hash);
		if (prior.get(file) !== hash) trulyChanged.push(file);
		if (++sinceYield >= STAT_YIELD_EVERY) {
			sinceYield = 0;
			await yieldToLoop();
		}
	}
	return { trulyChanged, hashes };
}

function changedSignatureFiles(
	previous: Map<string, string>,
	next: Map<string, string>,
): string[] | undefined {
	if (previous.size !== next.size) return undefined;
	const changed: string[] = [];
	for (const [file, signature] of next) {
		const oldSignature = previous.get(file);
		if (oldSignature === undefined) return undefined;
		if (oldSignature !== signature) changed.push(file);
	}
	return changed;
}

function getReviewGraphMaxFiles(): number {
	const override = Number.parseInt(
		process.env.PI_LENS_REVIEW_GRAPH_MAX_FILES ?? "",
		10,
	);
	return Number.isFinite(override) && override > 0
		? override
		: RUNTIME_CONFIG.reviewGraph.maxFiles;
}

function getReviewGraphMaxFileBytes(): number {
	const override = Number.parseInt(
		process.env.PI_LENS_REVIEW_GRAPH_MAX_FILE_BYTES ?? "",
		10,
	);
	return Number.isFinite(override) && override > 0
		? override
		: RUNTIME_CONFIG.reviewGraph.maxFileBytes;
}

function isWithinReviewGraphSizeLimit(file: string): boolean {
	try {
		return fs.statSync(file).size <= getReviewGraphMaxFileBytes();
	} catch {
		return false;
	}
}

async function getGraphSourceFiles(cwd: string): Promise<string[]> {
	// Async, chunked-yield walk (identical output to the sync collector) so the
	// per-edit cascade graph rebuild doesn't block the event loop on a large repo.
	const collected = await collectProjectSourceFilesAsync(cwd);
	const result: string[] = [];
	let sinceYield = 0;
	for (const raw of collected) {
		const file = normalizeMapKey(raw);
		const kind = detectFileKind(file);
		// isWithinReviewGraphSizeLimit does a statSync per file — yield periodically
		// so the size-limit filter (one stat each) can't hold the loop in one burst.
		if (!!kind && MAIN_KINDS.has(kind) && isWithinReviewGraphSizeLimit(file)) {
			result.push(file);
		}
		if (++sinceYield >= STAT_YIELD_EVERY) {
			sinceYield = 0;
			await yieldToLoop();
		}
	}
	return result;
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

const GRAPH_CACHE_FILENAME = "review-graph.json";

interface PersistedGraphData {
	version: string;
	builtAt: string;
	signature: string;
	fileSignatures?: Array<[string, string]>;
	fileHashes?: Array<[string, string]>;
	nodes: Array<[string, ReviewGraphNode]>;
	edges: ReviewGraphEdge[];
}

function loadPersistedGraph(cwd: string): {
	signature: string;
	fileSignatures: Map<string, string>;
	fileHashes: Map<string, string>;
	graph: ReviewGraph;
} | null {
	const cachePath = path.join(getProjectDataDir(cwd), "cache", GRAPH_CACHE_FILENAME);
	try {
		const raw = fs.readFileSync(cachePath, "utf-8");
		const data = JSON.parse(raw) as PersistedGraphData;
		if (data.version !== REVIEW_GRAPH_VERSION) return null;
		const graph: ReviewGraph = {
			version: data.version,
			builtAt: data.builtAt,
			nodes: new Map(data.nodes),
			edges: data.edges,
			edgesByFrom: new Map(),
			edgesByTo: new Map(),
			fileNodes: new Map(),
			symbolNodesByFile: new Map(),
			changedSymbolsByFile: new Map(),
		};
		rebuildIndexes(graph);
		return {
			signature: data.signature,
			fileSignatures: new Map(data.fileSignatures ?? []),
			fileHashes: new Map(data.fileHashes ?? []),
			graph,
		};
	} catch {
		return null;
	}
}

function persistGraph(
	cwd: string,
	signature: string,
	fileSignatures: Map<string, string>,
	fileHashes: Map<string, string> | undefined,
	graph: ReviewGraph,
): void {
	const cacheDir = path.join(getProjectDataDir(cwd), "cache");
	const cachePath = path.join(cacheDir, GRAPH_CACHE_FILENAME);
	const data: PersistedGraphData = {
		version: graph.version,
		builtAt: graph.builtAt,
		signature,
		fileSignatures: Array.from(fileSignatures.entries()),
		fileHashes: fileHashes ? Array.from(fileHashes.entries()) : undefined,
		nodes: Array.from(graph.nodes.entries()),
		edges: graph.edges,
	};
	const json = JSON.stringify(data);
	fs.mkdir(cacheDir, { recursive: true }, (mkdirErr) => {
		if (mkdirErr) {
			console.error(
				"[review-graph] cache dir creation failed:",
				mkdirErr.message,
			);
			return;
		}
		fs.writeFile(cachePath, json, "utf-8", (writeErr) => {
			if (writeErr) {
				console.error("[review-graph] cache write failed:", writeErr.message);
			}
		});
	});
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
			...featureHintMetadata(normalized),
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
				...featureHintMetadata(`${fn.name} ${normalized}`),
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
	filePath?: string,
): string | undefined {
	switch (kind) {
		case "python": return "python";
		case "go": return "go";
		case "rust": return "rust";
		case "ruby": return "ruby";
		case "cxx": {
			const ext = filePath ? path.extname(filePath).toLowerCase() : "";
			return ext === ".c" || ext === ".h" ? "c" : "cpp";
		}
		case "java": return "java";
		case "kotlin": return "kotlin";
		case "dart": return "dart";
		case "elixir": return "elixir";
		case "csharp": return "csharp";
		case "php": return "php";
		case "swift": return "swift";
		case "lua": return "lua";
		case "ocaml": return "ocaml";
		case "zig": return "zig";
		case "shell": return "bash";
		default: return undefined;
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
		metadata: featureHintMetadata(normalized),
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
				...featureHintMetadata(`${symbol.name} ${normalized}`),
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

function ensureFileNode(
	graph: ReviewGraph,
	filePath: string,
	languageId: string,
): string {
	const normalized = normalizeMapKey(filePath);
	const existing = graph.fileNodes.get(normalized);
	if (existing) return existing;
	const fileNodeId = `file:${normalized}`;
	addNode(graph, {
		id: fileNodeId,
		kind: "file",
		language: languageId,
		filePath: normalized,
		metadata: featureHintMetadata(normalized),
	});
	return fileNodeId;
}

function resolveCxxInclude(
	cwd: string,
	filePath: string,
	source: string,
): string | undefined {
	const candidates = [
		path.resolve(path.dirname(filePath), source),
		path.resolve(cwd, source),
		path.resolve(cwd, "include", source),
		path.resolve(cwd, "src", source),
	];
	const root = path.resolve(cwd);
	for (const candidate of candidates) {
		if (!candidate.startsWith(root + path.sep) && candidate !== root) continue;
		if (fs.existsSync(candidate) && detectFileKind(candidate) === "cxx") {
			return normalizeMapKey(candidate);
		}
	}
	return undefined;
}

function parseLocalCxxInclude(line: string): string | undefined {
	let i = 0;
	while (i < line.length && (line[i] === " " || line[i] === "\t")) i += 1;
	if (line[i] !== "#") return undefined;
	i += 1;
	while (i < line.length && (line[i] === " " || line[i] === "\t")) i += 1;
	if (!line.startsWith("include", i)) return undefined;
	i += "include".length;
	if (i >= line.length || (line[i] !== " " && line[i] !== "\t")) {
		return undefined;
	}
	while (i < line.length && (line[i] === " " || line[i] === "\t")) i += 1;
	if (line[i] !== '"') return undefined;
	i += 1;
	const start = i;
	while (i < line.length && line[i] !== '"') i += 1;
	if (i >= line.length || i === start) return undefined;
	return line.slice(start, i);
}

function addCxxIncludeEdges(
	graph: ReviewGraph,
	cwd: string,
	filePath: string,
): void {
	let content = "";
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch {
		return;
	}
	const fromNode = ensureFileNode(graph, filePath, "cpp");
	for (const line of content.split(/\r?\n/)) {
		const source = parseLocalCxxInclude(line);
		if (!source) continue;
		const target = resolveCxxInclude(cwd, filePath, source);
		if (!target) continue;
		const languageId = mapKindToTreeSitterLanguage("cxx", target) ?? "cpp";
		const toNode = ensureFileNode(graph, target, languageId);
		addEdge(graph, {
			from: fromNode,
			to: toNode,
			kind: "imports",
			metadata: { source },
		});
	}
}

function removeFileOwnedGraphData(
	graph: ReviewGraph,
	filePath: string,
): ReviewGraphEdge[] {
	const normalized = normalizeMapKey(filePath);
	const fileNodeId = `file:${normalized}`;
	const removedIds = new Set<string>();
	const removedSymbolIds = new Set<string>();
	for (const [id, node] of graph.nodes) {
		if (node.filePath !== normalized) continue;
		removedIds.add(id);
		if (node.kind === "symbol") removedSymbolIds.add(id);
	}
	if (graph.nodes.has(fileNodeId)) removedIds.add(fileNodeId);

	const preservedIncomingSymbolEdges: ReviewGraphEdge[] = [];
	graph.edges = graph.edges.filter((edge) => {
		const fromRemoved = removedIds.has(edge.from);
		const toRemoved = removedIds.has(edge.to);
		if (fromRemoved) return false;
		if (removedSymbolIds.has(edge.to)) {
			preservedIncomingSymbolEdges.push({ ...edge });
			return false;
		}
		// Preserve importer edges to the stable file node id; the node is re-added below.
		if (toRemoved && edge.to === fileNodeId) return true;
		return !toRemoved;
	});
	for (const id of removedIds) graph.nodes.delete(id);
	rebuildIndexes(graph);
	return preservedIncomingSymbolEdges;
}

async function addFileToGraph(
	graph: ReviewGraph,
	cwd: string,
	file: string,
	facts: FactStore,
): Promise<void> {
	const kind = detectFileKind(file);
	if (!kind || !MAIN_KINDS.has(kind)) return;
	if (kind === "jsts") {
		await ensureTsFacts(file, cwd, facts);
		addJsTsFile(graph, cwd, file, facts);
		return;
	}
	const languageId = mapKindToTreeSitterLanguage(kind, file);
	if (!languageId) return;
	const extracted = await extractTreeSitterSymbols(file, languageId);
	addTreeSitterFile(graph, file, languageId, extracted);
	if (kind === "cxx") addCxxIncludeEdges(graph, cwd, file);
}

function restoreValidIncomingEdges(
	graph: ReviewGraph,
	edges: ReviewGraphEdge[],
): void {
	const existing = new Set(
		graph.edges.map(
			(edge) =>
				`${edge.from}\u0000${edge.to}\u0000${edge.kind}\u0000${JSON.stringify(edge.metadata ?? {})}`,
		),
	);
	for (const edge of edges) {
		if (!graph.nodes.has(edge.from) || !graph.nodes.has(edge.to)) continue;
		const key = `${edge.from}\u0000${edge.to}\u0000${edge.kind}\u0000${JSON.stringify(edge.metadata ?? {})}`;
		if (existing.has(key)) continue;
		graph.edges.push(edge);
		existing.add(key);
	}
	rebuildIndexes(graph);
}

async function updateGraphFiles(
	graph: ReviewGraph,
	cwd: string,
	files: string[],
	facts: FactStore,
): Promise<void> {
	const preservedIncoming: ReviewGraphEdge[] = [];
	for (const file of files) {
		preservedIncoming.push(...removeFileOwnedGraphData(graph, file));
		await addFileToGraph(graph, cwd, file, facts);
	}
	restoreValidIncomingEdges(graph, preservedIncoming);
	resolveDeferredSymbolEdges(graph);
	graph.changedSymbolsByFile.clear();
	for (const file of files) {
		upsertChangedSymbols(graph, facts, file);
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
		const targetNode = graph.nodes.get(edge.to);
		if (!targetNode?.metadata?.unresolvedName) return edge;
		const candidates = symbolNameToIds.get(targetNode.symbolName ?? "") ?? [];
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
	const normalizedCwd = normalizeMapKey(cwd);
	const normalizedChanged = changedFiles.map((file) => normalizeMapKey(file));
	const normalizedChangedSet = new Set(normalizedChanged);
	const filesToBuild = await getGraphSourceFiles(cwd);
	const maxGraphFiles = getReviewGraphMaxFiles();
	if (filesToBuild.length > maxGraphFiles) {
		const graph = createEmptyGraph();
		graph.version = REVIEW_GRAPH_VERSION;
		graph.builtAt = new Date().toISOString();
		for (const file of normalizedChanged) {
			upsertChangedSymbols(graph, facts, file);
		}
		_lastGraphBuildInfo = {
			reused: false,
			mode: "skipped",
			skipReason: "too_many_files",
			sourceFileCount: filesToBuild.length,
			maxFileCount: maxGraphFiles,
		};
		facts.setSessionFact("session.reviewGraph", graph);
		return graph;
	}
	const fileSignatures = await sourceSignatureMapAsync(filesToBuild);
	const signature = sourceSignatureFromMap(fileSignatures);

	// Tier 1: in-memory cache (hot path — same process, already built this session)
	const memCached = _workspaceGraphCache.get(normalizedCwd);
	if (memCached?.signature === signature) {
		const graph = cloneGraph(memCached.graph);
		rebuildIndexes(graph);
		graph.changedSymbolsByFile.clear();
		for (const file of normalizedChanged) {
			upsertChangedSymbols(graph, facts, file);
		}
		_lastGraphBuildInfo = { reused: true, mode: "cached" };
		facts.setSessionFact("session.reviewGraph", graph);
		return graph;
	}
	const memChanged = memCached
		? changedSignatureFiles(memCached.fileSignatures, fileSignatures)
		: undefined;
	if (memCached && memChanged !== undefined && memChanged.length > 0) {
		// #202: a file's size/mtime can drift without its content changing
		// (formatter no-op, re-save, git checkout). Confirm by content hash so
		// such drift neither forces a re-parse nor kicks us out of the cheap
		// reuse path into a full rebuild.
		const { trulyChanged, hashes } = await confirmContentChanged(
			memChanged,
			memCached.fileHashes,
		);
		if (trulyChanged.length === 0) {
			// Pure drift — reuse the cached graph as-is.
			const graph = cloneGraph(memCached.graph);
			rebuildIndexes(graph);
			graph.changedSymbolsByFile.clear();
			for (const file of normalizedChanged) {
				upsertChangedSymbols(graph, facts, file);
			}
			_workspaceGraphCache.set(normalizedCwd, {
				signature,
				fileSignatures: new Map(fileSignatures),
				fileHashes: hashes,
				graph: cloneGraph(memCached.graph),
			});
			persistGraph(cwd, signature, fileSignatures, hashes, cloneGraph(graph));
			_lastGraphBuildInfo = { reused: true, mode: "cached" };
			facts.setSessionFact("session.reviewGraph", graph);
			return graph;
		}
		if (trulyChanged.every((file) => normalizedChangedSet.has(file))) {
			const graph = cloneGraph(memCached.graph);
			await updateGraphFiles(graph, cwd, trulyChanged, facts);
			const graphSnapshot = cloneGraph(graph);
			_workspaceGraphCache.set(normalizedCwd, {
				signature,
				fileSignatures: new Map(fileSignatures),
				fileHashes: hashes,
				graph: graphSnapshot,
			});
			persistGraph(cwd, signature, fileSignatures, hashes, graphSnapshot);
			_lastGraphBuildInfo = { reused: true, mode: "incremental" };
			facts.setSessionFact("session.reviewGraph", graph);
			return graph;
		}
	}

	// Tier 2: disk cache (cold start — files unchanged since last persist)
	const diskCached = loadPersistedGraph(cwd);
	if (diskCached?.signature === signature) {
		const graph = cloneGraph(diskCached.graph);
		rebuildIndexes(graph);
		graph.changedSymbolsByFile.clear();
		for (const file of normalizedChanged) {
			upsertChangedSymbols(graph, facts, file);
		}
		_workspaceGraphCache.set(normalizedCwd, {
			signature,
			fileSignatures: new Map(fileSignatures),
			fileHashes: diskCached.fileHashes,
			graph: cloneGraph(diskCached.graph),
		});
		_lastGraphBuildInfo = { reused: true, mode: "cached" };
		facts.setSessionFact("session.reviewGraph", graph);
		return graph;
	}
	const diskChanged =
		diskCached && diskCached.fileSignatures.size > 0
			? changedSignatureFiles(diskCached.fileSignatures, fileSignatures)
			: undefined;
	if (diskCached && diskChanged !== undefined && diskChanged.length > 0) {
		// #202: same content-hash confirm as the in-memory tier. This is where
		// it pays off most — on cold start, git/checkout mtime drift can make
		// `diskChanged` large while content is unchanged; confirming lets us
		// reuse the persisted graph instead of a full rebuild.
		const { trulyChanged, hashes } = await confirmContentChanged(
			diskChanged,
			diskCached.fileHashes,
		);
		if (trulyChanged.length === 0) {
			const graph = cloneGraph(diskCached.graph);
			rebuildIndexes(graph);
			graph.changedSymbolsByFile.clear();
			for (const file of normalizedChanged) {
				upsertChangedSymbols(graph, facts, file);
			}
			_workspaceGraphCache.set(normalizedCwd, {
				signature,
				fileSignatures: new Map(fileSignatures),
				fileHashes: hashes,
				graph: cloneGraph(diskCached.graph),
			});
			persistGraph(cwd, signature, fileSignatures, hashes, cloneGraph(graph));
			_lastGraphBuildInfo = { reused: true, mode: "cached" };
			facts.setSessionFact("session.reviewGraph", graph);
			return graph;
		}
		if (trulyChanged.every((file) => normalizedChangedSet.has(file))) {
			const graph = cloneGraph(diskCached.graph);
			await updateGraphFiles(graph, cwd, trulyChanged, facts);
			const graphSnapshot = cloneGraph(graph);
			_workspaceGraphCache.set(normalizedCwd, {
				signature,
				fileSignatures: new Map(fileSignatures),
				fileHashes: hashes,
				graph: graphSnapshot,
			});
			persistGraph(cwd, signature, fileSignatures, hashes, graphSnapshot);
			_lastGraphBuildInfo = { reused: true, mode: "incremental" };
			facts.setSessionFact("session.reviewGraph", graph);
			return graph;
		}
	}

	// Tier 3: full build
	const graph = createEmptyGraph();
	for (const file of filesToBuild) {
		await addFileToGraph(graph, cwd, file, facts);
		if (normalizedChangedSet.has(file)) {
			upsertChangedSymbols(graph, facts, file);
		}
	}

	resolveDeferredSymbolEdges(graph);
	graph.version = REVIEW_GRAPH_VERSION;
	graph.builtAt = new Date().toISOString();
	// #202: record per-file content hashes so the next run can tell a real
	// content change apart from pure mtime/size drift. Only runs on the (rare)
	// full-build path; the OS file cache is warm from the parse above.
	const fileHashes = await sourceHashMapAsync(filesToBuild);
	const graphSnapshot = cloneGraph(graph);
	_workspaceGraphCache.set(normalizedCwd, {
		signature,
		fileSignatures: new Map(fileSignatures),
		fileHashes,
		graph: graphSnapshot,
	});
	persistGraph(cwd, signature, fileSignatures, fileHashes, graphSnapshot); // fire-and-forget
	_lastGraphBuildInfo = { reused: false, mode: "full" };
	facts.setSessionFact("session.reviewGraph", graph);
	return graph;
}

export function buildOrUpdateGraph(
	cwd: string,
	changedFiles: string[],
	facts: FactStore,
): Promise<ReviewGraph> {
	const cacheKey = `${cwd}|${[...changedFiles].sort((a, b) => a.localeCompare(b)).join(",")}`;
	const cached = _buildCache.get(cacheKey);
	if (cached) return cached;

	const promise = _doBuildGraph(cwd, changedFiles, facts).catch((err) => {
		_buildCache.delete(cacheKey);
		throw err as Error;
	});
	_buildCache.set(cacheKey, promise);
	return promise;
}

/**
 * Extract symbols and refs from an already-built ReviewGraph for call graph construction.
 * Reuses parsed data without re-running tree-sitter — symbols come from "symbol" nodes,
 * refs come from "references" edges. Line numbers are unavailable here (not stored in graph
 * nodes), so caller attribution falls back to file-level keys in buildCallGraph.
 */
export function extractSymbolsAndRefsFromGraph(
	graph: ReviewGraph,
): {
	allSymbols: Map<string, import("../symbol-types.js").Symbol[]>;
	allRefs: Map<string, import("../symbol-types.js").SymbolRef[]>;
} {
	const allSymbols = new Map<string, import("../symbol-types.js").Symbol[]>();
	const allRefs = new Map<string, import("../symbol-types.js").SymbolRef[]>();

	for (const node of graph.nodes.values()) {
		if (node.kind === "symbol" && node.filePath && node.symbolName) {
			const sym: import("../symbol-types.js").Symbol = {
				id: `${node.filePath}:${node.symbolName}`,
				name: node.symbolName,
				kind: "function" as const,
				filePath: node.filePath,
				line: 1,
				column: 1,
				isExported: false,
			};
			const list = allSymbols.get(node.filePath) ?? [];
			list.push(sym);
			allSymbols.set(node.filePath, list);
		}
	}

	for (const edge of graph.edges) {
		if (edge.kind === "references" && edge.from.startsWith("file:")) {
			const callerFile = edge.from.slice("file:".length);
			const refName = edge.to.startsWith("symbol-name:")
				? edge.to.slice("symbol-name:".length)
				: edge.to.split(":").pop() ?? edge.to;
			const ref: import("../symbol-types.js").SymbolRef = {
				symbolId: `${callerFile}:${refName}`,
				filePath: callerFile,
				line: (edge.metadata as { line?: number } | undefined)?.line ?? 1,
				column: (edge.metadata as { column?: number } | undefined)?.column ?? 1,
			};
			const list = allRefs.get(callerFile) ?? [];
			list.push(ref);
			allRefs.set(callerFile, list);
		}
	}

	return { allSymbols, allRefs };
}
