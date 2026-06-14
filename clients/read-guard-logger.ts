import * as fs from "node:fs";
import * as path from "node:path";
import { isTestMode } from "./env-utils.js";
import { getGlobalPiLensDir } from "./file-utils.js";

const READ_GUARD_LOG_DIR = getGlobalPiLensDir();
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

try {
	if (!fs.existsSync(READ_GUARD_LOG_DIR)) {
		fs.mkdirSync(READ_GUARD_LOG_DIR, { recursive: true });
	}
} catch (err) {
	void err;
}

export interface ReadGuardLogEntry {
	event: string;
	sessionId?: string;
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

function shouldLogEvent(event: string): boolean {
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
		event === "touched_lines_missing"
	);
}

function rotateIfNeeded(): void {
	try {
		if (!fs.existsSync(READ_GUARD_LOG_FILE)) return;
		const size = fs.statSync(READ_GUARD_LOG_FILE).size;
		if (size < MAX_LOG_BYTES) return;
		try {
			fs.rmSync(READ_GUARD_LOG_BACKUP_FILE, { force: true });
		} catch (err) {
			void err;
		}
		fs.renameSync(READ_GUARD_LOG_FILE, READ_GUARD_LOG_BACKUP_FILE);
	} catch (err) {
		void err;
	}
}

export function logReadGuardEvent(entry: ReadGuardLogEntry): void {
	if (isTestMode() || !shouldLogEvent(entry.event)) {
		return;
	}
	const line = `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`;
	try {
		rotateIfNeeded();
		fs.appendFileSync(READ_GUARD_LOG_FILE, line);
	} catch (err) {
		void err;
	}
}

export function getReadGuardLogPath(): string {
	return READ_GUARD_LOG_FILE;
}
