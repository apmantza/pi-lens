import * as fs from "node:fs";
import * as path from "node:path";
import { isTestMode } from "./env-utils.js";
import { getGlobalPiLensDir } from "./file-utils.js";

const TREE_SITTER_LOG_DIR = getGlobalPiLensDir();
const TREE_SITTER_LOG_FILE = path.join(TREE_SITTER_LOG_DIR, "tree-sitter.log");

try {
	if (!fs.existsSync(TREE_SITTER_LOG_DIR)) {
		fs.mkdirSync(TREE_SITTER_LOG_DIR, { recursive: true });
	}
} catch {}

export interface TreeSitterLogEntry {
	ts?: string;
	phase:
		| "runner_start"
		| "runner_skip"
		| "queries_loaded"
		| "query_error"
		| "runner_complete"
		| "entity_diff"
		| "blast_radius";
	filePath: string;
	languageId?: string;
	queryId?: string;
	status?: string;
	diagnostics?: number;
	blocking?: number;
	queryCount?: number;
	effectiveQueryCount?: number;
	cacheHit?: boolean;
	reason?: string;
	error?: string;
	metadata?: Record<string, unknown>;
}

export function logTreeSitter(entry: TreeSitterLogEntry): void {
	if (isTestMode()) {
		return;
	}
	const line = `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`;
	try {
		fs.appendFileSync(TREE_SITTER_LOG_FILE, line);
	} catch {}
}

export function getTreeSitterLogPath(): string {
	return TREE_SITTER_LOG_FILE;
}
