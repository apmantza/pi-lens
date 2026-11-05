import { BoundedLruCache, BoundedSet } from "../bounded-cache.js";
import { normalizeMapKey } from "../path-utils.js";

// #2243 item 4 telemetry sink, INJECTED rather than imported. fact-store must
// stay an import leaf: `degradation-ledger` pulls
// `process-singletons → git-tracked-ignore → safe-spawn`, and `safe-spawn`
// imports `degradation-ledger` back, so a direct import here re-enters that
// cycle and, under vitest's mock hoisting, deadlocks module init with a
// "Cannot access 'safeSpawnAsync' before initialization" TDZ. integration.ts
// owns the store and already sits above that cycle, so it wires this to
// `recordDegradationOnce`. Unset (a plain LRU with no telemetry) is a safe
// no-op for the scanner's local store and for tests that never load dispatch.
// #2243 review round 3 (F1): SIX production FactStore instances share this one
// module-scope reporter slot (dispatch/integration.ts, mcp/analyze.ts,
// lens-map.ts, project-diagnostics/scanner.ts, runtime-session.ts's
// session-start call-graph task, mcp/cli.ts). A constant subject collapsed
// their eviction records into one: runtime-session's session-start
// review-graph walk — which runs before any dispatch and floods a store with
// every file in the project — consumed the once-per-session ledger slot, and
// the dispatch store's OWN eviction (the one that actually risks a live
// read-back mid-dispatch) never got its own record. The reporter now carries
// the evicting store's `subject`, so `recordDegradationOnce`'s own
// kind+subject dedupe key discriminates by store — each store gets its own
// once-per-session record.
export type CapacityEvictionReporter = (
	subject: string,
	axis: "count" | "bytes" | "pinned-over-budget" | "session-count",
	reason: string,
) => void;
let capacityEvictionReporter: CapacityEvictionReporter | undefined;

export function setFactStoreEvictionReporter(
	reporter: CapacityEvictionReporter | undefined,
): void {
	capacityEvictionReporter = reporter;
}

export function getFactStoreEvictionReporter():
	| CapacityEvictionReporter
	| undefined {
	return capacityEvictionReporter;
}

// #2240: the dispatch store is module-scope in integration.ts, so it lives for
// the whole process, and a review-graph project walk seeds facts for EVERY file
// it visits. Nothing removed an entry except the next dispatch of that same
// path, so a several-hundred-file batch retained one entry per distinct path
// until the heap ran out. Bound the record count the way widget-state.ts bounds
// its file records.
const MAX_FILE_FACT_RECORDS = 1024;
// Keep enough content for 1024 typical source files averaging 64 KiB, while
// preventing a small number of generated or vendored files from retaining
// hundreds of MiB for the process lifetime (#2247).
const MAX_FILE_FACT_CONTENT_BYTES = 64 * 1024 * 1024;
// Pinned records are exempt from capacity eviction. A dispatch reads its
// file's facts back after the runner groups settle (`file.content` misses read as
// empty content, not as "re-derive"), and the fire-and-forget blast-radius
// build runs a whole-project walk against the SAME store meanwhile — plain LRU
// recency would let that walk evict the file being dispatched. Every other holder
// re-derives an evicted fact from disk.
//
// #2243 item 2: a dispatch pins its file at start (`clearFileFactsFor`) and
// releases it at completion (`endDispatchFor`, in the dispatch's finally). The
// pin set therefore tracks dispatches actually IN FLIGHT, not the last N files
// touched.

// #2282: `sessionFacts` below is a flat `Map<factId, value>` shared by two
// unrelated fact shapes — a small FIXED vocabulary (tool availability keyed by
// command, the singleton "session.reviewGraph") and PER-FILE families that
// mint one key per file touched (session baseline, cascade baseline, review-
// graph entity snapshots) and never shrink. Only the second shape grows with
// batch size, so only it gets a bound; the fixed vocabulary stays on the plain
// map, unbounded, because its cardinality is small and stable. Per-file
// session facts opt into `boundedSessionFacts` instead, reusing fileFacts'
// LRU-count-cap-and-report discipline rather than adding a third mechanism.
// No pin exemption here (unlike fileFacts): every current per-file session
// fact is read once near dispatch start and written once at dispatch end, so
// nothing re-reads its OWN key later in the same dispatch the way a runner
// re-reads `file.content` — an eviction mid-batch only means the next dispatch
// of that path sees no previous baseline, the same safe state as its first
// ever dispatch this session.
//
// That equivalence holds only where an absent baseline means "report
// everything", which is true for the diagnostic baselines and false for the
// review-graph entity snapshot: there, an absent snapshot read as an empty one
// puts every symbol in `added` and drives a blast-radius run for a file that
// did not change. So an eviction leaves a tombstone, and a reader that needs
// the distinction asks `wasBoundedSessionFactEvicted`. Tombstones are keys
// only, and carry the same cap, so the coldest of them fall off in turn and
// that key reverts to first-dispatch semantics.
//
// Up to five per-file keys are minted per dispatched file today (diagnostic
// baseline, cascade baseline, the #4483 pre-edit linter seed of a file the
// tool_call captured, entity snapshot, changed symbols), so 4096 records
// covers roughly 820 distinct files before the coldest file's baseline starts
// degrading. An evicted seed leaves the delta baseline alone in charge, which
// already holds the file's old findings after its first dispatch.
export const MAX_SESSION_FACT_RECORDS = 4096;

export interface ReadonlyFactStore {
	getFileFact<T>(filePath: string, factId: string): T | undefined;
	hasFileFact(filePath: string, factId: string): boolean;
	getSessionFact<T>(factId: string): T | undefined;
	hasSessionFact(factId: string): boolean;
}

export class FactStore implements ReadonlyFactStore {
	// Insertion order is eviction order: the oldest-used record is evicted first.
	private readonly fileFacts = new Map<string, Map<string, unknown>>();
	private readonly sessionFacts = new Map<string, unknown>();
	// Bounded sibling of `sessionFacts` for per-file-keyed session facts (#2282).
	// True LRU: every fetch (get or create, see getBoundedSessionFact) refreshes
	// recency, so the oldest-UNUSED record is evicted first, not merely the
	// oldest-inserted.
	private readonly boundedSessionFacts = new BoundedLruCache<string, unknown>(
		MAX_SESSION_FACT_RECORDS,
	);
	// Keys evicted from `boundedSessionFacts` and not written since, so a reader
	// can tell "evicted" from "never seen" (#2282). Same cap, same FIFO order —
	// the cap lives in `BoundedSet.add`'s own overflow rather than in a
	// hand-rolled tombstone trim here (#4580 review F1).
	private readonly evictedSessionFactKeys = new BoundedSet<string>(
		MAX_SESSION_FACT_RECORDS,
	);
	// Pin refcount per file. A file is exempt from capacity eviction while its
	// count is > 0. Refcounted, not a Set, so two overlapping dispatches of the
	// same file both hold the pin until BOTH settle (#2243 item 2).
	private readonly pinnedFiles = new Map<string, number>();
	// Running UTF-8 byte total for file.content only. Maintaining it at every
	// mutation keeps getFileFact/setFileFact O(1) amortized; never scan the map
	// to decide whether the byte budget is exceeded.
	private retainedContentBytes = 0;
	// Subset of retainedContentBytes held by currently pinned files (#2247
	// review F2). Maintained incrementally the same way — a scan over
	// `pinnedFiles` looks small in isolation, but `evictColdFileFacts` calls it
	// on EVERY unpinned insert for as long as pinned bytes stay over budget, so
	// a scan there would re-walk a large pinned file's full string on every
	// single write admitted during that window. Keeping a running total avoids
	// reintroducing exactly the scan `retainedContentBytes` exists to avoid.
	private pinnedContentBytesTotal = 0;

	/**
	 * @param subject Discriminates this store's capacity-eviction telemetry
	 *   from every other production FactStore's (#2243 review round 3, F1).
	 *   Production callers pass a label naming the store (e.g. `"dispatch"`,
	 *   `"runtime-session-call-graph"`); the default is only for call sites
	 *   that never wired a reporter and tests that don't care.
	 */
	constructor(private readonly subject: string = "session-fact-store") {}

	// All file-keyed methods normalize the path internally via normalizeMapKey().
	// Callers always pass raw/resolved paths — normalization is not their concern.

	getFileFact<T>(filePath: string, factId: string): T | undefined {
		return this.touchFileFacts(normalizeMapKey(filePath))?.get(factId) as
			| T
			| undefined;
	}

	setFileFact(filePath: string, factId: string, value: unknown): void {
		const key = normalizeMapKey(filePath);
		let facts = this.touchFileFacts(key);
		if (!facts) {
			facts = new Map();
			this.fileFacts.set(key, facts);
		}
		if (factId === "file.content") {
			const delta =
				this.contentBytes(value) - this.contentBytes(facts.get(factId));
			this.retainedContentBytes += delta;
			if (this.pinnedFiles.has(key)) this.pinnedContentBytesTotal += delta;
		}
		facts.set(factId, value);
		this.evictColdFileFacts();
	}

	hasFileFact(filePath: string, factId: string): boolean {
		return this.fileFacts.get(normalizeMapKey(filePath))?.has(factId) ?? false;
	}

	/** Drop one file fact without disturbing the file's derived facts.
	 *  Removes the per-file entry too when the deleted fact was its last value. */
	deleteFileFact(filePath: string, factId: string): void {
		const key = normalizeMapKey(filePath);
		const facts = this.fileFacts.get(key);
		if (!facts) return;
		if (factId === "file.content") {
			const dropped = this.contentBytes(facts.get(factId));
			this.retainedContentBytes -= dropped;
			if (this.pinnedFiles.has(key)) this.pinnedContentBytesTotal -= dropped;
		}
		facts.delete(factId);
		if (facts.size === 0) this.fileFacts.delete(key);
	}

	/** Clear facts for one specific file only, and mark the file's dispatch as
	 *  begun. Use at the start of each per-file dispatch call.
	 *  Preserves facts for other files computed in the same turn.
	 *  Normalizes filePath internally — callers pass raw paths.
	 *  Pins the file against capacity eviction until the matching
	 *  {@link endDispatchFor} runs in the dispatch's settle path (#2243 item 2).
	 *  Every `clearFileFactsFor` MUST be paired with an `endDispatchFor`. */
	clearFileFactsFor(filePath: string): void {
		const key = normalizeMapKey(filePath);
		this.deleteFileFactsRecord(key);
		this.pinFile(key);
	}

	/** Pin a file against capacity eviction for the duration of a dispatch,
	 *  WITHOUT clearing its existing facts. Pairs with {@link endDispatchFor}
	 *  exactly like {@link clearFileFactsFor} does.
	 *
	 *  #2243 review round 3 (F5): `clearFileFactsFor`'s clear+re-derive is
	 *  right for a dispatch driven by a fresh edit, but the debounced
	 *  ast-grep warning scan runs ~2s AFTER the inline dispatch for that same
	 *  edit already re-derived every fact for this exact file — a second
	 *  clear there bought nothing but ~51ms of redundant re-parsing across
	 *  all five providers (measured; a warm-cache read is ~1ms). Use this
	 *  where the facts are very likely already fresh: `runProviders` still
	 *  re-derives any fact this file is missing (a genuine miss, e.g. the
	 *  fact was evicted meanwhile), so a read never depends on staleness. */
	beginDispatchFor(filePath: string): void {
		this.pinFile(normalizeMapKey(filePath));
	}

	/** Release the pin a {@link clearFileFactsFor} or {@link beginDispatchFor}
	 *  took for one file's dispatch. Call once per matching call, from the
	 *  dispatch's finally/settle path, so the pin set tracks dispatches
	 *  actually in flight rather than the last N files touched (#2243 item 2). */
	endDispatchFor(filePath: string): void {
		this.unpinFile(normalizeMapKey(filePath));
		this.evictColdFileFacts();
	}

	/** Clear one file's facts WITHOUT pinning. For sequential single-store scans
	 *  (project-diagnostics) that own their store and race no concurrent walk:
	 *  pinning there would exempt every scanned file from the capacity cap and
	 *  defeat it. Normalizes filePath internally. */
	dropFileFacts(filePath: string): void {
		this.deleteFileFactsRecord(normalizeMapKey(filePath));
	}

	/** LRU touch: re-inserting an existing record moves it to the end of the
	 *  eviction order, so a record still in use is not the next victim. */
	private touchFileFacts(key: string): Map<string, unknown> | undefined {
		const facts = this.fileFacts.get(key);
		if (!facts) return undefined;
		this.fileFacts.delete(key);
		this.fileFacts.set(key, facts);
		return facts;
	}

	private pinFile(key: string): void {
		const count = this.pinnedFiles.get(key) ?? 0;
		// Transition from unpinned to pinned: this file's content joins the
		// pinned subset. A refcount bump past 1 (an already-pinned file, two
		// overlapping dispatches) does not — it is already counted.
		if (count === 0) {
			this.pinnedContentBytesTotal += this.contentBytes(
				this.fileFacts.get(key)?.get("file.content"),
			);
		}
		this.pinnedFiles.set(key, count + 1);
	}

	private unpinFile(key: string): void {
		const count = this.pinnedFiles.get(key);
		if (count === undefined) return;
		if (count <= 1) {
			this.pinnedFiles.delete(key);
			// Transition from pinned to unpinned: this file's content leaves the
			// pinned subset.
			this.pinnedContentBytesTotal -= this.contentBytes(
				this.fileFacts.get(key)?.get("file.content"),
			);
		} else {
			this.pinnedFiles.set(key, count - 1);
		}
	}

	/** Drop least-recently-used records past either cap, skipping the files whose
	 *  dispatch pinned them. Pinned content counts toward the byte total, but is
	 *  never evicted before endDispatchFor. Pins survive until clearAll.
	 *
	 *  #2247 review F2: a leaked (or several overlapping) pin(s) can put pinned
	 *  bytes over budget ON THEIR OWN. Evicting every unpinned record can never
	 *  bring the total back under budget in that state — before this guard, the
	 *  loop below evicted each newly inserted unpinned record on the very next
	 *  call (it was always the sole remaining unpinned key), so unpinned writes
	 *  never retained anything: a silent, permanent collapse for the rest of
	 *  the process. Once byte pressure is unpinned-bytes-driven-only, stop
	 *  evicting and admit unpinned inserts as-is — best-effort under pin
	 *  pressure — and record the state distinctly so it is visible instead of
	 *  inferred from "the store stopped retaining anything". */
	private evictColdFileFacts(): void {
		if (!this.overCapacity()) return;
		for (const key of this.fileFacts.keys()) {
			if (this.pinnedFiles.has(key)) continue;
			const axis = this.capacityAxis();
			if (
				axis === "bytes" &&
				this.pinnedContentBytesTotal > MAX_FILE_FACT_CONTENT_BYTES
			) {
				this.reportPinnedOverBudget();
				return;
			}
			this.deleteFileFactsRecord(key);
			this.reportCapacityEviction(key, axis);
			if (!this.overCapacity()) return;
		}
	}

	private overCapacity(): boolean {
		return (
			this.fileFacts.size > MAX_FILE_FACT_RECORDS ||
			this.retainedContentBytes > MAX_FILE_FACT_CONTENT_BYTES
		);
	}

	private capacityAxis(): "count" | "bytes" {
		return this.fileFacts.size > MAX_FILE_FACT_RECORDS ? "count" : "bytes";
	}

	private contentBytes(value: unknown): number {
		return typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0;
	}

	private deleteFileFactsRecord(key: string): void {
		const facts = this.fileFacts.get(key);
		if (!facts) return;
		const dropped = this.contentBytes(facts.get("file.content"));
		this.retainedContentBytes -= dropped;
		if (this.pinnedFiles.has(key)) this.pinnedContentBytesTotal -= dropped;
		this.fileFacts.delete(key);
	}

	// #2243 item 4: the cap silently drops a fact a live dispatch may read back
	// as "" (dispatcher.ts reads `file.content` with `?? ""`). Emit through the
	// injected reporter so the drop is visible in the ledger instead of being
	// inferred from a downstream symptom. integration.ts routes this to
	// `recordDegradationOnce` keyed on THIS store's `subject` (#2243 review
	// round 3, F1), so the ledger's own per-kind+subject dedupe yields exactly
	// ONE record per session PER STORE (re-arming at session_start when the
	// ledger resets) — no latch or generation compare here, so fact-store
	// keeps no session-scoped state to forget to re-arm.
	private reportCapacityEviction(
		evictedKey: string,
		axis: "count" | "bytes",
	): void {
		capacityEvictionReporter?.(
			this.subject,
			axis,
			axis === "count"
				? `file-fact store axis=count exceeded ${MAX_FILE_FACT_RECORDS} records; evicted least-recently-used fact for ${evictedKey}`
				: `file-fact store axis=bytes exceeded ${MAX_FILE_FACT_CONTENT_BYTES} retained content bytes; evicted least-recently-used fact for ${evictedKey}`,
		);
	}

	// #2247 review F2: pinned bytes alone exceeding budget is not an eviction —
	// nothing is dropped — so it is reported through a distinct axis rather
	// than reusing `reportCapacityEviction`'s "evicted least-recently-used
	// fact for X" language, which would misdescribe what happened.
	private reportPinnedOverBudget(): void {
		const pinnedBytes = this.pinnedContentBytesTotal;
		capacityEvictionReporter?.(
			this.subject,
			"pinned-over-budget",
			`file-fact store pinned content bytes (${pinnedBytes}) exceed the ` +
				`${MAX_FILE_FACT_CONTENT_BYTES}-byte budget; unpinned inserts are ` +
				`admitted without eviction until a pin releases`,
		);
	}

	/** Running UTF-8 byte total for retained `file.content` values. Exposed so
	 *  tests can crosscheck it against a fresh sum over retained records
	 *  (#2247 review F3) — the running total is maintained incrementally on
	 *  every insert/delete path rather than recomputed, so a subtraction
	 *  dropped from one of those paths would otherwise drift silently. */
	getRetainedContentBytes(): number {
		return this.retainedContentBytes;
	}

	/** Running UTF-8 byte total for the pinned SUBSET of retained
	 *  `file.content` values. Exposed so tests can crosscheck it against a
	 *  fresh sum over `pinnedFiles ∩ fileFacts` (#2247 review F4) — like
	 *  `retainedContentBytes`, it is maintained incrementally on the pin
	 *  0→1 transition, the unpin 1→0 transition, content overwrite/delete,
	 *  and `clearAll`, so a drop from any one of those paths would
	 *  otherwise drift silently instead of failing loudly. */
	getPinnedContentBytes(): number {
		return this.pinnedContentBytesTotal;
	}

	getSessionFact<T>(factId: string): T | undefined {
		return this.sessionFacts.get(factId) as T | undefined;
	}

	setSessionFact(factId: string, value: unknown): void {
		this.sessionFacts.set(factId, value);
	}

	hasSessionFact(factId: string): boolean {
		return this.sessionFacts.has(factId);
	}

	/** Bounded counterpart to {@link getSessionFact} for per-file-keyed session
	 *  facts (#2282) — session baselines, cascade baselines, review-graph entity
	 *  snapshots. LRU touch: a read moves the record off the eviction end. */
	getBoundedSessionFact<T>(factId: string): T | undefined {
		if (!this.boundedSessionFacts.has(factId)) return undefined;
		return this.boundedSessionFacts.get(factId) as T;
	}

	/** Bounded counterpart to {@link setSessionFact}. Callers use this instead
	 *  of `setSessionFact` for any family that mints one key per file/entity
	 *  touched, so the store's count stays bounded across a large batch instead
	 *  of retaining one entry per distinct path for the process lifetime. */
	setBoundedSessionFact(factId: string, value: unknown): void {
		this.evictedSessionFactKeys.delete(factId);
		const evicted = this.boundedSessionFacts.set(factId, value);
		for (const [oldestKey] of evicted) {
			this.evictedSessionFactKeys.add(oldestKey);
			capacityEvictionReporter?.(
				this.subject,
				"session-count",
				`session-fact store axis=count exceeded ${MAX_SESSION_FACT_RECORDS} records; evicted least-recently-used fact for ${oldestKey}`,
			);
		}
	}

	hasBoundedSessionFact(factId: string): boolean {
		return this.boundedSessionFacts.has(factId);
	}

	/** True when this key held a bounded session fact that capacity eviction
	 *  dropped and nothing has rewritten since (#2282). Readers whose "absent"
	 *  branch is not a safe default — the review-graph entity snapshot, where
	 *  absent would read as "every symbol is new" — use this to tell an evicted
	 *  key from one this session has never seen. */
	wasBoundedSessionFactEvicted(factId: string): boolean {
		return this.evictedSessionFactKeys.has(factId);
	}

	/** O(1) entry count for memory-attribution sampling (#2282 Observability):
	 *  the fixed-vocabulary map plus the bounded per-file map, so a caller gets
	 *  this store's whole `sessionFacts` footprint in one number. */
	getSessionFactEntryCount(): number {
		return this.sessionFacts.size + this.boundedSessionFacts.size;
	}

	/** Call on session reset only. Clears everything including tool cache and baselines. */
	clearAll(): void {
		this.fileFacts.clear();
		this.sessionFacts.clear();
		this.boundedSessionFacts.clear();
		this.evictedSessionFactKeys.clear();
		this.pinnedFiles.clear();
		this.retainedContentBytes = 0;
		this.pinnedContentBytesTotal = 0;
	}
}
