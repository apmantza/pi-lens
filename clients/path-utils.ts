/**
 * Path utilities for pi-lens
 *
 * Handles cross-platform path normalization, particularly
 * Windows case-insensitivity issues when using paths as Map keys.
 *
 * Approach (inspired by OpenCode's Filesystem.normalizePath):
 * - On Windows: try realpathSync.native() for canonical casing
 * - Falls back to lowercase for files that don't exist yet
 * - On non-Windows: return path as-is (case-sensitive filesystem)
 * - Always convert backslashes to forward slashes for Map key consistency
 */

import {
	type Dirent,
	existsSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { minimatch } from "./deps/minimatch.js";

/**
 * Detect a positively Windows-shaped path, regardless of the host OS.
 *
 * A backslash anywhere in a path is not enough: it is a legal character in a
 * POSIX filename. Only a drive-letter prefix (`X:`), a UNC root (`\\`), or a
 * rooted backslash at position zero (`\`) selects Windows parsing.
 */
export function isWindowsPath(filePath: string): boolean {
	return /^[A-Za-z]:/.test(filePath) || filePath.startsWith("\\");
}

/**
 * Canonical backslash→forward-slash fold — the single sanctioned form of the
 * `p.replace(/\\/g, "/")` idiom otherwise hand-rolled across the codebase
 * (~138 sites, #1193). PURE separator normalization: it does NOT resolve,
 * canonicalize, lowercase, or collapse repeated slashes — reach for
 * `normalizeFilePath`/`normalizeMapKey`/`normalizeEphemeralMapKey` when a
 * canonical map *key* (case-fold / realpath) is what you need. Consolidating on
 * this funnels the scattered transform and makes a shape-2 lint/ast-grep rule
 * possible for the first time: today a bare inline `.replace(/\\/g, "/")` is
 * byte-identical to the sanctioned use so it can't be ruled (#1158); once
 * everything routes through `toPosix`, an *un-migrated* inline `.replace`
 * becomes detectable.
 */
export function toPosix(filePath: string): string {
	return filePath.replace(/\\/g, "/");
}

/** Return whether `filePath` is fully qualified under Windows semantics. */
export function isFullyQualifiedWin32(filePath: string): boolean {
	return win32.isAbsolute(filePath) && win32.parse(filePath).root.length > 1;
}

/** Return whether `filePath` is fully qualified under POSIX semantics. */
export function isFullyQualifiedPosix(filePath: string): boolean {
	return path.posix.isAbsolute(filePath) && !isWindowsPath(filePath);
}

/**
 * Return whether `filePath` is fully qualified under the host's semantics.
 *
 * In particular, `/foo` is rooted-relative under Win32 (ambient-drive
 * dependent) but fully qualified under POSIX.
 */
export function isFullyQualified(filePath: string): boolean {
	return process.platform === "win32"
		? isFullyQualifiedWin32(filePath)
		: isFullyQualifiedPosix(filePath);
}

/**
 * Shape-based absolute check (mirrors `toProjectRelativePath`'s idiom): a
 * Windows-shaped path (drive-letter/UNC) is parsed with `win32.isAbsolute`
 * regardless of host OS, since the host-default `path.isAbsolute` returns
 * FALSE for a Windows-shaped path on POSIX (#1150 class) and would let a
 * cross-platform-persisted relative path slip past this guard on Linux CI.
 * MUST run on the RAW `filePath`, before `normalizeMapKey`: on Windows,
 * `normalizeMapKey`'s nonexistent-path fallback (`resolveNonExisting`) calls
 * `win32.resolve`, which silently makes any relative path absolute against
 * `process.cwd()` — checking the normalized value would defeat this guard
 * entirely on Windows.
 *
 * Promoted from a private copy in `clients/review-graph/service.ts` (#2477)
 * so `clients/dispatch/dispatcher.ts`'s baseline-key guard (#2489) can share
 * the same sanctioned check instead of hand-rolling a second one.
 */
export function isAbsoluteFilePath(filePath: string): boolean {
	const p = isWindowsPath(filePath) ? win32 : path;
	return p.isAbsolute(filePath);
}

/**
 * Split a path into its non-empty segments on EITHER separator (`\` or `/`),
 * regardless of the running OS — the shape-safe form of `p.split(path.sep)` /
 * an inline `p.split(/[\\/]+/)`, which #1161/#1163 showed must not assume the
 * host separator for a possibly-cross-shaped path. Drops empty segments
 * (leading slash, drive-root, doubled separators).
 */
export function splitPathSegments(filePath: string): string[] {
	return filePath.split(/[\\/]+/).filter(Boolean);
}

/**
 * Normalize a file path for consistent Map key usage.
 *
 * On Windows:
 * - If the file exists: uses realpathSync.native() to get the canonical
 *   filesystem path (actual casing, resolved symlinks)
 * - If the file doesn't exist: resolves the path and lowercases
 *   (needed for new files where we haven't written yet)
 *
 * On non-Windows: returns path as-is (case-sensitive filesystem).
 *
 * Always converts backslashes to forward slashes for consistent Map keys.
 */
export function normalizeFilePath(filePath: string): string {
	// Convert backslashes to forward slashes first
	const normalized = filePath.replace(/\\/g, "/");

	if (process.platform !== "win32" && !isWindowsPath(normalized)) {
		return normalized;
	}

	// Windows: try realpathSync.native() for canonical casing
	// This resolves symlinks and returns the actual filesystem casing
	try {
		const canonical = realpathSync.native(filePath);
		return canonical.replace(/\\/g, "/");
	} catch {
		// File doesn't exist yet (new file) — resolve path and lowercase
		// We need to walk up the directory tree to find the nearest existing
		// parent, resolve its casing, then append the non-existent parts
		try {
			return resolveNonExisting(filePath);
		} catch {
			// Last resort: just lowercase the resolved path
			const resolved = win32.normalize(win32.resolve(filePath));
			return resolved.replace(/\\/g, "/").toLowerCase();
		}
	}
}

/**
 * Normalize a logged `filePath`/`cwd` value, but ONLY when it is already a
 * fully-qualified path (#2219, the #2141 class's sibling loggers). Several
 * NDJSON log-entry types reuse a `filePath`-typed field for non-path
 * sentinels alongside genuine paths — `"<quiet-window>"` in
 * `cascade-logger.ts`, `"<tree-sitter>"` in `tree-sitter-logger.ts`, a shell
 * command or an empty placeholder in `latency-logger.ts`. `normalizeFilePath`
 * resolves a relative-looking string against the CURRENT process cwd (see
 * `resolveNonExisting` above), so running it over one of those sentinels
 * would silently corrupt it into `"<repoRoot>/<quiet-window>"` instead of
 * normalizing it. Only a value that is already fully qualified can be the
 * #2141 mixed-raw/normalized-path defect; anything else is passed through
 * unchanged.
 *
 * #2229 review round 1, F1: this classifier checks BOTH host shapes
 * (`isFullyQualifiedWin32(value) || isFullyQualifiedPosix(value)`), not
 * `isFullyQualified(value)` (host-dispatched on `process.platform`). A
 * Windows-shaped absolute path (`C:\Users\...`) is exactly the log payload
 * this fix exists to normalize, but `isFullyQualified` on Linux CI routes to
 * `isFullyQualifiedPosix`, which rejects it (no leading `/`) — so on Linux
 * the guard silently no-ops for the very inputs the #2141 defect produces,
 * passing the raw backslash form straight through. Checking both shapes
 * makes the classifier's answer for a given STRING independent of which OS
 * is asking; `normalizeFilePath` itself still branches on `process.platform`
 * for how the file is resolved, but whether to normalize at all no longer
 * does (AGENTS.md shape 2, the #1024/#1150 OS-divergence class).
 */
export function normalizeLoggedPath(value: string): string {
	return isFullyQualifiedWin32(value) || isFullyQualifiedPosix(value)
		? normalizeFilePath(value)
		: value;
}

/**
 * Resolve a non-existing path by finding the nearest existing parent,
 * getting its canonical casing, then appending the non-existent parts lowercased.
 *
 * Example: C:\Users\Foo\newdir\file.ts
 * - C:\Users\Foo exists → realpathSync gives C:\Users\Foo
 * - newdir\file.ts doesn't exist → lowercased
 * - Result: C:/Users/Foo/newdir/file.ts
 */
function resolveNonExisting(filePath: string): string {
	const resolved = win32.resolve(filePath);
	let current = resolved;
	const nonExistentParts: string[] = [];

	// Walk up until we find an existing directory
	while (true) {
		if (existsSync(current)) {
			// Found existing ancestor — get its canonical casing
			const canonical = realpathSync.native(current);
			if (nonExistentParts.length === 0) {
				return canonical.replace(/\\/g, "/");
			}
			// Append non-existent parts (lowercased for consistency)
			const tail = nonExistentParts.reverse().join("/").toLowerCase();
			const base = canonical.replace(/\\/g, "/");
			return base.endsWith("/") ? base + tail : `${base}/${tail}`;
		}

		// Use win32.dirname (not the platform-default dirname) so a
		// Windows-shaped path is parsed with win32 semantics regardless of the
		// running OS — consistent with the win32.resolve/win32.normalize this
		// branch already commits to. The platform-default POSIX dirname would
		// find no separator in a win32-resolved "C:\repo\..." path (its only
		// separators are backslashes), collapse to ".", stop the upward walk at
		// cwd, and mangle the key on Linux CI (refs #1150, the #1024
		// OS-divergence class).
		const parent = win32.dirname(current);
		if (parent === current) {
			// Reached filesystem root without finding existing dir
			// Fall back to full lowercase
			throw new Error("No existing parent found");
		}

		nonExistentParts.push(win32.basename(current));
		current = parent;
	}
}

/**
 * Convert a file:// URI to a normalized path.
 * Handles URL decoding and Windows drive letter normalization.
 */
export function uriToPath(uri: string): string {
	try {
		const filePath = fileURLToPath(uri);
		return normalizeFilePath(filePath);
	} catch {
		// Not a valid file:// URI, treat as plain path
		return normalizeFilePath(uri);
	}
}

/**
 * Decode a file:// URI to an on-disk path WITHOUT map-key normalization.
 *
 * `uriToPath` runs its result through `normalizeFilePath`, which on win32
 * lowercases the nonexistent tail of a path (see `resolveNonExisting`) and
 * canonicalizes an existing path to its real casing. That is correct for Map
 * keys, but DESTRUCTIVE for a real create/rename target: creating `NewFile.txt`
 * would write `newfile.txt`, and a legitimate case-only rename would collapse
 * to a no-op ("source and destination must differ"). Disk mutations must honor
 * the caller's intended casing, so they resolve their target through this
 * decode-only path while confinement/validation keep using the normalized
 * `uriToPath`. Non-win32 is unaffected either way (normalizeFilePath is a
 * near-identity there).
 */
export function uriToDiskPath(uri: string): string {
	try {
		return fileURLToPath(uri);
	} catch {
		// Not a valid file:// URI — treat as a plain path (matches uriToPath).
		return uri;
	}
}

/**
 * Convert a path to a file:// URI.
 * Does NOT normalize the path - URIs preserve original casing.
 */
export function pathToUri(filePath: string): string {
	return pathToFileURL(filePath).href;
}

/**
 * Normalize a Map key lookup for file paths.
 * Use this when getting/setting values in Maps that use file paths as keys.
 */
export function normalizeMapKey(filePath: string): string {
	return normalizeFilePath(filePath);
}

/**
 * Human-facing path relative to a project root when the file is inside it.
 *
 * Parses by path SHAPE, not host OS (refs #1150/#1152, shape-2 class #1163):
 * a Windows-shaped `filePath` (drive-letter/UNC — e.g. a persisted call-graph
 * symbol-key path `C:\repo\src\x.ts` rehydrated on a Linux CI run) is split
 * with `win32.*` regardless of `process.platform`. The host-default
 * `isAbsolute`/`relative` find no drive-letter anchor in a win32 path on POSIX:
 * `path.isAbsolute("C:\\repo\\x.ts")` returns FALSE on Linux, short-circuiting
 * to the raw absolute path instead of ever relativizing it — so a file that IS
 * under the project root renders as a full absolute path on Linux but the
 * expected `src/x.ts` on Windows (green-locally / wrong-on-CI, the #1024
 * divergence class). `win32.*` on a native POSIX path (Windows never sees one;
 * Linux native paths aren't Windows-shaped) is never selected, so same-OS
 * native paths are unchanged either way.
 */
export function toProjectRelativePath(
	filePath: string,
	projectRoot: string,
): string {
	const p = isWindowsPath(filePath) ? win32 : path;
	if (!p.isAbsolute(filePath)) return filePath.replace(/\\/g, "/");
	const relative = p.relative(p.resolve(projectRoot), filePath);
	return relative && !relative.startsWith("..") && !p.isAbsolute(relative)
		? relative.replace(/\\/g, "/")
		: filePath.replace(/\\/g, "/");
}

/**
 * Cheap, syntactic-only Map key normalization: slash-fold + (on Windows)
 * lowercase. No `realpathSync` / filesystem I/O.
 *
 * `normalizeMapKey` (via `normalizeFilePath`) calls `realpathSync.native()` to
 * get canonical on-disk casing — correct for maps that key long-lived state
 * shared across call sites (e.g. LSP/read-guard caches), but expensive when
 * the *point* of the cache is to avoid filesystem calls in the first place:
 * for a candidate path that does NOT exist (the common case for sibling-probe
 * memos), `normalizeFilePath` walks up the directory tree doing its own
 * `existsSync` calls to resolve the nearest existing ancestor — measured at
 * ~11x slower than the single `existsSync` probe such a cache is trying to
 * save (refs #191).
 *
 * Safe to use ONLY for ephemeral, single-process, single-walk caches whose
 * keys are produced by this process's own `path.join`/`path.resolve` calls
 * within the same run (so separators and casing are already consistent
 * modulo simple slash direction) — never for state shared across processes,
 * persisted, or compared against externally-supplied paths where symlink /
 * real-casing resolution actually matters.
 */
export function normalizeEphemeralMapKey(filePath: string): string {
	// Most hot-path keys on POSIX are already canonical slash-separated strings.
	// Preserve that identity instead of allocating a replacement string for each
	// file in a large diagnostics reconciliation.
	if (process.platform !== "win32" && !filePath.includes("\\")) return filePath;
	const slashed = filePath.replace(/\\/g, "/");
	return process.platform === "win32" ? slashed.toLowerCase() : slashed;
}

/**
 * Compare two file paths for equality, handling Windows case-insensitivity
 * and mixed separators (backslash vs forward slash).
 */
export function pathsEqual(a: string, b: string): boolean {
	return normalizeFilePath(a) === normalizeFilePath(b);
}

/**
 * Check if `child` is under `parent` directory.
 * Separator-agnostic and case-insensitive on Windows.
 */
/**
 * Yield each directory from `startDir` up to (and including) the filesystem
 * root. Terminates when `path.dirname(current) === current` so it works on
 * Windows drive roots and POSIX `/` alike.
 *
 * Single source of truth for the half-dozen "walk up the directory tree
 * looking for X" loops that have accumulated across the codebase. Callers
 * that need an "is there a file named Y anywhere on the way up" check
 * should use `findNearestContaining` instead.
 */
export function* walkUpDirs(startDir: string): Generator<string> {
	let current = path.resolve(startDir);
	while (true) {
		yield current;
		const parent = path.dirname(current);
		if (parent === current) return;
		current = parent;
	}
}

/**
 * Walk up from `startDir` and return the first directory that contains any
 * of `candidates` on disk. Returns `undefined` if none match.
 *
 * @example
 *   findNearestContaining("/repo/pkg/src", ["package.json", "tsconfig.json"]);
 *   // → "/repo/pkg" if pkg/package.json exists, "/repo" if only /repo/package.json
 */
export function findNearestContaining(
	startDir: string,
	candidates: readonly string[],
): string | undefined {
	for (const dir of walkUpDirs(startDir)) {
		for (const name of candidates) {
			if (existsSync(path.join(dir, name))) return dir;
		}
	}
	return undefined;
}

/**
 * Walk up from `startDir` and return the first matching FILE path (not just
 * the containing directory) for any of `names`, first-match-wins within each
 * directory in `names` order. Single source of truth for the "walk up
 * looking for one of these config filenames" loop that `opengrep-config.ts`,
 * `typos-config.ts`, `zizmor-config.ts`, and `sgconfig.ts` each hand-rolled
 * independently (refs #680), and that `php-cs-fixer-config.ts` now delegates
 * to as well (refs #2472 review F2).
 *
 * UNCEILINGED by default (refs #2472 review round 3, F1) — `options.homeDir`
 * is opt-in, not default-on. A prior version applied the SAME `$HOME`
 * ceiling as `findNearestMarkerRoot` unconditionally, which broke every one
 * of these tools' actual discovery contract: each of them treats a config
 * living directly at `$HOME` (`~/typos.toml`, `~/sgconfig.yml`, …) as the
 * user's legitimate GLOBAL config, and reads it itself regardless of pi-lens
 * — the ceiling didn't stop pi-lens from seeing an unrelated ancestor
 * config, it stopped pi-lens from seeing the SAME config the tool was about
 * to read on its own, so pi-lens silently fell back to (or, for typos,
 * injected and let its own shipped `_typos.toml` merge over) the user's
 * config where the tool's own resolver would have honored it. `php-cs-fixer`
 * makes the same mismatch concrete: its detection gates
 * (`hasPhpCsFixerConfig` via `findNearestContaining`, `phpCsFixerFormatter
 * .detect` via its own `findUp`) are both unceilinged, so a ceilinged
 * carriage here disagreed with its own gate — "config exists" from the gate,
 * "config not found" from the resolver — and dropped the very `--config`
 * argv #2472 exists to carry. Pass `options.homeDir` only when a caller
 * affirmatively wants the ceiling (a config found at or above THAT directory
 * is never returned); omitting it walks all the way to the filesystem root,
 * matching `findNearestContaining`'s unceilinged behavior and every
 * underlying tool's own discovery.
 *
 * Distinct from `findNearestContaining`, which returns the containing
 * directory rather than the matched file path — use that one when the caller
 * only needs "is one of these present nearby", not which file it is.
 *
 * @example
 *   findLocalToolConfig(cwd, ["typos.toml", "_typos.toml", ".typos.toml"]);
 *   // → "/repo/typos.toml" if present, else undefined
 */
export function findLocalToolConfig(
	startDir: string,
	names: readonly string[],
	options: { homeDir?: string } = {},
): string | undefined {
	const homeDir =
		options.homeDir !== undefined ? path.resolve(options.homeDir) : undefined;
	for (const dir of walkUpDirs(startDir || process.cwd())) {
		if (homeDir !== undefined && isAtOrAboveHomeDir(dir, homeDir)) {
			return undefined;
		}
		for (const name of names) {
			const candidate = path.join(dir, name);
			if (existsSync(candidate)) return candidate;
		}
	}
	return undefined;
}

export interface FindNearestMarkerRootOptions {
	/**
	 * Directory names/files that, if found BEFORE any of `markers`, stop the
	 * walk and make it return `null` — e.g. `.git`/`.hg`/`.svn` so a search
	 * starting inside a repo without its own project marker doesn't escape
	 * past that repo's VCS boundary to pick up an unrelated parent's marker.
	 * Omit for callers with no such boundary (default: none).
	 */
	boundaries?: readonly string[];
	/** Override for `os.homedir()`, primarily for tests. */
	homeDir?: string;
	/** Further validate a marker path before accepting its containing directory. */
	markerPredicate?: (markerPath: string) => boolean;
}

/**
 * Accept only a real Git repository marker: a directory with HEAD, or a
 * worktree/submodule marker file whose first line starts with `gitdir:`.
 */
export function isRealGitMarker(markerPath: string): boolean {
	try {
		const marker = statSync(markerPath);
		if (marker.isDirectory()) return existsSync(path.join(markerPath, "HEAD"));
		if (!marker.isFile()) return false;
		return readFileSync(markerPath, "utf8")
			.split(/\r?\n/, 1)[0]
			.startsWith("gitdir:");
	} catch {
		return false;
	}
}

/**
 * Walk up from `startDir` looking for a directory containing any of
 * `markers`, the same containment-aware climb `knip-client.ts` and
 * `dead-code-client.ts` each used to hand-roll independently (refs #625):
 *
 *   - Never resolves at or above `$HOME` (via `isAtOrAboveHomeDir`) — a
 *     marker found there has escaped the user's workspace.
 *   - If `options.boundaries` is given and one is found before any `marker`,
 *     stops and returns `null` rather than continuing past it.
 *   - Depth-capped at 64 climbs, matching the callers' existing safety bound
 *     (guards a pathological symlink loop; real depths are ~10).
 *   - Returns `null` — never `startDir` — when nothing is found. Callers
 *     must treat `null` as "no project here", not fall back to the start
 *     directory (a `null`-swallowing fallback was the #250/#296 bug class:
 *     scanning $HOME wholesale from a bare cwd).
 *
 * For a plain "find nearest containing directory" with no boundary concept,
 * use `findNearestContaining` instead. Distinct from `startup-scan.ts`'s
 * `findNearestProjectRoot` (fixed marker list, no boundaries, no home-check —
 * that caller applies `isAtOrAboveHomeDir` itself afterward); named
 * differently here to avoid confusion between the two.
 */
export function findNearestMarkerRoot(
	startDir: string,
	markers: readonly string[],
	options: FindNearestMarkerRootOptions = {},
): string | null {
	const boundaries = options.boundaries ?? [];
	const homeDir = path.resolve(options.homeDir ?? os.homedir());
	const markerPredicate = options.markerPredicate ?? (() => true);
	let current = path.resolve(startDir);
	for (let depth = 0; depth < 64; depth++) {
		if (isAtOrAboveHomeDir(current, homeDir)) return null;
		if (
			markers.some(
				(m) =>
					existsSync(path.join(current, m)) &&
					markerPredicate(path.join(current, m)),
			)
		)
			return current;
		if (boundaries.some((m) => existsSync(path.join(current, m)))) return null;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
	return null;
}

/**
 * True when `dir` is the home directory OR an ancestor of it (`/home`,
 * `C:\Users`, the filesystem root, …). A project-root search that climbs to
 * such a directory has escaped the user's workspace — walking down from it
 * scans unrelated trees (the #250 runaway). Use this as the single shared
 * ceiling on any upward project-root resolution, instead of an exact
 * `=== os.homedir()` check (which a marker found *above* `$HOME` slips past).
 * A normal project *under* home (e.g. `~/code/app`) is NOT at-or-above home,
 * so it still resolves fine. Refs #253.
 *
 * ONE expression, deliberately: `path.relative` alone answers "is home inside
 * `dir`, or the same directory as `dir`", and it answers with the PLATFORM's
 * path-equality semantics — case-folding on win32, case-sensitive on POSIX.
 * The `resolvedDir === resolvedHome` shortcut that used to precede it was
 * case-SENSITIVE on every platform, so `c:\Users\jane` (the lowercase-drive
 * form VS Code URIs produce, and the form 46 records in a real `latency.log`
 * carry) missed the equality test AND was then rejected by a `rel !== ""`
 * clause — reporting "not at home" for the home directory itself and letting
 * every ceilinged walker climb straight past HOME (#2544 review F1).
 *
 *   rel === ""                       ⇢ `dir` IS home
 *   rel relative, no leading `..`    ⇢ home is INSIDE `dir` (an ancestor)
 *   rel starts with `..`             ⇢ home is elsewhere — sibling, or the
 *                                      prefix trap `C:\Users\jane2` → home
 *                                      `C:\Users\jane` gives `..\jane`
 *   rel absolute                     ⇢ different Windows drive
 *
 * Same shape as `isUnderDir` above; keep the two in step.
 *
 * `pathImpl` exists so the ubuntu Unit tests lane — the authoritative one —
 * can exercise the WIN32 semantics this helper's whole bug was about. Every
 * assertion that matters here (drive-letter folding, cross-drive `rel`) is
 * win32-only, so with the ambient `path` hardcoded the ceiling was enforced
 * only on a maintainer's dev box and CI's diff was structurally zero (#2544
 * review F2). Production never passes it; `path.win32`/`path.posix` are pure,
 * host-independent implementations, so `tests/clients/path-utils.test.ts` runs
 * the same table under both on every lane. Lane-level fix tracked as #2536.
 */
export function isAtOrAboveHomeDir(
	dir: string,
	homeDir: string = os.homedir(),
	pathImpl: typeof path = path,
): boolean {
	const rel = pathImpl.relative(
		pathImpl.resolve(dir),
		pathImpl.resolve(homeDir),
	);
	return !rel.startsWith("..") && !pathImpl.isAbsolute(rel);
}

/**
 * Rewrite a `$HOME`-anchored path to its `~` form for a DIAGNOSTIC surface.
 *
 * `~/.pi-lens/config.json` says everything an operator needs about which file
 * won, and `C:/Users/jane.doe/.pi-lens/config.json` says that plus the
 * account name. The second is the shape a global config path always has, so any
 * projection that names one leaks an identifier by default rather than by
 * accident (#2440 review finding F5).
 *
 * Deliberately NOT built on `normalizeFilePath`/`isUnderDir`: those resolve
 * through `realpathSync`, and a redaction helper on a diagnostic path must be
 * pure, total, and unable to throw for a file that no longer exists. This is a
 * string rewrite and nothing else.
 *
 * A path that is not under home is returned UNCHANGED — separators included.
 * Normalizing unrelated paths on the way past would make the helper's blast
 * radius every path any projection ever carries, for no redaction benefit.
 */
export function homeRelativePath(
	filePath: string,
	homeDir: string = os.homedir(),
): string {
	if (filePath.length === 0) return filePath;
	const candidate = toPosix(filePath);
	const home = toPosix(homeDir).replace(/\/+$/, "");
	if (home.length === 0) return filePath;
	// Windows paths are case-insensitive, so the COMPARISON folds case there
	// while the returned tail keeps the caller's own casing.
	const fold = (text: string): string =>
		process.platform === "win32" ? text.toLowerCase() : text;
	const foldedHome = fold(home);
	const foldedCandidate = fold(candidate);
	if (foldedCandidate === foldedHome) return "~";
	if (!foldedCandidate.startsWith(`${foldedHome}/`)) return filePath;
	return `~${candidate.slice(home.length)}`;
}

export function isUnderDir(child: string, parent: string): boolean {
	const normChild = normalizeFilePath(child);
	const normParent = normalizeFilePath(parent);
	// Ensure parent ends with / for prefix matching
	const parentPrefix = normParent.endsWith("/") ? normParent : `${normParent}/`;
	return normChild === normParent || normChild.startsWith(parentPrefix);
}

const VENDOR_DIR_NAMES = new Set([
	"node_modules",
	"vendor",
	"vendors",
	"third_party",
	"third-party",
]);

/**
 * Returns true when a file should be treated as external/vendor and excluded
 * from pipelines (LSP, diagnostics, complexity, read-guard, etc.).
 *
 * Cases:
 *   1. Outside the project root entirely (e.g. global npm packages, system files)
 *   2. Inside the project but under a vendor directory (node_modules, vendor, third_party, etc.)
 */
export function isExternalOrVendorFile(
	filePath: string,
	projectRoot: string,
): boolean {
	if (!isUnderDir(filePath, projectRoot)) return true;
	const normalized = normalizeFilePath(filePath);
	const rootNorm = normalizeFilePath(projectRoot);
	const rel = normalized.startsWith(rootNorm + "/")
		? normalized.slice(rootNorm.length + 1)
		: normalized;
	return rel.split("/").some((seg) => VENDOR_DIR_NAMES.has(seg));
}

/**
 * Shared marker-glob semantics for every "does this directory contain a file
 * matching this glob" probe (#895 review): match against the entry NAME only,
 * `dot: true` so dotfile markers match, `nocase` on win32 to match the
 * filesystem (and the project ignore matcher). The three marker probes —
 * language-profile.ts `hasProjectMarker`, workspace-topology.ts
 * `hasBasenameMarker`, lsp/server.ts `markerExists` — must all route their
 * glob matching through here rather than call minimatch with hand-copied
 * options.
 */
export function nameMatchesMarkerGlob(name: string, pattern: string): boolean {
	return minimatch(name, pattern, {
		dot: true,
		nocase: process.platform === "win32",
	});
}

/**
 * Files/symlinks-only marker-glob probe over a directory listing — a
 * *directory* named like a marker (e.g. a `Foo.csproj/` dir) is not a project
 * file (#201).
 */
export function direntsHaveMarkerGlobMatch(
	entries: readonly Dirent[],
	pattern: string,
): boolean {
	return entries.some(
		(entry) =>
			(entry.isFile() || entry.isSymbolicLink()) &&
			nameMatchesMarkerGlob(entry.name, pattern),
	);
}

/**
 * The axes on which build tools' workspace-MEMBER glob dialects genuinely
 * diverge (#2591). Every "does this workspace declare this directory as a
 * member" matcher in `clients/` routes through
 * {@link matchesWorkspaceMemberPattern} with one of the dialect constants
 * below rather than hand-rolling its own segment regex or minimatch options
 * block — the same single-source-of-truth rule `nameMatchesMarkerGlob` holds
 * for marker globs.
 *
 * Two axes deliberately do NOT appear here because every dialect agrees on
 * them, and a field with one value across every constant is configuration
 * that can never be wrong:
 *
 * - **Case sensitivity.** Cargo's pre-fold segment regex carried no `i` flag;
 *   uv matches with `MatchOptions { case_sensitive: true, .. }` on every
 *   platform (`MatchOptions::new()`'s default, kept by `is_included_in_workspace`).
 *   Matching is unconditionally case-SENSITIVE here, on Windows too.
 * - **Leading dots.** Cargo's pre-fold `*` compiled to `[^/]*`, which matches a
 *   leading `.` like any other character; uv passes `require_literal_leading_dot:
 *   false` (again the `MatchOptions::new()` default), which pi-lens expressed as
 *   minimatch's `dot: true`. A `*` matches `.hidden` in every dialect.
 *
 * If a fourth dialect ever disagrees on either, it becomes a field then — not
 * before.
 */
export interface WorkspaceMemberGlobDialect {
	/** Dialect name, for the dialect table in `tests/clients/path-utils.test.ts`. */
	readonly name: string;
	/**
	 * `crosses-components`: a path component that is exactly `**` matches zero
	 * or more path components (a TRAILING `/**` requires at least one, matching
	 * minimatch and rust `glob`). `pattern-never-matches`: a pattern containing
	 * `**` anywhere matches nothing at all.
	 */
	readonly globstar: "crosses-components" | "pattern-never-matches";
	/**
	 * Whether `*`/`?` may span a `/` — rust `glob`'s `require_literal_separator:
	 * false`. When false (the common case) a wildcard is confined to one path
	 * component, which is also what makes a pattern's component COUNT have to
	 * equal the path's: `crates/*` cannot reach `crates/a/b` because `[^/]*`
	 * cannot cross the separator. Component-count equality is therefore an
	 * entailment of this axis, not a separate one — see the dialect table's
	 * `segment-count mismatch` vectors, which red if `[^/]*` is widened.
	 */
	readonly wildcardCrossesSeparator: boolean;
	/** Whether `[abc]`/`[!abc]` is a character class or a literal bracket run. */
	readonly characterClasses: boolean;
	/** Tool-specific pattern normalization, applied before compilation. */
	readonly normalizePattern: (pattern: string) => string;
}

/**
 * Cargo `[workspace] members`/`exclude` entries.
 *
 * KNOWN LIMITATION (#1671 F6, documented rather than implemented, preserved
 * byte-for-byte by #2591's fold): a recursive `**` component is NOT supported
 * and a pattern containing one never matches — cargo workspaces that rely on
 * `**` to pull in an arbitrarily-nested crate tree under-hoist (the crate stays
 * independently rooted instead of joining the workspace). Folding cargo onto
 * uv's `crosses-components` globstar would silently change Rust-LSP root
 * selection, so the divergence is kept as a dialect value, not resolved.
 *
 * `characterClasses: false` is likewise a preserved divergence, not a
 * considered choice: cargo's pre-fold segment compiler escaped `[` and `]`
 * into literals, so `crates/[ab]` names a directory literally called `[ab]`.
 * Real cargo (the `glob` crate) would read it as a class; changing that here
 * would be the same unreviewed Rust-hoisting change.
 */
export const CARGO_WORKSPACE_MEMBER_DIALECT: WorkspaceMemberGlobDialect = {
	name: "cargo",
	globstar: "pattern-never-matches",
	wildcardCrossesSeparator: false,
	characterClasses: false,
	normalizePattern: (pattern) => pattern.replace(/\/+$/, ""),
};

/**
 * uv `[tool.uv.workspace] members`, pinned to
 * `astral-sh/uv@3c979abda4530fe9bf3d92e9bcf5c5575e3b3126`,
 * `crates/uv-workspace/src/workspace.rs` `is_included_in_workspace`: the glob is
 * `normalize_path`d first (so a leading `./` and any interior `.` component are
 * not part of the pattern) and matched with
 * `MatchOptions { require_literal_separator: true, ..MatchOptions::new() }`.
 */
export const UV_WORKSPACE_MEMBERS_DIALECT: WorkspaceMemberGlobDialect = {
	name: "uv-members",
	globstar: "crosses-components",
	wildcardCrossesSeparator: false,
	characterClasses: true,
	normalizePattern: (pattern) => path.posix.normalize(toPosix(pattern)),
};

/**
 * uv `[tool.uv.workspace] exclude`, same upstream file and SHA
 * (`WorkspaceExclusions::matches`): an exclusion is matched with
 * `Pattern::matches_path`, i.e. `MatchOptions::new()` defaults, where
 * `require_literal_separator` is FALSE — so a `*` in an exclusion DOES cross
 * `/` (`exclude = ['packages/a*c']` excludes `packages/a/b/c`). Two different
 * option sets inside one tool, which is why the dialect is an object and the
 * two uv constants are not one.
 *
 * Before #2591 this was a documented limitation: minimatch cannot express a
 * separator-crossing `*`, so pi-lens under-excluded. The dialect object can, so
 * it is now implemented rather than documented.
 */
export const UV_WORKSPACE_EXCLUDE_DIALECT: WorkspaceMemberGlobDialect = {
	name: "uv-exclude",
	globstar: "crosses-components",
	wildcardCrossesSeparator: true,
	characterClasses: true,
	normalizePattern: (pattern) => path.posix.normalize(toPosix(pattern)),
};

/**
 * Index of the `]` closing the character class opened at `open`, or `-1` when
 * the run is unterminated (in which case the `[` is a literal). A leading `!`
 * or `^` negates, and a `]` in first position is a literal class member — the
 * shape both minimatch and rust `glob` accept.
 */
function findCharacterClassEnd(segment: string, open: number): number {
	let i = open + 1;
	if (segment[i] === "!" || segment[i] === "^") i += 1;
	if (segment[i] === "]") i += 1;
	for (; i < segment.length; i += 1) if (segment[i] === "]") return i;
	return -1;
}

/**
 * One step of a compiled workspace-member pattern. Every step consumes a
 * BOUNDED amount of the path (one character, or one character at a time under
 * its own repeat), which is what makes the evaluator below non-backtracking:
 * there is no nested quantifier for a backtracking engine to explore.
 *
 * - `literal` — this exact code unit, `/` included.
 * - `one` / `star` — a `?` / `*`, consuming one / any number of characters
 *   that {@link stepAcceptsChar} admits.
 * - `class` — a `[abc]`/`[!abc]` run, compiled to a one-character regex. This
 *   is the only compiled regex left in the matcher, and it is bounded by
 *   construction: one class, no quantifier, tested against a one-character
 *   string.
 * - `split` — an epsilon fork: match from `alternative`, or from the next
 *   step. Only a `**` emits one, to express "zero or more whole components".
 */
type WorkspaceGlobStep =
	| { readonly kind: "literal"; readonly char: string }
	| { readonly kind: "one"; readonly crossesSeparator: boolean }
	| { readonly kind: "star"; readonly crossesSeparator: boolean }
	| { readonly kind: "class"; readonly match: RegExp }
	| WorkspaceGlobSplit;

/** The one mutable step: `alternative` is back-patched once the group it skips is emitted. */
interface WorkspaceGlobSplit {
	readonly kind: "split";
	alternative: number;
}

/**
 * May a wildcard with this separator policy consume `ch`?
 *
 * A separator-confined wildcard (`[^/]` in the regex this replaced) takes
 * anything but `/`. A separator-CROSSING one — uv `exclude`'s `*`/`?`, and
 * every `**` in either uv dialect — spelled `.` in that regex, which is every
 * code unit EXCEPT the four line terminators. That exclusion is preserved
 * deliberately rather than "fixed": minimatch's globstar is `.`-based too, so
 * a `\n` inside a directory name has never matched across a `**` in either
 * implementation, and the differential oracle would flag a change here as a
 * divergence rather than an improvement (#2603).
 */
function stepAcceptsChar(crossesSeparator: boolean, ch: string): boolean {
	return crossesSeparator
		? ch !== "\n" && ch !== "\r" && ch !== "\u2028" && ch !== "\u2029"
		: ch !== "/";
}

/**
 * Compile a normalized workspace-member pattern into a step list, or
 * `undefined` when it cannot be compiled at all.
 *
 * A `**` component consumes zero or more path components — except as the LAST
 * component, where it requires at least one (`a/**` matches `a/b`, not `a`),
 * reproducing both minimatch's and rust `glob`'s answer. It is emitted as
 * `split → one → star → literal "/"`, i.e. "nothing, or one-or-more characters
 * followed by the `/` that ends them", after the separator that precedes it.
 * That is the same language as the `(?:/.+)?/` group the previous compiler
 * emitted — `X(?:/.+)?/Y` and `X/(?:.+/)?Y` both denote `X/Y` ∪ `X/.+/Y` — in a
 * form with no nested quantifier.
 */
function compileWorkspaceMemberPattern(
	pattern: string,
	dialect: WorkspaceMemberGlobDialect,
): WorkspaceGlobStep[] | undefined {
	const isGlobstar = (component: string): boolean =>
		component === "**" && dialect.globstar === "crosses-components";
	const components = pattern.split("/");
	const steps: WorkspaceGlobStep[] = [];
	let needSeparator = false;
	for (let c = 0; c < components.length; c += 1) {
		if (needSeparator) steps.push({ kind: "literal", char: "/" });
		needSeparator = false;
		const component = components[c];
		if (isGlobstar(component)) {
			if (c === components.length - 1) {
				// `.+` — a trailing `**` requires at least one character.
				steps.push({ kind: "one", crossesSeparator: true });
				steps.push({ kind: "star", crossesSeparator: true });
				continue;
			}
			// `(?:.+/)?` — zero or more whole components. The group already ends
			// at a `/`, so the next component must NOT emit one.
			const split: WorkspaceGlobSplit = { kind: "split", alternative: -1 };
			steps.push(split);
			steps.push({ kind: "one", crossesSeparator: true });
			steps.push({ kind: "star", crossesSeparator: true });
			steps.push({ kind: "literal", char: "/" });
			split.alternative = steps.length;
			continue;
		}
		for (let i = 0; i < component.length; i += 1) {
			const ch = component[i];
			if (ch === "*") {
				steps.push({
					kind: "star",
					crossesSeparator: dialect.wildcardCrossesSeparator,
				});
				continue;
			}
			if (ch === "?") {
				steps.push({
					kind: "one",
					crossesSeparator: dialect.wildcardCrossesSeparator,
				});
				continue;
			}
			if (ch === "[" && dialect.characterClasses) {
				const close = findCharacterClassEnd(component, i);
				if (close !== -1) {
					// `\` and a first-position `]` are literal class MEMBERS in glob;
					// left alone they would be a regex escape and an empty-class
					// terminator (`[]ab]` is `[]` + `ab]` in JS), so both are escaped.
					const body = component.slice(i + 1, close).replace(/[\\\]]/g, "\\$&");
					const source = body.startsWith("!")
						? `[^${body.slice(1)}]`
						: `[${body}]`;
					let match: RegExp;
					try {
						match = new RegExp(`^${source}$`);
					} catch {
						// A glob character class is not a JS character class: `[z-a]`
						// is a legal glob (matching nothing, since the range is empty)
						// and an illegal RegExp ("Range out of order"). Fail CLOSED —
						// an uncompilable pattern declares no member and excludes
						// nothing — which is also the answer the deleted minimatch call
						// gave (#2591 review round 2, F2).
						return undefined;
					}
					steps.push({ kind: "class", match });
					i = close;
					continue;
				}
			}
			steps.push({ kind: "literal", char: ch });
		}
		needSeparator = true;
	}
	return steps;
}

/**
 * Does the whole of `subject` match the whole of `steps`?
 *
 * A memoized (step index, path index) table, filled once, bottom-up:
 * `table[s][p]` is "steps `s…` match `subject[p…]`". Every cell reads only
 * cells with a larger step index or a larger path index, so one backward
 * double loop fills the table with no recursion and no re-entry — the match is
 * O(steps x characters) in time and space, with no path through it that can
 * take exponential time (#2603).
 *
 * The compiled whole-path regex this replaced was correct but backtracking:
 * every `**` emitted its own nullable `.+`, and N of them explored 2^N splits
 * of a non-matching subject. #2591 collapsed CONSECUTIVE `**`s, which is a
 * normalization that cannot fire across a separating component, so
 * `("**\/*" x12)/zzz` against a 40-component path still took 124900 ms (#2603);
 * the same shapes are microseconds here. There is nothing left to collapse for
 * speed, so no collapse is done: `a/**\/**\/b` compiles to two adjacent
 * `(?:.+/)?` groups, which denote the same language as one and cost the same
 * table.
 */
function matchesWorkspaceMemberSteps(
	steps: readonly WorkspaceGlobStep[],
	subject: string,
): boolean {
	const stepCount = steps.length;
	const width = subject.length + 1;
	// One byte per (step, position) cell; `1` means "the rest matches from here".
	const table = new Uint8Array((stepCount + 1) * width);
	for (let p = subject.length; p >= 0; p -= 1) {
		const atEnd = p === subject.length;
		// The empty step list matches only the empty remainder.
		table[stepCount * width + p] = atEnd ? 1 : 0;
		for (let s = stepCount - 1; s >= 0; s -= 1) {
			const step = steps[s];
			const next = (s + 1) * width;
			let matched = 0;
			switch (step.kind) {
				case "literal":
					matched =
						!atEnd && subject[p] === step.char ? table[next + p + 1] : 0;
					break;
				case "one":
					matched =
						!atEnd && stepAcceptsChar(step.crossesSeparator, subject[p])
							? table[next + p + 1]
							: 0;
					break;
				case "class":
					matched =
						!atEnd && step.match.test(subject[p]) ? table[next + p + 1] : 0;
					break;
				case "star":
					// Consume nothing, or one more character and stay on this step.
					matched =
						table[next + p] === 1 ||
						(!atEnd &&
							stepAcceptsChar(step.crossesSeparator, subject[p]) &&
							table[s * width + p + 1] === 1)
							? 1
							: 0;
					break;
				case "split":
					matched =
						table[step.alternative * width + p] === 1 || table[next + p] === 1
							? 1
							: 0;
					break;
			}
			table[s * width + p] = matched;
		}
	}
	return table[0] === 1;
}

/**
 * Does `relativePath` — a `/`-separated path relative to the workspace root —
 * match one declared workspace-member (or workspace-exclude) `pattern` under
 * `dialect`?
 *
 * This is the ONE workspace-member matcher (#2591). `clients/lsp/server.ts`'s
 * `cargoWorkspaceDeclaresMember` and `clients/python-environment.ts`'s
 * `isUvWorkspaceMember` are thin callers of it; neither keeps a private segment
 * compiler or minimatch options block any more.
 *
 * `clients/review-graph/workspace-modules.ts`'s `expandWorkspacePattern` is
 * deliberately NOT a caller: npm/pnpm `workspaces` entries are EXPANDED against
 * the filesystem (one `readdir` of the directory preceding the first `*`,
 * yielding the directories that exist and hold a manifest) rather than tested
 * against a candidate path. It answers "which directories does this pattern
 * name", not "does this pattern name this directory"; folding it in would mean
 * giving this pure function a filesystem.
 *
 * The supported syntax is the intersection of the two upstream dialects: `*`,
 * `?`, `**`, `[abc]`/`[!abc]` (dialect-gated), and literals. minimatch-only
 * extensions the pre-fold uv path inherited by accident — brace expansion,
 * extglobs, leading-`!` negation, leading-`#` comments — are NOT honored, and
 * uv's own `glob` crate does not honor them either (same pinned SHA), so
 * dropping them moves uv toward upstream rather than away from it.
 *
 * Matching is NON-BACKTRACKING (#2603): the pattern compiles to a list of
 * bounded steps and {@link matchesWorkspaceMemberSteps} decides it with one
 * memoized (step, position) table, O(steps x characters), no matter how many
 * `**`s the pattern carries. The anchored whole-path regex this replaced was
 * correct but explored 2^N splits of a non-matching path for N `**`
 * components — 124900 ms for `("**\/*" x12)/zzz` against a 40-component path,
 * on a call `detectPythonEnvironment` awaits with no timeout, i.e. a wedged
 * turn rather than a slow answer. The wall-clock half of that fix lives in
 * `tests/clients/workspace-glob-nonbacktracking-budget.test.ts`; the answers
 * are unchanged, pinned by the dialect table and the minimatch differential in
 * `tests/clients/path-utils.test.ts`.
 *
 * A pattern that cannot be compiled at all answers `false` for every path —
 * it declares no member and excludes nothing (#2591 review round 2, F2). The
 * only such patterns today carry an empty character-class range (`[z-a]`:
 * legal glob, illegal JS RegExp). Reachability note, recorded rather than
 * assumed away: no such pattern can reach here through a manifest right now,
 * because `parseTomlStringArray` (`clients/cargo-manifest.ts`) captures an
 * array body non-greedily up to the FIRST `]`, so any entry containing a `]`
 * loses its closing quote and is dropped before it becomes a pattern. That is
 * a property of the TOML reader, not of this matcher, and it is not this
 * function's to rely on — the character-class axis stays because upstream
 * cargo and uv both support classes, and the reader's gap may be closed later.
 */
export function matchesWorkspaceMemberPattern(
	pattern: string,
	relativePath: string,
	dialect: WorkspaceMemberGlobDialect,
): boolean {
	const normalized = dialect.normalizePattern(pattern);
	if (
		dialect.globstar === "pattern-never-matches" &&
		normalized.includes("**")
	) {
		return false;
	}
	const steps = compileWorkspaceMemberPattern(normalized, dialect);
	return (
		steps !== undefined && matchesWorkspaceMemberSteps(steps, relativePath)
	);
}

/**
 * Narrow no-break space, U+202F. macOS writes it before AM/PM in screenshot
 * file names; users type an ordinary space.
 */
const NARROW_NO_BREAK_SPACE = "\u202F";
/** Right single quotation mark, U+2019. macOS writes it; users type U+0027. */
const RIGHT_SINGLE_QUOTE = "\u2019";

/**
 * The unicode space class pi folds to U+0020, copied character-for-character
 * from `@earendil-works/pi-coding-agent/dist/utils/paths.js:6`
 * (`UNICODE_SPACES`, source `src/utils/paths.ts`). Widening or narrowing this
 * set makes pi-lens resolve a different file than pi does.
 */
const HOST_UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * Mirror pi's `normalizeWindowsShellPath`
 * (`@earendil-works/pi-coding-agent/dist/utils/paths.js:47-56`): convert Git
 * Bash, MSYS, Cygwin, and WSL drive paths to a form native Windows APIs
 * accept.
 */
function hostNormalizeWindowsShellPath(filePath: string): string {
	if (
		!filePath.startsWith("/") ||
		filePath.startsWith("//") ||
		filePath.includes("\\")
	) {
		return filePath;
	}
	const match = filePath.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
	if (!match) return filePath;
	const suffix = match[2]?.replaceAll("/", "\\");
	return `${match[1].toUpperCase()}:\\${suffix ?? ""}`;
}

interface HostNormalizeOptions {
	/** Fold the unicode space class to U+0020. */
	normalizeUnicodeSpaces?: boolean;
	/** Drop a single leading `@` (pi's file-mention prefix). */
	stripAtPrefix?: boolean;
}

/**
 * Mirror pi's `normalizePath`
 * (`@earendil-works/pi-coding-agent/dist/utils/paths.js:57-79`, source
 * `src/utils/paths.ts`), in pi's order, which is load-bearing: the unicode
 * fold runs BEFORE the `@` strip, and the tilde expansion before the
 * `file://` conversion.
 *
 * The `win32` step is gated on `process.platform`, exactly as pi gates it.
 * This is a deliberate exception to the usual probe-the-filesystem rule
 * (AGENTS.md shape 2): pi-lens runs in pi's own process, so mirroring the
 * host's own platform branch is what keeps the two resolvers in agreement.
 * Shape-based parsing here would DIVERGE from the host, not protect against
 * it.
 */
export function normalizeHostToolPath(
	input: string,
	options: HostNormalizeOptions = {},
): string {
	let normalized = input;
	if (options.normalizeUnicodeSpaces) {
		normalized = normalized.replace(HOST_UNICODE_SPACES, " ");
	}
	if (options.stripAtPrefix && normalized.startsWith("@")) {
		normalized = normalized.slice(1);
	}
	if (process.platform === "win32") {
		normalized = hostNormalizeWindowsShellPath(normalized);
	}
	// `homedir()` is resolved inside the branch, as pi does. This runs on every
	// tool_call and a `~` path is the rare case.
	if (normalized === "~") return os.homedir();
	if (
		normalized.startsWith("~/") ||
		(process.platform === "win32" && normalized.startsWith("~\\"))
	) {
		return path.join(os.homedir(), normalized.slice(2));
	}
	if (normalized.startsWith("file://")) {
		try {
			return fileURLToPath(normalized);
		} catch {
			// pi lets a malformed file: URL throw out of normalizePath, but pi-lens
			// is advisory instrumentation on the same event: a URL pi rejects must
			// degrade to "no path" here, never take down the tool_call handler.
			return normalized;
		}
	}
	return normalized;
}

/**
 * Mirror pi's `resolveToCwd`
 * (`@earendil-works/pi-coding-agent/dist/core/tools/path-utils.js:42-44`,
 * source `src/core/tools/path-utils.ts:~44-46`) \u2014 the BASE resolution every
 * read/edit/write path goes through before the variant ladder below ever
 * runs.
 *
 * Two details are pi's, not ours, and both matter:
 *   - the input is normalized with `normalizeUnicodeSpaces` + `stripAtPrefix`;
 *     the BASE DIR is normalized with neither (`resolvePath`,
 *     `dist/utils/paths.js:80-84`).
 *   - an already-absolute input is re-resolved on its own, ignoring the cwd.
 */
export function resolveHostToolPath(input: string, baseDir: string): string {
	const normalized = normalizeHostToolPath(input, {
		normalizeUnicodeSpaces: true,
		stripAtPrefix: true,
	});
	const normalizedBaseDir = normalizeHostToolPath(baseDir);
	return path.isAbsolute(normalized)
		? path.resolve(normalized)
		: path.resolve(normalizedBaseDir, normalized);
}

export interface HostPathVariantResolution {
	/** The path to use: the first variant that exists, else the naive resolve. */
	path: string;
	/** Set when a VARIANT matched — `path` differs from the naive resolve. */
	variant?: "narrow-nbsp" | "nfd" | "curly-quote" | "nfd-curly-quote";
	/**
	 * The naive resolve did not exist and no variant did either. Distinct from
	 * "the naive resolve existed": callers that expect the file to be there use
	 * this to record a `path-variant-unresolved` degradation instead of
	 * returning silently (defect shape 10 — an empty result must say WHY).
	 */
	unresolved: boolean;
	/**
	 * Variant labels actually probed. Empty when the base resolve existed — and
	 * ALSO empty when every candidate collapsed onto the base path (a plain
	 * ASCII name with no quote and no AM/PM). Callers must therefore gate a
	 * degradation on `unresolved`, never on this being non-empty: the
	 * all-candidates-identical miss is a real miss, and gating it away is how
	 * the base-normalization cases went silent (#1655 review F1).
	 */
	triedVariants: string[];
}

/**
 * Mirror pi's read-path fallback ladder (#1655 item 5).
 *
 * pi does NOT open `resolve(cwd, input.path)`. `resolveReadPath`
 * (`@earendil-works/pi-coding-agent/dist/core/tools/path-utils.js:45-70`,
 * source `src/core/tools/path-utils.ts:52-83`) resolves, and when that path
 * does not exist it silently retries four unicode/spacing variants in this
 * exact order:
 *
 *   1. narrow no-break space before `AM.`/`PM.` (`tryMacOSScreenshotPath`)
 *   2. NFD normalization (`tryNFDVariant`) — macOS stores names decomposed
 *   3. U+0027 → U+2019 (`tryCurlyQuoteVariant`)
 *   4. NFD + curly quote combined
 *
 * Each candidate is used only when it DIFFERS from the resolved path and the
 * file exists; otherwise pi falls back to the resolved path. So the file pi
 * actually read can differ from what a naive `path.resolve` produces, and
 * pi-lens keyed its read guard, LSP touch, and dispatch off the naive form —
 * silently doing nothing for exactly those files.
 *
 * Order matters: it is pi's, so pi-lens picks the same file pi did when more
 * than one variant happens to exist.
 *
 * @param resolvedPath an already-resolved absolute path (the naive form)
 * @param fileExists injectable existence probe; defaults to `existsSync`
 */
export function resolveHostPathVariants(
	resolvedPath: string,
	fileExists: (candidate: string) => boolean = existsSync,
): HostPathVariantResolution {
	if (fileExists(resolvedPath)) {
		return { path: resolvedPath, unresolved: false, triedVariants: [] };
	}

	const nfd = resolvedPath.normalize("NFD");
	const candidates: Array<{
		variant: NonNullable<HostPathVariantResolution["variant"]>;
		candidate: string;
	}> = [
		{
			variant: "narrow-nbsp",
			candidate: resolvedPath.replace(
				/ (AM|PM)\./gi,
				`${NARROW_NO_BREAK_SPACE}$1.`,
			),
		},
		{ variant: "nfd", candidate: nfd },
		{
			variant: "curly-quote",
			candidate: resolvedPath.replaceAll("'", RIGHT_SINGLE_QUOTE),
		},
		{
			variant: "nfd-curly-quote",
			candidate: nfd.replaceAll("'", RIGHT_SINGLE_QUOTE),
		},
	];

	const triedVariants: string[] = [];
	for (const { variant, candidate } of candidates) {
		// pi skips a candidate identical to the resolved path, so pi-lens does
		// too — otherwise a no-op "variant" would be reported as a match.
		if (candidate === resolvedPath) continue;
		triedVariants.push(variant);
		if (fileExists(candidate)) {
			return { path: candidate, variant, unresolved: false, triedVariants };
		}
	}

	return { path: resolvedPath, unresolved: true, triedVariants };
}
