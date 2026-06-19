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
import { getProjectIgnoreMatcher, isExcludedDirName } from "./file-utils.js";
import { isAtOrAboveHomeDir } from "./path-utils.js";

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
}

export interface StartupScanOptions {
	homeDir?: string;
	maxSourceFiles?: number;
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

export function countSourceFilesWithinLimit(
	dir: string,
	limit: number,
): number {
	let count = 0;
	const rootDir = path.resolve(dir);
	const ignoreMatcher = getProjectIgnoreMatcher(rootDir);
	const stack = [rootDir];

	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) continue;

		let entries: fs.Dirent[] = [];
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			const fullPath = path.join(current, entry.name);
			if (entry.isDirectory()) {
				if (isExcludedDirName(entry.name)) continue;
				if (ignoreMatcher.isIgnored(fullPath, true)) continue;
				stack.push(fullPath);
				continue;
			}
			if (
				entry.isFile() &&
				!ignoreMatcher.isIgnored(fullPath, false) &&
				SOURCE_FILE_PATTERN.test(entry.name)
			) {
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
	const result = computeStartupScanContext(cwd, options);
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
	const rootDir = path.resolve(dir);
	const ignoreMatcher = getProjectIgnoreMatcher(rootDir);
	const stack = [rootDir];

	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) continue;

		let entries: fs.Dirent[] = [];
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			const fullPath = path.join(current, entry.name);
			if (entry.isDirectory()) {
				if (isExcludedDirName(entry.name)) continue;
				if (ignoreMatcher.isIgnored(fullPath, true)) continue;
				stack.push(fullPath);
			} else if (
				entry.isFile() &&
				!ignoreMatcher.isIgnored(fullPath, false) &&
				SOURCE_FILE_PATTERN.test(entry.name)
			) {
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
			reason: resolvedCwd === homeDir ? "home-dir" : "no-project-root",
		};
	} else if (path.resolve(projectRoot) === homeDir) {
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
	startupScanContextCache.set(cacheKey, result);
	return result;
}
