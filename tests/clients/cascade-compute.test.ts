// flake-shape: service-double — #4485: the silent-push wait reads a language-server client's per-file publish version and waits on it; a real server cannot be made to publish, or stay silent, inside the wait on demand
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ImpactCascadeResult,
	ReviewGraph,
} from "../../clients/review-graph/types.js";
import { setupTestEnvironment } from "./test-utils.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import { writeOrderToken } from "../../clients/write-ordering-guard.js";
import {
	installLspService,
	installLspServiceDouble,
} from "../support/lsp-service-seam.js";

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
	// #1104: logCascade no-ops under isTestMode(), so the only way to assert on
	// its call shape (e.g. the neighbor_touch `inconclusive` metadata flag) is to
	// spy on it directly rather than reading cascade.log.
	logCascade: vi.fn(),
}));

vi.mock("../../clients/review-graph/service.js", () => ({
	buildOrUpdateGraph: mocks.buildOrUpdateGraph,
	computeImpactCascade: mocks.computeImpactCascade,
	computeTransitiveImpact: mocks.computeTransitiveImpact,
	formatImpactCascade: mocks.formatImpactCascade,
}));

vi.mock("../../clients/cascade-logger.js", () => ({
	logCascade: mocks.logCascade,
	flushCascadeLog: vi.fn().mockResolvedValue(undefined),
	getCascadeLogPath: vi.fn().mockReturnValue("/tmp/cascade.log"),
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

/**
 * #4486: the compute reads a cached diagnostics entry only when it was
 * published after the compute started (`isPostEditObservation`). Doubles that
 * stand for a current snapshot stamp it one second ahead, a publish landing
 * while the compute runs.
 */
const postEditTs = () => Date.now() + 1_000;

/**
 * #4485: a silent-push client double that never publishes: the touch's
 * bounded wait resolves with no new publish for the file.
 */
function silentClient(serverId = "typescript") {
	return {
		serverId,
		diagnosticsVersion: 0,
		getDiagnosticsVersionForPath: () => 0,
		waitForDiagnostics: async (): Promise<void> => undefined,
		getDiagnostics: (_file: string): ReturnType<typeof lspError>[] => [],
		isAlive: () => true,
	};
}

// #1095: attach a content `binding` the way the REAL producers do — a
// NON-enumerable property (getAllDiagnostics uses a lazy getter, touchFile a
// value; both non-enumerable). Mirroring non-enumerability also guards against a
// future regression where the cascade reads `.binding` off a spread/clone (which
// silently drops it). `undefined` means no binding attached at all — the honest
// pre-#1095 fall-through, identical to "unknown" at every call site.
function withBinding<T extends object>(
	obj: T,
	boundToCurrentDisk: boolean | "unknown",
): T {
	Object.defineProperty(obj, "binding", {
		value: { boundToCurrentDisk },
		enumerable: false,
		configurable: true,
	});
	return obj;
}

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
		// No service until a case installs one (`getLSPService: vi.fn()` answered
		// undefined). After `vi.resetModules()`: the install evaluates the fresh graph.
		await installLspServiceDouble(null);
		mocks.logCascade.mockReset();
		const { resetDispatchBaselines } =
			await import("../../clients/dispatch/integration.js");
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
			installLspService({
				...makeLspServiceDouble(),
				getAllDiagnostics: vi
					.fn()
					.mockResolvedValue(
						new Map([
							[
								neighbor.split(path.sep).join("/"),
								{ diags: [lspError()], ts: postEditTs() },
							],
						]),
					),
				touchFile,
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");
			const result = await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});

			expect(touchFile).not.toHaveBeenCalled();
			expect(result?.result?.neighbors[0]?.diagnostics[0]?.filePath).toBe(
				neighbor,
			);
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
			installLspService({
				...makeLspServiceDouble(),
				getAllDiagnostics: vi.fn().mockResolvedValue(
					new Map([
						[
							direct.split(path.sep).join("/"),
							{ diags: [lspError("d")], ts: postEditTs() },
						],
						[
							indirect.split(path.sep).join("/"),
							{ diags: [lspError("i")], ts: postEditTs() },
						],
					]),
				),
				touchFile: vi.fn(),
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");
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

	it("marks a capped transitive expansion indeterminate even when the file slice fits", async () => {
		const env = setupTestEnvironment("cascade-transitive-truncated-");
		try {
			const primary = path.join(env.tmpDir, "src", "primary.ts");
			const neighbor = path.join(env.tmpDir, "src", "neighbor.py");
			fs.mkdirSync(path.dirname(primary), { recursive: true });
			fs.writeFileSync(primary, "export const x = 1;\n");
			fs.writeFileSync(neighbor, "from primary import x\n");
			mocks.computeImpactCascade.mockReturnValue(impact(primary, [neighbor]));
			mocks.computeTransitiveImpact.mockReturnValue({
				seedFile: primary,
				hits: [{ symbol: "", file: neighbor, depth: 1, relation: "imports" }],
				truncated: true,
				maxDepthReached: 1,
			});
			installLspService({
				...makeLspServiceDouble(),
				getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
				touchFile: vi.fn().mockResolvedValue({
					diags: [lspError("capped")],
				}),
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");
			const run = await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});

			expect(run.indeterminate).toMatchObject({
				reason: "budget_truncated",
				budget: { truncatedCount: 0, transitiveTruncated: true },
			});
			expect(run.indeterminate?.detail).toContain(
				"transitive expansion was capped before all eligible dependents were enumerated",
			);
			expect(cascadeResultMetadata()).toMatchObject({
				transitiveTruncated: true,
			});
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
			installLspService({
				...makeLspServiceDouble(),
				getAllDiagnostics: vi
					.fn()
					.mockResolvedValue(
						new Map([
							[
								reference.split(path.sep).join("/"),
								{ diags: [lspError("reference broken")], ts: postEditTs() },
							],
						]),
					),
				touchFile: vi.fn(),
				getDiagnostics: vi.fn(),
				references,
			});

			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");
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

	// #1109: the LSP-references blast-radius upgrade races `references()`
	// against a 750ms setTimeout. When `references()` wins (the common case —
	// the mocked LSP resolves synchronously), the losing setTimeout must be
	// cleared. Pre-fix, the handle was never stored, so the timer stayed a
	// REF'D pending timer for the remaining budget — a same-shape sibling of
	// the #1097 LSP client-wait leak (a one-shot `pi --print` process would
	// stay alive up to 750ms per changed symbol after the run settled).
	//
	// Uses fake timers (vi.getTimerCount, matching
	// tests/clients/lsp/client-wait-timer-cleanup.test.ts's pattern) so a
	// leaked timer is provable rather than merely "fires after the test ends."
	it("clears the LSP-references race timer once references() wins (#1109)", async () => {
		vi.useFakeTimers();
		const env = setupTestEnvironment("cascade-lsp-refs-timer-");
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
			// Resolves via a microtask — fake timers don't block microtask
			// resolution, only the setTimeout callback queue — so this wins the
			// Promise.race well before the 750ms timer would ever fire.
			const references = vi.fn().mockResolvedValue([
				{
					uri: pathToFileURL(reference).href,
					range: {
						start: { line: 1, character: 0 },
						end: { line: 1, character: 7 },
					},
				},
			]);
			installLspService({
				...makeLspServiceDouble(),
				getAllDiagnostics: vi
					.fn()
					.mockResolvedValue(
						new Map([
							[
								reference.split(path.sep).join("/"),
								{ diags: [lspError("reference broken")], ts: postEditTs() },
							],
						]),
					),
				touchFile: vi.fn(),
				getDiagnostics: vi.fn(),
				references,
			});

			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");
			const result = await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});

			expect(references).toHaveBeenCalled();
			expect(result?.result?.formatted).toContain("consumer.ts");
			// The core assertion: on pre-fix code this is 1 (the orphaned 750ms
			// reject timer) — the exact handle that would keep a one-shot
			// process alive after this call resolves.
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			env.cleanup();
			vi.useRealTimers();
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
			const touchFile = vi
				.fn()
				.mockResolvedValue({ diags: [lspError("python broken")] });
			installLspService({
				...makeLspServiceDouble(),
				getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
				touchFile,
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");
			const result = await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});

			// #1720: the cascade's neighbor re-check touches with `clientScope:
			// "primary"` (language server only), not "all". A neighbor's content did
			// not change — only its import target did — so an auxiliary scanner's
			// (ast-grep/opengrep/typos) file-local verdict for it cannot have
			// changed, and `reconcileCascadeNeighborLspErrors` discards any
			// aux-sourced re-derivation by construction (see the merge test below).
			// Asking aux servers here only cost notify traffic and confirmation
			// latency for a re-derivation nothing ever reads.
			expect(touchFile).toHaveBeenCalledWith(
				neighbor,
				expect.any(String),
				expect.objectContaining({
					silent: true,
					source: "cascade",
					clientScope: "primary",
					collectDiagnostics: true,
					// #3481: the neighbour read's stamp rides the touch.
					readStamp: expect.any(Number),
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

	it("#1720: a cascade neighbor re-check does not fan out to auxiliary servers, and the widget still renders the neighbor's preserved aux finding afterward", async () => {
		const env = setupTestEnvironment("cascade-aux-scope-");
		try {
			const { recordDiagnostics, getFileDiagnostics, clearWidgetState } =
				await import("../../clients/widget-state.js");
			clearWidgetState();

			const primary = path.join(env.tmpDir, "model.py");
			const neighbor = path.join(env.tmpDir, "api.py");
			fs.writeFileSync(primary, "class User: pass\n");
			fs.writeFileSync(neighbor, "from model import User\n");

			// Seed the neighbor with an existing auxiliary (ast-grep) finding from an
			// earlier per-edit run — the state a cascade touch can never legitimately
			// change, since the neighbor's own content is untouched.
			const normalizedNeighbor = neighbor.split(path.sep).join("/");
			recordDiagnostics(
				normalizedNeighbor,
				[
					{
						severity: "warning",
						tool: "ast-grep",
						message: "existing ast-grep finding",
						rule: "no-foo",
					},
				],
				1,
			);

			mocks.computeImpactCascade.mockReturnValue(impact(primary, [neighbor]));
			const touchFile = vi
				.fn()
				.mockResolvedValue({ diags: [lspError("cross-file type error")] });
			installLspService({
				...makeLspServiceDouble(),
				getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
				touchFile,
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");
			await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 2,
			});

			// The fix: no auxiliary server is ever asked for this neighbor.
			expect(touchFile).toHaveBeenCalledWith(
				neighbor,
				expect.any(String),
				expect.objectContaining({ clientScope: "primary" }),
			);

			// The widget still renders BOTH: the neighbor's preserved ast-grep
			// finding (never re-derived, never touched) and the fresh cross-file LSP
			// error the cascade actually confirmed.
			const rendered = getFileDiagnostics(normalizedNeighbor);
			expect(rendered?.find((d) => d.tool === "ast-grep")?.message).toBe(
				"existing ast-grep finding",
			);
			expect(rendered?.find((d) => d.tool === "lsp")?.message).toBe(
				"cross-file type error",
			);

			clearWidgetState();
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
			installLspService({
				...makeLspServiceDouble(),
				getAllDiagnostics: vi
					.fn()
					.mockResolvedValue(
						new Map([
							[
								fallbackFile.split(path.sep).join("/"),
								{ diags: [lspError("fallback error")], ts: postEditTs() },
							],
						]),
					),
				touchFile,
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");
			const result = await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});

			expect(touchFile).not.toHaveBeenCalled();
			expect(
				result?.result?.neighbors.some((n) => n.reason === "fallback"),
			).toBe(true);
			expect(result?.result?.formatted).toContain("fallback error");

			const cascadeResultEntry = mocks.logCascade.mock.calls
				.map(([entry]) => entry)
				.find((entry) => entry.phase === "cascade_result");
			expect(cascadeResultEntry?.metadata).toMatchObject({
				candidateNeighborCount: 1,
				eligibleNeighborCount: 1,
				filterDroppedCount: 0,
				selectedNeighborCount: 1,
				selectedOutcomeCount: 1,
				noLspConfigured: 1,
				passiveSnapshotHits: 0,
				selectedOutcomeGap: 0,
			});

			const neighborFallbackEntry = mocks.logCascade.mock.calls
				.map(([entry]) => entry)
				.find((entry) => entry.phase === "neighbor_fallback");
			expect(neighborFallbackEntry).toMatchObject({
				fallbackUsed: false,
				error: "no_lsp_server_configured",
			});
		} finally {
			env.cleanup();
		}
	});

	it("uses passive fallback only for no-LSP candidates in a mixed cascade", async () => {
		const env = setupTestEnvironment("cascade-mixed-fallback-");
		try {
			const primary = path.join(env.tmpDir, "main.ts");
			const noLspNeighbor = path.join(env.tmpDir, "neighbor.foo");
			const normalNeighbor = path.join(env.tmpDir, "neighbor.py");
			const unrelated = path.join(env.tmpDir, "unrelated.ts");
			fs.writeFileSync(primary, "export const x = 1;\n");
			fs.writeFileSync(noLspNeighbor, "neighbor\n");
			fs.writeFileSync(normalNeighbor, "from main import x\n");
			fs.writeFileSync(unrelated, "const unrelated = true;\n");
			mocks.computeImpactCascade.mockReturnValue(
				impact(primary, [noLspNeighbor, normalNeighbor]),
			);
			const touchFile = vi
				.fn()
				.mockResolvedValue({ diags: [lspError("normal error")] });
			installLspService({
				...makeLspServiceDouble(),
				getAllDiagnostics: vi.fn().mockResolvedValue(
					new Map([
						[
							noLspNeighbor.split(path.sep).join("/"),
							{ diags: [lspError("no-server error")], ts: postEditTs() },
						],
						[
							unrelated.split(path.sep).join("/"),
							{ diags: [lspError("unrelated error")], ts: postEditTs() },
						],
					]),
				),
				touchFile,
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");
			const result = await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});

			expect(touchFile).toHaveBeenCalledWith(
				normalNeighbor,
				expect.any(String),
				expect.objectContaining({ source: "cascade" }),
			);
			const formatted = result?.result?.formatted ?? "";
			expect(formatted).toContain("normal error");
			expect(formatted).toContain("no-server error");
			expect(formatted).not.toContain("unrelated error");
			// #1683: the no-LSP-configured neighbor is surfaced through the
			// passive-fallback path, which pushes the raw allDiags Map key as
			// `filePath` — that key is always `normalizeMapKey`-shaped (forward
			// slashes), not the native-separator candidate path the "normal"
			// touched neighbor gets. On POSIX those two shapes are byte-identical,
			// so a literal `toContain(noLspNeighbor)` passed on Linux CI by
			// accident and only broke on a Windows host (`\` vs `/`). Compare
			// through the same normalizer the production code keys on, rather
			// than assuming a path shape.
			const neighborFiles = (result?.result?.neighbors ?? []).map((n) =>
				normalizeMapKey(n.filePath),
			);
			expect(neighborFiles).toContain(normalizeMapKey(noLspNeighbor));
			expect(neighborFiles).not.toContain(normalizeMapKey(unrelated));

			const neighborFallbackEntry = mocks.logCascade.mock.calls
				.map(([entry]) => entry)
				.find(
					(entry) =>
						entry.phase === "neighbor_fallback" &&
						entry.neighborFile === noLspNeighbor,
				);
			expect(neighborFallbackEntry).toMatchObject({
				fallbackUsed: false,
				error: "no_lsp_server_configured",
			});
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
				.mockResolvedValue({ diags: [lspError("type error in neighbor")] });
			installLspService({
				...makeLspServiceDouble(),
				// Empty allDiags — no snapshot for neighbor (cold session)
				getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
				touchFile,
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");
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

	// #4485: a silent server with nothing to pull with (no
	// typescript.tsserverRequest advertised) is touched without collecting and
	// given a bounded wait for a publish; silence records it outstanding and
	// marks the run unconfirmed, never clean.
	it("#458: a tier-3 neighbor with no command to pull with waits for a publish and records it outstanding on silence", async () => {
		const env = setupTestEnvironment("cascade-tier3-skip-");
		try {
			const primary = path.join(env.tmpDir, "src", "primary.ts");
			const neighbor = path.join(env.tmpDir, "src", "neighbor.ts");
			fs.mkdirSync(path.dirname(primary), { recursive: true });
			fs.writeFileSync(primary, "export const x = 1;\n");
			fs.writeFileSync(neighbor, "import { x } from './primary';\n");
			mocks.computeImpactCascade.mockReturnValue(impact(primary, [neighbor]));

			const beforeTouch = Date.now();
			const touchFile = vi.fn();
			const getClientForFile = vi.fn().mockResolvedValue({
				client: silentClient(),
			});
			const getCapabilitySnapshots = vi.fn().mockResolvedValue([
				{
					serverId: "typescript",
					root: env.tmpDir,
					operationSupport: {},
					workspaceDiagnosticsSupport: { mode: "push-only" },
					advertisedCommands: [],
					rawCapabilityKeys: [],
				},
			]);
			installLspService({
				...makeLspServiceDouble(),
				// Empty allDiags — no snapshot for neighbor (cold session), forces
				// the active-touch branch rather than the passive-snapshot read.
				getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
				getCapabilitySnapshots,
				getClientForFile,
				touchFile,
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");
			const { _getOutstandingCascadeTouchesForTests } =
				await import("../../clients/lsp/cascade-tier.js");

			const result = await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});

			// The wait-skipping touch still fires the notify (didOpen/didChange),
			// just with the wait disabled — never a wholesale no-touch.
			expect(touchFile).toHaveBeenCalledWith(
				neighbor,
				expect.any(String),
				expect.objectContaining({
					diagnostics: "none",
					collectDiagnostics: false,
					clientScope: "primary",
					// #3481: the neighbour read's stamp rides the touch.
					readStamp: expect.any(Number),
				}),
			);
			// Recorded outstanding for the quiet-window reconcile — not silently
			// dropped, not silently treated as clean.
			const outstanding = _getOutstandingCascadeTouchesForTests();
			expect(outstanding).toHaveLength(1);
			expect(outstanding[0]).toMatchObject({ serverId: "typescript" });
			// touchedAt is sampled BEFORE the notify (pre-touchFile), so a publish
			// racing the record can never be misread as pre-touch at reconcile.
			expect(outstanding[0].touchedAt).toBeGreaterThanOrEqual(beforeTouch);
			expect(outstanding[0].touchedAt).toBeLessThanOrEqual(Date.now());
			// No answer came, so the run is not clean: it names the neighbour as
			// unconfirmed for turn_end's pending line.
			expect(result?.result?.neighbors[0]?.diagnostics ?? []).toEqual([]);
			expect(result.skipReason).toBe("indeterminate");
			expect(result.unconfirmed?.servers[0]?.paths).toEqual([neighbor]);
		} finally {
			env.cleanup();
		}
	});

	it("#458: PI_LENS_TIER_AWARE_CASCADE=0 disables the skip — tier-3 neighbor still waits in-lane", async () => {
		const original = process.env.PI_LENS_TIER_AWARE_CASCADE;
		process.env.PI_LENS_TIER_AWARE_CASCADE = "0";
		const env = setupTestEnvironment("cascade-tier3-killswitch-");
		try {
			const primary = path.join(env.tmpDir, "src", "primary.ts");
			const neighbor = path.join(env.tmpDir, "src", "neighbor.ts");
			fs.mkdirSync(path.dirname(primary), { recursive: true });
			fs.writeFileSync(primary, "export const x = 1;\n");
			fs.writeFileSync(neighbor, "import { x } from './primary';\n");
			mocks.computeImpactCascade.mockReturnValue(impact(primary, [neighbor]));

			const touchFile = vi
				.fn()
				.mockResolvedValue({ diags: [lspError("type error in neighbor")] });
			const getCapabilitySnapshots = vi.fn();
			const getClientForFile = vi.fn();
			installLspService({
				...makeLspServiceDouble(),
				getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
				getCapabilitySnapshots,
				getClientForFile,
				touchFile,
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile, resetDispatchBaselines: _reset } =
				await import("../../clients/dispatch/integration.js");
			const { _resetTierAwareCascadeEnabledForTests } =
				await import("../../clients/lsp/cascade-tier.js");
			_resetTierAwareCascadeEnabledForTests();

			await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});

			// Kill switch off: classification is never even attempted, and the
			// full in-lane wait (collectDiagnostics: true) is used, same as before #458.
			expect(getCapabilitySnapshots).not.toHaveBeenCalled();
			expect(touchFile).toHaveBeenCalledWith(
				neighbor,
				expect.any(String),
				expect.objectContaining({ collectDiagnostics: true }),
			);
		} finally {
			env.cleanup();
			if (original === undefined) {
				delete process.env.PI_LENS_TIER_AWARE_CASCADE;
			} else {
				process.env.PI_LENS_TIER_AWARE_CASCADE = original;
			}
			const { _resetTierAwareCascadeEnabledForTests } =
				await import("../../clients/lsp/cascade-tier.js");
			_resetTierAwareCascadeEnabledForTests();
		}
	});

	it("#1444: native-ts7 waits for its publish and records a collect-later touch on silence", async () => {
		const env = setupTestEnvironment("cascade-native-ts7-collect-later-");
		try {
			const primary = path.join(env.tmpDir, "src", "primary.ts");
			const neighbor = path.join(env.tmpDir, "src", "neighbor.ts");
			fs.mkdirSync(path.dirname(primary), { recursive: true });
			fs.writeFileSync(primary, "export const x = 1;\n");
			fs.writeFileSync(neighbor, "import { x } from './primary';\n");
			mocks.computeImpactCascade.mockReturnValue(impact(primary, [neighbor]));
			const touchFile = vi.fn();
			installLspService({
				...makeLspServiceDouble(),
				getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
				getCapabilitySnapshots: vi.fn().mockResolvedValue([
					{
						serverId: "typescript",
						root: env.tmpDir,
						workspaceDiagnosticsSupport: { mode: "push-only" },
						launchVariant: "native-ts7",
					},
				]),
				getClientForFile: vi.fn().mockResolvedValue({
					client: silentClient(),
				}),
				touchFile,
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");
			const {
				_getOutstandingCascadeTouchesForTests,
				reconcileOutstandingCascadeTouches,
			} = await import("../../clients/lsp/cascade-tier.js");
			await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});

			expect(touchFile).toHaveBeenCalledWith(
				neighbor,
				expect.any(String),
				expect.objectContaining({
					diagnostics: "none",
					collectDiagnostics: false,
					clientScope: "primary",
				}),
			);
			expect(_getOutstandingCascadeTouchesForTests()).toEqual([
				expect.objectContaining({ filePath: neighbor, serverId: "typescript" }),
			]);
			expect(mocks.logCascade).toHaveBeenCalledWith(
				expect.objectContaining({
					phase: "cascade_tier3_skip",
					metadata: expect.objectContaining({ waitTier: "collect-later" }),
				}),
			);
			// #1444: a cascade that deferred EVERY neighbour looks exactly like a
			// clean leaf in cascade.log (no neighbours, no output) unless the
			// deferral count says otherwise.
			expect(mocks.logCascade).toHaveBeenCalledWith(
				expect.objectContaining({
					phase: "cascade_result",
					metadata: expect.objectContaining({ collectLaterSkipped: 1 }),
				}),
			);
			const settled = await reconcileOutstandingCascadeTouches({
				getWarmClientForFile: vi.fn().mockResolvedValue({
					client: {
						serverId: "typescript",
						getAllDiagnostics: vi.fn().mockReturnValue(
							new Map([
								[
									normalizeMapKey(neighbor),
									{
										diags: [lspError("late native TS7 error")],
										ts: Date.now() + 1,
									},
								],
							]),
						),
					},
				}),
			} as any);
			expect(settled).toEqual([
				expect.objectContaining({
					outcome: "resolved-found",
					diagnosticCount: 1,
					diagnostics: [
						expect.objectContaining({ message: "late native TS7 error" }),
					],
				}),
			]);
		} finally {
			env.cleanup();
		}
	});

	// #1899: this used to assert the same-write `neighborTouchCache` short-
	// circuited the re-touch. That cache is gone. It could only hit when two
	// cascades ran inside ONE write, and `writeSeq` (pi's per-write index)
	// advances on every write, so live sessions measured 0 hits across 236 cold
	// touches. The test now pins the behavior that replaced it: a repeat cascade
	// re-touches, and `cacheHits` is no longer part of the result record.
	it("#1899: a repeat cascade in the same write re-touches (no same-write neighbor cache)", async () => {
		const env = setupTestEnvironment("cascade-cache-hits-");
		try {
			const primary = path.join(env.tmpDir, "model.py");
			const neighbor = path.join(env.tmpDir, "api.py");
			fs.writeFileSync(primary, "class User: pass\n");
			fs.writeFileSync(neighbor, "from model import User\n");
			mocks.computeImpactCascade.mockReturnValue(impact(primary, [neighbor]));
			const touchFile = vi
				.fn()
				.mockResolvedValue({ diags: [lspError("cascade result")] });
			installLspService({
				...makeLspServiceDouble(),
				getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
				touchFile,
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");

			await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});
			expect(touchFile).toHaveBeenCalledTimes(1);
			mocks.logCascade.mockClear();

			await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});
			expect(touchFile).toHaveBeenCalledTimes(2);

			const resultCall = mocks.logCascade.mock.calls.find(
				(call) => (call[0] as { phase?: string }).phase === "cascade_result",
			);
			const metadata = (resultCall![0] as { metadata: Record<string, unknown> })
				.metadata;
			expect(metadata).toMatchObject({ coldTouches: 1 });
			expect(metadata).not.toHaveProperty("cacheHits");
			// #4486: the recently-clean cache went the same way.
			expect(metadata).not.toHaveProperty("recentlyCleanHits");
		} finally {
			env.cleanup();
		}
	});

	// F1 (adversarial review of #1446): `coldTouches` used to be derived from
	// `coldSnapshotPaths.length`, a list finalized BEFORE the outcome checks
	// inside the touch pool run — so a neighbour could double-count or vanish
	// from every bucket. This exercises the touch-pool outcomes in ONE run:
	// `neighborColdTs` (.ts, autoPropagate) sits in `coldSnapshotPaths` on every
	// run (its snapshot is never valid) and takes a genuine cold touch, while
	// `neighborCold` (.py, activePaths) takes a genuine cold touch too and would
	// be invisible to the old `coldSnapshotPaths.length` derivation entirely.
	// The counters must still partition the touched-neighbour count exactly.
	//
	// #1899 dropped the `cacheHits` bucket with the dead `neighborTouchCache`;
	// #4486 dropped `recentlyCleanHits` with the recently-clean cache (the
	// clean neighbour is touched again), and #4485 split the silent-push touch
	// into `silentWaitTouches` with its unanswered subset `deferredTouches`.
	it("F1: coldTouches/silentWaitTouches partition the touched-neighbour set", async () => {
		const env = setupTestEnvironment("cascade-f1-partition-");
		try {
			const primary = path.join(env.tmpDir, "hub.py");
			const neighborColdTs = path.join(env.tmpDir, "src", "cache_hit.ts");
			const neighborClean = path.join(env.tmpDir, "recently_clean.py");
			const neighborCold = path.join(env.tmpDir, "genuinely_cold.py");
			const neighborDeferred = path.join(env.tmpDir, "src", "deferred.ts");
			fs.writeFileSync(primary, "class Hub: pass\n");
			fs.mkdirSync(path.dirname(neighborColdTs), { recursive: true });
			fs.writeFileSync(neighborColdTs, "export const cacheHit = 1;\n");
			fs.writeFileSync(neighborClean, "from hub import Hub  # clean\n");
			fs.writeFileSync(neighborCold, "from hub import Hub  # cold\n");
			fs.writeFileSync(
				neighborDeferred,
				"import { cacheHit } from './cache_hit';\n",
			);

			const touchFile = vi.fn().mockImplementation(async (p: string) => {
				if (p === neighborColdTs) return { diags: [lspError("cache seed")] };
				if (p === neighborClean) return { diags: [] };
				if (p === neighborCold) return { diags: [lspError("genuinely cold")] };
				return undefined; // neighborDeferred's notify-only touch
			});
			const getCapabilitySnapshots = vi
				.fn()
				.mockImplementation(async (p: string) => {
					if (p !== neighborDeferred) return [];
					return [
						{
							serverId: "typescript",
							root: env.tmpDir,
							workspaceDiagnosticsSupport: { mode: "push-only" },
							launchVariant: "native-ts7",
						},
					];
				});
			const getClientForFile = vi.fn().mockResolvedValue({
				client: silentClient(),
			});
			installLspService({
				...makeLspServiceDouble(),
				getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
				getCapabilitySnapshots,
				getClientForFile,
				touchFile,
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");

			// Setup run: a confirmed clean touch of neighborClean, which the
			// recently-clean cache used to answer for on the next run.
			mocks.computeImpactCascade.mockReturnValueOnce(
				impact(primary, [neighborColdTs, neighborClean]),
			);
			await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});
			expect(touchFile).toHaveBeenCalledTimes(2);
			mocks.logCascade.mockClear();

			// Main run, SAME turnSeq/writeSeq, plus two new neighbours.
			mocks.computeImpactCascade.mockReturnValueOnce(
				impact(primary, [
					neighborColdTs,
					neighborClean,
					neighborCold,
					neighborDeferred,
				]),
			);
			await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});

			const resultCall = mocks.logCascade.mock.calls.find(
				(call) => (call[0] as { phase?: string }).phase === "cascade_result",
			);
			expect(resultCall).toBeDefined();
			const metadata = (
				resultCall![0] as {
					metadata: {
						coldTouches: number;
						silentWaitTouches: number;
						deferredTouches: number;
					};
				}
			).metadata;
			expect(metadata).toMatchObject({
				coldTouches: 3,
				silentWaitTouches: 1,
				deferredTouches: 1,
			});
			expect(metadata).not.toHaveProperty("recentlyCleanHits");
			// The partition invariant: every touched neighbour (the 4 in this
			// run's pool) lands in EXACTLY one bucket — no double-count (the old
			// coldSnapshotPaths.length bug), no silent drop (the old activePaths
			// undercounting bug).
			const touchedNeighbourCount = 4;
			expect(metadata.coldTouches + metadata.silentWaitTouches).toBe(
				touchedNeighbourCount,
			);
		} finally {
			env.cleanup();
		}
	});

	it("#1446 item 4: cascade_result records the neighbour budget in force and how many eligible candidates it truncated", async () => {
		const env = setupTestEnvironment("cascade-budget-truncated-");
		try {
			const primary = path.join(env.tmpDir, "hub.py");
			fs.writeFileSync(primary, "class Hub: pass\n");
			// One more neighbour than the default 40-neighbour budget so the cap
			// (not the existence/vendor/ignore filters) is the thing truncating.
			const neighborCount = 41;
			const neighbors: string[] = [];
			for (let i = 0; i < neighborCount; i++) {
				const neighborPath = path.join(env.tmpDir, `dep${i}.py`);
				fs.writeFileSync(neighborPath, `from hub import Hub  # dep ${i}\n`);
				neighbors.push(neighborPath);
			}
			mocks.computeImpactCascade.mockReturnValue(impact(primary, neighbors));
			installLspService({
				...makeLspServiceDouble(),
				getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
				touchFile: vi.fn().mockResolvedValue({ diags: [] }),
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");
			await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});

			expect(mocks.logCascade).toHaveBeenCalledWith(
				expect.objectContaining({
					phase: "cascade_result",
					metadata: expect.objectContaining({
						neighborBudget: 40,
						budgetTruncated: 1,
					}),
				}),
			);
		} finally {
			env.cleanup();
		}
	}, 30_000);

	// #1462: the budget is derived from `Date.now() - <cascade entry>`, and
	// `computeImpactCascade` runs between those two samples — advancing a stubbed
	// clock inside it charges a synthetic prelude (graph build + reverse-deps
	// refresh) against the settle window without sleeping in the test.
	function chargePrelude(
		preludeMs: number,
		value: ImpactCascadeResult,
	): { restore: () => void } {
		let clock = 1_700_000_000_000;
		const spy = vi.spyOn(Date, "now").mockImplementation(() => clock);
		mocks.computeImpactCascade.mockImplementation(() => {
			clock += preludeMs;
			return value;
		});
		return { restore: () => spy.mockRestore() };
	}

	function budgetFixture(tmpDir: string, neighborCount: number) {
		const primary = path.join(tmpDir, "hub.py");
		fs.writeFileSync(primary, "class Hub: pass\n");
		const neighbors: string[] = [];
		for (let i = 0; i < neighborCount; i++) {
			const neighborPath = path.join(tmpDir, `dep${i}.py`);
			fs.writeFileSync(neighborPath, `from hub import Hub  # dep ${i}\n`);
			neighbors.push(neighborPath);
		}
		const touchFile = vi.fn().mockResolvedValue({ diags: [] });
		installLspService({
			...makeLspServiceDouble(),
			getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
			touchFile,
			getDiagnostics: vi.fn(),
		});
		return { primary, neighbors, touchFile };
	}

	function cascadeResultMetadata(): Record<string, unknown> {
		const call = mocks.logCascade.mock.calls.find(
			(c) => (c[0] as { phase?: string }).phase === "cascade_result",
		);
		expect(call).toBeDefined();
		return (call![0] as { metadata: Record<string, unknown> }).metadata;
	}

	// #5013: `cascade_result`'s `neighbors[].file` is the only surface that reads
	// the posix fold (the widget and formatted paths keep the full neighbour
	// path), so it is the record that witnesses the fold at that site. On win32
	// every nested path spells its separators with backslashes; on POSIX the fold
	// is observable only through a literal backslash in a directory name.
	it("#5013: cascade_result folds a backslash-spelled neighbour path for display (integration.ts)", async () => {
		const env = setupTestEnvironment("cascade-neighbor-fold-");
		try {
			const primary = path.join(env.tmpDir, "hub.py");
			fs.writeFileSync(primary, "class Hub: pass\n");
			const neighbourDir =
				process.platform === "win32" ? path.join("sub", "dir") : "sub\\dir";
			const neighborPath = path.join(env.tmpDir, neighbourDir, "dep.py");
			fs.mkdirSync(path.dirname(neighborPath), { recursive: true });
			fs.writeFileSync(neighborPath, "from hub import Hub\n");
			mocks.computeImpactCascade.mockReturnValue(
				impact(primary, [neighborPath]),
			);
			installLspService({
				...makeLspServiceDouble(),
				getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
				touchFile: vi.fn().mockResolvedValue({ diags: [lspError()] }),
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");
			await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});

			expect(cascadeResultMetadata().neighbors).toContainEqual(
				expect.objectContaining({ file: "dir/dep.py" }),
			);
		} finally {
			env.cleanup();
		}
	}, 30_000);

	it("#1462: a cascade inside the rescue band walks fewer neighbours instead of overrunning the on-time window", async () => {
		const env = setupTestEnvironment("cascade-budget-pressured-");
		const fixture = budgetFixture(env.tmpDir, 41);
		// 4000 ms of the 5000 ms window gone before the walk is even sized —
		// the shape of the measured logger.ts run (2046 ms reverse-deps refresh
		// ahead of a 38-neighbour walk that then blew the cap). 1000 ms left is
		// above the floor's 500 ms, so a shorter walk genuinely lands on time.
		const clock = chargePrelude(
			4000,
			impact(fixture.primary, fixture.neighbors),
		);
		try {
			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");
			const run = await computeCascadeForFile(fixture.primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});

			// 1000 ms left / 100 ms per neighbour = 10, not the flat 40.
			expect(run.indeterminate).toMatchObject({
				reason: "budget_truncated",
				budget: { truncatedCount: 31 },
			});
			expect(fixture.touchFile).toHaveBeenCalledTimes(10);
			expect(cascadeResultMetadata()).toMatchObject({
				neighborBudget: 10,
				neighborBudgetCeiling: 40,
				budgetRemainingMs: 1000,
				budgetZone: "narrowed",
				budgetTruncated: 31,
			});
		} finally {
			clock.restore();
			env.cleanup();
		}
	}, 30_000);

	it("#1462: the transitive expansion is capped by the derived budget, not the flat one", async () => {
		const env = setupTestEnvironment("cascade-budget-maxhits-");
		const fixture = budgetFixture(env.tmpDir, 41);
		const clock = chargePrelude(
			4000,
			impact(fixture.primary, fixture.neighbors),
		);
		try {
			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");
			await computeCascadeForFile(fixture.primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});

			// A rescued run must not pay for a 40-hit BFS it is then going to
			// throw 30 of away — the cap has to carry the SAME derived number the
			// slice uses, or "expands less as well as walking less" is a claim
			// with nothing behind it.
			expect(mocks.computeTransitiveImpact).toHaveBeenCalledWith(
				expect.anything(),
				expect.any(String),
				expect.objectContaining({ maxHits: 10 }),
			);
		} finally {
			clock.restore();
			env.cleanup();
		}
	}, 30_000);

	it("#1462: a window blown past rescue keeps the FULL budget rather than walking a stub", async () => {
		const env = setupTestEnvironment("cascade-budget-blown-");
		const fixture = budgetFixture(env.tmpDir, 41);
		// The cold-session case: a fresh graph build measures up to ~19 s
		// (runtime-coordinator.ts's carry-over note). Nothing fits the on-time
		// window any more, so narrowing would drop 35 neighbours PERMANENTLY and
		// still miss — while #1443's carry-over delivers the whole set one turn
		// late. Pre-#1462 behaviour is the correct behaviour here.
		const clock = chargePrelude(
			19_000,
			impact(fixture.primary, fixture.neighbors),
		);
		try {
			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");
			await computeCascadeForFile(fixture.primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});

			expect(fixture.touchFile).toHaveBeenCalledTimes(40);
			expect(cascadeResultMetadata()).toMatchObject({
				neighborBudget: 40,
				neighborBudgetCeiling: 40,
				budgetRemainingMs: -14_000,
				budgetZone: "past-rescue",
				budgetTruncated: 1,
			});
		} finally {
			clock.restore();
			env.cleanup();
		}
	}, 30_000);

	it("#1462: the active settle clock ignores the pre-turn gap", async () => {
		const env = setupTestEnvironment("cascade-budget-pre-turn-gap-");
		const fixture = budgetFixture(env.tmpDir, 41);
		const base = 1_700_000_000_000;
		let now = base;
		const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
		mocks.computeImpactCascade.mockImplementation(() => {
			now += 4000;
			return impact(fixture.primary, fixture.neighbors);
		});
		try {
			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");
			await computeCascadeForFile(fixture.primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
				turnEndCascadeSettleStart: () => base + 3000,
			});

			expect(fixture.touchFile).toHaveBeenCalledTimes(40);
			expect(cascadeResultMetadata()).toMatchObject({
				neighborBudget: 40,
				budgetRemainingMs: 4000,
				budgetZone: "fits",
			});
		} finally {
			clock.mockRestore();
			env.cleanup();
		}
	}, 30_000);

	it("#1462: the common fast cascade keeps the full flat budget", async () => {
		const env = setupTestEnvironment("cascade-budget-ample-");
		const fixture = budgetFixture(env.tmpDir, 41);
		// Same stubbed clock as the pressured cases, zero prelude — so a failure
		// here means the derivation narrowed the walk, not that the stub did.
		const clock = chargePrelude(0, impact(fixture.primary, fixture.neighbors));
		try {
			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");
			await computeCascadeForFile(fixture.primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});

			expect(fixture.touchFile).toHaveBeenCalledTimes(40);
			expect(cascadeResultMetadata()).toMatchObject({
				neighborBudget: 40,
				neighborBudgetCeiling: 40,
				budgetRemainingMs: 5000,
				budgetZone: "fits",
				budgetTruncated: 1,
			});
		} finally {
			clock.restore();
			env.cleanup();
		}
	}, 30_000);

	it("#1462: shrinking PI_LENS_CASCADE_SETTLE_WAIT_MS does not turn it into a neighbour-count knob", async () => {
		const env = setupTestEnvironment("cascade-budget-settle-env-");
		const previous = process.env.PI_LENS_CASCADE_SETTLE_WAIT_MS;
		// 1200 ms cannot fit a 40-neighbour walk even at zero prelude, so there
		// is no LATE run to rescue — only every run to shrink. The derivation
		// stands down instead of capping every cascade at ~12.
		process.env.PI_LENS_CASCADE_SETTLE_WAIT_MS = "1200";
		const fixture = budgetFixture(env.tmpDir, 41);
		const clock = chargePrelude(0, impact(fixture.primary, fixture.neighbors));
		try {
			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");
			await computeCascadeForFile(fixture.primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});

			expect(fixture.touchFile).toHaveBeenCalledTimes(40);
			expect(cascadeResultMetadata()).toMatchObject({
				neighborBudget: 40,
				budgetRemainingMs: 1200,
				budgetZone: "no-rescue-window",
			});
		} finally {
			clock.restore();
			if (previous === undefined) {
				delete process.env.PI_LENS_CASCADE_SETTLE_WAIT_MS;
			} else {
				process.env.PI_LENS_CASCADE_SETTLE_WAIT_MS = previous;
			}
			env.cleanup();
		}
	}, 30_000);

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
			installLspService({
				...makeLspServiceDouble(),
				getAllDiagnostics: vi
					.fn()
					.mockResolvedValue(
						new Map([
							[
								neighbor.split(path.sep).join("/"),
								{ diags: [lspError("existing warning")], ts: postEditTs() },
							],
						]),
					),
				touchFile,
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");
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

	// #4487: deliberately INVERTED. This test pinned the rolling delta
	// (`applyCascadeDeltaBaselines`), which hid an error on the second run
	// because the first run had seen it, so a persistent neighbour error read
	// clean from then on. The delta is gone; every run lists what it observed
	// and turn_end labels what it delivered before.
	it("lists a repeated cascade diagnostic on every run (no rolling delta)", async () => {
		const env = setupTestEnvironment("cascade-delta-");
		try {
			const primary = path.join(env.tmpDir, "src", "primary.ts");
			const neighbor = path.join(env.tmpDir, "src", "neighbor.ts");
			fs.mkdirSync(path.dirname(primary), { recursive: true });
			fs.writeFileSync(primary, "export const x = 1;\n");
			fs.writeFileSync(neighbor, "import { x } from './primary';\n");
			mocks.computeImpactCascade.mockReturnValue(impact(primary, [neighbor]));
			installLspService({
				...makeLspServiceDouble(),
				getAllDiagnostics: vi
					.fn()
					.mockResolvedValue(
						new Map([
							[
								neighbor.split(path.sep).join("/"),
								{ diags: [lspError("same error")], ts: postEditTs() },
							],
						]),
					),
				touchFile: vi.fn(),
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");
			const first = await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});
			const second = await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 2,
				writeSeq: 1,
			});

			expect(first?.result?.formatted).toContain("same error");
			expect(second?.result?.formatted).toContain("same error");
			expect(second?.skipReason).toBeUndefined();
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
				.mockResolvedValueOnce({ diags: [lspError("error1")] })
				.mockResolvedValueOnce({ diags: [lspError("error2")] });
			installLspService({
				...makeLspServiceDouble(),
				getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
				touchFile,
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile, resetDispatchBaselines } =
				await import("../../clients/dispatch/integration.js");
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
			expect(second?.result?.neighbors[0]?.diagnostics[0]?.message).toBe(
				"error2",
			);
		} finally {
			env.cleanup();
		}
	});

	it("suppresses an ignored neighbour from cascade snapshot output (#297)", async () => {
		const env = setupTestEnvironment("cascade-ignore-snapshot-");
		try {
			// Anchor the ignore matcher at tmpDir (the shared fixture `.git` stops
			// resolveGitIgnoreRoot's upward walk) and ignore test files there.
			fs.writeFileSync(
				path.join(env.tmpDir, ".pi-lens.json"),
				JSON.stringify({ ignore: ["**/*.test.ts"] }),
			);
			const primary = path.join(env.tmpDir, "src", "reader.ts");
			const ignoredNeighbor = path.join(env.tmpDir, "src", "reader.test.ts");
			fs.mkdirSync(path.dirname(primary), { recursive: true });
			fs.writeFileSync(primary, "export const countTotal = 1;\n");
			fs.writeFileSync(
				ignoredNeighbor,
				"import { countTotal } from './reader';\n",
			);
			// The test file is a direct importer (a cascade neighbour) AND carries an
			// LSP error in the passive snapshot — the exact #297 false-positive shape.
			mocks.computeImpactCascade.mockReturnValue(
				impact(primary, [ignoredNeighbor]),
			);
			installLspService({
				...makeLspServiceDouble(),
				getAllDiagnostics: vi
					.fn()
					.mockResolvedValue(
						new Map([
							[
								ignoredNeighbor.split(path.sep).join("/"),
								{ diags: [lspError("countTotal not found")], ts: postEditTs() },
							],
						]),
					),
				touchFile: vi.fn(),
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");
			const result = await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});

			// The ignored test file must not surface as a cascade neighbour.
			expect(result?.result).toBeUndefined();
			expect(result?.skipReason).toBe("no_neighbors");
		} finally {
			env.cleanup();
		}
	});

	it("suppresses an ignored neighbour from cascade fallback output (#297)", async () => {
		const env = setupTestEnvironment("cascade-ignore-fallback-");
		try {
			fs.writeFileSync(
				path.join(env.tmpDir, ".pi-lens.json"),
				JSON.stringify({ ignore: ["**/*.test.ts"] }),
			);
			// No-LSP neighbour keeps producedLspData false → fallback path runs and
			// scans every open file in allDiags, including the ignored test file.
			const primary = path.join(env.tmpDir, "main.ts");
			const noLspNeighbor = path.join(env.tmpDir, "neighbor.foo");
			const ignoredOpen = path.join(env.tmpDir, "src", "main.test.ts");
			fs.mkdirSync(path.dirname(ignoredOpen), { recursive: true });
			fs.writeFileSync(primary, "export const x = 1;\n");
			fs.writeFileSync(noLspNeighbor, "neighbor\n");
			fs.writeFileSync(ignoredOpen, "const x = 1;\n");
			mocks.computeImpactCascade.mockReturnValue(
				impact(primary, [noLspNeighbor]),
			);
			installLspService({
				...makeLspServiceDouble(),
				getAllDiagnostics: vi.fn().mockResolvedValue(
					new Map([
						[
							ignoredOpen.split(path.sep).join("/"),
							{
								diags: [lspError("ignored fallback error")],
								ts: postEditTs(),
							},
						],
					]),
				),
				touchFile: vi.fn(),
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");
			const result = await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});

			expect(result?.result?.formatted ?? "").not.toContain(
				"ignored fallback error",
			);
			expect(
				result?.result?.neighbors.some((n) => n.reason === "fallback"),
			).not.toBe(true);
		} finally {
			env.cleanup();
		}
	});

	// ── #1080: test-role neighbors excluded from collateral cascade surfaces ──

	it("excludes an UNIGNORED test-role graph neighbour but keeps a source neighbour (#1080)", async () => {
		const env = setupTestEnvironment("cascade-test-role-graph-");
		try {
			const primary = path.join(env.tmpDir, "src", "reader.ts");
			const sourceNeighbor = path.join(env.tmpDir, "src", "consumer.ts");
			const testNeighbor = path.join(env.tmpDir, "src", "consumer.test.ts");
			fs.mkdirSync(path.dirname(primary), { recursive: true });
			fs.writeFileSync(primary, "export const countTotal = 1;\n");
			fs.writeFileSync(
				sourceNeighbor,
				"import { countTotal } from './reader';\n",
			);
			fs.writeFileSync(
				testNeighbor,
				"import { countTotal } from './reader';\n",
			);
			// Both the source AND the test file are direct importers with a passive
			// snapshot error — the test file is NOT ignored (no .pi-lens.json), so
			// only the #1080 role filter can drop it.
			mocks.computeImpactCascade.mockReturnValue(
				impact(primary, [sourceNeighbor, testNeighbor]),
			);
			const touchFile = vi.fn();
			installLspService({
				...makeLspServiceDouble(),
				getAllDiagnostics: vi.fn().mockResolvedValue(
					new Map([
						[
							sourceNeighbor.split(path.sep).join("/"),
							{ diags: [lspError("consumer error")], ts: postEditTs() },
						],
						[
							testNeighbor.split(path.sep).join("/"),
							{ diags: [lspError("test error")], ts: postEditTs() },
						],
					]),
				),
				touchFile,
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");
			const result = await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});

			// Only the source neighbour surfaces / is read.
			expect(touchFile).not.toHaveBeenCalled();
			const neighborFiles = result?.result?.neighbors.map((n) =>
				n.filePath.split(path.sep).join("/"),
			);
			expect(neighborFiles).toEqual([sourceNeighbor.split(path.sep).join("/")]);
			// The header input (impact) — read verbatim by formatImpactCascade — is
			// also clean: the test file leaks through neither Direct importers nor
			// Check next counts/names.
			const impactNeighbors = result?.result?.impact.neighborFiles ?? [];
			expect(impactNeighbors).toContain(sourceNeighbor);
			expect(impactNeighbors).not.toContain(testNeighbor);
			expect(result?.result?.impact.directImporters).not.toContain(
				testNeighbor,
			);
		} finally {
			env.cleanup();
		}
	});

	it("does not surface or touch an LSP reference that points at a test file (#1080)", async () => {
		const env = setupTestEnvironment("cascade-test-role-refs-");
		try {
			const primary = path.join(env.tmpDir, "src", "primary.ts");
			const sourceRef = path.join(env.tmpDir, "src", "consumer.ts");
			const testRef = path.join(env.tmpDir, "src", "consumer.test.ts");
			fs.mkdirSync(path.dirname(primary), { recursive: true });
			fs.writeFileSync(primary, "export function changed() { return 1; }\n");
			fs.writeFileSync(
				sourceRef,
				"import { changed } from './primary';\nchanged();\n",
			);
			fs.writeFileSync(
				testRef,
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
					uri: pathToFileURL(sourceRef).href,
					range: {
						start: { line: 1, character: 0 },
						end: { line: 1, character: 7 },
					},
				},
				{
					uri: pathToFileURL(testRef).href,
					range: {
						start: { line: 1, character: 0 },
						end: { line: 1, character: 7 },
					},
				},
			]);
			const touchFile = vi.fn();
			installLspService({
				...makeLspServiceDouble(),
				getAllDiagnostics: vi.fn().mockResolvedValue(
					new Map([
						[
							sourceRef.split(path.sep).join("/"),
							{ diags: [lspError("consumer broke")], ts: postEditTs() },
						],
						[
							testRef.split(path.sep).join("/"),
							{ diags: [lspError("test broke")], ts: postEditTs() },
						],
					]),
				),
				touchFile,
				getDiagnostics: vi.fn(),
				references,
			});

			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");
			const result = await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});

			const neighborKeys = (result?.result?.neighbors ?? []).map((n) =>
				n.filePath.split(path.sep).join("/"),
			);
			expect(neighborKeys).toContain(sourceRef.split(path.sep).join("/"));
			expect(neighborKeys).not.toContain(testRef.split(path.sep).join("/"));
			// The test reference is never a surfaced neighbour in the impact object.
			const impactKeys = (result?.result?.impact.neighborFiles ?? []).map((f) =>
				f.split(path.sep).join("/"),
			);
			expect(impactKeys).not.toContain(testRef.split(path.sep).join("/"));
		} finally {
			env.cleanup();
		}
	});

	it("drops an unignored test file from fallback, keeps source, still drops ignored (#1080/#297)", async () => {
		const env = setupTestEnvironment("cascade-test-role-fallback-");
		try {
			fs.writeFileSync(
				path.join(env.tmpDir, ".pi-lens.json"),
				JSON.stringify({ ignore: ["**/vendored.test.ts"] }),
			);
			const primary = path.join(env.tmpDir, "main.ts");
			const noLspNeighbor = path.join(env.tmpDir, "neighbor.foo");
			const normalSource = path.join(env.tmpDir, "src", "helper.ts");
			const unignoredTest = path.join(env.tmpDir, "src", "reader.test.ts");
			const ignoredTest = path.join(env.tmpDir, "src", "vendored.test.ts");
			fs.mkdirSync(path.join(env.tmpDir, "src"), { recursive: true });
			fs.writeFileSync(primary, "export const x = 1;\n");
			fs.writeFileSync(noLspNeighbor, "neighbor\n");
			fs.writeFileSync(normalSource, "const x = 1;\n");
			fs.writeFileSync(unignoredTest, "const x = 1;\n");
			fs.writeFileSync(ignoredTest, "const x = 1;\n");
			mocks.computeImpactCascade.mockReturnValue(
				impact(primary, [noLspNeighbor]),
			);
			installLspService({
				...makeLspServiceDouble(),
				getAllDiagnostics: vi.fn().mockResolvedValue(
					new Map([
						[
							normalSource.split(path.sep).join("/"),
							{ diags: [lspError("normal source error")], ts: postEditTs() },
						],
						[
							unignoredTest.split(path.sep).join("/"),
							{ diags: [lspError("unignored test error")], ts: postEditTs() },
						],
						[
							ignoredTest.split(path.sep).join("/"),
							{ diags: [lspError("ignored test error")], ts: postEditTs() },
						],
					]),
				),
				touchFile: vi.fn(),
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");
			const result = await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});

			const formatted = result?.result?.formatted ?? "";
			// Only the normal source diagnostic is shown.
			expect(formatted).toContain("normal source error");
			expect(formatted).not.toContain("unignored test error");
			expect(formatted).not.toContain("ignored test error");
			const fallbackFiles = (result?.result?.neighbors ?? [])
				.filter((n) => n.reason === "fallback")
				.map((n) => n.filePath.split(path.sep).join("/"));
			expect(fallbackFiles).toContain(normalSource.split(path.sep).join("/"));
			expect(fallbackFiles).not.toContain(
				unignoredTest.split(path.sep).join("/"),
			);
			expect(fallbackFiles).not.toContain(
				ignoredTest.split(path.sep).join("/"),
			);
		} finally {
			env.cleanup();
		}
	});

	// #1023 over-correction guard: a HEALTHY graph (mode "full") with a genuinely
	// empty dependent set is a real clean leaf — it must stay `no_neighbors`, NOT
	// `indeterminate`, and emit NO advisory. The `impact()` helper carries no
	// `indeterminate` marker, and the default build-info mode is "full".
	it("returns no_neighbors (not indeterminate) for a healthy graph with zero dependents", async () => {
		const env = setupTestEnvironment("cascade-empty-");
		try {
			const primary = path.join(env.tmpDir, "primary.ts");
			fs.writeFileSync(primary, "export const x = 1;\n");
			mocks.computeImpactCascade.mockReturnValue(impact(primary, []));
			installLspService({
				...makeLspServiceDouble(),
				getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
				touchFile: vi.fn(),
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");
			const run = await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});
			expect(run.result).toBeUndefined();
			expect(run.skipReason).toBe("no_neighbors");
			expect(run.indeterminate).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	// #1023: a MISSING-NODE compute (computeImpactCascade marks the result
	// indeterminate because the changed file has no graph node) must NOT collapse
	// into `no_neighbors` — it is "couldn't compute", not "nothing impacted".
	it("returns indeterminate when the impact result is marked indeterminate (missing node)", async () => {
		const env = setupTestEnvironment("cascade-missing-node-");
		try {
			const primary = path.join(env.tmpDir, "primary.ts");
			fs.writeFileSync(primary, "export const x = 1;\n");
			mocks.computeImpactCascade.mockReturnValue({
				...impact(primary, []),
				indeterminate: { reason: "missing_node" },
			});
			installLspService({
				...makeLspServiceDouble(),
				getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
				touchFile: vi.fn(),
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");
			const run = await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});
			expect(run.result).toBeUndefined();
			expect(run.skipReason).toBe("indeterminate");
			expect(run.indeterminate?.reason).toBe("missing_node");
		} finally {
			env.cleanup();
		}
	});

	it("returns indeterminate when the review graph source walk was truncated", async () => {
		const env = setupTestEnvironment("cascade-source-budget-");
		try {
			const primary = path.join(env.tmpDir, "primary.ts");
			fs.writeFileSync(primary, "export const x = 1;\n");
			mocks.buildOrUpdateGraph.mockResolvedValue({
				...emptyGraph(),
				persistCoverage: {
					partial: true,
					cap: 500_000,
					totalNodes: 0,
					totalEdges: 0,
					persistedNodes: 0,
					persistedEdges: 0,
					totalFiles: 2,
					persistedFiles: 0,
					sourceFilesTruncated: true,
				},
			});
			mocks.computeImpactCascade.mockReturnValue(impact(primary, []));
			installLspService({
				...makeLspServiceDouble(),
				getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
				touchFile: vi.fn(),
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");
			const run = await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});
			expect(run.result).toBeUndefined();
			expect(run.skipReason).toBe("indeterminate");
			expect(run.indeterminate?.reason).toBe("graph_degraded");
			expect(run.indeterminate?.detail).toContain("source walk");
		} finally {
			env.cleanup();
		}
	});

	// Recurrence (#3780, #3673/#3679 survivors): the "persisted graph coverage
	// is incomplete" advisory was replaced by "" with every test green, because
	// the only partial-coverage case set `sourceFilesTruncated` and so never
	// reached the arm. Coverage that is partial for any OTHER reason (a
	// persisted-entry cap) must still say why, not hand the turn-end seam an
	// empty advisory.
	it("names incomplete persisted coverage when the graph is partial without a truncated source walk", async () => {
		const env = setupTestEnvironment("cascade-persist-partial-");
		try {
			const primary = path.join(env.tmpDir, "primary.ts");
			fs.writeFileSync(primary, "export const x = 1;\n");
			mocks.buildOrUpdateGraph.mockResolvedValue({
				...emptyGraph(),
				persistCoverage: {
					partial: true,
					cap: 500_000,
					totalNodes: 10,
					totalEdges: 10,
					persistedNodes: 5,
					persistedEdges: 5,
					totalFiles: 2,
					persistedFiles: 1,
				},
			});
			mocks.computeImpactCascade.mockReturnValue(impact(primary, []));
			installLspService({
				...makeLspServiceDouble(),
				getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
				touchFile: vi.fn(),
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");
			const run = await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});
			expect(run.result).toBeUndefined();
			expect(run.skipReason).toBe("indeterminate");
			expect(run.indeterminate?.reason).toBe("graph_degraded");
			expect(run.indeterminate?.detail).toBe(
				"review graph partial — persisted graph coverage is incomplete",
			);
		} finally {
			env.cleanup();
		}
	});

	// #1023: a SIZE-SKIPPED graph (getLastGraphBuildInfo().mode === "skipped",
	// too_many_files) — the ALREADY-KNOWN degraded state is threaded onto the
	// result at the compute site. Every edit computes zero neighbors against the
	// empty graph; this must surface as `indeterminate`, not a silent all-clear.
	it("returns indeterminate when the review graph was size-skipped (too_many_files)", async () => {
		const env = setupTestEnvironment("cascade-size-skip-");
		try {
			const primary = path.join(env.tmpDir, "primary.ts");
			fs.writeFileSync(primary, "export const x = 1;\n");
			// A healthy-looking (non-marked) empty impact — the degradation is known
			// ONLY via the build-info slot, exactly as in production.
			mocks.computeImpactCascade.mockReturnValue(impact(primary, []));
			installLspService({
				...makeLspServiceDouble(),
				getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
				touchFile: vi.fn(),
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");
			const { _setLastGraphBuildInfoForTests } =
				await import("../../clients/review-graph/builder.js");
			_setLastGraphBuildInfoForTests({
				reused: false,
				mode: "skipped",
				skipReason: "too_many_files",
				sourceFileCount: 5000,
				maxFileCount: 4000,
			} as any);

			const run = await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});
			expect(run.result).toBeUndefined();
			expect(run.skipReason).toBe("indeterminate");
			expect(run.indeterminate?.reason).toBe("graph_degraded");
			expect(run.indeterminate?.detail).toContain("5000");
		} finally {
			env.cleanup();
		}
	});

	// #5055 recurrence: the `unresolved_reference` marker is set after the
	// degraded-graph marker, and a run both degraded AND holding an unplaced
	// referrer must keep the more fundamental reason (the graph is unavailable),
	// not be relabelled as an ambiguous-name gap.
	it("keeps a graph_degraded marker when a name-only referrer is also unplaced (#5055)", async () => {
		const env = setupTestEnvironment("cascade-degraded-unplaced-");
		try {
			const primary = path.join(env.tmpDir, "primary.ts");
			const referrer = path.join(env.tmpDir, "caller.ts");
			fs.writeFileSync(primary, "export const x = 1;\n");
			fs.writeFileSync(referrer, "x;\n");
			mocks.computeImpactCascade.mockReturnValue({
				...impact(primary, []),
				nameOnlyReferrers: [referrer],
			});
			installLspService({
				...makeLspServiceDouble(),
				getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
				touchFile: vi.fn(),
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");
			const { _setLastGraphBuildInfoForTests } =
				await import("../../clients/review-graph/builder.js");
			_setLastGraphBuildInfoForTests({
				reused: false,
				mode: "skipped",
				skipReason: "too_many_files",
				sourceFileCount: 5000,
				maxFileCount: 4000,
			} as any);

			const run = await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});
			expect(run.skipReason).toBe("indeterminate");
			expect(run.indeterminate?.reason).toBe("graph_degraded");
		} finally {
			env.cleanup();
		}
	});

	// #3605 review F3: a web-tree-sitter trap cost a file in the graph its
	// symbols and imports, and the build completed. The dependents of that file
	// are missing from every cascade, so a clean verdict would be a silent
	// all-clear; only the build's count says so.
	it("returns indeterminate when a wasm trap cost a file in the graph its extraction", async () => {
		const env = setupTestEnvironment("cascade-wasm-trap-");
		try {
			const primary = path.join(env.tmpDir, "primary.py");
			fs.writeFileSync(primary, "x = 1\n");
			mocks.computeImpactCascade.mockReturnValue(impact(primary, []));
			installLspService({
				...makeLspServiceDouble(),
				getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
				touchFile: vi.fn(),
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");
			const { _setLastGraphBuildInfoForTests } =
				await import("../../clients/review-graph/builder.js");
			_setLastGraphBuildInfoForTests({
				reused: true,
				mode: "cached",
				graphChanged: false,
				wasmTrappedFiles: 2,
			});

			const run = await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});
			expect(run.skipReason).toBe("indeterminate");
			expect(run.indeterminate).toMatchObject({
				reason: "graph_degraded",
				detail:
					"review graph degraded — tree-sitter wasm runtime failure in 2 file(s)",
			});
		} finally {
			env.cleanup();
		}
	});

	// #3678 F-B: after the process-wide WASM abort, later builds have no
	// tree-sitter symbols and may have no per-file trap count. Keep that state
	// from becoming a silent `no_neighbors` all-clear.
	it("returns indeterminate after the process-wide tree-sitter abort", async () => {
		const env = setupTestEnvironment("cascade-wasm-aborted-");
		try {
			const primary = path.join(env.tmpDir, "primary.py");
			fs.writeFileSync(primary, "x = 1\n");
			mocks.computeImpactCascade.mockReturnValue(impact(primary, []));
			installLspService({
				...makeLspServiceDouble(),
				getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
				touchFile: vi.fn(),
				getDiagnostics: vi.fn(),
			});

			const {
				_resetSharedTreeSitterClientForTests,
				getSharedTreeSitterClient,
			} = await import("../../clients/tree-sitter-shared.js");
			const client = getSharedTreeSitterClient();
			expect(client).not.toBeNull();
			for (let i = 0; i < 4; i++) {
				expect(
					client!.reportWasmAbort(new Error("table index is out of bounds"), {
						languageId: "python",
						source: `def trap_${i}():\\n    return ${i}\\n`,
					} as never),
				).toBe(i === 3);
			}
			try {
				const { computeCascadeForFile } =
					await import("../../clients/dispatch/integration.js");
				const run = await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 1,
				});
				expect(run.skipReason).toBe("indeterminate");
				expect(run.indeterminate).toEqual({
					reason: "graph_degraded",
					detail:
						"review graph degraded — tree-sitter is disabled for this process until restart",
				});
			} finally {
				_resetSharedTreeSitterClientForTests();
			}
		} finally {
			env.cleanup();
		}
	});

	// #1093/#1092: the cascade computes the correcting cross-file truth for every
	// edited file's dependents, but that truth used to be display-only and was
	// never reconciled into the footer widget. So a finding in A caused by B,
	// fixed by editing B, survived in A's footer forever (A's own mtime never
	// advanced). These prove the confirmed neighbor results now reconcile into
	// widget state — INCLUDING the confirmed-clean `[]` case — while inconclusive
	// results and stale write-ordering tokens are respected.
	describe("neighbor reconciliation into widget state (#1093/#1092)", () => {
		it("a confirmed-CLEAN passive snapshot clears a neighbor's now-stale footer entry", async () => {
			const env = setupTestEnvironment("cascade-reconcile-clean-");
			try {
				const primary = path.join(env.tmpDir, "src", "primary.ts");
				const neighbor = path.join(env.tmpDir, "src", "neighbor.ts");
				fs.mkdirSync(path.dirname(primary), { recursive: true });
				fs.writeFileSync(primary, "export const x = 1;\n");
				fs.writeFileSync(neighbor, "import { x } from './primary';\n");
				mocks.computeImpactCascade.mockReturnValue(impact(primary, [neighbor]));
				// Passive snapshot for the neighbor is now CLEAN (the fix to `primary`
				// resolved the cross-file error) — a valid, confirmed observation.
				installLspService({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi
						.fn()
						.mockResolvedValue(
							new Map([
								[
									neighbor.split(path.sep).join("/"),
									{ diags: [], ts: postEditTs() },
								],
							]),
						),
					touchFile: vi.fn(),
					getDiagnostics: vi.fn(),
				});

				const { computeCascadeForFile } =
					await import("../../clients/dispatch/integration.js");
				const { recordDiagnostics, getFileDiagnostics } =
					await import("../../clients/widget-state.js");

				// A stale LSP footer entry for the neighbor, left over from before the
				// fix (the per-edit LSP runner tags language-server findings tool:"lsp").
				recordDiagnostics(
					neighbor,
					[
						{
							tool: "lsp",
							severity: "error",
							semantic: "blocking",
							message: "cross-file error (already fixed)",
						},
					],
					1,
				);
				expect(getFileDiagnostics(neighbor)).toHaveLength(1);

				await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 5,
				});

				// Pre-fix: cascade never reconciled → the stale entry survived.
				expect(getFileDiagnostics(neighbor)).toEqual([]);
			} finally {
				env.cleanup();
			}
		});

		it("a confirmed active touch writes the neighbor's diagnostics into the footer", async () => {
			const env = setupTestEnvironment("cascade-reconcile-dirty-");
			try {
				const primary = path.join(env.tmpDir, "model.py");
				const neighbor = path.join(env.tmpDir, "api.py");
				fs.writeFileSync(primary, "class User: pass\n");
				fs.writeFileSync(neighbor, "from model import User\n");
				mocks.computeImpactCascade.mockReturnValue(impact(primary, [neighbor]));
				installLspService({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
					touchFile: vi
						.fn()
						.mockResolvedValue({ diags: [lspError("python broken")] }),
					getDiagnostics: vi.fn(),
				});

				const { computeCascadeForFile } =
					await import("../../clients/dispatch/integration.js");
				const { getFileDiagnostics } =
					await import("../../clients/widget-state.js");

				await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 1,
				});

				// Pre-fix: cascade output was display-only → nothing written here.
				const diags = getFileDiagnostics(neighbor);
				expect(diags).toHaveLength(1);
				expect(diags?.[0]?.message).toBe("python broken");
			} finally {
				env.cleanup();
			}
		});

		// #3573: the active touch's row is stamped before the neighbor's read.
		// Stamped at reconcile time, a dependency written while the touch was
		// still waiting on the language server had an older mtime than the row,
		// and the widget's dependency gate never demoted it. (The own-file axis
		// is the #1095 binding's: a rewritten neighbor's touch is bound-false and
		// never reconciled.)
		for (const [label, depWrittenDuringTouch] of [
			[
				"a dependency written while the active touch runs demotes the neighbor's reconciled row (#3573)",
				true,
			],
			[
				"a dependency written before the neighbor's read leaves its reconciled row authoritative (#3573)",
				false,
			],
		] as const) {
			it(label, async () => {
				const env = setupTestEnvironment("cascade-reconcile-read-stamp-");
				const T_READ = 1_900_000_000_000;
				const T_EDIT = T_READ + 400;
				const T_REC = T_READ + 1500;
				const setMtime = (file: string, ms: number) =>
					fs.utimesSync(file, ms / 1000, ms / 1000);
				try {
					const primary = path.join(env.tmpDir, "primary.ts");
					const neighbor = path.join(env.tmpDir, "neighbor.ts");
					fs.writeFileSync(primary, "export const x = 1;\n");
					fs.writeFileSync(
						neighbor,
						'import { x } from "./primary.js";\nexport const y = x;\n',
					);
					setMtime(neighbor, T_READ - 1000);
					// The primary edit that started this cascade: before the read.
					// Its mtime leads the clock by 40 ms, the #1710 skew.
					setMtime(primary, T_READ + 40);
					mocks.computeImpactCascade.mockReturnValue(
						impact(primary, [neighbor]),
					);
					installLspService({
						...makeLspServiceDouble(),
						getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
						touchFile: vi.fn(async () => {
							vi.setSystemTime(T_EDIT);
							if (depWrittenDuringTouch) {
								fs.writeFileSync(primary, "export const x = 2;\n");
								setMtime(primary, T_EDIT);
							}
							vi.setSystemTime(T_REC);
							return { diags: [lspError("cross-file error")] };
						}),
						getDiagnostics: vi.fn(),
					});
					vi.useFakeTimers({ toFake: ["Date"] });
					vi.setSystemTime(T_READ);

					const { computeCascadeForFile } =
						await import("../../clients/dispatch/integration.js");
					const { getFileDiagnostics, reconcileStaleWidgetDependencyBlockers } =
						await import("../../clients/widget-state.js");
					await computeCascadeForFile(primary, env.tmpDir, {
						turnSeq: 1,
						writeSeq: 1,
					});

					const { demoted } = await reconcileStaleWidgetDependencyBlockers(
						env.tmpDir,
					);
					expect(demoted).toBe(depWrittenDuringTouch ? 1 : 0);
					expect(
						(getFileDiagnostics(neighbor) ?? []).map((d) => ({
							observedAt: d.observedAt,
							stale: d.stale ?? false,
						})),
					).toEqual([{ observedAt: T_READ, stale: depWrittenDuringTouch }]);
				} finally {
					vi.useRealTimers();
					env.cleanup();
				}
			});
		}

		it("an INCONCLUSIVE neighbor result (rejected touch → passive fallback) does NOT overwrite an existing footer entry", async () => {
			const env = setupTestEnvironment("cascade-reconcile-inconclusive-");
			try {
				const primary = path.join(env.tmpDir, "model.py");
				const neighbor = path.join(env.tmpDir, "api.py");
				fs.writeFileSync(primary, "class User: pass\n");
				fs.writeFileSync(neighbor, "from model import User\n");
				mocks.computeImpactCascade.mockReturnValue(impact(primary, [neighbor]));
				// The touch REJECTS — the neighbor falls back to a passive/stale
				// snapshot, which is NOT a confirmed observation and must not be
				// reconciled (#571 confirmed-only contract).
				installLspService({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
					touchFile: vi.fn().mockRejectedValue(new Error("touch timed out")),
					getDiagnostics: vi.fn(),
				});

				const { computeCascadeForFile } =
					await import("../../clients/dispatch/integration.js");
				const { recordDiagnostics, getFileDiagnostics } =
					await import("../../clients/widget-state.js");

				// A real prior confirmed-dirty entry that must survive.
				recordDiagnostics(
					neighbor,
					[{ severity: "error", message: "real prior finding" }],
					1,
				);

				await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 5,
				});

				const diags = getFileDiagnostics(neighbor);
				expect(diags).toHaveLength(1);
				expect(diags?.[0]?.message).toBe("real prior finding");
			} finally {
				env.cleanup();
			}
		});

		it("a cascade reconcile with an OLDER writeSeq does not clobber a newer per-edit record; a NEWER writeSeq does win", async () => {
			const env = setupTestEnvironment("cascade-reconcile-ordering-");
			try {
				const primary = path.join(env.tmpDir, "src", "primary.ts");
				const neighbor = path.join(env.tmpDir, "src", "shared.ts");
				fs.mkdirSync(path.dirname(primary), { recursive: true });
				fs.writeFileSync(primary, "export const x = 1;\n");
				fs.writeFileSync(neighbor, "import { x } from './primary';\n");
				mocks.computeImpactCascade.mockReturnValue(impact(primary, [neighbor]));
				// No snapshot → cold-snapshot touch path; touch confirms an error.
				installLspService({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
					touchFile: vi
						.fn()
						.mockResolvedValue({ diags: [lspError("cascade result")] }),
					getDiagnostics: vi.fn(),
				});

				const { computeCascadeForFile, resetDispatchBaselines } =
					await import("../../clients/dispatch/integration.js");
				const { recordDiagnostics, getFileDiagnostics } =
					await import("../../clients/widget-state.js");

				// A NEWER per-edit LSP-error record for the neighbor (order turn 7,
				// writeIndex 10), in the pipeline's turn-first widget order (#3540).
				// #3540 r2: the order turn is not the session's turn (`turnSeq`,
				// which restarts at a session reset); the cascade orders by the one
				// its primary edit carried.
				recordDiagnostics(
					neighbor,
					[
						{
							tool: "lsp",
							severity: "error",
							semantic: "blocking",
							message: "newer per-edit result",
						},
					],
					writeOrderToken(7, 10),
				);

				// Cascade launched from an OLDER primary edit (writeSeq 3) lands late —
				// its reconcile must be dropped by the WriteOrderingGuard.
				await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					orderTurn: 7,
					writeSeq: 3,
				});
				expect(getFileDiagnostics(neighbor)?.[0]?.message).toBe(
					"newer per-edit result",
				);

				// A later cascade with a NEWER writeSeq (20) is allowed to win —
				// proves the reconcile is actually firing (not silently a no-op) and
				// the token really is the cascade's writeSeq.
				resetDispatchBaselines();
				await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					orderTurn: 7,
					writeSeq: 20,
				});
				expect(getFileDiagnostics(neighbor)?.[0]?.message).toBe(
					"cascade result",
				);
			} finally {
				env.cleanup();
			}
		});

		it("an INCONCLUSIVE active touch (resolved [] carrying the inconclusive flag) does NOT wipe a live footer finding", async () => {
			const env = setupTestEnvironment("cascade-reconcile-inconclusive-touch-");
			try {
				const primary = path.join(env.tmpDir, "model.py");
				const neighbor = path.join(env.tmpDir, "api.py");
				fs.writeFileSync(primary, "class User: pass\n");
				fs.writeFileSync(neighbor, "from model import User\n");
				mocks.computeImpactCascade.mockReturnValue(impact(primary, [neighbor]));
				// The touch resolves empty `.diags` but carries `inconclusive: true`
				// (the diagnostics wait lapsed its budget) — NOT a confirmed clean.
				// Reconciling it as clean would wipe a live finding (the #533
				// false-clean trap). #1179: the real `touchFile` now carries the flag
				// as an EXPLICIT enumerable field on the `{ diags, inconclusive }`
				// wrapper, so it survives any copy of `.diags` by construction — set
				// it the same way here.
				installLspService({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
					touchFile: vi
						.fn()
						.mockResolvedValue({ diags: [], inconclusive: true }),
					getDiagnostics: vi.fn(),
				});

				const { computeCascadeForFile } =
					await import("../../clients/dispatch/integration.js");
				const { recordDiagnostics, getFileDiagnostics } =
					await import("../../clients/widget-state.js");

				// A live LSP error already recorded for the neighbor.
				recordDiagnostics(
					neighbor,
					[
						{
							tool: "lsp",
							severity: "error",
							semantic: "blocking",
							message: "live cross-file error",
						},
					],
					1,
				);

				const run = await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 5,
				});

				// Pre-fix: the inconclusive `[]` reconciled as confirmed-clean and the
				// live finding was wiped. It must survive an unconfirmed touch.
				const diags = getFileDiagnostics(neighbor);
				expect(diags).toHaveLength(1);
				expect(diags?.[0]?.message).toBe("live cross-file error");

				// #1104: the neighbor_touch log entry must carry `inconclusive` so the
				// two unconfirmed-touch causes (inconclusive wait vs. bound-false disk
				// divergence) are distinguishable from cascade.log alone.
				const neighborTouchEntry = mocks.logCascade.mock.calls
					.map(([entry]) => entry)
					.find((entry) => entry.phase === "neighbor_touch");
				expect(neighborTouchEntry?.metadata).toMatchObject({
					inconclusive: true,
				});
				// #4487: not an observation turn_end may clear a pending error with.
				expect(run.observedNeighborPaths).toBeUndefined();
				expect(run.result?.neighbors[0]).toMatchObject({
					inconclusive: true,
				});
				expect(run.result?.formatted).toContain("inconclusive");

				// #1444 (CLASSIC lane, end to end): the marker is a deliberate
				// behavior change on the classic full-wait path — output that was
				// empty for a lapsed budget is now a non-empty honest note. Assert it
				// through the turn-end seam, not just the formatter: a marker that
				// never reaches the agent's message is not an honesty improvement.
				const { RuntimeCoordinator } =
					await import("../../clients/runtime-coordinator.js");
				const { CacheManager } = await import("../../clients/cache-manager.js");
				const { handleTurnEnd } = await import("../../clients/runtime-turn.js");
				const { consumeTurnEndFindings } =
					await import("../../clients/runtime-context.js");
				const runtime = new RuntimeCoordinator();
				const cacheManager = new CacheManager(false);
				cacheManager.addModifiedRange(
					primary,
					{ start: 1, end: 1 },
					false,
					env.tmpDir,
				);
				runtime.appendCascadeRun(run);
				await handleTurnEnd({
					ctxCwd: env.tmpDir,
					getFlag: () => false,
					dbg: () => {},
					runtime,
					cacheManager,
					knipClient: {
						ensureAvailable: async () => false,
						analyze: async () => ({
							success: true,
							issues: [],
							unusedExports: [],
							unusedFiles: [],
							unusedDeps: [],
							unlistedDeps: [],
							summary: "skipped",
						}),
					},
					deadCodeClients: [],
					depChecker: { ensureAvailable: async () => false },
					testRunnerClient: { getTestRunTarget: () => null },
					resetLSPService: () => {},
					resetFormatService: () => {},
				} as any);
				const turnEndContent =
					consumeTurnEndFindings(cacheManager, env.tmpDir)?.messages[0]
						?.content ?? "";
				expect(turnEndContent).toContain("inconclusive");
				expect(turnEndContent).toContain("api.py");
			} finally {
				env.cleanup();
			}
		});

		it("a PARTIALLY confirmed active touch (auxiliary cut off) does NOT wipe a live footer finding (#1470)", async () => {
			const env = setupTestEnvironment("cascade-reconcile-partial-touch-");
			try {
				const primary = path.join(env.tmpDir, "model.py");
				const neighbor = path.join(env.tmpDir, "api.py");
				fs.writeFileSync(primary, "class User: pass\n");
				fs.writeFileSync(neighbor, "from model import User\n");
				mocks.computeImpactCascade.mockReturnValue(impact(primary, [neighbor]));
				// #1470: the touch resolves empty `.diags` and is NOT inconclusive —
				// the primary answered — but an auxiliary was cut off by the aux grace
				// timer, so the merged result is missing that scanner's coverage. Pre-
				// fix, `isConfirmedTouch` read only `inconclusive`, so this wiped the
				// live finding and seeded the (since deleted, #4486) recently-clean
				// cache, making the wipe self-sustaining on the next cascade.
				installLspService({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
					touchFile: vi.fn().mockResolvedValue({
						diags: [],
						confirmation: "partial",
						unconfirmedServerIds: ["opengrep"],
					}),
					getDiagnostics: vi.fn(),
				});

				const { computeCascadeForFile } =
					await import("../../clients/dispatch/integration.js");
				const { recordDiagnostics, getFileDiagnostics } =
					await import("../../clients/widget-state.js");

				recordDiagnostics(
					neighbor,
					[
						{
							tool: "lsp",
							severity: "error",
							semantic: "blocking",
							message: "live cross-file error",
						},
					],
					1,
				);

				const run = await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 5,
				});

				const diags = getFileDiagnostics(neighbor);
				expect(diags).toHaveLength(1);
				expect(diags?.[0]?.message).toBe("live cross-file error");
				// #4487: not an observation turn_end may clear a pending error with.
				expect(run.observedNeighborPaths).toBeUndefined();
				// The third unconfirmed-touch cause is named in cascade.log, so it is
				// distinguishable from the inconclusive and bound-false causes.
				const neighborTouchEntry = mocks.logCascade.mock.calls
					.map(([entry]) => entry)
					.find((entry) => entry.phase === "neighbor_touch");
				expect(neighborTouchEntry?.metadata).toMatchObject({
					unconfirmedServerIds: ["opengrep"],
				});
			} finally {
				env.cleanup();
			}
		});

		it("#1549: an inconclusive neighbour touch names WHICH server and WHICH deadline in cascade.log", async () => {
			// The forensic sweep behind #1549 could only infer the cause of an
			// inconclusive touch from duration histograms, because `neighbor_touch`
			// recorded the bare flag. `touchFile` now attributes the verdict, and the
			// cascade must carry that attribution across — this is the issue's own
			// observability acceptance criterion, so it is pinned end to end through
			// `computeCascadeForFile` rather than at the touch boundary.
			const env = setupTestEnvironment("cascade-inconclusive-attribution-");
			try {
				const primary = path.join(env.tmpDir, "model.py");
				const neighbor = path.join(env.tmpDir, "api.py");
				fs.writeFileSync(primary, "class User: pass\n");
				fs.writeFileSync(neighbor, "from model import User\n");
				mocks.computeImpactCascade.mockReturnValue(impact(primary, [neighbor]));
				installLspService({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
					touchFile: vi.fn().mockResolvedValue({
						diags: [],
						inconclusive: true,
						inconclusiveServerIds: ["pyright"],
						inconclusiveReason: "diagnostics-wait",
					}),
					getDiagnostics: vi.fn(),
				});

				const { computeCascadeForFile } =
					await import("../../clients/dispatch/integration.js");
				await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 5,
				});

				const neighborTouchEntry = mocks.logCascade.mock.calls
					.map(([entry]) => entry)
					.find((entry) => entry.phase === "neighbor_touch");
				expect(neighborTouchEntry?.metadata).toMatchObject({
					inconclusive: true,
					inconclusiveServerIds: ["pyright"],
					inconclusiveReason: "diagnostics-wait",
				});
			} finally {
				env.cleanup();
			}
		});

		it("#1549: a CONCLUSIVE touch blames nobody — no attribution fields on the row", async () => {
			// The other half of the carry: the fields are conditional on the verdict,
			// so a healthy sweep cannot accumulate empty attribution keys, and a
			// `partial` touch is never mislabelled as having an inconclusive cause.
			const env = setupTestEnvironment("cascade-conclusive-attribution-");
			try {
				const primary = path.join(env.tmpDir, "model.py");
				const neighbor = path.join(env.tmpDir, "api.py");
				fs.writeFileSync(primary, "class User: pass\n");
				fs.writeFileSync(neighbor, "from model import User\n");
				mocks.computeImpactCascade.mockReturnValue(impact(primary, [neighbor]));
				installLspService({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
					touchFile: vi.fn().mockResolvedValue({
						diags: [],
						confirmation: "partial",
						unconfirmedServerIds: ["opengrep"],
					}),
					getDiagnostics: vi.fn(),
				});

				const { computeCascadeForFile } =
					await import("../../clients/dispatch/integration.js");
				await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 5,
				});

				const neighborTouchEntry = mocks.logCascade.mock.calls
					.map(([entry]) => entry)
					.find((entry) => entry.phase === "neighbor_touch");
				expect(neighborTouchEntry?.metadata).toMatchObject({
					inconclusive: false,
				});
				expect(neighborTouchEntry?.metadata).not.toHaveProperty(
					"inconclusiveServerIds",
				);
				expect(neighborTouchEntry?.metadata).not.toHaveProperty(
					"inconclusiveReason",
				);
			} finally {
				env.cleanup();
			}
		});

		it("#1549: an answered primary beside an unheard scanner delivers its findings to the agent, marked as uncovered", async () => {
			// The consumer-side end of the fix. Pre-#1549 this exact touch resolved
			// `inconclusive` (one slow auxiliary set the touch-wide deadline), so the
			// neighbour reached the agent as a bare "diagnostics inconclusive" line
			// with the primary's real error discarded. Now the error is rendered AND
			// the scanner gap is named — neither overclaiming nor underclaiming.
			const env = setupTestEnvironment("cascade-partial-findings-flow-");
			try {
				const primary = path.join(env.tmpDir, "model.py");
				const neighbor = path.join(env.tmpDir, "api.py");
				fs.writeFileSync(primary, "class User: pass\n");
				fs.writeFileSync(neighbor, "from model import User\n");
				mocks.computeImpactCascade.mockReturnValue(impact(primary, [neighbor]));
				installLspService({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
					touchFile: vi.fn().mockResolvedValue({
						diags: [
							{
								severity: 1,
								message: "undefined name User",
								range: {
									start: { line: 0, character: 0 },
									end: { line: 0, character: 4 },
								},
							},
						],
						confirmation: "partial",
						unconfirmedServerIds: ["opengrep"],
					}),
					getDiagnostics: vi.fn(),
				});

				const { computeCascadeForFile } =
					await import("../../clients/dispatch/integration.js");
				const run = await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 5,
				});

				expect(run.result?.neighbors[0]).toMatchObject({
					unconfirmedServerIds: ["opengrep"],
				});
				expect(run.result?.neighbors[0]?.inconclusive).toBeUndefined();
				expect(run.result?.formatted).toContain("undefined name User");
				expect(run.result?.formatted).not.toContain("inconclusive");
			} finally {
				env.cleanup();
			}
		});

		it("a confirmed LSP-clean cascade clears the neighbor's LSP error but PRESERVES a live biome finding (merge, not replace)", async () => {
			const env = setupTestEnvironment("cascade-reconcile-merge-");
			try {
				const primary = path.join(env.tmpDir, "src", "primary.ts");
				const neighbor = path.join(env.tmpDir, "src", "neighbor.ts");
				fs.mkdirSync(path.dirname(primary), { recursive: true });
				fs.writeFileSync(primary, "export const x = 1;\n");
				fs.writeFileSync(neighbor, "import { x } from './primary';\n");
				mocks.computeImpactCascade.mockReturnValue(impact(primary, [neighbor]));
				// Passive snapshot reports the neighbor LSP-clean.
				installLspService({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi
						.fn()
						.mockResolvedValue(
							new Map([
								[
									neighbor.split(path.sep).join("/"),
									{ diags: [], ts: postEditTs() },
								],
							]),
						),
					touchFile: vi.fn(),
					getDiagnostics: vi.fn(),
				});

				const { computeCascadeForFile } =
					await import("../../clients/dispatch/integration.js");
				const { recordDiagnostics, getFileDiagnostics } =
					await import("../../clients/widget-state.js");

				// The neighbor's live footer state: a biome error (a source the cascade
				// never re-checks) AND an LSP error (which it does).
				recordDiagnostics(
					neighbor,
					[
						{ tool: "biome", severity: "error", message: "biome: unused var" },
						{
							tool: "lsp",
							severity: "error",
							semantic: "blocking",
							message: "lsp: cross-file error",
						},
					],
					1,
				);
				expect(getFileDiagnostics(neighbor)).toHaveLength(2);

				await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 5,
				});

				// The errors-only LSP re-check cleared its own stale error but must NOT
				// touch the biome finding. Pre-fix (full replace): the biome error was
				// silently wiped — a new automatic false-clean channel.
				const diags = getFileDiagnostics(neighbor);
				expect(diags?.map((d) => d.message)).toEqual(["biome: unused var"]);
			} finally {
				env.cleanup();
			}
		});

		it("a passive-snapshot reconcile stamps touchedAt at the snapshot's publish time (entry.ts), not now", async () => {
			const env = setupTestEnvironment("cascade-reconcile-snapshot-obs-");
			try {
				const primary = path.join(env.tmpDir, "src", "primary.ts");
				const neighbor = path.join(env.tmpDir, "src", "neighbor.ts");
				fs.mkdirSync(path.dirname(primary), { recursive: true });
				fs.writeFileSync(primary, "export const x = 1;\n");
				fs.writeFileSync(neighbor, "import { x } from './primary';\n");
				mocks.computeImpactCascade.mockReturnValue(impact(primary, [neighbor]));
				// The snapshot reports an error and was published after the compute
				// started (#4486), but 200 ms before the read returns it: a valid,
				// confirmed observation, older than the moment it is reconciled.
				let snapshotTs = 0;
				installLspService({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi.fn(async () => {
						// Published 1 ms after the read was asked, returned 200 ms
						// later: only Date is moved, no timer runs.
						snapshotTs = Date.now() + 1;
						vi.setSystemTime(snapshotTs + 200);
						return new Map([
							[
								neighbor.split(path.sep).join("/"),
								{ diags: [lspError("snapshot error")], ts: snapshotTs },
							],
						]);
					}),
					touchFile: vi.fn(),
					getDiagnostics: vi.fn(),
				});

				const { computeCascadeForFile } =
					await import("../../clients/dispatch/integration.js");
				const { getFileDiagnostics, reconcileStaleWidgetFiles } =
					await import("../../clients/widget-state.js");

				await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 5,
				});
				expect(getFileDiagnostics(neighbor)).toHaveLength(1);

				// The neighbor file changed AFTER the snapshot's publish time but
				// before the reconcile. touchedAt must be the snapshot's `ts`, so the
				// mtime-staleness gate drops the entry. Pre-fix (touchedAt=now, the
				// re-arming defect this PR fixes for cache hits): it would survive.
				const mtime = new Date(snapshotTs + 100);
				fs.utimesSync(neighbor, mtime, mtime);
				expect(await reconcileStaleWidgetFiles()).toBe(1);
				// Shed, not vanished: the record stays as unfinished evidence (#4625).
				expect(getFileDiagnostics(neighbor)).toEqual([]);
			} finally {
				vi.useRealTimers();
				env.cleanup();
			}
		});

		it("does NOT double-count or escalate a neighbor's auxiliary (opengrep) finding present in the cascade payload", async () => {
			const env = setupTestEnvironment("cascade-reconcile-aux-");
			try {
				const primary = path.join(env.tmpDir, "model.py");
				const neighbor = path.join(env.tmpDir, "api.py");
				fs.writeFileSync(primary, "class User: pass\n");
				fs.writeFileSync(neighbor, "from model import User\n");
				mocks.computeImpactCascade.mockReturnValue(impact(primary, [neighbor]));
				// Even if a touch result somehow carried an aux-sourced diagnostic
				// (opengrep tags its LSP diagnostics `source: "Semgrep"`) alongside no
				// genuine language-server error, the reconcile must still exclude it —
				// belt-and-suspenders alongside #1720's `clientScope: "primary"` fix,
				// which stops the cascade from asking aux servers at all.
				const semgrep = {
					severity: 1 as const,
					message: "opengrep: audit finding",
					range: {
						start: { line: 0, character: 0 },
						end: { line: 0, character: 1 },
					},
					code: "rules.audit",
					source: "Semgrep",
				};
				installLspService({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
					touchFile: vi.fn().mockResolvedValue({
						diags: [semgrep],
					}),
					getDiagnostics: vi.fn(),
				});

				const { computeCascadeForFile } =
					await import("../../clients/dispatch/integration.js");
				const { recordDiagnostics, getFileDiagnostics } =
					await import("../../clients/widget-state.js");

				// The neighbor already carries this opengrep finding, correctly tagged
				// and advisory (semantic "warning"), from its own per-edit dispatch.
				recordDiagnostics(
					neighbor,
					[
						{
							tool: "opengrep",
							severity: "error",
							semantic: "warning",
							message: "opengrep: audit finding",
						},
					],
					1,
				);

				await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 5,
				});

				// The cascade excludes auxiliary-sourced diagnostics from what it
				// reconciles, so the finding is neither duplicated nor re-written as a
				// blocking tool:"lsp" error — the neighbor's own correctly-tagged
				// advisory entry survives, exactly once. Pre-fix: two entries, one of
				// them escalated to tool:"lsp"/blocking.
				const diags = getFileDiagnostics(neighbor);
				expect(diags).toHaveLength(1);
				expect(diags?.[0]?.tool).toBe("opengrep");
				expect(diags?.[0]?.semantic).not.toBe("blocking");
			} finally {
				env.cleanup();
			}
		});
	});

	// #1095 (second PR): the cascade adopts the content `binding` carried by
	// diagnostics results. A passive snapshot / active touch whose diagnostics were
	// computed against a DIFFERENT disk state than what's on disk now
	// (boundToCurrentDisk === false) is no longer trusted — it is not reconciled into
	// the footer widget, killing the window where the first cascade after a fix-edit
	// replays the neighbor's PRE-fix snapshot. "unknown" preserves EXACTLY the
	// pre-#1095 TTL-only behavior; true reconciles (TTL stays the outer bound).
	describe("content-binding validity (#1095)", () => {
		it("does NOT reconcile a bound-false passive snapshot (stale pre-fix snapshot) and falls through to an active touch", async () => {
			const env = setupTestEnvironment("cascade-binding-false-snapshot-");
			try {
				const primary = path.join(env.tmpDir, "src", "primary.ts");
				const neighbor = path.join(env.tmpDir, "src", "neighbor.ts");
				fs.mkdirSync(path.dirname(primary), { recursive: true });
				fs.writeFileSync(primary, "export const x = 1;\n");
				fs.writeFileSync(neighbor, "import { x } from './primary';\n");
				mocks.computeImpactCascade.mockReturnValue(impact(primary, [neighbor]));
				// TTL-fresh snapshot still carrying the PRE-fix error, but the server's
				// view has diverged from disk (boundToCurrentDisk: false).
				const lsp = installLspService({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi
						.fn()
						.mockResolvedValue(
							new Map([
								[
									neighbor.split(path.sep).join("/"),
									withBinding(
										{ diags: [lspError("pre-fix error")], ts: postEditTs() },
										false,
									),
								],
							]),
						),
					// The neighbor is actually clean now — a confirmed active re-check.
					touchFile: vi.fn().mockResolvedValue({ diags: [] }),
					getDiagnostics: vi.fn(),
				});

				const { computeCascadeForFile } =
					await import("../../clients/dispatch/integration.js");
				const { getFileDiagnostics } =
					await import("../../clients/widget-state.js");

				const result = await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 5,
				});

				// Pre-fix: the TTL-fresh snapshot was reconciled and its stale error
				// landed in the footer. With binding: the bound-false snapshot is skipped,
				// so the pre-fix error never reaches the widget…
				expect(getFileDiagnostics(neighbor) ?? []).toEqual([]);
				// …and the neighbor falls through to an active touch (same budget as a
				// cold/stale snapshot) instead of trusting the diverged snapshot.
				expect(lsp.touchFile).toHaveBeenCalledWith(
					neighbor,
					expect.any(String),
					expect.objectContaining({
						source: "cascade",
						clientScope: "primary",
					}),
				);
				// The stale snapshot error must not survive as a cascade neighbor result.
				expect(
					result?.result?.neighbors[0]?.diagnostics.some(
						(d) => d.message === "pre-fix error",
					) ?? false,
				).toBe(false);
			} finally {
				env.cleanup();
			}
		});

		it("characterization: an unknown-binding TTL-fresh snapshot reconciles exactly as pre-#1095 (no touch)", async () => {
			const env = setupTestEnvironment("cascade-binding-unknown-snapshot-");
			try {
				const primary = path.join(env.tmpDir, "src", "primary.ts");
				const neighbor = path.join(env.tmpDir, "src", "neighbor.ts");
				fs.mkdirSync(path.dirname(primary), { recursive: true });
				fs.writeFileSync(primary, "export const x = 1;\n");
				fs.writeFileSync(neighbor, "import { x } from './primary';\n");
				mocks.computeImpactCascade.mockReturnValue(impact(primary, [neighbor]));
				const touchFile = vi.fn();
				installLspService({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi.fn().mockResolvedValue(
						new Map([
							[
								neighbor.split(path.sep).join("/"),
								withBinding(
									{
										diags: [lspError("unknown-bound error")],
										ts: postEditTs(),
									},
									"unknown",
								),
							],
						]),
					),
					touchFile,
					getDiagnostics: vi.fn(),
				});

				const { computeCascadeForFile } =
					await import("../../clients/dispatch/integration.js");
				const { getFileDiagnostics } =
					await import("../../clients/widget-state.js");

				const result = await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 5,
				});

				// Unknown binding → TTL-only behavior: snapshot trusted, no active touch,
				// error surfaced and reconciled into the footer, identical to pre-#1095.
				expect(touchFile).not.toHaveBeenCalled();
				expect(result?.result?.neighbors[0]?.lspTouched).toBe(false);
				expect(result?.result?.neighbors[0]?.diagnostics[0]?.message).toBe(
					"unknown-bound error",
				);
				expect(getFileDiagnostics(neighbor)).toHaveLength(1);
			} finally {
				env.cleanup();
			}
		});

		it("reconciles a bound-true passive snapshot (no touch)", async () => {
			const env = setupTestEnvironment("cascade-binding-true-snapshot-");
			try {
				const primary = path.join(env.tmpDir, "src", "primary.ts");
				const neighbor = path.join(env.tmpDir, "src", "neighbor.ts");
				fs.mkdirSync(path.dirname(primary), { recursive: true });
				fs.writeFileSync(primary, "export const x = 1;\n");
				fs.writeFileSync(neighbor, "import { x } from './primary';\n");
				mocks.computeImpactCascade.mockReturnValue(impact(primary, [neighbor]));
				const touchFile = vi.fn();
				installLspService({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi
						.fn()
						.mockResolvedValue(
							new Map([
								[
									neighbor.split(path.sep).join("/"),
									withBinding(
										{ diags: [lspError("bound-true error")], ts: postEditTs() },
										true,
									),
								],
							]),
						),
					touchFile,
					getDiagnostics: vi.fn(),
				});

				const { computeCascadeForFile } =
					await import("../../clients/dispatch/integration.js");
				const { getFileDiagnostics } =
					await import("../../clients/widget-state.js");

				const result = await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 5,
				});

				expect(touchFile).not.toHaveBeenCalled();
				expect(result?.result?.neighbors[0]?.diagnostics[0]?.message).toBe(
					"bound-true error",
				);
				expect(getFileDiagnostics(neighbor)).toHaveLength(1);
			} finally {
				env.cleanup();
			}
		});

		it("a bound-false active touch is not reconciled AND does not seed the recently-clean cache", async () => {
			const env = setupTestEnvironment("cascade-binding-false-touch-");
			try {
				// Python neighbor → active-touch path (no autoPropagate snapshot).
				const primary = path.join(env.tmpDir, "model.py");
				const neighbor = path.join(env.tmpDir, "api.py");
				fs.writeFileSync(primary, "class User: pass\n");
				fs.writeFileSync(neighbor, "from model import User\n");
				mocks.computeImpactCascade.mockReturnValue(impact(primary, [neighbor]));
				// The touch resolves empty `.diags` but is bound-false (computed against
				// a diverged disk state) — NOT a confirmed clean, exactly like
				// `inconclusive`. #1179: the real `touchFile` carries `binding` as an
				// EXPLICIT enumerable field on the wrapper (survives a `.diags` copy).
				const touchFile = vi.fn().mockImplementation(async () => ({
					diags: [],
					binding: { boundToCurrentDisk: false },
				}));
				installLspService({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
					touchFile,
					getDiagnostics: vi.fn(),
				});

				const { computeCascadeForFile } =
					await import("../../clients/dispatch/integration.js");
				const { recordDiagnostics, getFileDiagnostics } =
					await import("../../clients/widget-state.js");

				// A live prior LSP error the bound-false clean touch must NOT wipe.
				recordDiagnostics(
					neighbor,
					[
						{
							tool: "lsp",
							severity: "error",
							semantic: "blocking",
							message: "live cross-file error",
						},
					],
					1,
				);

				// Turn 1: bound-false clean touch — no reconcile.
				await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 1,
				});
				// Pre-fix: the bound-false `[]` reconciled as confirmed-clean and wiped the
				// live finding. It must survive an unconfirmed touch.
				const afterFirst = getFileDiagnostics(neighbor);
				expect(afterFirst).toHaveLength(1);
				expect(afterFirst?.[0]?.message).toBe("live cross-file error");

				// Turn 2: because the bound-false clean touch did NOT seed the
				// recently-clean cache, the neighbor is re-touched (a seeded entry would
				// short-circuit turn 2). Proves no recently-clean seed occurred.
				await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 2,
					writeSeq: 2,
				});
				expect(touchFile).toHaveBeenCalledTimes(2);
			} finally {
				env.cleanup();
			}
		});
	});

	// #1104: the cascade's DEGRADED/FALLBACK display paths (the touch-error
	// fallback and appendFallbackNeighbors) previously re-read TTL-fresh
	// `getAllDiagnostics()` snapshots WITHOUT consulting content binding — #1100
	// gated the RECONCILE (footer/widget) path onto binding, but a bound-false
	// (pre-fix-edit) snapshot could still reach cascade OUTPUT via these two
	// tier3-silent corners. Tighten both to the same false/unknown/true contract
	// #1100/#1095 already established for reconcile, and verify filtering a
	// display candidate never quietly turns a degraded cascade into a
	// clean-looking one.
	describe("fallback-display binding gaps (#1104)", () => {
		it("touch-error fallback excludes a bound-false TTL-fresh snapshot from cascade DISPLAY output", async () => {
			const env = setupTestEnvironment("cascade-1104-touch-fallback-");
			try {
				const primary = path.join(env.tmpDir, "model.py");
				const rejectedNeighbor = path.join(env.tmpDir, "stale_api.py");
				const confirmedNeighbor = path.join(env.tmpDir, "live_api.py");
				fs.writeFileSync(primary, "class User: pass\n");
				fs.writeFileSync(rejectedNeighbor, "from model import User\n");
				fs.writeFileSync(confirmedNeighbor, "from model import User\n");
				mocks.computeImpactCascade.mockReturnValue(
					impact(primary, [rejectedNeighbor, confirmedNeighbor]),
				);
				installLspService({
					...makeLspServiceDouble(),
					// TTL-fresh snapshot for the neighbor whose active touch will fail —
					// but bound-false (the server's view diverged from current disk, a
					// pre-fix-edit read).
					getAllDiagnostics: vi.fn().mockResolvedValue(
						new Map([
							[
								rejectedNeighbor.split(path.sep).join("/"),
								withBinding(
									{
										diags: [lspError("stale pre-fix error")],
										ts: postEditTs(),
									},
									false,
								),
							],
						]),
					),
					touchFile: vi.fn().mockImplementation(async (filePath: string) => {
						if (filePath === rejectedNeighbor) {
							throw new Error("touch failed");
						}
						return { diags: [lspError("confirmed live error")] };
					}),
					getDiagnostics: vi.fn(),
				});

				const { computeCascadeForFile } =
					await import("../../clients/dispatch/integration.js");
				const result = await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 1,
				});

				const rejected = result?.result?.neighbors.find(
					(n) => n.filePath === rejectedNeighbor,
				);
				// The stale/bound-false snapshot must not survive into the fallback
				// entry's displayed diagnostics.
				expect(rejected?.diagnostics ?? []).toEqual([]);
				expect(
					result?.result?.neighbors.some((n) =>
						n.diagnostics.some((d) => d.message === "stale pre-fix error"),
					),
				).toBe(false);
				// The genuinely confirmed neighbor's error still reaches output —
				// proves the fix is a targeted skip, not a blanket suppression.
				expect(result?.result?.formatted).toContain("confirmed live error");
			} finally {
				env.cleanup();
			}
		});

		it("characterization: touch-error fallback with unknown binding still displays the TTL-fresh snapshot exactly as before", async () => {
			const env = setupTestEnvironment("cascade-1104-touch-fallback-unknown-");
			try {
				const primary = path.join(env.tmpDir, "model.py");
				const neighbor = path.join(env.tmpDir, "api.py");
				fs.writeFileSync(primary, "class User: pass\n");
				fs.writeFileSync(neighbor, "from model import User\n");
				mocks.computeImpactCascade.mockReturnValue(impact(primary, [neighbor]));
				installLspService({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi.fn().mockResolvedValue(
						new Map([
							[
								neighbor.split(path.sep).join("/"),
								withBinding(
									{
										diags: [lspError("unknown-bound stale error")],
										ts: postEditTs(),
									},
									"unknown",
								),
							],
						]),
					),
					touchFile: vi.fn().mockRejectedValue(new Error("touch failed")),
					getDiagnostics: vi.fn(),
				});

				const { computeCascadeForFile } =
					await import("../../clients/dispatch/integration.js");
				const result = await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 1,
				});

				expect(result?.result?.neighbors[0]?.diagnostics[0]?.message).toBe(
					"unknown-bound stale error",
				);
			} finally {
				env.cleanup();
			}
		});

		it("appendFallbackNeighbors excludes a bound-false TTL-fresh snapshot from cascade DISPLAY output", async () => {
			const env = setupTestEnvironment("cascade-1104-append-fallback-");
			try {
				const primary = path.join(env.tmpDir, "main.ts");
				// Unknown extension neighbor keeps producedLspData false (no LSP
				// server configured), driving the run into appendFallbackNeighbors
				// exactly like the pre-existing "falls back to passive snapshot" test.
				const noLspNeighbor = path.join(env.tmpDir, "neighbor.foo");
				const staleFile = path.join(env.tmpDir, "stale.ts");
				const liveFile = path.join(env.tmpDir, "live.ts");
				fs.writeFileSync(primary, "export const x = 1;\n");
				fs.writeFileSync(noLspNeighbor, "neighbor\n");
				fs.writeFileSync(staleFile, "const x = 1;\n");
				fs.writeFileSync(liveFile, "const y = 2;\n");
				mocks.computeImpactCascade.mockReturnValue(
					impact(primary, [noLspNeighbor]),
				);
				installLspService({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi.fn().mockResolvedValue(
						new Map([
							[
								staleFile.split(path.sep).join("/"),
								withBinding(
									{
										diags: [lspError("stale collateral error")],
										ts: postEditTs(),
									},
									false,
								),
							],
							[
								liveFile.split(path.sep).join("/"),
								{
									diags: [lspError("live collateral error")],
									ts: postEditTs(),
								},
							],
						]),
					),
					touchFile: vi.fn(),
					getDiagnostics: vi.fn(),
				});

				const { computeCascadeForFile } =
					await import("../../clients/dispatch/integration.js");
				const result = await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 1,
				});

				expect(
					result?.result?.neighbors.some((n) => n.filePath === staleFile),
				).toBe(false);
				expect(result?.result?.formatted).not.toContain(
					"stale collateral error",
				);
				expect(result?.result?.formatted).toContain("live collateral error");
			} finally {
				env.cleanup();
			}
		});

		it("characterization: appendFallbackNeighbors with unknown binding still displays the collateral entry exactly as before", async () => {
			const env = setupTestEnvironment("cascade-1104-append-fallback-unknown-");
			try {
				const primary = path.join(env.tmpDir, "main.ts");
				const noLspNeighbor = path.join(env.tmpDir, "neighbor.foo");
				const fallbackFile = path.join(env.tmpDir, "already-open.ts");
				fs.writeFileSync(primary, "export const x = 1;\n");
				fs.writeFileSync(noLspNeighbor, "neighbor\n");
				fs.writeFileSync(fallbackFile, "const x = 1;\n");
				mocks.computeImpactCascade.mockReturnValue(
					impact(primary, [noLspNeighbor]),
				);
				installLspService({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi.fn().mockResolvedValue(
						new Map([
							[
								fallbackFile.split(path.sep).join("/"),
								withBinding(
									{
										diags: [lspError("unknown-bound fallback error")],
										ts: postEditTs(),
									},
									"unknown",
								),
							],
						]),
					),
					touchFile: vi.fn(),
					getDiagnostics: vi.fn(),
				});

				const { computeCascadeForFile } =
					await import("../../clients/dispatch/integration.js");
				const result = await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 1,
				});

				expect(result?.result?.formatted).toContain(
					"unknown-bound fallback error",
				);
			} finally {
				env.cleanup();
			}
		});

		it("HONESTY: when every appendFallbackNeighbors candidate is binding-rejected, the cascade still renders degraded/indeterminate — never a silent clean", async () => {
			const env = setupTestEnvironment("cascade-1104-honesty-");
			try {
				const primary = path.join(env.tmpDir, "main.ts");
				const noLspNeighbor = path.join(env.tmpDir, "neighbor.foo");
				const staleFile = path.join(env.tmpDir, "stale.ts");
				fs.writeFileSync(primary, "export const x = 1;\n");
				fs.writeFileSync(noLspNeighbor, "neighbor\n");
				fs.writeFileSync(staleFile, "const x = 1;\n");
				mocks.computeImpactCascade.mockReturnValue(
					impact(primary, [noLspNeighbor]),
				);
				installLspService({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi.fn().mockResolvedValue(
						new Map([
							[
								staleFile.split(path.sep).join("/"),
								withBinding(
									{
										diags: [lspError("withheld stale error")],
										ts: postEditTs(),
									},
									false,
								),
							],
						]),
					),
					touchFile: vi.fn(),
					getDiagnostics: vi.fn(),
				});

				const { computeCascadeForFile } =
					await import("../../clients/dispatch/integration.js");
				const result = await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 1,
				});

				// Not a genuine clean leaf: the withheld candidate must surface an
				// honest indeterminate advisory (#1023's doctrine, extended by
				// #1104) instead of silently looking clean/no_neighbors.
				expect(result?.skipReason).toBe("indeterminate");
				expect(result?.indeterminate?.reason).toBe("lsp_binding_rejected");
				expect(result?.result).toBeUndefined();
			} finally {
				env.cleanup();
			}
		});
	});

	// #4438: a change reaches files no import names: a Go file's package peers,
	// and every JS/TS file for a file that feeds the global scope. The cascade
	// took its neighbours from import and call edges only, so those files were
	// listed only by the degraded fallback, from the passive snapshot, and a Go
	// peer was never re-touched. Red on base ff67dd428.
	describe("implicit-scope dependents (#4438)", () => {
		function graphWith(files: string[]): ReviewGraph {
			const graph = emptyGraph();
			for (const file of files) {
				graph.fileNodes.set(normalizeMapKey(file), `file:${file}`);
			}
			return graph;
		}

		it("touches a Go file's package peer as a neighbour", async () => {
			const env = setupTestEnvironment("cascade-4438-go-");
			try {
				const primary = path.join(env.tmpDir, "b.go");
				const peer = path.join(env.tmpDir, "a.go");
				const other = path.join(env.tmpDir, "q", "c.go");
				fs.mkdirSync(path.dirname(other), { recursive: true });
				fs.writeFileSync(primary, "package p\n\nconst Y = 1\n");
				fs.writeFileSync(peer, "package p\n\nvar X = Y\n");
				fs.writeFileSync(other, "package q\n\nconst Z = 1\n");
				mocks.computeImpactCascade.mockReturnValue(impact(primary, []));
				const touchFile = vi
					.fn()
					.mockResolvedValue({ diags: [lspError("undefined: Y")] });
				installLspService({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
					touchFile,
					getDiagnostics: vi.fn(),
				});

				const { computeCascadeForFile } =
					await import("../../clients/dispatch/integration.js");
				const result = await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 1,
				});

				expect(touchFile.mock.calls.map(([file]) => file)).toEqual([peer]);
				const neighbor = result?.result?.neighbors[0];
				expect(neighbor?.filePath).toBe(peer);
				expect(neighbor?.reason).not.toBe("fallback");
				expect(neighbor?.lspTouched).toBe(true);
			} finally {
				env.cleanup();
			}
		});

		it("lists the JS/TS files as neighbours when an ambient file changes", async () => {
			const env = setupTestEnvironment("cascade-4438-ambient-");
			try {
				const primary = path.join(env.tmpDir, "globals.d.ts");
				const user = path.join(env.tmpDir, "use.ts");
				fs.writeFileSync(primary, "declare const FOO: string;\n");
				fs.writeFileSync(user, "export const u: number = FOO;\n");
				mocks.buildOrUpdateGraph.mockResolvedValue(graphWith([user]));
				mocks.computeImpactCascade.mockReturnValue(impact(primary, []));
				installLspService({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi.fn().mockResolvedValue(
						new Map([
							[
								user.split(path.sep).join("/"),
								{
									diags: [lspError("Type 'string' is not assignable")],
									ts: postEditTs(),
								},
							],
						]),
					),
					touchFile: vi.fn(),
					getDiagnostics: vi.fn(),
				});

				const { computeCascadeForFile } =
					await import("../../clients/dispatch/integration.js");
				const result = await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 1,
				});

				const neighbor = result?.result?.neighbors[0];
				expect(neighbor?.filePath).toBe(user);
				expect(neighbor?.reason).not.toBe("fallback");
			} finally {
				env.cleanup();
			}
		});

		// The bound: an ambient file reaches every JS/TS file of the project, so
		// the expansion takes the most central ones and says it stopped.
		it("caps the ambient expansion and discloses the cut", async () => {
			const env = setupTestEnvironment("cascade-4438-ambient-cap-");
			try {
				const primary = path.join(env.tmpDir, "globals.d.ts");
				fs.writeFileSync(primary, "declare const FOO: string;\n");
				const users: string[] = [];
				for (let i = 0; i < 14; i++) {
					const user = path.join(env.tmpDir, `u${i}.ts`);
					fs.writeFileSync(user, `export const u${i} = FOO;\n`);
					users.push(user);
				}
				mocks.buildOrUpdateGraph.mockResolvedValue(graphWith(users));
				mocks.computeImpactCascade.mockReturnValue(impact(primary, []));
				installLspService({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
					touchFile: vi.fn(),
					getDiagnostics: vi.fn(),
				});

				const { computeCascadeForFile } =
					await import("../../clients/dispatch/integration.js");
				const result = await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 1,
				});

				expect(result?.indeterminate?.reason).toBe("budget_truncated");
				expect(result?.indeterminate?.detail).toContain(
					"implicit-scope expansion checked 10 of 14 JS/TS files",
				);
			} finally {
				env.cleanup();
			}
		});

		// #4438 r2 (F1): a changed file the classifier cannot read (here over
		// the LSP sync limits, as `clients/lsp/index.ts` is) is no evidence of
		// a global-scope feed. Round 1 asked the cache's fail-closed answer,
		// touched 10 unrelated files and rendered a false budget advisory.
		it("adds no implicit neighbour when the changed module is over the sync limits", async () => {
			const env = setupTestEnvironment("cascade-4438-oversized-");
			try {
				const primary = path.join(env.tmpDir, "big.ts");
				const lines = ["import * as fs from 'node:fs';"];
				for (let i = 0; i < 5_100; i++) {
					lines.push(`export const v${i} = ${i};`);
				}
				fs.writeFileSync(primary, `${lines.join("\n")}\n`);
				const users: string[] = [];
				for (let i = 0; i < 14; i++) {
					const user = path.join(env.tmpDir, `u${i}.ts`);
					fs.writeFileSync(user, `export const u${i} = 1;\n`);
					users.push(user);
				}
				mocks.buildOrUpdateGraph.mockResolvedValue(graphWith(users));
				mocks.computeImpactCascade.mockReturnValue(impact(primary, []));
				const touchFile = vi.fn();
				installLspService({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
					touchFile,
					getDiagnostics: vi.fn(),
				});

				const { computeCascadeForFile } =
					await import("../../clients/dispatch/integration.js");
				const result = await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 1,
				});

				expect(touchFile).not.toHaveBeenCalled();
				expect(result?.neighborCount).toBe(0);
				expect(result?.indeterminate).toBeUndefined();
			} finally {
				env.cleanup();
			}
		});

		// #4438 r2 (F2): the cascade's Go peers need the same evidence as the
		// sweep's: same package clause, in the host build. A test file is
		// already dropped by the cascade's test-role filter.
		it("touches only the Go peers of the changed file's package build", async () => {
			const env = setupTestEnvironment("cascade-4438-go-evidence-");
			try {
				const primary = path.join(env.tmpDir, "b.go");
				const peer = path.join(env.tmpDir, "a.go");
				const otherOs = process.platform === "win32" ? "darwin" : "windows";
				fs.writeFileSync(primary, "package p\n\nconst Y = 1\n");
				fs.writeFileSync(peer, "package p\n\nvar X = Y\n");
				fs.writeFileSync(
					path.join(env.tmpDir, "gen.go"),
					"package q\n\nconst Z = 1\n",
				);
				fs.writeFileSync(
					path.join(env.tmpDir, "c.go"),
					`//go:build ${otherOs}\n\npackage p\n\nvar W = Y\n`,
				);
				fs.writeFileSync(
					path.join(env.tmpDir, `d_${otherOs}.go`),
					"package p\n\nvar V = Y\n",
				);
				mocks.computeImpactCascade.mockReturnValue(impact(primary, []));
				const touchFile = vi
					.fn()
					.mockResolvedValue({ diags: [lspError("undefined: Y")] });
				installLspService({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
					touchFile,
					getDiagnostics: vi.fn(),
				});

				const { computeCascadeForFile } =
					await import("../../clients/dispatch/integration.js");
				await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 1,
				});

				expect(touchFile.mock.calls.map(([file]) => file)).toEqual([peer]);
			} finally {
				env.cleanup();
			}
		});

		// #4438 r3 (review V3): a write is evidence for a peer only when the
		// written file is in that peer's build, so an in-package test file or a
		// file outside the host build touches no non-test peer.
		it.each([
			["an in-package test file", "a_test.go"],
			[
				"a file outside the host build",
				`x_${process.platform === "win32" ? "darwin" : "windows"}.go`,
			],
		])("touches no peer when the changed file is %s", async (_label, name) => {
			const env = setupTestEnvironment("cascade-4438-go-direction-");
			try {
				const primary = path.join(env.tmpDir, name);
				fs.writeFileSync(primary, "package p\n\nconst Y = 1\n");
				fs.writeFileSync(
					path.join(env.tmpDir, "b.go"),
					"package p\n\nvar X = Y\n",
				);
				mocks.computeImpactCascade.mockReturnValue(impact(primary, []));
				const touchFile = vi.fn().mockResolvedValue({ diags: [] });
				installLspService({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
					touchFile,
					getDiagnostics: vi.fn(),
				});

				const { computeCascadeForFile } =
					await import("../../clients/dispatch/integration.js");
				await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 1,
				});

				expect(touchFile).not.toHaveBeenCalled();
			} finally {
				env.cleanup();
			}
		});

		it("adds no implicit neighbour when the changed file is a module", async () => {
			const env = setupTestEnvironment("cascade-4438-module-");
			try {
				const primary = path.join(env.tmpDir, "mod.ts");
				const user = path.join(env.tmpDir, "use.ts");
				fs.writeFileSync(primary, "export const m = 1;\n");
				fs.writeFileSync(user, "export const u = 1;\n");
				mocks.buildOrUpdateGraph.mockResolvedValue(graphWith([user]));
				mocks.computeImpactCascade.mockReturnValue(impact(primary, []));
				const getAllDiagnostics = vi.fn().mockResolvedValue(new Map());
				installLspService({
					...makeLspServiceDouble(),
					getAllDiagnostics,
					touchFile: vi.fn(),
					getDiagnostics: vi.fn(),
				});

				const { computeCascadeForFile } =
					await import("../../clients/dispatch/integration.js");
				const result = await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 1,
				});

				expect(result?.neighborCount).toBe(0);
				expect(result?.indeterminate).toBeUndefined();
			} finally {
				env.cleanup();
			}
		});
	});

	// #4485/#4486/#4487: cascade delivery. Each case drives the production
	// compute (`computeCascadeForFile`) with the LSP service double standing in
	// for the language server, the host boundary.
	describe("cascade delivery (#4485, #4486, #4487)", () => {
		const tsSnapshot = (root: string, advertisedCommands: string[]) => [
			{
				serverId: "typescript",
				root,
				operationSupport: {},
				workspaceDiagnosticsSupport: { mode: "push-only" },
				launchVariant: "classic",
				advertisedCommands,
				rawCapabilityKeys: [],
			},
		];

		/** A snapshot read whose publish landed while the compute ran: the
		 * stamp is later than the compute's own start (`postEditTs`). */
		const publishedDuringCompute =
			(rows: Array<[string, ReturnType<typeof lspError>[]]>) => async () =>
				new Map(
					rows.map(([filePath, diags]) => [
						normalizeMapKey(filePath),
						{ diags, ts: postEditTs() },
					]),
				);

		function project(prefix: string) {
			const env = setupTestEnvironment(prefix);
			const primary = path.join(env.tmpDir, "src", "primary.ts");
			const neighbor = path.join(env.tmpDir, "src", "neighbor.ts");
			fs.mkdirSync(path.dirname(primary), { recursive: true });
			fs.writeFileSync(primary, "export const x = 1;\n");
			fs.writeFileSync(neighbor, "import { x } from './primary';\n");
			mocks.computeImpactCascade.mockReturnValue(impact(primary, [neighbor]));
			return { env, primary, neighbor };
		}

		// Recurrence (#4485): 77% of real neighbour outcomes were classic
		// tsserver neighbours deferred to the quiet window, which mostly never
		// came; the #707 sync confirm in the in-lane touch was never reached.
		it("a tier-3 neighbour whose server advertises typescript.tsserverRequest is answered in-lane and records no outstanding touch", async () => {
			const { env, primary, neighbor } = project("cascade-4485-cmdpull-");
			try {
				const touchFile = vi.fn(
					async (_path: string, _content: string, options: any) =>
						options?.collectDiagnostics
							? { diags: [lspError("Type 'string' is not assignable")] }
							: undefined,
				);
				installLspService({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
					getCapabilitySnapshots: vi
						.fn()
						.mockResolvedValue(
							tsSnapshot(env.tmpDir, ["typescript.tsserverRequest"]),
						),
					// A client that would stay silent through a silent-push wait,
					// so only the command-pull tier reaches the sync confirm.
					getClientForFile: vi
						.fn()
						.mockResolvedValue({ client: silentClient() }),
					touchFile,
				});

				const { computeCascadeForFile } =
					await import("../../clients/dispatch/integration.js");
				const { _getOutstandingCascadeTouchesForTests } =
					await import("../../clients/lsp/cascade-tier.js");
				const run = await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 1,
				});

				expect(touchFile).toHaveBeenCalledWith(
					neighbor,
					expect.any(String),
					expect.objectContaining({
						collectDiagnostics: true,
						clientScope: "primary",
						maxClientWaitMs: 1000,
					}),
				);
				expect(_getOutstandingCascadeTouchesForTests()).toEqual([]);
				expect(run.result?.formatted).toContain(
					"Type 'string' is not assignable",
				);
			} finally {
				env.cleanup();
			}
		});

		// Recurrence (#4485): 58 real runs whose every neighbour was deferred
		// returned `no_neighbors`, the value a genuine leaf returns.
		it("a run whose selected neighbours were all unanswered carries unconfirmed and never no_neighbors/clean", async () => {
			const { env, primary, neighbor } = project("cascade-4485-silent-");
			try {
				const waitForDiagnostics = vi.fn(async () => undefined);
				const client = {
					...silentClient(),
					diagnosticsVersion: 7,
					waitForDiagnostics,
				};
				installLspService({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
					getCapabilitySnapshots: vi
						.fn()
						.mockResolvedValue(tsSnapshot(env.tmpDir, [])),
					getClientForFile: vi.fn().mockResolvedValue({ client }),
					touchFile: vi.fn(async () => undefined),
				});

				const { computeCascadeForFile } =
					await import("../../clients/dispatch/integration.js");
				const run = await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 1,
				});

				// The wait is bounded and asks for a publish newer than the
				// client-wide counter read before the touch.
				expect(waitForDiagnostics).toHaveBeenCalledWith(neighbor, 1000, {
					minVersion: 7,
				});
				expect(run.skipReason).not.toBe("no_neighbors");
				expect(run.skipReason).not.toBe("clean");
				expect(run.skipReason).toBe("indeterminate");
				expect(run.unconfirmed).toEqual({
					count: 1,
					servers: [
						{
							serverId: "typescript",
							reason: "no-answer",
							waitMs: 1000,
							paths: [neighbor],
						},
					],
				});
				expect(run.selectedNeighborPaths).toEqual([neighbor]);
			} finally {
				env.cleanup();
			}
		});

		it("a silent-push neighbour that publishes inside the wait is answered with that publish", async () => {
			const { env, primary, neighbor } = project("cascade-4485-silent-pub-");
			try {
				let version = 7;
				const published = new Map<
					string,
					{ diags: ReturnType<typeof lspError>[]; ts: number }
				>();
				const client = Object.assign(silentClient(), {
					diagnosticsVersion: version,
					getDiagnosticsVersionForPath: () => version,
				});
				client.waitForDiagnostics = async () => {
					version = 9;
					published.set(normalizeMapKey(neighbor), {
						diags: [lspError("published inside the wait")],
						ts: Date.now() + 1,
					});
				};
				client.getDiagnostics = (file: string) =>
					published.get(normalizeMapKey(file))?.diags ?? [];
				installLspService({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
					getCapabilitySnapshots: vi
						.fn()
						.mockResolvedValue(tsSnapshot(env.tmpDir, [])),
					getClientForFile: vi.fn().mockResolvedValue({ client }),
					touchFile: vi.fn(async () => undefined),
				});

				const { computeCascadeForFile } =
					await import("../../clients/dispatch/integration.js");
				const { _getOutstandingCascadeTouchesForTests } =
					await import("../../clients/lsp/cascade-tier.js");
				const run = await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 1,
				});

				expect(run.unconfirmed).toBeUndefined();
				expect(run.result?.formatted).toContain("published inside the wait");
				expect(_getOutstandingCascadeTouchesForTests()).toEqual([]);
			} finally {
				env.cleanup();
			}
		});

		// Recurrence (#4486): a 4 s old snapshot of c.ts was read as clean; the
		// errors tsserver published 300 ms after the edit never reached the run.
		it("#4486: a passive snapshot with ts <= cascadeStart is not served; the neighbour is touched", async () => {
			const { env, primary, neighbor } = project("cascade-4486-pre-edit-");
			try {
				const touchFile = vi.fn(async () => ({
					diags: [lspError("error published after the edit")],
				}));
				installLspService({
					...makeLspServiceDouble(),
					// Clean, and published before this compute started.
					getAllDiagnostics: vi
						.fn()
						.mockResolvedValue(
							new Map([
								[normalizeMapKey(neighbor), { diags: [], ts: Date.now() - 50 }],
							]),
						),
					touchFile,
				});

				const { computeCascadeForFile } =
					await import("../../clients/dispatch/integration.js");
				const run = await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 1,
				});

				expect(touchFile).toHaveBeenCalledWith(
					neighbor,
					expect.any(String),
					expect.objectContaining({ collectDiagnostics: true }),
				);
				expect(run.result?.formatted).toContain(
					"error published after the edit",
				);
			} finally {
				env.cleanup();
			}
		});

		it("#4486: a passive snapshot published after the cascade started serves the neighbour without a touch", async () => {
			const { env, primary, neighbor } = project("cascade-4486-post-edit-");
			try {
				const touchFile = vi.fn();
				installLspService({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi.fn(
						publishedDuringCompute([[neighbor, [lspError("fresh error")]]]),
					),
					touchFile,
				});

				const { computeCascadeForFile } =
					await import("../../clients/dispatch/integration.js");
				const run = await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 1,
				});

				expect(touchFile).not.toHaveBeenCalled();
				expect(run.result?.neighbors[0]?.lspTouched).toBe(false);
				expect(run.result?.formatted).toContain("fresh error");
			} finally {
				env.cleanup();
			}
		});

		// Recurrence (#4487): a clean run carries no result, so a neighbour the
		// passive snapshot showed clean would never clear its pending error,
		// and the unresolved line would keep naming a fixed file.
		it("a clean passive snapshot published after the cascade started counts as an observation of the neighbour", async () => {
			const { env, primary, neighbor } = project("cascade-4487-clean-obs-");
			try {
				installLspService({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi.fn(publishedDuringCompute([[neighbor, []]])),
					touchFile: vi.fn(),
				});

				const { computeCascadeForFile } =
					await import("../../clients/dispatch/integration.js");
				const run = await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 1,
				});

				expect(run.result).toBeUndefined();
				expect(run.observedNeighborPaths).toEqual([neighbor]);
			} finally {
				env.cleanup();
			}
		});

		// Same shape as the passive snapshot (#4486 sweep): the touch-error
		// fallback served any TTL-fresh entry as the neighbour's state.
		it("#4486: the touch-error fallback does not display a snapshot from before the cascade started", async () => {
			const { env, primary, neighbor } = project("cascade-4486-touch-err-");
			try {
				// Python neighbour: no passive read, an active touch that throws.
				const pyNeighbor = path.join(env.tmpDir, "src", "dep.py");
				fs.writeFileSync(pyNeighbor, "import os\n");
				mocks.computeImpactCascade.mockReturnValue(
					impact(primary, [pyNeighbor]),
				);
				installLspService({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi
						.fn()
						.mockResolvedValue(
							new Map([
								[
									normalizeMapKey(pyNeighbor),
									{ diags: [lspError("pre-edit error")], ts: Date.now() - 50 },
								],
							]),
						),
					touchFile: vi.fn(async () => {
						throw new Error("touch failed");
					}),
				});

				const { computeCascadeForFile } =
					await import("../../clients/dispatch/integration.js");
				const run = await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 1,
				});

				expect(run.result?.formatted ?? "").not.toContain("pre-edit error");
				void neighbor;
			} finally {
				env.cleanup();
			}
		});

		it("#4486: the degraded fallback does not display cache entries from before the cascade started", async () => {
			const { env, primary } = project("cascade-4486-degraded-");
			try {
				const other = path.join(env.tmpDir, "src", "other.ts");
				fs.writeFileSync(other, "export const o = 1;\n");
				mocks.computeImpactCascade.mockReturnValue(impact(primary, []));
				installLspService({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi.fn().mockResolvedValue(
						new Map([
							[
								normalizeMapKey(other),
								{
									diags: [lspError("stale collateral")],
									ts: Date.now() - 50,
								},
							],
						]),
					),
					touchFile: vi.fn(),
				});

				const { computeCascadeForFile } =
					await import("../../clients/dispatch/integration.js");
				const run = await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 1,
				});

				expect(run.result?.formatted ?? "").not.toContain("stale collateral");
			} finally {
				env.cleanup();
			}
		});

		// Recurrence (#4486 sweep): the recently-clean cache answered clean for
		// five turns without a touch, so an edit that broke a neighbour checked
		// clean one turn earlier read clean.
		it("a neighbour checked clean on an earlier turn is checked again after the next edit", async () => {
			const { env, primary } = project("cascade-4486-recheck-");
			try {
				const pyNeighbor = path.join(env.tmpDir, "src", "dep.py");
				fs.writeFileSync(pyNeighbor, "import os\n");
				mocks.computeImpactCascade.mockReturnValue(
					impact(primary, [pyNeighbor]),
				);
				const touchFile = vi
					.fn()
					.mockResolvedValueOnce({ diags: [] })
					.mockResolvedValueOnce({ diags: [lspError("broken by the edit")] });
				installLspService({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
					touchFile,
				});

				const { computeCascadeForFile } =
					await import("../../clients/dispatch/integration.js");
				const first = await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 1,
				});
				const second = await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 2,
					writeSeq: 1,
				});

				expect(touchFile).toHaveBeenCalledTimes(2);
				// The clean answer is a fresh observation turn_end can clear a
				// pending neighbour error with (#4487).
				expect(first.skipReason).toBe("clean");
				expect(first.observedNeighborPaths).toEqual([pyNeighbor]);
				expect(second.result?.formatted).toContain("broken by the edit");
				expect(second.observedNeighborPaths).toEqual([pyNeighbor]);
			} finally {
				env.cleanup();
			}
		});

		// Recurrence (#4487): three cascades over four live tsserver errors
		// returned clean, then the errors, then clean.
		it("#4487: three cascades over a persistent neighbour error list it each time", async () => {
			const { env, primary, neighbor } = project("cascade-4487-persist-");
			try {
				installLspService({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi.fn(
						publishedDuringCompute([[neighbor, [lspError("same error")]]]),
					),
					touchFile: vi.fn(),
				});

				const { computeCascadeForFile } =
					await import("../../clients/dispatch/integration.js");
				const runs = [];
				for (const turnSeq of [1, 2, 3]) {
					runs.push(
						await computeCascadeForFile(primary, env.tmpDir, {
							turnSeq,
							writeSeq: 1,
						}),
					);
				}

				// The "still present since turn N" label is turn_end's (it names
				// the turn the error was first delivered), covered in
				// cascade-turn-merge.test.ts.
				for (const run of runs) {
					expect(run.skipReason).toBeUndefined();
					expect(run.result?.formatted).toContain("same error");
				}
			} finally {
				env.cleanup();
			}
		});

		// Recurrence (#4495 round-2 verify R2-1): the pending record took its
		// stamp from turn_end's delivery, after any write that landed between
		// the compute's read and turn_end, so the freshness gate never saw a
		// neighbour fixed in that window. The run carries its read bound.
		it("a run that lists neighbour errors carries its read time: the compute's start, before every read", async () => {
			const { env, primary, neighbor } = project("cascade-4495-checked-at-");
			try {
				const reads: number[] = [];
				const getAllDiagnostics = publishedDuringCompute([
					[neighbor, [lspError("read error")]],
				]);
				installLspService({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi.fn(async () => {
						reads.push(Date.now());
						return getAllDiagnostics();
					}),
					touchFile: vi.fn(),
				});
				const { computeCascadeForFile } =
					await import("../../clients/dispatch/integration.js");
				const before = Date.now();
				const run = await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 1,
				});
				expect(run.result?.formatted).toContain("read error");
				expect(reads.length).toBeGreaterThan(0);
				expect(run.checkedAt).toBeGreaterThanOrEqual(before);
				expect(run.checkedAt).toBeLessThanOrEqual(Math.min(...reads));
			} finally {
				env.cleanup();
			}
		});

		// Recurrence (#4485 row 7): once the #4403 "no language server
		// answered" line was delivered, a later run over the same unavailable
		// server listed no neighbour and returned `no_neighbors`, a leaf's
		// all-clear, although nothing was checked.
		it("a run whose unavailable-server line was already delivered is indeterminate, not a leaf, and repeats no line", async () => {
			const { env, primary } = project("cascade-4485-told-");
			try {
				installLspService({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
					touchFile: vi.fn(async () => ({
						diags: [],
						inconclusive: true,
						inconclusiveReason: "primary-unavailable",
						inconclusiveServerIds: ["typescript"],
						primaryUnavailableCause: "disabled",
					})),
				});

				const { computeCascadeForFile } =
					await import("../../clients/dispatch/integration.js");
				const { markCascadeUnansweredPrimariesDelivered } =
					await import("../../clients/cascade-format.js");
				const first = await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 1,
				});
				expect(first.result?.unansweredPrimaries?.notes).toHaveLength(1);
				markCascadeUnansweredPrimariesDelivered(["typescript"]);

				const later = await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 2,
					writeSeq: 1,
				});
				expect(later.result).toBeUndefined();
				expect(later.skipReason).toBe("indeterminate");
				expect(later.unconfirmed).toBeUndefined();
			} finally {
				env.cleanup();
			}
		});

		// Recurrence (#5034 review F2, #5014): a `fallbackFor` alternate answered
		// the neighbour while its owner did not, so the touch named the owner and
		// carried the alternate's findings. The primary-unavailable branch
		// returned `diagnostics: []`: the line reached the agent, the findings
		// did not. Once the line was delivered, the neighbour was dropped whole.
		it("a fallback's findings on a neighbour whose primary did not answer are delivered with the line, and after it", async () => {
			const { env, primary } = project("cascade-5014-fallback-");
			try {
				installLspService({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
					touchFile: vi.fn(async () => ({
						diags: [lspError("fallback finding")],
						inconclusive: true,
						inconclusiveReason: "primary-unavailable",
						inconclusiveServerIds: ["typescript"],
						primaryUnavailableCause: "unstarted",
					})),
				});

				const { computeCascadeForFile } =
					await import("../../clients/dispatch/integration.js");
				const { markCascadeUnansweredPrimariesDelivered } =
					await import("../../clients/cascade-format.js");
				const first = await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 1,
				});
				expect(first.result?.formatted).toContain("fallback finding");
				expect(first.result?.unansweredPrimaries?.notes).toHaveLength(1);
				// A fallback never confirms the neighbour.
				expect(first.observedNeighborPaths).toBeUndefined();
				markCascadeUnansweredPrimariesDelivered(["typescript"]);

				const later = await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 2,
					writeSeq: 1,
				});
				expect(later.result?.formatted).toContain("fallback finding");
				expect(later.result?.unansweredPrimaries).toBeUndefined();
				expect(later.observedNeighborPaths).toBeUndefined();
			} finally {
				env.cleanup();
			}
		});
	});
});
