/**
 * Redesigned Dispatch Types for pi-lens
 *
 * Key insight: Different clients have different OUTPUT SEMANTICS:
 * - BLOCKING: Errors that stop the agent (architect, lsp errors)
 * - WARNING: Non-blocking issues (biome warnings, type-safety)
 * - FIXABLE: Issues with auto-fix available
 * - SILENT: Metrics tracked but not shown (complexity)
 * - INFORMATIONAL: Shown in session summary only
 *
 * The dispatcher must handle these semantics consistently.
 */

import type { GenerationHandle } from "../generation-guard.js";
import type { AnalysisRootMode } from "../analysis-root.js";
import type { ExtensionLogLevel } from "../extension-log.js";
import type { PrimaryUnavailableCause } from "../lsp/diagnostic-binding.js";
import type { FileKind } from "../file-kinds.js";
import type { FileRole } from "../file-role.js";
import type { GeneratedArtifactEvidence } from "../generated-artifacts.js";
import type { PiLensProjectConfig } from "../project-lens-config.js";
import type { RulePolicyMap } from "./rule-policy.js";
import type { DispatchLatencyReport } from "./dispatcher.js";

export type DefectClass =
	| "silent-error"
	| "injection"
	| "secrets"
	| "async-misuse"
	| "correctness"
	| "safety"
	| "style"
	| "unknown"
	| "unused-value";

export interface ModifiedRange {
	start: number;
	end: number;
}

/**
 * Whether a finding's 1-based line span `[startLine, endLine]` overlaps the
 * lines a write changed. A match anchors at its start line, so an edit inside
 * a multi-line match leaves the anchor unchanged; the whole span is what the
 * edit can have touched (#4481 r2). Absent or empty `ranges` mean the whole
 * file (a full-file dispatch, a fresh write).
 */
export function spanOverlapsModifiedRanges(
	startLine: number,
	endLine: number,
	ranges: ReadonlyArray<ModifiedRange> | undefined,
): boolean {
	if (!ranges || ranges.length === 0) return true;
	return ranges.some((r) => startLine <= r.end && endLine >= r.start);
}

// --- API Interface ---

export interface PiAgentAPI {
	getFlag(flag: string, filePath?: string): string | boolean | undefined;
}

// --- Output Semantics ---

/**
 * How to display and handle this output
 */
export type OutputSemantic =
	/** Hard stop - agent cannot continue until fixed */
	| "blocking"
	/** Soft stop - shown but agent can continue */
	| "warning"
	/** Auto-fix was applied */
	| "fixed"
	/** Shown in session summary only */
	| "silent"
	/** Not applicable / skipped */
	| "none";

export interface Diagnostic {
	/** Unique identifier for deduplication */
	id: string;
	/** Human-readable message */
	message: string;
	/** File path */
	filePath: string;
	/** Line number (1-based) */
	line?: number;
	/** Column (1-based) */
	column?: number;
	/** Severity level */
	severity: "error" | "warning" | "info" | "hint";
	/** Output semantic */
	semantic: OutputSemantic;
	/** Which tool produced this */
	tool: string;
	/** A tool-specific code for this diagnostic */
	code?: string;
	/** Rule/category */
	rule?: string;
	/** Normalized defect class for overlap arbitration */
	defectClass?: DefectClass;
	/** Whether some known fix path exists (tool/manual/pipeline) */
	fixable?: boolean;
	/** Whether the post-write pipeline can safely auto-fix this issue */
	autoFixAvailable?: boolean;
	/** How the fix is expected to be applied */
	fixKind?: "pipeline" | "manual" | "suggestion";
	/** Auto-fix command/suggestion */
	fixSuggestion?: string;
	/** Exact matched text from tree-sitter (more precise than the full source line) */
	matchedText?: string;
	/** Tree-sitter AST node type of the match (e.g. "call_expression", "template_string") */
	astNodeType?: string;
	/**
	 * #692: purely informational provenance label for a diagnostic reconciled
	 * from a project-wide SCAN path (e.g. `"lens_diagnostics_full"`,
	 * `"lsp_diagnostics"`) rather than the per-edit dispatch pipeline. This
	 * field must NEVER participate in identity, dedup, or suppression —
	 * `id`/`rule` always derive from the diagnostic's own real source (see
	 * `convertLspDiagnostics`'s `scanOrigin` option). Absent for per-edit
	 * diagnostics.
	 */
	scanOrigin?: string;
	/**
	 * #3218: the one-line rationale for a finding the delta-mode promotion seam
	 * (`promoteDeltaUnusedToBlockers`) raised from hint/advisory to `blocking`.
	 * Set only by that seam; the STOP renderers emit each distinct note once
	 * beneath the banner so the agent is told WHY a hint-severity finding
	 * blocks. Absent on every other diagnostic.
	 */
	promotionNote?: string;
	/**
	 * #4484 round 2: the dispatcher runner whose run produced this finding,
	 * stamped by `dispatchForFile`. A recorded blocker leaves the record only
	 * when a conclusive run of this runner no longer observes it. Never part of
	 * identity, dedup or suppression.
	 */
	runnerId?: string;
	/**
	 * #4484 round 2: the language server that published an LSP finding
	 * (`convertLspDiagnostics`), so a run that names the server unconfirmed
	 * keeps that server's recorded blockers. Never part of identity.
	 */
	serverId?: string;
	/**
	 * #4484 round 5: the content hash (`lineContentHash`, as a number) of this
	 * finding's own line in the bytes it was observed in, stamped when it
	 * enters the inline-blocker record (`stampLineHashes`). A write with no
	 * usable position matches a recorded blocker only on a line with this
	 * text. Never part of identity, dedup or suppression.
	 */
	lineHash?: number;
	/**
	 * #4509 (N3): a recorded blocker a write kept without placing it in that
	 * write's bytes (no alignment, or its own line edited). Its `line` is from
	 * older bytes, so nothing reads it as a position. The carry matches it by
	 * identity on any line holding its `lineHash` text; the settle matches it
	 * by identity alone, anywhere in the file, with no line check (it fails
	 * closed). The record cites no line for it. An observed copy replaces it.
	 * Never part of identity.
	 */
	positionStale?: true;
	/**
	 * #4130: the diagnostic reports the runner's own failure (`faultResult`), not
	 * a finding about the code. Turn end delivers that fault once, as the
	 * failure note, so the deferred verdict drops this row. Never part of
	 * identity.
	 */
	runnerFault?: true;
}

/**
 * #4484 round 2: which sources reached no verdict in one dispatch. A recorded
 * blocker from one of them stays: its absence from the run is not evidence
 * that it is gone.
 */
export interface InconclusiveSources {
	/** Runners whose whole run reached no verdict (failed without findings, an
	 *  unanswered or unavailable language server, a collect-later run still in
	 *  flight). */
	runnerIds: readonly string[];
	/** Language servers a run named unconfirmed (`unconfirmedServerIds`). */
	serverIds: readonly string[];
	/**
	 * #4484 round 3: the subset of `runnerIds` still in flight (collect-later).
	 * Their settled run answers for the write on its own, so the next write
	 * owes them no lines.
	 */
	collectLaterRunnerIds: readonly string[];
}

export interface DispatchResult {
	/** The latency report this dispatch appended for its own file, when one was captured. Carries identity so a caller never has to infer it from the ring (clients/dispatch/dispatcher.ts). */
	latencyReport?: DispatchLatencyReport;
	/** All diagnostics found (delta-filtered for this run) */
	diagnostics: Diagnostic[];
	/** Blockers that must be fixed (delta-filtered) */
	blockers: Diagnostic[];
	/** Warnings to address (delta-filtered — only NEW warnings this run) */
	warnings: Diagnostic[];
	/** Total warnings in baseline BEFORE this run (for cumulative count display) */
	baselineWarningCount: number;
	/** Issues that were auto-fixed */
	fixed: Diagnostic[];
	/** Count of previously-seen diagnostics that were resolved this run */
	resolvedCount: number;
	/** Formatted output for display */
	output: string;
	/** Blocking-only portion of output (without auto-fix section) — for turn_end re-surfacing */
	blockerOutput: string;
	/** Whether any blockers were found */
	hasBlockers: boolean;
	/**
	 * #4484: the blocking findings this observation still holds that the delta
	 * did not call new (it saw their ids before). Not rendered as a STOP, but
	 * the file's current blocking set is `blockers` plus these: the record, the
	 * store and the commit gate read both, so an empty delta never clears a
	 * blocker that is still there. Absent when there are none.
	 */
	heldBackBlockers?: Diagnostic[];
	/**
	 * #4483: blocking linter findings the file already held before its first
	 * edit this session (the pre-edit seed, clients/dispatch/pre-edit-seed.ts).
	 * They are in neither `blockers` nor `heldBackBlockers`: they never STOP,
	 * never enter the inline-blocker record or the commit gate, and the write
	 * reports them on one line. Absent when there are none.
	 */
	preExisting?: Diagnostic[];
	/**
	 * #4484 round 2: findings this observation still holds that neither
	 * deliver nor enter the record on their own: a blocking finding an
	 * edit-range gate withheld because the edit did not touch its lines, and an
	 * unused value the delta held back (promoted, as when it was new). Each
	 * keeps a recorded blocker of the same identity pending. Absent when none.
	 */
	stillObserved?: Diagnostic[];
	/**
	 * #4484 round 6: runners whose verdict covers only the edit's ranges
	 * (`RunnerResult.editScopedVerdict`). Absent when none.
	 */
	editScopedRunnerIds?: string[];
	/** #4484 round 2: the runners and servers that reached no verdict. */
	inconclusiveSources?: InconclusiveSources;
	/**
	 * #4403: why the file's primary group did not check it. Set whenever the
	 * coverage notice's rule finds no coverage, whether or not the once-only
	 * latch shows the notice, so a write the latch silences still does not
	 * read as clean: the write-time all-clear line gives this instead.
	 */
	unconfirmedStatus?: string;
	/**
	 * #4733 r2 (from #4734's review): the coverage rule's positive answer for
	 * these bytes, set only where it found the file checked: `primary` (a
	 * runner of the primary group reached a verdict), `in_flight` (a
	 * collect-later primary whose answer reaches this session's blocker map at
	 * turn end), `fallback` (a fallback linter the rule accepts in its place),
	 * or `unconfigured` (this mode defines no primary group for the file, as in
	 * a `--no-lsp` TypeScript write). Unset otherwise, including where an unset
	 * `unconfirmedStatus` hides that no runner of a defined primary group ran.
	 */
	coverage?: "primary" | "in_flight" | "fallback" | "unconfigured";
	/**
	 * #4734 r3: the primary group's language server (its `lsp` runner) reached
	 * a usable result for these bytes, with no server left unconfirmed. Absent
	 * otherwise: no kind or primary group, `--no-lsp`, a CLI primary or a
	 * fallback linter standing in, a primary deferred or still in flight, and a
	 * partial notice the session latch withheld. The clean advisory's evidence
	 * that a language server answered (`PipelineResult.checkedClean`).
	 */
	primaryLspChecked?: true;
}

// --- Runner Definition ---

type RunnerMode = "all" | "fallback" | "first-success";

export interface RunnerDefinition {
	id: string;
	appliesTo: readonly FileKind[];
	priority: number;
	/** Skip this runner for test files (false positive reduction) */
	skipTestFiles?: boolean;
	/** Per-runner wall-clock timeout in ms; overrides dispatch.runnerTimeoutMs when set */
	timeoutMs?: number;
	/** Check if runner should run */
	when?: (ctx: DispatchContext) => Promise<boolean> | boolean;
	/** Execute the runner */
	run(ctx: DispatchContext): Promise<RunnerResult>;
}

/** Closed telemetry taxonomy for expected runner skips (#3968 added the two
 * ownership reasons: a runner may skip because its capability is policy-
 * deferred to a lane that owns it, or because its tool categorically cannot
 * serve the file's dialect — both are policy decisions named at the delivery
 * surface, never an empty output read as clean). `disabled-by-config` is the
 * operator's own decision (`dispatch.disabledRunners`): the runner never ran,
 * which is neither a failure nor a verdict on the file. `not-enabled` is the
 * same for an opt-in runner left off (#5042): nothing failed, and nothing was
 * checked either. */
export const RUNNER_SKIP_REASONS = [
	"no-files-matched",
	"configured-non-biome-linter",
	"dialect-unsupported",
	"covered-by-primary",
	"disabled-by-config",
	"not-enabled",
] as const;
export type RunnerSkipReason = (typeof RUNNER_SKIP_REASONS)[number];

/**
 * The skip reasons that say a runner had nothing to check, so beside a
 * `dispatch.disabledRunners` denial the coverage notice does not read them as
 * a tool that failed. A closed admission list over {@link RUNNER_SKIP_REASONS}:
 * a reason added to the taxonomy reads as a failure until it is listed here.
 * `covered-by-primary` is left out on purpose: it defers to a lane whose answer
 * is what the denial may have removed. `disabled-by-config` is the denial
 * itself and the caller handles it. {@link reachedNoVerdict} admits the
 * taxonomy as a verdict except `not-enabled`; this is the narrower "not a tool
 * failure" subset, and `not-enabled` is in it (#5042): an opt-in runner left
 * off failed at nothing.
 */
export const NOT_APPLICABLE_SKIP_REASONS: readonly RunnerSkipReason[] = [
	"no-files-matched",
	"configured-non-biome-linter",
	"dialect-unsupported",
	"not-enabled",
];

/** Whether a skip reason states the runner had nothing to check. */
export function isNotApplicableSkipReason(
	value: RunnerSkipReason | undefined,
): boolean {
	return NOT_APPLICABLE_SKIP_REASONS.some((reason) => reason === value);
}

/**
 * #4130: why an invoked tool produced no result. The non-`ran` kinds of
 * `classifyRunOutcome` (`runners/utils/spawn-outcome.ts`), so a new outcome
 * kind fails to compile at `skipUnlessToolRan` until it is named here.
 */
export type RunnerSkipFault =
	| "did-not-run"
	| "rejected-invocation"
	| "report-missing";

/** Runtime guard for untyped/plugin-provided runner results. */
export function isRunnerSkipReason(value: unknown): value is RunnerSkipReason {
	return RUNNER_SKIP_REASONS.some((reason) => reason === value);
}

/**
 * Closed taxonomy for WHO supplied a `covered-by-primary` claim (#3968 F2):
 * `"declared"` — the server row's own `covers` (config channel); `"builtin-fact"`
 * — the builtin facts table (`clients/lsp/server-covers.ts`). Admitted into
 * durable latency metadata through {@link isRunnerClaimSource}'s guard, the
 * same gate {@link isRunnerSkipReason} runs, so free text cannot enter.
 */
export const RUNNER_CLAIM_SOURCES = ["declared", "builtin-fact"] as const;
export type RunnerClaimSource = (typeof RUNNER_CLAIM_SOURCES)[number];

/** Runtime guard for untyped/plugin-provided runner results. */
export function isRunnerClaimSource(
	value: unknown,
): value is RunnerClaimSource {
	return RUNNER_CLAIM_SOURCES.some((source) => source === value);
}

export interface RunnerResult {
	status: "succeeded" | "failed" | "skipped" | "deferred";
	/** Diagnostics found */
	diagnostics: Diagnostic[];
	/** Output semantic for these diagnostics */
	semantic: OutputSemantic;
	/** Raw output string (if runner returns text instead of structured) */
	rawOutput?: string;
	/**
	 * When status==="failed", a short machine-readable reason that separates a
	 * genuine runner breakage from "the check ran and found blocking issues".
	 * Conventional values: "timeout", "exception" (thrown/aborted), "server_error"
	 * (LSP/tool process failed), "parser_error" (the tool exited nonzero and its
	 * output could not be parsed), "unconfirmed_output" (the tool printed output
	 * the runner could not confirm as findings for this file), "unavailable",
	 * "blocking_diagnostics" (the check completed and
	 * its findings, by the runner's own threshold, failed it — not a runner
	 * fault). A fault arm may carry a synthetic diagnostic so the inline path is
	 * never silent; its kind, not the diagnostic, says it is a fault (#3796).
	 * Every `failed` built from findings carries "blocking_diagnostics"
	 * through `findingsResult` (#3781), so a `failed` without it means the runner
	 * produced no usable result. A runner may also report findings, blocking ones
	 * included, as `succeeded`; `status` is not a severity channel, and severity
	 * lives in `semantic` and the diagnostics. Consumers (the log-smell
	 * analyzer, latency.log, the MCP analyze row) use this to avoid counting
	 * found-errors as crashes.
	 */
	failureKind?: string;
	/** Optional short human-readable detail for the failure (truncated). */
	failureMessage?: string;
	/** Bounded machine-readable reason when status is an expected skip. */
	skipReason?: RunnerSkipReason;
	/**
	 * #4130: a skip that is a runner fault, not an absent tool. The tool was
	 * invoked and broke (killed, timed out, rejected its invocation, wrote no
	 * report), so the run reached no verdict for a reason the user cannot act
	 * on by installing something. Set only through {@link faultSkip}; a skip
	 * with no tool to invoke leaves it unset. Smoke classification reads it so
	 * "absent" and "broken" stop rendering alike.
	 */
	skipFault?: RunnerSkipFault;
	/**
	 * When the skip is `covered-by-primary`: which fact source supplied the
	 * claim (`declared` — the row's own `covers`; `builtin-fact` — the facts
	 * table). The dispatcher admits it into latency metadata only on actual
	 * skips and only through the closed-taxonomy guard (#3968 F2).
	 */
	claimSource?: RunnerClaimSource;
	/** Correlated scanner ids whose findings are absent from this result. */
	unconfirmedServerIds?: readonly string[];
	/**
	 * Correlated scanner ids the touch marked collect-later, so their findings
	 * can still arrive at turn end (#2810). A subset of `unconfirmedServerIds`;
	 * the rest of that set has no delivery path and reads as silent.
	 */
	deferredServerIds?: readonly string[];
	/**
	 * #4484 round 6: the verdict covers only the edit's ranges. napi's Gate B
	 * skip sets it: the ast-grep server answers for the file, but its gate
	 * withholds a blocking finding outside the edit (`outOfEditScope`) under
	 * another identity, so it says nothing about napi's findings there.
	 */
	editScopedVerdict?: boolean;
	/**
	 * #4484 round 7: the lane a `covered-by-primary` skip defers to. The skip
	 * is a verdict only when that runner reached one and that server (when
	 * named) confirmed; otherwise the dispatcher reads it as no verdict, and a
	 * settled skip retires nothing. #4509: a run that read the bytes while
	 * that lane covers the file names it too. Its verdict is its own; when the
	 * lane answered, the lane's copy stands for the run's finding on each line
	 * the lane flagged, and the run's other findings deliver.
	 */
	coveredBy?: { runnerId: string; serverId?: string };
	/**
	 * #4403: why no primary language server answered, when the runner knows:
	 * the operator disabled it, it could not be started (or was still
	 * starting), or both. The coverage notice and the status line name it.
	 */
	primaryUnavailableCause?: PrimaryUnavailableCause;
	/** #4403: the disabled primaries, which get one note per server per session. */
	disabledPrimaryServerIds?: readonly string[];
	/**
	 * #4484 round 2: blocking findings the runner's edit-range gate withheld
	 * from delivery because the edit did not touch their span
	 * (`spanOverlapsModifiedRanges`). They are still observed: they keep a
	 * recorded blocker pending, and never deliver or enter the record alone.
	 */
	outOfEditScope?: Diagnostic[];
	/**
	 * #4638 r3 (N2): one bounded sentence naming findings the runner withheld
	 * from `diagnostics` on purpose (a project's declared syntax level outranks
	 * jedi's `compile` verdict). A drop only the ledger knows about reads as a
	 * clean edit, so the dispatcher renders this inline beside the blocker output.
	 */
	withheldNotice?: string;
	/**
	 * #4484 round 2: the run reached no verdict although it returned no
	 * failure kind (the language server's diagnostics wait hit its deadline
	 * with nothing collected, or a query run threw part way). What it did not
	 * report is not evidence of a clean file.
	 */
	inconclusive?: boolean;
}

/**
 * The `failureKind` that says a `failed` run completed its check and its own
 * findings failed it — not a runner fault (#3781). `findingsResult` stamps it,
 * and {@link hasUsableResult} is the one reader of the coverage rule.
 */
export const BLOCKING_DIAGNOSTICS_FAILURE_KIND = "blocking_diagnostics";

/**
 * The result of a run that COMPLETED with findings (#3781).
 *
 * A runner reports `failed` for findings when its own threshold says they fail
 * the check. The threshold differs per tool: a blocking diagnostic, an error
 * severity, any finding at all, or a nonzero exit. `status` is left as the
 * runner decided, because a multi-member fallback group continues past a
 * `failed` member (dispatcher.ts runGroup). The `failureKind` is what tells a
 * consumer (the log analyzer, latency.log, the MCP analyze row) that this
 * `failed` is findings and not a runner that broke. A broken run never comes
 * through here: its arm returns `failed` with its own kind, or with none.
 */
export function findingsResult(
	diagnostics: Diagnostic[],
	verdict: Pick<RunnerResult, "status" | "semantic">,
): RunnerResult {
	if (verdict.status === "failed") {
		return {
			...verdict,
			diagnostics,
			failureKind: BLOCKING_DIAGNOSTICS_FAILURE_KIND,
		};
	}
	return { ...verdict, diagnostics };
}

/**
 * The result of a run that BROKE and says so (#4130): `failed` with its own
 * fault kind, never `blocking_diagnostics`. The synthetic diagnostic keeps the
 * inline path from reading the run as clean. It is a warning by construction:
 * a tool that could not read its own output says nothing about the code, so it
 * must not enter the blocker map (#3814). `runnerFault` marks it, so turn end
 * delivers the fault once, as the failure note. A runner with real partial
 * findings beside a fault kind (rust-clippy) builds its own result instead.
 */
export function faultResult(
	fault: { kind: string; failureMessage: string },
	diagnostic: Pick<Diagnostic, "id" | "message" | "filePath" | "tool"> &
		Partial<Pick<Diagnostic, "line" | "column" | "rule" | "fixable">>,
): RunnerResult {
	return {
		status: "failed",
		diagnostics: [
			{
				...diagnostic,
				severity: "warning",
				semantic: "warning",
				runnerFault: true,
			},
		],
		semantic: "warning",
		failureKind: fault.kind,
		failureMessage: fault.failureMessage.slice(0, 200),
	};
}

/**
 * The one skip a runner returns after it invoked its tool and the tool broke
 * (#4130). An absent tool returns a bare skip instead: there is nothing to
 * blame, and nothing was invoked.
 */
export function faultSkip(fault: RunnerSkipFault): RunnerResult {
	return {
		status: "skipped",
		diagnostics: [],
		semantic: "none",
		skipFault: fault,
	};
}

/**
 * Whether a runner result is usable coverage of the bytes it ran on (#3867).
 *
 * A `succeeded` run reached a verdict about the file. A `failed` run reached
 * one only when `failureKind` is `"blocking_diagnostics"` — the check
 * completed and its own findings failed it, per the `RunnerResult.failureKind`
 * contract above. Any other `failureKind`, or none, means the runner broke or
 * never ran (timeout, spawn failure, server error) and covered nothing, so a
 * caller must not read it as "the file was analysed".
 *
 * The parameter accepts the wider latency-row status set (`when_skipped`,
 * `pending`, and `deferred`) so the dispatcher's coverage notice and turn end's
 * deferred delivery (#3796) ask this one owner instead of comparing
 * `status`/`failureKind` themselves.
 */
export function hasUsableResult(result: {
	status: string;
	failureKind?: string;
}): boolean {
	return (
		result.status === "succeeded" ||
		(result.status === "failed" &&
			result.failureKind === BLOCKING_DIAGNOSTICS_FAILURE_KIND)
	);
}

/**
 * Whether a runner's whole run reached no verdict about the file (#4484). The
 * other side of {@link hasUsableResult}: a run has a verdict only when it read
 * the file and finished (R1 in PR #4491's round-3 table). That is a
 * `succeeded` run not flagged `inconclusive`, a `failed` run with its own
 * findings, or a skip that states a not-applicable reason from
 * {@link RUNNER_SKIP_REASONS} (`not-enabled` excepted, below). Every other
 * outcome has none: a `failed` run without findings (timeout, spawn or server failure), a `deferred` one, a
 * run flagged `inconclusive`, and any skip without a stated reason, since a
 * skip that never read the file (a size or line cap, an aborted WASM runtime,
 * a grammar or server that is unavailable) says nothing about it. Unknown
 * skip forms therefore fail closed. A run that answered names its unconfirmed
 * servers, which the dispatcher adds to `InconclusiveSources.serverIds`, so
 * the rest of the run still counts.
 */
export function reachedNoVerdict(
	result: Pick<
		RunnerResult,
		"status" | "failureKind" | "inconclusive" | "skipReason"
	>,
): boolean {
	if (result.inconclusive === true) return true;
	switch (result.status) {
		case "failed":
			return !hasUsableResult(result);
		case "deferred":
			return true;
		case "skipped":
			// #5042: an opt-in runner left off states why it did not run, which
			// changes the notice's wording and nothing else. It still read nothing
			// of the file, so it stays out of the verdicts exactly as its bare skip
			// was: a recorded blocker of that runner is kept and its edited lines
			// stay owed, not retired by a run that never happened.
			return (
				!isRunnerSkipReason(result.skipReason) ||
				result.skipReason === "not-enabled"
			);
		default:
			return false;
	}
}

/**
 * #4733 r1 F2: whether one dispatch checked the whole file, as far as this
 * checkout can. The commit gate's record lets a clean write drop another
 * session's blocker section for the file only on such a run, since another
 * session's section names no runner a per-runner carry could judge it by.
 *
 * Admitted: no language server went unanswered (`serverIds`), the coverage
 * rule found the file checked (`coverage`; #4733 r2: an unset
 * `unconfirmedStatus` also holds when a defined primary group never ran),
 * no verdict covers only the
 * edit (`editScopedRunnerIds`), at least one runner ran and answered, and
 * every runner that reached no verdict either skipped or is a collect-later
 * run still in flight (its answer joins this session's own blocker map when
 * it settles). Refused: everything else, a runner that failed or broke part
 * way above all, and a no-verdict runner with no latency row. A skip carries
 * no marker of why it skipped, so one that could not read the file (a size
 * cap, an aborted WASM runtime) is admitted with the not-configured ones.
 */
export function checkedWholeFile(
	result: Pick<
		DispatchResult,
		"coverage" | "editScopedRunnerIds" | "inconclusiveSources" | "latencyReport"
	>,
): boolean {
	if (
		result.coverage === undefined ||
		result.editScopedRunnerIds !== undefined ||
		(result.inconclusiveSources?.serverIds.length ?? 0) > 0
	) {
		return false;
	}
	const noVerdict = new Set(result.inconclusiveSources?.runnerIds);
	const runners = result.latencyReport?.runners ?? [];
	const outcomeOf = new Map(
		runners.map((runner) => [runner.runnerId, runner.status]),
	);
	const skippedOrInFlight = new Set<string | undefined>(["skipped", "pending"]);
	return (
		[...outcomeOf.values()].includes("succeeded") &&
		[...noVerdict].every((runnerId) =>
			skippedOrInFlight.has(outcomeOf.get(runnerId)),
		)
	);
}

/**
 * #5020: the runners that reached a verdict on this run's bytes: a row of the
 * latency report with a usable result ({@link hasUsableResult}: it succeeded,
 * or it completed and failed on findings) that is not in
 * `inconclusiveSources`. A runner that skipped, broke, is still in flight or
 * answered for part of the file speaks for nothing, which is why this is the
 * evidence a retire of another file's row asks for
 * (`RuntimeCoordinator.retireForeignRows`). A run that failed on findings
 * speaks only through the caller's own guard: the retire also needs the run to
 * hold no blocker of its own on the file (`stillReported` in
 * `publishInlineVerdict`), so mypy answering `b.py` while reporting `c.py`
 * retires the row about `b.py` and keeps every row about `c.py` (PR #5033
 * round 3).
 *
 * An edit-scoped runner (`editScopedRunnerIds`) is refused here for the reason
 * `checkedWholeFile` refuses the whole run for it: its verdict covers the
 * edited ranges, so "no blocker reported" says nothing about the rest of the
 * file a cross-file row would be judged against.
 */
export function verdictRunnerIds(
	result: Pick<
		DispatchResult,
		"inconclusiveSources" | "editScopedRunnerIds" | "latencyReport"
	>,
): string[] {
	const noWholeFileVerdict = new Set([
		...(result.inconclusiveSources?.runnerIds ?? []),
		...(result.editScopedRunnerIds ?? []),
	]);
	return (result.latencyReport?.runners ?? []).flatMap((runner) =>
		hasUsableResult(runner) && !noWholeFileVerdict.has(runner.runnerId)
			? [runner.runnerId]
			: [],
	);
}

// --- Dispatch Context ---

/**
 * #2016 invariant: `filePath`, `projectRoot`, and `cwd` are ALREADY
 * `normalizeMapKey`-normalized. `createDispatchContext` is the only constructor
 * and it normalizes all three before building the object.
 *
 * So `normalizeMapKey(ctx.filePath)` is a pure `realpathSync.native` syscall
 * that returns its own input. On Windows that measures ~200 microseconds per
 * call; since #3098 POSIX pays that syscall too (measured at 1.8 microseconds
 * for an existing path, 4.7 for an absent one) rather than short-circuiting —
 * still too small for a CI timing gate to see, which is a reason to delete the
 * redundant call, not to tolerate it. Use these three fields directly as map
 * keys, fact keys, once-keys,
 * and degradation subjects. `tests/clients/dispatch-context-normalized.test.ts`
 * pins both halves: that the constructor normalizes, and that no call site
 * re-normalizes.
 */
export interface DispatchContext {
	/** Root ownership selected by the shared analysis-root seam. */
	readonly analysisRootMode?: AnalysisRootMode;
	/** Normalized. See the #2016 invariant above. */
	readonly filePath: string;
	/**
	 * Workspace/project root before language-specific root resolution.
	 * Normalized. See the #2016 invariant above.
	 */
	readonly projectRoot?: string;
	/** Normalized. See the #2016 invariant above. */
	readonly cwd: string;
	readonly kind: FileKind | undefined;
	readonly fileRole: FileRole;
	/**
	 * When `fileRole === "generated"`: the evidence tier that decided the
	 * verdict (undefined otherwise). Threaded from `createDispatchContext` so
	 * the generated short-circuit can emit a `dispatch_skipped_generated`
	 * phase record without re-reading the file (refs #2346).
	 */
	readonly generatedEvidence?: GeneratedArtifactEvidence;
	/**
	 * When `generatedEvidence === "line-shape"`: the measured mean non-empty
	 * line length that crossed the threshold. Undefined for path/header/decl
	 * evidence tiers (refs #2346).
	 */
	readonly generatedLineShapeMean?: number;
	readonly pi: PiAgentAPI;
	readonly autofix: boolean;
	readonly deltaMode: boolean;
	readonly facts: import("./fact-store.js").FactStore;
	/** Project-local .pi-lens.json config captured for this dispatch. */
	readonly projectConfig?: PiLensProjectConfig;
	/**
	 * The EDITED file's config owner's rule policy, including path-scoped
	 * denials: runners read it to skip a rule on this file, and the output filter
	 * reuses it for findings under the same owner (every other owner's finding
	 * reads its own, #5011 r8 F24).
	 */
	readonly rulePolicy?: RulePolicyMap;
	/**
	 * Runner ids the operator denied through `dispatch.disabledRunners`
	 * (union of every config tier). Absent when nothing is denied. The
	 * dispatcher skips these before their `when`/`run`, so the tool never spawns.
	 */
	readonly disabledRunnerIds?: ReadonlySet<string>;
	/** Only run blocking rules (severity: error) - used for fast feedback on file write */
	readonly blockingOnly?: boolean;
	readonly modifiedRanges?: ModifiedRange[];
	/**
	 * #4484 round 3 (R4): per runner, the lines an earlier write owed it
	 * because it reached no verdict there. They join that runner's
	 * `modifiedRanges` (`runnerDispatchContext`), so a blocker first written
	 * while it had no verdict is in range when it next answers.
	 */
	readonly owedRanges?: ReadonlyMap<string, readonly ModifiedRange[]>;
	/**
	 * #4483: this dispatch is the `tool_call` capture of a file's bytes before
	 * its first edit (`capturePreEditLinterFindings`). Its runner counts never
	 * reach the widget, and its log rows say so.
	 */
	readonly preEditCapture?: true;
	/**
	 * #4509: the runners that hold a recorded blocker on this file when the
	 * dispatch starts. A recorded blocker is judged only by a run of its own
	 * runner, so a runner that would defer to a covering lane runs instead
	 * (napi's Gate B).
	 */
	readonly recordedRunnerIds?: ReadonlySet<string>;
	/** Ordered per-file pipeline token used by widget reconciliation (#1198). */
	readonly writeIndex?: number;
	/**
	 * #3568: the session a post-write dispatch belongs to. A collect-later
	 * runner deferred after that session was replaced is not handed to the
	 * next session's turn end.
	 */
	readonly sessionGeneration?: GenerationHandle;
	/** Stable session identity for per-session turn-end runner delivery. */
	readonly sessionId?: string;
	/** Model/provider active for this dispatch, when the runtime knows it
	 * (#1448) — threaded to the worklog append so repair history can be
	 * attributed. Blank/absent outside a live agent turn (e.g. project scans). */
	readonly telemetryModel?: string;
	readonly telemetryProvider?: string;
	/** Pass-scoped filesystem memo for the shared tool-cwd seam. */
	readonly toolCwdMemo?: { gitRoot?: string | null };

	hasTool(command: string): Promise<boolean>;
	/** Log an advisory to the dispatch sink; `level` defaults to `error`. */
	log(message: string, level?: ExtensionLogLevel): void;
}

// --- Tool Plan ---

export type CapabilityDimension =
	| "types"
	| "security"
	| "smells"
	| "format"
	| "lint"
	| "docs";

export interface ToolPlan {
	name: string;
	/** Capabilities required for a complete verdict on this file kind. */
	capabilities: readonly CapabilityDimension[];
	groups: RunnerGroup[];
}

export interface RunnerGroup {
	mode: RunnerMode;
	runnerIds: string[];
	filterKinds?: readonly FileKind[];
	/** Override semantic for all runners in this group */
	semantic?: OutputSemantic;
}

// --- Registry ---

export interface RunnerRegistry {
	register(runner: RunnerDefinition): void;
	get(id: string): RunnerDefinition | undefined;
	getForKind(kind: FileKind, filePath?: string): RunnerDefinition[];
	list(): RunnerDefinition[];
	clear(): void;
}
