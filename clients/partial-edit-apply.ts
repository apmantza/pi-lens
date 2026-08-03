import type { EditToolInput } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import {
	detectLineEnding,
	normalizeToLF,
	restoreLineEndings,
} from "./host-edit-normalize.js";
import {
	createReadGuardEditBatchSummary,
	logReadGuardEvent,
	type ReadGuardEditBatchSummary,
} from "./read-guard-logger.js";

// A single edit element of the host edit tool ({ oldText, newText }). Pinned to
// the SDK's EditToolInput so a host schema rename (e.g. oldText -> old_text) is a
// compile error here rather than a silent runtime mismatch (#257 / refs #2).
type HostEdit = EditToolInput["edits"][number];

export interface PartiallyApplicableEdit {
	oldText: HostEdit["oldText"];
	// Widened vs the host: pi-lens models a pure deletion as an absent newText.
	newText: HostEdit["newText"] | undefined;
	originalIndex: number;
}

export interface PartialEditApplyResult {
	appliedCount: number;
	appliedIndices: string;
	postEditOutput?: string;
	/** Present for the instrumented read-guard path. */
	skippedCount?: number;
	skippedIndices?: string;
	postEditStatus?: "not_run" | "succeeded" | "failed";
	summary?: ReadGuardEditBatchSummary;
}

function replaceOnce(
	content: string,
	oldText: string,
	newText: string,
): {
	content: string;
	changed: boolean;
} {
	const idx = content.indexOf(oldText);
	if (idx === -1) return { content, changed: false };
	return {
		content:
			content.slice(0, idx) + newText + content.slice(idx + oldText.length),
		changed: true,
	};
}

/**
 * Applies already-resolved oldText edits from the preflight path, then invokes
 * the caller's normal post-edit bookkeeping/pipeline hook. The edits are exact
 * LF-normalized replacements; entries that no longer match are skipped rather
 * than logged as applied.
 */
export async function applyPartiallyApplicableEdits(args: {
	filePath: string;
	edits: PartiallyApplicableEdit[];
	afterWrite?: () => Promise<string | undefined>;
	/** Read-guard preflight summary, reused rather than re-shaped here. */
	summary?: ReadGuardEditBatchSummary;
	correlationId?: string;
}): Promise<PartialEditApplyResult> {
	const startedAt = Date.now();
	const raw = fs.readFileSync(args.filePath, "utf-8");
	// Detect + restore line endings the way the host edit tool does:
	// first-occurrence-wins detection (not "any CRLF present") and lone-CR -> LF
	// normalization, so this self-apply path can't diverge from how the host
	// would have written the same edits (#257).
	const ending = detectLineEnding(raw);
	let content = normalizeToLF(raw);
	const applied: number[] = [];
	const skipped: number[] = [];

	for (const edit of args.edits) {
		const oldText = normalizeToLF(edit.oldText);
		const newText = normalizeToLF(edit.newText ?? "");
		const replaced = replaceOnce(content, oldText, newText);
		if (!replaced.changed) {
			skipped.push(edit.originalIndex);
			logReadGuardEvent({
				event: "edit_partial_apply_skipped",
				correlationId: args.correlationId,
				filePath: args.filePath,
				metadata: {
					tool: "edit",
					reasonCode: "replace_once_skipped",
					editIndex: edit.originalIndex,
				},
			});
			continue;
		}
		content = replaced.content;
		applied.push(edit.originalIndex);
	}

	let commitStatus: ReadGuardEditBatchSummary["commitStatus"] =
		applied.length > 0 ? "committed" : "no_changes";
	try {
		if (applied.length > 0) {
			fs.writeFileSync(
				args.filePath,
				restoreLineEndings(content, ending),
				"utf-8",
			);
		}
	} catch (error) {
		commitStatus = "failed";
		if (args.summary || args.correlationId) {
			const summary = createReadGuardEditBatchSummary({
				...(args.summary ?? { requestedIndexes: args.edits.map((edit) => edit.originalIndex) }),
				appliedIndexes: [],
				commitStatus,
				durationMs: Date.now() - startedAt,
			});
			logReadGuardEvent({
				event: "edit_batch_summary",
				correlationId: args.correlationId,
				filePath: args.filePath,
				metadata: { tool: "edit", editBatchSummary: summary },
			});
		}
		throw error;
	}

	let postEditOutput: string | undefined;
	let postEditStatus: ReadGuardEditBatchSummary["postEditStatus"] = "not_run";
	if (applied.length > 0 && args.afterWrite) {
		try {
			postEditOutput = await args.afterWrite();
			postEditStatus = "succeeded";
		} catch (error) {
			// The write is committed. Preserve the existing caller behavior for
			// uninstrumented callers; the read-guard path records and handles it.
			postEditStatus = "failed";
			if (!args.summary && !args.correlationId) throw error;
		}
	}
	if (!args.summary && !args.correlationId) {
		return {
			appliedCount: applied.length,
			appliedIndices: applied.map((index) => `edits[${index}]`).join(", "),
			postEditOutput,
		};
	}
	const baseSummary = args.summary ??
		createReadGuardEditBatchSummary({
			requestedIndexes: args.edits.map((edit) => edit.originalIndex),
			resolvedIndexes: args.edits.map((edit) => edit.originalIndex),
		});
	const summary = createReadGuardEditBatchSummary({
		...baseSummary,
		rejectedReasons: [
			...baseSummary.rejectedReasons,
			...skipped.map((index) => ({ index, code: "replace_once_skipped" as const })),
		],
		appliedIndexes: applied,
		commitStatus,
		postEditStatus,
		durationMs: Date.now() - startedAt,
	});
	if (postEditStatus === "failed") {
		logReadGuardEvent({
			event: "edit_post_edit_pipeline_failed",
			correlationId: args.correlationId,
			filePath: args.filePath,
			metadata: {
				tool: "edit",
				commitStatus,
				appliedCount: applied.length,
				appliedIndexes: applied.slice(0, 100),
			},
		});
	}
	logReadGuardEvent({
		event: "edit_batch_summary",
		correlationId: args.correlationId,
		filePath: args.filePath,
		metadata: { tool: "edit", editBatchSummary: summary },
	});
	return {
		appliedCount: applied.length,
		appliedIndices: applied.map((index) => `edits[${index}]`).join(", "),
		postEditOutput,
		skippedCount: skipped.length,
		skippedIndices: skipped.map((index) => `edits[${index}]`).join(", "),
		postEditStatus,
		summary,
	};
}
