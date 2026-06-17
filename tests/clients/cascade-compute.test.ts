import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ImpactCascadeResult,
	ReviewGraph,
} from "../../clients/review-graph/types.js";
import { setupTestEnvironment } from "./test-utils.js";

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

const lspError = (message = "cascade error") => ({
	severity: 1 as const,
	message,
	range: {
		start: { line: 2, character: 4 },
		end: { line: 2, character: 10 },
	},
	code: "X1",
	source: "test-lsp",
});

function emptyGraph(): ReviewGraph {
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
	};
}

function impact(filePath: string, neighbors: string[]): ImpactCascadeResult {
	return {
		filePath,
		changedSymbols: ["changed"],
		directImporters: neighbors,
		directCallers: [],
		neighborFiles: neighbors,
		riskFlags: [],
	};
}

describe("computeCascadeForFile", () => {
	// vi.resetModules() drops the whole module cache and the dynamic re-import
	// below pays a full cold-resolve; under full-suite parallel CPU contention
	// that setup can exceed the default 10s hook timeout (it passes comfortably
	// in isolation). Raise the hook budget — this is setup, not an assertion, so
	// a longer ceiling absorbs the contention without masking a product failure.
	beforeEach(async () => {
		vi.resetModules();
		mocks.buildOrUpdateGraph.mockReset().mockResolvedValue(emptyGraph());
		mocks.computeImpactCascade.mockReset();
		mocks.computeTransitiveImpact.mockReset().mockReturnValue({
			seedFile: "",
			hits: [],
			truncated: false,
			maxDepthReached: 0,
		});
		mocks.formatImpactCascade.mockReset().mockReturnValue("impact header");
		mocks.getLSPService.mockReset();
		const { resetDispatchBaselines } = await import(
			"../../clients/dispatch/integration.js"
		);
		resetDispatchBaselines();
	}, 30_000);

	it("reads jsts neighbors from passive snapshot instead of active touching", async () => {
		const env = setupTestEnvironment("cascade-jsts-");
		try {
			const primary = path.join(env.tmpDir, "src", "primary.ts");
			const neighbor = path.join(env.tmpDir, "src", "neighbor.ts");
			fs.mkdirSync(path.dirname(primary), { recursive: true });
			fs.writeFileSync(primary, "export const x = 1;\n");
			fs.writeFileSync(neighbor, "import { x } from './primary';\n");
			mocks.computeImpactCascade.mockReturnValue(impact(primary, [neighbor]));
			const touchFile = vi.fn();
			mocks.getLSPService.mockReturnValue({
				getAllDiagnostics: vi
					.fn()
					.mockResolvedValue(
						new Map([
							[
								neighbor.split(path.sep).join("/"),
								{ diags: [lspError()], ts: Date.now() },
							],
						]),
					),
				touchFile,
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile } = await import(
				"../../clients/dispatch/integration.js"
			);
			const result = await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});

			expect(touchFile).not.toHaveBeenCalled();
			expect(result?.result?.neighbors[0]?.diagnostics[0]?.filePath).toBe(neighbor);
			expect(result?.result?.formatted).toContain("neighbor.ts");
		} finally {
			env.cleanup();
		}
	});

	it("includes bounded transitive (depth>1) dependents as neighbors", async () => {
		const env = setupTestEnvironment("cascade-transitive-");
		try {
			const primary = path.join(env.tmpDir, "src", "primary.ts");
			const direct = path.join(env.tmpDir, "src", "direct.ts");
			const indirect = path.join(env.tmpDir, "src", "indirect.ts");
			fs.mkdirSync(path.dirname(primary), { recursive: true });
			fs.writeFileSync(primary, "export const x = 1;\n");
			fs.writeFileSync(direct, "import { x } from './primary';\n");
			fs.writeFileSync(indirect, "import './direct';\n");
			// One-hop cascade sees only the direct importer…
			mocks.computeImpactCascade.mockReturnValue(impact(primary, [direct]));
			// …while the transitive walk also reaches the depth-2 dependent.
			mocks.computeTransitiveImpact.mockReturnValue({
				seedFile: primary,
				hits: [
					{ symbol: "", file: direct, depth: 1, relation: "imports" },
					{ symbol: "", file: indirect, depth: 2, relation: "imports" },
				],
				truncated: false,
				maxDepthReached: 2,
			});
			mocks.getLSPService.mockReturnValue({
				getAllDiagnostics: vi.fn().mockResolvedValue(
					new Map([
						[
							direct.split(path.sep).join("/"),
							{ diags: [lspError("d")], ts: Date.now() },
						],
						[
							indirect.split(path.sep).join("/"),
							{ diags: [lspError("i")], ts: Date.now() },
						],
					]),
				),
				touchFile: vi.fn(),
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile } = await import(
				"../../clients/dispatch/integration.js"
			);
			const result = await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});
			const neighborFiles = result?.result?.neighbors.map(
				(n) => n.diagnostics[0]?.filePath,
			);
			expect(neighborFiles).toContain(indirect); // depth-2 dependent surfaced
		} finally {
			env.cleanup();
		}
	});

	it("adds LSP reference files for changed-symbol blast radius", async () => {
		const env = setupTestEnvironment("cascade-lsp-refs-");
		try {
			const primary = path.join(env.tmpDir, "src", "primary.ts");
			const reference = path.join(env.tmpDir, "src", "consumer.ts");
			fs.mkdirSync(path.dirname(primary), { recursive: true });
			fs.writeFileSync(primary, "export function changed() { return 1; }\n");
			fs.writeFileSync(
				reference,
				"import { changed } from './primary';\nchanged();\n",
			);

			const graph = emptyGraph();
			const normalizedPrimary = primary.split(path.sep).join("/");
			const symbolId = `${normalizedPrimary}:changed`;
			graph.symbolNodesByFile.set(normalizedPrimary, [symbolId]);
			graph.nodes.set(symbolId, {
				id: symbolId,
				kind: "symbol",
				language: "jsts",
				filePath: normalizedPrimary,
				symbolName: "changed",
				symbolKind: "function",
				metadata: { line: 1, column: 17 },
			});
			mocks.buildOrUpdateGraph.mockResolvedValue(graph);
			mocks.computeImpactCascade.mockReturnValue({
				...impact(primary, []),
				changedSymbols: ["changed"],
			});
			const references = vi.fn().mockResolvedValue([
				{
					uri: pathToFileURL(reference).href,
					range: {
						start: { line: 1, character: 0 },
						end: { line: 1, character: 7 },
					},
				},
			]);
			mocks.getLSPService.mockReturnValue({
				getAllDiagnostics: vi
					.fn()
					.mockResolvedValue(
						new Map([
							[
								reference.split(path.sep).join("/"),
								{ diags: [lspError("reference broken")], ts: Date.now() },
							],
						]),
					),
				touchFile: vi.fn(),
				getDiagnostics: vi.fn(),
				references,
			});

			const { computeCascadeForFile } = await import(
				"../../clients/dispatch/integration.js"
			);
			const result = await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});

			expect(references).toHaveBeenCalledWith(normalizedPrimary, 0, 16, false);
			expect(
				result?.result?.neighbors.some(
					(n) =>
						n.filePath.split(path.sep).join("/") ===
						reference.split(path.sep).join("/"),
				),
			).toBe(true);
			expect(result?.result?.formatted).toContain("consumer.ts");
		} finally {
			env.cleanup();
		}
	});

	it("active-touches non-jsts neighbors silently", async () => {
		const env = setupTestEnvironment("cascade-python-");
		try {
			const primary = path.join(env.tmpDir, "model.py");
			const neighbor = path.join(env.tmpDir, "api.py");
			fs.writeFileSync(primary, "class User: pass\n");
			fs.writeFileSync(neighbor, "from model import User\n");
			mocks.computeImpactCascade.mockReturnValue(impact(primary, [neighbor]));
			const touchFile = vi.fn().mockResolvedValue([lspError("python broken")]);
			mocks.getLSPService.mockReturnValue({
				getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
				touchFile,
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile } = await import(
				"../../clients/dispatch/integration.js"
			);
			const result = await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});

			expect(touchFile).toHaveBeenCalledWith(
				neighbor,
				expect.any(String),
				expect.objectContaining({
					silent: true,
					source: "cascade",
					clientScope: "all",
					collectDiagnostics: true,
				}),
			);
			expect(result?.result?.neighbors[0]?.lspTouched).toBe(true);
			expect(result?.result?.neighbors[0]?.diagnostics[0]?.message).toBe(
				"python broken",
			);
		} finally {
			env.cleanup();
		}
	});

	it("falls back to passive snapshot when graph neighbors produce no LSP data", async () => {
		const env = setupTestEnvironment("cascade-fallback-");
		try {
			// Primary must be a recognised code file so detectFileKind passes the
			// non_code_file guard. Neighbor uses an unknown extension so
			// configuredServerCount===0 prevents active touching — keeping
			// producedLspData false and triggering appendFallbackNeighbors.
			const primary = path.join(env.tmpDir, "main.ts");
			const noLspNeighbor = path.join(env.tmpDir, "neighbor.foo");
			const fallbackFile = path.join(env.tmpDir, "already-open.ts");
			fs.writeFileSync(primary, "export const x = 1;\n");
			fs.writeFileSync(noLspNeighbor, "neighbor\n");
			fs.writeFileSync(fallbackFile, "const x = 1;\n");
			mocks.computeImpactCascade.mockReturnValue(
				impact(primary, [noLspNeighbor]),
			);
			const touchFile = vi.fn();
			mocks.getLSPService.mockReturnValue({
				getAllDiagnostics: vi
					.fn()
					.mockResolvedValue(
						new Map([
							[
								fallbackFile.split(path.sep).join("/"),
								{ diags: [lspError("fallback error")], ts: Date.now() },
							],
						]),
					),
				touchFile,
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile } = await import(
				"../../clients/dispatch/integration.js"
			);
			const result = await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});

			expect(touchFile).not.toHaveBeenCalled();
			expect(result?.result?.neighbors.some((n) => n.reason === "fallback")).toBe(true);
			expect(result?.result?.formatted).toContain("fallback error");
		} finally {
			env.cleanup();
		}
	});

	it("active-touches jsts neighbor when snapshot is missing (cold session)", async () => {
		const env = setupTestEnvironment("cascade-cold-snapshot-");
		try {
			const primary = path.join(env.tmpDir, "src", "primary.ts");
			const neighbor = path.join(env.tmpDir, "src", "neighbor.ts");
			fs.mkdirSync(path.dirname(primary), { recursive: true });
			fs.writeFileSync(primary, "export const x = 1;\n");
			fs.writeFileSync(neighbor, "import { x } from './primary';\n");
			mocks.computeImpactCascade.mockReturnValue(impact(primary, [neighbor]));
			const touchFile = vi
				.fn()
				.mockResolvedValue([lspError("type error in neighbor")]);
			mocks.getLSPService.mockReturnValue({
				// Empty allDiags — no snapshot for neighbor (cold session)
				getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
				touchFile,
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile } = await import(
				"../../clients/dispatch/integration.js"
			);
			const result = await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});

			// Should have fallen through to active touch with tighter 1000ms budget
			expect(touchFile).toHaveBeenCalledWith(
				neighbor,
				expect.any(String),
				expect.objectContaining({
					silent: true,
					source: "cascade",
					collectDiagnostics: true,
					maxClientWaitMs: 1000,
				}),
			);
			expect(result?.result?.neighbors[0]?.lspTouched).toBe(true);
			expect(result?.result?.neighbors[0]?.diagnostics[0]?.message).toBe(
				"type error in neighbor",
			);
		} finally {
			env.cleanup();
		}
	});

	it("does not touch jsts neighbor when snapshot is valid (warm session)", async () => {
		const env = setupTestEnvironment("cascade-warm-snapshot-");
		try {
			const primary = path.join(env.tmpDir, "src", "primary.ts");
			const neighbor = path.join(env.tmpDir, "src", "neighbor.ts");
			fs.mkdirSync(path.dirname(primary), { recursive: true });
			fs.writeFileSync(primary, "export const x = 1;\n");
			fs.writeFileSync(neighbor, "import { x } from './primary';\n");
			mocks.computeImpactCascade.mockReturnValue(impact(primary, [neighbor]));
			const touchFile = vi.fn();
			mocks.getLSPService.mockReturnValue({
				getAllDiagnostics: vi
					.fn()
					.mockResolvedValue(
						new Map([
							[
								neighbor.split(path.sep).join("/"),
								{ diags: [lspError("existing warning")], ts: Date.now() },
							],
						]),
					),
				touchFile,
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile } = await import(
				"../../clients/dispatch/integration.js"
			);
			const result = await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});

			// Valid snapshot — no touch should happen
			expect(touchFile).not.toHaveBeenCalled();
			expect(result?.result?.neighbors[0]?.lspTouched).toBe(false);
			expect(result?.result?.neighbors[0]?.diagnostics[0]?.message).toBe(
				"existing warning",
			);
		} finally {
			env.cleanup();
		}
	});

	it("filters repeated cascade diagnostics through cascade delta baselines", async () => {
		const env = setupTestEnvironment("cascade-delta-");
		try {
			const primary = path.join(env.tmpDir, "src", "primary.ts");
			const neighbor = path.join(env.tmpDir, "src", "neighbor.ts");
			fs.mkdirSync(path.dirname(primary), { recursive: true });
			fs.writeFileSync(primary, "export const x = 1;\n");
			fs.writeFileSync(neighbor, "import { x } from './primary';\n");
			mocks.computeImpactCascade.mockReturnValue(impact(primary, [neighbor]));
			mocks.getLSPService.mockReturnValue({
				getAllDiagnostics: vi
					.fn()
					.mockResolvedValue(
						new Map([
							[
								neighbor.split(path.sep).join("/"),
								{ diags: [lspError("same error")], ts: Date.now() },
							],
						]),
					),
				touchFile: vi.fn(),
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile } = await import(
				"../../clients/dispatch/integration.js"
			);
			const first = await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});
			const second = await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 2,
				writeSeq: 1,
			});

			expect(first?.result?.formatted).toContain("same error");
			expect(second?.result).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("re-touches neighbor when writeSeq advances within the same turn", async () => {
		// Uses .ts files (cold snapshot path) so getServersForFileWithConfig reliably
		// returns a server. Two primaries cascade to the same neighbor in the same turn
		// with different writeSeq values — the second must re-touch, not use the cache.
		const env = setupTestEnvironment("cascade-writeseq-");
		try {
			const primaryA = path.join(env.tmpDir, "src", "a.ts");
			const primaryB = path.join(env.tmpDir, "src", "b.ts");
			const neighbor = path.join(env.tmpDir, "src", "shared.ts");
			fs.mkdirSync(path.dirname(primaryA), { recursive: true });
			fs.writeFileSync(primaryA, "export const a = 1;\n");
			fs.writeFileSync(primaryB, "export const b = 2;\n");
			fs.writeFileSync(neighbor, "import { a } from './a';\n");

			// Neighbor goes through cold-snapshot path (allDiags empty → no snapshot →
			// falls into touch pool). First cascade sets cache at writeSeq=1.
			const touchFile = vi
				.fn()
				.mockResolvedValueOnce([lspError("error1")])
				.mockResolvedValueOnce([lspError("error2")]);
			mocks.getLSPService.mockReturnValue({
				getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
				touchFile,
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile, resetDispatchBaselines } = await import(
				"../../clients/dispatch/integration.js"
			);
			resetDispatchBaselines();

			mocks.computeImpactCascade.mockReturnValueOnce(
				impact(primaryA, [neighbor]),
			);
			await computeCascadeForFile(primaryA, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});
			expect(touchFile).toHaveBeenCalledTimes(1);

			// Same turn, higher writeSeq — cache entry (writeSeq=1) must be invalidated
			mocks.computeImpactCascade.mockReturnValueOnce(
				impact(primaryB, [neighbor]),
			);
			const second = await computeCascadeForFile(primaryB, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 2,
			});

			expect(touchFile).toHaveBeenCalledTimes(2);
			expect(second?.result?.neighbors[0]?.diagnostics[0]?.message).toBe("error2");
		} finally {
			env.cleanup();
		}
	});

	it("returns undefined for empty/clean cascade output", async () => {
		const env = setupTestEnvironment("cascade-empty-");
		try {
			const primary = path.join(env.tmpDir, "primary.ts");
			fs.writeFileSync(primary, "export const x = 1;\n");
			mocks.computeImpactCascade.mockReturnValue(impact(primary, []));
			mocks.getLSPService.mockReturnValue({
				getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
				touchFile: vi.fn(),
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile } = await import(
				"../../clients/dispatch/integration.js"
			);
			const run = await computeCascadeForFile(primary, env.tmpDir, { turnSeq: 1, writeSeq: 1 });
			expect(run.result).toBeUndefined();
			expect(run.skipReason).toBe("no_neighbors");
		} finally {
			env.cleanup();
		}
	});
});
