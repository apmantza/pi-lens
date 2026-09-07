import {
	createDeadline,
	yieldIfOverBudget,
	type CooperativeDeadline,
} from "./cooperative-budget.js";

/**
 * Packed backing store for the word index's inverted postings (#2069).
 *
 * The index used to hold one boxed `{ file: string; line: number }` object per
 * (token, file, line) posting. On this repository's own 2,622-document corpus
 * that is 2.22 million objects for 17.9 MB of source: a V8 object header, a
 * pointer into the file table, and a boxed number, to carry eight bytes of
 * information. Measured resident cost was 186.6 MB, or 88.1 bytes per entry.
 *
 * The information content is a pair of small integers, and the serializer has
 * always known it: `SerializedWordIndex.postings` is
 * `[token, [fileIdx, line, fileIdx, line, …]]`. This module makes the in-memory
 * form match the wire form. {@link WordPostingList} stores those pairs in an
 * `Int32Array` — two 32-bit lanes, {@link WORD_POSTING_ENTRY_BYTES} bytes per
 * entry, no per-entry object — and {@link WordIndexFileTable} owns the dense
 * file-id space the `fileIdx` lane refers to.
 *
 * The file table is deliberately ONE structure rather than a key→path map plus
 * a parallel id list: `ids` and `paths` are two views of a single interning
 * decision, so there is nothing to keep in sync by hand. It supersedes the
 * `Map<string, string>` interning table added in #2082 and keeps that fix's
 * invariant in a stronger form — posting removal now compares an integer id
 * instead of a shared string identity, so a divergent spelling cannot survive a
 * removal even in principle.
 *
 * Kept in its own module so the representation is unit-testable without the
 * index's tokenizer, refresh, and persistence machinery around it.
 */

/**
 * Bytes of backing store per posting entry: one `fileId` lane and one `line`
 * lane, both `Int32`. This is the constant #2069's acceptance criterion is
 * memory-sample record and the regression test both read.
 */
export const WORD_POSTING_ENTRY_BYTES = 8;

/**
 * Fixed bookkeeping charged to every posting list in the byte estimate: the
 * `WordPostingList` wrapper object, its entry in the postings `Map`, and the
 * canonical token string it holds. V8 does not expose these, so this is a
 * deliberate over-estimate of the ~136 bytes they occupy on a 64-bit build with
 * pointer compression.
 *
 * Over-estimating this constant does NOT make the whole figure an upper bound,
 * and {@link estimateWordIndexStoreBytes} is explicit that it is a floor. The
 * blind spot is arena slack: a list that outgrows its slice after an edit stops
 * referring to the arena, but the arena keeps the vacated lanes alive while any
 * sibling still points into it, and nothing charges them to anyone. After a
 * full-corpus rewrite pass the estimate reads 0.58 to 0.66 of the real cost
 * (two independent measurements). Treat this constant as tightening a floor,
 * never as buying headroom.
 */
export const WORD_POSTING_LIST_OVERHEAD_BYTES = 160;

/** Entry capacity a freshly created list reserves when the caller gives no hint. */
const DEFAULT_POSTING_CAPACITY_ENTRIES = 2;

/**
 * A token's postings as packed `[fileId, line]` pairs.
 *
 * `length` counts ENTRIES, not lanes — the buffer holds `2 * length` `Int32`s
 * and may hold spare capacity beyond that.
 * {@link compactPostingsIntoArena} releases the spare and shares one backing
 * store; bulk build paths run it once at the end, so a cold index carries no
 * growth slack and one `ArrayBuffer` in total.
 */
export class WordPostingList {
	/**
	 * The `Int32Array` these postings live in. Either private to this list, or —
	 * after {@link compactPostingsIntoArena} — a SHARED arena in which this list
	 * owns the half-open lane range `[laneStart, laneStart + capacityEntries*2)`.
	 * Held as an offset rather than a `subarray` view on purpose: 37,500 views
	 * cost 2.5 MB of `JSTypedArray` headers on this repository's corpus, and two
	 * integer fields are free by comparison.
	 */
	private lanes: Int32Array;
	private laneStart = 0;
	private capacityEntries: number;
	private entryCount = 0;

	/**
	 * The canonical instance of this list’s token.
	 *
	 * The tokenizer allocates a FRESH string for every occurrence
	 * (`toLowerCase()`, `split()`), and a `Map` key is not addressable, so
	 * every structure that stores a token name would otherwise hold its own
	 * copy. The forward index does exactly that, once per (document, token):
	 * 536,978 separate strings, measured at 17 MB on this repository’s corpus.
	 * Holding the first-seen instance here gives every later writer one
	 * addressable canonical string to point at, with no second interning map
	 * to keep in step with the postings map.
	 */
	readonly token: string;

	constructor(
		token: string,
		capacityEntries = DEFAULT_POSTING_CAPACITY_ENTRIES,
	) {
		this.token = token;
		this.capacityEntries = Math.max(1, capacityEntries);
		this.lanes = new Int32Array(this.capacityEntries * 2);
	}

	/** Number of postings held. */
	get length(): number {
		return this.entryCount;
	}

	/** This list's share of backing store, its own spare capacity included. */
	get byteLength(): number {
		return this.capacityEntries * WORD_POSTING_ENTRY_BYTES;
	}

	fileIdAt(entry: number): number {
		return this.lanes[this.laneStart + entry * 2];
	}

	lineAt(entry: number): number {
		return this.lanes[this.laneStart + entry * 2 + 1];
	}

	/**
	 * Grow so at least `entries` postings fit without another reallocation. The
	 * grown store is always PRIVATE: a list that outgrows its arena slice must
	 * not write past it into the next token's postings.
	 *
	 * Returns `true` when it allocated a fresh private store, so the index can
	 * keep an O(1) running tally of distinct backing stores instead of rebuilding
	 * a `Set` over the whole vocabulary on every edit (#2117).
	 */
	reserve(entries: number): boolean {
		if (entries <= this.capacityEntries) return false;
		const grown = new Int32Array(entries * 2);
		grown.set(
			this.lanes.subarray(this.laneStart, this.laneStart + this.entryCount * 2),
		);
		this.lanes = grown;
		this.laneStart = 0;
		this.capacityEntries = entries;
		return true;
	}

	push(fileId: number, line: number): void {
		if (this.entryCount === this.capacityEntries) {
			this.reserve(
				Math.max(DEFAULT_POSTING_CAPACITY_ENTRIES, this.capacityEntries * 2),
			);
		}
		const at = this.laneStart + this.entryCount * 2;
		this.lanes[at] = fileId;
		this.lanes[at + 1] = line;
		this.entryCount += 1;
	}

	/**
	 * Re-home this list's lanes into `arena` at lane index `offset`, returning
	 * the offset past the range it now owns. Used only by
	 * {@link compactPostingsIntoArena}, which sizes the arena from the same
	 * entry counts, so the range always fits.
	 */
	adoptArena(arena: Int32Array, offset: number): number {
		const width = this.entryCount * 2;
		for (let i = 0; i < width; i += 1) {
			arena[offset + i] = this.lanes[this.laneStart + i];
		}
		this.lanes = arena;
		this.laneStart = offset;
		this.capacityEntries = this.entryCount;
		return offset + width;
	}

	/**
	 * A new list with every posting for `fileId` removed, exactly sized. Returns
	 * a fresh list rather than mutating in place because the incremental refresh
	 * stages removals off to the side and publishes them without an await, and
	 * because an untouched token's list must keep its reference identity.
	 */
	withoutFile(fileId: number): WordPostingList {
		let surviving = 0;
		for (let i = 0; i < this.entryCount; i += 1) {
			if (this.fileIdAt(i) !== fileId) surviving += 1;
		}
		const next = new WordPostingList(this.token, Math.max(1, surviving));
		for (let i = 0; i < this.entryCount; i += 1) {
			if (this.fileIdAt(i) === fileId) continue;
			next.push(this.fileIdAt(i), this.lineAt(i));
		}
		return next;
	}

	/**
	 * The backing store these lanes live in. Exposed so a memory guard can prove
	 * the arena is shared rather than inferring it from a heap delta; nothing in
	 * the index reads it.
	 */
	get backingStore(): Int32Array {
		return this.lanes;
	}

	/** Build a list from flat `[fileId, line, …]` lanes, exactly sized. */
	static fromLanes(token: string, lanes: readonly number[]): WordPostingList {
		const entries = Math.floor(lanes.length / 2);
		const list = new WordPostingList(token, Math.max(1, entries));
		for (let i = 0; i < entries; i += 1) {
			list.push(lanes[i * 2], lanes[i * 2 + 1]);
		}
		return list;
	}
}

/**
 * Re-home every posting list into ONE shared `ArrayBuffer`, exactly sized.
 *
 * A bulk build ends with ~37,500 independently allocated `Int32Array`s on this
 * repository's corpus. Each carries its own `ArrayBuffer` header, and measured
 * across the whole store that bookkeeping was 10.1 MB against 18.1 MB of actual
 * lane data — more than a third of the posting store spent on allocation
 * headers for the long tail of rare tokens. One arena plus per-token
 * `subarray` views keeps the exact same per-list API and `byteLength`, and
 * drops the header to a view without a buffer of its own.
 *
 * A later per-edit `push` that outgrows a list allocates a fresh private array
 * for that token and stops referring to the arena. The vacated slice is not
 * reclaimed while any sibling still points into the arena, so incremental
 * churn can re-fragment what a build compacted. `refreshWordIndexIncrementally`
 * recompacts after a bounded store-count threshold, using the cooperative
 * variant below so a refresh does not monopolize the event loop.
 *
 * Measured on this repository's own tree, 2,699 documents and 2,272,686
 * postings: a fresh build is 32.8 MB in ONE backing store; one full-corpus
 * rewrite pass takes it to 39.9 MB across 37,687 stores (+22%); a second pass
 * reaches 41.7 MB and the store count does not move, so the cost levels off
 * rather than compounding. Even fully churned it stays well under the 151.6 MB
 * a boxed build cost. Recompaction on a churn threshold is tracked in the
 * follow-up issue; this comment is the sizing that decision needs.
 */
export function compactPostingsIntoArena(
	postings: Map<string, WordPostingList>,
): void {
	let lanes = 0;
	for (const list of postings.values()) lanes += list.length * 2;
	if (lanes === 0) return;
	const arena = new Int32Array(lanes);
	let offset = 0;
	for (const list of postings.values()) offset = list.adoptArena(arena, offset);
}

/**
 * Cooperative counterpart for incremental refresh. It yields every work budget
 * while copying the lists, so a large corpus does not monopolize the event
 * loop, and it is safe against a concurrent synchronous edit landing during one
 * of those yields.
 *
 * The arena is sized from a snapshot taken up front. A synchronous
 * `updateWordIndexDocument` that runs during a yield can grow a not-yet-adopted
 * list or replace it wholesale. The publish loop therefore adopts a list ONLY
 * when it is still the map's current entry AND still the size the snapshot
 * charged AND still fits the space that entry reserved. A list that changed is
 * left on its own private store; the next recompaction packs it. This makes an
 * out-of-bounds `adoptArena` write structurally impossible — the earlier code
 * sized the arena once, then wrote each list's CURRENT width, so a grown list
 * overran the arena and V8 silently dropped the tail postings (#2117 review F2).
 *
 * Each `adoptArena` copies and re-homes one list within a single synchronous
 * step, so readers never observe a partially written list.
 *
 * `options.deadline` and `options.beforeYield` are a test seam only (#2293):
 * production always takes the default 8 ms wall-clock deadline. The #2117
 * regression test used to prove the "grew during a yield" invariant by racing
 * a real timer against a 40,000-list copy, which made the yield itself a
 * scheduling accident — the copy sometimes finished inside the 8 ms budget
 * and never yielded at all, so the test's own precondition went unmet under
 * load. Injecting a deadline lets a test force a yield deterministically
 * instead of hoping wall-clock crosses the budget; `beforeYield` runs
 * in-line, immediately before the real cooperative pause, so a test can
 * mutate a not-yet-adopted list at that exact point with no reliance on
 * event-loop scheduling order.
 */
export async function compactPostingsIntoArenaCooperatively(
	postings: Map<string, WordPostingList>,
	options?: {
		deadline?: CooperativeDeadline;
		beforeYield?: () => void | Promise<void>;
	},
): Promise<void> {
	// Snapshot (token, list, width) in one synchronous pass; the arena is sized
	// from these widths and only unchanged lists are adopted, so the sum of the
	// widths actually written can never exceed the arena length.
	const planned: Array<{
		token: string;
		list: WordPostingList;
		width: number;
	}> = [];
	let lanes = 0;
	for (const [token, list] of postings) {
		const width = list.length * 2;
		planned.push({ token, list, width });
		lanes += width;
	}
	if (lanes === 0) return;
	const arena = new Int32Array(lanes);
	let offset = 0;
	const deadline = options?.deadline ?? createDeadline(8);
	for (const plan of planned) {
		if (
			postings.get(plan.token) === plan.list &&
			plan.list.length * 2 === plan.width &&
			offset + plan.width <= arena.length
		) {
			offset = plan.list.adoptArena(arena, offset);
		}
		if (deadline.expired()) {
			await options?.beforeYield?.();
			await yieldIfOverBudget(deadline);
		}
	}
}

/**
 * How many distinct backing stores the posting lists are spread across. One
 * after a bulk build; it climbs by one for each token that has outgrown its
 * arena slice since. Exists for the memory guard in
 * `tests/clients/word-index-posting-memory.test.ts`.
 */
export function countPostingBackingStores(
	postings: Map<string, WordPostingList>,
): number {
	const stores = new Set<Int32Array>();
	for (const list of postings.values()) stores.add(list.backingStore);
	return stores.size;
}

/**
 * The minimum a word index must expose to be censused. Declared structurally
 * so `memory-sampler.ts` can read it without importing the word-index module
 * graph (`fs`, the source filter, the persist scheduler) purely to get two
 * numbers.
 */
export interface WordIndexStore {
	postings: Map<string, WordPostingList>;
	forward?: { values(): IterableIterator<WordForwardEntry> };
}

/** Total posting entries across every token. O(distinct tokens). */
export function countPostingEntries(store: WordIndexStore): number {
	let count = 0;
	for (const list of store.postings.values()) count += list.length;
	return count;
}

/**
 * Estimated resident bytes of the two packed stores — postings and the forward
 * index — backing stores plus fixed per-list headers. O(distinct tokens +
 * documents): no posting or forward ELEMENT is read, so this is safe on the
 * memory-sample hot path.
 *
 * It deliberately excludes the token strings, the path-keyed metadata maps, and
 * the `Map` spines, which together measured 2.5 MB against 63 MB of packed
 * store on this repository's own corpus. Distinct backing stores are charged
 * once, including abandoned arena slack. The figure remains a floor on the
 * index's cost because object and map overhead stay unrepresented.
 */
export function estimateWordIndexStoreBytes(store: WordIndexStore): number {
	let bytes = 0;
	const backingStores = new Set<Int32Array>();
	for (const list of store.postings.values()) {
		backingStores.add(list.backingStore);
		bytes += WORD_POSTING_LIST_OVERHEAD_BYTES;
	}
	for (const backingStore of backingStores) bytes += backingStore.byteLength;
	for (const entry of store.forward?.values() ?? []) {
		bytes += entry.estimatedBytes;
	}
	return bytes;
}

/**
 * One document's forward entry: token → distinct-line count, packed.
 *
 * The forward index mirrors what the postings hold for a file, so it has the
 * same per-element shape and the same cost profile. On this repository's corpus
 * it is 536,600 entries across 2,677 `Map<string, number>` instances, measured
 * at 35.1 MB — larger than the packed posting store it mirrors, and enough on
 * its own to keep the index above #2069's 40 MB ceiling. Packing it into a
 * shared token-name array plus an `Int32Array` of counts costs the same eight
 * bytes per entry as a posting, and the token strings are the SAME objects the
 * postings map already keys on, so nothing is duplicated.
 *
 * Read-only by construction: a document's forward entry is built once from the
 * tokenizer's tally and replaced wholesale on the next edit, which is also what
 * lets an untouched document's entry keep its reference identity across an
 * unrelated update.
 */
export class WordForwardEntry {
	private constructor(
		private readonly tokenNames: string[],
		private readonly lineCounts: Int32Array,
	) {}

	/** Distinct tokens recorded for this document. */
	get size(): number {
		return this.tokenNames.length;
	}

	/**
	 * Distinct-line count for `token`, or `undefined`. Linear in the document's
	 * token count: the hot paths iterate this entry, they do not probe it, so a
	 * hash table would cost 40 bytes an entry to serve lookups nobody makes.
	 */
	get(token: string): number | undefined {
		const at = this.tokenNames.indexOf(token);
		return at === -1 ? undefined : this.lineCounts[at];
	}

	keys(): IterableIterator<string> {
		return this.tokenNames[Symbol.iterator]();
	}

	*entries(): IterableIterator<[string, number]> {
		for (let i = 0; i < this.tokenNames.length; i += 1) {
			yield [this.tokenNames[i], this.lineCounts[i]];
		}
	}

	[Symbol.iterator](): IterableIterator<[string, number]> {
		return this.entries();
	}

	/** Estimated resident bytes: packed lanes plus fixed headers. */
	get estimatedBytes(): number {
		return (
			this.tokenNames.length * WORD_FORWARD_ENTRY_BYTES +
			WORD_POSTING_LIST_OVERHEAD_BYTES
		);
	}

	/** Pack a tokenizer tally. Insertion order is preserved. */
	static fromTally(tally: Map<string, number>): WordForwardEntry {
		const tokenNames: string[] = [];
		tokenNames.length = tally.size;
		const lineCounts = new Int32Array(tally.size);
		let i = 0;
		for (const [token, count] of tally) {
			tokenNames[i] = token;
			lineCounts[i] = count;
			i += 1;
		}
		return new WordForwardEntry(tokenNames, lineCounts);
	}
}

/**
 * Bytes per forward entry: one pointer-compressed slot for the shared token
 * string and one `Int32` count lane.
 */
const WORD_FORWARD_ENTRY_BYTES = 8;

/**
 * The word index's dense file-id space: canonical path key → integer id →
 * display path.
 *
 * Ids are recycled. A per-edit document replacement removes the document and
 * re-adds it, so a table that only ever appended would grow one string slot per
 * edit — bounded on entry count while growing on the id axis, the shape
 * AGENTS.md catalogs at #9. {@link release} is only ever called after every
 * posting naming that id has been removed (the forward index enumerates them),
 * so a recycled id can never alias a surviving posting.
 */
export class WordIndexFileTable {
	private readonly idByKey = new Map<string, number>();
	private readonly pathById: Array<string | undefined> = [];
	private readonly freeIds: number[] = [];

	/** Live file count. */
	get size(): number {
		return this.idByKey.size;
	}

	/** Width of the id space, live plus recycled. Bounded growth is the point. */
	get idSpaceWidth(): number {
		return this.pathById.length;
	}

	/**
	 * Id for `key`, allocating one on first sight. First writer wins on the
	 * display path, matching the interning the boxed representation had: a
	 * second walk spelling of the same file reuses the first spelling's id and
	 * does not re-write the stored display path.
	 */
	intern(key: string, displayPath: string): number {
		const existing = this.idByKey.get(key);
		if (existing !== undefined) return existing;
		const id = this.freeIds.pop() ?? this.pathById.length;
		this.pathById[id] = displayPath;
		this.idByKey.set(key, id);
		return id;
	}

	idFor(key: string): number | undefined {
		return this.idByKey.get(key);
	}

	pathFor(id: number): string | undefined {
		return this.pathById[id];
	}

	/** Drop `key` and recycle its id. Returns the freed id, or `undefined`. */
	release(key: string): number | undefined {
		const id = this.idByKey.get(key);
		if (id === undefined) return undefined;
		this.idByKey.delete(key);
		this.pathById[id] = undefined;
		this.freeIds.push(id);
		return id;
	}
}
