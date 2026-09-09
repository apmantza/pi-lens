import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ImpactCascadeResult,
	ReviewGraph,
} from "../../clients/review-graph/types.js";
import type { GraphBuildInfo } from "../../clients/review-graph/builder.js";
import { setupTestEnvironment } from "./test-utils.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";

/**
 * #459: computeCascadeForFile should skip rebuilding + re-persisting the
 * reverse-dependency index when the returned graph carries the SAME
 * buildGeneration stamp the cached index was derived from, and reuse the
 * last-built index for this workspace instead. The stamp travels with the
 * graph instance; the global GraphBuildInfo slot is informational only (it can
 * be clobbered by an overlapping deferred cascade — see the race test below).
 * Mirrors the mocking approach in cascade-compute.test.ts (mock
 * review-graph/service.js for buildOrUpdateGraph, plus builder.js for
 * getLastGraphBuildInfo and reverse-deps.js for the index build/write calls).
 */

type ImpactHitMock = {
	symbol: string;
	file: string;
	depth: number;
	relation: string;
};

const mocks = vi.hoisted(() => ({
	buildOrUpdateGraph: vi.fn(),
	computeImpactCascade: vi.fn(),
	computeTransitiveImpact: vi.fn(
		(): {
			seedFile: string;
			hits: ImpactHitMock[];
			truncated: boolean;
			maxDepthReached: number;
		} => ({ seedFile: "", hits: [], truncated: false, maxDepthReached: 0 }),
	),
	formatImpactCascade: vi.fn(),
	getLSPService: vi.fn(),
	getGraphImportChanges: vi.fn(),
	getLastGraphBuildInfo: vi.fn(),
	buildReverseDependencyIndexFromGraph: vi.fn(),
	patchReverseDependencyIndex: vi.fn(),
	writeReverseDependencyIndexToSnapshot: vi.fn(),
}));

vi.mock("../../clients/review-graph/service.js", () => ({
	buildOrUpdateGraph: mocks.buildOrUpdateGraph,
	computeImpactCascade: mocks.computeImpactCascade,
	computeTransitiveImpact: mocks.computeTransitiveImpact,
	formatImpactCascade: mocks.formatImpactCascade,
}));

vi.mock("../../clients/lsp/index.js", () => ({
	getLSPService: mocks.getLSPService,
}));

vi.mock("../../clients/review-graph/builder.js", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../../clients/review-graph/builder.js")
		>();
	return {
		...actual,
		getGraphImportChanges: mocks.getGraphImportChanges,
		getLastGraphBuildInfo: mocks.getLastGraphBuildInfo,
	};
});

vi.mock("../../clients/reverse-deps.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/reverse-deps.js")>();
	return {
		...actual,
		buildReverseDependencyIndexFromGraph:
			mocks.buildReverseDependencyIndexFromGraph,
		patchReverseDependencyIndex: mocks.patchReverseDependencyIndex,
		writeReverseDependencyIndexToSnapshot:
			mocks.writeReverseDependencyIndexToSnapshot,
	};
});

function emptyGraph(buildGeneration?: number): ReviewGraph {
	return {
		version: "test",
		builtAt: new Date().toISOString(),
		nodes: new Map(),
		edges: [],
		edgesByFrom: new Map(),
		edgesByTo: new Map(),
		fileNodes: new Map(),
		symbolNodesByFile: new Map(),
		changedSymbolsByFile: new Map(),
		buildGeneration,
	};
}

function impact(filePath: string, neighbors: string[]): ImpactCascadeResult {
	return {
		filePath,
		changedSymbols: [],
		directImporters: neighbors,
		directCallers: [],
		neighborFiles: neighbors,
		riskFlags: [],
	};
}

function buildInfo(overrides: Partial<GraphBuildInfo>): GraphBuildInfo {
	return {
		reused: true,
		mode: "cached",
		graphChanged: false,
		...overrides,
	};
}

const emptyIndex = () => ({
	projectRoot: "/tmp",
	generatedAt: new Date().toISOString(),
	imports: {},
	importedBy: {},
	source: "review-graph" as const,
});

describe("reverse-deps index cache (#459)", () => {
	beforeEach(async () => {
		vi.resetModules();
		mocks.buildOrUpdateGraph.mockReset().mockResolvedValue(emptyGraph());
		mocks.computeImpactCascade.mockReset().mockReturnValue(impact("", []));
		mocks.computeTransitiveImpact.mockReset().mockReturnValue({
			seedFile: "",
			hits: [],
			truncated: false,
			maxDepthReached: 0,
		});
		mocks.formatImpactCascade.mockReset().mockReturnValue("impact header");
		mocks.getLSPService.mockReset().mockReturnValue(makeLspServiceDouble());
		mocks.getLastGraphBuildInfo.mockReset();
		mocks.getGraphImportChanges.mockReset().mockReturnValue(undefined);
		mocks.buildReverseDependencyIndexFromGraph
			.mockReset()
			.mockReturnValue(emptyIndex());
		mocks.patchReverseDependencyIndex
			.mockReset()
			.mockImplementation((index) => index);
		mocks.writeReverseDependencyIndexToSnapshot
			.mockReset()
			.mockReturnValue(true);
		delete process.env.PI_LENS_REVERSE_DEPS_REUSE;

		const { resetDispatchBaselines } =
			await import("../../clients/dispatch/integration.js");
		resetDispatchBaselines();
	}, 30_000);

	it("builds + writes the index on the first cascade run", async () => {
		const env = setupTestEnvironment("reverse-deps-first-");
		try {
			const primary = path.join(env.tmpDir, "primary.ts");
			fs.writeFileSync(primary, "export const x = 1;\n");
			mocks.computeImpactCascade.mockReturnValue(impact(primary, []));
			mocks.buildOrUpdateGraph.mockResolvedValue(emptyGraph(1));
			mocks.getLastGraphBuildInfo.mockReturnValue(
				buildInfo({ mode: "full", reused: false, graphChanged: true }),
			);

			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");
			await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});

			expect(mocks.buildReverseDependencyIndexFromGraph).toHaveBeenCalledTimes(
				1,
			);
			expect(mocks.writeReverseDependencyIndexToSnapshot).toHaveBeenCalledTimes(
				1,
			);
		} finally {
			env.cleanup();
		}
	});

	it("reuses the cached index on a second run when the graph generation is unchanged", async () => {
		const env = setupTestEnvironment("reverse-deps-reuse-");
		try {
			const primary = path.join(env.tmpDir, "primary.ts");
			fs.writeFileSync(primary, "export const x = 1;\n");
			mocks.computeImpactCascade.mockReturnValue(impact(primary, []));

			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");

			mocks.buildOrUpdateGraph.mockResolvedValue(emptyGraph(1));
			mocks.getLastGraphBuildInfo.mockReturnValue(
				buildInfo({ mode: "full", reused: false, graphChanged: true }),
			);
			await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});
			expect(mocks.buildReverseDependencyIndexFromGraph).toHaveBeenCalledTimes(
				1,
			);
			expect(mocks.writeReverseDependencyIndexToSnapshot).toHaveBeenCalledTimes(
				1,
			);

			// Second run: cache-hit build returns a graph carrying the SAME stamp.
			mocks.buildOrUpdateGraph.mockResolvedValue(emptyGraph(1));
			mocks.getLastGraphBuildInfo.mockReturnValue(
				buildInfo({ mode: "cached", reused: true, graphChanged: false }),
			);
			await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 2,
				writeSeq: 2,
			});

			// Still only ever called once — the second run reused the cache.
			expect(mocks.buildReverseDependencyIndexFromGraph).toHaveBeenCalledTimes(
				1,
			);
			expect(mocks.writeReverseDependencyIndexToSnapshot).toHaveBeenCalledTimes(
				1,
			);
		} finally {
			env.cleanup();
		}
	});

	it("rebuilds when the graph actually changed (seq-fastpath with real updates)", async () => {
		const env = setupTestEnvironment("reverse-deps-changed-");
		try {
			const primary = path.join(env.tmpDir, "primary.ts");
			fs.writeFileSync(primary, "export const x = 1;\n");
			mocks.computeImpactCascade.mockReturnValue(impact(primary, []));

			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");

			mocks.buildOrUpdateGraph.mockResolvedValue(emptyGraph(1));
			mocks.getLastGraphBuildInfo.mockReturnValue(
				buildInfo({ mode: "full", reused: false, graphChanged: true }),
			);
			await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});
			expect(mocks.buildReverseDependencyIndexFromGraph).toHaveBeenCalledTimes(
				1,
			);

			// seq-fastpath mode with a real re-extract mints a NEW generation — this
			// is exactly the case a plain `mode === "seq-fastpath"` check would have
			// wrongly treated as reusable.
			mocks.buildOrUpdateGraph.mockResolvedValue(emptyGraph(2));
			mocks.getLastGraphBuildInfo.mockReturnValue(
				buildInfo({ mode: "seq-fastpath", reused: true, graphChanged: true }),
			);
			await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 2,
				writeSeq: 2,
			});

			expect(mocks.buildReverseDependencyIndexFromGraph).toHaveBeenCalledTimes(
				2,
			);
			expect(mocks.writeReverseDependencyIndexToSnapshot).toHaveBeenCalledTimes(
				2,
			);
		} finally {
			env.cleanup();
		}
	});

	it("reuses across a new graph generation when imports did not change", async () => {
		const env = setupTestEnvironment("reverse-deps-body-only-");
		try {
			const primary = path.join(env.tmpDir, "primary.ts");
			fs.writeFileSync(primary, "export const x = 1;\n");
			mocks.computeImpactCascade.mockReturnValue(impact(primary, []));
			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");

			mocks.buildOrUpdateGraph.mockResolvedValue(emptyGraph(1));
			mocks.getLastGraphBuildInfo.mockReturnValue(
				buildInfo({ mode: "full", reused: false, graphChanged: true }),
			);
			await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});

			mocks.buildOrUpdateGraph.mockResolvedValue(emptyGraph(2));
			mocks.getLastGraphBuildInfo.mockReturnValue(
				buildInfo({ mode: "seq-fastpath", reused: true, graphChanged: true }),
			);
			mocks.getGraphImportChanges.mockReturnValue({
				// One-step delta from the index's cached generation (1) — contiguous.
				fromGeneration: 1,
				changes: [
					{
						filePath: primary,
						existedBefore: true,
						existsAfter: true,
						priorTargets: [],
						newTargets: [],
					},
				],
			});
			await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 2,
				writeSeq: 2,
			});

			expect(mocks.buildReverseDependencyIndexFromGraph).toHaveBeenCalledTimes(
				1,
			);
			expect(mocks.patchReverseDependencyIndex).not.toHaveBeenCalled();
			expect(mocks.writeReverseDependencyIndexToSnapshot).toHaveBeenCalledTimes(
				1,
			);
		} finally {
			env.cleanup();
		}
	});

	it("patches the cached index when one file's import targets change", async () => {
		const env = setupTestEnvironment("reverse-deps-patch-");
		try {
			const primary = path.join(env.tmpDir, "primary.ts");
			const target = path.join(env.tmpDir, "target.ts");
			fs.writeFileSync(primary, "export const x = 1;\n");
			mocks.computeImpactCascade.mockReturnValue(impact(primary, []));
			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");

			mocks.buildOrUpdateGraph.mockResolvedValue(emptyGraph(1));
			mocks.getLastGraphBuildInfo.mockReturnValue(
				buildInfo({ mode: "full", reused: false, graphChanged: true }),
			);
			await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});

			mocks.buildOrUpdateGraph.mockResolvedValue(emptyGraph(2));
			mocks.getLastGraphBuildInfo.mockReturnValue(
				buildInfo({ mode: "seq-fastpath", reused: true, graphChanged: true }),
			);
			mocks.getGraphImportChanges.mockReturnValue({
				// One-step delta from the index's cached generation (1) — contiguous.
				fromGeneration: 1,
				changes: [
					{
						filePath: primary,
						existedBefore: true,
						existsAfter: true,
						priorTargets: [],
						newTargets: [target],
					},
				],
			});
			await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 2,
				writeSeq: 2,
			});

			expect(mocks.buildReverseDependencyIndexFromGraph).toHaveBeenCalledTimes(
				1,
			);
			expect(mocks.patchReverseDependencyIndex).toHaveBeenCalledTimes(1);
			expect(mocks.writeReverseDependencyIndexToSnapshot).toHaveBeenCalledTimes(
				2,
			);
		} finally {
			env.cleanup();
		}
	});

	it("rebuilds when the global build-info slot was clobbered by an overlapping cascade (generation wins)", async () => {
		const env = setupTestEnvironment("reverse-deps-race-");
		try {
			const primary = path.join(env.tmpDir, "primary.ts");
			fs.writeFileSync(primary, "export const x = 1;\n");
			mocks.computeImpactCascade.mockReturnValue(impact(primary, []));

			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");

			mocks.buildOrUpdateGraph.mockResolvedValue(emptyGraph(1));
			mocks.getLastGraphBuildInfo.mockReturnValue(
				buildInfo({ mode: "full", reused: false, graphChanged: true }),
			);
			await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});
			expect(mocks.buildReverseDependencyIndexFromGraph).toHaveBeenCalledTimes(
				1,
			);

			// The race (#450 overlapping deferred cascades): THIS cascade's build
			// mutated the graph (new generation 2), but before it reads the global
			// slot, ANOTHER cascade's cache-hit build overwrote it with
			// graphChanged:false. A slot-based check would spuriously reuse the stale
			// index; the generation stamp on the held graph instance must force a
			// rebuild.
			mocks.buildOrUpdateGraph.mockResolvedValue(emptyGraph(2));
			mocks.getLastGraphBuildInfo.mockReturnValue(
				buildInfo({ mode: "cached", reused: true, graphChanged: false }),
			);
			await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 2,
				writeSeq: 2,
			});

			expect(mocks.buildReverseDependencyIndexFromGraph).toHaveBeenCalledTimes(
				2,
			);
			expect(mocks.writeReverseDependencyIndexToSnapshot).toHaveBeenCalledTimes(
				2,
			);
		} finally {
			env.cleanup();
		}
	});

	it("always rebuilds for unstamped graphs (mode skipped)", async () => {
		const env = setupTestEnvironment("reverse-deps-unstamped-");
		try {
			const primary = path.join(env.tmpDir, "primary.ts");
			fs.writeFileSync(primary, "export const x = 1;\n");
			mocks.computeImpactCascade.mockReturnValue(impact(primary, []));
			// No buildGeneration on the returned graphs, even though the slot claims
			// nothing changed — absent stamp means "cannot prove", so rebuild.
			mocks.buildOrUpdateGraph.mockResolvedValue(emptyGraph());
			mocks.getLastGraphBuildInfo.mockReturnValue(
				buildInfo({ mode: "cached", reused: true, graphChanged: false }),
			);

			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");
			await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});
			await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 2,
				writeSeq: 2,
			});

			expect(mocks.buildReverseDependencyIndexFromGraph).toHaveBeenCalledTimes(
				2,
			);
			expect(mocks.writeReverseDependencyIndexToSnapshot).toHaveBeenCalledTimes(
				2,
			);
		} finally {
			env.cleanup();
		}
	});

	it("kill switch PI_LENS_REVERSE_DEPS_REUSE=0 forces a rebuild every run", async () => {
		const env = setupTestEnvironment("reverse-deps-killswitch-");
		try {
			process.env.PI_LENS_REVERSE_DEPS_REUSE = "0";
			const primary = path.join(env.tmpDir, "primary.ts");
			fs.writeFileSync(primary, "export const x = 1;\n");
			mocks.computeImpactCascade.mockReturnValue(impact(primary, []));
			// Same generation both runs — reuse WOULD apply without the kill switch.
			mocks.buildOrUpdateGraph.mockResolvedValue(emptyGraph(1));
			mocks.getLastGraphBuildInfo.mockReturnValue(
				buildInfo({ mode: "cached", reused: true, graphChanged: false }),
			);

			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");
			await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});
			await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 2,
				writeSeq: 2,
			});

			expect(mocks.buildReverseDependencyIndexFromGraph).toHaveBeenCalledTimes(
				2,
			);
			expect(mocks.writeReverseDependencyIndexToSnapshot).toHaveBeenCalledTimes(
				2,
			);
		} finally {
			delete process.env.PI_LENS_REVERSE_DEPS_REUSE;
			env.cleanup();
		}
	});

	it("resetDispatchBaselines clears the cache so the next run rebuilds", async () => {
		const env = setupTestEnvironment("reverse-deps-reset-");
		try {
			const primary = path.join(env.tmpDir, "primary.ts");
			fs.writeFileSync(primary, "export const x = 1;\n");
			mocks.computeImpactCascade.mockReturnValue(impact(primary, []));
			// Same generation across both runs — only the reset forces the rebuild.
			mocks.buildOrUpdateGraph.mockResolvedValue(emptyGraph(1));
			mocks.getLastGraphBuildInfo.mockReturnValue(
				buildInfo({ mode: "full", reused: false, graphChanged: true }),
			);

			const { computeCascadeForFile, resetDispatchBaselines } =
				await import("../../clients/dispatch/integration.js");
			await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});
			expect(mocks.buildReverseDependencyIndexFromGraph).toHaveBeenCalledTimes(
				1,
			);

			// A later run reporting "unchanged" would normally reuse the cache…
			resetDispatchBaselines();
			mocks.getLastGraphBuildInfo.mockReturnValue(
				buildInfo({ mode: "cached", reused: true, graphChanged: false }),
			);
			await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 2,
				writeSeq: 2,
			});

			// …but the reset cleared the per-workspace cache, so this run rebuilt.
			expect(mocks.buildReverseDependencyIndexFromGraph).toHaveBeenCalledTimes(
				2,
			);
			expect(mocks.writeReverseDependencyIndexToSnapshot).toHaveBeenCalledTimes(
				2,
			);
		} finally {
			env.cleanup();
		}
	});
});
