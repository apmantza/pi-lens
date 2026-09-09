import { execFileSync } from "../support/git-fixture-env.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import { getProjectDataDir } from "../../clients/file-utils.js";
import { _resetUntrackedIgnoredCacheForTests } from "../../clients/git-tracked-ignore.js";
import { logLatency } from "../../clients/latency-logger.js";
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
	getGraphSourceFiles,
	_resetReviewGraphSourcePathMemoForTests,
	getLastGraphBuildInfo,
	_setReviewGraphEntryCounterForTests,
	isReviewGraphMigrationNeeded,
	REVIEW_GRAPH_VERSION,
} from "../../clients/review-graph/builder.js";
import { clearModuleGraphCache } from "../../clients/review-graph/workspace-modules.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

vi.mock("../../clients/latency-logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/latency-logger.js")>();
	return { ...actual, logLatency: vi.fn() };
});

describe("review graph service", () => {
	afterEach(() => {
		// Backstop for the Date.prototype.toISOString spy used below: if a
		// test's awaited build rejects before its own try/finally restore
		// runs, this still clears the pin before the next test in the file
		// (#2446 F1).
		vi.restoreAllMocks();
	});

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
			facts.setBoundedSessionFact(
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

	it("extracts production call edges for every JavaScript-family extension", async () => {
		const env = setupTestEnvironment("pi-lens-review-graph-javascript-");
		try {
			const calleePath = createTempFile(
				env.tmpDir,
				"src/callee.js",
				"export function helper() { return 1; }\n",
			);
			const callers = [
				["caller.js", "callerJs"],
				["caller.jsx", "callerJsx"],
				["caller.mjs", "callerMjs"],
				["caller.cjs", "callerCjs"],
			] as const;
			const callerPaths = callers.map(([file, name]) =>
				createTempFile(
					env.tmpDir,
					`src/${file}`,
					`import { helper } from "./callee.js";\nexport function ${name}() { return helper(); }\n`,
				),
			);

			const graph = await buildOrUpdateGraph(env.tmpDir, [], new FactStore());
			const helperNode = [...graph.nodes.values()].find(
				(node) =>
					node.symbolName === "helper" &&
					node.filePath === normalizeMapKey(calleePath),
			);
			expect(helperNode).toBeDefined();
			for (const [index, [, name]] of callers.entries()) {
				const callerPath = normalizeMapKey(callerPaths[index]);
				const callerNode = [...graph.nodes.values()].find(
					(node) => node.symbolName === name && node.filePath === callerPath,
				);
				expect(callerNode, `${name} was not extracted`).toBeDefined();
				expect(
					graph.edges.some(
						(edge) =>
							edge.kind === "calls" &&
							edge.from === callerNode?.id &&
							edge.to === helperNode?.id,
					),
				).toBe(true);
				const fileNode = graph.nodes.get(`file:${callerPath}`);
				expect(fileNode?.metadata?.extractionCoverage).toMatchObject({
					calls: "complete",
				});
			}
		} finally {
			clearReviewGraphWorkspaceCache();
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
				graph.edges.some((e) => e.from === `file:${normalizeMapKey(testPath)}`),
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

	it("getGraphSourceFiles matches the graph's canonical file set", async () => {
		const env = setupTestEnvironment("pi-lens-review-graph-source-set-");
		const previousMaxBytes = process.env.PI_LENS_REVIEW_GRAPH_MAX_FILE_BYTES;
		try {
			const sourcePath = createTempFile(env.tmpDir, "src/source.ts", "x");
			const testPath = createTempFile(env.tmpDir, "src/source.test.ts", "x");
			const oversizedPath = createTempFile(
				env.tmpDir,
				"src/oversized.ts",
				"this file is deliberately oversized\n",
			);
			process.env.PI_LENS_REVIEW_GRAPH_MAX_FILE_BYTES = "2";

			const result = await getGraphSourceFiles(env.tmpDir);
			expect(result.files).toContain(normalizeMapKey(sourcePath));
			expect(result.files).not.toContain(normalizeMapKey(testPath));
			expect(result.files).not.toContain(normalizeMapKey(oversizedPath));
		} finally {
			if (previousMaxBytes === undefined)
				delete process.env.PI_LENS_REVIEW_GRAPH_MAX_FILE_BYTES;
			else process.env.PI_LENS_REVIEW_GRAPH_MAX_FILE_BYTES = previousMaxBytes;
			env.cleanup();
		}
	});

	it("memoizes raw source spellings across consecutive builds (#2072)", async () => {
		const env = setupTestEnvironment("pi-lens-review-graph-source-memo-");
		try {
			createTempFile(env.tmpDir, "src/a.ts", "export const a = 1;\n");
			createTempFile(env.tmpDir, "src/b.ts", "export const b = 2;\n");
			_resetReviewGraphSourcePathMemoForTests();

			const first = await getGraphSourceFiles(env.tmpDir);
			const second = await getGraphSourceFiles(env.tmpDir);

			expect(first.pathNormalizeCalls).toBe(first.files.length);
			expect(second.pathNormalizeCalls).toBe(0);
			expect(second.files).toEqual(first.files);
		} finally {
			_resetReviewGraphSourcePathMemoForTests();
			env.cleanup();
		}
	});

	it("recomputes a recreated mixed-case spelling after a missing walk entry (#2072 F2/F3)", async () => {
		const env = setupTestEnvironment("pi-lens-review-graph-source-memo-ghost-");
		const victim = path.join(env.tmpDir, "src", "MiXeD-victim.ts");
		let visited = 0;
		try {
			for (let i = 0; i < 301; i++) {
				createTempFile(
					env.tmpDir,
					`src/${i === 0 ? "MiXeD-victim" : `file-${String(i).padStart(3, "0")}`}.ts`,
					`export const value${i} = ${i};\n`,
				);
			}
			_resetReviewGraphSourcePathMemoForTests();
			_setReviewGraphEntryCounterForTests(() => {
				visited++;
				// src/ plus the 301 files: delete the victim after the walker has
				// collected its raw spelling, but before normalization begins.
				if (visited === 302) fs.rmSync(victim, { force: true });
			});
			await getGraphSourceFiles(env.tmpDir);
			expect(visited).toBeGreaterThanOrEqual(302);
			expect(fs.existsSync(victim)).toBe(false);
			createTempFile(
				env.tmpDir,
				"src/MiXeD-victim.ts",
				"export const value = 1;\n",
			);
			_setReviewGraphEntryCounterForTests();
			const freshSources = await getGraphSourceFiles(env.tmpDir);
			expect(freshSources.files).toContain(normalizeMapKey(victim));
			const second = await buildOrUpdateGraph(env.tmpDir, [], new FactStore());
			expect(second.persistCoverage?.persistedFiles).toBe(
				second.persistCoverage?.totalFiles,
			);
			expect(second.fileNodes.has(normalizeMapKey(victim))).toBe(true);
		} finally {
			_setReviewGraphEntryCounterForTests();
			_resetReviewGraphSourcePathMemoForTests();
			env.cleanup();
		}
	}, 30_000);

	it("keeps an 8,000-file one-file rebuild within the changed-file bound (#2072 AC2)", async () => {
		const env = setupTestEnvironment("pi-lens-review-graph-source-memo-scale-");
		const previousMaxFiles = process.env.PI_LENS_REVIEW_GRAPH_MAX_FILES;
		try {
			process.env.PI_LENS_REVIEW_GRAPH_MAX_FILES = "8000";
			for (let i = 0; i < 8000; i++) {
				createTempFile(
					env.tmpDir,
					`src/file-${String(i).padStart(4, "0")}.ts`,
					`export const value${i} = ${i};\n`,
				);
			}
			_resetReviewGraphSourcePathMemoForTests();

			const cold = await getGraphSourceFiles(env.tmpDir);
			createTempFile(
				env.tmpDir,
				"src/file-0000.ts",
				"export const value0 = 1;\n",
			);
			const warm = await getGraphSourceFiles(env.tmpDir);

			// Cold behavior is O(project-files); the one-file rebuild's warm path
			// must stay within 2 x changedFiles, and this fixture changes one file.
			expect(cold.files).toHaveLength(8000);
			expect(cold.pathNormalizeCalls).toBe(8000);
			expect(warm.pathNormalizeCalls).toBeLessThanOrEqual(2);
			expect(warm.files).toEqual(cold.files);
		} finally {
			_resetReviewGraphSourcePathMemoForTests();
			if (previousMaxFiles === undefined)
				delete process.env.PI_LENS_REVIEW_GRAPH_MAX_FILES;
			else process.env.PI_LENS_REVIEW_GRAPH_MAX_FILES = previousMaxFiles;
			env.cleanup();
		}
	}, 120_000);

	it("keeps a walk's normalize counter stable across workspace eviction (#2072 F4)", async () => {
		const env = setupTestEnvironment(
			"pi-lens-review-graph-source-memo-eviction-",
		);
		const evictions: Array<Promise<unknown>> = [];
		let raced = false;
		try {
			for (let i = 0; i < 24; i++) {
				createTempFile(
					env.tmpDir,
					`src/file-${i}.ts`,
					`export const value${i} = ${i};\n`,
				);
			}
			_setReviewGraphEntryCounterForTests(() => {
				if (raced) return;
				raced = true;
				for (let i = 0; i < 9; i++) {
					const cwd = path.join(env.tmpDir, `workspace-${i}`);
					createTempFile(cwd, "src/other.ts", "export const other = 1;\n");
					evictions.push(getGraphSourceFiles(cwd));
				}
			});
			const warm = await getGraphSourceFiles(env.tmpDir);
			await Promise.all(evictions);
			expect(warm.pathNormalizeCalls).toBe(warm.files.length);
		} finally {
			_setReviewGraphEntryCounterForTests();
			_resetReviewGraphSourcePathMemoForTests();
			env.cleanup();
		}
	});

	// The case variant only aliases the same workspace on Windows, so the gate
	// is declarative: an early return mid-body reported a PASS on every Linux
	// CI run while asserting nothing (#2089). `it.skipIf` prints no reason, so
	// the name carries it.
	// lane: windows-vitest
	it.skipIf(process.platform !== "win32")(
		"case-variant workspace clears invalidate the source-path memo, on win32 only (#2072 F5)",
		async () => {
			const env = setupTestEnvironment(
				"pi-lens-review-graph-source-memo-clear-",
			);
			try {
				createTempFile(env.tmpDir, "src/a.ts", "export const a = 1;\n");
				_resetReviewGraphSourcePathMemoForTests();
				const first = await getGraphSourceFiles(env.tmpDir);
				const variant = env.tmpDir.replace(/[A-Za-z](?=[^\\/]*$)/, (c) =>
					c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase(),
				);
				clearReviewGraphWorkspaceCache(variant);
				const second = await getGraphSourceFiles(env.tmpDir);
				expect(second.pathNormalizeCalls).toBe(first.files.length);
			} finally {
				_resetReviewGraphSourcePathMemoForTests();
				env.cleanup();
			}
		},
	);

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
			// Deliberately pinned to "v3", below REVIEW_GRAPH_VERSION, to exercise
			// the legacy-migration rejection path itself (the #1082/#1106
			// vacuous-fixture class: a future bump to "v3" would silently
			// un-exercise this).
			expect(REVIEW_GRAPH_VERSION).not.toBe("v3");
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
			const { getCachedReviewGraph } =
				await import("../../clients/review-graph/builder.js");
			expect(getCachedReviewGraph(env.tmpDir)).toBeUndefined();

			// A real build produces a fresh v8 graph with the new ID shape, not the
			// old one, and is no longer flagged as needing migration.
			createTempFile(
				env.tmpDir,
				"src/a.ts",
				"export function alpha() {\n  return 1;\n}\n",
			);
			const graph = await buildOrUpdateGraph(env.tmpDir, [], new FactStore());
			expect(graph.version).toBe(REVIEW_GRAPH_VERSION);
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
			// Deliberately pinned to "v4", below REVIEW_GRAPH_VERSION, to exercise
			// the legacy-migration rejection path itself (the #1082/#1106
			// vacuous-fixture class: a future bump to "v4" would silently
			// un-exercise this).
			expect(REVIEW_GRAPH_VERSION).not.toBe("v4");
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

			const { getCachedReviewGraph } =
				await import("../../clients/review-graph/builder.js");
			expect(getCachedReviewGraph(env.tmpDir)).toBeUndefined();

			createTempFile(
				env.tmpDir,
				"src/types.ts",
				"export interface Foo {\n  a: number;\n}\n",
			);
			const graph = await buildOrUpdateGraph(env.tmpDir, [], new FactStore());
			expect(graph.version).toBe(REVIEW_GRAPH_VERSION);
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
			const graph = await buildOrUpdateGraph(env.tmpDir, [aPath], facts);

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
			facts.setBoundedSessionFact(
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
			facts.setBoundedSessionFact(
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
			const initialGraph = await buildOrUpdateGraph(env.tmpDir, [aPath], facts);
			clearGraphCache();
			createTempFile(
				env.tmpDir,
				"src/a.ts",
				"export function alpha() { return 222; }\n",
			);
			await new Promise((resolve) => setTimeout(resolve, 5));

			// #2441: pin the clock so this rebuild's `builtAt` lands in the SAME
			// millisecond as `initialGraph.builtAt`, deterministically — wall-clock
			// ISO strings are allowed to collide between two builds (the `setTimeout`
			// above only nudges mtime, it never guaranteed a distinct ms).
			// `buildGeneration` (`builder.ts`'s process-wide `_graphGenerationCounter`)
			// is bumped only on a real re-extract (#459) and is the field that must
			// move here.
			// #2446 F1: try/finally so a rejecting build still restores the
			// process-global Date.prototype spy instead of leaking it to later
			// tests in this file.
			const isoSpy = vi
				.spyOn(Date.prototype, "toISOString")
				.mockReturnValue(initialGraph.builtAt);
			try {
				const graph = await buildOrUpdateGraph(env.tmpDir, [aPath], facts);
				expect(getLastGraphBuildInfo()).toMatchObject({ mode: "incremental" });
				// #2446 F2: assert the pin fired rather than the mocked artifact
				// (`graph.builtAt`), so a future clock refactor doesn't red this.
				expect(isoSpy).toHaveBeenCalled();
				expect(graph.buildGeneration).not.toBe(initialGraph.buildGeneration);
				const impact = computeImpactCascade(graph, aPath);
				expect(impact.directImporters).toContain(normalizeMapKey(bPath));
				expect(impact.directCallers).toContain(normalizeMapKey(bPath));
			} finally {
				vi.restoreAllMocks();
			}
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
			facts.setBoundedSessionFact(
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

	it("logs a review_graph_size_skip latency phase on truncation (#775 R3: no silent caps)", async () => {
		const env = setupTestEnvironment("pi-lens-review-graph-cap-log-");
		const previous = process.env.PI_LENS_REVIEW_GRAPH_MAX_FILES;
		process.env.PI_LENS_REVIEW_GRAPH_MAX_FILES = "2";
		(logLatency as ReturnType<typeof vi.fn>).mockClear();
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
			await buildOrUpdateGraph(env.tmpDir, [changedPath], facts);

			const calls = (logLatency as ReturnType<typeof vi.fn>).mock.calls;
			const skipCall = calls.find(
				(args) => args[0]?.phase === "review_graph_size_skip",
			);
			expect(skipCall).toBeDefined();
			expect(skipCall?.[0]).toMatchObject({
				type: "phase",
				phase: "review_graph_size_skip",
				metadata: expect.objectContaining({
					maxFileCount: 2,
				}),
			});
			expect(skipCall?.[0]?.metadata?.sourceFileCount).toBeGreaterThan(2);
			expect(skipCall?.[0]?.metadata?.sourceFileCountLabel).toBe(
				"more than 2 files",
			);
		} finally {
			if (previous === undefined)
				delete process.env.PI_LENS_REVIEW_GRAPH_MAX_FILES;
			else process.env.PI_LENS_REVIEW_GRAPH_MAX_FILES = previous;
			env.cleanup();
		}
	});

	it("stops the size-gate walk at cap+1 visited entries", async () => {
		const env = setupTestEnvironment("pi-lens-review-graph-cap-bound-");
		const previous = process.env.PI_LENS_REVIEW_GRAPH_MAX_FILES;
		process.env.PI_LENS_REVIEW_GRAPH_MAX_FILES = "3";
		let visited = 0;
		_setReviewGraphEntryCounterForTests(() => {
			visited += 1;
		});
		try {
			for (let i = 0; i < 12; i += 1) {
				createTempFile(
					env.tmpDir,
					`source-${i}.ts`,
					`export const source${i} = ${i};\n`,
				);
			}
			await buildOrUpdateGraph(env.tmpDir, [], new FactStore());
			expect(getLastGraphBuildInfo()).toMatchObject({
				mode: "skipped",
				skipReason: "too_many_files",
				maxFileCount: 3,
			});
			expect(visited).toBeLessThanOrEqual(4);
		} finally {
			_setReviewGraphEntryCounterForTests();
			if (previous === undefined)
				delete process.env.PI_LENS_REVIEW_GRAPH_MAX_FILES;
			else process.env.PI_LENS_REVIEW_GRAPH_MAX_FILES = previous;
			env.cleanup();
		}
	});

	it("keeps the complete under-cap walk and does not report a near miss", async () => {
		const env = setupTestEnvironment("pi-lens-review-graph-cap-under-");
		const previous = process.env.PI_LENS_REVIEW_GRAPH_MAX_FILES;
		process.env.PI_LENS_REVIEW_GRAPH_MAX_FILES = "3";
		let visited = 0;
		_setReviewGraphEntryCounterForTests(() => {
			visited += 1;
		});
		(logLatency as ReturnType<typeof vi.fn>).mockClear();
		try {
			for (let i = 0; i < 2; i += 1) {
				createTempFile(
					env.tmpDir,
					`source-${i}.ts`,
					`export const source${i} = ${i};\n`,
				);
			}
			const graph = await buildOrUpdateGraph(env.tmpDir, [], new FactStore());
			expect(getLastGraphBuildInfo()?.skipReason).not.toBe("too_many_files");
			expect(graph.fileNodes.size).toBe(2);
			expect(visited).toBe(2);
			expect(
				(logLatency as ReturnType<typeof vi.fn>).mock.calls.some(
					(args) => args[0]?.phase === "review_graph_size_near_miss",
				),
			).toBe(false);
		} finally {
			_setReviewGraphEntryCounterForTests();
			if (previous === undefined)
				delete process.env.PI_LENS_REVIEW_GRAPH_MAX_FILES;
			else process.env.PI_LENS_REVIEW_GRAPH_MAX_FILES = previous;
			env.cleanup();
		}
	});

	it("logs a distinct near-miss event within 5% of the cap", async () => {
		const env = setupTestEnvironment("pi-lens-review-graph-near-miss-");
		const previous = process.env.PI_LENS_REVIEW_GRAPH_MAX_FILES;
		process.env.PI_LENS_REVIEW_GRAPH_MAX_FILES = "20";
		(logLatency as ReturnType<typeof vi.fn>).mockClear();
		try {
			for (let i = 0; i < 21; i += 1) {
				createTempFile(
					env.tmpDir,
					`source-${i}.ts`,
					`export const source${i} = ${i};\n`,
				);
			}
			await buildOrUpdateGraph(env.tmpDir, [], new FactStore());
			const nearMissCall = (
				logLatency as ReturnType<typeof vi.fn>
			).mock.calls.find(
				(args) => args[0]?.phase === "review_graph_size_near_miss",
			);
			expect(nearMissCall?.[0]).toMatchObject({
				phase: "review_graph_size_near_miss",
				metadata: expect.objectContaining({
					maxFileCount: 20,
					sourceFileCount: 21,
					sourceFileCountLabel: "more than 20 files",
				}),
			});
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

describe("review graph - workspace-package bare specifiers (#775)", () => {
	afterEach(() => {
		clearReviewGraphWorkspaceCache();
		clearModuleGraphCache();
	});

	it("resolves a bare specifier pointing at a sibling workspace package to a file-level import edge", async () => {
		const env = setupTestEnvironment("pi-lens-review-graph-workspace-");
		try {
			createTempFile(
				env.tmpDir,
				"package.json",
				JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
			);
			createTempFile(
				env.tmpDir,
				"packages/b/package.json",
				JSON.stringify({ name: "@scope/b", main: "src/index.ts" }),
			);
			const bEntry = createTempFile(
				env.tmpDir,
				"packages/b/src/index.ts",
				"export const b = 1;\n",
			);
			const aPath = createTempFile(
				env.tmpDir,
				"packages/a/src/index.ts",
				"import { b } from '@scope/b';\nexport function useB() { return b; }\n",
			);

			clearModuleGraphCache();
			const graph = await buildOrUpdateGraph(env.tmpDir, [], new FactStore());
			const aId = `file:${normalizeMapKey(aPath)}`;
			const bId = `file:${normalizeMapKey(bEntry)}`;
			expect(graph.nodes.has(bId)).toBe(true);
			expect(
				graph.edges.some(
					(e) => e.from === aId && e.to === bId && e.kind === "imports",
				),
			).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("resolves a workspace-package subpath import to a file within the package", async () => {
		const env = setupTestEnvironment("pi-lens-review-graph-workspace-subpath-");
		try {
			createTempFile(
				env.tmpDir,
				"package.json",
				JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
			);
			createTempFile(
				env.tmpDir,
				"packages/b/package.json",
				JSON.stringify({ name: "@scope/b" }),
			);
			const bUtil = createTempFile(
				env.tmpDir,
				"packages/b/src/utils.ts",
				"export const util = 1;\n",
			);
			const aPath = createTempFile(
				env.tmpDir,
				"packages/a/src/index.ts",
				"import { util } from '@scope/b/src/utils';\n",
			);

			clearModuleGraphCache();
			const graph = await buildOrUpdateGraph(env.tmpDir, [], new FactStore());
			const aId = `file:${normalizeMapKey(aPath)}`;
			const bId = `file:${normalizeMapKey(bUtil)}`;
			expect(
				graph.edges.some(
					(e) => e.from === aId && e.to === bId && e.kind === "imports",
				),
			).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("a non-workspace bare specifier stays an external node, not a fabricated file edge", async () => {
		const env = setupTestEnvironment(
			"pi-lens-review-graph-workspace-external-",
		);
		try {
			createTempFile(
				env.tmpDir,
				"package.json",
				JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
			);
			createTempFile(
				env.tmpDir,
				"packages/b/package.json",
				JSON.stringify({ name: "@scope/b" }),
			);
			const aPath = createTempFile(
				env.tmpDir,
				"packages/a/src/index.ts",
				"import React from 'react';\n",
			);

			clearModuleGraphCache();
			const graph = await buildOrUpdateGraph(env.tmpDir, [], new FactStore());
			const aId = `file:${normalizeMapKey(aPath)}`;
			expect(
				graph.edges.some(
					(e) =>
						e.from === aId && e.kind === "imports" && e.to === "external:react",
				),
			).toBe(true);
		} finally {
			env.cleanup();
		}
	});
});
