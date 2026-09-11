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
import { truncatedByOutputCap } from "./spawn-output-cap.js";

interface FileStatEntry {
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
const OPAQUE_HASH_BUDGET_BYTES = 8 * 1024 * 1024;

export type FileStatsSnapshot = Map<string, FileStatEntry>;

/** Hard cap on scanned files — beyond it the verdict is coverage-unknown. */
export const OPAQUE_SCAN_MAX_FILES = 2000;

/** How far before recorded start an earlier write may still be attributed. */
const OPAQUE_MTIME_TOLERANCE_MS = 150;

// `--untracked-files=all` lists untracked files individually instead of
// collapsing them per directory (it does NOT add ignored paths — that needs
// `--ignored`), so the worst realistic case is a working tree with a large
// unignored generated or vendored directory, and a rename entry costs two
// paths. 16 MiB is a blast-radius bound on that, well past any tree this can
// answer usefully about, and it is what makes the truncation guard below
// reachable at all (#2100).
const MAX_GIT_STATUS_OUTPUT_BYTES = 16 * 1024 * 1024;

type OpaqueUnknownReason =
	| "walk-failed"
	| "file-cap-exceeded"
	| "entry-budget-exceeded"
	| "no-git"
	| "git-failed"
	| "git-status-parse-failed"
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

/** What a bounded capture returns: the snapshot, and whether it was cut. */
export interface PathCaptureResult {
	snapshot: FileStatsSnapshot;
	/**
	 * `true` when a bound stopped the capture before every path was reached.
	 * A partial snapshot must never be read as a complete one: absence from a
	 * cut capture means "not looked at", not "unchanged".
	 */
	stoppedEarly: boolean;
}

/**
 * Stat (and optionally hash) an EXPLICIT file list into a snapshot.
 *
 * Extracted from `captureFileStats` so the observational net (#2430) reuses
 * exactly this identity function — same key form, same hash algorithm, same
 * byte budget — instead of hand-rolling a second scanner whose diff could
 * disagree with `diffFileStats`. The walk-and-cap half stays in
 * `captureFileStats`; a caller that already knows its file set skips it.
 *
 * `hashBudgetBytes` defaults to {@link OPAQUE_HASH_BUDGET_BYTES}. A file past
 * the budget simply carries no hash, and its comparison degrades to
 * mtime+size — the same documented limitation the walking capture has.
 *
 * `deadlineMs` (an absolute epoch stamp) and `signal` are both checked
 * BETWEEN files, so a multi-path capture cannot outrun either bound. The FIRST
 * entry always runs: the observational net's settle (#2430) guarantees the
 * target path it took a baseline for is re-captured no matter what the clock
 * says (#2449 review round 2, F5), and a bound that could cut the one path the
 * caller actually asked about would drop a mutation already measured.
 *
 * There was a synchronous twin of this function until #2449 review round 3
 * (T4). It existed only so `handleToolResult` could settle an observation
 * without yielding; the settle is an ordinary async step now, and blocking the
 * event loop on a directory's worth of `readFileSync` was never worth the
 * ordering shortcut it bought.
 */
export async function captureFileStatsForPaths(
	files: Iterable<string>,
	options: CaptureOptions & {
		hashBudgetBytes?: number;
		deadlineMs?: number;
		signal?: AbortSignal;
	} = {},
): Promise<PathCaptureResult> {
	const hashBudget = options.hashBudgetBytes ?? OPAQUE_HASH_BUDGET_BYTES;
	const snapshot: FileStatsSnapshot = new Map();
	let hashBytesSpent = 0;
	let stoppedEarly = false;
	let first = true;
	for (const file of files) {
		if (!first) {
			if (options.signal?.aborted === true) {
				stoppedEarly = true;
				break;
			}
			if (
				options.deadlineMs !== undefined &&
				Date.now() >= options.deadlineMs
			) {
				stoppedEarly = true;
				break;
			}
		}
		first = false;
		try {
			const stat = await fs.promises.stat(file);
			if (!stat.isFile()) continue;
			const entry: FileStatEntry = {
				mtimeMs: stat.mtimeMs,
				size: stat.size,
			};
			if (options.withHashes && hashBytesSpent + stat.size <= hashBudget) {
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
	return { snapshot, stoppedEarly };
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
		const { snapshot } = await captureFileStatsForPaths(files, options);
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
	const contentChanged = new Set(diffFileContent(before, after));
	const changed: string[] = [];
	for (const [key, stat] of after) {
		const prev = before.get(key);
		// Content confirm: same mtime tick + same size but different bytes.
		const contentConfirm = contentChanged.has(key);
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

/**
 * Return only paths whose bytes are confirmed different by hashes on both
 * sides. Missing hashes are deliberately omitted: callers deciding authorship
 * must treat unavailable content evidence as unknown, never as changed.
 */
export function diffFileContent(
	before: FileStatsSnapshot,
	after: FileStatsSnapshot,
): string[] {
	const changed: string[] = [];
	for (const [key, stat] of after) {
		const previous = before.get(key);
		if (
			previous?.hash !== undefined &&
			stat.hash !== undefined &&
			previous.hash !== stat.hash
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
	gitToplevelMemo.clear();
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

const gitToplevelMemo = new Map<string, string | undefined>();

/**
 * The root of the working tree `root` belongs to, or `undefined` when it is
 * not inside one (#2007).
 *
 * This is WORKTREE IDENTITY, which path containment cannot supply. A linked
 * worktree lives at a path nested under the main checkout — this repo keeps
 * agent worktrees under `.claude/worktrees/` — yet shares no working files
 * with it. `--show-toplevel` answers which tree a directory really belongs
 * to, so two directories are the same checkout when, and only when, their
 * toplevels match.
 *
 * Memoized beside `isGitWorktree`, and cleared by the same
 * `resetOpaqueMutationState` session boundary, so it cannot become a
 * process-lifetime latch (catalog shape 17). `undefined` is a real cached
 * answer, so the memo is probed with `has`, never by truthiness.
 */
export async function resolveGitToplevel(
	root: string,
): Promise<string | undefined> {
	const key = normalizeMapKey(path.resolve(root));
	if (gitToplevelMemo.has(key)) return gitToplevelMemo.get(key);
	const result = await safeSpawnAsync("git", ["rev-parse", "--show-toplevel"], {
		cwd: root,
		timeout: 3000,
	});
	const toplevel =
		!result.error && result.status === 0 && result.stdout?.trim()
			? result.stdout.trim()
			: undefined;
	gitToplevelMemo.set(key, toplevel);
	return toplevel;
}

export interface GitRecoveryOutcome {
	verdict: "recovered" | "unknown";
	paths: string[];
	unknownReason?: OpaqueUnknownReason;
	scannedCount: number;
	/**
	 * #2060: clean index-only paths the failed-integration filter dropped.
	 * Over-exclusion is silent by construction - the dropped files simply never
	 * appear - so this count is the only production evidence the filter ran.
	 * Counts only entries that also pass the mtime-freshness window, i.e. would
	 * otherwise have been dispatched (#2081) - a long-staged clean-index entry
	 * outside the window was never going to be reported, so excluding it is
	 * not suppression and must not inflate this count. Present only when
	 * nonzero.
	 */
	excludedIncomingCount?: number;
	/**
	 * #2060: well-formed XY pairs outside the documented matrix. Their paths are
	 * KEPT (see `isKnownPorcelainStatus`); the count exists so a gap in our
	 * table is visible rather than inferred. Present only when it is nonzero.
	 */
	unknownStatusCount?: number;
}

/** Narrow failure-only policy for Git integration commands. */
export interface GitRecoveryOptions {
	/**
	 * When a failed merge, rebase, or cherry-pick leaves unmerged index entries,
	 * omit clean index-only paths brought in by the other side. Paths with a
	 * worktree status and every unmerged path remain eligible.
	 */
	excludeIndexOnlyWhenUnmerged?: boolean;
}

interface GitStatusEntry {
	status: string;
	absPath: string;
}

const UNMERGED_PORCELAIN_STATUSES = new Set([
	"DD",
	"AU",
	"UD",
	"UA",
	"DU",
	"AA",
	"UU",
]);
/**
 * Git's Porcelain v1 ordinary-status table, not a Cartesian product. A clean
 * index permits worktree M/T/D, intent-to-add A, and worktree rename/copy R/C.
 * M/T/A/R/C may pair with blank/M/T/D; staged deletion is D<space>, DR or DC.
 * Broaden only with Git docs and a real-status probe.
 *
 * Membership no longer decides pass/fail for a whole command - an absent pair
 * is counted and kept, not fatal (#2060). It still decides which entries the
 * failed-integration filter may treat as "clean index-only incoming", so an
 * unknown pair is never silently classified as someone else's content.
 */
const LEGAL_ORDINARY_PORCELAIN_STATUSES = new Set([
	" M",
	" T",
	" D",
	" A",
	" R",
	" C",
	"DR",
	"DC",
	"M ",
	"MM",
	"MT",
	"MD",
	"T ",
	"TM",
	"TT",
	"TD",
	"A ",
	"AM",
	"AT",
	"AD",
	"D ",
	"R ",
	"RM",
	"RT",
	"RD",
	"C ",
	"CM",
	"CT",
	"CD",
]);

function isUnmergedStatus(status: string): boolean {
	return UNMERGED_PORCELAIN_STATUSES.has(status);
}

/** An XY pair this module can classify. Unknown pairs are kept, not rejected. */
function isKnownPorcelainStatus(status: string): boolean {
	return (
		status === "??" ||
		status === "!!" ||
		isUnmergedStatus(status) ||
		LEGAL_ORDINARY_PORCELAIN_STATUSES.has(status)
	);
}

/**
 * The characters Git's short format can put in an XY pair. This is the real
 * fail-closed line (#2060): output whose status field is outside this alphabet,
 * or carries no status at all, is not Porcelain v1 and nothing in it can be
 * trusted. An in-alphabet pair we happen not to have tabulated is a gap in our
 * table, so voiding the whole command's recovery for it would throw away every
 * other path - the read-guard hole this subsystem exists to close.
 */
const PORCELAIN_STATUS_CHARS = /^[ MTADRCU?!]{2}$/;

function isStructurallyValidStatus(status: string): boolean {
	return PORCELAIN_STATUS_CHARS.test(status) && status.trim() !== "";
}

/**
 * Files dirty in the working tree whose mtime falls inside
 * [startedAt - tolerance, now]. Porcelain -z parsing handles renames
 * (the NEW path is reported; the old path token is skipped before filtering).
 */
export async function recoverOpaqueChangesViaGit(
	root: string,
	startedAt: number,
	options: GitRecoveryOptions = {},
): Promise<GitRecoveryOutcome> {
	const result = await safeSpawnAsync(
		"git",
		["status", "--porcelain", "-z", "--untracked-files=all"],
		{
			cwd: root,
			timeout: 5000,
			maxOutputBytes: MAX_GIT_STATUS_OUTPUT_BYTES,
		},
	);
	// #2060: safe-spawn caps stdout before the child finishes. A capped listing
	// is a PREFIX of the truth, so reading it as complete would report every
	// path the cap removed as unchanged.
	//
	// #2100: FIRST, ahead of the git-failed check. Hitting the cap makes
	// safe-spawn SIGTERM the child, so the result also carries an error and a
	// null status — read in the other order every cap kill reported as
	// "git-failed" and this guard could never speak. `truncatedByOutputCap`
	// leaves a timed-out or aborted read to the git-failed branch below, which
	// is the honest answer for those.
	if (truncatedByOutputCap(result)) {
		return {
			verdict: "unknown",
			paths: [],
			unknownReason: "git-status-parse-failed",
			scannedCount: 0,
		};
	}
	if (result.error || (result.status !== 0 && result.status !== null)) {
		return {
			verdict: "unknown",
			paths: [],
			unknownReason: "git-failed",
			scannedCount: 0,
		};
	}
	const raw = result.stdout ?? "";
	if (raw && !raw.endsWith("\0")) {
		return {
			verdict: "unknown",
			paths: [],
			unknownReason: "git-status-parse-failed",
			scannedCount: 0,
		};
	}
	const entries: GitStatusEntry[] = [];
	let unknownStatusCount = 0;
	let skipNext = false; // rename's OLD path follows its NEW path
	for (const token of raw.split("\0")) {
		if (!token) continue;
		if (skipNext) {
			skipNext = false;
			continue;
		}
		// Each entry: two status chars, one space, then the path.
		if (token.length < 4 || token[2] !== " ") {
			return {
				verdict: "unknown",
				paths: [],
				unknownReason: "git-status-parse-failed",
				scannedCount: 0,
			};
		}
		const status = token.slice(0, 2);
		const relPath = token.slice(3);
		if (!isStructurallyValidStatus(status) || !relPath) {
			return {
				verdict: "unknown",
				paths: [],
				unknownReason: "git-status-parse-failed",
				scannedCount: 0,
			};
		}
		if (!isKnownPorcelainStatus(status)) unknownStatusCount += 1;
		if (status.includes("R") || status.includes("C")) skipNext = true;
		entries.push({ status, absPath: path.resolve(root, relPath) });
	}
	if (skipNext) {
		return {
			verdict: "unknown",
			paths: [],
			unknownReason: "git-status-parse-failed",
			scannedCount: 0,
		};
	}

	const hasUnmerged = entries.some((entry) => isUnmergedStatus(entry.status));
	const floorMs = startedAt - OPAQUE_MTIME_TOLERANCE_MS;
	// Kernel "stale" = modified AFTER the window floor - exactly the writes
	// this command may have authored, so exactly the entries that would be
	// dispatched absent any other filtering.
	async function isInWindow(absPath: string): Promise<boolean> {
		try {
			const stat = await fs.promises.stat(absPath);
			return (
				stat.isFile() &&
				freshnessFromMtime({ mtimeMs: stat.mtimeMs, referenceMs: floorMs })
					.verdict === "stale"
			);
		} catch {
			// Deleted or vanished: deletions are deliberately unreported.
			return false;
		}
	}
	let excludedIncomingCount = 0;
	let candidates = entries;
	if (options.excludeIndexOnlyWhenUnmerged === true && hasUnmerged) {
		// Clean index-only (`XY` with a blank Y) means "staged, worktree matches
		// the index". After a failed integration that content came from the other
		// side, never from the agent: merge, rebase, cherry-pick and revert all
		// REFUSE to start against a dirty index, so no agent-staged file can be
		// sitting here (#2060 F5, probed on git 2.55). An unknown-but-well-formed
		// pair is NOT classified as incoming - capture wins when in doubt.
		// Scope: the refusal argument covers content staged BEFORE the
		// integration started. Content staged mid-call, after the conflict
		// began, is indistinguishable from incoming and is excluded too; the
		// excluded count below is the visibility for that edge.
		// A blank Y already excludes every unmerged pair (all seven are two
		// letters), so this needs no separate unmerged term.
		const kept: GitStatusEntry[] = [];
		for (const entry of entries) {
			const cleanIndexOnly =
				entry.status[1] === " " && isKnownPorcelainStatus(entry.status);
			if (!cleanIndexOnly) {
				kept.push(entry);
				continue;
			}
			// #2081: only count entries the mtime window would otherwise have
			// dispatched. A long-staged clean-index path outside the window was
			// never going to be reported, so dropping it here is not suppression.
			if (await isInWindow(entry.absPath)) excludedIncomingCount += 1;
		}
		candidates = kept;
	}
	const paths: string[] = [];
	for (const { absPath } of candidates) {
		if (await isInWindow(absPath)) paths.push(normalizeMapKey(absPath));
	}
	return {
		verdict: "recovered",
		paths,
		scannedCount: paths.length,
		// Omitted when zero so the common outcome keeps one shape.
		...(excludedIncomingCount > 0 ? { excludedIncomingCount } : {}),
		...(unknownStatusCount > 0 ? { unknownStatusCount } : {}),
	};
}
