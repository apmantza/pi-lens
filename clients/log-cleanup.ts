/**
 * Log Cleanup Utility — manages log retention and rotation
 *
 * Environment variables:
 *   PI_LENS_LOG_RETENTION_DAYS - Days to keep logs (default: 7)
 *   PI_LENS_MAX_LOG_SIZE_MB    - Max size before rotation (default: 10)
 *
 * Scope:
 *   - ~/.pi-lens/*.log (all 8 global logs — see MANAGED_LOG_FILES: latency,
 *     sessionstart, tree-sitter, cascade, read-guard, actionable-warnings,
 *     ast-grep-tools, dead-code)
 *   - ~/.pi-lens/logs/*.jsonl (daily diagnostic logs)
 *   - ~/.pi-lens/<name>.<timestamp>.log (rotated backups, and legacy .log.<ts>)
 *
 * Excluded (intentionally NOT cleaned - project-scoped or persistent):
 *   - <project-data>/worklog.jsonl                - Agent fixable diagnostics
 *   - <project-data>/code-quality-warnings.jsonl  - Non-fixable warning history
 *   - <project-data>/actionable-warnings.jsonl    - Actionable warning history
 *   - <project-data>/metrics-history.json         - Complexity trends (capped internally)
 *   - <project-data>/reviews/*                    - Code review snapshots
 *   - <project-data>/turn-state.json              - Turn tracking
 *   - <project-data>/fix-session.json             - Active fix sessions
 *   - <project-data>/todo-baseline.json           - TODO baseline
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getGlobalPiLensDir } from "./file-utils.js";

const LOG_DIR = getGlobalPiLensDir();
const LOGS_SUBDIR = path.join(LOG_DIR, "logs");

/**
 * Every global `.log` pi-lens writes under ~/.pi-lens. Kept as one list so
 * rotation and the storage summary can't drift out of sync — that drift is
 * exactly what left actionable-warnings/ast-grep-tools/dead-code unrotated and
 * growing unbounded. New global log file? Add it here.
 */
export const MANAGED_LOG_FILES = [
	"latency.log",
	"sessionstart.log",
	"tree-sitter.log",
	"cascade.log",
	"read-guard.log",
	"actionable-warnings.log",
	"ast-grep-tools.log",
	"dead-code.log",
];

/**
 * Matches a rotated backup, never an active log. Rotation writes
 * `name.<ISO-timestamp>.log` (timestamp before the extension); an older shape
 * was `name.log.<timestamp>`. Match both so every backup — whichever version
 * produced it — is reaped by the retention sweep. The active `name.log` has no
 * timestamp segment and no trailing suffix after `.log`, so it never matches.
 */
export const ROTATED_BACKUP_RE = /(\.\d{4}-\d{2}-\d{2}T.*\.log|\.log\..+)$/;

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

	// Cleanup old rotated log backups. This sweep runs unconditionally on every
	// session start, so correcting the pattern self-heals any pre-existing
	// backlog on the next launch — no separate migration needed. (The prior
	// `/\.log\./` only matched the legacy `name.log.<ts>` shape, never the
	// current `name.<ts>.log`, so backups accumulated indefinitely.)
	const rotatedLogs = cleanupOldLogs(
		LOG_DIR,
		ROTATED_BACKUP_RE,
		config.retentionDays,
	);
	results.cleaned += rotatedLogs.deleted.length;

	// Check main logs for rotation
	const mainLogs = MANAGED_LOG_FILES.map((name) => path.join(LOG_DIR, name));

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
	for (const name of MANAGED_LOG_FILES) {
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
