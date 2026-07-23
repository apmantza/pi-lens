/**
 * Track B (#775) item 2 — size-cliff behavior.
 *
 * Two independent cliffs, both driven to a TINY boundary via option/env
 * overrides so the fixture stays small (a handful of files, not thousands):
 *
 *  1. startup-scan's verdict flips exactly at `maxSourceFiles` (N vs N+1
 *     source files) — sync AND async.
 *  2. review-graph's build bails above `PI_LENS_REVIEW_GRAPH_MAX_FILES` — and
 *     this file pins WHAT the downstream experience is afterward (#775's open
 *     question: "exact fallback when graph build was size-skipped"):
 *       - `getCachedReviewGraph` returns `undefined` when no graph was ever
 *         built/persisted before the project crossed the cap — a fresh
 *         size-skipped build never writes the in-memory or on-disk cache
 *         (`builder.ts`'s `too_many_files` branch only calls
 *         `facts.setSessionFact`, never `_workspaceGraphCache.set`/
 *         `persistGraph`).
 *       - If a graph WAS already cached/persisted from BEFORE the project grew
 *         past the cap, `getCachedReviewGraph` keeps returning that STALE
 *         graph — the size-skip is invisible at the read layer once a prior
 *         warm graph exists. Marked KNOWN GAP below: a caller reading
 *         `module_report`/`symbol_search` after the repo crossed the cap has
 *         no way to tell "graph reflects a smaller, stale past state" from
 *         "graph is current."
 *       - `module_report`'s `usedBy`/`semantic.source` degrade to `"none"`
 *         exactly like an ordinary cold cache (no graph at all) — there is no
 *         distinct signal for "skipped for size" vs. "never warmed" at this
 *         read layer either.
 */

import { afterEach, describe, expect, it } from "vitest";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import {
	resolveStartupScanContext,
	resolveStartupScanContextAsync,
} from "../../clients/startup-scan.js";
import {
	buildOrUpdateGraph,
} from "../../clients/review-graph/service.js";
import {
	clearGraphCache,
	clearReviewGraphWorkspaceCache,
	getCachedReviewGraph,
	getLastGraphBuildInfo,
} from "../../clients/review-graph/builder.js";
import { clearModuleGraphCache } from "../../clients/review-graph/workspace-modules.js";
import { moduleReport } from "../../clients/module-report.js";
import { makeMonorepo, type Monorepo, type MonorepoPackageSpec } from "./fixture.js";

function fileMap(count: number): Record<string, string> {
	const files: Record<string, string> = {};
	for (let i = 0; i < count; i++) {
		files[`src/file${i}.ts`] = `export const v${i} = ${i};\n`;
	}
	return files;
}

function fixtureWithSourceFiles(count: number): Monorepo {
	const pkg: MonorepoPackageSpec = {
		name: "@scope/a",
		dir: "packages/a",
		files: fileMap(count),
	};
	return makeMonorepo({ packages: [pkg] });
}

const ENV_REVIEW_GRAPH_MAX = "PI_LENS_REVIEW_GRAPH_MAX_FILES";

describe("monorepo size-cliff behavior (#775 item 2)", () => {
	describe("startup-scan verdict flips exactly at the configured maxSourceFiles boundary", () => {
		it("sync: N files -> canWarmCaches true, N+1 -> false", () => {
			const atLimit = fixtureWithSourceFiles(3);
			const overLimit = fixtureWithSourceFiles(4);
			try {
				const okCtx = resolveStartupScanContext(atLimit.root, {
					homeDir: atLimit.root + "-not-home",
					maxSourceFiles: 3,
				});
				expect(okCtx.canWarmCaches).toBe(true);
				expect(okCtx.sourceFileCount).toBe(3);

				const overCtx = resolveStartupScanContext(overLimit.root, {
					homeDir: overLimit.root + "-not-home",
					maxSourceFiles: 3,
				});
				expect(overCtx.canWarmCaches).toBe(false);
				expect(overCtx.reason).toBe("too-many-source-files");
			} finally {
				atLimit.cleanup();
				overLimit.cleanup();
			}
		});

		it("async: N files -> canWarmCaches true, N+1 -> false", async () => {
			const atLimit = fixtureWithSourceFiles(3);
			const overLimit = fixtureWithSourceFiles(4);
			try {
				const okCtx = await resolveStartupScanContextAsync(atLimit.root, {
					homeDir: atLimit.root + "-not-home",
					maxSourceFiles: 3,
				});
				expect(okCtx.canWarmCaches).toBe(true);

				const overCtx = await resolveStartupScanContextAsync(overLimit.root, {
					homeDir: overLimit.root + "-not-home",
					maxSourceFiles: 3,
				});
				expect(overCtx.canWarmCaches).toBe(false);
				expect(overCtx.reason).toBe("too-many-source-files");
			} finally {
				atLimit.cleanup();
				overLimit.cleanup();
			}
		});
	});

	describe("review-graph build bails above its configured cap, and the downstream read layer degrades", () => {
		let previousEnv: string | undefined;

		afterEach(() => {
			if (previousEnv === undefined) delete process.env[ENV_REVIEW_GRAPH_MAX];
			else process.env[ENV_REVIEW_GRAPH_MAX] = previousEnv;
			clearReviewGraphWorkspaceCache();
			clearModuleGraphCache();
		});

		it("build skips (mode: skipped/too_many_files) once source files exceed the cap", async () => {
			previousEnv = process.env[ENV_REVIEW_GRAPH_MAX];
			process.env[ENV_REVIEW_GRAPH_MAX] = "3";
			const repo = fixtureWithSourceFiles(4);
			try {
				const graph = await buildOrUpdateGraph(repo.root, [], new FactStore());
				expect(graph.nodes.size).toBe(0);
				expect(graph.edges.length).toBe(0);
				const info = getLastGraphBuildInfo();
				expect(info.mode).toBe("skipped");
				expect(info.skipReason).toBe("too_many_files");
			} finally {
				repo.cleanup();
			}
		});

		it("getCachedReviewGraph is undefined after a size-skipped build with no prior warm graph", async () => {
			previousEnv = process.env[ENV_REVIEW_GRAPH_MAX];
			process.env[ENV_REVIEW_GRAPH_MAX] = "3";
			const repo = fixtureWithSourceFiles(4);
			try {
				await buildOrUpdateGraph(repo.root, [], new FactStore());
				expect(getCachedReviewGraph(repo.root)).toBeUndefined();
			} finally {
				repo.cleanup();
			}
		});

		it("module_report degrades usedBy/semantic.source to 'none' identically to a cold cache (#775 open question)", async () => {
			previousEnv = process.env[ENV_REVIEW_GRAPH_MAX];
			process.env[ENV_REVIEW_GRAPH_MAX] = "3";
			const repo = fixtureWithSourceFiles(4);
			try {
				await buildOrUpdateGraph(repo.root, [], new FactStore());
				const file = repo.filePath("@scope/a", "src/file0.ts");
				const report = await moduleReport(file, repo.root);
				expect(report.provenance?.usedBy).toBe("none");
				expect(report.semantic.source).toBe("none");
				// No warning distinguishes "size-skipped" from "never warmed" —
				// `graphBuiltAt` is simply absent, same as a truly cold cache.
				expect(report.graphBuiltAt).toBeUndefined();
			} finally {
				repo.cleanup();
			}
		});

		it(
			"KNOWN GAP (#775): getCachedReviewGraph keeps returning a STALE prior graph once the repo grows past the cap — the size-skip is invisible once a warm graph already existed",
			async () => {
				// Build once while still within budget, warming the in-memory
				// (tier-1) cache with a real, populated graph.
				process.env[ENV_REVIEW_GRAPH_MAX] = "10";
				const repo = fixtureWithSourceFiles(3);
				try {
					const firstBuild = await buildOrUpdateGraph(
						repo.root,
						[],
						new FactStore(),
					);
					expect(firstBuild.nodes.size).toBeGreaterThan(0);
					const cachedAfterFirstBuild = getCachedReviewGraph(repo.root);
					expect(cachedAfterFirstBuild).toBeDefined();
					const staleBuiltAt = cachedAfterFirstBuild?.builtAt;

					// ...then shrink the cap below the (unchanged) file count and rebuild
					// WITHOUT clearing the tier-1 workspace-graph cache first (mirrors
					// the real process-lifetime scenario: a repo grows past the cap
					// between two builds in the same running process; nothing evicts the
					// prior warm entry). `clearGraphCache()` only clears the (cwd,
					// changedFiles)-keyed in-flight/completed BUILD-CALL dedup cache —
					// otherwise this second call, with identical (cwd, []) arguments,
					// would just return the FIRST call's already-resolved promise
					// unchanged, never re-evaluating the (now-lowered) cap at all.
					previousEnv = process.env[ENV_REVIEW_GRAPH_MAX];
					process.env[ENV_REVIEW_GRAPH_MAX] = "1";
					clearGraphCache();

					const secondBuild = await buildOrUpdateGraph(
						repo.root,
						[],
						new FactStore(),
					);
					// This call's own RETURN VALUE is correctly empty (the
					// too_many_files branch never reads or writes the tier-1 cache)...
					expect(secondBuild.nodes.size).toBe(0);

					// ...but a READER going through the read-only accessor instead of the
					// builder's return value still sees the untouched, now-stale tier-1
					// entry from the first (under-cap) build — the size-skip never
					// invalidates it.
					const cachedAfterSecondBuild = getCachedReviewGraph(repo.root);
					expect(cachedAfterSecondBuild).toBeDefined();
					expect(cachedAfterSecondBuild?.builtAt).toBe(staleBuiltAt);
					expect(cachedAfterSecondBuild?.nodes.size).toBeGreaterThan(0);
				} finally {
					repo.cleanup();
				}
			},
		);
	});
});
