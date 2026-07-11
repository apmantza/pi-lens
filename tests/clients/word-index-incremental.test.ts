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
	searchWordIndex,
	serializeWordIndex,
	updateWordIndexDocument,
	type WordIndex,
} from "../../clients/word-index.js";

// --- Basic primitive behavior --------------------------------------------------

describe("updateWordIndexDocument / removeWordIndexDocument", () => {
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
		expect(index.postings.get("beta")?.some((h) => h.file === "b.ts")).toBe(
			true,
		);
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
		expect(index.postings.get("omega")?.some((h) => h.file === "a.ts")).toBe(
			true,
		);
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
			content:
				"export function alpha() {}\nexport function alphaHelper() {}",
		});

		expect(index.postings.get("alphahelper")?.[0]?.file).toBe("a.ts");
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
		expect(index.postings.get("beta")?.some((h) => h.file === "b.ts")).toBe(
			true,
		);
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
		expect(updateWordIndexDocument(restored!, { path: "b.ts", content: "x" })).toBe(
			false,
		);
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
	"alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta",
	"handler", "controller", "service", "client", "manager", "builder",
	"parse", "resolve", "validate", "compute", "render", "dispatch",
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
	const postings = [...index.postings.entries()]
		.map(([token, hits]) => [
			token,
			[...hits].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
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
			{ path: "shrink.ts", content: "function alphaBeta() {}\nfunction gammaDelta() {}" },
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
			{ path: "grow.ts", content: "function newlyAddedFn() { return epsilonZeta; }" },
			{ path: "stable.ts", content: "function stableFn() {}" },
		]);

		expect(normalize(initial)).toEqual(normalize(rebuilt));
	});
});
