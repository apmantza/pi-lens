import * as path from "node:path";
import { isTestMode } from "./env-utils.js";
import { getGlobalPiLensLogDir } from "./probe-home-state.js";
import { createNdjsonLogger } from "./ndjson-logger.js";
import { normalizeFilePath } from "./path-utils.js";

const READ_GUARD_LOG_DIR = getGlobalPiLensLogDir();
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

const MAX_EDIT_BATCH_ITEMS = 100;

type EditBatchRejectionCode =
	| "oldtext_not_found"
	| "oldtext_unrepresentable"
	| "oldtext_duplicate"
	| "span_overlap"
	| "preflight_blocked"
	| "write_failed"
	| "pipeline_failed";

export interface EditBatchRejection {
	index: number;
	code: EditBatchRejectionCode;
}

export interface ReadGuardEditBatchSummary {
	/** True totals; the corresponding indexes are bounded, de-duplicated samples. */
	requestedCount: number;
	requestedTotal: number;
	requestedIndexes: number[];
	resolvedCount: number;
	resolvedTotal: number;
	resolvedIndexes: number[];
	rejectedCount: number;
	rejectedTotal: number;
	rejectedIndexes: number[];
	rejectedReasons: EditBatchRejection[];
	appliedCount: number;
	appliedTotal: number;
	appliedIndexes: number[];
	/** Edits recognized as exact retries of already-applied pairs (#2402). */
	alreadyAppliedCount: number;
	alreadyAppliedTotal: number;
	alreadyAppliedIndexes: number[];
	/** Correlations participating in a coalesced terminal outcome. */
	participantIds: string[];
	participantTotal: number;
	participantIdsTruncated: boolean;
	indexesTruncated: boolean;
	commitStatus: "not_attempted" | "committed" | "no_changes" | "failed";
	postEditStatus: "not_run" | "succeeded" | "failed";
	terminalStatus: "success" | "failed" | "blocked" | "skipped";
	durationMs: number;
}

let generatedCorrelationCounter = 0;

export function sanitizeCorrelationId(value: unknown): string | undefined {
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
	generatedCorrelationCounter = (generatedCorrelationCounter + 1) % 1_000_000;
	return `rg-${Date.now().toString(36)}-${generatedCorrelationCounter}`;
}

function validIndexes(indexes: number[]): number[] {
	return indexes.filter((index) => Number.isInteger(index) && index >= 0);
}

export function boundedEditIndexes(indexes: number[]): number[] {
	return [...new Set(validIndexes(indexes))].slice(0, MAX_EDIT_BATCH_ITEMS);
}

export function boundedIndexesForCount(count: number): number[] {
	const boundedCount = Math.max(0, Math.floor(count));
	return Array.from(
		{ length: Math.min(boundedCount, MAX_EDIT_BATCH_ITEMS) },
		(_, index) => index,
	);
}

export function formatBoundedEditIndexes(indexes: number[]): string {
	return boundedEditIndexes(indexes)
		.map((index) => `edits[${index}]`)
		.join(", ");
}

export function createReadGuardEditBatchSummary(args: {
	requestedIndexes: number[];
	requestedTotal?: number;
	resolvedIndexes?: number[];
	resolvedTotal?: number;
	rejectedReasons?: EditBatchRejection[];
	rejectedTotal?: number;
	appliedIndexes?: number[];
	appliedTotal?: number;
	alreadyAppliedIndexes?: number[];
	alreadyAppliedTotal?: number;
	participantIds?: string[];
	participantTotal?: number;
	commitStatus?: ReadGuardEditBatchSummary["commitStatus"];
	postEditStatus?: ReadGuardEditBatchSummary["postEditStatus"];
	terminalStatus?: ReadGuardEditBatchSummary["terminalStatus"];
	durationMs?: number;
}): ReadGuardEditBatchSummary {
	const requestedSource = validIndexes(args.requestedIndexes);
	const resolvedSource = validIndexes(args.resolvedIndexes ?? []);
	const rejectedSource = (args.rejectedReasons ?? []).filter(
		(entry) => Number.isInteger(entry.index) && entry.index >= 0,
	);
	const appliedSource = validIndexes(args.appliedIndexes ?? []);
	const alreadyAppliedSource = validIndexes(args.alreadyAppliedIndexes ?? []);
	const requestedIndexes = boundedEditIndexes(requestedSource);
	const resolvedIndexes = boundedEditIndexes(resolvedSource);
	const rejectedReasons = rejectedSource.slice(0, MAX_EDIT_BATCH_ITEMS);
	const rejectedIndexes = boundedEditIndexes(
		rejectedSource.map((entry) => entry.index),
	);
	const appliedIndexes = boundedEditIndexes(appliedSource);
	const alreadyAppliedIndexes = boundedEditIndexes(alreadyAppliedSource);
	const participantSource = (args.participantIds ?? []).filter(
		(id): id is string => typeof id === "string" && id.length > 0,
	);
	const participantIds = [...new Set(participantSource)].slice(
		0,
		MAX_EDIT_BATCH_ITEMS,
	);
	const commitStatus = args.commitStatus ?? "not_attempted";
	const postEditStatus = args.postEditStatus ?? "not_run";
	const terminalStatus =
		args.terminalStatus ??
		(postEditStatus === "failed" || commitStatus === "failed"
			? "failed"
			: commitStatus === "not_attempted" && rejectedSource.length > 0
				? "blocked"
				: commitStatus === "no_changes"
					? "skipped"
					: "success");
	return {
		requestedCount: requestedSource.length,
		requestedTotal: args.requestedTotal ?? requestedSource.length,
		requestedIndexes,
		resolvedCount: resolvedSource.length,
		resolvedTotal: args.resolvedTotal ?? resolvedSource.length,
		resolvedIndexes,
		rejectedCount: rejectedSource.length,
		rejectedTotal: args.rejectedTotal ?? rejectedSource.length,
		rejectedIndexes,
		rejectedReasons,
		appliedCount: appliedSource.length,
		appliedTotal: args.appliedTotal ?? appliedSource.length,
		appliedIndexes,
		alreadyAppliedCount: alreadyAppliedSource.length,
		alreadyAppliedTotal:
			args.alreadyAppliedTotal ?? alreadyAppliedSource.length,
		alreadyAppliedIndexes,
		participantIds,
		participantTotal: args.participantTotal ?? participantSource.length,
		participantIdsTruncated:
			(args.participantTotal ?? participantSource.length) >
			participantIds.length,
		indexesTruncated:
			(args.requestedTotal ?? requestedSource.length) >
				requestedIndexes.length ||
			(args.resolvedTotal ?? resolvedSource.length) > resolvedIndexes.length ||
			(args.rejectedTotal ?? rejectedSource.length) > rejectedIndexes.length ||
			(args.appliedTotal ?? appliedSource.length) > appliedIndexes.length ||
			(args.alreadyAppliedTotal ?? alreadyAppliedSource.length) >
				alreadyAppliedIndexes.length,
		commitStatus,
		postEditStatus,
		terminalStatus,
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

export function shouldLogEvent(event: string): boolean {
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
		// #2402: pre-write batch rejections and recognized exact retries are the
		// two new partial-apply outcomes; each is rare by construction.
		event === "edit_partial_apply_rejected" ||
		event === "edit_already_applied_retry" ||
		event === "edit_post_edit_pipeline_failed" ||
		event === "edit_batch_summary" ||
		event === "edit_batch_summary_overflow" ||
		event === "touched_lines_missing" ||
		// #1913: read-guard record-cap evictions are rare by construction (only
		// READ_GUARD_MAX_RECORDS_PER_FILE overflow triggers one), so this trim
		// record bypasses the per-read verbosity gate — a live eviction
		// regression must be visible without PI_LENS_READ_GUARD_VERBOSE=1.
		event === "read_cap_trimmed" ||
		// #1918: the record-cap trim's population siblings — whole-file
		// eviction under real pressure (file cap or an external delete) and
		// the per-file edits-cap trim. Idle-timeout eviction is deliberately
		// EXCLUDED from this event (see read-guard.ts's evictFile doc
		// comment) — it's routine housekeeping, not a fault, and its
		// per-file cardinality is unbounded in a healthy session. Same
		// rarity argument as #1913 for the reasons that DO fire: each is
		// rising-edge gated once per file per session, so always-on
		// visibility costs nothing.
		event === "read_file_evicted" ||
		event === "edits_cap_trimmed"
	);
}

const MAX_TELEMETRY_STRING = 512;
const MAX_TELEMETRY_KEYS = 64;

type BoundedTelemetry = {
	value: unknown;
	truncated: boolean;
	arrayTotals: Record<string, number>;
};

function boundTelemetryValue(
	value: unknown,
	pathName: string,
	depth: number,
): BoundedTelemetry {
	if (typeof value === "string") {
		return value.length > MAX_TELEMETRY_STRING
			? {
					value: `${value.slice(0, MAX_TELEMETRY_STRING)}…`,
					truncated: true,
					arrayTotals: {},
				}
			: { value, truncated: false, arrayTotals: {} };
	}
	if (Array.isArray(value)) {
		const sampled = value.slice(0, MAX_EDIT_BATCH_ITEMS);
		const bounded = sampled.map((item, index) =>
			boundTelemetryValue(item, `${pathName}[${index}]`, depth + 1),
		);
		const arrayTotals: Record<string, number> =
			value.length > MAX_EDIT_BATCH_ITEMS
				? { [pathName || "array"]: value.length }
				: {};
		let truncated = value.length > MAX_EDIT_BATCH_ITEMS;
		for (const item of bounded) {
			truncated ||= item.truncated;
			Object.assign(arrayTotals, item.arrayTotals);
		}
		return {
			value: bounded.map((item) => item.value),
			truncated,
			arrayTotals,
		};
	}
	if (!value || typeof value !== "object" || depth >= 4) {
		return { value, truncated: false, arrayTotals: {} };
	}
	const output: Record<string, unknown> = {};
	let truncated = false;
	const arrayTotals: Record<string, number> = {};
	for (const [key, child] of Object.entries(value).slice(
		0,
		MAX_TELEMETRY_KEYS,
	)) {
		const bounded = boundTelemetryValue(
			child,
			pathName ? `${pathName}.${key}` : key,
			depth + 1,
		);
		output[key] = bounded.value;
		truncated ||= bounded.truncated;
		Object.assign(arrayTotals, bounded.arrayTotals);
	}
	if (Object.keys(value).length > MAX_TELEMETRY_KEYS) truncated = true;
	return { value: output, truncated, arrayTotals };
}

export function logReadGuardEvent(entry: ReadGuardLogEntry): void {
	if (isTestMode() || !shouldLogEvent(entry.event)) {
		return;
	}
	const rawMetadata = entry.correlationId
		? { ...entry.metadata, correlationId: entry.correlationId }
		: entry.metadata;
	const bounded = boundTelemetryValue(rawMetadata, "metadata", 0);
	const metadata: Record<string, unknown> | undefined =
		bounded.truncated && bounded.value && typeof bounded.value === "object"
			? {
					...(bounded.value as Record<string, unknown>),
					telemetryTruncated: true,
					telemetryArrayTotals: bounded.arrayTotals,
				}
			: bounded.value && typeof bounded.value === "object"
				? (bounded.value as Record<string, unknown>)
				: undefined;
	const { correlationId: _correlationId, ...logEntry } = entry;
	// #2219 (the #2141 class): `filePath` reaches here from
	// `runtime-tool-result.ts`'s raw `path.resolve()`/`path.isAbsolute()`
	// arithmetic (never `normalizeFilePath`-passed), always a genuine file —
	// this field carries no non-path sentinel. Normalize once at this single
	// emit seam, matching `review-graph-logger.ts`'s `logReviewGraph`.
	writer.log({
		ts: new Date().toISOString(),
		...logEntry,
		filePath: normalizeFilePath(logEntry.filePath),
		metadata,
	});
}

export function getReadGuardLogPath(): string {
	return READ_GUARD_LOG_FILE;
}

/** Resolve once all enqueued read-guard writes are on disk (tests/shutdown). */
export function flushReadGuardLog(): Promise<void> {
	return writer.flush();
}
