import { describe, expect, it } from "vitest";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import {
	buildOrUpdateGraph,
	computeImpactCascade,
	formatImpactCascade,
} from "../../clients/review-graph/service.js";
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
			const { clearGraphCache } = await import(
				"../../clients/review-graph/builder.js"
			);
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
});
