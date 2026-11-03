import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import { getOpenDocumentSymbols } from "../../../clients/lsp-document-symbols.js";
import { LspRequestTimeoutError } from "../../../clients/lsp/request-timeout-error.js";
import {
	buildOrUpdateGraph,
	clearReviewGraphWorkspaceCache,
	flushReviewGraphPersist,
	flushReviewGraphPersistsForTests,
	getCachedReviewGraph,
} from "../../../clients/review-graph/builder.js";
import {
	clearReviewGraphFileIr,
	publishReviewGraphFileIr,
} from "../../../clients/review-graph/shared-extraction-ir.js";
import { logReviewGraph } from "../../../clients/review-graph-logger.js";
import { createTempFile, setupTestEnvironment } from "../test-utils.js";

vi.mock("../../../clients/lsp-document-symbols.js", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../../../clients/lsp-document-symbols.js")
		>();
	return { ...actual, getOpenDocumentSymbols: vi.fn() };
});
vi.mock("../../../clients/review-graph-logger.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../clients/review-graph-logger.js")
	>()),
	logReviewGraph: vi.fn(),
	flushReviewGraphLogSync: vi.fn(),
}));

const range = (start: number, end: number) => ({
	start: { line: start, character: 0 },
	end: { line: end, character: 1 },
});

afterEach(() => {
	flushReviewGraphPersistsForTests();
	clearReviewGraphWorkspaceCache();
	clearReviewGraphFileIr();
	vi.clearAllMocks();
});

// #4342: the fixtures are `.py` (python is a CORE grammar, bundled with the
// package), not `.dart`. A dart fixture needed tree-sitter-dart.wasm, which is
// not core, so a cold grammar cache sent the test to the CDN inside
// buildOrUpdateGraph; a slow CDN on a loaded shard stalled it past the 5 s test
// timeout. Python is non-jsts, so it still reaches the zero-symbol LSP fallback.
describe("review graph LSP symbol fallback (#307)", () => {
	it("adds hierarchical LSP nodes with provenance and persists them", async () => {
		const env = setupTestEnvironment("pi-lens-graph-lsp-");
		try {
			const file = createTempFile(env.tmpDir, "lib/main.py", "# opaque\n");
			process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS = "100000";
			vi.mocked(getOpenDocumentSymbols).mockResolvedValue([
				{
					name: "ReviewManager",
					kind: 5,
					range: range(0, 8),
					children: [{ name: "runSynthesis", kind: 6, range: range(2, 5) }],
				},
			]);
			const graph = await buildOrUpdateGraph(
				env.tmpDir,
				[file],
				new FactStore(),
			);
			const lspNodes = [...graph.nodes.values()].filter(
				(node) => node.provenance === "lsp",
			);
			expect(
				lspNodes.map((node) => node.qualifiedName ?? node.symbolName),
			).toEqual(["ReviewManager", "ReviewManager.runSynthesis"]);
			const parent = lspNodes.find(
				(node) => node.symbolName === "ReviewManager",
			)!;
			const child = lspNodes.find(
				(node) => node.symbolName === "runSynthesis",
			)!;
			expect(graph.edges).toContainEqual({
				from: parent.id,
				to: child.id,
				kind: "contains",
			});
			expect(logReviewGraph).toHaveBeenCalledWith(
				expect.objectContaining({
					phase: "lsp_symbol_fallback",
					reason: "added",
					nodes: 2,
				}),
			);

			expect(flushReviewGraphPersist(env.tmpDir, "cli").ok).toBe(true);
			clearReviewGraphWorkspaceCache(env.tmpDir);
			const loaded = getCachedReviewGraph(env.tmpDir);
			expect(
				[...(loaded?.nodes.values() ?? [])].filter(
					(node) => node.provenance === "lsp",
				),
			).toHaveLength(2);
		} finally {
			process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS = "0";
			env.cleanup();
		}
	});

	it("recovers native-TS7-shaped flat containment from containerName", async () => {
		const env = setupTestEnvironment("pi-lens-graph-lsp-flat-");
		try {
			const file = createTempFile(env.tmpDir, "lib/main.py", "# opaque\n");
			vi.mocked(getOpenDocumentSymbols).mockResolvedValue([
				{
					name: "ReviewManager",
					kind: 5,
					location: { uri: "file:///main.ts", range: range(0, 8) },
				},
				{
					name: "runSynthesis",
					containerName: "ReviewManager",
					kind: 6,
					location: { uri: "file:///main.ts", range: range(2, 5) },
				},
			]);
			const graph = await buildOrUpdateGraph(
				env.tmpDir,
				[file],
				new FactStore(),
			);
			const parent = [...graph.nodes.values()].find(
				(node) => node.symbolName === "ReviewManager",
			)!;
			const child = [...graph.nodes.values()].find(
				(node) => node.symbolName === "runSynthesis",
			)!;
			expect(child.qualifiedName).toBe("ReviewManager.runSynthesis");
			expect(graph.edges).toContainEqual({
				from: parent.id,
				to: child.id,
				kind: "contains",
			});
		} finally {
			env.cleanup();
		}
	});

	it("logs and degrades when no warm/open server is available", async () => {
		const env = setupTestEnvironment("pi-lens-graph-lsp-cold-");
		try {
			const file = createTempFile(env.tmpDir, "lib/main.py", "# opaque\n");
			vi.mocked(getOpenDocumentSymbols).mockResolvedValue(undefined);
			const graph = await buildOrUpdateGraph(
				env.tmpDir,
				[file],
				new FactStore(),
			);
			expect(
				[...graph.nodes.values()].some((node) => node.provenance === "lsp"),
			).toBe(false);
			expect(logReviewGraph).toHaveBeenCalledWith(
				expect.objectContaining({
					phase: "lsp_symbol_fallback",
					reason: "unavailable-or-failed",
				}),
			);
		} finally {
			env.cleanup();
		}
	});

	it("discloses a document-symbol timeout separately from no client", async () => {
		const env = setupTestEnvironment("pi-lens-graph-lsp-timeout-");
		try {
			const file = createTempFile(env.tmpDir, "lib/main.py", "# opaque\n");
			vi.mocked(getOpenDocumentSymbols).mockRejectedValue(
				new LspRequestTimeoutError("textDocument/documentSymbol", 150, 151),
			);
			await buildOrUpdateGraph(env.tmpDir, [file], new FactStore());
			expect(logReviewGraph).toHaveBeenCalledWith(
				expect.objectContaining({
					phase: "lsp_symbol_fallback",
					reason: "timeout",
				}),
			);
		} finally {
			env.cleanup();
		}
	});

	it("never requests document symbols for a productive fact extractor", async () => {
		const env = setupTestEnvironment("pi-lens-graph-lsp-productive-");
		try {
			const file = createTempFile(
				env.tmpDir,
				"src/main.ts",
				"export function productive() { return 1; }\n",
			);
			const graph = await buildOrUpdateGraph(
				env.tmpDir,
				[file],
				new FactStore(),
			);
			expect(
				[...graph.nodes.values()].some(
					(node) => node.symbolName === "productive",
				),
			).toBe(true);
			expect(getOpenDocumentSymbols).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("empty scanner IR still consults the warm LSP fallback (#955 review)", async () => {
		// A degraded extractor (defs query failed to compile — init() succeeds,
		// the documented kotlin case) publishes parsed-true/empty IR. Treating
		// that as authoritative silently lost the whole language's symbols on
		// warm builds; empty symbols now always take the fallback gate. For a
		// genuinely empty file the fallback is a no-op unless the file is open
		// in a warm client — which is exactly when LSP recovery is wanted.
		const env = setupTestEnvironment("pi-lens-graph-lsp-ir-empty-");
		try {
			const content = "# legitimately no declarations\n";
			const file = createTempFile(env.tmpDir, "lib/main.py", content);
			publishReviewGraphFileIr(env.tmpDir, {
				filePath: file,
				contentHash: createHash("sha256").update(content).digest("hex"),
				complete: true,
				structural: {
					kind: "tree-sitter",
					languageId: "python",
					extracted: { symbols: [], refs: [], imports: [] },
				},
			});
			await buildOrUpdateGraph(env.tmpDir, [file], new FactStore());
			expect(getOpenDocumentSymbols).toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});
});
