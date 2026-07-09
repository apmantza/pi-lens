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
import { normalizeFilePath, walkUpDirs } from "../path-utils.js";

export interface GitIdentity {
	/** Resolved HEAD commit SHA (detached or resolved from a symbolic ref). */
	headCommit: string;
	/** The git worktree top-level directory (parent of the resolved `.git` entry). */
	worktreeRoot: string;
}

interface ResolvedGitDir {
	/** The worktree-private gitdir — where HEAD lives (== repoGitDir for a normal repo). */
	gitDir: string;
	/** The shared commondir — where refs/objects/packed-refs live. */
	commonDir: string;
	worktreeRoot: string;
}

// Per-process cache of resolved gitdir location keyed by cwd — the gitdir
// location itself is stable for the life of the process; only HEAD's
// CONTENT changes (on commit/checkout), so that's re-read fresh every call.
const _gitDirCache = new Map<string, ResolvedGitDir | null>();

export function _resetGitIdentityCacheForTests(): void {
	_gitDirCache.clear();
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
			return { gitDir: gitPath, commonDir: readCommonDir(gitPath), worktreeRoot: dir };
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
	const key = normalizeFilePath(path.resolve(cwd));
	if (_gitDirCache.has(key)) return _gitDirCache.get(key) ?? null;
	let resolved: ResolvedGitDir | null;
	try {
		resolved = resolveGitDir(cwd);
	} catch {
		resolved = null;
	}
	_gitDirCache.set(key, resolved);
	return resolved;
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
		const packed = fs.readFileSync(path.join(commonDir, "packed-refs"), "utf-8");
		for (const line of packed.split("\n")) {
			if (line.startsWith("#") || line.startsWith("^") || !line.trim()) continue;
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
		const headRaw = fs.readFileSync(path.join(resolved.gitDir, "HEAD"), "utf-8").trim();
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
