/**
 * Redesigned Dispatch Types for pi-lens
 *
 * Key insight: Different clients have different OUTPUT SEMANTICS:
 * - BLOCKING: Errors that stop the agent (architect, ts-lsp errors)
 * - WARNING: Non-blocking issues (biome warnings, type-safety)
 * - FIXABLE: Issues with auto-fix available
 * - SILENT: Metrics tracked but not shown (complexity)
 * - INFORMATIONAL: Shown in session summary only
 *
 * The dispatcher must handle these semantics consistently.
 */

import type { FileKind } from "../file-kinds.js";
import type { DefectClass } from "./diagnostic-taxonomy.js";

export interface ModifiedRange {
	start: number;
	end: number;
}

// --- API Interface ---

export interface PiAgentAPI {
	getFlag(flag: string): string | boolean | undefined;
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
	/** Rule/category */
	rule?: string;
	/** Normalized defect class for overlap arbitration */
	defectClass?: DefectClass;
	/** Whether auto-fix is available */
	fixable?: boolean;
	/** Auto-fix command/suggestion */
	fixSuggestion?: string;
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
	/** Whether any blockers were found */
	hasBlockers: boolean;
}

// --- Runner Definition ---

export type RunnerMode = "all" | "fallback" | "first-success";

export interface RunnerDefinition {
	id: string;
	appliesTo: readonly FileKind[];
	priority: number;
	enabledByDefault: boolean;
	/** Skip this runner for test files (false positive reduction) */
	skipTestFiles?: boolean;
	/** Check if runner should run */
	when?: (ctx: DispatchContext) => Promise<boolean> | boolean;
	/** Execute the runner */
	run(ctx: DispatchContext): Promise<RunnerResult>;
}

export interface RunnerResult {
	status: "succeeded" | "failed" | "skipped";
	/** Diagnostics found */
	diagnostics: Diagnostic[];
	/** Output semantic for these diagnostics */
	semantic: OutputSemantic;
	/** Raw output string (if runner returns text instead of structured) */
	rawOutput?: string;
}

// --- Dispatch Context ---

export interface DispatchContext {
	readonly filePath: string;
	readonly cwd: string;
	readonly kind: FileKind | undefined;
	readonly pi: PiAgentAPI;
	readonly autofix: boolean;
	readonly deltaMode: boolean;
	readonly facts: import("./fact-store.js").FactStore;
	/** Only run blocking rules (severity: error) - used for fast feedback on file write */
	readonly blockingOnly?: boolean;
	readonly modifiedRanges?: ModifiedRange[];

	hasTool(command: string): Promise<boolean>;
	log(message: string): void;
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
