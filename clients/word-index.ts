/**
 * Identifier-aware inverted word index + BM25 ranking.
 *
 * The lexical half of the "codebase mental model + hybrid ranking" ask (#162):
 * a deterministic, zero-dep index over source identifiers that answers
 * "which files are most relevant to <query>" with BM25 relevance plus a small
 * set of priors (demote tests/vendor and doc files) and an optional graph
 * centrality boost (importedBy count from the reverse-dependency index). It
 * complements LSP/symbol navigation rather than duplicating the host's grep:
 * grep finds raw substrings; this ranks files by identifier relevance.
 *
 * Built from file contents during the session scan, persisted in the project
 * snapshot (serialize/deserialize below), and queried via an MCP tool. No
 * embeddings, no native deps, no daemon — pure in-process TypeScript.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	createDeadline,
	forEachCooperatively,
	yieldIfOverBudget,
} from "./cooperative-budget.js";
import { incrementDegradationCount } from "./degradation-ledger.js";
import { KIND_EXTENSIONS, type FileKind } from "./file-kinds.js";
import { PathKeyedMap } from "./path-keyed-map.js";
import { isAtOrAboveHomeDir, normalizeEphemeralMapKey } from "./path-utils.js";
import { createSingleFlight, type SingleFlight } from "./single-flight.js";
import {
	createDebounceScheduler,
	type DebounceScheduler,
} from "./persist-debounce.js";
import { getWordIndexMaxFilesDerived } from "./project-scale.js";
import {
	compactPostingsIntoArena,
	compactPostingsIntoArenaCooperatively,
	countPostingBackingStores,
	countPostingEntries,
	estimateWordIndexStoreBytes,
	WordForwardEntry,
	WordIndexFileTable,
	WordPostingList,
} from "./word-index-store.js";
import { logWordIndex } from "./word-index-logger.js";

/**
 * One posting, decoded. This is NOT the storage shape (#2069): postings live
 * packed in a {@link WordPostingList}, and this object is materialized only
 * when a caller asks for a decoded view via {@link wordIndexPostingHits}.
 */
export interface WordHit {
	file: string;
	line: number;
}

/**
 * The single normalizer every word-index path key folds through (#1025). The
 * CHEAP form — slash-fold + win32-lowercase, NO filesystem I/O — because the
 * index is a hot, single-process, in-memory structure whose keys this process
 * produces itself (`collectSourceFilesAsync`'s walk, `path.resolve` at the
 * per-edit seams). `normalizeMapKey`'s `realpathSync` per call would be wrong on
 * the BM25 path. Applied at BOTH the build seam and the per-edit update seam so
 * a file's on-disk casing (walk) and its tool-input casing (edit) can no longer
 * diverge into a duplicate doc entry with stale postings (the #1025 item #2
 * bug). Kept as a named alias so every seam is grep-visible and provably shares
 * ONE normalizer with the {@link PathKeyedMap}s below.
 */
export const wordIndexKey = normalizeEphemeralMapKey;

export interface WordIndex {
	/**
	 * token → packed postings (one entry per (file,line) the token appears on).
	 * Entries are `[fileId, line]` pairs in an `Int32Array`, where `fileId`
	 * indexes {@link fileTable} (#2069). Use {@link wordIndexPostingHits} for a
	 * decoded `{ file, line }` view.
	 */
	postings: Map<string, WordPostingList>;
	/** Canonical file key ↔ dense file id ↔ display path, shared by every posting. */
	fileTable: WordIndexFileTable;
	/**
	 * file → number of indexed tokens (document length, for BM25 normalization).
	 * Path-keyed via {@link wordIndexKey} ({@link PathKeyedMap}) so build-form and
	 * edit-form keys for the same file collapse to one entry (#1025).
	 */
	docLengths: PathKeyedMap<number>;
	totalTokens: number;
	docCount: number;
	/** True when source collection hit its file cap, so searches may be incomplete. */
	truncated?: boolean;
	/**
	 * Forward index (#348 phase 2): file → (token → distinct-line count for that
	 * token in that file). Mirrors exactly what the postings list holds for this
	 * file, so a single-document replace is mechanical — subtract this file's own
	 * contribution from `postings`/`docLengths`/`totalTokens`/`docCount` via the
	 * forward entry, then add the new one, instead of re-walking every other
	 * file's postings to find what to remove. Absent (`undefined`) on indexes
	 * built by phase 1 or deserialized from a pre-phase-2 snapshot — callers that
	 * need incremental updates must treat a missing forward index as "no
	 * incremental primitive available" and fall back to a full rebuild.
	 */
	forward?: PathKeyedMap<WordForwardEntry>;
	/** File mtimes captured when each document was tokenized (#958). */
	fileMtimes: PathKeyedMap<number>;
	/**
	 * File byte sizes captured when each document was tokenized (#1105). The
	 * incremental refresh gate is mtime-first (cheap, from the stat it already
	 * runs) but mtime alone is a stale signal: a content change that PRESERVES
	 * mtime (git checkout timestamp restoration, a formatter that preserves
	 * mtime, a same-second/same-clock write) would leave the old postings serving
	 * stale identifiers to symbol_search. Size is the free second axis of the
	 * review-graph gold-standard `size:mtimeMs` signature (builder.ts's
	 * `sourceSignatureEntry`) — the walk already reads `stat.size` to enforce the
	 * byte cap, so comparing it costs nothing yet catches every content change
	 * that alters length. The residual (same mtime AND same byte length, changed
	 * content) matches review-graph's own accepted residual; closing it would
	 * require reading+hashing every REUSED file on every refresh (the blind skip
	 * path), which is exactly the unconditional hot-path hashing the event-loop
	 * discipline forbids.
	 */
	fileSizes: PathKeyedMap<number>;
	/** Bounded scalar aggregate for the current persist window. */
	replacementStats?: { count: number; totalMs: number; maxMs: number };
	/** Files whose wire contribution changed since the last serialized snapshot. */
	dirtyFiles?: Set<string>;
	/**
	 * Running over-estimate of distinct posting backing stores since the last
	 * compaction (#2117). Incremental edits bump it by one per fresh private
	 * store they allocate; a compaction resets it to the exact store count. It
	 * is an O(1) gate for the churn-recompaction threshold, so the per-edit hot
	 * path never rebuilds a `Set` over the whole vocabulary. Over-counting only
	 * recompacts marginally early, which is safe; it never under-counts, so it
	 * never misses the threshold.
	 */
	postingStoreCount?: number;
	/**
	 * At-most-one-in-flight registry for this index's threshold-triggered arena
	 * recompaction (#2117). Uses the repo's canonical `createSingleFlight`
	 * primitive (#1753) rather than a hand-rolled latch, so a burst of edits
	 * joins the running recompaction instead of stacking duplicates. Held on the
	 * index so its lifetime is the index's and it adds no module-level state.
	 */
	recompactFlight?: SingleFlight<void>;
}

export interface RankedFile {
	file: string;
	score: number;
	/** Number of query-token occurrences in the file (summed term frequency). */
	hits: number;
	/** Distinct lines where a query token occurred, ascending. */
	lines: number[];
}

export interface RankOptions {
	/** Demote files under test/vendor/example paths (default true). */
	demoteTestVendor?: boolean;
	/** Demote documentation/data files so they can't starve a real source match (default true). */
	demoteDocs?: boolean;
	/** file → graph centrality (e.g. importedBy count); boosts well-connected files. */
	centrality?: Map<string, number>;
	/** Max results to return (default 20). */
	limit?: number;
	/**
	 * Optional pre-ranking scope predicate (#771, e.g. symbol_search's `paths`/
	 * `lang` params) — a file failing this check is dropped BEFORE its score
	 * entry is created, so a surviving file's score/priors/centrality boost are
	 * computed identically to an unfiltered run; only which files make it into
	 * the results list changes. Omitted (default) behaves exactly as before.
	 */
	fileFilter?: (file: string) => boolean;
}

// Common language keywords / boilerplate — indexing them adds noise and bloats
// postings without improving relevance. Kept deliberately small and
// language-agnostic.
const STOPWORDS = new Set([
	"the",
	"and",
	"for",
	"let",
	"var",
	"const",
	"function",
	"return",
	"if",
	"else",
	"import",
	"export",
	"from",
	"class",
	"interface",
	"type",
	"enum",
	"new",
	"this",
	"self",
	"void",
	"null",
	"true",
	"false",
	"async",
	"await",
	"public",
	"private",
	"protected",
	"static",
	"def",
	"fn",
	"func",
	"struct",
	"impl",
	"pub",
	"use",
	"mod",
	"in",
	"of",
	"as",
	"is",
	"not",
	"with",
]);

const TEST_VENDOR_RE =
	/(?:(^|[\\/])(?:tests?|__tests__|spec|specs|__mocks__|vendor|node_modules|examples?|fixtures?|\.git|dist|build|coverage)([\\/]|$))|(?:\.(?:test|spec)\.[a-z]+$)/i;

const DOC_FILE_RE =
	/\.(?:md|mdx|markdown|json|json5|jsonc|txt|rst|lock|ya?ml|toml|csv)$/i;

const TEST_VENDOR_PENALTY = 0.3;
const DOC_FILE_PENALTY = 0.5;
const BM25_K1 = 1.2;
const BM25_B = 0.75;

function isTestOrVendor(file: string): boolean {
	return TEST_VENDOR_RE.test(file);
}

function isDocFile(file: string): boolean {
	return DOC_FILE_RE.test(file);
}

/**
 * Split an identifier into lowercased sub-tokens across camelCase, PascalCase,
 * snake_case, kebab-case, dotted, and digit boundaries — and keep the whole
 * lowercased identifier too. `getUserByID` → [getuserbyid, get, user, by, id];
 * `MAX_RETRY_2` → [max_retry_2, max, retry, 2] (whole kept, plus parts).
 */
export function splitIdentifier(identifier: string): string[] {
	const parts = new Set<string>();
	const whole = identifier.toLowerCase();
	if (whole.length >= 2 && !STOPWORDS.has(whole)) parts.add(whole);
	for (const chunk of identifier.split(/[^A-Za-z0-9]+/)) {
		if (!chunk) continue;
		const spaced = chunk
			.replace(/([a-z0-9])([A-Z])/g, "$1 $2") // camelCase → camel Case
			.replace(/[A-Z](?=[A-Z][a-z])/g, "$& ") // HTTPServer → HTTP Server (linear; lookahead avoids super-linear backtracking, S5852)
			.replace(/([A-Za-z])([0-9])/g, "$1 $2") // retry2 → retry 2
			.replace(/([0-9])([A-Za-z])/g, "$1 $2"); // 2fa → 2 fa
		for (const sub of spaced.split(/\s+/)) {
			const token = sub.toLowerCase();
			if (token.length >= 2 && !STOPWORDS.has(token)) parts.add(token);
		}
	}
	return [...parts];
}

/** Extract identifier-like tokens from a line and split each into sub-tokens. */
export function tokenizeLine(line: string): string[] {
	const tokens: string[] = [];
	const matches = line.match(/[A-Za-z_$][A-Za-z0-9_$]*/g);
	if (!matches) return tokens;
	for (const match of matches) {
		for (const token of splitIdentifier(match)) tokens.push(token);
	}
	return tokens;
}

/**
 * Build the inverted index from file contents. One posting per (token, file,
 * line) — a token repeated on the same line counts once — so term frequency is
 * "lines mentioning the token", a stable signal that doesn't over-weight a line
 * that repeats an identifier. Document length is the total indexed token count.
 */
type WordIndexInputDocument = {
	path: string;
	content: string;
	mtimeMs?: number;
	size?: number;
};

type WordIndexInputDocuments = WordIndexInputDocument[] & {
	truncated?: boolean;
};

const WORD_INDEX_BUILD_YIELD_BUDGET_MS = 8;
/**
 * A line at or above this length is treated as a yield checkpoint on its own.
 * The per-50-lines cadence is a proxy for work that only holds on hand-written
 * source: a minified/bundled single-line file up to {@link WORD_INDEX_MAX_BYTES}
 * that the source filter did not exclude would otherwise get ZERO in-document
 * yields — one unbroken tokenize+push burst far above the budget (#1197 review
 * finding 4). Checking the clock after any long line makes the cooperativeness
 * claim true per BYTE, not just per line count.
 */
const WORD_INDEX_LONG_LINE_YIELD_CHARS = 4096;

/**
 * Shared cooperative time-slicer for every bulk word-index path (#1197).
 *
 * Time-based, not count-based: "yield every N items" is only a bound when the
 * per-item cost is bounded too, and the incremental refresh's per-document cost
 * grows with the corpus (each replacement filters shared posting arrays). The
 * #1197 outage was exactly that shape — 239 stale documents held pi's event loop
 * for seconds between two "every 100 files" checkpoints. Callers combine this
 * The shared deadline is checked at every bounded work unit so abort latency
 * and occupancy are governed by the same monotonic budget.
 */
function createEmptyWordIndex(truncated: boolean): WordIndex {
	return {
		postings: new Map<string, WordPostingList>(),
		fileTable: new WordIndexFileTable(),
		docLengths: new PathKeyedMap<number>(wordIndexKey),
		totalTokens: 0,
		docCount: 0,
		truncated,
		forward: new PathKeyedMap<WordForwardEntry>(wordIndexKey),
		fileMtimes: new PathKeyedMap<number>(wordIndexKey),
		fileSizes: new PathKeyedMap<number>(wordIndexKey),
		replacementStats: { count: 0, totalMs: 0, maxMs: 0 },
		dirtyFiles: new Set<string>(),
		postingStoreCount: 0,
		recompactFlight: createSingleFlight<void>(),
	};
}

export function countWordIndexPostingEntries(index: WordIndex): number {
	return countPostingEntries(index);
}

/**
 * Estimated resident bytes of the index's two packed stores (#2069).
 * Reported on the `full_rebuild`, `incremental_refresh`, and `cold_build`
 * word-index log records and on the `memory_sample` word-index subsystem, so
 * a heap census can be reconciled against the log without taking a snapshot —
 * the gap that let #1999 under-count this subsystem by a factor of sixty.
 */
export function estimateWordIndexResidentBytes(index: WordIndex): number {
	return estimateWordIndexStoreBytes(index);
}

/**
 * Record a posting whose file id the file table cannot resolve (#2069).
 *
 * Unreachable by construction: {@link WordIndexFileTable.release} only runs
 * after the forward index has enumerated and removed every posting naming that
 * id. If it fires, that invariant broke, and the visible symptom is a query
 * returning FEWER results with nothing to distinguish it from a smaller match
 * set — the clean-versus-errored ambiguity AGENTS.md catalogs as shape 10.
 *
 * `incrementDegradationCount` rather than `recordDegradationOnce` because
 * ranking is a hot loop: the tally stays exact for every occurrence while only
 * the first per (kind, orphaned id) writes a durable row. Subject is the id
 * itself, so aggregation keeps the discriminating identity.
 */
function recordOrphanWordIndexFileId(
	fileId: number,
	token: string,
	seam: "search" | "decode",
): void {
	incrementDegradationCount({
		kind: "word-index-orphan-file-id",
		subject: `fileId:${fileId}`,
		reason: `${seam} dropped a posting for token "${token}": the file table has no path for this id`,
	});
}

/**
 * Decode one token’s postings into `{ file, line }` objects. Allocates, so it
 * is for callers that genuinely need the display form (tests, diagnostics) —
 * never for the hot ranking loop, which reads the packed lanes directly.
 */
export function wordIndexPostingHits(
	index: WordIndex,
	token: string,
): WordHit[] {
	const list = index.postings.get(token);
	if (!list) return [];
	const hits: WordHit[] = [];
	for (let i = 0; i < list.length; i += 1) {
		const fileId = list.fileIdAt(i);
		const file = index.fileTable.pathFor(fileId);
		if (file === undefined) {
			recordOrphanWordIndexFileId(fileId, token, "decode");
			continue;
		}
		hits.push({ file, line: list.lineAt(i) });
	}
	return hits;
}

/**
 * Settle a freshly built index's posting store into its compact resident form
 * (#2069): re-home every list into one shared arena, sized from the live entry
 * counts. That both releases the doubling growth slack a build leaves behind
 * and stops the long tail of rare tokens paying for an `ArrayBuffer` header
 * each.
 */
function compactWordIndexPostings(index: WordIndex): void {
	compactPostingsIntoArena(index.postings);
	index.postingStoreCount = countPostingBackingStores(index.postings);
}

/** Bump the running distinct-backing-store tally by `count` (#2117). */
function notePostingStoresAllocated(index: WordIndex, count: number): void {
	index.postingStoreCount = (index.postingStoreCount ?? 0) + count;
}

/**
 * Floor for the recompaction gate: below this many backing stores the arena is
 * never repacked, so a small index never pays an O(vocab) walk it cannot amortize
 * (#2117). This is also the whole gate for indexes whose vocabulary is under
 * `WORD_INDEX_RECOMPACT_STORE_FLOOR / WORD_INDEX_RECOMPACT_STORE_FRACTION`
 * tokens, keeping the pre-#2246 behaviour for small corpora bit-identical.
 */
const WORD_INDEX_RECOMPACT_STORE_FLOOR = 64;

/**
 * Recompaction gate as a share of the live vocabulary (#2246). The flat 64-store
 * threshold #2117 shipped was crossed by every single edit: one document
 * replacement raises `postingStoreCount` by roughly the edited document's
 * distinct-token count (hundreds), so the whole O(vocab) arena was rebuilt after
 * every edit. Gating on a fraction of `postings.size` instead lets fragmentation
 * accumulate proportionally to the index, so recompaction fires once per many
 * edits rather than once per edit.
 *
 * Memory ceiling: the store count can reach a tenth of the vocabulary in private
 * stores before a repack, each carrying a fixed header plus growth slack. #2117
 * measured the fully-churned ceiling (every token private, store count =
 * vocabulary) at +22% resident. The cost does not scale with the store count
 * alone, because the tokens that churn most are also the ones carrying the
 * longest posting lists. PR #2246's adversarial hot-token probe measured this
 * gate at +13.7% resident at rest and +19.9% peak over base — inside the +22%
 * #2117 accepted, but not by the wide margin a naive store-count ratio would
 * predict. Raising the fraction further would cross that bound.
 */
const WORD_INDEX_RECOMPACT_STORE_FRACTION = 0.1;

/**
 * Backing-store count that triggers a repack for `index`: a fixed floor, or a
 * share of the live vocabulary once the index is large enough for the share to
 * exceed the floor. O(1) — reads `postings.size`, never walks the vocabulary.
 */
function wordIndexRecompactThreshold(index: WordIndex): number {
	return Math.max(
		WORD_INDEX_RECOMPACT_STORE_FLOOR,
		Math.floor(index.postings.size * WORD_INDEX_RECOMPACT_STORE_FRACTION),
	);
}

/**
 * Pack the arena if churn has spread the postings across more than the
 * threshold of backing stores (#2117, #2246). Runs the exact O(vocab) store
 * count as the authoritative gate — the per-edit hot path uses the O(1)
 * `postingStoreCount` estimate, so this expensive walk only happens inside the
 * bounded, off-hot-path recompaction it guards. Resets the estimate to the
 * true post-compaction count.
 */
async function recompactWordIndexPostingsIfNeeded(
	index: WordIndex,
	root: string,
): Promise<void> {
	const threshold = wordIndexRecompactThreshold(index);
	const beforeStores = countPostingBackingStores(index.postings);
	if (beforeStores <= threshold) {
		index.postingStoreCount = beforeStores;
		return;
	}
	const beforeBytes = estimateWordIndexResidentBytes(index);
	await compactPostingsIntoArenaCooperatively(index.postings);
	const afterStores = countPostingBackingStores(index.postings);
	index.postingStoreCount = afterStores;
	const afterBytes = estimateWordIndexResidentBytes(index);
	const firstForRoot = incrementDegradationCount({
		kind: "word-index-arena-recompact",
		subject: path.resolve(root),
		reason: `arena store threshold ${threshold} exceeded`,
		metadata: { beforeBytes, afterBytes, beforeStores, afterStores },
	});
	// Keep the detailed record bounded per root. The ledger still counts every
	// repeated recompaction and emits its own power-of-two summaries.
	if (firstForRoot) {
		logWordIndex({
			phase: "incremental_refresh",
			cwd: path.resolve(root),
			trigger: "incremental_refresh",
			reason: `arena_recompact beforeBytes=${beforeBytes} afterBytes=${afterBytes} beforeStores=${beforeStores} afterStores=${afterStores}`,
		});
	}
}

/**
 * Serialize a recompaction through the per-index async operation queue so no
 * async edit or refresh interleaves it (#2117). The queue plus the corruption-
 * proof cooperative compactor together close the review-F2 data race: the queue
 * excludes async operations, and the compactor's snapshot-and-skip publish
 * excludes the synchronous per-edit path the queue cannot see. The per-index
 * `recompactFlight` single-flight (#1753) keeps a burst of edits from stacking
 * duplicates: a caller that arrives while one recompaction runs joins it rather
 * than starting a second. The single slot uses a constant key.
 */
function enqueueWordIndexRecompact(
	index: WordIndex,
	root: string,
): Promise<void> {
	if ((index.postingStoreCount ?? 0) <= wordIndexRecompactThreshold(index)) {
		return Promise.resolve();
	}
	const flight = (index.recompactFlight ??= createSingleFlight<void>());
	return flight.run("recompact", () =>
		enqueueAsyncWordIndexOperation(index, () =>
			recompactWordIndexPostingsIfNeeded(index, root),
		),
	);
}

/**
 * O(1) hot-path gate for the synchronous per-edit seam. Reads the running
 * store-count estimate, never a fresh `Set` over the vocabulary, then defers
 * the actual work onto the async queue so it cannot stall the edit (#2117).
 */
function scheduleWordIndexRecompact(index: WordIndex, filePath: string): void {
	void enqueueWordIndexRecompact(index, path.dirname(filePath));
}

/**
 * Test hook: settle any queued arena recompaction for `index`. Draining the
 * index's own async operation queue is enough because the recompaction runs
 * through it; there is no module-level scheduler to flush.
 */
export async function flushWordIndexRecompactionsForTests(
	index: WordIndex,
): Promise<void> {
	await (asyncWordIndexOperations.get(index) ?? Promise.resolve());
}

function recordWordIndexReplacement(index: WordIndex, startedAt: number): void {
	const stats = index.replacementStats ?? { count: 0, totalMs: 0, maxMs: 0 };
	const durationMs = Math.max(0, Date.now() - startedAt);
	stats.count += 1;
	stats.totalMs += durationMs;
	stats.maxMs = Math.max(stats.maxMs, durationMs);
	index.replacementStats = stats;
}

/** Intern a document path once per index; posting removal compares this id. */
function internWordIndexFile(index: WordIndex, filePath: string): number {
	return index.fileTable.intern(wordIndexKey(filePath), filePath);
}

function appendWordIndexPostings(
	index: WordIndex,
	filePath: string,
	perTokenHits: Map<string, number[]>,
): Map<string, number> {
	const fileId = internWordIndexFile(index, filePath);
	const tokenLineCounts = new Map<string, number>();
	for (const [token, lineNumbers] of perTokenHits) {
		let list = index.postings.get(token);
		if (list) {
			// A grow allocates a fresh private store; count it so the O(1) gate
			// tracks fragmentation without re-walking the vocabulary (#2117).
			if (list.reserve(list.length + lineNumbers.length)) {
				notePostingStoresAllocated(index, 1);
			}
		} else {
			list = new WordPostingList(token, lineNumbers.length);
			index.postings.set(token, list);
			notePostingStoresAllocated(index, 1);
		}
		// `list.token` is the canonical instance, so the forward entry points at
		// the same string the postings map is keyed by instead of retaining this
		// document’s own tokenizer allocation (#2069).
		tokenLineCounts.set(list.token, lineNumbers.length);
		for (const line of lineNumbers) list.push(fileId, line);
	}
	return tokenLineCounts;
}

function commitWordIndexDocumentReplacement(
	index: WordIndex,
	doc: { path: string; content: string },
	perTokenHits: Map<string, number[]>,
	docLength: number,
	startedAt: number,
): void {
	const tokenLineCounts = appendWordIndexPostings(
		index,
		doc.path,
		perTokenHits,
	);
	index.docLengths.set(doc.path, docLength);
	index.forward!.set(doc.path, WordForwardEntry.fromTally(tokenLineCounts));
	index.fileMtimes.set(doc.path, -1);
	index.fileSizes.set(doc.path, Buffer.byteLength(doc.content, "utf-8"));
	index.dirtyFiles?.add(wordIndexKey(doc.path));
	index.totalTokens += docLength;
	index.docCount += 1;
	recordWordIndexReplacement(index, startedAt);
}

function indexWordLine(
	index: WordIndex,
	fileId: number,
	line: string,
	lineNumber: number,
	tokenLineCounts: Map<string, number>,
): number {
	const lineTokens = tokenizeLine(line);
	const seenOnLine = new Set<string>();
	for (const token of lineTokens) {
		if (seenOnLine.has(token)) continue;
		seenOnLine.add(token);
		let list = index.postings.get(token);
		if (!list) {
			list = new WordPostingList(token, 1);
			index.postings.set(token, list);
		}
		list.push(fileId, lineNumber);
		// Canonical instance, not this line’s fresh tokenizer allocation (#2069).
		const canonical = list.token;
		tokenLineCounts.set(canonical, (tokenLineCounts.get(canonical) ?? 0) + 1);
	}
	return lineTokens.length;
}

function finishWordIndexDocument(
	index: WordIndex,
	doc: WordIndexInputDocument,
	docLength: number,
	tokenLineCounts: Map<string, number>,
): void {
	index.docLengths.set(doc.path, docLength);
	index.forward?.set(doc.path, WordForwardEntry.fromTally(tokenLineCounts));
	index.fileMtimes.set(doc.path, doc.mtimeMs ?? 0);
	index.fileSizes.set(
		doc.path,
		doc.size ?? Buffer.byteLength(doc.content, "utf-8"),
	);
	// A build has no prior wire cache. Keeping the marker makes a future
	// serializer cache explicit and gives incremental refresh one uniform seam.
	index.dirtyFiles?.add(wordIndexKey(doc.path));
	index.totalTokens += docLength;
	index.docCount += 1;
}

function indexWordDocument(
	index: WordIndex,
	doc: WordIndexInputDocument,
): void {
	const fileId = internWordIndexFile(index, doc.path);
	const lines = doc.content.split(/\r?\n/);
	const tokenLineCounts = new Map<string, number>();
	let docLength = 0;
	for (let i = 0; i < lines.length; i += 1) {
		docLength += indexWordLine(index, fileId, lines[i], i + 1, tokenLineCounts);
	}
	finishWordIndexDocument(index, doc, docLength, tokenLineCounts);
}

export function buildWordIndex(files: WordIndexInputDocuments): WordIndex {
	const index = createEmptyWordIndex(files.truncated ?? false);
	for (const doc of files) indexWordDocument(index, doc);
	compactWordIndexPostings(index);
	return index;
}

/**
 * Cooperative production builder for bulk/cold paths. It produces the exact
 * same index as {@link buildWordIndex}, but time-slices both between documents
 * and within a large document so startup warmup cannot monopolize pi's TUI
 * event loop (#1197). The index is private until this resolves, so a superseded
 * build never publishes a partial replacement.
 */
export async function buildWordIndexAsync(
	files: WordIndexInputDocuments,
	shouldContinue: () => boolean = () => true,
): Promise<WordIndex> {
	const index = createEmptyWordIndex(files.truncated ?? false);
	const deadline = createDeadline(WORD_INDEX_BUILD_YIELD_BUDGET_MS);
	for (const doc of files) {
		if (!shouldContinue()) throw new Error("word index build superseded");
		const fileId = internWordIndexFile(index, doc.path);
		const lines = doc.content.split(/\r?\n/);
		const tokenLineCounts = new Map<string, number>();
		let docLength = 0;
		for (let i = 0; i < lines.length; i += 1) {
			const line = lines[i];
			docLength += indexWordLine(index, fileId, line, i + 1, tokenLineCounts);
			if (
				line.length >= WORD_INDEX_LONG_LINE_YIELD_CHARS ||
				deadline.expired()
			) {
				await yieldIfOverBudget(deadline);
				if (!shouldContinue()) throw new Error("word index build superseded");
			}
		}
		finishWordIndexDocument(index, doc, docLength, tokenLineCounts);
		if (deadline.expired() && (await yieldIfOverBudget(deadline))) {
			if (!shouldContinue()) throw new Error("word index build superseded");
		}
	}
	compactWordIndexPostings(index);
	return index;
}

/**
 * Remove `filePath`'s postings/docLength/forward entry from `index` in place,
 * using the forward index to know exactly which tokens to touch (no scan of
 * unrelated postings). No-op (returns false) if the index has no forward
 * index yet (pre-phase-2 / deserialized-old-shape) or the file isn't present —
 * callers must treat `false` as "fall back to a full rebuild", never as
 * silent success.
 */
export function removeWordIndexDocument(
	index: WordIndex,
	filePath: string,
): boolean {
	if (!index.forward) return false;
	const tokenLineCounts = index.forward.get(filePath);
	if (!tokenLineCounts) return false;

	// `postings` is token-keyed (not a PathKeyedMap), so the file identity it
	// carries must be resolved through the SAME normalizer the path maps use —
	// otherwise a build-form hit (`SUB/a.ts`) survives an edit-form removal
	// (`sub/a.ts`) on a case-insensitive FS and lingers as a stale posting
	// (the #1025 item #2 bug this fix closes). Since #2069 that identity is the
	// file table’s integer id, so the comparison below is an int compare rather
	// than a per-element string compare.
	const removedKey = wordIndexKey(filePath);
	const removedId = index.fileTable.idFor(removedKey);
	if (removedId === undefined) return false;
	for (const token of tokenLineCounts.keys()) {
		const list = index.postings.get(token);
		if (!list) continue;
		const next = list.withoutFile(removedId);
		// `withoutFile` always returns a freshly allocated private store (#2117).
		if (next.length > 0) {
			index.postings.set(token, next);
			notePostingStoresAllocated(index, 1);
		} else index.postings.delete(token);
	}

	const docLength = index.docLengths.get(filePath) ?? 0;
	index.docLengths.delete(filePath);
	index.forward.delete(filePath);
	index.fileMtimes.delete(filePath);
	index.fileSizes.delete(filePath);
	index.dirtyFiles?.add(wordIndexKey(filePath));
	index.fileTable.release(removedKey);
	index.totalTokens -= docLength;
	index.docCount = Math.max(0, index.docCount - 1);
	return true;
}

/**
 * Add or replace `filePath`'s document in `index` in place: removes the prior
 * postings for this file (if any, via {@link removeWordIndexDocument}'s
 * forward-index lookup) then re-tokenizes `content` and adds the new
 * postings/docLength/forward entry. df/N/totalTokens (avgdl) are updated as
 * running stats — no full recompute over other documents.
 *
 * Returns `false` (no-op on `index`) when the index has no forward index —
 * the caller must fall back to a full {@link buildWordIndex} rebuild in that
 * case (documented at the `forward` field and enforced by callers, not
 * silently patched here: a partially-forward-consistent index would corrupt
 * future incremental updates).
 */
export function updateWordIndexDocument(
	index: WordIndex,
	doc: { path: string; content: string },
): boolean {
	if (!index.forward) return false;
	const startedAt = Date.now();

	// Remove the old contribution first (no-op if this is a brand new doc).
	if (index.forward.has(doc.path)) {
		removeWordIndexDocument(index, doc.path);
	}

	// Tokenize with line numbers attached (needed for WordHit.line) — this also
	// yields the forward-index entry (distinct-line count per token) so the
	// tokenization work happens exactly once for this document.
	const lines = doc.content.split(/\r?\n/);
	const perTokenHits = new Map<string, number[]>();
	let docLength = 0;
	for (let i = 0; i < lines.length; i += 1) {
		const lineTokens = tokenizeLine(lines[i]);
		docLength += lineTokens.length;
		const seenOnLine = new Set<string>();
		for (const token of lineTokens) {
			if (seenOnLine.has(token)) continue;
			seenOnLine.add(token);
			const arr = perTokenHits.get(token);
			if (arr) arr.push(i + 1);
			else perTokenHits.set(token, [i + 1]);
		}
	}

	// Per-edit callers generally already have content but not a stat. -1 is an
	// impossible real mtime, so it deliberately makes the document stale at the
	// next startup refresh (`-1 !== realMtime` always) — unlike 0, which is a
	// legal on-disk mtime (SOURCE_DATE_EPOCH=0, archive extraction) and would
	// collide, leaving such a file never re-tokenized (#958 review F2).
	commitWordIndexDocumentReplacement(
		index,
		doc,
		perTokenHits,
		docLength,
		startedAt,
	);
	scheduleWordIndexRecompact(index, doc.path);
	return true;
}

type StagedWordIndexRemoval = {
	postings: Map<string, WordPostingList | undefined>;
	docLength: number;
};

const asyncWordIndexOperations = new WeakMap<WordIndex, Promise<void>>();

function enqueueAsyncWordIndexOperation<T>(
	index: WordIndex,
	operation: () => Promise<T>,
): Promise<T> {
	const previous = asyncWordIndexOperations.get(index) ?? Promise.resolve();
	const run = previous.catch(() => undefined).then(operation);
	const settled = run.then(
		() => undefined,
		() => undefined,
	);
	asyncWordIndexOperations.set(index, settled);
	return run.finally(() => {
		if (asyncWordIndexOperations.get(index) === settled) {
			asyncWordIndexOperations.delete(index);
		}
	});
}

async function stageWordIndexDocumentRemoval(
	index: WordIndex,
	filePath: string,
	shouldContinue: () => boolean,
): Promise<StagedWordIndexRemoval | undefined> {
	if (!index.forward) return undefined;
	const tokenLineCounts = index.forward.get(filePath);
	if (!tokenLineCounts) return undefined;
	const removedKey = wordIndexKey(filePath);
	const removedId = index.fileTable.idFor(removedKey);
	if (removedId === undefined) return undefined;
	const postings = new Map<string, WordPostingList | undefined>();
	const deadline = createDeadline(WORD_INDEX_BUILD_YIELD_BUDGET_MS);
	for (const token of tokenLineCounts.keys()) {
		if (!shouldContinue()) throw new Error("word index refresh superseded");
		const list = index.postings.get(token);
		if (!list) continue;
		// One token's postings, filtered by the SAME packed primitive the
		// synchronous path uses, so the staged result is identical rather than
		// merely equivalent. The work unit is the token, not the posting element:
		// a per-element deadline check cost one `performance.now()` per entry —
		// on the order of a million per edit on a 2.2M-posting corpus — which is
		// the tax that made this path unusable from the per-edit seam (#2067).
		// One list's scan is a bounded, non-yieldable unit; the deadline is
		// checked between lists.
		const survivors = list.withoutFile(removedId);
		postings.set(token, survivors.length > 0 ? survivors : undefined);
		if (deadline.expired() && (await yieldIfOverBudget(deadline))) {
			if (!shouldContinue()) throw new Error("word index refresh superseded");
		}
	}
	return { postings, docLength: index.docLengths.get(filePath) ?? 0 };
}

function commitWordIndexDocumentRemoval(
	index: WordIndex,
	filePath: string,
	staged: StagedWordIndexRemoval,
): void {
	for (const [token, list] of staged.postings) {
		// Staged survivors come from `WordPostingList.withoutFile` — a fresh
		// private store each, so the O(1) fragmentation gate must count them
		// (#2117).
		if (list) {
			index.postings.set(token, list);
			notePostingStoresAllocated(index, 1);
		} else index.postings.delete(token);
	}
	index.docLengths.delete(filePath);
	index.forward?.delete(filePath);
	index.fileMtimes.delete(filePath);
	index.fileSizes.delete(filePath);
	index.dirtyFiles?.add(wordIndexKey(filePath));
	index.fileTable.release(wordIndexKey(filePath));
	index.totalTokens -= staged.docLength;
	index.docCount = Math.max(0, index.docCount - 1);
}

/** Cooperative, atomically-published removal used only by bulk refresh. */
export async function removeWordIndexDocumentAsync(
	index: WordIndex,
	filePath: string,
	shouldContinue: () => boolean = () => true,
): Promise<boolean> {
	return enqueueAsyncWordIndexOperation(index, async () => {
		const staged = await stageWordIndexDocumentRemoval(
			index,
			filePath,
			shouldContinue,
		);
		if (!staged) return false;
		if (!shouldContinue()) throw new Error("word index refresh superseded");
		commitWordIndexDocumentRemoval(index, filePath, staged);
		return true;
	});
}

/**
 * The per-edit replacement primitive the cascade seam calls (#2067).
 *
 * `updateWordIndexDocumentAsync` plus the arena-recompaction gate the
 * synchronous variant carries, which is what makes this the per-edit entry
 * point rather than a rename. Bulk refresh must NOT use it: one refreshed
 * document raises `postingStoreCount` by roughly its distinct-token count, so a
 * per-document schedule would drive an O(vocabulary) recompaction between
 * nearly every pair of documents. `refreshWordIndexIncrementally` therefore
 * drives `updateWordIndexDocumentAsync` directly and recompacts ONCE after its
 * loop; the per-edit seam has no such "after the loop" and schedules here.
 */
export async function updateWordIndexDocumentForEdit(
	index: WordIndex,
	doc: { path: string; content: string },
): Promise<boolean> {
	const updated = await updateWordIndexDocumentAsync(index, doc);
	if (updated) scheduleWordIndexRecompact(index, doc.path);
	return updated;
}

/** Cooperative replacement whose old/new state is committed without an await. */
export async function updateWordIndexDocumentAsync(
	index: WordIndex,
	doc: { path: string; content: string },
	shouldContinue: () => boolean = () => true,
): Promise<boolean> {
	return enqueueAsyncWordIndexOperation(index, () =>
		updateWordIndexDocumentAsyncUnsafe(index, doc, shouldContinue),
	);
}

async function updateWordIndexDocumentAsyncUnsafe(
	index: WordIndex,
	doc: { path: string; content: string },
	shouldContinue: () => boolean,
): Promise<boolean> {
	if (!index.forward) return false;
	const startedAt = Date.now();
	const removal = index.forward.has(doc.path)
		? await stageWordIndexDocumentRemoval(index, doc.path, shouldContinue)
		: undefined;
	if (index.forward.has(doc.path) && !removal) return false;
	const perTokenHits = new Map<string, number[]>();
	let docLength = 0;
	const lines = doc.content.split(/\r?\n/);
	await forEachCooperatively(
		lines,
		(line, i) => {
			const lineTokens = tokenizeLine(line);
			docLength += lineTokens.length;
			const seenOnLine = new Set<string>();
			for (const token of lineTokens) {
				if (seenOnLine.has(token)) continue;
				seenOnLine.add(token);
				const arr = perTokenHits.get(token);
				if (arr) arr.push(i + 1);
				else perTokenHits.set(token, [i + 1]);
			}
		},
		{
			budgetMs: WORD_INDEX_BUILD_YIELD_BUDGET_MS,
			shouldContinue,
			abortMessage: "word index refresh superseded",
		},
	);
	if (!shouldContinue()) throw new Error("word index refresh superseded");
	if (removal) commitWordIndexDocumentRemoval(index, doc.path, removal);
	commitWordIndexDocumentReplacement(
		index,
		doc,
		perTokenHits,
		docLength,
		startedAt,
	);
	return true;
}

/** Bounds shared by every word-index build path — keep the walk off the
 * critical path on large repos: cap the file count, and skip files too large
 * to be hand-written source (generated/bundled output the source filter
 * didn't already exclude).
 *
 * Deprecated (#776): `collectWordIndexDocs` below no longer reads this
 * constant directly — it derives its cap from `getWordIndexMaxFilesDerived`
 * (project-scale.ts's `maxProjectFiles` knob), which reproduces this same
 * 6,000 default at the default base. Kept exported for tests/callers that
 * still reference the literal. */
export const WORD_INDEX_MAX_FILES = 6000;
export const WORD_INDEX_MAX_BYTES = 512 * 1024;

export type WordIndexPreflightFiles = Array<{
	path: string;
	mtimeMs: number;
	size: number;
}> & { truncated: boolean };

/**
 * Collect the bounded `{path, content}` doc set `buildWordIndex` consumes —
 * the ONE file-walk-and-read implementation shared by every build path
 * (session-start task, quick-mode warmup, cold-query background trigger),
 * so a bound/skip-rule change lands in one place instead of three copies.
 * `shouldContinue` lets a session-scoped caller abort early (session
 * superseded) without this module knowing about RuntimeCoordinator.
 */
export async function collectWordIndexDocs(
	root: string,
	shouldContinue: () => boolean = () => true,
	preflightFiles?: WordIndexPreflightFiles,
): Promise<
	Array<{ path: string; content: string; mtimeMs: number; size: number }> & {
		truncated: boolean;
		/**
		 * Files the walk enumerated but this pass could NOT index — unreadable
		 * (vanished / locked) or over `WORD_INDEX_MAX_BYTES`. Surfaced (L1, #958)
		 * so the full-build path can report coverage honestly (#533) instead of
		 * silently dropping them with no count, the way the incremental path
		 * already reports its own `skipped`.
		 */
		skipped: number;
	}
> {
	const { collectSourceFilesAsync } = await import("./source-filter.js");
	// #747 hardening: pass the cap INTO the walk — without it,
	// `collectSourceFilesAsync` defaults to an unbounded traversal and the
	// `WORD_INDEX_MAX_FILES` slice below only trims the result AFTER the whole
	// tree (all of $HOME, on a misrooted cwd) has already been enumerated.
	// #760: the walk is additionally bounded by source-filter's default
	// visited-entry budget (DEFAULT_MAX_SCAN_ENTRIES), so a mixed tree with few
	// source files among a huge pile of non-source files can't force a
	// full-tree walk either; an index over the truncated list is acceptable.
	const maxFiles = preflightFiles?.length ?? getWordIndexMaxFilesDerived(root);
	// #894 review: prioritize code kinds within the cap — with broadened
	// enumeration, thousands of data/doc files (locale JSON, fixtures, …)
	// ahead of the code dirs in walk order could exhaust `maxFiles` and evict
	// real source files from the index entirely (DOC_FILE_PENALTY can't
	// rescue a file that never made the slice).
	const files = preflightFiles
		? preflightFiles.map((file) => file.path)
		: await collectSourceFilesAsync(root, {
				maxFiles,
				prioritizeCodeKinds: true,
			});
	const truncated = preflightFiles?.truncated ?? files.length === maxFiles;
	const docs = Object.assign(
		[] as Array<{
			path: string;
			content: string;
			mtimeMs: number;
			size: number;
		}>,
		{ truncated, skipped: 0 },
	);
	if (!shouldContinue()) return docs;
	const deadline = createDeadline(WORD_INDEX_BUILD_YIELD_BUDGET_MS);
	for (const file of files.slice(0, maxFiles)) {
		if (!shouldContinue()) return docs;
		try {
			// A preflight list saves the second full WALK, but its metadata may be
			// stale by the time this rebuild reads the file. Re-stat each document at
			// content-read time so the stored freshness stamp describes the bytes we
			// actually index and the next incremental refresh cannot miss a change in
			// the walk-to-read window (#1302).
			const stat = fs.statSync(file);
			if (stat.size <= WORD_INDEX_MAX_BYTES) {
				docs.push({
					path: file,
					content: fs.readFileSync(file, "utf-8"),
					mtimeMs: stat.mtimeMs,
					size: stat.size,
				});
			} else {
				// Over the byte cap — enumerated but deliberately not indexed. Count
				// it (L1, #958) so callers can keep coverage honest instead of the
				// old silent drop.
				docs.skipped += 1;
			}
		} catch {
			// unreadable / vanished file — skip, but count it (see above).
			docs.skipped += 1;
		}
		if (deadline.expired() && (await yieldIfOverBudget(deadline))) {
			if (!shouldContinue()) return docs;
		}
	}
	return docs;
}

export interface WordIndexRefreshResult {
	mode: "incremental";
	refreshed: number;
	dropped: number;
	/** Files that were stale but unreadable this pass; posting left intact. */
	skipped: number;
	reused: number;
	timings: WordIndexRefreshTimings;
}

export interface WordIndexRefreshTimings {
	sourceWalkMs: number;
	statWalkMs: number;
	refreshReadsMs: number;
}

export interface WordIndexRebuildRequired {
	mode: "full-required";
	reason:
		| "missing-incremental-metadata"
		| "file-set-churn"
		| "stale-document-churn";
	/** Bounded walk+stat result for a rebuild without repeating the full walk. */
	preflightFiles?: WordIndexPreflightFiles;
	timings: WordIndexRefreshTimings;
}

export type WordIndexRefreshOutcome =
	| WordIndexRefreshResult
	| WordIndexRebuildRequired;

export interface WordIndexRefreshOptions {
	statFile?: (file: string) => Promise<Pick<fs.Stats, "mtimeMs" | "size">>;
	statConcurrency?: number;
}

// Node's fs.promises.stat runs on libuv's threadpool (default 4 slots), so
// real parallelism tops out there; the surplus workers are queue depth that
// keeps the pool saturated without starving other threadpool consumers.
export const WORD_INDEX_STAT_CONCURRENCY = 8;

const WORD_INDEX_INCREMENTAL_CHURN_THRESHOLD = 0.3;
// A ratio alone misclassifies one stale file in a three-file project as dense.
// Below this absolute floor, per-document replacement is bounded and cheaper
// than a second full walk/read even when the percentage is high (#1197).
const WORD_INDEX_DENSE_REFRESH_MIN_DOCUMENTS = 32;
/**
 * Cost of one file's stat+read+decode expressed in tokenizer-token units, so
 * the work model below can compare a path that re-reads EVERY file (full
 * rebuild) against one that re-reads only the stale files (incremental) in a
 * single currency. One read ≈ 300 tokens at the ~1 µs/token measured below.
 * Order-of-magnitude by design — it only has to keep a tiny-vocabulary corpus
 * (where posting scans are nearly free) from being sent to a full rebuild that
 * re-reads everything to save a handful of array filters.
 */
const WORD_INDEX_FILE_READ_TOKEN_COST = 300;
/**
 * Cost of scanning ONE posting-array element (the `wordIndexKey` compare in
 * {@link removeWordIndexDocument}'s filter) relative to tokenizing one token,
 * so both sides of the model below are denominated in tokens. Measured on this
 * repository's own 2,062-document corpus: 213 ns per element scan against 979 ns
 * per token — and the resulting predicted crossover (23 stale documents) lands
 * on the directly measured one (~21, from 97.8 ms per document replacement
 * against a 1,436 ms rebuild + re-read). The synthetic high-df corpus in the
 * #1197 probe gives 0.09, so this is the conservative (incremental-favouring)
 * end of the observed range.
 *
 * #2069 made the scan an Int32 compare over packed lanes instead of a string
 * compare over boxed objects, so the real per-element cost is now BELOW this
 * constant. The constant is left as measured: over-stating incremental cost
 * only ever routes work to a full rebuild, which is the bounded side of the
 * decision. Re-measuring it is #2067/#2068 territory, not this change.
 */
const WORD_INDEX_POSTING_SCAN_TOKEN_COST = 0.2;

/**
 * Refresh a serializer-v2 index from the current bounded source-file set.
 * The walk/stat pass is cheap; only sparse stale/new documents are read and
 * tokenized. Expected dense/legacy states return `full-required` BEFORE any
 * mutation; unexpected corruption or supersession still throws.
 */
export async function refreshWordIndexIncrementally(
	index: WordIndex,
	root: string,
	shouldContinue: () => boolean = () => true,
	options: WordIndexRefreshOptions = {},
): Promise<WordIndexRefreshOutcome> {
	if (!index.forward || !index.fileMtimes || !index.fileSizes) {
		return {
			mode: "full-required",
			reason: "missing-incremental-metadata",
			timings: { sourceWalkMs: 0, statWalkMs: 0, refreshReadsMs: 0 },
		};
	}
	const { collectSourceFilesAsync } = await import("./source-filter.js");
	const maxFiles = getWordIndexMaxFilesDerived(root);
	const sourceWalkStartMs = Date.now();
	const walked = await collectSourceFilesAsync(root, {
		maxFiles,
		prioritizeCodeKinds: true,
	});
	const sourceWalkMs = Date.now() - sourceWalkStartMs;
	if (!shouldContinue()) throw new Error("word index refresh superseded");

	// This set-difference must run in the SAME normalized key space the path
	// maps use (#1025 review). Otherwise a file whose stored displayPath became
	// the edit form (last-writer-wins after a case/separator-divergent per-edit
	// update) no longer string-matches its walk form here — even though
	// `fileMtimes.get(walkForm)` folds and hits — which would (1) double-count
	// churn (the same file scored as both "dropped" and "added"), possibly
	// crossing the threshold and forcing a needless full rebuild, and (2) drop
	// then re-add an unchanged file, opening a regression window because the drop
	// loop runs BEFORE the re-read: a transient read failure (skipped++) would
	// strand the file with no postings. Keying `current` and `oldSet` through
	// `wordIndexKey` keeps build/edit/refresh convergent; `current`'s value
	// retains the raw walk path for the stat/read and for the display key.
	const current = new Map<
		string,
		{ path: string; mtimeMs: number; size: number }
	>();
	const statWalkStartMs = Date.now();
	const statFile =
		options.statFile ?? ((file: string) => fs.promises.stat(file));
	const requestedConcurrency =
		options.statConcurrency ?? WORD_INDEX_STAT_CONCURRENCY;
	const statConcurrency =
		Number.isFinite(requestedConcurrency) && requestedConcurrency > 0
			? Math.max(1, Math.floor(requestedConcurrency))
			: WORD_INDEX_STAT_CONCURRENCY;
	const statResults = new Array<
		{ path: string; mtimeMs: number; size: number } | undefined
	>(walked.length);
	let cursor = 0;
	let superseded = false;
	const worker = async (): Promise<void> => {
		while (true) {
			if (!shouldContinue()) {
				superseded = true;
				return;
			}
			const slot = cursor++;
			if (slot >= walked.length) return;
			const file = walked[slot];
			try {
				const stat = await statFile(file);
				if (stat.size <= WORD_INDEX_MAX_BYTES) {
					statResults[slot] = {
						path: file,
						mtimeMs: stat.mtimeMs,
						size: stat.size,
					};
				}
			} catch {
				// A rejection has statSync parity: the file is simply absent.
			}
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(statConcurrency, walked.length) }, () =>
			worker(),
		),
	);
	if (superseded || !shouldContinue()) {
		throw new Error("word index refresh superseded");
	}
	const statWalkMs = Date.now() - statWalkStartMs;
	for (const result of statResults) {
		if (result) current.set(wordIndexKey(result.path), result);
	}
	const timings = { sourceWalkMs, statWalkMs, refreshReadsMs: 0 };
	const preflightFiles = Object.assign([...current.values()], {
		truncated: walked.length === maxFiles,
	});

	const oldSet = new Set([...index.docLengths.keys()].map(wordIndexKey));
	let changedSet = 0;
	for (const key of oldSet) if (!current.has(key)) changedSet++;
	for (const key of current.keys()) if (!oldSet.has(key)) changedSet++;
	const denominator = Math.max(oldSet.size, current.size, 1);
	if (changedSet / denominator > WORD_INDEX_INCREMENTAL_CHURN_THRESHOLD) {
		return {
			mode: "full-required",
			reason: "file-set-churn",
			preflightFiles,
			timings,
		};
	}

	// Replacing one document filters every shared posting array for that
	// document's tokens. That is excellent for a sparse edit, but repeating it
	// for most of the corpus becomes effectively quadratic. Decide the dense
	// transition BEFORE dropping or editing anything so the old index remains a
	// valid fallback until a separately-built full replacement is ready (#1197).
	let staleDocuments = 0;
	for (const { path: file, mtimeMs, size } of current.values()) {
		if (
			index.fileMtimes.get(file) !== mtimeMs ||
			(index.fileSizes.get(file) ?? -1) !== size
		) {
			staleDocuments += 1;
		}
	}
	// Density alone is NOT a bound (#1197 review finding 1): the per-document cost
	// GROWS with the corpus, so a stale set comfortably under any fixed ratio (or
	// any fixed absolute ceiling) still costs orders of magnitude more than a
	// rebuild on a big enough repository. 800 documents with 239 stale — 29.875%,
	// just under the ratio — measured 90.6 s with a 39.6 s synchronous block
	// against 1.3 s / 10.6 ms for a full build, and at the 6,000-file cap up to
	// 1,799 stale documents would have stayed on that path.
	//
	// So compare estimated WORK, both sides denominated in tokenizer tokens:
	//   incremental ≈ stale x (docTokens x postingLength x scanCost + readCost)
	//   full        ≈ totalTokens + corpusSize x readCost
	// This is self-bounding in a way no constant is: the incremental path is taken
	// only while its total estimated cost stays under ONE full rebuild, so the
	// worst case is "about as expensive as rebuilding", whatever the corpus size.
	//
	// Both statistics come from cheap metadata passes — one over `postings`
	// (distinct tokens, reading only `.length`) and one over `forward` (documents,
	// reading only `.size`). Neither touches a posting ELEMENT, which is the work
	// this decision exists to avoid.
	let postingEntries = 0;
	let weightedPostingEntries = 0;
	for (const list of index.postings.values()) {
		postingEntries += list.length;
		weightedPostingEntries += list.length * list.length;
	}
	// The mean posting-array length weighted by OCCURRENCES, not the plain mean:
	// a document's tokens are drawn from the frequency distribution, so the arrays
	// a removal actually filters skew hard toward the high-document-frequency
	// tokens. The unweighted mean (dominated by the long tail of df=1 tokens)
	// underestimates the real cost by an order of magnitude.
	const expectedPostingLength =
		postingEntries > 0 ? weightedPostingEntries / postingEntries : 0;
	let distinctTokenEntries = 0;
	for (const tokenLineCounts of index.forward.values()) {
		distinctTokenEntries += tokenLineCounts.size;
	}
	const expectedDocumentTokens =
		index.docCount > 0 ? distinctTokenEntries / index.docCount : 0;
	const estimatedIncrementalWork =
		staleDocuments *
		(expectedDocumentTokens *
			expectedPostingLength *
			WORD_INDEX_POSTING_SCAN_TOKEN_COST +
			WORD_INDEX_FILE_READ_TOKEN_COST);
	const estimatedFullRebuildWork =
		index.totalTokens + current.size * WORD_INDEX_FILE_READ_TOKEN_COST;
	// The document-count floor guards the RATIO test only — its documented job is
	// that "one stale file in a three-file project" is 33% but not dense. It must
	// NOT gate the work test: a floor is another constant, and letting one
	// suppress the work comparison would reintroduce exactly the unbounded-on-the
	// -other-axis shape (31 documents at 98 ms each on this repository's own
	// corpus, and worse as the corpus grows). The work test needs no floor — on a
	// small project a full rebuild is cheap, so it never fires there.
	if (
		(staleDocuments >= WORD_INDEX_DENSE_REFRESH_MIN_DOCUMENTS &&
			staleDocuments / Math.max(current.size, 1) >
				WORD_INDEX_INCREMENTAL_CHURN_THRESHOLD) ||
		estimatedIncrementalWork > estimatedFullRebuildWork
	) {
		return {
			mode: "full-required",
			reason: "stale-document-churn",
			preflightFiles,
			timings,
		};
	}

	const deadline = createDeadline(WORD_INDEX_BUILD_YIELD_BUDGET_MS);
	let dropped = 0;
	for (const key of oldSet) {
		if (!current.has(key)) {
			// `key` is already folded; removeWordIndexDocument re-folds it
			// idempotently via the PathKeyedMap, so the drop hits the right entry.
			if (!(await removeWordIndexDocumentAsync(index, key, shouldContinue))) {
				throw new Error(`failed to drop word-index document: ${key}`);
			}
			dropped++;
		}
	}

	let refreshed = 0;
	let skipped = 0;
	const refreshReadsStartMs = Date.now();
	for (const { path: file, mtimeMs, size } of current.values()) {
		// #1105: mtime-first, size-second freshness — mtime alone is a stale
		// signal (mtime-preserving content changes serve stale identifiers to
		// symbol_search). Size is free (the stat above already read it) and
		// catches every content change that alters byte length. Both come from the
		// SAME stat, so a mismatch on EITHER axis re-reads. `?? -1` makes a file
		// absent from the (possibly legacy, pre-#1105) size map always count as
		// changed → one-time re-read that repopulates the size, the safe direction.
		if (
			index.fileMtimes.get(file) !== mtimeMs ||
			(index.fileSizes.get(file) ?? -1) !== size
		) {
			// A file the walk/stat pass saw can still fail to read here — a
			// transient exclusive lock (antivirus, an editor, a build step) or a
			// file that vanished in the interim. Match collectWordIndexDocs'
			// tolerance: skip this one file and leave its existing posting (and
			// its old mtime, so it is retried next session) rather than aborting
			// the whole incremental pass into a full rebuild (#958 review F1).
			let content: string;
			try {
				content = fs.readFileSync(file, "utf-8");
			} catch {
				skipped++;
				continue;
			}
			if (
				!(await updateWordIndexDocumentAsync(
					index,
					{ path: file, content },
					shouldContinue,
				))
			) {
				throw new Error(`failed to refresh word-index document: ${file}`);
			}
			// updateWordIndexDocument stamps mtime=-1 (per-edit convention); the
			// refresh path KNOWS the real on-disk stat, so overwrite both axes with
			// the true values so this document is not needlessly re-read next pass.
			index.fileMtimes.set(file, mtimeMs);
			index.fileSizes.set(file, size);
			refreshed++;
		}
		// Same OR as the stat loop. This is the loop the #1197 outage actually
		// blocked in: replacing one document costs more the larger the corpus is,
		// so a count-only checkpoint let 100 replacements run back to back for
		// seconds. The gate above keeps the stale set sparse; this keeps even a
		// sparse-but-expensive set off the event loop.
		if (deadline.expired() && (await yieldIfOverBudget(deadline))) {
			if (!shouldContinue()) throw new Error("word index refresh superseded");
		}
	}
	timings.refreshReadsMs = Date.now() - refreshReadsStartMs;
	// Route through the same guarded queue the per-edit seam uses, so a refresh
	// and a concurrent cascade edit cannot both drive a recompaction (#2117).
	await enqueueWordIndexRecompact(index, root);
	index.truncated = walked.length === maxFiles;
	return {
		mode: "incremental",
		refreshed,
		dropped,
		skipped,
		reused: current.size - refreshed - skipped,
		timings,
	};
}

// --- Query prefix filters (#1450) --------------------------------------------
//
// Composable `lang:`/`file:`/`ext:` filters mixed into the plain query string,
// e.g. `lang:ts file:clients/ -file:test rank`. Hand-rolled tokenizer (a regex
// split per whitespace token) rather than a grammar — the issue's explicit
// direction, and the query language is small enough that a grammar would be
// pure overhead. Landed HERE, in `searchWordIndex` (the word-index query entry
// point), so both the pi `symbol_search` tool and the MCP
// `pilens_symbol_search` mirror inherit the syntax for free: they already pass
// their `query` argument straight through to `symbolSearch` → `searchWordIndex`
// with no filter-specific plumbing of their own.

/** The three supported inline query-filter prefixes (#1450). */
export type WordIndexQueryFilterKey = "lang" | "file" | "ext";

export const WORD_INDEX_QUERY_FILTER_KEYS: readonly WordIndexQueryFilterKey[] =
	["lang", "file", "ext"];

export interface WordIndexQueryFilter {
	key: WordIndexQueryFilterKey;
	value: string;
	/** True when the token was `-key:value` — always subtracts, never OR's with a positive filter of the same key. */
	negated: boolean;
}

export interface ParsedWordIndexQuery {
	/** The query with filter tokens stripped, ready for {@link tokenizeLine} — identical to the input when it contains no filters. */
	terms: string;
	filters: WordIndexQueryFilter[];
}

/** Thrown by {@link parseWordIndexQuery}/{@link buildWordIndexQueryFilter} for
 * an unrecognized `key:` prefix or an unrecognized `lang:` value — a query
 * typo fails loudly with the supported list instead of silently degrading
 * into a literal search term (#1450 acceptance criterion). */
export class WordIndexQueryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WordIndexQueryError";
	}
}

const WORD_INDEX_FILTER_TOKEN_RE = /^(-)?([A-Za-z][A-Za-z0-9_-]*):(.+)$/;

/**
 * Split a word-index query string into plain search terms and `key:value`
 * prefix filters (#1450). Whitespace-delimited, one regex per token — no
 * quoting scheme invented here, matching the pre-existing query path (which
 * never supported quoting either). A `-` immediately before a recognized
 * `key:` negates that filter; a bare `-term` (no colon) is left as an
 * ordinary token, unchanged from prior behavior — `tokenizeLine` already
 * strips the leading `-` when it extracts identifiers.
 *
 * An unrecognized `key:` (e.g. `type:foo`) throws {@link WordIndexQueryError}
 * naming the supported prefixes, rather than falling through as a literal
 * term — a typo must fail loudly, never silently rank as if the filter never
 * existed. An empty value (`lang:`) is not treated as a filter token at all
 * (kept as a term) since there is nothing to filter by.
 */
export function parseWordIndexQuery(query: string): ParsedWordIndexQuery {
	const filters: WordIndexQueryFilter[] = [];
	const termParts: string[] = [];
	for (const raw of query.split(/\s+/)) {
		if (!raw) continue;
		const match = raw.match(WORD_INDEX_FILTER_TOKEN_RE);
		if (!match) {
			termParts.push(raw);
			continue;
		}
		const [, negation, keyRaw, value] = match;
		const key = keyRaw.toLowerCase();
		if (!value) {
			termParts.push(raw);
			continue;
		}
		if (!(WORD_INDEX_QUERY_FILTER_KEYS as readonly string[]).includes(key)) {
			// Not a recognized filter key. Ordinary search terms legitimately
			// contain colons (std::vector, error:foo, http://…, C:\ paths, a
			// TODO:tag), and the old tokenizer searched them fine — a hard
			// error here is a usability regression, not typo protection. The
			// token passes through as a plain term; the loud-failure contract
			// survives where it is unambiguous: a KNOWN key with a bad value
			// (lang:notalang) still throws.
			termParts.push(raw);
			continue;
		}
		filters.push({
			key: key as WordIndexQueryFilterKey,
			value,
			negated: negation === "-",
		});
	}
	return { terms: termParts.join(" "), filters };
}

/** `lang:X` → the extension set for FileKind X (case-insensitive), drawn
 * exclusively from `KIND_EXTENSIONS` (clients/file-kinds.ts) — the single
 * source of truth (#894 invariant: no second, hand-maintained language list).
 * An unrecognized kind throws {@link WordIndexQueryError} listing the accepted
 * kinds (KIND_EXTENSIONS' own keys), the same loud-failure contract as an
 * unsupported `key:` prefix. */
function resolveLangExtensions(value: string): readonly string[] {
	const kind = value.toLowerCase() as FileKind;
	const extensions = KIND_EXTENSIONS[kind];
	if (!extensions) {
		const known = Object.keys(KIND_EXTENSIONS)
			.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
			.join(", ");
		throw new WordIndexQueryError(
			`Unknown lang: "${value}" in word-index query — supported languages: ${known}.`,
		);
	}
	return extensions;
}

/** `ext:ts` / `ext:.ts` → normalized to a single leading-dot, lowercased form for extname comparison. */
function normalizeExtFilterValue(value: string): string {
	return `.${value.replace(/^\.+/, "").toLowerCase()}`;
}

interface ResolvedWordIndexFilter {
	key: WordIndexQueryFilterKey;
	negated: boolean;
	test: (file: string, displayPath: string) => boolean;
}

function resolveWordIndexFilter(
	filter: WordIndexQueryFilter,
): ResolvedWordIndexFilter {
	if (filter.key === "lang") {
		const extensions = resolveLangExtensions(filter.value);
		return {
			key: filter.key,
			negated: filter.negated,
			test: (file) => extensions.includes(path.extname(file).toLowerCase()),
		};
	}
	if (filter.key === "ext") {
		const normalized = normalizeExtFilterValue(filter.value);
		return {
			key: filter.key,
			negated: filter.negated,
			test: (file) => path.extname(file).toLowerCase() === normalized,
		};
	}
	// "file": substring match against the index's own normalized display path
	// (#1450 — see the doc comment on {@link buildWordIndexQueryFilter} for the
	// case-behavior choice). Both sides fold through `wordIndexKey` so the
	// comparison matches the SAME normalization the index's own path keys use.
	const needle = wordIndexKey(filter.value);
	return {
		key: filter.key,
		negated: filter.negated,
		test: (_file, displayPath) => displayPath.includes(needle),
	};
}

/**
 * Build a pre-ranking predicate from parsed query filters (#1450). Composes
 * (AND) with `searchWordIndex`'s pre-existing `fileFilter` option (#771) —
 * `symbol_search`'s structured `paths`/`lang` params and this query's inline
 * filters both apply when both are present.
 *
 * Semantics: multiple positive filters of the SAME key OR together
 * (`lang:ts lang:go` matches either); filters of DIFFERENT keys AND
 * (`lang:ts file:clients/` requires both); a negated filter always subtracts,
 * regardless of any positive filter sharing its key.
 *
 * All filters are RESOLVED EAGERLY (extension lookups, `WordIndexQueryError`
 * thrown) here at build time — before any candidate file is tested — so a bad
 * `lang:` value fails once, loudly, rather than per-file during the scoring
 * loop.
 *
 * `file:` case behavior: matched via `wordIndexKey` (this module's single
 * path-key normalizer, `normalizeEphemeralMapKey`) on BOTH the candidate path
 * and the filter value — slash-folded everywhere, and case-folded ONLY on
 * win32 (Windows' case-insensitive filesystem), preserved on POSIX. This
 * mirrors the SAME normalization the word index's own path-keyed maps already
 * apply (#1025), rather than inventing a second, divergent case rule for this
 * one filter. The candidate path matched is the RAW index-stored path (not
 * cwd-relativized) — the index already stores paths in the form the caller
 * built it with (relative in tests, absolute in the real project walk), and
 * an absolute path's tail always contains its project-relative suffix, so
 * `file:clients/word-index.ts` still matches naturally either way.
 */
export function buildWordIndexQueryFilter(
	filters: readonly WordIndexQueryFilter[],
): ((file: string) => boolean) | undefined {
	if (filters.length === 0) return undefined;
	const resolved = filters.map(resolveWordIndexFilter);
	const positivesByKey = new Map<
		WordIndexQueryFilterKey,
		ResolvedWordIndexFilter[]
	>();
	const negatives: ResolvedWordIndexFilter[] = [];
	for (const r of resolved) {
		if (r.negated) {
			negatives.push(r);
			continue;
		}
		const group = positivesByKey.get(r.key) ?? [];
		group.push(r);
		positivesByKey.set(r.key, group);
	}
	return (file: string) => {
		const displayPath = wordIndexKey(file);
		for (const negative of negatives) {
			if (negative.test(file, displayPath)) return false;
		}
		for (const group of positivesByKey.values()) {
			if (!group.some((r) => r.test(file, displayPath))) return false;
		}
		return true;
	};
}

function combineFileFilters(
	a: ((file: string) => boolean) | undefined,
	b: ((file: string) => boolean) | undefined,
): ((file: string) => boolean) | undefined {
	if (!a) return b;
	if (!b) return a;
	return (file: string) => a(file) && b(file);
}

/**
 * Rank files for a query by BM25 over the query's identifier tokens, then apply
 * priors: demote test/vendor and doc/data files, and boost by graph centrality
 * when supplied. Returns the top {@link RankOptions.limit} files, highest first.
 *
 * The query string may mix plain terms with `lang:`/`file:`/`ext:` prefix
 * filters (+ `-` negation, #1450) — parsed by {@link parseWordIndexQuery} and
 * applied as a `fileFilter` (composed, AND, with any caller-supplied one)
 * BEFORE scoring, same as the pre-existing `paths`/`lang` options (#771): a
 * surviving file's score is unaffected by filtering. A query with no filter
 * tokens reproduces prior output byte-for-byte.
 *
 * DF-normalization note: BM25's per-token `idf` is computed from `docFrequency`
 * over the FULL (unfiltered) postings for that token — `fileFilter` (whether
 * from `options.fileFilter` or from this query's inline filters) is applied
 * AFTER `idf` is computed, per file, inside the same loop. This means a
 * filtered query reuses the GLOBAL, corpus-wide document frequency rather than
 * recomputing it over just the filtered subset. That is the pre-existing #771
 * behavior this change does not alter; it is an acceptable approximation
 * (idf reflects true corpus rarity, not an artifact of the filter) and keeps
 * filtered/unfiltered scores for the SAME file directly comparable, which is
 * the property #1450 asks for ("BM25 and centrality stay comparable within
 * the filtered set").
 */
export function searchWordIndex(
	index: WordIndex,
	query: string,
	options: RankOptions = {},
): RankedFile[] {
	const {
		demoteTestVendor = true,
		demoteDocs = true,
		centrality,
		limit = 20,
		fileFilter,
	} = options;

	const parsedQuery = parseWordIndexQuery(query);
	const queryFilter = buildWordIndexQueryFilter(parsedQuery.filters);
	const combinedFilter = combineFileFilters(fileFilter, queryFilter);

	const queryTokens = [...new Set(tokenizeLine(parsedQuery.terms))];
	if (queryTokens.length === 0) return [];

	const docCount = index.docCount || 1;
	const avgDocLength = index.totalTokens / docCount || 1;

	const scores = new Map<
		string,
		{ score: number; hits: number; lines: Set<number> }
	>();

	for (const token of queryTokens) {
		const posting = index.postings.get(token);
		if (!posting) continue;

		// Grouped by the packed file id, then resolved to the display path once
		// per (token, file) instead of once per posting (#2069). Insertion order,
		// document frequency, and the per-file line lists are identical to the
		// boxed representation, so scores and ordering are unchanged.
		const linesByFileId = new Map<number, number[]>();
		for (let i = 0; i < posting.length; i += 1) {
			const fileId = posting.fileIdAt(i);
			const arr = linesByFileId.get(fileId);
			if (arr) arr.push(posting.lineAt(i));
			else linesByFileId.set(fileId, [posting.lineAt(i)]);
		}

		const docFrequency = linesByFileId.size;
		const idf = Math.log(
			1 + (docCount - docFrequency + 0.5) / (docFrequency + 0.5),
		);

		for (const [fileId, lines] of linesByFileId) {
			const file = index.fileTable.pathFor(fileId);
			if (file === undefined) {
				// Dropping this silently would shorten the result list with nothing to
				// tell it apart from a smaller match set. Record, then drop.
				recordOrphanWordIndexFileId(fileId, token, "search");
				continue;
			}
			if (combinedFilter && !combinedFilter(file)) continue;
			const termFrequency = lines.length;
			const docLength = index.docLengths.get(file) ?? avgDocLength;
			const denominator =
				termFrequency +
				BM25_K1 * (1 - BM25_B + BM25_B * (docLength / avgDocLength));
			const termScore = idf * ((termFrequency * (BM25_K1 + 1)) / denominator);

			const entry = scores.get(file) ?? {
				score: 0,
				hits: 0,
				lines: new Set<number>(),
			};
			entry.score += termScore;
			entry.hits += termFrequency;
			for (const line of lines) entry.lines.add(line);
			scores.set(file, entry);
		}
	}

	const results: RankedFile[] = [];
	for (const [file, entry] of scores) {
		let score = entry.score;
		if (demoteTestVendor && isTestOrVendor(file)) score *= TEST_VENDOR_PENALTY;
		if (demoteDocs && isDocFile(file)) score *= DOC_FILE_PENALTY;
		const connections = centrality?.get(file);
		if (connections && connections > 0) {
			score *= 1 + Math.log(1 + connections) / 4;
		}
		results.push({
			file,
			score,
			hits: entry.hits,
			lines: [...entry.lines].sort((a, b) => a - b),
		});
	}

	results.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
	return results.slice(0, Math.max(0, limit));
}

/**
 * Build a centrality map (file → importedBy count) keyed by THIS index's file
 * paths, from the project snapshot's `reverseDeps` (importedBy). The snapshot
 * keys are normalized (`normalizeMapKey(resolve(...))`) while the index keys are
 * the raw scanned paths, so the caller injects a `normalizeKey` bridge; it
 * defaults to identity for testing. Pass the result to {@link searchWordIndex}
 * as `centrality` to boost well-connected files. Kept here (not in the engine)
 * so it stays pure + unit-testable without the normalizer dependency.
 */
export function centralityFromReverseDeps(
	index: WordIndex,
	reverseDeps: Record<string, string[]> | undefined,
	normalizeKey: (file: string) => string = (file) => file,
): Map<string, number> {
	const centrality = new Map<string, number>();
	if (!reverseDeps) return centrality;
	for (const file of index.docLengths.keys()) {
		const importers = reverseDeps[normalizeKey(file)];
		if (importers && importers.length > 0) {
			centrality.set(file, importers.length);
		}
	}
	return centrality;
}

// --- Persistence (compact JSON for the project snapshot) ---------------------

export interface SerializedWordIndex {
	/** Serializer version; pre-v2 indexes lack per-file freshness metadata. */
	version: 2;
	/** Distinct file paths; postings reference files by index to shrink the JSON. */
	files: string[];
	/** token → flat [fileIdx, line, fileIdx, line, …] pairs. */
	postings: Array<[string, number[]]>;
	/** Parallel to {@link files}: indexed token count per file. */
	docLengths: number[];
	totalTokens: number;
	/** Number of files actually represented in this index. */
	indexedFileCount?: number;
	/** True when source collection reached its configured file cap. */
	truncated?: boolean;
	/** Parallel to {@link files}: mtime at which each document was tokenized. */
	fileMtimes: number[];
	/**
	 * Parallel to {@link files}: byte size at which each document was tokenized
	 * (#1105, the second axis of the mtime+size refresh gate). Optional so a
	 * pre-#1105 snapshot still parses — a missing `fileSizes` deserializes to an
	 * empty size map, which makes every file count as size-changed on the next
	 * refresh (one-time full re-read that repopulates sizes, the SAFE direction),
	 * exactly how the review graph degrades to mtime-only against a pre-#202
	 * cache. Never version-bumped for the same reason: the absence is self-healing.
	 */
	fileSizes?: number[];
	/**
	 * Forward index (#348 phase 2): `[fileIdx, [[token, lineCount], …]]` per
	 * file. Optional so pre-phase-2 snapshots parse unchanged. When ABSENT on
	 * load, {@link deserializeWordIndex} returns a `WordIndex` with `forward:
	 * undefined` — callers that want incremental per-edit updates must treat
	 * that as "no incremental primitive available" and trigger one full
	 * rebuild (never migrate an old snapshot's shape in place).
	 */
	forward?: Array<[number, Array<[string, number]>]>;
}

/** Persisted word-index serialization format version. Bump on breaking format changes. */
export const WORD_INDEX_FORMAT_VERSION = 2;

const WORD_INDEX_INT32_MAX = 2_147_483_647;
// A file id and line fit in one exact Number key through this boundary.
const WORD_INDEX_PACKED_FILE_ID_MAX = 4_194_303;

function isCanonicalWordIndexNumber(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		Number.isSafeInteger(value) &&
		!Object.is(value, -0)
	);
}

function isCanonicalWordIndexToken(token: unknown): token is string {
	return (
		typeof token === "string" &&
		token.length >= 2 &&
		token === token.toLowerCase() &&
		/^[a-z0-9_$]+$/.test(token) &&
		!STOPWORDS.has(token)
	);
}

interface SerializedWordIndexCache {
	serialized: SerializedWordIndex;
	slotByFileId: Map<number, number>;
	tokensByFile: Map<string, Set<string>>;
}

const serializedWordIndexCaches = new WeakMap<
	WordIndex,
	SerializedWordIndexCache
>();

/**
 * Deterministic work performed by the most recent {@link serializeWordIndex}
 * call: how many distinct tokens the persist pass re-flattened, and whether
 * it took the bounded incremental path or fell back to a full rebuild.
 * Test-only observability (#2202) — the incremental path's whole point is to
 * touch O(dirty-file tokens), not O(corpus tokens), and that property is a
 * deterministic count, not a wall-clock duration, so it does not flake under
 * runner load the way a same-run timing ratio does.
 */
export interface WordIndexSerializeWork {
	affectedTokenCount: number;
	tookFullPath: boolean;
}

let _lastSerializeWork: WordIndexSerializeWork | undefined;

/** Test-only: work stats for the most recent {@link serializeWordIndex} call. */
export function getLastWordIndexSerializeWork():
	| WordIndexSerializeWork
	| undefined {
	return _lastSerializeWork;
}

function serializeWordIndexFull(index: WordIndex): SerializedWordIndexCache {
	const files = [...index.docLengths.keys()];
	// `files` carries whatever spelling `docLengths` last stored, which can
	// differ from the spelling the file table interned. Both fold through
	// `wordIndexKey`, so the slot lookup runs in the folded key space and a
	// separator- or case-divergent spelling still finds its postings (#1025).
	const slotByFileId = new Map<number, number>();
	files.forEach((file, i) => {
		const fileId = index.fileTable.idFor(wordIndexKey(file));
		if (fileId !== undefined) slotByFileId.set(fileId, i);
	});

	const postings: Array<[string, number[]]> = [];
	for (const [token, list] of index.postings) {
		const flat: number[] = [];
		for (let i = 0; i < list.length; i += 1) {
			const slot = slotByFileId.get(list.fileIdAt(i));
			if (slot === undefined) continue;
			flat.push(slot, list.lineAt(i));
		}
		if (flat.length > 0) postings.push([token, flat]);
	}

	const forward: Array<[number, Array<[string, number]>]> | undefined =
		index.forward
			? files.map((file, i) => [
					i,
					[...(index.forward!.get(file)?.entries() ?? [])],
				])
			: undefined;

	const serialized: SerializedWordIndex = {
		version: WORD_INDEX_FORMAT_VERSION,
		files,
		postings,
		docLengths: files.map((file) => index.docLengths.get(file) ?? 0),
		totalTokens: index.totalTokens,
		indexedFileCount: index.docCount,
		truncated: index.truncated,
		fileMtimes: files.map((file) => index.fileMtimes.get(file) ?? 0),
		fileSizes: files.map((file) => index.fileSizes.get(file) ?? 0),
		forward,
	};
	const tokensByFile = new Map<string, Set<string>>();
	if (index.forward) {
		for (const file of files) {
			tokensByFile.set(
				wordIndexKey(file),
				new Set(index.forward.get(file)?.keys() ?? []),
			);
		}
	}
	_lastSerializeWork = {
		affectedTokenCount: postings.length,
		tookFullPath: true,
	};
	return { serialized, slotByFileId, tokensByFile };
}

/**
 * Refresh the cached wire view without walking untouched posting lanes.
 * Existing files keep their slots, so a document replacement only rebuilds
 * the token lists named by that document's old or new forward entry. A file
 * removal or reordering changes slot identity and deliberately takes the
 * bounded full path.
 */
function serializeWordIndexIncrementally(
	index: WordIndex,
	cache: SerializedWordIndexCache,
): SerializedWordIndexCache {
	const files = [...index.docLengths.keys()];
	const priorFiles = cache.serialized.files;
	const currentKeys = new Set(files.map(wordIndexKey));
	const priorKeys = new Set(priorFiles.map(wordIndexKey));
	if ([...priorKeys].some((key) => !currentKeys.has(key))) {
		return serializeWordIndexFull(index);
	}
	// Re-flattening most lanes costs more than rebuilding the compact wire view.
	// The review fixture crosses over between 10% and 100% dirty, so use the
	// midpoint as a conservative bound until a workload-specific model exists.
	const dirty = index.dirtyFiles;
	if (dirty && dirty.size * 2 > files.length) {
		return serializeWordIndexFull(index);
	}
	// A replacement deletes and re-adds a PathKeyedMap entry, which changes Map
	// insertion order. Keep the cached wire slots stable instead of rewriting
	// every posting just because one document changed order.
	const filesInWireOrder = [
		...priorFiles,
		...files.filter((file) => !priorKeys.has(wordIndexKey(file))),
	];
	if (!dirty || dirty.size === 0) {
		_lastSerializeWork = { affectedTokenCount: 0, tookFullPath: false };
		return cache;
	}

	const slotByFileId = new Map(cache.slotByFileId);
	for (let i = priorFiles.length; i < filesInWireOrder.length; i += 1) {
		const fileId = index.fileTable.idFor(wordIndexKey(filesInWireOrder[i]));
		if (fileId !== undefined) slotByFileId.set(fileId, i);
	}
	const postings = cache.serialized.postings.slice() as Array<
		[string, number[]]
	>;
	const postingAt = new Map<string, number>();
	postings.forEach(([token], i) => postingAt.set(token, i));
	const removedTokens = new Set<string>();
	const tokensByFile = new Map(cache.tokensByFile);
	const fileByKey = new Map(
		filesInWireOrder.map((file) => [wordIndexKey(file), file]),
	);
	const affectedTokens = new Set<string>();
	for (const fileKey of dirty) {
		const file = fileByKey.get(fileKey);
		const oldTokens = tokensByFile.get(fileKey) ?? new Set<string>();
		const currentEntry =
			file === undefined ? undefined : index.forward?.get(file);
		const currentTokens = new Set(currentEntry?.keys() ?? []);
		for (const token of oldTokens) affectedTokens.add(token);
		for (const token of currentTokens) affectedTokens.add(token);
		if (file === undefined) tokensByFile.delete(fileKey);
		else tokensByFile.set(fileKey, currentTokens);
	}
	for (const token of affectedTokens) {
		const list = index.postings.get(token);
		const flat: number[] = [];
		if (list) {
			for (let i = 0; i < list.length; i += 1) {
				const slot = slotByFileId.get(list.fileIdAt(i));
				if (slot !== undefined) flat.push(slot, list.lineAt(i));
			}
		}
		const at = postingAt.get(token);
		if (flat.length === 0) {
			if (at !== undefined) removedTokens.add(token);
		} else if (at === undefined) {
			postings.push([token, flat]);
			postingAt.set(token, postings.length - 1);
		} else {
			postings[at] = [postings[at][0], flat];
		}
	}
	const compactedPostings = removedTokens.size
		? postings.filter(([token]) => !removedTokens.has(token))
		: postings;
	const forward = index.forward
		? (cache.serialized.forward
				?.slice()
				.map(
					(entry) => [entry[0], entry[1]] as [number, Array<[string, number]>],
				) ?? [])
		: undefined;
	for (const fileKey of dirty) {
		const file = fileByKey.get(fileKey);
		const fileId =
			file === undefined
				? undefined
				: index.fileTable.idFor(wordIndexKey(file));
		const slot = fileId === undefined ? undefined : slotByFileId.get(fileId);
		if (slot === undefined || !forward || file === undefined) continue;
		forward[slot] = [slot, [...(index.forward?.get(file)?.entries() ?? [])]];
	}
	const serialized: SerializedWordIndex = {
		...cache.serialized,
		files: filesInWireOrder,
		postings: compactedPostings,
		docLengths: filesInWireOrder.map((file) => index.docLengths.get(file) ?? 0),
		fileMtimes: filesInWireOrder.map((file) => index.fileMtimes.get(file) ?? 0),
		fileSizes: filesInWireOrder.map((file) => index.fileSizes.get(file) ?? 0),
		forward,
		totalTokens: index.totalTokens,
		indexedFileCount: index.docCount,
		truncated: index.truncated,
	};
	_lastSerializeWork = {
		affectedTokenCount: affectedTokens.size,
		tookFullPath: false,
	};
	return { serialized, slotByFileId, tokensByFile };
}

export function serializeWordIndex(index: WordIndex): SerializedWordIndex {
	const prior = serializedWordIndexCaches.get(index);
	const cache = prior
		? serializeWordIndexIncrementally(index, prior)
		: serializeWordIndexFull(index);
	serializedWordIndexCaches.set(index, cache);
	index.dirtyFiles?.clear();
	return cache.serialized;
}

export function deserializeWordIndex(
	data: SerializedWordIndex | null | undefined,
): WordIndex | null {
	if (
		!data ||
		data.version !== WORD_INDEX_FORMAT_VERSION ||
		!Array.isArray(data.files) ||
		!Array.isArray(data.postings) ||
		!Array.isArray(data.docLengths) ||
		!Array.isArray(data.fileMtimes)
	) {
		return null;
	}
	let canonical =
		data.docLengths.length === data.files.length &&
		data.fileMtimes.length === data.files.length;
	let needsDeepSanitize = !Array.isArray(data.forward);
	if (needsDeepSanitize) canonical = false;
	const fileKeys = new Set<string>();
	for (const file of data.files) {
		if (typeof file !== "string") return null;
		const key = wordIndexKey(file);
		if (fileKeys.has(key)) {
			canonical = false;
			needsDeepSanitize = true;
		}
		fileKeys.add(key);
	}
	const docLengths = new PathKeyedMap<number>(wordIndexKey);
	// Slot i of the wire `files` array becomes file id `fileIdBySlot[i]`. Two
	// slots whose spellings fold to one key share one id, exactly as a build
	// would intern them, so a divergent snapshot cannot deserialize into two
	// posting identities for one document.
	const fileTable = new WordIndexFileTable();
	const fileIdBySlot = data.files.map((file) =>
		fileTable.intern(wordIndexKey(file), file),
	);
	const slotByFileId = new Map<number, number>();
	fileIdBySlot.forEach((fileId, slot) => {
		if (!slotByFileId.has(fileId)) slotByFileId.set(fileId, slot);
	});
	const fileMtimes = new PathKeyedMap<number>(wordIndexKey);
	const fileSizes = new PathKeyedMap<number>(wordIndexKey);
	data.files.forEach((file, i) => {
		const value = data.docLengths[i];
		if (!isCanonicalWordIndexNumber(value) || value < 0) canonical = false;
		docLengths.set(
			file,
			isCanonicalWordIndexNumber(value) && value >= 0 ? value : 0,
		);
	});
	data.files.forEach((file, i) => {
		const value = data.fileMtimes[i];
		if (typeof value !== "number" || !Number.isFinite(value)) canonical = false;
		fileMtimes.set(
			file,
			typeof value === "number" && Number.isFinite(value) ? value : 0,
		);
	});
	// #1105: `fileSizes` is optional on the wire (pre-#1105 snapshots omit it).
	// Only populate when the array is present AND parallel to `files`; otherwise
	// leave it empty so the refresh gate re-reads every file once to repopulate,
	// rather than trusting a bogus/misaligned size. Never treated as "current".
	if (
		Array.isArray(data.fileSizes) &&
		data.fileSizes.length === data.files.length
	) {
		data.files.forEach((file, i) => {
			const value = data.fileSizes?.[i];
			if (!isCanonicalWordIndexNumber(value) || value < 0) canonical = false;
			fileSizes.set(
				file,
				isCanonicalWordIndexNumber(value) && value >= 0 ? value : 0,
			);
		});
	} else {
		canonical = false;
	}

	const postings = new Map<string, WordPostingList>();
	const postingTokens = new Set<string>();
	const postingFileCounts = new Map<string, Map<number, number>>();
	for (const posting of data.postings) {
		if (!Array.isArray(posting) || posting.length !== 2) {
			canonical = false;
			needsDeepSanitize = true;
			continue;
		}
		const [token, flat] = posting;
		if (
			!isCanonicalWordIndexToken(token) ||
			postingTokens.has(token) ||
			!Array.isArray(flat) ||
			flat.length === 0 ||
			flat.length % 2 !== 0
		) {
			canonical = false;
			needsDeepSanitize = true;
			continue;
		}
		postingTokens.add(token);
		const lanes: number[] = [];
		const seenPairs = new Set<number | string>();
		const observedCounts = new Map<number, number>();
		for (let i = 0; i < flat.length; i += 2) {
			const slot = flat[i];
			const line = flat[i + 1];
			if (
				!isCanonicalWordIndexNumber(slot) ||
				slot < 0 ||
				slot >= fileIdBySlot.length ||
				!isCanonicalWordIndexNumber(line) ||
				line < 1 ||
				line > WORD_INDEX_INT32_MAX
			) {
				canonical = false;
				needsDeepSanitize = true;
				continue;
			}
			const fileId = fileIdBySlot[slot];
			const pairKey =
				fileId <= WORD_INDEX_PACKED_FILE_ID_MAX
					? fileId * (WORD_INDEX_INT32_MAX + 1) + line
					: `${fileId}:${line}`;
			if (seenPairs.has(pairKey)) {
				canonical = false;
				needsDeepSanitize = true;
			}
			seenPairs.add(pairKey);
			lanes.push(fileId, line);
			observedCounts.set(fileId, (observedCounts.get(fileId) ?? 0) + 1);
		}
		if (lanes.length === 0) continue;
		const list = WordPostingList.fromLanes(token, lanes);
		postings.set(token, list);
		postingFileCounts.set(token, observedCounts);
	}

	// Every list above was sized exactly from the wire payload, so there is no
	// growth slack to release — but the per-list `ArrayBuffer` headers are the
	// same third-of-the-store cost a fresh build pays, and a deserialized index
	// is the LONG-lived one (a warm session reuses it across turns).
	compactPostingsIntoArena(postings);

	let forward: PathKeyedMap<WordForwardEntry> | undefined;
	if (Array.isArray(data.forward)) {
		const candidate = data.files.map(() => new Map<string, number>());
		const forwardTotals = new Map<string, number>();
		if (data.forward.length !== data.files.length) canonical = false;
		if (data.forward.length !== data.files.length) needsDeepSanitize = true;
		for (const [entryIndex, entry] of data.forward.entries()) {
			if (!Array.isArray(entry) || entry.length !== 2) {
				canonical = false;
				needsDeepSanitize = true;
				continue;
			}
			const [fileIdx, tokenCounts] = entry;
			if (
				!isCanonicalWordIndexNumber(fileIdx) ||
				fileIdx !== entryIndex ||
				fileIdx < 0 ||
				fileIdx >= data.files.length ||
				!Array.isArray(tokenCounts)
			) {
				canonical = false;
				needsDeepSanitize = true;
				continue;
			}
			for (const pair of tokenCounts) {
				if (
					!Array.isArray(pair) ||
					pair.length !== 2 ||
					!isCanonicalWordIndexToken(pair[0]) ||
					!isCanonicalWordIndexNumber(pair[1]) ||
					pair[1] < 1 ||
					pair[1] > WORD_INDEX_INT32_MAX ||
					candidate[fileIdx].has(pair[0])
				) {
					canonical = false;
					needsDeepSanitize = true;
					continue;
				}
				candidate[fileIdx].set(pair[0], pair[1]);
				forwardTotals.set(pair[0], (forwardTotals.get(pair[0]) ?? 0) + pair[1]);
			}
		}
		let forwardMatchesPostings = true;
		for (const [token, list] of postings) {
			if (forwardTotals.get(token) !== list.length) {
				forwardMatchesPostings = false;
			}
			const observed = postingFileCounts.get(token);
			if (!observed) {
				forwardMatchesPostings = false;
				continue;
			}
			for (const [fileId, count] of observed) {
				const slot = slotByFileId.get(fileId);
				if (slot === undefined || candidate[slot].get(token) !== count) {
					forwardMatchesPostings = false;
				}
			}
		}
		for (const token of forwardTotals.keys()) {
			if (!postingTokens.has(token)) forwardMatchesPostings = false;
		}
		if (!forwardMatchesPostings) canonical = false;
		if (!forwardMatchesPostings) needsDeepSanitize = true;
		forward = new PathKeyedMap<WordForwardEntry>(wordIndexKey);
		for (let i = 0; i < data.files.length; i += 1) {
			forward.set(data.files[i], WordForwardEntry.fromTally(candidate[i]));
		}
	} else if (Object.prototype.hasOwnProperty.call(data, "forward")) {
		canonical = false;
		needsDeepSanitize = true;
	}
	if (needsDeepSanitize) {
		const actualForwardCounts = data.files.map(() => new Map<string, number>());
		for (const [token, list] of postings) {
			const seenPairs = new Set<string>();
			const sanitized = new WordPostingList(token, list.length);
			for (let i = 0; i < list.length; i += 1) {
				const fileId = list.fileIdAt(i);
				const line = list.lineAt(i);
				const pairKey = `${fileId}:${line}`;
				if (seenPairs.has(pairKey)) continue;
				seenPairs.add(pairKey);
				sanitized.push(fileId, line);
				const slot = slotByFileId.get(fileId);
				if (slot !== undefined) {
					const counts = actualForwardCounts[slot];
					counts.set(token, (counts.get(token) ?? 0) + 1);
				}
			}
			postings.set(token, sanitized);
		}
		compactPostingsIntoArena(postings);
		if (Array.isArray(data.forward)) {
			forward = new PathKeyedMap<WordForwardEntry>(wordIndexKey);
			for (let i = 0; i < data.files.length; i += 1) {
				const canonicalSlot = slotByFileId.get(fileIdBySlot[i]) ?? i;
				forward.set(
					data.files[i],
					WordForwardEntry.fromTally(actualForwardCounts[canonicalSlot]),
				);
			}
		}
	}
	const expectedTotalTokens = [...docLengths.values()].reduce(
		(total, length) => total + length,
		0,
	);
	const totalTokens = isCanonicalWordIndexNumber(expectedTotalTokens)
		? expectedTotalTokens
		: 0;
	if (
		!isCanonicalWordIndexNumber(data.totalTokens) ||
		data.totalTokens !== totalTokens
	) {
		canonical = false;
	}
	if (
		typeof data.indexedFileCount !== "number" ||
		data.indexedFileCount !== docLengths.size
	) {
		canonical = false;
	}
	if (typeof data.truncated !== "boolean") canonical = false;

	const index: WordIndex = {
		postings,
		fileTable,
		docLengths,
		totalTokens,
		docCount: docLengths.size,
		truncated: data.truncated === true,
		forward,
		fileMtimes,
		fileSizes,
		// Postings were just packed into one arena above, so the running gate
		// starts from the exact post-compaction store count (#2117).
		postingStoreCount: countPostingBackingStores(postings),
		recompactFlight: createSingleFlight<void>(),
		// A deserialized index is a fresh object distinct from whichever index
		// produced `data`. Without this, every per-edit dirty mark on a
		// session-start reload (#2068) is a no-op against `undefined`, and
		// serializeWordIndexIncrementally's `!dirty` branch then returns the
		// stale cached wire view forever, silently dropping every later edit
		// from the persisted snapshot.
		dirtyFiles: new Set<string>(),
	};

	// Seed the wire cache from the snapshot just loaded so the FIRST persist
	// of a reloaded session (session-start's `snapshotSaveSyncMs`, #2068) also
	// takes the bounded incremental path instead of paying a full rebuild —
	// mirrors exactly what one priming `serializeWordIndex` call would cache.
	const tokensByFile = new Map<string, Set<string>>();
	if (forward) {
		for (const file of data.files) {
			tokensByFile.set(
				wordIndexKey(file),
				new Set(forward.get(file)?.keys() ?? []),
			);
		}
	}
	if (canonical) {
		serializedWordIndexCaches.set(index, {
			serialized: data,
			slotByFileId,
			tokensByFile,
		});
	}

	return index;
}

// --- Cold-query background build trigger (#348) -------------------------------
//
// `symbol_search` (pi tool) / `pilens_symbol_search` (MCP) are stateless callers:
// no RuntimeCoordinator, no session lifecycle — just a synchronous read of the
// persisted snapshot via `symbolSearch()`. When the index is missing (e.g. the
// session-start / warmup lifecycle in runtime-session.ts hasn't run yet, or this
// is an MCP-only session that never ran pilens_session_start), the tool must
// never block the query on a project walk (#348 decision 3): it triggers a
// single background build, keyed by the resolved cwd so a burst of queries in
// the same cold window only pays for one walk, and returns immediately.

export type WordIndexBuildStatus =
	| { state: "building" }
	| { state: "refused"; reason: string }
	| { state: "failed"; reason: string };

const buildStatuses = new Map<string, WordIndexBuildStatus>();

export function getWordIndexBuildStatus(
	cwd: string,
): WordIndexBuildStatus | undefined {
	return buildStatuses.get(path.resolve(cwd));
}

/** Test-only: reset the in-flight-build guard between test files/cases. */
export function _resetWordIndexBuildGuardForTests(): void {
	buildStatuses.clear();
}

/**
 * Fire a one-time bounded background build for `cwd` if one isn't already
 * running. Persists into the existing project snapshot (preserving its other
 * fields) so the next query — or the next real session — picks it up. Errors
 * are swallowed (this is best-effort warmth, not a request the caller is
 * waiting on); the guard always clears in a `finally` so a failed build can be
 * retried by a later query.
 */
export function triggerBackgroundWordIndexBuild(
	cwd: string,
	dbg?: (msg: string) => void,
	options: { homeDir?: string } = {},
): WordIndexBuildStatus {
	const key = path.resolve(cwd);
	// #747 hardening: this trigger is the one word-index build path with NO
	// session lifecycle in front of it (cold `symbol_search` queries, in-process
	// and via MCP where cwd can be a raw tool argument) — the session-start and
	// quick-mode-warmup builds sit behind `canWarmCaches`, which already refuses
	// a home-rooted cwd. Apply the same `isAtOrAboveHomeDir` ceiling here so a
	// cold query from $HOME never starts a whole-home walk-and-read.
	if (isAtOrAboveHomeDir(key, options.homeDir)) {
		const reason = `root at/above home directory (${key})`;
		dbg?.(`word-index cold-build: skipped — ${reason}`);
		logWordIndex({
			phase: "cold_build_refused",
			cwd: key,
			trigger: "cold_query",
			reason,
		});
		const status = { state: "refused", reason } as const;
		buildStatuses.set(key, status);
		return status;
	}
	const current = buildStatuses.get(key);
	if (current?.state === "building") return current;
	const status = { state: "building" } as const;
	buildStatuses.set(key, status);
	void (async () => {
		const startMs = Date.now();
		try {
			const {
				loadProjectSnapshot,
				saveProjectSnapshot,
				PROJECT_SNAPSHOT_VERSION,
			} = await import("./project-snapshot.js");
			const docs = await collectWordIndexDocs(key);
			const index = await buildWordIndexAsync(docs);
			const existing = loadProjectSnapshot(key);
			const snapshot = existing ?? {
				version: PROJECT_SNAPSHOT_VERSION,
				projectRoot: key,
				generatedAt: new Date().toISOString(),
				seq: 0,
				files: {},
				symbols: {},
				reverseDeps: {},
				cachedExports: [],
			};
			snapshot.generatedAt = new Date().toISOString();
			snapshot.wordIndex = serializeWordIndex(index);
			saveProjectSnapshot(key, snapshot);
			dbg?.(
				`word-index cold-build: ${index.docCount} files, ${index.postings.size} tokens (${Date.now() - startMs}ms)`,
			);
			// M2, #958: durable decision/coverage record for the MCP-critical cold
			// path (this is where symbol_search reads the index and dbg is a no-op).
			logWordIndex({
				phase: "cold_build",
				cwd: key,
				trigger: "cold_query",
				durationMs: Date.now() - startMs,
				indexedFileCount: index.docCount,
				tokens: index.postings.size,
				postingEntries: countWordIndexPostingEntries(index),
				residentBytes: estimateWordIndexResidentBytes(index),
				truncated: index.truncated,
				skipped: docs.skipped,
			});
			buildStatuses.delete(key);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			buildStatuses.set(key, { state: "failed", reason });
			dbg?.(`word-index cold-build: failed: ${reason}`);
			logWordIndex({
				phase: "cold_build_failed",
				cwd: key,
				trigger: "cold_query",
				durationMs: Date.now() - startMs,
				error: reason,
			});
		}
	})();
	return status;
}

// --- Debounced per-edit persist (#348 phase 2) --------------------------------
//
// The per-edit seam (dispatch/integration.ts) updates `runtime.wordIndex` in
// memory on every write, same as the review graph's per-edit rebuild. Without
// coalescing, persisting that in-memory index on every single edit would mean
// one full-snapshot JSON.stringify+write per keystroke-adjacent edit — the
// same OOM-risking spike the graph's #260 circuit-breaker exists to prevent.
// This reuses `createDebounceScheduler` (persist-debounce.ts) rather than
// growing a second copy of the graph's bespoke pending-map+timer bookkeeping;
// only the "write" callback differs, because the target differs: the graph
// owns its own cache file, but the word index must merge into the SHARED
// project-snapshot file via `saveRuntimeProjectSnapshot`/`saveProjectSnapshot`
// (preserving unrelated snapshot fields, and honoring the seq-laundering guard
// in project-snapshot.ts — see saveRuntimeProjectSnapshot's comment).

const WORD_INDEX_PERSIST_DEBOUNCE_MS_DEFAULT = 1500;

function wordIndexPersistDebounceMs(): number {
	const raw = Number(process.env.PI_LENS_WORD_INDEX_PERSIST_DEBOUNCE_MS);
	return Number.isFinite(raw) && raw >= 0
		? raw
		: WORD_INDEX_PERSIST_DEBOUNCE_MS_DEFAULT;
}

interface PendingWordIndexPersist {
	cwd: string;
	index: WordIndex;
	dbg?: (msg: string) => void;
}

let wordIndexPersistScheduler:
	| DebounceScheduler<PendingWordIndexPersist>
	| undefined;

function getWordIndexPersistScheduler(): DebounceScheduler<PendingWordIndexPersist> {
	if (wordIndexPersistScheduler) return wordIndexPersistScheduler;
	wordIndexPersistScheduler = createDebounceScheduler<PendingWordIndexPersist>({
		debounceMs: wordIndexPersistDebounceMs,
		write(_key, pending) {
			void writeWordIndexSnapshot(pending.cwd, pending.index, pending.dbg);
		},
	});
	return wordIndexPersistScheduler;
}

async function writeWordIndexSnapshot(
	cwd: string,
	index: WordIndex,
	dbg?: (msg: string) => void,
): Promise<void> {
	const persistStartedAt = Date.now();
	try {
		const {
			loadProjectSnapshot,
			saveProjectSnapshot,
			PROJECT_SNAPSHOT_VERSION,
		} = await import("./project-snapshot.js");
		const existing = loadProjectSnapshot(cwd);
		const snapshot = existing ?? {
			version: PROJECT_SNAPSHOT_VERSION,
			projectRoot: path.resolve(cwd),
			generatedAt: new Date().toISOString(),
			seq: 0,
			files: {},
			symbols: {},
			reverseDeps: {},
			cachedExports: [],
		};
		snapshot.generatedAt = new Date().toISOString();
		const serializeStartedAt = performance.now();
		snapshot.wordIndex = serializeWordIndex(index);
		const serializeMs = performance.now() - serializeStartedAt;
		saveProjectSnapshot(cwd, snapshot);
		const writeMs = performance.now() - serializeStartedAt - serializeMs;
		dbg?.(
			`word-index persist: ${index.docCount} files, ${index.postings.size} tokens`,
		);
		// #958 review F1: durably record persist SUCCESS too, not just failures —
		// in the MCP host (`dbg` is a no-op) this is the only signal that the index
		// is actually being kept fresh across edits. Debounced (~1.5s), so not
		// spammy. Mirrors the review graph's persist_succeeded.
		logWordIndex({
			phase: "persist_succeeded",
			cwd: path.resolve(cwd),
			trigger: "per_edit",
			durationMs: Date.now() - persistStartedAt,
			serializeMs,
			writeMs,
			indexedFileCount: index.docCount,
			tokens: index.postings.size,
			postingEntries: countWordIndexPostingEntries(index),
			residentBytes: estimateWordIndexResidentBytes(index),
			replacementCount: index.replacementStats?.count ?? 0,
			totalReplacementMs: index.replacementStats?.totalMs ?? 0,
			maxReplacementMs: index.replacementStats?.maxMs ?? 0,
		});
		index.replacementStats = { count: 0, totalMs: 0, maxMs: 0 };
	} catch (err) {
		dbg?.(`word-index persist: failed: ${err}`);
		// M3, #958: a swallowed persist means every LATER symbol_search reads a
		// stale index with no trace — the exact silent-failure this durable log
		// exists to surface (dbg is a no-op in the MCP host).
		logWordIndex({
			phase: "persist_failed",
			cwd: path.resolve(cwd),
			trigger: "per_edit",
			indexedFileCount: index.docCount,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/**
 * Schedule a debounced persist of `index` for `cwd`, coalescing a burst of
 * per-edit updates into one write after a quiet window (default 1500ms,
 * override via `PI_LENS_WORD_INDEX_PERSIST_DEBOUNCE_MS`, mirroring the review
 * graph's `PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS`). Merges through the same
 * `saveProjectSnapshot` path phase 1 uses — preserves unrelated snapshot
 * fields and respects the seq-laundering guard (only ever writes wordIndex
 * for the CURRENT in-memory index, never re-stamps a stale one).
 */
export function scheduleWordIndexPersist(
	cwd: string,
	index: WordIndex,
	dbg?: (msg: string) => void,
): void {
	const key = path.resolve(cwd);
	getWordIndexPersistScheduler().schedule(key, { cwd: key, index, dbg });
}

/** Test hook: force any pending debounced word-index persist to write immediately. */
export function flushWordIndexPersistsForTests(): void {
	getWordIndexPersistScheduler().flushAll();
}
