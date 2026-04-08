/**
 * Dispatch integration helpers
 *
 * Provides utilities for integrating the declarative dispatch system
 * with the existing index.ts tool_result handler.
 */

import { detectFileKind } from "../file-kinds.js";
import type { FileKind } from "../file-kinds.js";
import { getLspCapableKinds } from "../language-policy.js";
import {
	clearLatencyReports,
	createBaselineStore,
	createDispatchContext,
	type DispatchLatencyReport,
	dispatchForFile,
	formatLatencyReport,
	getLatencyReports,
	getRunnersForKind,
	type RunnerLatency,
} from "./dispatcher.js";
import { TOOL_PLANS } from "./plan.js";
import type {
	BaselineStore,
	DispatchResult,
	ModifiedRange,
	PiAgentAPI,
	RunnerGroup,
} from "./types.js";

export type { DispatchLatencyReport, RunnerLatency };
// Re-export latency tracking types and functions
export { clearLatencyReports, formatLatencyReport, getLatencyReports };

// Import runners to register them
import "./runners/index.js";

// --- Persistent Baseline Store ---
// Survives across dispatchLint calls within a session.
// Without this, delta mode is a no-op: every call creates a fresh empty
// store, so baselines.get() always returns undefined and every issue
// looks "new" every time.
const sessionBaselines: BaselineStore = createBaselineStore();
const LSP_CAPABLE_KINDS = new Set<FileKind>(getLspCapableKinds());

function withPrimaryLspGroup(
	kind: keyof typeof TOOL_PLANS,
	groups: RunnerGroup[],
	pi: PiAgentAPI,
): RunnerGroup[] {
	if (!pi.getFlag("lens-lsp") || !!pi.getFlag("no-lsp")) return groups;

	const alreadyHasLsp = groups.some((g) => g.runnerIds.includes("lsp"));
	if (alreadyHasLsp) return groups;

	return [
		{ mode: "all", runnerIds: ["lsp"], filterKinds: [kind as FileKind] },
		...groups,
	];
}

export function getDispatchGroupsForKind(
	kind: keyof typeof TOOL_PLANS,
	pi: PiAgentAPI,
): RunnerGroup[] {
	const plan = TOOL_PLANS[kind];
	if (!plan) {
		if (
			pi.getFlag("lens-lsp") &&
			!pi.getFlag("no-lsp") &&
			LSP_CAPABLE_KINDS.has(kind as FileKind)
		) {
			return [{ mode: "all", runnerIds: ["lsp"], filterKinds: [kind as FileKind] }];
		}
		return [];
	}
	return withPrimaryLspGroup(kind, plan.groups, pi);
}

/**
 * Reset baselines — call on session_start so a new session
 * starts with a clean slate.
 */
export function resetDispatchBaselines(): void {
	sessionBaselines.clear();
}

/**
 * Run linting for a file using the declarative dispatch system
 *
 * @param filePath - Path to the file to lint
 * @param cwd - Project root directory
 * @param pi - Pi agent API (for flags)
 * @returns Output string to display to user
 */
export async function dispatchLint(
	filePath: string,
	cwd: string,
	pi: PiAgentAPI,
	modifiedRanges?: ModifiedRange[],
): Promise<string> {
	// By default, only run BLOCKING rules for fast feedback on file write
	// Uses persistent sessionBaselines so delta mode actually filters
	// pre-existing issues after the first write.
	const ctx = createDispatchContext(
		filePath,
		cwd,
		pi,
		sessionBaselines,
		true,
		modifiedRanges,
	);

	const kind = ctx.kind;
	if (!kind) return "";

	const groups = getDispatchGroupsForKind(kind, pi);
	if (groups.length === 0) return "";

	const result = await dispatchForFile(ctx, groups);
	return result.output;
}

/**
 * Run linting and return full result (including diagnostics)
 */
export async function dispatchLintWithResult(
	filePath: string,
	cwd: string,
	pi: PiAgentAPI,
	modifiedRanges?: ModifiedRange[],
): Promise<DispatchResult> {
	const ctx = createDispatchContext(
		filePath,
		cwd,
		pi,
		sessionBaselines,
		true,
		modifiedRanges,
	);

	const kind = ctx.kind;
	if (!kind) {
		return {
			diagnostics: [],
			blockers: [],
			warnings: [],
			baselineWarningCount: 0,
			fixed: [],
			resolvedCount: 0,
			output: "",
			hasBlockers: false,
		};
	}

	const groups = getDispatchGroupsForKind(kind, pi);
	if (groups.length === 0) {
		return {
			diagnostics: [],
			blockers: [],
			warnings: [],
			baselineWarningCount: 0,
			fixed: [],
			resolvedCount: 0,
			output: "",
			hasBlockers: false,
		};
	}

	return dispatchForFile(ctx, groups);
}

/**
 * Create a baseline store for delta mode tracking
 */
export function createLintBaselines() {
	return createBaselineStore();
}

/**
 * Check if a file should be processed by the dispatcher
 * based on the file kind
 */
export function shouldDispatch(filePath: string): boolean {
	const kind = detectFileKind(filePath);
	return kind !== undefined;
}

/**
 * Get list of available runners for a file
 */
export async function getAvailableRunners(filePath: string): Promise<string[]> {
	const kind = detectFileKind(filePath);
	if (!kind) return [];

	const runners = getRunnersForKind(kind);
	return runners.map((r) => r.id);
}
