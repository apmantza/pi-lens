import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ActionableWarningRecord } from "./actionable-warnings.js";
import type { FunctionCallGraph } from "./call-graph.js";
import type { WordIndex } from "./word-index.js";
import type { CascadeRun } from "./cascade-types.js";
import { logCascade } from "./cascade-logger.js";
import {
	appendProjectChangeAllocated,
	appendProjectChangesAllocated,
	type ProjectChangeRange,
	type ProjectChangeSource,
} from "./project-changes.js";
import type { CodeQualityWarningRecord } from "./code-quality-warnings.js";
import type { Diagnostic } from "./dispatch/types.js";
import {
	ANY_POSITION,
	foldedFindingIdentity,
	retainRecordedFindings,
} from "./finding-identity.js";
import { formatDiagnostics } from "./dispatch/utils/format-utils.js";
import {
	inlineBlockerLines,
	inlineBlockerSourceOf,
	inlineBlockerSources,
	isCrossFileBlocker,
} from "./inline-blocker-fields.js";
import type { MutationKind } from "./mutating-tool.js";
import {
	normalizeMapKey,
	pathsEqual,
	realpathOrResolve,
} from "./path-utils.js";
import { PathKeyedMap } from "./path-keyed-map.js";
import { BoundedFifoMap, BoundedLruCache } from "./bounded-cache.js";
import { type AnalysisAnchor, owedByContentOnly } from "./line-alignment.js";
import {
	type PartialApplyPending,
	PartialApplyRecordStore,
} from "./partial-edit-apply.js";
import { ReadGuard } from "./read-guard.js";
import type { RuleScanResult } from "./rules-scanner.js";
import { RUNTIME_CONFIG } from "./runtime-config.js";
import { TurnSummaryCollector } from "./turn-summary.js";
import { deriveProviderFromModelId } from "./model-provider.js";
import { beginTurnContext, setTurnContextSession } from "./turn-context.js";
import {
	incrementDegradationCount,
	recordDegradationOnce,
} from "./degradation-ledger.js";
import { WriteOrderingGuard, writeOrderToken } from "./write-ordering-guard.js";
import { getProcessSingleton } from "./process-singletons.js";
import type { GenerationHandle } from "./generation-guard.js";
import {
	canWriteAnalysisRoot,
	type AnalysisRootMode,
} from "./analysis-root.js";
import {
	beginScope,
	type LineageHandle,
	nextOrderTurn,
	retireScope,
	scopeCell,
	type SessionScope,
	sessionCell,
} from "./session-scope.js";

/** Keep deferred cascade admission bounded without dropping late findings. */
export const MAX_PENDING_CASCADE_RUNS = 32;

function nextTelemetrySessionId(): string {
	const state = getProcessSingleton("runtime-coordinator-telemetry", 1, () => ({
		processId: randomBytes(6).toString("hex"),
		nextGeneration: 0,
	}));
	return `lens-${state.processId}-${++state.nextGeneration}`;
}

/**
 * Lanes whose cut advisory items may be parked at once (#3813/#3901): the
 * knip roots, dead-code clients and the call-graph lane of one session. The
 * oldest is evicted past it, and the eviction is counted by the caller.
 */
export const MAX_CUT_ADVISORY_LANES = 16;

/**
 * Every background startup scan name. `session_start` starts scans under these
 * names, the defer table in `runtime-session.ts` is keyed by them, and the
 * in-flight ledger below is read by name in `runtime-turn.ts`. One type makes a
 * misspelled or orphan name fail the build (#4352).
 */
export type StartupTaskName =
	| "todo"
	| "dead-code"
	| "knip"
	| "jscpd"
	| "govulncheck"
	| "gitleaks"
	| "opengrep"
	| "madge"
	| "trivy"
	| "call-graph"
	| "codebase-model"
	| "ast-grep-exports"
	| "word-index";

export interface ErrorDebtBaseline {
	testsPassed: boolean;
	buildPassed: boolean;
}

export interface CascadeSessionStats {
	runs: number;
	diagnosticsSurfaced: number;
	coldSnapshotTouches: number;
}

/**
 * One attributed mutation, recorded by {@link RuntimeCoordinator.recordProjectMutation}
 * alongside its projectSeq bump. This is the in-memory receipt for "who touched
 * this file, when, through which path" — the queryable twin of the durable
 * change-log entry. Consumers derive mutation answers from
 * {@link RuntimeCoordinator.getMutationsSince} instead of re-walking the JSONL.
 */
export interface MutationReceipt {
	/** projectSeq stamped by the bump this receipt rode on. */
	seq: number;
	/** normalizeMapKey + resolve form — same as getFilesChangedSince keys. */
	filePath: string;
	source: ProjectChangeSource;
	turnIndex: number;
	ts: number;
}

/**
 * Bounded receipt ring capacity (defect shape 9: bound the axis that grows —
 * per-mutation receipts are unbounded across a long session). Oldest receipts
 * evict first; eviction is counted and surfaced via
 * {@link RuntimeCoordinator.droppedMutationReceiptCount} so a consumer that
 * needs a complete window knows the answer was truncated, never silently
 * incomplete (#936 honesty rule).
 */
const MAX_MUTATION_RECEIPTS = 512;

/**
 * #3511 review S2: once per session and project, record why this runtime's
 * snapshots stopped being servable as fresh. Without it a monitor sees only
 * never-fresh snapshots. A runtime at seq 0 cannot tell a sibling from a
 * timed-out session_start read; the timeout has its own ledger kind.
 */
function recordViewIncomplete(
	cwd: string,
	cause: { ownSeq: number; logMaxSeq: number },
): void {
	const why = `the change log reached seq ${cause.logMaxSeq} while this runtime was at ${cause.ownSeq} (${
		cause.ownSeq === 0
			? "a sibling process, or a timed-out session_start read that seeded 0; see snapshot-sequence-read-timeout"
			: "a sibling process logged above it"
	})`;
	recordDegradationOnce({
		kind: "snapshot-view-incomplete",
		subject: path.resolve(cwd),
		reason: `snapshots are stamped incomplete (never fresh) until the next seed from the change log: ${why}`,
	});
}

export type DeferredMutationKind = "autofix" | "format";

export interface PathSetLike {
	add(value: string): PathSetLike;
	has(value: string): boolean;
	delete(value: string): boolean;
	clear(): void;
}

export interface DeferredMutationRecord {
	filePath: string;
	/** Formatter/language cwd captured when the edit was analyzed. */
	cwd: string;
	/**
	 * Workspace/project cwd used for turn-state and change-log bookkeeping.
	 * Required: omitting it silently routes bookkeeping through `record.cwd`
	 * (the language root), which is the monorepo-cwd-mismatch bug PR #105
	 * fixed. The agent-end consumer trusts this is set.
	 */
	turnStateCwd: string;
	firstTouchedAt: number;
	lastTouchedAt: number;
	/**
	 * Tool names that touched this file, as the host reported them. Widened
	 * from `"write" | "edit"` in #2423: a third-party mutating tool keeps its
	 * OWN name here, so the requeue telemetry names the real producer.
	 */
	toolNames: Set<string>;
	kinds: Set<DeferredMutationKind>;
	/**
	 * The runtime's turn counter at the moment this file was (most recently)
	 * queued/re-touched. Carried purely for provenance/instrumentation (#791)
	 * — NOT used as a hard ownership filter, because a single agent run can
	 * legitimately span multiple `turn_start`/`turn_end` cycles (retries,
	 * in-process subagent calls) before its OWN `agent_end` fires, and that
	 * later `agent_end` must still be allowed to flush work queued earlier in
	 * the same run.
	 */
	queuedTurnIndex: number;
	/** The immutable sink identity of the turn that queued this record. */
	queuedTurnId: string;
	/**
	 * The STABLE pi session id (`ctx.sessionManager.getSessionId()`) active
	 * when this file was (most recently) queued/re-touched, or `undefined`
	 * when the host never supplied one. This IS the ownership signal (#791):
	 * a concurrent in-process secondary session (subagent) gets its own
	 * distinct stable session id, so its `agent_end` firing can be told apart
	 * from the queuing session's own `agent_end`. `undefined` on either side
	 * is treated as "can't prove different" (fail-safe — never orphan a
	 * record just because a host doesn't supply stable ids).
	 */
	ownerSessionId: string | undefined;
	/**
	 * The cwd/worktree this edit's `tool_call` actually ran under (#1642 F3),
	 * DISTINCT from `turnStateCwd` (which is always the workspace/project
	 * root, by design, for bookkeeping — see its own doc). Defaults to
	 * `turnStateCwd` when the caller doesn't supply one, preserving prior
	 * behavior for callers with no real per-call origin to report.
	 *
	 * This is what the staleness/orphan-recovery fallback in
	 * `claimDeferredFormatFiles` checks before claiming an aged-out foreign
	 * record: an orphan queued from a DIFFERENT origin (e.g. a worktree) than
	 * the one now running `agent_end` (e.g. the parent checkout) must not be
	 * claimed just because its owning session died and it aged out — that IS
	 * the worktree→parent re-attribution the reported incident hit, just via
	 * the orphan fallback instead of `tool_result`'s path resolution.
	 */
	originCwd: string;
	/**
	 * #3521: the read guard's branch epoch when this record was queued. The
	 * drain credits its write only while the epoch is unchanged, so a record
	 * requeued before a `/tree` is not credited to the new branch. A merge
	 * keeps the newer epoch: that branch touched the file after every older
	 * branch's write to it.
	 */
	readGuardBranchEpoch: number;
}

/** @deprecated Use DeferredMutationRecord. */
export type DeferredFormatRecord = DeferredMutationRecord;

/**
 * A cached blocking finding re-served at turn end until it is resolved (#1561).
 *
 * #1631 adds a freshness baseline (`recordedAtMs`) and a `stale` flag. A blocker is
 * a verdict about the file AND everything it imports; when a dependency drifts on
 * disk after the verdict, the turn-boundary freshness sweep
 * (`clients/blocker-freshness.ts`) sets `stale` so the entry is demoted to a
 * `[stale — re-run to confirm]` advisory instead of being re-asserted at full
 * authority (#1419 demote-not-drop precedent).
 */
export interface InlineBlockerRecord {
	filePath: string;
	summary: string;
	/**
	 * #1561: the `nextWriteIndex()` token of the dispatch that produced this
	 * verdict. Without it the record carries no evidence of WHICH state it
	 * was a verdict about, so a later confirmed-clean result cannot be
	 * ordered against it and #1198's invariants 1-2 (a slow old clean must
	 * not erase a newer blocker) are unenforceable.
	 */
	writeIndex?: number;
	/**
	 * #3540: `writeIndex` with the turn it was drawn in (`writeOrderToken`).
	 * `writeIndex` restarts at every `beginTurn`, so a retire orders on this.
	 */
	writeOrder?: number;
	/**
	 * #1561 F1: the `tool` ids of the blocking diagnostics behind this
	 * summary. Inline blockers are NOT an LSP-only concept — `dispatcher.ts`
	 * builds them from `semantic === "blocking"` across EVERY runner, so an
	 * eslint, biome-check, actionlint, or ast-grep security-rule finding
	 * (`cors-wildcard`, `no-commented-credentials`) lands here too. A retire
	 * driven by a language-server verdict must therefore prove it covers the
	 * sources that actually raised the blocker; without this field the record
	 * carries no way to tell an `lsp`-origin blocker from a security-rule one,
	 * and an LSP-only clean silently retires both.
	 */
	sources?: readonly string[];
	/**
	 * #1631: wall-clock ms baseline for the turn-boundary freshness sweep, which
	 * compares the file's and its forward imports' on-disk mtime against it.
	 * #3503: the moment the analysed bytes were read, not the moment the verdict
	 * was recorded; a write during the dispatch is newer than the verdict.
	 * Unstamped (legacy) records are left untouched by the sweep.
	 */
	recordedAtMs?: number;
	/**
	 * #1631: set by the freshness sweep when the file or a forward import
	 * drifted after the verdict. A stale entry is demoted out of the
	 * authoritative blocker channel at turn end.
	 */
	stale?: boolean;
	/**
	 * #1641: which gate demoted this entry, so a sibling gate re-deriving its
	 * OWN verdict never heals a demotion it didn't make — the same discipline
	 * `WidgetDiagnostic.staleReason` already uses on the widget/lens surfaces.
	 * `"dependency-drift"` (#1631/`blocker-freshness.ts`) is a one-way latch
	 * for this session (cleared only by a fresh dispatch or confirmed-clean
	 * retire); `"past-eof"` (#1641/`blocker-past-eof.ts`) RE-ARMS every turn
	 * end, since a transient shrink-then-restore of the file must un-demote it.
	 * `"self-drift"` (#2982) also RE-ARMS, for the same reason in a different
	 * axis: the record's own bytes changed after the verdict, and bytes that
	 * change back must un-demote it. Re-arming does not cover an agent rewrite
	 * that never returns to the recorded bytes, so since #4990 this axis has
	 * its own delivery cap, `SELF_DRIFT_MAX_DELIVERIES` (`runtime-turn.ts`),
	 * separate from the #1950 dependency-drift cap. It retires the record
	 * with a ledger reason that says a re-run can still confirm it, and a
	 * heal resets the count (`staleDeliveryCount`).
	 */
	staleReason?: "dependency-drift" | "past-eof" | "self-drift";
	/**
	 * #3248: the last turn-end disposition-policy verdict for this record —
	 * `true` when EVERY blocker it carries was suppressed. Set only by
	 * `applyInlineBlockerPolicyVerdicts`, read only by the two commit-gate
	 * derivations (`updateGitGuardStatus`'s latch and `syncGitGuardRecord`'s
	 * persisted record), so the gate agrees with the banner the agent was
	 * shown instead of blocking a commit on findings pi-lens no longer prints.
	 * Never persisted: `TurnEndFindingsCache` is unchanged, and a session that
	 * never ran the policy sees `undefined`, which counts as blocking.
	 */
	policySuppressed?: boolean;
	/**
	 * #2982: the file's size in bytes when the verdict was recorded, the cheap
	 * first tier of the content confirmation the self-drift axis applies
	 * before demoting. mtime moving is not evidence that content changed — a
	 * `touch`, a `git checkout` restoring identical bytes, or a no-op
	 * formatter pass all move it — and #2449 round 2 F7 already settled that
	 * question for `observed-mutation.ts`: "mtime-only drift has to be
	 * confirmed against content before anything is replayed". Absent (an
	 * unreadable file at record time) means the tier cannot decide, and the
	 * sweep then leaves the record authoritative.
	 */
	recordedSize?: number;
	/**
	 * #2982 review round 2: the sha256 of the file's bytes when the verdict was
	 * recorded, the tier that decides what `recordedSize` cannot. A same-length
	 * edit (a renamed identifier of equal length, a flipped comparison, a changed
	 * digit) is the common shape, not an exotic one, so a size-only tier leaves a
	 * genuinely changed record authoritative. Captured off the synchronous
	 * dispatch path by the pipeline result; absent when that result could not
	 * provide a bounded baseline, which the sweep reads as `unverifiable`.
	 */
	recordedHash?: string;
	/**
	 * #1641: the 1-based cited lines of the diagnostics behind `summary`,
	 * captured at write time (`dispatchResult.blockers[].line` in
	 * `pipeline.ts`) rather than re-parsed from the rendered text — see
	 * `PipelineResult.inlineBlockerLines`'s doc comment for why. Empty/absent
	 * when no blocker in this record cited a line.
	 */
	lines?: readonly number[];
	/**
	 * #3246: the blocking diagnostics `summary` was rendered from, captured at
	 * write time from the same `dispatchResult.blockers` array
	 * (`PipelineResult.inlineBlockerDiagnostics`). The turn-end replay needs a
	 * diagnostic IDENTITY — tool, rule, message, line — to derive a disposition
	 * anchor from; with only the rendered string, a `lens_diagnostic_mark` made
	 * after this record was written could never reach it, and the marked
	 * blocker re-surfaced every turn while every other findings surface had
	 * already dropped it. Read by `clients/inline-blocker-dispositions.ts`;
	 * absent on a legacy/hand-authored record, which is re-served verbatim
	 * (fail-open) with one bounded degradation row.
	 */
	diagnostics?: readonly Diagnostic[];
	/**
	 * #1950: how many turn ends have re-served this record while `stale`.
	 * Only incremented for the `"dependency-drift"` and `"self-drift"` reasons
	 * — `"past-eof"` retires after its own single delivery (#1944) and never
	 * needs a count. Caps a recoverable-but-unconfirmed demotion at its axis's
	 * cap, `DEPENDENCY_DRIFT_MAX_DELIVERIES` or `SELF_DRIFT_MAX_DELIVERIES`
	 * (`clients/blocker-freshness.ts`), instead of re-serving it for the rest
	 * of the session. The count belongs to one demotion episode: healing a
	 * self-drift demotion drops it (#4990).
	 */
	staleDeliveryCount?: number;
	/**
	 * #4484 round 4: what the verdict behind this record analysed (line
	 * hashes, owed lines), set by `setAnalysisAnchor` right after the record
	 * verb. It lives exactly as long as the record. At most 4 bytes per line
	 * up to `MAX_ALIGNMENT_LINES` (400 KB), plus `MAX_OWED_RANGES` ranges per
	 * owing runner. Absent on a record a collect-later settle started: the
	 * next write then has no alignment and matches on identity alone.
	 */
	analysisAnchor?: AnalysisAnchor;
	/**
	 * #4921: the turn session whose write recorded this verdict, named only
	 * when it is not this coordinator's session (a concurrent in-process
	 * secondary, #473); an unnamed record is the coordinator's
	 * (`turnSession`'s own default). Turn-end readers admit only their own
	 * session's records (`getInlineBlockersSnapshot({ sessionId })`); the
	 * commit gate reads every record. The latest verdict on a file replaces
	 * the record and its owner.
	 */
	session?: string;
}

/**
 * What {@link RuntimeCoordinator.updateGitGuardStatus} last counted for the
 * commit gate (#4941): the unsuppressed blocker records with their files, the
 * latest write's own verdict (its file, when known), and the first non-blank
 * line of that write's output.
 */
interface GitGuardMemo {
	readonly entries: ReadonlyArray<{
		readonly filePath: string;
		readonly summary: string;
	}>;
	readonly verdict: { readonly filePath: string | undefined } | undefined;
	readonly firstLine: string | undefined;
}

const EMPTY_GIT_GUARD_MEMO: GitGuardMemo = {
	entries: [],
	verdict: undefined,
	firstLine: undefined,
};

/**
 * #3218 criterion 2: the render cap for the turn-end "Resolved this turn"
 * lines. One line per retired FILE (never per finding); a session that
 * retires more than this in one turn says "… and N more".
 */
const MAX_RESOLVED_BLOCKER_FILES = 10;

/**
 * #4484 round 5: files with no blocker record whose whole analysis anchor is
 * kept (`_owedAnchors`), at most 400 KB each. Past it the oldest file's owed
 * lines are matched by content, a superset that fails closed.
 */
export const MAX_OWED_ANCHORS = 16;

/**
 * #3218 criterion 2: one file whose inline blocker a fresh clean verdict
 * retired during the turn, as recorded by the retire seam itself. The seam
 * knows the retired record (for `blockerCount`) and the retiring write (for
 * `writeIndex`); the turn-end composer only formats these rows, it never
 * re-derives which files were resolved from counts.
 */
export interface ResolvedBlockerFile {
	/** The path as the blocker was recorded, for the composer to display. */
	filePath: string;
	/** How many blocking diagnostics the retired record carried. */
	blockerCount: number;
	/**
	 * The retiring write's index, from `clearInlineBlockers`'s own order.
	 * `undefined` when no write retired it: a confirmed-clean check takes a
	 * write slot but performs no write, and a legacy caller may supply no order.
	 * Never the RECORDING write's index, which would name the write that created
	 * the blocker as the one that cleared it.
	 */
	writeIndex: number | undefined;
	/** Retired by `retireInlineBlockerOnConfirmedClean`, not by a clean write. */
	confirmedClean: boolean;
	/** #4921: the retired record's `session`: the turn end that may say it. */
	session?: string;
	/**
	 * `turnIndex` when the retire happened. The composer says "this turn" only
	 * for an entry from its own turn; a carried entry (a turn_end that delivered
	 * nothing, or a retire that landed mid-handler) says "since the last report".
	 */
	turnIndex: number;
}

/**
 * The canonical target `tool_call` resolved for one specific call, recorded
 * by tool-call identity (#1642). `tool_result`'s paired handler MUST look
 * this up and use `resolvedPath` as-is instead of re-deriving a path from its
 * own (possibly relative, possibly worktree-collapsing) diff metadata — that
 * re-derivation is exactly how a gitignored worktree edit got re-attributed
 * onto a same-relative-path file in the parent checkout.
 */
export interface ToolCallAttribution {
	/**
	 * The absolute path `tool_call` resolved for THIS call, at call time.
	 * NOT authoritative for what actually executed (a later `tool_call`
	 * extension handler can mutate `event.input` in place with no
	 * re-validation, and `edit`'s own `prepareArguments` rewrites args before
	 * the event fires — pi host `agent-session.ts`/`types.ts`). Kept only for
	 * the divergence diagnostic in `runtime-tool-result.ts`; never trusted as
	 * the actual target.
	 */
	resolvedPath: string | undefined;
	/**
	 * True when `tool_call`'s OWN (possibly-superseded) resolution was
	 * gitignored. Diagnostic only, same caveat as `resolvedPath` — the real
	 * decision is `tool_result`'s fresh re-check on the authoritative path.
	 */
	skipped: boolean;
	/**
	 * The cwd/worktree `tool_call` actually ran under. THIS is the field that
	 * matters: `tool_result`'s own authoritative `input.path` (populated from
	 * the EXECUTED args, pi host `agent-session.ts`) is resolved against this
	 * basis instead of the project root — the fix for #1642's worktree→parent
	 * collapse.
	 */
	originCwd: string;
	/**
	 * #3523: the read guard allowed this call's edit at the agent's own line
	 * numbers. Unset for a relocated or unchecked edit, whose written lines
	 * are not where the agent believes they are.
	 */
	editInPlace?: true;
	/**
	 * #3525: FileTime had moved when the read guard checked this call's edit
	 * (`ReadGuard.fileTimeMoved`), so its write must not re-stamp it.
	 */
	fileTimeStale?: true;
	/**
	 * #5120: this call's `edits` were rewritten to the matched subset of a
	 * partly matching batch, for the host edit to write. Its `tool_result`
	 * takes it once ({@link RuntimeCoordinator.takeToolCallPartialApply}) to
	 * tell the agent what applied. A call a later handler blocks gets no
	 * `tool_result`; the entry then goes with the attribution's own bound.
	 */
	partialApply?: PartialApplyPending;
	/** `Date.now()` when recorded — see `TOOL_CALL_ATTRIBUTION_TTL_MS`. */
	recordedAt: number;
}

/**
 * #3555: a read the tool_call widened to its enclosing symbol or Markdown
 * section, carried by tool-call identity to its tool_result, which labels it.
 */
export interface ReadWidening {
	/** The file the tool_call resolved (absolute), for the record. */
	filePath: string;
	/**
	 * The read's raw file input as the tool_call left it. The tool_result
	 * matches on this, since it resolves paths without the tool_call's host
	 * variant ladder, and a reused id may name another file.
	 */
	inputPath: string | undefined;
	requested: { offset: number; limit: number };
	shown: { offset: number; limit: number };
	boundary: { heading: string } | { symbol: { name: string; kind: string } };
}

/**
 * Bound on in-flight tool_call → tool_result correlations. A tool_result
 * follows its tool_call almost immediately, so this only needs to cover
 * calls genuinely in flight; sized generously above any realistic
 * in-flight-batch width so a slow paired result is never evicted before use.
 */
const TOOL_CALL_ATTRIBUTION_CAPACITY = 256;

/**
 * A recorded attribution older than this is treated as expired (as if it
 * were never recorded) rather than trusted — defense in depth against a host
 * that reuses a call id, or a pathologically delayed/duplicated tool_result,
 * outliving the LRU capacity bound. Generous relative to any real tool
 * round-trip; only guards against genuine identity reuse, not slow tools.
 */
const TOOL_CALL_ATTRIBUTION_TTL_MS = 5 * 60_000;

/**
 * A record narrowed to the rows that survive a retirement. The derived fields
 * (`summary`, `sources`, `lines`) come from the surviving rows, never from the
 * old record, so a narrowed record cannot keep a source or a line count that
 * only a retired row held. The one rebuild every partial retire uses
 * (`retireUnobservedRunnerBlockers`, `retireInlineBlockerOnConfirmedClean`,
 * `retireForeignRows`).
 */
function narrowedRecord(
	existing: InlineBlockerRecord,
	kept: Diagnostic[],
): InlineBlockerRecord {
	return {
		...existing,
		summary: formatDiagnostics(kept, "blocking").trim(),
		diagnostics: kept,
		sources: inlineBlockerSources(kept),
		lines: inlineBlockerLines(kept, existing.filePath),
	};
}

/**
 * #3613 (session-scope S4): per-turn warnings partitioned by the session
 * whose turn produced them. A concurrent secondary (an in-process subagent)
 * adds, reads and clears its own partition on the primary's coordinator, so
 * neither session's turn moves the other's warnings.
 *
 * #4965: a partition is a cell on its session's scope (`scopeCell`), so it
 * ends with that scope: a primary's when its coordinator begins the next
 * scope, a secondary's at its shutdown. A turn drains it earlier
 * (`clearTurnWarnings`). Both record kinds share one cell per session. The primary's cell is the coordinator's own scope;
 * a foreign session's is found by its id (`sessionCell`), and a write for a
 * session with no live scope is dropped and counted.
 */
interface TurnWarningsCell {
	readonly actionable: Map<string, ActionableWarningRecord>;
	readonly codeQuality: Map<string, CodeQualityWarningRecord>;
}

const TURN_WARNINGS_CELL = "turn-warnings";

function newTurnWarningsCell(): TurnWarningsCell {
	return { actionable: new Map(), codeQuality: new Map() };
}

export class RuntimeCoordinator {
	private _projectRoot = normalizeMapKey(process.cwd());
	// #3611: the session generation is this scope's ticket, drawn from one
	// process counter, so two coordinators (two entry evaluations) never hold
	// the same number (N4). The construction scope's ticket is the
	// coordinator's id on the `session_scope_transition` row.
	private _scope: SessionScope = beginScope({ role: "primary" });
	private readonly _coordinatorId = this._scope.scopeId;
	private _sessionStartedAt = Date.now();
	private _errorDebtBaseline: ErrorDebtBaseline | null = null;
	private _pipelineCrashCounts = new Map<string, number>();
	private _cachedExports = new Map<string, string>();
	private _startupScansInFlight = new Map<StartupTaskName, number>();
	private _cascadeRuns: CascadeRun[] = [];
	// #3813/#3901: items an item-bearing turn-end advisory showed and the cap
	// cut (knip, dead-code, call-graph impact), keyed by lane. Parked once,
	// taken once; see `parkCutAdvisoryItems`.
	private readonly _cutAdvisoryItems = new BoundedFifoMap<string, unknown[]>(
		MAX_CUT_ADVISORY_LANES,
	);
	private _turnEndCascadeSettleStarts = new Map<number, number>();
	private _nextCascadeSettleToken = 0;
	// Cascade computes are kicked off unawaited by the pipeline (#450); their
	// promises park here until turn_end drains them via settleCascadeRuns. Each is
	// guaranteed non-rejecting by the pipeline's .catch.
	private _pendingCascadeRuns: Promise<CascadeRun>[] = [];
	private _cascadeSessionStats: CascadeSessionStats = {
		runs: 0,
		diagnosticsSurfaced: 0,
		coldSnapshotTouches: 0,
	};
	private _complexityBaselines = new Set<string>();
	private readonly _fixedThisTurn = new PathKeyedMap<true>(normalizeMapKey);
	private readonly _writtenThisTurn = new PathKeyedMap<true>(normalizeMapKey);
	private readonly _autofixDemotedThisTurn = new PathKeyedMap<true>(
		normalizeMapKey,
	);
	private readonly _reportedThisTurn = new Set<string>();
	private _mutationReceipts: MutationReceipt[] = [];
	private _droppedMutationReceipts = 0;
	private _projectRulesScan: RuleScanResult = {
		rules: [],
		hasCustomRules: false,
	};
	/** Process-unique and monotonic across coordinator reloads (#4213). */
	private _telemetrySessionId = nextTelemetrySessionId();
	private _lifecycleReason: string | undefined;
	private _hasStableSessionId = false;
	private _telemetryModel = "unknown";
	// Raw model/provider identity, separate from the combined `provider/model`
	// display string above — worklog/disposition attribution (#1448) wants the
	// two fields apart, blank when the host never supplied them. `_telemetryProvider`
	// is the explicit host value when given, else derived from the model id
	// (deriveProviderFromModelId, blank on ambiguity — never guessed).
	private _telemetryModelId = "";
	private _telemetryProvider = "";
	// True once a host has supplied an explicit provider this session. An
	// explicit provider is never downgraded by a derivation from a later
	// model-only call; a DERIVED provider, by contrast, is re-derived on
	// every model-only call so a mid-session model switch (e.g. gpt-5-mini →
	// claude-sonnet-4-5) doesn't leave a stale provider from the old model.
	private _telemetryProviderIsExplicit = false;
	private _turnIndex = 0;
	/**
	 * #3540 r2: the turn half of a write order token (`writeOrderToken`).
	 * `beginTurn` advances it and `resetForSession` never restarts it: the
	 * widget's write guards outlive a session reset (`/reload` keeps them),
	 * so a later turn's token must outrank every earlier one in the process.
	 * `_turnIndex` restarts per session for telemetry.
	 * #3611 (N3): drawn from the process counter (`nextOrderTurn`), because a
	 * `/reload` that re-evaluates the entry builds a new coordinator while the
	 * widget module keeps its guards.
	 */
	private _writeOrderTurn = 0;
	private _writeIndex = 0;
	/**
	 * #3613 F2: the per-turn cap key of each concurrent session's current turn
	 * (`turnKey`), and how many such turns have started. Entries go at the
	 * session's shutdown (`forgetTurnSession`).
	 */
	private readonly _foreignTurnKeys = new Map<string, number>();
	private _foreignTurns = 0;
	/**
	 * #3613 G1: every turn start on this coordinator, of any session, since the
	 * session reset: what `_turnIndex` counted before #3613, kept for the
	 * process-level turn cadences (`turnStartCount`).
	 */
	private _turnStarts = 0;
	private _projectSeq = 0;
	// #3511: the highest logged seq this runtime's view is known to have missed
	// (a sibling process logged it above our seq); 0 when none. Cleared by a
	// seed from the log, or by a late read that covers it.
	private _viewMissingThrough = 0;
	// #3511 review round 2: the change-log entries folded by this session's
	// seed or late merge. An `unlocked` entry after it may share a seq we
	// hold, so a snapshot stamped with it is judged against the log's tags.
	private _viewLogEntries = 0;
	private _turnStartProjectSeq = 0;
	private readonly _fileSeq = new Map<string, number>();
	// File key → the projectSeq value at that file's most recent bump (#451). Lets
	// the review-graph builder ask "which files changed since I last built?" and
	// skip its per-build O(project) walk+stat sweep when only pi-observed edits
	// occurred. Keyed identically to _fileSeq (normalizeMapKey + path.resolve).
	private readonly _fileLastProjectSeq = new Map<string, number>();
	/**
	 * The commit gate's memo of the last {@link updateGitGuardStatus}: the
	 * unsuppressed blocker records it counted, each with its file, so the gate
	 * can answer for one repository's tree (#4941) and the turn-end readers
	 * for all of them.
	 */
	private _gitGuardMemo: GitGuardMemo = EMPTY_GIT_GUARD_MEMO;
	/**
	 * Per project (the `cwd` whose stored record the reason is about), the
	 * reason that record cannot be confirmed (#4941 r2 F1). One record per
	 * repository: a failure about B must not replace, and a write about B must
	 * not clear, the uncertainty about A.
	 */
	private readonly _gitGuardCacheUnknown = new PathKeyedMap<string>(
		normalizeMapKey,
	);
	/**
	 * #4733 r2 F12: per file, a dispatch that never answered
	 * (`pipeline_crash`, `pipeline_error`). It is about that file, not the
	 * persisted record, so it lives apart from the record's latch above: only
	 * that file's own dispatch returning removes it, and no record write or
	 * delete does. Cleared per session.
	 */
	private readonly _gitGuardUnansweredDispatches = new PathKeyedMap<string>(
		normalizeMapKey,
	);
	callGraph: FunctionCallGraph | null = null;
	wordIndex: WordIndex | null = null;
	private _readGuard: ReadGuard | null = null;
	/**
	 * #4942: the read guard of each concurrent in-process session, keyed by the
	 * owner `recordSession` names (its session id, opaque here). Entries go at
	 * the session's shutdown (`forgetTurnSession`) and with the coordinator's
	 * own reset.
	 */
	private readonly _foreignReadGuards = new Map<string, ReadGuard>();
	private readonly _pendingDeferredMutations =
		new PathKeyedMap<DeferredMutationRecord>(normalizeMapKey);
	/** tool_call → tool_result path-attribution correlation (#1642). */
	private readonly _toolCallAttributions = new BoundedLruCache<
		string,
		ToolCallAttribution
	>(TOOL_CALL_ATTRIBUTION_CAPACITY);
	/**
	 * #3555: a widening rides its own correlation, with the same bound. Since
	 * #4138 a read also carries a {@link ToolCallAttribution} (its origin cwd
	 * is what a relative read path resolves against at tool_result); the
	 * widening stays separate because it outlives a blocked call's attribution.
	 */
	private readonly _readWidenings = new BoundedLruCache<string, ReadWidening>(
		TOOL_CALL_ATTRIBUTION_CAPACITY,
	);
	private readonly _lspReadWarmState = new Map<
		string,
		{ status: "warming" | "ready"; ts: number }
	>();
	private readonly _pendingInlineBlockers =
		new PathKeyedMap<InlineBlockerRecord>(normalizeMapKey);
	/**
	 * #4484 round 4: per file, what its last applied inline verdict left owed
	 * (`setAnalysisAnchor`), for a file whose record is gone or has no anchor.
	 * The positions live on the blocker record
	 * (`InlineBlockerRecord.analysisAnchor`). Round 5: this keeps each owing
	 * runner's owed line texts (`owedByContentOnly`, at most
	 * `MAX_OWED_LINE_TEXTS` hashes per runner, 16 KB), not only its id, so
	 * the next write owes it only the lines with those texts, never the whole
	 * file for a skip. Replaced by every applied verdict of the file and
	 * cleared per session.
	 */
	private readonly _owedRunners = new PathKeyedMap<AnalysisAnchor>(
		normalizeMapKey,
	);
	/**
	 * #4484 round 5: for a file with no blocker record, its last verdict's
	 * whole anchor (line hashes too), so the next write still remaps owed
	 * positions exactly (verify probe P23). At most `MAX_OWED_ANCHORS` files,
	 * 400 KB each; an evicted file falls back to `_owedRunners`' owed line
	 * texts, a superset. Cleared per session.
	 */
	private readonly _owedAnchors = new PathKeyedMap<AnalysisAnchor>(
		normalizeMapKey,
		MAX_OWED_ANCHORS,
	);
	/**
	 * #3507: one per-path order for BOTH verbs on `_pendingInlineBlockers`,
	 * the widget store's guard shape (`widget-state.ts` diagnosticsWriteGuard).
	 * Pipelines of two same-file edits overlap under pi's parallel tools, so
	 * an older run that settles last must neither erase nor replace the newer
	 * run's verdict (#1198 invariants 1-2). The last applied token lives here,
	 * not on the record, so it survives a clear.
	 */
	private readonly _inlineBlockerWriteOrder = new WriteOrderingGuard<
		string,
		number
	>();
	/**
	 * #3218 criterion 2: inline blockers a fresh clean verdict retired this
	 * turn, keyed by resolved path so a file is named once. Bounded at
	 * `MAX_RESOLVED_BLOCKER_FILES`; the overflow is counted so the delivery can
	 * still say "… and N more" (counting retire events past the cap). The
	 * turn-end composer consumes it, so a retire is delivered exactly once; an
	 * entry no turn_end delivered stays until one does, and session reset clears
	 * it.
	 */
	private readonly _resolvedBlockerFilesThisTurn =
		new PathKeyedMap<ResolvedBlockerFile>(normalizeMapKey);
	private _resolvedBlockerFilesDropped = 0;
	// #484: opt-in per-RUN summary of diagnostics/autofixes/formats,
	// accumulated across the run's turns and consumed once at the
	// agent_settled quiet window. The collector itself is always constructed
	// (cheap, empty Map) but callers gate recording behind the
	// `lens-turn-summary` flag so it's a true no-op when the feature is off.
	private readonly _turnSummary = new TurnSummaryCollector();
	// #2402/#1053: session-scoped applied-edit records for exact-retry
	// recognition. Both producers (partial-apply commit, full native-edit
	// success) write here; the preflight consults it before declaring an
	// oldText miss, so an identical retry never re-executes a committed write.
	readonly partialApplyRecords = new PartialApplyRecordStore();

	resetForSession(startedAt = Date.now()): void {
		const previous = this._scope;
		retireScope(previous, "superseded");
		this._scope = beginScope({
			role: "primary",
			parentScopeId: previous.scopeId,
			coordinatorId: this._coordinatorId,
		});
		this._sessionStartedAt = startedAt;
		this._complexityBaselines.clear();
		this._pipelineCrashCounts.clear();
		this._cachedExports.clear();
		this.wordIndex = null;
		this._startupScansInFlight.clear();
		this._cascadeRuns = [];
		this._cutAdvisoryItems.clear();
		this._pendingCascadeRuns = [];
		this._turnEndCascadeSettleStarts.clear();
		this._cascadeSessionStats = {
			runs: 0,
			diagnosticsSurfaced: 0,
			coldSnapshotTouches: 0,
		};
		this._fixedThisTurn.clear();
		this._writtenThisTurn.clear();
		this._autofixDemotedThisTurn.clear();
		this._reportedThisTurn.clear();
		this._mutationReceipts = [];
		this._droppedMutationReceipts = 0;
		// #3613, #4965: the outgoing session's per-turn records live on the scope
		// this reset superseded, so they end with it; a live secondary's cell is
		// on its own scope and survives the primary's replacement.
		this._telemetrySessionId = nextTelemetrySessionId();
		this._hasStableSessionId = false;
		this._telemetryModel = "unknown";
		this._telemetryModelId = "";
		this._telemetryProvider = "";
		this._telemetryProviderIsExplicit = false;
		this._turnIndex = 0;
		this._turnStarts = 0;
		this._writeIndex = 0;
		this._projectSeq = 0;
		this._viewMissingThrough = 0;
		this._viewLogEntries = 0;
		this._turnStartProjectSeq = 0;
		this._fileSeq.clear();
		this._fileLastProjectSeq.clear();
		this._gitGuardMemo = EMPTY_GIT_GUARD_MEMO;
		this._gitGuardCacheUnknown.clear();
		this._gitGuardUnansweredDispatches.clear();
		this._readGuard = null;
		// A dropped secondary's FileTime bucket stays: a read of its that is in
		// flight across this reset keeps its tool_call stamp, which its
		// tool_result needs to see a writer that moved the file (#4942 r7).
		this._foreignReadGuards.clear();
		this._pendingDeferredMutations.clear();
		// #1642 F5: every sibling correlation/state map is cleared here. A
		// per-session-numbered host reusing tool-call ids across sessions must
		// not let a NEW session inherit a DEAD session's recorded skip verdict.
		this._toolCallAttributions.clear();
		this._readWidenings.clear();
		this._lspReadWarmState.clear();
		this._pendingInlineBlockers.clear();
		this._owedRunners.clear();
		this._owedAnchors.clear();
		this._inlineBlockerWriteOrder.clear();
		this._resolvedBlockerFilesThisTurn.clear();
		this._resolvedBlockerFilesDropped = 0;
		this._turnSummary.clear();
		// #2402: an applied-edit record is a fact about the session that applied
		// it; a new session must re-resolve identical payloads from content.
		this.partialApplyRecords.clear();
	}

	get sessionStartedAt(): number {
		return this._sessionStartedAt;
	}

	get cascadeSessionStats(): CascadeSessionStats {
		return this._cascadeSessionStats;
	}

	recordCascadeRun(
		diagnosticsSurfaced: number,
		coldSnapshotTouches: number,
	): void {
		this._cascadeSessionStats.runs += 1;
		this._cascadeSessionStats.diagnosticsSurfaced += diagnosticsSurfaced;
		this._cascadeSessionStats.coldSnapshotTouches += coldSnapshotTouches;
	}

	/**
	 * Record the turn-end policy verdict on every live inline-blocker record
	 * (#3248): `true` for a file whose every blocker the policy suppressed,
	 * `false` for every other record in the map.
	 *
	 * ONE writer, rewriting the WHOLE axis each turn end, so the verdict can
	 * never outlive the pass that made it: a record demoted since, or one whose
	 * survivors came back because the file's bytes moved under a content-bound
	 * anchor, is cleared by the same call that sets its sibling. A fresh
	 * dispatch replaces the record wholesale (`recordInlineBlockers`), so a NEW
	 * blocker is never born pre-suppressed (#1198 ordering).
	 *
	 * #4921: `of` names the turn session whose pass this is; it rewrites only
	 * that session's records, the ones its pass judged. Omitted: every record.
	 *
	 * @returns how many records this call CHANGED — 0 means the gate's view of
	 * the map is already what the policy just decided.
	 */
	applyInlineBlockerPolicyVerdicts(
		suppressedFilePaths: readonly string[],
		of?: { sessionId: string | undefined },
	): number {
		const suppressed = new Set(
			suppressedFilePaths.map((filePath) => path.resolve(filePath)),
		);
		let changed = 0;
		for (const [key, entry] of this._pendingInlineBlockers.entries()) {
			if (of && !this.ownedBy(entry, of.sessionId)) continue;
			const policySuppressed = suppressed.has(path.resolve(entry.filePath));
			if ((entry.policySuppressed ?? false) === policySuppressed) continue;
			this._pendingInlineBlockers.set(key, { ...entry, policySuppressed });
			changed += 1;
		}
		return changed;
	}

	/**
	 * `blockerFile` is the file `hasBlockers` speaks for (the write's own); a
	 * verdict with no file is a repository-less blocker, which every tree's
	 * commit gate counts (#4941).
	 */
	updateGitGuardStatus(
		hasBlockers: boolean,
		output: string,
		blockerFile?: string,
	): void {
		// The status is an aggregate over the current per-file map. A clean B
		// result must not erase an unresolved A result; the pipeline records/clears
		// the edited file immediately before this method runs.
		// #3248: every live record except one whose whole blocker set the
		// turn-end disposition policy suppressed. The record itself stays in the
		// map — the policy is content-bound and re-derived from the record's
		// diagnostics at every turn end, so dropping it there would be silencing
		// rather than filtering (AGENTS.md shape 10); it just stops counting for
		// the gate the agent was shown nothing for.
		this._gitGuardMemo = {
			entries: this.getInlineBlockersSnapshot()
				.filter((entry) => !entry.policySuppressed)
				.map((entry) => ({
					filePath: entry.filePath,
					summary: entry.summary.trim(),
				})),
			verdict: hasBlockers ? { filePath: blockerFile } : undefined,
			firstLine: output
				.split("\n")
				.map((line) => line.trim())
				.find((line) => line.length > 0),
		};
	}

	/**
	 * The commit gate's status over the blockers `inScope` admits (every one
	 * when omitted): whether any counts, and the first one's summary. #4941:
	 * the gate asks for the tree being committed, so a blocker in another
	 * repository neither refuses the commit nor names its file.
	 */
	gitGuardStatus(inScope?: (filePath: string) => boolean): {
		hasBlockers: boolean;
		summary: string;
	} {
		const { entries, verdict, firstLine } = this._gitGuardMemo;
		const counted = inScope
			? entries.filter((entry) => inScope(entry.filePath))
			: entries;
		const verdictCounts =
			verdict !== undefined &&
			(!inScope || verdict.filePath === undefined || inScope(verdict.filePath));
		if (!verdictCounts && counted.length === 0) {
			return { hasBlockers: false, summary: "" };
		}
		return {
			hasBlockers: true,
			summary: (
				counted.map((entry) => entry.summary).find(Boolean) ??
				firstLine ??
				"Unresolved blockers detected"
			).slice(0, 160),
		};
	}

	get gitGuardHasBlockers(): boolean {
		return this.gitGuardStatus().hasBlockers;
	}

	get gitGuardSummary(): string {
		return this.gitGuardStatus().summary;
	}

	/** `cwd` is the project whose stored record the reason is about (#4941). */
	markGitGuardCacheUnknown(reason: string, cwd: string): void {
		this._gitGuardCacheUnknown.set(cwd, reason);
	}

	/** A write or retirement of `cwd`'s record answers that project's reason only. */
	clearGitGuardCacheUnknown(cwd: string): void {
		this._gitGuardCacheUnknown.delete(cwd);
	}

	/**
	 * The first latched reason about a project `inScope` accepts, or the first
	 * of all when `inScope` is absent (a command the gate cannot place in a
	 * tree is judged by every project's reason).
	 */
	gitGuardCacheUnknownFor(
		inScope?: (cwd: string) => boolean,
	): string | undefined {
		for (const [cwd, reason] of this._gitGuardCacheUnknown) {
			if (!inScope || inScope(cwd)) return reason;
		}
		return undefined;
	}

	markGitGuardDispatchUnanswered(filePath: string, reason: string): void {
		this._gitGuardUnansweredDispatches.set(filePath, reason);
	}

	/** The file's dispatch returned: it answers its own latch, and only that. */
	answerGitGuardDispatch(filePath: string): void {
		this._gitGuardUnansweredDispatches.delete(filePath);
	}

	/** Every file whose dispatch has not answered, with its reason, in order. */
	get gitGuardUnansweredDispatches(): ReadonlyArray<{
		readonly filePath: string;
		readonly reason: string;
	}> {
		return [...this._gitGuardUnansweredDispatches].map(
			([filePath, reason]) => ({ filePath, reason }),
		);
	}

	/** Whether this session holds an inline-blocker entry for the file. */
	hasInlineBlocker(filePath: string): boolean {
		return this._pendingInlineBlockers.has(filePath);
	}

	/**
	 * #4921: the turn session that owns the file's inline-blocker record, or
	 * undefined when the file has none.
	 */
	inlineBlockerOwner(filePath: string): string | undefined {
		const entry = this._pendingInlineBlockers.get(filePath);
		return entry ? (entry.session ?? this._telemetrySessionId) : undefined;
	}

	/**
	 * #4921: whether `sessionId`'s turn is this coordinator's own session, the
	 * rule {@link beginTurn} applies: a turn with no session id of its own is
	 * the coordinator's. A concurrent in-process secondary's is not.
	 */
	isCoordinatorSession(sessionId: string | undefined): boolean {
		return this.turnSession(sessionId) === this._telemetrySessionId;
	}

	/** #4921: the `session` a record written by `sessionId`'s turn carries. */
	private recordSession(sessionId: string | undefined): {
		session?: string;
	} {
		return sessionId === undefined || this.isCoordinatorSession(sessionId)
			? {}
			: { session: sessionId };
	}

	/** #4921: whether a record (or its Resolved note) is `sessionId`'s turn's. */
	private ownedBy(
		entry: { session?: string },
		sessionId: string | undefined,
	): boolean {
		return (
			(entry.session ?? this._telemetrySessionId) ===
			this.turnSession(sessionId)
		);
	}

	/**
	 * Start a turn. `sessionId` is the turn's own session (its ctx's stable id);
	 * omitted, or equal to this coordinator's session, the turn is the
	 * coordinator's own. #3613 (S4, N2): a concurrent secondary's turn on this
	 * coordinator advances only its own turn identity and its own per-turn
	 * records. The turn counter, the write-order turn, the turn's change
	 * window and the carried cascade runs are the primary's.
	 */
	beginTurn(sessionId?: string): void {
		this._turnStarts += 1;
		const turnSession = this.turnSession(sessionId);
		if (turnSession !== this._telemetrySessionId) {
			beginTurnContext(turnSession);
			// A fresh key strictly between this coordinator's turn and its next
			// (n / (n + 1) < 1 grows with n): distinct from every other turn's,
			// and drawn in start order.
			this._foreignTurns += 1;
			this._foreignTurnKeys.set(
				turnSession,
				this._turnIndex + this._foreignTurns / (this._foreignTurns + 1),
			);
			this.clearTurnWarnings(turnSession);
			return;
		}
		// #1443: runs sitting here at turn_start were appended AFTER the last
		// turn_end drained them (consumeCascadeRuns) — the quiet-window reconcile's
		// late re-injection (`onResolvedFound`, clients/lsp/cascade-tier.ts) lands
		// in exactly that window. Wiping them dead-ended that delivery path: the
		// finding was computed, formatted, appended, and then deleted before any
		// turn_end could render it. Carry them into THIS turn instead, exactly
		// once: `carriedTurns` is stamped on the way through and a run that the
		// next turn_end still did not consume is dropped here with a log line
		// rather than queued forever (a stale finding must not outlive the state
		// it describes, and an unbounded queue would replay it every turn).
		this._cascadeRuns = this._cascadeRuns.flatMap((run) => {
			const carriedTurns = (run.carriedTurns ?? 0) + 1;
			if (carriedTurns > 1) {
				logCascade({
					phase: "cascade_carry_over_drop",
					filePath: run.filePath,
					neighborCount: run.neighborCount,
					diagnosticCount: run.diagnosticCount,
					metadata: { carriedTurns, turnIndex: this._turnIndex },
				});
				return [];
			}
			return [{ ...run, carriedTurns }];
		});
		// _pendingCascadeRuns is deliberately NOT cleared here: a cascade compute
		// still in flight past last turn_end's settle cap (fresh graph builds have
		// measured up to ~19s) must surface on the NEXT turn_end, not be dropped —
		// pre-#450 those findings were always awaited, never lost. Session reset
		// still clears it.
		// Inline blockers are session-scoped per-file state. They are cleared only
		// when that file is re-analyzed clean or the session resets; a new turn must
		// not let a clean unrelated file erase an unresolved blocker.
		this.clearTurnWarnings(turnSession);
		// _turnSummary is deliberately NOT cleared here (#484 rework): the
		// summary entry is emitted once per RUN at the agent_settled quiet
		// window (sendMessage during a live stream would STEER the agent, and
		// turn_end can fire mid-stream), so the collector must accumulate
		// across the run's turns. It is cleared only by consume() at emit and
		// by resetForSession().
		this._turnStartProjectSeq = this._projectSeq;
		this._turnIndex += 1;
		this._writeOrderTurn = nextOrderTurn();
		beginTurnContext(this._telemetrySessionId);
		this._writeIndex = 0;
		this._reportedThisTurn.clear();
		this._writtenThisTurn.clear();
		this._autofixDemotedThisTurn.clear();
	}

	/**
	 * THE one mutation seam. Every producer of an in-project file mutation —
	 * native write/edit, recognized bash writes, format/autofix, LSP workspace
	 * edits, and (phase 2) opaque script-write recovery — records through here,
	 * once: it bumps the seq store (`bumpFileSeq`), appends a bounded attributed
	 * receipt, and optionally appends the durable change-log entry. Consumers
	 * derive from `getFilesChangedSince` / `getMutationsSince`; no producer or
	 * consumer may hand-roll a parallel bump+log pairing (#2000 phase 1).
	 *
	 * Receipt recording never throws; change-log append failures route to
	 * `onAppendError` (default: swallowed) so telemetry cannot break dispatch.
	 */
	recordProjectMutation(args: {
		filePath: string;
		source: ProjectChangeSource;
		/** When set, a durable change-log entry is appended for this cwd. */
		cwd?: string;
		changedRange?: ProjectChangeRange;
		/**
		 * #4943: the turn session of the writer, which the change-log row names
		 * (an in-process subagent's write is its own). Omitted, it is this
		 * coordinator's session, as before.
		 */
		sessionId?: string | undefined;
		onAppendError?: (err: unknown) => void;
	}): { projectSeq: number; fileSeq: number } {
		// #3511: a logged mutation takes its seq from the shared change log,
		// under the log's lock, so a sibling process never logs the same seq.
		let logged: ReturnType<RuntimeCoordinator["bumpFileSeq"]> | undefined;
		if (args.cwd !== undefined) {
			try {
				const cwd = args.cwd;
				appendProjectChangeAllocated(cwd, (logMaxSeq) => {
					const ownSeq = this._projectSeq;
					logged = this.bumpFileSeq(args.filePath, logMaxSeq);
					if (this._viewMissingThrough > 0) {
						recordViewIncomplete(cwd, { ownSeq, logMaxSeq });
					}
					return {
						seq: logged.projectSeq,
						timestamp: new Date().toISOString(),
						sessionId: this.turnSession(args.sessionId),
						turnIndex: this.turnIndex,
						source: args.source,
						filePath: path.resolve(args.filePath),
						fileSeq: logged.fileSeq,
						changedRange: args.changedRange,
					};
				});
			} catch (err) {
				args.onAppendError?.(err);
			}
		}
		const { projectSeq, fileSeq, key } =
			logged ?? this.bumpFileSeq(args.filePath);
		this.recordMutationReceipt({ projectSeq, fileSeq, key }, args.source);
		return { projectSeq, fileSeq };
	}

	/**
	 * #4535: the bulk form of {@link recordProjectMutation}, for a disk change
	 * pi-lens did not author that spans many paths (a publisher's recorded
	 * population). It allocates from the SAME sequence, in ONE locked append:
	 * `appendProjectChangesAllocated` takes the change-log lock once and writes
	 * every line under it, so a 400-path HEAD move costs one lock round-trip
	 * inside a hook budget instead of 400. The lock-failure semantics are the
	 * single writer's: when the lock is unavailable every appended line is
	 * tagged `unlocked` and one `change-log-lock-unavailable` degradation is
	 * recorded for the batch. Receipts are appended per path with the same ring
	 * cap and drop counter as a single mutation.
	 *
	 * Returns the batch's last allocated `projectSeq` (the record's seq after
	 * the batch) and each path's `fileSeq` keyed by the bump's normalized key.
	 * Duplicate paths are the caller's to collapse: each entry bumps.
	 */
	recordProjectMutations(args: {
		paths: readonly string[];
		source: ProjectChangeSource;
		cwd?: string;
		onAppendError?: (err: unknown) => void;
	}): { projectSeq: number; fileSeqs: ReadonlyMap<string, number> } {
		let logged:
			| Array<ReturnType<RuntimeCoordinator["bumpFileSeq"]>>
			| undefined;
		if (args.cwd !== undefined && args.paths.length > 0) {
			try {
				const cwd = args.cwd;
				const paths = args.paths;
				appendProjectChangesAllocated(cwd, (logMaxSeq) => {
					const ownSeq = this._projectSeq;
					const bumps = paths.map((filePath) =>
						this.bumpFileSeq(filePath, logMaxSeq),
					);
					logged = bumps;
					if (this._viewMissingThrough > 0) {
						recordViewIncomplete(cwd, { ownSeq, logMaxSeq });
					}
					return bumps.map((bump, index) => ({
						seq: bump.projectSeq,
						timestamp: new Date().toISOString(),
						sessionId: this.telemetrySessionId,
						turnIndex: this.turnIndex,
						source: args.source,
						filePath: path.resolve(paths[index] as string),
						fileSeq: bump.fileSeq,
					}));
				});
			} catch (err) {
				args.onAppendError?.(err);
			}
		}
		const bumps =
			logged ?? args.paths.map((filePath) => this.bumpFileSeq(filePath));
		const fileSeqs = new Map<string, number>();
		for (const bump of bumps) {
			this.recordMutationReceipt(
				{ projectSeq: bump.projectSeq, fileSeq: bump.fileSeq, key: bump.key },
				args.source,
			);
			fileSeqs.set(bump.key, bump.fileSeq);
		}
		return { projectSeq: this._projectSeq, fileSeqs };
	}

	/**
	 * The receipt ring (§ {@link MutationReceipt}): one entry per bump, oldest
	 * evicted at the cap and counted, never silently incomplete. One writer, so
	 * the single and bulk mutation paths cannot drift apart on attribution.
	 */
	private recordMutationReceipt(
		bump: { projectSeq: number; fileSeq: number; key: string },
		source: ProjectChangeSource,
	): void {
		if (this._mutationReceipts.length >= MAX_MUTATION_RECEIPTS) {
			this._mutationReceipts.shift();
			this._droppedMutationReceipts += 1;
		}
		this._mutationReceipts.push({
			seq: bump.projectSeq,
			// Reuse the bump's normalized key (a realpath syscall: ~200us on
			// Windows, ~1.8us on POSIX since #3098) — never re-derive it here.
			filePath: bump.key,
			source,
			turnIndex: this._turnIndex,
			ts: Date.now(),
		});
	}

	/**
	 * Attributed mutations whose seq is strictly after `seq` — the receipt-level
	 * counterpart of {@link getFilesChangedSince}. Bounded: entries evicted by
	 * the ring cap are gone; compare `droppedMutationReceiptCount` against zero
	 * before treating the result as a complete window.
	 */
	getMutationsSince(seq: number): MutationReceipt[] {
		// Shallow copies: a consumer mutating a returned receipt must not
		// corrupt the ring's internal state.
		return this._mutationReceipts
			.filter((r) => r.seq > seq)
			.map((r) => ({ ...r }));
	}

	get droppedMutationReceiptCount(): number {
		return this._droppedMutationReceipts;
	}

	/**
	 * Atomically records write/edit ordering before debounce can coalesce it.
	 *
	 * Takes the classified {@link MutationKind}, not a raw tool name (#2423):
	 * an edit-shaped tool pi-lens does not name still demotes this file to the
	 * deferred pass, which is the safe timing.
	 */
	recordMutationToolReceipt(
		filePath: string,
		kind: MutationKind,
	): { autofixMode: "immediate" | "deferred" } {
		if (kind === "write") {
			this._writtenThisTurn.set(filePath, true);
		} else if (this._writtenThisTurn.has(filePath)) {
			this._autofixDemotedThisTurn.set(filePath, true);
			// A later edit establishes a new final state that must be eligible for
			// the deferred pass even if the preceding write was fixed immediately.
			this._fixedThisTurn.delete(filePath);
		}
		return {
			autofixMode:
				kind === "edit" || this._autofixDemotedThisTurn.has(filePath)
					? "deferred"
					: "immediate",
		};
	}

	get reportedThisTurn(): Set<string> {
		return this._reportedThisTurn;
	}

	nextWriteIndex(): number {
		this._writeIndex += 1;
		return this._writeIndex;
	}

	peekWriteIndex(): number {
		return this._writeIndex;
	}

	/**
	 * #3540: draw the next write index as an order token that spans turns
	 * (`writeOrderToken`), for a writer whose token is compared against
	 * another turn's: the widget store and the inline-blocker retire.
	 */
	nextWriteOrderToken(): number {
		return writeOrderToken(
			this._writeOrderTurn,
			this.nextWriteIndex(),
		) as number;
	}

	setTelemetryIdentity(identity: {
		sessionId?: string;
		model?: string;
		provider?: string;
	}): void {
		if (identity.sessionId && identity.sessionId.trim()) {
			this._telemetrySessionId = identity.sessionId.trim();
			setTurnContextSession(this._telemetrySessionId);
		}
		const model = identity.model?.trim();
		const provider = identity.provider?.trim();
		if (model && provider) {
			this._telemetryModel = `${provider}/${model}`;
		} else if (model) {
			this._telemetryModel = model;
		} else if (provider) {
			this._telemetryModel = provider;
		}
		if (model) this._telemetryModelId = model;
		if (provider) {
			this._telemetryProvider = provider;
			this._telemetryProviderIsExplicit = true;
		} else if (model && !this._telemetryProviderIsExplicit) {
			// No explicit provider has ever been reported this session, so the
			// provider is (still) a derivation — re-derive it from the CURRENT
			// model id every time. Without this, a stale derived provider from
			// an earlier model would survive a mid-session model switch (e.g.
			// gpt-5-mini → claude-sonnet-4-5 with no explicit provider on
			// either call) because the old "has any provider ever been set"
			// guard treated the derived value as sticky. An explicit provider,
			// once set, is never touched here regardless of later model calls.
			this._telemetryProvider = deriveProviderFromModelId(model);
		}
	}

	get telemetrySessionId(): string {
		return this._telemetrySessionId;
	}

	/**
	 * Pin the session identity to pi's STABLE session id and record why this
	 * session started (#190). Called AFTER {@link resetForSession} (which assigns
	 * a fresh random id), so the stable id — when pi provides one via
	 * `ctx.sessionManager.getSessionId()` — wins and survives a quit→resume.
	 */
	setSessionLifecycle(args: { sessionId?: string; reason?: string }): void {
		if (args.sessionId && args.sessionId.trim()) {
			this._telemetrySessionId = args.sessionId.trim();
			this._hasStableSessionId = true;
		}
		this._lifecycleReason = args.reason;
	}

	/** Why the current session started: new | resume | fork | reload | startup. */
	get sessionLifecycleReason(): string | undefined {
		return this._lifecycleReason;
	}

	/** True once a stable pi session id has been pinned (vs the random fallback). */
	get hasStableSessionId(): boolean {
		return this._hasStableSessionId;
	}

	get telemetryModel(): string {
		return this._telemetryModel;
	}

	/** Raw model id (never the combined `provider/model` display string), blank
	 * when the host hasn't reported one this session. Worklog/disposition
	 * attribution (#1448) reads this, not {@link telemetryModel}. */
	get telemetryModelId(): string {
		return this._telemetryModelId;
	}

	/** Explicit host-reported provider, or a conservative derivation from the
	 * model id (see clients/model-provider.ts), blank when neither is known. */
	get telemetryProviderId(): string {
		return this._telemetryProvider;
	}

	get turnIndex(): number {
		return this._turnIndex;
	}

	/**
	 * #3613 G1: the turn starts of every session on this coordinator since the
	 * session reset. A process-level turn cadence (the memory sample, the
	 * smells re-check) paces on it: an integer, so its `% N` gate is met, and
	 * moved by a subagent's turns, which run inside one primary turn.
	 */
	get turnStartCount(): number {
		return this._turnStarts;
	}

	/** #3540 r2: the order turn a write token is drawn in; never restarts. */
	get writeOrderTurn(): number {
		return this._writeOrderTurn;
	}

	get projectSeq(): number {
		return this._projectSeq;
	}

	/** True when a snapshot of this runtime must not claim `projectSeq` (#3511). */
	get viewMissesLoggedEntries(): boolean {
		return this._viewMissingThrough > 0;
	}

	/** The change-log entries this session's seed or merge folded (#3511). */
	get viewLogEntries(): number {
		return this._viewLogEntries;
	}

	get turnStartProjectSeq(): number {
		return this._turnStartProjectSeq;
	}

	seedProjectSequence(
		projectSeq: number,
		fileSeqByPath?: Map<string, number>,
		/** The log entries the read folded (#3511 review round 2). */
		logEntries = 0,
	): void {
		this._projectSeq = Math.max(0, Math.floor(projectSeq));
		this._viewMissingThrough = 0;
		this._viewLogEntries = logEntries;
		this._turnStartProjectSeq = this._projectSeq;
		this._fileSeq.clear();
		// Seeded per-file counters carry no projectSeq provenance, so start the
		// changed-since map empty; the graph fast path simply won't fire until an
		// in-process bump records a seq-stamped change (safe: falls back to sweep).
		this._fileLastProjectSeq.clear();
		for (const [filePath, seq] of fileSeqByPath ?? []) {
			this._fileSeq.set(
				normalizeMapKey(path.resolve(filePath)),
				Math.max(0, seq),
			);
		}
	}

	/**
	 * #3511 review B2: fold a late sequence read (session_start's deferred one,
	 * after a timed-out read seeded 0) into a session that has already
	 * advanced. Unlike `seedProjectSequence` it never lowers the seq or a
	 * file's seq, and keeps the in-window changed-since marks. It clears the
	 * incomplete mark only when the read reaches every entry the view missed:
	 * locked allocation appends entries in rising seq order, so a read whose
	 * max is at or above that seq saw all of them. An unlocked entry breaks
	 * that order; readers catch it by its tag after the fold point, which the
	 * merge only ever advances (review round 2).
	 */
	mergeProjectSequence(
		projectSeq: number,
		fileSeqByPath: Map<string, number>,
		logEntries = 0,
	): void {
		this._projectSeq = Math.max(this._projectSeq, Math.floor(projectSeq));
		this._viewLogEntries = Math.max(this._viewLogEntries, logEntries);
		for (const [filePath, seq] of fileSeqByPath) {
			const key = normalizeMapKey(path.resolve(filePath));
			this._fileSeq.set(key, Math.max(this._fileSeq.get(key) ?? 0, seq));
		}
		if (projectSeq >= this._viewMissingThrough) this._viewMissingThrough = 0;
	}

	bumpFileSeq(
		filePath: string,
		/** The shared change log's max seq, when this bump is logged (#3511). */
		logMaxSeq = 0,
	): {
		projectSeq: number;
		fileSeq: number;
		/** The normalized key the bump was recorded under — reuse, never re-derive. */
		key: string;
	} {
		// normalizeMapKey costs a realpath syscall per call — ~200us on Windows,
		// ~1.8us on POSIX since #3098; every caller that also needs the key must
		// reuse this one instead of paying it twice.
		const key = normalizeMapKey(path.resolve(filePath));
		// #3511: a sibling process logged entries above our seq. Allocate above
		// them, and remember that this runtime's view has not folded them.
		if (logMaxSeq > this._projectSeq) {
			this._projectSeq = logMaxSeq;
			this._viewMissingThrough = Math.max(this._viewMissingThrough, logMaxSeq);
		}
		this._projectSeq += 1;
		const fileSeq = (this._fileSeq.get(key) ?? 0) + 1;
		this._fileSeq.set(key, fileSeq);
		this._fileLastProjectSeq.set(key, this._projectSeq);
		return { projectSeq: this._projectSeq, fileSeq, key };
	}

	/**
	 * Files whose most recent bump happened AFTER `seq` — i.e. every file the
	 * review graph would need to re-ingest to catch up from a build taken at
	 * projectSeq `seq` (#451). Returns NORMALIZED keys (normalizeMapKey +
	 * path.resolve), the same form the builder's fileSignatures map uses, so the
	 * caller can compare without re-normalizing.
	 */
	getFilesChangedSince(seq: number): string[] {
		const changed: string[] = [];
		for (const [key, lastSeq] of this._fileLastProjectSeq) {
			if (lastSeq > seq) changed.push(key);
		}
		return changed;
	}

	getFileSeq(filePath: string): number {
		return this._fileSeq.get(normalizeMapKey(path.resolve(filePath))) ?? 0;
	}

	getFileSeqEntries(): Array<[string, number]> {
		return [...this._fileSeq.entries()];
	}

	get sessionGeneration(): number {
		return this._scope.scopeId;
	}

	/** #3611: the session scope this coordinator serves. */
	get sessionScope(): SessionScope {
		return this._scope;
	}

	/**
	 * #3499: a handle on the current session, for a write that lands after an
	 * await which can outlive the session (a fire-and-forget quiet window).
	 * #3611: a `LineageHandle` on the current scope.
	 */
	captureSessionGeneration(): LineageHandle {
		return this._scope.capture();
	}

	isCurrentSession(generation: number): boolean {
		return this._scope.scopeId === generation && this._scope.isLive();
	}

	markStartupScanInFlight(name: StartupTaskName, generation: number): void {
		this._startupScansInFlight.set(name, generation);
	}

	clearStartupScanInFlight(name: StartupTaskName, generation: number): void {
		const owner = this._startupScansInFlight.get(name);
		if (owner === generation) {
			this._startupScansInFlight.delete(name);
		}
	}

	isStartupScanInFlight(name: StartupTaskName): boolean {
		return this._startupScansInFlight.has(name);
	}

	formatPipelineCrashNotice(filePath: string, err: unknown): string {
		const key = path.resolve(filePath);
		const count = (this._pipelineCrashCounts.get(key) ?? 0) + 1;
		this._pipelineCrashCounts.set(key, count);

		const message = err instanceof Error ? err.message : String(err);
		const shortMessage = message.split("\n")[0].slice(0, 220);
		const shouldSurface =
			count <= RUNTIME_CONFIG.crashNotice.alwaysShowFirstN ||
			count % RUNTIME_CONFIG.crashNotice.showEveryNth === 0;
		if (!shouldSurface) return "";

		return [
			"⚠️ pi-lens pipeline crashed while analyzing this write.",
			`File: ${path.basename(filePath)} | crash count this session: ${count}`,
			`Error: ${shortMessage}`,
			"Recovery: LSP service was reset. If this repeats, rerun with --no-lsp and report the file + stack.",
		].join("\n");
	}

	getCrashEntries(): Array<[string, number]> {
		return Array.from(this._pipelineCrashCounts.entries());
	}

	get projectRoot(): string {
		return this._projectRoot;
	}

	set projectRoot(value: string) {
		this._projectRoot = normalizeMapKey(value);
	}

	get errorDebtBaseline(): ErrorDebtBaseline | null {
		return this._errorDebtBaseline;
	}

	set errorDebtBaseline(value: ErrorDebtBaseline | null) {
		this._errorDebtBaseline = value;
	}

	get cachedExports(): Map<string, string> {
		return this._cachedExports;
	}

	appendCascadeRun(run: CascadeRun): void {
		this._cascadeRuns.push(run);
	}

	/**
	 * #3512: `generation` is the session the compute was dispatched in. The
	 * admitting handler awaits the pipeline first and can resume after a
	 * same-cwd replacement's reset, so a capture taken here would name the new
	 * session; it is therefore required. `filePath` is the edited file the
	 * compute belongs to, the subject of a dropped admission's ledger row.
	 */
	appendCascadePromise(
		p: Promise<CascadeRun>,
		generation: GenerationHandle,
		filePath: string,
		analysisRootMode: AnalysisRootMode = "session",
	): void {
		if (!canWriteAnalysisRoot(analysisRootMode)) return;
		// A stale admission is dropped on both branches below.
		if (generation.guardedWrite(filePath, () => true) === undefined) return;
		if (this._pendingCascadeRuns.length < MAX_PENDING_CASCADE_RUNS) {
			this._pendingCascadeRuns.push(p);
			return;
		}
		// Preserve delivery for overflow rather than growing the per-edit array.
		// The settled run enters the same accumulator off-hook and is therefore
		// visible to the next turn-end drain.
		recordDegradationOnce({
			kind: "cascade-pending-cap",
			subject: "runtime-coordinator",
			reason: `deferred cascade admission capped at ${MAX_PENDING_CASCADE_RUNS}`,
		});
		// #3512: the reset cannot reach this detached append, so a compute
		// admitted in one session and settling after a same-cwd replacement is
		// dropped here instead of landing in the new session's runs.
		void p
			.then((run) =>
				generation.guardedWrite(run.filePath, () => this.appendCascadeRun(run)),
			)
			.catch(() => {
				// Pipeline promises are normally non-rejecting; preserve the existing
				// failure sink if a caller violates that contract.
			});
	}

	/**
	 * The active turn_end settle clock, or undefined outside that wait.
	 *
	 * #1462 review F-F: every cascade compute in flight on this coordinator
	 * reads the SAME clock. `_turnEndCascadeSettleStarts` is keyed by settle
	 * token so `settleCascadeRuns` can distinguish its own drain from a nested
	 * one, but this getter always answers with the latest active window —
	 * there is one turn_end per runtime, not one per caller. A cascade begun
	 * moments before turn_end and one begun long before it both measure elapsed
	 * time against the same start, which is correct: they are racing the same
	 * settle wait and share its deadline, not separate ones.
	 */
	getTurnEndCascadeSettleStart(): number | undefined {
		let latest: number | undefined;
		for (const start of this._turnEndCascadeSettleStarts.values())
			latest = start;
		return latest;
	}

	/**
	 * Drain the deferred cascade computes kicked off this turn (#450), racing them
	 * against a bounded wait. Fulfilled runs feed the same accumulator as inline
	 * runs (appendCascadeRun). A promise still pending at the cap is retained so a
	 * late-resolving compute is picked up on the next turn_end rather than lost.
	 * The stored promises never reject (pipeline guarantees an "error" skip-run).
	 */
	async settleCascadeRuns(
		maxWaitMs: number,
		settleOptions: {
			trackTurnEndClock?: boolean;
			/**
			 * #3499: the session this settle belongs to. The quiet window runs
			 * fire-and-forget and can outlive its session; after a replacement,
			 * both the append and the re-park are dropped.
			 * #4161: a settle called after the replacement takes nothing: the
			 * computes parked then are the successor's (turn_end calls it after
			 * awaits a replacement can land in).
			 */
			generation?: GenerationHandle | undefined;
		} = {},
	): Promise<{ settled: number; timedOut: number }> {
		const pending = this._pendingCascadeRuns;
		if (pending.length === 0) return { settled: 0, timedOut: 0 };
		const { generation } = settleOptions;
		if (
			generation &&
			generation.guardedWrite("cascade-settle", () => true) === undefined
		)
			return { settled: 0, timedOut: 0 };
		this._pendingCascadeRuns = [];
		const settleToken = settleOptions.trackTurnEndClock
			? ++this._nextCascadeSettleToken
			: undefined;
		if (settleToken !== undefined) {
			this._turnEndCascadeSettleStarts.set(settleToken, Date.now());
		}

		try {
			// Track per-promise settlement so promises still in flight at the cap can be
			// carried over. A settled entry records its run; an unsettled one is re-parked.
			const tracked = pending.map((p) => {
				const entry: {
					done: boolean;
					run?: CascadeRun;
					promise: Promise<CascadeRun>;
				} = { done: false, promise: p };
				entry.promise = p.then((run) => {
					entry.done = true;
					entry.run = run;
					return run;
				});
				return entry;
			});

			const timeout = new Promise<void>((resolve) => {
				setTimeout(resolve, maxWaitMs).unref?.();
			});
			await Promise.race([
				Promise.allSettled(tracked.map((t) => t.promise)),
				timeout,
			]);

			const commit = (subject: string, write: () => void): void => {
				if (generation) generation.guardedWrite(subject, write);
				else write();
			};
			let settled = 0;
			let timedOut = 0;
			for (const entry of tracked) {
				const { run } = entry;
				if (entry.done && run) {
					commit(run.filePath, () => this.appendCascadeRun(run));
					settled += 1;
				} else {
					// An unsettled compute has no file yet; the ledger row counts them.
					commit("cascade-pending", () =>
						this._pendingCascadeRuns.push(entry.promise),
					);
					timedOut += 1;
				}
			}
			return { settled, timedOut };
		} finally {
			if (settleToken !== undefined) {
				this._turnEndCascadeSettleStarts.delete(settleToken);
			}
		}
	}

	/**
	 * #3813/#3901: park the items a lane's advisory showed and the turn-end cap
	 * cut. Their producers have no queue to restore (the scan cache is
	 * overwritten and the edited-file worklist retired before the cap runs), so
	 * the lane re-checks each parked item against its next fresh run. Replaces
	 * the lane's earlier entry. Returns the lane evicted to stay within
	 * `MAX_CUT_ADVISORY_LANES`, if any.
	 */
	parkCutAdvisoryItems(lane: string, items: readonly unknown[]): string[] {
		this._cutAdvisoryItems.delete(lane);
		if (items.length === 0) return [];
		return this._cutAdvisoryItems.set(lane, [...items]).map(([key]) => key);
	}

	/** Remove and return a lane's parked items: they are offered once. */
	takeCutAdvisoryItems<T>(lane: string): T[] {
		const items = this._cutAdvisoryItems.get(lane);
		this._cutAdvisoryItems.delete(lane);
		return (items ?? []) as T[];
	}

	consumeCascadeRuns(): CascadeRun[] {
		const runs = this._cascadeRuns;
		this._cascadeRuns = [];
		return runs;
	}

	/**
	 * R1 (#1443 follow-up): non-destructive peek used by turn_end's read-only
	 * fast path. A carried cascade run (or one still in flight) represents a
	 * DELIVERY OPPORTUNITY, not turn activity — an agent that answers a question
	 * without editing anything must still get yesterday's late finding. Before
	 * this, the files-empty early return skipped `settleCascadeRuns` /
	 * `consumeCascadeRuns` entirely on a read-only turn, so `beginTurn`'s next
	 * carry pass saw the run as having survived a turn_start with no offsetting
	 * drain and dropped it — burning the one-turn carry allowance on a turn that
	 * never had a chance to deliver.
	 */
	hasCascadeRuns(): boolean {
		// Carried, ALREADY-BUILT runs only. Pending (still-settling) computes are
		// deliberately excluded: a read-only turn that fell through for a pending
		// run would block on the full settle cap — every turn, forever, when the
		// compute never resolves (re-review finding F1). A pending run loses
		// nothing by waiting: settleCascadeRuns re-parks it and the next turn
		// that actually settles it delivers it.
		return this._cascadeRuns.length > 0;
	}

	/**
	 * Record a file's blocking verdict. Returns its freshness baseline, or
	 * undefined when a newer dispatch of the same file already recorded or
	 * cleared it (#3507). `recordedAtMs` is the pipeline's analysis read time
	 * (#3503); a caller without one stamps now.
	 */
	recordInlineBlockers(
		filePath: string,
		summary: string,
		writeIndex?: number,
		sources?: readonly string[],
		lines?: readonly number[],
		contentBaseline?: { size: number; sha256: string },
		diagnostics?: readonly Diagnostic[],
		orderTurn = this._writeOrderTurn,
		recordedAtMs = Date.now(),
		/** #4921: the turn session of the write (`ToolResultDeps.sessionId`). */
		sessionId?: string,
	): number | undefined {
		const writeOrder = writeOrderToken(orderTurn, writeIndex);
		if (
			!this._inlineBlockerWriteOrder.shouldWrite(
				normalizeMapKey(filePath),
				writeOrder,
			)
		)
			return undefined;
		// #3218 criterion 2: a newer blocking verdict supersedes an earlier
		// retirement of the same file — the agent is blocked on it again, so a
		// carried "Resolved" entry would be a false claim.
		this._resolvedBlockerFilesThisTurn.delete(filePath);
		this._pendingInlineBlockers.set(filePath, {
			filePath,
			summary,
			writeIndex,
			writeOrder,
			sources,
			lines,
			diagnostics,
			recordedAtMs,
			stale: false,
			...(contentBaseline
				? {
						recordedSize: contentBaseline.size,
						recordedHash: contentBaseline.sha256,
					}
				: {}),
			...this.recordSession(sessionId),
		});
		return recordedAtMs;
	}

	/**
	 * #3814: add a settled collect-later runner's blocking findings to the file's
	 * inline-blocker record, the one channel the commit gate's latch
	 * (`updateGitGuardStatus`) and the turn-end replay both read. A deferred
	 * runner answers after `recordInlineBlockers` has run for its edit, so it
	 * MERGES into the record instead of replacing it: the fast runners' blockers
	 * for the same bytes stay.
	 *
	 * Idempotent by finding identity, because two callers hand the same answer
	 * here: the commit gate (before turn end) and the turn-end drain (after).
	 * Ordering needs no token of its own: the caller admits only answers the
	 * path-freshness gate called current, and a later write to the file replaces
	 * or clears the whole record (`recordInlineBlockers` / `clearInlineBlockers`).
	 * A new record carries the analysed bytes' baseline, so a disposition verdict
	 * on it is confirmable by the gate (`firstExpiredSuppressionVerdict`); a
	 * merge keeps the existing baseline and its stale demotion. An existing
	 * record with no structured diagnostics is left alone: the file already
	 * blocks, and merging into text alone would drop it from the replay.
	 *
	 * @returns how many findings were new to the record (0 = a replay).
	 */
	recordDeferredInlineBlockers(
		filePath: string,
		blocking: readonly Diagnostic[],
		analysed: {
			recordedAtMs: number;
			contentBaseline?: { size: number; sha256: string };
		},
		/**
		 * #4943: the turn session of the write the settled runner answered
		 * (`PendingRunnerFindings.sessionId`). A new record is that session's;
		 * a merge keeps the existing record's owner.
		 */
		sessionId?: string,
	): number {
		const key = filePath;
		const existing = this._pendingInlineBlockers.get(key);
		if (existing && !existing.diagnostics) return 0;
		// #4484 round 5 (K3): not the id. A carry that moves a blocker's line
		// keeps its line-bound id (`lsp:<code>:<line>`), so the settled copy at
		// the same line has another one.
		const identity = (d: Diagnostic) =>
			JSON.stringify([foldedFindingIdentity(d), d.line, d.column]);
		const known = new Set((existing?.diagnostics ?? []).map(identity));
		const added = blocking.flatMap((d) => (known.has(identity(d)) ? [] : [d]));
		if (added.length === 0) return 0;
		const diagnostics = [...(existing?.diagnostics ?? []), ...added];
		this._pendingInlineBlockers.set(key, {
			...(existing ?? {
				filePath,
				recordedAtMs: analysed.recordedAtMs,
				stale: false,
				...(analysed.contentBaseline
					? {
							recordedSize: analysed.contentBaseline.size,
							recordedHash: analysed.contentBaseline.sha256,
						}
					: {}),
				...this.recordSession(sessionId),
			}),
			summary: formatDiagnostics(diagnostics, "blocking").trim(),
			diagnostics,
			// The same two derivations the pipeline's writer uses: `lines` keeps only
			// this file's own rows, `sources` pins an untagged finding as "unknown".
			sources: [
				...new Set([
					...(existing?.sources ?? []),
					...inlineBlockerSources(added),
				]),
			],
			lines: [
				...(existing?.lines ?? []),
				...inlineBlockerLines(added, filePath),
			],
			// The turn-end policy verdict was about the OLD set; the added findings
			// passed the policy already and the next turn end re-derives the rest.
			policySuppressed: false,
		});
		return added.length;
	}

	/**
	 * #4484 round 2: the file's recorded blocking diagnostics, which the next
	 * write's pipeline carries forward unless a conclusive observation from
	 * their own source shows them gone. Undefined when nothing is recorded or
	 * the record holds text only.
	 */
	getInlineBlockerDiagnostics(
		filePath: string,
	): readonly Diagnostic[] | undefined {
		return this._pendingInlineBlockers.get(filePath)?.diagnostics;
	}

	/**
	 * #4484 round 3: the anchor the next write's pipeline aligns to: the line
	 * hashes of the bytes the file's blocker record is about, and the lines
	 * still owed. Round 4: it is the record's own anchor. A file without one
	 * (no record, or a record a collect-later settle started) gets no hashes,
	 * so the pipeline cannot align. Round 5: it gets the owed line texts.
	 */
	getAnalysisAnchor(filePath: string): AnalysisAnchor | undefined {
		return (
			this._pendingInlineBlockers.get(filePath)?.analysisAnchor ??
			this._owedAnchors.get(filePath) ??
			this._owedRunners.get(filePath)
		);
	}

	/**
	 * #4484 round 3: store the anchor of an inline verdict that just applied
	 * (`recordInlineBlockers` or `clearInlineBlockers` returned applied), so it
	 * always describes the bytes the record is about. Round 4: it goes on the
	 * record, and lives as long as the record; what is owed goes apart
	 * (`_owedRunners`, by content since round 5), so it outlives a record that
	 * a later retire drops. Round 5: a file with no record keeps its whole
	 * anchor too (`_owedAnchors`, bounded).
	 */
	setAnalysisAnchor(
		filePath: string,
		anchor: AnalysisAnchor | undefined,
	): void {
		const existing = this._pendingInlineBlockers.get(filePath);
		if (existing) {
			// The display key every record writer uses.
			const key = filePath;
			const { analysisAnchor: _dropped, ...rest } = existing;
			this._pendingInlineBlockers.set(
				key,
				anchor ? { ...rest, analysisAnchor: anchor } : rest,
			);
		}
		const owed = owedByContentOnly(anchor);
		if (owed) this._owedRunners.set(filePath, owed);
		else this._owedRunners.delete(filePath);
		if (owed && anchor?.lineHashes && !existing)
			this._owedAnchors.set(filePath, anchor);
		else this._owedAnchors.delete(filePath);
	}

	/**
	 * #4484 round 2: a settled collect-later run is the observation that can
	 * retire the blockers its runner left pending while it was in flight. Its
	 * runner's recorded blockers that the run no longer observes leave the
	 * record; blockers from other runners, and from a server the run left
	 * unconfirmed, stay. A blocker is still observed only at its own line, in
	 * range or withheld by the run's edit-range gate (#4484 round 3). The run
	 * must be about the recorded bytes: marked after
	 * they were read (`recordedAtMs`), with the file still holding them
	 * (`recordedHash`). An emptied record is deleted and its file is noted
	 * Resolved for turn end, as a clean write's clear does.
	 *
	 * @returns how many recorded blockers the run retired.
	 */
	retireUnobservedRunnerBlockers(
		filePath: string,
		run: {
			runnerId: string;
			observed: readonly Diagnostic[];
			markedAtMs: number;
			sha256: string | undefined;
			unconfirmedServerIds?: readonly string[];
		},
	): number {
		const key = filePath;
		const existing = this._pendingInlineBlockers.get(key);
		if (
			!existing?.diagnostics ||
			run.sha256 === undefined ||
			existing.recordedHash !== run.sha256 ||
			existing.recordedAtMs === undefined ||
			run.markedAtMs < existing.recordedAtMs
		)
			return 0;
		const unconfirmed = new Set(run.unconfirmedServerIds);
		// #4484 round 3: the run is about the recorded bytes, so a recorded
		// blocker's position is its own line. #4509 (N3): except a stale one,
		// whose line is from older bytes; it matches its identity anywhere.
		const { kept, retired } = retainRecordedFindings(
			existing.diagnostics,
			run.observed,
			{
				positionOf: (d) => (d.positionStale ? ANY_POSITION : d.line),
				keepUnobserved: (d) =>
					d.runnerId !== run.runnerId ||
					(d.serverId !== undefined && unconfirmed.has(d.serverId)),
			},
		);
		if (retired.length === 0) return 0;
		if (kept.length === 0) {
			this.noteResolvedBlockerFile(existing, undefined, false);
			this._pendingInlineBlockers.delete(key);
			return retired.length;
		}
		this._pendingInlineBlockers.set(key, narrowedRecord(existing, kept));
		return retired.length;
	}

	/**
	 * #3218 criterion 2: remember one file whose blocker a clean verdict just
	 * retired, for the turn-end "Resolved" line. Called from the two retire
	 * seams (`clearInlineBlockers` and `retireInlineBlockerOnConfirmedClean`)
	 * with the record that was removed and the retiring write's order, so the
	 * composer never has to re-derive the count from rendered text. Bounded at
	 * `MAX_RESOLVED_BLOCKER_FILES`; the overflow is counted for the "… and N
	 * more" tail.
	 */
	private noteResolvedBlockerFile(
		record: InlineBlockerRecord,
		retiringWriteOrder: number | undefined,
		confirmedClean: boolean,
	): void {
		if (
			!this._resolvedBlockerFilesThisTurn.has(record.filePath) &&
			this._resolvedBlockerFilesThisTurn.size >= MAX_RESOLVED_BLOCKER_FILES
		) {
			this._resolvedBlockerFilesDropped += 1;
			return;
		}
		this._resolvedBlockerFilesThisTurn.set(record.filePath, {
			filePath: record.filePath,
			blockerCount: record.diagnostics?.length ?? record.lines?.length ?? 1,
			// A write order token carries its turn above the write index
			// (`writeOrderToken`); the line names only the write.
			writeIndex:
				confirmedClean || retiringWriteOrder === undefined
					? undefined
					: retiringWriteOrder % 2 ** 32,
			confirmedClean,
			turnIndex: this._turnIndex,
			...(record.session === undefined ? {} : { session: record.session }),
		});
	}

	/**
	 * Clear a file's verdict after a clean dispatch. Returns false when a newer
	 * dispatch of the same file already recorded or cleared it (#3507), or when
	 * `analysis` ran without authorship over the very bytes the record is about
	 * (#4137 round 3). Such a run withholds the blocker channel (#3226), so its
	 * clean result is no evidence against an authored verdict on the same bytes;
	 * before this, an opaque recovery of bytes the agent authored cleared the
	 * record whenever the already-analysed latch was gone (a concurrent
	 * session's turn start, the session's own next turn), and turn end then
	 * reported a false "Resolved". The refusal consumes no write order and is
	 * counted as `blocker-clear-refused` per file key. A record with no
	 * `recordedHash` (#2982: the file was unreadable or over the baseline cap at
	 * record time) cannot be matched and is cleared as before.
	 *
	 * #4484: a blocker is pending until a fresh observation no longer holds it,
	 * so a run whose own observation still holds `analysis.blocking` blockers
	 * never clears the record, whatever its authorship or its delta said; it
	 * is refused and counted the same way.
	 */
	clearInlineBlockers(
		filePath: string,
		writeIndex?: number,
		orderTurn = this._writeOrderTurn,
		analysis?: {
			authored: boolean;
			sha256: string | undefined;
			blocking?: number;
		},
	): boolean {
		const existing = this._pendingInlineBlockers.get(filePath);
		if (existing && (analysis?.blocking ?? 0) > 0) {
			incrementDegradationCount({
				kind: "blocker-clear-refused",
				subject: normalizeMapKey(filePath),
				reason:
					"the clearing run still observed a blocker on the file; the record stays until an observation holds none (#4484)",
			});
			return false;
		}
		if (
			existing &&
			analysis &&
			!analysis.authored &&
			analysis.sha256 !== undefined &&
			existing.recordedHash === analysis.sha256
		) {
			// Counted per file key: one ledger entry per file, a durable row at the
			// first refusal and the ledger's power-of-two milestones, never one per
			// occurrence.
			incrementDegradationCount({
				kind: "blocker-clear-refused",
				subject: normalizeMapKey(filePath),
				reason:
					"an analysis without authorship read the bytes an authored verdict is about; its clean result does not retire the record (#4137)",
			});
			return false;
		}
		if (
			!this._inlineBlockerWriteOrder.shouldWrite(
				normalizeMapKey(filePath),
				writeOrderToken(orderTurn, writeIndex),
			)
		)
			return false;
		if (existing) {
			this.noteResolvedBlockerFile(
				existing,
				writeOrderToken(orderTurn, writeIndex),
				false,
			);
		}
		this._pendingInlineBlockers.delete(filePath);
		return true;
	}

	/**
	 * #1631: demote a cached blocker to stale without dropping it (#1419
	 * demote-not-drop). Called by the turn-boundary freshness sweep when the
	 * file or one of its forward imports drifted on disk after the verdict.
	 * Idempotent: re-marking an already-stale entry (for ANY reason) is a
	 * no-op — a `"past-eof"` demotion already took this record out of the
	 * authoritative channel, and `sweepInlineBlockerFreshness` re-checks next
	 * turn once that heals. Returns true only when this call transitioned the
	 * entry to stale, so a caller can log the demotion exactly once.
	 */
	markInlineBlockerStale(
		filePath: string,
		reason: "dependency-drift" | "past-eof" = "dependency-drift",
	): boolean {
		const key = filePath;
		const existing = this._pendingInlineBlockers.get(key);
		if (!existing || existing.stale) return false;
		this._pendingInlineBlockers.set(key, {
			...existing,
			stale: true,
			staleReason: reason,
		});
		return true;
	}

	/**
	 * #1641: re-derive the past-EOF demotion for one inline-blocker record.
	 * Unlike {@link markInlineBlockerStale} (a one-way latch for the
	 * dependency-drift gate), this RE-ARMS: called every turn end with the
	 * gate's freshly-computed verdict, it can both demote (rising edge) and
	 * heal (falling edge — a transient shrink-then-restore of the file). Never
	 * touches a record a sibling gate demoted (`staleReason !== "past-eof"`
	 * while `stale`) — composing with #1631's dependency-drift gate means each
	 * gate only heals its own demotions. Returns true only on an actual
	 * transition, so the caller logs/resyncs exactly once per edge.
	 */
	setInlineBlockerPastEofStale(filePath: string, isPastEof: boolean): boolean {
		const key = filePath;
		const existing = this._pendingInlineBlockers.get(key);
		if (!existing) return false;
		if (existing.stale && existing.staleReason !== "past-eof") return false;
		const currentlyPastEof =
			!!existing.stale && existing.staleReason === "past-eof";
		if (currentlyPastEof === isPastEof) return false;
		this._pendingInlineBlockers.set(key, {
			...existing,
			stale: isPastEof,
			staleReason: isPastEof ? "past-eof" : undefined,
		});
		return true;
	}

	/**
	 * #2982: re-derive the self-drift demotion for one inline-blocker record.
	 *
	 * Modelled on {@link setInlineBlockerPastEofStale}, not on
	 * {@link markInlineBlockerStale}: it RE-ARMS rather than latching, so a
	 * file whose bytes drift and then come back (a checkout, a revert, an
	 * editor writing the original content) un-demotes on the next sweep
	 * instead of staying demoted for the session. That re-arm covers a file whose
	 * bytes COME BACK; it does not cover an agent rewrite that never returns to
	 * them, which is why this axis carries its own delivery cap
	 * (`SELF_DRIFT_MAX_DELIVERIES`, #4990) — a record that heals before the cap
	 * un-demotes and is never retired, so the security-provenance concern
	 * (#2982 review) still holds.
	 *
	 * Composes with the sibling gates the same way they compose with each
	 * other: it never touches a record another gate demoted, and never heals a
	 * demotion it did not make. Returns true only on an actual transition, so
	 * the caller counts exactly one edge.
	 */
	setInlineBlockerSelfDriftStale(
		filePath: string,
		isSelfDrift: boolean,
	): boolean {
		const key = filePath;
		const existing = this._pendingInlineBlockers.get(key);
		if (!existing) return false;
		if (existing.stale && existing.staleReason !== "self-drift") return false;
		const currentlySelfDrift =
			!!existing.stale && existing.staleReason === "self-drift";
		if (currentlySelfDrift === isSelfDrift) return false;
		// Omit the key rather than assigning `undefined` to it: under
		// `exactOptionalPropertyTypes` those are different, and writing the
		// `undefined` is a strictness spike the ratchet counts. Healing has to
		// drop `staleReason` off the rebuilt record, so destructure it away
		// instead of letting `...existing` carry the old value through.
		//
		// The delivery count goes with it (#4990 review F3): it is the cap's
		// tally for ONE demotion episode, and a heal ends the episode. Carried
		// across, the next demotion retired on its first delivery with a ledger
		// reason claiming a full cap the agent never saw.
		const {
			staleReason: _cleared,
			staleDeliveryCount: _clearedCount,
			...rest
		} = existing;
		this._pendingInlineBlockers.set(key, {
			...rest,
			stale: isSelfDrift,
			...(isSelfDrift ? { staleReason: "self-drift" as const } : {}),
		});
		return true;
	}

	/**
	 * #1944: retire a past-EOF demotion after its ONE degraded delivery.
	 *
	 * The past-EOF gate demotes and re-arms, but nothing ever retired the
	 * record, so a blocker whose file shrank past the cited lines re-served on
	 * every turn end for the rest of the session — measured live at 80+
	 * minutes on session 01a0234c. The re-serve is unbounded, not the six
	 * turns the first evidence window suggested.
	 *
	 * It is unbounded because the record cannot resolve itself. The two
	 * clearing events (`clearInlineBlockers` on a later dispatch of the same
	 * path, `retireInlineBlockerOnConfirmedClean` on a fresh clean verdict)
	 * both need the file to be looked at again, and the agent has no reason to
	 * look: the coordinates it was handed do not exist. "Re-run to confirm" is
	 * an instruction this record makes impossible to follow.
	 *
	 * So the delivery surface retires it after serving it once, degraded. That
	 * is a DROP, which #1419's demote-not-drop rule normally forbids; the
	 * exception is narrow and stated here. The finding was already delivered
	 * this turn with its dead coordinates annotated, and what remains is a
	 * message pinned to a line the file does not have. `deadLines` is required
	 * and must be non-empty, so a record stale for any OTHER reason, or
	 * past-EOF with no identified dead line, still stands.
	 *
	 * @returns true when an entry was retired — the caller records it, so the
	 * suppression is never silent (#1432 Gap 1).
	 */
	retireDemotedPastEofBlocker(
		filePath: string,
		deadLines: readonly number[],
	): boolean {
		const key = this.pastEofRetireKey(filePath, deadLines);
		if (key === undefined) return false;
		this._pendingInlineBlockers.delete(key);
		return true;
	}

	/**
	 * #3813: the retire rule of {@link retireDemotedPastEofBlocker}, without
	 * the delete. The turn-end composer asks it at render time (to word the
	 * retirement note) and only retires once the cap has let the delivery
	 * through; the rule stays here, in one place.
	 */
	wouldRetireDemotedPastEofBlocker(
		filePath: string,
		deadLines: readonly number[],
	): boolean {
		return this.pastEofRetireKey(filePath, deadLines) !== undefined;
	}

	/** The store key of the record the past-EOF retire rule admits, if any. */
	private pastEofRetireKey(
		filePath: string,
		deadLines: readonly number[],
	): string | undefined {
		if (deadLines.length === 0) return undefined;
		const key = filePath;
		const existing = this._pendingInlineBlockers.get(key);
		if (!existing) return undefined;
		// Only this gate's own demotion. A dependency-drift demotion (#1631)
		// keeps in-bounds coordinates the agent CAN re-run against, so it stays
		// in the store until a fresh verdict clears it.
		if (!existing.stale) return undefined;
		return (existing.staleReason ?? "past-eof") === "past-eof"
			? key
			: undefined;
	}

	/**
	 * #1950 fix-round F1: read the current delivery count WITHOUT committing
	 * an increment. `runtime-turn.ts` needs the count a delivery would reach
	 * BEFORE it knows whether that delivery will actually reach the agent —
	 * the turn-end signature dedupe (`turn-end-findings-last`) can suppress a
	 * turn whose rendered content is identical to the last one, and a
	 * suppressed turn must not advance the counter (the agent never saw it).
	 * The caller peeks, renders the tentative body, and only calls
	 * {@link incrementInlineBlockerStaleDelivery} once it knows the turn's
	 * content is NOT being suppressed.
	 */
	peekInlineBlockerStaleDeliveryCount(filePath: string): number {
		const key = filePath;
		return this._pendingInlineBlockers.get(key)?.staleDeliveryCount ?? 0;
	}

	/**
	 * #1950: commit one more turn end that re-served this record while
	 * `stale`. The caller (`runtime-turn.ts`) only calls this for a
	 * `"dependency-drift"` or `"self-drift"` demotion — a `"past-eof"`
	 * demotion retires after its own single delivery (#1944,
	 * `retireDemotedPastEofBlocker`) and never accumulates a count — and only
	 * AFTER confirming the turn's content will not be suppressed by the
	 * signature dedupe (see {@link peekInlineBlockerStaleDeliveryCount}), so
	 * this counts ACTUAL deliveries the agent saw, not turn-end loop
	 * iterations. Returns the new count, or 0 when there is no entry to count
	 * against (already retired, or never recorded).
	 */
	incrementInlineBlockerStaleDelivery(filePath: string): number {
		const key = filePath;
		const existing = this._pendingInlineBlockers.get(key);
		if (!existing) return 0;
		const next = (existing.staleDeliveryCount ?? 0) + 1;
		this._pendingInlineBlockers.set(key, {
			...existing,
			staleDeliveryCount: next,
		});
		return next;
	}

	/**
	 * #1950/#4990: retire a drift demotion once it has been delivered its axis's
	 * cap with no re-run confirming or clearing it.
	 * `"dependency-drift"` retires at `DEPENDENCY_DRIFT_MAX_DELIVERIES` and
	 * `"self-drift"` at `SELF_DRIFT_MAX_DELIVERIES` (both decided by the caller,
	 * `runtime-turn.ts`, which also owns the count). Unlike
	 * {@link retireDemotedPastEofBlocker}, the record is NOT provably
	 * unrecoverable — its coordinates are still in bounds, and a fresh dispatch
	 * of the file could still confirm or clear it. This is a bounded-noise cap,
	 * not a "this can never resolve" verdict, and the caller's ledger reason must
	 * say so (`demoted-finding-retired`'s "capped, re-run can still confirm" vs.
	 * past-EOF's "retired, unrecoverable").
	 *
	 * Only ever touches the named axis's OWN demotion: a record demoted by a
	 * sibling gate on the same file is that gate's record to retire, not this
	 * one's.
	 *
	 * @returns true when an entry was retired — the caller records it, so the
	 * suppression is never silent (#1432 Gap 1).
	 */
	retireDemotedDriftBlocker(
		filePath: string,
		reason: "dependency-drift" | "self-drift",
	): boolean {
		const key = filePath;
		const existing = this._pendingInlineBlockers.get(key);
		if (!existing) return false;
		if (!existing.stale) return false;
		if (existing.staleReason !== reason) return false;
		this._pendingInlineBlockers.delete(key);
		return true;
	}

	/**
	 * Retire a file's inline blocker because a FRESH, content-bound diagnostic
	 * verdict proved it gone (#1561).
	 *
	 * The map was invalidated by exactly two events: a later dispatch of the
	 * SAME path returning no blockers, and that path ceasing to exist (#1245).
	 * Neither covers the common case that produced #1561 — a blocker on file F
	 * whose cause lives in file G. Fixing G re-dispatches G, not F, so F's
	 * verdict was never re-taken and "Unresolved from this turn" was re-injected
	 * for the rest of the session. In the live case the agent then ran
	 * `lsp_diagnostics` on F, pi-lens answered "confirmed clean", and the
	 * blocker was STILL re-served on the next three turn ends: #571 wired that
	 * tool's confirmed result into the widget footer and stopped there.
	 *
	 * This is the seam #1198 invariant 4 left undecided, decided: an affirmative
	 * clean from the authoritative current view retires the stale verdict.
	 *
	 * Ordering (#1198 invariants 1-2). Both stores draw from the same
	 * `nextWriteIndex()` counter, ordered turn first (#3540: the counter
	 * restarts at every turn), so when both sides are stamped the retire
	 * requires the clean verdict to be strictly NEWER. A slow old clean that
	 * settles after a fresh dispatch found real blockers must not erase them.
	 * When either side is unstamped the two cannot be ordered at all; the fresh
	 * confirmed verdict wins, because it is the only one of the two backed by an
	 * actual observation of current content. Only production's single record site
	 * is stamped, so in practice the unstamped branch is legacy callers/tests.
	 *
	 * COVERAGE (#1561 F1). A blocker is retired only by a verdict that can speak
	 * for the tools that raised it. Inline blockers come from the whole dispatch,
	 * not just the language server: `dispatcher.ts` collects every
	 * `semantic === "blocking"` diagnostic across all runners, so eslint,
	 * biome-check, actionlint, elixir/gleam-check and ast-grep security rules all
	 * land in this map. A language-server check knows nothing about any of them,
	 * so the coverage test is per ROW (#4990 gap 1): the diagnostics whose source
	 * the verdict covered leave the record, the rest stay, and a record with no
	 * structured rows fails CLOSED and is never retired, because "we don't know
	 * what raised this" must not resolve to "an LSP check can clear it".
	 *
	 * Before #4990 the test was all-or-nothing on `record.sources`, so a record
	 * with `["lsp", "oxlint"]` outlived a confirmed-clean typescript verdict
	 * forever: one server cannot speak for the oxlint row, and the oxlint row was
	 * never re-dispatched either. Per-source row retirement is the same filter
	 * the record's own builder already applies (`inlineBlockerSources`), so a
	 * partly-covered record narrows to what the verdict did not speak for and
	 * keeps gating only on those rows.
	 *
	 * @returns true when the record was retired OR narrowed (at least one source
	 * row left it). The caller records either, so a drop is never silent
	 * (#1432 Gap 1).
	 */
	retireInlineBlockerOnConfirmedClean(
		filePath: string,
		/** #3540: a `nextWriteOrderToken()` reservation, turn first. */
		confirmedAtWriteOrder?: number,
		coveredSources?: readonly string[],
	): boolean {
		const key = filePath;
		const existing = this._pendingInlineBlockers.get(key);
		if (!existing) return false;
		if (
			existing.writeOrder !== undefined &&
			confirmedAtWriteOrder !== undefined &&
			confirmedAtWriteOrder <= existing.writeOrder
		) {
			return false;
		}
		// Fail closed on unknown provenance: "we don't know what raised this" must
		// not resolve to "an LSP check can clear it".
		if (!existing.sources || existing.sources.length === 0) return false;
		const covered = new Set(coveredSources ?? []);
		if (existing.sources.every((source) => covered.has(source))) {
			// #3218 criterion 2: this retire is a resolution — name it at turn end.
			this.noteResolvedBlockerFile(existing, undefined, true);
			this._pendingInlineBlockers.delete(key);
			return true;
		}
		// Partial coverage (#4990 gap 1). Without the structured rows there is no
		// honest per-source split, so the record stands, exactly as before.
		const diagnostics = existing.diagnostics;
		if (!diagnostics || diagnostics.length === 0) return false;
		const kept = diagnostics.filter(
			(diagnostic) => !covered.has(inlineBlockerSourceOf(diagnostic)),
		);
		if (kept.length === diagnostics.length) return false;
		if (kept.length === 0) {
			this.noteResolvedBlockerFile(existing, undefined, true);
			this._pendingInlineBlockers.delete(key);
			return true;
		}
		// The derived fields come from the surviving rows, never from the old
		// record (`narrowedRecord`).
		this._pendingInlineBlockers.set(key, narrowedRecord(existing, kept));
		return true;
	}

	/**
	 * #5020: retire the rows of other files' records that cite a file a fresh
	 * observation has settled. A chart-wide runner (helm-lint, helm-render) or an
	 * import-following one (mypy, phpstan) reports a blocking row against a file
	 * it did not dispatch for, so the row lands in the WRITTEN file's record
	 * (#1641). That record is re-taken only by a dispatch of the written file,
	 * which the agent has no reason to make once the cited file is fixed or gone:
	 * `clearInlineBlockers` never ran for it, and the commit gate stayed shut with
	 * nothing left to fix.
	 *
	 * The row is another file's claim, so the cited file's own state retires it
	 * (`why`), and only two states do. `"cited-file-clean"`: the cited file was
	 * dispatched and the runner that raised the row answered with no blocker of
	 * its own on it (the caller proves that; `shouldRetire` is its verdict per
	 * row). `"cited-file-missing"`: the cited file no longer exists, which the
	 * #1245 reconcile already decides for a record's OWN file. Everything else
	 * stays, rows with no structured diagnostics included (fail closed), and so
	 * does a row that cites no file (`isCrossFileBlocker` is total).
	 *
	 * A clean verdict retires only a record it is strictly newer than
	 * (`confirmedAtWriteOrder`, turn first), as `retireInlineBlockerOnConfirmedClean`
	 * orders its own: a slow old clean must not erase a newer observation.
	 *
	 * `of` limits the retire to one session's records, the partition
	 * `getInlineBlockersSnapshot` reads. Omitted, every session's record is
	 * judged.
	 *
	 * @returns one entry per record that lost rows, with the session that owns
	 * it, so the caller can bring the commit gate (the latch and the persisted
	 * record) back in line. Counted once per file in the degradation ledger.
	 */
	retireForeignRows(
		why: "cited-file-clean" | "cited-file-missing",
		shouldRetire: (row: Diagnostic) => boolean,
		confirmedAtWriteOrder?: number,
		of?: { sessionId: string | undefined },
	): Array<{ filePath: string; owner: string | undefined }> {
		const changed: Array<{ filePath: string; owner: string | undefined }> = [];
		for (const existing of this.getInlineBlockersSnapshot(of)) {
			const key = existing.filePath;
			if (
				confirmedAtWriteOrder !== undefined &&
				existing.writeOrder !== undefined &&
				confirmedAtWriteOrder <= existing.writeOrder
			)
				continue;
			const diagnostics = existing.diagnostics;
			if (!diagnostics) continue;
			const kept = diagnostics.filter(
				(row) =>
					!(isCrossFileBlocker(row, existing.filePath) && shouldRetire(row)),
			);
			if (kept.length === diagnostics.length) continue;
			changed.push({
				filePath: existing.filePath,
				owner: existing.session ?? this._telemetrySessionId,
			});
			incrementDegradationCount({
				kind: "cross-file-row-retired",
				subject: normalizeMapKey(existing.filePath),
				reason:
					why === "cited-file-clean"
						? "a row naming another file left the record: that file was dispatched and its runner reported nothing on it (#5020)"
						: "a row naming another file left the record: that file no longer exists (#5020)",
			});
			if (kept.length === 0) {
				if (why === "cited-file-clean")
					this.noteResolvedBlockerFile(existing, undefined, true);
				this._pendingInlineBlockers.delete(key);
			} else {
				this._pendingInlineBlockers.set(key, narrowedRecord(existing, kept));
			}
		}
		return changed;
	}

	/**
	 * #5020: the rows whose cited file is gone, for the two reads the commit gate
	 * depends on (the turn end and the gate's own evaluation). Only an ABSOLUTE
	 * cite is judged: a relative one is relative to whatever the runner ran in,
	 * which the record does not keep, so a row that cannot be placed stays
	 * (fail closed) rather than being resolved against a guess.
	 *
	 * Both reads persist what they retire into the caller's own cwd cache, and
	 * each caller retires only its OWN session's records (`of`, required): the
	 * acting session's own records, whose cache is the coordinator root's cache
	 * or the session cwd's, whichever wrote them. A sweep by another session at
	 * another cwd would write the wrong project's cache and leave the owner's
	 * record refusing its next commit (PR #5033 round 3, F1 and item 4).
	 * Another session's dead cite is that session's own turn end or commit gate
	 * to retire.
	 */
	retireForeignRowsOfMissingFiles(of: {
		sessionId: string | undefined;
	}): Array<{
		filePath: string;
		owner: string | undefined;
	}> {
		return this.retireForeignRows(
			"cited-file-missing",
			(row) => path.isAbsolute(row.filePath) && !fs.existsSync(row.filePath),
			undefined,
			of,
		);
	}

	/**
	 * #3218 criterion 2: a retirement no turn_end has delivered yet. The
	 * read-only turn_end path uses it to fall through to the composer instead of
	 * returning early, so a `lens_diagnostics` confirmation reaches the agent.
	 */
	hasResolvedBlockerFiles(): boolean {
		return this._resolvedBlockerFilesThisTurn.size > 0;
	}

	/**
	 * #3218 criterion 2: hand the turn-end composer the retired files it can
	 * deliver, and remove exactly those, so a retire is delivered once. An entry
	 * `holdBack` names STAYS for the next turn_end: the composer holds back a
	 * file its own message still lists as unresolved (a retire that landed after
	 * the blockers were snapshotted), because one message must never say both,
	 * and a line that would not fit the message cap (called in list order).
	 * The "… and N more" overflow count rides with a batch that lists files and
	 * is otherwise kept, so a bare tail is never delivered.
	 *
	 * #4921: `of` names the consuming turn session; another session's note
	 * stays for that session's turn end, unseen by `holdBack`.
	 */
	consumeResolvedBlockerFiles(
		holdBack: (entry: ResolvedBlockerFile) => boolean,
		of?: { sessionId: string | undefined },
	): {
		files: ResolvedBlockerFile[];
		dropped: number;
	} {
		const files: ResolvedBlockerFile[] = [];
		const held: ResolvedBlockerFile[] = [];
		for (const entry of this._resolvedBlockerFilesThisTurn.values()) {
			if (of && !this.ownedBy(entry, of.sessionId)) held.push(entry);
			else (holdBack(entry) ? held : files).push(entry);
		}
		// Rebuild, never delete-in-place (see `reconcileInlineBlockers`).
		this._resolvedBlockerFilesThisTurn.clear();
		for (const entry of held) {
			this._resolvedBlockerFilesThisTurn.set(entry.filePath, entry);
		}
		if (files.length === 0) return { files, dropped: 0 };
		const dropped = this._resolvedBlockerFilesDropped;
		this._resolvedBlockerFilesDropped = 0;
		return { files, dropped };
	}

	reconcileInlineBlockers(): void {
		// Rebuild, never delete-in-place: `PathKeyedMap.delete()` re-normalizes
		// the key, and `normalizeMapKey` realpaths a live file but lowercases
		// the tail of a deleted one — so on Windows a mixed-case filename gets
		// a DIFFERENT delete-time key than its set-time key and the delete
		// misses (#1245, verified live: `MyCase.ts` survived reconcile).
		// Existence-checking the display path and rebuilding survivors avoids
		// the key-mismatch entirely; live survivors re-set to identical keys
		// (both realpath), so only the stale entries are dropped.
		const survivors: Array<[string, InlineBlockerRecord]> = [];
		for (const [displayPath, value] of this._pendingInlineBlockers.entries()) {
			if (fs.existsSync(displayPath)) survivors.push([displayPath, value]);
		}
		if (survivors.length !== this._pendingInlineBlockers.size) {
			this._pendingInlineBlockers.clear();
			for (const [displayPath, value] of survivors) {
				this._pendingInlineBlockers.set(displayPath, value);
			}
		}
	}

	/**
	 * Stale-entry reconcile (#1245): a blocker recorded for a file that has
	 * since been deleted can never be cleared — `clearInlineBlockers` fires
	 * only on a LATER dispatch of the same path, which a deleted file never
	 * gets. Every read of the blocker map (turn_end injection, git-guard
	 * size/summary, `syncGitGuardRecord`) therefore drops entries whose file no
	 * longer exists on disk: a blocker for a deleted file is stale by
	 * definition (the agent cannot fix it), so it must not re-surface every
	 * turn or gate a commit. The map is tiny (per-turn blockers) and reads are
	 * bounded (once per turn_end / tool_result), so the probe cost is
	 * negligible.
	 *
	 * #4921: `of` names a turn session, and the snapshot holds only that
	 * session's records: what its turn end may deliver, sweep or re-judge.
	 * Omitted, every record: the commit gate's view, which answers for the
	 * tree whichever session wrote the blocker.
	 */
	getInlineBlockersSnapshot(of?: {
		sessionId: string | undefined;
	}): InlineBlockerRecord[] {
		this.reconcileInlineBlockers();
		const records = [...this._pendingInlineBlockers.values()];
		return of
			? records.filter((entry) => this.ownedBy(entry, of.sessionId))
			: records;
	}

	consumeInlineBlockers(): InlineBlockerRecord[] {
		const entries = this.getInlineBlockersSnapshot();
		this._pendingInlineBlockers.clear();
		return entries;
	}

	/**
	 * #3613: the partition a per-turn record of `sessionId`'s turn lives in,
	 * the rule {@link beginTurn} applies too: a turn with no session id of its
	 * own is this coordinator's.
	 */
	private turnSession(sessionId: string | undefined): string {
		return sessionId ?? this._telemetrySessionId;
	}

	/**
	 * The cell holding `sessionId`'s turn's warnings. The coordinator's own turn
	 * is its scope's; a concurrent session's is found by id. `create` builds it
	 * on first write; without it a missing cell is `undefined`.
	 */
	private turnWarnings(
		sessionId: string | undefined,
		create: boolean,
	): TurnWarningsCell | undefined {
		const turnSession = this.turnSession(sessionId);
		const init = create ? newTurnWarningsCell : undefined;
		return turnSession === this._telemetrySessionId
			? scopeCell<TurnWarningsCell>(this._scope, TURN_WARNINGS_CELL, init)
			: sessionCell<TurnWarningsCell>(turnSession, TURN_WARNINGS_CELL, init);
	}

	/** Drain both warning maps of `turnSession`; other sessions' cells are theirs. */
	private clearTurnWarnings(turnSession: string): void {
		const cell = this.turnWarnings(turnSession, false);
		cell?.actionable.clear();
		cell?.codeQuality.clear();
	}

	recordActionableWarnings(
		warnings: ActionableWarningRecord[],
		sessionId?: string,
	): void {
		const cell = this.turnWarnings(sessionId, true);
		if (cell) for (const item of warnings) cell.actionable.set(item.id, item);
	}

	peekActionableWarnings(sessionId?: string): ActionableWarningRecord[] {
		return [
			...(this.turnWarnings(sessionId, false)?.actionable.values() ?? []),
		];
	}

	clearActionableWarnings(sessionId?: string): void {
		this.turnWarnings(sessionId, false)?.actionable.clear();
	}

	recordCodeQualityWarnings(
		warnings: CodeQualityWarningRecord[],
		sessionId?: string,
	): void {
		const cell = this.turnWarnings(sessionId, true);
		if (cell) for (const item of warnings) cell.codeQuality.set(item.id, item);
	}

	peekCodeQualityWarnings(sessionId?: string): CodeQualityWarningRecord[] {
		return [
			...(this.turnWarnings(sessionId, false)?.codeQuality.values() ?? []),
		];
	}

	clearCodeQualityWarnings(sessionId?: string): void {
		this.turnWarnings(sessionId, false)?.codeQuality.clear();
	}

	/**
	 * #3613 F2: the key a per-turn cap (the observed-mutation budget, a
	 * bounded-telemetry `capPerTurn`) uses for the current turn of `sessionId`.
	 * This coordinator's own turn is its turn index, as before; a concurrent
	 * session's turn is the key its own turn start drew, so each of its turns
	 * re-arms and no two sessions' turns share a cap.
	 */
	turnKey(sessionId?: string): number {
		const turnSession = this.turnSession(sessionId);
		if (turnSession === this._telemetrySessionId) return this._turnIndex;
		return this._foreignTurnKeys.get(turnSession) ?? this._turnIndex;
	}

	/**
	 * #3613 G2: whether `key` is a live turn key: this coordinator's current
	 * turn, or a live concurrent session's current one.
	 */
	isLiveTurnKey(key: number): boolean {
		if (key === this._turnIndex) return true;
		for (const live of this._foreignTurnKeys.values())
			if (live === key) return true;
		return false;
	}

	/**
	 * #3613: a concurrent session's per-turn records end with its session, so
	 * a subagent that shuts down before its turn end leaves no partition
	 * behind. This coordinator's own records are reset by `resetForSession`.
	 */
	forgetTurnSession(sessionId: string | undefined): void {
		const turnSession = this.turnSession(sessionId);
		if (turnSession === this._telemetrySessionId) return;
		this._foreignTurnKeys.delete(turnSession);
		this._foreignReadGuards.get(turnSession)?.releaseFileTime();
		this._foreignReadGuards.delete(turnSession);
		this.clearTurnWarnings(turnSession);
	}

	/** #484: the per-run diagnostics/autofix/format collector (accumulates
	 * across turns; consumed once at the agent_settled quiet window). Always
	 * present; callers gate recording behind the `lens-turn-summary` opt-in
	 * flag. */
	get turnSummary(): TurnSummaryCollector {
		return this._turnSummary;
	}

	get complexityBaselines(): Set<string> {
		return this._complexityBaselines;
	}

	get fixedThisTurn(): PathSetLike {
		// Self-referencing local so chained add() returns the same facade
		// instead of re-entering this getter and allocating a new one per call
		// (sonar S7725).
		const facade: PathSetLike = {
			add: (filePath) => {
				this._fixedThisTurn.set(filePath, true);
				return facade;
			},
			has: (filePath) => this._fixedThisTurn.has(filePath),
			delete: (filePath) => this._fixedThisTurn.delete(filePath),
			clear: () => this._fixedThisTurn.clear(),
		};
		return facade;
	}

	get projectRulesScan(): RuleScanResult {
		return this._projectRulesScan;
	}

	set projectRulesScan(value: RuleScanResult) {
		this._projectRulesScan = value;
	}

	get readGuard(): ReadGuard {
		this._readGuard ??= new ReadGuard(
			this._telemetrySessionId,
			{},
			this._scope,
		);
		return this._readGuard;
	}

	/**
	 * #4942: the read guard of `sessionId`'s turn, so an edit is judged by the
	 * reads of the session that edits. The owner is the one `recordSession`
	 * names for the inline blockers (#4921): a turn with no session id of its
	 * own is the coordinator's, whose guard is {@link readGuard}; a concurrent
	 * in-process secondary's is its own, built on first use.
	 */
	readGuardFor(sessionId: string | undefined): ReadGuard {
		const owner = this.recordSession(sessionId).session;
		if (owner === undefined) return this.readGuard;
		let guard = this._foreignReadGuards.get(owner);
		if (guard === undefined) {
			guard = new ReadGuard(owner, {}, this._scope);
			this._foreignReadGuards.set(owner, guard);
		}
		return guard;
	}

	/**
	 * Record the canonical target `tool_call` resolved for `toolCallId`
	 * (#1642). The paired `tool_result` claims this exactly once via
	 * {@link takeToolCallAttribution} instead of re-deriving a path from its
	 * own diff metadata.
	 */
	recordToolCallAttribution(
		toolCallId: string,
		attribution: Omit<ToolCallAttribution, "recordedAt">,
	): void {
		this._toolCallAttributions.set(toolCallId, {
			...attribution,
			recordedAt: Date.now(),
		});
	}

	/** #3555: note the widening the tool_call applied to this read. */
	recordReadWidening(toolCallId: string, widening: ReadWidening): void {
		this._readWidenings.set(toolCallId, widening);
	}

	/** #3555: one-shot claim of a read's widening, as with an attribution. */
	takeReadWidening(toolCallId: string): ReadWidening | undefined {
		const widening = this._readWidenings.get(toolCallId);
		this._readWidenings.delete(toolCallId);
		return widening;
	}

	/** #3523: see {@link ToolCallAttribution.editInPlace}. */
	markToolCallEditInPlace(toolCallId: string): void {
		const attribution = this._toolCallAttributions.get(toolCallId);
		if (attribution) attribution.editInPlace = true;
	}

	/** #3525: see {@link ToolCallAttribution.fileTimeStale}. */
	markToolCallFileTimeStale(toolCallId: string): void {
		const attribution = this._toolCallAttributions.get(toolCallId);
		if (attribution) attribution.fileTimeStale = true;
	}

	/** #5120: see {@link ToolCallAttribution.partialApply}. */
	markToolCallPartialApply(
		toolCallId: string,
		pending: PartialApplyPending,
	): void {
		const attribution = this._toolCallAttributions.get(toolCallId);
		if (attribution) attribution.partialApply = pending;
	}

	/**
	 * #5120: one-shot claim of a call's partial apply. It leaves the rest of the
	 * attribution for {@link takeToolCallAttribution}. pi's call ids are unique
	 * per call; a write, edit or read that reused one would record a new
	 * attribution at its `tool_call` and drop this.
	 */
	takeToolCallPartialApply(
		toolCallId: string,
	): PartialApplyPending | undefined {
		const attribution = this._toolCallAttributions.get(toolCallId);
		const pending = attribution?.partialApply;
		if (attribution) delete attribution.partialApply;
		return pending;
	}

	/**
	 * One-shot claim of a previously recorded tool-call attribution. Removed
	 * on read: a given `tool_call`/`tool_result` pair correlates exactly once,
	 * and leaving it behind would let a later, unrelated `tool_result` that
	 * happens to reuse a stale id inherit a stranger's resolved path.
	 *
	 * An expired entry (older than `TOOL_CALL_ATTRIBUTION_TTL_MS`) is treated
	 * as a miss and removed rather than returned — see the constant's doc.
	 */
	takeToolCallAttribution(toolCallId: string): ToolCallAttribution | undefined {
		const attribution = this._toolCallAttributions.get(toolCallId);
		if (attribution === undefined) return undefined;
		this._toolCallAttributions.delete(toolCallId);
		if (Date.now() - attribution.recordedAt > TOOL_CALL_ATTRIBUTION_TTL_MS) {
			return undefined;
		}
		return attribution;
	}

	/**
	 * Queue one mutation kind for `filePath` at `agent_end`. Returns `true`
	 * when this call created a pending entry or added a new kind, and `false`
	 * for a same-kind re-touch. Callers publish each kind's first transition
	 * without spamming repeated edits before `agent_end`.
	 */
	deferMutation(
		filePath: string,
		cwd: string,
		/** Host tool name; any mutating tool, not just `write`/`edit` (#2423). */
		toolName: string,
		turnStateCwd: string,
		kind: DeferredMutationKind,
		ownerSessionId?: string,
		originCwd?: string,
		/** #3521: a producer that awaited since it captured the epoch passes it. */
		readGuardBranchEpoch = this.readGuard.currentBranchEpoch,
		analysisRootMode: AnalysisRootMode = "session",
	): boolean {
		if (!canWriteAnalysisRoot(analysisRootMode)) return false;
		const key = realpathOrResolve(filePath);
		const now = Date.now();
		const resolvedOriginCwd = originCwd ?? turnStateCwd;
		const existing = this._pendingDeferredMutations.get(key);
		if (existing) {
			existing.readGuardBranchEpoch = Math.max(
				existing.readGuardBranchEpoch,
				readGuardBranchEpoch,
			);
			const addedKind = !existing.kinds.has(kind);
			existing.lastTouchedAt = now;
			existing.cwd = cwd;
			existing.turnStateCwd = turnStateCwd;
			existing.toolNames.add(toolName);
			existing.kinds.add(kind);
			existing.queuedTurnIndex = this._turnIndex;
			existing.queuedTurnId = `${this._telemetrySessionId}:${this._turnIndex}`;
			existing.ownerSessionId = ownerSessionId;
			existing.originCwd = resolvedOriginCwd;
			return addedKind;
		}
		this._pendingDeferredMutations.set(key, {
			filePath: key,
			cwd,
			turnStateCwd,
			firstTouchedAt: now,
			lastTouchedAt: now,
			toolNames: new Set([toolName]),
			kinds: new Set([kind]),
			queuedTurnIndex: this._turnIndex,
			queuedTurnId: `${this._telemetrySessionId}:${this._turnIndex}`,
			ownerSessionId,
			originCwd: resolvedOriginCwd,
			readGuardBranchEpoch,
		});
		return true;
	}

	deferFormat(
		filePath: string,
		cwd: string,
		/** Host tool name; any mutating tool, not just `write`/`edit` (#2423). */
		toolName: string,
		turnStateCwd: string,
		ownerSessionId?: string,
		originCwd?: string,
		analysisRootMode: AnalysisRootMode = "session",
	): boolean {
		return this.deferMutation(
			filePath,
			cwd,
			toolName,
			turnStateCwd,
			"format",
			ownerSessionId,
			originCwd,
			undefined,
			analysisRootMode,
		);
	}

	/** Return the ownership identity of a queued format record for bus events. */
	deferredFormatIdentity(filePath: string):
		| {
				ownerSessionId: string | undefined;
				turnIndex: number;
				batchId: string;
		  }
		| undefined {
		const record = this._pendingDeferredMutations.get(filePath);
		if (!record || !record.kinds.has("format")) return undefined;
		return {
			ownerSessionId: record.ownerSessionId,
			turnIndex: record.queuedTurnIndex,
			batchId: record.queuedTurnId,
		};
	}

	get pendingDeferredFormatCount(): number {
		return this._pendingDeferredMutations.size;
	}

	get pendingDeferredMutationCount(): number {
		return this._pendingDeferredMutations.size;
	}

	/**
	 * Legacy unconditional drain — still exposed for any caller that
	 * genuinely wants "everything, no ownership check" (and for tests). New
	 * flush call sites should prefer {@link claimDeferredFormatFiles}.
	 */
	consumeDeferredFormatFiles(): DeferredFormatRecord[] {
		const records = [...this._pendingDeferredMutations.values()];
		this._pendingDeferredMutations.clear();
		return records;
	}

	/**
	 * Ownership-filtered drain (#791). Claims and removes only the records
	 * this flush is entitled to:
	 *  - `ownerSessionId` unset on the record, OR `currentSessionId` unset, OR
	 *    they match → claimed as "same session" (the common case, and the
	 *    fail-safe default when either side lacks a stable session id).
	 *  - otherwise (both known, and they differ) the record belongs to a
	 *    DIFFERENT session (e.g. a concurrent in-process secondary/subagent)
	 *    and is left queued for its owner's own flush — UNLESS it has sat
	 *    unclaimed longer than `staleAfterMs` (the owner presumably died), in
	 *    which case this flush claims it as an orphan-recovery fallback ONLY
	 *    when `currentOriginCwd` (this flush's own workspace/worktree) exactly
	 *    matches the record's `originCwd` (the cwd it was actually queued
	 *    under, #1642 F3 — NOT `turnStateCwd`, which is always the workspace
	 *    root by design and so would match every session unconditionally). A
	 *    mismatch means the record belongs to a DIFFERENT checkout/worktree
	 *    than the one now running `agent_end` — claiming it across that
	 *    boundary is exactly how a worktree's queued edit got formatted onto
	 *    the parent checkout in the reported incident. It is left queued
	 *    (NOT deleted) and logged instead: a legitimate crashed-session
	 *    orphan from, say, a monorepo subdir must still be claimable later by
	 *    a flush whose origin actually matches, or stay visible for
	 *    observability — deleting it here would drop it forever with no
	 *    origin ever able to reclaim it.
	 *
	 * `ownedOnly` is a concurrent secondary's drain (#4943): it claims exactly
	 * the records its own known session id owns. An ownerless record, another
	 * session's and a stale orphan are all left for the primary, so a
	 * secondary with no stable id claims nothing.
	 *
	 * Returns the claimed records, the left-queued mismatched-origin records,
	 * and per-skipped record why it was left behind — callers use this for
	 * `agent_end`'s latency-log provenance and for the "stale fallback
	 * fired"/"orphan mismatch" log lines.
	 */
	claimDeferredFormatFiles(
		currentSessionId: string | undefined,
		now: number,
		staleAfterMs: number,
		currentOriginCwd?: string,
		ownedOnly = false,
	): {
		claimed: DeferredFormatRecord[];
		staleClaimed: DeferredFormatRecord[];
		deferredToOwner: DeferredFormatRecord[];
		droppedOrphans: DeferredFormatRecord[];
	} {
		const claimed: DeferredFormatRecord[] = [];
		const staleClaimed: DeferredFormatRecord[] = [];
		const deferredToOwner: DeferredFormatRecord[] = [];
		const droppedOrphans: DeferredFormatRecord[] = [];
		for (const [key, record] of this._pendingDeferredMutations) {
			const sameSession = ownedOnly
				? currentSessionId !== undefined &&
					record.ownerSessionId === currentSessionId
				: record.ownerSessionId === undefined ||
					currentSessionId === undefined ||
					record.ownerSessionId === currentSessionId;
			if (sameSession) {
				claimed.push(record);
				this._pendingDeferredMutations.delete(key);
				continue;
			}
			if (ownedOnly) {
				deferredToOwner.push(record);
				continue;
			}
			const age = now - record.lastTouchedAt;
			if (age > staleAfterMs) {
				// #1642 F3: origin identity is required before an orphan-recovery
				// claim, not just staleness. `currentOriginCwd === undefined`
				// means the caller can't state its own origin — fail-safe as
				// "can't prove different" (same posture as the sameSession check
				// above), not as a free pass to claim across a KNOWN mismatch.
				const originMatches =
					currentOriginCwd === undefined ||
					pathsEqual(record.originCwd, currentOriginCwd);
				if (originMatches) {
					this._pendingDeferredMutations.delete(key);
					staleClaimed.push(record);
				} else {
					// Left queued — see the doc above for why this must not be
					// deleted. Reported once per claim attempt; a genuinely
					// abandoned origin will keep surfacing here, which is the
					// intended, safer trade-off over silent, permanent loss.
					droppedOrphans.push(record);
				}
				continue;
			}
			deferredToOwner.push(record);
		}
		return { claimed, staleClaimed, deferredToOwner, droppedOrphans };
	}

	/** Return claimed records that were never started by an aborted drain. */
	requeueDeferredFormatFiles(records: DeferredFormatRecord[]): void {
		for (const record of records) {
			const key = record.filePath;
			const existing = this._pendingDeferredMutations.get(key);
			if (existing) {
				for (const kind of record.kinds) existing.kinds.add(kind);
				for (const toolName of record.toolNames)
					existing.toolNames.add(toolName);
				existing.readGuardBranchEpoch = Math.max(
					existing.readGuardBranchEpoch,
					record.readGuardBranchEpoch,
				);
				continue;
			}
			this._pendingDeferredMutations.set(key, {
				...record,
				kinds: new Set(record.kinds),
				toolNames: new Set(record.toolNames),
			});
		}
	}

	claimDeferredMutations(
		currentSessionId: string | undefined,
		now: number,
		staleAfterMs: number,
		currentOriginCwd?: string,
		ownedOnly = false,
	) {
		return this.claimDeferredFormatFiles(
			currentSessionId,
			now,
			staleAfterMs,
			currentOriginCwd,
			ownedOnly,
		);
	}

	requeueDeferredMutations(records: DeferredMutationRecord[]): void {
		this.requeueDeferredFormatFiles(records);
	}

	shouldWarmLspOnRead(filePath: string, maxAgeMs = 120_000): boolean {
		const state = this._lspReadWarmState.get(path.resolve(filePath));
		if (!state) return true;
		if (state.status === "warming") return false;
		return Date.now() - state.ts > maxAgeMs;
	}

	markLspReadWarmStarted(filePath: string): void {
		this._lspReadWarmState.set(path.resolve(filePath), {
			status: "warming",
			ts: Date.now(),
		});
	}

	markLspReadWarmCompleted(filePath: string): void {
		this._lspReadWarmState.set(path.resolve(filePath), {
			status: "ready",
			ts: Date.now(),
		});
	}

	clearLspReadWarmState(filePath: string): void {
		this._lspReadWarmState.delete(path.resolve(filePath));
	}
}

/**
 * Read the live model identity off a pi extension context (#1655 item 2).
 *
 * `ExtensionContext.model` is `AgentSession.model`, projected through a lazy
 * getter guarded by `assertActive()`
 * (`@earendil-works/pi-coding-agent/dist/core/extensions/runner.js:488-491`;
 * `dist/core/agent-session.js:580-582`). The value is a `Model` with `id` and
 * `provider` (`@earendil-works/pi-ai/dist/types.d.ts:661-667`), or `undefined`
 * when no model is selected.
 *
 * Because the getter is lazy and guarded, reading it on a REPLACED runner
 * throws. Telemetry identity is advisory; a stale ctx must degrade to "no
 * identity", never take down the event handler that happened to carry it.
 */
export function readHostModelIdentity(ctx: unknown): {
	model?: string;
	provider?: string;
} {
	try {
		const model = (
			ctx as { model?: { id?: unknown; provider?: unknown } } | null
		)?.model;
		return {
			model: typeof model?.id === "string" ? model.id : undefined,
			provider:
				typeof model?.provider === "string" ? model.provider : undefined,
		};
	} catch {
		return {};
	}
}
