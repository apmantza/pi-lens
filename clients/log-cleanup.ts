/**
 * Log Cleanup Utility — manages log retention and rotation
 *
 * Environment variables:
 *   PI_LENS_LOG_RETENTION_DAYS - Days to keep logs (default: 7)
 *   PI_LENS_MAX_LOG_SIZE_MB    - Max size before rotation (default: 10)
 *   Both take a positive integer, or 0 / off / unlimited for no limit; an
 *   unusable value falls back to the default and is named in the report.
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
 *     PROJECT_DATA_ORPHAN_RETENTION_DAYS old by the directory's own mtime;
 *     never on win32)
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
	projectDataBase,
} from "./file-utils.js";
import {
	getLogLimit,
	UNLIMITED,
	unusableLogLimitEnv,
} from "./log-rotation-limits.js";
import { classifyIpcSocketName, probeIpcSocketListener } from "./mcp/ipc.js";
import { getRegisteredLogFiles } from "./ndjson-logger.js";
import { realIsPidAlive } from "./pid-liveness.js";
import { getGlobalPiLensLogDir } from "./probe-home-state.js";
import { pathsEqual } from "./path-utils.js";
import { sessionsDir, sessionStateFileName } from "./session-state-store.js";

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
 * writes under `<project-data>/sessions/` ({@link sessionStateFileName}):
 * the id is sanitized to `[A-Za-z0-9._-]{1,200}`, so the sweep matches that
 * whole shape instead of the uuid-only live shape.
 */
const SESSION_STATE_FILE_RE = /^[A-Za-z0-9._-]{1,200}\.json$/;

/**
 * How old a project data directory whose root is gone may get before the
 * sweep removes it, read from the directory's own mtime. The root-existence
 * decode is what protects live projects (a project dir whose root exists
 * stays regardless of age); the window only debounces a briefly unmounted
 * root, and an idle project's dir passes it.
 */
const PROJECT_DATA_ORPHAN_RETENTION_DAYS = 30;

interface LogCleanupConfig {
	retentionDays: number;
	maxSizeMB: number;
	/** Environment values that were unusable and replaced by their default. */
	invalid: string[];
}

function getConfig(): LogCleanupConfig {
	return {
		retentionDays: getLogLimit("retentionDays"),
		maxSizeMB: getLogLimit("maxSizeMB"),
		invalid: unusableLogLimitEnv(),
	};
}

function describeLimit(value: number, unit: string): string {
	return value === UNLIMITED ? "unlimited" : `${value}${unit}`;
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
	/** `file` entries are unlinked; `dir` entries are removed recursively;
	 * `socket` entries go through the lstat-guarded socket unlink. */
	deletion: "file" | "dir" | "socket";
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
			deletion: "file",
		},
		{
			label: "rotated logs",
			directory: getGlobalPiLensLogDir,
			match: (name) => ROTATED_BACKUP_RE.test(name),
			maxAgeDays: () => config.retentionDays,
			deletion: "file",
		},
		{
			label: "spill logs",
			directory: getGlobalPiLensLogDir,
			match: (name) => SPILL_RESULT_LOG_RE.test(name),
			maxAgeDays: () => config.retentionDays,
			deletion: "file",
		},
		{
			label: "session state files",
			// The store owns the location (clients/session-state-store.ts).
			directory: () => sessionsDir(options.cwd ?? process.cwd()),
			match: (name) => SESSION_STATE_FILE_RE.test(name),
			maxAgeDays: () => config.retentionDays,
			deletion: "file",
			liveness: (_absPath, name) =>
				sessionStateLiveness(name, options.currentSessionId),
		},
		{
			// The same directory `clients/mcp/ipc.ts` binds every `.sock`
			// endpoint name into; Windows named pipes have no file to scan.
			label: "stale sockets",
			directory: () => os.tmpdir(),
			match: (name) => name.endsWith(".sock"),
			maxAgeDays: () => 1,
			deletion: "socket",
			liveness: socketLiveness,
		},
		{
			label: "orphaned project data dirs",
			directory: projectDataBase,
			// The liveness gate classifies every child; a name it cannot
			// judge is kept, so the row admits all and judges each.
			match: () => true,
			maxAgeDays: () => PROJECT_DATA_ORPHAN_RETENTION_DAYS,
			deletion: "dir",
			liveness: projectDataDirLiveness,
		},
	];
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

/**
 * The session-state row's gate: the live session's own snapshot is never the
 * sweep's to reap, however long the session idles before its next save.
 */
function sessionStateLiveness(
	name: string,
	currentSessionId: string | undefined,
): LivenessVerdict {
	// The store's own file-name derivation: an id it sanitizes is stored
	// under the sanitized name (#5707 CodeRabbit 7n).
	return currentSessionId !== undefined &&
		name === sessionStateFileName(currentSessionId)
		? "live"
		: "stale";
}

/**
 * The project-data row's gate, answered by the decode beside the naming
 * rules (`clients/file-utils.ts`, one probe per name): a root that exists is
 * live, a root that is gone is stale, and a name the decode cannot judge
 * keeps the directory. Only a real directory is judged: a file or link of
 * slug shape in a shared `PILENS_DATA_DIR` is not a project's (#5707 r1 F8).
 */
function projectDataDirLiveness(
	absPath: string,
	name: string,
): LivenessVerdict {
	let isDirectory = false;
	try {
		isDirectory = fs.lstatSync(absPath).isDirectory();
	} catch {
		// none: an entry the sweep cannot stat is not judged; it stays.
		isDirectory = false;
	}
	if (!isDirectory) return "indeterminate";
	const decoded = createProjectDataDirRootProbe().statusFor(name);
	if (decoded === "exists") return "live";
	if (decoded === "gone") return "stale";
	return "indeterminate";
}

/**
 * The socket row's gate: a pid-scoped name carries its owner's pid (a dead
 * owner means nobody can ever bind that name again), a workspace name is
 * judged by dialing it, and a name the classifier refuses is kept.
 */
async function socketLiveness(
	absPath: string,
	name: string,
): Promise<LivenessVerdict> {
	const classified = classifyIpcSocketName(name);
	if (!classified) return "indeterminate";
	if (classified.kind === "pid-scoped") {
		// The name carries its owner's pid, so a dead owner means nobody can
		// ever bind it again. The one liveness check judges the owner (EPERM
		// and an unprobeable pid read alive, so the socket stays); a name
		// carrying no holdable pid has no owner to judge and stays too.
		if (!(classified.pid > 0)) return "indeterminate";
		return realIsPidAlive(classified.pid) ? "live" : "stale";
	}
	// ipc.ts's probe answers "dead" for the same verdict this gate calls
	// stale: a socket file no listener serves.
	const dial = await probeIpcSocketListener(absPath);
	return dial === "dead" ? "stale" : dial === "live" ? "live" : "indeterminate";
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
		// none: the failure is returned to the caller, which counts it once
		// per run in the sweep's report and its dbg record.
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
			const socketClass =
				row.deletion === "socket" ? classifyIpcSocketName(name) : undefined;
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
					// none: an unreadable entry cannot be judged a socket; the
					// sweep keeps whatever it cannot judge.
					isSocket = false;
				}
				if (!isSocket) continue;
				fs.unlinkSync(absPath);
			} else if (row.deletion === "dir") {
				fs.rmSync(absPath, { recursive: true, force: true });
			} else {
				fs.unlinkSync(absPath);
			}
			deleted.push(name);
		} catch (err) {
			// none: the failure is pushed to the row's error list, which the
			// sweep counts once per run in its report and its dbg record.
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
	/** Unusable limit variables that fell back to their default. */
	invalid: string[];
}> {
	const config = getConfig();
	const results = {
		cleaned: 0,
		rotated: 0,
		report: "",
		invalid: config.invalid,
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

	const limits = `retention: ${describeLimit(config.retentionDays, "d")}, maxSize: ${describeLimit(config.maxSizeMB, "MB")}`;
	const ignored =
		config.invalid.length > 0
			? `; ignored unusable ${config.invalid.join(", ")} (use a positive integer, or 0/off/unlimited)`
			: "";
	results.report =
		parts.length > 0
			? `log_cleanup: removed ${parts.join(", ")} (${limits}${ignored})`
			: `log_cleanup: no cleanup needed (${limits}${ignored})`;

	return results;
}
