import { describe, expect, it } from "vitest";
import { extractSymbolsAndRefsFromGraph } from "../../../clients/review-graph/builder.js";
import type { ReviewGraph } from "../../../clients/review-graph/types.js";

// ── Minimal ReviewGraph fixture ───────────────────────────────────────────────

function makeGraph(
	nodes: Array<{ id: string; kind: string; filePath?: string; symbolName?: string }>,
	edges: Array<{ from: string; to: string; kind: string; metadata?: Record<string, unknown> }>,
): ReviewGraph {
	const nodeMap = new Map(nodes.map((n) => [n.id, n as any]));
	return {
		nodes: nodeMap,
		edges: edges as any[],
		fileNodes: new Map(),
		edgesByFrom: new Map(),
		edgesByTo: new Map(),
	} as ReviewGraph;
}

// ── extractSymbolsAndRefsFromGraph ────────────────────────────────────────────

describe("extractSymbolsAndRefsFromGraph", () => {
	it("extracts symbol nodes into allSymbols map keyed by filePath", () => {
		const graph = makeGraph(
			[
				{ id: "/proj/a.ts:doThing", kind: "symbol", filePath: "/proj/a.ts", symbolName: "doThing" },
				{ id: "/proj/a.ts:helper", kind: "symbol", filePath: "/proj/a.ts", symbolName: "helper" },
				{ id: "/proj/b.ts:process", kind: "symbol", filePath: "/proj/b.ts", symbolName: "process" },
			],
			[],
		);

		const { allSymbols } = extractSymbolsAndRefsFromGraph(graph);

		expect(allSymbols.get("/proj/a.ts")).toHaveLength(2);
		expect(allSymbols.get("/proj/b.ts")).toHaveLength(1);
		expect(allSymbols.get("/proj/a.ts")?.map((s) => s.name)).toContain("doThing");
		expect(allSymbols.get("/proj/a.ts")?.map((s) => s.name)).toContain("helper");
	});

	it("ignores non-symbol nodes", () => {
		const graph = makeGraph(
			[
				{ id: "file:/proj/a.ts", kind: "file", filePath: "/proj/a.ts" },
				{ id: "/proj/a.ts:doThing", kind: "symbol", filePath: "/proj/a.ts", symbolName: "doThing" },
			],
			[],
		);

		const { allSymbols } = extractSymbolsAndRefsFromGraph(graph);
		expect([...allSymbols.values()].flat()).toHaveLength(1);
	});

	it("extracts references edges into allRefs map keyed by caller file", () => {
		const graph = makeGraph(
			[],
			[
				{
					from: "file:/proj/a.ts",
					to: "symbol-name:helper",
					kind: "references",
					metadata: { line: 10, column: 5 },
				},
			],
		);

		const { allRefs } = extractSymbolsAndRefsFromGraph(graph);

		const refs = allRefs.get("/proj/a.ts");
		expect(refs).toHaveLength(1);
		expect(refs?.[0].symbolId.split(":").pop()).toBe("helper");
		expect(refs?.[0].line).toBe(10);
	});

	it("strips symbol-name: prefix from ref target", () => {
		const graph = makeGraph(
			[],
			[{ from: "file:/proj/a.ts", to: "symbol-name:myFunc", kind: "references" }],
		);

		const { allRefs } = extractSymbolsAndRefsFromGraph(graph);
		const ref = allRefs.get("/proj/a.ts")?.[0];
		expect(ref?.symbolId).toBe("/proj/a.ts:myFunc");
	});

	it("ignores non-references edges", () => {
		const graph = makeGraph(
			[],
			[
				{ from: "file:/proj/a.ts", to: "file:/proj/b.ts", kind: "imports" },
				{ from: "file:/proj/a.ts", to: "/proj/a.ts:fn", kind: "defines" },
			],
		);

		const { allRefs } = extractSymbolsAndRefsFromGraph(graph);
		expect(allRefs.size).toBe(0);
	});

	it("ignores references edges not from file: nodes", () => {
		const graph = makeGraph(
			[],
			[{ from: "/proj/a.ts:caller", to: "symbol-name:callee", kind: "references" }],
		);

		const { allRefs } = extractSymbolsAndRefsFromGraph(graph);
		expect(allRefs.size).toBe(0);
	});

	it("returns empty maps for an empty graph", () => {
		const graph = makeGraph([], []);
		const { allSymbols, allRefs } = extractSymbolsAndRefsFromGraph(graph);
		expect(allSymbols.size).toBe(0);
		expect(allRefs.size).toBe(0);
	});

	it("groups multiple refs from the same file", () => {
		const graph = makeGraph(
			[],
			[
				{ from: "file:/proj/a.ts", to: "symbol-name:foo", kind: "references" },
				{ from: "file:/proj/a.ts", to: "symbol-name:bar", kind: "references" },
				{ from: "file:/proj/b.ts", to: "symbol-name:baz", kind: "references" },
			],
		);

		const { allRefs } = extractSymbolsAndRefsFromGraph(graph);
		expect(allRefs.get("/proj/a.ts")).toHaveLength(2);
		expect(allRefs.get("/proj/b.ts")).toHaveLength(1);
	});

	it("symbols have correct id format filePath:name", () => {
		const graph = makeGraph(
			[{ id: "/proj/a.ts:doThing", kind: "symbol", filePath: "/proj/a.ts", symbolName: "doThing" }],
			[],
		);
		const { allSymbols } = extractSymbolsAndRefsFromGraph(graph);
		const sym = allSymbols.get("/proj/a.ts")?.[0];
		expect(sym?.id).toBe("/proj/a.ts:doThing");
		expect(sym?.filePath).toBe("/proj/a.ts");
		expect(sym?.name).toBe("doThing");
	});
});
