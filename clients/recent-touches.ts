/**
 * Cross-process touched-files record (#492).
 *
 * #485 (clients/agent-nudge.ts) delivers an inline "these files were
 * autoformatted by pi-lens" context nudge, fed by the IN-PROCESS
 * `pilens:files:touched` bus event (#482, clients/bus-publish.ts). That
 * covers every run/turn of the SAME pi process, but subagents spawn real
 * child `pi` processes — a separate process, a separate in-memory bus, a
 * separate accumulator. Nothing about #485 crosses that boundary in either
 * direction:
 *
 *   - Child blind to parent: parent's turn_end autoformat dirties the tree;
 *     a child asked to commit runs `git status`, finds unexplained `M`
 *     files, burns turns investigating.
 *   - Parent blind to child: the child is ephemeral, but the parent keeps
 *     working in the same tree after the child returns and its pi-lens
 *     autoformatted on top of the child's edits.
 *
 * This module is the shared substrate: a single project-scoped
 * `recent-touches.json` (via `getProjectDataDir(cwd)` — NEVER a hardcoded
 * `.pi-lens` path) that every pi-lens instance (parent or child) both
 * appends to (on publish) and reads from (session_start / turn_start). Ring
 * buffer capped at ~50 entries; atomic tmp+rename writes, same pattern as
 * the instance registry (#474, clients/instance-registry.ts). `pid` is what
 * makes consumption self-excluding: a process must never see its own writes
 * come back around as a "cross-process" nudge.
 *
 * Non-goals (#492): no IPC, no daemon, no `fs.watch` — a passive file,
 * appended on publish and read at session_start / mtime-gated at
 * turn_start. Not a general cross-process event bus; one record for one
 * nudge feed.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getProjectDataDir } from "./file-utils.js";
import { normalizeFilePath } from "./path-utils.js";

export const RECENT_TOUCHES_MAX_ENTRIES = 50;
/** Freshness window for the CHILD session_start consumer (15 minutes). */
export const RECENT_TOUCHES_FRESHNESS_MS = 15 * 60 * 1000;

export type RecentTouchReason = "autofix" | "format";

export interface RecentTouchEntry {
	/** Normalized (forward-slash) path — see `normalizeFilePath`. */
	path: string;
	reason: RecentTouchReason;
	/** Epoch ms. */
	ts: number;
	/** Writer's pid — enables self-exclusion for the reading process. */
	pid: number;
	sessionId?: string;
}

interface RecentTouchesFile {
	entries: RecentTouchEntry[];
}

function recentTouchesPath(cwd: string): string {
	return path.join(getProjectDataDir(cwd), "recent-touches.json");
}

// --- Kill switch: reuse the #485 flag (house style per clients/agent-nudge.ts) ---
// This module does not define its own env var — #492 is explicitly a feed
// INTO the same nudge pipeline, so one switch governs the whole path
// (producer, both consumers) as specified in the issue.
let _enabledCache: boolean | undefined;

export function isRecentTouchesEnabled(): boolean {
	if (_enabledCache === undefined) {
		_enabledCache = process.env.PI_LENS_AGENT_NUDGE !== "0";
	}
	return _enabledCache;
}

/** Test-only: reset all module state between test files/cases. */
export function _resetRecentTouchesForTests(): void {
	_enabledCache = undefined;
	_lastSeenMtimeMs = undefined;
	_lastConsumedCursor.clear();
}

// --- Read (never throws — missing file, corrupt JSON, or wrong shape ⇒ empty) ---

async function readRecentTouchesAsync(cwd: string): Promise<RecentTouchesFile> {
	try {
		const raw = await fs.promises.readFile(recentTouchesPath(cwd), "utf-8");
		const parsed = JSON.parse(raw);
		if (parsed && Array.isArray(parsed.entries)) {
			return parsed as RecentTouchesFile;
		}
		return { entries: [] };
	} catch {
		return { entries: [] };
	}
}

// --- Write (atomic tmp + rename, same pattern as instance-registry.ts) ---

async function writeRecentTouchesAsync(
	cwd: string,
	file: RecentTouchesFile,
): Promise<void> {
	const dir = getProjectDataDir(cwd);
	const target = recentTouchesPath(cwd);
	const tmpPath = `${target}.tmp-${process.pid}`;
	try {
		await fs.promises.mkdir(dir, { recursive: true });
		await fs.promises.writeFile(tmpPath, JSON.stringify(file), "utf-8");
		await fs.promises.rename(tmpPath, target);
	} catch {
		// Best-effort record — a failed write just means this batch of touches
		// never reaches other instances; never throw for the caller (the
		// producer seam is the fire-and-forget bus-publish path).
		try {
			await fs.promises.rm(tmpPath, { force: true });
		} catch {
			// ignore
		}
	}
}

export interface AppendRecentTouchesArgs {
	cwd: string;
	reason: RecentTouchReason;
	paths: string[];
	sessionId?: string;
}

/**
 * Append this process's touched paths to the shared record (read-modify-
 * write-whole-file, ring-buffer capped at `RECENT_TOUCHES_MAX_ENTRIES` —
 * oldest entries drop first). Called from the SAME seam as
 * `publishFilesTouched` (clients/bus-publish.ts) so parent and child run
 * identical code. Never throws — callers must swallow/log failures
 * themselves (this function already does internally via the write helper).
 */
export async function appendRecentTouches(
	args: AppendRecentTouchesArgs,
): Promise<void> {
	if (!isRecentTouchesEnabled()) return;
	if (args.paths.length === 0) return;
	const now = Date.now();
	const pid = process.pid;
	const newEntries: RecentTouchEntry[] = args.paths.map((p) => ({
		path: normalizeFilePath(p),
		reason: args.reason,
		ts: now,
		pid,
		sessionId: args.sessionId,
	}));
	const file = await readRecentTouchesAsync(args.cwd);
	const merged = [...file.entries, ...newEntries];
	// Ring buffer: keep the newest N (oldest-first array, so slice from the tail).
	const capped =
		merged.length > RECENT_TOUCHES_MAX_ENTRIES
			? merged.slice(merged.length - RECENT_TOUCHES_MAX_ENTRIES)
			: merged;
	await writeRecentTouchesAsync(args.cwd, { entries: capped });
}

// --- Shared foreign-entry filter (both consumers) ---

/**
 * The baseline relevance filter EVERY consumer applies: not our own pid,
 * within the freshness window, and the file still exists on disk. Shared so
 * the turn_start reader can never drift from the session_start reader again
 * — the original turn_start implementation only filtered pid + cursor, which
 * meant a fresh process's FIRST turn_start (unset mtime watermark, cursor 0)
 * would surface every entry in the record, including days-old touches of
 * since-deleted files (the ring buffer caps count, not age — nothing ever
 * expires entries in place).
 */
function passesForeignEntryFilter(
	entry: RecentTouchEntry,
	selfPid: number,
	now: number,
	freshnessMs: number,
): boolean {
	if (entry.pid === selfPid) return false;
	if (now - entry.ts > freshnessMs) return false;
	try {
		return fs.existsSync(entry.path);
	} catch {
		return false;
	}
}

// --- Consumer: child at session_start ---

export interface ReadCrossProcessTouchesForSessionStartArgs {
	cwd: string;
	/** Defaults to `process.pid` — overridable for tests. */
	selfPid?: number;
	/** Defaults to `Date.now()` — overridable for tests. */
	now?: number;
	/** Defaults to `RECENT_TOUCHES_FRESHNESS_MS` — overridable for tests. */
	freshnessMs?: number;
}

/**
 * Read entries for the CHILD-at-session_start consumer: `pid !== self`,
 * newer than the freshness window, and whose file still exists on disk.
 * The child has no read-guard history yet (it just started), so relevance
 * here is recency + existence only — the read-guard-based relevance filter
 * is applied later, upstream, by the caller feeding these into #485's
 * accumulator (agent-nudge.ts intentionally has no session-agnostic
 * "cross-process" bypass of its own relevance filter — this function is
 * the point where that decision is made, per #492 point 6).
 *
 * Never throws: ENOENT / EACCES / parse errors on the record file already
 * collapse to an empty read inside `readRecentTouchesAsync`; a
 * `fs.existsSync` per candidate is wrapped defensively too.
 */
export async function readCrossProcessTouchesForSessionStart(
	args: ReadCrossProcessTouchesForSessionStartArgs,
): Promise<RecentTouchEntry[]> {
	if (!isRecentTouchesEnabled()) return [];
	try {
		const selfPid = args.selfPid ?? process.pid;
		const now = args.now ?? Date.now();
		const freshnessMs = args.freshnessMs ?? RECENT_TOUCHES_FRESHNESS_MS;
		const file = await readRecentTouchesAsync(args.cwd);
		return file.entries.filter((e) =>
			passesForeignEntryFilter(e, selfPid, now, freshnessMs),
		);
	} catch {
		return [];
	}
}

// --- Consumer: parent at turn_start (mtime-gated hot path) ---

// Module state: the last mtime we've already consumed, and a per-cwd cursor
// (max ts already surfaced) so repeated reads of an unchanged-since-last-
// check file never re-emit the same entries into the accumulator twice.
let _lastSeenMtimeMs: number | undefined;
const _lastConsumedCursor = new Map<string, number>();

export interface ReadCrossProcessTouchesForTurnStartArgs {
	cwd: string;
	selfPid?: number;
	/** Defaults to `Date.now()` — overridable for tests. */
	now?: number;
	/** Defaults to `RECENT_TOUCHES_FRESHNESS_MS` — overridable for tests. */
	freshnessMs?: number;
}

/**
 * Parent-at-turn_start consumer. Hot path: ONE `fs.stat` per call; when the
 * mtime matches the last-seen mtime, returns `[]` immediately — no read, no
 * JSON parse. On a changed mtime, reads the file and applies TWO filters:
 *   1. the shared foreign-entry filter (`pid !== self`, within the
 *      freshness window, file still exists) — the same baseline the
 *      session_start reader applies, so a fresh process's first turn_start
 *      can never nudge about days-old touches of since-deleted files;
 *   2. `ts` newer than this cwd's last-consumed cursor (dedupes identical
 *      path+ts across repeated reads — a touch already surfaced once must
 *      never come back), then advances both the mtime watermark and the
 *      cursor.
 *
 * Wrapped so ENOENT/EACCES/parse errors NEVER throw into turn_start — a
 * missing record file (no cross-process activity yet) is the common case
 * and must be silent, not logged as an error.
 */
export async function readCrossProcessTouchesForTurnStart(
	args: ReadCrossProcessTouchesForTurnStartArgs,
): Promise<RecentTouchEntry[]> {
	if (!isRecentTouchesEnabled()) return [];
	try {
		const target = recentTouchesPath(args.cwd);
		let mtimeMs: number;
		try {
			mtimeMs = (await fs.promises.stat(target)).mtimeMs;
		} catch {
			// No record file yet (ENOENT) or inaccessible (EACCES) — nothing to
			// report; do not disturb the mtime watermark.
			return [];
		}
		if (_lastSeenMtimeMs === mtimeMs) return [];
		_lastSeenMtimeMs = mtimeMs;

		const selfPid = args.selfPid ?? process.pid;
		const now = args.now ?? Date.now();
		const freshnessMs = args.freshnessMs ?? RECENT_TOUCHES_FRESHNESS_MS;
		const file = await readRecentTouchesAsync(args.cwd);
		const cursorKey = normalizeFilePath(args.cwd);
		const cursor = _lastConsumedCursor.get(cursorKey) ?? 0;
		const fresh = file.entries.filter(
			(e) =>
				e.ts > cursor && passesForeignEntryFilter(e, selfPid, now, freshnessMs),
		);
		if (file.entries.length > 0) {
			const maxTs = Math.max(...file.entries.map((e) => e.ts));
			_lastConsumedCursor.set(cursorKey, Math.max(cursor, maxTs));
		}
		return fresh;
	} catch {
		return [];
	}
}
