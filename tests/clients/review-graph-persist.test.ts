import * as fs from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import { getProjectDataDir } from "../../clients/file-utils.js";
import {
	_resetReviewGraphBuildAttemptsForTests,
	_setReviewGraphEntryBudgetForTests,
	buildOrUpdateGraph,
	clearGraphCache,
	clearReviewGraphWorkspaceCache,
	flushReviewGraphPersist,
	flushReviewGraphPersistsForExitForTests,
	flushReviewGraphPersistsForTests,
	getCachedReviewGraph,
	getLastReviewGraphBuildAttempt,
	getReviewGraphWorkerFallbackReasonForTests,
	GRAPH_PERSIST_MAX_ELEMENTS_DEFAULT,
	type GraphSeqHint,
	resetReviewGraphPersistWorkerForTests,
	terminateReviewGraphPersistWorkerForTests,
	waitForReviewGraphPersistsForTests,
} from "../../clients/review-graph/builder.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";
import {
	flushReviewGraphLogSync,
	logReviewGraph,
} from "../../clients/review-graph-logger.js";

vi.mock("../../clients/review-graph-logger.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/review-graph-logger.js")
	>()),
	logReviewGraph: vi.fn(),
	flushReviewGraphLogSync: vi.fn(),
}));

// Circuit-breaker for the review-graph persist (#260): the whole-graph
// JSON.stringify on every edit turn spiked the host into a Zone OOM. These cover
// the two guards — element-count ceiling (skip) and debounce (coalesce/defer).

const cleanups: Array<() => void> = [];
afterEach(async () => {
	flushReviewGraphPersistsForTests(); // drain any pending debounced write/timer
	await waitForReviewGraphPersistsForTests();
	resetReviewGraphPersistWorkerForTests();
	while (cleanups.length) cleanups.pop()?.();
	clearReviewGraphWorkspaceCache();
	_resetReviewGraphBuildAttemptsForTests();
	_setReviewGraphEntryBudgetForTests();
	vi.clearAllMocks();
	// Restore the test-default synchronous persist + uncapped size.
	process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS = "0";
	delete process.env.PI_LENS_GRAPH_PERSIST_MAX_ELEMENTS;
	delete process.env.PI_LENS_REVIEW_GRAPH_MAX_FILES;
	delete process.env.PI_LENS_TEST_PERSIST_WORKER_DELAY_MS;
});

function makeEnv() {
	const env = setupTestEnvironment("pi-lens-graph-persist-");
	cleanups.push(env.cleanup);
	return env;
}

function cachePathFor(cwd: string): string {
	return path.join(getProjectDataDir(cwd), "cache", "review-graph.json.gz");
}

async function waitForFile(p: string, attempts = 20): Promise<boolean> {
	for (let i = 0; i < attempts; i++) {
		if (fs.existsSync(p)) return true;
		await new Promise((r) => setTimeout(r, 25));
	}
	return fs.existsSync(p);
}

describe("review-graph persist circuit-breaker (#260)", () => {
	it("does not re-normalize a warm graph's persisted source paths (#2072 AC1)", async () => {
		const env = makeEnv();
		try {
			const source = createTempFile(
				env.tmpDir,
				"src/warm.ts",
				"export const warm = 1;\n",
			);
			await buildOrUpdateGraph(env.tmpDir, [], new FactStore());
			flushReviewGraphPersistsForTests();
			await waitForReviewGraphPersistsForTests();
			fs.writeFileSync(source, "export const warm = 2;\n");
			const realpath = fs.realpathSync.native;
			const realpathNative = vi.spyOn(fs.realpathSync, "native");
			const stacks: string[] = [];
			realpathNative.mockImplementation((...args) => {
				stacks.push(new Error().stack ?? "");
				return realpath(...args);
			});
			realpathNative.mockClear();
			await buildOrUpdateGraph(
				env.tmpDir,
				[path.resolve(source)],
				new FactStore(),
			);
			expect(
				stacks.filter((stack) => stack.includes("countRetainedSourceFiles")),
			).toHaveLength(0);
			realpathNative.mockRestore();
		} finally {
			env.cleanup();
		}
	}, 30_000);

	it("preserves mixed-case source coverage in a persisted graph (#2072 F2/F3 AC3)", async () => {
		const env = makeEnv();
		try {
			createTempFile(env.tmpDir, "src/MiXeD.ts", "export const mixed = 1;\n");
			createTempFile(env.tmpDir, "src/other.ts", "export const other = 2;\n");
			const built = await buildOrUpdateGraph(env.tmpDir, [], new FactStore());
			flushReviewGraphPersistsForTests();
			await waitForReviewGraphPersistsForTests();
			const raw = JSON.parse(
				gunzipSync(fs.readFileSync(cachePathFor(env.tmpDir))).toString("utf-8"),
			);
			expect(raw.coverage).toEqual(
				expect.objectContaining({
					partial: false,
					totalFiles: built.fileNodes.size,
					persistedFiles: built.fileNodes.size,
				}),
			);
			expect(raw.fileSignatures).toEqual(
				expect.arrayContaining(
					[...built.fileNodes.keys()].map((filePath) =>
						expect.arrayContaining([filePath]),
					),
				),
			);
		} finally {
			env.cleanup();
		}
	});
	it("defaults to the measured 500,000-element ceiling (#936)", () => {
		expect(GRAPH_PERSIST_MAX_ELEMENTS_DEFAULT).toBe(500_000);
	});

	it("entry-budget truncation remains visibly partial through persistence", async () => {
		const env = makeEnv();
		createTempFile(env.tmpDir, "src/a.ts", "export const a = 1;\n");
		createTempFile(env.tmpDir, "src/b.ts", "export const b = 2;\n");
		_setReviewGraphEntryBudgetForTests(2);

		const built = await buildOrUpdateGraph(env.tmpDir, [], new FactStore());
		await waitForReviewGraphPersistsForTests();

		expect(built.persistCoverage).toEqual(
			expect.objectContaining({
				partial: true,
				sourceFilesTruncated: true,
				totalFiles: expect.any(Number),
				persistedFiles: expect.any(Number),
			}),
		);
		const success = vi
			.mocked(logReviewGraph)
			.mock.calls.map(([entry]) => entry)
			.find((entry) => entry.phase === "persist_succeeded");
		expect(success?.observability?.graph?.persistCoverage).toEqual(
			expect.objectContaining({ partial: true, sourceFilesTruncated: true }),
		);
		const partial = vi
			.mocked(logReviewGraph)
			.mock.calls.map(([entry]) => entry)
			.find((entry) => entry.phase === "persist_partial");
		expect(partial?.reason).toBe("source_walk_entry_budget");
	});

	it("overlapping builds use each returned graph's skip outcome", async () => {
		const env = makeEnv();
		const files: string[] = [];
		for (let i = 0; i < 20; i++) {
			files.push(
				createTempFile(
					env.tmpDir,
					`src/file-${i}.ts`,
					`export const value${i} = ${i};\n`,
				),
			);
		}
		process.env.PI_LENS_REVIEW_GRAPH_MAX_FILES = "1000";
		const fullBuild = buildOrUpdateGraph(
			env.tmpDir,
			[files[0]],
			new FactStore(),
		);
		process.env.PI_LENS_REVIEW_GRAPH_MAX_FILES = "2";
		const skippedBuild = buildOrUpdateGraph(
			env.tmpDir,
			[files[1]],
			new FactStore(),
		);
		await Promise.all([fullBuild, skippedBuild]);

		const entries = vi
			.mocked(logReviewGraph)
			.mock.calls.map(([entry]) => entry);
		expect(
			entries.some(
				(entry) =>
					entry.phase === "build_succeeded" &&
					entry.observability?.graph?.mode === "full",
			),
		).toBe(true);
		expect(
			entries.some(
				(entry) =>
					entry.phase === "build_skipped" && entry.reason === "too_many_files",
			),
		).toBe(true);
		const fullSuccess = entries.find(
			(entry) =>
				entry.phase === "build_succeeded" &&
				entry.observability?.graph?.mode === "full",
		);
		expect(fullSuccess?.reason).toBeUndefined();
		// The newer skipped attempt remains the project-report truth source even
		// when the older full build finishes afterward.
		expect(getLastReviewGraphBuildAttempt(env.tmpDir)).toMatchObject({
			outcome: "skipped",
		});
	});

	it("size cap: persists an honestly-marked useful partial graph", async () => {
		const env = makeEnv();
		createTempFile(env.tmpDir, "a.test.ts", "export const fixtureOnly = 1;\n");
		createTempFile(
			env.tmpDir,
			"a.ts",
			'import "./a.test.js";\nexport function foo() {\n  return 1;\n}\n',
		);
		createTempFile(
			env.tmpDir,
			"b.ts",
			'import { foo } from "./a.js";\nexport const r = foo();\n',
		);
		const cachePath = cachePathFor(env.tmpDir);
		// A two-file project is well above 1 element (file + symbol nodes + edges).
		process.env.PI_LENS_GRAPH_PERSIST_MAX_ELEMENTS = "4";

		const built = await buildOrUpdateGraph(
			env.tmpDir,
			[path.join(env.tmpDir, "a.ts"), path.join(env.tmpDir, "b.ts")],
			new FactStore(),
		);
		flushReviewGraphPersistsForTests();
		expect(await waitForFile(cachePath)).toBe(true);
		await waitForReviewGraphPersistsForTests();
		const raw = JSON.parse(
			gunzipSync(fs.readFileSync(cachePath)).toString("utf-8"),
		);
		expect(raw.coverage).toEqual(
			expect.objectContaining({
				partial: true,
				cap: 4,
				totalNodes: built.nodes.size,
				totalEdges: built.edges.length,
				persistedNodes: raw.nodes.length,
				persistedEdges: raw.edges.length,
				totalFiles: 2,
				persistedFiles: expect.any(Number),
			}),
		);
		expect(raw.coverage.persistedFiles).toBeLessThanOrEqual(
			raw.coverage.totalFiles,
		);
		expect(raw.nodes.length + raw.edges.length).toBeLessThanOrEqual(4);
		expect(raw.nodes.length).toBeGreaterThan(0);
		expect(
			raw.nodes.some(
				([, node]: [string, { filePath?: string }]) =>
					node.filePath?.endsWith("/a.ts") || node.filePath?.endsWith("\\a.ts"),
			),
		).toBe(true);
		const attempt = getLastReviewGraphBuildAttempt(env.tmpDir);
		expect(attempt).toMatchObject({ outcome: "succeeded" });
		expect(attempt?.reason).toMatch(
			/persisted partial review graph \(\d+\/\d+ elements/,
		);
		const entries = vi
			.mocked(logReviewGraph)
			.mock.calls.map(([entry]) => entry);
		const partial = entries.find((entry) => entry.phase === "persist_partial");
		expect(partial?.observability).toEqual({
			graph: expect.objectContaining({
				sourceFiles: 2,
				persistCoverage: expect.objectContaining({
					partial: true,
					totalNodes: built.nodes.size,
					totalEdges: built.edges.length,
				}),
			}),
			persistence: expect.objectContaining({ status: "scheduled" }),
		});
		const success = entries.find(
			(entry) => entry.phase === "persist_succeeded",
		);
		expect(success?.observability?.graph?.persistCoverage).toEqual(
			expect.objectContaining({
				partial: true,
				totalNodes: built.nodes.size,
				totalEdges: built.edges.length,
			}),
		);
	});

	it("round-trips partial coverage without presenting it as complete", async () => {
		const env = makeEnv();
		createTempFile(
			env.tmpDir,
			"hot.ts",
			"export function hot() { return 1 }\n",
		);
		createTempFile(
			env.tmpDir,
			"user.ts",
			'import { hot } from "./hot.js";\nexport const used = hot();\n',
		);
		process.env.PI_LENS_GRAPH_PERSIST_MAX_ELEMENTS = "4";
		const built = await buildOrUpdateGraph(
			env.tmpDir,
			[path.join(env.tmpDir, "hot.ts"), path.join(env.tmpDir, "user.ts")],
			new FactStore(),
		);
		flushReviewGraphPersistsForTests();
		await waitForReviewGraphPersistsForTests();

		clearReviewGraphWorkspaceCache(env.tmpDir);
		const loaded = getCachedReviewGraph(env.tmpDir);
		expect(loaded?.persistCoverage).toMatchObject({
			partial: true,
			cap: 4,
			totalNodes: built.nodes.size,
			totalEdges: built.edges.length,
		});
		expect(loaded?.persistCoverage?.persistedNodes).toBe(loaded?.nodes.size);
		expect(loaded?.persistCoverage?.persistedEdges).toBe(loaded?.edges.length);
		expect(
			(loaded?.nodes.size ?? 0) + (loaded?.edges.length ?? 0),
		).toBeLessThanOrEqual(4);
	});

	it("a partial cached graph never seeds a build (no silent-partial, no laundering; #936 review)", async () => {
		const env = makeEnv();
		createTempFile(
			env.tmpDir,
			"hot.ts",
			"export function hot() { return 1 }\n",
		);
		createTempFile(
			env.tmpDir,
			"user.ts",
			'import { hot } from "./hot.js";\nexport const used = hot();\n',
		);
		const files = [
			path.join(env.tmpDir, "hot.ts"),
			path.join(env.tmpDir, "user.ts"),
		];
		process.env.PI_LENS_GRAPH_PERSIST_MAX_ELEMENTS = "4";
		const built = await buildOrUpdateGraph(env.tmpDir, files, new FactStore());
		flushReviewGraphPersistsForTests();
		await waitForReviewGraphPersistsForTests();

		// A read consumer (symbol search / project report) warms the SHARED
		// in-memory cache with the partial snapshot via getCachedReviewGraph.
		clearReviewGraphWorkspaceCache(env.tmpDir);
		const partial = getCachedReviewGraph(env.tmpDir);
		expect(partial?.persistCoverage?.partial).toBe(true); // precondition

		// A build now shares that poisoned cache. It MUST NOT reuse or extend the
		// partial graph: the returned session graph must be the COMPLETE freshly
		// built graph (full node/edge count, no coverage marker), never the
		// capped-away partial served as authoritative.
		const rebuilt = await buildOrUpdateGraph(
			env.tmpDir,
			files,
			new FactStore(),
		);
		expect(rebuilt.persistCoverage).toBeUndefined();
		expect(rebuilt.nodes.size).toBe(built.nodes.size);
		expect(rebuilt.edges.length).toBe(built.edges.length);

		// And the on-disk snapshot stays honestly partial — an incremental
		// extension of the partial base would have re-persisted it as
		// partial:false, laundering it into a "complete" snapshot forever.
		flushReviewGraphPersistsForTests();
		await waitForReviewGraphPersistsForTests();
		const raw = JSON.parse(
			gunzipSync(fs.readFileSync(cachePathFor(env.tmpDir))).toString("utf-8"),
		);
		expect(raw.coverage?.partial).toBe(true);
	});

	it("size cap: writes normally when under the ceiling", async () => {
		const env = makeEnv();
		createTempFile(
			env.tmpDir,
			"a.ts",
			"export function foo() {\n  return 1;\n}\n",
		);
		const cachePath = cachePathFor(env.tmpDir);
		process.env.PI_LENS_GRAPH_PERSIST_MAX_ELEMENTS = "1000000";

		await buildOrUpdateGraph(
			env.tmpDir,
			[path.join(env.tmpDir, "a.ts")],
			new FactStore(),
		);
		flushReviewGraphPersistsForTests();
		expect(await waitForFile(cachePath)).toBe(true);
	});

	it("debounce: defers the write until the quiet window / flush", async () => {
		const env = makeEnv();
		createTempFile(
			env.tmpDir,
			"a.ts",
			"export function foo() {\n  return 1;\n}\n",
		);
		const cachePath = cachePathFor(env.tmpDir);
		process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS = "100000"; // effectively never

		const built = await buildOrUpdateGraph(
			env.tmpDir,
			[path.join(env.tmpDir, "a.ts")],
			new FactStore(),
		);
		const entries = vi
			.mocked(logReviewGraph)
			.mock.calls.map(([entry]) => entry);
		const started = entries.find((entry) => entry.phase === "build_started");
		const scheduled = entries.find(
			(entry) => entry.phase === "persist_scheduled",
		);
		expect(started?.observability?.graph).toEqual(
			expect.objectContaining({
				buildId: expect.any(Number),
				nodes: 0,
				edges: 0,
			}),
		);
		expect(scheduled?.observability).toEqual({
			graph: expect.objectContaining({
				graphGeneration: built.buildGeneration,
				builtAt: built.builtAt,
				sourceFiles: 1,
				nodes: built.nodes.size,
				edges: built.edges.length,
			}),
			persistence: expect.objectContaining({
				generation: expect.any(Number),
				attemptId: expect.any(Number),
				status: "scheduled",
			}),
		});
		expect(JSON.stringify(scheduled?.observability)).not.toContain(
			"export function",
		);
		expect(JSON.stringify(scheduled?.observability)).not.toContain(env.tmpDir);
		await new Promise((r) => setTimeout(r, 60));
		// Scheduled but not yet flushed → no file on disk.
		expect(fs.existsSync(cachePath)).toBe(false);

		flushReviewGraphPersistsForTests();
		expect(await waitForFile(cachePath)).toBe(true);
		const succeeded = vi
			.mocked(logReviewGraph)
			.mock.calls.find(([entry]) => entry.phase === "persist_succeeded")?.[0];
		expect(succeeded?.observability?.persistence).toEqual(
			expect.objectContaining({ status: "succeeded" }),
		);
		expect(succeeded?.observability?.persistence?.generation).toBe(
			scheduled?.observability?.persistence?.generation,
		);
		expect(succeeded?.durationMs).toEqual(expect.any(Number));
		expect(succeeded?.serializeMs).toEqual(expect.any(Number));
		expect(succeeded?.writeMs).toEqual(expect.any(Number));
		const completed = vi
			.mocked(logReviewGraph)
			.mock.calls.find(([entry]) => entry.phase === "build_succeeded")?.[0];
		expect(completed?.observability?.graph).toEqual(
			expect.objectContaining({
				buildId: started?.observability?.graph?.buildId,
				graphGeneration: built.buildGeneration,
				builtAt: built.builtAt,
				nodes: built.nodes.size,
				edges: built.edges.length,
			}),
		);
	});

	it("records debounce coalescing and the superseded persistence generation", async () => {
		const env = makeEnv();
		const first = createTempFile(env.tmpDir, "a.ts", "export const a = 1;\n");
		process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS = "100000";
		await buildOrUpdateGraph(env.tmpDir, [first], new FactStore());
		const second = createTempFile(env.tmpDir, "b.ts", "export const b = 2;\n");
		await buildOrUpdateGraph(env.tmpDir, [first, second], new FactStore());
		const scheduled = vi
			.mocked(logReviewGraph)
			.mock.calls.map(([entry]) => entry)
			.filter((entry) => entry.phase === "persist_scheduled");
		expect(scheduled).toHaveLength(2);
		const firstPersistence = scheduled[0].observability?.persistence;
		const secondPersistence = scheduled[1].observability?.persistence;
		expect(secondPersistence).toEqual(
			expect.objectContaining({
				status: "scheduled",
				coalesced: true,
				supersededGeneration: firstPersistence?.generation,
				reason: "debounced_coalescing",
			}),
		);
		const superseded = vi
			.mocked(logReviewGraph)
			.mock.calls.map(([entry]) => entry)
			.find(
				(entry) =>
					entry.phase === "persist_skipped" &&
					entry.observability?.persistence?.generation ===
						firstPersistence?.generation,
			);
		expect(superseded?.observability?.persistence).toEqual(
			expect.objectContaining({
				status: "superseded",
				supersededByGeneration: secondPersistence?.generation,
				reason: "newer_generation_scheduled",
			}),
		);
		flushReviewGraphPersistsForTests();
		await waitForReviewGraphPersistsForTests();
		const success = vi
			.mocked(logReviewGraph)
			.mock.calls.map(([entry]) => entry)
			.find((entry) => entry.phase === "persist_succeeded");
		expect(success?.observability?.persistence?.generation).toBe(
			secondPersistence?.generation,
		);
	});

	it("correlates build mode with each returned graph across workspaces", async () => {
		const incrementalEnv = makeEnv();
		const fullEnv = makeEnv();
		const incrementalPath = createTempFile(
			incrementalEnv.tmpDir,
			"a.ts",
			"export const before = 1;\n",
		);
		const fullPath = createTempFile(
			fullEnv.tmpDir,
			"b.ts",
			"export const full = 2;\n",
		);
		const incrementalFacts = new FactStore();
		await buildOrUpdateGraph(
			incrementalEnv.tmpDir,
			[incrementalPath],
			incrementalFacts,
		);
		createTempFile(incrementalEnv.tmpDir, "a.ts", "export const after = 3;\n");
		clearGraphCache();
		vi.mocked(logReviewGraph).mockClear();

		await Promise.all([
			buildOrUpdateGraph(
				incrementalEnv.tmpDir,
				[incrementalPath],
				incrementalFacts,
			),
			buildOrUpdateGraph(fullEnv.tmpDir, [fullPath], new FactStore()),
		]);

		const successes = vi
			.mocked(logReviewGraph)
			.mock.calls.map(([entry]) => entry)
			.filter((entry) => entry.phase === "build_succeeded");
		const incrementalSuccess = successes.find(
			(entry) =>
				path.resolve(entry.cwd) === path.resolve(incrementalEnv.tmpDir),
		);
		const fullSuccess = successes.find(
			(entry) => path.resolve(entry.cwd) === path.resolve(fullEnv.tmpDir),
		);
		expect(incrementalSuccess?.observability?.graph?.mode).toBe("incremental");
		expect(fullSuccess?.observability?.graph?.mode).toBe("full");
	});

	it("uses the build-start sequence in build_succeeded telemetry", async () => {
		const env = makeEnv();
		const sourcePath = createTempFile(
			env.tmpDir,
			"a.ts",
			"export const value = 1;\n",
		);
		process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS = "100000";
		let projectSeq = 10;
		const seqHint: GraphSeqHint = {
			projectSeq: () => projectSeq,
			getFilesChangedSince: () => [],
		};

		const build = buildOrUpdateGraph(
			env.tmpDir,
			[sourcePath],
			new FactStore(),
			seqHint,
		);
		projectSeq = 11;
		await build;

		const succeeded = vi
			.mocked(logReviewGraph)
			.mock.calls.map(([entry]) => entry)
			.find((entry) => entry.phase === "build_succeeded");
		expect(succeeded?.observability?.graph?.projectSeq).toBe(10);
	});

	it("flushes exit-hook lifecycle events after forced persistence", async () => {
		const env = makeEnv();
		const sourcePath = createTempFile(
			env.tmpDir,
			"a.ts",
			"export const exitFlush = 1;\n",
		);
		process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS = "100000";
		await buildOrUpdateGraph(env.tmpDir, [sourcePath], new FactStore());

		flushReviewGraphPersistsForExitForTests();
		expect(vi.mocked(flushReviewGraphLogSync)).toHaveBeenCalled();
		const success = vi
			.mocked(logReviewGraph)
			.mock.calls.map(([entry]) => entry)
			.find(
				(entry) =>
					entry.phase === "persist_succeeded" &&
					entry.observability?.persistence?.reason === "exit_flush",
			);
		expect(success).toBeDefined();
	});

	it("does not fall back an older worker generation after a newer one is scheduled", async () => {
		const env = makeEnv();
		const first = createTempFile(env.tmpDir, "a.ts", "export const a = 1;\n");
		process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS = "0";
		process.env.PI_LENS_TEST_PERSIST_WORKER_DELAY_MS = "10000";
		await buildOrUpdateGraph(env.tmpDir, [first], new FactStore());
		const second = createTempFile(env.tmpDir, "b.ts", "export const b = 2;\n");
		process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS = "100000";
		await buildOrUpdateGraph(env.tmpDir, [first, second], new FactStore());
		await terminateReviewGraphPersistWorkerForTests();
		await waitForReviewGraphPersistsForTests();
		const skipped = vi
			.mocked(logReviewGraph)
			.mock.calls.map(([entry]) => entry)
			.find(
				(entry) =>
					entry.phase === "persist_skipped" &&
					entry.reason === "superseded" &&
					entry.observability?.persistence?.reason ===
						"worker_death_after_newer_generation",
			);

		expect(skipped?.observability?.persistence).toEqual(
			expect.objectContaining({
				status: "superseded",
				reason: "worker_death_after_newer_generation",
				workerStarted: true,
			}),
		);
		expect(
			vi
				.mocked(logReviewGraph)
				.mock.calls.some(
					([entry]) =>
						entry.phase === "worker_fallback" &&
						entry.observability?.persistence?.generation ===
							skipped?.observability?.persistence?.generation,
				),
		).toBe(false);
		flushReviewGraphPersistsForTests();
		await waitForReviewGraphPersistsForTests();
	});

	it("worker gzip round-trips through the load path", async () => {
		const env = makeEnv();
		createTempFile(
			env.tmpDir,
			"a.ts",
			"export function alpha() { return 1 }\nexport const beta = alpha();\n",
		);
		process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS = "0";
		const built = await buildOrUpdateGraph(
			env.tmpDir,
			[path.join(env.tmpDir, "a.ts")],
			new FactStore(),
		);
		await waitForReviewGraphPersistsForTests();
		expect(fs.readFileSync(cachePathFor(env.tmpDir)).subarray(0, 2)).toEqual(
			Buffer.from([0x1f, 0x8b]),
		);

		clearReviewGraphWorkspaceCache(env.tmpDir);
		const loaded = getCachedReviewGraph(env.tmpDir);
		expect(loaded?.nodes.size).toBe(built.nodes.size);
		expect(loaded?.edges).toEqual(built.edges);
	});

	it("loads a legacy uncompressed v7 snapshot when gzip is absent", async () => {
		const env = makeEnv();
		createTempFile(env.tmpDir, "legacy.ts", "export const legacy = 1;\n");
		process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS = "100000";
		await buildOrUpdateGraph(
			env.tmpDir,
			[path.join(env.tmpDir, "legacy.ts")],
			new FactStore(),
		);
		flushReviewGraphPersistsForTests();
		const gzipPath = cachePathFor(env.tmpDir);
		const legacyPath = path.join(path.dirname(gzipPath), "review-graph.json");
		fs.writeFileSync(legacyPath, gunzipSync(fs.readFileSync(gzipPath)));
		fs.rmSync(gzipPath);
		clearReviewGraphWorkspaceCache(env.tmpDir);

		expect(getCachedReviewGraph(env.tmpDir)?.nodes.size).toBeGreaterThan(0);
	});

	it("sync flush supersedes an older in-flight worker generation", async () => {
		const env = makeEnv();
		const sourcePath = createTempFile(
			env.tmpDir,
			"a.ts",
			"export const oldValue = 1;\n",
		);
		process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS = "0";
		const oldGraph = await buildOrUpdateGraph(
			env.tmpDir,
			[sourcePath],
			new FactStore(),
		);
		const oldNodeCount = oldGraph.nodes.size;
		const secondPath = createTempFile(
			env.tmpDir,
			"b.ts",
			"export const newValue = 2;\n",
		);
		process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS = "100000";
		const newGraph = await buildOrUpdateGraph(
			env.tmpDir,
			[sourcePath, secondPath],
			new FactStore(),
		);
		expect(newGraph.nodes.size).toBeGreaterThan(oldNodeCount);
		expect(flushReviewGraphPersist(env.tmpDir).ok).toBe(true);
		await waitForReviewGraphPersistsForTests();
		clearReviewGraphWorkspaceCache(env.tmpDir);
		expect(getCachedReviewGraph(env.tmpDir)?.nodes.size).toBe(
			newGraph.nodes.size,
		);
	});

	// #3536: the persist worker serves requests concurrently, so generation 2
	// can promote while generation 1 is still in the worker. The forced flush
	// (the CLI, and the exit hook) used to pick the newest in-flight candidate,
	// generation 1, and write it over the promoted generation 2.
	it.each([
		["cli flush", (cwd: string) => flushReviewGraphPersist(cwd, "cli")],
		["exit hook", (_cwd: string) => flushReviewGraphPersistsForExitForTests()],
	] as const)(
		"%s never writes a generation the gate already superseded (#3536)",
		async (_seam, flush) => {
			const env = makeEnv();
			const cachePath = cachePathFor(env.tmpDir);
			const diskFiles = () =>
				(
					JSON.parse(
						gunzipSync(fs.readFileSync(cachePath)).toString("utf8"),
					) as {
						fileSignatures: Array<[string, string]>;
					}
				).fileSignatures
					.map(([file]) => path.basename(file))
					.sort();
			process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS = "0";
			// Gate 1: generation 1's request never reaches the worker, so it
			// stays in flight for as long as the test needs.
			const post = Worker.prototype.postMessage;
			const hold = vi
				.spyOn(Worker.prototype, "postMessage")
				.mockImplementation(function (this: Worker, message, ...rest) {
					const request = message as {
						generation?: number;
						stagePath?: string;
					};
					if (
						request.generation === 1 &&
						request.stagePath?.startsWith(cachePath)
					) {
						return;
					}
					return post.call(this, message, ...rest);
				});
			// Gate 2: resolves when generation 2's worker result is promoted.
			let promoted!: () => void;
			const generation2Promoted = new Promise<void>((resolve) => {
				promoted = resolve;
			});
			vi.mocked(logReviewGraph).mockImplementation((entry) => {
				if (
					entry.phase === "persist_succeeded" &&
					entry.offloaded === true &&
					entry.observability?.persistence?.generation === 2
				) {
					promoted();
				}
			});
			try {
				const a = createTempFile(env.tmpDir, "a.ts", "export const a = 1;\n");
				await buildOrUpdateGraph(env.tmpDir, [a], new FactStore());
				expect(hold).toHaveBeenCalledTimes(1);
				const c = createTempFile(env.tmpDir, "c.ts", "export const c = 3;\n");
				clearGraphCache();
				await buildOrUpdateGraph(env.tmpDir, [c], new FactStore());
				await generation2Promoted;
				expect(diskFiles()).toEqual(["a.ts", "c.ts"]);

				flush(env.tmpDir);

				expect(diskFiles()).toEqual(["a.ts", "c.ts"]);
				const skipped = vi
					.mocked(logReviewGraph)
					.mock.calls.map(([entry]) => entry)
					.filter(
						(entry) =>
							entry.phase === "persist_skipped" &&
							entry.observability?.persistence?.reason ===
								"forced_flush_superseded",
					);
				expect(
					skipped.map((entry) => entry.observability?.persistence),
				).toEqual([
					expect.objectContaining({
						generation: 1,
						status: "superseded",
						supersededByGeneration: 2,
					}),
				]);
			} finally {
				hold.mockRestore();
				vi.mocked(logReviewGraph).mockReset();
			}
		},
	);

	it("forced flush records when it selected an in-flight worker snapshot", async () => {
		const env = makeEnv();
		const sourcePath = createTempFile(
			env.tmpDir,
			"a.ts",
			"export const inFlight = 1;\n",
		);
		process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS = "0";
		process.env.PI_LENS_TEST_PERSIST_WORKER_DELAY_MS = "1000";
		await buildOrUpdateGraph(env.tmpDir, [sourcePath], new FactStore());

		expect(flushReviewGraphPersist(env.tmpDir).ok).toBe(true);
		const success = vi
			.mocked(logReviewGraph)
			.mock.calls.map(([entry]) => entry)
			.find(
				(entry) =>
					entry.phase === "persist_succeeded" &&
					entry.observability?.persistence?.reason === "forced_flush",
			);
		expect(success?.observability?.persistence).toEqual(
			expect.objectContaining({
				workerStarted: true,
				workerCompleted: false,
			}),
		);
	});

	it("worker death degrades to a logged main-thread persist", async () => {
		const env = makeEnv();
		createTempFile(env.tmpDir, "a.ts", "export const fallback = 1;\n");
		process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS = "0";
		process.env.PI_LENS_TEST_PERSIST_WORKER_DELAY_MS = "1000";
		await buildOrUpdateGraph(
			env.tmpDir,
			[path.join(env.tmpDir, "a.ts")],
			new FactStore(),
		);
		await terminateReviewGraphPersistWorkerForTests();
		await waitForReviewGraphPersistsForTests();
		expect(fs.existsSync(cachePathFor(env.tmpDir))).toBe(true);
		expect(getReviewGraphWorkerFallbackReasonForTests()).toMatch(
			/exited|unavailable/,
		);
		const fallback = vi
			.mocked(logReviewGraph)
			.mock.calls.map(([entry]) => entry)
			.find((entry) => entry.phase === "worker_fallback");
		const success = vi
			.mocked(logReviewGraph)
			.mock.calls.map(([entry]) => entry)
			.find((entry) => entry.phase === "persist_succeeded");
		expect(fallback?.observability?.persistence).toEqual(
			expect.objectContaining({
				status: "fallback",
				workerStarted: true,
				workerFallback: true,
			}),
		);
		expect(fallback?.observability?.persistence?.generation).toBe(
			success?.observability?.persistence?.generation,
		);
	});
});
