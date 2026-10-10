/**
 * CacheManager for pi-lens.
 *
 * Manages persistent cache for scanner results and turn state.
 * Provides read/write/freshness checks for:
 * - Scanner cache: <project-data-dir>/cache/{scanner}.json
 * - Turn state: <project-data-dir>/turn-state.json
 *
 * `<project-data-dir>` is `getProjectDataDir(cwd)` (clients/file-utils.ts) --
 * `<cwd>/.pi-lens` only when that legacy directory already exists, otherwise
 * `~/.pi-lens/projects/<slug>` or a `PILENS_DATA_DIR` location. Never assume
 * the legacy spelling, and never show it to an agent: build a displayed path
 * with `displayProjectDataPath` (#2521).
 */

import { createSubsystemLogger } from "./extension-log.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { getProjectDataDir } from "./file-utils.js";
import { writeFileAtomic } from "./atomic-write.js";
import { readJsonCache, readJsonCacheAsync } from "./json-cache-read.js";
import { isUnderDir, normalizeMapKey } from "./path-utils.js";
import type { AnalysisRootMode } from "./analysis-root.js";

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

export type CacheInspection =
	| "missing"
	| "fresh"
	| "stale"
	| "malformed"
	| "unreadable";

export interface ModifiedRange {
	start: number;
	end: number;
}

export interface TurnFileState {
	modifiedRanges: ModifiedRange[];
	importsChanged: boolean;
	lastEdit: string; // ISO timestamp
}

export type TurnStateOwnerKind = "pi" | "mcp";

export interface TurnStateOwner {
	kind: TurnStateOwnerKind;
	id: string;
	pid: number;
	lastSeen: string;
	/**
	 * #2504: epoch ms this writer's SESSION began. Read by
	 * `getTurnStateAccess` to date an ownerless persisted worklist against the
	 * asking session — a worklist last written before this session started
	 * cannot be this session's work, however recently the file was touched.
	 * Optional: a caller that cannot supply it keeps the pre-#2504 gate.
	 */
	sessionStartedAt?: number;
}

export type TurnStateAccess = "owned" | "available" | "foreign-live";

export interface TurnState {
	files: Record<string, TurnFileState>;
	turnCycles: number;
	maxCycles: number;
	lastUpdated: string;
	/** Legacy session id retained for old consumers and persisted snapshots. */
	sessionId?: string;
	/** Explicit writer identity; unlike sessionId this distinguishes pi/MCP. */
	owner?: TurnStateOwner;
	/** #3613 R2: durable worklists for concurrent same-process sessions. */
	sessions?: Record<string, TurnStatePartition>;
}

export type TurnStatePartition = Omit<TurnState, "sessions">;

// --- Defaults ---

const DEFAULT_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_TURN_STATE: TurnState = {
	files: {},
	turnCycles: 0,
	maxCycles: 3,
	lastUpdated: "",
};

export const MCP_TURN_STATE_OWNER_ID = `mcp-${process.pid}`;
const TURN_OWNER_STALE_MS = 30 * 60 * 1000;
const TURN_SESSION_PARTITION_TTL_MS = 30 * 60 * 1000;
const MAX_TURN_SESSION_PARTITIONS = 16;

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
		this.log = verbose ? createSubsystemLogger("cache") : () => {};
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
	/**
	 * #2504: is this path inside the PROJECT the worklist belongs to?
	 *
	 * Routed through `isUnderDir` (which normalises via `normalizeFilePath`) so
	 * the answer is separator- and case-form independent, the same key rule
	 * every other turn-state map obeys.
	 *
	 * The root is the PROJECT root, not the caller's `cwd` (#2504 review round
	 * 2, F1). The two coincide for every producer whose `cwd` IS the session
	 * root, but not for `clients/lsp-mutation.ts`: `tools/lsp-navigation.ts`
	 * threads a `cwd`-scoped context for a call issued from a sub-package
	 * directory, so a monorepo-wide server's edit on a SIBLING package is
	 * inside the project and outside that `cwd`. Judging it against `cwd`
	 * dropped exactly the server-initiated edits #2450/#2479 exist to record.
	 * This is the same root `isRecordableProjectPath` (clients/file-utils.ts)
	 * is given at that call site — one predicate root, taken from
	 * `runtime.projectRoot`, not two that can disagree.
	 */
	isTurnStatePathWithinRoot(filePath: string, projectRoot: string): boolean {
		const root = path.resolve(projectRoot);
		const abs = path.resolve(root, filePath);
		if (normalizeMapKey(abs) === normalizeMapKey(root)) return false;
		return isUnderDir(abs, root);
	}

	getTurnFileState(filePath: string, cwd: string): TurnFileState | undefined {
		const state = this.readTurnState(cwd);
		const key = this.toTurnStateKey(filePath, cwd);
		return state.files[key];
	}

	// ---- Scanner Cache ----

	/**
	 * The ONE staleness rule both scanner reads apply (#3274): the envelope's
	 * age in ms when it is inside `maxAgeMs`, or `null` — having logged the
	 * stale verdict — when it is not.
	 *
	 * Extracted rather than copied into {@link readCacheAsync} because the TTL
	 * boundary is exactly what the two seams must not disagree about while
	 * #3300 migrates callers across: a delivery that read one store through
	 * each method would otherwise be able to see it fresh and stale at once.
	 */
	private freshAgeMs(
		scanner: string,
		meta: CacheMeta,
		maxAgeMs: number,
	): number | null {
		const age = Date.now() - new Date(meta.timestamp).getTime();
		if (age > maxAgeMs) {
			this.log(
				`Cache stale: ${scanner} (age: ${Math.round(age / 1000)}s, max: ${maxAgeMs / 1000}s)`,
			);
			return null;
		}
		return age;
	}

	/**
	 * Read a scanner cache entry WITHOUT blocking the event loop (#3274).
	 *
	 * `readCache` below is synchronous: two `existsSync` plus two
	 * `readFileSync`+`JSON.parse`, all of which complete during ARGUMENT
	 * EVALUATION. `bounded()` (`clients/deadline-utils.ts`) takes a promise, so
	 * a hook that wrapped the sync read registered a budget that could never be
	 * spent — probed on #3274 with an already-aborted signal and `ms: 0`:
	 * `bounded()` returned `undefined` and the read had already parsed its JSON.
	 * This sibling suspends on `fs.promises`, so the turn_end budget and the
	 * hook's `ctx.signal` can actually abandon it.
	 *
	 * Same outcomes as the sync seam — an envelope, or `null` for missing,
	 * stale, corrupt or unreadable — and the same parser
	 * (`readJsonCacheAsync`, the async sibling in `clients/json-cache-read.ts`;
	 * there is no second parser). ONE deliberate difference, in the verbose log
	 * only: a missing store is reported as `Cache miss: <scanner> — <err>` from
	 * the read's own ENOENT instead of a preceding `existsSync` pair, because
	 * the pair is half the blocking cost this method exists to remove.
	 */
	async readCacheAsync<T>(
		scanner: string,
		cwd: string,
		maxAgeMs = DEFAULT_MAX_AGE_MS,
	): Promise<CacheEntry<T> | null> {
		const cachePath = path.join(getCacheDir(cwd), `${scanner}.json`);
		const metaPath = path.join(getCacheDir(cwd), `${scanner}.meta.json`);
		const onReadError = (err: unknown) => {
			this.log(`Cache miss: ${scanner} — ${err}`);
		};

		const meta = await readJsonCacheAsync<CacheMeta>(
			metaPath,
			(parsed) => parsed as CacheMeta,
			onReadError,
		);
		if (meta === undefined) return null;

		const age = this.freshAgeMs(scanner, meta, maxAgeMs);
		if (age === null) return null;

		const data = await readJsonCacheAsync<T>(
			cachePath,
			(parsed) => parsed as T,
			onReadError,
		);
		if (data === undefined) return null;

		this.log(`Cache hit: ${scanner} (age: ${Math.round(age / 1000)}s)`);
		return { data, meta };
	}

	/**
	 * Read a scanner cache entry. Returns null if not found or stale.
	 *
	 * Synchronous, and therefore unboundable on a hook path — see
	 * {@link readCacheAsync}, and the `sync-hook-read` population in
	 * `tests/config/hook-await-bounds.test.ts` that counts the callers still
	 * on it. #3300 migrates them and deletes this method in its last slice.
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
			const onReadError = (err: unknown) => {
				this.log(`Cache read error: ${scanner} — ${err}`);
			};

			const meta = readJsonCache<CacheMeta>(
				metaPath,
				(parsed) => parsed as CacheMeta,
				onReadError,
			);
			if (meta === undefined) return null;

			const age = this.freshAgeMs(scanner, meta, maxAgeMs);
			if (age === null) return null;

			const data = readJsonCache<T>(
				cachePath,
				(parsed) => parsed as T,
				onReadError,
			);
			if (data === undefined) return null;

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

		writeFileAtomic(cachePath, JSON.stringify(data, null, 2), {
			bestEffort: false,
		});
		writeFileAtomic(metaPath, JSON.stringify(meta, null, 2), {
			bestEffort: false,
		});
		this.log(`Cache written: ${scanner}`);
	}

	/** Inspect a cache without changing the behavior of readCache consumers. */
	inspectCache(
		scanner: string,
		cwd: string,
		maxAgeMs = DEFAULT_MAX_AGE_MS,
	): CacheInspection {
		const cachePath = path.join(getCacheDir(cwd), `${scanner}.json`);
		const metaPath = path.join(getCacheDir(cwd), `${scanner}.meta.json`);
		for (const cachePathname of [cachePath, metaPath]) {
			try {
				fs.statSync(cachePathname);
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") return "missing";
				return "unreadable";
			}
		}
		try {
			const meta = readJsonCache<CacheMeta>(
				metaPath,
				(parsed) => parsed as CacheMeta,
			);
			if (!meta || typeof meta.timestamp !== "string") return "malformed";
			const timestamp = new Date(meta.timestamp).getTime();
			if (!Number.isFinite(timestamp)) return "malformed";
			const age = Date.now() - timestamp;
			if (age < 0 || age > maxAgeMs) return age < 0 ? "malformed" : "stale";
			const data = readJsonCache<unknown>(cachePath, (parsed) => parsed);
			return data === undefined ? "malformed" : "fresh";
		} catch {
			return "unreadable";
		}
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
			const meta = readJsonCache<CacheMeta>(
				metaPath,
				(parsed) => parsed as CacheMeta,
			);
			if (meta === undefined) return false;
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
	readTurnState(cwd: string, sessionId?: string): TurnState {
		return this.resolveTurnStatePartition(cwd, sessionId).state;
	}

	/**
	 * Reserve a secondary's durable partition at turn start. The legacy
	 * envelope may still be ownerless before the first write, so the write
	 * itself cannot infer that this session is concurrent from persisted state.
	 */
	ensureSecondaryTurnStatePartition(cwd: string, sessionId: string): void {
		const envelope = this.readTurnStateEnvelope(cwd);
		if (envelope.sessions?.[sessionId]) return;
		const secondary: TurnState = {
			...DEFAULT_TURN_STATE,
			files: {},
			lastUpdated: new Date().toISOString(),
			sessionId,
			owner: {
				kind: "pi",
				id: sessionId,
				pid: process.pid,
				lastSeen: new Date().toISOString(),
			},
		};
		this.writeTurnState(
			{
				...envelope,
				sessions: { ...envelope.sessions, [sessionId]: secondary },
			},
			cwd,
		);
	}

	/** Resolve the persisted primary/secondary turn-state partition. */
	private resolveTurnStatePartition(
		cwd: string,
		sessionId?: string,
	): {
		envelope: TurnState;
		state: TurnState;
		isSecondary: boolean;
		persist: (state: TurnState) => void;
		remove: () => void;
	} {
		const envelope = this.readTurnStateEnvelope(cwd);
		const persistedSecondary =
			sessionId === undefined ? undefined : envelope.sessions?.[sessionId];
		const primary =
			sessionId === undefined ||
			(envelope.owner === undefined && persistedSecondary === undefined) ||
			(envelope.owner?.kind === "pi" && envelope.owner.id === sessionId);
		const isSecondary =
			!primary &&
			(persistedSecondary !== undefined ||
				(envelope.owner?.kind === "pi" && envelope.owner.pid === process.pid));
		const state = primary
			? envelope
			: (persistedSecondary ?? {
					...DEFAULT_TURN_STATE,
					files: {},
					lastUpdated: new Date().toISOString(),
				});
		return {
			envelope,
			state,
			isSecondary,
			persist: (next) => {
				if (isSecondary && sessionId !== undefined) {
					this.writeTurnState(
						{
							...envelope,
							sessions: { ...envelope.sessions, [sessionId]: next },
						},
						cwd,
					);
				} else this.writeTurnState(next, cwd);
			},
			remove: () => {
				if (!isSecondary || sessionId === undefined) return;
				const { [sessionId]: _retired, ...remaining } = envelope.sessions ?? {};
				this.writeTurnState({ ...envelope, sessions: remaining }, cwd);
			},
		};
	}

	private readTurnStateEnvelope(cwd: string): TurnState {
		const statePath = getTurnStatePath(cwd);
		if (!fs.existsSync(statePath)) {
			return {
				...DEFAULT_TURN_STATE,
				files: {},
				lastUpdated: new Date().toISOString(),
			};
		}

		const state = readJsonCache<TurnState>(
			statePath,
			(parsed) => parsed as TurnState,
		);
		const envelope = state ?? {
			...DEFAULT_TURN_STATE,
			files: {},
			lastUpdated: new Date().toISOString(),
		};
		if (!envelope.sessions) return envelope;
		const now = Date.now();
		const liveEntries = Object.entries(envelope.sessions).filter(
			([, partition]) => {
				const updated = Date.parse(partition.lastUpdated ?? "");
				return (
					Number.isFinite(updated) &&
					now - updated <= TURN_SESSION_PARTITION_TTL_MS
				);
			},
		);
		liveEntries.sort(
			([, left], [, right]) =>
				Date.parse(right.lastUpdated) - Date.parse(left.lastUpdated),
		);
		const sessions = Object.fromEntries(
			liveEntries.slice(0, MAX_TURN_SESSION_PARTITIONS),
		);
		if (
			Object.keys(sessions).length !== Object.keys(envelope.sessions).length
		) {
			const pruned = { ...envelope, sessions };
			writeFileAtomic(statePath, JSON.stringify(pruned, null, 2));
			return pruned;
		}
		return envelope;
	}

	/**
	 * Write turn state.
	 */
	writeTurnState(state: TurnState, cwd: string): void {
		const lensDir = getLensDir(cwd);
		fs.mkdirSync(lensDir, { recursive: true });

		const statePath = getTurnStatePath(cwd);
		state.lastUpdated = new Date().toISOString();
		writeFileAtomic(statePath, JSON.stringify(state, null, 2));
	}

	/** Return whether a writer may read/write this workspace worklist. */
	getTurnStateAccess(
		cwd: string,
		owner: Pick<TurnStateOwner, "kind" | "id"> & { sessionStartedAt?: number },
	): TurnStateAccess {
		const state = this.readTurnState(cwd);
		const hasFiles = Object.keys(state.files ?? {}).length > 0;
		if (!state.owner) {
			if (!state.sessionId || state.sessionId === owner.id) {
				// #2504: an OWNERLESS state was unconditionally "owned" here, and
				// ownerless was the resting shape (pre-#2504 `clearTurnState`
				// dropped the owner and `addModifiedRange` only stamps one when a
				// sessionId is supplied). A worklist persisted by a session that
				// has since exited was therefore adopted wholesale by the next
				// session — 154 historical paths reported as "modified this turn"
				// on a turn that made no tool calls at all. A worklist whose last
				// write predates this session's start is not this session's work.
				if (hasFiles && this.turnStatePredatesSession(state, owner)) {
					return "available";
				}
				return "owned";
			}
			// Pre-owner files have no liveness information. Preserve the existing
			// stale-session eviction behavior for this legacy shape.
			return "available";
		}
		if (state.owner.kind === owner.kind && state.owner.id === owner.id) {
			return "owned";
		}
		// #2504: an EMPTY worklist carries nothing to protect, so it never
		// latches a foreign writer out. This keeps the new `clearTurnState`
		// owner stamp from turning a cleared worklist into a cross-process lock:
		// an MCP writer in another process must still be able to register work
		// against a worklist a pi session just cleared, exactly as it could when
		// clearing left the state ownerless.
		if (!hasFiles) return "owned";
		return this.isTurnStateOwnerStale(state.owner)
			? "available"
			: "foreign-live";
	}

	/**
	 * #2504: true when this worklist was last written before the asking
	 * session began. `lastUpdated` is restamped by `writeTurnState` on EVERY
	 * write (add/clear/cycle), so a live session's own worklist is always
	 * newer than its start; only a carried-over file can be older. An
	 * unparseable stamp is treated as stale — a worklist we cannot date is
	 * exactly the legacy shape this gate exists to evict.
	 */
	private turnStatePredatesSession(
		state: TurnState,
		owner: { sessionStartedAt?: number },
	): boolean {
		const startedAt = owner.sessionStartedAt;
		if (startedAt === undefined || !Number.isFinite(startedAt)) return false;
		const lastUpdated = Date.parse(state.lastUpdated ?? "");
		if (!Number.isFinite(lastUpdated)) return true;
		return lastUpdated < startedAt;
	}

	private isTurnStateOwnerStale(owner: TurnStateOwner): boolean {
		if (owner.pid > 0 && owner.pid !== process.pid) {
			try {
				process.kill(owner.pid, 0);
				return false;
			} catch {
				return true;
			}
		}
		const lastSeen = Date.parse(owner.lastSeen);
		return (
			!Number.isFinite(lastSeen) || Date.now() - lastSeen > TURN_OWNER_STALE_MS
		);
	}

	/**
	 * Add or update a file's modified ranges in turn state.
	 * Merges overlapping ranges. `sessionId:null` deliberately preserves the
	 * current owner; callers must provide an explicit owner id to claim a stale
	 * worklist.
	 */
	addModifiedRange(
		filePath: string,
		range: ModifiedRange,
		importsChanged: boolean,
		cwd: string,
		sessionId?: string | null,
		ownerKind: TurnStateOwnerKind = "pi",
		projectRoot?: string,
		analysisRootMode?: AnalysisRootMode,
	): TurnState {
		if (
			analysisRootMode !== undefined &&
			analysisRootMode !== "session" &&
			analysisRootMode !== "linked-worktree"
		)
			return this.readTurnState(cwd);
		// #2504: the worklist is a PROJECT worklist. A path outside the project
		// was accepted and keyed by its absolute path, so a prior session's
		// scratchpad, `~/.claude/plans/*.md` and `~/.plegma/work/.../TASK.md`
		// all became "modified files" that turn_end then fed to the test runner
		// and opened in an LSP client. Reject before the owner stamp below, so
		// an out-of-project write cannot claim the worklist either.
		//
		// `projectRoot` defaults to `cwd` — true for every producer whose cwd
		// IS the session root. A caller whose `cwd` is NARROWER than the
		// project (an LSP call issued from a sub-package directory) passes the
		// real root explicitly; `cwd` still selects which `turn-state.json`
		// the entry lands in, exactly as before (#2504 review round 2, F1).
		const containmentRoot = projectRoot ?? cwd;
		if (!this.isTurnStatePathWithinRoot(filePath, containmentRoot)) {
			this.log(
				`turn-state: rejected out-of-project path ${filePath} (project root ${containmentRoot})`,
			);
			return this.readTurnState(cwd);
		}
		const partition = this.resolveTurnStatePartition(
			cwd,
			sessionId !== null ? sessionId : undefined,
		);
		const useSessionPartition =
			partition.isSecondary && ownerKind === "pi" && sessionId != null;
		const state = useSessionPartition ? partition.state : partition.envelope;
		if (sessionId) {
			const owner: TurnStateOwner = {
				kind: ownerKind,
				id: sessionId,
				pid: process.pid,
				lastSeen: new Date().toISOString(),
			};
			if (
				!useSessionPartition &&
				this.getTurnStateAccess(cwd, owner) === "foreign-live"
			)
				return state;
			state.sessionId = sessionId;
			state.owner = owner;
		}
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

		if (useSessionPartition) partition.persist(state);
		else this.writeTurnState(state, cwd);
		return state;
	}

	/**
	 * Clear turn state (after turn_end processes it).
	 */
	clearTurnState(
		cwd: string,
		owner: Pick<TurnStateOwner, "kind" | "id"> & { sessionStartedAt?: number },
		sessionId?: string,
	): boolean {
		const partition = this.resolveTurnStatePartition(cwd, sessionId);
		if (sessionId !== undefined && partition.isSecondary) {
			if (partition.envelope.sessions?.[sessionId]) partition.remove();
			return true;
		}
		const currentState = partition.envelope;
		const isCurrentOwner =
			this.getTurnStateAccess(cwd, owner) !== "foreign-live";
		if (!isCurrentOwner && process.pid !== currentState.owner?.pid)
			return false;
		// #2504: stamp the CLEARING owner. Dropping `owner`/`sessionId` here made
		// ownerless the resting shape of turn-state.json, which is what let the
		// next session read a carried-over worklist as its own. A cleared state
		// now says who cleared it and when, so `getTurnStateAccess` can judge it
		// by liveness like any other owned state — and, since the worklist is
		// empty, the stamp never latches another writer out (see the
		// empty-worklist branch there).
		const state: TurnState = {
			...DEFAULT_TURN_STATE,
			files: {}, // fresh object — DEFAULT_TURN_STATE.files can be polluted by addModifiedRange
			lastUpdated: new Date().toISOString(),
			sessionId: owner.id,
			owner: {
				kind: owner.kind,
				id: owner.id,
				pid: process.pid,
				lastSeen: new Date().toISOString(),
				sessionStartedAt: owner.sessionStartedAt,
			},
		};
		this.writeTurnState(state, cwd);
		return true;
	}

	/**
	 * Increment turn cycle counter.
	 */
	incrementTurnCycle(
		cwd: string,
		owner: Pick<TurnStateOwner, "kind" | "id">,
		sessionId?: string,
	): TurnState {
		const partition = this.resolveTurnStatePartition(cwd, sessionId);
		const state = partition.state;
		if (sessionId !== undefined && state.owner?.id !== sessionId) return state;
		const isCurrentOwner =
			this.getTurnStateAccess(cwd, owner) !== "foreign-live";
		if (!isCurrentOwner && process.pid !== state.owner?.pid) return state;
		state.turnCycles++;
		partition.persist(state);
		return state;
	}

	/**
	 * Check if max cycles exceeded.
	 */
	isMaxCyclesExceeded(cwd: string, sessionId?: string): boolean {
		const state = this.readTurnState(cwd, sessionId);
		return state.turnCycles >= state.maxCycles;
	}

	/**
	 * Get files that need jscpd re-scan (any edit).
	 * Only returns source code files jscpd can meaningfully analyse.
	 */
	getFilesForJscpd(cwd: string, sessionId?: string): string[] {
		const state = this.readTurnState(cwd, sessionId);
		return Object.keys(state.files).filter((f) =>
			/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|cs|php|cpp|c|h|hpp|swift|kt)$/.test(
				f,
			),
		);
	}

	/**
	 * Get files that need madge re-scan (imports changed).
	 */
	getFilesForMadge(cwd: string, sessionId?: string): string[] {
		const state = this.readTurnState(cwd, sessionId);
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
