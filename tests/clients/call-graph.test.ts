import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildCallGraph,
	formatImpact,
	impact,
	loadCallGraph,
	readMtimes,
	saveCallGraph,
	staleFiles,
	type FunctionCallGraph,
} from "../../clients/call-graph.js";
import type { Symbol, SymbolRef } from "../../clients/symbol-types.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function sym(filePath: string, name: string, kind: Symbol["kind"] = "function", line = 1): Symbol {
	return { id: `${filePath}:${name}`, name, kind, filePath, line, column: 1, isExported: true };
}

function ref(callerFile: string, refName: string, line = 5): SymbolRef {
	return { symbolId: `${callerFile}:${refName}`, filePath: callerFile, line, column: 1 };
}

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-cg-")); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

// ── buildCallGraph ─────────────────────────────────────────────────────────────

describe("buildCallGraph", () => {
	it("resolves a cross-file call and populates both directions", () => {
		const fileA = "/proj/a.ts";
		const fileB = "/proj/b.ts";

		const allSymbols = new Map([
			[fileA, [sym(fileA, "doThing", "function", 1)]],
			[fileB, [sym(fileB, "helper", "function", 1)]],
		]);
		const allRefs = new Map([
			[fileA, [ref(fileA, "helper", 5)]], // a.ts calls helper from b.ts
		]);

		const graph = buildCallGraph(allSymbols, allRefs);

		expect(graph.totalRefs).toBeGreaterThan(0);

		// Callee map: doThing → {b.ts:helper}
		const callerKey = `${fileA}:doThing`;
		const calleeKey = `${fileB}:helper`;
		expect(graph.callees.get(callerKey)?.has(calleeKey)).toBe(true);

		// Caller map: helper → {a.ts:doThing}
		expect(graph.callers.get(calleeKey)?.has(callerKey)).toBe(true);
	});

	it("does not create edges for same-file refs", () => {
		const fileA = "/proj/a.ts";

		const allSymbols = new Map([
			[fileA, [sym(fileA, "foo"), sym(fileA, "bar")]],
		]);
		const allRefs = new Map([
			[fileA, [ref(fileA, "bar", 5)]], // a.ts calls bar — also in a.ts
		]);

		const graph = buildCallGraph(allSymbols, allRefs);

		// No cross-file edges — no callee/caller entries expected
		expect(graph.callees.size).toBe(0);
		expect(graph.callers.size).toBe(0);
	});

	it("applies ambiguity discounting when multiple files define same name", () => {
		const fileA = "/proj/a.ts";
		const fileB = "/proj/b.ts";
		const fileC = "/proj/c.ts";

		const allSymbols = new Map([
			[fileA, []],
			[fileB, [sym(fileB, "shared")]],
			[fileC, [sym(fileC, "shared")]],
		]);
		const allRefs = new Map([
			[fileA, [ref(fileA, "shared", 3)]],
		]);

		const graph = buildCallGraph(allSymbols, allRefs);

		// Two defs → weight = 0.5 each
		for (const edge of graph.edges) {
			expect(edge.weight).toBe(0.5);
		}
	});

	it("filters stdlib names from resolution", () => {
		const fileA = "/proj/a.ts";
		const fileB = "/proj/b.ts";

		const allSymbols = new Map([
			[fileA, []],
			[fileB, [sym(fileB, "console"), sym(fileB, "Math")]],
		]);
		const allRefs = new Map([
			[fileA, [ref(fileA, "console", 2), ref(fileA, "Math", 3)]],
		]);

		const graph = buildCallGraph(allSymbols, allRefs);

		expect(graph.edges).toHaveLength(0);
	});

	it("falls back to file-level caller key when no enclosing function found", () => {
		const fileA = "/proj/a.ts";
		const fileB = "/proj/b.ts";

		// fileA has no function symbols — ref is at module level
		const allSymbols = new Map([
			[fileA, []],
			[fileB, [sym(fileB, "init")]],
		]);
		const allRefs = new Map([
			[fileA, [ref(fileA, "init", 1)]],
		]);

		const graph = buildCallGraph(allSymbols, allRefs);

		const callerKey = `file:${fileA}`;
		expect(graph.callees.get(callerKey)?.size).toBe(1);
	});

	it("accumulates weighted in-degree correctly", () => {
		const fileA = "/proj/a.ts";
		const fileB = "/proj/b.ts";
		const fileC = "/proj/c.ts";

		const allSymbols = new Map([
			[fileA, [sym(fileA, "caller1"), sym(fileA, "caller2")]],
			[fileB, []],
			[fileC, [sym(fileC, "shared")]],
		]);
		// Two distinct callers each call shared once (weight=1.0 each)
		const allRefs = new Map([
			[fileA, [ref(fileA, "shared", 3), ref(fileA, "shared", 10)]],
			[fileB, [ref(fileB, "shared", 5)]],
		]);

		const graph = buildCallGraph(allSymbols, allRefs);

		const calleeKey = `${fileC}:shared`;
		const inDeg = graph.inDegree.get(calleeKey) ?? 0;
		// Each unambiguous ref contributes weight 1.0
		expect(inDeg).toBeGreaterThan(0);
	});
});

// ── impact() ──────────────────────────────────────────────────────────────────

function makeGraph(
	edges: Array<{ callerKey: string; calleeKey: string; weight?: number }>,
): FunctionCallGraph {
	const callees = new Map<string, Set<string>>();
	const callers = new Map<string, Set<string>>();
	const inDegree = new Map<string, number>();
	const resolvedEdges = edges.map((e) => ({
		callerFile: e.callerKey.split(":")[0] ?? "",
		callerSymbol: e.callerKey.split(":")[1],
		callerKey: e.callerKey,
		calleeFile: e.calleeKey.split(":")[0] ?? "",
		calleeSymbol: e.calleeKey.split(":")[1] ?? e.calleeKey,
		calleeKey: e.calleeKey,
		weight: e.weight ?? 1.0,
	}));

	for (const edge of resolvedEdges) {
		const ec = callees.get(edge.callerKey) ?? new Set();
		ec.add(edge.calleeKey);
		callees.set(edge.callerKey, ec);
		const cr = callers.get(edge.calleeKey) ?? new Set();
		cr.add(edge.callerKey);
		callers.set(edge.calleeKey, cr);
		inDegree.set(edge.calleeKey, (inDegree.get(edge.calleeKey) ?? 0) + edge.weight!);
	}

	return { callees, callers, inDegree, edges: resolvedEdges, unresolvedRefs: 0, totalRefs: 0, builtAt: "" };
}

describe("impact()", () => {
	it("returns empty for a symbol with no callers", () => {
		const g = makeGraph([{ callerKey: "a:foo", calleeKey: "b:bar" }]);
		expect(impact(g, "a:foo")).toHaveLength(0);
	});

	it("classifies depth-1 as WillBreak", () => {
		const g = makeGraph([{ callerKey: "a:caller", calleeKey: "b:callee" }]);
		const results = impact(g, "b:callee");
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({ symbolKey: "a:caller", depth: 1, severity: "WillBreak" });
	});

	it("classifies depth-2 as MayBreak", () => {
		const g = makeGraph([
			{ callerKey: "a:A", calleeKey: "b:B" },
			{ callerKey: "c:C", calleeKey: "a:A" },
		]);
		const results = impact(g, "b:B");
		const c = results.find((r) => r.symbolKey === "c:C");
		expect(c?.severity).toBe("MayBreak");
		expect(c?.depth).toBe(2);
	});

	it("classifies depth-3 as Review", () => {
		const g = makeGraph([
			{ callerKey: "a:A", calleeKey: "b:B" },
			{ callerKey: "c:C", calleeKey: "a:A" },
			{ callerKey: "d:D", calleeKey: "c:C" },
		]);
		const results = impact(g, "b:B");
		const d = results.find((r) => r.symbolKey === "d:D");
		expect(d?.severity).toBe("Review");
		expect(d?.depth).toBe(3);
	});

	it("respects maxDepth — does not traverse beyond it", () => {
		const g = makeGraph([
			{ callerKey: "a:A", calleeKey: "b:B" },
			{ callerKey: "c:C", calleeKey: "a:A" },
		]);
		const results = impact(g, "b:B", 1);
		expect(results.map((r) => r.symbolKey)).not.toContain("c:C");
	});

	it("does not revisit already-visited nodes (cycle safety)", () => {
		// A → B → A (cycle)
		const g = makeGraph([
			{ callerKey: "a:A", calleeKey: "b:B" },
			{ callerKey: "b:B", calleeKey: "a:A" },
		]);
		const results = impact(g, "b:B");
		const keys = results.map((r) => r.symbolKey);
		// Should not loop; each key appears at most once
		expect(new Set(keys).size).toBe(keys.length);
	});

	it("filters low-weight edges when minWeight > edge weight", () => {
		const g = makeGraph([{ callerKey: "a:A", calleeKey: "b:B", weight: 0.05 }]);
		const results = impact(g, "b:B", 3, 0.1);
		expect(results).toHaveLength(0);
	});

	it("results are sorted by depth then symbolKey", () => {
		const g = makeGraph([
			{ callerKey: "z:Z", calleeKey: "b:B" },
			{ callerKey: "a:A", calleeKey: "b:B" },
		]);
		const results = impact(g, "b:B");
		expect(results[0].symbolKey < results[1].symbolKey).toBe(true);
	});
});

describe("formatImpact()", () => {
	it("returns empty string for empty results", () => {
		expect(formatImpact([], "/proj")).toBe("");
	});

	it("formats WillBreak callers", () => {
		const g = makeGraph([{ callerKey: "/proj/a.ts:handleRequest", calleeKey: "/proj/b.ts:changed" }]);
		const results = impact(g, "/proj/b.ts:changed");
		const summary = formatImpact(results, "/proj");
		expect(summary).toContain("WillBreak");
		expect(summary).toContain("handleRequest");
	});

	it("mentions Review count when present", () => {
		const g = makeGraph([
			{ callerKey: "/proj/a.ts:A", calleeKey: "/proj/b.ts:B" },
			{ callerKey: "/proj/c.ts:C", calleeKey: "/proj/a.ts:A" },
			{ callerKey: "/proj/d.ts:D", calleeKey: "/proj/c.ts:C" },
		]);
		const results = impact(g, "/proj/b.ts:B");
		const summary = formatImpact(results, "/proj");
		expect(summary).toContain("Review");
	});
});

// ── Persistence ────────────────────────────────────────────────────────────────

describe("saveCallGraph / loadCallGraph", () => {
	it("round-trips callees, callers, and inDegree correctly", () => {
		process.env.PILENS_DATA_DIR = tmpDir;

		const fileA = "/proj/a.ts";
		const fileB = "/proj/b.ts";
		const allSymbols = new Map([
			[fileA, [sym(fileA, "caller")]],
			[fileB, [sym(fileB, "callee")]],
		]);
		const allRefs = new Map([[fileA, [ref(fileA, "callee", 5)]]]);

		const graph = buildCallGraph(allSymbols, allRefs);
		const mtimes = new Map([[fileA, 1234], [fileB, 5678]]);

		saveCallGraph("/proj", graph, mtimes);
		const loaded = loadCallGraph("/proj");

		expect(loaded).toBeDefined();
		const callerKey = `${fileA}:caller`;
		const calleeKey = `${fileB}:callee`;
		expect(loaded?.graph.callees.get(callerKey)?.has(calleeKey)).toBe(true);
		expect(loaded?.graph.callers.get(calleeKey)?.has(callerKey)).toBe(true);
		expect(loaded?.fileMtimes.get(fileA)).toBe(1234);

		delete process.env.PILENS_DATA_DIR;
	});

	it("returns undefined for missing cache", () => {
		process.env.PILENS_DATA_DIR = tmpDir;
		expect(loadCallGraph("/nonexistent")).toBeUndefined();
		delete process.env.PILENS_DATA_DIR;
	});
});

// ── staleFiles ─────────────────────────────────────────────────────────────────

describe("staleFiles", () => {
	it("returns files whose mtime differs", () => {
		const fileA = path.join(tmpDir, "a.ts");
		fs.writeFileSync(fileA, "x");
		const mtime = fs.statSync(fileA).mtimeMs;

		// File with wrong mtime → stale
		const stale = staleFiles(new Map([[fileA, mtime - 1000]]), [fileA]);
		expect(stale).toContain(fileA);
	});

	it("returns file as stale if not in mtime map", () => {
		const fileA = path.join(tmpDir, "new.ts");
		fs.writeFileSync(fileA, "x");

		const stale = staleFiles(new Map(), [fileA]);
		expect(stale).toContain(fileA);
	});

	it("does not return file as stale when mtime matches", () => {
		const fileA = path.join(tmpDir, "fresh.ts");
		fs.writeFileSync(fileA, "x");
		const mtime = fs.statSync(fileA).mtimeMs;

		const stale = staleFiles(new Map([[fileA, mtime]]), [fileA]);
		expect(stale).not.toContain(fileA);
	});
});

describe("readMtimes", () => {
	it("reads current mtimes for existing files", () => {
		const fileA = path.join(tmpDir, "a.ts");
		fs.writeFileSync(fileA, "x");

		const mtimes = readMtimes([fileA]);
		expect(mtimes.has(fileA)).toBe(true);
		expect(typeof mtimes.get(fileA)).toBe("number");
	});

	it("skips files that do not exist", () => {
		const missing = path.join(tmpDir, "missing.ts");
		const mtimes = readMtimes([missing]);
		expect(mtimes.has(missing)).toBe(false);
	});
});
