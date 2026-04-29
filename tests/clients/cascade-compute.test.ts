import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ImpactCascadeResult,
	ReviewGraph,
} from "../../clients/review-graph/types.js";
import { setupTestEnvironment } from "./test-utils.js";

const mocks = vi.hoisted(() => ({
	buildOrUpdateGraph: vi.fn(),
	computeImpactCascade: vi.fn(),
	formatImpactCascade: vi.fn(),
	getLSPService: vi.fn(),
}));

vi.mock("../../clients/review-graph/service.js", () => ({
	buildOrUpdateGraph: mocks.buildOrUpdateGraph,
	computeImpactCascade: mocks.computeImpactCascade,
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
	beforeEach(async () => {
		vi.resetModules();
		mocks.buildOrUpdateGraph.mockReset().mockResolvedValue(emptyGraph());
		mocks.computeImpactCascade.mockReset();
		mocks.formatImpactCascade.mockReset().mockReturnValue("impact header");
		mocks.getLSPService.mockReset();
		const { resetDispatchBaselines } = await import(
			"../../clients/dispatch/integration.js"
		);
		resetDispatchBaselines();
	});

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
			expect(result?.neighbors[0]?.diagnostics[0]?.filePath).toBe(neighbor);
			expect(result?.formatted).toContain("neighbor.ts");
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
			const touchFile = vi.fn().mockResolvedValue(undefined);
			mocks.getLSPService.mockReturnValue({
				getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
				touchFile,
				getDiagnostics: vi.fn().mockResolvedValue([lspError("python broken")]),
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
				}),
			);
			expect(result?.neighbors[0]?.lspTouched).toBe(true);
			expect(result?.neighbors[0]?.diagnostics[0]?.message).toBe(
				"python broken",
			);
		} finally {
			env.cleanup();
		}
	});

	it("falls back to passive snapshot when graph neighbors produce no LSP data", async () => {
		const env = setupTestEnvironment("cascade-fallback-");
		try {
			const primary = path.join(env.tmpDir, "main.foo");
			const noLspNeighbor = path.join(env.tmpDir, "neighbor.foo");
			const fallbackFile = path.join(env.tmpDir, "already-open.ts");
			fs.writeFileSync(primary, "primary\n");
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
			expect(result?.neighbors.some((n) => n.reason === "fallback")).toBe(true);
			expect(result?.formatted).toContain("fallback error");
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
			await expect(
				computeCascadeForFile(primary, env.tmpDir, { turnSeq: 1, writeSeq: 1 }),
			).resolves.toBeUndefined();
		} finally {
			env.cleanup();
		}
	});
});
