/**
 * Shared, memoized workspace-topology snapshot service (#806).
 *
 * Several subsystems each performed their own independent per-directory
 * marker walk (`.pi-lens.json` discovery in `project-lens-config.ts`,
 * governing-tsconfig discovery in `review-graph/tsconfig-paths.ts`,
 * workspace-manifest presence checks in `review-graph/workspace-modules.ts`)
 * — each with its own probe pattern and its own (or no) invalidation. In a
 * large monorepo the same directory chain got re-walked and re-stat'ed by
 * several subsystems per edit.
 *
 * This module is the single seam: `getDirectoryMarkers(dir)` collects ALL
 * markers a directory can carry in ONE `readdir` pass (not N `existsSync`
 * probes), cached per directory and invalidated by the directory's own
 * mtime (the pattern `project-lens-config.ts`'s `inDirDiscoveryCache`
 * established for #804). `findNearestDirWithMarker` layers the shared
 * upward-walk discipline (`walkUpDirs` + `isAtOrAboveHomeDir` ceiling, an
 * explicit depth cap with cap-trip latency logging — no silent truncation)
 * on top of that per-directory cache.
 *
 * `resetWorkspaceTopology()` is wired into the session-reset path
 * (`runtime-session.ts`'s `handleSessionStart`) so a directory's markers
 * (and every consumer's own downstream cache layered on top) are re-read
 * fresh on the next session, without a full process restart.
 *
 * #807 (second wave): `language-profile.ts`'s `resolveLanguageRootForFile`
 * and `startup-scan.ts`'s `findNearestProjectRoot` route their per-directory
 * marker checks through this module too — `findNearestDirWithAnyBasename`
 * for the former (a home-guarded, depth-capped, walk-cached generalization of
 * `findNearestDirWithMarker` for marker lists that aren't typed
 * `DirectoryMarkers` fields), and a direct `getDirectoryMarkers(dir)`
 * `entryNames` read for the latter (walk loop kept hand-written and
 * NOT home-guarded — see that function's docstring for why). This module
 * still only indexes per-directory MARKER PRESENCE; it does not decide what
 * "the project root" is — that policy (which markers count, what wins when
 * several qualify, whether a found root gets clamped back to the workspace)
 * stays with each resolver.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	PROJECT_CONFIG_BASENAMES,
	isResolvedGlobalConfigPath,
} from "./config-locations.js";
import { FRESHNESS_CADENCE_MS } from "./freshness-cadence.js";
import { logLatency } from "./latency-logger.js";
import {
	isAtOrAboveHomeDir,
	nameMatchesMarkerGlob,
	walkUpDirs,
} from "./path-utils.js";

/** Depth cap on any upward marker walk — mirrors `findNearestMarkerRoot`'s bound. */
const MAX_WALK_DEPTH = 64;

/**
 * The project config basenames, canonical first — the SHARED table, not a
 * fourth copy of the pair (#2426 review round 2). `config-locations.ts` derives
 * it from the one location table the resolver walks, so a change there cannot
 * leave this marker index preferring a different file than the loaders do.
 */
const PI_LENS_CONFIG_BASENAMES = PROJECT_CONFIG_BASENAMES;

/**
 * Every marker pi-lens subsystems currently probe for, keyed by the basename
 * on disk. Add a new marker here (not a private probe elsewhere) when a
 * consumer needs another per-directory file presence check.
 */
export interface DirectoryMarkers {
	dir: string;
	/** mtime of the directory itself at scan time — the cache's invalidation key. */
	dirMtimeMs: number;
	/**
	 * Raw immediate-child entry names from this directory's single `readdir`
	 * pass (#807) — type-agnostic (file OR directory dirents), unlike the
	 * stat-confirmed `*Path` fields below. For callers doing a plain
	 * `existsSync`-style basename-presence check (e.g. `.git`, which is a
	 * directory for a normal clone but a file for a worktree, or a marker set
	 * that isn't one of the typed fields yet) — see `findNearestDirWithAnyBasename`.
	 * Not a substitute for the typed fields where the caller specifically
	 * needs "and it's a file" confirmed.
	 */
	entryNames: ReadonlySet<string>;
	/** Immediate-child file/symlink names, used for glob marker matching. */
	entryFileNames: ReadonlySet<string>;
	/** Resolved path of `.pi-lens.json`, preferred over the no-dot fallback. */
	piLensConfigPath: string | undefined;
	tsconfigPath: string | undefined;
	packageJsonPath: string | undefined;
	pnpmWorkspaceYamlPath: string | undefined;
	cargoTomlPath: string | undefined;
	goWorkPath: string | undefined;
	chartYamlPath: string | undefined;
}

interface DirCacheEntry {
	dirMtimeMs: number;
	markers: DirectoryMarkers;
	lastUsedAt: number;
	idleTimer?: ReturnType<typeof setTimeout>;
}

/** Per-directory marker cache — the shared seam every consumer reads through. */
const dirMarkerCache = new Map<string, DirCacheEntry>();

/** Downstream memo clears that must follow the topology index reset. */
const topologyDerivedCacheResets: Array<() => void> = [];

export function registerWorkspaceTopologyReset(reset: () => void): void {
	topologyDerivedCacheResets.push(reset);
}

/** Cache for upward marker-walk results, keyed by `${startDir}\0${markerKey}`. */
type WalkCacheEntry = {
	dir: string | undefined;
	dirMtimes: Array<{ dir: string; mtimeMs: number }>;
	walkedAtMs: number;
	lastUsedAt: number;
	idleTimer?: ReturnType<typeof setTimeout>;
};
const walkCache = new Map<string, WalkCacheEntry>();
const TOPOLOGY_MAX_DIR_ENTRIES = 256;
const TOPOLOGY_MAX_WALK_ENTRIES = 512;
const TOPOLOGY_IDLE_EVICT_MS_DEFAULT = 20 * 60_000;

function topologyIdleEvictMs(): number {
	const value = Number.parseInt(
		process.env.PI_LENS_WORKSPACE_TOPOLOGY_IDLE_EVICT_MS ?? "",
		10,
	);
	return Number.isSafeInteger(value) && value > 0
		? value
		: TOPOLOGY_IDLE_EVICT_MS_DEFAULT;
}

function deleteDirMarker(key: string): void {
	const entry = dirMarkerCache.get(key);
	if (entry?.idleTimer) clearTimeout(entry.idleTimer);
	dirMarkerCache.delete(key);
}

function deleteWalk(key: string): void {
	const entry = walkCache.get(key);
	if (entry?.idleTimer) clearTimeout(entry.idleTimer);
	walkCache.delete(key);
}

function touchDirMarker(key: string, entry: DirCacheEntry): void {
	entry.lastUsedAt = Date.now();
	if (entry.idleTimer) clearTimeout(entry.idleTimer);
	const stamp = entry.lastUsedAt;
	entry.idleTimer = setTimeout(() => {
		if (dirMarkerCache.get(key) === entry && entry.lastUsedAt === stamp)
			deleteDirMarker(key);
	}, topologyIdleEvictMs());
	entry.idleTimer.unref?.();
}

function touchWalk(key: string, entry: WalkCacheEntry): void {
	entry.lastUsedAt = Date.now();
	if (entry.idleTimer) clearTimeout(entry.idleTimer);
	const stamp = entry.lastUsedAt;
	entry.idleTimer = setTimeout(() => {
		if (walkCache.get(key) === entry && entry.lastUsedAt === stamp)
			deleteWalk(key);
	}, topologyIdleEvictMs());
	entry.idleTimer.unref?.();
}

export function resetWorkspaceTopology(): void {
	for (const key of dirMarkerCache.keys()) deleteDirMarker(key);
	for (const key of walkCache.keys()) deleteWalk(key);
	for (const reset of topologyDerivedCacheResets) reset();
}

/**
 * Release cache eviction handles without discarding reusable entries.
 * One-shot cascades call this after marker discovery so cache residency does
 * not leave a process-liveness tail; the next cache use re-arms its timer.
 */
export function releaseWorkspaceTopologyIdleTimers(): void {
	for (const entry of dirMarkerCache.values()) {
		if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
		entry.idleTimer = undefined;
	}
	for (const entry of walkCache.values()) {
		if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
		entry.idleTimer = undefined;
	}
}

function safeDirMtimeMs(dir: string): number {
	try {
		return fs.statSync(dir).mtimeMs;
	} catch {
		return -1;
	}
}

function safeIsFile(filePath: string): boolean {
	try {
		return fs.statSync(filePath).isFile();
	} catch {
		return false;
	}
}

/**
 * Single-pass marker scan for one directory: one `readdir` collects ALL
 * markers pi-lens subsystems care about, cached and invalidated by the
 * directory's own mtime (so an add/remove/rename inside `dir` — which bumps
 * the directory's mtime on every platform pi-lens supports — drops the
 * cached entry without a session restart).
 */
export function getDirectoryMarkers(dir: string): DirectoryMarkers {
	const resolvedDir = path.resolve(dir);
	const dirMtimeMs = safeDirMtimeMs(resolvedDir);
	const cached = dirMarkerCache.get(resolvedDir);
	if (cached && cached.dirMtimeMs === dirMtimeMs) {
		touchDirMarker(resolvedDir, cached);
		return cached.markers;
	}

	let entries: fs.Dirent[] = [];
	try {
		entries = fs.readdirSync(resolvedDir, { withFileTypes: true });
	} catch {
		entries = [];
	}
	// `readdir`'s Dirent type does not follow symlinks (lstat semantics), so a
	// symlinked marker file reports as neither file nor directory here. Track
	// candidate names that exist as *some* dirent and resolve the handful of
	// markers we actually care about with one confirming `stat` each — still
	// a single directory listing, not N blind `existsSync` probes.
	const present = new Set(entries.map((e) => e.name));
	const fileNames = new Set(
		entries
			.filter((entry) => entry.isFile() || entry.isSymbolicLink())
			.map((entry) => entry.name),
	);

	const resolveMarker = (basename: string): string | undefined => {
		if (!present.has(basename)) return undefined;
		const candidate = path.join(resolvedDir, basename);
		return safeIsFile(candidate) ? candidate : undefined;
	};

	const piLensConfigPath =
		resolveMarker(PI_LENS_CONFIG_BASENAMES[0]) ??
		resolveMarker(PI_LENS_CONFIG_BASENAMES[1]);

	const markers: DirectoryMarkers = {
		dir: resolvedDir,
		dirMtimeMs,
		entryNames: present,
		entryFileNames: fileNames,
		piLensConfigPath,
		tsconfigPath: resolveMarker("tsconfig.json"),
		packageJsonPath: resolveMarker("package.json"),
		pnpmWorkspaceYamlPath: resolveMarker("pnpm-workspace.yaml"),
		cargoTomlPath: resolveMarker("Cargo.toml"),
		goWorkPath: resolveMarker("go.work"),
		chartYamlPath: resolveMarker("Chart.yaml"),
	};
	const entry: DirCacheEntry = { dirMtimeMs, markers, lastUsedAt: Date.now() };
	const outgoing = dirMarkerCache.get(resolvedDir);
	if (outgoing?.idleTimer !== undefined) {
		clearTimeout(outgoing.idleTimer);
		outgoing.idleTimer = undefined;
	}
	dirMarkerCache.set(resolvedDir, entry);
	touchDirMarker(resolvedDir, entry);
	while (dirMarkerCache.size > TOPOLOGY_MAX_DIR_ENTRIES) {
		const victim = [...dirMarkerCache.entries()].sort(
			([, a], [, b]) => a.lastUsedAt - b.lastUsedAt,
		)[0];
		if (!victim) break;
		deleteDirMarker(victim[0]);
	}
	return markers;
}

function walkCacheKey(startDir: string, markerKey: string): string {
	return `${path.resolve(startDir)}\0${markerKey}`;
}

/**
 * One directory a cached marker walk probed, with the mtime it carried when the
 * walk ran. Hits compare every record; cached misses compare the start-directory
 * record and the shared freshness cadence.
 */
export type DirMtimeRecord = { dir: string; mtimeMs: number };

export function dirMtimesStillFresh(
	dirMtimes: readonly DirMtimeRecord[],
): boolean {
	return dirMtimes.every(({ dir, mtimeMs }) => safeDirMtimeMs(dir) === mtimeMs);
}

/**
 * Async arm of `dirMtimesStillFresh` — same records, same comparison, stats
 * issued in parallel. It exists for the async marker walk in
 * `clients/lsp/server.ts`'s `NearestRoot`, whose own marker probes are
 * `fs/promises` and which runs on the per-file LSP touch path: a `statSync` per
 * directory there would block the event loop the walk deliberately keeps free.
 * Both arms live here so "is this recorded walk still current" has one owner
 * (#3412).
 *
 * Written with promise combinators rather than `await`, along with the two
 * readers below, so the ONLY place that waits on these stats is the caller's
 * `await bounded(...)` — a hook-path await that a later editor cannot leave
 * unbounded, instead of an inner await bounded only by a registry admission
 * (#3412 review round 1, M-3421-02).
 */
export function dirMtimesStillFreshAsync(
	dirMtimes: readonly DirMtimeRecord[],
): Promise<boolean> {
	return Promise.all(dirMtimes.map(({ dir }) => dirMtimeMsAsync(dir))).then(
		(current) =>
			dirMtimes.every(({ mtimeMs }, index) => current[index] === mtimeMs),
	);
}

/**
 * Current mtime of `dir`, or `-1` when it cannot be stat'ed — the async arm of
 * `safeDirMtimeMs`. A recorder and `dirMtimesStillFreshAsync` MUST read through
 * the same function so the absent-directory sentinel is the same value on both
 * sides: `prisma/` not existing yet is a recordable state, and the record must
 * compare unequal once it is created (#3412).
 */
function dirMtimeMsAsync(dir: string): Promise<number> {
	return fs.promises.stat(dir).then(
		(stats) => stats.mtimeMs,
		() => -1,
	);
}

/** One freshness record per directory, read in parallel (#3412). */
export function dirMtimeRecordsAsync(
	dirs: readonly string[],
): Promise<DirMtimeRecord[]> {
	return Promise.all(
		dirs.map((dir) =>
			dirMtimeMsAsync(dir).then((mtimeMs) => ({ dir, mtimeMs })),
		),
	);
}

/**
 * Records for directories whose mtime could NOT be read — because the caller's
 * bound fired, so the answer is unknown rather than absent. `NaN` compares
 * unequal to every mtime including itself, so an entry carrying one of these
 * can never be served: the walk's answer is still returned, it is simply not
 * memoized. Unknown must never be spelled as a number a directory could
 * actually have, and dropping the directory from the signature (recording
 * nothing) would hide every later change in it (#3412 review round 1, S9).
 */
export function unknownDirMtimeRecords(
	dirs: readonly string[],
): DirMtimeRecord[] {
	return dirs.map((dir) => ({ dir, mtimeMs: Number.NaN }));
}

/**
 * Shared core of the two nearest-marker walkers below: the cache check, the
 * home-guarded/depth-capped upward loop, per-directory mtime recording, and
 * the cache store live HERE once — callers supply only their cache-key
 * suffix, their match predicate over a directory's marker index, and the
 * identifying metadata for the cap-trip latency log. (Extracted for #812's
 * Sonar new-code duplication gate: the two walkers previously each carried
 * this skeleton verbatim.)
 */
function walkToNearestMatch(
	startDir: string,
	cacheSuffix: string,
	matches: (markers: DirectoryMarkers) => boolean,
	capMetadata: Record<string, unknown>,
	homeDir: string,
): string | undefined {
	const key = walkCacheKey(startDir, cacheSuffix);
	const cached = walkCache.get(key);
	if (cached) {
		const startDirMtime = cached.dirMtimes[0];
		const isFresh =
			cached.dir === undefined
				? startDirMtime !== undefined &&
					Date.now() - cached.walkedAtMs < FRESHNESS_CADENCE_MS &&
					safeDirMtimeMs(startDirMtime.dir) === startDirMtime.mtimeMs
				: dirMtimesStillFresh(cached.dirMtimes);
		if (isFresh) {
			touchWalk(key, cached);
			return cached.dir;
		}
	}

	const dirMtimes: Array<{ dir: string; mtimeMs: number }> = [];
	let found: string | undefined;
	let depth = 0;
	for (const dir of walkUpDirs(startDir)) {
		if (isAtOrAboveHomeDir(dir, homeDir)) break;
		if (depth >= MAX_WALK_DEPTH) {
			logLatency({
				type: "phase",
				filePath: startDir,
				phase: "workspace-topology-walk-cap",
				durationMs: 0,
				metadata: { ...capMetadata, depth, homeDir },
			});
			break;
		}
		const markers = getDirectoryMarkers(dir);
		dirMtimes.push({ dir, mtimeMs: markers.dirMtimeMs });
		if (matches(markers)) {
			found = dir;
			break;
		}
		depth += 1;
	}

	const walkedAtMs = Date.now();
	const entry: WalkCacheEntry = {
		dir: found,
		dirMtimes,
		walkedAtMs,
		lastUsedAt: walkedAtMs,
	};
	const outgoing = walkCache.get(key);
	if (outgoing?.idleTimer !== undefined) {
		clearTimeout(outgoing.idleTimer);
		outgoing.idleTimer = undefined;
	}
	walkCache.set(key, entry);
	touchWalk(key, entry);
	while (walkCache.size > TOPOLOGY_MAX_WALK_ENTRIES) {
		const victim = [...walkCache.entries()].sort(
			([, a], [, b]) => a.lastUsedAt - b.lastUsedAt,
		)[0];
		if (!victim) break;
		deleteWalk(victim[0]);
	}
	return found;
}

/**
 * Walk up from `startDir` looking for the nearest directory whose marker
 * index has `markerKey` set (e.g. `"tsconfigPath"`, `"piLensConfigPath"`).
 * Shared walk discipline (AGENTS.md invariants):
 *   - Uses `walkUpDirs`, the single upward-climb primitive.
 *   - Never resolves at or above `$HOME` via `isAtOrAboveHomeDir`.
 *   - Depth-capped at `MAX_WALK_DEPTH`; a cap trip is logged as a latency
 *     phase (not silently truncated) so a pathological deep tree is visible.
 *
 * Cached per `(startDir, markerKey)`. Hits are invalidated when any visited
 * directory's mtime changes. Misses are revalidated against `startDir`'s mtime
 * and the shared freshness cadence, so ancestor marker changes are eventually
 * found without unrelated ancestor churn forcing a re-walk.
 */
export function findNearestDirWithMarker(
	startDir: string,
	markerKey: keyof Omit<
		DirectoryMarkers,
		"dir" | "dirMtimeMs" | "entryNames" | "entryFileNames"
	>,
	homeDir: string = os.homedir(),
): string | undefined {
	return walkToNearestMatch(
		startDir,
		markerKey,
		(markers) => Boolean(markers[markerKey]),
		{ markerKey },
		homeDir,
	);
}

/**
 * Type-agnostic (file OR directory) `existsSync`-style presence check for
 * `basename` inside the directory `markers` describes. Single-segment names
 * (the common case) resolve against the shared per-directory `entryNames`
 * set — no extra `stat`. A multi-segment name (e.g. `"prisma/schema.prisma"`,
 * a nested path some `resolveLanguageRootForFile` marker lists use) falls
 * back to one confirming `existsSync` — the directory's own readdir doesn't
 * cover a grandchild, so this still costs one syscall for that shape, same
 * as the pre-#807 hand-rolled loops it replaces.
 */
function hasBasenameMarker(
	markers: DirectoryMarkers,
	basename: string,
): boolean {
	if (basename.includes("/") || basename.includes("\\")) {
		return fs.existsSync(path.join(markers.dir, basename));
	}
	if (basename.includes("*")) {
		// `entryFileNames` is already files/symlinks-only, so matching the cached
		// names via the shared marker-glob helper preserves the same semantics as
		// the Dirent-filtering probes without re-reading the directory.
		return [...markers.entryFileNames].some((entryName) =>
			nameMatchesMarkerGlob(entryName, basename),
		);
	}
	return markers.entryNames.has(basename);
}

/**
 * Walk up from `startDir` looking for the nearest directory containing ANY of
 * `basenames` (`existsSync`-style, type-agnostic presence — see
 * `hasBasenameMarker`). The generalized counterpart of
 * `findNearestDirWithMarker` for callers whose marker set is a per-call list
 * rather than one of `DirectoryMarkers`' typed fields (#807) — e.g.
 * `resolveLanguageRootForFile`'s per-language-kind root-marker lists. Shares
 * the exact same walk discipline (`walkUpDirs`, `isAtOrAboveHomeDir` ceiling,
 * `MAX_WALK_DEPTH` cap with the same cap-trip latency log) and is backed by
 * the same per-directory `getDirectoryMarkers` cache, so a directory chain
 * already visited for one marker set isn't re-`readdir`'d for another.
 *
 * Cached per `(startDir, basenames)`, invalidated the same way as
 * `findNearestDirWithMarker`.
 */
export function findNearestDirWithAnyBasename(
	startDir: string,
	basenames: readonly string[],
	homeDir: string = os.homedir(),
): string | undefined {
	if (basenames.length === 0) return undefined;
	return walkToNearestMatch(
		startDir,
		`any:${basenames.join(String.fromCodePoint(1))}`,
		(markers) =>
			basenames.some((basename) => hasBasenameMarker(markers, basename)),
		{ basenames },
		homeDir,
	);
}

export interface PiLensConfigMarker {
	path: string;
	dir: string;
	mtimeMs: number;
	/**
	 * Byte size of the config file at stat time (#1105). The config caches gate
	 * reuse on this alongside `mtimeMs` — the free second axis of the review-graph
	 * `size:mtimeMs` signature — so an in-place edit that PRESERVES mtime (git
	 * checkout timestamp restoration, a same-second rewrite) but changes length no
	 * longer replays a stale parsed config. The stat that yields `mtimeMs` already
	 * reads `size`, so carrying it costs nothing.
	 */
	size: number;
}

/**
 * `.pi-lens.json`/`pi-lens.json` directly IN `dir` — no upward walk. The
 * shared-index equivalent of `project-lens-config.ts`'s old private
 * `findPiLensConfigInDir` probe loop.
 *
 * A candidate that IS the resolved global config path is refused
 * (global-config-location PR, refs #2457): the global tier reads that file by
 * absolute path, and discovering it here a second time made the nested ignore
 * layering full-validate it and warn that its global-only keys are "not
 * honored in a project config" — including the notice advising the user to
 * set them in the very file being ignored. The refusal is observable through
 * the marker staying absent, the same shape as a directory with no marker.
 */
export function findPiLensConfigMarkerInDir(
	dir: string,
): PiLensConfigMarker | undefined {
	const markers = getDirectoryMarkers(dir);
	if (!markers.piLensConfigPath) return undefined;
	if (isResolvedGlobalConfigPath(markers.piLensConfigPath)) return undefined;
	const stat = (() => {
		try {
			return fs.statSync(markers.piLensConfigPath!);
		} catch {
			return undefined;
		}
	})();
	if (!stat?.isFile()) return undefined;
	return {
		path: markers.piLensConfigPath,
		dir: markers.dir,
		mtimeMs: stat.mtimeMs,
		size: stat.size,
	};
}

/**
 * Nearest directory (at or above `startDir`, home-guarded) that carries a
 * `tsconfig.json` marker. The shared-index equivalent of
 * `review-graph/tsconfig-paths.ts`'s old `findNearestContaining(key,
 * ["tsconfig.json"])` call.
 */
export function findGoverningTsconfigDir(
	startDir: string,
	homeDir: string = os.homedir(),
): string | undefined {
	return findNearestDirWithMarker(startDir, "tsconfigPath", homeDir);
}

export interface WorkspaceManifestMarkers {
	hasPnpmWorkspaceYaml: boolean;
	hasGoWork: boolean;
	hasCargoToml: boolean;
	hasPackageJson: boolean;
}

/**
 * Presence-only workspace manifest markers for `dir` — the shared-index
 * equivalent of `workspace-modules.ts`'s old `detectWorkspaceType` probe
 * (`pnpm-workspace.yaml` / `go.work` / `Cargo.toml` / `package.json`
 * `existsSync` calls). Callers still read + parse the manifest CONTENT
 * themselves (workspace globs, `[workspace]` section, `workspaces` field) —
 * this only answers "is the marker file present".
 */
export function getWorkspaceManifestMarkers(
	dir: string,
): WorkspaceManifestMarkers {
	const markers = getDirectoryMarkers(dir);
	return {
		hasPnpmWorkspaceYaml: markers.pnpmWorkspaceYamlPath !== undefined,
		hasGoWork: markers.goWorkPath !== undefined,
		hasCargoToml: markers.cargoTomlPath !== undefined,
		hasPackageJson: markers.packageJsonPath !== undefined,
	};
}
