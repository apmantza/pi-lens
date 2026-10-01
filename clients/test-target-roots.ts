/**
 * Which checkout root owns turn_end test selection for one edit (#3871).
 *
 * Its own module for the same reason as `knip-scan-roots.ts`: a pure,
 * synchronous resolver that `runtime-turn.ts` can import without pulling
 * `test-runner-client.ts`'s awaits into a one-hop pin set.
 */

import { dirname } from "node:path";
import {
	type GitCheckout,
	resolveGitCheckout,
	resolveLinkedWorktreeOwner,
} from "./review-graph/git-identity.js";

/**
 * A per-turn resolver: the root that owns `absoluteFile`. An edit belongs to
 * the checkout that owns it. The session cwd keeps every edit it owned before,
 * and every edit whose owner is unresolvable or an unrelated repository (a
 * submodule, a nested clone): those stay foreign and `isExcludedTestTarget`
 * rejects them exactly as it did. Only a LINKED WORKTREE of the session's
 * repository (same commondir, different top level) is its own root: tests for
 * an edit there run in that worktree, with its own config and `node_modules`,
 * never against the session checkout. A worktree root is returned in the
 * spelling `absoluteFile` used (the spelling the turn's file keys carry).
 *
 * There is deliberately no per-turn cap on roots (#3871 r2): a root costs
 * about 0.2 ms of synchronous probing, and the spawns it leads to are already
 * bounded by `TEST_RUNNER_MAX_TARGETS`, so a cap only starved the fourth
 * worktree's tests.
 */
export function createTurnEndTestRoots(
	sessionCwd: string,
): (absoluteFile: string) => string {
	const session = resolveGitCheckout(sessionCwd);
	const ownerByDir = new Map<string, GitCheckout | null>();
	return (absoluteFile) => {
		if (session === null) return sessionCwd;
		const dir = dirname(absoluteFile);
		let owner = ownerByDir.get(dir);
		if (owner === undefined) {
			owner = resolveLinkedWorktreeOwner(session, absoluteFile);
			ownerByDir.set(dir, owner);
		}
		return owner === null ? sessionCwd : owner.spelledRoot;
	};
}
