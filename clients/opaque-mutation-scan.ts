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
 *   confirm (withHashes captures sha256 up to OPAQUE_HASH_BUDGET_BYTES); a
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
import * as os from "node:os";
import * as path from "node:path";

import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import {
	resolveGitCheckout,
	resolveGitIdentity,
	sameCheckoutOtherRoot,
} from "./review-graph/git-identity.js";
import { collectSourceFilesWithBudgetAsync } from "./source-filter.js";

import { BoundedFifoMap } from "./bounded-cache.js";
import { hashContentBytes } from "./content-stamp.js";
import { scanShellWriteScopes } from "./bash-file-access.js";
import {
	incrementDegradationCount,
	recordDegradationOnce,
} from "./degradation-ledger.js";
import {
	isAtOrAboveHomeDir,
	normalizeMapKey,
	realpathOrResolve,
} from "./path-utils.js";
import { freshnessFromMtime } from "./freshness.js";
import { safeSpawnAsync } from "./safe-spawn.js";
import { createSingleFlight } from "./single-flight.js";
import { truncatedByOutputCap } from "./spawn-output-cap.js";
import { isPiLensToolName } from "./tool-config.js";

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
	/**
	 * #4905: the root is the home folder or above it (`isAtOrAboveHomeDir`), so
	 * its stat-diff walk is refused outright: it always passes the file cap.
	 */
	| "home-root"
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
	/**
	 * #4502: the working-tree paths that were dirty when the command started,
	 * so a same-HEAD discard (`git stash`, `git checkout .`, `git restore`) can
	 * be seen at all: those commands move no HEAD and leave no dirty entry, and
	 * both of the head-move detector's signals are therefore silent while an
	 * open document keeps bytes the disk no longer has. `undefined` when git
	 * could not answer: an empty array would read as "the tree was clean",
	 * which is a different fact.
	 */
	dirtyPaths?: readonly string[];
}

/** A literal tool name of one member of pi's typed `tool_call` union. */
type LiteralToolName<E> = E extends { toolName: infer N extends string }
	? string extends N
		? never
		: N
	: never;

/**
 * #4732: what each of pi's built-in tools can write. Typed against the host's
 * own `ToolCallEvent` union, so a pi release that adds a built-in tool fails to
 * compile here until the tool is placed, and a name pi drops fails too.
 *
 * - `opaque`: a shell, which writes whatever its command does.
 * - `named`: a structured writer; the classified chain records the one path
 *   it names (`classifyMutatingTool`).
 * - `none`: read-only.
 */
const PI_BUILTIN_TOOL_WRITES = new Map<string, "opaque" | "named" | "none">(
	Object.entries({
		bash: "opaque",
		powershell: "opaque",
		write: "named",
		edit: "named",
		read: "none",
		grep: "none",
		find: "none",
		ls: "none",
	} as const satisfies Record<
		LiteralToolName<ToolCallEvent>,
		"opaque" | "named" | "none"
	>),
);

/**
 * Opaque recovery feeds dispatch and LSP resync; it is not read evidence.
 * Keep its lifecycle gate shared by the pre-call baseline and post-call take.
 *
 * #4732: fail closed. A tool is diffed unless its name is known not to write a
 * path pi-lens does not already record: pi's read-only and structured built-ins
 * ({@link PI_BUILTIN_TOOL_WRITES}) and pi-lens's own pi tools
 * ({@link isPiLensToolName}), which are read-only or record every write through the
 * mutation bridge. Every other name (another extension's tool, an MCP tool
 * routed through pi, the outer codemode call) is opaque. A tool whose EVENT the
 * structured classifier recognizes is excluded at the record site, which has
 * the event.
 */
export function shouldRunOpaqueRecovery(
	toolName: string,
	workspaceRoot: string | undefined,
): workspaceRoot is string {
	if (workspaceRoot === undefined) return false;
	const builtin = PI_BUILTIN_TOOL_WRITES.get(toolName);
	if (builtin !== undefined) return builtin === "opaque";
	return !isPiLensToolName(toolName);
}

/**
 * The turn a baseline was recorded in: the session's turn key and the
 * coordinator's liveness test for it (`RuntimeCoordinator.turnKey` and
 * `isLiveTurnKey`, #3613), so a concurrent session's turn stays live.
 */
export interface OpaqueBaselineTurn {
	key: number;
	isLive: (key: number) => boolean;
}

export interface CaptureOptions {
	budgetMs?: number;
	/** Internal test seam for making an absent-evidence verdict reachable. */
	forcedUnknownReason?: OpaqueUnknownReason;
	/**
	 * Read file contents and record sha256 hashes alongside mtime/size. Used on
	 * the stat-diff path so the post-side diff can detect same-tick same-size
	 * rewrites. Bounded by OPAQUE_HASH_BUDGET_BYTES; files past the budget
	 * simply carry no hash (comparison degrades to mtime+size for them).
	 */
	withHashes?: boolean;
	/**
	 * Internal test seam (#4905): the walk's entry budget, so the
	 * `entry-budget-exceeded` verdict is reachable without planting 200,000
	 * directory entries. Absent in production, which takes the walker's default.
	 */
	maxScanEntries?: number;
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
				entry.hash = hashContentBytes(await fs.promises.readFile(file));
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
	if (options.forcedUnknownReason !== undefined) {
		return { unknownReason: options.forcedUnknownReason, scannedCount: 0 };
	}
	// #4905: the home folder (or a folder above it) holds more than the file cap
	// of files on any real machine, so the walk below would spend its time and
	// end at `file-cap-exceeded`. Same rule as `analysis-root`, `jscpd-client`
	// and `lsp/index` (#4760): refuse, and let the caller read it as UNKNOWN.
	// By real path on both sides, as `analysis-root` does (#4689): a root or a
	// HOME spelled through a link names the same folder.
	if (
		isAtOrAboveHomeDir(realpathOrResolve(root), realpathOrResolve(os.homedir()))
	)
		return { unknownReason: "home-root", scannedCount: 0 };
	const rootKey = normalizeMapKey(root);
	// #4905: `budgetMs` below paces the walk's event-loop yields (the walker
	// resets that deadline after every directory read); it does not bound the
	// walk's wall time. A root already found over the file cap would pay the
	// whole walk again on every call, so the verdict is kept until the session
	// ends.
	if (overCapRootMemo.has(rootKey))
		return { unknownReason: "file-cap-exceeded", scannedCount: 0 };
	const budgetMs = options.budgetMs ?? 50;
	try {
		const walk = await collectSourceFilesWithBudgetAsync(root, {
			maxFiles: OPAQUE_SCAN_MAX_FILES + 1,
			budgetMs,
			...(options.maxScanEntries === undefined
				? {}
				: { maxScanEntries: options.maxScanEntries }),
		});
		const files = walk.files;
		if (walk.entryBudgetExceeded || files.length > OPAQUE_SCAN_MAX_FILES) {
			// A PARTIAL universe must never read as a confident diff (invariant
			// 3): writes in the unvisited tail would silently vanish.
			const unknownReason = walk.entryBudgetExceeded
				? "entry-budget-exceeded"
				: "file-cap-exceeded";
			if (unknownReason === "file-cap-exceeded")
				overCapRootMemo.set(rootKey, true);
			return { unknownReason, scannedCount: files.length };
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
 * Return paths confirmed different by hashes, plus files absent before and
 * present after. A missing baseline entry is evidence of creation; a missing
 * hash on an existing entry remains unknown.
 */
export function diffFileContent(
	before: FileStatsSnapshot,
	after: FileStatsSnapshot,
): string[] {
	const changed: string[] = [];
	for (const [key, stat] of after) {
		const previous = before.get(key);
		if (
			previous === undefined ||
			(previous.hash !== undefined &&
				stat.hash !== undefined &&
				previous.hash !== stat.hash)
		) {
			changed.push(key);
		}
	}
	return changed;
}

/**
 * The ONE root a prescan record is captured and consumed against: the session's
 * own working directory, which is where the host runs the bash command and so
 * the tree its writes land in.
 *
 * Both hooks ask this function, because a record written under one root and
 * looked up under another reports `no-pending-snapshot` for a command that did
 * write (#4504). `ctx.cwd` is per-session and frozen: it projects the same
 * `_cwd` field the tools are constructed with and is never reassigned
 * (`tests/clients/pi-host-contract.test.ts`), so one session's two hooks
 * resolve the same value. The fallback is the coordinator's `projectRoot`, the
 * only answer a host that offers no cwd leaves, and it is the same answer at
 * both hooks. The root that differs between the two hooks in production is a
 * concurrent secondary session's (#473): it is declined by the #2129 guard, so
 * the coordinator keeps the live primary's root while `ctx.cwd` is its own.
 */
export function opaquePrescanRoot(
	sessionCwd: string | undefined,
	/** The coordinator's `projectRoot`, resolved by the caller for its host. */
	projectRoot: string,
): string {
	return sessionCwd ?? projectRoot;
}

/**
 * Extra checkouts one bash command may be recovered from, beside the session
 * root. Bounded because the population comes from the command's own text: a
 * generated `cd` chain cannot turn one bash call into a repository sweep. A
 * target past the cap is REFUSED and recorded, never silently dropped.
 */
export const OPAQUE_RECOVERY_ROOT_CAP = 4;

/** Why a checkout the command named is not a recovery root (#2050). */
export type OpaqueRootRefusal =
	/** A checkout of a DIFFERENT repository: #4242's re-root lane, not this one. */
	| "different-repository"
	/** The session root is not a checkout, so no `commonDir` can be compared. */
	| "session-root-not-a-checkout";

export interface OpaqueRecoveryRoots {
	/** Roots this call's writes are recovered from: the session root first. */
	roots: string[];
	/** Named checkouts that were NOT admitted, with the reason. */
	refused: Array<{ root: string; reason: OpaqueRootRefusal }>;
	/** Named checkouts past {@link OPAQUE_RECOVERY_ROOT_CAP}. */
	capped: string[];
}

/**
 * The checkouts one bash command's writes are recovered from (#2050).
 *
 * The session root is always first, because the host runs the command there.
 * Every further root comes from the command's OWN text — a `cd`/`pushd`
 * target, or a recognised write operand — and is admitted only when its
 * checkout is a linked worktree of the SESSION's repository, the #3871
 * `sameCheckoutOtherRoot` rule (equal `commonDir`, different top level). A
 * sibling checkout, a nested worktree under the session root, and a worktree
 * reached only by an absolute operand all qualify; another repository does
 * not, and is reported rather than scanned.
 *
 * Deliberately NOT a scan of every registered worktree: the command must name
 * the tree, so the cost stays one `git status` per named root and the answer
 * never widens beyond what the command demonstrably touched.
 *
 * Pure filesystem reads (`resolveGitCheckout` spawns nothing), so the `tool_call`
 * and `tool_result` hooks derive the same list from one command text and one
 * session root — the #4504 rule, now per root.
 */
export function resolveOpaqueRecoveryRoots(
	command: string,
	sessionRoot: string,
): OpaqueRecoveryRoots {
	const roots = [sessionRoot];
	const refused: OpaqueRecoveryRoots["refused"] = [];
	const capped: string[] = [];
	const session = resolveGitCheckout(sessionRoot);
	const admitted = new Set<string>([
		normalizeMapKey(path.resolve(sessionRoot)),
	]);
	if (session) admitted.add(normalizeMapKey(session.root));
	const scan = scanShellWriteScopes(command, sessionRoot);
	// `cd` targets first: they name a tree directly. A recognised write names a
	// FILE, so its checkout is resolved at the file's directory.
	const candidates: Array<{ owner: string; lookup: string }> = [
		...scan.cdTargets.map((dir) => ({ owner: dir, lookup: dir })),
		...scan.written.map((file) => ({
			owner: file,
			lookup: path.dirname(file),
		})),
	];
	const considered = new Set<string>();
	let extra = 0;
	for (const candidate of candidates) {
		const candidateKey = normalizeMapKey(path.resolve(candidate.owner));
		if (considered.has(candidateKey)) continue;
		considered.add(candidateKey);
		if (admitted.has(candidateKey)) continue;
		const checkout = resolveGitCheckout(candidate.lookup);
		// Not a checkout: there is no checkout identity to recover against, and
		// nothing here can claim anything about it.
		if (!checkout) continue;
		const rootKey = normalizeMapKey(checkout.root);
		if (admitted.has(rootKey)) continue;
		if (!session) {
			// Nothing to compare a commondir against. Say so once rather than
			// treating an unrelated tree as if it were this session's.
			refused.push({
				root: checkout.root,
				reason: "session-root-not-a-checkout",
			});
			continue;
		}
		if (!sameCheckoutOtherRoot(session, checkout)) {
			refused.push({ root: checkout.root, reason: "different-repository" });
			continue;
		}
		if (extra >= OPAQUE_RECOVERY_ROOT_CAP) {
			capped.push(checkout.root);
			continue;
		}
		extra += 1;
		admitted.add(rootKey);
		roots.push(checkout.root);
	}
	return { roots, refused, capped };
}

const ROOT_REFUSAL_REASONS: Record<OpaqueRootRefusal, string> = {
	"different-repository":
		"a bash command named a git checkout in another repository; its writes were not observed (only a linked worktree of the session's own repository is recovered, #2050)",
	"session-root-not-a-checkout":
		"a bash command named a git checkout, but the session root is not one, so no commonDir could be compared and its writes were not observed",
};

/**
 * Record, once per root and session, every checkout a bash command named that
 * no baseline was taken for (#2050): a refusal is visible rather than read as
 * "that command wrote nothing". The cap is one record per session, because it
 * describes the bound, not a tree.
 */
export function recordOpaqueRootRefusals(scopes: OpaqueRecoveryRoots): void {
	for (const { root, reason } of scopes.refused)
		recordDegradationOnce({
			kind: "opaque-recovery-root-refused",
			subject: normalizeMapKey(root),
			reason: ROOT_REFUSAL_REASONS[reason],
		});
	if (scopes.capped.length > 0)
		recordDegradationOnce({
			kind: "opaque-recovery-root-refused",
			subject: "cap",
			reason: `a bash command named more than ${OPAQUE_RECOVERY_ROOT_CAP} checkouts of this repository; the ones past the cap had no baseline taken and their writes were not observed`,
		});
}

/**
 * The session-stamped slot (`<cwd>:<generation>`) a baseline lives in, derived
 * once for the `tool_call` record and the `tool_result` take (shape 19). The
 * generation keeps a concurrent-secondary session (#473) from consuming another
 * session's baseline; the root half is {@link opaquePrescanRoot}.
 */
export function opaqueBaselineSlot(
	scanRoot: string,
	sessionGeneration: number,
): string {
	return `${normalizeMapKey(path.resolve(scanRoot))}:${sessionGeneration}`;
}

/**
 * Upper bound on baselines awaiting their `tool_result`, so per-call keying
 * keeps the bound a one-entry slot had by construction. Real batches are a
 * handful of calls; a codemode fan-out of dozens still fits.
 */
export const OPAQUE_BASELINE_PENDING_CAP = 64;

/**
 * Baselines awaiting their `tool_result`, one entry per bash call (#4137).
 *
 * pi runs the bash calls of one assistant message in parallel (top level and
 * codemode's nested `Promise.all` alike), so all N `tool_call`s precede the
 * first `tool_result`. A slot per cwd kept the last baseline and N-1 calls lost
 * the evidence that proves they authored their own writes. The tool-call id
 * gives each call its own entry; a host that supplies no id keeps the shared
 * slot, the only identity it offers.
 *
 * A call's recovery window also holds its siblings' writes, which it dispatches
 * as opaque; the pipeline dedupe ranks authority, so the sibling's own authored
 * dispatch of the same bytes still runs (`claimPipelineDispatch`).
 */
export class OpaqueBaselineStore {
	private readonly pending = new BoundedFifoMap<
		string,
		{ state: PendingOpaqueBaseline; turn: OpaqueBaselineTurn | undefined }
	>(OPAQUE_BASELINE_PENDING_CAP);

	private static keyOf(slot: string, callId: string | undefined): string {
		return callId === undefined ? slot : `${slot}#${callId}`;
	}

	/**
	 * Store `state` for a call. A baseline this displaces is lost: its
	 * `tool_result` will find nothing and report `partial-recognition-no-baseline`,
	 * withholding the blocker section of a write the agent authored. That loss is
	 * counted in the degradation ledger, one entry per cause with a running count,
	 * never one row per occurrence (#4137).
	 *
	 * First, an entry whose turn is over is retired: pi sends no `tool_result`
	 * for a call a `tool_call` handler blocked or Escape aborted before it ran,
	 * and on a non-git project the entry holds a whole-tree stat snapshot.
	 */
	record(
		slot: string,
		callId: string | undefined,
		state: PendingOpaqueBaseline,
		turn?: OpaqueBaselineTurn,
	): void {
		for (const [staleKey, entry] of this.pending.entriesArray())
			if (entry.turn && !entry.turn.isLive(entry.turn.key)) {
				this.pending.delete(staleKey);
				recordBaselineLoss("unsettled");
			}
		const key = OpaqueBaselineStore.keyOf(slot, callId);
		const overwrote = this.pending.delete(key);
		const evicted = this.pending.set(key, { state, turn });
		if (overwrote) recordBaselineLoss("overwrite");
		if (evicted.length > 0) recordBaselineLoss("cap");
	}

	/**
	 * #4732: whether `tool_call` recorded a baseline for this call. A tool other
	 * than bash recovers only then, so its `tool_result` follows the decision its
	 * own `tool_call` made instead of re-deriving it (shape 19).
	 */
	has(slot: string, callId: string): boolean {
		return this.pending.has(OpaqueBaselineStore.keyOf(slot, callId));
	}

	take(
		slot: string,
		callId: string | undefined,
	): PendingOpaqueBaseline | undefined {
		const key = OpaqueBaselineStore.keyOf(slot, callId);
		const entry = this.pending.get(key);
		this.pending.delete(key);
		return entry?.state;
	}

	/** Session-boundary clear - unconsumed baselines are unreachable after reset. */
	takeAllForTest(): void {
		this.pending.clear();
	}
}

const BASELINE_LOSS_REASONS = {
	overwrite:
		"a pending opaque baseline (bash or another captured tool) was replaced before its tool_result took it; that call reports partial-recognition-no-baseline and withholds blockers (host without distinct tool-call ids, or a reused id)",
	cap: `more than ${OPAQUE_BASELINE_PENDING_CAP} opaque baselines (bash or other captured tools) awaited a tool_result; the oldest was dropped`,
	unsettled:
		"an opaque baseline (bash or another captured tool) outlived its turn with no tool_result (the call was blocked or aborted before it ran) and was retired; a result that still arrives reports partial-recognition-no-baseline",
} as const;

/**
 * #4732: record, once per cause and session, that a tool other than bash was
 * not diffed or its diff could not answer, so its writes went unobserved.
 * Subject `no-tool-call-id`: the host gave the call no id, and a shared slot
 * would let it take a bash call's baseline. Any other subject is the recovery's
 * unknown verdict (`git-failed`, `file-cap-exceeded`, ...).
 */
export function recordOpaqueCaptureRefused(
	cause: string,
	toolName: string,
): void {
	recordDegradationOnce({
		kind: "opaque-capture-refused",
		subject: cause,
		reason:
			cause === "no-tool-call-id"
				? `a call of ${toolName} carried no tool-call id, so its writes were not diffed (a shared slot would take a bash call's baseline)`
				: `the opaque diff of a ${toolName} call could not answer (${cause}); the files it wrote were not observed`,
	});
}

function recordBaselineLoss(cause: keyof typeof BASELINE_LOSS_REASONS): void {
	incrementDegradationCount({
		kind: "opaque-baseline-lost",
		subject: cause,
		reason: BASELINE_LOSS_REASONS[cause],
	});
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
 * #4905: roots whose stat walk answered `file-cap-exceeded`, so the next call
 * in the session answers the same without walking. Bounded (a session names
 * few roots), and cleared with the rest of this module at the session
 * boundary, so a tree that shrank is walked again by the next session.
 */
const overCapRootMemo = new BoundedFifoMap<string, true>(16);

/**
 * Session-boundary clear (#1635): unconsumed pending baselines are keyed by
 * cwd:generation, so entries from a finished session are unreachable; and a
 * directory that was not a worktree last session may be one now. Without this
 * reset both leak and mis-answer forever.
 */
export function resetOpaqueMutationState(): void {
	getOpaqueBaselineStore().takeAllForTest();
	gitRepoMemo.clear();
	overCapRootMemo.clear();
	gitToplevelMemo.clear();
	headRecords.clear();
	headLooks.clear();
	pendingHeadDiscards.clear();
}

/**
 * #4493: the HEAD each session last saw in a scan slot, so a clean-tree HEAD
 * move (checkout, reset --hard, a completed rebase or cherry-pick, or one made
 * outside pi) is seen at all: `git status` is empty after one. Keyed by
 * {@link headRecordKey}, so one session never reads or writes another's.
 * Cleared with the rest of this module at the session boundary, where the LSP
 * service resets too, so no held document outlives its record.
 */
const HEAD_RECORD_CAP = 64;
const headRecords = new BoundedFifoMap<string, string>(HEAD_RECORD_CAP);

/** One session's HEAD record key in a scan slot ({@link opaqueBaselineSlot}). */
export function headRecordKey(
	slot: string,
	sessionId: string | undefined,
): string {
	return `${slot}|${sessionId ?? ""}`;
}

/**
 * The same-HEAD discard paths a look of `key` still owes a publish (#4612 r4).
 * The bash `tool_result` reads its own discard set from its own baseline, then
 * hands it to a look; a look that arrives while another of its key is in
 * flight JOINS it ({@link serializeHeadLook} coalescing), so its own closure
 * never runs and its set would be dropped on the floor. Each caller adds its
 * paths here in the same synchronous step as its join, and a pass drains its
 * key first, before any await: the running pass has either not drained yet
 * (it takes the paths) or has (the join earned a trailing pass, which takes
 * them).
 *
 * Keyed by the look key ({@link headRecordKey}, which carries the session id
 * and the generation, so a late pass never drains another session's set),
 * bounded by {@link HEAD_RECORD_CAP} keys, each holding only what arrived
 * during one pass, and cleared with the rest of this module at the session
 * boundary.
 */
const pendingHeadDiscards = new BoundedFifoMap<string, Set<string>>(
	HEAD_RECORD_CAP,
);

/** Hand this call's discard paths to the look of `key` that will publish them. */
export function addHeadDiscards(
	key: string,
	paths: readonly string[] | undefined,
): void {
	if (!paths || paths.length === 0) return;
	const pending = pendingHeadDiscards.get(key) ?? new Set<string>();
	for (const filePath of paths) pending.add(filePath);
	pendingHeadDiscards.set(key, pending);
}

/** Every discard path owed to `key`, in arrival order, and forget them. */
export function takeHeadDiscards(key: string): string[] {
	const pending = pendingHeadDiscards.get(key);
	if (!pending) return [];
	pendingHeadDiscards.delete(key);
	return [...pending];
}

/**
 * Test and diagnostic probe (#4612 r4): does a look of `key` in flight owe a
 * trailing pass? A joining caller's own closure never runs, so a join is
 * otherwise unobservable before the flight settles.
 */
export function headLookPendingRerun(key: string): boolean {
	return headLooks.hasPendingRerun(key);
}

/**
 * Record `head` for `key` and return the HEAD it replaces when that differs:
 * the move to resync. A first observation returns `undefined`. Synchronous, so
 * two looks cannot both claim a move; {@link serializeHeadLook} keeps the
 * looks of one key in order.
 */
export function observeGitHead(key: string, head: string): string | undefined {
	const previous = headRecords.get(key);
	headRecords.delete(key);
	headRecords.set(key, head);
	return previous !== undefined && previous !== head ? previous : undefined;
}

/**
 * #4493: one HEAD look per record key at a time. A session's parallel tool
 * calls look concurrently. A look that arrives mid-flight joins it: it returns
 * only once the flight has sent the move's bytes to the primary servers, so a
 * parallel read or edit never runs against the stale view (review r1 F1). It
 * also gets one trailing look of its own, which reads HEAD after the flight,
 * so a move made after the flight read HEAD is seen before it returns (review
 * r1 F2, #1687's shape). An entry lives while its flight runs.
 */
const headLooks = createSingleFlight<void>({ coalesceTrailing: true });

/** Run `look` as the only HEAD look of `key` in flight. */
export function serializeHeadLook(
	key: string,
	look: () => Promise<void>,
): Promise<void> {
	return headLooks.run(key, look);
}

const COMMIT_ID = /^[0-9a-f]{40,64}$/;

/**
 * HEAD's commit id, or `undefined` for an unborn HEAD or a failed read. Every
 * non-bash tool_call looks, so the common case reads the files git keeps
 * (`resolveGitIdentity`: HEAD, the loose ref, packed-refs; about 0.05 ms)
 * and spawns `git rev-parse` only when those cannot answer: a reftable ref
 * store, a SHA-256 detached HEAD, or anything else they do not resolve.
 */
export async function readGitHead(root: string): Promise<string | undefined> {
	const fromFiles = resolveGitIdentity(root)?.headCommit;
	if (fromFiles && COMMIT_ID.test(fromFiles)) return fromFiles;
	const result = await safeSpawnAsync(
		"git",
		["rev-parse", "--verify", "-q", "HEAD"],
		{ cwd: root, timeout: 3000 },
	);
	const head =
		!result.error && result.status === 0 ? result.stdout?.trim() : undefined;
	return head && COMMIT_ID.test(head) ? head : undefined;
}

/**
 * The directory git prints porcelain and diff paths relative to: the top of
 * the checkout `root` is in, in `root`'s own spelling (git's own toplevel is
 * a real path). Read from files; `root` itself when that cannot answer.
 *
 * The walk skips a `.git` directory with no HEAD as git does (a stray
 * `/tmp/.git` once sent every path to `/tmp`).
 */
function gitPathBase(root: string): string {
	return resolveGitCheckout(root)?.spelledRoot ?? root;
}

/**
 * The files that differ between commits `from` and `to`, as map keys, or
 * `undefined` when git failed or the listing was cut. The whole checkout's
 * delta, so a held document outside a subdirectory cwd is in it too;
 * `--no-renames` lists both sides of a rename.
 */
export async function listGitHeadDelta(
	root: string,
	from: string,
	to: string,
): Promise<string[] | undefined> {
	const result = await safeSpawnAsync(
		"git",
		["diff", "--name-only", "--no-renames", "-z", from, to],
		{ cwd: root, timeout: 5000, maxOutputBytes: MAX_GIT_STATUS_OUTPUT_BYTES },
	);
	if (truncatedByOutputCap(result) || result.error || result.status !== 0)
		return undefined;
	const base = gitPathBase(root);
	return (result.stdout ?? "")
		.split("\0")
		.filter(Boolean)
		.map((relPath) => normalizeMapKey(path.resolve(base, relPath)));
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
	/**
	 * Destinations resolved by the bash prescan. These paths are checked by
	 * content against HEAD and the index because `mv`, `cp -p`, `rsync -a`,
	 * and archive extraction can preserve an old mtime.
	 */
	namedPaths?: readonly string[];
}

interface GitStatusEntry {
	status: string;
	absPath: string;
	/**
	 * A rename's or copy's SOURCE side (#4612 r4). Porcelain v1 `-z` gives such
	 * an entry as two NUL-separated tokens, `XY <new>` then `<old>`, so the
	 * destination alone is one side of one entry. Recovery keeps using
	 * `absPath` only (the bytes on disk are the destination's), while the
	 * same-HEAD discard baseline needs both sides: `git reset --hard HEAD`
	 * restores the source and removes the destination, which leaves the
	 * destination absent from the tree and the source never named.
	 */
	renamedFrom?: string;
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
 * One `git status --porcelain -z` read, parsed into typed entries, or the
 * reason it could not be trusted. Extracted so the two consumers of the same
 * bytes share one parser: {@link recoverOpaqueChangesViaGit} filters these
 * entries through its mtime window, and {@link captureGitDirtyPaths} /
 * {@link readSameHeadDiscards} compare the set before and after a command
 * (#4502). A second hand-rolled porcelain parser is a second chance to disagree
 * about a rename, a `!!` entry or an untrusted pair.
 */
async function readGitStatusEntries({
	cwd,
}: {
	cwd: string;
}): Promise<
	| { verdict: "ok"; entries: GitStatusEntry[]; unknownStatusCount: number }
	| { verdict: "unknown"; unknownReason: OpaqueUnknownReason }
> {
	const result = await safeSpawnAsync(
		"git",
		["status", "--porcelain", "-z", "--untracked-files=all"],
		{
			cwd,
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
	if (truncatedByOutputCap(result))
		return { verdict: "unknown", unknownReason: "git-status-parse-failed" };
	if (result.error || (result.status !== 0 && result.status !== null))
		return { verdict: "unknown", unknownReason: "git-failed" };
	const raw = result.stdout ?? "";
	if (raw && !raw.endsWith("\0"))
		return { verdict: "unknown", unknownReason: "git-status-parse-failed" };
	// Porcelain paths are relative to the top of the checkout, not to `cwd`
	// (#4493 residual 3): from a subdirectory each one pointed below itself.
	const base = gitPathBase(cwd);
	const entries: GitStatusEntry[] = [];
	let unknownStatusCount = 0;
	// A rename's or copy's OLD path follows its NEW path as the next token; this
	// is the entry still waiting for it.
	let awaitingSource: GitStatusEntry | undefined;
	for (const token of raw.split("\0")) {
		if (!token) continue;
		if (awaitingSource) {
			awaitingSource.renamedFrom = path.resolve(base, token);
			awaitingSource = undefined;
			continue;
		}
		// Each entry: two status chars, one space, then the path.
		if (token.length < 4 || token[2] !== " ")
			return { verdict: "unknown", unknownReason: "git-status-parse-failed" };
		const status = token.slice(0, 2);
		const relPath = token.slice(3);
		if (!isStructurallyValidStatus(status) || !relPath)
			return { verdict: "unknown", unknownReason: "git-status-parse-failed" };
		if (!isKnownPorcelainStatus(status)) unknownStatusCount += 1;
		const entry: GitStatusEntry = {
			status,
			absPath: path.resolve(base, relPath),
		};
		entries.push(entry);
		if (status.includes("R") || status.includes("C")) awaitingSource = entry;
	}
	if (awaitingSource)
		return { verdict: "unknown", unknownReason: "git-status-parse-failed" };
	return { verdict: "ok", entries, unknownStatusCount };
}

/**
 * The cap on the dirty set one bash call records before it runs (#4502). A
 * discard restores at most the working tree, and an open document set is far
 * smaller than a checkout, so the bound costs nothing real while keeping the
 * pending baseline's memory and the post-command comparison bounded.
 */
export const SAME_HEAD_DIRTY_SET_CAP = 512;

/**
 * The working-tree paths that are dirty NOW, as map keys, or `undefined` when
 * git could not answer. Recorded before a bash command so a same-HEAD discard
 * (`git stash`, `git checkout .`, `git restore`) can be seen at all: those
 * commands leave `git status` clean and HEAD unmoved, so the delta and the
 * dirty set AFTER the command both name nothing.
 *
 * Bounded twice: the porcelain read by `MAX_GIT_STATUS_OUTPUT_BYTES`, and the
 * recorded set by {@link SAME_HEAD_DIRTY_SET_CAP}. A cut set keeps its first
 * `SAME_HEAD_DIRTY_SET_CAP` entries and reports itself, never silently.
 */
export async function captureGitDirtyPaths(
	root: string,
): Promise<string[] | undefined> {
	const read = await readGitStatusEntries({ cwd: root });
	if (read.verdict === "unknown") return undefined;
	// BOTH sides of a rename or copy (#4612 r4). `git reset --hard HEAD`
	// restores the source and removes the destination without moving HEAD, so a
	// baseline that recorded only the destination names a path the discard
	// removed and never the one it rewrote: the restored source kept its
	// pre-discard server copy. Recovery keeps using the destination alone
	// ({@link recoverOpaqueChangesViaGit}) — the bytes on disk are its subject.
	const named: string[] = [];
	for (const entry of read.entries) {
		// `!!` is an ignored path, not a change a discard could revert; every
		// other status names bytes a discard can rewrite or remove.
		if (entry.status === "!!") continue;
		named.push(entry.absPath);
		if (entry.renamedFrom !== undefined) named.push(entry.renamedFrom);
	}
	const dirty: string[] = [];
	const seen = new Set<string>();
	for (const side of named) {
		const key = normalizeMapKey(side);
		if (seen.has(key)) continue;
		if (dirty.length === SAME_HEAD_DIRTY_SET_CAP) {
			incrementDegradationCount({
				kind: "same-head-discard-set-capped",
				subject: normalizeMapKey(path.resolve(root)),
				reason: `more than ${SAME_HEAD_DIRTY_SET_CAP} working-tree paths were dirty before a bash call; a same-HEAD discard that reverts one of the rest is not detected for this call`,
			});
			break;
		}
		seen.add(key);
		dirty.push(key);
	}
	return dirty;
}

/**
 * The paths that were dirty before a command and are clean after it (#4502):
 * the files a same-HEAD discard reverted. `undefined` when git could not answer
 * now, so the caller resyncs nothing rather than guessing.
 *
 * A path that is merely absent from the new status is not a discard — a
 * rejected command, an unreadable subtree — but the read itself proves the
 * file is clean, and a clean file whose MTime moved is exactly what the drift
 * pass can still check: the publish this feeds compares the server's bytes with
 * the disk's, so a path whose bytes did not change costs one read and sends
 * nothing.
 */
export async function readSameHeadDiscards(
	root: string,
	dirtyBefore: readonly string[],
): Promise<string[] | undefined> {
	if (dirtyBefore.length === 0) return [];
	const read = await readGitStatusEntries({ cwd: root });
	if (read.verdict === "unknown") return undefined;
	// Both sides of a rename or copy count as still-dirty (#4612 r4): a baseline
	// that named a rename's source would otherwise read it as discarded on every
	// call of a rename that is still staged.
	const dirtyNow = new Set<string>();
	for (const entry of read.entries) {
		dirtyNow.add(normalizeMapKey(entry.absPath));
		if (entry.renamedFrom !== undefined)
			dirtyNow.add(normalizeMapKey(entry.renamedFrom));
	}
	return dirtyBefore.filter((filePath) => !dirtyNow.has(filePath));
}

/**
 * Files dirty in the working tree whose mtime falls inside
 * [startedAt - tolerance, now]. Destinations named by the bash prescan use a
 * content comparison instead, so a preserved mtime does not hide a write.
 * Porcelain -z parsing handles renames: the NEW path is the one filtered, and
 * the entry's source side (`renamedFrom`) is ignored here.
 */
export async function recoverOpaqueChangesViaGit(
	root: string,
	startedAt: number,
	options: GitRecoveryOptions = {},
): Promise<GitRecoveryOutcome> {
	const read = await readGitStatusEntries({ cwd: root });
	if (read.verdict === "unknown") {
		return {
			verdict: "unknown",
			paths: [],
			unknownReason: read.unknownReason,
			scannedCount: 0,
		};
	}
	const { entries, unknownStatusCount } = read;

	const hasUnmerged = entries.some((entry) => isUnmergedStatus(entry.status));
	const floorMs = startedAt - OPAQUE_MTIME_TOLERANCE_MS;
	const namedPaths = new Set(
		(options.namedPaths ?? []).map((file) =>
			normalizeMapKey(realpathOrResolve(file)),
		),
	);
	async function differsFromHeadOrIndex(absPath: string): Promise<boolean> {
		const relative = path.relative(gitPathBase(root), absPath);
		for (const args of [
			["diff", "--quiet", "HEAD", "--", relative],
			["diff", "--quiet", "--", relative],
		]) {
			const result = await safeSpawnAsync("git", args, {
				cwd: root,
				timeout: 3000,
			});
			if (result.error || (result.status !== 0 && result.status !== 1))
				return true;
			if (result.status === 1) return true;
		}
		return false;
	}
	// Kernel "stale" = modified AFTER the window floor - exactly the writes
	// this command may have authored, so exactly the entries that would be
	// dispatched absent any other filtering.
	async function isChanged(absPath: string, status: string): Promise<boolean> {
		if (namedPaths.has(normalizeMapKey(realpathOrResolve(absPath)))) {
			try {
				if (!(await fs.promises.stat(absPath)).isFile()) return false;
			} catch {
				return false;
			}
			// Untracked: no HEAD or index copy to compare, so a named file that
			// exists is the write (`mv ../old.ts src/new.ts` keeps the old mtime).
			return status === "??" || differsFromHeadOrIndex(absPath);
		}
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
			if (await isChanged(entry.absPath, entry.status))
				excludedIncomingCount += 1;
		}
		candidates = kept;
	}
	const paths: string[] = [];
	for (const { absPath, status } of candidates) {
		if (await isChanged(absPath, status)) paths.push(normalizeMapKey(absPath));
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
