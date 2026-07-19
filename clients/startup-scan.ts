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
import { toPositiveFinite } from "./env-utils.js";
import {
	getProjectIgnoreMatcher,
	type ProjectIgnoreMatcher,
} from "./file-utils.js";
import { isAtOrAboveHomeDir } from "./path-utils.js";
import { readDirEntriesSafe, shouldRecurseIntoDir } from "./source-walker.js";

export const PROJECT_ROOT_MARKERS = [
	".git",
	"package.json",
	"pyproject.toml",
	"Cargo.toml",
	"go.mod",
	"composer.json",
];

export const MAX_STARTUP_SOURCE_FILES = 2000;

const SOURCE_FILE_PATTERN = /\.(ts|tsx|js|jsx|py|go|rs|rb)$/;

export interface StartupScanContext {
	cwd: string;
	scanRoot: string;
	projectRoot: string | null;
	canWarmCaches: boolean;
	reason?: "home-dir" | "no-project-root" | "too-many-source-files";
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
}

// Default TTL for a persisted `too-many-source-files` verdict (#699): 24h.
const DEFAULT_STARTUP_SCAN_VERDICT_TTL_MS = 24 * 60 * 60 * 1000;

let _startupScanVerdictTtlCache: number | undefined;

/**
 * How long a persisted `too-many-source-files` verdict stays reusable before
 * a session re-walks the tree to refresh it (#699).
 *
 * Resolution order: `PI_LENS_STARTUP_SCAN_VERDICT_TTL_MS` env var, else the
 * 24h default. Lazy + memoized so importing this module never touches
 * `process.env` at load time (house style — see `runtime-config.ts` /
 * `slow-fs.ts` / `subagent-mode.ts`).
 */
export function getStartupScanVerdictTtlMs(): number {
	if (_startupScanVerdictTtlCache !== undefined) {
		return _startupScanVerdictTtlCache;
	}
	const envTtl = toPositiveFinite(
		process.env.PI_LENS_STARTUP_SCAN_VERDICT_TTL_MS,
	);
	_startupScanVerdictTtlCache =
		envTtl > 0 ? envTtl : DEFAULT_STARTUP_SCAN_VERDICT_TTL_MS;
	return _startupScanVerdictTtlCache;
}

/** Test-only: clears the memoized TTL so a subsequent call re-reads the env
 * var (matching the `_resetForTests` convention). */
export function _resetStartupScanVerdictTtlForTests(): void {
	_startupScanVerdictTtlCache = undefined;
}

/**
 * Whether a persisted startup-scan verdict is still safe to reuse without
 * re-walking the project tree (#699).
 *
 * Only the `too-many-source-files` reason is TTL'd. It's the one verdict
 * that can go stale on its own: the repo can shrink below
 * `MAX_STARTUP_SOURCE_FILES` between sessions, and nothing else would notice
 * — the seq-based freshness check that guards every other
 * `project-snapshot.json` field never fires for it, because pi-lens never
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
	if (verdict.reason !== "too-many-source-files") return true;
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

/** Shared (rootDir, ignoreMatcher, stack) setup for both count-walk variants below. */
function initSourceCountWalk(dir: string): {
	rootDir: string;
	ignoreMatcher: ProjectIgnoreMatcher;
	stack: string[];
} {
	const rootDir = path.resolve(dir);
	const ignoreMatcher = getProjectIgnoreMatcher(rootDir);
	return { rootDir, ignoreMatcher, stack: [rootDir] };
}

/**
 * Shared per-entry decision for both `countSourceFilesWithinLimit` and its
 * async twin: pushes a recursable directory onto `stack` (mutated in place)
 * and reports whether `entry` itself counts as a source file. Extracted
 * (refs #191) so the sync/async loops don't carry a byte-identical
 * directory-branch block — the two loops still own their own traversal
 * shape (sync recursion-via-stack vs. async with a yield cadence), only this
 * per-entry classification is shared.
 *
 * Directories here never check for symlinks or generated-artifact names —
 * always follows symlinks (unlike source-filter.ts's collectSourceFiles*).
 */
function classifyCountEntry(
	entry: fs.Dirent,
	fullPath: string,
	ignoreMatcher: ProjectIgnoreMatcher,
	stack: string[],
): boolean {
	if (entry.isDirectory()) {
		if (shouldRecurseIntoDir(entry, fullPath, { ignoreMatcher, followSymlinks: true })) {
			stack.push(fullPath);
		}
		return false;
	}
	return (
		entry.isFile() &&
		!ignoreMatcher.isIgnored(fullPath, false) &&
		SOURCE_FILE_PATTERN.test(entry.name)
	);
}

export function countSourceFilesWithinLimit(
	dir: string,
	limit: number,
): number {
	let count = 0;
	const { ignoreMatcher, stack } = initSourceCountWalk(dir);

	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) continue;

		const entries = readDirEntriesSafe(current);

		for (const entry of entries) {
			const fullPath = path.join(current, entry.name);
			if (classifyCountEntry(entry, fullPath, ignoreMatcher, stack)) {
				count += 1;
				if (count > limit) return count;
			}
		}
	}
	return count;
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
		(options.maxSourceFiles ?? "");
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

	const sourceFileCount = countSourceFilesWithinLimit(
		projectRoot,
		maxSourceFiles,
	);
	if (sourceFileCount > maxSourceFiles) {
		return {
			cwd: resolvedCwd,
			scanRoot: projectRoot,
			projectRoot,
			canWarmCaches: false,
			reason: "too-many-source-files",
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

export async function countSourceFilesWithinLimitAsync(
	dir: string,
	limit: number,
	opts: { yieldEvery?: number } = {},
): Promise<number> {
	// Yield every 100 entries by default. Empirically each yield costs ~0.1ms
	// of overhead and a 2k-file project produces ~20 yields, so the total
	// async overhead is well under 5ms while keeping per-burst sync work
	// under 50ms (the perceptual threshold for "instant" keystrokes).
	const yieldEvery = opts.yieldEvery ?? 100;
	let count = 0;
	let processedSinceYield = 0;
	const { ignoreMatcher, stack } = initSourceCountWalk(dir);
	// #703: prime the tracked-files set ONCE before the walk (not per file) so
	// a tracked file matching a `.gitignore`/global pattern isn't dropped from
	// the startup source-file count. Fail-open: resolves even when git is
	// absent, and `isIgnored` degrades to pattern-only if this never resolves
	// before a caller inspects results.
	await ignoreMatcher.ensureTrackedIndex();

	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) continue;

		const entries = readDirEntriesSafe(current);

		for (const entry of entries) {
			const fullPath = path.join(current, entry.name);
			if (classifyCountEntry(entry, fullPath, ignoreMatcher, stack)) {
				count += 1;
				if (count > limit) return count;
			}
			if (++processedSinceYield % yieldEvery === 0) {
				// Yield to the macrotask queue. setImmediate (not Promise.resolve)
				// is required: stdin "data" events are macrotasks too, and a
				// microtask-only yield would not unblock keystroke handling.
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
		}
	}
	return count;
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
		(options.maxSourceFiles ?? "");
	const cached = startupScanContextCache.get(cacheKey);
	if (cached) return cached;

	const resolvedCwd = path.resolve(cwd);
	const homeDir = path.resolve(options.homeDir ?? os.homedir());
	const maxSourceFiles = options.maxSourceFiles ?? MAX_STARTUP_SOURCE_FILES;
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
		const sourceFileCount = await countSourceFilesWithinLimitAsync(
			projectRoot,
			maxSourceFiles,
		);
		if (sourceFileCount > maxSourceFiles) {
			result = {
				cwd: resolvedCwd,
				scanRoot: projectRoot,
				projectRoot,
				canWarmCaches: false,
				reason: "too-many-source-files",
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
