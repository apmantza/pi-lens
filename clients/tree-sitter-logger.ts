import * as path from "node:path";
import { isTestMode } from "./env-utils.js";
import { getGlobalPiLensDir } from "./file-utils.js";
import { createNdjsonLogger } from "./ndjson-logger.js";
import type { TreeSitterParseCacheStats } from "./tree-sitter-client.js";
import { getMaxLogSizeMB } from "./log-cleanup.js";

const TREE_SITTER_LOG_DIR = getGlobalPiLensDir();
const TREE_SITTER_LOG_FILE = path.join(TREE_SITTER_LOG_DIR, "tree-sitter.log");

const writer = createNdjsonLogger({
	filePath: TREE_SITTER_LOG_FILE,
	maxBytes: getMaxLogSizeMB() * 1024 * 1024,
});

export interface TreeSitterLogEntry {
	ts?: string;
	phase:
		| "runner_start"
		| "runner_skip"
		| "queries_loaded"
		| "query_error"
		| "runtime_abort"
		| "runner_complete"
		| "entity_diff"
		| "blast_radius"
		| "cache_stats"
		// #1333: free-form operational text that used to be a raw console.error
		// (or a verbose-gated one) from the tree-sitter stack. `reason` carries
		// the message, `metadata.subsystem` the emitting module.
		| "diagnostic";
	filePath: string;
	languageId?: string;
	queryId?: string;
	status?: string;
	durationMs?: number;
	diagnostics?: number;
	blocking?: number;
	queryCount?: number;
	effectiveQueryCount?: number;
	cacheHit?: boolean;
	reason?: string;
	error?: string;
	metadata?: Record<string, unknown>;
}

const CACHE_COUNTER_KEYS = [
	"lookups",
	"hits",
	"misses",
	"coldMisses",
	"capacityMisses",
	"contentChangedMisses",
	"mtimeMisses",
	"statFailedMisses",
	"sets",
	"replacements",
	"evictions",
	"clears",
	"ghostHistoryDrops",
	"parserInvocations",
	"parserDurationMs",
	"parserFailures",
] as const satisfies readonly (keyof TreeSitterParseCacheStats)[];

export function logTreeSitter(entry: TreeSitterLogEntry): void {
	if (isTestMode()) {
		return;
	}
	writer.log({ ts: new Date().toISOString(), ...entry });
}

export function logTreeSitterCacheStats(options: {
	scope: string;
	filePath: string;
	fileCount: number;
	durationMs: number;
	stats: TreeSitterParseCacheStats;
	// #1935 review / #1982: ast-grep-napi is merged into the same file-major
	// pass this record measures, but parses through its own engine (never this
	// record's TreeCache), so its cost has no counter of its own here. The
	// CONTRACT: a caller whose scope RUNS an ast-grep pass must subtract that
	// pass's duration from `durationMs` above AND report it in this sub-field —
	// never fold it silently into `durationMs` or drop it. A caller whose scope
	// runs no ast-grep pass reports explicit zeros. REQUIRED (#1982): every
	// cache_stats record carries the field so consumers never distinguish by
	// absence; enforced by this option type and by
	// tests/clients/tree-sitter-cache-stats-astgrep-coverage.test.ts.
	astGrep: { durationMs: number; fileCount: number };
}): void {
	const delta = Object.fromEntries(
		CACHE_COUNTER_KEYS.map((key) => [key, options.stats[key]]),
	) as Record<(typeof CACHE_COUNTER_KEYS)[number], number>;
	logTreeSitter({
		phase: "cache_stats",
		filePath: options.filePath,
		durationMs: options.durationMs,
		metadata: {
			scope: options.scope,
			fileCount: options.fileCount,
			hitRate: delta.lookups > 0 ? delta.hits / delta.lookups : null,
			delta,
			resident: {
				size: options.stats.size,
				maxSize: options.stats.maxSize,
				totalBytes: options.stats.totalBytes,
				totalLines: options.stats.totalLines,
			},
			astGrep: options.astGrep,
		},
	});
}

/**
 * The tree-sitter stack's terminal-safe diagnostic sink (#1333).
 *
 * pi owns the terminal, so nothing under `clients/` may `console.error`. The
 * tree-sitter subsystem already owns `tree-sitter.log`, so its diagnostics stay
 * there rather than moving to the generic `extension.log` — one log per
 * subsystem, per the AGENTS.md logger invariant.
 *
 * `filePath` is optional because several of these fire process-wide (WASM
 * abort, grammar fetch, rule compile) with no file in hand.
 */
export function logTreeSitterDiagnostic(entry: {
	/** Emitting module, e.g. `tree-sitter-client`, `symbol-extractor`. */
	subsystem: string;
	message: string;
	/** `debug` is what the previously verbose-gated loggers write at. */
	level?: "error" | "warn" | "debug";
	filePath?: string;
	languageId?: string;
	metadata?: Record<string, unknown>;
}): void {
	logTreeSitter({
		phase: "diagnostic",
		filePath: entry.filePath ?? "<tree-sitter>",
		...(entry.languageId ? { languageId: entry.languageId } : {}),
		status: entry.level ?? "error",
		reason: entry.message,
		metadata: { subsystem: entry.subsystem, ...(entry.metadata ?? {}) },
	});
}

export function getTreeSitterLogPath(): string {
	return TREE_SITTER_LOG_FILE;
}

/** Resolve once all enqueued tree-sitter writes are on disk (tests/shutdown). */
export function flushTreeSitterLog(): Promise<void> {
	return writer.flush();
}
