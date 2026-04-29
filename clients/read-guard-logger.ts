import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const READ_GUARD_LOG_DIR = path.join(os.homedir(), ".pi-lens");
const READ_GUARD_LOG_FILE = path.join(READ_GUARD_LOG_DIR, "read-guard.log");

try {
	if (!fs.existsSync(READ_GUARD_LOG_DIR)) {
		fs.mkdirSync(READ_GUARD_LOG_DIR, { recursive: true });
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

export function logReadGuardEvent(entry: ReadGuardLogEntry): void {
	if (
		process.env.PI_LENS_TEST_MODE === "1" ||
		(process.env.VITEST && process.env.PI_LENS_TEST_MODE !== "0")
	) {
		return;
	}
	const line = `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`;
	try {
		fs.appendFileSync(READ_GUARD_LOG_FILE, line);
	} catch {}
}

export function getReadGuardLogPath(): string {
	return READ_GUARD_LOG_FILE;
}
