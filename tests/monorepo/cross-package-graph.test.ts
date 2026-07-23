/**
 * Track B (#775) item 1 — cross-package graph edges, post-#777.
 *
 * #777 taught `resolveJsTs`/`localImportToFile` to resolve a bare specifier
 * matching a known workspace package name (entry or subpath) to a file-level
 * edge instead of treating it as external. `tests/clients/review-graph.service.test.ts`
 * already pins the graph-edge shape directly; this file re-verifies the same
 * behavior through the shared fixture builder AND extends it one level up the
 * stack to `module_report`'s `usedBy`/blast-radius (the actual reader-facing
 * surface the audit's risk #2 was about) plus the module-level impact-cascade
 * fallback (`computeImpactCascade`'s `moduleGraph` parameter, query.ts:189-206).
 */

import { afterEach, describe, expect, it } from "vitest";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import {
	buildOrUpdateGraph,
	computeImpactCascade,
} from "../../clients/review-graph/service.js";
import {
	clearReviewGraphWorkspaceCache,
	getCachedReviewGraph,
} from "../../clients/review-graph/builder.js";
import { clearModuleGraphCache } from "../../clients/review-graph/workspace-modules.js";
import { moduleReport } from "../../clients/module-report.js";
import { makeMonorepo, type Monorepo } from "./fixture.js";

function twoPackageFixture(): Monorepo {
	return makeMonorepo({
		packages: [
			{
				name: "@scope/a",
				dir: "packages/a",
				deps: ["@scope/b", "react"],
				files: {
					"src/index.ts": [
						"import { b } from '@scope/b';",
						"import { util } from '@scope/b/src/utils';",
						"import React from 'react';",
						"export function useB() {",
						"  return b + util + typeof React;",
						"}",
						"",
					].join("\n"),
				},
			},
			{
				name: "@scope/b",
				dir: "packages/b",
				main: "src/index.ts",
				files: {
					"src/index.ts": "export const b = 1;\n",
					"src/utils.ts": "export const util = 2;\n",
				},
			},
		],
	});
}

describe("monorepo cross-package graph edges (#775 item 1)", () => {
	afterEach(() => {
		clearReviewGraphWorkspaceCache();
		clearModuleGraphCache();
	});

	it("entry-specifier import resolves to a file-level edge into the sibling package", async () => {
		const repo = twoPackageFixture();
		try {
			const aEntry = repo.filePath("@scope/a", "src/index.ts");
			const bEntry = repo.filePath("@scope/b", "src/index.ts");

			const graph = await buildOrUpdateGraph(repo.root, [], new FactStore());
			const aId = `file:${normalizeMapKey(aEntry)}`;
			const bId = `file:${normalizeMapKey(bEntry)}`;
			expect(graph.nodes.has(bId)).toBe(true);
			expect(
				graph.edges.some(
					(e) => e.from === aId && e.to === bId && e.kind === "imports",
				),
			).toBe(true);
		} finally {
			repo.cleanup();
		}
	});

	it("subpath specifier resolves to the specific file within the sibling package", async () => {
		const repo = twoPackageFixture();
		try {
			const aEntry = repo.filePath("@scope/a", "src/index.ts");
			const bUtils = repo.filePath("@scope/b", "src/utils.ts");

			const graph = await buildOrUpdateGraph(repo.root, [], new FactStore());
			const aId = `file:${normalizeMapKey(aEntry)}`;
			const utilsId = `file:${normalizeMapKey(bUtils)}`;
			expect(
				graph.edges.some(
					(e) => e.from === aId && e.to === utilsId && e.kind === "imports",
				),
			).toBe(true);
		} finally {
			repo.cleanup();
		}
	});

	it("a bare specifier NOT matching any workspace package stays external", async () => {
		const repo = twoPackageFixture();
		try {
			const aEntry = repo.filePath("@scope/a", "src/index.ts");
			const graph = await buildOrUpdateGraph(repo.root, [], new FactStore());
			const aId = `file:${normalizeMapKey(aEntry)}`;
			expect(
				graph.edges.some(
					(e) =>
						e.from === aId && e.kind === "imports" && e.to === "external:react",
				),
			).toBe(true);
		} finally {
			repo.cleanup();
		}
	});

	it("module_report's usedBy sees the cross-package dependent (blast radius, #775 risk #2)", async () => {
		const repo = twoPackageFixture();
		try {
			const aEntry = repo.filePath("@scope/a", "src/index.ts");
			const bEntry = repo.filePath("@scope/b", "src/index.ts");

			// Warm the graph first (module_report is a READ-ONLY consumer of the
			// cached graph — it never builds one itself, #256).
			await buildOrUpdateGraph(repo.root, [], new FactStore());
			expect(getCachedReviewGraph(repo.root)).toBeDefined();

			const report = await moduleReport(bEntry, repo.root, { blastRadius: true });
			expect(report.provenance?.usedBy).toBe("cached-review-graph");
			// b's blast radius must include a's file — the reader-facing "who uses
			// this" surface actually sees the cross-package import edge that #777
			// added, not just the raw graph.
			const blastFiles = (report.blastRadius?.files ?? []).map((f) => f.file);
			expect(
				blastFiles.some((p) => p.replace(/\\/g, "/").endsWith("packages/a/src/index.ts")),
			).toBe(true);
			void aEntry;
		} finally {
			repo.cleanup();
		}
	});

	it("computeImpactCascade's module-level downstream expansion sees @scope/a as a dependent of @scope/b when cwd is passed", async () => {
		const repo = twoPackageFixture();
		try {
			const bEntry = repo.filePath("@scope/b", "src/index.ts");
			const graph = await buildOrUpdateGraph(repo.root, [], new FactStore());

			// Without cwd the moduleGraph fallback never engages (query.ts:191-206
			// requires a non-null moduleGraph) — see impact-cascade-cwd.test.ts for
			// the full pin of this distinction (#775 open question 7).
			const withoutCwd = computeImpactCascade(graph, bEntry);
			const withCwd = computeImpactCascade(graph, bEntry, repo.root);

			// The file-level `imports` edge already puts a's file in neighborFiles
			// regardless of the module graph, so assert on the module-level risk
			// flag instead, which ONLY appears via the moduleGraph downstream path.
			expect(
				withoutCwd.riskFlags.some((f) => f.includes("downstream module file")),
			).toBe(false);
			expect(
				withCwd.riskFlags.some((f) => f.includes("downstream module file")),
			).toBe(true);
		} finally {
			repo.cleanup();
		}
	});
});
