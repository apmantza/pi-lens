import * as path from "node:path";
import {
	createReadGuardEditBatchSummary,
	getReadGuardCorrelationId,
	logReadGuardEvent,
	type ReadGuardEditBatchSummary,
} from "./read-guard-logger.js";
import {
	appendProjectChange,
	type ProjectChangeSource,
} from "./project-changes.js";
import type { AppliedWorkspaceEdit } from "./lsp/edits.js";
import { normalizeMapKey } from "./path-utils.js";

export interface LspMutationRuntime {
	bumpFileSeq?: (filePath: string) => { projectSeq: number; fileSeq: number };
	telemetrySessionId?: string;
	turnIndex?: number;
}

export interface LspMutationCacheManager {
	addModifiedRange: (
		filePath: string,
		range: { start: number; end: number },
		importsChanged: boolean,
		cwd: string,
		sessionId?: string,
	) => unknown;
}

export interface LspMutationContext {
	cwd: string;
	correlationId: string;
	tool: string;
	source: "lsp-edit" | "autofix";
	runtime?: LspMutationRuntime;
	readGuard?: { recordWritten: (filePath: string) => void };
	cacheManager?: LspMutationCacheManager;
	/** Existing autonomous-write publishers. Agent-owned navigation edits do not set these. */
	publishFilesTouched?: (paths: string[]) => void;
	recordAutofix?: (filePath: string) => void;
	dbg?: (message: string) => void;
	/** Batch callers can defer the single terminal log until all edits are attempted. */
	emitSummary?: boolean;
	/** Internal duplicate/debounce guard for a logical mutation request. */
	summaryEmitted?: boolean;
	/** Bounded per-batch dedupe for the existing turn-summary autofix publisher. */
	autofixRecordedPaths?: Set<string>;
}

export interface LspMutationSummaryOptions {
	requestedTotal?: number;
	considered?: number;
	completed?: number;
	failedCount?: number;
	results?: AppliedWorkspaceEdit[];
	bookkeep?: boolean;
	status?: "success" | "failed" | "skipped";
}

export interface LspMutationTelemetry {
	editBatchSummary: ReadGuardEditBatchSummary;
	operationCounts: {
		requested: number;
		applied: number;
		textEdits: number;
		create: number;
		rename: number;
		delete: number;
	};
	sampledPaths: string[];
	sampledPathsTotal: number;
	sampledPathsTruncated: boolean;
	considered?: number;
	completed?: number;
	failedCount?: number;
}

const MAX_SAMPLES = 100;

export function newLspMutationCorrelationId(toolCallId?: string): string {
	return getReadGuardCorrelationId(toolCallId ? { toolCallId } : {});
}

function allResults(
	options: LspMutationSummaryOptions,
): AppliedWorkspaceEdit[] {
	return options.results ?? [];
}

function combineResults(results: AppliedWorkspaceEdit[]): {
	requestedTotal: number;
	appliedTotal: number;
	appliedIndexes: number[];
	files: string[];
	fileDetails: AppliedWorkspaceEdit["fileDetails"];
	textEdits: number;
	create: number;
	rename: number;
	delete: number;
	paths: string[];
} {
	const files = new Set<string>();
	const fileDetails: AppliedWorkspaceEdit["fileDetails"] = [];
	const appliedIndexes: number[] = [];
	const paths: string[] = [];
	let requestedTotal = 0;
	let appliedTotal = 0;
	let textEdits = 0;
	let create = 0;
	let rename = 0;
	let deleteCount = 0;
	for (const result of results) {
		requestedTotal += result.operationTotal;
		appliedTotal += result.appliedOperationTotal;
		textEdits += result.operationCounts.textEdits;
		create += result.operationCounts.create;
		rename += result.operationCounts.rename;
		deleteCount += result.operationCounts.delete;
		for (const index of result.appliedOperationIndexes) appliedIndexes.push(index);
		for (const file of result.files) {
			if (!files.has(file)) {
				files.add(file);
				paths.push(file);
			}
		}
		fileDetails.push(...result.fileDetails);
	}
	return {
		requestedTotal,
		appliedTotal,
		appliedIndexes,
		files: [...files],
		fileDetails,
		textEdits,
		create,
		rename,
		delete: deleteCount,
		paths,
	};
}

function uniqueDetails(
	files: string[],
	fileDetails: AppliedWorkspaceEdit["fileDetails"],
): AppliedWorkspaceEdit["fileDetails"] {
	const byPath = new Map<string, AppliedWorkspaceEdit["fileDetails"][number]>();
	for (const detail of fileDetails) {
		const key = normalizeMapKey(path.resolve(detail.filePath));
		const previous = byPath.get(key);
		if (!previous) {
			byPath.set(key, detail);
			continue;
		}
		byPath.set(key, {
			filePath: previous.filePath,
			range:
				previous.range && detail.range
					? {
						start: Math.min(previous.range.start, detail.range.start),
						end: Math.max(previous.range.end, detail.range.end),
					}
					: previous.range ?? detail.range,
			importsChanged: previous.importsChanged || detail.importsChanged,
		});
	}
	return files.map(
		(filePath) =>
			byPath.get(normalizeMapKey(path.resolve(filePath))) ?? {
				filePath,
				// Resource operations have no already-computed text range. A small
				// range is still enough to invalidate the touched-file turn state;
				// never synchronously re-read the whole file here.
				range: { start: 1, end: 1 },
				importsChanged: true,
			},
	);
}

function bookkeepLspMutation(
	context: LspMutationContext,
	files: string[],
	fileDetails: AppliedWorkspaceEdit["fileDetails"],
): void {
	const details = uniqueDetails(files, fileDetails);
	for (const detail of details) {
		const filePath = path.resolve(detail.filePath);
		if (context.readGuard) {
			try {
				context.readGuard.recordWritten(filePath);
			} catch (err) {
				context.dbg?.(`lsp mutation read-guard stamp failed for ${filePath}: ${err}`);
			}
		}
		const runtime = context.runtime;
		if (runtime?.bumpFileSeq) {
			const { projectSeq, fileSeq } = runtime.bumpFileSeq(filePath);
			try {
				appendProjectChange(context.cwd, {
					seq: projectSeq,
					timestamp: new Date().toISOString(),
					sessionId: runtime.telemetrySessionId ?? "unknown",
					turnIndex: runtime.turnIndex ?? 0,
					source: context.source as ProjectChangeSource,
					filePath,
					fileSeq,
					changedRange: detail.range,
				});
			} catch (err) {
				context.dbg?.(`lsp mutation project change append failed for ${filePath}: ${err}`);
			}
		}
		if (context.cacheManager) {
			try {
				context.cacheManager.addModifiedRange(
					filePath,
					detail.range ?? { start: 1, end: 1 },
					detail.importsChanged ?? true,
					context.cwd,
					runtime?.telemetrySessionId,
				);
			} catch (err) {
				context.dbg?.(`lsp mutation modified-range tracking failed for ${filePath}: ${err}`);
			}
		}
		if (context.recordAutofix && context.source === "autofix") {
			const key = normalizeMapKey(filePath);
			const seen = context.autofixRecordedPaths ?? new Set<string>();
			context.autofixRecordedPaths = seen;
			if (!seen.has(key)) {
				if (seen.size >= MAX_SAMPLES) {
					const oldest = seen.values().next().value;
					if (oldest) seen.delete(oldest);
				}
				seen.add(key);
				context.recordAutofix(filePath);
			}
		}
	}
	if (context.publishFilesTouched && files.length > 0) {
		context.publishFilesTouched(files);
	}
}

function telemetryFor(
	context: LspMutationContext,
	options: LspMutationSummaryOptions,
): LspMutationTelemetry {
	const combined = combineResults(allResults(options));
	const requestedTotal = options.requestedTotal ?? combined.requestedTotal;
	const appliedTotal = combined.appliedTotal;
	const requestedIndexes = Array.from(
		{ length: Math.min(requestedTotal, MAX_SAMPLES) },
		(_, index) => index,
	);
	const rejectedTotal = Math.max(0, requestedTotal - appliedTotal);
	const rejectedReasons = Array.from(
		{ length: Math.min(rejectedTotal, MAX_SAMPLES) },
		(_, index) => ({ index, code: "write_failed" as const }),
	);
	const status =
		options.status ?? (appliedTotal > 0 ? "success" : "skipped");
	const editBatchSummary = createReadGuardEditBatchSummary({
		requestedIndexes,
		requestedTotal,
		resolvedIndexes: requestedIndexes,
		resolvedTotal: requestedTotal,
		rejectedReasons,
		rejectedTotal,
		appliedIndexes: combined.appliedIndexes,
		appliedTotal,
		participantIds: [context.correlationId],
		participantTotal: 1,
		commitStatus:
			status === "failed"
				? "failed"
				: appliedTotal > 0
					? "committed"
					: "no_changes",
		terminalStatus: status,
	});
	return {
		editBatchSummary,
		operationCounts: {
			requested: requestedTotal,
			applied: appliedTotal,
			textEdits: combined.textEdits,
			create: combined.create,
			rename: combined.rename,
			delete: combined.delete,
		},
		sampledPaths: combined.paths.slice(0, MAX_SAMPLES),
		sampledPathsTotal: combined.paths.length,
		sampledPathsTruncated: combined.paths.length > MAX_SAMPLES,
		considered: options.considered,
		completed: options.completed,
		failedCount: options.failedCount,
	};
}

export function recordLspMutation(
	context: LspMutationContext,
	options: LspMutationSummaryOptions = {},
): LspMutationTelemetry {
	const results = allResults(options);
	const combined = combineResults(results);
	if (options.bookkeep !== false && combined.files.length > 0) {
		bookkeepLspMutation(context, combined.files, combined.fileDetails);
	}
	const telemetry = telemetryFor(context, options);
	if (context.emitSummary !== false && !context.summaryEmitted) {
		context.summaryEmitted = true;
		logReadGuardEvent({
			event: "edit_batch_summary",
			correlationId: context.correlationId,
			filePath: combined.files[0] ?? context.cwd,
			metadata: {
				tool: context.tool,
				source: context.source,
				outcome: telemetry.editBatchSummary.terminalStatus,
				editBatchSummary: telemetry.editBatchSummary,
				operationCounts: telemetry.operationCounts,
				sampledPaths: telemetry.sampledPaths,
				sampledPathsTotal: telemetry.sampledPathsTotal,
				sampledPathsTruncated: telemetry.sampledPathsTruncated,
				considered: telemetry.considered,
				completed: telemetry.completed,
				failedCount: telemetry.failedCount,
			},
		});
	}
	return telemetry;
}

export function recordLspMutationBatch(
	context: LspMutationContext,
	options: LspMutationSummaryOptions,
): LspMutationTelemetry {
	const previous = context.emitSummary;
	context.emitSummary = true;
	try {
		return recordLspMutation(context, options);
	} finally {
		context.emitSummary = previous;
	}
}

export function recordLspMutationOutcome(
	context: LspMutationContext,
	status: "success" | "failed" | "skipped",
): LspMutationTelemetry {
	return recordLspMutation(context, { status, requestedTotal: 0 });
}
