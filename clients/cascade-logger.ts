import * as fs from "node:fs";
import * as path from "node:path";
import { isTestMode } from "./env-utils.js";
import { getGlobalPiLensDir } from "./file-utils.js";

const CASCADE_LOG_DIR = getGlobalPiLensDir();
const CASCADE_LOG_FILE = path.join(CASCADE_LOG_DIR, "cascade.log");

try {
	if (!fs.existsSync(CASCADE_LOG_DIR)) {
		fs.mkdirSync(CASCADE_LOG_DIR, { recursive: true });
	}
} catch {}

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
		| "cascade_turn_end"; // merged result emitted at turn_end
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

export function logCascade(entry: CascadeLogEntry): void {
	if (isTestMode()) {
		return;
	}
	const line = `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`;
	try {
		fs.appendFileSync(CASCADE_LOG_FILE, line);
	} catch {}
}

export function getCascadeLogPath(): string {
	return CASCADE_LOG_FILE;
}
