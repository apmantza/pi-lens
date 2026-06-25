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
 * Single mode (no depth knob — #256). READ-ONLY by contract — it never builds a
 * graph and never calls an LSP server on this path (both repeatedly OOM'd pi when
 * an agent fanned out reports). Every call:
 *   1. tree-sitter extract of THE one file (always; cold-safe structure).
 *   2. read the already-built review graph (in-memory, else the persisted disk
 *      snapshot) for who-uses-this / flags / imports — never a build. Cold cache
 *      → outline only.
 * `semantic.source` reflects who-uses-this provenance: "review-graph" when the
 * cached graph backs it, else "none" (cold). Live-LSP enrichment is re-homed to
 * #236, where LSP writes provenance-tagged edges INTO the graph (once, persisted)
 * for this path to read as "graph-lsp". That logic lives in clients/module-report-lsp.ts.
 *
 * Guard integrity: moduleReport injects NO read records — an outline is not
 * "having seen the body". readSymbol returns the actual body lines so the host
 * can record a read that legitimately satisfies the read-guard for that symbol.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { detectFileKind } from "./file-kinds.js";
import { logLatency } from "./latency-logger.js";
import { normalizeMapKey } from "./path-utils.js";
import { resolveImportToFiles } from "./review-graph/import-resolvers.js";
import type { ReviewGraph, ReviewGraphEdgeKind } from "./review-graph/types.js";
import type { Symbol as ExtractedSymbol } from "./symbol-types.js";
import { TreeSitterClient } from "./tree-sitter-client.js";
import {
	type ImportRef,
	TreeSitterSymbolExtractor,
} from "./tree-sitter-symbol-extractor.js";

// NOTE: live-LSP enrichment is NO LONGER called on this read path (#256). Firing
// LSP per read — speculatively, on the agent's fan-out path — repeatedly OOM'd
// pi. The enrichment logic is kept as a separate module (clients/module-report-
// lsp.ts) to be re-homed in #236, where LSP writes provenance-tagged edges INTO
// the review graph (computed once, persisted) so this path just reads them.

export interface ModuleReportOptions {
	/** Cap on who-uses-this entries per symbol. */
	maxRefsPerSymbol?: number;
}

export interface ModuleSymbolUsedBy {
	file: string;
	symbol: string;
	line: number;
	relation: ReviewGraphEdgeKind;
	/** Where this edge came from: the AST review graph, or a live LSP query. */
	provenance?: "ast" | "lsp";
}

export interface ModuleSymbolEntry {
	name: string;
	kind: string;
	startLine: number;
	endLine: number;
	exported: boolean;
	/** Set only for non-public members of an exported class (#258); omitted
	 * otherwise. Explains why an otherwise-reachable member sits in `internal`. */
	visibility?: "private" | "protected";
	signature?: string;
	doc?: string;
	/** Outgoing call count (jsts graph path only). */
	fanout?: number;
	/** McCabe complexity (jsts graph path only). */
	complexity?: number;
	/** Empty when the symbol has no risk flags; omitted from the wire entirely. */
	flags?: string[];
	usedBy?: ModuleSymbolUsedBy[];
	/** Members nested under their container by line-range containment (#301) —
	 * a class/interface's methods/fields, an outer class's inner classes. Each
	 * member is a full entry (read-args, visibility, who-uses-this); omitted when
	 * the symbol has none. The api/internal split is over TOP-LEVEL entries only;
	 * members ride along inside their container. */
	members?: ModuleSymbolEntry[];
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
	staleness: "fresh" | "unavailable";
	path: string;
	language?: string;
	lineCount?: number;
	summary: { imports: number; exports: number; symbols: number };
	imports: { external: string[]; internal: string[] };
	api: ModuleSymbolEntry[];
	internal: ModuleSymbolEntry[];
	recommendedReads: RecommendedRead[];
	semantic: {
		/** Provenance of who-uses-this: AST review graph, future graph-LSP edges
		 * (#236), or none (cold cache). */
		source: "review-graph" | "graph-lsp" | "none";
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

async function extractFile(
	absPath: string,
	languageId: string,
	content: string,
): Promise<{ symbols: ExtractedSymbol[]; imports: ImportRef[] }> {
	try {
		const initialized = await tsClient.init();
		if (!initialized) return { symbols: [], imports: [] };
		const tree = await tsClient.parseFile(absPath, languageId);
		if (!tree) return { symbols: [], imports: [] };
		const extractor = await getExtractor(languageId);
		if (!extractor) return { symbols: [], imports: [] };
		const result = extractor.extract(tree, absPath, content);
		return { symbols: result.symbols, imports: result.imports };
	} catch {
		return { symbols: [], imports: [] };
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
	projectRoot: string,
): ModuleSymbolUsedBy[] {
	const out: ModuleSymbolUsedBy[] = [];
	const seen = new Set<string>();
	for (const edge of graph.edgesByTo.get(symbolNodeId) ?? []) {
		if (edge.kind !== "calls" && edge.kind !== "references") continue;
		const from = graph.nodes.get(edge.from);
		const rawFile =
			from?.filePath ??
			(edge.from.startsWith("file:") ? edge.from.slice("file:".length) : "");
		if (!rawFile) continue;
		const file = toDisplayPath(rawFile, projectRoot);
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

// Human-facing path: cwd-relative + forward-slashed when the file sits under the
// project root, else the absolute (slash-normalized) path. Machine fields (the
// `read` args) keep the absolute path so the host's Read tool resolves them
// unambiguously; only display fields (`path`, `usedBy.file`, imports) relativize.
function toDisplayPath(p: string, projectRoot: string): string {
	if (!path.isAbsolute(p)) return p.replace(/\\/g, "/");
	const rel = path.relative(projectRoot, p);
	return rel && !rel.startsWith("..")
		? rel.replace(/\\/g, "/")
		: p.replace(/\\/g, "/");
}

function collectImports(
	graph: ReviewGraph,
	normalizedPath: string,
	projectRoot: string,
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
				internal.add(toDisplayPath(target.filePath, projectRoot));
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

// An import source string "looks internal" when its shape names a same-project
// target the per-language resolver couldn't pin to a file (a not-yet-created
// file, or a language we don't resolve to disk). Relative paths and Rust's
// crate-relative prefixes are unambiguously in-project; everything else
// (bare specifiers, absolute package paths) is treated as external. This is the
// floor under `resolveImportToFiles` — it never fabricates a file path, only a
// best-effort internal/external bucket.
function looksInternal(source: string, languageId: string): boolean {
	// C/C++ (#302): a #include is local-vs-system by syntax, not by a leading dot.
	// A system header keeps its angle brackets (<stdio.h>) → external; a quoted
	// local include arrives bare (foo.h, quotes already stripped) → internal, even
	// when the header file isn't on disk.
	if (languageId === "c" || languageId === "cpp") {
		return !source.startsWith("<");
	}
	// A leading "." is relative across every language we extract (JS ./ ../,
	// Python . .foo ..pkg, Ruby/Dart/bash relative paths) and never begins a bare
	// or scoped package specifier (react, @scope/pkg, java.util.List, fmt). Rust's
	// crate-relative prefixes are likewise unambiguously in-project.
	return (
		source.startsWith(".") ||
		source.startsWith("crate::") ||
		source.startsWith("super::") ||
		source.startsWith("self::")
	);
}

// Cold-cache imports (#301): the warm review graph is the source of truth for
// imports, but on a cold cache it's absent and `collectImports` returns empty
// even though the tree-sitter extractor already parsed the import sources. Rebuild
// the same {external, internal} shape language-uniformly from those sources:
// resolve each to real in-project files via the warm graph's own resolver
// (`resolveImportToFiles`) when the language supports it, else fall back to the
// shape heuristic. Internal entries are cwd-relative display paths (resolved) or
// the raw source (heuristic), mirroring `collectImports`.
function coldImports(
	imports: ImportRef[],
	languageId: string,
	absPath: string,
	projectRoot: string,
): { external: string[]; internal: string[] } {
	const external = new Set<string>();
	const internal = new Set<string>();
	for (const imp of imports) {
		const files = resolveImportToFiles(
			projectRoot,
			absPath,
			languageId,
			imp.source,
		);
		if (files.length > 0) {
			for (const f of files) internal.add(toDisplayPath(f, projectRoot));
		} else if (looksInternal(imp.source, languageId)) {
			internal.add(imp.source);
		} else {
			external.add(imp.source);
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
	projectRoot: string,
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

	// A private/protected member of an exported class is reachable but NOT part
	// of the public API, so it must not count as `exported` for the api/internal
	// split, the "exported" flag, or read ranking (#258). The extractor's
	// sym.isExported is untouched (the review graph still sees the full surface);
	// this gating is local to the report's presentation.
	const nonPublic =
		sym.visibility === "private" || sym.visibility === "protected";
	const exported = (sym.isExported || !!node?.exported) && !nonPublic;
	const flags: string[] = [];
	if (exported) flags.push("exported");
	if (fanout !== undefined && fanout >= 4) flags.push("high fanout");
	if (complexity !== undefined && complexity >= 8)
		flags.push("high complexity");
	if (metadata.isBoundaryWrapper) flags.push("boundary wrapper");

	const usedBy = graph
		? resolveUsedBy(graph, symbolNodeId, maxRefs, projectRoot)
		: undefined;

	return {
		name: sym.name,
		kind: sym.kind,
		startLine,
		endLine,
		exported,
		...(sym.visibility ? { visibility: sym.visibility } : {}),
		signature: sym.signature,
		doc: sym.doc,
		fanout: fanout && fanout > 0 ? fanout : undefined,
		complexity,
		// Empty flags array would waste ~3-5 tokens per entry on a 41-symbol
		// outline (~200 tok total). Omit when there's nothing to report.
		...(flags.length > 0 ? { flags } : {}),
		usedBy: usedBy && usedBy.length > 0 ? usedBy : undefined,
		read: readArgsFor(displayPath, startLine, endLine),
	};
}

// Nest members under their container by line-range containment (#301), mirroring
// ast-grep's outline: a class/interface's methods sit in its `members[]`, not at
// the top level. Each entry attaches to its NEAREST (smallest) strictly-enclosing
// entry, so arbitrary depth (a method in an inner class in an outer class) nests
// correctly. Mutates the entries (sets `members`) and returns the TOP-LEVEL ones
// (no container) for the api/internal split. The flat list stays usable for
// ranking so hot nested methods still surface in recommendedReads.
function nestEntries(entries: ModuleSymbolEntry[]): ModuleSymbolEntry[] {
	const span = (e: ModuleSymbolEntry) => e.endLine - e.startLine;
	const containerOf = new Map<
		ModuleSymbolEntry,
		ModuleSymbolEntry | undefined
	>();
	for (const e of entries) {
		let best: ModuleSymbolEntry | undefined;
		for (const c of entries) {
			if (c === e) continue;
			// Strict containment: c wraps e AND is strictly larger, so equal-range
			// pairs (a mis-extracted class+ctor on the same lines) never mutually nest.
			const contains =
				c.startLine <= e.startLine &&
				c.endLine >= e.endLine &&
				span(c) > span(e);
			if (!contains) continue;
			if (!best || span(c) < span(best)) best = c;
		}
		containerOf.set(e, best);
	}
	for (const e of entries) {
		const parent = containerOf.get(e);
		if (!parent) continue;
		if (!parent.members) parent.members = [];
		parent.members.push(e);
	}
	for (const e of entries) {
		if (e.members) e.members.sort((a, b) => a.startLine - b.startLine);
	}
	return entries.filter((e) => !containerOf.get(e));
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
			(entry.flags?.includes("high complexity") ? 3 : 0);
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
 * Build a structured report for a single module. Read-only, single mode (#256):
 * tree-sitter extract + 3-tier-cached review graph (who-uses-this, imports,
 * complexity/fanout) + bounded live-LSP enrichment of exported symbols. Each tier
 * degrades independently, so a cold graph or absent LSP server never aborts the
 * report — it just narrows what's populated.
 */
export async function moduleReport(
	file: string,
	cwd: string,
	options?: ModuleReportOptions,
): Promise<ModuleReport> {
	const startedAt = Date.now();
	const maxRefs = Math.max(1, options?.maxRefsPerSymbol ?? 10);
	const absPath = path.resolve(cwd, file);
	const normalizedPath = normalizeMapKey(absPath);

	let content: string;
	try {
		content = fs.readFileSync(absPath, "utf-8");
	} catch {
		return unavailableReport(toDisplayPath(absPath, cwd));
	}

	const kind = detectFileKind(absPath);
	const languageId = tsLangForFile(absPath, kind);
	const lineCount = content.split(/\r?\n/).length;

	const { symbols: extracted, imports: extractedImports } = languageId
		? await extractFile(absPath, languageId, content)
		: { symbols: [], imports: [] };

	// READ-ONLY: consume the already-built review graph, never build one here. A
	// synchronous full build re-runs every fact provider (TS-compiler ASTs for
	// jsts) and two racing builds OOM'd pi (#256). Cold cache → outline-only.
	let graph: ReviewGraph | undefined;
	try {
		const { getCachedReviewGraph } = await import("./review-graph/builder.js");
		graph = getCachedReviewGraph(cwd);
	} catch {
		graph = undefined;
	}

	// Drop function-local declarations (a nested const/arrow/function) from the
	// outline — they're implementation detail of a parent symbol, not navigable
	// module structure (#259). Presentation-only: the review graph keeps them.
	const outlineSymbols = extracted.filter((sym) => !sym.local);

	// Flat entries first — ranking and cold-import resolution both read the full
	// list. `entries` is mutated by nestEntries (members attached); `topLevel` is
	// the api/internal split surface.
	const entries = outlineSymbols.map((sym) =>
		toEntry(sym, absPath, normalizedPath, graph, maxRefs, cwd),
	);
	const topLevel = nestEntries(entries);

	const api = topLevel.filter((entry) => entry.exported);
	const internal = topLevel.filter((entry) => !entry.exported);

	// Imports: the warm review graph is source-of-truth; on a cold cache (or a
	// graph without this file's node) fall back to the language-uniform tree-sitter
	// resolution (#301) so a cold report no longer shows zero imports.
	const warmImports = graph
		? collectImports(graph, normalizedPath, cwd)
		: { external: [], internal: [] };
	const imports =
		warmImports.external.length + warmImports.internal.length > 0 || !languageId
			? warmImports
			: coldImports(extractedImports, languageId, absPath, cwd);

	const hasGraphNode = graph?.fileNodes.has(normalizedPath) ?? false;

	const report: ModuleReport = {
		available: entries.length > 0 || hasGraphNode,
		staleness: entries.length === 0 && !hasGraphNode ? "unavailable" : "fresh",
		path: toDisplayPath(absPath, cwd),
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
			// Provenance of who-uses-this / references. The AST review graph is the
			// only source on this read path; "graph-lsp" is reserved for #236 (LSP
			// writes provenance edges INTO the graph). Cold cache → "none".
			source: hasGraphNode ? "review-graph" : "none",
			references: hasGraphNode,
			implementations: false,
		},
	};

	// Observability (#256): record graph source (cached vs cold) so a future
	// regression is attributable per call. This path is read-only by contract —
	// "graph: cached|cold", never a build, never an LSP call.
	logLatency({
		type: "phase",
		phase: "module_report",
		filePath: absPath,
		durationMs: Date.now() - startedAt,
		metadata: {
			graph: graph ? "cached" : "cold",
			symbols: entries.length,
			exported: api.length,
		},
	});

	return report;
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
	const startedAt = Date.now();
	const absPath = path.resolve(cwd, file);
	// Pure tree-sitter on one file — no graph, no LSP. Log for correlation with
	// module_report frequency/timing (#256), one event per outcome.
	const log = (found: boolean): void => {
		logLatency({
			type: "phase",
			phase: "read_symbol",
			filePath: absPath,
			durationMs: Date.now() - startedAt,
			metadata: { symbol: symbolName, found },
		});
	};

	let content: string;
	try {
		content = fs.readFileSync(absPath, "utf-8");
	} catch {
		log(false);
		return { found: false, path: absPath, name: symbolName };
	}

	const kind = detectFileKind(absPath);
	const languageId = tsLangForFile(absPath, kind);
	if (!languageId) {
		log(false);
		return { found: false, path: absPath, name: symbolName };
	}

	const { symbols } = await extractFile(absPath, languageId, content);
	const sym = symbols.find((candidate) => candidate.name === symbolName);
	if (!sym) {
		log(false);
		return { found: false, path: absPath, name: symbolName };
	}

	const startLine = sym.line;
	const endLine = sym.endLine ?? sym.line;
	const lines = content.split(/\r?\n/);
	const source = lines.slice(startLine - 1, endLine).join("\n");

	log(true);
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
