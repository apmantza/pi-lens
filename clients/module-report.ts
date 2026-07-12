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
 *   2. language-agnostic inline executable extraction over the same tree-sitter
 *      AST (callbacks/closures/lambdas/function literals; no second parse).
 *   3. read the already-built review graph (in-memory, else the persisted disk
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
import { annotateMiddleMan } from "./middle-man-analysis.js";
import { normalizeMapKey } from "./path-utils.js";
import { resolveImportToFiles } from "./review-graph/import-resolvers.js";
import type { ReviewGraph, ReviewGraphEdgeKind } from "./review-graph/types.js";
import type { Symbol as ExtractedSymbol } from "./symbol-types.js";
import { getSharedTreeSitterClient } from "./tree-sitter-shared.js";
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
	/** Optional task hint used only to rank recommendedReads; never expands scope or triggers scans. */
	focus?: string;
	/** Payload tier. `summary` keeps top-level read handles/recommendations only.
	 * `compact` computes the same full data as `default` (so the JSON shape and
	 * `ModuleReport` type are unaffected) but signals the caller to render it as
	 * the line-oriented text view (`renderCompactModuleReport`) instead of JSON —
	 * see tools/module-report.ts. */
	view?: "summary" | "default" | "compact";
	/** Include the cross-file blast-radius section (#304): the transitive
	 * dependents of this module, aggregated to ranked file `read` args. Read-only
	 * over the CACHED graph — omitted entirely on a cold cache (never builds). */
	blastRadius?: boolean;
	/** Max hops for the blast-radius walk (default 3). Only meaningful with
	 * `blastRadius`. */
	blastRadiusDepth?: number;
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
	/** Decorators/attributes/annotations on the declaration, in source order
	 * (`@app.get("/x")`, `#[tokio::main]`, `@Override`) — the symbol's role without
	 * reading its body. Omitted when none. */
	decorators?: string[];
	/** Outgoing call count (jsts graph path only). */
	fanout?: number;
	/** McCabe complexity (jsts graph path only). */
	complexity?: number;
	/** Non-derivable risk/lifecycle signals (e.g. "async", "high fanout", "high
	 * complexity", "boundary wrapper", "middle man"). "exported" is NOT repeated
	 * here — it already rides the `exported` boolean field above (#512). Empty
	 * flags omit the key entirely from the wire. */
	flags?: string[];
	/** Share of a class's real methods (excludes accessors/constructors) whose
	 * ENTIRE body is a single pure-forwarding call to ONE held field (#325).
	 * Only set on class-kind entries that clear the "middle man" flag threshold
	 * — see `middle-man-analysis.ts`. Not a general-purpose metric surfaced for
	 * every class; absent means either not a class, too few methods to judge,
	 * or below threshold. */
	delegationRatio?: number;
	usedBy?: ModuleSymbolUsedBy[];
	/** Members nested under their container by line-range containment (#301) —
	 * a class/interface's methods/fields, an outer class's inner classes. Each
	 * member is a full entry (visibility, who-uses-this); omitted when
	 * the symbol has none. The api/internal split is over TOP-LEVEL entries only;
	 * members ride along inside their container. */
	members?: ModuleSymbolEntry[];
	// NOTE (#512): no `read` block here. offset/limit are pure derivations of
	// startLine/endLine (offset = startLine, limit = endLine - startLine + 1) and
	// the path is the report's own `path` field — repeating all three per symbol
	// cost real tokens with zero new information. To read a symbol: call
	// `read`/`read_symbol` with offset=startLine, limit=endLine-startLine+1 on
	// THIS report's path.
}

export interface RecommendedRead {
	reason: string;
	/** Named symbol or synthetic callback handle. */
	symbol?: string;
	startLine: number;
	endLine: number;
}

export interface ModuleCallbackEntry {
	/** Stable synthetic handle usable with read_symbol. */
	name: string;
	/** Normalized role for an inline callback/closure/lambda. */
	kind: string;
	/** Raw tree-sitter node kind for debugging. */
	rawKind: string;
	startLine: number;
	endLine: number;
	signature?: string;
	parentChain?: string[];
	flags?: string[];
	// NOTE (#512): no `read` block — same derivation as ModuleSymbolEntry
	// (offset = startLine, limit = endLine - startLine + 1, path = report's own
	// `path`). Use readArgsFor(...)-equivalent math to build a read call.
}

/** One file in the blast radius (#304): a transitive dependent of this module,
 * aggregated from its (possibly several) dependent symbols. */
export interface BlastRadiusFile {
	/** cwd-relative display path of the dependent file. */
	file: string;
	/** How many dependent symbols/edges in this file reach the module. */
	dependents: number;
	/** Closest hop at which this file depends on the module (1 = direct). */
	minDepth: number;
	/** Distinct edge kinds by which it depends (calls/references/imports). */
	relations: ReviewGraphEdgeKind[];
	/** Ready-to-use read args for the whole dependent file (verify the change). */
	read: { path: string; offset: number; limit: number };
}

/** Cross-file blast radius (#304): "if you change this module, read/verify these
 * files". Present only when requested AND the cached graph is warm. */
export interface BlastRadius {
	/** True when the impact walk hit its node cap (the list is a prefix). */
	truncated: boolean;
	/** Deepest hop reached (transitivity actually observed). */
	maxDepth: number;
	/** Dependent files, ranked closest-and-most-depended-on first. */
	files: BlastRadiusFile[];
}

export interface ModuleReport {
	/** False when the file is unreadable or has no symbols and no graph node. */
	available: boolean;
	staleness: "fresh" | "unavailable";
	path: string;
	/** Present when the report degraded because parsing/extraction failed. */
	error?: string;
	/** Non-fatal degradation notes for approximate sections. */
	warnings?: string[];
	language?: string;
	lineCount?: number;
	view?: "summary" | "compact";
	summary: { imports: number; exports: number; symbols: number };
	imports: { external: string[]; internal: string[] };
	api: ModuleSymbolEntry[];
	internal: ModuleSymbolEntry[];
	/** Important anonymous callbacks/closures that normal symbol outlines miss. */
	callbacks: ModuleCallbackEntry[];
	/**
	 * Honesty signal for the callbacks section. `tuned` = language-specific
	 * callback rules applied (e.g. Go goroutines/defer); `generic` = the default
	 * JS/TS-shaped heuristics were used (named/assigned/captured callbacks only —
	 * no language-specific role detection). Lets callers avoid over-trusting the
	 * callbacks list for languages without a tuned rule set.
	 */
	callbackSupport?: "tuned" | "generic";
	recommendedReads: RecommendedRead[];
	/** Cross-file blast radius (#304) — present only when requested via
	 * `blastRadius` and the cached graph is warm; omitted otherwise. */
	blastRadius?: BlastRadius;
	/**
	 * ISO timestamp the cached review graph was last built (`ReviewGraph.builtAt`),
	 * present whenever a graph was consulted (warm or cold-but-existing). Omitted
	 * when no graph exists at all. Additive (#536) — this is the persisted
	 * timestamp an MCP adapter uses to compute a staleness hint; the pi tool
	 * surface ignores it (staleness signage is MCP-only, per #536's decision:
	 * pi's graph is per-edit warm, so a staleness line there would be noise).
	 */
	graphBuiltAt?: string;
	provenance?: {
		symbols: "syntax" | "none";
		imports: "cached-review-graph" | "syntax" | "none";
		usedBy: "cached-review-graph" | "none";
		callbacks: "heuristic-tree-sitter" | "none";
		blastRadius?: "cached-review-graph" | "none";
	};
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
	/** Present when extraction failed rather than the symbol being absent. */
	error?: string;
	/** Non-fatal degradation notes from symbol/callback extraction. */
	warnings?: string[];
	kind?: string;
	startLine?: number;
	endLine?: number;
	signature?: string;
	/** The verbatim body lines — recording this read satisfies the read-guard. */
	source?: string;
	/**
	 * ~3 nearest symbol/callback names in the file, by name similarity, when
	 * `symbolName` misses (#523). Lets the caller self-correct a typo or
	 * qualification mismatch without a module_report round-trip. Omitted when
	 * found, or when nothing in the file scores above the similarity threshold.
	 */
	suggestions?: string[];
	/**
	 * Set when more than one same-file symbol shares the requested name
	 * (overloads, a type and a value sharing a name) — `match` above is the
	 * FIRST one (source order), same as the historical silent behavior; this
	 * just makes the ambiguity visible so the caller can pass `kind` to pick a
	 * specific one (#523).
	 */
	ambiguous?: { count: number; kinds: string[] };
}

export interface ReadSymbolOptions {
	/**
	 * Disambiguates same-name matches by kind (e.g. "function" vs "interface").
	 * Optional; omitting it preserves the historical "return the first match"
	 * behavior (#523).
	 */
	kind?: string;
}

export interface ReadEnclosingOutlineItem {
	name: string;
	kind: string;
	startLine: number;
	endLine: number;
	signature?: string;
	parentChain?: string[];
	read: { path: string; offset: number; limit: number };
}

export interface ReadEnclosingResult {
	found: boolean;
	path: string;
	line: number;
	name?: string;
	kind?: string;
	startLine?: number;
	endLine?: number;
	enclosingStartLine?: number;
	enclosingEndLine?: number;
	signature?: string;
	parentChain?: string[];
	partial?: boolean;
	selection?: {
		strategy: "range-containment" | "oversize-slice" | "oversize-outline";
		source: "tree-sitter";
		confidence: "high" | "medium";
	};
	outline?: ReadEnclosingOutlineItem[];
	error?: string;
	warnings?: string[];
	/** The verbatim enclosing body lines — recording this read satisfies the read-guard. */
	source?: string;
}

export interface ReadEnclosingOptions {
	/** Optional semantic kind filter, e.g. function, method, callback, class. */
	kinds?: string[];
	/** Optional maximum body size to return. Oversized matches obey onOversize. */
	maxLines?: number;
	/** Oversize behavior: error (default), bounded slice, or nested outline. */
	onOversize?: "error" | "slice" | "outline";
	/** Maximum lines for onOversize=slice; defaults to maxLines, then 80. */
	aroundLine?: number;
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

// Per-language extractor cache — extractors are cheap once their queries are
// compiled. The shared TreeSitterClient (which memoizes grammar init) is obtained
// per call from the process-wide singleton.
const extractorCache = new Map<
	string,
	Promise<TreeSitterSymbolExtractor | null>
>();

async function getExtractor(
	languageId: string,
): Promise<TreeSitterSymbolExtractor | null> {
	let cached = extractorCache.get(languageId);
	if (!cached) {
		cached = (async () => {
			const client = getSharedTreeSitterClient();
			if (!client) return null;
			const extractor = new TreeSitterSymbolExtractor(languageId, client);
			const ok = await extractor.init();
			return ok ? extractor : null;
		})().catch((err) => {
			extractorCache.delete(languageId);
			throw err;
		});
		extractorCache.set(languageId, cached);
	}
	return cached;
}

type ModuleReportNode = {
	type: string;
	text: string;
	children: ModuleReportNode[];
	parent?: ModuleReportNode | null;
	/** Named (vs anonymous punctuation/keyword) node — web-tree-sitter field. */
	isNamed?: boolean;
	startPosition: { row: number; column: number };
	endPosition: { row: number; column: number };
};

function diagnosticMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

async function extractFile(
	absPath: string,
	languageId: string,
	content: string,
): Promise<{
	symbols: ExtractedSymbol[];
	imports: ImportRef[];
	root?: ModuleReportNode;
	error?: string;
	warnings?: string[];
}> {
	try {
		const tsClient = getSharedTreeSitterClient();
		if (!tsClient) {
			return {
				symbols: [],
				imports: [],
				error: "tree-sitter runtime unavailable (wasm aborted)",
			};
		}
		const initialized = await tsClient.init();
		if (!initialized) {
			return {
				symbols: [],
				imports: [],
				error: "tree-sitter runtime failed to initialize",
			};
		}
		const tree = await tsClient.parseFile(absPath, languageId);
		if (!tree) {
			return {
				symbols: [],
				imports: [],
				error: `tree-sitter failed to parse as ${languageId}`,
			};
		}
		const extractor = await getExtractor(languageId);
		const root = tree.rootNode as unknown as ModuleReportNode;
		if (!extractor) {
			return {
				symbols: [],
				imports: [],
				root,
				warnings: [`Symbol extractor not available for ${languageId}`],
			};
		}
		const result = extractor.extract(tree, absPath, content);
		return { symbols: result.symbols, imports: result.imports, root };
	} catch (err) {
		const message = diagnosticMessage(err);
		logLatency({
			type: "phase",
			phase: "module_report_extract_error",
			filePath: absPath,
			durationMs: 0,
			metadata: { error: message },
		});
		return { symbols: [], imports: [], error: message };
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
): { external: string[]; internal: string[]; warnings: string[] } {
	const external = new Set<string>();
	const internal = new Set<string>();
	const warnings: string[] = [];
	for (const imp of imports) {
		let files: string[] = [];
		try {
			files = resolveImportToFiles(
				projectRoot,
				absPath,
				languageId,
				imp.source,
			);
		} catch (err) {
			const message = diagnosticMessage(err);
			warnings.push(`Failed to resolve import "${imp.source}": ${message}`);
			logLatency({
				type: "phase",
				phase: "module_report_import_resolve_error",
				filePath: absPath,
				durationMs: 0,
				metadata: {
					import: imp.source,
					error: message,
				},
			});
		}
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
		warnings,
	};
}

function toEntry(
	sym: ExtractedSymbol,
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
	// split or read ranking (#258). The extractor's sym.isExported is untouched
	// (the review graph still sees the full surface); this gating is local to
	// the report's presentation.
	const nonPublic =
		sym.visibility === "private" || sym.visibility === "protected";
	const exported = (sym.isExported || !!node?.exported) && !nonPublic;
	// `flags` carries only non-derivable signals — "exported" is NOT pushed here
	// since it duplicates the `exported` boolean field below (#512).
	const flags: string[] = [];
	if (sym.isAsync) flags.push("async");
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
		...(sym.decorators?.length ? { decorators: sym.decorators } : {}),
		signature: sym.signature,
		doc: sym.doc,
		fanout: fanout && fanout > 0 ? fanout : undefined,
		complexity,
		// Empty flags array would waste ~3-5 tokens per entry on a 41-symbol
		// outline (~200 tok total). Omit when there's nothing to report.
		...(flags.length > 0 ? { flags } : {}),
		usedBy: usedBy && usedBy.length > 0 ? usedBy : undefined,
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

function summarizeEntries(entries: ModuleSymbolEntry[]): ModuleSymbolEntry[] {
	return entries.map((entry) => ({
		name: entry.name,
		kind: entry.kind,
		startLine: entry.startLine,
		endLine: entry.endLine,
		exported: entry.exported,
		...(entry.visibility ? { visibility: entry.visibility } : {}),
		...(entry.signature ? { signature: entry.signature } : {}),
		...(entry.doc ? { doc: entry.doc } : {}),
		...(entry.flags ? { flags: entry.flags } : {}),
		...(entry.members
			? {
					members: entry.members.map((member) => ({
						name: member.name,
						kind: member.kind,
						startLine: member.startLine,
						endLine: member.endLine,
						exported: member.exported,
						...(member.visibility ? { visibility: member.visibility } : {}),
						...(member.signature ? { signature: member.signature } : {}),
						...(member.doc ? { doc: member.doc } : {}),
					})),
				}
			: {}),
	}));
}

function normalizeFocus(focus: string | undefined): string[] {
	return (focus ?? "")
		.toLowerCase()
		.split(/[^a-z0-9_.]+/)
		.map((part) => part.trim())
		.filter((part) => part.length >= 3)
		.slice(0, 8);
}

function focusScore(text: string, terms: string[]): number {
	if (terms.length === 0) return 0;
	const haystack = text.toLowerCase();
	return terms.reduce(
		(score, term) => score + (haystack.includes(term) ? 6 : 0),
		0,
	);
}

function rankRecommendedReads(
	entries: ModuleSymbolEntry[],
	callbacks: ModuleCallbackEntry[] = [],
	limit = 5,
	focus?: string,
): RecommendedRead[] {
	const focusTerms = normalizeFocus(focus);
	const scoredSymbols = entries.map((entry) => {
		const refs = entry.usedBy?.length ?? 0;
		const focus = focusScore(
			[
				entry.name,
				entry.kind,
				entry.signature ?? "",
				entry.flags?.join(" ") ?? "",
			].join(" "),
			focusTerms,
		);
		const score =
			refs * 2 +
			(entry.complexity ?? 0) +
			(entry.exported ? 2 : 0) +
			(entry.flags?.includes("high complexity") ? 3 : 0) +
			focus;
		return { kind: "symbol" as const, entry, score, refs, focus };
	});
	const scoredCallbacks = callbacks.map((callback) => {
		const flags = callback.flags ?? [];
		const focus = focusScore(
			[
				callback.name,
				callback.kind,
				callback.signature ?? "",
				flags.join(" "),
			].join(" "),
			focusTerms,
		);
		const score =
			(flags.includes("captures ctx.ui") ? 8 : 0) +
			(flags.includes("captures ctx") ? 5 : 0) +
			(flags.includes("detached timer") ? 4 : 0) +
			(flags.includes("lifecycle") ? 3 : 0) +
			(callback.kind === "object_property_callback" ? 2 : 0) +
			(callback.kind === "assigned_callback" ? 1 : 0) +
			focus;
		return { kind: "callback" as const, callback, score, focus };
	});
	const scored = [...scoredSymbols, ...scoredCallbacks].filter(
		(item) => item.score > 0,
	);
	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, limit).map((item) => {
		if (item.kind === "symbol") {
			const { entry, refs } = item;
			const reasons: string[] = [];
			if (item.focus > 0) reasons.push("matches focus");
			if (entry.exported) reasons.push("exported");
			if (refs > 0) reasons.push(`used by ${refs}`);
			if (entry.complexity !== undefined && entry.complexity >= 8) {
				reasons.push(`complexity ${entry.complexity}`);
			}
			return {
				reason: reasons.join(", ") || "public surface",
				symbol: entry.name,
				startLine: entry.startLine,
				endLine: entry.endLine,
			};
		}
		const reasons: string[] = [];
		if (item.focus > 0) reasons.push("matches focus");
		if (item.callback.flags?.length) reasons.push(...item.callback.flags);
		if (item.callback.kind === "object_property_callback") {
			reasons.push("callback property");
		}
		if (item.callback.kind === "assigned_callback") {
			reasons.push("assigned callback");
		}
		return {
			reason: reasons.join(", ") || item.callback.kind,
			symbol: item.callback.name,
			startLine: item.callback.startLine,
			endLine: item.callback.endLine,
		};
	});
}

// Cap the blast-radius list so a high-fanout module doesn't blow the token
// budget; the ranking puts the closest/most-depended-on files first. The read
// limit is the dependent file's own line count when the graph knows it, else a
// modest default — these are "go verify" pointers, not full dumps.
const BLAST_RADIUS_FILE_CAP = 12;
const BLAST_RADIUS_DEFAULT_READ_LIMIT = 400;

function blastReadArgs(
	graph: ReviewGraph,
	normalizedFile: string,
): { path: string; offset: number; limit: number } {
	const fileNodeId = graph.fileNodes.get(normalizedFile);
	const lineCount = fileNodeId
		? graph.nodes.get(fileNodeId)?.metadata?.lineCount
		: undefined;
	const limit =
		typeof lineCount === "number" && lineCount > 0
			? lineCount
			: BLAST_RADIUS_DEFAULT_READ_LIMIT;
	// Machine field keeps the absolute (slash-normalized) path so the host's Read
	// resolves it unambiguously — same convention as ModuleSymbolEntry.read.
	return { path: normalizedFile, offset: 1, limit };
}

// Cross-file blast radius (#304): the transitive dependents of this module,
// aggregated from symbol-level impact hits to ranked FILE reads — "if you change
// this module, read/verify these files". Read-only over the CACHED graph the
// caller already loaded (never builds; the caller gates on a warm graph), so it
// shares module_report's #256 no-build contract. Returns undefined when nothing
// depends on the module (no section to show).
async function computeBlastRadius(
	graph: ReviewGraph,
	normalizedPath: string,
	projectRoot: string,
	maxDepth: number,
): Promise<BlastRadius | undefined> {
	const { computeTransitiveImpact } = await import("./review-graph/query.js");
	const result = computeTransitiveImpact(graph, normalizedPath, { maxDepth });
	const byFile = new Map<
		string,
		{
			dependents: number;
			minDepth: number;
			relations: Set<ReviewGraphEdgeKind>;
		}
	>();
	for (const hit of result.hits) {
		if (!hit.file) continue;
		const key = normalizeMapKey(hit.file);
		if (key === normalizedPath) continue; // never list the module itself
		const cur = byFile.get(key) ?? {
			dependents: 0,
			minDepth: Number.POSITIVE_INFINITY,
			relations: new Set<ReviewGraphEdgeKind>(),
		};
		cur.dependents += 1;
		cur.minDepth = Math.min(cur.minDepth, hit.depth);
		cur.relations.add(hit.relation);
		byFile.set(key, cur);
	}
	if (byFile.size === 0) return undefined;
	const files: BlastRadiusFile[] = [...byFile.entries()]
		.map(([key, v]) => ({
			file: toDisplayPath(key, projectRoot),
			dependents: v.dependents,
			minDepth: v.minDepth,
			relations: [...v.relations].sort((a, b) => a.localeCompare(b)),
			read: blastReadArgs(graph, key),
		}))
		// Closest hop first, then most-depended-on, then stable by path.
		.sort(
			(a, b) =>
				a.minDepth - b.minDepth ||
				b.dependents - a.dependents ||
				a.file.localeCompare(b.file),
		)
		.slice(0, BLAST_RADIUS_FILE_CAP);
	return {
		truncated: result.truncated,
		maxDepth: result.maxDepthReached,
		files,
	};
}

function nodeLine(node: ModuleReportNode): number {
	return node.startPosition.row + 1;
}

function nodeEndLine(node: ModuleReportNode): number {
	return node.endPosition.row + 1;
}

function firstLine(text: string): string {
	return text.split(/\r?\n/, 1)[0]?.trim() ?? "";
}

type CallbackOwner = Pick<ModuleSymbolEntry, "name" | "startLine" | "endLine">;

function findNearestSymbolName(
	entries: CallbackOwner[],
	startLine: number,
	endLine: number,
): string | undefined {
	let best: CallbackOwner | undefined;
	for (const entry of entries) {
		if (entry.startLine > startLine || entry.endLine < endLine) continue;
		if (
			!best ||
			entry.endLine - entry.startLine < best.endLine - best.startLine
		) {
			best = entry;
		}
	}
	return best?.name;
}

const INLINE_EXECUTABLE_NODE_KINDS = new Set([
	// JavaScript / TypeScript
	"arrow_function",
	"function_expression",
	// Python
	"lambda",
	// Go
	"func_literal",
	// Rust
	"closure_expression",
	// Swift / Kotlin (trailing/lambda closures)
	"lambda_literal",
	// Other grammars use one of these for lambdas/anonymous functions.
	"lambda_expression",
	"anonymous_function",
]);

const ARGUMENT_CONTAINER_NODE_KINDS = new Set([
	"arguments",
	"argument_list",
	"argument_list_expression",
]);

// Call-node kinds across grammars: JS/TS/Rust use `call_expression`; Python and
// Ruby use a bare `call`. Accepting both lets the per-language callback rules see
// the enclosing call name (e.g. `loop.call_later`) regardless of grammar.
const CALL_NODE_KINDS = new Set(["call_expression", "call"]);

function callNameForCallback(node: ModuleReportNode): string | undefined {
	const parent = node.parent;
	const call = ARGUMENT_CONTAINER_NODE_KINDS.has(parent?.type ?? "")
		? parent?.parent
		: CALL_NODE_KINDS.has(parent?.type ?? "")
			? parent
			: undefined;
	if (!call || !CALL_NODE_KINDS.has(call.type)) return undefined;
	const callee = call.children.find(
		(child) => !ARGUMENT_CONTAINER_NODE_KINDS.has(child.type),
	);
	return callee?.text;
}

function eventNameForCallback(node: ModuleReportNode): string | undefined {
	const args = node.parent;
	if (args?.type !== "arguments") return undefined;
	const first = args.children.find(
		(child) => child.type === "string" && nodeLine(child) <= nodeLine(node),
	);
	return first?.text;
}

function propertyNameForCallback(node: ModuleReportNode): string | undefined {
	const parent = node.parent;
	if (parent?.type !== "pair" && parent?.type !== "key_value_pair") {
		return undefined;
	}
	const key = parent.children.find((child) => child !== node);
	return key?.text;
}

function assignedNameForCallback(node: ModuleReportNode): string | undefined {
	const parent = node.parent;
	if (!parent) return undefined;
	if (
		parent.type === "let_declaration" ||
		parent.type === "variable_declarator"
	) {
		return parent.children.find((child) => child.type === "identifier")?.text;
	}
	if (parent.type === "expression_list") {
		const declaration = parent.parent;
		if (declaration?.type !== "short_var_declaration") return undefined;
		const nameList = declaration.children.find((child) => child !== parent);
		return nameList?.children.find((child) => child.type === "identifier")
			?.text;
	}
	if (parent.type === "assignment") {
		return parent.children.find((child) => child.type === "identifier")?.text;
	}
	return undefined;
}

// ── Callback classification: per-language rule sets ──────────────────────────
// The inline-executable NODE KINDS are language-uniform (above), but the
// SEMANTICS — what role a callback plays, what risk flags it carries, whether
// it is high-signal enough to surface — are language-specific. Each language
// group supplies a rule set; languages without one fall back to the generic
// (JS/TS-tuned) rules. This mirrors how SYMBOL_QUERIES / IMPORT_QUERIES are
// keyed per language, and is the seam for adding more languages incrementally
// (one guarded vertical slice at a time).

type CallbackContext = {
	node: ModuleReportNode;
	callName: string | undefined;
	eventName: string | undefined;
	propertyName: string | undefined;
	assignedName: string | undefined;
};

type CallbackClassification = {
	kind: string;
	flags?: string[];
	include: boolean;
	/** Optional name base; when absent, extractCallbacks builds one generically. */
	nameBase?: string;
};

type CallbackLanguageRules = {
	classify(
		ctx: CallbackContext,
		owner: string | undefined,
	): CallbackClassification;
};

/** Walk up to `maxHops` ancestors looking for a node of one of `types`. */
function ancestorOfType(
	node: ModuleReportNode,
	types: Set<string>,
	maxHops = 6,
): ModuleReportNode | undefined {
	let current = node.parent;
	let hops = 0;
	while (current && hops < maxHops) {
		if (types.has(current.type)) return current;
		current = current.parent;
		hops += 1;
	}
	return undefined;
}

/** Find the first descendant of `type` within `maxDepth` levels (shallow). */
function descendantOfType(
	node: ModuleReportNode,
	type: string,
	maxDepth = 2,
): ModuleReportNode | undefined {
	if (maxDepth < 0) return undefined;
	for (const child of node.children ?? []) {
		if (child.type === type) return child;
		const found = descendantOfType(child, type, maxDepth - 1);
		if (found) return found;
	}
	return undefined;
}

/**
 * Generic, JS/TS-tuned classification — the historical behavior, now the
 * default rule set for any language without a tuned entry. Kept byte-for-byte
 * equivalent to the previous callbackKind/callbackFlags/shouldIncludeCallback
 * so the refactor is behavior-preserving for every currently-supported language.
 */
function classifyGenericCallback(ctx: CallbackContext): CallbackClassification {
	const { node, callName, propertyName, assignedName } = ctx;
	let kind: string;
	if (
		callName === "setTimeout" ||
		callName === "setInterval" ||
		callName === "setImmediate"
	) {
		kind = "timer_callback";
	} else if (callName === "pi.on" || callName?.endsWith(".on")) {
		kind = "event_handler";
	} else if (
		callName?.endsWith(".then") ||
		callName?.endsWith(".catch") ||
		callName?.endsWith(".finally")
	) {
		kind = "promise_callback";
	} else if (propertyName) {
		kind = "object_property_callback";
	} else if (assignedName) {
		kind = "assigned_callback";
	} else {
		kind = "callback";
	}
	const flags: string[] = [];
	if (node.text.trimStart().startsWith("async")) flags.push("async");
	if (/\bctx\s*\.\s*ui\b/.test(node.text)) flags.push("captures ctx.ui");
	else if (/\bctx\b/.test(node.text)) flags.push("captures ctx");
	if (kind === "timer_callback") flags.push("detached timer");
	if (kind === "event_handler") flags.push("lifecycle");
	const include =
		kind !== "callback" ||
		!!propertyName ||
		!!assignedName ||
		flags.some((flag) => flag.startsWith("captures "));
	return { kind, ...(flags.length > 0 ? { flags } : {}), include };
}

const jstsCallbackRules: CallbackLanguageRules = {
	classify: (ctx) => classifyGenericCallback(ctx),
};

// Go: goroutines (`go func() {…}()`) and deferred closures (`defer func() {…}()`)
// are the high-signal lifecycle constructs the generic rules DROP (they land as
// a bare "callback"). Detect them structurally via the enclosing go_statement /
// defer_statement — unambiguous node kinds, no call-name heuristics. Anything
// else (assigned closures etc.) delegates to the generic rules unchanged.
const GO_GOROUTINE_KINDS = new Set(["go_statement"]);
const GO_DEFER_KINDS = new Set(["defer_statement"]);

const goCallbackRules: CallbackLanguageRules = {
	classify(ctx, owner) {
		if (ancestorOfType(ctx.node, GO_GOROUTINE_KINDS, 3)) {
			return {
				kind: "goroutine",
				flags: ["goroutine"],
				include: true,
				nameBase: owner ? `${owner}.goroutine` : "goroutine",
			};
		}
		if (ancestorOfType(ctx.node, GO_DEFER_KINDS, 3)) {
			return {
				kind: "deferred_callback",
				flags: ["deferred"],
				include: true,
				nameBase: owner ? `${owner}.defer` : "defer",
			};
		}
		return classifyGenericCallback(ctx);
	},
};

/** Append a flag without duplicating it; tolerates an undefined start list. */
function withFlag(flags: string[] | undefined, flag: string): string[] {
	const next = flags ? [...flags] : [];
	if (!next.includes(flag)) next.push(flag);
	return next;
}

// Python: lambdas handed to schedulers/futures are the lifecycle-sensitive
// inline executables the generic rules drop (a bare-arg lambda lands as
// "callback"). Classify by the enclosing call name — now visible via the `call`
// node kind. Python has no `async` lambdas, so no async boundary to add here.
const pythonCallbackRules: CallbackLanguageRules = {
	classify(ctx) {
		const base = classifyGenericCallback(ctx);
		const callName = ctx.callName ?? "";
		if (
			/(?:^|\.)(?:call_later|call_soon|call_at)$/.test(callName) ||
			/(?:^|\.)Timer$/.test(callName)
		) {
			return {
				kind: "timer_callback",
				flags: withFlag(base.flags, "detached timer"),
				include: true,
			};
		}
		if (/\.add_done_callback$/.test(callName)) {
			return {
				kind: "future_callback",
				flags: withFlag(base.flags, "future completion"),
				include: true,
			};
		}
		return base;
	},
};

// Rust: closures handed to thread/task spawns, and `move` closures (capture by
// value — the classic detached-state shape), are high-signal. `move` is
// structurally certain: the closure text begins with `move` / `async move`.
const rustCallbackRules: CallbackLanguageRules = {
	classify(ctx) {
		const base = classifyGenericCallback(ctx);
		const isMove = /^\s*(?:async\s+)?move\b/.test(ctx.node.text);
		const flags = isMove ? withFlag(base.flags, "move") : base.flags;
		const callName = ctx.callName ?? "";
		if (/(?:^|::|\.)spawn$/.test(callName)) {
			return {
				kind: "task",
				flags: withFlag(flags, "spawned"),
				include: true,
			};
		}
		return {
			...base,
			...(flags ? { flags } : {}),
			include: base.include || isMove,
		};
	},
};

// Swift: the canonical Swift lifecycle bug is a closure that captures `self`
// strongly across an async boundary (retain cycle). The capture list is fully
// structural — `capture_list → capture_list_item → ownership_modifier`
// (weak/unowned) — so weak-vs-strong self capture is detectable with zero
// guessing. A strong self capture is the high-signal one we surface.
const swiftCallbackRules: CallbackLanguageRules = {
	classify(ctx) {
		const base = classifyGenericCallback(ctx);
		const node = ctx.node;
		const captureList = descendantOfType(node, "capture_list", 2);
		let weakSelf = false;
		if (captureList) {
			for (const item of captureList.children ?? []) {
				if (item.type !== "capture_list_item") continue;
				const own = item.children?.find((c) => c.type === "ownership_modifier");
				if (own && /\bself\b/.test(item.text)) weakSelf = true;
			}
		}
		const refsSelf = /\bself\b/.test(node.text);
		let flags = base.flags;
		let include = base.include;
		if (weakSelf) {
			flags = withFlag(flags, "weak self");
			include = true;
		} else if (refsSelf) {
			flags = withFlag(flags, "captures self");
			include = true;
		}
		return { ...base, ...(flags ? { flags } : {}), include };
	},
};

// C++: a lambda with a by-reference default capture (`[&]`) can dangle once the
// enclosing scope returns — the classic async/thread bug. Capture mode is
// structural (`lambda_capture_specifier → lambda_default_capture`). Also flag
// std::thread / std::async launches.
const cppCallbackRules: CallbackLanguageRules = {
	classify(ctx) {
		const base = classifyGenericCallback(ctx);
		const capture = descendantOfType(ctx.node, "lambda_capture_specifier", 2);
		let flags = base.flags;
		let byRef = false;
		if (capture) {
			const def = capture.children?.find(
				(c) => c.type === "lambda_default_capture",
			);
			if (def?.text.includes("&")) {
				flags = withFlag(flags, "captures by reference");
				byRef = true;
			}
		}
		const callName = ctx.callName ?? "";
		if (/(?:^|::)(?:thread|async)$/.test(callName)) {
			return {
				kind: "task",
				flags: withFlag(flags, "spawned"),
				include: true,
			};
		}
		return {
			...base,
			...(flags ? { flags } : {}),
			include: base.include || byRef,
		};
	},
};

/** Trailing identifier of a (possibly dotted) callee, e.g. `scope.launch` → `launch`. */
function lastCalleeSegment(text: string | undefined): string {
	const m = String(text ?? "")
		.trim()
		.match(/([A-Za-z_$][\w$]*)\s*$/);
	return m ? m[1] : "";
}

// Kotlin: coroutine builders (`launch`/`async`/`withContext`/`runBlocking`/…)
// are the dominant lifecycle/leak source. The trailing lambda sits under
// `call_expression → call_suffix → annotated_lambda`, so resolve the builder
// name from the enclosing call's callee.
const KOTLIN_COROUTINE_BUILDERS = new Set([
	"launch",
	"async",
	"withContext",
	"runBlocking",
	"coroutineScope",
	"supervisorScope",
]);
const kotlinCallbackRules: CallbackLanguageRules = {
	classify(ctx) {
		const base = classifyGenericCallback(ctx);
		const call = ancestorOfType(ctx.node, new Set(["call_expression"]), 4);
		const callee = call?.children?.find(
			(c) =>
				c.type === "navigation_expression" || c.type === "simple_identifier",
		);
		const name = lastCalleeSegment(callee?.text);
		if (KOTLIN_COROUTINE_BUILDERS.has(name)) {
			return {
				kind: "coroutine",
				flags: withFlag(base.flags, "coroutine"),
				include: true,
				nameBase: name,
			};
		}
		return base;
	},
};

// Java: lambdas handed to `new Thread(...)`, executor `submit`/`execute`/
// `schedule`, or UI/event listeners. Resolve the constructor type or the
// method name from the enclosing invocation.
const JAVA_TASK_METHODS =
	/^(?:submit|execute|schedule|scheduleAtFixedRate|scheduleWithFixedDelay|invokeLater|invokeAndWait)$/;
const JAVA_LISTENER_METHODS =
	/^(?:add\w*Listener|set\w*Listener|subscribe|addCallback|then\w*)$/;
const javaCallbackRules: CallbackLanguageRules = {
	classify(ctx) {
		const base = classifyGenericCallback(ctx);
		const obj = ancestorOfType(
			ctx.node,
			new Set(["object_creation_expression"]),
			3,
		);
		const created = obj?.children?.find((c) => c.type === "type_identifier");
		if (created && /Thread$/.test(created.text)) {
			return {
				kind: "task",
				flags: withFlag(base.flags, "thread"),
				include: true,
				nameBase: `new ${created.text}`,
			};
		}
		const inv = ancestorOfType(ctx.node, new Set(["method_invocation"]), 3);
		if (inv) {
			const named = (inv.children ?? []).filter((c) => c.isNamed);
			const argIdx = named.findIndex((c) => c.type === "argument_list");
			const nameNode = argIdx > 0 ? named[argIdx - 1] : undefined;
			const name = nameNode?.type === "identifier" ? nameNode.text : "";
			if (JAVA_TASK_METHODS.test(name)) {
				return {
					kind: "task",
					flags: withFlag(base.flags, "submitted"),
					include: true,
					nameBase: name,
				};
			}
			if (JAVA_LISTENER_METHODS.test(name)) {
				return {
					kind: "event_handler",
					flags: withFlag(base.flags, "listener"),
					include: true,
					nameBase: name,
				};
			}
		}
		return base;
	},
};

// C#: event subscriptions (`x.Click += (s,e) => …`), `Task.Run`/`StartNew`
// launches, and `async` lambdas. The event case is a lambda whose parent is a
// `+=` assignment.
const csharpCallbackRules: CallbackLanguageRules = {
	classify(ctx) {
		const base = classifyGenericCallback(ctx);
		const parent = ctx.node.parent;
		if (parent?.type === "assignment_expression" && /\+=/.test(parent.text)) {
			return {
				kind: "event_handler",
				flags: withFlag(base.flags, "event +="),
				include: true,
			};
		}
		const inv = ancestorOfType(ctx.node, new Set(["invocation_expression"]), 4);
		if (inv) {
			const callee = inv.children?.find(
				(c) => c.type === "member_access_expression" || c.type === "identifier",
			);
			const name = lastCalleeSegment(callee?.text);
			if (/^(?:Run|StartNew|Start)$/.test(name)) {
				return {
					kind: "task",
					flags: withFlag(base.flags, "task"),
					include: true,
					nameBase: name,
				};
			}
		}
		if (/^\s*async\b/.test(ctx.node.text)) {
			return {
				...base,
				flags: withFlag(base.flags, "async"),
				include: true,
			};
		}
		return base;
	},
};

const CALLBACK_RULES: Record<string, CallbackLanguageRules> = {
	typescript: jstsCallbackRules,
	tsx: jstsCallbackRules,
	javascript: jstsCallbackRules,
	go: goCallbackRules,
	python: pythonCallbackRules,
	rust: rustCallbackRules,
	swift: swiftCallbackRules,
	cpp: cppCallbackRules,
	kotlin: kotlinCallbackRules,
	java: javaCallbackRules,
	csharp: csharpCallbackRules,
};

function callbackRulesFor(
	languageId: string | undefined,
): CallbackLanguageRules {
	return (
		(languageId ? CALLBACK_RULES[languageId] : undefined) ?? jstsCallbackRules
	);
}

/**
 * Whether a language has a TUNED callback rule set (explicit CALLBACK_RULES
 * entry) vs. falling back to the generic JS/TS-shaped heuristics. Drives the
 * report's `callbackSupport` honesty signal.
 */
function callbackSupportFor(
	languageId: string | undefined,
): "tuned" | "generic" {
	return languageId && CALLBACK_RULES[languageId] ? "tuned" : "generic";
}

function extractCallbacks(
	root: ModuleReportNode | undefined,
	entries: CallbackOwner[],
	languageId: string | undefined,
	warnings?: string[],
): ModuleCallbackEntry[] {
	if (!root) return [];
	const rules = callbackRulesFor(languageId);
	const callbacks: ModuleCallbackEntry[] = [];
	const maxDepth = 1000;
	let depthTruncated = false;
	const visit = (node: ModuleReportNode, depth = 0): void => {
		if (depth > maxDepth) {
			depthTruncated = true;
			return;
		}
		if (INLINE_EXECUTABLE_NODE_KINDS.has(node.type)) {
			const startLine = nodeLine(node);
			const endLine = nodeEndLine(node);
			const callName = callNameForCallback(node);
			const eventName = eventNameForCallback(node);
			const propertyName = propertyNameForCallback(node);
			const assignedName = assignedNameForCallback(node);
			const owner = findNearestSymbolName(entries, startLine, endLine);
			const cls = rules.classify(
				{ node, callName, eventName, propertyName, assignedName },
				owner,
			);
			if (cls.include) {
				const base =
					cls.nameBase ??
					(propertyName
						? owner
							? `${owner}.${propertyName}`
							: propertyName
						: assignedName
							? owner
								? `${owner}.${assignedName}`
								: assignedName
							: eventName && callName
								? `${callName}(${eventName})`
								: (callName ?? "callback"));
				callbacks.push({
					name: `${base}@${startLine}`,
					kind: cls.kind,
					rawKind: node.type,
					startLine,
					endLine,
					signature: firstLine(node.text),
					...(owner ? { parentChain: [owner] } : {}),
					...(cls.flags ? { flags: cls.flags } : {}),
				});
			}
		}
		for (const child of node.children ?? []) visit(child, depth + 1);
	};
	visit(root);
	if (depthTruncated) {
		warnings?.push(`Callback extraction stopped at AST depth ${maxDepth}`);
	}
	const callbackCap = 25;
	if (callbacks.length > callbackCap) {
		warnings?.push(
			`Callback list truncated to ${callbackCap} of ${callbacks.length} entries`,
		);
	}
	return callbacks.slice(0, callbackCap);
}

function unavailableReport(displayPath: string, error?: string): ModuleReport {
	return {
		available: false,
		staleness: "unavailable",
		path: displayPath,
		...(error ? { error } : {}),
		summary: { imports: 0, exports: 0, symbols: 0 },
		imports: { external: [], internal: [] },
		api: [],
		internal: [],
		callbacks: [],
		recommendedReads: [],
		semantic: { source: "none", references: false, implementations: false },
	};
}

/**
 * Build a structured report for a single module. Read-only, single mode (#256):
 * tree-sitter extract + 3-tier-cached review graph (who-uses-this, imports,
 * complexity/fanout) + callback extraction. This path never calls LSP; LSP-derived
 * relationships must be written into the cached graph ahead of time (#236) and are
 * then read here as graph data. Each tier degrades independently, so a cold graph
 * never aborts the report — it just narrows what's populated.
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

	const {
		symbols: extracted,
		imports: extractedImports,
		root,
		error: extractionError,
		warnings: extractionWarnings,
	} = languageId
		? await extractFile(absPath, languageId, content)
		: {
				symbols: [],
				imports: [],
				root: undefined,
				error: undefined,
				warnings: undefined,
			};
	if (extractionError) {
		return unavailableReport(toDisplayPath(absPath, cwd), extractionError);
	}

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
		toEntry(sym, normalizedPath, graph, maxRefs, cwd),
	);
	const topLevel = nestEntries(entries);

	// Middle-man / delegate-only class detection (#325): a whole-class judgment
	// over the now-nested members[], so it must run AFTER nestEntries. Mutates
	// `entries` in place (topLevel/api/internal hold the same object references).
	annotateMiddleMan(entries, content, languageId);

	const api = topLevel.filter((entry) => entry.exported);
	const internal = topLevel.filter((entry) => !entry.exported);
	let callbacks: ModuleCallbackEntry[] = [];
	const warnings: string[] = [...(extractionWarnings ?? [])];
	try {
		callbacks = extractCallbacks(root, entries, languageId, warnings);
	} catch (err) {
		const message = diagnosticMessage(err);
		warnings.push(`Failed to extract callbacks: ${message}`);
		logLatency({
			type: "phase",
			phase: "module_report_callback_extract_error",
			filePath: absPath,
			durationMs: 0,
			metadata: { error: message },
		});
	}

	// Imports: the warm review graph is source-of-truth; on a cold cache (or a
	// graph without this file's node) fall back to the language-uniform tree-sitter
	// resolution (#301) so a cold report no longer shows zero imports.
	const warmImports = graph
		? collectImports(graph, normalizedPath, cwd)
		: { external: [], internal: [] };
	const coldImportResult =
		warmImports.external.length + warmImports.internal.length > 0 || !languageId
			? undefined
			: coldImports(extractedImports, languageId, absPath, cwd);
	if (coldImportResult?.warnings.length)
		warnings.push(...coldImportResult.warnings);
	const imports = coldImportResult
		? {
				external: coldImportResult.external,
				internal: coldImportResult.internal,
			}
		: warmImports;

	const hasGraphNode = graph?.fileNodes.has(normalizedPath) ?? false;

	// #511: distinguish two very different reasons `usedBy`/`semantic` degrade to
	// "none". A graph that doesn't exist at all (`!graph`) is an honest, expected
	// cold start — the edit pipeline hasn't warmed this workspace yet. But a graph
	// that DOES exist and just doesn't have a node for THIS file (e.g. the file was
	// added/renamed after the graph was last persisted) is silently
	// indistinguishable from "no who-uses-this data exists" unless we say so. Make
	// the second case actionable: a rebuild (pilens_rebuild) would populate it.
	if (graph && !hasGraphNode) {
		warnings.push(
			"who-uses-this is unavailable for this file: the cached review graph " +
				"exists but has no node for it (likely added/changed after the graph " +
				"was last built). Run pilens_rebuild to refresh it.",
		);
	}

	// Cross-file blast radius (#304): opt-in, read-only over the CACHED graph. Only
	// computed when requested AND the file is in a warm graph — a cold cache omits
	// the section entirely (never builds, same #256 contract as the rest of this
	// path). Aggregated to file reads; undefined when nothing depends on the module.
	const blastRadius =
		options?.blastRadius && graph && hasGraphNode
			? await computeBlastRadius(
					graph,
					normalizedPath,
					cwd,
					Math.max(1, options.blastRadiusDepth ?? 3),
				)
			: undefined;

	const view = options?.view ?? "default";
	const summaryView = view === "summary";
	// "compact" computes the same full data as "default" — it's a rendering
	// instruction for the caller (renderCompactModuleReport), not a data tier —
	// so it only needs to echo back on the report; it never gates section content
	// the way summaryView does.
	const compactView = view === "compact";
	let importsProvenance: NonNullable<ModuleReport["provenance"]>["imports"] = "none";
	if (coldImportResult) {
		importsProvenance = "syntax";
	} else if (graph) {
		importsProvenance = "cached-review-graph";
	}
	const blastRadiusProvenance = blastRadius ? "cached-review-graph" : "none";
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
		...(warnings.length > 0 ? { warnings } : {}),
		api: summaryView ? summarizeEntries(api) : api,
		internal: summaryView ? summarizeEntries(internal) : internal,
		callbacks: summaryView ? [] : callbacks,
		callbackSupport: callbackSupportFor(languageId),
		recommendedReads: rankRecommendedReads(
			entries,
			callbacks,
			5,
			options?.focus,
		),
		...(summaryView ? { view: "summary" } : {}),
		...(compactView ? { view: "compact" } : {}),
		...(blastRadius && !summaryView ? { blastRadius } : {}),
		...(graph ? { graphBuiltAt: graph.builtAt } : {}),
		provenance: {
			symbols: languageId ? "syntax" : "none",
			imports: importsProvenance,
			usedBy: hasGraphNode ? "cached-review-graph" : "none",
			callbacks: languageId && !summaryView ? "heuristic-tree-sitter" : "none",
			...(options?.blastRadius
				? { blastRadius: blastRadiusProvenance }
				: {}),
		},
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

// --- Compact (line-oriented text) rendering (#512 slice 4) ------------------
//
// An opt-in `view: "compact"` alternative to the JSON report: one line per
// symbol/callback instead of a repeated-keys JSON object, at roughly a quarter
// of the token cost for the same information. Purely a rendering step over the
// already-built ModuleReport — it changes no data, only presentation, so a
// caller that wants JSON just skips this function. Default view stays JSON
// (this is opt-in for dogfooding, not a default flip).

function padRange(startLine: number, endLine: number, width: number): string {
	return `${startLine}-${endLine}`.padEnd(width);
}

const KIND_ABBREV: Record<string, string> = {
	function: "fn",
	method: "fn",
	class: "class",
	interface: "iface",
	type: "type",
	variable: "var",
	property: "prop",
};

function compactKind(kind: string): string {
	return KIND_ABBREV[kind] ?? kind;
}

function compactUsedBySuffix(usedBy: ModuleSymbolUsedBy[] | undefined): string {
	if (!usedBy || usedBy.length === 0) return "";
	const counts = new Map<string, number>();
	for (const u of usedBy) counts.set(u.file, (counts.get(u.file) ?? 0) + 1);
	const parts = [...counts.entries()].map(([file, n]) =>
		n > 1 ? `${file}×${n}` : file,
	);
	return `  used-by: ${parts.join(", ")}`;
}

function compactEntryLine(entry: ModuleSymbolEntry, width: number): string {
	const range = padRange(entry.startLine, entry.endLine, width);
	const kind = compactKind(entry.kind).padEnd(6);
	const sig = entry.signature ? `${entry.name}${entry.signature}` : entry.name;
	const flagsSuffix =
		entry.flags && entry.flags.length > 0 ? `  [${entry.flags.join(", ")}]` : "";
	const docSuffix = entry.doc ? `  — ${entry.doc}` : "";
	const usedBySuffix = compactUsedBySuffix(entry.usedBy);
	return `  ${range}${kind}${sig}${flagsSuffix}${usedBySuffix}${docSuffix}`;
}

function compactMemberLines(
	entry: ModuleSymbolEntry,
	width: number,
	indent: string,
): string[] {
	if (!entry.members || entry.members.length === 0) return [];
	return entry.members.map((m) => `${indent}${compactEntryLine(m, width).slice(2)}`);
}

function compactCallbackLine(callback: ModuleCallbackEntry, width: number): string {
	const range = padRange(callback.startLine, callback.endLine, width);
	const kind = callback.kind.padEnd(20);
	const flagsSuffix =
		callback.flags && callback.flags.length > 0
			? `  [${callback.flags.join(", ")}]`
			: "";
	const ownerSuffix = callback.parentChain?.length
		? `  (in ${callback.parentChain.join(".")})`
		: "";
	return `  ${range}${kind}${callback.name}${flagsSuffix}${ownerSuffix}`;
}

/**
 * Render a ModuleReport as the line-oriented compact text view (#512 slice 4):
 * one line per symbol/member/callback instead of a JSON object per entry.
 * Example:
 * ```
 * clients/agent-nudge.ts jsts 266L — 8 symbols, 5 exported | imports: bus-publish, latency-logger
 * API:
 *   77-81    fn  _resetAgentNudgeForTests()  — Test-only: clear accumulator state.
 * INTERNAL:
 *   95-104   fn  isValidPayload(data: unknown)
 * CALLBACKS:
 *   164-172  event_handler  events.on@164  [lifecycle]  (in wireAgentNudgeSubscriber)
 * ```
 * Purely presentational over an already-built report — call `moduleReport`
 * first (with `view: "compact"` or any other view) and pass its result here.
 */
export function renderCompactModuleReport(report: ModuleReport): string {
	if (!report.available) {
		return `${report.path} — unavailable${report.error ? `: ${report.error}` : ""}`;
	}
	const allEntries = [...report.api, ...report.internal];
	const allRanges = allEntries.flatMap((e) => [
		e,
		...(e.members ?? []),
	]);
	const width =
		Math.max(
			5,
			...allRanges.map((e) => `${e.startLine}-${e.endLine}`.length),
			...report.callbacks.map((c) => `${c.startLine}-${c.endLine}`.length),
		) + 2;

	const importsList = [...report.imports.internal, ...report.imports.external];
	const importsSuffix =
		importsList.length > 0
			? ` | imports: ${importsList
					.slice(0, 6)
					.map((i) => baseNameNoExt(i))
					.join(", ")}${importsList.length > 6 ? ", …" : ""}`
			: "";
	const lines: string[] = [
		`${report.path} ${report.language ?? "?"} ${report.lineCount ?? "?"}L — ` +
			`${report.summary.symbols} symbols, ${report.summary.exports} exported${importsSuffix}`,
	];

	if (report.api.length > 0) {
		lines.push("API:");
		for (const entry of report.api) {
			lines.push(compactEntryLine(entry, width));
			lines.push(...compactMemberLines(entry, width, "    "));
		}
	}
	if (report.internal.length > 0) {
		lines.push("INTERNAL:");
		for (const entry of report.internal) {
			lines.push(compactEntryLine(entry, width));
			lines.push(...compactMemberLines(entry, width, "    "));
		}
	}
	if (report.callbacks.length > 0) {
		lines.push("CALLBACKS:");
		for (const callback of report.callbacks) {
			lines.push(compactCallbackLine(callback, width));
		}
	}
	if (report.recommendedReads.length > 0) {
		lines.push("RECOMMENDED:");
		for (const r of report.recommendedReads) {
			lines.push(
				`  ${padRange(r.startLine, r.endLine, width)}${r.symbol ?? ""}  — ${r.reason}`,
			);
		}
	}
	return lines.join("\n");
}

function baseNameNoExt(p: string): string {
	const base = p.split(/[\\/]/).pop() ?? p;
	return base.replace(/\.[^./\\]+$/, "");
}

// ── readSymbol lookup helpers (#523) ──────────────────────────────────────────

interface SymbolSelection {
	match?: ExtractedSymbol;
	ambiguous?: { count: number; kinds: string[] };
}

// Duplicate-name disambiguation (#523 item 4). `candidates` is every symbol
// already known to share the requested name; when `kind` is given it narrows
// first, else the historical "first match" (source order) wins — unchanged
// behavior for the common (unambiguous) case. `ambiguous` is populated only
// when the CHOSEN pool still has more than one entry, so a kind that uniquely
// resolves the collision reports no ambiguity.
function selectMatch(
	candidates: ExtractedSymbol[],
	kind: string | undefined,
): SymbolSelection {
	if (candidates.length === 0) return {};
	const filtered = kind ? candidates.filter((c) => c.kind === kind) : candidates;
	const pool = filtered.length > 0 ? filtered : candidates;
	const match = pool[0];
	if (pool.length <= 1) return { match };
	return {
		match,
		ambiguous: {
			count: pool.length,
			kinds: [...new Set(pool.map((c) => c.kind))],
		},
	};
}

// `Class.method` qualification (#523 item 3). Members are located by line-range
// containment within the named parent — the same shape module-report's
// `nestEntries` uses for the outline, computed directly here over the flat
// extractor list (readSymbol never builds the nested outline). Returns
// undefined (NOT a miss) when the qualifier doesn't resolve to a known parent —
// the caller then falls through to the plain unqualified lookup using the full
// dotted string, which naturally misses and feeds the did-you-mean path below
// rather than crashing.
function resolveQualifiedMatch(
	symbols: ExtractedSymbol[],
	qualifiedName: string,
	kind: string | undefined,
): SymbolSelection | undefined {
	const dotIdx = qualifiedName.lastIndexOf(".");
	if (dotIdx <= 0 || dotIdx === qualifiedName.length - 1) return undefined;
	const parentName = qualifiedName.slice(0, dotIdx);
	const memberName = qualifiedName.slice(dotIdx + 1);
	const parent = symbols.find((candidate) => candidate.name === parentName);
	if (!parent) return undefined;
	const parentStart = parent.line;
	const parentEnd = parent.endLine ?? parent.line;
	const members = symbols.filter(
		(candidate) =>
			candidate !== parent &&
			candidate.name === memberName &&
			candidate.line >= parentStart &&
			(candidate.endLine ?? candidate.line) <= parentEnd,
	);
	if (members.length === 0) return undefined;
	return selectMatch(members, kind);
}

// Did-you-mean on miss (#523 item 2). A small, focused Levenshtein distance —
// NOT a reuse of read-guard-tool-lines.ts's `findSimilarLines`/`tokenSimilarity`.
// That function does Jaccard similarity over whitespace-tokenized LINE CONTENT
// (built for relocated-block suggestions across a window of file lines); a
// single identifier is one token to it, so "isAgentNudgeEnable" vs
// "isAgentNudgeEnabled" scores 0 (disjoint token sets) despite being a
// one-character typo. Symbol-name matching needs character-level edit distance
// instead, so this is a small dedicated implementation rather than a forced
// reuse. No existing levenshtein/editDistance utility was found elsewhere in
// the codebase (checked clients/read-guard-tool-lines.ts and clients/dispatch/
// dispatcher.ts, the only other "similarity" hits).
function levenshteinDistance(a: string, b: string): number {
	const al = a.length;
	const bl = b.length;
	if (al === 0) return bl;
	if (bl === 0) return al;
	let prev = new Array<number>(bl + 1);
	let curr = new Array<number>(bl + 1);
	for (let j = 0; j <= bl; j++) prev[j] = j;
	for (let i = 1; i <= al; i++) {
		curr[0] = i;
		for (let j = 1; j <= bl; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
		}
		[prev, curr] = [curr, prev];
	}
	return prev[bl];
}

// Normalized similarity in [0, 1]; 1 = identical (case-insensitive).
function nameSimilarity(a: string, b: string): number {
	const maxLen = Math.max(a.length, b.length);
	if (maxLen === 0) return 1;
	return 1 - levenshteinDistance(a.toLowerCase(), b.toLowerCase()) / maxLen;
}

// Threshold chosen so a plausible typo/near-miss (one-two edits on a
// medium-length identifier, e.g. "isAgentNudgeEnable" -> "isAgentNudgeEnabled",
// score ~0.95) clears it while a wildly-wrong name (near-zero character
// overlap) doesn't — avoids suggesting misleading names on a genuine miss.
const SIMILAR_NAME_MIN_SCORE = 0.45;
const SIMILAR_NAME_MAX_SUGGESTIONS = 3;

function suggestSimilarNames(candidates: string[], target: string): string[] {
	const unique = [...new Set(candidates)].filter((name) => name !== target);
	return unique
		.map((name) => ({ name, score: nameSimilarity(target, name) }))
		.filter((entry) => entry.score >= SIMILAR_NAME_MIN_SCORE)
		.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
		.slice(0, SIMILAR_NAME_MAX_SUGGESTIONS)
		.map((entry) => entry.name);
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
	options: ReadSymbolOptions = {},
): Promise<ReadSymbolResult> {
	const { kind: symbolKindFilter } = options;
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

	const {
		symbols,
		root,
		error: extractionError,
		warnings: extractionWarnings,
	} = await extractFile(absPath, languageId, content);
	if (extractionError) {
		log(false);
		return {
			found: false,
			path: absPath,
			name: symbolName,
			error: extractionError,
		};
	}
	const lines = content.split(/\r?\n/);

	// #523 item 3: a dotted name tries the qualified (Class.method) lookup
	// first; a hit there wins outright. Otherwise fall through to the plain
	// unqualified lookup using the FULL requested name (so an unresolved
	// qualifier or a non-dotted name both flow through the same miss/did-you-
	// mean path below rather than a separate branch).
	const qualified = resolveQualifiedMatch(symbols, symbolName, symbolKindFilter);
	const unqualifiedMatches = symbols.filter(
		(candidate) => candidate.name === symbolName,
	);
	const selection = qualified ?? selectMatch(unqualifiedMatches, symbolKindFilter);

	if (selection.match) {
		const sym = selection.match;
		// #523 item 1: extend the returned range (and thus the read-guard
		// coverage recorded for it — see tools/module-report.ts's
		// recordReadCoverage) to include an attached doc comment, when one
		// exists. `docStartLine` is the SAME position-based, blank-line-gap-aware
		// attachment computation the outline's `doc` summary already uses (#517's
		// extractDocCommentInfo) — no re-derivation here, just reusing the line
		// it already computed.
		const startLine = sym.docStartLine ?? sym.line;
		const endLine = sym.endLine ?? sym.line;
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
			...(selection.ambiguous ? { ambiguous: selection.ambiguous } : {}),
		};
	}

	const owners = symbols
		.filter((candidate) => !candidate.local)
		.map((candidate) => ({
			name: candidate.name,
			startLine: candidate.line,
			endLine: candidate.endLine ?? candidate.line,
		}));
	let allCallbacks: ModuleCallbackEntry[];
	const callbackWarnings = [...(extractionWarnings ?? [])];
	try {
		allCallbacks = extractCallbacks(root, owners, languageId, callbackWarnings);
	} catch (err) {
		const message = `Callback extraction failed: ${diagnosticMessage(err)}`;
		logLatency({
			type: "phase",
			phase: "read_symbol_callback_extract_error",
			filePath: absPath,
			durationMs: Date.now() - startedAt,
			metadata: { symbol: symbolName, error: message },
		});
		log(false);
		return { found: false, path: absPath, name: symbolName, error: message };
	}
	const callback = allCallbacks.find(
		(candidate) => candidate.name === symbolName,
	);
	if (!callback) {
		log(false);
		// #523 item 2: embed the ~3 nearest symbol/callback names directly in the
		// miss response so the caller can self-correct without a module_report
		// round-trip. Non-local symbols only — locals aren't reachable by name
		// from outside their enclosing scope, so suggesting one would send the
		// caller to a dead end.
		const corpus = [
			...symbols.filter((candidate) => !candidate.local).map((c) => c.name),
			...allCallbacks.map((c) => c.name),
		];
		const suggestions = suggestSimilarNames(corpus, symbolName);
		return {
			found: false,
			path: absPath,
			name: symbolName,
			...(callbackWarnings.length > 0 ? { warnings: callbackWarnings } : {}),
			...(suggestions.length > 0 ? { suggestions } : {}),
		};
	}
	const source = lines
		.slice(callback.startLine - 1, callback.endLine)
		.join("\n");
	log(true);
	return {
		found: true,
		path: absPath,
		name: callback.name,
		kind: callback.kind,
		startLine: callback.startLine,
		endLine: callback.endLine,
		signature: callback.signature,
		source,
	};
}

type EnclosingCandidate = {
	name: string;
	kind: string;
	startLine: number;
	endLine: number;
	signature?: string;
	parentChain?: string[];
	priority: number;
};

function symbolMatchesKind(kind: string, filters: Set<string>): boolean {
	if (filters.size === 0) return true;
	const normalized = kind.toLowerCase();
	if (filters.has(normalized)) return true;
	if (filters.has("function") && normalized.includes("function")) return true;
	if (filters.has("method") && normalized.includes("method")) return true;
	if (
		filters.has("type") &&
		["class", "interface", "struct", "enum", "trait", "type"].includes(
			normalized,
		)
	) {
		return true;
	}
	return false;
}

function callbackMatchesKind(kind: string, filters: Set<string>): boolean {
	if (filters.size === 0) return true;
	const normalized = kind.toLowerCase();
	return (
		filters.has(normalized) ||
		filters.has("callback") ||
		filters.has("closure") ||
		filters.has("lambda") ||
		(normalized.includes("callback") && filters.has("function"))
	);
}

function symbolParentChain(
	symbol: ExtractedSymbol,
	symbols: ExtractedSymbol[],
): string[] | undefined {
	const chain = symbols
		.filter((candidate) => {
			if (candidate === symbol) return false;
			const start = candidate.line;
			const end = candidate.endLine ?? candidate.line;
			const symEnd = symbol.endLine ?? symbol.line;
			return (
				start <= symbol.line &&
				end >= symEnd &&
				end - start > symEnd - symbol.line
			);
		})
		.sort(
			(a, b) =>
				a.line - b.line ||
				(b.endLine ?? b.line) - b.line - ((a.endLine ?? a.line) - a.line),
		)
		.map((candidate) => candidate.name);
	return chain.length > 0 ? chain : undefined;
}

function clampSliceRange(
	targetLine: number,
	startLine: number,
	endLine: number,
	limit: number,
): { startLine: number; endLine: number } {
	const boundedLimit = Math.max(1, Math.min(endLine - startLine + 1, limit));
	let sliceStart = targetLine - Math.floor(boundedLimit / 2);
	sliceStart = Math.max(
		startLine,
		Math.min(sliceStart, endLine - boundedLimit + 1),
	);
	return { startLine: sliceStart, endLine: sliceStart + boundedLimit - 1 };
}

function enclosingOutline(
	selected: EnclosingCandidate,
	symbols: ExtractedSymbol[],
	callbacks: ModuleCallbackEntry[],
	filters: Set<string>,
	filePath: string,
): ReadEnclosingOutlineItem[] {
	const items: ReadEnclosingOutlineItem[] = [];
	for (const sym of symbols) {
		const startLine = sym.line;
		const endLine = sym.endLine ?? sym.line;
		if (startLine === selected.startLine && endLine === selected.endLine)
			continue;
		if (startLine < selected.startLine || endLine > selected.endLine) continue;
		if (!symbolMatchesKind(sym.kind, filters)) continue;
		items.push({
			name: sym.name,
			kind: sym.kind,
			startLine,
			endLine,
			signature: sym.signature,
			parentChain: symbolParentChain(sym, symbols),
			read: readArgsFor(filePath, startLine, endLine),
		});
	}
	for (const callback of callbacks) {
		if (
			callback.startLine < selected.startLine ||
			callback.endLine > selected.endLine
		)
			continue;
		if (!callbackMatchesKind(callback.kind, filters)) continue;
		items.push({
			name: callback.name,
			kind: callback.kind,
			startLine: callback.startLine,
			endLine: callback.endLine,
			signature: callback.signature,
			parentChain: callback.parentChain,
			read: readArgsFor(filePath, callback.startLine, callback.endLine),
		});
	}
	return items
		.sort(
			(a, b) =>
				a.startLine - b.startLine ||
				a.endLine - a.startLine - (b.endLine - b.startLine),
		)
		.slice(0, 25);
}

/**
 * Read the smallest useful symbol/callback enclosing a source line. This is the
 * search/diagnostic → exact-body bridge: single-file tree-sitter only, no graph,
 * no LSP, and the returned range is concrete read-guard coverage.
 */
export async function readEnclosing(
	file: string,
	line: number,
	cwd: string,
	options?: ReadEnclosingOptions,
): Promise<ReadEnclosingResult> {
	const startedAt = Date.now();
	const absPath = path.resolve(cwd, file);
	const targetLine = Math.max(1, Math.floor(line));
	const log = (found: boolean): void => {
		logLatency({
			type: "phase",
			phase: "read_enclosing",
			filePath: absPath,
			durationMs: Date.now() - startedAt,
			metadata: { line: targetLine, found },
		});
	};

	let content: string;
	try {
		content = fs.readFileSync(absPath, "utf-8");
	} catch {
		log(false);
		return { found: false, path: absPath, line: targetLine };
	}

	const kind = detectFileKind(absPath);
	const languageId = tsLangForFile(absPath, kind);
	if (!languageId) {
		log(false);
		return { found: false, path: absPath, line: targetLine };
	}

	const {
		symbols,
		root,
		error: extractionError,
		warnings: extractionWarnings,
	} = await extractFile(absPath, languageId, content);
	if (extractionError) {
		log(false);
		return {
			found: false,
			path: absPath,
			line: targetLine,
			error: extractionError,
		};
	}

	const filters = new Set(
		(options?.kinds ?? []).map((value) => value.toLowerCase()),
	);
	const owners = symbols
		.filter((candidate) => !candidate.local)
		.map((candidate) => ({
			name: candidate.name,
			startLine: candidate.line,
			endLine: candidate.endLine ?? candidate.line,
		}));
	const warnings = [...(extractionWarnings ?? [])];
	let callbacks: ModuleCallbackEntry[] = [];
	try {
		callbacks = extractCallbacks(root, owners, languageId, warnings);
	} catch (err) {
		const message = `Callback extraction failed: ${diagnosticMessage(err)}`;
		warnings.push(message);
		logLatency({
			type: "phase",
			phase: "read_enclosing_callback_extract_error",
			filePath: absPath,
			durationMs: Date.now() - startedAt,
			metadata: { line: targetLine, error: message },
		});
	}

	const candidates: EnclosingCandidate[] = [];
	for (const sym of symbols.filter((candidate) => !candidate.local)) {
		const startLine = sym.line;
		const endLine = sym.endLine ?? sym.line;
		if (targetLine < startLine || targetLine > endLine) continue;
		if (!symbolMatchesKind(sym.kind, filters)) continue;
		candidates.push({
			name: sym.name,
			kind: sym.kind,
			startLine,
			endLine,
			signature: sym.signature,
			parentChain: symbolParentChain(sym, symbols),
			priority: 1,
		});
	}
	for (const callback of callbacks) {
		if (targetLine < callback.startLine || targetLine > callback.endLine)
			continue;
		if (!callbackMatchesKind(callback.kind, filters)) continue;
		candidates.push({
			name: callback.name,
			kind: callback.kind,
			startLine: callback.startLine,
			endLine: callback.endLine,
			signature: callback.signature,
			parentChain: callback.parentChain,
			priority: 0,
		});
	}

	candidates.sort((a, b) => {
		const span = a.endLine - a.startLine - (b.endLine - b.startLine);
		return span || a.priority - b.priority || a.startLine - b.startLine;
	});
	const selected = candidates[0];
	if (!selected) {
		log(false);
		return {
			found: false,
			path: absPath,
			line: targetLine,
			...(warnings.length > 0 ? { warnings } : {}),
		};
	}

	const lines = content.split(/\r?\n/);
	const limit = selected.endLine - selected.startLine + 1;
	if (options?.maxLines && limit > options.maxLines) {
		const oversize = options.onOversize ?? "error";
		const base = {
			path: absPath,
			line: targetLine,
			name: selected.name,
			kind: selected.kind,
			startLine: selected.startLine,
			endLine: selected.endLine,
			signature: selected.signature,
			parentChain: selected.parentChain,
			enclosingStartLine: selected.startLine,
			enclosingEndLine: selected.endLine,
			...(warnings.length > 0 ? { warnings } : {}),
		};
		if (oversize === "slice") {
			const sliceLimit = Math.max(
				1,
				Math.floor(options.aroundLine ?? options.maxLines ?? 80),
			);
			const slice = clampSliceRange(
				targetLine,
				selected.startLine,
				selected.endLine,
				sliceLimit,
			);
			const source = lines.slice(slice.startLine - 1, slice.endLine).join("\n");
			log(true);
			return {
				...base,
				found: true,
				startLine: slice.startLine,
				endLine: slice.endLine,
				partial: true,
				selection: {
					strategy: "oversize-slice",
					source: "tree-sitter",
					confidence: "medium",
				},
				source,
			};
		}
		if (oversize === "outline") {
			log(false);
			return {
				...base,
				found: false,
				selection: {
					strategy: "oversize-outline",
					source: "tree-sitter",
					confidence: "medium",
				},
				outline: enclosingOutline(
					selected,
					symbols,
					callbacks,
					filters,
					absPath,
				),
				error: `Enclosing ${selected.kind} spans ${limit} lines, above maxLines ${options.maxLines}`,
			};
		}
		log(false);
		return {
			...base,
			found: false,
			error: `Enclosing ${selected.kind} spans ${limit} lines, above maxLines ${options.maxLines}`,
		};
	}
	const source = lines
		.slice(selected.startLine - 1, selected.endLine)
		.join("\n");
	log(true);
	return {
		found: true,
		path: absPath,
		line: targetLine,
		name: selected.name,
		kind: selected.kind,
		startLine: selected.startLine,
		endLine: selected.endLine,
		enclosingStartLine: selected.startLine,
		enclosingEndLine: selected.endLine,
		signature: selected.signature,
		parentChain: selected.parentChain,
		selection: {
			strategy: "range-containment",
			source: "tree-sitter",
			confidence: "high",
		},
		...(warnings.length > 0 ? { warnings } : {}),
		source,
	};
}
