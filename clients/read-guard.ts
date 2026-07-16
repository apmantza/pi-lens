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
import { createFileTime, type FileTime } from "./file-time.js";
import { normalizeFilePath } from "./path-utils.js";
import { logReadGuardEvent } from "./read-guard-logger.js";

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
	turnIndex: number;
	writeIndex: number;
	timestamp: number;
}

export interface EditRecord {
	filePath: string;
	tool: "write" | "edit";
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

const OWN_EDIT_STALE_GRACE_MS = Math.max(
	0,
	Number.parseInt(
		process.env.PI_LENS_READ_GUARD_OWN_EDIT_GRACE_MS ?? "120000",
		10,
	) || 120000,
);

/** Avoid hashing very large reads in the hot path. */
const READ_HASH_MAX_LINES = Math.max(
	0,
	Number.parseInt(
		process.env.PI_LENS_READ_GUARD_HASH_MAX_LINES ?? "3000",
		10,
	) || 3000,
);

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

function readEffectiveRangeCoversRange(
	read: ReadRecord,
	[startLine, endLine]: [number, number],
): boolean {
	return (
		readRangeCoversLine(read, startLine) && readRangeCoversLine(read, endLine)
	);
}

function captureLineHashes(
	filePath: string,
	offset: number,
	limit: number,
): Record<number, string> | undefined {
	if (limit <= 0 || limit > READ_HASH_MAX_LINES) return undefined;
	try {
		const lines = splitLines(fs.readFileSync(filePath, "utf-8"));
		const hashes: Record<number, string> = {};
		const end = Math.min(lines.length, offset + limit - 1);
		for (let lineNo = Math.max(1, offset); lineNo <= end; lineNo++) {
			hashes[lineNo] = lineContentHash(lines[lineNo - 1] ?? "");
		}
		return Object.keys(hashes).length > 0 ? hashes : undefined;
	} catch {
		return undefined;
	}
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
	private readonly fileTime: FileTime;
	private readonly exemptions = new Set<string>(); // One-time exemptions via /lens-allow-edit
	private readonly pendingCreations = new Map<
		string,
		{ turnIndex: number; writeIndex: number }
	>();
	// Files that recordWritten() has fired on this session. Lets
	// wasWrittenThisSession() return a deterministic answer for files the
	// pi Write tool authored, independent of filesystem mtime granularity
	// or clock skew (NFS, FAT32, etc.).
	private readonly writtenThisSession = new Set<string>();
	private readonly sessionId: string;
	private readonly sessionStartMs: number;

	constructor(sessionId: string, config: Partial<ReadGuardConfig> = {}) {
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

	// --- Public API ---

	/**
	 * Record that a file was read.
	 * Call this from the tool_call handler after any LSP expansion.
	 */
	recordRead(record: ReadRecord): void {
		const filePath = this.key(record.filePath);
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
		arr.push(storedRecord);
		this.reads.set(storedRecord.filePath, arr);

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
			},
		});

		// Also update FileTime stamp for this file
		this.fileTime.read(storedRecord.filePath);
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
				`🔄 RETRYABLE — Edit without read\n\nYou are trying to edit \`${filePath}\` but have not read it in this conversation.\n\nRead the file first, then retry the edit: \`read path="${filePath}"\``,
				undefined,
				effectiveMode,
			);
			this.recordVerdict(filePath, "edit", touchedLines, verdict, {
				reasonKind: "zero_read",
			});
			return verdict;
		}

		// 2. FileTime check (actual staleness)
		let ignoredOwnEditStaleness = false;
		let ignoredHashStaleness = false;
		if (this.fileTime.hasChanged(filePath)) {
			const lastRead = fileReads[fileReads.length - 1];
			if (this.canTreatStalenessAsOwnPriorEdit(filePath, lastRead.timestamp)) {
				ignoredOwnEditStaleness = true;
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
			const snapshotValidation = this.validateRangeSnapshot(filePath, range);
			const coverage = this.checkCoverage(filePath, range);
			if (!coverage.covered) {
				const lastRead = fileReads[fileReads.length - 1];
				const [editStart, editEnd] = range;
				const lastReadEnd =
					lastRead.effectiveOffset + lastRead.effectiveLimit - 1;
				// If oldText was resolved (content-verified), the model demonstrably
				// knew the content it's replacing — line drift from prior edits in
				// the session is the likely cause. Downgrade to warn rather than block.
				const outOfRangeMode = options?.oldTextResolved ? "warn" : effectiveMode;
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
			if (snapshotValidation.shouldBlock && !options?.skipSnapshotCheck) {
				const [editStart, editEnd] = range;
				// Grace period: when the snapshot is stale because THIS session's own
				// earlier edit shifted line numbers (ignoredOwnEditStaleness), and
				// the agent read the file recently, downgrade to a warning rather
				// than blocking. The agent has fresh context — they just don't
				// know the exact new line numbers after the shift.
				const RANGE_STALE_GRACE_MS = 60_000;
				const lastRead = fileReads[fileReads.length - 1];
				const graceActive =
					ignoredOwnEditStaleness &&
					Date.now() - lastRead.timestamp < RANGE_STALE_GRACE_MS;
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
					graceActive ? "warn" : effectiveMode,
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
					graceActive,
					relocatedTo: relocation?.to ?? null,
					relocationAutoApplyOffered: !!verdict.relocation,
				});
				return verdict;
			}
			if (coverage.viaSymbol) viaSymbol = true;
		}

		const verdict = this.allow();
		this.recordVerdict(filePath, "edit", touchedLines, verdict, {
			reasonKind: viaSymbol ? "symbol_coverage" : "range_coverage",
			viaSymbol,
			ignoredOwnEditStaleness,
			ignoredHashStaleness,
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
	 * Mark a file as pending creation (Write tool to a non-existing file).
	 * Must be called from the tool_call handler before the write lands so
	 * isNewFile() still returns true. recordWritten will inject a synthetic
	 * read so immediate follow-up edits are not blocked by zero_read.
	 */
	noteCreatedFile(
		filePath: string,
		turnIndex: number,
		writeIndex: number,
	): void {
		this.pendingCreations.set(this.key(filePath), { turnIndex, writeIndex });
	}

	/**
	 * Refresh the FileTime stamp after the model's own write lands on disk.
	 * Call this from the tool_result handler so the next checkEdit on the same
	 * file doesn't see "file_modified" caused by our own previous edit.
	 */
	recordWritten(filePath: string): void {
		filePath = this.key(filePath);
		this.fileTime.read(filePath);
		this.writtenThisSession.add(filePath);
		const creation = this.pendingCreations.get(filePath);
		if (creation) {
			this.pendingCreations.delete(filePath);
			this.injectCreationRead(filePath, creation.turnIndex, creation.writeIndex);
		}
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
		return this.reads.get(this.key(filePath)) ?? [];
	}

	/**
	 * Get all edit records for a file (for debugging).
	 */
	getEditHistory(filePath: string): EditRecord[] {
		return this.edits.get(this.key(filePath)) ?? [];
	}

	// --- Private helpers ---

	private injectCreationRead(
		filePath: string,
		turnIndex: number,
		writeIndex: number,
	): void {
		let lineCount = 0;
		try {
			lineCount = splitLines(fs.readFileSync(filePath, "utf-8")).length;
		} catch {
			return;
		}
		if (lineCount === 0) return;
		this.recordRead({
			filePath,
			requestedOffset: 1,
			requestedLimit: lineCount,
			effectiveOffset: 1,
			effectiveLimit: lineCount,
			expandedByLsp: false,
			turnIndex,
			writeIndex,
			timestamp: Date.now(),
		});
	}

	private wasWrittenThisSession(filePath: string): boolean {
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

	private canTreatStalenessAsOwnPriorEdit(
		filePath: string,
		lastReadTimestamp: number,
	): boolean {
		const edits = this.edits.get(filePath) ?? [];
		const latest = edits.at(-1);
		if (!latest) return false;
		if (latest.verdict !== "allowed" && latest.verdict !== "warned")
			return false;
		if (latest.timestamp < lastReadTimestamp) return false;
		return Date.now() - latest.timestamp <= OWN_EDIT_STALE_GRACE_MS;
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

		return rangesToCheck.every((range) =>
			reads.some(
				(read) =>
					this.readCoversRange(read, range) &&
					this.readRangeHashesStillMatch(read, lines, range),
			),
		);
	}

	private readCoversRange(
		read: ReadRecord,
		[editStart, editEnd]: [number, number],
	): boolean {
		const readStart = Math.max(
			1,
			read.effectiveOffset - this.config.contextLines,
		);
		const readEnd =
			read.effectiveOffset + read.effectiveLimit - 1 + this.config.contextLines;
		if (editStart >= readStart && editEnd <= readEnd) return true;
		if (!read.enclosingSymbol) return false;
		return (
			read.enclosingSymbol.startLine <= editStart &&
			read.enclosingSymbol.endLine >= editEnd
		);
	}

	private validateRangeSnapshot(
		filePath: string,
		range: [number, number],
	): {
		status: "match" | "mismatch" | "unavailable";
		matchingReadIndex: number;
		missingLines: number[];
		mismatchedLines: number[];
		candidateReadCount: number;
		checkedCandidateCount: number;
		unavailableCandidateCount: number;
		shouldBlock: boolean;
	} {
		const reads = this.reads.get(filePath) ?? [];
		const candidates = reads.filter((read) =>
			this.readCoversRange(read, range),
		);
		let status: "match" | "mismatch" | "unavailable" = "unavailable";
		let matchingReadIndex = -1;
		let missingLines: number[] = [];
		let mismatchedLines: number[] = [];
		let checkedCandidateCount = 0;
		let unavailableCandidateCount = 0;
		let hashUnavailableCandidateCount = 0;
		let lastMismatchTimestamp = -Infinity;
		let lastUnavailableTimestamp = -Infinity;
		for (let i = 0; i < candidates.length; i += 1) {
			const validation = currentLinesMatchReadSnapshot(
				filePath,
				candidates[i],
				range,
			);
			if (!validation.checked) {
				unavailableCandidateCount += 1;
				if (readEffectiveRangeCoversRange(candidates[i], range)) {
					hashUnavailableCandidateCount += 1;
				}
				if (status === "unavailable") {
					missingLines = validation.missingLines;
				}
				lastUnavailableTimestamp = Math.max(
					lastUnavailableTimestamp,
					candidates[i].timestamp,
				);
				continue;
			}
			checkedCandidateCount += 1;
			if (validation.matches) {
				status = "match";
				matchingReadIndex = i;
				missingLines = [];
				mismatchedLines = [];
				break;
			}
			status = "mismatch";
			missingLines = [];
			mismatchedLines = validation.mismatchedLines;
			lastMismatchTimestamp = Math.max(
				lastMismatchTimestamp,
				candidates[i].timestamp,
			);
		}

		// Enforce only when no candidate that actually delivered the target range
		// lacks hashes. Context-only/symbol-only coverage may be unavailable without
		// weakening enforcement from another hash-checkable read of the same range.
		// Also suppress when a re-read (unavailable only due to context-zone boundary)
		// is more recent than the stale read that triggered the mismatch — the agent
		// refreshed their view, and the re-read's edge lines fall within contextLines.
		const shouldBlock =
			status === "mismatch" &&
			lastUnavailableTimestamp <= lastMismatchTimestamp &&
			checkedCandidateCount > 0 &&
			hashUnavailableCandidateCount === 0;

		logReadGuardEvent({
			event: "range_snapshot_validation",
			sessionId: this.sessionId,
			filePath,
			metadata: {
				range,
				status,
				candidateReadCount: candidates.length,
				checkedCandidateCount,
				unavailableCandidateCount,
				hashUnavailableCandidateCount,
				matchingReadIndex,
				missingLineCount: missingLines.length,
				mismatchedLineCount: mismatchedLines.length,
				missingLines: missingLines.slice(0, 20),
				mismatchedLines: mismatchedLines.slice(0, 20),
				enforced: shouldBlock || status === "match",
			},
		});

		return {
			status,
			matchingReadIndex,
			missingLines,
			mismatchedLines,
			candidateReadCount: candidates.length,
			checkedCandidateCount,
			unavailableCandidateCount,
			shouldBlock,
		};
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

		// Newest read that captured hashes for the entire target range wins.
		let wanted: string[] | undefined;
		for (let i = reads.length - 1; i >= 0; i -= 1) {
			const hashes = reads[i].lineHashes;
			if (!hashes) continue;
			const seq: string[] = [];
			let complete = true;
			for (let lineNo = startLine; lineNo <= endLine; lineNo += 1) {
				const h = hashes[lineNo];
				if (h === undefined) {
					complete = false;
					break;
				}
				seq.push(h);
			}
			if (complete) {
				wanted = seq;
				break;
			}
		}
		if (!wanted) return undefined;

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
		const intervals = reads.map(
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
			// Convert glob to regex
			const regex = new RegExp(
				`^${pattern.replace(/\\/g, "\\\\").replace(/\./g, "\\.").replace(/\*/g, ".*")}$`,
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
		tool: "write" | "edit",
		touchedLines: [number, number],
		verdict: ReadGuardVerdict,
	): void {
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
		this.edits.set(filePath, arr);
	}

	private recordVerdict(
		filePath: string,
		tool: "write" | "edit",
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
