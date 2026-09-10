import * as path from "node:path";
import { isTestMode } from "./env-utils.js";
import { getGlobalPiLensLogDir } from "./probe-home-state.js";
import { getMaxLogSizeMB } from "./log-cleanup.js";
import { createNdjsonLogger } from "./ndjson-logger.js";
import { normalizeFilePath } from "./path-utils.js";
import { getTurnId } from "./turn-context.js";
import type {
	ReviewGraph,
	ReviewGraphPersistCoverage,
} from "./review-graph/types.js";

const REVIEW_GRAPH_LOG_DIR = getGlobalPiLensLogDir();
const REVIEW_GRAPH_LOG_FILE = path.join(
	REVIEW_GRAPH_LOG_DIR,
	"review-graph.log",
);

// Bounded like every other global sink (#2505) — see sessionstart-logger.
const writer = createNdjsonLogger({
	filePath: REVIEW_GRAPH_LOG_FILE,
	maxBytes: getMaxLogSizeMB() * 1024 * 1024,
	backupPath: `${REVIEW_GRAPH_LOG_FILE}.1`,
});

export type ReviewGraphBuildMode =
	| "full"
	| "cached"
	| "incremental"
	| "skipped"
	| "seq-fastpath";

/** Counts and identity for the graph content involved in an operational event. */
export interface ReviewGraphBuildMetadata {
	buildId?: number;
	graphGeneration?: number;
	builtAt?: string;
	projectSeq?: number;
	seqHint?: boolean;
	mode?: ReviewGraphBuildMode;
	sourceFiles?: number;
	/** True when sourceFiles is a lower bound from a truncated source walk. */
	sourceFilesTruncated?: boolean;
	/** Raw walker spellings that missed the bounded canonical-path memo. */
	pathNormalizeCalls?: number;
	nodes: number;
	edges: number;
	/** Exact complete-vs-partial coverage of the persisted graph snapshot. */
	persistCoverage?: ReviewGraphPersistCoverage;
}

/** Parent-side persistence lifecycle identity/status. */
export interface ReviewGraphPersistenceMetadata {
	generation: number;
	attemptId: number;
	status: "scheduled" | "succeeded" | "failed" | "fallback" | "superseded";
	supersededGeneration?: number;
	supersededByGeneration?: number;
	coalesced?: boolean;
	reason?: string;
	workerStarted?: boolean;
	workerCompleted?: boolean;
	workerFallback?: boolean;
}

export interface ReviewGraphOperationalMetadata {
	graph?: ReviewGraphBuildMetadata;
	persistence?: ReviewGraphPersistenceMetadata;
}

export interface ReviewGraphBuildMetadataOptions {
	buildId?: number;
	projectSeq?: number;
	seqHint?: boolean;
	mode?: ReviewGraphBuildMode;
	sourceFileCount?: number;
	sourceFileCountTruncated?: boolean;
	pathNormalizeCalls?: number;
}

/**
 * Build the one canonical graph metadata shape used by build and persist logs.
 * Counts come from the graph instance; source-file count may use the exact
 * signature-map count when the build has one, otherwise the graph file index.
 */
export function makeReviewGraphBuildMetadata(
	graph: Pick<
		ReviewGraph,
		| "buildGeneration"
		| "builtAt"
		| "nodes"
		| "edges"
		| "fileNodes"
		| "persistCoverage"
	>,
	options: ReviewGraphBuildMetadataOptions = {},
): ReviewGraphBuildMetadata {
	return {
		...(options.buildId === undefined ? {} : { buildId: options.buildId }),
		...(graph.buildGeneration === undefined
			? {}
			: { graphGeneration: graph.buildGeneration }),
		builtAt: graph.builtAt,
		...(options.projectSeq === undefined
			? {}
			: { projectSeq: options.projectSeq }),
		...(options.seqHint === undefined ? {} : { seqHint: options.seqHint }),
		...(options.mode === undefined ? {} : { mode: options.mode }),
		sourceFiles: options.sourceFileCount ?? graph.fileNodes.size,
		...(options.sourceFileCountTruncated ||
		graph.persistCoverage?.sourceFilesTruncated
			? { sourceFilesTruncated: true }
			: {}),
		...(options.pathNormalizeCalls === undefined
			? {}
			: { pathNormalizeCalls: options.pathNormalizeCalls }),
		nodes: graph.nodes.size,
		edges: graph.edges.length,
		...(graph.persistCoverage
			? { persistCoverage: graph.persistCoverage }
			: {}),
	};
}

export interface ReviewGraphLogEntry {
	ts?: string;
	/** Logger process identity for machine-global log correlation. */
	pid?: number;
	turnId?: string;
	phase:
		| "build_started"
		| "build_succeeded"
		| "build_skipped"
		| "build_failed"
		| "lsp_symbol_fallback"
		| "persist_scheduled"
		| "persist_partial"
		| "persist_succeeded"
		| "persist_skipped"
		| "persist_failed"
		| "worker_fallback"
		// #936 limit 2: cross-session resumable full build (checkpointing).
		| "checkpoint_written"
		| "checkpoint_resumed"
		// A present checkpoint was rejected (fail-open to a cold build) — `reason`
		// says why, so "why isn't my checkpoint resuming?" is diagnosable.
		| "checkpoint_discarded"
		// An offloaded/sync checkpoint WRITE failed — resume won't be available
		// next session; `reason` carries the cause.
		| "checkpoint_write_failed"
		// #1961: the BLIND read path (`getCachedReviewGraph`) dropped a persisted
		// snapshot. `reason` names why — today only a worktree-identity mismatch,
		// since a HEAD move no longer drops anything. Bounded: rising edge per
		// (verdict, cwd) off the `review-graph-snapshot-read` ledger kind.
		| "snapshot_read_dropped"
		// #1961: the blind read SERVED a snapshot stamped at a different HEAD.
		// Not a drop and not a failure — the verdict that used to be a silent
		// drop, now recorded so "why is my graph from yesterday's commit?" is
		// answerable. Same bound as `snapshot_read_dropped`.
		| "snapshot_read_drifted";
	cwd: string;
	/** Additive, bounded lifecycle metadata; never contains source contents/paths. */
	observability?: ReviewGraphOperationalMetadata;
	reason?: string;
	durationMs?: number;
	nodes?: number;
	edges?: number;
	elements?: number;
	persistedElements?: number;
	cap?: number;
	error?: string;
	rawBytes?: number;
	gzBytes?: number;
	serializeMs?: number;
	writeMs?: number;
	offloaded?: boolean;
	// #936: checkpoint telemetry (files processed / reused / re-walked / target).
	processed?: number;
	reused?: number;
	stale?: number;
	remaining?: number;
	target?: number;
}

/**
 * #2141: call sites feed this a mix of raw `cwd` params and already-normalized
 * cache keys (`normalizeMapKey(path.resolve(cwd))`), so the same project root
 * showed up in the log as both `C:\...\pi-free` and `C:/.../pi-free`. Rather
 * than auditing every call site, normalize once here — the single emit
 * seam — matching the form `normalizeFilePath` already produces for every
 * other structured log's `cwd` field (bus-publish, disposition-publish,
 * diagnostics-publish, format-events-publish all normalize at their publish
 * call sites; this pulls the same conversion in-house so no future call site
 * can regress it).
 */
export function logReviewGraph(entry: ReviewGraphLogEntry): void {
	if (isTestMode()) {
		return;
	}
	writer.log({
		ts: new Date().toISOString(),
		...entry,
		cwd: normalizeFilePath(entry.cwd),
		pid: process.pid,
		turnId: getTurnId(),
	});
}

export function getReviewGraphLogPath(): string {
	return REVIEW_GRAPH_LOG_FILE;
}

/** Resolve once all enqueued review-graph writes are on disk (tests/shutdown). */
export function flushReviewGraphLog(): Promise<void> {
	return writer.flush();
}

/** Teardown-only: force queued entries to disk before the process exits. */
export function flushReviewGraphLogSync(): void {
	writer.flushSync();
}
