// Type declarations for prune-agent-worktrees.mjs (untyped .mjs imported
// from .ts tests). Only the pure, exported seams are declared — the CLI body
// is not importable surface.

export const DEFAULT_MAX_REMOVALS: number;
export const DEFAULT_HOOK_BUDGET_MS: number;
export const DEFAULT_MANUAL_BUDGET_MS: number;
export const HOOK_TIMEOUT_MS: Readonly<Record<string, number>>;
export const HOOK_TIMEOUT_MARGIN_MS: number;
export const DEFAULT_SCAN_TIMEOUT_MS: number;
export const MIN_SCAN_BUDGET_MS: number;
export const DEFAULT_GIT_TIMEOUT_MS: number;
export const MIN_GIT_TIMEOUT_MS: number;
export const REMOVE_TIMEOUT_MS: number;
export const HOOK_REMOVE_RESERVE_MS: Readonly<Record<string, number>>;
export const RECHECK_TIMEOUT_MS: number;

export interface PruneCliOptions {
	dryRun: boolean;
	minAgeMs: number;
	budgetMs: number | null;
	scanTimeoutMs: number | null;
	only: string[] | null;
	hook: string | null;
	keepAgentTree: boolean;
	orphanSweep: boolean;
	json: boolean;
	quiet: boolean;
	help: boolean;
	errors: string[];
}

export function parseArgs(argv: string[]): PruneCliOptions;

export interface HookPolicy {
	removeWorktrees: boolean;
	deleteBranches: boolean;
	orphanSweep: boolean;
	scopedToAgentTree: boolean;
	/** `Infinity` = uncapped, `0` = never, `n` = at most n per run. */
	maxRemovals: number;
	/** Which budget arithmetic `hookBudgetMs` applies to this mode. */
	budgetSource: "hook" | "manual";
}

export const HOOK_POLICIES: Readonly<Record<string, HookPolicy>>;

export function resolveHookPolicy(
	hook: string | null | undefined,
	invocation?: { only?: string[] | null; keepAgentTree?: boolean },
): HookPolicy;

export function hookBudgetMs(
	hook: string | null | undefined,
	policy: HookPolicy,
): number;

export function removeBoundMs(
	hook: string | null | undefined,
	policy: HookPolicy,
): number;

export function recheckBoundMs(
	hook: string | null | undefined,
	policy: HookPolicy,
): number;

export function scanReserveMs(budgetMs: number, scanTimeoutMs: number): number;

export function keptReasonFor(input: {
	targetPath: string | null;
	plan: { keep: { path: string; reason: string }[] };
	deferred: { path: string }[];
	policy: HookPolicy;
}): string | null;

export function worktreePathFromHookPayload(
	payload: unknown,
	repoRoot: string,
): string | null;

export function worktreeActivityMs(worktreePath: string, nowMs: number): number;

export function getHygieneLogPath(): string;

export function isDirty(
	worktreePath: string,
	timeoutMs?: number,
): "clean" | "dirty" | "unreadable";
