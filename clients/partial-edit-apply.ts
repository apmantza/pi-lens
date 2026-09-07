import type { EditToolInput } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { writeFileAtomic } from "./atomic-write.js";
import { createFileTime } from "./file-time.js";
import {
	detectLineEnding,
	normalizeToLF,
	restoreLineEndings,
} from "./host-edit-normalize.js";
import { PathKeyedMap } from "./path-keyed-map.js";
import { normalizeMapKey } from "./path-utils.js";
import {
	boundedEditIndexes,
	createReadGuardEditBatchSummary,
	formatBoundedEditIndexes,
	logReadGuardEvent,
	type ReadGuardEditBatchSummary,
} from "./read-guard-logger.js";

// A single edit element of the host edit tool ({ oldText, newText }). Pinned to
// the SDK's EditToolInput so a host schema rename (e.g. oldText -> old_text) is a
// compile error here rather than a silent runtime mismatch (#257 / refs #2).
type HostEdit = EditToolInput["edits"][number];

/**
 * Identity of the file content the preflight resolved the batch against
 * (#1053). The apply step re-reads the file and rejects the whole batch when
 * this identity no longer holds, so spans resolved against one snapshot are
 * never re-interpreted against changed bytes. The hash covers byte identity
 * completely; no length or mtime sibling is needed alongside it.
 */
export interface EditSnapshotIdentity {
	/** sha256 of the raw file bytes the preflight read. */
	hash: string;
}

export interface PartiallyApplicableEdit {
	/** The submitted (post-autopatch) old text, as the preflight received it. */
	oldText: HostEdit["oldText"];
	/**
	 * The exact LF text the preflight located at the span — what this module
	 * replaces. Differs from `oldText` only when a normalization tier (host
	 * match-space folding, lone-CR fold) recovered the real file bytes.
	 */
	appliedSpanText: string;
	// Widened vs the host: pi-lens models a pure deletion as an absent newText.
	newText: HostEdit["newText"] | undefined;
	originalIndex: number;
	/** Snapshot the span was resolved against (#1053). */
	snapshot: EditSnapshotIdentity;
	/** Inclusive start offset of the span in the snapshot's LF view. */
	spanStart: number;
	/** Exclusive end offset of the span in the snapshot's LF view. */
	spanEnd: number;
}

type PartialApplyRejectionReason =
	| "stale_snapshot"
	| "span_changed"
	| "span_overlap"
	| "invalid_batch";

interface PartialApplyRejection {
	reason: PartialApplyRejectionReason;
	/** Bounded, agent-actionable detail for the block reason. */
	detail: string;
}

export interface PartialEditApplyResult {
	appliedCount: number;
	appliedTotal: number;
	appliedIndices: string;
	postEditOutput?: string;
	postEditStatus: "not_run" | "succeeded" | "failed";
	summary?: ReadGuardEditBatchSummary;
	/**
	 * Set when the batch was rejected BEFORE any write (stale, drifted, or
	 * overlapping spans). No bytes changed, no post-edit dispatch ran.
	 */
	rejected?: PartialApplyRejection;
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

// Locks are process-global in FileTime (module-global map keyed by resolved
// path), so one instance here serializes against every other FileTime user.
const fileLock = createFileTime("partial-edit-apply");

function hashBytes(content: Uint8Array): string {
	return createHash("sha256").update(content).digest("hex");
}

function hashFile(filePath: string): string | undefined {
	try {
		return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
	} catch {
		return undefined;
	}
}

/**
 * Internal rejection signal: raised only BEFORE any bytes are written, so a
 * rejection can never be confused with a commit failure.
 */
class PartialApplyRejectionError extends Error {
	constructor(
		public readonly reason: PartialApplyRejectionReason,
		public readonly detail: string,
	) {
		super(detail);
		this.name = "PartialApplyRejectionError";
	}
}

/**
 * Applies preflight-approved spans from the original snapshot, then invokes the
 * caller's normal post-edit bookkeeping/pipeline hook (#1053, #2402).
 *
 * Contract:
 * - Spans are consumed as resolved; oldText is never re-searched against a
 *   changed buffer.
 * - The whole batch is validated (snapshot identity, span bounds, span text,
 *   pairwise non-overlap) BEFORE any write; a rejection writes nothing and
 *   dispatches no post-edit pipeline.
 * - The commit goes through the shared atomic writer under the file lock.
 * - A committed write and a post-edit analysis failure are separate outcomes;
 *   the caller decides the message, and committed bytes are never reported as
 *   a retryable oldText miss.
 */
export async function applyPartiallyApplicableEdits(args: {
	filePath: string;
	edits: PartiallyApplicableEdit[];
	afterWrite?: () => Promise<string | undefined>;
	/** Read-guard preflight summary, reused rather than re-shaped here. */
	summary?: ReadGuardEditBatchSummary;
	correlationId?: string;
	/** Session-scoped applied-edit records for exact-retry recognition. */
	recordStore?: PartialApplyRecordStore;
}): Promise<PartialEditApplyResult> {
	const startedAt = Date.now();
	const summaryRef = args.summary;
	const correlationId = args.correlationId;
	const logBatchEvent = (
		entry: Parameters<typeof logReadGuardEvent>[0],
	): void => logReadGuardEvent({ ...entry, correlationId });

	const reject = (
		reason: PartialApplyRejectionReason,
		detail: string,
	): PartialEditApplyResult => {
		logBatchEvent({
			event: "edit_partial_apply_rejected",
			filePath: args.filePath,
			metadata: {
				tool: "edit",
				rejectionReason: reason,
				detail,
				editCount: args.edits.length,
			},
		});
		return {
			appliedCount: 0,
			appliedTotal: 0,
			appliedIndices: "",
			postEditStatus: "not_run",
			rejected: { reason, detail },
		};
	};
	if (args.edits.length === 0) {
		return reject(
			"invalid_batch",
			"no preflight-approved edits were carried into the apply step",
		);
	}
	const snapshot = args.edits[0].snapshot;
	for (const edit of args.edits) {
		if (edit.snapshot.hash !== snapshot.hash) {
			return reject(
				"invalid_batch",
				"carried edits reference different snapshot identities; the batch must be rebuilt from one preflight",
			);
		}
	}

	// Validate + commit inside the file lock so a concurrent same-file writer
	// (formatter, LSP edit, another session's partial apply) cannot interleave
	// between the identity re-check and the rename.
	const commit = (): string => {
		const rawBytes = fs.readFileSync(args.filePath);
		if (hashBytes(rawBytes) !== snapshot.hash) {
			throw new PartialApplyRejectionError(
				"stale_snapshot",
				"the file changed since the preflight resolved these edits; rebuild the edit from the current content",
			);
		}
		const raw = rawBytes.toString("utf8");
		const ending = detectLineEnding(raw);
		const lf = normalizeToLF(raw);

		// The span-text equality is the single span guard: `slice` clamps to the
		// buffer, so an out-of-bounds, inverted, or drifted span cannot produce
		// the approved text and is rejected here as one rejection class. A
		// separate bounds check would only re-label the same failure.
		const ordered = [...args.edits].sort((a, b) => a.spanStart - b.spanStart);
		for (let i = 0; i < ordered.length; i += 1) {
			const edit = ordered[i];
			if (lf.slice(edit.spanStart, edit.spanEnd) !== edit.appliedSpanText) {
				throw new PartialApplyRejectionError(
					"span_changed",
					`edits[${edit.originalIndex}] span no longer holds the text the preflight approved; the batch must be rebuilt from a fresh preflight`,
				);
			}
			if (i > 0) {
				const prev = ordered[i - 1];
				if (edit.spanStart < prev.spanEnd) {
					throw new PartialApplyRejectionError(
						"span_overlap",
						`edits[${prev.originalIndex}] and edits[${edit.originalIndex}] resolved to overlapping spans; extend one oldText to disambiguate the location`,
					);
				}
			}
		}

		let committed = lf;
		for (let i = ordered.length - 1; i >= 0; i -= 1) {
			const edit = ordered[i];
			const newText = normalizeToLF(edit.newText ?? "");
			committed =
				committed.slice(0, edit.spanStart) +
				newText +
				committed.slice(edit.spanEnd);
		}

		const output = restoreLineEndings(committed, ending);
		const targetPath = fs.lstatSync(args.filePath).isSymbolicLink()
			? fs.realpathSync(args.filePath)
			: args.filePath;
		const mode = fs.statSync(args.filePath).mode & 0o7777;
		writeFileAtomic(targetPath, output, {
			bestEffort: false,
			mode,
		});
		return hashBytes(Buffer.from(output, "utf8"));
	};

	let commitStatus: ReadGuardEditBatchSummary["commitStatus"] = "committed";
	let committedContentHash: string | undefined;
	try {
		await fileLock.withLock(args.filePath, async () => {
			committedContentHash = commit();
			for (const edit of args.edits) {
				args.recordStore?.record(
					args.filePath,
					edit.oldText,
					edit.newText,
					committedContentHash,
				);
			}
		});
	} catch (error) {
		if (error instanceof PartialApplyRejectionError) {
			commitStatus = "not_attempted";
			const baseSummary =
				summaryRef ??
				createReadGuardEditBatchSummary({
					requestedIndexes: boundedEditIndexes(
						args.edits.map((edit) => edit.originalIndex),
					),
					requestedTotal: args.edits.length,
				});
			const summary = createReadGuardEditBatchSummary({
				...baseSummary,
				participantIds: correlationId
					? [...baseSummary.participantIds, correlationId]
					: baseSummary.participantIds,
				participantTotal: correlationId
					? baseSummary.participantTotal + 1
					: baseSummary.participantTotal,
				commitStatus,
				postEditStatus: "not_run",
				terminalStatus: "blocked",
				durationMs: Date.now() - startedAt,
			});
			logBatchEvent({
				event: "edit_batch_summary",
				filePath: args.filePath,
				metadata: { tool: "edit", editBatchSummary: summary },
			});
			return reject(error.reason, error.detail);
		}
		commitStatus = "failed";
		if (summaryRef || correlationId) {
			const summary = createReadGuardEditBatchSummary({
				...(summaryRef ?? {
					requestedIndexes: boundedEditIndexes(
						args.edits.map((edit) => edit.originalIndex),
					),
					requestedTotal: args.edits.length,
				}),
				appliedIndexes: [],
				appliedTotal: 0,
				participantIds: correlationId ? [correlationId] : undefined,
				participantTotal: correlationId ? 1 : undefined,
				commitStatus,
				terminalStatus: "failed",
				durationMs: Date.now() - startedAt,
			});
			logBatchEvent({
				event: "edit_batch_summary",
				filePath: args.filePath,
				metadata: { tool: "edit", editBatchSummary: summary },
			});
		}
		throw error;
	}

	let postEditOutput: string | undefined;
	let postEditStatus: ReadGuardEditBatchSummary["postEditStatus"] = "not_run";
	if (args.afterWrite) {
		try {
			postEditOutput = await args.afterWrite();
			postEditStatus = "succeeded";
			// #2402: the afterWrite pipeline (a formatter) may have rewritten the
			// file. Record the new state so an identical retry against the
			// formatted bytes is still recognized as already-applied instead of
			// falling back to oldText resolution and re-applying. Only stamped when
			// the pipeline actually changed the bytes; the post-commit hash already
			// covers a no-op pass.
			if (args.recordStore) {
				const afterWriteHash = hashFile(args.filePath);
				if (
					afterWriteHash !== undefined &&
					afterWriteHash !== committedContentHash
				) {
					for (const edit of args.edits) {
						args.recordStore.noteAfterWriteHash(
							args.filePath,
							edit.oldText,
							edit.newText,
							afterWriteHash,
						);
					}
				}
			}
		} catch (error) {
			// The write is committed. Preserve the existing caller behavior for
			// uninstrumented callers; the read-guard path records and handles it.
			postEditStatus = "failed";
			if (!summaryRef && !correlationId) throw error;
		}
	}
	const appliedIndexes = boundedEditIndexes(
		args.edits.map((edit) => edit.originalIndex),
	);
	if (!summaryRef && !correlationId) {
		return {
			appliedCount: args.edits.length,
			appliedTotal: args.edits.length,
			appliedIndices: formatBoundedEditIndexes(appliedIndexes),
			postEditOutput,
			postEditStatus,
		};
	}
	const baseSummary =
		summaryRef ??
		createReadGuardEditBatchSummary({
			requestedIndexes: appliedIndexes,
			requestedTotal: args.edits.length,
			resolvedIndexes: appliedIndexes,
			resolvedTotal: args.edits.length,
		});
	const summary = createReadGuardEditBatchSummary({
		...baseSummary,
		appliedIndexes,
		appliedTotal: args.edits.length,
		participantIds: correlationId
			? [...baseSummary.participantIds, correlationId]
			: baseSummary.participantIds,
		participantTotal: correlationId
			? baseSummary.participantTotal + 1
			: baseSummary.participantTotal,
		commitStatus,
		postEditStatus,
		// Commit failures rethrow above, so reaching here means the commit
		// landed; only the post-edit analysis can fail from this point on.
		terminalStatus: postEditStatus === "failed" ? "failed" : "success",
		durationMs: Date.now() - startedAt,
	});
	if (postEditStatus === "failed") {
		logBatchEvent({
			event: "edit_post_edit_pipeline_failed",
			filePath: args.filePath,
			metadata: {
				tool: "edit",
				commitStatus,
				appliedCount: args.edits.length,
				appliedIndexes,
				appliedTotal: args.edits.length,
			},
		});
	}
	logBatchEvent({
		event: "edit_batch_summary",
		filePath: args.filePath,
		metadata: { tool: "edit", editBatchSummary: summary },
	});
	return {
		appliedCount: args.edits.length,
		appliedTotal: args.edits.length,
		appliedIndices: formatBoundedEditIndexes(appliedIndexes),
		postEditOutput,
		postEditStatus,
		summary,
	};
}
