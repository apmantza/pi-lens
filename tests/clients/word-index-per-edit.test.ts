/**
 * #348 phase 2 — the per-edit seam (`computeCascadeForFile`'s `wordIndex`/
 * `fileContent`/`onWordIndexUpdated` options) that updates the warm in-memory
 * word index at the SAME call site as the review-graph rebuild, and the
 * cold-session handoff rule: no index loaded yet ⇒ documented no-op (phase 1's
 * lifecycle/background build owns "cold", never this seam).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewGraph } from "../../clients/review-graph/types.js";
import { buildWordIndex, WORD_INDEX_MAX_BYTES } from "../../clients/word-index.js";
import { setupTestEnvironment } from "./test-utils.js";

const mocks = vi.hoisted(() => ({
	buildOrUpdateGraph: vi.fn(),
	computeImpactCascade: vi.fn(),
	computeTransitiveImpact: vi.fn(() => ({
		seedFile: "",
		hits: [],
		truncated: false,
		maxDepthReached: 0,
	})),
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

function noNeighbors(filePath: string) {
	return {
		filePath,
		changedSymbols: [],
		directImporters: [],
		directCallers: [],
		neighborFiles: [],
		riskFlags: [],
	};
}

describe("computeCascadeForFile — word-index per-edit seam (#348 phase 2)", () => {
	beforeEach(async () => {
		vi.resetModules();
		mocks.buildOrUpdateGraph.mockReset().mockResolvedValue(emptyGraph());
		mocks.computeImpactCascade.mockReset().mockImplementation(noNeighbors);
		mocks.computeTransitiveImpact.mockReset().mockReturnValue({
			seedFile: "",
			hits: [],
			truncated: false,
			maxDepthReached: 0,
		});
		mocks.formatImpactCascade.mockReset().mockReturnValue(undefined);
		mocks.getLSPService.mockReset().mockReturnValue({
			getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
			touchFile: vi.fn(),
			getDiagnostics: vi.fn(),
		});
		const { resetDispatchBaselines } = await import(
			"../../clients/dispatch/integration.js"
		);
		resetDispatchBaselines();
	}, 30_000);

	it("updates the in-memory index with the edited file's content", async () => {
		const env = setupTestEnvironment("word-index-per-edit-update-");
		try {
			const filePath = path.join(env.tmpDir, "src", "widget.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			const content = "export function renderWidget() { return 1; }";
			fs.writeFileSync(filePath, content);

			const wordIndex = buildWordIndex([
				{ path: filePath, content: "export function oldWidget() {}" },
			]);
			expect(wordIndex.postings.has("oldwidget")).toBe(true);
			expect(wordIndex.postings.has("renderwidget")).toBe(false);

			const onWordIndexUpdated = vi.fn();
			const { computeCascadeForFile } = await import(
				"../../clients/dispatch/integration.js"
			);
			await computeCascadeForFile(filePath, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
				fileContent: content,
				wordIndex,
				onWordIndexUpdated,
			});

			expect(wordIndex.postings.has("oldwidget")).toBe(false);
			expect(
				wordIndex.postings.get("renderwidget")?.some((h) => h.file === filePath),
			).toBe(true);
			expect(onWordIndexUpdated).toHaveBeenCalledWith(wordIndex);
		} finally {
			env.cleanup();
		}
	});

	it("cold-session handoff: wordIndex null is a no-op (never synchronously builds)", async () => {
		const env = setupTestEnvironment("word-index-per-edit-cold-");
		try {
			const filePath = path.join(env.tmpDir, "src", "widget.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			const content = "export function renderWidget() {}";
			fs.writeFileSync(filePath, content);

			const onWordIndexUpdated = vi.fn();
			const { computeCascadeForFile } = await import(
				"../../clients/dispatch/integration.js"
			);
			// wordIndex omitted entirely (undefined), matching a cold session where
			// runtime.wordIndex is still null and nothing is threaded through.
			await computeCascadeForFile(filePath, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
				fileContent: content,
				onWordIndexUpdated,
			});

			expect(onWordIndexUpdated).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("no-op when the index has no forward map (pre-phase-2 / deserialized-old-shape)", async () => {
		const env = setupTestEnvironment("word-index-per-edit-noforward-");
		try {
			const filePath = path.join(env.tmpDir, "src", "widget.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			const content = "export function renderWidget() {}";
			fs.writeFileSync(filePath, content);

			const wordIndex = buildWordIndex([
				{ path: filePath, content: "export function oldWidget() {}" },
			]);
			delete wordIndex.forward; // simulate a pre-phase-2 index shape

			const onWordIndexUpdated = vi.fn();
			const { computeCascadeForFile } = await import(
				"../../clients/dispatch/integration.js"
			);
			await computeCascadeForFile(filePath, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
				fileContent: content,
				wordIndex,
				onWordIndexUpdated,
			});

			// Untouched — no incremental update attempted on a forward-index-less index.
			expect(wordIndex.postings.has("oldwidget")).toBe(true);
			expect(onWordIndexUpdated).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("no-op when fileContent is undefined (deleted/unreadable file)", async () => {
		const env = setupTestEnvironment("word-index-per-edit-nocontent-");
		try {
			const filePath = path.join(env.tmpDir, "src", "widget.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "export function renderWidget() {}");

			const wordIndex = buildWordIndex([
				{ path: filePath, content: "export function oldWidget() {}" },
			]);
			const onWordIndexUpdated = vi.fn();
			const { computeCascadeForFile } = await import(
				"../../clients/dispatch/integration.js"
			);
			await computeCascadeForFile(filePath, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
				// fileContent intentionally omitted (undefined)
				wordIndex,
				onWordIndexUpdated,
			});

			expect(wordIndex.postings.has("oldwidget")).toBe(true);
			expect(onWordIndexUpdated).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("removes (not partially indexes) a file over the shared size cap", async () => {
		const env = setupTestEnvironment("word-index-per-edit-oversize-");
		try {
			const filePath = path.join(env.tmpDir, "src", "huge.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			const hugeContent = "x".repeat(WORD_INDEX_MAX_BYTES + 1024);
			fs.writeFileSync(filePath, hugeContent);

			const wordIndex = buildWordIndex([
				{ path: filePath, content: "export function smallHuge() {}" },
			]);
			expect(wordIndex.docLengths.has(filePath)).toBe(true);

			const onWordIndexUpdated = vi.fn();
			const { computeCascadeForFile } = await import(
				"../../clients/dispatch/integration.js"
			);
			await computeCascadeForFile(filePath, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
				fileContent: hugeContent,
				wordIndex,
				onWordIndexUpdated,
			});

			expect(wordIndex.docLengths.has(filePath)).toBe(false);
			expect(wordIndex.forward?.has(filePath)).toBe(false);
			expect(onWordIndexUpdated).toHaveBeenCalledWith(wordIndex);
		} finally {
			env.cleanup();
		}
	});
});
