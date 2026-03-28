/**
 * Dispatch integration helpers
 *
 * Provides utilities for integrating the declarative dispatch system
 * with the existing index.ts tool_result handler.
 */

import { detectFileKind } from "../file-kinds.js";
import { createBaselineStore, createDispatchContext } from "./dispatcher.js";
import type { PiAgentAPI } from "./types.js";

// Import runners to register them
import "./runners/index.js";

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
	const ctx = createDispatchContext(filePath, cwd, pi);

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
