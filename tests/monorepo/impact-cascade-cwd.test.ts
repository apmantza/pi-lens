/**
 * Track B (#775) item 7 — impact-cascade cwd (audit open question): is `cwd`
 * reliably populated in the real call chain, so `computeImpactCascade`'s
 * workspace module-graph fallback (query.ts:189-206, `moduleGraph` param)
 * actually engages?
 *
 * Both real callers now pass `cwd` through:
 *   - `dispatch/integration.ts:858` (the primary per-edit cascade path,
 *     `computeCascadeForFile`) passes `cwd` through to
 *     `service.computeImpactCascade(graph, normalizedFile, cwd)`.
 *   - `dispatch/runners/tree-sitter.ts`'s `runBlastRadiusInBackground` (the
 *     OTHER real caller, feeding cascade.log's background blast-radius
 *     enrichment) now also calls `computeImpactCascade(graph, filePath, cwd)`
 *     — fixed in #781, where `cwd` was previously dropped at the call site
 *     despite being in scope.
 *
 * This file pins the observed difference at the `service.ts` seam directly
 * (with vs. without `cwd`) using a monorepo fixture where the module-level
 * fallback is the ONLY thing that can surface a cross-package dependent (a
 * package with no direct file-level import edge to the changed file, only a
 * workspace dependency edge), and confirms the tree-sitter.ts background
 * blast-radius call site engages that fallback now that `cwd` is threaded
 * through.
 */

import { afterEach, describe, expect, it } from "vitest";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import { buildOrUpdateGraph, computeImpactCascade } from "../../clients/review-graph/service.js";
import { clearReviewGraphWorkspaceCache } from "../../clients/review-graph/builder.js";
import { clearModuleGraphCache } from "../../clients/review-graph/workspace-modules.js";
import { makeMonorepo } from "./fixture.js";

describe("computeImpactCascade's module-graph fallback requires cwd (#775 item 7)", () => {
	afterEach(() => {
		clearReviewGraphWorkspaceCache();
		clearModuleGraphCache();
	});

	it("without cwd: no downstream-module risk flag, even though @scope/a workspace-depends on @scope/b", async () => {
		const repo = makeMonorepo({
			packages: [
				{
					name: "@scope/a",
					dir: "packages/a",
					deps: ["@scope/b"],
					// No source-level import at all — the ONLY relationship is the
					// package.json dependency edge the module graph scans for.
					files: { "src/index.ts": "export const a = 1;\n" },
				},
				{
					name: "@scope/b",
					dir: "packages/b",
					files: { "src/index.ts": "export const b = 1;\n" },
				},
			],
		});
		try {
			const bEntry = repo.filePath("@scope/b", "src/index.ts");
			const graph = await buildOrUpdateGraph(repo.root, [], new FactStore());

			const withoutCwd = computeImpactCascade(graph, bEntry);
			expect(withoutCwd.neighborFiles).not.toContain(
				repo.filePath("@scope/a", "src/index.ts"),
			);
			expect(
				withoutCwd.riskFlags.some((f) => f.includes("downstream module")),
			).toBe(false);

			const withCwd = computeImpactCascade(graph, bEntry, repo.root);
			expect(
				withCwd.riskFlags.some((f) => f.includes("downstream module")),
			).toBe(true);
		} finally {
			repo.cleanup();
		}
	});

	it(
		"fixed (#781): dispatch/runners/tree-sitter.ts's runBlastRadiusInBackground now calls computeImpactCascade WITH cwd, so the module-graph fallback engages — reproduced here by calling the service function the same way that call site does",
		async () => {
			const repo = makeMonorepo({
				packages: [
					{
						name: "@scope/a",
						dir: "packages/a",
						deps: ["@scope/b"],
						files: { "src/index.ts": "export const a = 1;\n" },
					},
					{
						name: "@scope/b",
						dir: "packages/b",
						files: { "src/index.ts": "export const b = 1;\n" },
					},
				],
			});
			try {
				const bEntry = repo.filePath("@scope/b", "src/index.ts");
				const graph = await buildOrUpdateGraph(repo.root, [], new FactStore());
				// Mirrors dispatch/runners/tree-sitter.ts:54's exact call shape post-#781
				// (`computeImpactCascade(graph, filePath, cwd)`, cwd now threaded
				// through from the enclosing scope).
				const impact = computeImpactCascade(graph, bEntry, repo.root);
				expect(
					impact.riskFlags.some((f) => f.includes("downstream module")),
				).toBe(true);
			} finally {
				repo.cleanup();
			}
		},
	);
});
