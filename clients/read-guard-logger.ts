import * as path from "node:path";
import { isTestMode } from "./env-utils.js";
import { getGlobalPiLensDir } from "./file-utils.js";
import { createNdjsonLogger } from "./ndjson-logger.js";

const READ_GUARD_LOG_DIR = getGlobalPiLensDir();
const READ_GUARD_LOG_FILE = path.join(READ_GUARD_LOG_DIR, "read-guard.log");
const READ_GUARD_LOG_BACKUP_FILE = path.join(
	READ_GUARD_LOG_DIR,
	"read-guard.log.1",
);
const MAX_LOG_BYTES = Math.max(
	128 * 1024,
	Number.parseInt(process.env.PI_LENS_READ_GUARD_MAX_BYTES ?? "1048576", 10) ||
		1048576,
);
const writer = createNdjsonLogger({
	filePath: READ_GUARD_LOG_FILE,
	maxBytes: MAX_LOG_BYTES,
	backupPath: READ_GUARD_LOG_BACKUP_FILE,
});
const VERBOSE_READ_GUARD_LOG =
	process.env.PI_LENS_READ_GUARD_VERBOSE === "1" ||
	process.env.PI_LENS_READ_GUARD_LOG === "verbose";
const LOG_ALLOWED_EDITS = process.env.PI_LENS_READ_GUARD_LOG_ALLOWS === "1";
const SNAPSHOT_LOG_SETTING = (
	process.env.PI_LENS_READ_GUARD_LOG_SNAPSHOTS ?? "1"
).toLowerCase();
const LOG_SNAPSHOT_VALIDATION = !["0", "false", "off"].includes(
	SNAPSHOT_LOG_SETTING,
);

export const MAX_EDIT_BATCH_ITEMS = 100;

export type EditBatchRejectionCode =
	| "oldtext_not_found"
	| "oldtext_duplicate"
	| "replace_once_skipped"
	| "preflight_blocked"
	| "write_failed"
	| "pipeline_failed";

export interface EditBatchRejection {
	index: number;
	code: EditBatchRejectionCode;
}

export interface ReadGuardEditBatchSummary {
	requestedCount: number;
	requestedIndexes: number[];
	resolvedCount: number;
	resolvedIndexes: number[];
	rejectedCount: number;
	rejectedIndexes: number[];
	rejectedReasons: EditBatchRejection[];
	appliedCount: number;
	appliedIndexes: number[];
	commitStatus: "not_attempted" | "committed" | "no_changes" | "failed";
	postEditStatus: "not_run" | "succeeded" | "failed";
	durationMs: number;
}

let generatedCorrelationCounter = 0;

function sanitizeCorrelationId(value: unknown): string | undefined {
	if (typeof value !== "string" && typeof value !== "number") return undefined;
	const sanitized = String(value)
		.trim()
		.replace(/[^a-zA-Z0-9._:-]/g, "_")
		.slice(0, 64);
	return sanitized.length > 0 ? sanitized : undefined;
}

/** Prefer the host call token; otherwise create a bounded per-process token. */
export function getReadGuardCorrelationId(event: unknown): string {
	const value = (event ?? {}) as Record<string, unknown>;
	const details = (value.details ?? {}) as Record<string, unknown>;
	for (const candidate of [
		details.readGuardCorrelationId,
		details.toolCallId,
		value.toolCallId,
		value.callId,
		value.requestId,
		value.id,
	]) {
		const sanitized = sanitizeCorrelationId(candidate);
		if (sanitized) return sanitized;
	}
	generatedCorrelationCounter =
		(generatedCorrelationCounter + 1) % 1_000_000;
	return `rg-${Date.now().toString(36)}-${generatedCorrelationCounter}`;
}

export function boundedEditIndexes(indexes: number[]): number[] {
	return [...new Set(indexes)]
		.filter((index) => Number.isInteger(index) && index >= 0)
		.slice(0, MAX_EDIT_BATCH_ITEMS);
}

export function createReadGuardEditBatchSummary(args: {
	requestedIndexes: number[];
	resolvedIndexes?: number[];
	rejectedReasons?: EditBatchRejection[];
	appliedIndexes?: number[];
	commitStatus?: ReadGuardEditBatchSummary["commitStatus"];
	postEditStatus?: ReadGuardEditBatchSummary["postEditStatus"];
	durationMs?: number;
}): ReadGuardEditBatchSummary {
	const requestedIndexes = boundedEditIndexes(args.requestedIndexes);
	const resolvedIndexes = boundedEditIndexes(args.resolvedIndexes ?? []);
	const rejectedReasons = (args.rejectedReasons ?? [])
		.filter((entry) =>
			boundedEditIndexes([entry.index]).includes(entry.index),
		)
		.slice(0, MAX_EDIT_BATCH_ITEMS);
	const rejectedIndexes = boundedEditIndexes(
		rejectedReasons.map((entry) => entry.index),
	);
	const appliedIndexes = boundedEditIndexes(args.appliedIndexes ?? []);
	return {
		requestedCount: requestedIndexes.length,
		requestedIndexes,
		resolvedCount: resolvedIndexes.length,
		resolvedIndexes,
		rejectedCount: rejectedIndexes.length,
		rejectedIndexes,
		rejectedReasons,
		appliedCount: appliedIndexes.length,
		appliedIndexes,
		commitStatus: args.commitStatus ?? "not_attempted",
		postEditStatus: args.postEditStatus ?? "not_run",
		durationMs: Math.max(0, Math.min(args.durationMs ?? 0, 86_400_000)),
	};
}

export interface ReadGuardLogEntry {
	event: string;
	sessionId?: string;
	/** Bounded host/tool-call correlation token, persisted inside metadata. */
	correlationId?: string;
	filePath: string;
	requestedOffset?: number;
	requestedLimit?: number;
	effectiveOffset?: number;
	effectiveLimit?: number;
	symbol?: string;
	symbolKind?: string;
	symbolStartLine?: number;
	symbolEndLine?: number;
	metadata?: Record<string, unknown>;
}

function shouldLogEvent(event: string): boolean {
	if (VERBOSE_READ_GUARD_LOG) return true;
	if (event === "edit_allowed") return LOG_ALLOWED_EDITS;
	if (event === "range_snapshot_validation") return LOG_SNAPSHOT_VALIDATION;
	return (
		event === "edit_blocked" ||
		event === "edit_warned" ||
		event === "exemption_added" ||
		event === "oldtext_not_found" ||
		event === "oldtext_duplicate" ||
		event === "oldtext_indent_autopatched" ||
		event === "oldtext_trailing_ws_autopatched" ||
		event === "oldtext_escape_autopatched" ||
		event === "edit_range_relocated" ||
		event === "edit_preflight_blocked" ||
		event === "edit_partial_apply" ||
		event === "edit_partial_apply_skipped" ||
		event === "edit_post_edit_pipeline_failed" ||
		event === "edit_batch_summary" ||
		event === "touched_lines_missing"
	);
}

export function logReadGuardEvent(entry: ReadGuardLogEntry): void {
	if (isTestMode() || !shouldLogEvent(entry.event)) {
		return;
	}
	const metadata = entry.correlationId
		? { ...(entry.metadata ?? {}), correlationId: entry.correlationId }
		: entry.metadata;
	const { correlationId: _correlationId, ...logEntry } = entry;
	writer.log({ ts: new Date().toISOString(), ...logEntry, metadata });
}

export function getReadGuardLogPath(): string {
	return READ_GUARD_LOG_FILE;
}

/** Resolve once all enqueued read-guard writes are on disk (tests/shutdown). */
export function flushReadGuardLog(): Promise<void> {
	return writer.flush();
}
