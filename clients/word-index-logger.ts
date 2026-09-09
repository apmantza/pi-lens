/**
 * Persistent NDJSON trace of word-index build / refresh / persist outcomes
 * (#926 durable reporting, extended for #958 incremental cross-session refresh).
 *
 * Every word-index signal used to ride solely on the optional `dbg` callback
 * threaded through runtime-session / word-index. `dbg` varies by host and is a
 * documented no-op in the MCP host (clients/mcp/session.ts's `dbg: noop`) —
 * exactly the host where `pilens_symbol_search` READS this index. So the one
 * decision that governs a query's freshness (full rebuild vs incremental
 * refresh, and how many docs were refreshed/dropped/skipped/reused, whether the
 * index is `truncated`, #928) and the one failure that silently corrupts every
 * later query (a swallowed snapshot persist) were invisible precisely where
 * they mattered — the same blind spot bus-events-logger.ts and
 * review-graph-logger.ts were created to close.
 *
 * This gives the word index the same durable trace those siblings have via the
 * shared `createNdjsonLogger` writer (self-registers for log-cleanup rotation),
 * with `isTestMode()` gating writes off inside the test runner. Callers log
 * DIRECTLY here — never through `dbg` — so the trace exists regardless of the
 * host's `dbg` wiring.
 */
import * as path from "node:path";
import { isTestMode } from "./env-utils.js";
import { getGlobalPiLensLogDir } from "./probe-home-state.js";
import { getMaxLogSizeMB } from "./log-cleanup.js";
import { createNdjsonLogger } from "./ndjson-logger.js";
import { normalizeFilePath } from "./path-utils.js";

const WORD_INDEX_LOG_FILE = path.join(
	getGlobalPiLensLogDir(),
	"word-index.log",
);

const writer = createNdjsonLogger({
	filePath: WORD_INDEX_LOG_FILE,
	maxBytes: getMaxLogSizeMB() * 1024 * 1024,
});

type WordIndexLogPhase =
	/** Full rebuild from a fresh file-walk-and-read (absent/stale/churned index). */
	| "full_rebuild"
	/** Only stale/new docs re-tokenized against a reused snapshot (#958). */
	| "incremental_refresh"
	/** Incremental refresh threw (churn, missing metadata, …) → full rebuild. */
	| "incremental_fallback"
	/** Stateless cold-query background build (MCP `symbol_search`, no session). */
	| "cold_build"
	/** Cold-query build refused for safety (root at/above $HOME). */
	| "cold_build_refused"
	/** Cold-query background build (build or persist) failed. */
	| "cold_build_failed"
	/** A warm MCP index was normally released by idle/LRU lifecycle policy. */
	| "warm_cache_evicted"
	/** A debounced snapshot persist landed — confirms the index is kept fresh
	 *  across edits (the durable record the MCP host's no-op `dbg` couldn't give). */
	| "persist_succeeded"
	/** A snapshot persist swallowed its error — every later query reads stale. */
	| "persist_failed";

export interface WordIndexLogEntry {
	ts?: string;
	phase: WordIndexLogPhase;
	cwd: string;
	/** Which lifecycle produced this: "session_start" | "cold_query" | "per_edit". */
	trigger?: string;
	durationMs?: number;
	/** Persist split: wire assembly on the host versus snapshot dispatch/write. */
	serializeMs?: number;
	writeMs?: number;
	phaseDurationsMs?: {
		snapshotLoadMs?: number;
		deserializeMs?: number;
		sourceWalkMs?: number;
		statWalkMs?: number;
		refreshReadsMs?: number;
		snapshotSaveSyncMs?: number;
	};
	/** Docs actually represented in the index (mirrors indexedFileCount, #928). */
	indexedFileCount?: number;
	/** True when the source walk reached its file cap — searches may be partial. */
	truncated?: boolean;
	/** Distinct token count (postings.size) — index breadth at a glance. */
	tokens?: number;
	/** Total in-memory posting entries (sum of posting-list lengths). */
	postingEntries?: number;
	/**
	 * Estimated resident bytes of the index’s packed stores (#2069). `tokens`
	 * and `postingEntries` describe breadth; this is the number that actually
	 * governs memory, so a heap census can be reconciled against this log
	 * without taking a snapshot. Divide by `postingEntries` for the per-entry
	 * cost the #2069 acceptance criterion is written against.
	 */
	residentBytes?: number;
	/** Aggregate per-edit replacement cost for the pending turn/burst. */
	replacementCount?: number;
	totalReplacementMs?: number;
	maxReplacementMs?: number;
	/** Incremental: docs re-tokenized because their mtime changed. */
	refreshed?: number;
	/** Incremental: docs removed because they left the current file set. */
	dropped?: number;
	/**
	 * Files the walk enumerated but did NOT (re)index this pass — meaning is
	 * per-phase (surfaced on both paths so coverage stays honest, #533):
	 *  - full_rebuild: unreadable OR over the byte cap → genuinely ABSENT from
	 *    the index (never counted as indexed).
	 *  - incremental_refresh: stale files that failed to re-read this pass → their
	 *    PRIOR postings are retained (and old mtime kept, so retried next pass);
	 *    over-cap files are excluded from the index as on the full path.
	 * Either way a skipped file is never counted as freshly indexed or reused.
	 */
	skipped?: number;
	/** Incremental: docs reused unchanged (the whole point — reused ≫ refreshed). */
	reused?: number;
	/** Refusal / fallback cause (cold_build_refused / incremental_fallback). */
	reason?: string;
	/** Failure detail (cold_build_failed / persist_failed). */
	error?: string;
}

/**
 * #2141 class sweep: mirrors review-graph-logger.ts's `cwd` normalization.
 * Call sites here feed both raw roots (`snapshotRoot`, `path.resolve(cwd)`)
 * and pre-normalized cache keys (`key`), so the same root could show up in
 * two path forms. Normalizing once at this shared emit seam closes that for
 * every call site, present and future.
 */
export function logWordIndex(entry: WordIndexLogEntry): void {
	if (isTestMode()) {
		return;
	}
	writer.log({
		ts: new Date().toISOString(),
		...entry,
		cwd: normalizeFilePath(entry.cwd),
	});
}
