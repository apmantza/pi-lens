/**
 * Opaque-mutation recovery (#2000 phase 2).
 *
 * A bash command whose writes are NOT recognized by
 * `extractWrittenPathsFromCommand` (python/node/perl/PowerShell internal
 * writes, restores) previously bypassed dispatch AND read-guard authorship.
 * This module observes what such a command actually changed.
 *
 * GIT-FIRST STRATEGY: inside a git worktree the pre side records only a
 * TIMESTAMP; the post side asks `git status --porcelain` which files are
 * dirty and keeps those whose mtime falls inside the command's window.
 * This has NO file-universe bound — it works identically on a 10-file site
 * and a 5000-file monorepo, and content-identical rewrites are correctly
 * NOT reported (a false positive the pure stat-diff design produced).
 *
 * NON-GIT FALLBACK: outside git the pre side takes a bounded stat snapshot
 * (cap enforced, cooperative budget) and the post side diffs it — the
 * original design, kept honestly scoped to small non-git trees.
 *
 * Every failure mode yields an explicit UNKNOWN verdict to the caller —
 * never a clean claim (issue invariant 3). All path keys use
 * normalizeMapKey+resolve, joining the mutation-seam's key form.
 *
 * KNOWN LIMITATIONS:
 * - shape 6: stat-diff identity is size+mtimeMs PLUS a budgeted content-hash
 *   confirm (withHashes captures sha1 up to OPAQUE_HASH_BUDGET_BYTES); a
 *   same-tick/same-size rewrite is detected when both sides hashed the file,
 *   and degrades to mtime+size for files past the hash budget. The git path
 *   detects any content change regardless.
 * - INVARIANT 4 (per issue): ignored/vendor paths are EXCLUDED. Under the
 *   git strategy this means writes landing ONLY in .gitignore'd locations
 *   are never reported - an all-ignored write set reads as an empty (clean)
 *   recovery BY SPEC, not by oversight. Codegen targeting dist/build-style
 *   outputs should use explicit redirect destinations so the extractor
 *   recognizes them.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { collectSourceFilesWithBudgetAsync } from "./source-filter.js";
import { createHash } from "node:crypto";

import { normalizeMapKey } from "./path-utils.js";
import { freshnessFromMtime } from "./freshness.js";
import { safeSpawnAsync } from "./safe-spawn.js";

export interface FileStatEntry {
	mtimeMs: number;
	size: number;
	/**
	 * Content hash, present only when capture ran with `withHashes` and the
	 * cumulative byte budget allowed it. Both sides having hashes upgrades
	 * diff identity from mtime+size to CONTENT - closing the shape-6
	 * same-tick/same-size rewrite hole on the stat-diff path. Absent on
	 * either side -> fall back to mtime+size (documented limitation).
	 */
	hash?: string;
}

/** Stop hashing once this many cumulative bytes were read (per capture). */
export const OPAQUE_HASH_BUDGET_BYTES = 8 * 1024 * 1024;

export type FileStatsSnapshot = Map<string, FileStatEntry>;

/** Hard cap on scanned files — beyond it the verdict is coverage-unknown. */
export const OPAQUE_SCAN_MAX_FILES = 2000;

/** How far before recorded start an earlier write may still be attributed. */
export const OPAQUE_MTIME_TOLERANCE_MS = 150;

export type OpaqueUnknownReason =
	| "walk-failed"
	| "file-cap-exceeded"
	| "entry-budget-exceeded"
	| "no-git"
	| "git-failed"
	| "no-pending-snapshot";

export interface CaptureOutcome {
	snapshot?: FileStatsSnapshot;
	unknownReason?: OpaqueUnknownReason;
	scannedCount: number;
}

/** The pending pre-side state: either a timestamp (git) or stats (fallback). */
export interface PendingOpaqueBaseline {
	startedAt: number;
	strategy: "git" | "stat-diff";
	stats?: FileStatsSnapshot;
	statsUnknownReason?: OpaqueUnknownReason;
}

export interface CaptureOptions {
	budgetMs?: number;
	/**
	 * Read file contents and record sha1 hashes alongside mtime/size. Used on
	 * the stat-diff path so the post-side diff can detect same-tick same-size
	 * rewrites. Bounded by OPAQUE_HASH_BUDGET_BYTES; files past the budget
	 * simply carry no hash (comparison degrades to mtime+size for them).
	 */
	withHashes?: boolean;
}

export async function captureFileStats(
	root: string,
	options: CaptureOptions = {},
): Promise<CaptureOutcome> {
	const budgetMs = options.budgetMs ?? 50;
	try {
		const walk = await collectSourceFilesWithBudgetAsync(root, {
			maxFiles: OPAQUE_SCAN_MAX_FILES + 1,
			budgetMs,
		});
		const files = walk.files;
		if (walk.entryBudgetExceeded || files.length > OPAQUE_SCAN_MAX_FILES) {
			// A PARTIAL universe must never read as a confident diff (invariant
			// 3): writes in the unvisited tail would silently vanish.
			return {
				unknownReason: walk.entryBudgetExceeded
					? "entry-budget-exceeded"
					: "file-cap-exceeded",
				scannedCount: files.length,
			};
		}
		const snapshot: FileStatsSnapshot = new Map();
		let hashBytesSpent = 0;
		for (const file of files) {
			try {
				const stat = await fs.promises.stat(file);
				const entry: FileStatEntry = {
					mtimeMs: stat.mtimeMs,
					size: stat.size,
				};
				if (
					options.withHashes &&
					hashBytesSpent + stat.size <= OPAQUE_HASH_BUDGET_BYTES
				) {
					entry.hash = createHash("sha256")
						.update(await fs.promises.readFile(file))
						.digest("hex");
					hashBytesSpent += stat.size;
				}
				snapshot.set(normalizeMapKey(path.resolve(file)), entry);
			} catch {
				// Vanished mid-walk: absent from both snapshots = unchanged-by-absence.
			}
		}
		return { snapshot, scannedCount: snapshot.size };
	} catch {
		return { unknownReason: "walk-failed", scannedCount: 0 };
	}
}

/** Paths added or whose size/mtime changed. Deletions are NOT reported. */
export function diffFileStats(
	before: FileStatsSnapshot,
	after: FileStatsSnapshot,
): string[] {
	const changed: string[] = [];
	for (const [key, stat] of after) {
		const prev = before.get(key);
		// Content confirm: same mtime tick + same size but different bytes.
		const contentConfirm =
			prev?.hash !== undefined &&
			stat.hash !== undefined &&
			prev.hash !== stat.hash;
		if (
			!prev ||
			prev.mtimeMs !== stat.mtimeMs ||
			prev.size !== stat.size ||
			contentConfirm
		) {
			changed.push(key);
		}
	}
	return changed;
}

export class OpaqueBaselineStore {
	private readonly byCwd = new Map<string, PendingOpaqueBaseline>();
	private evictions = 0;

	record(cwdKey: string, baseline: PendingOpaqueBaseline): void {
		if (this.byCwd.has(cwdKey)) this.evictions += 1;
		this.byCwd.set(cwdKey, baseline);
	}

	take(cwdKey: string): PendingOpaqueBaseline | undefined {
		const baseline = this.byCwd.get(cwdKey);
		this.byCwd.delete(cwdKey);
		return baseline;
	}

	get evictionCount(): number {
		return this.evictions;
	}

	/** Session-boundary clear - unconsumed baselines are unreachable after reset. */
	takeAllForTest(): void {
		this.byCwd.clear();
	}
}

const globalStoreSymbol = Symbol.for("pi-lens:opaque-snapshot-store");

interface GlobalSlot {
	store?: OpaqueBaselineStore;
}
const globalSlot = globalThis as typeof globalThis & Record<symbol, GlobalSlot>;

export function getOpaqueBaselineStore(): OpaqueBaselineStore {
	const existing = globalSlot[globalStoreSymbol]?.store;
	if (existing) return existing;
	const created = new OpaqueBaselineStore();
	globalSlot[globalStoreSymbol] = { store: created };
	return created;
}

const gitRepoMemo = new Map<string, boolean>();

/**
 * Session-boundary clear (#1635): unconsumed pending baselines are keyed by
 * cwd:generation, so entries from a finished session are unreachable; and a
 * directory that was not a worktree last session may be one now. Without this
 * reset both leak and mis-answer forever.
 */
export function resetOpaqueMutationState(): void {
	getOpaqueBaselineStore().takeAllForTest();
	gitRepoMemo.clear();
}

/** Cached git-worktree probe (repos don't stop being git mid-session). */
export async function isGitWorktree(root: string): Promise<boolean> {
	const key = normalizeMapKey(path.resolve(root));
	const memo = gitRepoMemo.get(key);
	if (memo !== undefined) return memo;
	const result = await safeSpawnAsync(
		"git",
		["rev-parse", "--is-inside-work-tree"],
		{ cwd: root, timeout: 3000 },
	);
	const isRepo =
		!result.error && result.status === 0 && result.stdout?.trim() === "true";
	gitRepoMemo.set(key, isRepo === true);
	return isRepo === true;
}

export function _resetGitWorktreeMemoForTests(): void {
	gitRepoMemo.clear();
}

export interface GitRecoveryOutcome {
	verdict: "recovered" | "unknown";
	paths: string[];
	unknownReason?: OpaqueUnknownReason;
	scannedCount: number;
}

/**
 * Files dirty in the working tree whose mtime falls inside
 * [startedAt - tolerance, now]. Porcelain -z parsing handles renames
 * (the NEW path is reported; the old path token is skipped).
 */
export async function recoverOpaqueChangesViaGit(
	root: string,
	startedAt: number,
): Promise<GitRecoveryOutcome> {
	const result = await safeSpawnAsync(
		"git",
		["status", "--porcelain", "-z", "--untracked-files=all"],
		{ cwd: root, timeout: 5000 },
	);
	if (result.error || (result.status !== 0 && result.status !== null)) {
		return {
			verdict: "unknown",
			paths: [],
			unknownReason: "git-failed",
			scannedCount: 0,
		};
	}
	const floorMs = startedAt - OPAQUE_MTIME_TOLERANCE_MS;
	const raw = result.stdout ?? "";
	const tokens = raw.split("\0");
	const paths: string[] = [];
	let skipNext = false; // rename's OLD path follows its NEW path
	for (const token of tokens) {
		if (!token) continue;
		if (skipNext) {
			skipNext = false;
			continue;
		}
		// Each entry: two status chars, one space, then the path.
		if (token.length < 4 || token[2] !== " ") continue;
		const status = token.slice(0, 2);
		const relPath = token.slice(3);
		if (status.includes("R") || status.includes("C")) skipNext = true;
		const abs = path.resolve(root, relPath);
		try {
			const stat = await fs.promises.stat(abs);
			if (
				stat.isFile() &&
				freshnessFromMtime({ mtimeMs: stat.mtimeMs, referenceMs: floorMs })
					.verdict === "stale"
			) {
				// Kernel "stale" = modified AFTER the window floor - exactly the
				// writes this command may have authored.
				paths.push(normalizeMapKey(abs));
			}
		} catch {
			// Deleted or vanished: deletions are deliberately unreported.
		}
	}
	return { verdict: "recovered", paths, scannedCount: paths.length };
}
