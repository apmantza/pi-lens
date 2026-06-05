import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildCodebaseModel,
	loadCodebaseModel,
	saveCodebaseModel,
} from "../../clients/codebase-model.js";
import type { FunctionCallGraph } from "../../clients/call-graph.js";

// ── Fixture ───────────────────────────────────────────────────────────────────

function makeGraph(
	inDegree: Record<string, number>,
	callers: Record<string, string[]> = {},
	callees: Record<string, string[]> = {},
): FunctionCallGraph {
	return {
		inDegree: new Map(Object.entries(inDegree)),
		callers: new Map(Object.entries(callers).map(([k, v]) => [k, new Set(v)])),
		callees: new Map(Object.entries(callees).map(([k, v]) => [k, new Set(v)])),
		edges: [],
		unresolvedRefs: 0,
		totalRefs: 0,
		builtAt: "",
	};
}

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-model-")); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

// ── buildCodebaseModel ────────────────────────────────────────────────────────

describe("buildCodebaseModel", () => {
	it("returns empty model when graph has no edges", () => {
		const model = buildCodebaseModel(makeGraph({}), "/proj");
		expect(model.entries).toHaveLength(0);
		expect(model.totalTokens).toBe(0);
	});

	it("ranks symbols by in-degree descending", () => {
		const graph = makeGraph({
			"/proj/a.ts:low": 0.5,
			"/proj/b.ts:high": 5.0,
			"/proj/c.ts:mid": 2.0,
		});
		const model = buildCodebaseModel(graph, "/proj");
		const names = model.entries.map((e) => e.name);
		expect(names[0]).toBe("high");
		expect(names[1]).toBe("mid");
		expect(names[2]).toBe("low");
	});

	it("skips symbols below MIN_IN_DEGREE threshold", () => {
		const graph = makeGraph({
			"/proj/a.ts:insignificant": 0.1,
			"/proj/b.ts:significant": 2.0,
		});
		const model = buildCodebaseModel(graph, "/proj");
		expect(model.entries.map((e) => e.name)).not.toContain("insignificant");
		expect(model.entries.map((e) => e.name)).toContain("significant");
	});

	it("excludes node_modules, test, and dist files", () => {
		const graph = makeGraph({
			"/proj/node_modules/pkg/index.ts:pkg": 10.0,
			"/proj/src/foo.test.ts:testHelper": 5.0,
			"/proj/dist/bundle.ts:bundled": 8.0,
			"/proj/src/real.ts:realFn": 3.0,
		});
		const model = buildCodebaseModel(graph, "/proj");
		const names = model.entries.map((e) => e.name);
		expect(names).not.toContain("pkg");
		expect(names).not.toContain("testHelper");
		expect(names).not.toContain("bundled");
		expect(names).toContain("realFn");
	});

	it("deduplicates symbols by name across files", () => {
		const graph = makeGraph({
			"/proj/a.ts:sharedName": 5.0,
			"/proj/b.ts:sharedName": 3.0,
		});
		const model = buildCodebaseModel(graph, "/proj");
		const names = model.entries.map((e) => e.name);
		expect(names.filter((n) => n === "sharedName")).toHaveLength(1);
	});

	it("respects token budget", () => {
		// Create many symbols — budget should cap them
		const inDegree: Record<string, number> = {};
		for (let i = 0; i < 50; i++) {
			inDegree[`/proj/src/file${i}.ts:func${i}`] = 50 - i;
		}
		const model = buildCodebaseModel(makeGraph(inDegree), "/proj", 200);
		expect(model.totalTokens).toBeLessThanOrEqual(200);
		// Truncation must actually happen — far fewer than the 50 input symbols fit.
		expect(model.entries.length).toBeGreaterThan(0);
		expect(model.entries.length).toBeLessThan(50);
		// Highest in-degree symbols are kept (they're processed first).
		expect(model.entries[0]?.name).toBe("func0");
	});

	it("produces relative file paths", () => {
		const graph = makeGraph({ "/proj/src/util.ts:helper": 2.0 });
		const model = buildCodebaseModel(graph, "/proj");
		expect(model.entries[0]?.file).toBe("src/util.ts");
	});

	it("populates calls and calledBy from graph", () => {
		const graph = makeGraph(
			{ "/proj/b.ts:callee": 2.0 },
			{ "/proj/b.ts:callee": ["/proj/a.ts:caller"] },
			{ "/proj/b.ts:callee": ["/proj/c.ts:dep"] },
		);
		const model = buildCodebaseModel(graph, "/proj");
		const entry = model.entries.find((e) => e.name === "callee");
		expect(entry?.calledBy).toContain("caller");
		expect(entry?.calls).toContain("dep");
	});

	it("caps calls and calledBy at 10 each", () => {
		const manyCallers = Array.from({ length: 15 }, (_, i) => `/proj/x${i}.ts:fn${i}`);
		const graph = makeGraph(
			{ "/proj/b.ts:popular": 15.0 },
			{ "/proj/b.ts:popular": manyCallers },
		);
		const model = buildCodebaseModel(graph, "/proj");
		const entry = model.entries.find((e) => e.name === "popular");
		expect(entry?.calledBy.length).toBeLessThanOrEqual(10);
	});

	it("infers class kind for PascalCase names", () => {
		const graph = makeGraph({ "/proj/MyClass.ts:MyClass": 2.0 });
		const model = buildCodebaseModel(graph, "/proj");
		expect(model.entries[0]?.kind).toBe("class");
	});

	it("infers method kind for dotted names", () => {
		const graph = makeGraph({ "/proj/svc.ts:service.handle": 2.0 });
		const model = buildCodebaseModel(graph, "/proj");
		expect(model.entries[0]?.kind).toBe("method");
	});

	it("infers function kind for lowercase names", () => {
		const graph = makeGraph({ "/proj/util.ts:doThing": 2.0 });
		const model = buildCodebaseModel(graph, "/proj");
		expect(model.entries[0]?.kind).toBe("function");
	});

	it("sets generatedAt and summary counts", () => {
		const graph = makeGraph({ "/proj/a.ts:fn": 2.0 });
		const model = buildCodebaseModel(graph, "/proj");
		expect(model.generatedAt).toBeTruthy();
		expect(model.totalSymbols).toBe(1);
		expect(model.entries).toHaveLength(1);
	});
});

// ── Persistence ───────────────────────────────────────────────────────────────

describe("saveCodebaseModel / loadCodebaseModel", () => {
	it("round-trips the model correctly", () => {
		process.env.PILENS_DATA_DIR = tmpDir;
		const graph = makeGraph({ "/proj/src/foo.ts:bar": 3.0 });
		const model = buildCodebaseModel(graph, "/proj");
		saveCodebaseModel("/proj", model);
		const loaded = loadCodebaseModel("/proj");
		expect(loaded).toBeDefined();
		expect(loaded?.entries).toHaveLength(model.entries.length);
		expect(loaded?.totalTokens).toBe(model.totalTokens);
		delete process.env.PILENS_DATA_DIR;
	});

	it("returns undefined for missing cache", () => {
		process.env.PILENS_DATA_DIR = tmpDir;
		expect(loadCodebaseModel("/nonexistent/path")).toBeUndefined();
		delete process.env.PILENS_DATA_DIR;
	});
});
