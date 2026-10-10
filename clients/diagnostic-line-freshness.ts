/**
 * Past-EOF validity gate for cited diagnostic line numbers (#1641).
 *
 * A live session served diagnostics at lines 407-410 of a file that was 402
 * lines on disk and UNMODIFIED — the LSP's in-memory document had drifted
 * longer than disk without any file write happening (no didChange lost, just
 * an in-memory buffer that grew past what the file actually contains). That
 * makes this a DIFFERENT invariant than #1622/#1627's freshness gate: those
 * compare a cited file's MTIME against a scan timestamp, which says nothing
 * when the file was never touched on disk at all. The cheap, orthogonal check
 * available here is structural: a diagnostic whose start line exceeds the
 * file's CURRENT line count cannot possibly be describing current content,
 * regardless of what any timestamp says.
 *
 * CONTRACT:
 *   - A diagnostic citing a line beyond the file's current line count is
 *     DEMOTED (`stale: true`), never dropped — the underlying issue may well
 *     still be real, just at a coordinate this gate can no longer vouch for.
 *   - RE-ARMS, never latches: the verdict is recomputed from the gate's own
 *     inputs (current mtime, current line count) on every call, so a
 *     TRANSIENT shrink (truncate-then-write, a formatter pass, a checkout)
 *     that later restores the line un-demotes on its own next read. A
 *     persisted `stale: true` a caller stores between calls is a cache of the
 *     last-derived verdict, never an independent source of truth that
 *     overrides the next derivation — the #1633-V1 lesson: derive, don't latch.
 *   - Fail open: a file that cannot be stat'ed/read, or exceeds the size gate,
 *     yields no verdict at all (every diagnostic passes through unchanged).
 *     An unreadable/oversized file is not evidence of anything; demoting on
 *     it would manufacture false staleness.
 *   - The line count matches the LSP's own addressing, not `wc -l`: a
 *     document with N newline characters has N+1 ADDRESSABLE lines (the
 *     line after the final `\n`, or the single line of an empty document,
 *     is a real position a server can anchor a diagnostic to — e.g. TS1005
 *     "'}' expected" at EOF). `WidgetDiagnostic.line` is always
 *     `range.start.line + 1` from that same addressing, so the gate must
 *     use it too or every trailing-newline file demotes its own valid EOF
 *     diagnostics.
 *   - Cost discipline: one `statSync` per served file; the file's newlines
 *     are counted in bounded chunks via a raw fd read (never a full
 *     `readFileSync` — no whole-file string materialization, no per-render
 *     re-read of unchanged content), gated by a byte-size cap matching
 *     `captureReadContentBinding`'s precedent (`read-guard.ts`). The count is
 *     memoized in a small SHARED cache (module-scoped, bounded, evicted FIFO
 *     past a cap), keyed on BOTH mtime AND size (review round V1) — mtime
 *     ALONE is not a reliable cache key on hosts where its resolution is
 *     coarser than back-to-back writes: a truncate-then-write, a formatter
 *     write-back, or pi-lens's own auto-format immediately followed by the
 *     agent's write can land two DIFFERENT contents on the identical
 *     `mtimeMs`, and a mtime-only cache serves the first content's count for
 *     the second — measured live at 207/300 shrink/restore cycles. Requiring
 *     both to match narrows a same-tick collision to same-mtime-AND-same-size
 *     (which a shrink/restore cycle never produces, since the whole point is
 *     the size changed). A changed file is always recounted. Tests can still
 *     inject an isolated {@link LineCountCache} via {@link createLineCountCache}
 *     to avoid cross-test bleed.
 *   - On a demotion EDGE (a diagnostic that was not already flagged past-EOF
 *     and now is), best-effort trigger a document resync (didClose/didOpen or
 *     a full-sync didChange) so the desync HEALS instead of re-serving the
 *     same stale verdict next time (#1631's resync-before-revalidate rule).
 *     Resync is fire-and-forget: a failure here must never block or fail the
 *     render path that discovered the drift. Already-demoted entries and the
 *     healing direction never re-trigger a resync — only the rising edge does.
 */
import * as fs from "node:fs";
import { BoundedFifoMap } from "./bounded-cache.js";
import { logLatency } from "./latency-logger.js";
import { toProjectRelativePath } from "./path-utils.js";
import { STALE_LINE_MARKER } from "./stale-marker.js";

/** Marker rendered in place of a demoted diagnostic's now-untrustworthy line.
 * Shares the base `STALE_LINE_MARKER` vocabulary with sibling freshness
 * gates (#1622/#1633) and adds this gate's own specific reason as a suffix. */
export const PAST_EOF_STALE_MARKER = `${STALE_LINE_MARKER} — line past EOF`;

/** How many demoted cited lines a single record names before it stops. */
const MAX_LOGGED_PAST_EOF_LINES = 3;

/** Byte-size gate matching `captureReadContentBinding`'s precedent
 * (`clients/read-guard.ts`'s `READ_BINDING_MAX_BYTES`) — a hot render/serve
 * path must never pay to scan an unbounded file. */
const MAX_GATE_BYTES = 4 * 1024 * 1024;

/** Chunk size for the bounded newline scan — small enough to keep one read's
 * memory footprint negligible, large enough that a multi-MB file finishes in
 * single-digit reads rather than thousands. */
const NEWLINE_SCAN_CHUNK_BYTES = 64 * 1024;
const NEWLINE_BYTE = 0x0a;

interface LineCountCacheEntry {
	mtimeMs: number;
	/**
	 * Byte size at the time `lineCount` was computed. Required alongside
	 * `mtimeMs` for a cache HIT (review round V1): mtime resolution on this
	 * host is coarse enough (~1ms) that two writes in the same tick —
	 * truncate-then-write, a formatter write-back, a checkout, pi-lens's own
	 * auto-format immediately followed by the agent's write — can land on the
	 * IDENTICAL `mtimeMs` while the content differs. Measured live: 207/300
	 * shrink/restore cycles served the wrong line count keyed on mtime alone,
	 * including a first-read-of-cycle returning a stale count for an 11-line
	 * file. `size` is cheap (already on the same `fs.Stats` the mtime came
	 * from) and, combined with mtime, makes a same-tick same-size DIFFERENT-
	 * content collision the only residual gap — astronomically narrower than
	 * mtime alone, and not the shape any of this gate's real inputs produce
	 * (a shrink/restore cycle always changes size).
	 */
	size: number;
	lineCount: number;
}

/**
 * Memo for {@link getCachedLineCount}, mtime-keyed so a stale entry is never
 * trusted: every lookup re-stats the file and only reuses the memo when the
 * stat's mtime still matches what the entry was computed against. A caller
 * that wants full isolation (tests) can create its own with
 * {@link createLineCountCache}; production call sites use the shared default.
 */
// Structural, not `Map` itself: the shared default is bounded (below), while
// {@link createLineCountCache}'s test-isolated instances stay plain, unbounded
// `Map`s — both satisfy this narrow surface.
export interface LineCountCache {
	get(filePath: string): LineCountCacheEntry | undefined;
	has(filePath: string): boolean;
	// `void`, not the concrete return type: TypeScript's void-return
	// assignability rule accepts BOTH implementations (`Map#set` returns
	// `this`, `BoundedFifoMap#set` returns the evicted pairs) while telling
	// every caller the result is not theirs to read. `unknown` here tripped
	// the repo's own `no-unknown-returns` ast-grep self-scan, which fails the
	// whole Unit-tests step (#2442 review F1).
	set(filePath: string, entry: LineCountCacheEntry): void;
	readonly size: number;
	clear(): void;
}

/** Test-only isolation seam. Production code uses the shared default cache. */
export function createLineCountCache(): LineCountCache {
	return new Map();
}

// Shared across calls/render passes so N files touched once per session cost
// N recounts total, not N per render — the actual fix for the cost this gate
// exists to control. Still cannot go stale: every read re-stats first and a
// mismatched mtime always recomputes (see the module doc comment). Bounded
// via FIFO eviction (mirrors `READ_GUARD_MAX_FILES`'s precedent) so a long
// session's file count cannot grow this without limit.
export const MAX_SHARED_CACHE_ENTRIES = 512;
const sharedLineCountCache: LineCountCache = new BoundedFifoMap<
	string,
	LineCountCacheEntry
>(MAX_SHARED_CACHE_ENTRIES);

function rememberInSharedCache(
	cache: LineCountCache,
	filePath: string,
	entry: LineCountCacheEntry,
): void {
	// `cache` is either the shared BoundedFifoMap (bounds itself on `set`) or a
	// test-isolated plain `Map` (unbounded by design) — either way, this is
	// just a write.
	cache.set(filePath, entry);
}

/** Test-only: drop the shared memo between test files/cases. */
export function _resetSharedLineCountCacheForTests(): void {
	sharedLineCountCache.clear();
}

/**
 * Test-only: seed the shared memo with a fabricated entry, deterministically
 * proving a cache HIT (and that the default cache used by callers with no
 * explicit `lineCountCache` is genuinely shared across calls) without relying
 * on a real write's mtime round-tripping through `fs.utimesSync` at full
 * precision — a platform-specific hazard on its own, unrelated to what such a
 * test is actually verifying.
 */
export function _seedSharedLineCountCacheForTests(
	filePath: string,
	entry: LineCountCacheEntry,
): void {
	sharedLineCountCache.set(filePath, entry);
}

/** #2442 test-only: membership check that bypasses the real-stat requirement
 *  `getCachedLineCount` imposes on every call — proves capacity eviction
 *  directly, without needing 513 real files on disk. */
export function _sharedLineCountCacheHasForTests(filePath: string): boolean {
	return sharedLineCountCache.has(filePath);
}

/**
 * Count newline bytes in `filePath` via bounded raw reads — never a full
 * `readFileSync`/UTF-8 decode of the whole file. `0x0A` (LF) never appears as
 * a continuation byte in UTF-8, so counting it at the byte level is exact
 * regardless of encoding, and multi-byte characters spanning a chunk boundary
 * cannot produce a false match (a continuation byte's high bits can never
 * equal `0x0A`).
 */
function countNewlinesChunked(filePath: string, sizeBytes: number): number {
	const fd = fs.openSync(filePath, "r");
	try {
		const buffer = Buffer.allocUnsafe(
			Math.min(NEWLINE_SCAN_CHUNK_BYTES, sizeBytes) || 1,
		);
		let newlineCount = 0;
		let position = 0;
		while (position < sizeBytes) {
			const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position);
			if (bytesRead <= 0) break;
			for (let i = 0; i < bytesRead; i++) {
				if (buffer[i] === NEWLINE_BYTE) newlineCount++;
			}
			position += bytesRead;
		}
		return newlineCount;
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * LSP-addressable line count for `filePath`: newline count + 1, matching
 * `range.start.line + 1` (a document with zero newlines still has one
 * addressable line — position 0,0 — and a trailing `\n` adds one more,
 * empty, addressable line after it). Memoized in `cache` (the shared default
 * unless a caller injects its own) and invalidated by mtime AND size (V1 —
 * mtime alone is not a reliable cache key on hosts where its resolution is
 * coarser than back-to-back writes). Returns `undefined` when the file
 * cannot be stat'ed, is zero bytes, exceeds the byte-size gate, or
 * cannot be read (deleted, unreadable, permissions, oversized) — callers MUST
 * treat `undefined` as "no verdict", not as "zero lines" (the empty-result-
 * must-distinguish-clean-from-errored screen).
 */
export function getCachedLineCount(
	filePath: string,
	cache: LineCountCache = sharedLineCountCache,
): number | undefined {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(filePath);
	} catch {
		return undefined;
	}
	// A zero-byte stat can be a truncate-then-write window. It is not evidence
	// that the file has one addressable line, so fail open like an unreadable
	// file rather than manufacturing a verdict from the empty read.
	if (stat.size === 0) return undefined;
	const cached = cache.get(filePath);
	if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
		return cached.lineCount;
	}
	if (stat.size > MAX_GATE_BYTES) return undefined;
	let newlineCount: number;
	try {
		newlineCount = countNewlinesChunked(filePath, stat.size);
	} catch {
		return undefined;
	}
	const lineCount = newlineCount + 1;
	rememberInSharedCache(cache, filePath, {
		mtimeMs: stat.mtimeMs,
		size: stat.size,
		lineCount,
	});
	return lineCount;
}

/** The minimal shape this gate needs from a rendered diagnostic. */
export interface PastEofDiagnosticLike {
	/** 1-based cited line, as stored on `WidgetDiagnostic`. */
	line?: number;
	/** Demotion marker, shared with sibling freshness gates. RE-DERIVED on
	 * every call from the current line count — never trusted as a latch. */
	stale?: boolean;
	/** Which gate demoted this entry. This gate owns only "past-eof" (and
	 * legacy entries with no reason): an entry another gate demoted (e.g.
	 * #1631's "dependency-drift") is passed through untouched, so re-deriving
	 * the past-EOF verdict cannot un-demote a sibling gate's finding. */
	staleReason?: string;
}

export interface PastEofGateResult<T> {
	diagnostics: T[];
	demotedCount: number;
}

/**
 * Recompute the past-EOF verdict for every diagnostic in `diagnostics`
 * against `filePath`'s CURRENT line count. Sets `stale: true` on a match and
 * `stale: false` when a previously-past-EOF line is back in bounds (a
 * transient shrink healed) — the verdict is always derived fresh, never
 * latched. Pure apart from the cached stat/read in {@link getCachedLineCount}
 * and the bounded `logLatency`/`resync` calls, which fire only on a RISING
 * edge (a diagnostic that was not already flagged and now is) so an
 * unchanged persistent demotion doesn't re-log or re-resync on every render.
 * Never throws, never mutates the input array.
 */
export function demotePastEofDiagnostics<
	T extends PastEofDiagnosticLike,
>(args: {
	/** Serving surface name as it appears in telemetry, e.g. `"lens_diagnostics"`. */
	store: string;
	cwd: string;
	filePath: string;
	diagnostics: readonly T[];
	/** Defaults to the shared, mtime-invalidated cache. Inject an isolated one in tests. */
	lineCountCache?: LineCountCache;
	resync?: (filePath: string) => void;
}): PastEofGateResult<T> {
	const { diagnostics } = args;
	if (diagnostics.length === 0) {
		return { diagnostics: [], demotedCount: 0 };
	}
	const lineCount = getCachedLineCount(
		args.filePath,
		args.lineCountCache ?? sharedLineCountCache,
	);
	if (lineCount === undefined) {
		// Fail open: no verdict available for this file right now. Leave
		// whatever `stale` value each entry already carries untouched — this
		// gate has nothing to say either direction.
		return { diagnostics: [...diagnostics], demotedCount: 0 };
	}
	const risingEdgeLines: number[] = [];
	const out = diagnostics.map((d) => {
		// Another gate's demotion is not this gate's to heal (#1631 drift
		// entries have in-bounds lines; re-deriving here would clear them).
		if (d.stale && d.staleReason !== undefined && d.staleReason !== "past-eof")
			return d;
		const isPastEof = typeof d.line === "number" && d.line > lineCount;
		if (isPastEof === !!d.stale) return d; // no transition either direction
		if (isPastEof) risingEdgeLines.push(d.line as number);
		return {
			...d,
			stale: isPastEof,
			staleReason: isPastEof ? "past-eof" : undefined,
		};
	});
	if (risingEdgeLines.length === 0) {
		return { diagnostics: out, demotedCount: 0 };
	}
	let sizeBytes: number;
	try {
		sizeBytes = fs.statSync(args.filePath).size;
	} catch {
		sizeBytes = 0;
	}
	logLatency({
		type: "phase",
		phase: "diagnostic_past_eof",
		filePath: args.cwd,
		durationMs: 0,
		metadata: {
			store: args.store,
			file: toProjectRelativePath(args.filePath, args.cwd),
			sizeBytes,
			actualLineCount: lineCount,
			demotedCount: risingEdgeLines.length,
			sampleCitedLines: risingEdgeLines.slice(0, MAX_LOGGED_PAST_EOF_LINES),
		},
	});
	if (args.resync) {
		try {
			args.resync(args.filePath);
		} catch {
			// Best-effort — a resync failure must never fail the render path.
		}
	}
	return { diagnostics: out, demotedCount: risingEdgeLines.length };
}

/**
 * Default resync trigger (#1641 criterion 2): re-open the file with its
 * CURRENT disk content so the LSP's in-memory document is replaced rather
 * than left to re-publish the same divergent diagnostics next time
 * (`LSPService.openFile` sends a full-sync didChange, or a didClose/didOpen
 * pair for servers that only re-scan on a fresh open — see
 * `handleNotifyOpen`'s `reopenOnResync` branch). Dynamic import (mirrors
 * `clients/module-report-lsp.ts`) so this module — used from widget-state.ts
 * and tools/lens-diagnostics.ts — never statically depends on `clients/lsp`,
 * which itself imports widget-state.ts.
 *
 * Fire-and-forget by design: the caller is a synchronous render path and must
 * not block on (or fail because of) a resync. No LSP service, no client for
 * this file's language, or a transient read/spawn failure all degrade to a
 * silent no-op — the next successful touch/dispatch resyncs anyway.
 */
export function resyncDocumentOnPastEof(filePath: string): void {
	void (async () => {
		try {
			const [{ getOwnedLspService }, content] = await Promise.all([
				import("./lsp/service-singleton.js"),
				fs.promises.readFile(filePath, "utf-8"),
			]);
			await getOwnedLspService<{
				openFile: (
					filePath: string,
					content: string,
					options: { preserveDiagnostics: boolean },
				) => Promise<unknown>;
			}>().openFile(filePath, content, { preserveDiagnostics: false });
		} catch {
			// Best-effort heal only.
		}
	})();
}
