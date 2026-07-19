/**
 * Shared "untracked AND ignored" file-id computation (#679's `/lens-map`,
 * reused by #694's review-graph ignore-gated node creation) — and, since
 * #703, the sibling "tracked files" set that lets `getProjectIgnoreMatcher`
 * (`file-utils.ts`) honor the OTHER half of the same git semantic.
 *
 * THE critical git semantic this exists to respect: a TRACKED file is never
 * ignored, even when a `.gitignore` pattern matches it (pi-lens's own
 * committed `clients/deps/*.js` vendored sources match the repo's `*.js`
 * ignore pattern and MUST stay graph/map nodes) — which is why this asks git
 * itself (`ls-files --others --ignored --exclude-standard` for the untracked
 * side, `ls-files` alone for the tracked side) instead of running a pattern
 * matcher over `.gitignore` (a matcher-only approach would wrongly drop
 * tracked vendored files, e.g. #703's `clients/test-runner-client.ts`
 * matching `.gitignore`'s `test-*.ts`).
 *
 * Degradation: when git is absent/fails/times out (not a git repo, bare
 * checkout, etc.) both `collectUntrackedIgnoredIds` and `collectTrackedFiles`
 * return `undefined` and every caller SKIPS/degrades — the graph/map shows
 * what's known rather than guessing via a matcher that can't see tracked
 * status, and `getProjectIgnoreMatcher` falls back to pattern-only behavior.
 *
 * Keying asymmetry (deliberate, not an oversight): `collectUntrackedIgnoredIds`
 * keys its ids with `normalizeMapKey` (realpath-backed) because those ids are
 * compared against review-graph/map NODE ids — externally-produced state that
 * genuinely needs canonical on-disk casing/symlink resolution to match up.
 * `collectTrackedFiles`'s ids, by contrast, are only ever compared against a
 * `ProjectIgnoreMatcher`'s own `path.resolve`'d paths, produced by THIS
 * process in the SAME walk — an ephemeral, self-consistent comparison per
 * `normalizeEphemeralMapKey`'s contract (`path-utils.ts`), so it uses the
 * cheap syntactic-only fold instead. Do not "fix" this asymmetry by unifying
 * the two — they solve different problems (#703 review).
 */

import * as path from "node:path";
import { isExcludedDirName } from "./file-utils.js";
import { normalizeEphemeralMapKey, normalizeMapKey } from "./path-utils.js";
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

/**
 * Parses `git ls-files` output (repo-relative paths, one per line, tracked
 * files only — no `--others`) into normalized ids, keyed for comparison
 * against a `ProjectIgnoreMatcher`'s own (non-realpath'd) `path.resolve`'d
 * paths — NOT against {@link parseUntrackedIgnoredOutput}'s ids, which are
 * realpath-keyed for a different consumer (review-graph/map node ids). The
 * two sets are NOT directly comparable/mergeable despite the shared
 * dir-exclusion-prune shape — see this file's module doc for the asymmetry.
 *
 * `cwd` is realpath'd exactly ONCE here (not per file) to reconcile the one
 * divergence that matters in practice: on Windows, the matcher's
 * `resolvedRoot` comes from `path.resolve` while this fetch's `cwd` may carry
 * different on-disk casing (e.g. `c:\users` vs `C:\Users`) — a single
 * realpath on the shared root, followed by a cheap syntactic fold
 * (`normalizeEphemeralMapKey`) on every per-file join, reconciles that without
 * paying `realpathSync` per tracked file (#703 perf follow-up — a ~2k-file
 * repo was doing ~2k realpath calls in one synchronous burst per fetch).
 * Accepted edge case: a symlinked or 8.3-short-name project root can still
 * make the cheap per-file fold miss even after this one realpath — degrades
 * to today's pattern-only behavior for that root, consistent with the
 * fail-open contract elsewhere in this module.
 */
export function parseTrackedFilesOutput(stdout: string, cwd: string): Set<string> {
	const ids = new Set<string>();
	const base = normalizeMapKey(cwd);
	for (const line of stdout.split(/\r?\n/)) {
		const rel = line.trim();
		if (!rel) continue;
		const dirSegments = rel.split("/").slice(0, -1);
		if (dirSegments.some((segment) => isExcludedDirName(segment))) continue;
		ids.add(normalizeEphemeralMapKey(path.join(base, rel)));
	}
	return ids;
}

async function fetchTrackedFiles(
	cwd: string,
): Promise<ReadonlySet<string> | undefined> {
	try {
		const result = await safeSpawnAsync("git", ["ls-files"], {
			cwd,
			timeout: 10_000,
			resourceLabel: "git-tracked-ignore",
		});
		if (result.error || result.status !== 0) return undefined;
		return parseTrackedFilesOutput(result.stdout, cwd);
	} catch {
		return undefined;
	}
}

const _trackedCache = new Map<string, CacheEntry>();
// Sync snapshot of the most recently RESOLVED tracked-files fetch per root,
// keyed the same way as `_trackedCache`. `getProjectIgnoreMatcher`'s
// `isIgnored` is sync-and-hot (#703 constraint) and can't await a promise, so
// this is the seam it reads from: `ensureTrackedIndex` (file-utils.ts) awaits
// `collectTrackedFiles` ONCE per walk, which populates this snapshot as a
// side effect; `isIgnored` then reads the snapshot synchronously for every
// file in that same walk. A caller that never primes sees an absent snapshot
// entry and degrades to pattern-only behavior (fail-open, by design).
const _trackedSnapshot = new Map<string, ReadonlySet<string> | undefined>();

/**
 * The tracked-files id set for `cwd` (i.e. `git ls-files`, no `--others`),
 * memoized per-process with the same {@link CACHE_TTL_MS} time bound as
 * {@link collectUntrackedIgnoredIds} — see that function's doc for the hot
 * per-edit-rebuild-loop rationale. Also updates the synchronous snapshot
 * `getTrackedFilesSnapshot` reads, so sync hot-path callers can consult a
 * cheap in-memory Set instead of awaiting this promise per file.
 */
export function collectTrackedFiles(
	cwd: string,
): Promise<ReadonlySet<string> | undefined> {
	// #703 perf follow-up: `normalizeEphemeralMapKey`, not `normalizeMapKey` —
	// this map's only readers/writers are `ensureTrackedIndex`/`isIgnored`
	// (file-utils.ts), both of which derive `cwd` from the SAME matcher's
	// `resolvedRoot` (`path.resolve`, not realpath) within one process, so the
	// cheap syntactic fold is sufficient and avoids a realpath per call — see
	// this file's module doc for why this diverges from `collectUntrackedIgnoredIds`.
	const key = normalizeEphemeralMapKey(cwd);
	const now = Date.now();
	const cached = _trackedCache.get(key);
	if (cached && now - cached.fetchedAtMs < CACHE_TTL_MS) return cached.promise;
	const promise = fetchTrackedFiles(cwd).then((result) => {
		_trackedSnapshot.set(key, result);
		return result;
	});
	_trackedCache.set(key, { promise, fetchedAtMs: now });
	return promise;
}

/**
 * Synchronous read of the most recent {@link collectTrackedFiles} result for
 * `cwd`. Returns `undefined` when nothing has primed this root yet (never
 * called `collectTrackedFiles`), when git degraded (no repo/spawn failure),
 * OR when a fetch is still in flight — all three collapse to the same
 * fail-open "tracked status unknown, use pattern-only behavior" contract.
 * Called on every `isIgnored` check that reaches the tracked-rescue branch
 * (file-utils.ts's `isTrackedAndRescued`), so this key MUST stay the cheap
 * `normalizeEphemeralMapKey` fold, not a realpath.
 */
export function getTrackedFilesSnapshot(cwd: string): ReadonlySet<string> | undefined {
	return _trackedSnapshot.get(normalizeEphemeralMapKey(cwd));
}

/** Test hook: drop the memoized tracked-files cache/snapshot. */
export function _resetTrackedFilesCacheForTests(): void {
	_trackedCache.clear();
	_trackedSnapshot.clear();
}
