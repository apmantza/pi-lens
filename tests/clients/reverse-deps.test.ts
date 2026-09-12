import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import {
	PROJECT_SNAPSHOT_VERSION,
	loadProjectSnapshot,
	saveProjectSnapshot,
	saveRuntimeProjectSnapshot,
	waitForProjectSnapshotPersistsForTests,
} from "../../clients/project-snapshot.js";
import {
	buildReverseDependencyIndexFromGraph,
	buildReverseDependencyIndexFromSnapshot,
	getAffectedFilesFromIndex,
	getReverseDepsFromIndex,
	loadReverseDependencyIndexFromSnapshot,
	patchReverseDependencyIndex,
	writeReverseDependencyIndexToSnapshot,
} from "../../clients/reverse-deps.js";
import { buildOrUpdateGraph } from "../../clients/review-graph/service.js";
import type {
	ReviewGraph,
	ReviewGraphEdge,
	ReviewGraphNode,
} from "../../clients/review-graph/types.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import {
	cleanupTestEnvironments,
	createTempFile,
	setupTestEnvironment,
} from "./test-utils.js";

describe("reverse dependency index", () => {
	const cleanupReverseDepsTemps = async () => {
		// Snapshot persistence can enqueue filesystem work after a test resolves.
		// Drain several macrotasks before removing this family's fixtures; clean
		// after each tick so delayed work cannot recreate an earlier root.
		await waitForProjectSnapshotPersistsForTests();
		for (let tick = 0; tick < 3; tick++) {
			await new Promise<void>((resolve) => setImmediate(resolve));
			cleanupTestEnvironments("pi-lens-reverse-deps-", {
				// Keep the root tracked across intermediate drains so deferred
				// snapshot work can be removed if it recreates the root.
				untrack: tick === 2,
			});
		}
	};

	afterEach(cleanupReverseDepsTemps);
	afterAll(cleanupReverseDepsTemps);

	it(
		"patches random single-file mutations equivalently to a full rebuild",
		{
			timeout: 30_000,
		},
		() => {
			let state = 0x939_0003;
			const random = () => {
				state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
				return state / 0x1_0000_0000;
			};
			const cwd = normalizeMapKey(path.resolve("reverse-deps-random"));
			const files = Array.from({ length: 24 }, (_, index) =>
				normalizeMapKey(path.join(cwd, `file-${index}.ts`)),
			);
			const targetsByFile = new Map<string, Set<string>>(
				files.map((file) => [file, new Set<string>()]),
			);
			const graphFromState = (): ReviewGraph => {
				const nodes = new Map<string, ReviewGraphNode>();
				const edges: ReviewGraphEdge[] = [];
				const fileNodes = new Map<string, string>();
				for (const file of targetsByFile.keys()) {
					const id = `file:${file}`;
					nodes.set(id, {
						id,
						kind: "file",
						language: "typescript",
						filePath: file,
					});
					fileNodes.set(file, id);
				}
				for (const [file, targets] of targetsByFile) {
					for (const target of targets) {
						if (!targetsByFile.has(target) || target === file) continue;
						edges.push({
							from: `file:${file}`,
							to: `file:${target}`,
							kind: "imports",
						});
					}
				}
				return {
					version: "test",
					builtAt: "test",
					nodes,
					edges,
					edgesByFrom: new Map(),
					edgesByTo: new Map(),
					fileNodes,
					symbolNodesByFile: new Map(),
					changedSymbolsByFile: new Map(),
				};
			};

			let patched = buildReverseDependencyIndexFromGraph({
				cwd,
				graph: graphFromState(),
			});
			for (let iteration = 0; iteration < 50; iteration++) {
				const file = files[Math.floor(random() * files.length)];
				const prior = [...(targetsByFile.get(file) ?? [])].sort();
				const next = new Set(prior);
				const target = files[Math.floor(random() * files.length)];
				if (next.has(target)) next.delete(target);
				else if (target !== file) next.add(target);
				targetsByFile.set(file, next);
				patched = patchReverseDependencyIndex(patched, [
					{
						filePath: file,
						existedBefore: true,
						existsAfter: true,
						priorTargets: prior,
						newTargets: [...next].sort(),
					},
				]);
				const rebuilt = buildReverseDependencyIndexFromGraph({
					cwd,
					graph: graphFromState(),
				});
				rebuilt.generatedAt = patched.generatedAt;
				expect(patched).toEqual(rebuilt);
			}
		},
	);

	it("builds reverse dependency lookups from the review graph", async () => {
		const env = setupTestEnvironment("pi-lens-reverse-deps-");
		try {
			const aPath = createTempFile(
				env.tmpDir,
				"src/a.ts",
				"export const alpha = 1;\n",
			);
			const bPath = createTempFile(
				env.tmpDir,
				"src/b.ts",
				"import { alpha } from './a';\nexport const beta = alpha;\n",
			);
			const cPath = createTempFile(
				env.tmpDir,
				"src/c.ts",
				"import { beta } from './b';\nexport const gamma = beta;\n",
			);

			const graph = await buildOrUpdateGraph(
				env.tmpDir,
				[aPath],
				new FactStore(),
			);
			const index = buildReverseDependencyIndexFromGraph({
				cwd: env.tmpDir,
				graph,
			});

			expect(getReverseDepsFromIndex(index, aPath)).toEqual([
				normalizeMapKey(bPath),
			]);
			expect(getAffectedFilesFromIndex(index, aPath, 2)).toEqual([
				normalizeMapKey(bPath),
				normalizeMapKey(cPath),
			]);
		} finally {
			env.cleanup();
		}
	});

	it("persists and reloads reverse dependencies through the project snapshot", async () => {
		const env = setupTestEnvironment("pi-lens-reverse-deps-snapshot-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const aPath = createTempFile(
				env.tmpDir,
				"src/a.ts",
				"export const alpha = 1;\n",
			);
			const bPath = createTempFile(
				env.tmpDir,
				"src/b.ts",
				"import { alpha } from './a';\nexport const beta = alpha;\n",
			);
			const graph = await buildOrUpdateGraph(
				env.tmpDir,
				[aPath],
				new FactStore(),
			);
			const index = buildReverseDependencyIndexFromGraph({
				cwd: env.tmpDir,
				graph,
				seq: 3,
			});
			saveProjectSnapshot(env.tmpDir, {
				version: PROJECT_SNAPSHOT_VERSION,
				projectRoot: env.tmpDir,
				generatedAt: new Date().toISOString(),
				seq: 3,
				files: {},
				symbols: {},
				reverseDeps: {},
				cachedExports: [],
			});

			expect(
				writeReverseDependencyIndexToSnapshot({ cwd: env.tmpDir, index }),
			).toBe(true);
			const snapshot = loadProjectSnapshot(env.tmpDir);
			expect(snapshot?.reverseDeps[normalizeMapKey(aPath)]).toEqual([
				normalizeMapKey(bPath),
			]);
			expect(snapshot?.files[normalizeMapKey(bPath)]?.imports).toEqual([
				normalizeMapKey(aPath),
			]);

			const loaded = loadReverseDependencyIndexFromSnapshot({
				cwd: env.tmpDir,
				currentProjectSeq: 3,
			});
			expect(loaded).not.toBeNull();
			expect(loaded?.source).toBe("project-snapshot");
			expect(loaded && getReverseDepsFromIndex(loaded, aPath)).toEqual([
				normalizeMapKey(bPath),
			]);
			expect(
				loadReverseDependencyIndexFromSnapshot({
					cwd: env.tmpDir,
					currentProjectSeq: 4,
				}),
			).toBeNull();
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});

	it("preserves cached reverse dependencies when saving runtime snapshots", () => {
		const env = setupTestEnvironment("pi-lens-reverse-deps-preserve-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const aPath = normalizeMapKey(path.join(env.tmpDir, "src/a.ts"));
			const bPath = normalizeMapKey(path.join(env.tmpDir, "src/b.ts"));
			saveProjectSnapshot(env.tmpDir, {
				version: PROJECT_SNAPSHOT_VERSION,
				projectRoot: env.tmpDir,
				generatedAt: new Date().toISOString(),
				seq: 5,
				files: {
					[bPath]: {
						path: bPath,
						mtimeMs: 1,
						size: 10,
						imports: [aPath],
						lastSeq: 0,
					},
				},
				symbols: {},
				reverseDeps: { [aPath]: [bPath] },
				cachedExports: [],
			});
			const runtime = new RuntimeCoordinator();
			runtime.seedProjectSequence(5);
			runtime.cachedExports.set("alpha", aPath);

			saveRuntimeProjectSnapshot({ cwd: env.tmpDir, runtime });
			const snapshot = loadProjectSnapshot(env.tmpDir);
			expect(snapshot?.cachedExports).toEqual([["alpha", aPath]]);
			expect(
				buildReverseDependencyIndexFromSnapshot(snapshot!)?.importedBy,
			).toEqual({
				[aPath]: [bPath],
				[bPath]: [],
			});
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});

	it("retries a recreated reverse-deps root while tracking is retained", () => {
		const env = setupTestEnvironment("pi-lens-reverse-deps-recreated-");
		try {
			cleanupTestEnvironments("pi-lens-reverse-deps-recreated-", {
				// This models deferred work recreating the root after an early
				// cleanup pass; the shipped defect untracked it at that point.
				untrack: false,
			});
			fs.mkdirSync(env.tmpDir, { recursive: true });
			cleanupTestEnvironments("pi-lens-reverse-deps-recreated-", {
				untrack: false,
			});
			expect(fs.existsSync(env.tmpDir)).toBe(false);
		} finally {
			cleanupTestEnvironments("pi-lens-reverse-deps-recreated-");
		}
	});

	// #1814 F2: `clients/lsp/workspace-diagnostics-cache.ts`'s `getImports`
	// reads `ReverseDependencyIndex.imports[key]` directly and relies on
	// `undefined` meaning "this file was never covered by the scan that built
	// this index" — distinct from `[]`, "covered, confirmed zero imports".
	// This index itself used to fabricate the `[]` claim for files it never
	// scanned, one layer below #1814's original fix in
	// workspace-diagnostics-cache.ts.
	describe("imports map does not fabricate coverage (#1814 F2)", () => {
		const cwd = normalizeMapKey(path.resolve("reverse-deps-1814-f2"));

		// Reviewer probe (a): `normalizeIndex` used to materialize
		// `imports[file] = []` for every key in the UNION of `imports` and
		// `importedBy`, so a file known ONLY as another file's import
		// target — never itself scanned — read as "covered, zero imports".
		it("does not fabricate an imports entry for a file known only as an import target", () => {
			const aPath = normalizeMapKey(path.join(cwd, "a.ts"));
			const bPath = normalizeMapKey(path.join(cwd, "b.ts"));
			const index = buildReverseDependencyIndexFromSnapshot({
				version: PROJECT_SNAPSHOT_VERSION,
				projectRoot: cwd,
				generatedAt: new Date().toISOString(),
				seq: 1,
				files: {
					[bPath]: {
						path: bPath,
						mtimeMs: 0,
						size: 0,
						imports: [aPath],
						lastSeq: 0,
					},
				},
				symbols: {},
				reverseDeps: {},
				cachedExports: [],
			});
			// b.ts was genuinely scanned: its own imports list is real.
			expect(index?.imports[bPath]).toEqual([aPath]);
			// a.ts was never scanned itself — only known as b.ts's import
			// target. Fabricating `imports[aPath] = []` claims "a.ts
			// confirmed zero imports", indistinguishable downstream from a
			// file the scan actually covered.
			expect(index?.imports[aPath]).toBeUndefined();
			// a.ts genuinely IS known to be imported by b.ts — importedBy
			// carries no such "was I scanned" precondition and is unchanged.
			expect(index?.importedBy[aPath]).toEqual([bPath]);
		});

		// Reviewer probe (b): a snapshot file entry with no `imports` field
		// at all — the exact per-entry state `hasFileImports`'s `.some()`
		// guard anticipates existing alongside scanned entries in a mixed
		// snapshot — used to default to `[]` via `?? []`.
		it("does not fabricate an imports entry for a snapshot file with no imports field recorded", () => {
			const scannedPath = normalizeMapKey(path.join(cwd, "scanned.ts"));
			const unscannedPath = normalizeMapKey(path.join(cwd, "unscanned.ts"));
			const index = buildReverseDependencyIndexFromSnapshot({
				version: PROJECT_SNAPSHOT_VERSION,
				projectRoot: cwd,
				generatedAt: new Date().toISOString(),
				seq: 1,
				files: {
					[scannedPath]: {
						path: scannedPath,
						mtimeMs: 0,
						size: 0,
						imports: [],
						lastSeq: 0,
					},
					// No `imports` field: a lightweight snapshot entry (e.g.
					// a touch that never ran the import scan).
					[unscannedPath]: {
						path: unscannedPath,
						mtimeMs: 0,
						size: 0,
						lastSeq: 0,
					},
				},
				symbols: {},
				reverseDeps: {},
				cachedExports: [],
			});
			// scanned.ts genuinely recorded zero imports — real coverage.
			expect(index?.imports[scannedPath]).toEqual([]);
			// unscanned.ts never recorded an imports field — must not read
			// as "covered, zero imports".
			expect(index?.imports[unscannedPath]).toBeUndefined();
		});

		// Class-sweep finding: `snapshot.reverseDeps` (a separate persisted
		// "who imports me" map) merges into the SAME raw `index.imports`
		// object the two probes above guard, via its own `??= []` — a third
		// fabrication source inside `buildReverseDependencyIndexFromSnapshot`
		// that neither probe (a)'s nor probe (b)'s fix touches, since it
		// mutates `index.imports` directly before `normalizeIndex` ever runs.
		it("does not fabricate an imports entry via the reverseDeps merge for a file only known as an import target there", () => {
			const aPath = normalizeMapKey(path.join(cwd, "ra.ts"));
			const bPath = normalizeMapKey(path.join(cwd, "rb.ts"));
			const index = buildReverseDependencyIndexFromSnapshot({
				version: PROJECT_SNAPSHOT_VERSION,
				projectRoot: cwd,
				generatedAt: new Date().toISOString(),
				seq: 1,
				files: {},
				symbols: {},
				// a.ts is known ONLY via reverseDeps (b.ts imports it) —
				// neither file has a `files` entry, so neither was scanned.
				reverseDeps: { [aPath]: [bPath] },
				cachedExports: [],
			});
			expect(index?.imports[aPath]).toBeUndefined();
			// b.ts is also unscanned (no `files` entry) — the reverseDeps
			// merge must not promote "we know b.ts imports a.ts" (one edge)
			// into "we know b.ts's complete import list".
			expect(index?.imports[bPath]).toBeUndefined();
			expect(index?.importedBy[aPath]).toEqual([bPath]);
		});

		// Mutation-proof / inversion set (reviewer's explicit re-run ask): a
		// genuinely covered zero-import file must still serve as covered,
		// and a real dependency edge must still be visible for the
		// mtime-check loop to walk — the fabrication fix must not flip
		// legitimate `[]` entries to `undefined`.
		it("still reports a genuinely scanned zero-import file as covered", () => {
			const gPath = normalizeMapKey(path.join(cwd, "g.ts"));
			const index = buildReverseDependencyIndexFromSnapshot({
				version: PROJECT_SNAPSHOT_VERSION,
				projectRoot: cwd,
				generatedAt: new Date().toISOString(),
				seq: 1,
				files: {
					[gPath]: {
						path: gPath,
						mtimeMs: 0,
						size: 0,
						imports: [],
						lastSeq: 0,
					},
				},
				symbols: {},
				reverseDeps: {},
				cachedExports: [],
			});
			expect(index?.imports[gPath]).toEqual([]);
		});

		it("still reports a real dependency edge for the mtime-check loop to walk", () => {
			const aPath = normalizeMapKey(path.join(cwd, "dep-a.ts"));
			const bPath = normalizeMapKey(path.join(cwd, "dep-b.ts"));
			const index = buildReverseDependencyIndexFromSnapshot({
				version: PROJECT_SNAPSHOT_VERSION,
				projectRoot: cwd,
				generatedAt: new Date().toISOString(),
				seq: 1,
				files: {
					[bPath]: {
						path: bPath,
						mtimeMs: 0,
						size: 0,
						imports: [aPath],
						lastSeq: 0,
					},
				},
				symbols: {},
				reverseDeps: {},
				cachedExports: [],
			});
			expect(index?.imports[bPath]).toEqual([aPath]);
		});
	});
});
