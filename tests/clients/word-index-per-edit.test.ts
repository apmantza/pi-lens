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
import {
	buildWordIndex,
	WORD_INDEX_MAX_BYTES,
	wordIndexPostingHits,
} from "../../clients/word-index.js";
import { countClockReads } from "../support/perf-harness.js";
import { setupTestEnvironment } from "./test-utils.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";

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
		mocks.getLSPService.mockReset().mockReturnValue(makeLspServiceDouble());
		const { resetDispatchBaselines } =
			await import("../../clients/dispatch/integration.js");
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
			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");
			await computeCascadeForFile(filePath, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
				fileContent: content,
				wordIndex,
				onWordIndexUpdated,
			});

			expect(wordIndex.postings.has("oldwidget")).toBe(false);
			expect(
				wordIndexPostingHits(wordIndex, "renderwidget").some(
					(h) => h.file === filePath,
				),
			).toBe(true);
			expect(onWordIndexUpdated).toHaveBeenCalledWith(wordIndex);
			// The broader runtime.wordIndex -> memory_sample seam remains a remainder:
			// this PR does not fix the dogfood wordIndex:null observation.
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
			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");
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
			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");
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
			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");
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

	// #2254: the seam's cooperative replacement must read the clock O(distinct
	// tokens the old document carried), not O(posting elements it walks). That is
	// what keeps the per-edit block bounded — a deadline check per posting element
	// cost one `performance.now()` per entry (the #2067 tax). A clock-read count
	// is a deterministic WORK COUNT, invariant to machine speed and runner load,
	// so it replaces the earlier wall-clock max-block bound (#2202 class): that
	// bound needed a 401-document fixture and `retry: 2`, and was both flaky and a
	// noisy neighbour in the timing-sensitive lane.
	//
	// Red-first: restoring the per-element deadline check reds this — the fixture
	// walks two orders of magnitude more posting elements than it has tokens.
	it("replaces through the seam with clock reads bounded by tokens, not postings (#2254)", async () => {
		const env = setupTestEnvironment("word-index-per-edit-occupancy-");
		try {
			// A few distinct tokens repeated across a high-document-frequency corpus:
			// each token's posting list is long, so a per-element deadline check would
			// read the clock tens of thousands of times while a per-token check reads
			// it a handful. No large single document and no retry are needed — the
			// clock-read count does not depend on wall-clock timing.
			const shared = Array.from(
				{ length: 6 },
				(_, i) => `sharedtoken${i}`,
			).join(" ");
			const filePath = path.join(env.tmpDir, "src", "target.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			const content = Array(20).fill("replacementtoken here").join("\n");
			fs.writeFileSync(filePath, content);

			const wordIndex = buildWordIndex([
				{ path: filePath, content: Array(20).fill(shared).join("\n") },
				...Array.from({ length: 60 }, (_, doc) => ({
					path: path.join(env.tmpDir, "src", `peer${doc}.ts`),
					content: Array(200).fill(shared).join("\n"),
				})),
			]);

			// Not vacuous: the old document's tokens really do span a large posting
			// population the staging pass has to walk.
			let postingElements = 0;
			let oldDistinctTokens = 0;
			for (const token of wordIndex.forward?.get(filePath)?.keys() ?? []) {
				postingElements += wordIndex.postings.get(token)?.length ?? 0;
				oldDistinctTokens += 1;
			}
			expect(postingElements).toBeGreaterThan(20_000);
			expect(oldDistinctTokens).toBeGreaterThan(0);

			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");
			const clockReads = await countClockReads(() =>
				computeCascadeForFile(filePath, env.tmpDir, {
					turnSeq: 1,
					writeSeq: 1,
					fileContent: content,
					wordIndex,
				}),
			);

			// TWO-SIDED. The upper bound catches the per-element regression: one read
			// per posting element instead of per token reds it by two orders of
			// magnitude. The lower bound catches the opposite regression, and it is
			// the one the deleted wall-clock assertion used to own — if the seam stops
			// calling the cooperative primitive and goes back to the synchronous
			// `updateWordIndexDocument`, there is no deadline at all, so the count
			// COLLAPSES to zero and an upper bound alone stays green. The floor is the
			// old document's distinct-token count, because cooperative staging checks
			// its deadline once per token it retires.
			expect(clockReads).toBeGreaterThanOrEqual(oldDistinctTokens);
			expect(clockReads).toBeLessThan(2_000);
			// Not vacuous: the replacement really happened.
			expect(
				wordIndexPostingHits(wordIndex, "replacementtoken").some(
					(hit) => hit.file === filePath,
				),
			).toBe(true);
			expect(
				wordIndexPostingHits(wordIndex, "sharedtoken0").some(
					(hit) => hit.file === filePath,
				),
			).toBe(false);
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
			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");
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
