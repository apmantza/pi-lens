/**
 * Per-session diagnostic state persistence (#190 Phase 1).
 *
 * pi-lens's widget/diagnostic state was in-memory only, so quitting and resuming
 * a session (`pi --session <id>`) started "fresh" — `lens_diagnostics` returned
 * nothing. This store persists the widget snapshot to disk keyed by pi's STABLE
 * session id (`ctx.sessionManager.getSessionId()`), so a resumed session can
 * rehydrate its prior findings. Best-effort: every read/write swallows errors
 * (a missing or corrupt file just means "start clean").
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { writeFileAtomicAsync } from "./atomic-write.js";
import { getProjectDataDir } from "./file-utils.js";
import { readJsonCacheAsync } from "./json-cache-read.js";
import type { PersistedReadGuardState } from "./read-guard.js";
import { type SessionScope, snapshotSessionStores } from "./session-scope.js";
import type { PersistedWidgetState } from "./widget-state.js";

/**
 * 2 since #3612: one envelope for every session store, each payload under its
 * store's name. This build still reads version 1 and never writes it.
 */
export const STATE_VERSION = 2;

export interface PersistedSessionState {
	version: number;
	sessionId: string;
	savedAt: number;
	/** Each declared session store's snapshot, by store name (`session-scope.ts`). */
	stores: Record<string, unknown>;
	/** Set by {@link fromDisk} on a migrated file only; never written (#3873). */
	migratedFrom?: 1;
}

/**
 * Version 1 (#190, #1041): the widget snapshot and an optional read-set,
 * which version 2 keeps as the `widget` and `read-guard` stores.
 */
interface PersistedSessionStateV1 {
	version: 1;
	sessionId: string;
	savedAt: number;
	widget: PersistedWidgetState;
	readGuard?: PersistedReadGuardState;
}

function fromDisk(parsed: unknown): PersistedSessionState | undefined {
	const state = parsed as Partial<PersistedSessionState> | null;
	if (
		state?.version === STATE_VERSION &&
		typeof state.stores === "object" &&
		state.stores !== null
	)
		return state as PersistedSessionState;
	const v1 = parsed as Partial<PersistedSessionStateV1> | null;
	if (v1?.version !== 1 || !v1.widget) return undefined;
	return {
		version: STATE_VERSION,
		sessionId: String(v1.sessionId),
		savedAt: Number(v1.savedAt),
		stores: { widget: v1.widget, "read-guard": v1.readGuard },
		migratedFrom: 1,
	};
}

function sessionsDir(cwd: string): string {
	return path.join(getProjectDataDir(cwd), "sessions");
}

/** Session ids are pi uuids, but sanitize defensively before using as a filename. */
function sessionFilePath(cwd: string, sessionId: string): string {
	const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200);
	return path.join(sessionsDir(cwd), `${safe}.json`);
}

/**
 * Persist `stores` for `sessionId` (atomic write via tmp+rename). No-op on a
 * missing id or any I/O error: persistence must never break a turn.
 */
export async function saveSessionState(
	cwd: string,
	sessionId: string | undefined,
	stores: Record<string, unknown>,
): Promise<void> {
	if (!sessionId || !sessionId.trim()) return;
	try {
		const dir = sessionsDir(cwd);
		await fs.mkdir(dir, { recursive: true });
		const payload: PersistedSessionState = {
			version: STATE_VERSION,
			sessionId,
			savedAt: Date.now(),
			stores,
		};
		// bestEffort (default): a failed write/rename just means this snapshot is
		// lost, matching this store's documented "start clean" fallback.
		await writeFileAtomicAsync(
			sessionFilePath(cwd, sessionId),
			JSON.stringify(payload),
		);
	} catch {
		/* best-effort */
	}
}

/**
 * The one sidecar writer (#3612): every declared store's snapshot of
 * `scope`, saved fire-and-forget under `sessionId`.
 */
export function persistScope(
	cwd: string,
	sessionId: string | undefined,
	scope: SessionScope,
): void {
	void saveSessionState(cwd, sessionId, snapshotSessionStores(scope));
}

/**
 * Reconcile a rehydrated snapshot with the current filesystem (#190 / #180):
 * drop files whose on-disk mtime is newer than `savedAt` (changed since the
 * snapshot) or that no longer exist, so a resume never shows stale diagnostics
 * for files edited between sessions. Dropped files simply re-scan on their next
 * edit. Existence/mtime are probed concurrently (off the event loop).
 */
export async function dropStaleFiles(
	widget: PersistedWidgetState,
	savedAt: number,
): Promise<PersistedWidgetState> {
	const checked = await Promise.all(
		widget.files.map(async (file) => {
			try {
				const st = await fs.stat(file.filePath);
				// mtime within a small skew of savedAt counts as unchanged.
				return st.mtimeMs <= savedAt + 1 ? file : undefined;
			} catch {
				return undefined; // gone → drop
			}
		}),
	);
	return {
		...widget,
		files: checked.filter(
			(f): f is PersistedWidgetState["files"][number] => f !== undefined,
		),
	};
}

/**
 * Load the persisted stores for `sessionId`, or undefined if none,
 * unreadable, or of an unknown version. A version-1 file loads as its
 * `widget` and `read-guard` stores.
 */
export async function loadSessionState(
	cwd: string,
	sessionId: string | undefined,
): Promise<PersistedSessionState | undefined> {
	if (!sessionId || !sessionId.trim()) return undefined;
	return readJsonCacheAsync<PersistedSessionState>(
		sessionFilePath(cwd, sessionId),
		fromDisk,
	);
}
