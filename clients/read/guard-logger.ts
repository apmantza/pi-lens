import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const READ_GUARD_LOG_DIR = path.join(os.homedir(), ".pi-lens");
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

try {
	if (!nodeFs.existsSync(READ_GUARD_LOG_DIR)) {
		nodeFs.mkdirSync(READ_GUARD_LOG_DIR, { recursive: true });
	}
} catch {}

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
	return (
		event === "edit_blocked" ||
		event === "edit_warned" ||
		event === "exemption_added" ||
		event === "oldtext_not_found" ||
		event === "oldtext_duplicate" ||
		event === "touched_lines_missing"
	);
}

function rotateIfNeeded(): void {
	try {
		if (!nodeFs.existsSync(READ_GUARD_LOG_FILE)) return;
		const size = nodeFs.statSync(READ_GUARD_LOG_FILE).size;
		if (size < MAX_LOG_BYTES) return;
		try {
			nodeFs.rmSync(READ_GUARD_LOG_BACKUP_FILE, { force: true });
		} catch {}
		nodeFs.renameSync(READ_GUARD_LOG_FILE, READ_GUARD_LOG_BACKUP_FILE);
	} catch {}
}

export function logReadGuardEvent(entry: ReadGuardLogEntry): void {
	if (
		process.env.PI_LENS_TEST_MODE === "1" ||
		(process.env.VITEST && process.env.PI_LENS_TEST_MODE !== "0") ||
		!shouldLogEvent(entry.event)
	) {
		return;
	}
	const line = `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`;
	try {
		rotateIfNeeded();
		nodeFs.appendFileSync(READ_GUARD_LOG_FILE, line);
	} catch {}
}

export function getReadGuardLogPath(): string {
	return READ_GUARD_LOG_FILE;
}
