/**
 * Log Cleanup Utility — manages log retention and rotation
 *
 * Environment variables:
 *   PI_LENS_LOG_RETENTION_DAYS - Days to keep logs (default: 7)
 *   PI_LENS_MAX_LOG_SIZE_MB    - Max size before rotation (default: 10)
 *
 * Scope:
 *   - ~/.pi-lens/*.log (latency.log, sessionstart.log, tree-sitter.log)
 *   - ~/.pi-lens/logs/*.jsonl (daily diagnostic logs)
 *   - ~/.pi-lens/*.log.* (rotated backups)
 *
 * Excluded (intentionally NOT cleaned - per-project or persistent):
 *   - {cwd}/.pi-lens/worklog.jsonl        - Agent fixable diagnostics
 *   - {cwd}/.pi-lens/metrics-history.json - Complexity trends (capped internally)
 *   - {cwd}/.pi-lens/reviews/*          - Code review snapshots
 *   - {cwd}/.pi-lens/turn-state.json    - Turn tracking
 *   - {cwd}/.pi-lens/fix-session.json   - Active fix sessions
 *   - {cwd}/.pi-lens/todo-baseline.json - TODO baseline
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const LOG_DIR = path.join(os.homedir(), ".pi-lens");
const LOGS_SUBDIR = path.join(LOG_DIR, "logs");

export interface LogCleanupConfig {
	retentionDays: number;
	maxSizeMB: number;
}

function getConfig(): LogCleanupConfig {
	return {
		retentionDays: Math.max(
			1,
			Number.parseInt(process.env.PI_LENS_LOG_RETENTION_DAYS ?? "7", 10) || 7,
		),
		maxSizeMB: Math.max(
			1,
			Number.parseInt(process.env.PI_LENS_MAX_LOG_SIZE_MB ?? "10", 10) || 10,
		),
	};
}

function getFileAgeDays(filePath: string): number {
	try {
		const stats = fs.statSync(filePath);
		const ageMs = Date.now() - stats.mtime.getTime();
		return ageMs / (1000 * 60 * 60 * 24);
	} catch {
		return 0;
	}
}

function getFileSizeMB(filePath: string): number {
	try {
		const stats = fs.statSync(filePath);
		return stats.size / (1024 * 1024);
	} catch {
		return 0;
	}
}

/**
 * Delete files older than retentionDays
 */
export function cleanupOldLogs(
	directory: string,
	pattern: RegExp,
	retentionDays?: number,
): { deleted: string[]; errors: string[] } {
	const config = getConfig();
	const maxAge = retentionDays ?? config.retentionDays;
	const deleted: string[] = [];
	const errors: string[] = [];

	try {
		if (!fs.existsSync(directory)) {
			return { deleted, errors };
		}

		const files = fs.readdirSync(directory);
		for (const file of files) {
			if (!pattern.test(file)) continue;

			const filePath = path.join(directory, file);
			const ageDays = getFileAgeDays(filePath);

			if (ageDays > maxAge) {
				try {
					fs.unlinkSync(filePath);
					deleted.push(file);
				} catch (err) {
					errors.push(`${file}: ${err}`);
				}
			}
		}
	} catch (err) {
		errors.push(`Directory read failed: ${err}`);
	}

	return { deleted, errors };
}

/**
 * Rotate a log file if it exceeds max size
 */
export function rotateLogIfNeeded(
	logFile: string,
	maxSizeMB?: number,
): { rotated: boolean; newFile?: string } {
	const config = getConfig();
	const maxSize = maxSizeMB ?? config.maxSizeMB;
	const sizeMB = getFileSizeMB(logFile);

	if (sizeMB < maxSize) {
		return { rotated: false };
	}

	try {
		// Create timestamped backup
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		const ext = path.extname(logFile);
		const base = logFile.slice(0, -ext.length);
		const backupFile = `${base}.${timestamp}${ext}`;

		// Rename current to backup, create fresh file
		fs.renameSync(logFile, backupFile);
		fs.writeFileSync(logFile, "", "utf8");

		return { rotated: true, newFile: backupFile };
	} catch {
		return { rotated: false };
	}
}

/**
 * Main cleanup function - call on session start
 * Cleans up all pi-lens log files based on retention policy
 */
export function runLogCleanup(dbg?: (msg: string) => void): {
	cleaned: number;
	rotated: number;
	report: string;
} {
	const config = getConfig();
	const results = {
		cleaned: 0,
		rotated: 0,
		report: "",
	};

	// Cleanup old daily diagnostic logs (*.jsonl)
	const dailyLogs = cleanupOldLogs(
		LOGS_SUBDIR,
		/\.jsonl$/,
		config.retentionDays,
	);
	results.cleaned += dailyLogs.deleted.length;

	// Cleanup old rotated log backups (*.log.*)
	const rotatedLogs = cleanupOldLogs(LOG_DIR, /\.log\./, config.retentionDays);
	results.cleaned += rotatedLogs.deleted.length;

	// Check main logs for rotation
	const mainLogs = [
		path.join(LOG_DIR, "latency.log"),
		path.join(LOG_DIR, "sessionstart.log"),
		path.join(LOG_DIR, "tree-sitter.log"),
		path.join(LOG_DIR, "cascade.log"),
	];

	for (const logFile of mainLogs) {
		const rotation = rotateLogIfNeeded(logFile, config.maxSizeMB);
		if (rotation.rotated) {
			results.rotated++;
			if (rotation.newFile) {
				const sizeMB = getFileSizeMB(rotation.newFile);
				dbg?.(
					`log_cleanup: rotated ${path.basename(logFile)} (${sizeMB.toFixed(1)}MB) → ${path.basename(rotation.newFile)}`,
				);
			}
		}
	}

	// Build report
	const parts: string[] = [];
	if (dailyLogs.deleted.length > 0) {
		parts.push(`${dailyLogs.deleted.length} daily logs`);
	}
	if (rotatedLogs.deleted.length > 0) {
		parts.push(`${rotatedLogs.deleted.length} rotated logs`);
	}
	if (results.rotated > 0) {
		parts.push(`${results.rotated} active logs rotated`);
	}

	results.report =
		parts.length > 0
			? `log_cleanup: removed ${parts.join(", ")} (retention: ${config.retentionDays}d, maxSize: ${config.maxSizeMB}MB)`
			: `log_cleanup: no cleanup needed (retention: ${config.retentionDays}d, maxSize: ${config.maxSizeMB}MB)`;

	if (dailyLogs.errors.length > 0 || rotatedLogs.errors.length > 0) {
		dbg?.(
			`log_cleanup errors: ${[...dailyLogs.errors, ...rotatedLogs.errors].join("; ")}`,
		);
	}

	return results;
}

/**
 * Get current log storage summary
 */
export function getLogStorageSummary(): {
	totalMB: number;
	files: { name: string; sizeMB: number; ageDays: number }[];
} {
	const files: { name: string; sizeMB: number; ageDays: number }[] = [];
	let totalMB = 0;

	// Main logs
	const mainLogs = ["latency.log", "sessionstart.log", "tree-sitter.log"];
	for (const name of mainLogs) {
		const filePath = path.join(LOG_DIR, name);
		if (fs.existsSync(filePath)) {
			const sizeMB = getFileSizeMB(filePath);
			const ageDays = getFileAgeDays(filePath);
			files.push({ name, sizeMB, ageDays });
			totalMB += sizeMB;
		}
	}

	// Daily logs
	try {
		if (fs.existsSync(LOGS_SUBDIR)) {
			const dailyFiles = fs.readdirSync(LOGS_SUBDIR);
			for (const name of dailyFiles) {
				if (!name.endsWith(".jsonl")) continue;
				const filePath = path.join(LOGS_SUBDIR, name);
				const sizeMB = getFileSizeMB(filePath);
				const ageDays = getFileAgeDays(filePath);
				files.push({ name: `logs/${name}`, sizeMB, ageDays });
				totalMB += sizeMB;
			}
		}
	} catch {
		// Ignore
	}

	return { totalMB, files };
}
