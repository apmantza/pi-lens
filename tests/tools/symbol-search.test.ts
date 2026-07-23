/**
 * symbol_search pi tool (#348) — cold (available:false + hint + background
 * build kicked once) and warm (ranked results) paths, per the #517-slimmed
 * payload (startLine/endLine, no per-hit `read` block, no repeated path array).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import { PROJECT_SNAPSHOT_VERSION, saveProjectSnapshot } from "../../clients/project-snapshot.js";
import {
	buildOrUpdateGraph,
	clearReviewGraphWorkspaceCache,
	getCachedReviewGraph,
} from "../../clients/review-graph/builder.js";
import { buildWordIndex, serializeWordIndex, _resetWordIndexBuildGuardForTests } from "../../clients/word-index.js";
import { createSymbolSearchTool } from "../../tools/symbol-search.js";
import { createTempFile, setupTestEnvironment } from "../clients/test-utils.js";

afterEach(() => {
	_resetWordIndexBuildGuardForTests();
	clearReviewGraphWorkspaceCache();
});

function warmWordIndexSnapshot(
	tmpDir: string,
	files: Array<{ path: string; content: string }>,
): void {
	const index = buildWordIndex(files);
	saveProjectSnapshot(tmpDir, {
		version: PROJECT_SNAPSHOT_VERSION,
		projectRoot: tmpDir,
		generatedAt: new Date().toISOString(),
		seq: 0,
		files: {},
		symbols: {},
		reverseDeps: {},
		cachedExports: [],
		wordIndex: serializeWordIndex(index),
	});
}

describe("symbol_search tool", () => {
	it("cold path: returns available:false with an actionable hint and kicks off a background build", async () => {
		const env = setupTestEnvironment("pi-lens-symbolsearch-cold-");
		try {
			createTempFile(
				env.tmpDir,
				"src/auth.ts",
				"export function authenticateUser(id) { return id; }",
			);
			const tool = createSymbolSearchTool(() => env.tmpDir);
			const result = await tool.execute(
				"1",
				{ query: "authenticate user" },
				undefined,
				null,
				{ cwd: env.tmpDir },
			);
			expect(result.isError).toBe(true);
			expect(result.details).toMatchObject({ available: false, query: "authenticate user" });
			expect(String((result.details as { hint?: string }).hint)).toMatch(/background|retry/i);
			expect(String(result.content[0]?.text)).toMatch(/background|retry/i);

			// The cold query kicked off a bounded background build (#348 decision 3) —
			// never blocking THIS call, but the index should show up shortly after.
			const { loadProjectSnapshot } = await import("../../clients/project-snapshot.js");
			await vi.waitFor(
				() => {
					const snapshot = loadProjectSnapshot(env.tmpDir);
					expect(snapshot?.wordIndex).toBeDefined();
				},
				{ timeout: 5000 },
			);
		} finally {
			env.cleanup();
		}
	}, 10_000);

	it("warm path: returns ranked results with startLine/endLine, no per-hit read block, path relative to cwd", async () => {
		const env = setupTestEnvironment("pi-lens-symbolsearch-warm-");
		try {
			const authFile = createTempFile(
				env.tmpDir,
				"src/auth.ts",
				"export function authenticateUser(id) {\n  return id;\n}\n",
			);
			const index = buildWordIndex([
				{ path: authFile, content: "export function authenticateUser(id) {\n  return id;\n}\n" },
			]);
			saveProjectSnapshot(env.tmpDir, {
				version: PROJECT_SNAPSHOT_VERSION,
				projectRoot: env.tmpDir,
				generatedAt: new Date().toISOString(),
				seq: 0,
				files: {},
				symbols: {},
				reverseDeps: {},
				cachedExports: [],
				wordIndex: serializeWordIndex(index),
			});

			const tool = createSymbolSearchTool(() => env.tmpDir);
			const result = await tool.execute(
				"1",
				{ query: "authenticate user" },
				undefined,
				null,
				{ cwd: env.tmpDir },
			);
			expect(result.isError).toBeFalsy();
			expect(result.details).toMatchObject({ available: true, count: 1 });

			const text = String(result.content[0]?.text);
			const jsonStart = text.indexOf("{");
			const payload = JSON.parse(text.slice(jsonStart)) as {
				available: boolean;
				query: string;
				results: Array<{
					file: string;
					score: number;
					hits: number;
					startLine: number;
					endLine: number;
					read?: unknown;
					lines?: unknown;
				}>;
			};
			expect(payload.available).toBe(true);
			expect(payload.results).toHaveLength(1);
			const hit = payload.results[0];
			expect(hit.file.replace(/\\/g, "/")).toBe("src/auth.ts"); // relative to cwd, not repeated/absolute
			expect(hit.startLine).toBeGreaterThan(0);
			expect(hit.endLine).toBe(hit.startLine); // single-line span (no fabricated full-file range)
			// #517 conformity: no per-hit `read` block, no raw `lines[]` array on the wire.
			expect(hit.read).toBeUndefined();
			expect(hit.lines).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("warm path with no matches returns available:true, empty results, not an error", async () => {
		const env = setupTestEnvironment("pi-lens-symbolsearch-nomatch-");
		try {
			const index = buildWordIndex([
				{ path: "src/widget.ts", content: "export function renderWidget() {}" },
			]);
			saveProjectSnapshot(env.tmpDir, {
				version: PROJECT_SNAPSHOT_VERSION,
				projectRoot: env.tmpDir,
				generatedAt: new Date().toISOString(),
				seq: 0,
				files: {},
				symbols: {},
				reverseDeps: {},
				cachedExports: [],
				wordIndex: serializeWordIndex(index),
			});

			const tool = createSymbolSearchTool(() => env.tmpDir);
			const result = await tool.execute(
				"1",
				{ query: "kubernetes helm chart" },
				undefined,
				null,
				{ cwd: env.tmpDir },
			);
			expect(result.isError).toBeFalsy();
			expect(result.details).toMatchObject({ available: true, count: 0 });
		} finally {
			env.cleanup();
		}
	});

	// #771: `paths`/`lang` scope hits before ranking; omitting them reproduces
	// today's output. Every hit also carries a `suggestedNext` discovery hint.
	describe("paths/lang filters + suggestedNext (#771)", () => {
		function makeFixture(env: { tmpDir: string }) {
			const tsFile = createTempFile(
				env.tmpDir,
				"src/auth/login.ts",
				"export function authenticateUser(id) { return id; }",
			);
			const pyFile = createTempFile(
				env.tmpDir,
				"scripts/authenticate.py",
				"def authenticate_user(id):\n    return id\n",
			);
			warmWordIndexSnapshot(env.tmpDir, [
				{ path: tsFile, content: "export function authenticateUser(id) { return id; }" },
				{
					path: pyFile,
					content: "def authenticate_user(id):\n    return id\n",
				},
			]);
			return { tsFile, pyFile };
		}

		it("omitting paths/lang returns identical output to today (both files ranked)", async () => {
			const env = setupTestEnvironment("pi-lens-symbolsearch-nofilter-");
			try {
				makeFixture(env);
				const tool = createSymbolSearchTool(() => env.tmpDir);
				const result = await tool.execute(
					"1",
					{ query: "authenticate user" },
					undefined,
					null,
					{ cwd: env.tmpDir },
				);
				const text = String(result.content[0]?.text);
				const payload = JSON.parse(text.slice(text.indexOf("{"))) as {
					results: Array<{ file: string }>;
				};
				expect(payload.results.map((r) => r.file.replace(/\\/g, "/")).sort()).toEqual(
					["scripts/authenticate.py", "src/auth/login.ts"].sort(),
				);
			} finally {
				env.cleanup();
			}
		});

		it("`lang` filters hits before ranking to one language", async () => {
			const env = setupTestEnvironment("pi-lens-symbolsearch-lang-");
			try {
				makeFixture(env);
				const tool = createSymbolSearchTool(() => env.tmpDir);
				const result = await tool.execute(
					"1",
					{ query: "authenticate user", lang: "python" },
					undefined,
					null,
					{ cwd: env.tmpDir },
				);
				const text = String(result.content[0]?.text);
				const payload = JSON.parse(text.slice(text.indexOf("{"))) as {
					results: Array<{ file: string }>;
				};
				expect(payload.results).toHaveLength(1);
				expect(payload.results[0].file.replace(/\\/g, "/")).toBe(
					"scripts/authenticate.py",
				);
			} finally {
				env.cleanup();
			}
		});

		it("`paths` glob scopes hits to matching files (same shape as ast_grep_search)", async () => {
			const env = setupTestEnvironment("pi-lens-symbolsearch-paths-");
			try {
				makeFixture(env);
				const tool = createSymbolSearchTool(() => env.tmpDir);
				const result = await tool.execute(
					"1",
					{ query: "authenticate user", paths: ["src"] },
					undefined,
					null,
					{ cwd: env.tmpDir },
				);
				const text = String(result.content[0]?.text);
				const payload = JSON.parse(text.slice(text.indexOf("{"))) as {
					results: Array<{ file: string }>;
				};
				expect(payload.results).toHaveLength(1);
				expect(payload.results[0].file.replace(/\\/g, "/")).toBe("src/auth/login.ts");
			} finally {
				env.cleanup();
			}
		});

		it("attaches a suggestedNext module_report hint per hit", async () => {
			const env = setupTestEnvironment("pi-lens-symbolsearch-suggestednext-");
			try {
				const { tsFile } = makeFixture(env);
				void tsFile;
				const tool = createSymbolSearchTool(() => env.tmpDir);
				const result = await tool.execute(
					"1",
					{ query: "authenticate user" },
					undefined,
					null,
					{ cwd: env.tmpDir },
				);
				const text = String(result.content[0]?.text);
				const payload = JSON.parse(text.slice(text.indexOf("{"))) as {
					results: Array<{
						file: string;
						suggestedNext?: { tool: string; path: string };
					}>;
				};
				expect(payload.results.length).toBeGreaterThan(0);
				for (const hit of payload.results) {
					expect(hit.suggestedNext).toEqual({
						tool: "module_report",
						path: hit.file,
					});
				}
			} finally {
				env.cleanup();
			}
		});
	});

	// #771: graph-aware hit annotations — read-only, present only when the
	// cached review graph happens to be warm; a cold cache must neither
	// annotate nor trigger a build (the tool's latency profile is unchanged).
	describe("graph-aware annotations (#771)", () => {
		it("cold graph: no annotations, and no graph build is triggered", async () => {
			const env = setupTestEnvironment("pi-lens-symbolsearch-graphcold-");
			try {
				createTempFile(
					env.tmpDir,
					"src/auth.ts",
					"export function authenticateUser(id) { return id; }",
				);
				warmWordIndexSnapshot(env.tmpDir, [
					{
						path: "src/auth.ts",
						content: "export function authenticateUser(id) { return id; }",
					},
				]);
				expect(getCachedReviewGraph(env.tmpDir)).toBeUndefined();

				const tool = createSymbolSearchTool(() => env.tmpDir);
				const result = await tool.execute(
					"1",
					{ query: "authenticate user" },
					undefined,
					null,
					{ cwd: env.tmpDir },
				);
				const text = String(result.content[0]?.text);
				const payload = JSON.parse(text.slice(text.indexOf("{"))) as {
					results: Array<{ annotations?: unknown }>;
				};
				expect(payload.results.length).toBeGreaterThan(0);
				for (const hit of payload.results) {
					expect(hit.annotations).toBeUndefined();
				}
				// The read-only accessor must not have built/cached a graph as a
				// side effect of this call.
				expect(getCachedReviewGraph(env.tmpDir)).toBeUndefined();
			} finally {
				env.cleanup();
			}
		});

		it("warm graph: annotates hits with fanIn/complexity signals", async () => {
			const env = setupTestEnvironment("pi-lens-symbolsearch-graphwarm-");
			try {
				const authFile = createTempFile(
					env.tmpDir,
					"src/auth.ts",
					[
						"export function authenticateUser(id) {",
						"  if (id) {",
						"    return id;",
						"  }",
						"  return null;",
						"}",
					].join("\n"),
				);
				warmWordIndexSnapshot(env.tmpDir, [
					{
						path: authFile,
						content: [
							"export function authenticateUser(id) {",
							"  if (id) {",
							"    return id;",
							"  }",
							"  return null;",
							"}",
						].join("\n"),
					},
				]);
				await buildOrUpdateGraph(env.tmpDir, [], new FactStore());
				expect(getCachedReviewGraph(env.tmpDir)).toBeDefined();

				const tool = createSymbolSearchTool(() => env.tmpDir);
				const result = await tool.execute(
					"1",
					{ query: "authenticate user" },
					undefined,
					null,
					{ cwd: env.tmpDir },
				);
				const text = String(result.content[0]?.text);
				const payload = JSON.parse(text.slice(text.indexOf("{"))) as {
					results: Array<{ annotations?: { fanIn: number; complexity?: number } }>;
				};
				expect(payload.results.length).toBeGreaterThan(0);
				const hit = payload.results[0];
				expect(hit.annotations).toBeDefined();
				expect(typeof hit.annotations?.fanIn).toBe("number");
			} finally {
				env.cleanup();
			}
		});
	});
});
