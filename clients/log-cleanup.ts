/**
 * Log Cleanup Utility — manages log retention and rotation
 *
 * Environment variables:
 *   PI_LENS_LOG_RETENTION_DAYS - Days to keep logs (default: 7)
 *   PI_LENS_MAX_LOG_SIZE_MB    - Max size before rotation (default: 10)
 *
 * Scope:
 *   - ~/.pi-lens/*.log (every global log — see getManagedLogFiles())
 *   - ~/.pi-lens/logs/*.jsonl (daily diagnostic logs)
 *   - ~/.pi-lens/<name>.<timestamp>.log (rotated backups, and legacy .log.<ts>)
 *   - ~/.pi-lens/tool-result-<ms>-<uuid>.log (oversized tool-result spills,
 *     written by tools/render-compact.ts through spillResultLogName())
 *   - <project-data>/sessions/<id>.json (per-session state snapshots; the
 *     current session's file is kept regardless of age)
 *   - os.tmpdir()/pi-lens-mcp-*.sock (MCP endpoint sockets whose owner is
 *     gone — see classifyIpcSocketName and probeIpcSocketListener)
 *   - ~/.pi-lens/projects/<slug>-<hash>/ (project data directories whose
 *     root no longer exists — see createProjectDataDirRootProbe; at least
 *     PROJECT_DATA_ORPHAN_RETENTION_DAYS old)
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

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	createProjectDataDirRootProbe,
	getProjectDataDir,
	projectDataBase,
} from "./file-utils.js";
import { classifyIpcSocketName, probeIpcSocketListener } from "./mcp/ipc.js";
import { getGlobalPiLensLogDir } from "./probe-home-state.js";
import { getRegisteredLogFiles } from "./ndjson-logger.js";
import { pathsEqual } from "./path-utils.js";

const LOGS_SUBDIR = () => path.join(getGlobalPiLensLogDir(), "logs");

/**
 * Every global `.log` pi-lens writes under ~/.pi-lens, resolved dynamically so
 * rotation and the storage summary can't drift out of sync with what's
 * actually written — that drift is exactly what left
 * actionable-warnings/ast-grep-tools/dead-code, and later bus-events.log,
 * unrotated and growing unbounded.
 *
 * Three sources are unioned:
 *   1. `getRegisteredLogFiles()` — every static-path `createNdjsonLogger`
 *      instance self-registers at construction (module load) time. A brand
 *      new `*-logger.ts` module built on the shared writer is picked up with
 *      zero action here, as long as it's imported before this runs (true for
 *      the whole current codebase — every logger module is statically
 *      imported from index.ts's transitive graph before session start).
 *   2. A direct `~/.pi-lens/*.log` directory read, excluding rotated-backup
 *      names — a defensive backstop in case some future logger module is only
 *      *dynamically* imported and hasn't registered yet when this runs. Once
 *      a file has content on disk, this catches it regardless of import
 *      timing; an unregistered file that doesn't exist yet has nothing to
 *      clean up anyway.
 * `dir` is overridable for tests; production callers use the default
 * (real `~/.pi-lens`).
 */
export function getManagedLogFiles(
	dir: string = getGlobalPiLensLogDir(),
): string[] {
	const names = new Set<string>();

	for (const absPath of getRegisteredLogFiles()) {
		if (pathsEqual(path.dirname(absPath), dir)) {
			names.add(path.basename(absPath));
		}
	}

	try {
		if (fs.existsSync(dir)) {
			for (const entry of fs.readdirSync(dir)) {
				if (entry.endsWith(".log") && !ROTATED_BACKUP_RE.test(entry)) {
					names.add(entry);
				}
			}
		}
	} catch {
		// best-effort backstop — registry + straggler list still apply
	}

	return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * Matches a rotated backup, never an active log. Rotation writes
 * `name.<ISO-timestamp>.log` (timestamp before the extension); an older shape
 * was `name.log.<timestamp>`. Match both so every backup — whichever version
 * produced it — is reaped by the retention sweep. The active `name.log` has no
 * timestamp segment and no trailing suffix after `.log`, so it never matches.
 */
export const ROTATED_BACKUP_RE = /(\.\d{4}-\d{2}-\d{2}T.*\.log|\.log\..+)$/;

/**
 * Matches the oversized tool-result spill file `tools/render-compact.ts`
 * writes through {@link spillResultLogName} when a tool result exceeds the
 * result budget. The writer and this pattern share one derivation, so a
 * naming drift cannot strand spill files the way the rotated-backup drift
 * did (this file's original bug).
 */
export const SPILL_RESULT_LOG_RE =
	/^tool-result-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.log$/;

/**
 * The name `tools/render-compact.ts` writes oversized tool results under:
 * one derivation shared with the retention sweep's spill-log row
 * ({@link SPILL_RESULT_LOG_RE}), so the writer's names are always reapable.
 */
export function spillResultLogName(
	now: number = Date.now(),
	id: string = randomUUID(),
): string {
	return `tool-result-${now}-${id}.log`;
}

/**
 * Matches the per-session state snapshot `clients/session-state-store.ts`
 * writes under `<project-data>/sessions/`: the session id is sanitized to
 * `[A-Za-z0-9._-]{1,200}` before it becomes a filename, so the sweep matches
 * that whole shape instead of re-deriving the uuid-only live shape.
 */
const SESSION_STATE_FILE_RE = /^[A-Za-z0-9._-]{1,200}\.json$/;

/**
 * How old a project data directory whose root is gone may get before the
 * sweep removes it. The root-existence decode is what protects live projects
 * (a project dir whose root exists stays regardless of age); the window
 * guards the decode's failure mode on a temporarily unmounted or
 * unreachable root, where a fresh directory is the one thing that survives.
 */
const PROJECT_DATA_ORPHAN_RETENTION_DAYS = 30;

interface LogCleanupConfig {
	retentionDays: number;
	maxSizeMB: number;
}

/** Rotation threshold for every active `~/.pi-lens/*.log`, in MB. */
export function getMaxLogSizeMB(): number {
	return Math.max(
		1,
		Number.parseInt(process.env.PI_LENS_MAX_LOG_SIZE_MB ?? "10", 10) || 10,
	);
}

function getConfig(): LogCleanupConfig {
	return {
		retentionDays: Math.max(
			1,
			Number.parseInt(process.env.PI_LENS_LOG_RETENTION_DAYS ?? "7", 10) || 7,
		),
		maxSizeMB: getMaxLogSizeMB(),
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

type LivenessVerdict = "live" | "stale" | "indeterminate";

/** What one `kill(pid, 0)` probe of a socket owner pid answered. */
type PidProbe = "alive" | "esrch" | "refused";

function realPidProbe(pid: number): PidProbe {
	try {
		process.kill(pid, 0);
		return "alive";
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "ESRCH"
			? "esrch"
			: "refused";
	}
}

/**
 * Whether a pid-scoped socket's owner is gone. The name embeds the owner's
 * pid, so a dead owner means nobody can ever bind that name again; a probe
 * we cannot judge (a live pid of another user answers EPERM) keeps the
 * socket. `signal` is the process boundary, injectable for tests.
 */
export function pidScopedSocketLiveness(
	pid: number,
	signal: (pid: number) => PidProbe = realPidProbe,
): LivenessVerdict {
	switch (signal(pid)) {
		case "alive":
			return "live";
		case "esrch":
			return "stale";
		case "refused":
			return "indeterminate";
	}
}

/**
 * One retention row (#5702): a directory, the entry names it may reap, and a
 * maximum age. An entry is removed only when its age exceeds the window AND
 * its liveness gate (when the row has one) answers `stale` — an entry the
 * gate calls `live` or `indeterminate` stays regardless of age.
 */
interface RetentionRow {
	/** Report label, one deletion count per row. */
	label: string;
	/** Directory the row sweeps, resolved at run time so callers can pin home. */
	directory: () => string;
	match: (name: string) => boolean;
	maxAgeDays: () => number;
	/** `file` entries are unlinked; `dir` entries are removed recursively. */
	kind: "file" | "dir";
	/**
	 * Extra liveness gate for rows whose safety needs more than the age
	 * window (socket owner, project root). Absent on plain age rows. May be
	 * sync or async; the socket row dials, the others do not.
	 */
	liveness?: (
		absPath: string,
		name: string,
	) => LivenessVerdict | Promise<LivenessVerdict>;
}

/**
 * The one retention table. `runLogCleanup` walks it; a writer whose files
 * must not pile up gets a row here, never a second sweep or timer.
 */
function getRetentionRows(options: RetentionOptions): RetentionRow[] {
	const config = getConfig();
	return [
		{
			label: "daily logs",
			directory: LOGS_SUBDIR,
			match: (name) => name.endsWith(".jsonl"),
			maxAgeDays: () => config.retentionDays,
			kind: "file",
		},
		{
			label: "rotated logs",
			directory: getGlobalPiLensLogDir,
			match: (name) => ROTATED_BACKUP_RE.test(name),
			maxAgeDays: () => config.retentionDays,
			kind: "file",
		},
		{
			label: "spill logs",
			directory: getGlobalPiLensLogDir,
			match: (name) => SPILL_RESULT_LOG_RE.test(name),
			maxAgeDays: () => config.retentionDays,
			kind: "file",
		},
		{
			label: "session state files",
			directory: () =>
				path.join(getProjectDataDir(options.cwd ?? process.cwd()), "sessions"),
			match: (name) => SESSION_STATE_FILE_RE.test(name),
			maxAgeDays: () => config.retentionDays,
			kind: "file",
			liveness: (_absPath, name) =>
				// A live session's own snapshot is never the sweep's to reap,
				// however long the session idles before its next save.
				name === `${options.currentSessionId}.json` ? "live" : "stale",
		},
		{
			// The same directory `clients/mcp/ipc.ts` binds every `.sock`
			// endpoint name into; Windows named pipes have no file to scan.
			label: "stale sockets",
			directory: () => os.tmpdir(),
			match: (name) => classifyIpcSocketName(name) !== undefined,
			maxAgeDays: () => 1,
			kind: "file",
			liveness: async (absPath, name) => {
				const classified = classifyIpcSocketName(name);
				if (!classified) return "indeterminate";
				if (classified.kind === "pid-scoped") {
					return pidScopedSocketLiveness(classified.pid);
				}
				// ipc.ts's probe answers "dead" for the same verdict this gate
				// calls stale: a socket file no listener serves.
				const dial = await probeIpcSocketListener(absPath);
				return dial === "dead"
					? "stale"
					: dial === "live"
						? "live"
						: "indeterminate";
			},
		},
		{
			label: "orphaned project data dirs",
			directory: projectDataBase,
			// The liveness gate classifies every child; a name it cannot
			// judge is kept, so the row admits all and judges each.
			match: () => true,
			maxAgeDays: () => PROJECT_DATA_ORPHAN_RETENTION_DAYS,
			kind: "dir",
			liveness: async (_absPath, name) => {
				const status = createProjectDataDirRootProbe().statusFor(name);
				return status === "exists"
					? "live"
					: status === "gone"
						? "stale"
						: "indeterminate";
			},
		},
	];
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

export interface RetentionOptions {
	/**
	 * The project root the session runs in: scopes the session-state row to
	 * that project's data directory. Defaults to the process cwd.
	 */
	cwd?: string;
	/**
	 * The live session's id: its own state file is kept regardless of age.
	 * Absent (tests, embedders without a session id), no state file is exempt.
	 */
	currentSessionId?: string;
}

interface RetentionSweepResult {
	label: string;
	deleted: number;
}

/**
 * One row over one directory. Every delete failure lands in `errors` —
 * counted, never thrown — and the row's own deletion count feeds the report.
 */
async function runRetentionRow(
	row: RetentionRow,
): Promise<RetentionSweepResult & { errors: string[] }> {
	const directory = row.directory();
	const deleted: string[] = [];
	const errors: string[] = [];

	let names: string[];
	try {
		names = fs.existsSync(directory) ? fs.readdirSync(directory) : [];
	} catch (err) {
		return {
			label: row.label,
			deleted: 0,
			errors: [`read ${directory}: ${err}`],
		};
	}

	for (const name of names) {
		if (!row.match(name)) continue;
		const absPath = path.join(directory, name);
		const ageDays = getFileAgeDays(absPath);
		if (ageDays <= row.maxAgeDays()) continue;
		if (row.liveness) {
			const verdict = await row.liveness(absPath, name);
			if (verdict !== "stale") continue;
		}
		try {
			const socketClass = classifyIpcSocketName(name);
			if (socketClass) {
				// Only a real socket is reaped (the same lstat guard the bind
				// path's unlinkStaleUnixSocket applies); anything else with a
				// socket-shaped name stays. The unlink targets the on-disk path
				// the sweep enumerated, not a sun_path-cut bind target: the gate
				// cuts for the listener about to bind, while a full-shape name
				// past the sun_path limit can only be a leftover file, which is
				// exactly what the sweep is here to reap.
				let isSocket = false;
				try {
					isSocket = fs.lstatSync(absPath).isSocket();
				} catch {
					isSocket = false;
				}
				if (!isSocket) continue;
				fs.unlinkSync(absPath);
			} else if (row.kind === "dir") {
				fs.rmSync(absPath, { recursive: true, force: true });
			} else {
				fs.unlinkSync(absPath);
			}
			deleted.push(name);
		} catch (err) {
			errors.push(`${name}: ${err}`);
		}
	}

	return { label: row.label, deleted: deleted.length, errors };
}

/**
 * Main cleanup function - call on session start
 * Cleans up all pi-lens log files based on retention policy
 */
export async function runLogCleanup(
	dbg?: (msg: string) => void,
	options: RetentionOptions = {},
): Promise<{
	cleaned: number;
	rotated: number;
	report: string;
}> {
	const config = getConfig();
	const results = {
		cleaned: 0,
		rotated: 0,
		report: "",
	};

	const sweeps: RetentionSweepResult[] = [];
	const errors: string[] = [];

	// One retention table; every row runs, and one failed delete is a count,
	// never a throw (#5702 decision 3).
	for (const row of getRetentionRows(options)) {
		const sweep = await runRetentionRow(row);
		sweeps.push(sweep);
		errors.push(...sweep.errors);
	}
	results.cleaned = sweeps.reduce((sum, sweep) => sum + sweep.deleted, 0);

	// Check main logs for rotation
	const mainLogs = getManagedLogFiles().map((name) =>
		path.join(getGlobalPiLensLogDir(), name),
	);

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
	for (const sweep of sweeps) {
		if (sweep.deleted > 0) parts.push(`${sweep.deleted} ${sweep.label}`);
	}
	if (results.rotated > 0) {
		parts.push(`${results.rotated} active logs rotated`);
	}
	if (errors.length > 0) {
		// One counted record per run, with the first message for identity;
		// a failed delete never throws the sweep off the remaining entries.
		parts.push(`${errors.length} deletions failed`);
		dbg?.(
			`log_cleanup: ${errors.length} deletions failed; first: ${errors[0]}`,
		);
	}

	results.report =
		parts.length > 0
			? `log_cleanup: removed ${parts.join(", ")} (retention: ${config.retentionDays}d, maxSize: ${config.maxSizeMB}MB)`
			: `log_cleanup: no cleanup needed (retention: ${config.retentionDays}d, maxSize: ${config.maxSizeMB}MB)`;

	return results;
}
