/**
 * Shared "untracked AND ignored" file-id computation (#679's `/lens-map`,
 * reused by #694's review-graph ignore-gated node creation).
 *
 * THE critical git semantic this exists to respect: a TRACKED file is never
 * ignored, even when a `.gitignore` pattern matches it (pi-lens's own
 * committed `clients/deps/*.js` vendored sources match the repo's `*.js`
 * ignore pattern and MUST stay graph/map nodes) — which is why this asks git
 * itself (`ls-files --others --ignored --exclude-standard`) instead of
 * running a pattern matcher over `.gitignore` (a matcher-only approach would
 * wrongly drop tracked vendored files).
 *
 * Degradation: when git is absent/fails/times out (not a git repo, bare
 * checkout, etc.) `collectUntrackedIgnoredIds` returns `undefined` and every
 * caller SKIPS the filter entirely — the graph/map shows what's known rather
 * than guessing via a matcher that can't see tracked status.
 */

import * as path from "node:path";
import { isExcludedDirName } from "./file-utils.js";
import { normalizeMapKey } from "./path-utils.js";
import { safeSpawnAsync } from "./safe-spawn.js";

/**
 * Parses `git ls-files --others --ignored --exclude-standard` output
 * (repo-relative paths, one per line) into normalized map-key file ids.
 * Exported as a pure function so the parse/normalize step is unit-testable
 * without mocking the spawn.
 */
export function parseUntrackedIgnoredOutput(
	stdout: string,
	cwd: string,
): Set<string> {
	const ids = new Set<string>();
	for (const line of stdout.split(/\r?\n/)) {
		const rel = line.trim();
		if (!rel) continue;
		// Paths inside shared-excluded dirs (node_modules, dist, .git, …) can
		// never be review-graph/map nodes — the graph walk itself routes
		// exclusion through `isExcludedDirName` — so skip them BEFORE paying for
		// `normalizeMapKey` (realpath-backed, per-call filesystem cost): on
		// pi-lens itself this prunes a 66k-line ignored list (node_modules) down
		// to ~1.6k paths that actually need normalizing.
		const dirSegments = rel.split("/").slice(0, -1);
		if (dirSegments.some((segment) => isExcludedDirName(segment))) continue;
		ids.add(normalizeMapKey(path.join(cwd, rel)));
	}
	return ids;
}

async function fetchUntrackedIgnoredIds(
	cwd: string,
): Promise<ReadonlySet<string> | undefined> {
	try {
		const result = await safeSpawnAsync(
			"git",
			["ls-files", "--others", "--ignored", "--exclude-standard"],
			{ cwd, timeout: 10_000, resourceLabel: "git-tracked-ignore" },
		);
		if (result.error || result.status !== 0) return undefined;
		return parseUntrackedIgnoredOutput(result.stdout, cwd);
	} catch {
		return undefined;
	}
}

interface CacheEntry {
	promise: Promise<ReadonlySet<string> | undefined>;
	fetchedAtMs: number;
}

// #694: the review-graph build calls this on EVERY incremental/cascade
// rebuild (a hot, per-edit path), not just `/lens-map`'s one-shot generation —
// spawning `git ls-files` per edit would be a real per-keystroke cost. Memoize
// per cwd with a short time bound: cheap enough that a `.gitignore` edit or a
// newly-untracked file takes effect within a few seconds, but a burst of
// per-edit rebuilds within that window shares one spawn.
const CACHE_TTL_MS = 30_000;
const _cache = new Map<string, CacheEntry>();

/**
 * The untracked-AND-ignored id set for `cwd`, memoized per-process with a
 * {@link CACHE_TTL_MS} time bound so a hot rebuild loop (review-graph
 * incremental/cascade builds) never spawns `git` per file/per edit — see the
 * module doc for the tracked-file semantic and the degrade-to-undefined
 * contract.
 */
export function collectUntrackedIgnoredIds(
	cwd: string,
): Promise<ReadonlySet<string> | undefined> {
	const key = normalizeMapKey(cwd);
	const now = Date.now();
	const cached = _cache.get(key);
	if (cached && now - cached.fetchedAtMs < CACHE_TTL_MS) return cached.promise;
	const promise = fetchUntrackedIgnoredIds(cwd);
	_cache.set(key, { promise, fetchedAtMs: now });
	return promise;
}

/** Test hook: drop the memoized cache so a test's fake git state is re-read. */
export function _resetUntrackedIgnoredCacheForTests(): void {
	_cache.clear();
}
