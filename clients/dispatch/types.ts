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
 * The output tier of a finding at this severity (#5412). Only `error` blocks.
 * `warning`, `info` and `hint` are advisory warnings: the tier every CLI runner
 * gives a non-error finding (#1777, #1802). The LSP converter keeps its raw
 * `none` for a `hint` (`convertLspDiagnostics`); the auxiliary profile raises it.
 */
export function semanticFor(severity: Diagnostic["severity"]): OutputSemantic {
	return severity === "error" ? "blocking" : "warning";
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
	 * #5258: whether a check of this file's kind completed. REQUIRED, so every
	 * producer of a `DispatchResult` states it and the compiler finds one that
	 * does not; the write-time all-clear line, `PipelineResult.checkedClean`
	 * and the widget footer's `✓ clean` all read this and nothing else. It
	 * replaces #4403's `unconfirmedStatus` and #4734's `primaryLspChecked`,
	 * whose absence was read as clean.
	 */
	verdict: CoverageVerdict;
	/**
	 * #4733 r2 (from #4734's review): the commit gate's answer to "did the rule
	 * find the file covered", read only by {@link checkedWholeFile}. It is a
	 * wider question than {@link verdict}: `in_flight` (a collect-later primary
	 * whose answer reaches this session's blocker map at turn end) and
	 * `unconfigured` (this mode defines no primary group for the file, as in a
	 * `--no-lsp` TypeScript write) count as covered there and as unchecked in
	 * `verdict`. Unset where the rule found no coverage.
	 */
	coverage?: "primary" | "in_flight" | "fallback" | "unconfigured";
}

/**
 * #5258: the one positive answer to "did a check of this file's kind
 * complete". `checked` carries the ids of the runners that completed
 * ({@link hasUsableResult}); a non-empty list is the only way to build it, so
 * a missing field, a skipped runner, a timeout, a thrown error, unparseable
 * output and an absent binary can never produce it. Everything else is
 * `unchecked` with the sentence the write-time line gives instead of "clean".
 * `tier` says what stood in: `primary` (a runner of the primary group reached
 * a verdict) or `fallback` (a fallback linter the coverage rule accepts in its
 * place). A language server answered exactly when `runnerIds` holds `lsp`
 * (`PipelineResult.checkedClean`).
 */
export type CoverageVerdict =
	| {
			checked: true;
			tier: "primary" | "fallback";
			runnerIds: readonly [string, ...string[]];
	  }
	| { checked: false; reason: string; inapplicable?: true; repeat?: true };

/**
 * Surface policy the `unchecked` arm carries (#5258 r2). `inapplicable`: no
 * check can ever cover this file (no file kind, a generated file), so only the
 * write's own line says so; the widget footer count and the persisted reason
 * cover files a check could have covered but did not. `repeat`: the line for
 * this reason was already printed for this file this session, so the write
 * prints none until a result replaces it.
 */
export type UncheckedSurface = { inapplicable?: true; repeat?: true };

/** The `unchecked` arm; the single constructor, so the shape has one spelling. */
export const unchecked = (
	reason: string,
	surface: UncheckedSurface = {},
): CoverageVerdict => ({
	checked: false,
	reason,
	...surface,
});

/**
 * #5287: why no check of the analysed file's kind completed, or `undefined`
 * when one did. A reply from a worker or warm server built before the verdict
 * field carries none, which is not a completed check either, so the verdict is
 * read as optional here: silence and a clean summary are reserved for a
 * `checked` one. Kept in this leaf module because the CLI's cold path imports
 * only it before the analysis runs.
 */
export const verdictUncheckedReason = (
	verdict: CoverageVerdict | undefined,
): string | undefined =>
	verdict === undefined
		? "the answering pi-lens server did not report whether a check completed — restart it if it predates this build"
		: verdict.checked
			? undefined
			: verdict.reason;

/**
 * What the widget store records for a run, or `undefined` for a checked one:
 * the unchecked reason, and whether no check can ever cover the file. The store
 * keeps both. The footer counts only the covered kind, and every cache-only
 * report names the reason (#5287).
 */
export const recordedUnchecked = (
	verdict: CoverageVerdict,
): { reason: string; inapplicable?: true } | undefined =>
	verdict.checked
		? undefined
		: {
				reason: verdict.reason,
				...(verdict.inapplicable && { inapplicable: true as const }),
			};

/**
 * The `checked` arm from the runner rows that completed, or `undefined` when
 * none did. The only place the arm is built, and it takes rows, not a
 * boolean, so a `checked` verdict names the runners that earned it. A row
 * flagged `inconclusive` read part of the file, whatever its status, so it
 * earns nothing (#5285 r3).
 */
export function checkedVerdict(
	tier: "primary" | "fallback",
	rows: readonly {
		runnerId: string;
		status: string;
		failureKind?: string;
		inconclusive?: true;
	}[],
): CoverageVerdict | undefined {
	const [first, ...rest] = rows
		.filter((row) => row.inconclusive !== true && hasUsableResult(row))
		.map((row) => row.runnerId);
	if (first === undefined) return undefined;
	// A variable, not a literal: this is a verdict's runner list, not a
	// `RunnerGroup`, and the group-id census reads `runnerIds: [...]` literals.
	const completed: [string, ...string[]] = [first, ...rest];
	return { checked: true, tier, runnerIds: completed };
}

/**
 * #5258: what a surface knows when it would claim "clean" for more than one
 * file or lane. `scope` is how many units the claim speaks for; `proven` how
 * many of them a check completed on, counted from completions only (a
 * `checked` verdict, a fully confirmed server answer), never by subtracting
 * the failures a surface happened to list; `findings` is what the claim would
 * deny.
 */
export interface CleanEvidence {
	scope: number;
	proven: number;
	findings: number;
}

/**
 * #5258: the one clean predicate. A surface says clean, `No issues` or `✓`
 * only when every unit it speaks for was proven and it shows no finding. An
 * empty scope proves nothing, so `clean (0 files)` cannot be built, and a
 * unit nobody counted as proven (a timed-out server, a cut-short scan, a state
 * no one listed) withholds the claim without being named here. The per-file
 * proof is {@link checkedVerdict}; `tests/clients/delivery-surface-ratchet.test.ts`
 * registers every other emitter of a clean claim.
 */
export function cleanVerdict(evidence: CleanEvidence): boolean {
	return (
		evidence.findings === 0 &&
		evidence.scope > 0 &&
		evidence.proven === evidence.scope
	);
}

/**
 * A dispatch that ran nothing: no findings, the given verdict. The one
 * literal for the five early returns (#5258: no kind, no runner group, an
 * adopted root that admits none, a generated file, `dispatchLintDetailed`'s
 * empty result), each of which used to spell the shape out with the verdict
 * left to be read as clean.
 */
export function emptyDispatchResult(verdict: CoverageVerdict): DispatchResult {
	return {
		diagnostics: [],
		blockers: [],
		warnings: [],
		baselineWarningCount: 0,
		fixed: [],
		resolvedCount: 0,
		output: "",
		blockerOutput: "",
		hasBlockers: false,
		verdict,
	};
}

/**
 * The reason of a collect-later primary that has not answered yet. Like every
 * unchecked reason, a later write whose check completed or a scan that
 * confirms the file retires it in the widget store (#5285 r3).
 */
export const IN_FLIGHT_REASON =
	"the primary check is still running (findings arrive at turn end if it lands)";

/** No file kind: nothing in pi-lens analyses this file type. */
export const NO_ANALYZER_REASON = "no analyzer handles this file type";

/**
 * The one wording for a file no language server's matcher selects: write time,
 * `lsp_diagnostics` and `lsp_navigation` all say this, so the reader is never
 * told to install a server that cannot help (#5287).
 */
export const NO_SERVER_REASON = "no language server handles this file";

/**
 * A kind with no primary checker in this mode (`--no-lsp` removes the language
 * server, the only primary of eleven kinds). Other runners may have run, but
 * none of them is the check the kind relies on (#5258).
 */
export const noPrimaryCheckerReason = (lspEnabled: boolean): string =>
	`no primary checker is enabled for this kind${lspEnabled ? "" : " (--no-lsp turns off its language server)"}`;

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
	/**
	 * Whether the project carries the config this runner needs, asked with the
	 * runner's resolved tool cwd. The runner's own gate and `effective_config`
	 * both call this one predicate (#5408), so a runner that skips for want of
	 * config is never reported as selected.
	 */
	requiresConfig?: (cwd: string) => boolean;
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
 * checked either. The four reasons of #5258 say why a runner read none of the
 * file, so the coverage notice names the cause instead of one sentence for all:
 * `not-installed` (its tool was not found), `install-disabled` (not found, and
 * the managed install is off by `PI_LENS_DISABLE_TOOL_INSTALL=1`),
 * `not-configured` (it runs only where the project carries its config) and
 * `not-preferred` (the project's lint policy picks another tool). Four more
 * name why a tool that may well be installed was not usable: `probe-incomplete`
 * (its availability probe timed out or could not finish, so it is not reported
 * missing), `probe-rejected` (a binary it runs, the tool or a runtime it needs,
 * was found and rejected its version probe),
 * `trust-refused` (the project's own binary was refused by pi project trust)
 * and `runtime-missing` (a runtime it needs, such as Java, is absent). None of
 * them is a verdict on the file ({@link VERDICT_SKIP_REASONS}). */
export const RUNNER_SKIP_REASONS = [
	"no-files-matched",
	"configured-non-biome-linter",
	"dialect-unsupported",
	"covered-by-primary",
	"disabled-by-config",
	"not-enabled",
	"not-installed",
	"install-disabled",
	"not-configured",
	"not-preferred",
	"probe-incomplete",
	"probe-rejected",
	"trust-refused",
	"runtime-missing",
] as const;
export type RunnerSkipReason = (typeof RUNNER_SKIP_REASONS)[number];

/**
 * The skip reasons that are a verdict about the file: the runner reached a
 * conclusion without reading it (nothing matched, another lane owns it, the
 * operator denied it). The one admission list {@link reachedNoVerdict} reads;
 * every other reason, and any skip that states none, reads no verdict, so a
 * reason added to {@link RUNNER_SKIP_REASONS} fails closed until it is listed
 * here (#5258).
 */
export const VERDICT_SKIP_REASONS: readonly RunnerSkipReason[] = [
	"no-files-matched",
	"configured-non-biome-linter",
	"dialect-unsupported",
	"covered-by-primary",
	"disabled-by-config",
];

/**
 * The skip reasons that say the runner's tool could not be used here, each
 * with its own true cause. They are the ones the session records once per
 * (runner, reason) (`runner-skip-cause`); `not-configured` and
 * `not-preferred` are the project's own choices.
 */
export const TOOL_UNUSABLE_SKIP_REASONS: readonly RunnerSkipReason[] = [
	"not-installed",
	"install-disabled",
	"probe-incomplete",
	"probe-rejected",
	"trust-refused",
	"runtime-missing",
];

/**
 * The cause a coverage notice states for a runner that skipped with this
 * reason (#5258). A `Record` over the closed set, so a reason added without a
 * sentence does not compile.
 */
export const SKIP_REASON_PHRASE: Record<RunnerSkipReason, string> = {
	"no-files-matched": "no file matched",
	"configured-non-biome-linter": "the project is configured for another linter",
	"dialect-unsupported": "its tool does not support this file's dialect",
	"covered-by-primary": "the primary language server covers this file",
	"disabled-by-config": "disabled in config by dispatch.disabledRunners",
	"not-enabled": "not enabled",
	"not-installed": "not installed",
	"install-disabled":
		"not installed, and the managed install is off (PI_LENS_DISABLE_TOOL_INSTALL=1)",
	"not-configured": "not configured",
	"not-preferred": "the project's lint policy prefers another tool",
	"probe-incomplete": "its availability probe did not finish",
	// The binary may be a runtime the tool needs (Java for SpotBugs), not the
	// tool itself, so the phrase does not say the tool was found.
	"probe-rejected": "a binary it runs was found but rejected its version probe",
	"trust-refused":
		"the project's own binary was refused (pi project trust is not granted)",
	"runtime-missing": "a runtime it needs is not installed",
};

/**
 * The skip reasons that say a runner had nothing to check, so beside a
 * `dispatch.disabledRunners` denial the coverage notice does not read them as
 * a tool that failed. A closed admission list over {@link RUNNER_SKIP_REASONS}:
 * a reason added to the taxonomy reads as a failure until it is listed here.
 * `covered-by-primary` is left out on purpose: it defers to a lane whose answer
 * is what the denial may have removed. `disabled-by-config` is the denial
 * itself and the caller handles it. {@link reachedNoVerdict} is an allow-list
 * over {@link VERDICT_SKIP_REASONS}; this is a different, narrower "not a tool
 * failure" subset, and `not-enabled` is in it (#5042): an opt-in runner left
 * off failed at nothing.
 */
export const NOT_APPLICABLE_SKIP_REASONS: readonly RunnerSkipReason[] = [
	"no-files-matched",
	"configured-non-biome-linter",
	"dialect-unsupported",
	"not-enabled",
	"not-configured",
	"not-preferred",
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
 * The one skip a runner returns when it states why it read none of the file
 * (#5258). A skip with neither this, {@link faultSkip} nor an inline
 * `skipReason` is a bare skip, which the coverage notice can only word as "a
 * language tool is missing, timed out, or failed to run"
 * (`tests/clients/dispatch/bare-skip-census.test.ts` bounds those).
 */
export function skipped(reason: RunnerSkipReason): RunnerResult {
	return {
		status: "skipped",
		diagnostics: [],
		semantic: "none",
		skipReason: reason,
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
			// #5042, #5258: a skip that states why it did not run changes the
			// notice's wording and nothing else. A reason outside
			// {@link VERDICT_SKIP_REASONS} (`not-enabled`, a missing tool, a missing
			// config) read nothing of the file, so it stays out of the verdicts
			// exactly as its bare skip was: a recorded blocker of that runner is
			// kept and its edited lines stay owed, not retired by a run that never
			// happened.
			return !VERDICT_SKIP_REASONS.some(
				(reason) => reason === result.skipReason,
			);
		case "succeeded":
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
 * rule found the file checked (`coverage`; #4733 r2: it is unset when a
 * defined primary group never ran), no verdict covers only the
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
	 * The EDITED file's config owner's `rules.<id>.threshold`, or undefined when
	 * no tier sets it (the rule's own default then applies). One resolution with
	 * {@link rulePolicy}, so a nested `.pi-lens.json` tightens its own files'
	 * thresholds and nothing above it (#5292). Ask the owner for the field
	 * instead of reading `projectConfig.rules` at a new call site.
	 */
	readonly ruleThreshold?: (ruleId: string) => number | undefined;
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
