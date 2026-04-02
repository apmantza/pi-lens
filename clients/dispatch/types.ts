/**
 * Redesigned Dispatch Types for pi-lens
 *
 * Key insight: Different clients have different OUTPUT SEMANTICS:
 * - BLOCKING: Errors that stop the agent (architect, ts-lsp errors)
 * - WARNING: Non-blocking issues (biome warnings, type-safety)
 * - FIXABLE: Issues with auto-fix available
 * - SILENT: Metrics tracked but not shown (complexity, TDR)
 * - INFORMATIONAL: Shown in session summary only
 *
 * The dispatcher must handle these semantics consistently.
 */

import type { FileKind } from "../file-kinds.js";

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
	/** Whether auto-fix is available */
	fixable?: boolean;
	/** Auto-fix command/suggestion */
	fixSuggestion?: string;
}

export interface DispatchResult {
	/** All diagnostics found */
	diagnostics: Diagnostic[];
	/** Blockers that must be fixed */
	blockers: Diagnostic[];
	/** Warnings to address */
	warnings: Diagnostic[];
	/** Issues that were auto-fixed */
	fixed: Diagnostic[];
	/** Formatted output for display */
	output: string;
	/** Whether any blockers were found */
	hasBlockers: boolean;
}

// --- Baseline Management ---

export interface BaselineStore {
	/** Get baseline for a file */
	get(filePath: string): unknown[] | undefined;
	/** Set baseline for a file */
	set(filePath: string, diagnostics: unknown[]): void;
	/** Clear all baselines */
	clear(): void;
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
	readonly baselines: BaselineStore;
	/** Only run blocking rules (severity: error) - used for fast feedback on file write */
	readonly blockingOnly?: boolean;

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

// Test edit - adding unused variable to check inline diagnostics flow
const _unusedTestVariable = "checking pre-write and post-write flow";

export interface RunnerRegistry {
	register(runner: RunnerDefinition): void;
	get(id: string): RunnerDefinition | undefined;
	getForKind(kind: FileKind): RunnerDefinition[];
	list(): RunnerDefinition[];
}
