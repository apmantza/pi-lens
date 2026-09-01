/**
 * #348 phase 2 — the forward-index incremental-update primitive
 * (`updateWordIndexDocument` / `removeWordIndexDocument`) and its load-bearing
 * acceptance test: k random document edits/additions/removals applied
 * incrementally must produce an index STATE and QUERY RANKINGS identical to a
 * from-scratch `buildWordIndex` over the same final corpus.
 */

import { describe, expect, it } from "vitest";
import {
	buildWordIndex,
	deserializeWordIndex,
	removeWordIndexDocument,
	removeWordIndexDocumentAsync,
	searchWordIndex,
	serializeWordIndex,
	getLastWordIndexSerializeWork,
	updateWordIndexDocument,
	updateWordIndexDocumentForEdit,
	type WordIndex,
	wordIndexPostingHits,
} from "../../clients/word-index.js";
import { countClockReads } from "../support/perf-harness.js";

// --- Basic primitive behavior --------------------------------------------------

describe("updateWordIndexDocument / removeWordIndexDocument", () => {
	it("refreshes a Windows-shaped forward entry and removes phantom postings", () => {
		const file = "C:\\Repo\\Src\\Alpha.ts";
		const index = buildWordIndex([
			{ path: file, content: "oldalpha tokgamma" },
			{ path: "C:\\Repo\\Src\\Stable.ts", content: "stabletoken" },
		]);
		serializeWordIndex(index);

		updateWordIndexDocument(index, { path: file, content: "newalpha" });

		const incremental = serializeWordIndex(index);
		const slot = incremental.files.indexOf(file);
		expect(slot).toBeGreaterThanOrEqual(0);
		expect(incremental.forward?.[slot]?.[1]).toEqual([["newalpha", 1]]);

		const restored = deserializeWordIndex(incremental);
		expect(restored).not.toBeNull();
		expect(wordIndexPostingHits(restored!, "oldalpha")).toEqual([]);
		expect(wordIndexPostingHits(restored!, "tokgamma")).toEqual([]);
		expect(wordIndexPostingHits(restored!, "newalpha")).toEqual([
			{ file, line: 1 },
		]);
	});

	it("refreshes the cached wire view for a dirty document", () => {
		const index = buildWordIndex([
			{ path: "a.ts", content: "oldalpha" },
			{ path: "b.ts", content: "untouched" },
		]);
		serializeWordIndex(index);
		updateWordIndexDocument(index, { path: "a.ts", content: "newalpha" });

		const restored = deserializeWordIndex(serializeWordIndex(index));
		expect(restored).not.toBeNull();
		expect(wordIndexPostingHits(restored!, "oldalpha")).toEqual([]);
		expect(wordIndexPostingHits(restored!, "newalpha")).toEqual([
			{ file: "a.ts", line: 1 },
		]);
		expect(wordIndexPostingHits(restored!, "untouched")).toEqual([
			{ file: "b.ts", line: 1 },
		]);
	});

	it("keeps persisting edits after a session-start reload from a snapshot (#2068)", () => {
		const built = buildWordIndex([
			{ path: "a.ts", content: "oldalpha" },
			{ path: "b.ts", content: "untouched" },
		]);
		const restored = deserializeWordIndex(serializeWordIndex(built));
		expect(restored).not.toBeNull();

		// Mirrors session start's own first save right after deserialize
		// (`saveRuntimeProjectSnapshot`), which primes the wire cache before
		// any further edit happens in this process.
		serializeWordIndex(restored!);

		updateWordIndexDocument(restored!, { path: "a.ts", content: "newalpha" });

		const roundTripped = deserializeWordIndex(serializeWordIndex(restored!));
		expect(roundTripped).not.toBeNull();
		expect(wordIndexPostingHits(roundTripped!, "oldalpha")).toEqual([]);
		expect(wordIndexPostingHits(roundTripped!, "newalpha")).toEqual([
			{ file: "a.ts", line: 1 },
		]);
	});

	it("does not republish sanitized snapshot lanes from the reload cache", () => {
		const valid = serializeWordIndex(
			buildWordIndex([{ path: "a.ts", content: "good" }]),
		);
		const malformed = {
			...valid,
			postings: [
				["GOOD", [0, 1]],
				["good", [0, 1, 999, 1]],
			] as Array<[string, number[]]>,
			docLengths: ["not-a-length"] as unknown as number[],
			totalTokens: Number.NaN,
			indexedFileCount: 99,
			truncated: "yes" as unknown as boolean,
			fileMtimes: [Number.POSITIVE_INFINITY],
			fileSizes: [null] as unknown as number[],
			forward: [[0, [["good", -1]]]] as Array<
				[number, Array<[string, number]>]
			>,
		};

		const restored = deserializeWordIndex(malformed);
		expect(restored).not.toBeNull();
		expect(wordIndexPostingHits(restored!, "good")).toEqual([
			{ file: "a.ts", line: 1 },
		]);
		expect(wordIndexPostingHits(restored!, "GOOD")).toEqual([]);

		const output = serializeWordIndex(restored!);
		expect(getLastWordIndexSerializeWork()).toMatchObject({
			tookFullPath: true,
		});
		expect(output.postings).toEqual([["good", [0, 1]]]);
		expect(output.docLengths).toEqual([0]);
		expect(output.totalTokens).toBe(0);
		expect(output.indexedFileCount).toBe(1);
		expect(output.truncated).toBe(false);
		expect(output.fileMtimes).toEqual([0]);
		expect(output.fileSizes).toEqual([0]);
		expect(output.forward).toEqual([[0, [["good", 1]]]]);
	});

	it("seeds the incremental cache for a canonical snapshot", () => {
		const wire = serializeWordIndex(
			buildWordIndex([{ path: "a.ts", content: "good" }]),
		);
		const restored = deserializeWordIndex(wire);
		expect(restored).not.toBeNull();

		serializeWordIndex(restored!);
		expect(getLastWordIndexSerializeWork()).toMatchObject({
			tookFullPath: false,
			affectedTokenCount: 0,
		});
	});

	it("keeps the fast path for valid historical posting order", () => {
		const index = buildWordIndex([
			{ path: "a.ts", content: "shared alpha" },
			{ path: "b.ts", content: "shared beta" },
		]);
		serializeWordIndex(index);
		updateWordIndexDocument(index, { path: "a.ts", content: "shared gamma" });
		const wire = serializeWordIndex(index);
		expect(wire.postings.find(([token]) => token === "shared")?.[1]).toEqual([
			1, 1, 0, 1,
		]);

		const restored = deserializeWordIndex(wire);
		expect(restored).not.toBeNull();
		serializeWordIndex(restored!);
		expect(getLastWordIndexSerializeWork()?.tookFullPath).toBe(false);
	});

	it("takes the full path for aliases and partial legacy snapshots", () => {
		const valid = serializeWordIndex(
			buildWordIndex([{ path: "a.ts", content: "good" }]),
		);
		const aliased = {
			...valid,
			files: ["src/a.ts", "src\\a.ts"],
			docLengths: [1, 1],
			fileMtimes: [0, 0],
			fileSizes: [4, 4],
			indexedFileCount: 2,
			postings: [["good", [0, 1, 1, 1]]] as Array<[string, number[]]>,
			forward: [
				[0, [["good", 1]]],
				[1, [["good", 1]]],
			] as Array<[number, Array<[string, number]>]>,
		};
		const restoredAlias = deserializeWordIndex(aliased);
		expect(restoredAlias).not.toBeNull();
		expect(wordIndexPostingHits(restoredAlias!, "good")).toEqual([
			{ file: "src/a.ts", line: 1 },
		]);
		const aliasOutput = serializeWordIndex(restoredAlias!);
		expect(getLastWordIndexSerializeWork()?.tookFullPath).toBe(true);
		expect(aliasOutput.indexedFileCount).toBe(aliasOutput.files.length);
		expect(JSON.stringify(aliasOutput)).not.toBe(JSON.stringify(aliased));

		const legacy = { ...valid } as Record<string, unknown>;
		delete legacy.fileSizes;
		delete legacy.forward;
		const restoredLegacy = deserializeWordIndex(legacy as never);
		expect(restoredLegacy).not.toBeNull();
		const legacyOutput = serializeWordIndex(restoredLegacy!);
		expect(getLastWordIndexSerializeWork()?.tookFullPath).toBe(true);
		expect(legacyOutput.fileSizes).toEqual([0]);
		expect(legacyOutput.forward).toBeUndefined();

		const missingSizes = { ...valid } as Record<string, unknown>;
		delete missingSizes.fileSizes;
		const restoredMissingSizes = deserializeWordIndex(missingSizes as never);
		expect(restoredMissingSizes).not.toBeNull();
		const missingSizesOutput = serializeWordIndex(restoredMissingSizes!);
		expect(getLastWordIndexSerializeWork()?.tookFullPath).toBe(true);
		expect(missingSizesOutput.fileSizes).toEqual([0]);
		expect(missingSizesOutput.forward).toEqual(valid.forward);

		const missingForward = { ...valid } as Record<string, unknown>;
		delete missingForward.forward;
		const restoredMissingForward = deserializeWordIndex(
			missingForward as never,
		);
		expect(restoredMissingForward).not.toBeNull();
		const missingForwardOutput = serializeWordIndex(restoredMissingForward!);
		expect(getLastWordIndexSerializeWork()?.tookFullPath).toBe(true);
		expect(missingForwardOutput.fileSizes).toEqual(valid.fileSizes);
		expect(missingForwardOutput.forward).toBeUndefined();
		expect(
			updateWordIndexDocument(restoredMissingForward!, {
				path: "a.ts",
				content: "changed",
			}),
		).toBe(false);
		const afterUnsupportedEdit = serializeWordIndex(restoredMissingForward!);
		expect(afterUnsupportedEdit).toEqual(missingForwardOutput);
	});

	it("does not cache duplicate or per-file-inconsistent postings", () => {
		const valid = serializeWordIndex(
			buildWordIndex([
				{ path: "a.ts", content: "shared" },
				{ path: "b.ts", content: "shared" },
			]),
		);
		const duplicate = {
			...valid,
			postings: [["shared", [0, 1, 0, 1]]] as Array<[string, number[]]>,
			forward: [
				[0, [["shared", 2]]],
				[1, []],
			] as Array<[number, Array<[string, number]>]>,
		};

		const restored = deserializeWordIndex(duplicate);
		expect(restored).not.toBeNull();
		expect(wordIndexPostingHits(restored!, "shared")).toEqual([
			{ file: "a.ts", line: 1 },
		]);
		const output = serializeWordIndex(restored!);
		expect(getLastWordIndexSerializeWork()?.tookFullPath).toBe(true);
		expect(output.postings).toEqual([["shared", [0, 1]]]);
		expect(output.forward).toEqual([
			[0, [["shared", 1]]],
			[1, []],
		]);

		const inconsistent = {
			...valid,
			postings: [["shared", [0, 1, 0, 2]]] as Array<[string, number[]]>,
		};
		const restoredInconsistent = deserializeWordIndex(inconsistent);
		expect(restoredInconsistent).not.toBeNull();
		const inconsistentOutput = serializeWordIndex(restoredInconsistent!);
		expect(getLastWordIndexSerializeWork()?.tookFullPath).toBe(true);
		expect(inconsistentOutput.forward).toEqual([
			[0, [["shared", 2]]],
			[1, []],
		]);
	});

	it("persists a brand-new document after a cached snapshot is primed (#2158 F1)", () => {
		const index = buildWordIndex([{ path: "a.ts", content: "alpha" }]);
		serializeWordIndex(index);

		updateWordIndexDocument(index, { path: "b.ts", content: "epsilon" });

		const restored = deserializeWordIndex(serializeWordIndex(index));
		expect(restored).not.toBeNull();
		expect(wordIndexPostingHits(restored!, "epsilon")).toEqual([
			{ file: "b.ts", line: 1 },
		]);
	});

	it("keeps incremental and fresh mixed-batch wires equivalent (#2158 F3)", () => {
		const index = buildWordIndex([
			{ path: "a.ts", content: "shared alpha" },
			{ path: "b.ts", content: "beta shared" },
		]);
		serializeWordIndex(index);

		updateWordIndexDocument(index, { path: "a.ts", content: "shared gamma" });
		updateWordIndexDocument(index, { path: "c.ts", content: "delta shared" });
		removeWordIndexDocument(index, "b.ts");

		const incremental = serializeWordIndex(index);
		const fresh = serializeWordIndex(
			buildWordIndex([
				{ path: "a.ts", content: "shared gamma", mtimeMs: -1 },
				{ path: "c.ts", content: "delta shared", mtimeMs: -1 },
			]),
		);
		expect(incremental).toEqual(fresh);
	});

	it("adds a brand new document", () => {
		const index = buildWordIndex([
			{ path: "a.ts", content: "export function alpha() {}" },
		]);
		const ok = updateWordIndexDocument(index, {
			path: "b.ts",
			content: "export function beta() {}",
		});
		expect(ok).toBe(true);
		expect(index.docCount).toBe(2);
		expect(index.forward?.has("b.ts")).toBe(true);
		expect(
			wordIndexPostingHits(index, "beta").some((h) => h.file === "b.ts"),
		).toBe(true);
	});

	it("replaces an existing document (term disappears entirely from the doc)", () => {
		const index = buildWordIndex([
			{ path: "a.ts", content: "export function alpha() {}" },
		]);
		expect(index.postings.has("alpha")).toBe(true);

		updateWordIndexDocument(index, {
			path: "a.ts",
			content: "export function omega() {}",
		});

		// alpha is gone entirely (only doc that had it), omega is now present.
		expect(index.postings.has("alpha")).toBe(false);
		expect(
			wordIndexPostingHits(index, "omega").some((h) => h.file === "a.ts"),
		).toBe(true);
		expect(index.docCount).toBe(1);
	});

	it("a doc shrinking drops the tokens that no longer appear, keeps the rest", () => {
		const index = buildWordIndex([
			{
				path: "a.ts",
				content: "export function alpha() {}\nexport function beta() {}",
			},
		]);
		expect(index.postings.has("alpha")).toBe(true);
		expect(index.postings.has("beta")).toBe(true);

		updateWordIndexDocument(index, {
			path: "a.ts",
			content: "export function alpha() {}",
		});

		expect(index.postings.has("alpha")).toBe(true);
		expect(index.postings.has("beta")).toBe(false);
		expect(index.docLengths.get("a.ts")).toBeLessThan(
			"export function alpha() {}\nexport function beta() {}".length,
		);
	});

	it("a doc growing adds new tokens without disturbing unrelated docs", () => {
		const index = buildWordIndex([
			{ path: "a.ts", content: "export function alpha() {}" },
			{ path: "z.ts", content: "export function zeta() {}" },
		]);
		const zForwardBefore = index.forward?.get("z.ts");

		updateWordIndexDocument(index, {
			path: "a.ts",
			content: "export function alpha() {}\nexport function alphaHelper() {}",
		});

		expect(wordIndexPostingHits(index, "alphahelper")[0]?.file).toBe("a.ts");
		// z.ts's forward entry is a completely untouched reference — verified via
		// identity, not just value equality, since an unrelated doc's edit must
		// never even re-derive its own forward entry.
		expect(index.forward?.get("z.ts")).toBe(zForwardBefore);
	});

	it("removes a document entirely", () => {
		const index = buildWordIndex([
			{ path: "a.ts", content: "export function alpha() {}" },
			{ path: "b.ts", content: "export function beta() {}" },
		]);
		const ok = removeWordIndexDocument(index, "a.ts");
		expect(ok).toBe(true);
		expect(index.docCount).toBe(1);
		expect(index.forward?.has("a.ts")).toBe(false);
		expect(index.postings.has("alpha")).toBe(false);
		expect(
			wordIndexPostingHits(index, "beta").some((h) => h.file === "b.ts"),
		).toBe(true);
	});

	it("an unchanged doc is untouched by an unrelated update (reference identity)", () => {
		const index = buildWordIndex([
			{ path: "a.ts", content: "export function alpha() {}" },
			{ path: "unrelated.ts", content: "export function untouched() {}" },
		]);
		const postingsRefBefore = index.postings.get("untouched");
		const forwardRefBefore = index.forward?.get("unrelated.ts");

		updateWordIndexDocument(index, {
			path: "a.ts",
			content: "export function alphaRenamed() {}",
		});

		expect(index.postings.get("untouched")).toBe(postingsRefBefore);
		expect(index.forward?.get("unrelated.ts")).toBe(forwardRefBefore);
	});

	it("refuses to mutate an index with no forward index (pre-phase-2 shape)", () => {
		const index = buildWordIndex([
			{ path: "a.ts", content: "export function alpha() {}" },
		]);
		// Simulate a deserialized pre-phase-2 snapshot: no forward index.
		delete index.forward;

		const before = JSON.stringify([...index.postings.entries()]);
		const ok = updateWordIndexDocument(index, {
			path: "b.ts",
			content: "export function beta() {}",
		});
		expect(ok).toBe(false);
		expect(JSON.stringify([...index.postings.entries()])).toBe(before);
		expect(removeWordIndexDocument(index, "a.ts")).toBe(false);
	});

	it("round-trips the forward index through serialize/deserialize", () => {
		const index = buildWordIndex([
			{ path: "a.ts", content: "export function alpha() {}" },
			{ path: "b.ts", content: "export function beta() {}" },
		]);
		const restored = deserializeWordIndex(serializeWordIndex(index));
		expect(restored?.forward).toBeDefined();
		expect(restored?.forward?.get("a.ts")?.get("alpha")).toBe(1);

		// The restored index supports further incremental updates.
		const ok = updateWordIndexDocument(restored!, {
			path: "a.ts",
			content: "export function alphaRenamed() {}",
		});
		expect(ok).toBe(true);
	});

	it("deserializing a pre-phase-2 (forward-less) snapshot yields forward: undefined", () => {
		const index = buildWordIndex([
			{ path: "a.ts", content: "export function alpha() {}" },
		]);
		const serialized = serializeWordIndex(index);
		delete serialized.forward; // simulate an old persisted shape
		const restored = deserializeWordIndex(serialized);
		expect(restored).not.toBeNull();
		expect(restored?.forward).toBeUndefined();
		// Fallback contract: caller must rebuild rather than incrementally update.
		expect(
			updateWordIndexDocument(restored!, { path: "b.ts", content: "x" }),
		).toBe(false);
	});
});

// --- THE acceptance test: equivalence with a from-scratch rebuild -------------

// Small deterministic PRNG (mulberry32) so failures are reproducible without
// depending on the test runner's Math.random seeding.
function mulberry32(seed: number): () => number {
	let a = seed;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function pick<T>(rng: () => number, arr: T[]): T {
	return arr[Math.floor(rng() * arr.length)];
}

const WORDS = [
	"alpha",
	"beta",
	"gamma",
	"delta",
	"epsilon",
	"zeta",
	"eta",
	"theta",
	"handler",
	"controller",
	"service",
	"client",
	"manager",
	"builder",
	"parse",
	"resolve",
	"validate",
	"compute",
	"render",
	"dispatch",
];

function randomContent(rng: () => number, lineCount: number): string {
	const lines: string[] = [];
	for (let i = 0; i < lineCount; i += 1) {
		const wordCount = 1 + Math.floor(rng() * 4);
		const words: string[] = [];
		for (let w = 0; w < wordCount; w += 1) words.push(pick(rng, WORDS));
		lines.push(`function ${words.join("")}Fn() { return ${words[0]}; }`);
	}
	return lines.join("\n");
}

/** Deep-normalize a WordIndex into a comparable plain structure (Maps sorted, Sets->arrays). */
function normalize(index: WordIndex) {
	const postings = [...index.postings.keys()]
		.map((token) => [
			token,
			wordIndexPostingHits(index, token).sort(
				(a, b) => a.file.localeCompare(b.file) || a.line - b.line,
			),
		])
		.sort((a, b) => (a[0] as string).localeCompare(b[0] as string));
	const docLengths = [...index.docLengths.entries()].sort((a, b) =>
		a[0].localeCompare(b[0]),
	);
	const forward = index.forward
		? [...index.forward.entries()]
				.map(([file, counts]) => [
					file,
					[...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])),
				])
				.sort((a, b) => (a[0] as string).localeCompare(b[0] as string))
		: undefined;
	return {
		postings,
		docLengths,
		totalTokens: index.totalTokens,
		docCount: index.docCount,
		forward,
	};
}

describe("equivalence property: k incremental edits == from-scratch rebuild (#348 phase 2)", () => {
	it("matches index state and query rankings after a mixed batch of edits", () => {
		const rng = mulberry32(42);

		// Seed corpus.
		const corpus = new Map<string, string>();
		for (let i = 0; i < 8; i += 1) {
			corpus.set(`src/file${i}.ts`, randomContent(rng, 5 + (i % 4)));
		}

		let index = buildWordIndex(
			[...corpus.entries()].map(([path, content]) => ({ path, content })),
		);

		// Capture references to untouched docs to verify later.
		const untouchedPath = "src/file7.ts";
		const untouchedForwardBefore = index.forward?.get(untouchedPath);

		const k = 25;
		const ops: string[] = [];
		for (let step = 0; step < k; step += 1) {
			const roll = rng();
			if (roll < 0.35 && corpus.size > 1) {
				// Edit an existing doc (may shrink or grow).
				const keys = [...corpus.keys()].filter((p) => p !== untouchedPath);
				const path = pick(rng, keys);
				const lineCount = 1 + Math.floor(rng() * 8);
				const content = randomContent(rng, lineCount);
				corpus.set(path, content);
				updateWordIndexDocument(index, { path, content });
				ops.push(`edit ${path}`);
			} else if (roll < 0.55 && corpus.size > 2) {
				// Remove a doc.
				const keys = [...corpus.keys()].filter((p) => p !== untouchedPath);
				const path = pick(rng, keys);
				corpus.delete(path);
				removeWordIndexDocument(index, path);
				ops.push(`remove ${path}`);
			} else {
				// Add a brand new doc.
				const path = `src/new-${step}.ts`;
				const content = randomContent(rng, 1 + Math.floor(rng() * 6));
				corpus.set(path, content);
				updateWordIndexDocument(index, { path, content });
				ops.push(`add ${path}`);
			}
		}

		// Unchanged doc untouched by unrelated edits — verified via reference
		// identity (the forward-index Map for this file was never re-derived).
		expect(index.forward?.get(untouchedPath)).toBe(untouchedForwardBefore);

		const rebuilt = buildWordIndex(
			[...corpus.entries()].map(([path, content]) => ({ path, content })),
		);

		expect(normalize(index)).toEqual(normalize(rebuilt));

		// Query rankings must match too, for several queries.
		const queries = [
			"alpha",
			"handler controller",
			"parse resolve validate",
			"nonexistentTermXYZ",
			"builder",
		];
		for (const query of queries) {
			const incrementalResults = searchWordIndex(index, query, { limit: 50 });
			const rebuiltResults = searchWordIndex(rebuilt, query, { limit: 50 });
			expect(incrementalResults).toEqual(rebuiltResults);
		}

		expect(ops.length).toBe(k);
	});

	it("matches for a doc shrinking to empty and a doc growing from empty", () => {
		const initial = buildWordIndex([
			{
				path: "shrink.ts",
				content: "function alphaBeta() {}\nfunction gammaDelta() {}",
			},
			{ path: "grow.ts", content: "" },
			{ path: "stable.ts", content: "function stableFn() {}" },
		]);

		updateWordIndexDocument(initial, { path: "shrink.ts", content: "" });
		updateWordIndexDocument(initial, {
			path: "grow.ts",
			content: "function newlyAddedFn() { return epsilonZeta; }",
		});

		const rebuilt = buildWordIndex([
			{ path: "shrink.ts", content: "" },
			{
				path: "grow.ts",
				content: "function newlyAddedFn() { return epsilonZeta; }",
			},
			{ path: "stable.ts", content: "function stableFn() {}" },
		]);

		expect(normalize(initial)).toEqual(normalize(rebuilt));
	});
});

// --- Cooperative removal staging: work unit is the token, not the posting ------

describe("cooperative removal staging counts the clock per token (#2067)", () => {
	/**
	 * The cooperative staging path used to check its deadline per posting
	 * ELEMENT, which cost one `performance.now()` per entry and made the
	 * primitive unusable from the per-edit seam. Staging now filters each
	 * token's postings with the packed `withoutFile` primitive and checks the
	 * deadline BETWEEN tokens.
	 *
	 * This guard counts clock reads rather than measuring wall-clock time, so
	 * it is invariant to machine speed and event-loop load. Restoring the
	 * per-element form reds it: the fixture walks two orders of magnitude more
	 * posting elements than it has tokens or lines.
	 */
	const TOKENS = Array.from({ length: 12 }, (_, i) => `stagingtoken${i}`);
	const PEER_COUNT = 300;
	const PEER_LINES = 60;

	function highDocumentFrequencyIndex(target: string): WordIndex {
		const line = TOKENS.join(" ");
		return buildWordIndex([
			{ path: target, content: Array(5).fill(line).join("\n") },
			...Array.from({ length: PEER_COUNT }, (_, peer) => ({
				path: `C:\Repo\Src\Peer${peer}.ts`,
				content: Array(PEER_LINES).fill(line).join("\n"),
			})),
		]);
	}

	/** Posting entries the staging pass has to walk for `target`. */
	function postingElementsToWalk(index: WordIndex, target: string): number {
		let total = 0;
		for (const token of index.forward?.get(target)?.keys() ?? []) {
			total += index.postings.get(token)?.length ?? 0;
		}
		return total;
	}

	it("stages a removal with clock reads bounded by tokens, not postings", async () => {
		const target = "C:\Repo\Src\Target.ts";
		const index = highDocumentFrequencyIndex(target);
		const elements = postingElementsToWalk(index, target);
		// Not vacuous: the fixture really does walk a large posting population.
		expect(elements).toBeGreaterThan(100_000);

		const clockReads = await countClockReads(() =>
			removeWordIndexDocumentAsync(index, target),
		);

		// One read per token plus a handful of yields, never one per element.
		expect(clockReads).toBeLessThan(2_000);
		expect(index.forward?.has(target)).toBe(false);
		expect(
			wordIndexPostingHits(index, TOKENS[0]).some((hit) => hit.file === target),
		).toBe(false);
	});

	it("keeps the per-edit seam's replacement on the same bound", async () => {
		const target = "C:\Repo\Src\Target.ts";
		const index = highDocumentFrequencyIndex(target);
		expect(postingElementsToWalk(index, target)).toBeGreaterThan(100_000);

		const clockReads = await countClockReads(() =>
			updateWordIndexDocumentForEdit(index, {
				path: target,
				content: "replacementtoken",
			}),
		);

		expect(clockReads).toBeLessThan(2_000);
		expect(
			wordIndexPostingHits(index, "replacementtoken").some(
				(hit) => hit.file === target,
			),
		).toBe(true);
	});
});
