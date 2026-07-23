/**
 * Track B (#775) item 7 — impact-cascade cwd (audit open question): is `cwd`
 * reliably populated in the real call chain, so `computeImpactCascade`'s
 * workspace module-graph fallback (query.ts:189-206, `moduleGraph` param)
 * actually engages?
 *
 * Empirical finding: it depends on the caller.
 *   - `dispatch/integration.ts:858` (the primary per-edit cascade path,
 *     `computeCascadeForFile`) DOES pass `cwd` through to
 *     `service.computeImpactCascade(graph, normalizedFile, cwd)` — the
 *     module-graph fallback engages there.
 *   - `dispatch/runners/tree-sitter.ts`'s `runBlastRadiusInBackground` (the
 *     OTHER real caller, feeding cascade.log's background blast-radius
 *     enrichment) calls `computeImpactCascade(graph, filePath)` — WITHOUT
 *     `cwd` — even though `cwd` is already a parameter in scope at that call
 *     site (see the function signature). KNOWN GAP (#775): this path's
 *     workspace module-graph fallback can never engage, so its cross-package
 *     downstream-module risk flag is silently unavailable — not because cwd
 *     is unavailable, but because it's dropped at the call site.
 *
 * This file pins the observed difference at the `service.ts` seam directly
 * (with vs. without `cwd`) using a monorepo fixture where the module-level
 * fallback is the ONLY thing that can surface a cross-package dependent (a
 * package with no direct file-level import edge to the changed file, only a
 * workspace dependency edge).
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
		"KNOWN GAP (#775): dispatch/runners/tree-sitter.ts's runBlastRadiusInBackground calls computeImpactCascade WITHOUT cwd despite having it in scope — reproduced here by calling the service function the same way that call site does",
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
				// Mirrors dispatch/runners/tree-sitter.ts:54's exact call shape
				// (`computeImpactCascade(graph, filePath)`, cwd available in the
				// enclosing scope but not threaded through).
				const impact = computeImpactCascade(graph, bEntry);
				expect(
					impact.riskFlags.some((f) => f.includes("downstream module")),
				).toBe(false);
			} finally {
				repo.cleanup();
			}
		},
	);
});
