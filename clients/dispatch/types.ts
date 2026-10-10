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
import type { ExtensionLogLevel } from "../extension-log.js";
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
 * surface, never an empty output read as clean). */
export const RUNNER_SKIP_REASONS = [
	"no-files-matched",
	"configured-non-biome-linter",
	"dialect-unsupported",
	"covered-by-primary",
] as const;
export type RunnerSkipReason = (typeof RUNNER_SKIP_REASONS)[number];

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
	/** Shared global+project rule policy, including path-scoped denials. */
	readonly rulePolicy?: RulePolicyMap;
	/** Only run blocking rules (severity: error) - used for fast feedback on file write */
	readonly blockingOnly?: boolean;
	readonly modifiedRanges?: ModifiedRange[];
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
