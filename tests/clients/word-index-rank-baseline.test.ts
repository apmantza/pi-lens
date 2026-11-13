/**
 * #2067 criterion 5 / #2069 acceptance criterion 3 — `searchWordIndex` output is unchanged by the
 * packed posting store.
 *
 * This is a characterization test, not a red-first regression test: the
 * baseline in `tests/support/word-index-rank-baseline.json` was minted by
 * running the corpus and query set below against the BOXED representation
 * (`origin/master` at e0ef5a3f), before the packing landed. It passes on both
 * representations by construction — that is the claim it exists to make. What
 * it guards from here on is any later change to grouping, document frequency,
 * or path resolution inside the ranking loop.
 *
 * The recorded shape is `[file, score, hits, lines]` per result: every field
 * #2069 names. Scores are rounded to six decimals so the fixture does not pin
 * float noise that has nothing to do with the representation.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	buildWordIndex,
	searchWordIndex,
	updateWordIndexDocument,
	updateWordIndexDocumentForEdit,
} from "../../clients/word-index.js";
import {
	expectPlantedStaleRow,
	rowsWithoutLiveMember,
} from "../support/baseline-staleness.js";

const WORDS = [
	"renderWidget",
	"parseConfig",
	"HTTPServerPool",
	"retry_2_times",
	"loadIndexShard",
	"normalizePathKey",
	"collectSourceFiles",
	"emitDiagnostics",
	"buildReviewGraph",
	"schedulePersist",
	"resolveImports",
	"walkDirectory",
];
const DIRS = ["src", "tests", "docs", "vendor"];
const EXTS = [".ts", ".go", ".md", ".py"];

/** Deterministic pseudo-random source; the fixture pins its exact output. */
function makeRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 0x1_0000_0000;
	};
}

function makeCorpus() {
	const random = makeRandom(2069);
	return Array.from({ length: 60 }, (_, doc) => ({
		path: `${DIRS[doc % DIRS.length]}/module${doc % 7}/file${doc}${EXTS[doc % EXTS.length]}`,
		content: Array.from({ length: 25 }, (_, line) => {
			const w = Array.from(
				{ length: 3 },
				() => WORDS[Math.floor(random() * WORDS.length)],
			);
			return `const ${w[0]}${line} = ${w[1]}(${w[2]});`;
		}).join("\n"),
	}));
}

/**
 * Twenty queries spanning single terms, multi-term queries, every inline filter
 * prefix (`lang:`, `file:`, `ext:`) with and without negation, sub-token splits,
 * and one query that matches nothing.
 */
const QUERIES = [
	"renderWidget",
	"parse config",
	"HTTPServerPool",
	"retry_2_times",
	"loadIndexShard emitDiagnostics",
	"normalizePathKey",
	"collectSourceFiles lang:go",
	"emitDiagnostics ext:md",
	"buildReviewGraph file:src/",
	"schedulePersist -file:tests",
	"resolveImports lang:python",
	"walkDirectory file:module3",
	"widget",
	"pool server",
	"shard index load",
	"graph review build",
	"persist schedule",
	"imports resolve -file:vendor",
	"directory walk ext:ts",
	"nosuchtokenanywhere",
];

type RecordedResult = [string, number, number, number[]];
type RecordedQuery = [string, RecordedResult[]];

const baselinePath = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"support",
	"word-index-rank-baseline.json",
);

function record(index: ReturnType<typeof buildWordIndex>): RecordedQuery[] {
	return QUERIES.map((query) => [
		query,
		searchWordIndex(index, query, { limit: 5 }).map(
			(result): RecordedResult => [
				result.file,
				Number(result.score.toFixed(6)),
				result.hits,
				result.lines,
			],
		),
	]);
}

/**
 * The baseline's two-sided comparison: a recorded query row the run does not
 * reproduce exactly (the row-without-producer direction), and a run row the
 * baseline does not record. A row is the query with its whole ranked list.
 */
function rankDrift(
	recorded: readonly RecordedQuery[],
	actual: readonly RecordedQuery[],
): string[] {
	const rows = (queries: readonly RecordedQuery[]) =>
		new Set(queries.map((row) => JSON.stringify(row)));
	return [
		...rowsWithoutLiveMember(rows(recorded), rows(actual)).map(
			(row) => `recorded row the run does not reproduce: ${row}`,
		),
		...rowsWithoutLiveMember(rows(actual), rows(recorded)).map(
			(row) => `run row the baseline does not record: ${row}`,
		),
	];
}

function readBaseline(): RecordedQuery[] {
	const baseline = JSON.parse(
		fs.readFileSync(baselinePath, "utf-8"),
	) as RecordedQuery[];
	// A fixture that lost its rows would let this pass while asserting
	// nothing, and an empty result list per query would do the same.
	expect(baseline).toHaveLength(QUERIES.length);
	expect(baseline.filter(([, results]) => results.length > 0).length).toBe(
		QUERIES.length - 1,
	);
	return baseline;
}

describe("word-index ranking is unchanged by replacement and packing (#2067/#2069)", () => {
	it("reproduces the boxed representation's output for a fixed 20-query set", () => {
		const baseline = readBaseline();
		const corpus = makeCorpus();
		const index = buildWordIndex(corpus);
		const actual = record(index);

		expect(rankDrift(baseline, actual)).toEqual([]);
		expect(
			updateWordIndexDocument(index, {
				path: corpus[0].path,
				content: corpus[0].content,
			}),
		).toBe(true);
		expect(record(index)).toEqual(actual);
	});

	it("reds a planted baseline row the ranking run never produces (#5072)", () => {
		// The row-without-producer direction: a recorded query the run never
		// ran, judged by the comparison the case above runs against a real build.
		const plantedQuery = "5072-ghost-query";
		const actual = record(buildWordIndex(makeCorpus()));
		expectPlantedStaleRow({
			baseline: "tests/support/word-index-rank-baseline.json",
			rowKey: plantedQuery,
			verdict: rankDrift(
				[
					...readBaseline(),
					[plantedQuery, [["src/module0/file0.ts", 1, 1, [0]]]],
				],
				actual,
			),
		});
	});

	it("reproduces it after every document goes through the per-edit seam (#2067 criterion 5)", async () => {
		const baseline = readBaseline();
		const corpus = makeCorpus();
		const index = buildWordIndex(corpus);

		// The whole corpus through the primitive the cascade seam now calls, so
		// the claim covers the cooperative removal staging and the queued commit,
		// not just one document's worth of them.
		for (const doc of corpus) {
			expect(
				await updateWordIndexDocumentForEdit(index, {
					path: doc.path,
					content: doc.content,
				}),
			).toBe(true);
		}

		expect(record(index)).toEqual(baseline);
	});
});
