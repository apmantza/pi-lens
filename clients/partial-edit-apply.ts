import type { EditToolInput } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { PathKeyedMap } from "./path-keyed-map.js";
import { normalizeMapKey } from "./path-utils.js";
import type { ReadGuardEditBatchSummary } from "./read-guard-logger.js";

// A single edit element of the host edit tool ({ oldText, newText }). Pinned to
// the SDK's EditToolInput so a host schema rename (e.g. oldText -> old_text) is a
// compile error here rather than a silent runtime mismatch (#257 / refs #2).
type HostEdit = EditToolInput["edits"][number];

/**
 * Identity of the file content the preflight resolved the batch against: the
 * sha256 of the raw bytes it read. Exact-retry recognition (#2402) compares it
 * with the hash an applied record carries.
 */
export interface EditSnapshotIdentity {
	/** sha256 of the raw file bytes the preflight read. */
	hash: string;
}

export interface PartiallyApplicableEdit {
	/** The submitted (post-autopatch) old text, as the preflight received it. */
	oldText: HostEdit["oldText"];
	/**
	 * The exact LF text the preflight located at the span: the `oldText` the
	 * host edit is handed (#5120). Differs from `oldText` only when a
	 * normalization tier (host match-space folding, lone-CR fold) recovered
	 * the real file bytes.
	 */
	appliedSpanText: string;
	// Widened vs the host: pi-lens models a pure deletion as an absent newText.
	newText: HostEdit["newText"] | undefined;
	originalIndex: number;
	/** Inclusive start offset of the span in the snapshot's LF view. */
	spanStart: number;
	/** Exclusive end offset of the span in the snapshot's LF view. */
	spanEnd: number;
}

/**
 * #5120: what a partial apply's `tool_call` hands its `tool_result`. The
 * `tool_call` rewrites the call's `edits` to the matched subset and the host
 * edit writes it, so every later `tool_call` handler sees those bytes first.
 * This record is how the `tool_result` still tells the agent which edits
 * applied and which did not (#1053), and keys the #2402 records by the pairs
 * the agent submitted rather than the span text the host was handed.
 */
export interface PartialApplyPending {
	/** The matched edits as submitted (post-autopatch), in original numbering. */
	applied: Array<{
		oldText: string;
		newText: string | undefined;
		originalIndex: number;
	}>;
	/** The preflight verdict for the whole batch. */
	preflightError: string;
	/** Its per-edit bodies: they describe exactly the edits NOT applied. */
	preflightDetails?: string[];
	alreadyAppliedEdits?: number[];
	/** The preflight's batch summary, which the commit summary extends. */
	summary?: ReadGuardEditBatchSummary;
}

export interface AppliedPartialEditRecord {
	/** Fixed-size digest of the exact submitted oldText/newText pair. */
	pairDigest: string;
	/** Hash of the complete file state immediately after this edit committed. */
	contentHash?: string;
	/**
	 * Hash of the file state after the post-commit pipeline (a formatter) rewrote
	 * it, when that rewrite changed the bytes (#2402). Recognition accepts EITHER
	 * this or `contentHash`: a deterministic formatter pass between commit and an
	 * identical retry no longer defeats already-applied recognition, while an
	 * unknown third-party state still matches neither and stays fail-safe.
	 */
	afterWriteContentHash?: string;
	appliedAtMs: number;
}

const MAX_APPLIED_RECORDS_PER_FILE = 8;
/** Exported for #2442's bounded-eviction test; not a public API. */
export const MAX_APPLIED_RECORD_FILES = 64;

/**
 * Canonical key for an applied edit: LF-normalized, per-line trailing
 * whitespace stripped, trailing empty lines dropped. Retry payloads go through
 * the same normalization, so an identical resubmission matches its record even
 * when the two passes' autopatch results diverged on trailing whitespace
 * (deterministic given identical payloads; the strip removes the only
 * payload-dependent axis that survives to the retry).
 */
export function stripOldTextTrailingWhitespace(value: string): string {
	const lines = value
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((l) => l.trimEnd());
	while (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return lines.join("\n");
}

function editPairDigest(oldText: string, newText: string | undefined): string {
	return createHash("sha256")
		.update(JSON.stringify([oldText, newText ?? ""]), "utf8")
		.digest("hex");
}

function countLfOccurrences(content: string, needle: string): number {
	if (!needle) return 0;
	let count = 0;
	let pos = 0;
	while (pos < content.length) {
		const idx = content.indexOf(needle, pos);
		if (idx === -1) break;
		count += 1;
		pos = idx + needle.length;
	}
	return count;
}

/**
 * Evidence check for an exact-retry recognition (#2402): the recorded pair was
 * applied by this process; the content evidence answers whether that state is
 * still the file's state. Deliberately NOT a global heuristic — it only runs
 * for an edit whose exact (oldText, newText) pair is on record.
 *
 * - oldText not contained in newText: the applied state holds when oldText is
 *   gone and newText is present.
 * - oldText contained in newText (e.g. an extended import line): the applied
 *   state holds when every remaining oldText occurrence lies inside a newText
 *   occurrence. Re-applying would duplicate newText — the exact #2402 loop.
 */
export function isExactAppliedRetry(args: {
	contentLf: string;
	oldKey: string;
	newKey: string;
	/** Current raw file hash, when the caller can provide it. */
	contentHash?: string;
	/** Raw file hash recorded immediately after the original commit. */
	expectedContentHash?: string;
	/**
	 * Raw file hash recorded after the post-commit pipeline (a formatter) rewrote
	 * the file, when it changed the bytes (#2402). When present it is an
	 * additional accepted state alongside `expectedContentHash`.
	 */
	expectedAfterWriteHash?: string;
}): boolean {
	const {
		contentLf,
		oldKey,
		newKey,
		contentHash,
		expectedContentHash,
		expectedAfterWriteHash,
	} = args;
	// Hash gate (fail-safe): when the caller recorded any file-state hash, the
	// current file must match one of the states THIS process produced — the
	// post-commit bytes or the post-afterWrite (formatter) bytes. A file in any
	// other state is an unrecognized third-party change; we refuse rather than
	// re-resolve against it. The gate is skipped only when no hash was recorded.
	const haveExpectedHash =
		expectedContentHash !== undefined || expectedAfterWriteHash !== undefined;
	if (haveExpectedHash) {
		const matchesKnownState =
			contentHash !== undefined &&
			(contentHash === expectedContentHash ||
				contentHash === expectedAfterWriteHash);
		if (!matchesKnownState) return false;
	}
	if (!oldKey) return false;
	if (newKey === "") return countLfOccurrences(contentLf, oldKey) === 0;
	if (!newKey.includes(oldKey)) {
		return (
			countLfOccurrences(contentLf, oldKey) === 0 &&
			countLfOccurrences(contentLf, newKey) >= 1
		);
	}
	const newOccurrences: Array<[number, number]> = [];
	let pos = 0;
	while (pos < contentLf.length) {
		const idx = contentLf.indexOf(newKey, pos);
		if (idx === -1) break;
		newOccurrences.push([idx, idx + newKey.length]);
		pos = idx + newKey.length;
	}
	if (newOccurrences.length === 0) return false;
	pos = 0;
	while (pos < contentLf.length) {
		const idx = contentLf.indexOf(oldKey, pos);
		if (idx === -1) break;
		const end = idx + oldKey.length;
		if (!newOccurrences.some(([s, e]) => s <= idx && e >= end)) return false;
		pos = end;
	}
	return true;
}

/**
 * Session-scoped store of applied partial/full edits, keyed by normalized file
 * path. `RuntimeCoordinator.resetForSession` clears it, so an applied record
 * never outlives the session whose edit produced it. Records are bounded on
 * both axes (per-file entries, and files) with oldest-entry eviction.
 */
export class PartialApplyRecordStore {
	// Bounded on the PathKeyedMap itself (#2442): the file axis used to
	// hand-roll `keys().next().value` here, which also evicted an unrelated
	// file when a path ALREADY in the map was re-recorded at capacity.
	private readonly files = new PathKeyedMap<AppliedPartialEditRecord[]>(
		normalizeMapKey,
		MAX_APPLIED_RECORD_FILES,
	);

	find(
		filePath: string,
		oldText: string | undefined,
		newText: string | undefined,
	): AppliedPartialEditRecord | undefined {
		if (!oldText) return undefined;
		const pairDigest = editPairDigest(oldText, newText);
		const records = this.files.get(filePath) ?? [];
		return records.find((r) => r.pairDigest === pairDigest);
	}

	record(
		filePath: string,
		oldText: string,
		newText: string | undefined,
		contentHash?: string,
	): void {
		if (!oldText) return;
		const pairDigest = editPairDigest(oldText, newText);
		const records = this.files.get(filePath) ?? [];
		const existing = records.findIndex((r) => r.pairDigest === pairDigest);
		if (existing >= 0) records.splice(existing, 1);
		const entry: AppliedPartialEditRecord = {
			pairDigest,
			contentHash: contentHash ?? hashFile(filePath),
			appliedAtMs: Date.now(),
		};
		if (records.length >= MAX_APPLIED_RECORDS_PER_FILE) records.shift();
		records.push(entry);
		this.files.set(filePath, records); // the map bounds its own file axis
	}

	/**
	 * Stamps the post-afterWrite file hash onto an existing record so a later
	 * identical retry against the formatter-rewritten file is still recognized as
	 * already-applied (#2402). No-op when the pair was never recorded.
	 */
	noteAfterWriteHash(
		filePath: string,
		oldText: string,
		newText: string | undefined,
		afterWriteContentHash: string,
	): void {
		if (!oldText) return;
		const pairDigest = editPairDigest(oldText, newText);
		const record = this.files
			.get(filePath)
			?.find((r) => r.pairDigest === pairDigest);
		if (record) record.afterWriteContentHash = afterWriteContentHash;
	}

	clear(): void {
		this.files.clear();
	}

	get fileCount(): number {
		return this.files.size;
	}
}

function hashFile(filePath: string): string | undefined {
	try {
		return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
	} catch {
		return undefined;
	}
}
