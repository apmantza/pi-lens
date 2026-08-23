import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ActionableWarningRecord } from "./actionable-warnings.js";
import type { FunctionCallGraph } from "./call-graph.js";
import type { WordIndex } from "./word-index.js";
import type { CascadeRun } from "./cascade-types.js";
import { logCascade } from "./cascade-logger.js";
import {
	appendProjectChange,
	type ProjectChangeRange,
	type ProjectChangeSource,
} from "./project-changes.js";
import type { CodeQualityWarningRecord } from "./code-quality-warnings.js";
import type { FileComplexity } from "./complexity-client.js";
import { normalizeMapKey, pathsEqual } from "./path-utils.js";
import { PathKeyedMap } from "./path-keyed-map.js";
import { BoundedLruCache } from "./bounded-cache.js";
import { ReadGuard } from "./read-guard.js";
import type { RuleScanResult } from "./rules-scanner.js";
import { RUNTIME_CONFIG } from "./runtime-config.js";
import { TurnSummaryCollector } from "./turn-summary.js";
import { deriveProviderFromModelId } from "./model-provider.js";

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
	toolNames: Set<"write" | "edit">;
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
	 * #1631: wall-clock ms when the verdict was recorded. Baseline for the
	 * turn-boundary freshness sweep, which compares the file's and its forward
	 * imports' on-disk mtime against it. Unstamped (legacy) records are left
	 * untouched by the sweep.
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
	 */
	staleReason?: "dependency-drift" | "past-eof";
	/**
	 * #1641: the 1-based cited lines of the diagnostics behind `summary`,
	 * captured at write time (`dispatchResult.blockers[].line` in
	 * `pipeline.ts`) rather than re-parsed from the rendered text — see
	 * `PipelineResult.inlineBlockerLines`'s doc comment for why. Empty/absent
	 * when no blocker in this record cited a line.
	 */
	lines?: readonly number[];
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
	/** `Date.now()` when recorded — see `TOOL_CALL_ATTRIBUTION_TTL_MS`. */
	recordedAt: number;
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

export class RuntimeCoordinator {
	private _projectRoot = normalizeMapKey(process.cwd());
	private _sessionGeneration = 0;
	private _sessionStartedAt = Date.now();
	private _errorDebtBaseline: ErrorDebtBaseline | null = null;
	private _pipelineCrashCounts = new Map<string, number>();
	private _cachedExports = new Map<string, string>();
	private _startupScansInFlight = new Map<string, number>();
	private _cascadeRuns: CascadeRun[] = [];
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
	private _complexityBaselines = new Map<string, FileComplexity>();
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
	private _telemetrySessionId = `lens-${Date.now().toString(36)}`;
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
	private _writeIndex = 0;
	private _projectSeq = 0;
	private _turnStartProjectSeq = 0;
	private readonly _fileSeq = new Map<string, number>();
	// File key → the projectSeq value at that file's most recent bump (#451). Lets
	// the review-graph builder ask "which files changed since I last built?" and
	// skip its per-build O(project) walk+stat sweep when only pi-observed edits
	// occurred. Keyed identically to _fileSeq (normalizeMapKey + path.resolve).
	private readonly _fileLastProjectSeq = new Map<string, number>();
	private _gitGuardHasBlockers = false;
	private _gitGuardSummary = "";
	private _gitGuardCacheUnknownReason: string | undefined;
	callGraph: FunctionCallGraph | null = null;
	wordIndex: WordIndex | null = null;
	private _readGuard: ReadGuard | null = null;
	private readonly _pendingDeferredMutations =
		new PathKeyedMap<DeferredMutationRecord>(normalizeMapKey);
	/** tool_call → tool_result path-attribution correlation (#1642). */
	private readonly _toolCallAttributions = new BoundedLruCache<
		string,
		ToolCallAttribution
	>(TOOL_CALL_ATTRIBUTION_CAPACITY);
	private readonly _lspReadWarmState = new Map<
		string,
		{ status: "warming" | "ready"; ts: number }
	>();
	private readonly _pendingInlineBlockers =
		new PathKeyedMap<InlineBlockerRecord>(normalizeMapKey);
	private readonly _actionableWarningsThisTurn = new Map<
		string,
		ActionableWarningRecord
	>();
	private readonly _codeQualityWarningsThisTurn = new Map<
		string,
		CodeQualityWarningRecord
	>();
	// #484: opt-in per-RUN summary of diagnostics/autofixes/formats,
	// accumulated across the run's turns and consumed once at the
	// agent_settled quiet window. The collector itself is always constructed
	// (cheap, empty Map) but callers gate recording behind the
	// `lens-turn-summary` flag so it's a true no-op when the feature is off.
	private readonly _turnSummary = new TurnSummaryCollector();

	resetForSession(startedAt = Date.now()): void {
		this._sessionGeneration += 1;
		this._sessionStartedAt = startedAt;
		this._complexityBaselines.clear();
		this._pipelineCrashCounts.clear();
		this._cachedExports.clear();
		this.wordIndex = null;
		this._startupScansInFlight.clear();
		this._cascadeRuns = [];
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
		this._telemetrySessionId = `lens-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
		this._hasStableSessionId = false;
		this._telemetryModel = "unknown";
		this._telemetryModelId = "";
		this._telemetryProvider = "";
		this._telemetryProviderIsExplicit = false;
		this._turnIndex = 0;
		this._writeIndex = 0;
		this._projectSeq = 0;
		this._turnStartProjectSeq = 0;
		this._fileSeq.clear();
		this._fileLastProjectSeq.clear();
		this._gitGuardHasBlockers = false;
		this._gitGuardSummary = "";
		this._gitGuardCacheUnknownReason = undefined;
		this._readGuard = null;
		this._pendingDeferredMutations.clear();
		// #1642 F5: every sibling correlation/state map is cleared here. A
		// per-session-numbered host reusing tool-call ids across sessions must
		// not let a NEW session inherit a DEAD session's recorded skip verdict.
		this._toolCallAttributions.clear();
		this._lspReadWarmState.clear();
		this._pendingInlineBlockers.clear();
		this._actionableWarningsThisTurn.clear();
		this._codeQualityWarningsThisTurn.clear();
		this._turnSummary.clear();
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

	updateGitGuardStatus(hasBlockers: boolean, output: string): void {
		// The status is an aggregate over the current per-file map. A clean B
		// result must not erase an unresolved A result; the pipeline records/clears
		// the edited file immediately before this method runs.
		this._gitGuardHasBlockers =
			hasBlockers || this.getInlineBlockersSnapshot().length > 0;
		if (!this._gitGuardHasBlockers) {
			this._gitGuardSummary = "";
			return;
		}
		const firstLine = output
			.split("\n")
			.map((line) => line.trim())
			.find((line) => line.length > 0);
		const summaries = this.getInlineBlockersSnapshot()
			.map((entry) => entry.summary.trim())
			.filter(Boolean);
		this._gitGuardSummary = (
			summaries[0] ??
			firstLine ??
			"Unresolved blockers detected"
		).slice(0, 160);
	}

	get gitGuardHasBlockers(): boolean {
		return this._gitGuardHasBlockers;
	}

	get gitGuardSummary(): string {
		return this._gitGuardSummary;
	}

	markGitGuardCacheUnknown(reason: string): void {
		this._gitGuardCacheUnknownReason = reason;
	}

	clearGitGuardCacheUnknown(): void {
		this._gitGuardCacheUnknownReason = undefined;
	}

	get gitGuardCacheUnknownReason(): string | undefined {
		return this._gitGuardCacheUnknownReason;
	}

	beginTurn(): void {
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
		this._actionableWarningsThisTurn.clear();
		this._codeQualityWarningsThisTurn.clear();
		// _turnSummary is deliberately NOT cleared here (#484 rework): the
		// summary entry is emitted once per RUN at the agent_settled quiet
		// window (sendMessage during a live stream would STEER the agent, and
		// turn_end can fire mid-stream), so the collector must accumulate
		// across the run's turns. It is cleared only by consume() at emit and
		// by resetForSession().
		this._turnStartProjectSeq = this._projectSeq;
		this._turnIndex += 1;
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
		onAppendError?: (err: unknown) => void;
	}): { projectSeq: number; fileSeq: number } {
		const { projectSeq, fileSeq, key } = this.bumpFileSeq(args.filePath);
		if (this._mutationReceipts.length >= MAX_MUTATION_RECEIPTS) {
			this._mutationReceipts.shift();
			this._droppedMutationReceipts += 1;
		}
		this._mutationReceipts.push({
			seq: projectSeq,
			// Reuse the bump's normalized key (~200us realpath on Windows) —
			// never re-derive it here.
			filePath: key,
			source: args.source,
			turnIndex: this._turnIndex,
			ts: Date.now(),
		});
		if (args.cwd !== undefined) {
			try {
				appendProjectChange(args.cwd, {
					seq: projectSeq,
					timestamp: new Date().toISOString(),
					sessionId: this.telemetrySessionId,
					turnIndex: this.turnIndex,
					source: args.source,
					filePath: path.resolve(args.filePath),
					fileSeq,
					changedRange: args.changedRange,
				});
			} catch (err) {
				args.onAppendError?.(err);
			}
		}
		return { projectSeq, fileSeq };
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

	/** Atomically records write/edit ordering before debounce can coalesce it. */
	recordMutationToolReceipt(
		filePath: string,
		toolName: "write" | "edit",
	): { autofixMode: "immediate" | "deferred" } {
		if (toolName === "write") {
			this._writtenThisTurn.set(filePath, true);
		} else if (this._writtenThisTurn.has(filePath)) {
			this._autofixDemotedThisTurn.set(filePath, true);
			// A later edit establishes a new final state that must be eligible for
			// the deferred pass even if the preceding write was fixed immediately.
			this._fixedThisTurn.delete(filePath);
		}
		return {
			autofixMode:
				toolName === "edit" || this._autofixDemotedThisTurn.has(filePath)
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

	setTelemetryIdentity(identity: {
		sessionId?: string;
		model?: string;
		provider?: string;
	}): void {
		if (identity.sessionId && identity.sessionId.trim()) {
			this._telemetrySessionId = identity.sessionId.trim();
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

	get projectSeq(): number {
		return this._projectSeq;
	}

	get turnStartProjectSeq(): number {
		return this._turnStartProjectSeq;
	}

	seedProjectSequence(
		projectSeq: number,
		fileSeqByPath?: Map<string, number>,
	): void {
		this._projectSeq = Math.max(0, Math.floor(projectSeq));
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

	bumpFileSeq(filePath: string): {
		projectSeq: number;
		fileSeq: number;
		/** The normalized key the bump was recorded under — reuse, never re-derive. */
		key: string;
	} {
		// normalizeMapKey costs ~200us/call on Windows (realpath); every caller
		// that also needs the key must reuse this one instead of paying it twice.
		const key = normalizeMapKey(path.resolve(filePath));
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
		return this._sessionGeneration;
	}

	isCurrentSession(generation: number): boolean {
		return this._sessionGeneration === generation;
	}

	markStartupScanInFlight(name: string, generation: number): void {
		this._startupScansInFlight.set(name, generation);
	}

	clearStartupScanInFlight(name: string, generation: number): void {
		const owner = this._startupScansInFlight.get(name);
		if (owner === generation) {
			this._startupScansInFlight.delete(name);
		}
	}

	isStartupScanInFlight(name: string): boolean {
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

	appendCascadePromise(p: Promise<CascadeRun>): void {
		this._pendingCascadeRuns.push(p);
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
		settleOptions: { trackTurnEndClock?: boolean } = {},
	): Promise<{ settled: number; timedOut: number }> {
		const pending = this._pendingCascadeRuns;
		if (pending.length === 0) return { settled: 0, timedOut: 0 };
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

			let settled = 0;
			let timedOut = 0;
			for (const entry of tracked) {
				if (entry.done && entry.run) {
					this.appendCascadeRun(entry.run);
					settled += 1;
				} else {
					this._pendingCascadeRuns.push(entry.promise);
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

	recordInlineBlockers(
		filePath: string,
		summary: string,
		writeIndex?: number,
		sources?: readonly string[],
		lines?: readonly number[],
	): void {
		this._pendingInlineBlockers.set(path.resolve(filePath), {
			filePath,
			summary,
			writeIndex,
			sources,
			lines,
			recordedAtMs: Date.now(),
			stale: false,
		});
	}

	clearInlineBlockers(filePath: string): void {
		this._pendingInlineBlockers.delete(path.resolve(filePath));
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
		const key = path.resolve(filePath);
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
		const key = path.resolve(filePath);
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
		if (deadLines.length === 0) return false;
		const key = path.resolve(filePath);
		const existing = this._pendingInlineBlockers.get(key);
		if (!existing) return false;
		// Only this gate's own demotion. A dependency-drift demotion (#1631)
		// keeps in-bounds coordinates the agent CAN re-run against, so it stays
		// in the store until a fresh verdict clears it.
		if (!existing.stale) return false;
		if ((existing.staleReason ?? "past-eof") !== "past-eof") return false;
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
	 * `nextWriteIndex()` counter, so when both sides are stamped the retire
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
	 * so `coveredSources` must be a SUPERSET of the recorded sources or the entry
	 * stands. This is a commit gate: a record whose provenance is unknown (no
	 * `sources`) fails CLOSED and is never retired, because "we don't know what
	 * raised this" must not resolve to "an LSP check can clear it".
	 *
	 * @returns true when an entry was retired — the caller logs it, so an
	 * eviction is never silent (#1432 Gap 1).
	 */
	retireInlineBlockerOnConfirmedClean(
		filePath: string,
		confirmedAtWriteIndex?: number,
		coveredSources?: readonly string[],
	): boolean {
		const key = path.resolve(filePath);
		const existing = this._pendingInlineBlockers.get(key);
		if (!existing) return false;
		if (
			existing.writeIndex !== undefined &&
			confirmedAtWriteIndex !== undefined &&
			confirmedAtWriteIndex <= existing.writeIndex
		) {
			return false;
		}
		// Fail closed on unknown provenance, and on any source the fresh verdict
		// did not consult. An eslint-origin blocker outliving an LSP-only clean is
		// the correct outcome — the next dispatch of that file is what clears it.
		if (!existing.sources || existing.sources.length === 0) return false;
		const covered = new Set(coveredSources ?? []);
		if (!existing.sources.every((source) => covered.has(source))) return false;
		this._pendingInlineBlockers.delete(key);
		return true;
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
	 */
	getInlineBlockersSnapshot(): InlineBlockerRecord[] {
		this.reconcileInlineBlockers();
		return [...this._pendingInlineBlockers.values()];
	}

	consumeInlineBlockers(): InlineBlockerRecord[] {
		const entries = this.getInlineBlockersSnapshot();
		this._pendingInlineBlockers.clear();
		return entries;
	}

	recordActionableWarnings(warnings: ActionableWarningRecord[]): void {
		for (const warning of warnings) {
			this._actionableWarningsThisTurn.set(warning.id, warning);
		}
	}

	peekActionableWarnings(): ActionableWarningRecord[] {
		return [...this._actionableWarningsThisTurn.values()];
	}

	clearActionableWarnings(): void {
		this._actionableWarningsThisTurn.clear();
	}

	recordCodeQualityWarnings(warnings: CodeQualityWarningRecord[]): void {
		for (const warning of warnings) {
			this._codeQualityWarningsThisTurn.set(warning.id, warning);
		}
	}

	peekCodeQualityWarnings(): CodeQualityWarningRecord[] {
		return [...this._codeQualityWarningsThisTurn.values()];
	}

	clearCodeQualityWarnings(): void {
		this._codeQualityWarningsThisTurn.clear();
	}

	/** #484: the per-run diagnostics/autofix/format collector (accumulates
	 * across turns; consumed once at the agent_settled quiet window). Always
	 * present; callers gate recording behind the `lens-turn-summary` opt-in
	 * flag. */
	get turnSummary(): TurnSummaryCollector {
		return this._turnSummary;
	}

	get complexityBaselines(): Map<string, FileComplexity> {
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
		this._readGuard ??= new ReadGuard(this._telemetrySessionId);
		return this._readGuard;
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
		toolName: "write" | "edit",
		turnStateCwd: string,
		kind: DeferredMutationKind,
		ownerSessionId?: string,
		originCwd?: string,
	): boolean {
		const key = path.resolve(filePath);
		const now = Date.now();
		const resolvedOriginCwd = originCwd ?? turnStateCwd;
		const existing = this._pendingDeferredMutations.get(key);
		if (existing) {
			const addedKind = !existing.kinds.has(kind);
			existing.lastTouchedAt = now;
			existing.cwd = cwd;
			existing.turnStateCwd = turnStateCwd;
			existing.toolNames.add(toolName);
			existing.kinds.add(kind);
			existing.queuedTurnIndex = this._turnIndex;
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
			ownerSessionId,
			originCwd: resolvedOriginCwd,
		});
		return true;
	}

	deferFormat(
		filePath: string,
		cwd: string,
		toolName: "write" | "edit",
		turnStateCwd: string,
		ownerSessionId?: string,
		originCwd?: string,
	): boolean {
		return this.deferMutation(
			filePath,
			cwd,
			toolName,
			turnStateCwd,
			"format",
			ownerSessionId,
			originCwd,
		);
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
			const sameSession =
				record.ownerSessionId === undefined ||
				currentSessionId === undefined ||
				record.ownerSessionId === currentSessionId;
			if (sameSession) {
				claimed.push(record);
				this._pendingDeferredMutations.delete(key);
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
			const key = path.resolve(record.filePath);
			const existing = this._pendingDeferredMutations.get(key);
			if (existing) {
				for (const kind of record.kinds) existing.kinds.add(kind);
				for (const toolName of record.toolNames)
					existing.toolNames.add(toolName);
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
	) {
		return this.claimDeferredFormatFiles(
			currentSessionId,
			now,
			staleAfterMs,
			currentOriginCwd,
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
