import { describe, expect, it } from "vitest";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import {
	buildOrUpdateGraph,
	computeImpactCascade,
	formatImpactCascade,
} from "../../clients/review-graph/service.js";
import {
	clearGraphCache,
	getLastGraphBuildInfo,
} from "../../clients/review-graph/builder.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

describe("review graph service", () => {
	it("builds a TS graph and surfaces importers/callers without duplicate edges", async () => {
		const env = setupTestEnvironment("pi-lens-review-graph-");
		try {
			const aPath = createTempFile(
				env.tmpDir,
				"src/a.ts",
				[
					"export function alpha() {",
					"  return helper();",
					"}",
					"function helper() {",
					"  return 1;",
					"}",
					"",
				].join("\n"),
			);
			const bPath = createTempFile(
				env.tmpDir,
				"src/b.ts",
				[
					"import { alpha } from './a';",
					"export function beta() {",
					"  return alpha();",
					"}",
					"",
				].join("\n"),
			);

			const facts = new FactStore();
			facts.setSessionFact(
				`session.reviewGraph.changedSymbols:${normalizeMapKey(aPath)}`,
				["alpha"],
			);

			const firstGraph = await buildOrUpdateGraph(env.tmpDir, [aPath], facts);
			const firstImpact = computeImpactCascade(firstGraph, aPath);
			expect(firstImpact.changedSymbols).toContain("alpha");
			expect(firstImpact.directImporters).toContain(normalizeMapKey(bPath));
			expect(firstImpact.directCallers).toContain(normalizeMapKey(bPath));
			expect(formatImpactCascade(firstImpact)).toContain("Impact cascade");

			const secondGraph = await buildOrUpdateGraph(env.tmpDir, [aPath], facts);
			const uniqueEdges = new Set(
				secondGraph.edges.map(
					(edge) => `${edge.kind}:${edge.from}->${edge.to}`,
				),
			);
			expect(uniqueEdges.size).toBe(secondGraph.edges.length);
		} finally {
			env.cleanup();
		}
	});

	it("builds file-level graphs for python/go/rust/ruby without crashing", async () => {
		const env = setupTestEnvironment("pi-lens-review-graph-langs-");
		try {
			const paths = [
				createTempFile(
					env.tmpDir,
					"pkg/main.py",
					"def greet(name):\n    return name\n",
				),
				createTempFile(
					env.tmpDir,
					"pkg/main.go",
					"package main\n\nfunc greet() {}\n",
				),
				createTempFile(env.tmpDir, "pkg/main.rs", "fn greet() {}\n"),
				createTempFile(env.tmpDir, "pkg/main.rb", "def greet\n  :ok\nend\n"),
			];

			const facts = new FactStore();
			const graph = await buildOrUpdateGraph(env.tmpDir, paths, facts);
			let totalSymbols = 0;
			for (const filePath of paths) {
				const normalized = normalizeMapKey(filePath);
				expect(graph.fileNodes.has(normalized)).toBe(true);
				totalSymbols += (graph.symbolNodesByFile.get(normalized) ?? []).length;
			}
			expect(totalSymbols).toBeGreaterThan(0);
		} finally {
			env.cleanup();
		}
	});

	it("surfaces references-edge neighbors for non-jsts languages (Python)", async () => {
		const env = setupTestEnvironment("pi-lens-review-graph-refs-");
		try {
			const modelsPath = createTempFile(
				env.tmpDir,
				"pkg/models.py",
				"class User:\n    pass\n",
			);
			const apiPath = createTempFile(
				env.tmpDir,
				"pkg/api.py",
				"from pkg.models import User\n\ndef get_user() -> User:\n    return User()\n",
			);

			const facts = new FactStore();
			facts.setSessionFact(
				`session.reviewGraph.changedSymbols:${normalizeMapKey(modelsPath)}`,
				["User"],
			);

			const graph = await buildOrUpdateGraph(
				env.tmpDir,
				[modelsPath, apiPath],
				facts,
			);
			const impact = computeImpactCascade(graph, modelsPath);
			// references edges from api.py → models.py:User should surface api.py as a neighbor
			expect(impact.neighborFiles).toContain(normalizeMapKey(apiPath));
		} finally {
			env.cleanup();
		}
	});

	it("flags cycle-adjacent files and suppresses low-signal output", async () => {
		const env = setupTestEnvironment("pi-lens-review-graph-cycle-");
		try {
			const aPath = createTempFile(
				env.tmpDir,
				"src/a.ts",
				"import { beta } from './b';\nexport function alpha() { return beta(); }\n",
			);
			createTempFile(
				env.tmpDir,
				"src/b.ts",
				"import { alpha } from './a';\nexport function beta() { return alpha(); }\n",
			);
			const lonePath = createTempFile(env.tmpDir, "src/lone.py", "value = 1\n");

			const facts = new FactStore();
			facts.setSessionFact(
				`session.reviewGraph.changedSymbols:${normalizeMapKey(aPath)}`,
				["alpha"],
			);

			const graph = await buildOrUpdateGraph(env.tmpDir, [aPath], facts);
			const impact = computeImpactCascade(graph, aPath);
			expect(impact.riskFlags).toContain("cycle-adjacent file");

			const loneResult = computeImpactCascade(graph, lonePath);
			expect(formatImpactCascade(loneResult)).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("updates cached graph incrementally when only the changed file mtime shifts", async () => {
		const env = setupTestEnvironment("pi-lens-review-graph-incremental-");
		try {
			const aPath = createTempFile(
				env.tmpDir,
				"src/a.ts",
				"export function alpha() { return 1; }\n",
			);
			const bPath = createTempFile(
				env.tmpDir,
				"src/b.ts",
				"import { alpha } from './a';\nexport function beta() { return alpha(); }\n",
			);

			const facts = new FactStore();
			await buildOrUpdateGraph(env.tmpDir, [aPath], facts);
			clearGraphCache();
			createTempFile(
				env.tmpDir,
				"src/a.ts",
				"export function alpha() { return 222; }\n",
			);

			const graph = await buildOrUpdateGraph(env.tmpDir, [aPath], facts);
			expect(getLastGraphBuildInfo()).toMatchObject({ mode: "incremental" });
			const impact = computeImpactCascade(graph, aPath);
			expect(impact.directImporters).toContain(normalizeMapKey(bPath));
			expect(impact.directCallers).toContain(normalizeMapKey(bPath));
		} finally {
			env.cleanup();
		}
	});

	it("skips full graph builds when source count exceeds the safety cap", async () => {
		const env = setupTestEnvironment("pi-lens-review-graph-cap-");
		const previous = process.env.PI_LENS_REVIEW_GRAPH_MAX_FILES;
		process.env.PI_LENS_REVIEW_GRAPH_MAX_FILES = "2";
		try {
			const changedPath = createTempFile(
				env.tmpDir,
				"src/changed.ts",
				"export function changed() { return 1; }\n",
			);
			for (let i = 0; i < 3; i += 1) {
				createTempFile(
					env.tmpDir,
					`src/extra-${i}.ts`,
					`export function extra${i}() { return ${i}; }\n`,
				);
			}

			const facts = new FactStore();
			facts.setSessionFact(
				`session.reviewGraph.changedSymbols:${normalizeMapKey(changedPath)}`,
				["changed"],
			);
			const graph = await buildOrUpdateGraph(env.tmpDir, [changedPath], facts);

			expect(getLastGraphBuildInfo()).toMatchObject({
				mode: "skipped",
				skipReason: "too_many_files",
				maxFileCount: 2,
			});
			expect(graph.nodes.size).toBe(0);
			expect(
				graph.changedSymbolsByFile.get(normalizeMapKey(changedPath)),
			).toEqual(["changed"]);
		} finally {
			if (previous === undefined)
				delete process.env.PI_LENS_REVIEW_GRAPH_MAX_FILES;
			else process.env.PI_LENS_REVIEW_GRAPH_MAX_FILES = previous;
			env.cleanup();
		}
	});

	it("does not skip when non-graph files (JSON/MD) push the raw count over the cap", async () => {
		// The walk is capped at maxGraphFiles+1, but scoped to graph-relevant
		// extensions — so a repo heavy in JSON/YAML/Markdown does NOT trip the
		// too_many_files skip on files the graph would have filtered out anyway
		// (#250 regression guard: a naive cap on the unscoped walk would skip here).
		const env = setupTestEnvironment("pi-lens-review-graph-scope-");
		const previous = process.env.PI_LENS_REVIEW_GRAPH_MAX_FILES;
		process.env.PI_LENS_REVIEW_GRAPH_MAX_FILES = "5";
		try {
			const changedPath = createTempFile(
				env.tmpDir,
				"src/changed.ts",
				"export function changed() { return 1; }\n",
			);
			createTempFile(
				env.tmpDir,
				"src/helper.ts",
				"export function helper() { return 2; }\n",
			);
			// 20 non-graph files — well over the cap of 5, but not graph-relevant.
			for (let i = 0; i < 20; i += 1) {
				createTempFile(env.tmpDir, `docs/d${i}.md`, `# doc ${i}\n`);
				createTempFile(env.tmpDir, `cfg/c${i}.json`, `{ "k": ${i} }\n`);
			}

			const facts = new FactStore();
			const graph = await buildOrUpdateGraph(env.tmpDir, [changedPath], facts);

			// 2 main-kind files <= cap of 5 → builds, does not skip.
			expect(getLastGraphBuildInfo().skipReason).toBeUndefined();
			expect(getLastGraphBuildInfo().mode).not.toBe("skipped");
			expect(graph.nodes.size).toBeGreaterThan(0);
		} finally {
			if (previous === undefined)
				delete process.env.PI_LENS_REVIEW_GRAPH_MAX_FILES;
			else process.env.PI_LENS_REVIEW_GRAPH_MAX_FILES = previous;
			env.cleanup();
		}
	});

	it("rebuilds indexes on workspace cache hit so impact cascade still works", async () => {
		const env = setupTestEnvironment("pi-lens-review-graph-cache-");
		try {
			const aPath = createTempFile(
				env.tmpDir,
				"src/a.ts",
				"export function alpha() { return 1; }\n",
			);
			const bPath = createTempFile(
				env.tmpDir,
				"src/b.ts",
				"import { alpha } from './a';\nexport function beta() { return alpha(); }\n",
			);

			const facts = new FactStore();
			const firstGraph = await buildOrUpdateGraph(env.tmpDir, [aPath], facts);
			expect(firstGraph.fileNodes.size).toBeGreaterThan(0);
			expect(firstGraph.edgesByTo.size).toBeGreaterThan(0);

			// Force workspace cache lookup on next call
			clearGraphCache();

			const secondGraph = await buildOrUpdateGraph(env.tmpDir, [bPath], facts);
			expect(secondGraph.fileNodes.size).toBeGreaterThan(0);
			expect(secondGraph.edgesByTo.size).toBeGreaterThan(0);

			const impact = computeImpactCascade(secondGraph, aPath);
			expect(impact.directImporters).toContain(normalizeMapKey(bPath));
		} finally {
			env.cleanup();
		}
	});

	it("resolves a tree-sitter language import to a real file→file edge (#249)", async () => {
		// ruby require_relative resolves to a sibling .rb — proves the resolver is
		// wired into addTreeSitterFile, not just the unit-tested pure function.
		const env = setupTestEnvironment("pi-lens-review-graph-resolve-");
		try {
			const bPath = createTempFile(
				env.tmpDir,
				"lib/b.rb",
				"def beta; 2; end\n",
			);
			const aPath = createTempFile(
				env.tmpDir,
				"lib/a.rb",
				'require_relative "./b"\ndef alpha; beta; end\n',
			);

			const facts = new FactStore();
			const graph = await buildOrUpdateGraph(env.tmpDir, [aPath, bPath], facts);

			const aId = `file:${normalizeMapKey(aPath)}`;
			const bId = `file:${normalizeMapKey(bPath)}`;
			const hasResolvedEdge = graph.edges.some(
				(e) => e.from === aId && e.to === bId && e.kind === "imports",
			);
			expect(hasResolvedEdge).toBe(true);
			// And it must NOT have fallen back to an unresolved module: node.
			expect(graph.nodes.has("module:./b")).toBe(false);

			// who-imports-this works at file granularity through the resolved edge.
			const impact = computeImpactCascade(graph, bPath);
			expect(impact.directImporters).toContain(normalizeMapKey(aPath));
		} finally {
			env.cleanup();
		}
	});
});
