// Type declarations for guard-bash.mjs (untyped .mjs imported from .ts
// tests). Only the pure, exported seams are declared — the CLI's stdin/exit
// side effects (`run`, the main-guard block) are exercised only by spawning
// the real script as a child process, not by importing it.

export type DenyRule =
	| "stash"
	| "reset"
	| "worktreeForce"
	| "worktreeSymlink"
	| "probe"
	| "tmpdirCollision"
	| "sharedKill"
	| "tmpCheckout"
	| "checkUngated"
	| "ciVerdictStatus"
	| "hookBypass";

export const RULE_MESSAGES: Readonly<Record<DenyRule, string>>;

/**
 * Every region of the command text that bash can EXECUTE, inert regions
 * (heredoc bodies, comments) already subtracted. Index 0 is the top level;
 * the rest are command-substitution bodies from any depth, flattened.
 */
export function scannableRegions(commandText: string): string[];

export function splitSegments(region: string): string[];

/**
 * {@link splitSegments}'s sibling for #3471: the same split, with each
 * segment's preceding separator kept (`null` for a region's first segment).
 */
export function splitSegmentsWithSeparators(
	region: string,
): Array<{ text: string; sep: string | null }>;

export function splitWords(segment: string): string[];

export function stripEnvAssignments(words: string[]): {
	env: Record<string, string>;
	rest: string[];
};

export function classifySegment(
	rawSegment: string,
	sharedEnv?: Record<string, string>,
	cwd?: string,
	originCwd?: string,
): DenyRule | null;

export function findDeny(commandText: string, cwd?: string): DenyRule | null;

export function classifyPayload(payload: unknown): DenyRule | null;

/** @returns process exit code -- 0 to allow, 2 to deny. */
export function run(): number;
