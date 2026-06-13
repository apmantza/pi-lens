import { describe, expect, it } from "vitest";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import { computeTransitiveImpact } from "../../../clients/review-graph/query.js";
import type {
	ReviewGraph,
	ReviewGraphEdge,
	ReviewGraphNode,
} from "../../../clients/review-graph/types.js";

/**
 * Build a minimal ReviewGraph from nodes + edges, deriving the index maps the
 * traversal needs (edgesByTo, fileNodes, symbolNodesByFile).
 */
function makeGraph(
	nodes: ReviewGraphNode[],
	edges: ReviewGraphEdge[],
): ReviewGraph {
	const nodeMap = new Map(nodes.map((n) => [n.id, n]));
	const edgesByTo = new Map<string, ReviewGraphEdge[]>();
	const edgesByFrom = new Map<string, ReviewGraphEdge[]>();
	const fileNodes = new Map<string, string>();
	const symbolNodesByFile = new Map<string, string[]>();
	for (const edge of edges) {
		(edgesByTo.get(edge.to) ?? edgesByTo.set(edge.to, []).get(edge.to))?.push(
			edge,
		);
		(
			edgesByFrom.get(edge.from) ??
			edgesByFrom.set(edge.from, []).get(edge.from)
		)?.push(edge);
	}
	for (const node of nodes) {
		if (!node.filePath) continue;
		const key = normalizeMapKey(node.filePath);
		if (node.kind === "file") fileNodes.set(key, node.id);
		if (node.kind === "symbol") {
			(
				symbolNodesByFile.get(key) ??
				symbolNodesByFile.set(key, []).get(key)
			)?.push(node.id);
		}
	}
	return {
		version: "v2",
		builtAt: new Date().toISOString(),
		nodes: nodeMap,
		edges,
		edgesByFrom,
		edgesByTo,
		fileNodes,
		symbolNodesByFile,
		changedSymbolsByFile: new Map(),
	};
}

// a.ts:core  <-calls-  b.ts:mid  <-calls-  c.ts:top
// a.ts(file) <-imports- d.ts(file)
const nodes: ReviewGraphNode[] = [
	{ id: "a#file", kind: "file", language: "ts", filePath: "a.ts" },
	{ id: "a#core", kind: "symbol", language: "ts", filePath: "a.ts", symbolName: "core" },
	{ id: "b#mid", kind: "symbol", language: "ts", filePath: "b.ts", symbolName: "mid" },
	{ id: "c#top", kind: "symbol", language: "ts", filePath: "c.ts", symbolName: "top" },
	{ id: "d#file", kind: "file", language: "ts", filePath: "d.ts" },
];
const edges: ReviewGraphEdge[] = [
	{ from: "b#mid", to: "a#core", kind: "calls" },
	{ from: "c#top", to: "b#mid", kind: "calls" },
	{ from: "d#file", to: "a#file", kind: "imports" },
];

describe("computeTransitiveImpact", () => {
	it("walks incoming edges transitively with depth + relation", () => {
		const graph = makeGraph(nodes, edges);
		const result = computeTransitiveImpact(graph, "a.ts", { maxDepth: 3 });

		const bySymbol = new Map(result.hits.map((h) => [h.symbol || h.file, h]));
		expect(bySymbol.get("mid")).toMatchObject({ depth: 1, relation: "calls" });
		expect(bySymbol.get("top")).toMatchObject({ depth: 2, relation: "calls" });
		expect(bySymbol.get("d.ts")).toMatchObject({ depth: 1, relation: "imports" });
		expect(result.maxDepthReached).toBe(2);
		expect(result.truncated).toBe(false);
	});

	it("respects the depth bound", () => {
		const graph = makeGraph(nodes, edges);
		const result = computeTransitiveImpact(graph, "a.ts", { maxDepth: 1 });
		const symbols = result.hits.map((h) => h.symbol);
		expect(symbols).toContain("mid"); // depth 1
		expect(symbols).not.toContain("top"); // depth 2 — beyond bound
		expect(result.maxDepthReached).toBe(1);
	});

	it("filters by relation", () => {
		const graph = makeGraph(nodes, edges);
		const result = computeTransitiveImpact(graph, "a.ts", {
			relations: ["imports"],
		});
		expect(result.hits).toHaveLength(1);
		expect(result.hits[0]).toMatchObject({ file: "d.ts", relation: "imports" });
	});

	it("truncates at maxHits", () => {
		const graph = makeGraph(nodes, edges);
		const result = computeTransitiveImpact(graph, "a.ts", { maxHits: 1 });
		expect(result.hits).toHaveLength(1);
		expect(result.truncated).toBe(true);
	});

	it("returns no hits for a file nothing depends on", () => {
		const graph = makeGraph(nodes, edges);
		const result = computeTransitiveImpact(graph, "c.ts");
		expect(result.hits).toHaveLength(0);
		expect(result.truncated).toBe(false);
	});
});
