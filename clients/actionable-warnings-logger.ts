import * as fs from "node:fs";
import * as path from "node:path";
import { isTestMode } from "./env-utils.js";
import { getGlobalPiLensDir } from "./file-utils.js";

const AW_LOG_DIR = getGlobalPiLensDir();
const AW_LOG_FILE = path.join(AW_LOG_DIR, "actionable-warnings.log");
const AW_LOG_BACKUP_FILE = path.join(AW_LOG_DIR, "actionable-warnings.log.1");
const MAX_LOG_BYTES = Math.max(
	128 * 1024,
	Number.parseInt(
		process.env.PI_LENS_AW_LOG_MAX_BYTES ?? "1048576",
		10,
	) || 1048576,
);

try {
	if (!fs.existsSync(AW_LOG_DIR)) {
		fs.mkdirSync(AW_LOG_DIR, { recursive: true });
	}
} catch (err) {
	void err;
}

export interface ActionableWarningsLogEntry {
	event: string;
	sessionId?: string;
	filePath?: string;
	metadata?: Record<string, unknown>;
}

function rotateIfNeeded(): void {
	try {
		if (!fs.existsSync(AW_LOG_FILE)) return;
		const size = fs.statSync(AW_LOG_FILE).size;
		if (size < MAX_LOG_BYTES) return;
		try {
			fs.rmSync(AW_LOG_BACKUP_FILE, { force: true });
		} catch (err) {
			void err;
		}
		fs.renameSync(AW_LOG_FILE, AW_LOG_BACKUP_FILE);
	} catch (err) {
		void err;
	}
}

export function logActionableWarningsEvent(
	entry: ActionableWarningsLogEntry,
): void {
	if (isTestMode()) {
		return;
	}
	const line = `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`;
	try {
		rotateIfNeeded();
		fs.appendFileSync(AW_LOG_FILE, line);
	} catch (err) {
		void err;
	}
}

export function getActionableWarningsLogPath(): string {
	return AW_LOG_FILE;
}
