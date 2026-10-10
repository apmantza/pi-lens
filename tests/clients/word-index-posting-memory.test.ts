/**
 * #2069 — the word index's resident footprint.
 *
 * The index used to hold one boxed `{ file, line }` object per (token, file,
 * line) posting: 2.22 million objects for a 17.9 MB corpus, measured at
 * 186.6 MB resident, or 88.1 bytes to carry eight bytes of information. The fix
 * packs postings and the forward index into `Int32Array` lanes over a dense
 * file-id space.
 *
 * The first test here is the acceptance guard and measures REAL retained heap
 * with a forced collection on both sides, because an arithmetic estimate cannot
 * catch a representation that quietly reboxes. Everything else is a
 * mutation guard for one specific mechanism the packed form depends on.
 *
 * On pre-fix code every measured assertion below fails: the boxed
 * representation costs about 90 bytes per entry on this fixture, and
 * `word-index-store.js` does not exist.
 */

import * as v8 from "node:v8";
import * as vm from "node:vm";
import { describe, expect, it } from "vitest";
import {
	buildWordIndex,
	countWordIndexPostingEntries,
	estimateWordIndexResidentBytes,
	removeWordIndexDocument,
	releaseWordIndexMemoAtSettle,
	searchWordIndex,
	serializeWordIndex,
	updateWordIndexDocument,
	wordIndexKey,
	wordIndexPostingHits,
	type WordIndex,
} from "../../clients/word-index.js";
import {
	countPostingBackingStores,
	WORD_POSTING_ENTRY_BYTES,
} from "../../clients/word-index-store.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";

/**
 * Ceiling on measured bytes per posting entry.
 *
 * The fixture below measures 17.8 on a packed index and 97.2 on the boxed one,
 * so 28 leaves ~57% headroom for host variation while still failing hard on
 * the boxed representation. It is also tight enough to catch dropping the
 * token canonicalization the forward index depends on, which costs one string
 * per (document, token) and measured 39 bytes per entry on this fixture.
 *
 * #2069's own "under 16" is a figure for the real 2,622-document corpus, where
 * fixed per-token costs amortize over far more postings. That criterion is
 * asserted separately against the deterministic estimate.
 */
const MEASURED_BYTES_PER_ENTRY_CEILING = 28;

/**
 * A vocabulary sized so the fixture's postings-per-token ratio resembles a real
 * source tree's. That ratio is what the per-entry figure is sensitive to: the
 * fixed per-token bookkeeping amortizes over a token's postings, so a corpus of
 * mostly once-used identifiers reports a much higher per-entry cost than
 * pi-lens's own tree (2.26 million postings over 37,500 tokens, about 60 each).
 * 2,400 identifiers over the corpus below lands in the same neighbourhood.
 */
const VOCABULARY = Array.from({ length: 2400 }, (_, i) => `symbolName${i}`);

/** Deterministic pseudo-random source: the fixture must not vary run to run. */
function makeRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 0x1_0000_0000;
	};
}

function makeCorpus(documents: number, lines: number) {
	const random = makeRandom(20690);
	return Array.from({ length: documents }, (_, doc) => ({
		path: `src/module${doc}/file${doc}.ts`,
		content: Array.from({ length: lines }, () => {
			const words = Array.from(
				{ length: 4 },
				() => VOCABULARY[Math.floor(random() * VOCABULARY.length)],
			);
			return `const ${words[0]} = ${words[1]}(${words[2]}, ${words[3]});`;
		}).join("\n"),
	}));
}

/**
 * A forced-collection hook, without asking the whole suite for `--expose-gc`.
 *
 * The heap delta this file measures is meaningless un-forced: the tokenizer's
 * garbage is larger than the signal. Adding `--expose-gc` to every worker's
 * `execArgv` is the obvious route and is wrong here — `tests/config/worker-budget.test.ts`
 * pins that array to exactly the derived heap ceiling (#2042), and one file's
 * measurement need is no reason to widen a suite-wide contract. `setFlagsFromString`
 * exposes `gc` for this process only; the flag is turned back off immediately,
 * and the returned function keeps working because it is already bound.
 *
 * It throws rather than skipping. A silent skip would leave #2069's acceptance
 * guard disarmed behind a green tick (AGENTS.md shape 7, the invisible-skip
 * test-authoring screen).
 */
function resolveForcedCollector(): () => void {
	const ambient = (globalThis as { gc?: () => void }).gc;
	if (typeof ambient === "function") return ambient;
	v8.setFlagsFromString("--expose-gc");
	try {
		const collect = vm.runInNewContext("gc") as unknown;
		if (typeof collect !== "function") {
			throw new Error("could not expose gc(); #2069's memory guard cannot run");
		}
		return collect as () => void;
	} finally {
		v8.setFlagsFromString("--no-expose-gc");
	}
}

const forceCollect = resolveForcedCollector();

function forceCollection(): void {
	for (let i = 0; i < 5; i += 1) forceCollect();
}

/** Retained bytes, heap plus external backing stores, after a forced collection. */
function retainedBytes(): number {
	forceCollection();
	const usage = process.memoryUsage();
	return usage.heapUsed + usage.external;
}

describe("word-index posting footprint (#2069)", () => {
	it("holds a built index well under the boxed representation's cost", () => {
		const corpus = makeCorpus(240, 220);

		const before = retainedBytes();
		const index = buildWordIndex(corpus);
		const after = retainedBytes();

		const entries = countWordIndexPostingEntries(index);
		expect(entries).toBeGreaterThan(150_000);

		const measuredPerEntry = (after - before) / entries;
		// Keep the index reachable across the sample, then report on failure.
		expect(index.docCount).toBe(corpus.length);
		expect(measuredPerEntry).toBeLessThan(MEASURED_BYTES_PER_ENTRY_CEILING);
	});

	it("estimates under 16 bytes per posting entry (#2069 acceptance criterion 2)", () => {
		const index = buildWordIndex(makeCorpus(240, 220));
		const entries = countWordIndexPostingEntries(index);
		expect(entries).toBeGreaterThan(150_000);
		// Pin the density this figure is sensitive to, so a fixture edit that
		// quietly makes the corpus sparser cannot turn the bound into a fluke.
		expect(entries / index.postings.size).toBeGreaterThan(20);
		expect(estimateWordIndexResidentBytes(index) / entries).toBeLessThan(16);
	});

	it("leaves no growth slack in a bulk-built posting list", () => {
		const index = buildWordIndex(makeCorpus(40, 60));
		for (const list of index.postings.values()) {
			// `compact()` ran, so capacity equals length exactly. Drop the compaction
			// pass and the doubling growth leaves up to 100% slack here.
			expect(list.byteLength).toBe(list.length * WORD_POSTING_ENTRY_BYTES);
		}
	});

	it("shares one backing store across every bulk-built posting list", () => {
		const index = buildWordIndex(makeCorpus(40, 60));
		expect(index.postings.size).toBeGreaterThan(20);
		// Drop the arena pass and this equals `postings.size`: one ArrayBuffer
		// header per token, which measured 2.5 MB on this repository's corpus.
		expect(countPostingBackingStores(index.postings)).toBe(1);
		// A representation with no packed lanes at all reports one distinct
		// backing store too, because every list would report `undefined`. Pin the
		// store's identity and width so that cannot pass for an arena.
		const [first] = [...index.postings.values()];
		expect(first.backingStore).toBeInstanceOf(Int32Array);
		expect(first.backingStore.length).toBe(
			countWordIndexPostingEntries(index) * 2,
		);
	});

	it("moves a token that outgrows its arena slice without disturbing its neighbours", () => {
		const index = buildWordIndex([
			{ path: "a.ts", content: "alphaToken\nbetaToken" },
			{ path: "b.ts", content: "betaToken\ngammaToken" },
		]);
		expect(countPostingBackingStores(index.postings)).toBe(1);
		const alphaBefore = wordIndexPostingHits(index, "alphatoken");
		const betaBefore = wordIndexPostingHits(index, "betatoken");
		const gammaBefore = wordIndexPostingHits(index, "gammatoken");

		// `gammatoken` is the LAST list in the arena, so its slice starts at a
		// non-zero offset — the case that catches a grow which forgets to reset
		// the offset as well as one that writes past the slice. Growing the FIRST
		// list would sit at offset zero and pass either way.
		updateWordIndexDocument(index, {
			path: "c.ts",
			content: "gammaToken\ngammaToken more",
		});

		expect(wordIndexPostingHits(index, "gammatoken")).toHaveLength(3);
		expect(wordIndexPostingHits(index, "alphatoken")).toEqual(alphaBefore);
		expect(wordIndexPostingHits(index, "betatoken")).toEqual(betaBefore);
		expect(wordIndexPostingHits(index, "gammatoken").slice(0, 1)).toEqual(
			gammaBefore,
		);
	});

	it("recycles the file id a replaced document releases", () => {
		const index = buildWordIndex([{ path: "a.ts", content: "alphaToken" }]);
		for (let i = 0; i < 50; i += 1) {
			updateWordIndexDocument(index, {
				path: "a.ts",
				content: `alphaToken revision${i}`,
			});
		}
		expect(index.fileTable.size).toBe(1);
		// Without the free list, each replacement's remove-then-add would burn a
		// fresh id and strand a display-path slot: 51 slots for one document.
		expect(index.fileTable.idSpaceWidth).toBe(1);
	});

	it("does not let a recycled file id alias a removed document's postings", () => {
		const index = buildWordIndex([
			{ path: "a.ts", content: "sharedToken alphaOnly" },
			{ path: "b.ts", content: "sharedToken betaOnly" },
		]);
		const removedId = index.fileTable.idFor(wordIndexKey("a.ts"));
		expect(removedId).toBeDefined();
		expect(removeWordIndexDocument(index, "a.ts")).toBe(true);

		// The next document interned takes the recycled id.
		expect(
			updateWordIndexDocument(index, {
				path: "c.ts",
				content: "sharedToken gammaOnly",
			}),
		).toBe(true);
		expect(index.fileTable.idFor(wordIndexKey("c.ts"))).toBe(removedId);

		// a.ts must be gone from every posting the recycled id could alias.
		const files = wordIndexPostingHits(index, "sharedtoken").map(
			(hit) => hit.file,
		);
		expect(files.sort()).toEqual(["b.ts", "c.ts"]);
		expect(index.postings.has("alphaonly")).toBe(false);
	});

	it("records a bounded degradation when a posting's file id has no path", () => {
		resetDegradationLedger();
		const index = buildWordIndex([
			{ path: "a.ts", content: "alphaToken\nalphaToken again" },
			{ path: "b.ts", content: "betaToken" },
		]);
		// Break the invariant the packed store rests on: release the id while its
		// postings still name it. `release` is the real production method, so this
		// forces the branch without stubbing anything the code under test owns.
		expect(index.fileTable.release(wordIndexKey("a.ts"))).toBeDefined();

		// Each seam is measured in its OWN ledger window. Sharing one window lets a
		// seam that stopped recording hide behind its sibling's count.
		const orphanGroup = () =>
			getDegradationSummary().find(
				(entry) => entry.kind === "word-index-orphan-file-id",
			);

		// Decode seam: a.ts held `alphatoken` on two lines, so both postings drop.
		expect(wordIndexPostingHits(index, "alphatoken")).toEqual([]);
		expect(orphanGroup()?.count).toBe(2);
		expect(orphanGroup()?.latestReasons.map((entry) => entry.subject)).toEqual([
			"fileId:0",
		]);
		expect(orphanGroup()?.latestReasons[0]?.reason).toMatch(
			/^decode dropped a posting for token "alphatoken": the file table has no path for this id \(count: 2\)$/,
		);

		// Search seam, fresh window. `alphaToken` also splits into the shared
		// sub-token `token`, which b.ts still carries, so the query returns a
		// SHORTER list rather than an empty one — exactly the case a silent drop
		// makes indistinguishable from a smaller match set (AGENTS.md shape 10).
		resetDegradationLedger();
		expect(orphanGroup()).toBeUndefined();
		expect(
			searchWordIndex(index, "alphaToken", {
				demoteTestVendor: false,
				demoteDocs: false,
			}).map((result) => result.file),
		).toEqual(["b.ts"]);
		// One grouped entry per query token that still names the orphaned id:
		// `alphatoken`, `alpha`, and the shared `token`.
		expect(orphanGroup()?.count).toBe(3);
		expect(orphanGroup()?.latestReasons.map((entry) => entry.subject)).toEqual([
			"fileId:0",
		]);
		expect(orphanGroup()?.latestReasons[0]?.reason).toMatch(
			/^search dropped a posting for token "[a-z]+": the file table has no path for this id \(count: 3\)$/,
		);
		resetDegradationLedger();
	});

	it("ranks identically to the boxed representation's documented output", () => {
		// #2069 acceptance criterion 3: file/score/hits/lines are unchanged. The
		// packed store groups by file id and resolves the display path once per
		// (token, file); this pins the resolved output shape.
		const index: WordIndex = buildWordIndex([
			{ path: "src/widget.ts", content: "renderWidget\nrenderWidget helper" },
			{ path: "src/other.ts", content: "renderWidget" },
		]);
		const results = searchWordIndex(index, "renderWidget", {
			demoteTestVendor: false,
			demoteDocs: false,
		});
		expect(
			results.map((r) => ({ file: r.file, hits: r.hits, lines: r.lines })),
		).toEqual([
			// `renderWidget` splits into three query tokens (renderwidget,
			// render, widget), so `hits` is the summed term frequency across all
			// three, not the count of matching lines.
			{ file: "src/widget.ts", hits: 6, lines: [1, 2] },
			{ file: "src/other.ts", hits: 3, lines: [1] },
		]);
	});
});

describe("word-index serialized memo footprint (#4124)", () => {
	it("frees the wire form's heap when the settle releases it, with the decoded index kept", () => {
		const index = buildWordIndex(makeCorpus(240, 220));
		const baseline = retainedBytes();
		serializeWordIndex(index);
		const held = retainedBytes();
		releaseWordIndexMemoAtSettle(index);
		const released = retainedBytes();

		// Recurrence: the memo is a second copy of the index's postings and sat on
		// the heap for the whole idle life of a session.
		expect(held - baseline).toBeGreaterThan(1_000_000);
		expect(held - released).toBeGreaterThan((held - baseline) * 0.8);
		expect(index.docCount).toBe(240);
	});

	it("neither the memo nor its armed backstop keeps a dropped index alive", async () => {
		// Recurrence guard for the backstop timer: a closure holding the index
		// strongly would pin a replaced session's index and wire form for the
		// whole delay (10 minutes by default).
		let ref: WeakRef<WordIndex> | undefined;
		(() => {
			const index = buildWordIndex(makeCorpus(20, 40));
			serializeWordIndex(index);
			ref = new WeakRef(index);
		})();
		// A WeakRef target is only cleared after the job that created it ends.
		await new Promise<void>((resolve) => setImmediate(resolve));
		forceCollection();
		expect(ref?.deref()).toBeUndefined();
	});
});
