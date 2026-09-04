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

vi.mock("../../clients/lsp/index.js", () => ({
	getLSPService: mocks.getLSPService,
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

// Keep inline behavior overrides on the shared service factory while making
// the recurrence sweep sensitive to direct `vi.fn` service literals.
const makeTouchFileMock = vi.fn;

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
		mocks.getLSPService.mockReset();
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
			mocks.getLSPService.mockReturnValue({
				...makeLspServiceDouble(),
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
			mocks.getLSPService.mockReturnValue({
				...makeLspServiceDouble(),
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
				touchFile: makeTouchFileMock(),
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
			mocks.getLSPService.mockReturnValue({
				...makeLspServiceDouble(),
				getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
				touchFile: makeTouchFileMock().mockResolvedValue({
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
			mocks.getLSPService.mockReturnValue({
				...makeLspServiceDouble(),
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
				touchFile: makeTouchFileMock(),
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
			mocks.getLSPService.mockReturnValue({
				...makeLspServiceDouble(),
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
				touchFile: makeTouchFileMock(),
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
			mocks.getLSPService.mockReturnValue({
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
			mocks.getLSPService.mockReturnValue({
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
			mocks.getLSPService.mockReturnValue({
				...makeLspServiceDouble(),
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
			mocks.getLSPService.mockReturnValue({
				...makeLspServiceDouble(),
				getAllDiagnostics: vi.fn().mockResolvedValue(
					new Map([
						[
							noLspNeighbor.split(path.sep).join("/"),
							{ diags: [lspError("no-server error")], ts: Date.now() },
						],
						[
							unrelated.split(path.sep).join("/"),
							{ diags: [lspError("unrelated error")], ts: Date.now() },
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
			mocks.getLSPService.mockReturnValue({
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

	it("#458: skips the in-lane wait for a tier-3 (push-only, silent-on-clean) neighbor touch and records it outstanding", async () => {
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
				client: { serverId: "typescript" },
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
			mocks.getLSPService.mockReturnValue({
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
			// No trustworthy diagnostics were produced by this touch, so the
			// degraded-fallback path (empty diagnostics, not "clean") applies —
			// never a false "no errors" for a skipped wait.
			expect(result?.result?.neighbors[0]?.diagnostics ?? []).toEqual([]);
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
			mocks.getLSPService.mockReturnValue({
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

	it("#1444: native-ts7 skips the in-lane wait and records a collect-later touch", async () => {
		const env = setupTestEnvironment("cascade-native-ts7-collect-later-");
		try {
			const primary = path.join(env.tmpDir, "src", "primary.ts");
			const neighbor = path.join(env.tmpDir, "src", "neighbor.ts");
			fs.mkdirSync(path.dirname(primary), { recursive: true });
			fs.writeFileSync(primary, "export const x = 1;\n");
			fs.writeFileSync(neighbor, "import { x } from './primary';\n");
			mocks.computeImpactCascade.mockReturnValue(impact(primary, [neighbor]));
			const touchFile = vi.fn();
			mocks.getLSPService.mockReturnValue({
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
					client: { serverId: "typescript" },
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

	it("#1446 item 5: cascade_result records recentlyCleanHits when the recently-clean cache short-circuits a re-touch", async () => {
		const env = setupTestEnvironment("cascade-recently-clean-hits-");
		try {
			const primary = path.join(env.tmpDir, "model.py");
			const neighbor = path.join(env.tmpDir, "api.py");
			fs.writeFileSync(primary, "class User: pass\n");
			fs.writeFileSync(neighbor, "from model import User\n");
			mocks.computeImpactCascade.mockReturnValue(impact(primary, [neighbor]));
			const touchFile = vi.fn().mockResolvedValue({ diags: [] });
			mocks.getLSPService.mockReturnValue({
				...makeLspServiceDouble(),
				getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
				touchFile,
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");

			// First cascade: a confirmed clean touch seeds recentlyCleanNeighborCache.
			await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});
			expect(touchFile).toHaveBeenCalledTimes(1);
			mocks.logCascade.mockClear();

			// Second cascade, one turn later (within RECENTLY_CLEAN_TTL_TURNS = 5):
			// must short-circuit without touching the LSP again, and the skip must
			// be counted rather than silently disappearing into "no signal".
			await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 2,
				writeSeq: 2,
			});
			expect(touchFile).toHaveBeenCalledTimes(1);
			expect(mocks.logCascade).toHaveBeenCalledWith(
				expect.objectContaining({
					phase: "cascade_result",
					metadata: expect.objectContaining({
						recentlyCleanHits: 1,
					}),
				}),
			);
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
			mocks.getLSPService.mockReturnValue({
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
			expect(metadata).toMatchObject({ coldTouches: 1, recentlyCleanHits: 0 });
			expect(metadata).not.toHaveProperty("cacheHits");
		} finally {
			env.cleanup();
		}
	});

	// F1 (adversarial review of #1446): `coldTouches` used to be derived from
	// `coldSnapshotPaths.length`, a list finalized BEFORE the cache-hit checks
	// inside the touch pool run — so a coldSnapshotPaths neighbour that then hit
	// recentlyCleanNeighborCache was double-counted (cold AND
	// cache/clean), while a non-autopropagate (activePaths) neighbour that missed
	// both caches and took a genuine touch was counted in neither bucket. This
	// exercises the touch-pool outcomes in ONE run: `neighborColdTs` (.ts,
	// autoPropagate) sits in `coldSnapshotPaths` on every run (its snapshot is
	// never valid) and takes a genuine cold touch — the double-count case —
	// while `neighborCold` (.py, activePaths) takes a genuine cold touch too and
	// would be invisible to the old `coldSnapshotPaths.length` derivation
	// entirely — the silent-drop case. The counters must still partition the
	// touched-neighbour count exactly.
	//
	// #1899 dropped the `cacheHits` bucket with the dead `neighborTouchCache`;
	// the partition invariant is unchanged and now spans three buckets.
	it("F1: recentlyCleanHits/coldTouches/deferredTouches partition the touched-neighbour set", async () => {
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
				client: { serverId: "typescript" },
			});
			mocks.getLSPService.mockReturnValue({
				...makeLspServiceDouble(),
				getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
				getCapabilitySnapshots,
				getClientForFile,
				touchFile,
				getDiagnostics: vi.fn(),
			});

			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");

			// Setup run: seeds recentlyCleanNeighborCache (neighborClean, a
			// confirmed clean touch) at turnSeq=1/writeSeq=1.
			mocks.computeImpactCascade.mockReturnValueOnce(
				impact(primary, [neighborColdTs, neighborClean]),
			);
			await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});
			expect(touchFile).toHaveBeenCalledTimes(2);
			mocks.logCascade.mockClear();

			// Main run, SAME turnSeq/writeSeq, plus two new neighbours the
			// recently-clean cache has not seen.
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
						recentlyCleanHits: number;
						coldTouches: number;
						deferredTouches: number;
					};
				}
			).metadata;
			expect(metadata).toMatchObject({
				recentlyCleanHits: 1,
				coldTouches: 2,
				deferredTouches: 1,
			});
			// The partition invariant: every touched neighbour (the 4 in this
			// run's pool) lands in EXACTLY one bucket — no double-count (the old
			// coldSnapshotPaths.length bug), no silent drop (the old activePaths
			// undercounting bug).
			const touchedNeighbourCount = 4;
			expect(
				metadata.recentlyCleanHits +
					metadata.coldTouches +
					metadata.deferredTouches,
			).toBe(touchedNeighbourCount);
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
			mocks.getLSPService.mockReturnValue({
				...makeLspServiceDouble(),
				getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
				touchFile: makeTouchFileMock().mockResolvedValue({ diags: [] }),
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
		mocks.getLSPService.mockReturnValue({
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
			mocks.getLSPService.mockReturnValue({
				...makeLspServiceDouble(),
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
				...makeLspServiceDouble(),
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
				touchFile: makeTouchFileMock(),
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
				.mockResolvedValueOnce({ diags: [lspError("error1")] })
				.mockResolvedValueOnce({ diags: [lspError("error2")] });
			mocks.getLSPService.mockReturnValue({
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
			// Anchor the ignore matcher at tmpDir (a .git marker stops
			// resolveGitIgnoreRoot's upward walk) and ignore test files there.
			fs.mkdirSync(path.join(env.tmpDir, ".git"), { recursive: true });
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
			mocks.getLSPService.mockReturnValue({
				...makeLspServiceDouble(),
				getAllDiagnostics: vi
					.fn()
					.mockResolvedValue(
						new Map([
							[
								ignoredNeighbor.split(path.sep).join("/"),
								{ diags: [lspError("countTotal not found")], ts: Date.now() },
							],
						]),
					),
				touchFile: makeTouchFileMock(),
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
			fs.mkdirSync(path.join(env.tmpDir, ".git"), { recursive: true });
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
			mocks.getLSPService.mockReturnValue({
				...makeLspServiceDouble(),
				getAllDiagnostics: vi
					.fn()
					.mockResolvedValue(
						new Map([
							[
								ignoredOpen.split(path.sep).join("/"),
								{ diags: [lspError("ignored fallback error")], ts: Date.now() },
							],
						]),
					),
				touchFile: makeTouchFileMock(),
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
			mocks.getLSPService.mockReturnValue({
				...makeLspServiceDouble(),
				getAllDiagnostics: vi.fn().mockResolvedValue(
					new Map([
						[
							sourceNeighbor.split(path.sep).join("/"),
							{ diags: [lspError("consumer error")], ts: Date.now() },
						],
						[
							testNeighbor.split(path.sep).join("/"),
							{ diags: [lspError("test error")], ts: Date.now() },
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
			mocks.getLSPService.mockReturnValue({
				...makeLspServiceDouble(),
				getAllDiagnostics: vi.fn().mockResolvedValue(
					new Map([
						[
							sourceRef.split(path.sep).join("/"),
							{ diags: [lspError("consumer broke")], ts: Date.now() },
						],
						[
							testRef.split(path.sep).join("/"),
							{ diags: [lspError("test broke")], ts: Date.now() },
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
			fs.mkdirSync(path.join(env.tmpDir, ".git"), { recursive: true });
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
			mocks.getLSPService.mockReturnValue({
				...makeLspServiceDouble(),
				getAllDiagnostics: vi.fn().mockResolvedValue(
					new Map([
						[
							normalSource.split(path.sep).join("/"),
							{ diags: [lspError("normal source error")], ts: Date.now() },
						],
						[
							unignoredTest.split(path.sep).join("/"),
							{ diags: [lspError("unignored test error")], ts: Date.now() },
						],
						[
							ignoredTest.split(path.sep).join("/"),
							{ diags: [lspError("ignored test error")], ts: Date.now() },
						],
					]),
				),
				touchFile: makeTouchFileMock(),
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
			mocks.getLSPService.mockReturnValue({
				...makeLspServiceDouble(),
				getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
				touchFile: makeTouchFileMock(),
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
			mocks.getLSPService.mockReturnValue({
				...makeLspServiceDouble(),
				getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
				touchFile: makeTouchFileMock(),
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
			mocks.getLSPService.mockReturnValue({
				...makeLspServiceDouble(),
				getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
				touchFile: makeTouchFileMock(),
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
			mocks.getLSPService.mockReturnValue({
				...makeLspServiceDouble(),
				getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
				touchFile: makeTouchFileMock(),
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
				mocks.getLSPService.mockReturnValue({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi
						.fn()
						.mockResolvedValue(
							new Map([
								[
									neighbor.split(path.sep).join("/"),
									{ diags: [], ts: Date.now() },
								],
							]),
						),
					touchFile: makeTouchFileMock(),
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
				mocks.getLSPService.mockReturnValue({
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
				mocks.getLSPService.mockReturnValue({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
					touchFile: makeTouchFileMock().mockRejectedValue(
						new Error("touch timed out"),
					),
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
				mocks.getLSPService.mockReturnValue({
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

				// A NEWER per-edit LSP-error record for the neighbor (writeIndex 10).
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
					10,
				);

				// Cascade launched from an OLDER primary edit (writeSeq 3) lands late —
				// its reconcile must be dropped by the WriteOrderingGuard.
				await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
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
				mocks.getLSPService.mockReturnValue({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
					touchFile: vi
						.fn()
						.mockResolvedValue({ diags: [], inconclusive: true }),
					getDiagnostics: vi.fn(),
				});

				const { computeCascadeForFile, getDispatchCascadeCacheStats } =
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
				expect(
					getDispatchCascadeCacheStats().recentlyCleanNeighborCacheSize,
				).toBe(0);
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
				// live finding and seeded the recently-clean cache, making the wipe
				// self-sustaining on the next cascade.
				mocks.getLSPService.mockReturnValue({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
					touchFile: makeTouchFileMock().mockResolvedValue({
						diags: [],
						confirmation: "partial",
						unconfirmedServerIds: ["opengrep"],
					}),
					getDiagnostics: vi.fn(),
				});

				const { computeCascadeForFile, getDispatchCascadeCacheStats } =
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

				await computeCascadeForFile(primary, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 5,
				});

				const diags = getFileDiagnostics(neighbor);
				expect(diags).toHaveLength(1);
				expect(diags?.[0]?.message).toBe("live cross-file error");
				// Not cached as a confirmed neighbor result either.
				expect(
					getDispatchCascadeCacheStats().recentlyCleanNeighborCacheSize,
				).toBe(0);
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
				mocks.getLSPService.mockReturnValue({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
					touchFile: makeTouchFileMock().mockResolvedValue({
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
				mocks.getLSPService.mockReturnValue({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
					touchFile: makeTouchFileMock().mockResolvedValue({
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
				mocks.getLSPService.mockReturnValue({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
					touchFile: makeTouchFileMock().mockResolvedValue({
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
				mocks.getLSPService.mockReturnValue({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi
						.fn()
						.mockResolvedValue(
							new Map([
								[
									neighbor.split(path.sep).join("/"),
									{ diags: [], ts: Date.now() },
								],
							]),
						),
					touchFile: makeTouchFileMock(),
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
				// The snapshot is 20s old (still within CASCADE_TTL_MS) and reports an
				// error — a valid, confirmed observation, but an AGING one.
				const snapshotTs = Date.now() - 20_000;
				mocks.getLSPService.mockReturnValue({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi
						.fn()
						.mockResolvedValue(
							new Map([
								[
									neighbor.split(path.sep).join("/"),
									{ diags: [lspError("snapshot error")], ts: snapshotTs },
								],
							]),
						),
					touchFile: makeTouchFileMock(),
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

				// The neighbor file changed 10s ago — AFTER the snapshot's publish time
				// but before now. touchedAt must be the snapshot's `ts` (now-20s), so
				// the mtime-staleness gate drops the entry. Pre-fix (touchedAt=now, the
				// re-arming defect this PR fixes for cache hits): it would survive.
				const mtime = new Date(Date.now() - 10_000);
				fs.utimesSync(neighbor, mtime, mtime);
				expect(await reconcileStaleWidgetFiles()).toBe(1);
				expect(getFileDiagnostics(neighbor)).toBeUndefined();
			} finally {
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
				mocks.getLSPService.mockReturnValue({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
					touchFile: makeTouchFileMock().mockResolvedValue({
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
				mocks.getLSPService.mockReturnValue({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi
						.fn()
						.mockResolvedValue(
							new Map([
								[
									neighbor.split(path.sep).join("/"),
									withBinding(
										{ diags: [lspError("pre-fix error")], ts: Date.now() },
										false,
									),
								],
							]),
						),
					// The neighbor is actually clean now — a confirmed active re-check.
					touchFile: makeTouchFileMock().mockResolvedValue({ diags: [] }),
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
				const lsp = mocks.getLSPService.mock.results[0]?.value;
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
				mocks.getLSPService.mockReturnValue({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi.fn().mockResolvedValue(
						new Map([
							[
								neighbor.split(path.sep).join("/"),
								withBinding(
									{
										diags: [lspError("unknown-bound error")],
										ts: Date.now(),
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
				mocks.getLSPService.mockReturnValue({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi
						.fn()
						.mockResolvedValue(
							new Map([
								[
									neighbor.split(path.sep).join("/"),
									withBinding(
										{ diags: [lspError("bound-true error")], ts: Date.now() },
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
				mocks.getLSPService.mockReturnValue({
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
				mocks.getLSPService.mockReturnValue({
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
										ts: Date.now(),
									},
									false,
								),
							],
						]),
					),
					touchFile: makeTouchFileMock().mockImplementation(
						async (filePath: string) => {
							if (filePath === rejectedNeighbor) {
								throw new Error("touch failed");
							}
							return { diags: [lspError("confirmed live error")] };
						},
					),
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
				mocks.getLSPService.mockReturnValue({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi.fn().mockResolvedValue(
						new Map([
							[
								neighbor.split(path.sep).join("/"),
								withBinding(
									{
										diags: [lspError("unknown-bound stale error")],
										ts: Date.now(),
									},
									"unknown",
								),
							],
						]),
					),
					touchFile: makeTouchFileMock().mockRejectedValue(
						new Error("touch failed"),
					),
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
				mocks.getLSPService.mockReturnValue({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi.fn().mockResolvedValue(
						new Map([
							[
								staleFile.split(path.sep).join("/"),
								withBinding(
									{
										diags: [lspError("stale collateral error")],
										ts: Date.now(),
									},
									false,
								),
							],
							[
								liveFile.split(path.sep).join("/"),
								{ diags: [lspError("live collateral error")], ts: Date.now() },
							],
						]),
					),
					touchFile: makeTouchFileMock(),
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
				mocks.getLSPService.mockReturnValue({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi.fn().mockResolvedValue(
						new Map([
							[
								fallbackFile.split(path.sep).join("/"),
								withBinding(
									{
										diags: [lspError("unknown-bound fallback error")],
										ts: Date.now(),
									},
									"unknown",
								),
							],
						]),
					),
					touchFile: makeTouchFileMock(),
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
				mocks.getLSPService.mockReturnValue({
					...makeLspServiceDouble(),
					getAllDiagnostics: vi.fn().mockResolvedValue(
						new Map([
							[
								staleFile.split(path.sep).join("/"),
								withBinding(
									{
										diags: [lspError("withheld stale error")],
										ts: Date.now(),
									},
									false,
								),
							],
						]),
					),
					touchFile: makeTouchFileMock(),
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
});
