// Type declarations for worktree-hygiene.mjs (untyped .mjs imported from .ts
// tests). Mirrors the JSDoc in the implementation; keep the two in sync.

export const DEFAULT_MIN_AGE_MS: number;

export type WorktreeActivitySignal = "checkout" | "head" | "reflog";

export const WORKTREE_ACTIVITY_SIGNALS: readonly WorktreeActivitySignal[];
export const WORKTREE_ACTIVITY_BANNED_SIGNALS: readonly string[];

export function worktreeActivityFromSignals(
	signals: Record<string, number | null | undefined> | null | undefined,
	nowMs: number,
): number;

export function parseReflogLastEntryMs(text: string): number | null;
export const DEFAULT_LOG_MAX_LINES: number;
export const MAX_RECORDED_COMMAND_CHARS: number;

export interface WorktreeListRow {
	path: string;
	head: string | null;
	branch: string | null;
	detached: boolean;
	bare: boolean;
	locked: boolean;
	lockedReason: string | null;
	prunable: boolean;
}

export interface WorktreeCandidate {
	path: string;
	head?: string | null;
	branch?: string | null;
	dirty: boolean;
	dirtyUnreadable?: boolean;
	pushed: boolean;
	mtimeMs: number;
	locked?: boolean;
	lockPid?: number | null;
	unevaluated?: boolean;
}

export interface PrunePlanRemoval {
	path: string;
	branch: string | null;
	ageMs: number;
	locked: boolean;
	selected: boolean;
}

export interface PrunePlanKeep {
	path: string;
	reason: string;
	detail: string | null;
}

export interface PrunePlan {
	remove: PrunePlanRemoval[];
	keep: PrunePlanKeep[];
}

export interface ProcRow {
	pid: number;
	ppid?: number;
	command: string;
	cwd?: string;
}

export function toComparablePath(p: string): string;

export function isAgentWorktreePath(p: string): boolean;
export function enclosingAgentWorktree(p: string): string | null;
export function parseWorktreeList(porcelain: string): WorktreeListRow[];
export function parseLockPid(
	lockedReason: string | null | undefined,
): number | null;
export function parseDuration(text: string): number | null;

export function planWorktreePrune(options: {
	worktrees: WorktreeCandidate[];
	nowMs: number;
	minAgeMs?: number;
	only?: string[] | null;
	selfPath?: string | string[] | null;
	isPidAlive?: (pid: number) => boolean;
}): PrunePlan;

export interface MergedWorktreeCandidate {
	path: string;
	branch?: string | null;
	bare?: boolean;
	/** `git status --porcelain` answered and was EMPTY (no changes, no untracked files). */
	clean?: boolean;
	statusUnreadable?: boolean;
	/** HEAD is an ancestor of `origin/master` (strict; side branches do not count). */
	mergedIntoMaster?: boolean;
	/** First porcelain entry, bounded — names the change a keep protects. */
	statusDetail?: string | null;
	mtimeMs: number;
	locked?: boolean;
	lockPid?: number | null;
	unevaluated?: boolean;
}

/**
 * Merged-branch sweep (#2631): which NON-PRIMARY trees (excluding the main
 * checkout is the caller's job) may be removed — any path whose branch is an
 * ancestor of `origin/master` and whose checkout is clean, untracked files
 * included in "clean" via porcelain.
 */
export function planMergedWorktreeRemovals(options: {
	candidates: MergedWorktreeCandidate[];
	nowMs: number;
	selfPath?: string | string[] | null;
	isPidAlive?: (pid: number) => boolean;
	selectedKeys?: Set<string> | null;
}): PrunePlan;

/**
 * Verdict for an unregistered `.claude/worktrees/agent-*` directory (#2538):
 * removable only when it holds nothing but git's own `.git` gitlink — every
 * other entry is treated as an untracked deliverable. Null input means the
 * directory could not be read.
 */
export function unregisteredAgentDirVerdict(
	entryNames: string[] | null | undefined,
): { removable: boolean; reason: string };

export function orderBySelection<T extends { path: string }>(
	rows: T[],
	only: string[] | null,
): T[];

export function isFixtureHelperCommand(command: string): boolean;

export function collectAncestorPids(
	rows: ProcRow[],
	startPid: number,
): Set<number>;

export function selectProcessesUnderPath(
	rows: ProcRow[],
	targetPath: string,
	options?: { protectedPids?: Set<number> },
): ProcRow[];

export function selectOrphanFixtureProcesses(
	rows: ProcRow[],
	options?: {
		selfPid?: number;
		protectedPids?: Set<number>;
		isPidAlive?: (pid: number) => boolean;
	},
): { row: ProcRow; reason: string }[];

export function verifySnapshotIntegrity(
	rows: ProcRow[],
	selfPid: number,
	options?: { isPidAlive?: (pid: number) => boolean },
): { ok: boolean; reason: string | null };

export function planOrphanSweep(options: {
	rows: ProcRow[];
	selfPid: number;
	protectedPids?: Set<number>;
	restrictToPath?: string | null;
	listingOk?: boolean;
	isPidAlive?: (pid: number) => boolean;
}): {
	orphans: { row: ProcRow; reason: string }[];
	degraded: { reason: string } | null;
};

export function capRemovals<T extends { ageMs: number }>(
	removals: T[],
	max: number | null | undefined,
): T[];

export function planBranchDeletions(options: {
	branches: {
		name: string;
		containedInOrigin: boolean;
		hasUpstream: boolean;
		upstreamGone: boolean;
		checkedOut: boolean;
	}[];
	removedBranchRefs: (string | null | undefined)[];
}): string[];

// `containedInOrigin` is accepted but deliberately UNUSED: callers hand the
// same row shape to both this pre-filter and selectStaleBranches, and the
// point of the split is that the cheap half never consults containment.
export function isAgentBranchCandidate(branch: {
	name: string;
	hasUpstream: boolean;
	upstreamGone: boolean;
	checkedOut: boolean;
	containedInOrigin?: boolean;
}): boolean;

export function selectStaleBranches(
	branches: {
		name: string;
		containedInOrigin: boolean;
		hasUpstream: boolean;
		upstreamGone: boolean;
		checkedOut: boolean;
	}[],
): string[];

export function formatKillRecord(input: {
	pid: number;
	command: string;
	reason: string;
	worktree?: string | null;
	dryRun?: boolean;
	killed?: boolean;
	error?: string | null;
	nowIso?: string;
}): string;

export function formatWorktreeRecord(input: {
	path: string;
	branch?: string | null;
	ageMs: number;
	dryRun?: boolean;
	removed?: boolean;
	/** #2631: the merged-branch sweep selected this tree. */
	merged?: boolean;
	error?: string | null;
	nowIso?: string;
}): string;

export function formatUnregisteredDirRecord(input: {
	path: string;
	dryRun?: boolean;
	removed?: boolean;
	error?: string | null;
	nowIso?: string;
}): string;

export function formatScanRecord(input: {
	reason:
		| "skipped"
		| "empty"
		| "listing-failed"
		| "self-missing"
		| "chain-incomplete";
	budgetMs: number;
	/** What was left of the SWEEP budget when the degradation was recorded. */
	remainingMs?: number;
	/** The bound the listing was actually given, `min(ceiling, remaining)`. */
	ceilingMs?: number;
	rows?: number;
	nowIso?: string;
}): string;

export const RUN_SKIP_REASONS: {
	readonly NO_AGENT_ID: "no-agent-id";
	readonly AGENT_WORKTREE_MISSING: "agent-worktree-missing";
	readonly WORKTREE_LIST_FAILED: "worktree-list-failed";
	readonly INVALID_ARGUMENTS: "invalid-arguments";
};

export function formatRunRecord(input: {
	hook?: string | null;
	outcome: "fired" | "skipped";
	reason?: string | null;
	worktree?: string | null;
	/** Why the run's single scoped tree is still on disk; null if removed. */
	keptReason?: string | null;
	removed?: number;
	/** #2538: unregistered agent-* directories this run removed. */
	unregisteredDirs?: number;
	orphans?: number;
	rows?: number;
	dryRun?: boolean;
	budgetMs?: number;
	durationMs?: number;
	nowIso?: string;
}): string;

export function pruneLogLines(
	existingLines: string[],
	newLines: string[],
	maxLines?: number,
): string[];
