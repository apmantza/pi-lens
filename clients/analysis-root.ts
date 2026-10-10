/**
 * Classifies the root that owns one file for tool_result bookkeeping.
 *
 * This is deliberately a pure decision seam over the existing path and git
 * identity helpers. Callers may admit only the modes they own; in particular,
 * `adopted` remains a no-op until the adopted-root analysis slice lands.
 */

import * as os from "node:os";
import { isUnderDir, isVendorPath } from "./path-utils.js";
import { isPiLensInternalPath } from "./file-utils.js";
import {
	resolveGitCheckout,
	resolveLinkedWorktreeOwner,
} from "./review-graph/git-identity.js";

export type AnalysisRootMode =
	| "session"
	| "linked-worktree"
	| "adopted"
	| "none";

export function resolveAnalysisRoot(
	filePath: string,
	sessionRoot: string,
): AnalysisRootMode {
	if (isVendorPath(filePath)) return "none";
	// Root-keyed state must never be attributed to a container/root itself, or
	// to a path that contains the session. These are housekeeping/ownership
	// boundaries, not analysis projects.
	if (
		filePath === os.tmpdir() ||
		filePath === sessionRoot ||
		isUnderDir(sessionRoot, filePath) ||
		(!isUnderDir(filePath, sessionRoot) &&
			isPiLensInternalPath(filePath, sessionRoot))
	)
		return "none";
	if (isUnderDir(filePath, sessionRoot)) return "session";

	const session = resolveGitCheckout(sessionRoot);
	if (session && resolveLinkedWorktreeOwner(session, filePath)) {
		return "linked-worktree";
	}

	// `clients/lsp/index.ts` keeps its async marker-root discovery separate: it
	// needs initialized server roots and trust policy, while this seam must be a
	// synchronous classification shared by tool_result writers. The caller may
	// later adopt that LSP root; until then this mode is gated by every writer.
	return "adopted";
}

export function canWriteAnalysisRoot(mode: AnalysisRootMode): boolean {
	return mode === "session" || mode === "linked-worktree";
}
