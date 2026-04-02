/**
 * Dispatch integration helpers
 *
 * Provides utilities for integrating the declarative dispatch system
 * with the existing index.ts tool_result handler.
 */

import { detectFileKind } from "../file-kinds.js";
import {
	clearLatencyReports,
	createBaselineStore,
	createDispatchContext,
	type DispatchLatencyReport,
	formatLatencyReport,
	getLatencyReports,
	type RunnerLatency,
} from "./dispatcher.js";
import type { BaselineStore, DispatchResult, PiAgentAPI } from "./types.js";

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
): Promise<string> {
	// By default, only run BLOCKING rules for fast feedback on file write
	// Uses persistent sessionBaselines so delta mode actually filters
	// pre-existing issues after the first write.
	const ctx = createDispatchContext(filePath, cwd, pi, sessionBaselines, true);

	// Import dispatchForFile dynamically to avoid circular deps
	const { dispatchForFile } = await import("./dispatcher.js");
	const { getRunnersForKind } = await import("./dispatcher.js");
	const { TOOL_PLANS } = await import("./plan.js");

	const kind = ctx.kind;
	if (!kind) return "";

	const plan = TOOL_PLANS[kind];
	if (!plan) return "";

	const result = await dispatchForFile(ctx, plan.groups);
	return result.output;
}

/**
 * Run linting and return full result (including diagnostics for TDR)
 */
export async function dispatchLintWithResult(
	filePath: string,
	cwd: string,
	pi: PiAgentAPI,
): Promise<DispatchResult> {
	const ctx = createDispatchContext(filePath, cwd, pi, sessionBaselines, true);

	const { dispatchForFile } = await import("./dispatcher.js");
	const { getRunnersForKind } = await import("./dispatcher.js");
	const { TOOL_PLANS } = await import("./plan.js");

	const kind = ctx.kind;
	if (!kind) {
		return {
			diagnostics: [],
			blockers: [],
			warnings: [],
			fixed: [],
			output: "",
			hasBlockers: false,
		};
	}

	const plan = TOOL_PLANS[kind];
	if (!plan) {
		return {
			diagnostics: [],
			blockers: [],
			warnings: [],
			fixed: [],
			output: "",
			hasBlockers: false,
		};
	}

	return await dispatchForFile(ctx, plan.groups);
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

	const { getRunnersForKind } = await import("./dispatcher.js");
	const runners = getRunnersForKind(kind);
	return runners.map((r) => r.id);
}
