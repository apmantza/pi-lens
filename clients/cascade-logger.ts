import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const CASCADE_LOG_DIR = path.join(os.homedir(), ".pi-lens");
const CASCADE_LOG_FILE = path.join(CASCADE_LOG_DIR, "cascade.log");

try {
	if (!fs.existsSync(CASCADE_LOG_DIR)) {
		fs.mkdirSync(CASCADE_LOG_DIR, { recursive: true });
	}
} catch {}

export interface CascadeLogEntry {
	ts?: string;
	phase:
		| "cascade_skip"         // primary has blockers or new file — cascade suppressed
		| "graph_build"          // graph built or reused
		| "neighbors_computed"   // impact cascade result ready
		| "neighbor_touch"       // single neighbor LSP touch result
		| "neighbor_snapshot"    // neighbor read from passive snapshot (autoPropagate)
		| "neighbor_fallback"    // neighbor fell back to getAllDiagnostics
		| "cascade_result"       // final per-file cascade result
		| "cascade_turn_end"     // merged result emitted at turn_end
		| "silent_open";         // didChangeWatchedFiles suppressed (silent mode)
	filePath: string;
	neighborFile?: string;
	reason?: string;
	graphBuiltMs?: number;
	graphReused?: boolean;
	neighborCount?: number;
	touchedCount?: number;
	snapshotCount?: number;
	fallbackUsed?: boolean;
	diagnosticCount?: number;
	durationMs?: number;
	autoPropagate?: boolean;
	lspTouched?: boolean;
	error?: string;
	metadata?: Record<string, unknown>;
}

export function logCascade(entry: CascadeLogEntry): void {
	const line = `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`;
	try {
		fs.appendFileSync(CASCADE_LOG_FILE, line);
	} catch {}
}

export function getCascadeLogPath(): string {
	return CASCADE_LOG_FILE;
}
