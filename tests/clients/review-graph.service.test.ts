import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import { getProjectDataDir } from "../../clients/file-utils.js";
import { _resetUntrackedIgnoredCacheForTests } from "../../clients/git-tracked-ignore.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import {
	buildOrUpdateGraph,
	computeImpactCascade,
	formatImpactCascade,
} from "../../clients/review-graph/service.js";
import {
	clearGraphCache,
	clearReviewGraphWorkspaceCache,
	flushReviewGraphPersistsForTests,
	getCachedReviewGraph,
	getLastGraphBuildInfo,
	isReviewGraphMigrationNeeded,
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

	it("excludes test files from the graph (#260)", async () => {
		const env = setupTestEnvironment("pi-lens-review-graph-notests-");
		try {
			const aPath = createTempFile(
				env.tmpDir,
				"src/a.ts",
				"export function alpha() {\n  return 1;\n}\n",
			);
			const testPath = createTempFile(
				env.tmpDir,
				"src/a.test.ts",
				"import { alpha } from './a';\nalpha();\n",
			);

			// Full build (empty changedFiles → walks the project source set).
			const graph = await buildOrUpdateGraph(env.tmpDir, [], new FactStore());
			expect(graph.fileNodes.has(normalizeMapKey(aPath))).toBe(true);
			// The *.test.ts file is not graph-relevant: no node, no edges.
			expect(graph.fileNodes.has(normalizeMapKey(testPath))).toBe(false);
			expect(
				graph.edges.some(
					(e) => e.from === `file:${normalizeMapKey(testPath)}`,
				),
			).toBe(false);

			// Incremental guard: passing the test file as a changed file must not
			// add it either (the per-file chokepoint skips it).
			const g2 = await buildOrUpdateGraph(
				env.tmpDir,
				[testPath],
				new FactStore(),
			);
			expect(g2.fileNodes.has(normalizeMapKey(testPath))).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("getCachedReviewGraph returns a shared, indexed object — no per-call clone (#260)", async () => {
		const env = setupTestEnvironment("pi-lens-review-graph-shared-");
		try {
			createTempFile(
				env.tmpDir,
				"src/a.ts",
				"export function alpha() {\n  return 1;\n}\n",
			);
			createTempFile(
				env.tmpDir,
				"src/b.ts",
				"import { alpha } from './a';\nexport function beta() {\n  return alpha();\n}\n",
			);
			await buildOrUpdateGraph(env.tmpDir, [], new FactStore()); // warm cache

			const g1 = getCachedReviewGraph(env.tmpDir);
			const g2 = getCachedReviewGraph(env.tmpDir);
			expect(g1).toBeDefined();
			// Same reference across calls → the read path no longer clones (B/#260).
			expect(g1).toBe(g2);
			// And it's already indexed (who-uses-this works without a rebuild).
			expect(g1!.edgesByFrom.size).toBeGreaterThan(0);
			expect(g1!.fileNodes.size).toBeGreaterThan(0);
		} finally {
			clearReviewGraphWorkspaceCache();
			env.cleanup();
		}
	});

	it("isReviewGraphMigrationNeeded: stale version → true, current/absent → false (#260)", async () => {
		const env = setupTestEnvironment("pi-lens-review-graph-migrate-");
		try {
			// Nothing persisted → nothing to migrate (a cold start builds on demand).
			expect(isReviewGraphMigrationNeeded(env.tmpDir)).toBe(false);

			// A snapshot written under an older version → migration needed.
			const cacheDir = path.join(getProjectDataDir(env.tmpDir), "cache");
			fs.mkdirSync(cacheDir, { recursive: true });
			fs.writeFileSync(
				path.join(cacheDir, "review-graph.json"),
				JSON.stringify({
					version: "v1-old",
					builtAt: "x",
					signature: "s",
					nodes: [],
					edges: [],
				}),
			);
			expect(isReviewGraphMigrationNeeded(env.tmpDir)).toBe(true);

			// A real build persists the CURRENT version → no longer stale.
			createTempFile(
				env.tmpDir,
				"src/a.ts",
				"export function alpha() {\n  return 1;\n}\n",
			);
			await buildOrUpdateGraph(env.tmpDir, [], new FactStore());
			flushReviewGraphPersistsForTests();
			for (let i = 0; i < 20 && isReviewGraphMigrationNeeded(env.tmpDir); i++) {
				await new Promise((r) => setTimeout(r, 25));
			}
			expect(isReviewGraphMigrationNeeded(env.tmpDir)).toBe(false);
		} finally {
			clearReviewGraphWorkspaceCache();
			env.cleanup();
		}
	});

	it("refs #655: a v3 snapshot (pre-collision-safe-ID scheme) is detected as stale and safely rebuilt, never misread", async () => {
		// #655's v4 bump changed the symbol-node ID shape from `<file>:<name>` to
		// `<file>:<name>:<kind>:<startLine>`. A real v3 snapshot's nodes/edges still
		// use the OLD id shape throughout — merging it with newly-built v4 IDs
		// would silently duplicate/misalign nodes, so it must be rejected exactly
		// like the v2→v3 (#260) bump was, not partially reused.
		const env = setupTestEnvironment("pi-lens-review-graph-v3-migrate-");
		try {
			const cacheDir = path.join(getProjectDataDir(env.tmpDir), "cache");
			fs.mkdirSync(cacheDir, { recursive: true });
			fs.writeFileSync(
				path.join(cacheDir, "review-graph.json"),
				JSON.stringify({
					version: "v3",
					builtAt: "x",
					signature: "s",
					nodes: [
						[
							"src/a.ts:alpha",
							{
								id: "src/a.ts:alpha",
								kind: "symbol",
								language: "jsts",
								filePath: "src/a.ts",
								symbolName: "alpha",
								symbolKind: "function",
							},
						],
					],
					edges: [],
				}),
			);
			// A v3 snapshot must be flagged as needing migration under the v4 build.
			expect(isReviewGraphMigrationNeeded(env.tmpDir)).toBe(true);

			// getCachedReviewGraph's blind read must also reject it outright (never
			// hand back a v3-shaped graph to a v4-ID-aware caller like module-report).
			const { getCachedReviewGraph } = await import(
				"../../clients/review-graph/builder.js"
			);
			expect(getCachedReviewGraph(env.tmpDir)).toBeUndefined();

			// A real build produces a fresh v4 graph with the new ID shape, not the
			// old one, and is no longer flagged as needing migration.
			createTempFile(
				env.tmpDir,
				"src/a.ts",
				"export function alpha() {\n  return 1;\n}\n",
			);
			const graph = await buildOrUpdateGraph(env.tmpDir, [], new FactStore());
			expect(graph.version).toBe("v6");
			const alphaId = [...graph.nodes.keys()].find((id) =>
				id.includes(":alpha:"),
			);
			expect(alphaId).toBeDefined();
			flushReviewGraphPersistsForTests();
			for (let i = 0; i < 20 && isReviewGraphMigrationNeeded(env.tmpDir); i++) {
				await new Promise((r) => setTimeout(r, 25));
			}
			expect(isReviewGraphMigrationNeeded(env.tmpDir)).toBe(false);
		} finally {
			clearReviewGraphWorkspaceCache();
			env.cleanup();
		}
	});

	it("refs #694: a v4 snapshot (pre-twin-preference, compiled-artifact edges) is detected as stale and safely rebuilt", async () => {
		// #694's v5 bump: import resolution now prefers a .ts/.tsx source twin
		// over a compiled .js sibling, and node creation is gated against
		// untracked-AND-ignored files. A real v4 snapshot from a compile-in-place
		// project has edges materialized on the compiled artifact node
		// throughout — merging that with newly-built v5 edges would leave the
		// graph in mixed, partially-corrected state, so it must be rejected
		// exactly like the earlier version bumps.
		const env = setupTestEnvironment("pi-lens-review-graph-v4-migrate-");
		try {
			const cacheDir = path.join(getProjectDataDir(env.tmpDir), "cache");
			fs.mkdirSync(cacheDir, { recursive: true });
			fs.writeFileSync(
				path.join(cacheDir, "review-graph.json"),
				JSON.stringify({
					version: "v4",
					builtAt: "x",
					signature: "s",
					nodes: [
						[
							"file:src/types.js",
							{
								id: "file:src/types.js",
								kind: "file",
								language: "jsts",
								filePath: "src/types.js",
							},
						],
					],
					edges: [],
				}),
			);
			expect(isReviewGraphMigrationNeeded(env.tmpDir)).toBe(true);

			const { getCachedReviewGraph } = await import(
				"../../clients/review-graph/builder.js"
			);
			expect(getCachedReviewGraph(env.tmpDir)).toBeUndefined();

			createTempFile(
				env.tmpDir,
				"src/types.ts",
				"export interface Foo {\n  a: number;\n}\n",
			);
			const graph = await buildOrUpdateGraph(env.tmpDir, [], new FactStore());
			expect(graph.version).toBe("v6");
			flushReviewGraphPersistsForTests();
			for (let i = 0; i < 20 && isReviewGraphMigrationNeeded(env.tmpDir); i++) {
				await new Promise((r) => setTimeout(r, 25));
			}
			expect(isReviewGraphMigrationNeeded(env.tmpDir)).toBe(false);
		} finally {
			clearReviewGraphWorkspaceCache();
			env.cleanup();
		}
	});

	it("refs #655: an unresolved bare-name call stays 'name-only'; a unique-name call resolves 'exact'", async () => {
		const env = setupTestEnvironment("pi-lens-review-graph-resolution-");
		try {
			// `alpha` is globally unique by name → its bare-name callee edge must
			// upgrade to "exact" once resolveDeferredSymbolEdges runs.
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
			// Two `dup` functions in two different files → any bare-name call to
			// `dup` can't be told apart → must stay "name-only", never "exact".
			createTempFile(
				env.tmpDir,
				"src/dup1.ts",
				"export function dup() { return 1; }\n",
			);
			createTempFile(
				env.tmpDir,
				"src/dup2.ts",
				"export function dup() { return 2; }\n",
			);
			createTempFile(
				env.tmpDir,
				"src/caller.ts",
				"export function useDup() { return dup(); }\n",
			);

			const facts = new FactStore();
			const graph = await buildOrUpdateGraph(
				env.tmpDir,
				[aPath],
				facts,
			);

			const helperCallEdge = graph.edges.find(
				(e) =>
					e.kind === "calls" &&
					e.from.includes(":alpha:") &&
					graph.nodes.get(e.to)?.symbolName === "helper",
			);
			expect(helperCallEdge).toBeDefined();
			expect(helperCallEdge?.resolution).toBe("exact");

			const dupCallEdge = graph.edges.find(
				(e) => e.kind === "calls" && e.from.includes(":useDup:"),
			);
			expect(dupCallEdge).toBeDefined();
			expect(dupCallEdge?.resolution).toBe("name-only");
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

	it("skips graph construction when cwd IS $HOME, without walking it (#622)", async () => {
		// #622: launching Pi from $HOME and editing an absolute-path file in some
		// other repo used to pass $HOME straight through to buildOrUpdateGraph as
		// `cwd` (the 3 real per-edit callers assume cwd is already a project
		// root). getGraphSourceFiles then walked the entire home tree — 206k+
		// files, ~500s of blocked event loop — before its maxGraphFiles cap even
		// had a chance to trip, because the cap counts post-filter kept files,
		// not directory entries visited. buildOrUpdateGraph must now reject a
		// cwd that is (or is an ancestor of) $HOME before any walk starts.
		const facts = new FactStore();
		const homeDir = os.homedir();
		const start = Date.now();
		const graph = await buildOrUpdateGraph(homeDir, [], facts);
		const elapsedMs = Date.now() - start;

		expect(getLastGraphBuildInfo()).toMatchObject({
			mode: "skipped",
			skipReason: "unsafe_root",
		});
		expect(graph.nodes.size).toBe(0);
		expect(graph.fileNodes.size).toBe(0);
		// A real walk of $HOME is the entire point of the bug (~500s in the
		// issue's own logs) — bailing before it starts must be near-instant.
		expect(elapsedMs).toBeLessThan(2_000);
	});

	it("does not skip a normal project root that merely lives UNDER home (#622)", async () => {
		// Regression guard: the #622 fix must reject cwd only when it IS (or is
		// an ancestor of) $HOME — a real project nested under home (the common
		// case, e.g. ~/code/app) must still build normally.
		const env = setupTestEnvironment("pi-lens-review-graph-under-home-");
		try {
			createTempFile(
				env.tmpDir,
				"src/a.ts",
				"export function alpha() { return 1; }\n",
			);
			const facts = new FactStore();
			const graph = await buildOrUpdateGraph(env.tmpDir, [], facts);
			expect(getLastGraphBuildInfo().skipReason).not.toBe("unsafe_root");
			expect(graph.fileNodes.size).toBeGreaterThan(0);
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

describe("review graph: ignore-gated node creation (#694)", () => {
	function initGitRepo(cwd: string): void {
		execFileSync("git", ["init", "-q"], { cwd });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
		execFileSync("git", ["config", "user.name", "Test"], { cwd });
	}

	beforeEach(() => {
		_resetUntrackedIgnoredCacheForTests();
	});
	afterEach(() => {
		_resetUntrackedIgnoredCacheForTests();
	});

	it("never materializes an untracked-AND-gitignored import target as a file node, but keeps a tracked one matching the same pattern", async () => {
		const env = setupTestEnvironment("pi-lens-review-graph-ignore-gate-");
		try {
			initGitRepo(env.tmpDir);
			// vendor.js is committed BEFORE the `*.js` ignore pattern exists — the
			// real-world shape of "vendored source that predates/survives a later
			// broad ignore rule." Git's own semantic: once tracked, a file is never
			// "ignored" even when a later pattern matches it.
			const vendorPath = createTempFile(
				env.tmpDir,
				"src/vendor.js",
				"exports.vendor = 1;\n",
			);
			execFileSync("git", ["add", "src/vendor.js"], { cwd: env.tmpDir });
			execFileSync("git", ["commit", "-q", "-m", "vendor"], {
				cwd: env.tmpDir,
			});

			// Broad `*.js` pattern (mirrors pi-lens's own root .gitignore) — matches
			// BOTH gen.js (untracked build artifact, no .ts twin) and vendor.js.
			createTempFile(env.tmpDir, ".gitignore", "*.js\n");
			const genPath = createTempFile(
				env.tmpDir,
				"src/gen.js",
				"exports.gen = 1;\n",
			);
			const aPath = createTempFile(
				env.tmpDir,
				"src/a.ts",
				"import './gen.js';\nimport './vendor.js';\n",
			);
			// Commit .gitignore and a.ts — deliberately NOT gen.js, so it stays
			// untracked (and therefore actually ignored by git).
			execFileSync("git", ["add", ".gitignore", "src/a.ts"], {
				cwd: env.tmpDir,
			});
			execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: env.tmpDir });

			const facts = new FactStore();
			const graph = await buildOrUpdateGraph(env.tmpDir, [aPath], facts);

			const genId = `file:${normalizeMapKey(genPath)}`;
			const vendorId = `file:${normalizeMapKey(vendorPath)}`;
			expect(graph.nodes.has(genId)).toBe(false);
			expect(graph.nodes.has(vendorId)).toBe(true);

			const aId = `file:${normalizeMapKey(aPath)}`;
			expect(
				graph.edges.some(
					(e) => e.from === aId && e.to === vendorId && e.kind === "imports",
				),
			).toBe(true);
			// The filtered-out ignored target must not leave a dangling edge either.
			expect(graph.edges.some((e) => e.to === genId)).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("degrades to unfiltered (no git binary reachable in the repo) without throwing", async () => {
		// Not a git repo at all: collectUntrackedIgnoredIds' spawn fails/returns
		// non-zero, so the caller must skip the filter entirely rather than
		// guessing via a matcher that can't see tracked status.
		const env = setupTestEnvironment("pi-lens-review-graph-ignore-gate-nogit-");
		try {
			createTempFile(env.tmpDir, ".gitignore", "*.js\n");
			const genPath = createTempFile(
				env.tmpDir,
				"src/gen.js",
				"exports.gen = 1;\n",
			);
			const aPath = createTempFile(
				env.tmpDir,
				"src/a.ts",
				"import './gen.js';\n",
			);
			const facts = new FactStore();
			const graph = await buildOrUpdateGraph(env.tmpDir, [aPath], facts);
			// No git identity available ⇒ filter skipped ⇒ the import target is
			// still admitted (status quo, not a regression from this change).
			const genId = `file:${normalizeMapKey(genPath)}`;
			expect(graph.nodes.has(genId)).toBe(true);
		} finally {
			env.cleanup();
		}
	});
});
