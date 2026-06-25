/**
 * NDJSON telemetry for cross-file dead-code scans (#127). One event per
 * session_start scan per language, so we can answer: which languages get
 * scanned, how many findings, and how long the whole-project scan takes (the
 * input to phasing decisions in the issue). Mirrors `ast-grep-tool-logger.ts`
 * for shape + size-based rotation.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { isTestMode } from "./env-utils.js";
import { getGlobalPiLensDir } from "./file-utils.js";

const LOG_DIR = getGlobalPiLensDir();
const LOG_FILE = path.join(LOG_DIR, "dead-code.log");
const LOG_BACKUP_FILE = path.join(LOG_DIR, "dead-code.log.1");
const MAX_LOG_BYTES = Math.max(
	128 * 1024,
	Number.parseInt(process.env.PI_LENS_DEAD_CODE_LOG_MAX_BYTES ?? "1048576", 10) ||
		1048576,
);

export interface DeadCodeScanEvent {
	language: string;
	sessionId?: string;
	success: boolean;
	cached: boolean;
	unusedExports: number;
	unusedFiles: number;
	unusedDeps: number;
	unlistedDeps: number;
	durationMs?: number;
	reason?: string;
}

function rotateIfNeeded(): void {
	try {
		const stat = fs.statSync(LOG_FILE);
		if (stat.size >= MAX_LOG_BYTES) {
			fs.renameSync(LOG_FILE, LOG_BACKUP_FILE);
		}
	} catch {
		// no file yet, or rename raced — nothing to rotate
	}
}

/**
 * Append one scan event. Fire-and-forget: telemetry must never break a scan, so
 * every fs error is swallowed. Skipped under test mode to keep the suite from
 * writing to the user's real ~/.pi-lens.
 */
export function logDeadCodeScan(event: DeadCodeScanEvent): void {
	if (isTestMode()) return;
	try {
		if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
		rotateIfNeeded();
		const row = JSON.stringify({ ts: new Date().toISOString(), ...event });
		fs.appendFileSync(LOG_FILE, row + "\n");
	} catch {
		// telemetry is best-effort
	}
}
