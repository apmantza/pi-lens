import * as path from "node:path";
import { isTestMode } from "./env-utils.js";
import { getGlobalPiLensLogDir } from "./probe-home-state.js";
import { createNdjsonLogger } from "./ndjson-logger.js";
import { getMaxLogSizeMB } from "./log-rotation-limits.js";
import { normalizeLoggedPath } from "./path-utils.js";

const CASCADE_LOG_DIR = getGlobalPiLensLogDir();
const CASCADE_LOG_FILE = path.join(CASCADE_LOG_DIR, "cascade.log");

const writer = createNdjsonLogger({
	filePath: CASCADE_LOG_FILE,
	maxBytes: getMaxLogSizeMB() * 1024 * 1024,
});

export interface CascadeLogEntry {
	ts?: string;
	phase:
		| "cascade_skip" // primary has blockers, non-code file, or unsupported graph kind
		| "graph_build" // graph built or reused
		| "reverse_deps_cache" // reverse dependency cache refresh/load/merge
		| "neighbors_computed" // impact cascade result ready
		| "neighbor_touch" // single neighbor LSP active touch result
		| "neighbor_snapshot" // neighbor read from passive snapshot (autoPropagate jsts)
		| "neighbor_fallback" // neighbor fell back to getAllDiagnostics (error or degraded)
		| "cascade_result" // final per-file cascade result
		| "cascade_turn_end" // merged result emitted at turn_end
		| "cascade_indeterminate" // #1023: impact could not be computed — honest advisory surfaced
		| "cascade_tier3_skip" // #458: in-lane wait skipped for a tier-3 neighbor touch
		| "cascade_tier3_reconcile" // #458: quiet-window reconcile of outstanding tier-3 touches
		| "cascade_tier3_peek" // #4485: turn_end's one read of the unanswered touches after its settle
		| "cascade_tier3_expired" // #4485: touches that reached the age bound, read once before they go
		| "cascade_tier3_dropped" // #4485: unanswered touches a session reset discarded
		| "cascade_unconfirmed_rendered" // #4485: the turn's pending line for unanswered neighbours rendered
		| "cascade_pending_rendered" // #4487: the turn's line for pending neighbour errors no cascade re-checked
		| "cascade_pending_gated" // #4495 round 3: pending entries whose file changed outside pi (named once) or was deleted (forgotten)
		| "cascade_carry_over_drop" // #1443: late/carried run dropped — superseded by a later write, or the one-turn carry bound lapsed
		| "cascade_carry_rendered" // #3168 F6: a carried run/coverage advisory actually rendered with its carry label this turn
		| "cascade_injected" // #1446 item 1: what cascade text actually reached blockerParts this turn
		| "cascade_test_targets"; // #1446 item 2: which tests were suggested for cascade neighbors, including the zero-suggestion case
	filePath: string;
	neighborFile?: string;
	reason?: string;

	// graph_build
	graphBuiltMs?: number;
	graphReused?: boolean; // true when FactStore cache was valid (future: incremental rebuild)
	graphNodeCount?: number;
	graphFileCount?: number;
	graphChangedSymbolCount?: number;

	// neighbors_computed
	neighborCount?: number;
	totalNeighborCount?: number; // before cap
	importerCount?: number;
	callerCount?: number;
	referenceCount?: number;
	riskFlags?: string[];

	// neighbor_snapshot
	snapshotMissing?: boolean; // true when file not found in allDiags
	snapshotAgeSec?: number; // age of snapshot entry in seconds

	// neighbor_touch
	lspServerCount?: number; // number of LSP servers configured for this file type
	touchedCount?: number;
	snapshotCount?: number;
	coldSnapshot?: boolean; // true when touch was triggered because autoPropagate snapshot was missing

	// shared
	fallbackUsed?: boolean;
	diagnosticCount?: number;
	durationMs?: number;
	autoPropagate?: boolean;
	lspTouched?: boolean;
	error?: string;
	metadata?: Record<string, unknown>;
}

/**
 * #2219 (the #2141 class): call sites across `dispatch/integration.ts`,
 * `runtime-turn.ts`, and `runtime-coordinator.ts` feed a mix of raw
 * `filePath`/`cwd` params and (for `lsp/cascade-tier.ts`) the
 * `"<quiet-window>"` sentinel. Normalize once here, the single emit seam —
 * same pattern as `review-graph-logger.ts`'s `logReviewGraph`, guarded via
 * `normalizeLoggedPath` so the non-path sentinel passes through unchanged
 * instead of being resolved against the process cwd.
 */
export function logCascade(entry: CascadeLogEntry): void {
	if (isTestMode()) {
		return;
	}
	writer.log({
		ts: new Date().toISOString(),
		...entry,
		filePath: normalizeLoggedPath(entry.filePath),
	});
}
