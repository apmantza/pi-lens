/**
 * Pure-filesystem git identity resolution for the review-graph snapshot
 * (#300). Resolves the current HEAD commit and worktree top-level path
 * WITHOUT spawning `git` — this runs on the persist path, which includes the
 * synchronous process-exit flush in builder.ts. Spawning a child process
 * during teardown crashes libuv on Windows (uv_async on a closing handle —
 * the #234 `pi update` crash), so every read here is a plain `fs` call
 * wrapped so any failure degrades to "not a git repo" (no stamp, no check —
 * identical to today's behavior).
 *
 * Handles both a normal repo (`.git` is a directory) and a linked worktree
 * (`.git` is a FILE containing `gitdir: <path>`, where HEAD lives in that
 * worktree-private gitdir but branch refs live in the shared `commondir`).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { dirname, join, resolve } from "node:path";
import {
	isUnderDir,
	normalizeFilePath,
	pathsEqual,
	walkUpDirs,
} from "../path-utils.js";

export interface GitIdentity {
	/** Resolved HEAD commit SHA (detached or resolved from a symbolic ref). */
	headCommit: string;
	/** The git worktree top-level directory (parent of the resolved `.git` entry). */
	worktreeRoot: string;
}

export type GitIdentityResolver = (cwd: string) => GitIdentity | undefined;

/** A build-local memo: it is discarded when the build settles. */
export function createGitIdentityResolver(): GitIdentityResolver {
	const memo = new Map<string, GitIdentity | undefined>();
	return (cwd) => {
		if (memo.has(cwd)) return memo.get(cwd);
		const identity = resolveGitIdentity(cwd);
		memo.set(cwd, identity);
		return identity;
	};
}

interface ResolvedGitDir {
	/** The worktree-private gitdir — where HEAD lives (== repoGitDir for a normal repo). */
	gitDir: string;
	/** The shared commondir — where refs/objects/packed-refs live. */
	commonDir: string;
	worktreeRoot: string;
}

// Kept as a compatibility no-op for tests that reset the former memo. Git
// repository creation/removal is a process-lifecycle change, so the lookup
// below must walk the filesystem on every call rather than cache presence or
// absence by cwd.
export function _resetGitIdentityCacheForTests(): void {
	return;
}

function readCommonDir(gitDir: string): string {
	try {
		const raw = fs.readFileSync(path.join(gitDir, "commondir"), "utf-8").trim();
		if (!raw) return gitDir;
		return path.isAbsolute(raw) ? raw : path.resolve(gitDir, raw);
	} catch {
		return gitDir;
	}
}

/**
 * Walk up from `cwd` looking for a `.git` entry. Returns null when none is
 * found (not a git repo) or the entry is malformed in a way we can't resolve.
 */
function resolveGitDir(cwd: string): ResolvedGitDir | null {
	for (const dir of walkUpDirs(cwd)) {
		const gitPath = path.join(dir, ".git");
		let stat: fs.Stats;
		try {
			stat = fs.statSync(gitPath);
		} catch {
			continue;
		}
		if (stat.isDirectory()) {
			return {
				gitDir: gitPath,
				commonDir: readCommonDir(gitPath),
				worktreeRoot: dir,
			};
		}
		if (stat.isFile()) {
			// Linked worktree: ".git" is a file with a single "gitdir: <path>" line.
			try {
				const contents = fs.readFileSync(gitPath, "utf-8").trim();
				const match = contents.match(/^gitdir:\s*(.+)$/);
				if (!match) return null;
				const linkedGitDir = path.isAbsolute(match[1])
					? match[1]
					: path.resolve(dir, match[1]);
				if (!fs.statSync(linkedGitDir).isDirectory()) return null;
				return {
					gitDir: linkedGitDir,
					commonDir: readCommonDir(linkedGitDir),
					worktreeRoot: dir,
				};
			} catch {
				return null;
			}
		}
		// Neither a dir nor a file at `.git` — treat as not-a-repo rather than
		// keep walking past what looks like a repo root.
		return null;
	}
	return null;
}

function getResolvedGitDir(cwd: string): ResolvedGitDir | null {
	let resolved: ResolvedGitDir | null;
	try {
		resolved = resolveGitDir(cwd);
	} catch {
		resolved = null;
	}
	return resolved;
}

/**
 * `dir` with its symlinks followed (#3872); the input spelling when it cannot
 * be resolved. Checkout identity is compared by real location: a session whose
 * cwd is a link to the repository is the same checkout as the real path git
 * wrote into every linked worktree's `.git` file.
 */
export function canonicalDirectory(dir: string): string {
	try {
		return fs.realpathSync.native(dir);
	} catch {
		return dir;
	}
}

export interface GitCheckout {
	/** The checkout's top-level directory (parent of its `.git` entry), real path: its identity. */
	root: string;
	/**
	 * The same top-level directory in the path spelling `startPath` used (the
	 * directory the upward walk found `.git` in). Anything compared with paths
	 * spelled like `startPath` derives from this, never from `root` (#3872 r3).
	 */
	spelledRoot: string;
	/** The shared commondir, real path: equal for a repository and every linked worktree of it. */
	commonDir: string;
}

/**
 * The checkout that owns `startPath` (#3872), by reading files only. `null`
 * for anything that is not, or cannot be confidently resolved as, a git
 * checkout; callers treat that as "ownership unknown", never as a verdict.
 * Two paths belong to the same repository exactly when their `commonDir`s are
 * equal (compare through `normalizeFilePath`).
 */
export function resolveGitCheckout(startPath: string): GitCheckout | null {
	const resolved = getResolvedGitDir(startPath);
	return resolved
		? {
				root: canonicalDirectory(resolved.worktreeRoot),
				spelledRoot: resolved.worktreeRoot,
				commonDir: canonicalDirectory(resolved.commonDir),
			}
		: null;
}

/**
 * The linked worktree of `session`'s repository that owns `absoluteFile`, or
 * `null` when the session checkout owns it, its owner is a different
 * repository (a submodule, a nested clone), or no owner can be resolved (#3871,
 * #3872). Same commondir plus a different top level is the whole rule; every
 * "which checkout owns this edit" decision in turn_end asks here, so the knip
 * scan root and the test runner root cannot disagree about a file.
 */
export function resolveLinkedWorktreeOwner(
	session: GitCheckout,
	absoluteFile: string,
): GitCheckout | null {
	const owner = resolveGitCheckout(dirname(absoluteFile));
	return owner !== null &&
		!pathsEqual(owner.root, session.root) &&
		pathsEqual(owner.commonDir, session.commonDir)
		? owner
		: null;
}

/**
 * The top-level directory of every linked worktree registered in `commonDir`
 * (`<commonDir>/worktrees/<name>/gitdir` names each one's `.git` file). Files
 * only, no `git` subprocess; unreadable entries are skipped, so a pruned or
 * half-removed worktree can only make the answer shorter.
 */
export function listLinkedWorktreeRoots(commonDir: string): string[] {
	const roots: string[] = [];
	let names: string[];
	try {
		names = fs.readdirSync(join(commonDir, "worktrees"));
	} catch {
		return roots;
	}
	for (const name of names) {
		try {
			const entryDir = join(commonDir, "worktrees", name);
			const gitFile = fs.readFileSync(join(entryDir, "gitdir"), "utf-8").trim();
			if (gitFile)
				roots.push(canonicalDirectory(dirname(resolve(entryDir, gitFile))));
		} catch {
			/* a worktree whose registration is unreadable is not listed */
		}
	}
	return roots;
}

/**
 * The linked worktrees of `scanRoot`'s repository that sit strictly inside
 * `scanRoot`, by real path (#4117). These are the directories a whole-tree
 * scan of `scanRoot` would walk into and count as project files, whatever
 * they are called; a worktree beside or above the root is not walked and is
 * not listed. `[]` when `scanRoot` is not a git checkout.
 */
export function listNestedLinkedWorktreeRoots(scanRoot: string): string[] {
	const checkout = resolveGitCheckout(scanRoot);
	if (!checkout) return [];
	const base = canonicalDirectory(scanRoot);
	const nested: string[] = [];
	for (const root of listLinkedWorktreeRoots(checkout.commonDir)) {
		if (!pathsEqual(root, base) && isUnderDir(root, base)) nested.push(root);
	}
	return nested;
}

function resolveRefToSha(commonDir: string, ref: string): string | null {
	// Loose ref file first (refs/heads/x), then packed-refs as fallback.
	try {
		const loose = fs.readFileSync(path.join(commonDir, ref), "utf-8").trim();
		if (loose) return loose;
	} catch {
		/* fall through to packed-refs */
	}
	try {
		const packed = fs.readFileSync(
			path.join(commonDir, "packed-refs"),
			"utf-8",
		);
		for (const line of packed.split("\n")) {
			if (line.startsWith("#") || line.startsWith("^") || !line.trim())
				continue;
			const [sha, packedRef] = line.trim().split(/\s+/, 2);
			if (packedRef === ref) return sha;
		}
	} catch {
		/* no packed-refs — ref is simply unresolved */
	}
	return null;
}

/**
 * Resolve the current git HEAD commit + worktree root purely by reading
 * files — no `git` subprocess. Returns undefined for anything that isn't (or
 * can't be confidently resolved as) a git repo; callers treat that exactly
 * like "not a git repo" — no stamp, no check, today's behavior.
 */
export function resolveGitIdentity(cwd: string): GitIdentity | undefined {
	try {
		const resolved = getResolvedGitDir(cwd);
		if (!resolved) return undefined;
		const headRaw = fs
			.readFileSync(path.join(resolved.gitDir, "HEAD"), "utf-8")
			.trim();
		const refMatch = headRaw.match(/^ref:\s*(.+)$/);
		let headCommit: string | null;
		if (refMatch) {
			headCommit = resolveRefToSha(resolved.commonDir, refMatch[1].trim());
		} else {
			headCommit = /^[0-9a-f]{7,40}$/i.test(headRaw) ? headRaw : null;
		}
		if (!headCommit) return undefined;
		return {
			headCommit,
			worktreeRoot: normalizeFilePath(resolved.worktreeRoot),
		};
	} catch {
		return undefined;
	}
}
