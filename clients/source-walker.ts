/**
 * Shared directory-walk primitives (refs #191, "unify the three divergent
 * source walkers").
 *
 * `source-filter.ts` (`collectSourceFiles`/`collectSourceFilesAsync`),
 * `language-profile.ts` (`collectSourceFilesForWarmup`), and
 * `startup-scan.ts` (`countSourceFilesWithinLimit`/`countSourceFilesWithinLimitAsync`)
 * each re-implement a `readdirSync` + ignore-matcher + exclude-dir walk. The
 * SonarCloud duplication flagged on PR #188's async variants is a symptom of
 * this repeated boilerplate.
 *
 * This module intentionally does NOT own the full traversal loop for any
 * caller. Each walker's loop shape (sync-recursive vs. stack-based, yield
 * cadence, file-classification rules — extensions vs. regex vs. build-artifact
 * detection, hard caps vs. count-and-early-exit) is caller-specific and
 * preserved exactly where it already lived; unifying those would silently
 * change observable behavior (e.g. which files survive a `maxFiles` cap on an
 * over-large tree), which issue #191 explicitly calls out as NOT to do
 * silently.
 *
 * What genuinely was duplicated five times across those files is:
 *   1. The "should I recurse into this directory" decision — ignore-matcher +
 *      exclude-dir-name, plus two checks only `source-filter.ts` needs
 *      (generated-artifact directories, symlink-following).
 *   2. The `readdirSync(..., { withFileTypes: true })` + try/catch-swallow
 *      boilerplate (a missing/unreadable directory is silently skipped).
 * Both are centralized here so there is exactly one place that encodes "what
 * counts as an excluded directory."
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectIgnoreMatcher } from "./file-utils.js";
import { isExcludedDirName } from "./file-utils.js";
import { isGeneratedArtifactDirectoryName } from "./generated-artifacts.js";

/**
 * Read a directory's entries, returning `[]` for a permission-denied or
 * missing directory instead of throwing. Shared by every walker below — a
 * directory can legitimately disappear or become unreadable mid-walk (race
 * with another process, a broken symlink target, etc.) and every existing
 * caller already treated that as "yields no entries," not a hard failure.
 */
export function readDirEntriesSafe(dirPath: string): fs.Dirent[] {
	try {
		return fs.readdirSync(dirPath, { withFileTypes: true });
	} catch {
		return [];
	}
}

export interface DirWalkPolicy {
	/** Project ignore rules (.gitignore + .pi-lens.json), from `getProjectIgnoreMatcher`. */
	ignoreMatcher: ProjectIgnoreMatcher;
	/** Extra directory-name/glob patterns to exclude, merged with the shared default list. */
	extraExcludeDirs?: string[];
	/**
	 * Also exclude directories that look like generated/build-artifact output
	 * (e.g. `dist`, `.next`, `__generated__`). Only `source-filter.ts` opts into
	 * this today — `language-profile.ts` and `startup-scan.ts` never checked
	 * for it, so their walkers must pass this as `false`/omitted to keep their
	 * existing behavior.
	 */
	skipGeneratedArtifactDirs?: boolean;
	/**
	 * Recurse into symlinked directories. Default `false` (skip them) —
	 * matches `source-filter.ts`'s existing default. `language-profile.ts` and
	 * `startup-scan.ts` never checked `entry.isSymbolicLink()` at all (i.e.
	 * always followed), so their call sites must pass `true` to preserve that.
	 */
	followSymlinks?: boolean;
}

/**
 * The one shared "should this directory be walked into" decision. Every
 * caller's own loop still owns *when* to call this (inline recursion vs. a
 * stack) and what to do with the answer.
 */
export function shouldRecurseIntoDir(
	entry: fs.Dirent,
	fullPath: string,
	policy: DirWalkPolicy,
): boolean {
	if (isExcludedDirName(entry.name, policy.extraExcludeDirs ?? [])) {
		return false;
	}
	if (policy.ignoreMatcher.isIgnored(fullPath, true)) return false;
	if (
		policy.skipGeneratedArtifactDirs === true &&
		isGeneratedArtifactDirectoryName(entry.name)
	) {
		return false;
	}
	if (policy.followSymlinks !== true && entry.isSymbolicLink()) return false;
	return true;
}

// ---------------------------------------------------------------------------
// Bounded-walk engine (refs #761).
//
// Every recursive tree walker in the repo re-implemented the same traversal
// skeleton — the `readdirSync` + for-entry loop, the sync-recursion / async-
// stack shapes, and the `setImmediate` yield cadence — so each hardening
// episode (#747→#751/#754 home ceilings, #758/#759→#760/#764 entry budgets)
// cost O(number-of-walkers) to apply. These three drivers own the LOOP and the
// mechanical yield cadence exactly once; each walker plugs in a per-entry
// `WalkVisitor` that classifies one entry and charges its own bounds, keeping
// the classification/policy (symlink handling, artifact probes, source-file
// patterns, budget arithmetic) caller-specific by design — the bounds
// arithmetic genuinely differs by an off-by-one between the count family
// (post-classify `visited >= max`) and the collect family (pre-classify
// `visited > max`), so it stays in the visitor rather than being forced onto
// one shared comparison (#761: consolidate the loop, not the policy).
// ---------------------------------------------------------------------------

/**
 * What a {@link WalkVisitor} tells the driver to do with one directory entry
 * after it has classified (and bound-charged) it:
 *  - `"recurse"`: this entry is a directory to descend into. The driver owns
 *    the traversal order (depth-first; see each driver).
 *  - `"skip"`: nothing to do — keep walking.
 *  - `"stop"`: terminate the ENTIRE walk immediately (a bound tripped, or the
 *    walker found what it was looking for). Any state the caller needs
 *    (results collected, which bound tripped) lives in its own closure.
 */
export type WalkDisposition = "recurse" | "skip" | "stop";

/**
 * Per-entry step. Receives one directory entry and its already-joined absolute
 * path (the driver computes `path.join(dir, entry.name)` once), classifies it,
 * mutates the caller's own walk state via closure, and returns a
 * {@link WalkDisposition}. This is the single pluggable seam of the engine —
 * generalized from `visitCountEntry` (startup-scan) and
 * `chargeEntryBudget`/`classifyEntry` (source-filter).
 */
export type WalkVisitor = (entry: fs.Dirent, fullPath: string) => WalkDisposition;

export interface StackWalkOptions {
	/**
	 * Loop guard checked once before popping each directory (not per entry).
	 * Reproduces jscpd's per-directory entry budget (`visited < MAX_ENTRIES` as
	 * a `while` condition): the current directory's entry loop always runs to
	 * completion, but no further directory is popped once this returns true.
	 * When it stops the walk this way the driver returns `false` (the visitor
	 * never signalled `"stop"`).
	 */
	shouldStop?: () => boolean;
}

export interface AsyncStackWalkOptions extends StackWalkOptions {
	/**
	 * Yield to the macrotask queue (via `setImmediate`) after every N entries
	 * the visitor processes without stopping. `setImmediate` — not
	 * `Promise.resolve` — is required so stdin "data" events (also macrotasks)
	 * can interleave and keystrokes stay responsive during `session_start`
	 * (#703). Each caller passes its own historical cadence (startup: 100,
	 * source-filter: 50).
	 */
	yieldEvery: number;
	/**
	 * Optional async hook awaited once before the walk begins — used to prime
	 * the ignore-matcher's tracked-file index (`ensureTrackedIndex`, #703) so a
	 * tracked file matching a `.gitignore` pattern isn't dropped.
	 */
	beforeWalk?: () => Promise<void>;
}

/**
 * Depth-first, stack-based synchronous driver. Within each directory, entries
 * are visited left-to-right; entries the visitor marks `"recurse"` are gathered
 * and pushed in reverse after the entry loop, so the pop order descends
 * left-to-right. Returns true iff the visitor stopped the walk via `"stop"`
 * (vs. exhausting the tree or tripping `shouldStop`).
 */
export function walkTreeStackSync(
	rootDir: string,
	visit: WalkVisitor,
	opts: StackWalkOptions = {},
): boolean {
	const stack: string[] = [rootDir];
	while (stack.length > 0) {
		if (opts.shouldStop?.()) return false;
		const dir = stack.pop();
		if (dir === undefined) continue;
		const subDirs: string[] = [];
		for (const entry of readDirEntriesSafe(dir)) {
			const fullPath = path.join(dir, entry.name);
			const disposition = visit(entry, fullPath);
			if (disposition === "stop") return true;
			if (disposition === "recurse") subDirs.push(fullPath);
		}
		for (let i = subDirs.length - 1; i >= 0; i--) stack.push(subDirs[i]);
	}
	return false;
}

/**
 * Async, chunked-yield twin of {@link walkTreeStackSync}. Same depth-first
 * stack traversal, plus a `setImmediate` yield every `yieldEvery` processed
 * entries so a large tree never holds the event loop in one synchronous burst.
 * Returns true iff the visitor stopped the walk via `"stop"`.
 */
export async function walkTreeStackAsync(
	rootDir: string,
	visit: WalkVisitor,
	opts: AsyncStackWalkOptions,
): Promise<boolean> {
	await opts.beforeWalk?.();
	const stack: string[] = [rootDir];
	let processedSinceYield = 0;
	while (stack.length > 0) {
		if (opts.shouldStop?.()) return false;
		const dir = stack.pop();
		if (dir === undefined) continue;
		const subDirs: string[] = [];
		for (const entry of readDirEntriesSafe(dir)) {
			const fullPath = path.join(dir, entry.name);
			const disposition = visit(entry, fullPath);
			if (disposition === "stop") return true;
			if (disposition === "recurse") subDirs.push(fullPath);
			if (++processedSinceYield >= opts.yieldEvery) {
				processedSinceYield = 0;
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
		}
		for (let i = subDirs.length - 1; i >= 0; i--) stack.push(subDirs[i]);
	}
	return false;
}

/**
 * Depth-first synchronous driver that descends into a `"recurse"` directory
 * IMMEDIATELY, before visiting the remaining sibling entries — the recursion
 * shape (and therefore the result-array order) of `source-filter.ts`'s sync
 * collector, which its stack-based async twin deliberately does NOT share.
 * Returns true iff the visitor stopped the walk via `"stop"`; the stop
 * propagates up through every recursion frame so the walk halts at once.
 */
export function walkTreeRecursiveSync(
	rootDir: string,
	visit: WalkVisitor,
): boolean {
	function scan(currentDir: string): boolean {
		for (const entry of readDirEntriesSafe(currentDir)) {
			const fullPath = path.join(currentDir, entry.name);
			const disposition = visit(entry, fullPath);
			if (disposition === "stop") return true;
			if (disposition === "recurse" && scan(fullPath)) return true;
		}
		return false;
	}
	return scan(rootDir);
}
