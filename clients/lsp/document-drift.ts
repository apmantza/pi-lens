/**
 * #1783 — disk-drift backstop for open LSP documents.
 *
 * An edit made outside the tracked write/edit path (a bash-tool bulk edit)
 * never produces a `didChange`, so the language server keeps answering from
 * the content it was last given. Nothing compared disk against that content,
 * so the stale view survived for as long as the server stayed up: proven live
 * on 2026-08-20, where `src/mcp/stdio.ts` published `diagnosticCount:2` for
 * 40 minutes while `tsc` on disk reported 0.
 *
 * This module records what content actually landed on a server and, on a
 * bounded cadence, compares disk against that record.
 *
 * ## The drift key pairs mtime with size (catalog shape 6)
 *
 * Neither half is sufficient on its own:
 *
 * - Size alone misses a same-length edit (a renamed identifier, a flipped
 *   comparison) — the exact shape a bulk sed produces.
 * - An mtime comparison alone misses an edit whose tool preserves the
 *   original timestamp (`cp -p`, an archive extract, a `utimes` restore).
 *
 * The mtime half compares against `syncedAt` — the wall clock at which the
 * content landed on the server — not against a stat taken at record time.
 * That keeps the recording path free of a stat: pi-lens always syncs AFTER
 * the write it is reacting to, so `mtimeMs > syncedAt` means "disk moved
 * after we last told the server anything".
 *
 * A stat divergence is a CANDIDATE, not a verdict. The sweep then reads the
 * file and compares the content fingerprint. A touched-but-unchanged file
 * (`touch`, a formatter that rewrote identical bytes) re-stamps its record
 * and sends nothing. That preserves the changed/unchanged distinction rather
 * than laundering both into one "drifted" verdict.
 *
 * Out of scope, stated plainly: an edit that changes content, keeps the
 * length identical, AND preserves mtime is invisible to `stat`. Detecting it
 * needs a read of every tracked document on every pass, which is the cost
 * this design exists to avoid. The disk-binding contentHash on the read path
 * (`diagnostic-binding.ts`) remains the check for that case.
 *
 * ## The record is per FILE, so it must claim only full coverage
 *
 * A file can be open on several servers at once: the primary language server
 * plus the cross-cutting auxiliary scanners. One record per file therefore
 * means one claim about ALL of them. `LSPService.recordFullyCoveredSync` only
 * stamps when every server that currently holds the document was targeted by
 * the sync AND every one of those writes landed. A primary-only touch while an
 * auxiliary holds the document writes nothing, and neither does a touch where
 * one server's write timed out.
 *
 * The resync is the mirror image: it targets every live client holding the
 * document, so a heal cannot leave one view behind and then stamp the file as
 * current. On a partial sync the OLD record survives, with an older timestamp
 * and an older fingerprint, so the document stays eligible instead of going
 * invisible.
 *
 * ## The cap never evicts a document a server still holds (#4503)
 *
 * The record set is capped so a workspace sweep — one touch per project file,
 * which leaves every one of those documents open — cannot grow it without
 * bound. Evicting by insertion order alone broke the very case the backstop
 * exists for: the 513th file's stamp unbound the 1st, the server kept its
 * pre-edit view, and no record was left to compare disk against, so an
 * untracked edit to that document could never heal for the life of the
 * server.
 *
 * Eviction therefore walks insertion order and skips every record whose
 * document a live server still holds ({@link
 * DocumentDriftTrackerOptions.holdsDocument}); it drops the oldest one nobody
 * holds. When every tracked document is held, nothing is evicted and the set
 * stands above the cap, bounded by the held-document count instead of by a
 * constant. One bounded record per session names the first time that happens
 * ({@link DocumentDriftTrackerOptions.onCapOverflow}), so growth past the cap
 * stays visible. A record the sweep already proved unheld is evicted by the
 * next insert.
 *
 * ## Cost and pacing
 *
 * One `stat` per tracked document per pass, at most {@link DRIFT_CHECK_BATCH}
 * documents per pass, at most one pass per {@link driftCheckIntervalMs}. A
 * read happens only for a document whose stat already diverged.
 *
 * Resyncs are capped at {@link DRIFT_RESYNC_BATCH} per pass and run serially,
 * so a 200-file bulk edit heals in paced rounds instead of firing 200
 * concurrent `didChange` writes at one single-threaded server — the #1714
 * sweep-burst shape. Each resync goes through the caller's normal touch path,
 * so it inherits the existing per-server notify-write budget and
 * backpressure demotion rather than bypassing them.
 */

import { createHash } from "node:crypto";
import nodeFs from "node:fs";
import { nonNegativeIntEnv } from "../env-utils.js";
import { normalizeMapKey } from "../path-utils.js";
import { createSingleFlight, type SingleFlight } from "../single-flight.js";

/**
 * Whole-content fingerprint, shared by the touch debounce and this module's
 * confirmation read. It covers every character: a length + head + tail key
 * read a same-length middle edit as unchanged (#3480).
 */
export function fingerprintDocumentContent(content: string): string {
	if (content.length <= 96) return `${content.length}:${content}`;
	return `${content.length}:${createHash("sha256").update(content).digest("hex")}`;
}

/** What the server was last told, and when. */
export interface SyncedDocumentRecord {
	/** Byte length of the content that landed. The size half of the key. */
	readonly size: number;
	/** Fingerprint of that content. Confirms a stat candidate before a resync. */
	readonly fingerprint: string;
	/**
	 * The mtime half of the key compares against this.
	 *
	 * It is the moment the caller STARTED the sync, not the moment the notify
	 * write landed. The write can take up to the notify budget, and an untracked
	 * edit inside that window would be stamped as already-synchronized and stay
	 * invisible forever. Anchoring on the start — within a millisecond or two of
	 * the caller's own read of the file — narrows the blind window to the
	 * caller's read-to-sync gap, which is the smallest this design can make it
	 * without the caller passing its read timestamp down.
	 */
	readonly syncedAt: number;
}

export type DriftDisposition =
	/** Stat diverged, the content really changed, and the resync completed. */
	| "resynced"
	/** The resync was attempted and threw; the old record is kept for a retry. */
	| "failed"
	/** Stat diverged but the bytes are identical; the record was re-stamped. */
	| "unchanged"
	/** The file is gone or unreadable; the record was dropped. */
	| "vanished"
	/** No live client still holds the document; the record was dropped. */
	| "unheld"
	/** Drifted, but this pass's resync budget was already spent. */
	| "deferred";

export interface DriftSweepOptions {
	/** Skip the interval and the empty-queue rate limit. */
	force?: boolean;
	/**
	 * #4532 gap 13: check every tracked document and re-push every change, for a
	 * caller that is about to answer from the server's view. The turn-settle
	 * backstop leaves it off and keeps its per-pass caps.
	 */
	full?: boolean;
}

export interface DriftSweepResult {
	/** Documents stat'd in this pass. */
	readonly checked: number;
	/** Documents whose (size, mtime) key diverged from the synced record. */
	readonly candidates: number;
	/** Documents actually resynchronized. */
	readonly resynced: number;
	/** Resyncs that threw. The old record is kept, so a later pass retries. */
	readonly failed: number;
	/** Divergences that turned out to be identical bytes. */
	readonly unchanged: number;
	/** Divergences left for a later pass by the per-pass resync cap. */
	readonly deferred: number;
	/** Records dropped because the file no longer reads. */
	readonly vanished: number;
	/** Records dropped because no live client still holds the document. */
	readonly unheld: number;
	/** Tracked documents at the start of the pass. */
	readonly tracked: number;
	/**
	 * #3828 r3: what this pass did to each queued target it took: `resynced`,
	 * `failed` or `deferred` (still queued), `vanished` or `unheld` (dropped).
	 * A target queued after the pass took its snapshot is absent, and is still
	 * queued for the next pass.
	 */
	readonly queued: ReadonlyMap<string, DriftDisposition>;
}

const SKIPPED: DriftSweepResult = {
	checked: 0,
	candidates: 0,
	resynced: 0,
	failed: 0,
	unchanged: 0,
	deferred: 0,
	vanished: 0,
	unheld: 0,
	tracked: 0,
	queued: new Map(),
};

/** Documents stat'd per pass. Bounds the per-pass cost on a large workspace. */
export const DRIFT_CHECK_BATCH = 64;
/** Resyncs issued per pass. Paces the heal so a bulk edit cannot burst. */
export const DRIFT_RESYNC_BATCH = 4;
/**
 * Tracked-document ceiling for documents NO live server holds. A workspace
 * sweep can open far more than this, and those documents stay open, so the
 * tracked set is bounded by the max of this number and the held-document
 * count — never by this number alone (#4503).
 */
export const DRIFT_TRACK_CAP = 512;

const DEFAULT_DRIFT_CHECK_INTERVAL_MS = 10_000;

/** The pass is workspace-wide, so the single-flight registry needs one key. */
const SWEEP_KEY = "open-document-drift";

/** Minimum gap between two drift passes. Env-tunable; 0 disables the sweep. */
export function driftCheckIntervalMs(): number {
	return nonNegativeIntEnv(
		"PI_LENS_LSP_DRIFT_CHECK_MS",
		DEFAULT_DRIFT_CHECK_INTERVAL_MS,
	);
}

export interface DocumentDriftTrackerOptions {
	/**
	 * Does a live language server still hold this document open?
	 *
	 * The cap below is enforced against this answer, so a record a held
	 * document depends on is never the one evicted (#4503). A pass may answer
	 * for itself through {@link DriftSweepDeps.holdsDocument}; this is the
	 * tracker's standing answer when a pass supplies none.
	 *
	 * Omitting it means "nothing is held", which is the pre-#4503 FIFO cap: a
	 * caller that can answer must, or a held document loses its record at the
	 * cap and its stale view is never compared against disk again.
	 */
	holdsDocument?(filePath: string): boolean;
	/**
	 * Called at most once per session, when the tracked set first stands above
	 * {@link DRIFT_TRACK_CAP} because every record belongs to a held document.
	 * The population is bounded by the held-document count from there, so this
	 * is the seam that keeps that growth visible (#4503).
	 */
	onCapOverflow?(state: { tracked: number; cap: number }): void;
}

export interface DriftSweepDeps {
	/**
	 * Re-push disk content to the servers holding this document open.
	 *
	 * Returns whether every one of those views now holds this content. A push
	 * whose notify write was rejected or timed out returns `false`: the caller
	 * that owns the sync path swallows those failures to keep an edit moving, so
	 * "the call returned" is not evidence the heal happened. A `false` (or a
	 * throw) keeps the OLD record, so a later pass retries.
	 */
	resync(
		filePath: string,
		content: string,
		driftAgeMs: number,
		/** #3481: `performance.now()` taken before the sweep read `content`. */
		readStamp?: number,
		/**
		 * #3828 r3: the target was queued as a save (see `enqueueResync`). Unset
		 * for every resync the stat backstop finds on its own.
		 */
		saved?: boolean,
	): Promise<boolean>;
	/**
	 * Does a live language server still hold this document open? A record for a
	 * document nobody holds is dropped, never resynced — that is what keeps the
	 * backstop from spawning a server to correct a view that does not exist.
	 */
	holdsDocument?(filePath: string): boolean;
	/** Called once per confirmed drift, before the resync. Observability seam. */
	onDrift?(event: {
		filePath: string;
		driftAgeMs: number;
		disposition: DriftDisposition;
		syncedSize: number;
		diskSize: number;
	}): void;
	now?(): number;
	stat?(filePath: string): Promise<{ size: number; mtimeMs: number }>;
	read?(filePath: string): Promise<string>;
}

export class DocumentDriftTracker {
	/** Insertion-ordered; the sweep cursor walks it round-robin. */
	private readonly synced = new Map<string, SyncedDocumentRecord>();
	/** Whether this tracker may drop a record while its document is still held. */
	private readonly holds: ((filePath: string) => boolean) | undefined;
	private readonly onCapOverflow:
		| ((state: { tracked: number; cap: number }) => void)
		| undefined;
	/**
	 * Set by the first cap crossing of the session, so the overflow record is
	 * emitted at most once per session. {@link clear} re-arms it at the session
	 * boundary: a later crossing is the same session's answer, and a per-crossing
	 * row would grow with every sweep rather than with the session.
	 */
	private capOverflowRecorded = false;
	/**
	 * The last walk found no record it may evict, so the next insert into an
	 * over-cap set has nothing new to learn. Cleared by {@link clear}, by a pass
	 * that dropped an unheld record (see {@link evictPastCap}), and once
	 * {@link DRIFT_TRACK_CAP} inserts have gone by without a walk, so a
	 * population that grew while nobody looked is re-examined.
	 */
	private noEvictableRecord = false;
	/** Inserts that skipped the walk since the last one. */
	private skipsSinceWalk = 0;
	/**
	 * Git/external recovery targets waiting for the same paced resync budget,
	 * each with whether its push is a save (#3828 r3). The save lives and dies
	 * with the queue entry, so a deferred target keeps it and a sent one drops it.
	 */
	private readonly pendingResync = new Map<string, boolean>();
	private lastSweepAt = 0;
	private cursor = 0;
	/**
	 * At most one pass at a time (#1753's primitive). Callers fire `sweep`
	 * without awaiting it from hot paths, so an overlapping call must JOIN the
	 * running pass rather than double the stat load. One key: the pass is
	 * workspace-wide, not per file. No `generation` hook — `clear()` is called
	 * from the service reset, and a pass that settles afterwards writes into a
	 * map the reset already emptied, so there is no successor for it to evict.
	 */
	private readonly flight: SingleFlight<DriftSweepResult> =
		createSingleFlight<DriftSweepResult>();

	constructor(options: DocumentDriftTrackerOptions = {}) {
		this.holds = options.holdsDocument;
		this.onCapOverflow = options.onCapOverflow;
	}

	get size(): number {
		return this.synced.size;
	}

	peek(filePath: string): SyncedDocumentRecord | undefined {
		return this.synced.get(normalizeMapKey(filePath));
	}

	/**
	 * Queue known-open targets for the next ordinary paced drift pass.
	 * `saved` (#3828 r3): the caller wrote these bytes to disk, so the push is a
	 * save (#3405). A later enqueue without it keeps a save still queued.
	 */
	enqueueResync(
		filePaths: readonly string[],
		options: { saved?: boolean } = {},
	): void {
		for (const filePath of filePaths) {
			const key = normalizeMapKey(filePath);
			this.pendingResync.set(
				key,
				this.pendingResync.get(key) === true || options.saved === true,
			);
		}
	}

	get pendingResyncCount(): number {
		return this.pendingResync.size;
	}

	/**
	 * Record content that landed on EVERY server holding this document.
	 *
	 * The caller owns that coverage judgement — see
	 * `LSPService.recordFullyCoveredSync`. `now` is the moment the sync STARTED,
	 * not the moment its write landed; see {@link SyncedDocumentRecord.syncedAt}.
	 */
	recordSynced(
		filePath: string,
		content: string,
		now = Date.now(),
		/** #3480: the caller's already-computed fingerprint of `content`. */
		fingerprint = fingerprintDocumentContent(content),
	): void {
		const key = normalizeMapKey(filePath);
		// Delete first so a re-record moves the entry to the END of the insertion
		// order. Without this, a hot file keeps an old cursor position and the
		// eviction below would drop it while stale entries survive.
		this.synced.delete(key);
		this.synced.set(key, {
			size: Buffer.byteLength(content, "utf8"),
			fingerprint,
			syncedAt: now,
		});
		this.evictPastCap();
	}

	/**
	 * Drop the oldest record that no live server holds, and never one it does.
	 *
	 * #4503: the cap used to evict by insertion order alone. A workspace sweep
	 * stamps one record per project file in a single burst and leaves every one
	 * of those documents open, so the 513th file's stamp silently unbound the
	 * 1st: the server still held it, but no record was left to compare disk
	 * against, and an untracked edit to it could never heal.
	 *
	 * So the walk skips every record whose document is held and evicts the first
	 * one that is not. When every record is held, nothing is evicted: the set
	 * stands above the cap, bounded by the held-document count rather than by an
	 * arbitrary number. Nothing is stranded by that: a record the sweep proves
	 * unheld is dropped by the pass itself, and the next insert after a release
	 * can evict instead of skip.
	 *
	 * The walk costs one predicate call per tracked record — the predicate is a
	 * live-client map lookup — so it runs only when it can pay off:
	 * {@link noEvictableRecord} remembers a walk that found nobody to evict, and
	 * the inserts that follow skip it. That memo is sound because every record
	 * arrives for a document that just landed on a live server
	 * ({@link recordSynced} is only called under full coverage), and the one
	 * thing that makes a tracked record evictable again is a server closing the
	 * document, which the pass below discovers and drops. A document may close
	 * and go unnoticed between passes, so the memo re-arms after
	 * {@link DRIFT_TRACK_CAP} skipped inserts: the set then stands at most one
	 * cap above the held-document count the last walk saw (not the current
	 * one, which may since have dropped) instead of following churn upward.
	 */
	private evictPastCap(): void {
		if (this.synced.size <= DRIFT_TRACK_CAP) return;
		if (this.noEvictableRecord) {
			this.skipsSinceWalk += 1;
			if (this.skipsSinceWalk < DRIFT_TRACK_CAP) return;
		}
		this.skipsSinceWalk = 0;
		this.noEvictableRecord = false;
		let victim: string | undefined;
		for (const key of this.synced.keys()) {
			if (this.isHeld(key)) continue;
			victim = key;
			break;
		}
		if (victim !== undefined) {
			this.synced.delete(victim);
			return;
		}
		this.noEvictableRecord = true;
		if (this.capOverflowRecorded) return;
		this.capOverflowRecorded = true;
		this.onCapOverflow?.({
			tracked: this.synced.size,
			cap: DRIFT_TRACK_CAP,
		});
	}

	private isHeld(key: string): boolean {
		return this.holds?.(key) === true;
	}

	forget(filePath: string): void {
		this.synced.delete(normalizeMapKey(filePath));
	}

	/** Drop every record. Used on shutdown/session reset, where the server's view dies with it. */
	clear(): void {
		this.synced.clear();
		this.pendingResync.clear();
		this.cursor = 0;
		this.lastSweepAt = 0;
		this.capOverflowRecorded = false;
		this.noEvictableRecord = false;
		this.skipsSinceWalk = 0;
		this.flight.clear();
	}

	/**
	 * Stat one batch of tracked documents and resync the ones whose disk state
	 * no longer matches what the server holds.
	 *
	 * Rate-limited and single-flight: callers fire this from hot paths without
	 * awaiting it, so an overlapping call must join the running pass rather than
	 * double the stat load.
	 */
	async sweep(
		deps: DriftSweepDeps,
		options: DriftSweepOptions = {},
	): Promise<DriftSweepResult> {
		const now = deps.now ?? Date.now;
		// The rate limit and the empty check only decide whether to START a pass.
		// A caller arriving mid-pass joins it instead, which is the point of the
		// single-flight registry.
		if (!this.flight.has(SWEEP_KEY)) {
			const intervalMs = driftCheckIntervalMs();
			if (!options.force) {
				if (intervalMs === 0) return SKIPPED;
				if (now() - this.lastSweepAt < intervalMs) return SKIPPED;
			}
			// #4493: queued targets need no record (a held document whose record
			// was evicted or never stamped), so only an empty queue AND no record
			// leave nothing to do.
			if (this.synced.size === 0 && this.pendingResync.size === 0) {
				this.lastSweepAt = now();
				return SKIPPED;
			}
		}
		const full = options.full === true;
		// #4532 gap 13: a full pass must not join a capped pass already in flight,
		// which started before the caller's change and checks 64 documents. Let
		// that pass settle, then run this one. A rejection of that pass reaches
		// this caller as it would have when joining it.
		if (full && this.flight.has(SWEEP_KEY))
			await this.flight.run(SWEEP_KEY, () => this.runSweep(deps, now));
		return this.flight.run(SWEEP_KEY, () => this.runSweep(deps, now, full));
	}

	private async runSweep(
		deps: DriftSweepDeps,
		now: () => number,
		full = false,
	): Promise<DriftSweepResult> {
		this.lastSweepAt = now();
		const stat = deps.stat ?? defaultStat;
		const read = deps.read ?? defaultRead;
		// #4503: the pass may answer the holding question itself (the tests drive
		// one answer per pass); otherwise the tracker's standing answer is the one
		// the cap was already enforced against, so a pass and the eviction below
		// can never disagree about whether a record is still load-bearing.
		const holds = deps.holdsDocument ?? this.holds;
		const keys = [...this.synced.keys()];
		const tracked = keys.length;
		if (this.cursor >= tracked) this.cursor = 0;
		// A full pass checks every tracked document and re-pushes every change it
		// finds, so the per-pass caps do not apply (its window is every tracked
		// key, so the cursor lands where it started).
		const checkBatch = full ? tracked : DRIFT_CHECK_BATCH;
		const resyncBatch = full ? Number.POSITIVE_INFINITY : DRIFT_RESYNC_BATCH;
		const window: string[] = [];
		for (let i = 0; i < Math.min(checkBatch, tracked); i++) {
			window.push(keys[(this.cursor + i) % tracked] as string);
		}
		this.cursor = tracked === 0 ? 0 : (this.cursor + window.length) % tracked;

		// Drop records nobody holds BEFORE spending a stat on them.
		let unheld = 0;
		const batch: string[] = [];
		for (const key of window) {
			const record = this.synced.get(key);
			if (!record) continue;
			if (holds && !holds(key)) {
				this.synced.delete(key);
				unheld += 1;
				// A dropped record is proof that the population holds something
				// evictable again, so the next over-cap insert walks instead of
				// trusting {@link noEvictableRecord}.
				this.noEvictableRecord = false;
				this.skipsSinceWalk = 0;
				deps.onDrift?.({
					filePath: key,
					driftAgeMs: Math.max(0, now() - record.syncedAt),
					disposition: "unheld",
					syncedSize: record.size,
					diskSize: -1,
				});
				continue;
			}
			batch.push(key);
		}

		// The stats run concurrently: they are independent, and this pass is
		// already off the caller's critical path.
		const stats = await Promise.all(
			batch.map(async (key) => {
				try {
					return { key, stat: await stat(key) };
				} catch {
					return { key, stat: undefined };
				}
			}),
		);

		let candidates = 0;
		let vanished = 0;
		const drifted: Array<{
			key: string;
			record: SyncedDocumentRecord;
			mtimeMs: number;
		}> = [];
		for (const entry of stats) {
			const record = this.synced.get(entry.key);
			if (!record) continue;
			if (!entry.stat) {
				this.synced.delete(entry.key);
				vanished += 1;
				deps.onDrift?.({
					filePath: entry.key,
					driftAgeMs: Math.max(0, now() - record.syncedAt),
					disposition: "vanished",
					syncedSize: record.size,
					diskSize: -1,
				});
				continue;
			}
			// The paired key. Either half alone leaves a real edit undetected.
			const sizeMoved = entry.stat.size !== record.size;
			// `Math.floor` because the two clocks have different resolutions:
			// `stat.mtimeMs` carries a sub-millisecond fraction (…972.1006) while
			// `Date.now()` is a whole millisecond (…972). Comparing them raw makes
			// EVERY file written in the same millisecond as its sync a permanent
			// candidate — a read of that file on every pass, forever, for a
			// difference of 0.1ms. Flooring costs a blind window of at most one
			// millisecond, which is inside the read-to-sync gap this key already
			// cannot see into. Coarse filesystems (FAT 2s, HFS+ 1s) round mtime
			// DOWN, so they never produce the opposite error.
			const mtimeMoved = Math.floor(entry.stat.mtimeMs) > record.syncedAt;
			if (!sizeMoved && !mtimeMoved) continue;
			candidates += 1;
			drifted.push({
				key: entry.key,
				record,
				mtimeMs: entry.stat.mtimeMs,
			});
		}
		const queued = [...this.pendingResync.keys()];
		const queuedDispositions = new Map<string, DriftDisposition>();
		for (const key of queued) {
			if (holds && !holds(key)) {
				this.pendingResync.delete(key);
				unheld += 1;
				queuedDispositions.set(key, "unheld");
				continue;
			}
		}

		let resynced = 0;
		let failed = 0;
		let unchanged = 0;
		let deferred = 0;
		const resyncedKeys = new Set<string>();
		for (const key of queued) {
			if (!this.pendingResync.has(key)) continue;
			if (resynced >= resyncBatch) {
				deferred += 1;
				queuedDispositions.set(key, "deferred");
				deps.onDrift?.({
					filePath: key,
					driftAgeMs: 0,
					disposition: "deferred",
					syncedSize: this.synced.get(key)?.size ?? 0,
					diskSize: -1,
				});
				continue;
			}
			let content: string;
			const readStamp = performance.now();
			try {
				content = await read(key);
			} catch {
				this.pendingResync.delete(key);
				vanished += 1;
				queuedDispositions.set(key, "vanished");
				continue;
			}
			let landed = false;
			try {
				landed = await deps.resync(
					key,
					content,
					0,
					readStamp,
					this.pendingResync.get(key),
				);
			} catch {
				landed = false;
			}
			if (!landed) {
				failed += 1;
				queuedDispositions.set(key, "failed");
				deps.onDrift?.({
					filePath: key,
					driftAgeMs: 0,
					disposition: "failed",
					syncedSize: this.synced.get(key)?.size ?? 0,
					diskSize: Buffer.byteLength(content, "utf8"),
				});
				continue;
			}
			this.pendingResync.delete(key);
			resynced += 1;
			resyncedKeys.add(key);
			queuedDispositions.set(key, "resynced");
			deps.onDrift?.({
				filePath: key,
				driftAgeMs: 0,
				disposition: "resynced",
				syncedSize: this.synced.get(key)?.size ?? 0,
				diskSize: Buffer.byteLength(content, "utf8"),
			});
		}
		for (const { key, record, mtimeMs } of drifted) {
			// A Git recovery target and the ordinary stat backstop can identify the
			// same file in one pass. One event gets one resync opportunity; otherwise
			// folding Git recovery onto this scheduler double-counts the same write.
			if (resyncedKeys.has(key)) continue;
			const driftAgeMs = Math.max(0, now() - record.syncedAt);
			if (resynced >= resyncBatch) {
				// Paced, not dropped: the cursor already advanced past this file, but
				// a later pass wraps around to it. Recorded so a backlog is visible.
				deferred += 1;
				deps.onDrift?.({
					filePath: key,
					driftAgeMs,
					disposition: "deferred",
					syncedSize: record.size,
					diskSize: -1,
				});
				continue;
			}
			let content: string;
			const readStamp = performance.now();
			try {
				content = await read(key);
			} catch {
				this.synced.delete(key);
				vanished += 1;
				continue;
			}
			if (fingerprintDocumentContent(content) === record.fingerprint) {
				// Touched, not changed. Re-stamp so the next pass stops flagging it,
				// and send nothing: the server's view is already correct.
				unchanged += 1;
				this.recordSynced(key, content, settledStamp(now(), mtimeMs));
				deps.onDrift?.({
					filePath: key,
					driftAgeMs,
					disposition: "unchanged",
					syncedSize: record.size,
					diskSize: Buffer.byteLength(content, "utf8"),
				});
				continue;
			}
			// Serial on purpose. See the pacing note in this module's header.
			// The record is emitted AFTER the await, with the outcome the resync
			// actually had: emitting "resynced" up front logged a completed heal for
			// a push that then threw, which is exactly the lie a bounded record
			// exists to prevent.
			const diskSize = Buffer.byteLength(content, "utf8");
			let landed = false;
			try {
				landed = await deps.resync(key, content, driftAgeMs, readStamp);
			} catch {
				landed = false;
			}
			if (!landed) {
				// A failed resync leaves the OLD record in place, so the next pass
				// retries this file instead of recording a heal that never happened.
				failed += 1;
				deps.onDrift?.({
					filePath: key,
					driftAgeMs,
					disposition: "failed",
					syncedSize: record.size,
					diskSize,
				});
				continue;
			}
			resynced += 1;
			// Stamp AUTHORITATIVELY, over whatever the sync path recorded. The sync
			// path anchors on its own start time, which can sit BEHIND the disk mtime
			// it is reacting to — deliberately, so an edit inside the sync window is
			// still visible. Left alone, that same record makes this file a candidate
			// on every later pass: a read per pass, forever, for a heal that already
			// happened. `settledStamp` closes it against the mtime this pass actually
			// observed, so a converged file stops being re-read and only a NEWER
			// mtime reopens it.
			this.recordSynced(key, content, settledStamp(now(), mtimeMs));
			deps.onDrift?.({
				filePath: key,
				driftAgeMs,
				disposition: "resynced",
				syncedSize: record.size,
				diskSize,
			});
		}

		return {
			checked: batch.length,
			candidates,
			resynced,
			failed,
			unchanged,
			deferred,
			vanished,
			unheld,
			tracked,
			queued: queuedDispositions,
		};
	}
}

/**
 * The timestamp that settles a record against the disk state just observed.
 *
 * `Math.ceil` because `stat.mtimeMs` carries a sub-millisecond fraction that
 * `Date.now()` does not have, and `Math.max` because the clock may already be
 * past that mtime. The result is the smallest timestamp for which the drift
 * key reads "in sync" for exactly this disk state and nothing newer.
 */
function settledStamp(now: number, observedMtimeMs: number): number {
	return Math.max(now, Math.ceil(observedMtimeMs));
}

async function defaultStat(
	filePath: string,
): Promise<{ size: number; mtimeMs: number }> {
	const st = await nodeFs.promises.stat(filePath);
	return { size: st.size, mtimeMs: st.mtimeMs };
}

async function defaultRead(filePath: string): Promise<string> {
	return nodeFs.promises.readFile(filePath, "utf-8");
}
