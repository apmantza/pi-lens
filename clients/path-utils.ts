/**
 * Path utilities for pi-lens
 *
 * Handles cross-platform path normalization, particularly
 * Windows case-insensitivity issues when using paths as Map keys.
 *
 * Approach (inspired by OpenCode's Filesystem.normalizePath):
 * - On Windows: try realpathSync.native() for canonical casing
 * - Falls back to lowercase for files that don't exist yet
 * - On non-Windows: an absolute path keys by its path identity, the
 *   kernel-real path of the file or of its nearest existing ancestor plus the
 *   missing tail (#4689; this also carries the on-disk casing, #3098); a
 *   relative path folds dot segments and adopts on-disk casing only
 * - Always convert backslashes to forward slashes for Map key consistency
 */

import {
	type Dirent,
	existsSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import {
	lstat as lstatAsync,
	realpath as realpathNativeAsync,
} from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BoundedFifoMap } from "./bounded-cache.js";
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
 * Adopt `canonical`'s CASING for the trailing segments of `held`, stopping at
 * the first segment that differs by more than case.
 *
 * `realpathSync.native` answers a different question than the one the POSIX
 * arm of `normalizeFilePath` asks: it resolves symlinks AND reports on-disk
 * casing, and we want only the second half. Walking from the tail and halting
 * at the first structural divergence separates them with no extra syscall:
 *
 *   held      /var/folders/T/x/SUB/a.ts   (macOS tmpdir, mis-cased segment)
 *   canonical /private/var/folders/T/x/sub/a.ts
 *   result    /var/folders/T/x/sub/a.ts   (case fixed, symlink prefix kept)
 *
 * Only a RELATIVE spelling reaches this (#4689): an absolute one keys by its
 * path identity, the kernel's own answer, which already carries the on-disk
 * casing. A relative spelling is not an identity, so it keeps the caller's
 * prefix and only its casing moves (refs #2490 — a cwd fold for its own sake
 * broke every monorepo).
 *
 * PURE string algebra: this pins what the rewrite DOES, never what the kernel
 * reports — and from two strings alone it cannot tell "the same file, spelled
 * with different case" from "a different file whose name happens to be a case
 * variant". Any symlink whose BASENAME is a case variant of its target's
 * basename (`<root>/MyProject` → `work/myproject`, `node_modules/Foo` →
 * `../pkgs/foo`) has its name replaced while its own parent is kept, so the
 * result names a different place — or no place at all. Measured in #3159
 * review round 2 (F1): two different inodes collapsed onto ONE key (the #1024
 * defect inverted — false suppression), and a symlinked package keyed under a
 * path that does not exist on disk, breaking the #2490 bound above. The caller
 * therefore CONFIRMS every rewrite against the filesystem before adopting it
 * (see `normalizeFilePath`); do not use this function without that step.
 */
function adoptCanonicalCasing(held: string, canonical: string): string {
	const heldParts = held.split("/");
	const realParts = canonical.split("/");
	let i = heldParts.length - 1;
	let j = realParts.length - 1;
	let changed = false;
	while (i >= 0 && j >= 0) {
		const a = heldParts[i] as string;
		const b = realParts[j] as string;
		if (a !== b) {
			if (a.toLowerCase() !== b.toLowerCase()) break;
			heldParts[i] = b;
			changed = true;
		}
		i--;
		j--;
	}
	// Identity-preserving when nothing moved — this runs on every POSIX map-key
	// derivation and the overwhelmingly common answer is "already canonical".
	// NOT a behavioural branch (both arms produce an equal string): it is the
	// same allocation guard `normalizeEphemeralMapKey` documents below.
	return changed ? heldParts.join("/") : held;
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
 * On POSIX:
 * - An ABSOLUTE path returns its **path identity** (#4689): the kernel-real
 *   path. An existing path is `realpath(3)` of the spelling itself, so a file
 *   link, a directory link, an alias root and the on-disk casing all resolve
 *   in one call, and every spelling of one file derives one key. A missing
 *   path is the `realpath` of its nearest existing ancestor joined with the
 *   missing tail, which stays case-PRESERVING: on a case-sensitive filesystem
 *   `SUB/a.ts` and `sub/a.ts` are two different files, and nothing on disk can
 *   say which one a missing spelling means. The kernel resolves `..`
 *   physically (`<dir-link>/..` is the link target's parent), so no lexical
 *   fold runs before it; only the missing tail is folded. A spelling no
 *   ancestor of which resolves keeps its `path.posix.normalize` form.
 * - A RELATIVE path is not an identity (as in the win32 arm): it folds `.`,
 *   `..` and duplicate separators as string algebra and adopts the on-disk
 *   CASING of its trailing segments (`adoptCanonicalCasing`), and is never
 *   resolved against `process.cwd()` (refs #2490, where a cwd fold broke every
 *   monorepo). #3184 is why it folds: a casing-only rewrite cannot express a
 *   string with fewer segments, so `src/../src/a.ts` used to come back
 *   unfolded as an orphan key.
 *
 * Before #4689 the POSIX arm computed the same `realpath` on every call and
 * discarded it, keeping the caller's link spelling, so one inode carried one
 * key per spelling (split widget records, a stale blocker under the link after
 * a fix through the target, cross-spelling read-guard refusals).
 *
 * Why POSIX canonicalizes casing at all (#3098, the #1024 defect's live half):
 * a case-insensitive POSIX filesystem — macOS's default APFS, `nocase` vfat /
 * ntfs3 / cifs mounts — makes `SUB/a.ts` and `sub/a.ts` ONE file, so a raw
 * mis-cased write (`lens_diagnostic_mark` anchors under `path.resolve(cwd,
 * arg)`) and a `normalizeMapKey` read derived two anchors for one file and the
 * agent's own disposition mark silently never applied. A case-preserving POSIX
 * arm cannot close that: the two keys only become one if the normalizer asks
 * the filesystem which name is really on disk.
 *
 * `realpathSync.native` is `realpath(3)`. On Darwin it rebuilds every
 * component from the filesystem's own `ATTR_CMN_NAME` — Libc-1669.0.4
 * `stdlib/FreeBSD/realpath.c:233` (`getattrlist(resolved, &_rp_alist, …,
 * FSOPT_NOFOLLOW)` with `ATTR_CMN_NAME`) and `:348-354` ("attrs already has
 * the real name") — which is why it returns on-disk casing on APFS/HFS+.
 * MEASURED counter-example (#3098): a Linux ext4/tmpfs `chattr +F` casefold
 * directory aliases the two spellings but `realpath(3)` there returns the
 * spelling the caller asked with, so this arm is a no-op on casefolded Linux
 * directories — filed with the transcript as #3154.
 *
 * Always converts backslashes to forward slashes for consistent Map keys.
 */
export function normalizeFilePath(filePath: string): string {
	return normalizePathForm(filePath, true);
}

/**
 * The pre-#4689 POSIX form: dot segments folded and on-disk casing adopted,
 * the caller's link spelling KEPT (the win32 arm is unchanged and resolves).
 * Read where a path is classified by where it is SPELLED: `isUnderDir`'s
 * spelling axis, `isVendorPath` (a segment NAMES a dependency tree), and the
 * project data-dir name, a durable record pinned to the root's spelling
 * (`clients/file-utils.ts`; #4689 review r1 F2).
 */
export function normalizePathSpelling(filePath: string): string {
	return normalizePathForm(filePath, false);
}

function normalizePathForm(filePath: string, identity: boolean): string {
	if (process.platform === "win32") {
		// Relative values and the empty sentinel are not filesystem identities.
		// In particular, win32.resolve() would silently anchor them to the
		// process cwd, which makes a path-only key depend on the runner's drive
		// (#2490). Keep this guard inside the Windows arm so POSIX relative
		// inputs still receive their realpath/casing treatment.
		if (filePath === "") return "";
		if (!isFullyQualifiedWin32(filePath)) {
			return win32.normalize(filePath).replace(/\\/g, "/");
		}
	}

	// Convert backslashes to forward slashes first
	const normalized = filePath.replace(/\\/g, "/");

	if (process.platform !== "win32" && !isWindowsPath(normalized)) {
		// #3184 (a relative spelling, or any spelling in the spelling form; an
		// absolute identity returns below). `path.posix`, not the host default: this branch is already
		// committed to POSIX parsing of a slash-folded string (shape 2). Only
		// the POSIX arm needs this — the win32 arm below reaches `realpath` or
		// `win32.resolve`/`win32.normalize` on every path, all of which fold
		// dot segments already (measured: `C:\repo\src\..\src\a.ts` →
		// `c:/repo/src/a.ts` on this POSIX host, before this change) — and
		// folding BEFORE the arms would also move which arm a degenerate
		// drive-letter path selects (`path.posix.normalize("C:/repo/../..")`
		// is `"."`, no longer Windows-shaped).
		// Two inputs keep the caller's spelling instead:
		// - "" is a non-path sentinel in this codebase's path-typed fields
		//   (see `normalizeLoggedPath`'s doc); `posix.normalize("")` invents
		//   ".", the process cwd.
		// - a UNC root (`\\server\share`, slash-folded to `//server/share`)
		//   reaches THIS arm on a POSIX host, because `isWindowsPath` tests
		//   the already-folded string and sees no backslash; POSIX
		//   `normalize` collapses its leading `//` to `/`, renaming the path
		//   to an unrelated local one.
		const sentinel = normalized === "" || normalized.startsWith("//");
		// #4689: an absolute spelling IS a filesystem address, so its key is
		// its path identity (the kernel-real path), exactly as the win32 arm
		// below has always answered. The kernel resolves `..` physically, so
		// nothing is folded before it answers.
		if (identity && !sentinel && normalized.startsWith("/"))
			return posixPathIdentity(normalized);
		const folded = sentinel ? normalized : path.posix.normalize(normalized);
		try {
			const canonical = realpathSync.native(folded);
			// Fast path, not a guard: both arms answer `folded` when the
			// strings match, but skipping the two `split`s there is a measured
			// 1.9 vs 2.3 microseconds per call (#3098, measured when absolute
			// spellings took this arm too).
			if (canonical === folded) return folded;
			const adopted = adoptCanonicalCasing(folded, canonical);
			if (adopted === folded) return folded;
			// The rewrite is string algebra and can land on a DIFFERENT file
			// (#3159 review round 2, F1 — see `adoptCanonicalCasing`). Adopt it
			// only once the filesystem agrees it still names the file the caller
			// held: `canonical` IS `realpath(normalized)`, so this asks exactly
			// "does the rewritten spelling resolve to the same file?". One extra
			// syscall, and only on the rare branch where casing actually moved —
			// never on an already-canonical path. A throw here (the rewritten
			// path does not exist, the #2490 monorepo case) lands in the catch
			// below and keeps the caller's spelling, which is the same answer.
			return realpathSync.native(adopted) === canonical ? adopted : folded;
		} catch {
			// Does not exist (or is unreadable): case-preserving, as above.
			return folded;
		}
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

/** One tally row per errno that made a path identity fall back to an ancestor. */
export interface PathIdentityFallback {
	code: string;
	count: number;
	/** The first spelling the kernel refused with this code. */
	firstPath: string;
}

/**
 * Distinct errno codes kept; realpath(3) can answer only a handful. The bound
 * is the shared FIFO map's (its eviction is tested where it lives), not a
 * branch of this module (#4689 review r1 F6: the hand-written cap could not
 * be driven to red by any errno the kernel returns).
 */
const pathIdentityFallbacks = new BoundedFifoMap<string, PathIdentityFallback>(
	16,
);

function recordPathIdentityFallback(code: string, spelled: string): void {
	const existing = pathIdentityFallbacks.get(code);
	if (existing) existing.count += 1;
	else pathIdentityFallbacks.set(code, { code, count: 1, firstPath: spelled });
}

/**
 * The identity fallbacks this process has seen (#4689), PULLED at read time
 * by `getDegradationSummary()` as `path-identity-fallback`: this module sits
 * below the ledger, which imports it, so it cannot write through
 * `recordDegradation` without a no-client-cycles cycle. Bounded to one row
 * per errno code.
 */
export function getPathIdentityFallbacks(): readonly PathIdentityFallback[] {
	return [...pathIdentityFallbacks.values()].map((row) => ({ ...row }));
}

/** Re-armed with the ledger at a session boundary (catalog shape 17). */
export function resetPathIdentityFallbacks(): void {
	pathIdentityFallbacks.clear();
}

/**
 * The identity walk's candidates, deepest first: the spelling itself, then each
 * ancestor up to the filesystem root. `missing` grows with the climb and names
 * the segments to fold onto the first ancestor the kernel resolves; a driver
 * reads it only on the step it returns on, and `foldMissingTail` reverses it in
 * place there, so a driver never resumes the walk after that.
 *
 * One walk, two syscall drivers (#4689 batch 10): `kernelAttempt` (sync,
 * `realpathSync.native`) and `kernelAttemptAsync` (`fs/promises.realpath`, the
 * same `uv_fs_realpath`). A second copy of this loop is what the async seam
 * deleted in `clients/lsp/edits.ts`, so keep the climb here.
 */
function* identityCandidates(
	spelled: string,
	p: typeof path.posix,
): Generator<{ candidate: string; missing: string[] }> {
	let current = spelled;
	const missing: string[] = [];
	for (;;) {
		yield { candidate: current, missing };
		const parent = p.dirname(current);
		if (parent === current) return;
		missing.push(p.basename(current));
		current = parent;
	}
}

/**
 * One refused identity candidate. A missing component is the expected answer for a file not yet written (a
 * per-key hot path, #2016), not a failure; any other errno (an unreadable
 * ancestor, a cyclic link) is tallied for the ledger's read-time fold and makes
 * the identity UNCONFIRMED: the walk climbed over a name the kernel refused to
 * give, so the answer is only an ancestor plus the spelling's tail.
 */
function recordIdentityRefusal(refusal: unknown, candidate: string): void {
	if (isAbsenceRefusal(refusal)) return;
	recordPathIdentityFallback(
		(refusal as NodeJS.ErrnoException | undefined)?.code ?? "unknown",
		candidate,
	);
}

/**
 * True when the kernel's refusal is the not-written answer (`ENOENT`: no such
 * file, `ENOTDIR`: a component names a file) rather than a refused resolution
 * (`EACCES`, `ELOOP`, `ENAMETOOLONG`): a walk that skipped the former answered
 * about an absence, one that skipped the latter climbed over an unnamed file.
 */
function isAbsenceRefusal(refusal: unknown): boolean {
	const code = (refusal as NodeJS.ErrnoException | undefined)?.code;
	return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * What one walk answered. `answer` is the resolved prefix with the missing tail
 * folded on; `foldedTail` says the fold removed a segment, so the answer names a
 * path the kernel never saw and needs one more walk (see `foldMissingTail`).
 */
interface KernelAttempt {
	answer: string;
	foldedTail: boolean;
}

/**
 * An attempt that also answers whether the kernel confirmed the name. Only the
 * async driver reports it: its one consumer is a containment decision
 * (`kernelPathIdentityAsync`), and no sync caller asks — `realpathOrResolve`
 * takes the fallback either way.
 */
interface ConfirmedKernelAttempt extends KernelAttempt {
	/** False when a skipped component refused for a reason other than absence. */
	kernelConfirmed: boolean;
}

/** One walk's identity, and whether the kernel confirmed the name. */
export interface KernelPathIdentity {
	/** The kernel-real path, or the nearest resolvable ancestor plus the tail. */
	identity: string;
	/** False when a skipped component refused for a reason other than absence. */
	kernelConfirmed: boolean;
}

/**
 * `real` with the walk's missing tail folded onto it. The tail names nothing on
 * disk, so only the tail is folded (`p.join`); the resolved prefix keeps the
 * kernel's own answer, link for link.
 *
 * The fold can still move a segment the kernel refused into a position it now
 * resolves: `<dir>/<missing>/../<dir-link>/child` folds to
 * `<dir>/<dir-link>/child`, whose `dir-link` the walk never traversed, so
 * resolving that answer again crosses the link and the key moves. A folded
 * answer is therefore resolved once more, and that second answer is a fixpoint
 * — a fold removes every dot segment, so the tail it hands back holds none
 * (#4689 r2 F-CR1).
 */
function foldMissingTail(
	real: string,
	missing: string[],
	p: typeof path.posix,
): string {
	return missing.length === 0 ? real : p.join(real, ...missing.reverse());
}

/** True when the fold removed a segment, so the folded answer needs one more walk. */
function tailHasDotSegment(missing: readonly string[]): boolean {
	return missing.some((segment) => segment === "." || segment === "..");
}

/** One walk with the sync driver; see `identityCandidates`. */
function kernelAttempt(
	spelled: string,
	p: typeof path.posix,
): KernelAttempt | undefined {
	for (const { candidate, missing } of identityCandidates(spelled, p)) {
		try {
			const real = realpathSync.native(candidate);
			return {
				answer: foldMissingTail(real, missing, p),
				foldedTail: tailHasDotSegment(missing),
			};
		} catch (refusal) {
			recordIdentityRefusal(refusal, candidate);
		}
	}
	return undefined;
}

/**
 * The kernel-real path of an absolute `spelled` path, parsed with `p`: the
 * `realpath` of the path itself when it exists, otherwise the `realpath` of its
 * nearest existing ancestor joined with the missing tail. Only the tail is
 * folded (`p.join`): it names nothing on disk, so it holds no link for the
 * kernel to follow; and a fold that removed a dot segment is resolved once
 * more, so the answer is its own re-resolution. `undefined` when no ancestor
 * resolves.
 *
 * The first attempt is the only syscall for an existing path, which is the
 * per-edit case; a missing path pays one more `realpath` per missing segment,
 * and a dot segment in that tail one second walk.
 */
function kernelRealPath(
	spelled: string,
	p: typeof path.posix,
): string | undefined {
	const first = kernelAttempt(spelled, p);
	if (!first) return undefined;
	if (!first.foldedTail) return first.answer;
	return kernelAttempt(first.answer, p)?.answer ?? first.answer;
}

/** `normalizeFilePath`'s POSIX arm for an absolute, slash-folded spelling. */
function posixPathIdentity(spelled: string): string {
	return kernelRealPath(spelled, path.posix) ?? path.posix.normalize(spelled);
}

/**
 * The path identity of `filePath` in the host's native form: the kernel-real
 * path of an existing file, or of its nearest existing ancestor plus the
 * missing tail (#4689; #1129 F11: a directory not created yet, spelled
 * through a symlinked tmpdir, which `ephemeral-root.ts` resolved with its own
 * copy of this walk until #4689). The input reaches the kernel unfolded,
 * absolute or relative to the process cwd, so a `..` after a link names what
 * the OS opens and both spellings of one file name one identity. For a map
 * key use `normalizeMapKey`, which answers the same identity slash-folded.
 */
export function realpathOrResolve(filePath: string): string {
	return kernelRealPath(filePath, path) ?? path.resolve(filePath);
}

/**
 * `realpathOrResolve` for a caller that already awaits (#4689 batch 10): the
 * same identity, climbed by the same walk, resolved through
 * `fs/promises.realpath`. Both that call and `realpathSync.native` are
 * `uv_fs_realpath`, so the sync and async forms answer one string on every
 * platform — unlike `realpathSync` (measured, #4689 batch 10: a `link/../f.ts`
 * spelling comes back as the lexically folded path from `realpathSync` and as
 * the file the kernel opens from `realpathSync.native` and from the async
 * call). The input reaches the kernel unfolded, and a missing path is the
 * nearest existing ancestor's real path plus the missing tail, as the sync
 * form documents.
 */
export async function realpathOrResolveAsync(
	filePath: string,
): Promise<string> {
	return (
		(await kernelPathIdentityAsync(filePath))?.identity ??
		path.resolve(filePath)
	);
}

/** One walk with the async driver; see `identityCandidates`. */
async function kernelAttemptAsync(
	spelled: string,
): Promise<ConfirmedKernelAttempt | undefined> {
	let kernelConfirmed = true;
	for (const { candidate, missing } of identityCandidates(spelled, path)) {
		try {
			const real = await realpathNativeAsync(candidate);
			return {
				answer: foldMissingTail(real, missing, path),
				foldedTail: tailHasDotSegment(missing),
				kernelConfirmed,
			};
		} catch (refusal) {
			recordIdentityRefusal(refusal, candidate);
			if (!isAbsenceRefusal(refusal)) kernelConfirmed = false;
			// A dangling link also answers `ENOENT`, but its entry exists and a write
			// through it lands at the link's target, not under this spelling (#4877).
			else if (
				!(await lstatAsync(candidate).then(
					() => false,
					(lstatRefusal) => {
						// none: absence is the ordinary missing tail, and any other `lstat`
						// refusal already leaves the walk unconfirmed, so it fails closed.
						return isAbsenceRefusal(lstatRefusal);
					},
				))
			) {
				// Tallied like the other refused codes so the refusal reaches the
				// ledger's read-time fold, not only the caller's error.
				recordPathIdentityFallback("ENOENT-DANGLING", candidate);
				kernelConfirmed = false;
			}
		}
	}
	return undefined;
}

/**
 * The async identity, with the one fact a containment decision needs.
 * `kernelConfirmed` is false when the walk climbed over a component the kernel
 * refused for a reason other than absence — an unreadable ancestor (`EACCES`),
 * a cyclic link (`ELOOP`) — so `identity` is only the nearest resolvable
 * ancestor plus the spelling's tail, not a name the kernel ever gave. A queue
 * key takes that answer anyway (`realpathOrResolveAsync`); a caller that decides
 * whether a path is inside a workspace refuses it, as this file's `edits.ts`
 * confiner did before it borrowed this seam (#4689 r2 F-CR2). `undefined` when
 * no ancestor resolves.
 */
export async function kernelPathIdentityAsync(
	filePath: string,
): Promise<KernelPathIdentity | undefined> {
	const first = await kernelAttemptAsync(filePath);
	if (!first) return undefined;
	const settled = first.foldedTail
		? await kernelAttemptAsync(first.answer)
		: undefined;
	return {
		identity: settled?.answer ?? first.answer,
		kernelConfirmed:
			first.kernelConfirmed && (settled?.kernelConfirmed ?? true),
	};
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
 * The ONE lexical containment test (#2556, shape 83). Returns `file` relative
 * to `root`, forward-slashed, when `file` is the root itself (`""`) or inside
 * it, and `undefined` when it is outside. Callers that need only the verdict
 * test `!== undefined`; callers that need the relative text (a glob target, a
 * display path, a cache key) take it from the same call, so the verdict and
 * the text cannot disagree.
 *
 * Outside is decided from the `path.relative` result on three arms, every one
 * of them required: `..` exactly, a `..` SEGMENT (`..` plus a separator, so a
 * directory named `..foo` is inside, #4835), and an absolute result (across
 * Windows drives `path.relative` returns the target's absolute path, which
 * starts with no `..`, #4878 F1). No filesystem access: both operands are read
 * as spelled, so a caller on the identity axis normalizes first.
 *
 * `pathImpl` picks the dialect (a Windows-shaped path on a POSIX host takes
 * `path.win32`); production callers pass the host default or the dialect they
 * classified, and `tests/clients/path-utils.test.ts` runs both on every lane.
 */
export function relativeInside(
	root: string,
	file: string,
	pathImpl: typeof path = path,
): string | undefined {
	const relative = pathImpl.relative(pathImpl.resolve(root), file);
	return relative !== ".." &&
		!relative.startsWith(`..${pathImpl.sep}`) &&
		!pathImpl.isAbsolute(relative)
		? relative.replace(/\\/g, "/")
		: undefined;
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
	return relativeToProjectRoot(filePath, projectRoot, () =>
		normalizeFilePath(projectRoot),
	);
}

/**
 * A `toProjectRelativePath` for one project root, with that root's canonical
 * form computed at most once per resolver.
 *
 * The outside-root retry canonicalizes the root on every call, and a text
 * renderer answers hundreds of display paths from one root in one call: 500
 * locations, half outside the root, spent 7.46 ms per render against 5.05 ms
 * with the root canonicalized once, and 500 outside-root locations 13.44 ms
 * against 8.54 ms (measured on this repo's macOS host, #1449). The remaining
 * per-row cost is the file's own canonical retry, which #4101 requires.
 */
export function createProjectRelativePathResolver(
	projectRoot: string,
): (filePath: string) => string {
	let canonicalRoot: string | undefined;
	return (filePath: string): string =>
		relativeToProjectRoot(
			filePath,
			projectRoot,
			() => (canonicalRoot ??= normalizeFilePath(projectRoot)),
		);
}

/** The one relative-path rule both entry points above share. */
function relativeToProjectRoot(
	filePath: string,
	projectRoot: string,
	canonicalRoot: () => string,
): string {
	const p = isWindowsPath(filePath) ? win32 : path;
	if (!p.isAbsolute(filePath)) return filePath.replace(/\\/g, "/");
	const direct = relativeInside(projectRoot, filePath, p);
	if (direct) return direct;
	// #4101: a canonical key (`normalizeMapKey`: realpath on win32, so 8.3 names,
	// junctions and subst drives are expanded) set against a root the caller
	// spelled differently. Canonicalize both sides before giving up; a file
	// that really is outside the root stays outside.
	const canonical = relativeInside(
		canonicalRoot(),
		normalizeFilePath(filePath),
		p,
	);
	if (canonical) return canonical;
	return filePath.replace(/\\/g, "/");
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

/** How {@link walkUpDirs} climbs and where it stops. */
export interface WalkUpDirsOptions {
	/**
	 * Stop before the first directory at or above this home
	 * (`isAtOrAboveHomeDir`), compared on the axis the walk climbs: the home's
	 * identity for an identity walk, its spelling for a spelled one. The
	 * ceiling is the home's identity, so a link under the home to a folder
	 * outside it climbs the folder's ancestors (#4847 review F2).
	 */
	homeDir?: string;
	/**
	 * Climb the caller's spelling instead of the path identity. Only for a walk
	 * whose answer is compared with spelled paths by design, named at the call.
	 */
	spelling?: boolean;
	/**
	 * Yield at most this many directories, counted from the start, for a walk
	 * with its own depth cap (the Cargo workspace climb, the ast-grep
	 * `node_modules` search). Omitted, the climb ends only at the root or the
	 * home ceiling.
	 */
	maxDepth?: number;
}

/**
 * Yield each directory from `startDir` up to (and including) the filesystem
 * root. Terminates when `path.dirname(current) === current` so it works on
 * Windows drive roots and POSIX `/` alike.
 *
 * The climb starts at the PATH IDENTITY of `startDir` (`realpathOrResolve`,
 * #4689 item 6): a directory reached through a link walks up its target's
 * parents, the ones the kernel opens, not the link's. A start derived from a
 * FILE comes from that file's identity (`path.dirname(realpathOrResolve(f))`),
 * because the directory holding a file link is a real directory. The home
 * ceiling and every other end a caller compares a yielded directory with sit
 * on the same axis.
 *
 * Single source of truth for the half-dozen "walk up the directory tree
 * looking for X" loops that have accumulated across the codebase. Callers
 * that need an "is there a file named Y anywhere on the way up" check
 * should use `findNearestContaining` instead.
 */
export function* walkUpDirs(
	startDir: string,
	options: WalkUpDirsOptions = {},
): Generator<string> {
	const axis = options.spelling ? path.resolve : realpathOrResolve;
	let current = axis(startDir);
	const home =
		options.homeDir === undefined ? undefined : axis(options.homeDir);
	for (let yielded = 0; yielded < (options.maxDepth ?? Infinity); yielded++) {
		if (home !== undefined && isAtOrAboveHomeDir(current, home)) return;
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
 * makes the same mismatch concrete: its detection gate (`hasToolConfig(
 * "php-cs-fixer")`, which visits `$HOME` and stops there since #5408) must
 * agree with the carriage for a config AT `$HOME`, so a ceilinged carriage
 * disagreed with its own gate — "config exists" from the gate, "config not
 * found" from the resolver — and dropped the very `--config` argv #2472
 * exists to carry. Pass `options.homeDir` only when a caller
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
	for (const dir of walkUpDirs(startDir || process.cwd(), options)) {
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

export type GitMarkerResult =
	| { kind: "valid" | "absent" }
	| { kind: "unavailable"; cause: unknown };

export type MarkerRootResult =
	| { kind: "found"; root: string }
	| { kind: "not-found"; reason: "home-ceiling" | "root" | "depth-limit" }
	| { kind: "unavailable"; markerPath: string; cause: unknown };

/** Detailed ownership walks require a probe that can distinguish I/O failure. */
export interface FindNearestMarkerRootDetailedOptions {
	homeDir?: string;
	markerPredicate: (markerPath: string) => GitMarkerResult;
}

/**
 * Accept only a real Git repository marker: a directory with HEAD, or a
 * worktree/submodule marker file whose first line starts with `gitdir:`.
 * Ownership callers request details: absence may permit climbing, but a read
 * error must not invent an enclosing owner. Legacy callers retain a boolean.
 */
export function isRealGitMarker(
	markerPath: string,
	details: true,
): GitMarkerResult;
export function isRealGitMarker(markerPath: string): boolean;
export function isRealGitMarker(
	markerPath: string,
	details?: true,
): boolean | GitMarkerResult {
	// Array callbacks supply an index here; only the documented true opts in.
	const detailed = details === true;
	try {
		const marker = statSync(markerPath);
		let valid = false;
		if (marker.isDirectory()) {
			// existsSync hides EACCES as false. HEAD is part of ownership evidence,
			// so detailed callers need its failure just as much as the marker's.
			statSync(path.join(markerPath, "HEAD"));
			valid = true;
		} else if (marker.isFile()) {
			valid = readFileSync(markerPath, "utf8")
				.split(/\r?\n/, 1)[0]
				.startsWith("gitdir:");
		}
		if (!detailed) return valid;
		return { kind: valid ? "valid" : "absent" };
	} catch (cause) {
		if (!detailed) return false;
		if (
			typeof cause === "object" &&
			cause !== null &&
			"code" in cause &&
			(cause.code === "ENOENT" || cause.code === "ENOTDIR")
		) {
			return { kind: "absent" };
		}
		return { kind: "unavailable", cause };
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
	const markerPredicate = options.markerPredicate ?? (() => true);
	// #4689 item 6: both ends of the climb are path identities (`walkUpDirs`),
	// so a directory reached through a link walks up its target's parents and
	// a home that is itself a link still stops the walk.
	for (const current of walkUpDirs(startDir, {
		homeDir: options.homeDir ?? os.homedir(),
		maxDepth: 64,
	})) {
		if (
			markers.some(
				(m) =>
					existsSync(path.join(current, m)) &&
					markerPredicate(path.join(current, m)),
			)
		)
			return current;
		if (boundaries.some((m) => existsSync(path.join(current, m)))) return null;
	}
	return null;
}

/**
 * Ownership walk for callers that must tell "no marker here" from "could not
 * tell" (refs #3644, #3691). Same climb as `findNearestMarkerRoot` (home
 * ceiling, 64-step cap) but the predicate returns a `GitMarkerResult`, so an I/O
 * failure stops the walk as `unavailable` instead of becoming "absent" and
 * letting an enclosing root be mistaken for the owner. It takes no
 * `boundaries`, so `"boundary"` is not a reason it can return. Kept separate
 * from the legacy walker so the legacy callers' `existsSync` precheck and
 * boolean predicate contract cannot drift with it.
 */
export function findNearestMarkerRootDetailed(
	startDir: string,
	markers: readonly string[],
	options: FindNearestMarkerRootDetailedOptions,
): MarkerRootResult {
	// #4689 item 6: identities at both ends, as in `findNearestMarkerRoot`.
	let climbed = 0;
	let last: string | undefined;
	for (const current of walkUpDirs(startDir, {
		homeDir: options.homeDir ?? os.homedir(),
		maxDepth: 64,
	})) {
		climbed += 1;
		last = current;
		for (const marker of markers) {
			const markerPath = path.join(current, marker);
			const checked = options.markerPredicate(markerPath);
			if (checked.kind === "unavailable")
				return { kind: "unavailable", markerPath, cause: checked.cause };
			if (checked.kind === "valid") return { kind: "found", root: current };
		}
	}
	// The climb ended without a marker; the last directory it yielded says why.
	if (last === undefined) return { kind: "not-found", reason: "home-ceiling" };
	if (path.dirname(last) === last) return { kind: "not-found", reason: "root" };
	return {
		kind: "not-found",
		reason: climbed >= 64 ? "depth-limit" : "home-ceiling",
	};
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
	return relativeInside(dir, pathImpl.resolve(homeDir), pathImpl) !== undefined;
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

/**
 * Is `child` the same path as `parent`, or inside it? Containment holds when
 * it holds on either axis, and each disjunct compares both operands on ONE
 * axis (#4689 review r1 F3/F5):
 *
 * - The spellings (`normalizePathSpelling`: separators, dot segments and
 *   casing folded, no link followed). This is every answer the predicate gave
 *   before #4689, so a path SPELLED inside a root stays inside: a
 *   `node_modules/.bin` shim that links out of the project is still the
 *   project's, which is what the #2556 trust inputs refuse.
 * - The path identities (`normalizeFilePath`). Keys are identities while the
 *   roots callers hold are spellings, so a key under a session rooted at a
 *   link, or a link spelling under a root held as a key (`ctx.cwd`), meets the
 *   root here. Every trust caller treats "inside" as the cautious answer, so
 *   an answer the identity adds never widens what runs.
 *
 * The second disjunct runs only on a POSIX miss: on win32 both forms are the
 * realpath, so it could only repeat the first.
 */
export function isUnderDir(child: string, parent: string): boolean {
	if (isWithinForm(normalizePathSpelling(child), normalizePathSpelling(parent)))
		return true;
	if (process.platform === "win32") return false;
	return isWithinIdentity(child, parent);
}

/**
 * `child` at or under `parent` on the IDENTITY axis only: both operands
 * through `normalizeFilePath` (realpath, so a link spelling meets its target)
 * and no spelling disjunct. Read where a lexically-inside path that links out
 * must stay outside (a chart's template tree, #2556).
 */
export function isWithinIdentity(child: string, parent: string): boolean {
	return isWithinForm(normalizeFilePath(child), normalizeFilePath(parent));
}

/**
 * `child` at or under `parent`, as text, for two paths already in one form
 * (forward slashes, folded the same way). No filesystem access: callers that
 * hold kernel-real paths (#4530's session-repository judge) compare with this
 * instead of paying `isUnderDir`'s two normalizations per comparison.
 */
export function isWithinForm(child: string, parent: string): boolean {
	// Ensure parent ends with / for prefix matching
	const parentPrefix = parent.endsWith("/") ? parent : `${parent}/`;
	return child === parent || child.startsWith(parentPrefix);
}

/** True when a path is outside the session's project root. */
export function isOutsideProjectRoot(
	filePath: string,
	projectRoot: string,
): boolean {
	return !isUnderDir(filePath, projectRoot);
}

const VENDOR_DIR_NAMES = new Set([
	"node_modules",
	"vendor",
	"vendors",
	"third_party",
	"third-party",
	".venv",
	"site-packages",
	"bower_components",
]);

/** True when any path segment names an installed or vendored dependency tree. */
export function isVendorPath(filePath: string): boolean {
	return normalizePathSpelling(filePath)
		.split("/")
		.some((segment) => VENDOR_DIR_NAMES.has(segment.toLowerCase()));
}

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
	if (isOutsideProjectRoot(filePath, projectRoot)) return true;
	return isVendorPath(filePath);
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

const WORKSPACE_GLOB_MEMO_CELL_CAP = 2_000_000;

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
	onCap?: () => void,
): boolean {
	const stepCount = steps.length;
	const width = subject.length + 1;
	// 2,000,000 cells is above real ~8e5-cell globs and below the issue's ~1.6e7-cell row.
	if ((stepCount + 1) * width > WORKSPACE_GLOB_MEMO_CELL_CAP) {
		onCap?.();
		return false;
	}
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
	onCap?: () => void,
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
		steps !== undefined &&
		matchesWorkspaceMemberSteps(steps, relativePath, onCap)
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

/**
 * Resolve a host tool's raw path to the file pi will actually touch.
 *
 * This is the ONE resolver for a host-supplied tool path, shared by the
 * `tool_call` and `tool_result` seams (#4576: they used to disagree on tilde
 * expansion, so `~/x` reached dispatch as `<projectRoot>/~/x`). A second
 * consumer must call this rather than re-compose the two stages, because the
 * stages are pi's, not pi-lens's.
 *
 * The `cwd` basis is the host `ctx.cwd`, which for the pinned host IS the same
 * value the tools were constructed with — `AgentSession` passes its one `_cwd`
 * to both `createAllToolDefinitions`
 * (`@earendil-works/pi-coding-agent/dist/core/agent-session.js:2026`, source
 * `src/core/tools/index.ts:99-124`) and the `ExtensionRunner` behind `ctx.cwd`
 * (`dist/core/agent-session.js:2037`; `runner.js:154`, `:476-479`). Neither is
 * reassigned after construction, so there is no drift TODAY (#1655 item 4).
 * `tests/clients/pi-host-contract.test.ts` pins that, because the day a host
 * lets one move independently, every path here silently retargets.
 *
 * The path is produced the way pi produces it, in pi's two stages (#1655 item
 * 5, plus review F1):
 *
 *   1. `resolveHostToolPath` mirrors pi's BASE resolution, `resolveToCwd`
 *      (`dist/core/tools/path-utils.js:42-44`, source
 *      `src/core/tools/path-utils.ts:~44-46`) — unicode-space folding, `@`
 *      prefix stripping, `~` expansion, `file://` conversion, and Git-Bash
 *      drive paths, all BEFORE anything is probed.
 *   2. `resolveHostPathVariants` mirrors pi's fallback LADDER
 *      (`dist/core/tools/path-utils.js:45-70`, source
 *      `src/core/tools/path-utils.ts:52-83`).
 *
 * Stage 1 was missing in the first cut of this fix, and the ladder cannot
 * stand in for it: an `@`-prefixed path, a `file://` URL, or a non-breaking
 * space are all resolved by pi at stage 1 and are untouched by any of the four
 * stage-2 candidates. A plain `path.resolve` therefore produced a path pi
 * never opens, and the miss looked identical to "file genuinely absent".
 */
export function resolveToolCallFilePath(
	rawFilePath: string | undefined,
	cwd: string | undefined,
	projectRoot: string,
): HostPathVariantResolution | undefined {
	if (!rawFilePath) return undefined;
	return resolveHostPathVariants(
		resolveHostToolPath(rawFilePath, cwd ?? projectRoot),
	);
}
