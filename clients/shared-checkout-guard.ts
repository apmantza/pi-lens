/**
 * Shared-checkout WIP guard (#2007).
 *
 * THE HAZARD. Several agent sessions can run against ONE checkout. Nothing
 * in git binds a session to a directory, so when one session runs
 * `git checkout <branch>`, git overwrites the tracked files another live
 * session was editing. The work is not recoverable: it was never committed
 * and never stashed. The reported incident lost uncommitted edits to three
 * files between two observations minutes apart.
 *
 * THE ANSWER IS REFUSAL, NOT RESCUE. An auto-stash would be invisible
 * machinery that moves another session's work somewhere it did not ask for,
 * and `git stash` is repo-global across worktrees, so the rescue would be a
 * second instance of the same defect. This guard instead DECLINES the
 * command and says who else is here. The operator resolves it the way the
 * design contract already says to: commit, or take a dedicated
 * `git worktree`.
 *
 * THREE FACTS MUST ALL HOLD BEFORE ANYTHING IS DECLINED, cheapest first:
 *
 *   1. The bash input really invokes a git verb that rewrites the working
 *      tree, read from git's own COMMAND POSITION. Pure string work, no I/O —
 *      see `WORKTREE_MUTATING_GIT_MATCHER`. The directory judged is the one
 *      the invocation TARGETS, which `-C` and `--work-tree` can move away
 *      from the caller's cwd.
 *   2. Another live pi-lens session is in the SAME WORKING TREE.
 *      `selectLivePeerInstances` (clients/instance-registry.ts) owns liveness
 *      and is the single source of truth for it; warm-attach reads the same
 *      predicate in `"exact"` mode. Path containment alone is not identity
 *      here, in either direction: a peer at the repo root and a command run
 *      from a subdirectory DO share one tree, while a linked worktree nested
 *      under the main checkout shares nothing with it. Containment against
 *      the toplevel is the pre-filter; `git rev-parse --show-toplevel` is the
 *      decision. No peer means nothing to protect.
 *   3. The working tree actually carries uncommitted work. A clean tree can
 *      be switched freely.
 *
 * That ordering is the cost story: the two `git` probes run only after a
 * genuine worktree-mutating command in a genuinely shared checkout, which is
 * rare. Ordinary bash traffic pays one string classification.
 *
 * UNKNOWN IS NOT CLEAN (catalog shape 10). When `git status` cannot answer,
 * the guard declines with its OWN reason rather than assuming the tree is
 * clean, and records a counted degradation so a repeatedly broken probe is
 * visible instead of silently permissive.
 *
 * The TOPLEVEL probes fail open, deliberately and asymmetrically to the
 * dirtiness probe: a candidate peer whose `git rev-parse --show-toplevel`
 * fails is dropped, and the allow record folds into `no_peer_session`; a cwd
 * whose probe fails folds into `not_a_git_worktree`. Both read as facts in
 * latency.log when they may be a timeout or a lock. Chosen because failing
 * closed here would let a broken probe block every branch switch; the cost is
 * that those two reasons are not distinguishable from the genuine cases.
 *
 * NO LATCHES HERE (catalog shape 17). Every decision is recomputed from the
 * registry and the tree. Repeat-suppression for telemetry lives in the
 * degradation ledger, which already re-arms at `session_start`.
 */

import { emitBounded } from "./bounded-telemetry.js";
import {
	collectGitInvocations,
	detectGuardedGitVerb,
	type GitVerbMatcher,
	matchGitVerbAtCommandPosition,
	resolveGitTargetDirectory,
} from "./git-guard.js";
import {
	getInstanceRoots,
	type InstanceEntry,
	readInstanceRegistry,
	selectLivePeerInstances,
} from "./instance-registry.js";
import { realIsPidAlive } from "./instance-reaper.js";
import { logLatency } from "./latency-logger.js";
import { resolveGitToplevel } from "./opaque-mutation-scan.js";
import { normalizeFilePath } from "./path-utils.js";
import { safeSpawnAsync } from "./safe-spawn.js";
import { truncatedByOutputCap } from "./spawn-output-cap.js";

/** Verbs that rewrite tracked files unconditionally. */
const ALWAYS_MUTATING_VERBS: ReadonlySet<string> = new Set([
	"checkout",
	"switch",
	"restore",
	"merge",
	"rebase",
	"pull",
	"cherry-pick",
	"revert",
]);

/** `git reset` touches the working tree only in these modes. */
const RESET_WORKTREE_MODES: ReadonlySet<string> = new Set([
	"--hard",
	"--merge",
	"--keep",
]);

/** `git stash` subcommands that only read. Everything else moves files. */
const READ_ONLY_STASH_SUBCOMMANDS: ReadonlySet<string> = new Set([
	"list",
	"show",
]);

/**
 * `git clean` in dry-run mode reports and deletes nothing.
 *
 * Short flags CLUSTER (`git clean -nfd` is `-n -f -d`), so an exact-token set
 * would read `-nfd` as mutating and decline a command that touches nothing.
 * Match the letter inside any short cluster, and `--dry-run` exactly.
 */
function isCleanDryRun(argsAfterVerb: readonly string[]): boolean {
	return argsAfterVerb.some(
		(arg) =>
			arg === "--dry-run" ||
			(arg.startsWith("-") && !arg.startsWith("--") && arg.includes("n")),
	);
}

/**
 * The verb question for the shared-checkout guard. Every other part of the
 * classification (wrappers, `$IFS`, substitutions, PATHEXT, text consumers)
 * is the #1063 git-guard machinery, reused rather than re-implemented.
 *
 * `indirectAlwaysMatches` is FALSE here on purpose. The commit gate is a
 * policy an agent may want to evade, so it fails closed on any indirect
 * `git`. This guard protects an agent from its own accident, so failing
 * closed on `xargs git status` would cost far more than it saves; the
 * indirect path stays armed only when the argv also carries a governed verb.
 *
 * DELIBERATELY OUT OF SCOPE: `git apply` and `git am`. They add the caller's
 * own patch on top of the tree and fail loudly into `.rej` files rather than
 * discarding tracked content wholesale, and `git apply` is the sanctioned
 * replacement for the forbidden `git stash`. Blocking it would push
 * operators back toward stash.
 */
const WORKTREE_MUTATING_GIT_MATCHER: GitVerbMatcher = {
	id: "worktree-mutating",
	indirectAlwaysMatches: false,
	// `git checkout --help` opens documentation and changes nothing. This
	// guard can afford to read a leading help flag as documentation; the
	// commit gate cannot — see `suppressPostVerbHelp`'s own docstring.
	suppressPostVerbHelp: true,
	matchesVerb(verb, argsAfterVerb) {
		if (ALWAYS_MUTATING_VERBS.has(verb)) return true;
		if (verb === "reset") {
			return argsAfterVerb.some((arg) => RESET_WORKTREE_MODES.has(arg));
		}
		if (verb === "stash") {
			const subcommand = argsAfterVerb.find((arg) => !arg.startsWith("-"));
			return (
				subcommand === undefined || !READ_ONLY_STASH_SUBCOMMANDS.has(subcommand)
			);
		}
		if (verb === "clean") return !isCleanDryRun(argsAfterVerb);
		return false;
	},
};

/** True when this one git invocation's subcommand rewrites tracked files. */
function matchesWorktreeMutatingVerb(gitTokens: string[]): boolean {
	return matchGitVerbAtCommandPosition(
		gitTokens,
		WORKTREE_MUTATING_GIT_MATCHER,
	);
}

/** True when this bash input runs a git verb that rewrites tracked files. */
export function isWorktreeMutatingGitAttempt(
	toolName: string,
	input: unknown,
): boolean {
	return detectGuardedGitVerb(toolName, input, WORKTREE_MUTATING_GIT_MATCHER);
}

/**
 * `dirty` and `clean` are answers. `unknown` means git could not tell us,
 * which is NOT the same as clean and must never be collapsed into it.
 */
export type WorkingTreeState = "dirty" | "clean" | "unknown";

// A `git status --porcelain --untracked-files=all` listing over a huge
// untracked tree (an unignored `node_modules`, a vendored dependency dump) can
// run to many MiB. This is a blast-radius bound on a wedged or runaway git, not
// a working limit; 16 MiB matches the sibling git-status probes
// (`opaque-mutation-scan.ts`'s `MAX_GIT_STATUS_OUTPUT_BYTES` and
// `git-tracked-ignore.ts`'s `MAX_LS_FILES_OUTPUT_BYTES`, both 16 MiB). Without
// it `outputTruncated` can never fire, so the truncation guard below was
// dormant (#2100 F3).
const MAX_GIT_STATUS_OUTPUT_BYTES = 16 * 1024 * 1024;

/**
 * Ask git whether the working tree carries uncommitted work.
 *
 * Deliberately narrower than `recoverOpaqueChangesViaGit`: that function
 * answers WHICH files changed inside a time window and stats each one, which
 * drops deletions and costs one stat per entry. Here the only question is
 * whether ANY entry exists, so a truncated listing is still a definite
 * `dirty` — a prefix of dirt is dirt.
 */
export async function probeWorkingTreeState(
	root: string,
): Promise<WorkingTreeState> {
	const result = await safeSpawnAsync(
		"git",
		["status", "--porcelain", "--untracked-files=all"],
		{ cwd: root, timeout: 5000, maxOutputBytes: MAX_GIT_STATUS_OUTPUT_BYTES },
	);
	// Read truncation FIRST (#2100 F3), through the shared seam that
	// git-tracked-ignore uses. Reaching the cap makes safe-spawn kill the tree,
	// which settles as `error` + null status on POSIX and status 1 on Windows —
	// both of which the failure check below reads as `unknown`. So a definite
	// dirty (we captured 16 MiB of porcelain) was being downgraded to `unknown`
	// the moment the cap fired. Timeout and abort keep their own classification
	// and fall through to `unknown`, since a hung git cannot prove dirtiness.
	if (truncatedByOutputCap(result)) return "dirty";
	if (result.error || (result.status !== 0 && result.status !== null)) {
		return "unknown";
	}
	return (result.stdout ?? "").trim().length > 0 ? "dirty" : "clean";
}

export interface SharedCheckoutDecision {
	block: boolean;
	/** True when the refusal comes from an unanswerable probe, not from WIP. */
	unknown?: boolean;
	reason?: string;
}

/** Seams the tests replace. Production uses every default. */
export interface SharedCheckoutGuardDeps {
	readRegistry?: () => Promise<InstanceEntry[]>;
	isPidAlive?: (pid: number) => boolean;
	now?: number;
	/** Resolves a directory to its working-tree root, or undefined. */
	resolveToplevel?: (root: string) => Promise<string | undefined>;
	probeWorkingTree?: (root: string) => Promise<WorkingTreeState>;
}

function logAllow(root: string, reasonCategory: string): void {
	logLatency({
		type: "phase",
		toolName: "shared-checkout-guard",
		phase: "shared_checkout_guard_allow",
		filePath: root,
		durationMs: 0,
		metadata: { decision: "allowed", reasonCategory },
	});
}

function describePeers(peers: readonly InstanceEntry[]): string {
	const pids = peers.slice(0, 4).map((peer) => peer.pid);
	const suffix = peers.length > pids.length ? ", …" : "";
	return `${peers.length} other live pi-lens session${
		peers.length === 1 ? "" : "s"
	} (pid ${pids.join(", ")}${suffix})`;
}

/**
 * Decide whether one worktree-mutating git command may run here.
 *
 * Never throws: a registry read that fails yields an empty peer list, which
 * reads as "no shared checkout" and allows. That direction is deliberate —
 * the registry is observability substrate and an outage of it must not
 * start refusing every branch switch on every machine.
 */
export async function evaluateSharedCheckoutGuard(
	toolName: string,
	input: unknown,
	cwd: string,
	deps: SharedCheckoutGuardDeps = {},
): Promise<SharedCheckoutDecision> {
	if (!isWorktreeMutatingGitAttempt(toolName, input)) return { block: false };
	// #2007: `git -C <dir>` and `--work-tree` retarget the command at a
	// DIFFERENT directory. Evaluating the caller's cwd would inspect the wrong
	// working tree and allow the destructive command against a shared one, so
	// every targeted directory is evaluated and the first contended one wins.
	const targets = resolveGuardTargets(toolName, input, cwd);
	let entries: InstanceEntry[];
	try {
		entries = await (deps.readRegistry ?? readInstanceRegistry)();
	} catch {
		logAllow(normalizeFilePath(cwd), "registry_unreadable");
		return { block: false };
	}
	for (const target of targets) {
		const decision = await evaluateOneTarget(target, entries, deps);
		if (decision.block) return decision;
	}
	return { block: false };
}

/** Distinct directories the command's git invocations actually target. */
function resolveGuardTargets(
	toolName: string,
	input: unknown,
	cwd: string,
): string[] {
	const targets = new Set<string>();
	for (const gitTokens of collectGitInvocations(toolName, input)) {
		if (!matchesWorktreeMutatingVerb(gitTokens)) continue;
		targets.add(resolveGitTargetDirectory(gitTokens, cwd));
	}
	// A wrapper or substitution form the token scan cannot attribute to a
	// directory still matched the classifier, so fall back to the cwd rather
	// than evaluating nothing.
	if (targets.size === 0) targets.add(cwd);
	return [...targets];
}

async function evaluateOneTarget(
	cwd: string,
	entries: InstanceEntry[],
	deps: SharedCheckoutGuardDeps,
): Promise<SharedCheckoutDecision> {
	const root = normalizeFilePath(cwd);
	const resolveToplevel = deps.resolveToplevel ?? resolveGitToplevel;
	const toplevel = await resolveToplevel(cwd);
	if (toplevel === undefined) {
		logAllow(root, "not_a_git_worktree");
		return { block: false };
	}
	const normalizedToplevel = normalizeFilePath(toplevel);
	// Containment against the TOPLEVEL, not against the caller's directory:
	// two sessions in sibling subdirectories of one checkout share it, and
	// comparing them to each other would miss that. Every directory in a
	// working tree is under its own toplevel, so this pre-filter can only
	// admit candidates, never drop a real peer.
	const candidates = selectLivePeerInstances(
		entries,
		normalizedToplevel,
		deps.now ?? Date.now(),
		deps.isPidAlive ?? realIsPidAlive,
		"containment",
	);
	// Path containment is NOT shared-checkout identity. A linked worktree sits
	// at a path nested under the main checkout — this repo puts agent
	// worktrees under `.claude/worktrees/` — and shares no working files with
	// it. Confirm each candidate belongs to the SAME working tree before
	// declining anything, or the guard tells an operator already inside a
	// dedicated worktree to go get a dedicated worktree.
	//
	// #2130: confirm against EVERY root the candidate serves, not only
	// `projectRoot`. `selectLivePeerInstances` admits a candidate when ANY of
	// its roots overlaps the target, so resolving the index-0 root alone drops
	// a peer admitted on a SECONDARY root — and dropping the only peer allows
	// the destructive command. `getInstanceRoots` is the single reader for
	// registry root identity precisely so no caller re-derives it from the
	// scalar field.
	//
	// Cost: at most one `git rev-parse` per distinct root, capped by
	// `INSTANCE_ROOT_CAP` (32) and memoized below, on a path that already
	// spawns one `rev-parse` for the target. The loop short-circuits on the
	// first matching root, so the common single-root peer costs exactly what it
	// did before.
	const toplevelMemo = new Map<string, string | undefined>();
	const resolveToplevelOnce = async (
		dir: string,
	): Promise<string | undefined> => {
		if (toplevelMemo.has(dir)) return toplevelMemo.get(dir);
		const resolved = await resolveToplevel(dir);
		toplevelMemo.set(dir, resolved);
		return resolved;
	};
	const peers: InstanceEntry[] = [];
	for (const candidate of candidates) {
		for (const candidateRoot of getInstanceRoots(candidate)) {
			const peerToplevel = await resolveToplevelOnce(candidateRoot);
			if (
				peerToplevel !== undefined &&
				normalizeFilePath(peerToplevel) === normalizedToplevel
			) {
				peers.push(candidate);
				break;
			}
		}
	}
	if (peers.length === 0) {
		logAllow(root, "no_peer_session");
		return { block: false };
	}
	const state = await (deps.probeWorkingTree ?? probeWorkingTreeState)(cwd);
	if (state === "clean") {
		logAllow(root, "working_tree_clean");
		return { block: false };
	}
	if (state === "unknown") {
		emitBounded(
			"shared_checkout_probe_failed",
			root,
			{
				toolName: "shared-checkout-guard",
				durationMs: 0,
				metadata: { decision: "blocked", peerCount: peers.length },
			},
			{
				ledgerKind: "shared-checkout-probe",
				risingEdgePer: "identity",
				reason: "git status could not report working-tree state",
			},
		);
		return {
			block: true,
			unknown: true,
			reason:
				"🔴 WORKING-TREE CHANGE BLOCKED (--lens-checkout-guard): git could not report whether this checkout has uncommitted work, and it is shared with " +
				`${describePeers(peers)}. Re-run the command once git answers, or take a dedicated git worktree.`,
		};
	}
	emitBounded(
		"shared_checkout_switch_blocked",
		root,
		{
			toolName: "shared-checkout-guard",
			durationMs: 0,
			metadata: { decision: "blocked", peerCount: peers.length },
		},
		{
			ledgerKind: "shared-checkout-wip",
			risingEdgePer: "identity",
			reason: "worktree-mutating git command declined on a shared checkout",
		},
	);
	return {
		block: true,
		reason:
			"🔴 WORKING-TREE CHANGE BLOCKED (--lens-checkout-guard): this checkout has uncommitted changes and is shared with " +
			`${describePeers(peers)}. The command would discard work that may not be yours. ` +
			"Commit the changes first, or run this in a dedicated git worktree.",
	};
}
