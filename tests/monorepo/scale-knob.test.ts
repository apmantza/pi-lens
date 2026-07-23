/**
 * Track B (#775) item 3 — scale knob end-to-end (post-#779).
 *
 * A `.pi-lens.json` with a small `maxProjectFiles` at the monorepo root
 * actually changes the EFFECTIVE startup-scan and review-graph budgets,
 * observed via behavior (a verdict/build-skip flip), not just via the
 * `project-scale.ts` getters (already unit-tested in
 * `tests/clients/project-scale.test.ts`).
 */

import { afterEach, describe, expect, it } from "vitest";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import { resolveStartupScanContext } from "../../clients/startup-scan.js";
import { buildOrUpdateGraph } from "../../clients/review-graph/service.js";
import {
	clearGraphCache,
	clearReviewGraphWorkspaceCache,
	getLastGraphBuildInfo,
} from "../../clients/review-graph/builder.js";
import { clearModuleGraphCache } from "../../clients/review-graph/workspace-modules.js";
import { resetProjectLensConfigCache } from "../../clients/project-lens-config.js";
import { makeMonorepo, type MonorepoPackageSpec } from "./fixture.js";

function fileMap(count: number): Record<string, string> {
	const files: Record<string, string> = {};
	for (let i = 0; i < count; i++) {
		files[`src/file${i}.ts`] = `export const v${i} = ${i};\n`;
	}
	return files;
}

describe("monorepo .pi-lens.json maxProjectFiles scale knob, end-to-end (#775 item 3, post-#779)", () => {
	afterEach(() => {
		resetProjectLensConfigCache();
		clearReviewGraphWorkspaceCache();
		clearModuleGraphCache();
	});

	it("a root .pi-lens.json maxProjectFiles=3 flips the startup-scan verdict at its derived (1x) source-file budget", () => {
		// startupScan ratio is 1x maxProjectFiles (project-scale.ts), so
		// maxProjectFiles: 3 derives a startup-scan budget of 3 source files.
		const pkg: MonorepoPackageSpec = {
			name: "@scope/a",
			dir: "packages/a",
			files: fileMap(4), // one over the derived budget
		};
		const repo = makeMonorepo({
			packages: [pkg],
			rootPiLensConfig: { maxProjectFiles: 3 },
		});
		try {
			const ctx = resolveStartupScanContext(repo.root, {
				homeDir: repo.root + "-not-home",
				// No explicit maxSourceFiles override — let the derived value from
				// the fixture's own .pi-lens.json flow through.
			});
			expect(ctx.canWarmCaches).toBe(false);
			expect(ctx.reason).toBe("too-many-source-files");
		} finally {
			repo.cleanup();
		}
	});

	it("the SAME fixture warms fine under a larger maxProjectFiles (proves the .pi-lens.json value, not a hardcoded default, drove the flip)", () => {
		const pkg: MonorepoPackageSpec = {
			name: "@scope/a",
			dir: "packages/a",
			files: fileMap(4),
		};
		const repo = makeMonorepo({
			packages: [pkg],
			rootPiLensConfig: { maxProjectFiles: 100 },
		});
		try {
			const ctx = resolveStartupScanContext(repo.root, {
				homeDir: repo.root + "-not-home",
			});
			expect(ctx.canWarmCaches).toBe(true);
		} finally {
			repo.cleanup();
		}
	});

	it("a root .pi-lens.json maxProjectFiles=2 flips the review-graph build to skipped at its derived (0.5x) file budget", async () => {
		// reviewGraph ratio is 0.5x maxProjectFiles, so maxProjectFiles: 2 derives
		// a review-graph cap of 1 file — this fixture's 2 source files exceed it.
		const pkg: MonorepoPackageSpec = {
			name: "@scope/a",
			dir: "packages/a",
			files: fileMap(2),
		};
		const repo = makeMonorepo({
			packages: [pkg],
			rootPiLensConfig: { maxProjectFiles: 2 },
		});
		try {
			clearGraphCache();
			const graph = await buildOrUpdateGraph(repo.root, [], new FactStore());
			expect(graph.nodes.size).toBe(0);
			expect(getLastGraphBuildInfo().skipReason).toBe("too_many_files");
		} finally {
			repo.cleanup();
		}
	});

	it("the SAME fixture builds fine under a larger maxProjectFiles", async () => {
		const pkg: MonorepoPackageSpec = {
			name: "@scope/a",
			dir: "packages/a",
			files: fileMap(2),
		};
		const repo = makeMonorepo({
			packages: [pkg],
			rootPiLensConfig: { maxProjectFiles: 100 },
		});
		try {
			clearGraphCache();
			const graph = await buildOrUpdateGraph(repo.root, [], new FactStore());
			expect(graph.nodes.size).toBeGreaterThan(0);
			expect(getLastGraphBuildInfo().skipReason).toBeUndefined();
		} finally {
			repo.cleanup();
		}
	});
});
