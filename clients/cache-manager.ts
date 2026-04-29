/**
 * CacheManager for pi-lens.
 *
 * Manages persistent cache for scanner results and turn state.
 * Provides read/write/freshness checks for:
 * - Scanner cache: .pi-lens/cache/{scanner}.json
 * - Turn state: .pi-lens/turn-state.json
 *
 * All paths are relative to project root (process.cwd()).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getProjectDataDir } from "./file-utils.js";
import { normalizeMapKey } from "./path-utils.js";

// --- Types ---

export interface CacheMeta {
	timestamp: string; // ISO timestamp
	scanDurationMs?: number;
	fileCount?: number;
}

export interface CacheEntry<T> {
	data: T;
	meta: CacheMeta;
}

export interface ModifiedRange {
	start: number;
	end: number;
}

export interface TurnFileState {
	modifiedRanges: ModifiedRange[];
	importsChanged: boolean;
	lastEdit: string; // ISO timestamp
}

export interface TurnState {
	files: Record<string, TurnFileState>;
	turnCycles: number;
	maxCycles: number;
	lastUpdated: string;
}

// --- Defaults ---

const DEFAULT_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_TURN_STATE: TurnState = {
	files: {},
	turnCycles: 0,
	maxCycles: 3,
	lastUpdated: "",
};

// --- Helpers ---

function getLensDir(cwd: string): string {
	return getProjectDataDir(cwd);
}

function getCacheDir(cwd: string): string {
	return path.join(getLensDir(cwd), "cache");
}

function getTurnStatePath(cwd: string): string {
	return path.join(getLensDir(cwd), "turn-state.json");
}

// --- Cache Manager ---

export class CacheManager {
	private log: (msg: string) => void;

	constructor(verbose = false) {
		this.log = verbose
			? (msg: string) => console.error(`[cache] ${msg}`)
			: () => {};
	}

	/**
	 * Convert a file path to a stable turn-state key.
	 * Uses normalized absolute paths first, then stores cwd-relative keys when possible.
	 */
	toTurnStateKey(filePath: string, cwd: string): string {
		const cwdNorm = normalizeMapKey(path.resolve(cwd));
		const fileNorm = normalizeMapKey(path.resolve(cwd, filePath));
		const rel = path.relative(cwdNorm, fileNorm).replace(/\\/g, "/");
		if (!rel || rel === ".") return fileNorm;
		if (rel === ".." || rel.startsWith("../")) return fileNorm;
		return rel;
	}

	/**
	 * Get turn-state entry for a file path using normalized lookup.
	 */
	getTurnFileState(filePath: string, cwd: string): TurnFileState | undefined {
		const state = this.readTurnState(cwd);
		const key = this.toTurnStateKey(filePath, cwd);
		return state.files[key];
	}

	// ---- Scanner Cache ----

	/**
	 * Read a scanner cache entry. Returns null if not found or stale.
	 */
	readCache<T>(
		scanner: string,
		cwd: string,
		maxAgeMs = DEFAULT_MAX_AGE_MS,
	): CacheEntry<T> | null {
		const cachePath = path.join(getCacheDir(cwd), `${scanner}.json`);
		const metaPath = path.join(getCacheDir(cwd), `${scanner}.meta.json`);

		if (!fs.existsSync(cachePath) || !fs.existsSync(metaPath)) {
			this.log(`Cache miss: ${scanner} (files don't exist)`);
			return null;
		}

		try {
			const meta: CacheMeta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
			const age = Date.now() - new Date(meta.timestamp).getTime();

			if (age > maxAgeMs) {
				this.log(
					`Cache stale: ${scanner} (age: ${Math.round(age / 1000)}s, max: ${maxAgeMs / 1000}s)`,
				);
				return null;
			}

			const data: T = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
			this.log(`Cache hit: ${scanner} (age: ${Math.round(age / 1000)}s)`);
			return { data, meta };
		} catch (err) {
			this.log(`Cache read error: ${scanner} — ${err}`);
			return null;
		}
	}

	/**
	 * Write a scanner cache entry.
	 */
	writeCache<T>(
		scanner: string,
		data: T,
		cwd: string,
		extraMeta?: Partial<CacheMeta>,
	): void {
		const cacheDir = getCacheDir(cwd);
		fs.mkdirSync(cacheDir, { recursive: true });

		const cachePath = path.join(cacheDir, `${scanner}.json`);
		const metaPath = path.join(cacheDir, `${scanner}.meta.json`);

		const meta: CacheMeta = {
			timestamp: new Date().toISOString(),
			...extraMeta,
		};

		fs.writeFileSync(cachePath, JSON.stringify(data, null, 2));
		fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
		this.log(`Cache written: ${scanner}`);
	}

	/**
	 * Check if a cache entry is fresh (exists and not expired).
	 */
	isCacheFresh(
		scanner: string,
		cwd: string,
		maxAgeMs = DEFAULT_MAX_AGE_MS,
	): boolean {
		const metaPath = path.join(getCacheDir(cwd), `${scanner}.meta.json`);
		if (!fs.existsSync(metaPath)) return false;

		try {
			const meta: CacheMeta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
			const age = Date.now() - new Date(meta.timestamp).getTime();
			return age <= maxAgeMs;
		} catch {
			return false;
		}
	}

	/**
	 * Clear a specific cache entry.
	 */
	clearCache(scanner: string, cwd: string): void {
		const cachePath = path.join(getCacheDir(cwd), `${scanner}.json`);
		const metaPath = path.join(getCacheDir(cwd), `${scanner}.meta.json`);
		for (const p of [cachePath, metaPath]) {
			try {
				fs.unlinkSync(p);
			} catch (err) {
				// ENOENT: file doesn't exist, other errors logged
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
					this.log(`Failed to delete ${p}: ${err}`);
				}
			}
		}
	}

	// ---- Turn State ----

	/**
	 * Read turn state. Returns default if not found.
	 */
	readTurnState(cwd: string): TurnState {
		const statePath = getTurnStatePath(cwd);
		if (!fs.existsSync(statePath)) {
			return {
				...DEFAULT_TURN_STATE,
				files: {},
				lastUpdated: new Date().toISOString(),
			};
		}

		try {
			return JSON.parse(fs.readFileSync(statePath, "utf-8"));
		} catch {
			return {
				...DEFAULT_TURN_STATE,
				files: {},
				lastUpdated: new Date().toISOString(),
			};
		}
	}

	/**
	 * Write turn state.
	 */
	writeTurnState(state: TurnState, cwd: string): void {
		const lensDir = getLensDir(cwd);
		fs.mkdirSync(lensDir, { recursive: true });

		const statePath = getTurnStatePath(cwd);
		state.lastUpdated = new Date().toISOString();
		fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
	}

	/**
	 * Add or update a file's modified ranges in turn state.
	 * Merges overlapping ranges.
	 */
	addModifiedRange(
		filePath: string,
		range: ModifiedRange,
		importsChanged: boolean,
		cwd: string,
	): TurnState {
		const state = this.readTurnState(cwd);
		const normalizedPath = this.toTurnStateKey(filePath, cwd);

		const existing = state.files[normalizedPath];
		if (existing) {
			// Merge ranges
			existing.modifiedRanges = this.mergeRanges([
				...existing.modifiedRanges,
				range,
			]);
			existing.importsChanged = existing.importsChanged || importsChanged;
			existing.lastEdit = new Date().toISOString();
		} else {
			state.files[normalizedPath] = {
				modifiedRanges: [range],
				importsChanged,
				lastEdit: new Date().toISOString(),
			};
		}

		this.writeTurnState(state, cwd);
		return state;
	}

	/**
	 * Clear turn state (after turn_end processes it).
	 */
	clearTurnState(cwd: string): void {
		const state: TurnState = {
			...DEFAULT_TURN_STATE,
			files: {}, // fresh object — DEFAULT_TURN_STATE.files can be polluted by addModifiedRange
			lastUpdated: new Date().toISOString(),
		};
		this.writeTurnState(state, cwd);
	}

	/**
	 * Increment turn cycle counter.
	 */
	incrementTurnCycle(cwd: string): TurnState {
		const state = this.readTurnState(cwd);
		state.turnCycles++;
		this.writeTurnState(state, cwd);
		return state;
	}

	/**
	 * Check if max cycles exceeded.
	 */
	isMaxCyclesExceeded(cwd: string): boolean {
		const state = this.readTurnState(cwd);
		return state.turnCycles >= state.maxCycles;
	}

	/**
	 * Get files that need jscpd re-scan (any edit).
	 */
	getFilesForJscpd(cwd: string): string[] {
		const state = this.readTurnState(cwd);
		return Object.keys(state.files);
	}

	/**
	 * Get files that need madge re-scan (imports changed).
	 */
	getFilesForMadge(cwd: string): string[] {
		const state = this.readTurnState(cwd);
		return Object.entries(state.files)
			.filter(([, f]) => f.importsChanged)
			.map(([p]) => p);
	}

	// ---- Utilities ----

	/**
	 * Merge overlapping or adjacent ranges.
	 */
	mergeRanges(ranges: ModifiedRange[]): ModifiedRange[] {
		if (ranges.length === 0) return [];

		const sorted = [...ranges].sort((a, b) => a.start - b.start);
		const merged: ModifiedRange[] = [sorted[0]];

		for (const current of sorted.slice(1)) {
			const last = merged[merged.length - 1];
			if (current.start <= last.end + 1) {
				last.end = Math.max(last.end, current.end);
			} else {
				merged.push({ ...current });
			}
		}

		return merged;
	}

	/**
	 * Check if a line falls within any modified range.
	 */
	isLineInModifiedRange(line: number, ranges: ModifiedRange[]): boolean {
		return ranges.some((r) => r.start <= line && line <= r.end);
	}
}
