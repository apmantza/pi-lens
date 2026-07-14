export type ReviewGraphNodeKind = "file" | "symbol" | "module" | "external";
export type ReviewGraphEdgeKind =
	| "contains"
	| "defines"
	| "imports"
	| "calls"
	| "references";

export interface ReviewGraphNode {
	id: string;
	kind: ReviewGraphNodeKind;
	language: string;
	filePath?: string;
	symbolName?: string;
	symbolKind?: string;
	exported?: boolean;
	metadata?: Record<string, unknown>;
}

export interface ReviewGraphEdge {
	from: string;
	to: string;
	kind: ReviewGraphEdgeKind;
	metadata?: Record<string, unknown>;
	/**
	 * Resolution confidence for a `calls`/`references` edge (refs #655 — narrow
	 * slice of its full `resolution` enum). A callee/reference is initially
	 * matched by bare name only (the extractor sees no import/type info) —
	 * `"name-only"` means it stayed that way: 0 or 2+ same-named candidates
	 * existed graph-wide, so `edge.to` may point at an unresolved placeholder
	 * node or, ambiguously, could be the wrong same-named symbol. `"exact"`
	 * means exactly one same-named real symbol existed anywhere in the graph
	 * at resolution time, so the match is provably unambiguous (not the same
	 * as scope/type-checked resolution — see `resolveDeferredSymbolEdges` in
	 * builder.ts). Undefined for edge kinds where resolution confidence
	 * doesn't apply (`imports`/`contains`/`defines`) and for `calls` edges to
	 * a definite external target (`callee.includes(".")` in builder.ts).
	 */
	resolution?: "exact" | "name-only";
}

export interface ReviewGraph {
	version: string;
	builtAt: string;
	nodes: Map<string, ReviewGraphNode>;
	edges: ReviewGraphEdge[];
	edgesByFrom: Map<string, ReviewGraphEdge[]>;
	edgesByTo: Map<string, ReviewGraphEdge[]>;
	fileNodes: Map<string, string>;
	symbolNodesByFile: Map<string, string[]>;
	changedSymbolsByFile: Map<string, string[]>;
	/**
	 * #459: process-local monotonic stamp identifying the graph CONTENT this
	 * instance was built from. Two returned graphs share a generation iff no
	 * graph-mutating build happened between them, so caches of graph-derived
	 * data (e.g. the reverse-dependency index) key invalidation off this — it
	 * travels with the instance, unlike the global last-build-info slot, which
	 * overlapping deferred cascades can clobber (#450). Absent on graphs from
	 * paths that never reuse (mode "skipped") ⇒ derived caches must rebuild.
	 */
	buildGeneration?: number;
}

export interface ImpactCascadeResult {
	filePath: string;
	changedSymbols: string[];
	directImporters: string[];
	directCallers: string[];
	neighborFiles: string[];
	riskFlags: string[];
}
