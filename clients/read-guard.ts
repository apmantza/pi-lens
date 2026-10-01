/**
 * Read-Before-Edit Guard for pi-lens
 *
 * Blocks edits that lack adequate prior reading:
 * 1. Zero-read edit: never read this file in this branch
 * 2. File modified since read: disk content changed (FileTime)
 * 3. Out-of-range edit: edit target not covered by any previous read
 * 4. LSP expansion exemption: single-line read expanded to full symbol counts
 *
 * Falls back safely when LSP is unavailable.
 */

import * as fs from "node:fs";
import { incrementDegradationCount } from "./degradation-ledger.js";
import { createFileTime, type FileTime } from "./file-time.js";
import { hashDiagnosticContent } from "./lsp/diagnostic-binding.js";
import { normalizeEphemeralMapKey, normalizeFilePath } from "./path-utils.js";
import { logReadGuardEvent } from "./read-guard-logger.js";
import { beginScope, moveBranch, type SessionScope } from "./session-scope.js";

// --- Types ---

export interface ReadRecord {
	filePath: string;
	// What the agent *asked* for
	requestedOffset: number;
	requestedLimit: number;
	// What pi-lens *delivered* (after LSP expansion, if any)
	effectiveOffset: number;
	effectiveLimit: number;
	expandedByLsp: boolean;
	enclosingSymbol?: {
		name: string;
		kind: string;
		startLine: number;
		endLine: number;
	};
	/** 1-indexed line → content hash captured at read time, used to ignore no-op mtime staleness. */
	lineHashes?: Record<number, string>;
	contentBinding?: ReadContentBinding;
	/**
	 * Set when the record came from a search hit rather than a real read (#1904).
	 * States how many context lines were credited around the hit and why, so the
	 * ledger shows whether coverage rests on lines the model saw or on slack.
	 */
	searchCredit?: SearchCredit;
	turnIndex: number;
	writeIndex: number;
	timestamp: number;
	/**
	 * Provenance tag. Absent (undefined) = recorded by the normal internal
	 * tool-call path. `"bridge:<consumer>"` = recorded via the cross-extension
	 * read-recording bridge with the given consumer identifier.
	 */
	source?: string;
	/** A requested native-read range that has not been confirmed as delivered. */
	provisional?: boolean;
	/**
	 * The host tool call whose result carried this evidence into the
	 * conversation (#3521), in `resolveToolCallCorrelationId` form. After a
	 * conversation move (`/tree`, `/fork`, `/clone`, resume) a record is kept
	 * only when this call's `toolResult` is on the new branch; a record without
	 * one (a bridge read, a host that sends no id) is dropped there.
	 */
	toolCallId?: string;
}

/**
 * Why a search-hit read credited the lines it did.
 *  - `match-lines-only`: bare hit; only the printed match lines are credited.
 *  - `delivered-context-flags`: the search command printed context (grep
 *    `-A`/`-B`/`-C`), so those lines were delivered and are credited.
 *  - `caller-margin`: the caller asked for explicit extra slack.
 */
export type SearchCreditReason =
	| "match-lines-only"
	| "delivered-context-flags"
	| "caller-margin";

interface SearchCredit {
	marginBefore: number;
	marginAfter: number;
	reason: SearchCreditReason;
}

/**
 * The caller's actual handling of a range-snapshot verdict (#1904 item 1).
 *  - `enforced-block`: the verdict blocked the edit.
 *  - `bypassed-content-match`: the verdict said block, but the caller passed
 *    `skipSnapshotCheck` because the edit was content-validated (oldText).
 *  - `enforced-pass`: a hash-checked read matched, so the edit passed the gate.
 *  - `not-decidable`: no candidate read could be hash-checked.
 */
type RangeSnapshotOutcome =
	| "enforced-block"
	| "bypassed-content-match"
	| "enforced-pass"
	| "not-decidable";

export interface ReadContentBinding {
	hash: string;
	fullFile: boolean;
	offset: number;
	limit: number;
}

export interface EditRecord {
	filePath: string;
	/**
	 * Host tool name. Widened from `"write" | "edit"` in #2423 so a third-party
	 * mutating tool is recorded under its own name instead of being relabelled.
	 */
	tool: string;
	touchedLines: [start: number, end: number];
	precedingReads: ReadRecord[];
	verdict: "allowed" | "blocked" | "warned";
	reason?: string;
	timestamp: number;
}

export interface ReadGuardVerdict {
	action: "allow" | "block" | "warn";
	reason?: string;
	details?: {
		editRange: [number, number];
		readRanges: Array<{ start: number; end: number }>;
		symbolRanges: Array<{ name: string; start: number; end: number }>;
		snapshot?: {
			status: "match" | "mismatch" | "unavailable";
			mismatchedLines: number[];
			missingLines: number[];
		};
		/** Content-verified new location of a range that drifted since it was read. */
		relocation?: {
			from: [number, number];
			to: [number, number];
		};
	};
	/**
	 * Set when a single-range edit's target drifted but its content is verified
	 * (by read-time line hashes) to live uniquely at a new line range. The host
	 * adapter may shift the edit's range to `to` and let it proceed instead of
	 * blocking — the same content-verified auto-apply pi-hashline-readmap does.
	 * Only present for single-range edits (multi-range stays a hint).
	 */
	relocation?: {
		from: [number, number];
		to: [number, number];
	};
}

export interface ReadGuardConfig {
	enabled: boolean;
	mode: "block" | "warn" | "off";
	contextLines: number;
	exemptions: Array<{
		pattern: string;
		mode: "allow" | "warn" | "block";
	}>;
}

/**
 * Serializable snapshot of the guard's read-set (#1041). The in-memory `reads`
 * map is process-bound, so a `pi --session <id>` resume — which resets the
 * runtime to a fresh empty guard — used to falsely `zero_read`-block the first
 * edit of any file the prior session had read. Persisting `reads` on the SAME
 * #190 `PersistedSessionState` path that widget diagnostics ride lets a resumed
 * session rehydrate its read history. Only `reads` is persisted: edits/written
 * markers are re-derivable and `reads` is the payload that gates `checkEdit`.
 * Keys are `normalizeFilePath` form (see {@link ReadGuard.key}) so the round
 * trip re-folds identically on Windows/Linux.
 */
export interface PersistedReadGuardState {
	version: number;
	reads: Array<[string, ReadRecord[]]>;
}

/** A session's authorship ({@link ReadGuard.exportAuthorship}), keys in `normalizeFilePath` form. */
export interface PersistedReadGuardAuthorship {
	written: string[];
	sessionStartMs: number;
}

/**
 * 2 since #3521: records carry `toolCallId`. A version-1 sidecar has no ids
 * to match against the branch, so it loads as no reads (one re-read).
 */
export const READ_GUARD_STATE_VERSION = 2;

// --- Constants ---

const DEFAULT_CONFIG: ReadGuardConfig = {
	enabled: true,
	mode: "block",
	contextLines: 3,
	exemptions: [
		{ pattern: "*.md", mode: "warn" },
		{ pattern: "*.txt", mode: "allow" },
		{ pattern: "*.log", mode: "allow" },
	],
};

/** Avoid hashing very large reads in the hot path. */
const READ_HASH_MAX_LINES = Math.max(
	0,
	Number.parseInt(
		process.env.PI_LENS_READ_GUARD_HASH_MAX_LINES ?? "3000",
		10,
	) || 3000,
);

/**
 * Content bindings are defense in depth on a read-adjacent hot path. Cap the
 * synchronous disk read so bridge registration never hashes an unbounded file.
 */
const READ_BINDING_MAX_BYTES = 4 * 1024 * 1024;
const READ_GUARD_MAX_FILES = 256;
/**
 * #1904 item 3: `enforceFileCap` bounds how many FILES the store holds, not how
 * many records each file holds. One hot file reached 268 hash-bearing records in
 * 75 minutes, and every record carries a `lineHashes` map, so a long session on
 * a few files grows without bound. Cap records per file and drop oldest-first.
 *
 * Eviction is safe in the blocking direction: it narrows the staleness-rescue
 * path — a stale edit rescued by an older snapshot that still matches — and can
 * turn an allow into a "re-read and retry" block. It never turns a block into
 * an allow. See `enforceRecordCapForFile` for which records go first, and why
 * age alone is the wrong order.
 */
const READ_GUARD_MAX_RECORDS_PER_FILE = 128;

/**
 * Session-lifetime running totals for one file's record-cap trims (#1913
 * review F1). Owned per-`ReadGuard`-instance, so it re-arms automatically at
 * `session_start` along with `this.reads`/`this.edits` — no separate reset to
 * wire and forget. Queryable via `getTrimStats` even after logging stops
 * re-emitting (see `recordRead`'s trim block).
 */
export interface FileTrimStats {
	totalEvicted: number;
	evictedCreditCount: number;
	evictedGenuineCount: number;
	trimEventCount: number;
}

/**
 * Trim a single file's read list to the per-file cap. Returns how many records
 * were dropped so the ledger can show the trim.
 *
 * Eviction is NOT purely by age. The shape that overflows this cap is
 * read-once-then-grep-often: one whole-file read followed by hundreds of cheap
 * search credits. Pure age order evicts that whole-file read first, and it is
 * the record `canIgnoreStalenessByHashes` needs to rescue an edit after an
 * unrelated mtime touch. So spend the search credits first, oldest among them
 * first, and only fall through to genuine reads when the credits run out.
 * Genuine reads are then evicted oldest-first as before.
 *
 * Records are trimmed IN PLACE: `EditRecord.precedingReads` holds a reference
 * to this same array, so a replacement array would silently detach it.
 */
interface RecordCapTrimResult {
	evictedCount: number;
	/** Of `evictedCount`, how many were search-credit records (spent first). */
	evictedCreditCount: number;
	/** Of `evictedCount`, how many were genuine (non-credit) reads. */
	evictedGenuineCount: number;
}

const NO_TRIM: RecordCapTrimResult = {
	evictedCount: 0,
	evictedCreditCount: 0,
	evictedGenuineCount: 0,
};

/**
 * Which of `evictFile`'s four call sites (#1918) dropped a file's tracked
 * state. Carried in the `read_file_evicted` metadata so a live regression
 * names not just which file was evicted but which cap/timer fired.
 * `idle-timeout` never reaches that metadata (#1918 review F2) — designed
 * housekeeping stays silent by construction; see `evictFile`'s doc comment.
 */
type FileEvictionReason =
	| "file-cap-consumed"
	| "file-cap-unconsumed"
	| "idle-timeout"
	| "external-delete";

function enforceRecordCapForFile(records: ReadRecord[]): RecordCapTrimResult {
	if (records.length <= READ_GUARD_MAX_RECORDS_PER_FILE) return NO_TRIM;
	const excess = records.length - READ_GUARD_MAX_RECORDS_PER_FILE;
	const evicted = new Set<number>();
	let evictedCreditCount = 0;
	for (let i = 0; i < records.length && evicted.size < excess; i++) {
		if (records[i].searchCredit !== undefined) {
			evicted.add(i);
			evictedCreditCount++;
		}
	}
	for (let i = 0; i < records.length && evicted.size < excess; i++) {
		evicted.add(i);
	}
	const kept = records.filter((_, i) => !evicted.has(i));
	records.length = 0;
	for (const record of kept) records.push(record);
	return {
		evictedCount: excess,
		evictedCreditCount,
		evictedGenuineCount: excess - evictedCreditCount,
	};
}

/**
 * #1904 class sweep: `this.edits` is the same shape as `this.reads` — a
 * per-file array that only ever grows. Its cap sits far above every consumer's
 * reach, so trimming is inert: `findRelocation`'s window saturates at
 * RELOCATION_WINDOW_MAX / RELOCATION_WINDOW_PER_EDIT (20) applied edits. Only
 * `getStats`, a debug surface, sees the older records at all.
 */
const READ_GUARD_MAX_EDITS_PER_FILE = 256;
// Unconsumed reads remain valid until edit or session end, but this high
// sanity cap prevents a read-only session from growing without bound.
const READ_GUARD_MAX_UNCONSUMED_FILES = 4096;
const READ_GUARD_IDLE_EVICT_MS_DEFAULT = 30 * 60_000;

export function captureReadContentBinding(
	filePath: string,
	offset: number,
	limit: number,
): ReadContentBinding | undefined {
	try {
		if (fs.statSync(filePath).size > READ_BINDING_MAX_BYTES) return undefined;
		const content = fs.readFileSync(filePath, "utf-8");
		// Allocate at most the classification prefix first. For range bindings,
		// splitting then stops at the requested range end rather than the EOF.
		const lines = splitLinesThrough(content, READ_HASH_MAX_LINES + 1);
		if (lines.length <= READ_HASH_MAX_LINES) {
			return {
				hash: hashDiagnosticContent(content),
				fullFile: true,
				offset: 1,
				limit: lines.length,
			};
		}
		const scopedOffset = Math.max(1, offset);
		const scopedLimit = Math.min(Math.max(0, limit), READ_HASH_MAX_LINES);
		if (scopedLimit === 0) return undefined;
		const rangeLines = splitLinesThrough(
			content,
			scopedOffset - 1 + scopedLimit,
		);
		const scopedContent = rangeLines
			.slice(scopedOffset - 1, scopedOffset - 1 + scopedLimit)
			.join("\n");
		return {
			hash: hashDiagnosticContent(scopedContent),
			fullFile: false,
			offset: scopedOffset,
			limit: scopedLimit,
		};
	} catch {
		return undefined;
	}
}

export function _currentContentMatchesBindingForTests(
	filePath: string,
	binding: ReadContentBinding,
): boolean {
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		const boundContent = binding.fullFile
			? content
			: splitLines(content)
					.slice(binding.offset - 1, binding.offset - 1 + binding.limit)
					.join("\n");
		return hashDiagnosticContent(boundContent) === binding.hash;
	} catch {
		return false;
	}
}

const currentContentMatchesBinding = _currentContentMatchesBindingForTests;

// Adaptive relocation window (findRelocation). A globally-unique hash-sequence
// match always wins; when the content is duplicated elsewhere, we fall back to
// a match that is unique WITHIN this window of the original position. The window
// widens with edits already applied to the file (accumulated line drift) —
// floor + per-edit growth, capped — the analog of pi-hashline-readmap's
// edits-scaled relocation window.
const RELOCATION_WINDOW_MIN = Math.max(
	1,
	Number.parseInt(
		process.env.PI_LENS_READ_GUARD_RELOCATION_WINDOW_MIN ?? "40",
		10,
	) || 40,
);
const RELOCATION_WINDOW_PER_EDIT = Math.max(
	0,
	Number.parseInt(
		process.env.PI_LENS_READ_GUARD_RELOCATION_WINDOW_PER_EDIT ?? "20",
		10,
	) || 20,
);
const RELOCATION_WINDOW_MAX = Math.max(
	RELOCATION_WINDOW_MIN,
	Number.parseInt(
		process.env.PI_LENS_READ_GUARD_RELOCATION_WINDOW_MAX ?? "400",
		10,
	) || 400,
);

function splitLines(text: string): string[] {
	return text.split(/\r?\n/);
}

/** `splitLines` semantics, but without scanning/allocating beyond `maxLines`. */
function splitLinesThrough(text: string, maxLines: number): string[] {
	if (maxLines <= 0) return [];
	const lines: string[] = [];
	let start = 0;
	while (lines.length < maxLines) {
		const newline = text.indexOf("\n", start);
		if (newline === -1) {
			lines.push(text.slice(start));
			break;
		}
		const end =
			newline > start && text[newline - 1] === "\r" ? newline - 1 : newline;
		lines.push(text.slice(start, end));
		start = newline + 1;
		if (start === text.length && lines.length < maxLines) {
			lines.push("");
			break;
		}
	}
	return lines;
}

export function lineContentHash(line: string): string {
	// FNV-1a over whitespace-stripped content. This treats no-op formatter/touch
	// changes as still-valid context while detecting semantic line changes.
	const normalized = line.replace(/\s+/g, "");
	let hash = 2166136261;
	for (let i = 0; i < normalized.length; i++) {
		hash = Math.imul(hash ^ normalized.charCodeAt(i), 16777619);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

function readRangeCoversLine(read: ReadRecord, lineNo: number): boolean {
	return (
		lineNo >= read.effectiveOffset &&
		lineNo <= read.effectiveOffset + read.effectiveLimit - 1
	);
}

/**
 * The newest non-provisional read that DELIVERED `lineNo` (its effective
 * range, never the `contextLines` zone): the agent's latest view of that line
 * (#3522). A provisional record was never delivered, and a context-only read
 * never showed the line again, so neither can stand for it. `reads` is in
 * arrival order.
 */
function newestViewOfLine(
	reads: readonly ReadRecord[],
	lineNo: number,
): ReadRecord | undefined {
	for (let i = reads.length - 1; i >= 0; i -= 1) {
		if (
			reads[i].provisional !== true &&
			readRangeCoversLine(reads[i], lineNo)
		) {
			return reads[i];
		}
	}
	return undefined;
}

/** Hash `lines` as file lines `firstLine`, `firstLine + 1`, ... */
function hashLines(
	lines: readonly string[],
	firstLine: number,
): Record<number, string> | undefined {
	const hashes: Record<number, string> = {};
	lines.forEach((line, i) => {
		hashes[firstLine + i] = lineContentHash(line);
	});
	return lines.length > 0 ? hashes : undefined;
}

function captureLineHashes(
	filePath: string,
	offset: number,
	limit: number,
): Record<number, string> | undefined {
	if (limit <= 0 || limit > READ_HASH_MAX_LINES) return undefined;
	try {
		const lines = splitLines(fs.readFileSync(filePath, "utf-8"));
		const start = Math.max(1, offset);
		const end = Math.min(lines.length, offset + limit - 1);
		return hashLines(lines.slice(start - 1, end), start);
	} catch {
		return undefined;
	}
}

/**
 * A read's evidence taken from text the conversation showed the agent (an
 * attached autofix, the agent's own `newText`, a delivered read), not from
 * the disk at record time (#3519, #3523, #3524). `text` starts at file line
 * `offset`. `lineHashes` is undefined past the same READ_HASH_MAX_LINES bound
 * a disk capture has.
 */
export function deliveredLineEvidence(
	text: string,
	offset: number,
): { lineCount: number; lineHashes: Record<number, string> | undefined } {
	const lines = splitLines(text);
	return {
		lineCount: lines.length,
		lineHashes:
			lines.length <= READ_HASH_MAX_LINES
				? hashLines(lines, offset)
				: undefined,
	};
}

export function currentLinesMatchReadSnapshot(
	filePath: string,
	read: ReadRecord,
	[startLine, endLine]: [number, number],
): {
	checked: boolean;
	matches: boolean;
	missingLines: number[];
	mismatchedLines: number[];
} {
	const hashes = read.lineHashes ?? {};
	const missingLines: number[] = [];
	const mismatchedLines: number[] = [];
	for (let lineNo = startLine; lineNo <= endLine; lineNo += 1) {
		if (!readRangeCoversLine(read, lineNo) || hashes[lineNo] === undefined) {
			missingLines.push(lineNo);
		}
	}
	if (missingLines.length > 0) {
		return { checked: false, matches: false, missingLines, mismatchedLines };
	}

	let lines: string[];
	try {
		lines = splitLines(fs.readFileSync(filePath, "utf-8"));
	} catch {
		return {
			checked: true,
			matches: false,
			missingLines,
			mismatchedLines: [...Array(endLine - startLine + 1)].map(
				(_, index) => startLine + index,
			),
		};
	}

	for (let lineNo = startLine; lineNo <= endLine; lineNo += 1) {
		if (lineNo < 1 || lineNo > lines.length) {
			mismatchedLines.push(lineNo);
			continue;
		}
		if (lineContentHash(lines[lineNo - 1] ?? "") !== hashes[lineNo]) {
			mismatchedLines.push(lineNo);
		}
	}

	return {
		checked: true,
		matches: mismatchedLines.length === 0,
		missingLines,
		mismatchedLines,
	};
}

// --- ReadGuard Class ---

export class ReadGuard {
	private readonly config: ReadGuardConfig;
	private readonly reads = new Map<string, ReadRecord[]>();
	private readonly edits = new Map<string, EditRecord[]>();
	private readonly fileLastUsed = new Map<string, number>();
	private readonly fileIdleTimers = new Map<
		string,
		ReturnType<typeof setTimeout>
	>();
	/** Reads remain behavior-gating until the corresponding edit is published. */
	private readonly consumedReadFiles = new Set<string>();
	private readonly fileTime: FileTime;
	private readonly exemptions = new Set<string>(); // One-time exemptions via /lens-allow-edit
	private readonly pendingCreations = new Map<
		string,
		{ turnIndex: number; writeIndex: number; toolCallId?: string }
	>();
	// Files that recordWritten() has fired on this session. Lets
	// wasWrittenThisSession() return a deterministic answer for files the
	// pi Write tool authored, independent of filesystem mtime granularity
	// or clock skew (NFS, FAT32, etc.).
	private readonly writtenThisSession = new Set<string>();
	private readonly unchangedThisSession = new Set<string>();
	// Existence-independent index for hasKnownPath/forgetPath (#1668 review
	// F1). `this.key()` (normalizeFilePath) branches on whether `filePath`
	// currently exists on disk, on EVERY platform since #3098 — an existing
	// file resolves to its on-disk casing (win32: `realpathSync.native`;
	// POSIX: the on-disk casing of the trailing segments), a missing one to a
	// lowercased tail on win32 and to the caller's own spelling on POSIX.
	// recordRead/recordWritten always key while the file is still on disk
	// (real casing); hasKnownPath/forgetPath are queried AFTER an external
	// delete already landed, when the path no longer exists — recomputing
	// `this.key()` at that point returns a DIFFERENT string for any
	// mixed-case basename (win32 `MyModule.ts` → `mymodule.ts`; POSIX
	// `Components/x.ts` held against an on-disk `components/`), so a lookup
	// against `reads`/`writtenThisSession` silently misses. This index maps
	// a purely syntactic key (`normalizeEphemeralMapKey` — slash-fold +
	// lowercase, no filesystem access, so it never depends on current disk
	// state) to the REAL key `reads`/`writtenThisSession` used at record
	// time, so a post-delete lookup finds the same entry regardless of what
	// happened to the file since. Pruned inside `evictFile` so it never
	// outlives the record it points at.
	//
	// ONLY hasKnownPath/forgetPath route through this index, because only they
	// need the real key BACK. `noteCreatedFile` (keys while the file is still
	// absent) and `recordWritten` (keys after it exists) straddle the same
	// state change, and used to do it through `this.key()` directly — a
	// spelling whose key moved orphaned the `pendingCreations` entry and the
	// creation read was never injected (#3163, pre-existing on win32 and
	// reachable on POSIX since #3098). They now key `pendingCreations` by the
	// same existence-independent `normalizeEphemeralMapKey` spelling this index
	// is keyed by; no index is needed there, since the real key is derived by
	// `recordWritten` itself at the moment it is used.
	private readonly knownPathIndex = new Map<string, string>();
	/** Running per-file record-cap trim totals for this session (#1913 F1). */
	private readonly trimAccumulators = new Map<string, FileTrimStats>();
	private readonly sessionId: string;
	/** Re-anchored at every conversation move (#3521); see `retainBranch`. */
	private sessionStartMs: number;
	/**
	 * The scope whose branch epoch this guard reads (#3611). Every
	 * `retainBranch` moves it (#3521). A deferred writer captures the epoch
	 * before it awaits, and `recordWritten` refuses the write when a `/tree`
	 * moved the conversation in between (catalog shape 22). A guard built
	 * outside a coordinator owns a scope of its own.
	 */
	private readonly scope: SessionScope;

	constructor(
		sessionId: string,
		config: Partial<ReadGuardConfig> = {},
		scope: SessionScope = beginScope({ role: "primary" }),
	) {
		this.scope = scope;
		this.sessionId = sessionId;
		this.sessionStartMs = Date.now();
		this.config = { ...DEFAULT_CONFIG, ...config };
		this.fileTime = createFileTime(sessionId);
	}

	/**
	 * Canonical Map key for a file path. Read sources arrive with mixed
	 * separators/casing — the Read tool gives OS-native backslashes on Windows,
	 * while LSP-expanded and search-tool reads arrive slash-normalized from URIs.
	 * Keying the reads/edits/exemptions maps on the raw path made a read recorded
	 * under one form invisible to an edit checked under another, producing a false
	 * `zero_read` block despite the file having been read. `normalizeFilePath`
	 * folds separators and Windows casing to one key, so record and lookup always
	 * agree. Every map access in this class MUST key through here.
	 */
	private key(filePath: string): string {
		return normalizeFilePath(filePath);
	}

	private idleEvictMs(): number {
		const value = Number.parseInt(
			process.env.PI_LENS_READ_GUARD_IDLE_EVICT_MS ?? "",
			10,
		);
		return Number.isSafeInteger(value) && value > 0
			? value
			: READ_GUARD_IDLE_EVICT_MS_DEFAULT;
	}

	private clearFileTimer(filePath: string): void {
		const timer = this.fileIdleTimers.get(filePath);
		if (timer) clearTimeout(timer);
		this.fileIdleTimers.delete(filePath);
	}

	/**
	 * #1918: `enforceRecordCapForFile` (the per-file record cap) is the only
	 * `read-guard.ts` eviction path #1913 gave a bounded record. This whole-file
	 * evictor has four call sites — `enforceFileCap`'s consumed-file cap, its
	 * unconsumed-file cap, `touchFile`'s idle timer, and `forgetPath`'s
	 * external-delete cleanup — and none of them left any trace. A live
	 * regression in any of the four (e.g. a cap set too low) dropped a file's
	 * read/edit history with nothing in `~/.pi-lens/read-guard.log` to show it
	 * happened.
	 *
	 * Follows #1913's aggregate-after-first pattern for the three PRESSURE
	 * reasons (cap exhaustion, external delete): `incrementDegradationCount`
	 * keeps the exact per-file eviction tally (and its own power-of-two
	 * milestone rows in latency.log) while the read-guard.log line fires only
	 * on the rising edge, so a file evicted repeatedly across a session can't
	 * flood the log.
	 *
	 * `idle-timeout` is deliberately excluded from both the ledger tally and
	 * the log line (#1918 review F2): idle eviction is designed housekeeping,
	 * not a fault signal — a read-only session that idles out N files is
	 * healthy, ordinary behavior, and N is unbounded (every distinct file path
	 * touched that session is its own ledger subject). Recording it here would
	 * grow the ledger's tally map without bound and spam `pilens_health` in
	 * every healthy session, unlike the other three reasons, which are rare by
	 * construction (only real pressure or an explicit delete reaches them).
	 */
	private evictFile(filePath: string, reason: FileEvictionReason): void {
		this.clearFileTimer(filePath);
		this.reads.delete(filePath);
		this.edits.delete(filePath);
		this.fileLastUsed.delete(filePath);
		this.consumedReadFiles.delete(filePath);
		this.writtenThisSession.delete(filePath);
		// #1668 review F1: prune the reverse-pointing knownPathIndex entries
		// too, so it never outlives the record it points at.
		for (const [syntacticKey, stored] of this.knownPathIndex) {
			if (stored === filePath) this.knownPathIndex.delete(syntacticKey);
		}
		if (reason === "idle-timeout") return;
		const isRisingEdge = incrementDegradationCount({
			kind: "read-guard-file-evicted",
			subject: filePath,
			reason: `evicted (${reason})`,
		});
		if (isRisingEdge) {
			logReadGuardEvent({
				event: "read_file_evicted",
				sessionId: this.sessionId,
				filePath,
				metadata: { reason },
			});
		}
	}

	private touchFile(filePath: string): void {
		const now = Date.now();
		this.fileLastUsed.set(filePath, now);
		this.clearFileTimer(filePath);
		// An outstanding read is enforcement state, not a rebuildable cache entry.
		// It must survive idle time and file-cap pressure until the edit consumes it.
		if (this.reads.has(filePath) && !this.consumedReadFiles.has(filePath))
			return;
		const stamp = now;
		const timer = setTimeout(() => {
			if (this.fileLastUsed.get(filePath) !== stamp) return;
			// Never turn an outstanding read into a zero-read block through idle
			// eviction. Only consumed reads and rebuildable edit history may expire.
			if (this.reads.has(filePath) && !this.consumedReadFiles.has(filePath))
				return;
			// #1918 review F2: this reason is intentionally silent inside
			// evictFile — idle eviction is routine housekeeping, not a fault, and
			// every distinct file idling out this session is its own ledger
			// subject, so recording it would grow unbounded and flood
			// pilens_health on every healthy session. See evictFile's doc comment.
			this.evictFile(filePath, "idle-timeout");
		}, this.idleEvictMs());
		timer.unref?.();
		this.fileIdleTimers.set(filePath, timer);
	}

	private enforceFileCap(): void {
		while (this.reads.size > READ_GUARD_MAX_FILES) {
			const victim = [...this.reads.keys()]
				.filter((filePath) => this.consumedReadFiles.has(filePath))
				.sort(
					(a, b) =>
						(this.fileLastUsed.get(a) ?? 0) - (this.fileLastUsed.get(b) ?? 0),
				)[0];
			if (!victim) break;
			this.evictFile(victim, "file-cap-consumed");
		}
		while (this.reads.size > READ_GUARD_MAX_UNCONSUMED_FILES) {
			const victim = [...this.reads.keys()]
				.filter((filePath) => !this.consumedReadFiles.has(filePath))
				.sort(
					(a, b) =>
						(this.fileLastUsed.get(a) ?? 0) - (this.fileLastUsed.get(b) ?? 0),
				)[0];
			if (!victim) break;
			// This is a normal read miss: a later edit must require a fresh read,
			// never silently allow and never become a permanent hard-block.
			this.evictFile(victim, "file-cap-unconsumed");
		}
	}

	// --- Public API ---

	/**
	 * Record that a file was read.
	 * Call this from the tool_call handler after any LSP expansion.
	 */
	recordRead(
		record: ReadRecord,
		opts?: {
			supersedes?: { toolCallId: string };
			/**
			 * False when the record's evidence is text the conversation showed
			 * the agent rather than the disk now, so the FileTime stamp is left
			 * to whatever last observed the disk (#3519, #3523, #3524).
			 */
			stampFileTime?: boolean;
		},
	): void {
		const filePath = this.key(record.filePath);
		if (opts?.supersedes) {
			const records = this.reads.get(filePath);
			const provisionalSource = `native-read:${opts.supersedes.toolCallId}:provisional`;
			const provisionalIndex = records?.findIndex(
				(candidate) => candidate.source === provisionalSource,
			);
			if (provisionalIndex !== undefined && provisionalIndex >= 0)
				records!.splice(provisionalIndex, 1);
		}
		// #1668 review F1: index by the existence-independent syntactic key
		// while the file is (presumably) still on disk, so a later
		// hasKnownPath/forgetPath lookup after an external delete can still
		// find this entry's real key.
		this.knownPathIndex.set(
			normalizeEphemeralMapKey(record.filePath),
			filePath,
		);
		const storedRecord: ReadRecord = {
			...record,
			filePath,
			lineHashes:
				record.lineHashes ??
				captureLineHashes(
					filePath,
					record.effectiveOffset,
					record.effectiveLimit,
				),
		};
		const arr = this.reads.get(storedRecord.filePath) ?? [];
		this.consumedReadFiles.delete(storedRecord.filePath);
		arr.push(storedRecord);
		this.reads.set(storedRecord.filePath, arr);
		// Capture BEFORE the trim: `readCountForFile` saturates at the cap once
		// eviction starts, so it stops showing growth. `rawReadCountForFile` keeps
		// the real arrival count observable alongside `evictedRecordCount`.
		const rawReadCountForFile = arr.length;
		const {
			evictedCount: evictedRecordCount,
			evictedCreditCount,
			evictedGenuineCount,
		} = enforceRecordCapForFile(arr);
		this.touchFile(storedRecord.filePath);
		this.enforceFileCap();

		logReadGuardEvent({
			event: "read_recorded",
			sessionId: this.sessionId,
			filePath: storedRecord.filePath,
			requestedOffset: storedRecord.requestedOffset,
			requestedLimit: storedRecord.requestedLimit,
			effectiveOffset: storedRecord.effectiveOffset,
			effectiveLimit: storedRecord.effectiveLimit,
			symbol: storedRecord.enclosingSymbol?.name,
			symbolKind: storedRecord.enclosingSymbol?.kind,
			symbolStartLine: storedRecord.enclosingSymbol?.startLine,
			symbolEndLine: storedRecord.enclosingSymbol?.endLine,
			metadata: {
				expandedByLsp: storedRecord.expandedByLsp,
				turnIndex: storedRecord.turnIndex,
				writeIndex: storedRecord.writeIndex,
				readCountForFile: arr.length,
				hashLineCount: Object.keys(storedRecord.lineHashes ?? {}).length,
				...(storedRecord.source !== undefined && {
					source: storedRecord.source,
				}),
				...(storedRecord.searchCredit !== undefined && {
					searchCreditReason: storedRecord.searchCredit.reason,
					searchCreditMarginBefore: storedRecord.searchCredit.marginBefore,
					searchCreditMarginAfter: storedRecord.searchCredit.marginAfter,
				}),
				...(evictedRecordCount > 0 && {
					evictedRecordCount,
					rawReadCountForFile,
				}),
			},
		});

		// #1913: the eviction counters above ride `read_recorded`, which is
		// gated behind PI_LENS_READ_GUARD_VERBOSE — off by default. That left a
		// live eviction regression with no trace at default verbosity.
		//
		// review F1: a naive "emit every trim" fix floods read-guard.log once a
		// hot file sits past the cap — every later push trims exactly 1 record
		// (the array is always AT the cap before the push, so `excess` is
		// always exactly 1), so 300 recordRead calls on one file is ~172
		// identical always-on lines, and can rotate `edit_blocked` records out
		// of the 1MB cap. `rawReadCountForFile` also freezes at cap+1 forever,
		// so a raw per-trim record can't even discriminate thrash severity.
		//
		// Fix: emit the read-guard.log line ONCE per file per session, on the
		// FIRST trim only. `trimAccumulators` still updates on every trim,
		// queryable via `getTrimStats` — the running totals a health surface or
		// a future emission point would need are never lost, even though
		// read-guard.log stops re-announcing them. "Have we already logged
		// this file's first trim" routes through the degradation ledger's own
		// rising-edge tally (`incrementDegradationCount` — the pattern
		// CLAUDE.md names for repeated degradations) instead of a hand-rolled
		// per-file Set; subsequent trims still call it, so the ledger's own
		// entry for this (kind, subject) keeps its reason text and count
		// current for the health/degradation summary even after read-guard.log
		// goes quiet.
		if (evictedRecordCount > 0) {
			const key = storedRecord.filePath;
			const acc = this.trimAccumulators.get(key) ?? {
				totalEvicted: 0,
				evictedCreditCount: 0,
				evictedGenuineCount: 0,
				trimEventCount: 0,
			};
			acc.totalEvicted += evictedRecordCount;
			acc.evictedCreditCount += evictedCreditCount;
			acc.evictedGenuineCount += evictedGenuineCount;
			acc.trimEventCount += 1;
			this.trimAccumulators.set(key, acc);

			const isRisingEdge = incrementDegradationCount({
				kind: "read-guard-record-cap-trim",
				subject: key,
				reason: `trim #${acc.trimEventCount}: evicted ${evictedRecordCount} (credit ${evictedCreditCount}, genuine ${evictedGenuineCount})`,
			});
			if (isRisingEdge) {
				logReadGuardEvent({
					event: "read_cap_trimmed",
					sessionId: this.sessionId,
					filePath: storedRecord.filePath,
					metadata: {
						trimEventCount: acc.trimEventCount,
						evictedRecordCount: acc.totalEvicted,
						evictedCreditCount: acc.evictedCreditCount,
						evictedGenuineCount: acc.evictedGenuineCount,
						rawReadCountForFile,
					},
				});
			}
		}

		// Also update FileTime stamp for this file
		if (opts?.stampFileTime !== false)
			this.fileTime.read(storedRecord.filePath);
	}

	/**
	 * #3525: whether the disk may hold bytes no read or own write accounts
	 * for: FileTime moved since its stamp, or there is none. An edit that
	 * passes `checkEdit` then did so on other evidence (line hashes, a
	 * resolved oldText), and its own write must not re-stamp FileTime.
	 */
	fileTimeMoved(filePath: string): boolean {
		return this.fileTime.hasChanged(this.key(filePath));
	}

	/**
	 * #3524: whether another write moved the file after its last FileTime
	 * stamp (a native read's tool_call takes one). False when there is no
	 * stamp at all: nothing says when the delivered bytes were read.
	 */
	diskMovedSinceStamp(filePath: string): boolean {
		const key = this.key(filePath);
		return (
			this.fileTime.get(key) !== undefined && this.fileTime.hasChanged(key)
		);
	}

	/**
	 * Record a structured symbol read (the `readSymbol` engine capability / its
	 * MCP mirror) as a genuine read of that symbol's line range — the
	 * read-substitute tie-in for #245. `readSymbol` returns the verbatim body, so
	 * an edit within [startLine, endLine] is legitimately covered, exactly like a
	 * TS/LSP-expanded read that delivered the whole enclosing symbol. Line hashes
	 * for the range are captured by recordRead, so the edit is also
	 * snapshot-verified (drift since the symbol read still blocks).
	 *
	 * Intentionally NOT offered for module *outlines*: an outline shows a symbol's
	 * shape (name/signature/range), not its body, so granting edit coverage from
	 * it would let the agent edit lines it never saw. Only a body-delivering read
	 * (readSymbol / raw Read) records coverage.
	 */
	recordSymbolRead(
		filePath: string,
		symbol: { name: string; kind: string; startLine: number; endLine: number },
		turnIndex: number,
		writeIndex: number,
		toolCallId?: string,
	): void {
		const span = Math.max(1, symbol.endLine - symbol.startLine + 1);
		this.recordRead({
			filePath,
			requestedOffset: symbol.startLine,
			requestedLimit: span,
			effectiveOffset: symbol.startLine,
			effectiveLimit: span,
			expandedByLsp: false,
			enclosingSymbol: {
				name: symbol.name,
				kind: symbol.kind,
				startLine: symbol.startLine,
				endLine: symbol.endLine,
			},
			turnIndex,
			writeIndex,
			timestamp: Date.now(),
			...(toolCallId !== undefined && { toolCallId }),
		});
	}

	/**
	 * Check if an edit should be allowed.
	 * Returns verdict with action and optional reason for blocking.
	 */
	checkEdit(
		filePath: string,
		touchedLines?: [number, number],
		editRanges?: [number, number][],
		options?: { skipSnapshotCheck?: boolean; oldTextResolved?: boolean },
	): ReadGuardVerdict {
		// Canonicalize once: every map lookup below (and every private helper this
		// passes filePath to) must agree with how recordRead keyed the read.
		filePath = this.key(filePath);
		if (this.reads.has(filePath) || this.edits.has(filePath))
			this.touchFile(filePath);

		// Check exemptions
		if (this.exemptions.has(filePath)) {
			this.exemptions.delete(filePath); // One-time use
			const verdict = this.allow();
			this.recordVerdict(filePath, "edit", touchedLines, verdict, {
				reasonKind: "manual_exemption",
			});
			return verdict;
		}

		// Check config exemptions by pattern
		const exemptionMode = this.getExemptionMode(filePath);
		if (exemptionMode === "allow") {
			const verdict = this.allow();
			this.recordVerdict(filePath, "edit", touchedLines, verdict, {
				reasonKind: "pattern_exemption",
				exemptionMode,
			});
			return verdict;
		}

		// "warn" pattern exemptions downgrade all blocking verdicts to warnings.
		const effectiveMode: "block" | "warn" | undefined =
			exemptionMode === "warn" ? "warn" : undefined;

		// 1. Zero-read check
		const fileReads = this.reads.get(filePath);
		if (!fileReads || fileReads.length === 0) {
			// If the file was written after this session started, the agent authored
			// it in this session (via Write or any other mechanism). Allow the edit —
			// a synthetic read would have been injected for Write tool calls, but
			// this catches cases where the write bypassed the hook or the session
			// restarted between write and edit.
			if (this.wasWrittenThisSession(filePath)) {
				this.injectCreationRead(filePath, 0, 0);
				const verdict = this.allow();
				this.recordVerdict(filePath, "edit", touchedLines, verdict, {
					reasonKind: "session_authored",
				});
				return verdict;
			}
			const verdict = this.blockOrWarn(
				"zero-read",
				`🔄 RETRYABLE — Edit without read: you have not read \`${filePath}\` in this conversation. Read it first, then retry: \`read path="${filePath}"\`.`,
				undefined,
				effectiveMode,
			);
			this.recordVerdict(filePath, "edit", touchedLines, verdict, {
				reasonKind: "zero_read",
			});
			return verdict;
		}

		const lastBoundRead = [...fileReads]
			.reverse()
			.find((read) => read.contentBinding !== undefined);
		if (
			lastBoundRead?.contentBinding &&
			!currentContentMatchesBinding(filePath, lastBoundRead.contentBinding)
		) {
			const verdict = this.blockOrWarn(
				"file-modified",
				`🔄 RETRYABLE — File modified since read\n\nYou last read \`${filePath}\` at ${new Date(lastBoundRead.timestamp).toISOString()}.\nThe file content no longer matches the bridge-recorded read.\n\nYour mental model is out of sync with the actual file content.\nTo proceed:\n  1. Re-read the file: \`read path="${filePath}"\``,
				undefined,
				effectiveMode,
			);
			this.recordVerdict(filePath, "edit", touchedLines, verdict, {
				reasonKind: "file_modified",
				lastReadTimestamp: lastBoundRead.timestamp,
				contentBindingMismatch: true,
			});
			return verdict;
		}

		// 2. FileTime check (actual staleness)
		let ignoredHashStaleness = false;
		let ignoredOldTextResolvedStaleness = false;
		if (this.fileTime.hasChanged(filePath)) {
			const lastRead = fileReads[fileReads.length - 1];
			if (options?.oldTextResolved === true) {
				// The host-facing preflight sets this only after oldText resolves to
				// exactly one span in the live bytes. That content evidence is newer
				// and stronger than FileTime's coarse external-write signal, matching
				// the skipSnapshotCheck exception at the later range-stale gate.
				ignoredOldTextResolvedStaleness = true;
			} else if (
				this.canIgnoreStalenessByHashes(
					filePath,
					fileReads,
					touchedLines,
					editRanges,
				)
			) {
				ignoredHashStaleness = true;
			} else {
				const verdict = this.blockOrWarn(
					"file-modified",
					`🔄 RETRYABLE — File modified since read\n\nYou last read \`${filePath}\` at ${new Date(lastRead.timestamp).toISOString()}.\nThe file has been modified on disk since then (auto-format, external tool, or previous edit).\n\nYour mental model is out of sync with the actual file content.\nTo proceed:\n  1. Re-read the file: \`read path="${filePath}"\``,
					undefined,
					effectiveMode,
				);
				this.recordVerdict(filePath, "edit", touchedLines, verdict, {
					reasonKind: "file_modified",
					lastReadTimestamp: lastRead.timestamp,
				});
				return verdict;
			}
		}

		// If no line range specified, we can only check zero-read and FileTime
		if (!touchedLines) {
			const verdict = this.allow();
			this.recordVerdict(filePath, "edit", touchedLines, verdict, {
				reasonKind: "no_line_info",
			});
			return verdict;
		}

		// 3. Range coverage check
		// When the edit touches multiple disjoint spots (e.g. rename across 4 tool
		// registrations), check each spot independently. Collapsing to a bounding
		// box would falsely flag reads that cover exactly the right lines.
		const rangesToCheck: [number, number][] =
			editRanges && editRanges.length > 1 ? editRanges : [touchedLines];

		let viaSymbol = false;
		for (const range of rangesToCheck) {
			const coverage = this.checkCoverage(filePath, range);
			if (!coverage.covered) {
				const lastRead = fileReads[fileReads.length - 1];
				const [editStart, editEnd] = range;
				const lastReadEnd =
					lastRead.effectiveOffset + lastRead.effectiveLimit - 1;
				// If oldText was resolved (content-verified), the model demonstrably
				// knew the content it's replacing — line drift from prior edits in
				// the session is the likely cause. Downgrade to warn rather than block.
				const outOfRangeMode = options?.oldTextResolved
					? "warn"
					: effectiveMode;
				const verdict = this.blockOrWarn(
					"out-of-range",
					`🔄 RETRYABLE — Edit outside read range\n\nYou read \`${filePath}\` lines ${lastRead.effectiveOffset}-${lastReadEnd}${lastRead.enclosingSymbol ? ` (${lastRead.enclosingSymbol.kind} \`${lastRead.enclosingSymbol.name}\`)` : ""}, but your edit touches lines ${editStart}-${editEnd}.\n\nRead the relevant section first, then retry the edit:\n  \`read path="${filePath}" offset=${Math.max(1, editStart - 5)} limit=${Math.min(30, editEnd - editStart + 10)}\``,
					{
						editRange: range,
						readRanges: fileReads.map((r) => ({
							start: r.effectiveOffset,
							end: r.effectiveOffset + r.effectiveLimit - 1,
						})),
						symbolRanges: fileReads
							.filter((r) => r.enclosingSymbol)
							.map((r) => ({
								name: r.enclosingSymbol!.name,
								start: r.enclosingSymbol!.startLine,
								end: r.enclosingSymbol!.endLine,
							})),
					},
					outOfRangeMode,
				);
				this.recordVerdict(filePath, "edit", touchedLines, verdict, {
					reasonKind: "out_of_range",
					oldTextResolved: options?.oldTextResolved ?? false,
				});
				return verdict;
			}
			// After the coverage gate, so the per-line check below only ever walks
			// a range some read covers, never an arbitrary caller-supplied one.
			const snapshotValidation = this.validateRangeSnapshot(
				filePath,
				range,
				!!options?.skipSnapshotCheck,
			);
			if (snapshotValidation.shouldBlock && !options?.skipSnapshotCheck) {
				const [editStart, editEnd] = range;
				// Content-verified relocation: if the lines the agent read have
				// merely shifted (same content, new offset), tell them exactly where
				// so they re-target in one turn. We hint rather than silently
				// re-apply: the host applies native range edits positionally and
				// can't re-verify, so an unverified auto-relocation could corrupt.
				const relocation = this.findRelocation(filePath, fileReads, range);
				const relocationNote = relocation
					? `\n\n📍 The content you read at lines ${relocation.from[0]}-${relocation.from[1]} now appears unchanged at lines ${relocation.to[0]}-${relocation.to[1]} — it shifted position. Re-target your edit to lines ${relocation.to[0]}-${relocation.to[1]}.`
					: "";
				const verdict = this.blockOrWarn(
					"range-stale",
					`🔄 RETRYABLE — Edit range changed since read\n\nYou are editing \`${filePath}\` lines ${editStart}-${editEnd}, but those lines no longer match the content you read earlier.${relocationNote}\n\nRe-read the relevant section, then retry the edit using the current line range/content:\n  \`read path="${filePath}" offset=${Math.max(1, editStart - 5)} limit=${Math.min(30, editEnd - editStart + 10)}\``,
					{
						editRange: range,
						readRanges: fileReads.map((r) => ({
							start: r.effectiveOffset,
							end: r.effectiveOffset + r.effectiveLimit - 1,
						})),
						symbolRanges: fileReads
							.filter((r) => r.enclosingSymbol)
							.map((r) => ({
								name: r.enclosingSymbol!.name,
								start: r.enclosingSymbol!.startLine,
								end: r.enclosingSymbol!.endLine,
							})),
						snapshot: {
							status: snapshotValidation.status,
							mismatchedLines: snapshotValidation.mismatchedLines,
							missingLines: snapshotValidation.missingLines,
						},
						...(relocation ? { relocation } : {}),
					},
					effectiveMode,
				);
				// Offer auto-apply only for a single-range edit: we relocated exactly
				// one range, so shifting it is the whole edit. A multi-range edit
				// could have other drifted spots we returned before checking, so it
				// stays a hint.
				if (relocation && rangesToCheck.length === 1) {
					verdict.relocation = relocation;
				}
				this.recordVerdict(filePath, "edit", touchedLines, verdict, {
					reasonKind: "range_stale",
					range,
					mismatchedLines: snapshotValidation.mismatchedLines.slice(0, 20),
					relocatedTo: relocation?.to ?? null,
					relocationAutoApplyOffered: !!verdict.relocation,
				});
				return verdict;
			}
			if (coverage.viaSymbol) viaSymbol = true;
		}

		const verdict = this.allow();
		this.recordVerdict(filePath, "edit", touchedLines, verdict, {
			reasonKind: ignoredOldTextResolvedStaleness
				? "file_modified_oldtext_unique"
				: viaSymbol
					? "symbol_coverage"
					: "range_coverage",
			viaSymbol,
			ignoredHashStaleness,
			oldTextResolved: ignoredOldTextResolvedStaleness,
		});
		return verdict;
	}

	/**
	 * Check if this is a new file (no existing file on disk).
	 * New file writes are exempt from the guard.
	 */
	isNewFile(filePath: string): boolean {
		try {
			return !fs.existsSync(filePath);
		} catch {
			return true; // Assume new if we can't stat
		}
	}

	/**
	 * Whether pi-lens has any record of this path from a read or write this
	 * session (#1668). Gates external-delete detection: a path pi-lens never
	 * read or wrote is one no LSP server's cache was ever told about through
	 * us, so an `rm` naming it carries no signal worth checking disk for —
	 * this is a lookup against state already being tracked, never a fresh
	 * filesystem stat over an unbounded path set.
	 *
	 * MUST go through `knownPathIndex`, not `this.key(filePath)` directly
	 * (#1668 review F1): this is called AFTER a bash delete has already
	 * landed, when `filePath` no longer exists — `this.key()` at that point
	 * returns a lowercased-tail key, not the real-casing key `recordRead`/
	 * `recordWritten` stored while the file was still on disk. For a
	 * mixed-case basename (`MyModule.ts`) the two keys differ and a direct
	 * `this.key()` lookup always misses.
	 */
	hasKnownPath(filePath: string): boolean {
		const stored = this.knownPathIndex.get(normalizeEphemeralMapKey(filePath));
		return (
			stored !== undefined &&
			(this.reads.has(stored) || this.writtenThisSession.has(stored))
		);
	}

	/**
	 * Every path this guard has a read or a write record for, as normalized keys
	 * (#2430).
	 *
	 * This is the read-guard half of the observational net's TRACKED-FILE SET:
	 * the files pi-lens has actually seen this session, which the `agent_settled`
	 * sweep hash-checks instead of walking the workspace. It reads state already
	 * held in memory and stats nothing; both backing containers are capped
	 * (`READ_GUARD_MAX_UNCONSUMED_FILES`), so the result is bounded by
	 * construction.
	 *
	 * `touchFile` is deliberately NOT called: enumerating is not using, and
	 * refreshing every entry's idle clock on each sweep would make the idle
	 * eviction unreachable.
	 */
	getTrackedPaths(): string[] {
		const tracked = new Set<string>(this.reads.keys());
		for (const written of this.writtenThisSession) tracked.add(written);
		return [...tracked];
	}

	/**
	 * Drop all record of a path pi-lens confirmed no longer exists on disk
	 * (#1668, external delete). Without this a later write reusing the same
	 * path would inherit a stale writtenThisSession/reads entry from before
	 * the delete, and a repeat `rm` of the same already-gone path would keep
	 * matching {@link hasKnownPath} and re-emitting a type-3 notification.
	 *
	 * MUST evict through `knownPathIndex`, not `this.key(filePath)` directly
	 * (#1668 review F1) — same reasoning as {@link hasKnownPath}: `filePath`
	 * is already gone from disk by the time this runs, so recomputing
	 * `this.key()` targets the wrong (lowercased-tail) key for a mixed-case
	 * basename and leaves the real entry behind un-evicted.
	 */
	forgetPath(filePath: string): void {
		const stored = this.knownPathIndex.get(normalizeEphemeralMapKey(filePath));
		this.evictFile(stored ?? this.key(filePath), "external-delete");
	}

	/**
	 * Mark a file as pending creation (Write tool to a non-existing file).
	 * Must be called from the tool_call handler before the write lands so
	 * isNewFile() still returns true. recordWritten will inject a synthetic
	 * read so immediate follow-up edits are not blocked by zero_read.
	 *
	 * Keyed by the existence-INDEPENDENT syntactic spelling
	 * (`normalizeEphemeralMapKey`, the same key `knownPathIndex` uses), NOT by
	 * `this.key()` (#3163). This entry is written while the file is still
	 * ABSENT and read back by `recordWritten` once it EXISTS — the one state
	 * change `normalizeFilePath` itself branches on — so a `this.key()` on each
	 * side answered with two different strings for any spelling whose key moves
	 * when the file appears (win32: a mixed-case basename, lower-cased in the
	 * absent branch by `resolveNonExisting`; POSIX since #3098: a parent whose
	 * canonical casing is adopted once `realpathSync.native` succeeds). The
	 * entry was then orphaned — nothing prunes `pendingCreations` — and the
	 * creation read never injected. The syntactic key never touches the
	 * filesystem, so it cannot move; the REAL key the injected read needs is
	 * derived by `recordWritten` itself and is not stored here.
	 */
	noteCreatedFile(
		filePath: string,
		turnIndex: number,
		writeIndex: number,
		toolCallId?: string,
	): void {
		this.pendingCreations.set(normalizeEphemeralMapKey(filePath), {
			turnIndex,
			writeIndex,
			...(toolCallId !== undefined && { toolCallId }),
		});
	}

	/**
	 * Refresh the FileTime stamp after the model's own write lands on disk.
	 * Call this from the tool_result handler so the next checkEdit on the same
	 * file doesn't see "file_modified" caused by our own previous edit.
	 * A deferred writer passes the `branchEpoch` it captured before awaiting;
	 * a write from before a `/tree` is then not credited (#3521).
	 */
	recordWritten(
		rawFilePath: string,
		opts?: {
			branchEpoch?: number;
			/**
			 * False when the written bytes are not the agent's own call's, or
			 * when the disk already held bytes no read accounts for: the stamp
			 * is left where it was, so the next edit is judged by line hashes
			 * (#3525).
			 */
			stampFileTime?: boolean;
			/** The bytes a `write` wrote: its creation read's evidence (#3524). */
			writtenContent?: string;
		},
	): void {
		if (
			opts?.branchEpoch !== undefined &&
			opts.branchEpoch !== this.currentBranchEpoch
		) {
			incrementDegradationCount({
				kind: "read-guard-write-after-branch-move",
				subject: "recordWritten",
				reason: `a write captured at branch epoch ${opts.branchEpoch} landed at ${this.currentBranchEpoch}; not credited to the new branch`,
			});
			return;
		}
		const filePath = this.key(rawFilePath);
		this.unchangedThisSession.delete(filePath);
		// #1668 review F1: index by the existence-independent syntactic key
		// (see `knownPathIndex`) so a later hasKnownPath/forgetPath lookup
		// after an external delete can still find this entry's real key.
		this.knownPathIndex.set(normalizeEphemeralMapKey(rawFilePath), filePath);
		if (opts?.stampFileTime !== false) this.fileTime.read(filePath);
		this.writtenThisSession.add(filePath);
		if (this.reads.has(filePath)) this.consumedReadFiles.add(filePath);
		this.touchFile(filePath);
		this.enforceFileCap();
		// #3163: `noteCreatedFile` announced this creation while the file was
		// still absent, so the announcement is keyed by the syntactic spelling —
		// look it up the same way, never through the existence-dependent
		// `filePath` above. `injectCreationRead` still receives the real key.
		const creationKey = normalizeEphemeralMapKey(rawFilePath);
		const creation = this.pendingCreations.get(creationKey);
		if (creation) {
			this.pendingCreations.delete(creationKey);
			this.injectCreationRead(
				filePath,
				creation.turnIndex,
				creation.writeIndex,
				creation.toolCallId,
				opts?.writtenContent,
			);
		}
	}

	/** Record that a recognized mutation had complete evidence but changed no bytes. */
	recordUnchanged(rawFilePath: string): void {
		const filePath = this.key(rawFilePath);
		// A no-op command is scoped to this command. It must not erase a
		// confirmed Write from earlier in the session.
		if (!this.writtenThisSession.has(filePath))
			this.unchangedThisSession.add(filePath);
	}

	/**
	 * Add a one-time exemption for a file.
	 * Called via /lens-allow-edit command.
	 */
	addExemption(filePath: string): void {
		this.exemptions.add(this.key(filePath));
		logReadGuardEvent({
			event: "exemption_added",
			sessionId: this.sessionId,
			filePath,
			metadata: {
				source: "lens-allow-edit",
			},
		});
	}

	/**
	 * Get summary statistics for /lens-health.
	 */
	getSummary(): {
		totalEdits: number;
		totalBlocks: number;
		byReason: Record<string, number>;
		byFile: Record<string, { edits: number; blocks: number }>;
		lspExpansionsHelped: number;
	} {
		let totalEdits = 0;
		let totalBlocks = 0;
		let lspExpansionsHelped = 0;
		const byReason: Record<string, number> = {};
		const byFile: Record<string, { edits: number; blocks: number }> = {};

		for (const [filePath, records] of this.edits) {
			for (const record of records) {
				totalEdits++;
				byFile[filePath] = byFile[filePath] ?? { edits: 0, blocks: 0 };
				byFile[filePath].edits++;

				if (record.verdict === "blocked") {
					totalBlocks++;
					byFile[filePath].blocks++;
				}

				if (record.reason) {
					byReason[record.reason] = (byReason[record.reason] ?? 0) + 1;
				}

				// Count LSP expansions that allowed an edit
				if (
					record.precedingReads.some((r) => r.expandedByLsp) &&
					record.verdict === "allowed"
				) {
					lspExpansionsHelped++;
				}
			}
		}

		return {
			totalEdits,
			totalBlocks,
			byReason,
			byFile,
			lspExpansionsHelped,
		};
	}

	/**
	 * Get all read records for a file (for debugging).
	 */
	getReadHistory(filePath: string): ReadRecord[] {
		const key = this.key(filePath);
		if (this.reads.has(key)) this.touchFile(key);
		return this.reads.get(key) ?? [];
	}

	/**
	 * Session-lifetime record-cap trim totals for a file (#1913 review F1).
	 * `recordRead` only writes ONE `read_cap_trimmed` read-guard.log line per
	 * file per session (on the first trim), so this is the running-totals
	 * surface for everything after that — the exact split this class already
	 * computes on every trim, not re-derivable from `getReadHistory` alone
	 * (which only shows the SURVIVING records, not what was evicted).
	 */
	getTrimStats(filePath: string): FileTrimStats | undefined {
		const stats = this.trimAccumulators.get(this.key(filePath));
		return stats ? { ...stats } : undefined;
	}

	/**
	 * Snapshot the read-set for persistence across a session resume (#1041).
	 * Mirrors widget-state's `exportWidgetState`: the Map is emitted as
	 * `[key, records]` tuples, keys already in `normalizeFilePath` form. Only
	 * `reads` is serialized — it is the payload `checkEdit`'s zero-read/coverage
	 * checks consult. Safe to call even when the guard is disabled (an empty or
	 * never-populated `reads` simply exports zero entries).
	 */
	exportState(): PersistedReadGuardState {
		return {
			version: READ_GUARD_STATE_VERSION,
			reads: [...this.reads.entries()].map(([key, records]) => [
				key,
				records.map((record) => ({ ...record })),
			]),
		};
	}

	/**
	 * The files this session authored (#3612, D5): what `wasWrittenThisSession`
	 * reads. A `/reload` keeps the conversation and its branch, so the
	 * reloaded guard keeps them; every other start resets them.
	 */
	exportAuthorship(): PersistedReadGuardAuthorship {
		return {
			written: [...this.writtenThisSession],
			sessionStartMs: this.sessionStartMs,
		};
	}

	/** Restore {@link exportAuthorship}'s output. Null-safe on a malformed payload. */
	importAuthorship(state: unknown): void {
		const authorship = state as Partial<PersistedReadGuardAuthorship> | null;
		if (Array.isArray(authorship?.written))
			for (const filePath of authorship.written)
				if (typeof filePath === "string") this.writtenThisSession.add(filePath);
		if (typeof authorship?.sessionStartMs === "number")
			this.sessionStartMs = authorship.sessionStartMs;
	}

	/**
	 * Keep exactly the reads the conversation still shows the agent, after it
	 * moved to another branch in this activation (`/tree`, #3521).
	 *
	 * A record stays, whole, when its `toolCallId` is in `onBranch` (the
	 * `toolResult`s on the new branch); every other record is deleted. Nothing
	 * is re-verified or re-stamped here: the FileTime stamps are cleared, so
	 * each kept record must pass the per-line hash check against disk at the
	 * next edit. A stamp taken on the abandoned branch would otherwise vouch
	 * for bytes this branch never showed. Edits, authored-write and
	 * pending-creation state came from the old branch too, so they go, and the
	 * mtime fallback of `wasWrittenThisSession` is re-anchored to now.
	 */
	retainBranch(onBranch: ReadonlySet<string>): {
		kept: number;
		dropped: number;
	} {
		const result = { kept: 0, dropped: 0 };
		for (const [filePath, records] of this.reads) {
			const kept: ReadRecord[] = [];
			for (const read of records)
				if (read.toolCallId !== undefined && onBranch.has(read.toolCallId))
					kept.push(read);
			result.kept += kept.length;
			result.dropped += records.length - kept.length;
			if (kept.length > 0) {
				this.reads.set(filePath, kept);
				continue;
			}
			this.reads.delete(filePath);
		}
		this.edits.clear();
		this.writtenThisSession.clear();
		this.pendingCreations.clear();
		this.fileTime.clear();
		// #3520 owns deleting this fallback; until then a write made on the
		// abandoned branch must not read as authored on this one.
		this.sessionStartMs = Date.now();
		moveBranch(this.scope);
		return result;
	}

	/** The epoch a deferred writer captures before it awaits (#3521). */
	get currentBranchEpoch(): number {
		return this.scope.branchEpoch();
	}

	/**
	 * #3676: which guard lifetime {@link currentBranchEpoch} counts in. The epoch
	 * restarts at 0 in every new guard (`/fork`, `/new`, a resume), so a stamp
	 * that outlives its guard, in a cache file for instance, carries this beside
	 * the epoch. The scope ticket is drawn from a per-process counter that starts
	 * at 1 in every process, so the pid is part of the key.
	 */
	get lineageKey(): string {
		return `${process.pid}:${this.scope.scopeId}`;
	}

	/**
	 * Load a persisted read-set (#1041) for the branch this session starts on
	 * (#3521): a resume, `pi --fork`, or the fork/clone hand-off. The same rule
	 * as {@link retainBranch}: a record is imported, whole, only when its
	 * `toolCallId` is in `onBranch`, and without a FileTime stamp, so the
	 * per-line hash check decides each edit against the current disk. The
	 * guard is fresh here (`resetForSession`), so there is no older
	 * conversation state to clear. A
	 * record for a file that no longer exists is dropped. Version-guarded and
	 * null-safe: `undefined`, a version-1 sidecar (no ids), or a malformed
	 * payload loads as no reads and never throws — a throw here would abort
	 * the whole session_start rehydration.
	 */
	importBranch(
		state: PersistedReadGuardState | undefined,
		onBranch: ReadonlySet<string>,
	): { imported: number; dropped: number } {
		const result = { imported: 0, dropped: 0 };
		if (!state || state.version !== READ_GUARD_STATE_VERSION) return result;
		if (!Array.isArray(state.reads)) return result;
		for (const entry of state.reads) {
			if (!Array.isArray(entry) || entry.length !== 2) continue;
			const [rawPath, records] = entry;
			if (typeof rawPath !== "string") continue;
			if (!Array.isArray(records) || records.length === 0) continue;
			const filePath = this.key(rawPath);
			const exists = fs.existsSync(filePath);
			for (const read of records) {
				const id = (read as Partial<ReadRecord> | undefined)?.toolCallId;
				if (!exists || typeof id !== "string" || !onBranch.has(id)) {
					result.dropped += 1;
					continue;
				}
				// `?? {}`: a record without hashes must not be re-hashed from
				// today's disk by recordRead; that would vouch for bytes written
				// after the conversation last saw the file.
				this.recordRead(
					{ ...read, filePath, lineHashes: read.lineHashes ?? {} },
					{ stampFileTime: false },
				);
				result.imported += 1;
			}
		}
		return result;
	}

	/**
	 * Get all edit records for a file (for debugging).
	 */
	getEditHistory(filePath: string): EditRecord[] {
		const key = this.key(filePath);
		if (this.edits.has(key)) this.touchFile(key);
		return this.edits.get(key) ?? [];
	}

	// --- Private helpers ---

	/**
	 * `writtenContent`, when the write's bytes are known, is the agent's view
	 * of the file: hashed from it, not from a disk another writer may have
	 * moved before this handler ran (#3524). Without it (the `session_authored`
	 * path, #3520) the disk is all there is.
	 */
	private injectCreationRead(
		filePath: string,
		turnIndex: number,
		writeIndex: number,
		toolCallId?: string,
		writtenContent?: string,
	): void {
		let evidence: ReturnType<typeof deliveredLineEvidence>;
		try {
			evidence =
				writtenContent !== undefined
					? deliveredLineEvidence(writtenContent, 1)
					: {
							lineCount: splitLines(fs.readFileSync(filePath, "utf-8")).length,
							lineHashes: undefined,
						};
		} catch {
			return;
		}
		const { lineCount, lineHashes } = evidence;
		if (lineCount === 0) return;
		this.recordRead({
			filePath,
			requestedOffset: 1,
			requestedLimit: lineCount,
			effectiveOffset: 1,
			effectiveLimit: lineCount,
			expandedByLsp: false,
			...(lineHashes && { lineHashes }),
			turnIndex,
			writeIndex,
			timestamp: Date.now(),
			...(toolCallId !== undefined && { toolCallId }),
		});
	}

	private wasWrittenThisSession(filePath: string): boolean {
		if (this.unchangedThisSession.has(filePath)) return false;
		// Authoritative path: we observed a write of this file via recordWritten.
		// Survives mtime granularity (FAT32 ~2s), clock skew (NFS), and external
		// tools that touch mtime backward.
		if (this.writtenThisSession.has(filePath)) return true;
		try {
			return fs.statSync(filePath).mtimeMs >= this.sessionStartMs;
		} catch {
			return false;
		}
	}

	private canIgnoreStalenessByHashes(
		filePath: string,
		reads: ReadRecord[],
		touchedLines?: [number, number],
		editRanges?: [number, number][],
	): boolean {
		let lines: string[];
		try {
			lines = splitLines(fs.readFileSync(filePath, "utf-8"));
		} catch {
			return false;
		}

		const rangesToCheck: [number, number][] | undefined = touchedLines
			? editRanges && editRanges.length > 1
				? editRanges
				: [touchedLines]
			: undefined;

		if (!rangesToCheck) {
			const lastRead = reads.at(-1);
			return !!lastRead && this.readHashesStillMatch(lastRead, lines);
		}

		// The same per-line question as `validateRangeSnapshot` (#3522): every
		// line must still match the newest read that delivered it. "Some read
		// covers the whole range" vouched from an older read for a line a newer
		// read saw differently.
		return rangesToCheck.every(([startLine, endLine]) => {
			for (let lineNo = startLine; lineNo <= endLine; lineNo += 1) {
				const view = newestViewOfLine(reads, lineNo);
				if (
					!view ||
					!this.readRangeHashesStillMatch(view, lines, [lineNo, lineNo])
				) {
					return false;
				}
			}
			return true;
		});
	}

	private validateRangeSnapshot(
		filePath: string,
		[startLine, endLine]: [number, number],
		/**
		 * What the CALLER will do with the verdict. `checkEdit` honours
		 * `skipSnapshotCheck` for content-validated (oldText) edits, so a
		 * `shouldBlock` verdict may never reach the gate (#1904 item 1).
		 */
		snapshotCheckSkipped: boolean,
	): {
		status: "match" | "mismatch" | "unavailable";
		missingLines: number[];
		mismatchedLines: number[];
		shouldBlock: boolean;
	} {
		const reads = this.reads.get(filePath) ?? [];
		// Judge each line by the newest read that delivered it (#3522), in runs
		// that share one read. A line no read delivered (only in a context zone)
		// or whose newest view carries no hash for it cannot be checked and is
		// reported missing; it never blocks and never lets an older read speak
		// for it.
		const runs: Array<{ read: ReadRecord; range: [number, number] }> = [];
		const missingLines: number[] = [];
		for (let lineNo = startLine; lineNo <= endLine; lineNo += 1) {
			const view = newestViewOfLine(reads, lineNo);
			if (!view || view.lineHashes?.[lineNo] === undefined) {
				missingLines.push(lineNo);
				continue;
			}
			const last = runs.at(-1);
			if (last?.read === view && last.range[1] === lineNo - 1) {
				last.range[1] = lineNo;
			} else {
				runs.push({ read: view, range: [lineNo, lineNo] });
			}
		}
		const mismatchedLines: number[] = [];
		let checkedLineCount = 0;
		for (const { read, range } of runs) {
			checkedLineCount += range[1] - range[0] + 1;
			mismatchedLines.push(
				...currentLinesMatchReadSnapshot(filePath, read, range).mismatchedLines,
			);
		}
		const status: "match" | "mismatch" | "unavailable" =
			mismatchedLines.length > 0
				? "mismatch"
				: missingLines.length === 0
					? "match"
					: "unavailable";
		const shouldBlock = status === "mismatch";

		// `enforced` below states INTENT — whether this validation reached a
		// decidable verdict. It says nothing about what the caller did with it.
		// `outcome` states the caller's actual behaviour, which is what an
		// enforcement rate must be computed from (#1904 item 1).
		const outcome: RangeSnapshotOutcome = shouldBlock
			? snapshotCheckSkipped
				? "bypassed-content-match"
				: "enforced-block"
			: status === "match"
				? "enforced-pass"
				: "not-decidable";

		logReadGuardEvent({
			event: "range_snapshot_validation",
			sessionId: this.sessionId,
			filePath,
			metadata: {
				range: [startLine, endLine],
				status,
				viewRunCount: runs.length,
				checkedLineCount,
				missingLineCount: missingLines.length,
				mismatchedLineCount: mismatchedLines.length,
				missingLines: missingLines.slice(0, 20),
				mismatchedLines: mismatchedLines.slice(0, 20),
				enforced: shouldBlock || status === "match",
				outcome,
			},
		});

		return { status, missingLines, mismatchedLines, shouldBlock };
	}

	private readRangeHashesStillMatch(
		read: ReadRecord,
		lines: string[],
		[startLine, endLine]: [number, number],
	): boolean {
		const hashes = read.lineHashes ?? {};
		for (let lineNo = startLine; lineNo <= endLine; lineNo += 1) {
			if (!readRangeCoversLine(read, lineNo) || hashes[lineNo] === undefined) {
				return false;
			}
			if (lineNo < 1 || lineNo > lines.length) return false;
			if (lineContentHash(lines[lineNo - 1] ?? "") !== hashes[lineNo]) {
				return false;
			}
		}
		return true;
	}

	/**
	 * Content-verified relocation. When a range the agent read has drifted, find
	 * where the read-time line-hash sequence for [startLine,endLine] now appears
	 * in the current file. Returns the unique new location, or undefined when:
	 * no recorded read captured hashes for the whole range; the sequence is too
	 * short to be collision-resistant (<2 lines); or it now matches zero or
	 * multiple spots. Powers a *hint* only — never a silent positional re-apply.
	 */
	private findRelocation(
		filePath: string,
		reads: ReadRecord[],
		[startLine, endLine]: [number, number],
	): { from: [number, number]; to: [number, number] } | undefined {
		const span = endLine - startLine + 1;
		// A single line's hash collides too easily to relocate on confidently.
		if (span < 2) return undefined;

		// Relocate only from the read that is the agent's newest view of EVERY
		// line of the range (#3522). A run taken from an older read would
		// overwrite lines a newer read showed the agent differently.
		const source = newestViewOfLine(reads, startLine);
		if (!source?.lineHashes) return undefined;
		const wanted: string[] = [];
		for (let lineNo = startLine; lineNo <= endLine; lineNo += 1) {
			const hash = source.lineHashes[lineNo];
			if (hash === undefined || newestViewOfLine(reads, lineNo) !== source) {
				return undefined;
			}
			wanted.push(hash);
		}

		let lines: string[];
		try {
			lines = splitLines(fs.readFileSync(filePath, "utf-8"));
		} catch {
			return undefined;
		}
		const currentHashes = lines.map((line) => lineContentHash(line));
		const lastStart = currentHashes.length - span; // last valid 0-based start

		const matchStarts: number[] = [];
		for (let i = 0; i <= lastStart; i += 1) {
			let ok = true;
			for (let j = 0; j < span; j += 1) {
				if (currentHashes[i + j] !== wanted[j]) {
					ok = false;
					break;
				}
			}
			if (ok) matchStarts.push(i + 1); // 1-indexed
		}

		let newStart: number | undefined;
		if (matchStarts.length === 1) {
			// Unique across the whole file → certainly the relocated span,
			// regardless of how far it drifted (e.g. a large refactor moved it).
			newStart = matchStarts[0];
		} else if (matchStarts.length > 1) {
			// Duplicated elsewhere: fall back to locality. Lines rarely teleport,
			// so accept a match unique WITHIN an adaptive window of the original
			// position — out-of-window duplicates don't poison a locally
			// unambiguous relocation. The window widens with the edits already
			// applied to this file this session (each prior edit shifts line
			// numbers, so accumulated drift grows).
			const appliedEdits = (this.edits.get(filePath) ?? []).filter(
				(record) => record.verdict !== "blocked",
			).length;
			const window = Math.min(
				RELOCATION_WINDOW_MAX,
				Math.max(
					RELOCATION_WINDOW_MIN,
					appliedEdits * RELOCATION_WINDOW_PER_EDIT,
				),
			);
			const lo = startLine - window;
			const hi = endLine + window;
			const local = matchStarts.filter((start) => start >= lo && start <= hi);
			if (local.length === 1) newStart = local[0];
		}

		if (newStart === undefined || newStart === startLine) return undefined;
		return { from: [startLine, endLine], to: [newStart, newStart + span - 1] };
	}

	private readHashesStillMatch(read: ReadRecord, lines: string[]): boolean {
		const entries = Object.entries(read.lineHashes ?? {});
		if (entries.length === 0) return false;
		for (const [lineText, expected] of entries) {
			const lineNo = Number(lineText);
			if (!Number.isInteger(lineNo) || lineNo < 1 || lineNo > lines.length) {
				return false;
			}
			if (lineContentHash(lines[lineNo - 1] ?? "") !== expected) return false;
		}
		return true;
	}

	private checkCoverage(
		filePath: string,
		touchedLines: [number, number],
	): { covered: boolean; viaSymbol: boolean } {
		const [editStart, editEnd] = touchedLines;

		const reads = this.reads.get(filePath) ?? [];

		// First pass: check symbol coverage and any single read that covers the edit.
		for (const read of reads) {
			if (read.provisional === true) continue;
			const readStart = Math.max(
				1,
				read.effectiveOffset - this.config.contextLines,
			);
			const readEnd =
				read.effectiveOffset +
				read.effectiveLimit -
				1 +
				this.config.contextLines;

			if (editStart >= readStart && editEnd <= readEnd) {
				return { covered: true, viaSymbol: false };
			}

			if (read.enclosingSymbol) {
				const symStart = read.enclosingSymbol.startLine;
				const symEnd = read.enclosingSymbol.endLine;
				if (symStart <= editStart && symEnd >= editEnd) {
					return { covered: true, viaSymbol: true };
				}
			}
		}

		// Second pass: merge all read intervals and check if their union covers
		// [editStart, editEnd]. Handles multi-chunk reads (e.g. 1-100 + 101-200).
		const intervals = reads
			.filter((read) => read.provisional !== true)
			.map(
				(read) =>
					[
						Math.max(1, read.effectiveOffset - this.config.contextLines),
						read.effectiveOffset +
							read.effectiveLimit -
							1 +
							this.config.contextLines,
					] as [number, number],
			);

		intervals.sort((a, b) => a[0] - b[0]);

		// Merge overlapping/adjacent intervals
		const merged: Array<[number, number]> = [];
		for (const [s, e] of intervals) {
			if (merged.length > 0 && s <= merged[merged.length - 1][1] + 1) {
				merged[merged.length - 1][1] = Math.max(
					merged[merged.length - 1][1],
					e,
				);
			} else {
				merged.push([s, e]);
			}
		}

		for (const [s, e] of merged) {
			if (editStart >= s && editEnd <= e) {
				return { covered: true, viaSymbol: false };
			}
		}

		return { covered: false, viaSymbol: false };
	}

	private getExemptionMode(
		filePath: string,
	): "allow" | "warn" | "block" | null {
		for (const exemption of this.config.exemptions) {
			if (this.matchesPattern(filePath, exemption.pattern)) {
				return exemption.mode;
			}
		}
		return null;
	}

	private matchesPattern(filePath: string, pattern: string): boolean {
		// Simple glob matching — can be expanded
		if (pattern.startsWith("*")) {
			const suffix = pattern.slice(1);
			return filePath.endsWith(suffix);
		}
		if (pattern.includes("*")) {
			// Adjacent stars are equivalent to one star in this dialect. Collapse
			// them before compiling so a non-match cannot backtrack over every
			// nullable `.*` group (#2622).
			const collapsedPattern = pattern.replace(/\*+/g, "*");
			const regex = new RegExp(
				`^${collapsedPattern.replace(/\\/g, "\\\\").replace(/\./g, "\\.").replace(/\*/g, ".*")}$`,
			);
			return regex.test(filePath);
		}
		return filePath === pattern;
	}

	private blockOrWarn(
		_reason: string,
		message: string,
		details?: ReadGuardVerdict["details"],
		overrideMode?: "block" | "warn",
	): ReadGuardVerdict {
		const mode = overrideMode ?? this.config.mode;
		if (mode === "warn") {
			return { action: "warn", reason: message, details };
		}
		return { action: "block", reason: message, details };
	}

	private allow(): ReadGuardVerdict {
		return { action: "allow" };
	}

	private recordEdit(
		filePath: string,
		tool: string,
		touchedLines: [number, number],
		verdict: ReadGuardVerdict,
	): void {
		this.touchFile(filePath);
		const arr = this.edits.get(filePath) ?? [];
		arr.push({
			filePath,
			tool,
			touchedLines,
			precedingReads: this.reads.get(filePath) ?? [],
			verdict: mapVerdictAction(verdict.action),
			reason: verdict.reason,
			timestamp: Date.now(),
		});
		if (arr.length > READ_GUARD_MAX_EDITS_PER_FILE) {
			const trimmedCount = arr.length - READ_GUARD_MAX_EDITS_PER_FILE;
			arr.splice(0, trimmedCount);
			// #1918: the #282-289 doc comment argues this trim is inert in
			// practice (every consumer reads only the last record or a
			// bounded relocation window), but an argument is not a record —
			// if that assumption ever breaks, this is the only signal. Same
			// aggregate-after-first shape as `read_cap_trimmed` (#1913):
			// `incrementDegradationCount` keeps the exact per-file tally,
			// the read-guard.log line fires once on the rising edge.
			const isRisingEdge = incrementDegradationCount({
				kind: "read-guard-edits-cap-trim",
				subject: filePath,
				reason: `trimmed ${trimmedCount} edit record(s) past cap`,
			});
			if (isRisingEdge) {
				logReadGuardEvent({
					event: "edits_cap_trimmed",
					sessionId: this.sessionId,
					filePath,
					metadata: { trimmedCount, cappedLength: arr.length },
				});
			}
		}
		this.edits.set(filePath, arr);
	}

	private recordVerdict(
		filePath: string,
		tool: string,
		touchedLines: [number, number] | undefined,
		verdict: ReadGuardVerdict,
		metadata: Record<string, unknown> = {},
	): void {
		const normalizedTouchedLines = touchedLines ?? [1, 1];
		this.recordEdit(filePath, tool, normalizedTouchedLines, verdict);
		const reads = this.reads.get(filePath) ?? [];
		logReadGuardEvent({
			event:
				verdict.action === "allow"
					? "edit_allowed"
					: verdict.action === "warn"
						? "edit_warned"
						: "edit_blocked",
			sessionId: this.sessionId,
			filePath,
			metadata: {
				tool,
				touchedLines: touchedLines ?? null,
				normalizedTouchedLines,
				readCount: reads.length,
				reads: reads.map((read) => ({
					requestedOffset: read.requestedOffset,
					requestedLimit: read.requestedLimit,
					effectiveOffset: read.effectiveOffset,
					effectiveLimit: read.effectiveLimit,
					expandedByLsp: read.expandedByLsp,
					enclosingSymbol: read.enclosingSymbol ?? null,
					timestamp: read.timestamp,
				})),
				verdictAction: verdict.action,
				details: verdict.details,
				...metadata,
			},
		});
	}
}

// --- Factory ---

function mapVerdictAction(
	action: ReadGuardVerdict["action"],
): EditRecord["verdict"] {
	switch (action) {
		case "allow":
			return "allowed";
		case "block":
			return "blocked";
		case "warn":
			return "warned";
	}
}

export function createReadGuard(
	sessionId: string,
	config?: Partial<ReadGuardConfig>,
): ReadGuard {
	return new ReadGuard(sessionId, config);
}
