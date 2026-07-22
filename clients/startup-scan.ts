/**
 * Startup scan safety — gates eager cache warmups to real project roots.
 *
 * Prevents pi-lens from scanning $HOME or generic directories at session
 * start, which would hang or produce meaningless results.
 *
 * Credit: alexx-ftw (PR #1)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { lazyEnvNumber } from "./env-utils.js";
import {
	getProjectIgnoreMatcher,
	type ProjectIgnoreMatcher,
} from "./file-utils.js";
import { isAtOrAboveHomeDir } from "./path-utils.js";
import {
	shouldRecurseIntoDir,
	walkTreeStackAsync,
	walkTreeStackSync,
	type WalkVisitor,
} from "./source-walker.js";

export const PROJECT_ROOT_MARKERS = [
	".git",
	"package.json",
	"pyproject.toml",
	"Cargo.toml",
	"go.mod",
	"composer.json",
];

export const MAX_STARTUP_SOURCE_FILES = 2000;

// #758: hard ceiling on the number of directory entries the startup source
// count walk will visit before it gives up and declares the tree too big to
// warm. The source-file early-exit (MAX_STARTUP_SOURCE_FILES) only fires when
// a project has MANY source files — a repo with FEW source files but a huge
// pile of non-source files (e.g. a game mod: 300 scripts among 84k data files)
// never trips it, so the pre-#758 walk traversed the entire tree, dominated by
// one ignoreMatcher.isIgnored() call per entry, blocking session_start for
// seconds. Capping total entries bounds that worst case deterministically. The
// same pattern already guards jscpd-client.ts's hasSourceFilesRecursive walk.
export const MAX_STARTUP_SCAN_ENTRIES = 50_000;

const SOURCE_FILE_PATTERN = /\.(ts|tsx|js|jsx|py|go|rs|rb)$/;

export interface StartupScanContext {
	cwd: string;
	scanRoot: string;
	projectRoot: string | null;
	canWarmCaches: boolean;
	reason?:
		| "home-dir"
		| "no-project-root"
		| "too-many-source-files"
		| "too-many-entries";
	sourceFileCount?: number;
	/**
	 * Wall-clock time (`Date.now()`) this verdict was computed. Stamped by
	 * `resolveStartupScanContext`/`Async` right before it's cached, and carried
	 * through when the verdict is persisted to `project-snapshot.json`'s
	 * `startupScan` field (#699) so a later process can decide whether a
	 * persisted `too-many-source-files` verdict is still fresh enough to skip
	 * the walk — see `isStartupScanVerdictFresh`.
	 */
	computedAt?: number;
}

export interface StartupScanOptions {
	homeDir?: string;
	maxSourceFiles?: number;
	/**
	 * Entry-budget ceiling for the source-count walk (#758). Defaults to
	 * `getStartupScanMaxEntries()`. Exposed mainly so tests can drive the
	 * `too-many-entries` verdict deterministically with a tiny fixture.
	 */
	maxScanEntries?: number;
}

// Default TTL for a persisted `too-many-source-files` verdict (#699): 24h.
const DEFAULT_STARTUP_SCAN_VERDICT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How long a persisted `too-many-source-files` verdict stays reusable before
 * a session re-walks the tree to refresh it (#699).
 *
 * Resolution order: `PI_LENS_STARTUP_SCAN_VERDICT_TTL_MS` env var, else the
 * 24h default. Lazy + memoized (via `lazyEnvNumber`, #763) so importing this
 * module never touches `process.env` at load time (house style — see
 * `runtime-config.ts` / `slow-fs.ts` / `subagent-mode.ts`).
 */
const _ttl = lazyEnvNumber(
	"PI_LENS_STARTUP_SCAN_VERDICT_TTL_MS",
	DEFAULT_STARTUP_SCAN_VERDICT_TTL_MS,
);
export const getStartupScanVerdictTtlMs = _ttl.get;

/** Test-only: clears the memoized TTL so a subsequent call re-reads the env
 * var (matching the `_resetForTests` convention). */
export const _resetStartupScanVerdictTtlForTests = _ttl._resetForTests;

/**
 * Total directory-entry ceiling for the startup source-count walk (#758).
 *
 * Resolution order: `PI_LENS_STARTUP_SCAN_MAX_ENTRIES` env var, else the
 * `MAX_STARTUP_SCAN_ENTRIES` default. Lazy + memoized (via `lazyEnvNumber`,
 * #763) so importing this module never touches `process.env` at load time
 * (same house style as `getStartupScanVerdictTtlMs`).
 */
const _maxEntries = lazyEnvNumber(
	"PI_LENS_STARTUP_SCAN_MAX_ENTRIES",
	MAX_STARTUP_SCAN_ENTRIES,
);
export const getStartupScanMaxEntries = _maxEntries.get;

/** Test-only: clears the memoized entry cap so a subsequent call re-reads the
 * env var (matching the `_resetForTests` convention). */
export const _resetStartupScanMaxEntriesForTests = _maxEntries._resetForTests;

/**
 * Whether a persisted startup-scan verdict is still safe to reuse without
 * re-walking the project tree (#699).
 *
 * The content-derived reasons `too-many-source-files` and `too-many-entries`
 * (#758) are the ones that are TTL'd. They can go stale on their own: the repo
 * can shrink below `MAX_STARTUP_SOURCE_FILES` (or below the entry ceiling)
 * between sessions, and nothing else would notice
 * — the seq-based freshness check that guards every other
 * `project-snapshot.json` field never fires for them, because pi-lens never
 * writes anything while `canWarmCaches` is false, so the snapshot's seq
 * never advances on its own. Trade-off, by design: a shrunk repo recovers
 * automatically once the TTL expires and the next session re-walks, in
 * exchange for skipping a walk that (per #699) can cost 17s+ on a large
 * monorepo, on every single process start, for a result nothing could use.
 *
 * `home-dir` / `no-project-root` describe the resolved root's location
 * relative to $HOME, not its contents, so they don't drift the same way —
 * reused indefinitely here (still gated by the snapshot's own seq-freshness
 * check upstream). `canWarmCaches: true` verdicts aren't TTL'd by this
 * function either; a fresh snapshot's `seq` match already implies the
 * project state hasn't moved since it warmed successfully.
 *
 * Fails closed on a verdict with no `computedAt` (e.g. hand-written test
 * fixture, or a pre-#699 snapshot) — treated as stale so it gets refreshed
 * rather than trusted indefinitely.
 */
export function isStartupScanVerdictFresh(
	verdict: StartupScanContext,
	now: number = Date.now(),
): boolean {
	if (
		verdict.reason !== "too-many-source-files" &&
		verdict.reason !== "too-many-entries"
	)
		return true;
	if (typeof verdict.computedAt !== "number") return false;
	return now - verdict.computedAt < getStartupScanVerdictTtlMs();
}

export function findNearestProjectRoot(startDir: string): string | null {
	let current = path.resolve(startDir);
	while (true) {
		if (
			PROJECT_ROOT_MARKERS.some((marker) =>
				fs.existsSync(path.join(current, marker)),
			)
		) {
			return current;
		}
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

export interface SourceCountResult {
	/** Source files found (capped at `limit + 1` once the early-exit fires). */
	count: number;
	/**
	 * True when the walk stopped because it hit `maxEntries` before either
	 * finishing the tree or crossing the source-file limit — i.e. the tree is
	 * large and dominated by non-source files (#758). Callers treat this as
	 * "too big to warm" rather than trusting the partial `count`.
	 */
	entryBudgetExceeded: boolean;
}

/** Mutable per-walk tallies threaded through the shared count visitor below. */
interface SourceCountState {
	count: number;
	visited: number;
	entryBudgetExceeded: boolean;
}

/**
 * Per-entry step of the source-count walk (#761), plugged into both the sync
 * and async {@link walkTreeStackSync}/`Async` drivers, which differ only in
 * yield cadence. Applies both bounds in their historical order:
 *   - `limit`: source-file early-exit (existing behavior) — fires as soon as
 *     more than `limit` source files are seen.
 *   - `maxEntries`: total directory-entry ceiling (#758) — fires as soon as
 *     `maxEntries` entries have been visited (`visited >= maxEntries`, checked
 *     AFTER classification), flagging `entryBudgetExceeded` so a mixed
 *     source/non-source tree can't drag the walk across the whole tree.
 * The source-limit check precedes the entry-budget check, so an entry that
 * trips both stops as a source-limit hit (`entryBudgetExceeded` stays false).
 *
 * Directories here never check for symlinks or generated-artifact names —
 * always follows symlinks (unlike source-filter.ts's collectSourceFiles*).
 */
function makeSourceCountVisitor(
	state: SourceCountState,
	ignoreMatcher: ProjectIgnoreMatcher,
	limit: number,
	maxEntries: number,
): WalkVisitor {
	return (entry, fullPath) => {
		state.visited += 1;
		if (entry.isDirectory()) {
			const recurse = shouldRecurseIntoDir(entry, fullPath, {
				ignoreMatcher,
				followSymlinks: true,
			});
			if (state.visited >= maxEntries) {
				state.entryBudgetExceeded = true;
				return "stop";
			}
			return recurse ? "recurse" : "skip";
		}
		if (
			entry.isFile() &&
			!ignoreMatcher.isIgnored(fullPath, false) &&
			SOURCE_FILE_PATTERN.test(entry.name)
		) {
			state.count += 1;
			if (state.count > limit) return "stop";
		}
		if (state.visited >= maxEntries) {
			state.entryBudgetExceeded = true;
			return "stop";
		}
		return "skip";
	};
}

/**
 * Core synchronous source-count walk shared by the public
 * `countSourceFilesWithinLimit` wrapper and `computeStartupScanContext`.
 * Bounds are documented on `makeSourceCountVisitor`.
 */
function walkSourceCount(
	dir: string,
	limit: number,
	maxEntries: number,
): SourceCountResult {
	const state: SourceCountState = { count: 0, visited: 0, entryBudgetExceeded: false };
	const rootDir = path.resolve(dir);
	const ignoreMatcher = getProjectIgnoreMatcher(rootDir);
	walkTreeStackSync(
		rootDir,
		makeSourceCountVisitor(state, ignoreMatcher, limit, maxEntries),
	);
	return { count: state.count, entryBudgetExceeded: state.entryBudgetExceeded };
}

export function countSourceFilesWithinLimit(
	dir: string,
	limit: number,
): number {
	// Public wrapper keeps its pre-#758 contract: only the source-file limit
	// bounds it (no entry ceiling). The #758 entry budget applies solely to the
	// startup-scan verdict path via `walkSourceCount`.
	return walkSourceCount(dir, limit, Number.POSITIVE_INFINITY).count;
}

// Process-lifetime memo for the (cwd, homeDir, maxSourceFiles) tuple. The
// underlying computation walks the entire project root counting source
// files and is dominated by ignoreMatcher.isIgnored() calls; on a 2k-file
// project it costs ~2-3s the first time. Every `session_start` invocation
// (boot, /new, --print) recomputes this otherwise. Since the answer
// depends only on the file tree shape and ignore rules — both of which
// are also captured by the project snapshot freshness check upstream —
// in-process memoisation is safe for the duration of a single pi process.
const startupScanContextCache = new Map<string, StartupScanContext>();

export function resolveStartupScanContext(
	cwd: string,
	options: StartupScanOptions = {},
): StartupScanContext {
	const cacheKey =
		path.resolve(cwd) +
		"|" +
		(options.homeDir ?? "") +
		"|" +
		(options.maxSourceFiles ?? "") +
		"|" +
		(options.maxScanEntries ?? "");
	const cached = startupScanContextCache.get(cacheKey);
	if (cached) return cached;
	const result = { ...computeStartupScanContext(cwd, options), computedAt: Date.now() };
	startupScanContextCache.set(cacheKey, result);
	return result;
}

function computeStartupScanContext(
	cwd: string,
	options: StartupScanOptions = {},
): StartupScanContext {
	const resolvedCwd = path.resolve(cwd);
	const homeDir = path.resolve(options.homeDir ?? os.homedir());
	const maxSourceFiles = options.maxSourceFiles ?? MAX_STARTUP_SOURCE_FILES;
	const maxScanEntries = options.maxScanEntries ?? getStartupScanMaxEntries();
	const projectRoot = findNearestProjectRoot(resolvedCwd);

	if (!projectRoot) {
		return {
			cwd: resolvedCwd,
			scanRoot: resolvedCwd,
			projectRoot: null,
			canWarmCaches: false,
			reason: isAtOrAboveHomeDir(resolvedCwd, homeDir)
				? "home-dir"
				: "no-project-root",
		};
	}

	// A marker resolved at $HOME — OR at an ancestor of it (e.g. /home,
	// C:\Users) — means the upward search escaped the workspace; warming caches
	// would walk an unrelated tree (#250/#253). The old exact `=== homeDir`
	// check missed the above-home case.
	if (isAtOrAboveHomeDir(projectRoot, homeDir)) {
		return {
			cwd: resolvedCwd,
			scanRoot: projectRoot,
			projectRoot,
			canWarmCaches: false,
			reason: "home-dir",
		};
	}

	const { count: sourceFileCount, entryBudgetExceeded } = walkSourceCount(
		projectRoot,
		maxSourceFiles,
		maxScanEntries,
	);
	if (sourceFileCount > maxSourceFiles || entryBudgetExceeded) {
		return {
			cwd: resolvedCwd,
			scanRoot: projectRoot,
			projectRoot,
			canWarmCaches: false,
			reason: entryBudgetExceeded
				? "too-many-entries"
				: "too-many-source-files",
			sourceFileCount,
		};
	}

	return {
		cwd: resolvedCwd,
		scanRoot: projectRoot,
		projectRoot,
		canWarmCaches: true,
		sourceFileCount,
	};
}

// ---------------------------------------------------------------------------
// Async, chunked-yield counterparts used by the cold-start warmup pipeline
// (see runtime-session.ts handleSessionStart). The synchronous variants above
// block the Node event loop for the full duration of the project walk, which
// is fine when called from a non-interactive code path but freezes the TUI
// when called during `session_start`. These async variants do the same work
// but yield control via `await new Promise(setImmediate)` every N directory
// entries, so stdin handlers (i.e. keystrokes) stay responsive.
//
// They share the same memo (`startupScanContextCache`) as their sync siblings,
// so whichever runs first warms the cache for the other. By design the
// warmup pipeline runs the async version 2s after a cold-start "quick" return,
// then the user's first /new sees a sync-path cache hit and skips the work
// entirely.
// ---------------------------------------------------------------------------

/**
 * Async core of the source-count walk (the yield-cadence twin of
 * `walkSourceCount`). Same visitor and two bounds — `limit` (source files) and
 * `maxEntries` (total entries, #758) — driven through the shared
 * {@link walkTreeStackAsync} engine (#761), which yields via `setImmediate`
 * every `yieldEvery` entries to keep `session_start` keystrokes responsive.
 */
async function walkSourceCountAsync(
	dir: string,
	limit: number,
	maxEntries: number,
	opts: { yieldEvery?: number } = {},
): Promise<SourceCountResult> {
	const state: SourceCountState = { count: 0, visited: 0, entryBudgetExceeded: false };
	const rootDir = path.resolve(dir);
	const ignoreMatcher = getProjectIgnoreMatcher(rootDir);
	await walkTreeStackAsync(
		rootDir,
		makeSourceCountVisitor(state, ignoreMatcher, limit, maxEntries),
		{
			// Yield every 100 entries by default. Empirically each yield costs
			// ~0.1ms of overhead and a 2k-file project produces ~20 yields, so the
			// total async overhead is well under 5ms while keeping per-burst sync
			// work under 50ms (the perceptual threshold for "instant" keystrokes).
			yieldEvery: opts.yieldEvery ?? 100,
			// #703: prime the tracked-files set ONCE before the walk (not per file)
			// so a tracked file matching a `.gitignore`/global pattern isn't dropped
			// from the startup source-file count. Fail-open: resolves even when git
			// is absent, and `isIgnored` degrades to pattern-only if this never
			// resolves before a caller inspects results.
			beforeWalk: () => ignoreMatcher.ensureTrackedIndex(),
		},
	);
	return { count: state.count, entryBudgetExceeded: state.entryBudgetExceeded };
}

export async function countSourceFilesWithinLimitAsync(
	dir: string,
	limit: number,
	opts: { yieldEvery?: number } = {},
): Promise<number> {
	// Public wrapper keeps its pre-#758 contract: only the source-file limit
	// bounds it (no entry ceiling).
	return (
		await walkSourceCountAsync(dir, limit, Number.POSITIVE_INFINITY, opts)
	).count;
}

export async function resolveStartupScanContextAsync(
	cwd: string,
	options: StartupScanOptions = {},
): Promise<StartupScanContext> {
	const cacheKey =
		path.resolve(cwd) +
		"|" +
		(options.homeDir ?? "") +
		"|" +
		(options.maxSourceFiles ?? "") +
		"|" +
		(options.maxScanEntries ?? "");
	const cached = startupScanContextCache.get(cacheKey);
	if (cached) return cached;

	const resolvedCwd = path.resolve(cwd);
	const homeDir = path.resolve(options.homeDir ?? os.homedir());
	const maxSourceFiles = options.maxSourceFiles ?? MAX_STARTUP_SOURCE_FILES;
	const maxScanEntries = options.maxScanEntries ?? getStartupScanMaxEntries();
	const projectRoot = findNearestProjectRoot(resolvedCwd);

	let result: StartupScanContext;
	if (!projectRoot) {
		result = {
			cwd: resolvedCwd,
			scanRoot: resolvedCwd,
			projectRoot: null,
			canWarmCaches: false,
			reason: isAtOrAboveHomeDir(resolvedCwd, homeDir)
				? "home-dir"
				: "no-project-root",
		};
	} else if (isAtOrAboveHomeDir(projectRoot, homeDir)) {
		result = {
			cwd: resolvedCwd,
			scanRoot: projectRoot,
			projectRoot,
			canWarmCaches: false,
			reason: "home-dir",
		};
	} else {
		const { count: sourceFileCount, entryBudgetExceeded } =
			await walkSourceCountAsync(projectRoot, maxSourceFiles, maxScanEntries);
		if (sourceFileCount > maxSourceFiles || entryBudgetExceeded) {
			result = {
				cwd: resolvedCwd,
				scanRoot: projectRoot,
				projectRoot,
				canWarmCaches: false,
				reason: entryBudgetExceeded
					? "too-many-entries"
					: "too-many-source-files",
				sourceFileCount,
			};
		} else {
			result = {
				cwd: resolvedCwd,
				scanRoot: projectRoot,
				projectRoot,
				canWarmCaches: true,
				sourceFileCount,
			};
		}
	}
	result = { ...result, computedAt: Date.now() };
	startupScanContextCache.set(cacheKey, result);
	return result;
}
