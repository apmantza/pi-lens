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

import type { ExtensionLogLevel } from "../extension-log.js";
import type { FileKind } from "../file-kinds.js";
import type { FileRole } from "../file-role.js";
import type { GeneratedArtifactEvidence } from "../generated-artifacts.js";
import type { PiLensProjectConfig } from "../project-lens-config.js";

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
}

export interface DispatchResult {
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

/** Closed telemetry taxonomy for expected runner skips. */
export const RUNNER_SKIP_REASONS = ["no-files-matched"] as const;
export type RunnerSkipReason = (typeof RUNNER_SKIP_REASONS)[number];

/** Runtime guard for untyped/plugin-provided runner results. */
export function isRunnerSkipReason(value: unknown): value is RunnerSkipReason {
	return RUNNER_SKIP_REASONS.some((reason) => reason === value);
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
	 * (LSP/tool process failed), "blocking_diagnostics" (the file has blocking
	 * findings — not a runner fault). Consumers (e.g. the log-smell analyzer)
	 * use this to avoid counting found-errors as crashes.
	 */
	failureKind?: string;
	/** Optional short human-readable detail for the failure (truncated). */
	failureMessage?: string;
	/** Bounded machine-readable reason when status is an expected skip. */
	skipReason?: RunnerSkipReason;
	/** Correlated scanner ids whose findings are absent from this result. */
	unconfirmedServerIds?: readonly string[];
	/**
	 * Correlated scanner ids the touch marked collect-later, so their findings
	 * can still arrive at turn end (#2810). A subset of `unconfirmedServerIds`;
	 * the rest of that set has no delivery path and reads as silent.
	 */
	deferredServerIds?: readonly string[];
}

// --- Dispatch Context ---

/**
 * #2016 invariant: `filePath`, `projectRoot`, and `cwd` are ALREADY
 * `normalizeMapKey`-normalized. `createDispatchContext` is the only constructor
 * and it normalizes all three before building the object.
 *
 * So `normalizeMapKey(ctx.filePath)` is a pure `realpathSync.native` syscall
 * that returns its own input. On Windows that measures ~200 microseconds per
 * call, and POSIX short-circuits it, which is why CI timing gates cannot see
 * the waste. Use these three fields directly as map keys, fact keys, once-keys,
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
	/** Only run blocking rules (severity: error) - used for fast feedback on file write */
	readonly blockingOnly?: boolean;
	readonly modifiedRanges?: ModifiedRange[];
	/** Ordered per-file pipeline token used by widget reconciliation (#1198). */
	readonly writeIndex?: number;
	/** Model/provider active for this dispatch, when the runtime knows it
	 * (#1448) — threaded to the worklog append so repair history can be
	 * attributed. Blank/absent outside a live agent turn (e.g. project scans). */
	readonly telemetryModel?: string;
	readonly telemetryProvider?: string;

	hasTool(command: string): Promise<boolean>;
	/** Log an advisory to the dispatch sink; `level` defaults to `error`. */
	log(message: string, level?: ExtensionLogLevel): void;
}

// --- Tool Plan ---

export interface ToolPlan {
	name: string;
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
