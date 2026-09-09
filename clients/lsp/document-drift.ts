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

import nodeFs from "node:fs";
import { normalizeMapKey } from "../path-utils.js";
import { createSingleFlight, type SingleFlight } from "../single-flight.js";

/** Cheap content fingerprint. Same shape as the touch-debounce fingerprint. */
export function fingerprintDocumentContent(content: string): string {
	if (content.length <= 96) return `${content.length}:${content}`;
	return `${content.length}:${content.slice(0, 48)}:${content.slice(-48)}`;
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

type DriftDisposition =
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
};

/** Documents stat'd per pass. Bounds the per-pass cost on a large workspace. */
const DRIFT_CHECK_BATCH = 64;
/** Resyncs issued per pass. Paces the heal so a bulk edit cannot burst. */
export const DRIFT_RESYNC_BATCH = 4;
/** Tracked-document ceiling. A workspace sweep can open far more than this. */
export const DRIFT_TRACK_CAP = 512;

const DEFAULT_DRIFT_CHECK_INTERVAL_MS = 10_000;

/** The pass is workspace-wide, so the single-flight registry needs one key. */
const SWEEP_KEY = "open-document-drift";

/** Minimum gap between two drift passes. Env-tunable; 0 disables the sweep. */
export function driftCheckIntervalMs(): number {
	const raw = Number(process.env.PI_LENS_LSP_DRIFT_CHECK_MS);
	if (!Number.isFinite(raw) || raw < 0) return DEFAULT_DRIFT_CHECK_INTERVAL_MS;
	return Math.floor(raw);
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
	/** Git/external recovery targets waiting for the same paced resync budget. */
	private readonly pendingResync = new Set<string>();
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

	get size(): number {
		return this.synced.size;
	}

	peek(filePath: string): SyncedDocumentRecord | undefined {
		return this.synced.get(normalizeMapKey(filePath));
	}

	/** Queue known-open targets for the next ordinary paced drift pass. */
	enqueueResync(filePaths: readonly string[]): void {
		for (const filePath of filePaths) {
			this.pendingResync.add(normalizeMapKey(filePath));
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
	recordSynced(filePath: string, content: string, now = Date.now()): void {
		const key = normalizeMapKey(filePath);
		// Delete first so a re-record moves the entry to the END of the insertion
		// order. Without this, a hot file keeps an old cursor position and the
		// eviction below would drop it while stale entries survive.
		this.synced.delete(key);
		this.synced.set(key, {
			size: Buffer.byteLength(content, "utf8"),
			fingerprint: fingerprintDocumentContent(content),
			syncedAt: now,
		});
		while (this.synced.size > DRIFT_TRACK_CAP) {
			const oldest = this.synced.keys().next();
			if (oldest.done) break;
			this.synced.delete(oldest.value);
		}
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
		options: { force?: boolean } = {},
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
			if (this.synced.size === 0) {
				this.lastSweepAt = now();
				return SKIPPED;
			}
		}
		return this.flight.run(SWEEP_KEY, () => this.runSweep(deps, now));
	}

	private async runSweep(
		deps: DriftSweepDeps,
		now: () => number,
	): Promise<DriftSweepResult> {
		this.lastSweepAt = now();
		const stat = deps.stat ?? defaultStat;
		const read = deps.read ?? defaultRead;
		const keys = [...this.synced.keys()];
		const tracked = keys.length;
		if (this.cursor >= tracked) this.cursor = 0;
		const window: string[] = [];
		for (let i = 0; i < Math.min(DRIFT_CHECK_BATCH, tracked); i++) {
			window.push(keys[(this.cursor + i) % tracked] as string);
		}
		this.cursor = (this.cursor + window.length) % tracked;

		// Drop records nobody holds BEFORE spending a stat on them.
		let unheld = 0;
		const batch: string[] = [];
		for (const key of window) {
			const record = this.synced.get(key);
			if (!record) continue;
			if (deps.holdsDocument && !deps.holdsDocument(key)) {
				this.synced.delete(key);
				unheld += 1;
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
		const queued = [...this.pendingResync];
		for (const key of queued) {
			if (deps.holdsDocument && !deps.holdsDocument(key)) {
				this.pendingResync.delete(key);
				unheld += 1;
				continue;
			}
		}

		let resynced = 0;
		let failed = 0;
		let unchanged = 0;
		let deferred = 0;
		for (const key of queued) {
			if (!this.pendingResync.has(key)) continue;
			if (resynced >= DRIFT_RESYNC_BATCH) {
				deferred += 1;
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
			try {
				content = await read(key);
			} catch {
				this.pendingResync.delete(key);
				vanished += 1;
				continue;
			}
			let landed = false;
			try {
				landed = await deps.resync(key, content, 0);
			} catch {
				landed = false;
			}
			if (!landed) {
				failed += 1;
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
			deps.onDrift?.({
				filePath: key,
				driftAgeMs: 0,
				disposition: "resynced",
				syncedSize: this.synced.get(key)?.size ?? 0,
				diskSize: Buffer.byteLength(content, "utf8"),
			});
		}
		for (const { key, record, mtimeMs } of drifted) {
			const driftAgeMs = Math.max(0, now() - record.syncedAt);
			if (resynced >= DRIFT_RESYNC_BATCH) {
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
				landed = await deps.resync(key, content, driftAgeMs);
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
