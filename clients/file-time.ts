/**
 * FileTime Tracking for pi-lens
 *
 * Prevents race conditions when auto-formatting or external tools modify files.
 * Tracks file modification times and sizes to detect external changes.
 *
 * Inspired by OpenCode's FileTime system - ensures agents re-read files
 * that have been modified externally (including by formatters).
 */

import * as fs from "node:fs";
import * as path from "node:path";

// --- Types ---

export interface FileStamp {
	readAt: Date;
	mtime: number | undefined;
	ctime: number | undefined;
	size: number | undefined;
}

interface FileTimeState {
	reads: Map<string, Map<string, FileStamp>>; // sessionID -> filePath -> stamp
	locks: Map<string, Promise<void>>; // filePath -> lock promise
}

// --- Singleton State ---

const globalState: FileTimeState = {
	reads: new Map(),
	locks: new Map(),
};

// --- Public API ---

export class FileTime {
	private sessionID: string;

	constructor(sessionID: string) {
		this.sessionID = sessionID;
	}

	/**
	 * Record a file read with current stats
	 * Call this after ANY file modification (including formatting)
	 */
	read(filePath: string): FileStamp {
		const absolutePath = path.resolve(filePath);
		const stamp = createStamp(absolutePath);

		let sessionReads = globalState.reads.get(this.sessionID);
		if (!sessionReads) {
			sessionReads = new Map();
			globalState.reads.set(this.sessionID, sessionReads);
		}

		sessionReads.set(absolutePath, stamp);
		return stamp;
	}

	/**
	 * Get last recorded stamp for a file
	 */
	get(filePath: string): FileStamp | undefined {
		const absolutePath = path.resolve(filePath);
		const sessionReads = globalState.reads.get(this.sessionID);
		return sessionReads?.get(absolutePath);
	}

	/**
	 * Assert file hasn't changed since last read
	 * Throws error if file modified externally - forces agent to re-read
	 */
	assert(filePath: string): void {
		const absolutePath = path.resolve(filePath);
		const sessionReads = globalState.reads.get(this.sessionID);
		const recorded = sessionReads?.get(absolutePath);

		if (!recorded) {
			throw new FileTimeError(
				`You must read file ${absolutePath} before modifying it. Use the read tool first.`,
				absolutePath,
				"not-read",
			);
		}

		const current = createStamp(absolutePath);
		const changed =
			current.mtime !== recorded.mtime ||
			current.ctime !== recorded.ctime ||
			current.size !== recorded.size;

		if (changed) {
			throw new FileTimeError(
				`File ${absolutePath} has been modified since it was last read.\n` +
					`Last modification: ${new Date(current.mtime ?? Date.now()).toISOString()}\n` +
					`Last read: ${recorded.readAt.toISOString()}\n\n` +
					`Please read the file again before modifying it.`,
				absolutePath,
				"modified",
			);
		}
	}

	/**
	 * Check if file has changed (non-throwing version of assert)
	 */
	hasChanged(filePath: string): boolean {
		const absolutePath = path.resolve(filePath);
		const sessionReads = globalState.reads.get(this.sessionID);
		const recorded = sessionReads?.get(absolutePath);

		if (!recorded) return true; // Never read = changed

		const current = createStamp(absolutePath);
		return (
			current.mtime !== recorded.mtime ||
			current.ctime !== recorded.ctime ||
			current.size !== recorded.size
		);
	}

	/**
	 * Acquire exclusive lock on file
	 * Prevents concurrent modifications to same file
	 */
	async withLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
		const absolutePath = path.resolve(filePath);

		// Wait for existing lock
		while (globalState.locks.has(absolutePath)) {
			const existing = globalState.locks.get(absolutePath);
			if (existing) await existing;
		}

		// Create new lock
		const lockPromise = fn().finally(() => {
			globalState.locks.delete(absolutePath);
		});
		// The STORED lock promise must never reject unhandled: a rejecting fn
		// (e.g. partial-apply's pre-write rejection, #2402) would otherwise leave
		// an orphaned rejected promise on every withLock caller. Waiters awaiting
		// the stored copy still resume — the finally above already deleted the
		// lock entry by the time the rejection settles.
		globalState.locks.set(
			absolutePath,
			lockPromise.then(
				() => {},
				() => {},
			),
		);
		return lockPromise;
	}

	/**
	 * Clear all tracked files for this session
	 */
	clear(): void {
		globalState.reads.delete(this.sessionID);
	}

	/**
	 * Clear specific file tracking
	 */
	clearFile(filePath: string): void {
		const absolutePath = path.resolve(filePath);
		const sessionReads = globalState.reads.get(this.sessionID);
		sessionReads?.delete(absolutePath);
	}
}

// --- Error Type ---

class FileTimeError extends Error {
	readonly filePath: string;
	readonly reason: "not-read" | "modified";

	constructor(
		message: string,
		filePath: string,
		reason: "not-read" | "modified",
	) {
		super(message);
		this.name = "FileTimeError";
		this.filePath = filePath;
		this.reason = reason;
	}
}

// --- Utilities ---

function createStamp(filePath: string): FileStamp {
	try {
		const stats = fs.statSync(filePath);
		return {
			readAt: new Date(),
			mtime: stats.mtime.getTime(),
			ctime: stats.ctime.getTime(),
			size: stats.size,
		};
	} catch {
		// File doesn't exist - return empty stamp
		return {
			readAt: new Date(),
			mtime: undefined,
			ctime: undefined,
			size: undefined,
		};
	}
}

// --- Global Helpers ---

export function createFileTime(sessionID: string): FileTime {
	return new FileTime(sessionID);
}

export function clearAllSessions(): void {
	globalState.reads.clear();
	globalState.locks.clear();
}
