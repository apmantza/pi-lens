// Type declarations for scripts/lib/pr-worktree.mjs (untyped .mjs imported
// from .ts tests). Mirrors the JSDoc in the implementation; keep the two in
// sync.

export const WORKTREE_BRANCH_PREFIX: string;

export function slugifyWorktreeName(value: unknown): string;
export function isValidWorktreeName(value: unknown): boolean;

export interface PrHeadInfo {
	headRefName?: string | null;
	headRepositoryOwner?: { login?: string | null } | null;
	isCrossRepository?: boolean;
}

export interface OpenPlanInput {
	target: string;
	mode: string | null;
	name?: string | null;
	worktreesRoot: string;
	prHead?: PrHeadInfo | null;
}

export type OpenPlan =
	| {
			ok: true;
			name: string;
			path: string;
			mode: "head" | "merge" | "branch";
			branch: string | null;
			commitish: string;
			fetchRefspec: string | null;
	  }
	| { ok: false; error: string };

export function deriveOpenPlan(input: OpenPlanInput): OpenPlan;

export function nestedDestinationError(input: {
	destination: string;
	checkouts: string[];
	mainCheckout?: string | null;
	pathApi?: typeof import("node:path");
}): string | null;

export type NodeModulesKind = "missing" | "symlink" | "directory" | "other";

export function classifyNodeModules(
	entry:
		| { isSymbolicLink?: () => boolean; isDirectory?: () => boolean }
		| null
		| undefined,
): NodeModulesKind;

export function worktreeBranchName(worktreePath: string): string;

export interface ClosePlanInput {
	worktreePath: string;
	worktreesRoot: string;
	mainRoot: string | null;
	registered: boolean;
	dirty: boolean;
	detachedCommits: string[];
	detachedCheckFailed: boolean;
	nodeModulesKind: NodeModulesKind;
	branchExists: boolean;
	branchUnpushed: boolean;
}

export type ClosePlan =
	| {
			ok: true;
			unlinkNodeModules: boolean;
			branchToDelete: string | null;
			branchKept: string | null;
	  }
	| { ok: false; code: number; error: string };

export function deriveClosePlan(input: ClosePlanInput): ClosePlan;
