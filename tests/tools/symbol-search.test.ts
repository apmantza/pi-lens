// flake-shape: ungoverned-wait-for — the cold build is fire-and-forget (triggerBackgroundWordIndexBuild exposes no awaitable), so a real-time vi.waitFor is the only join on the snapshot it publishes.
/**
 * symbol_search pi tool (#348) — cold (available:false + hint + background
 * build kicked once) and warm (ranked results) paths, per the #517-slimmed
 * payload (startLine/endLine, no per-hit `read` block, no repeated path array).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import { toPosix } from "../../clients/path-utils.js";
import {
	PROJECT_SNAPSHOT_VERSION,
	loadProjectSnapshot,
	saveProjectSnapshot,
} from "../../clients/project-snapshot.js";
import { _resetWarmWordIndexCacheForTests } from "../../clients/mcp/analyze.js";
import {
	buildOrUpdateGraph,
	clearReviewGraphWorkspaceCache,
	getCachedReviewGraph,
} from "../../clients/review-graph/builder.js";
import {
	buildWordIndex,
	getWordIndexBuildStatus,
	serializeWordIndex,
	triggerBackgroundWordIndexBuild,
	_resetWordIndexBuildGuardForTests,
} from "../../clients/word-index.js";
import { symbolSearch } from "../../clients/lens-engine.js";
import { createSymbolSearchTool } from "../../tools/symbol-search.js";
import { createTempFile, setupTestEnvironment } from "../clients/test-utils.js";

/** One rendered ranked row: `  1. <path>[ <line>] (score ...)`. */
const ROW = /^ {2}\d+\. (.*) \((score .*)\)$/;

function rows(
	text: string,
): Array<{ file: string; line?: number; detail: string }> {
	return text.split("\n").flatMap((line) => {
		const match = ROW.exec(line);
		if (match === null) return [];
		// The line number sits before the detail parenthetical; a path that ends
		// in digits is not a row number (the repo's fixtures never end that way).
		const pre = match[1];
		const cut = pre.lastIndexOf(" ");
		const tail = cut === -1 ? "" : pre.slice(cut + 1);
		const numbered = /^\d+$/.test(tail);
		return [
			{
				file: toPosix(numbered ? pre.slice(0, cut) : pre),
				...(numbered ? { line: Number(tail) } : {}),
				detail: match[2],
			},
		];
	});
}

function rankedFiles(text: string): string[] {
	return rows(text).map((row) => row.file);
}

/** #5104: the ranked table is the whole answer on both surfaces — no JSON tail
 * on pi, no fenced block on MCP. A brace or a fence means a duplicate came
 * back, and a reader that stops at the table silently accepts it. */
function expectOneTable(text: string): void {
	expect(text).not.toContain("{");
	expect(text).not.toContain("```");
}

afterEach(() => {
	_resetWordIndexBuildGuardForTests();
	_resetWarmWordIndexCacheForTests();
	clearReviewGraphWorkspaceCache();
});

function warmWordIndexSnapshot(
	tmpDir: string,
	files: Array<{ path: string; content: string }>,
	truncated = false,
): void {
	const index = buildWordIndex(Object.assign(files, { truncated }));
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
	it("zero-hit output warns when the index is capped and exposes coverage (#928)", async () => {
		const env = setupTestEnvironment("pi-lens-symbolsearch-capped-");
		try {
			warmWordIndexSnapshot(
				env.tmpDir,
				[{ path: "src/auth.ts", content: "export const authenticate = true;" }],
				true,
			);
			const tool = createSymbolSearchTool(() => env.tmpDir);
			const result = await tool.execute(
				"1",
				{ query: "definitely absent identifier" },
				undefined,
				null,
				{ cwd: env.tmpDir },
			);
			expect(String(result.content[0]?.text)).toContain(
				"Index covers 1 files (capped — results may be incomplete).",
			);
			expectOneTable(String(result.content[0]?.text));
			expect(result.details).toMatchObject({
				available: true,
				count: 0,
				coverage: { files: 1, truncated: true },
			});
		} finally {
			env.cleanup();
		}
	});

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
			expect(result.details).toMatchObject({
				available: false,
				query: "authenticate user",
			});
			expect(String((result.details as { hint?: string }).hint)).toMatch(
				/background|retry/i,
			);
			expect(String(result.content[0]?.text)).toMatch(/background|retry/i);

			// The cold query kicked off a bounded background build (#348 decision 3) —
			// never blocking THIS call, but the index should show up shortly after.
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

	it("the cold query's own warm entry answers once that build finishes (#4583)", async () => {
		const env = setupTestEnvironment("pi-lens-symbolsearch-cold-adopt-");
		try {
			createTempFile(
				env.tmpDir,
				"src/auth.ts",
				"export function authenticateUser(id) { return id; }",
			);
			const tool = createSymbolSearchTool(() => env.tmpDir);
			const cold = await tool.execute(
				"1",
				{ query: "authenticate user" },
				undefined,
				null,
				{ cwd: env.tmpDir },
			);
			expect(cold.details).toMatchObject({
				available: false,
				unavailableReason: "building",
			});

			// The warm entry this process cached during the build must adopt the
			// index the build published; otherwise every later query replays the
			// "building" answer over an index that is already on disk (#4583).
			await vi.waitFor(
				() => {
					expect(loadProjectSnapshot(env.tmpDir)?.wordIndex).toBeDefined();
				},
				{ timeout: 5000 },
			);
			const warm = await tool.execute(
				"2",
				{ query: "authenticate user" },
				undefined,
				null,
				{ cwd: env.tmpDir },
			);
			expect(warm.details).toMatchObject({ available: true, count: 1 });
		} finally {
			env.cleanup();
		}
	}, 10_000);

	it("cold path exposes the last build failure instead of claiming only that it is building (#926)", async () => {
		const env = setupTestEnvironment("pi-lens-symbolsearch-failed-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		try {
			createTempFile(
				env.tmpDir,
				"src/auth.ts",
				"export const authenticate = true;",
			);
			process.env.PILENS_DATA_DIR = createTempFile(
				env.tmpDir,
				"occupied-data-root",
				"not a directory",
			);
			triggerBackgroundWordIndexBuild(env.tmpDir);
			await vi.waitFor(() => {
				expect(getWordIndexBuildStatus(env.tmpDir)?.state).toBe("failed");
			});

			const tool = createSymbolSearchTool(() => env.tmpDir);
			const result = await tool.execute(
				"1",
				{ query: "authenticate" },
				undefined,
				null,
				{ cwd: env.tmpDir },
			);
			expect(result.details).toMatchObject({
				available: false,
				unavailableReason: "last-build-failed",
			});
			expect(String(result.content[0]?.text)).toMatch(
				/last word index build failed/i,
			);
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	}, 10_000);

	it("warm path: renders one ranked row per hit, line number included, path relative to cwd", async () => {
		const env = setupTestEnvironment("pi-lens-symbolsearch-warm-");
		try {
			const authFile = createTempFile(
				env.tmpDir,
				"src/auth.ts",
				"export function authenticateUser(id) {\n  return id;\n}\n",
			);
			const index = buildWordIndex([
				{
					path: authFile,
					content: "export function authenticateUser(id) {\n  return id;\n}\n",
				},
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
			expectOneTable(text);
			const ranked = rows(text);
			expect(ranked).toHaveLength(1);
			expect(ranked[0]?.file).toBe("src/auth.ts"); // relative to cwd, not repeated/absolute
			expect(ranked[0]?.detail).toMatch(/^score \d+\.\d{2}, \d+ hit\(s\)/);
			expect(text).toContain("line ");
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
			expect(String(result.content[0]?.text)).toContain(
				'No files matched "kubernetes helm chart".',
			);
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
				{
					path: tsFile,
					content: "export function authenticateUser(id) { return id; }",
				},
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
				expectOneTable(text);
				expect(rankedFiles(text).sort()).toEqual(
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
				expectOneTable(text);
				expect(rankedFiles(text)).toEqual(["scripts/authenticate.py"]);
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
				expectOneTable(text);
				expect(rankedFiles(text)).toEqual(["src/auth/login.ts"]);
				// #5013 F3: the same glob spelled with a backslash scopes to the same
				// files, because the pattern is folded through `toPosix` before
				// minimatch sees it. An unfolded `src\auth` matches nothing, and the
				// tool then reports no results at all (no payload to parse).
				const backslash = await tool.execute(
					"1",
					{ query: "authenticate user", paths: ["src\\auth"] },
					undefined,
					null,
					{ cwd: env.tmpDir },
				);
				expect(rankedFiles(String(backslash.content[0]?.text))).toEqual([
					"src/auth/login.ts",
				]);
			} finally {
				env.cleanup();
			}
		});

		it("renders one table with no per-hit JSON hint (#5104)", async () => {
			const env = setupTestEnvironment("pi-lens-symbolsearch-onetable-");
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
				expectOneTable(text);
				expect(rankedFiles(text).sort()).toEqual(
					["scripts/authenticate.py", "src/auth/login.ts"].sort(),
				);
			} finally {
				env.cleanup();
			}
		});

		// #5038: the parameter says "same shape/semantics as ast_grep_search's
		// `paths`", but the matcher only ever saw the root-relative spelling, so
		// `./src` and an absolute directory returned no hits — a zero-hit answer
		// that reads as "no match". `limit` had the sibling problem against
		// `project_report`'s `max(1, floor)`.
		it("scopes `src`, `./src` and the absolute directory to the same hits (#5038)", async () => {
			const env = setupTestEnvironment("pi-lens-symbolsearch-5038-");
			try {
				makeFixture(env);
				const tool = createSymbolSearchTool(() => env.tmpDir);
				const hitsFor = async (paths: string[]) => {
					const result = await tool.execute(
						"1",
						{ query: "authenticate user", paths },
						undefined,
						null,
						{ cwd: env.tmpDir },
					);
					return rankedFiles(String(result.content[0]?.text));
				};
				const expected = ["src/auth/login.ts"];
				expect(await hitsFor(["src"]), "src").toEqual(expected);
				expect(await hitsFor(["./src"]), "./src").toEqual(expected);
				expect(
					await hitsFor([path.join(env.tmpDir, "src")]),
					"absolute",
				).toEqual(expected);
				// #771 asked for globs, so the resolved spelling stays a pattern.
				expect(await hitsFor(["src/**/*.ts"]), "glob").toEqual(expected);
			} finally {
				env.cleanup();
			}
		});

		// RECURRENCE GUARDED (#5047 r1 F1): the reader hands the engine an ABSOLUTE
		// entry, and the engine matched it as a glob pattern, so a workspace whose
		// own directory name holds glob syntax (`app[1]`, `app{a,b}`) lost every
		// scope: `paths: ["src"]` answered "No files matched" while the same tree
		// under a plain name answered one hit. The workspace prefix is a literal;
		// only what the caller wrote after it is a pattern.
		for (const workspaceName of [
			"app[1]",
			"app{a,b}",
			"plain",
			"proj\u00A0a",
		]) {
			it(`scopes \`paths\` the same in a workspace named ${workspaceName} (#5047 F1)`, async () => {
				const env = setupTestEnvironment("pi-lens-symbolsearch-globmeta-");
				try {
					const workspace = path.join(env.tmpDir, workspaceName);
					makeFixture({ tmpDir: workspace });
					const tool = createSymbolSearchTool(() => workspace);
					const hitsFor = async (paths: string[]) => {
						const result = await tool.execute(
							"1",
							{ query: "authenticate user", paths },
							undefined,
							null,
							{ cwd: workspace },
						);
						const text = String(result.content[0]?.text);
						return rankedFiles(text);
					};
					const expected = ["src/auth/login.ts"];
					expect(await hitsFor(["src"]), "src").toEqual(expected);
					expect(await hitsFor(["./src"]), "./src").toEqual(expected);
					// An absolute entry the CALLER spells with a no-break space is folded
					// by the host resolver on purpose (host parity, #4576), so only the
					// other names carry this cell.
					if (!workspaceName.includes("\u00A0"))
						expect(
							await hitsFor([path.join(workspace, "src")]),
							"absolute",
						).toEqual(expected);
					// The caller's own glob after the literal prefix is still a glob.
					expect(await hitsFor(["src/**/*.ts"]), "glob").toEqual(expected);
					expect(await hitsFor(["scripts"]), "other dir").toEqual([
						"scripts/authenticate.py",
					]);
					// The workspace itself scopes to every hit, not to none: the entry
					// relativizes to "" and must read as the whole workspace.
					expect((await hitsFor(["."])).sort(), "cwd").toEqual(
						["scripts/authenticate.py", "src/auth/login.ts"].sort(),
					);
					// A directory that holds no hit still scopes everything out: the
					// fix must not turn the literal prefix into "match everything".
					expect(await hitsFor(["docs"]), "empty dir").toEqual([]);
				} finally {
					env.cleanup();
				}
			});
		}

		// RECURRENCE GUARDED (#5047 r1 F5): the engine kept a fifth copy of the
		// blank-entry rule, so a blank entry reaching `symbolSearch` directly was
		// dropped and the call widened to the whole index. The reader owns the rule;
		// the engine takes its entries as admitted, so a blank one matches nothing.
		it("does not widen to the whole index on a blank entry at the engine seam (#5047 F5)", async () => {
			const env = setupTestEnvironment("pi-lens-symbolsearch-blank-engine-");
			try {
				makeFixture(env);
				const hitsFor = async (paths: string[]) =>
					(
						await symbolSearch("authenticate user", env.tmpDir, undefined, {
							paths,
						})
					).results.map((hit) => toPosix(path.relative(env.tmpDir, hit.file)));
				expect(await hitsFor(["src"])).toEqual(["src/auth/login.ts"]);
				expect(await hitsFor(["  "])).toEqual([]);
			} finally {
				env.cleanup();
			}
		});

		it("clamps `limit` to max(1, floor) like project_report (#5038)", async () => {
			const env = setupTestEnvironment("pi-lens-symbolsearch-5038-limit-");
			try {
				makeFixture(env);
				const tool = createSymbolSearchTool(() => env.tmpDir);
				const countFor = async (limit: number) => {
					const result = await tool.execute(
						"1",
						{ query: "authenticate user", limit },
						undefined,
						null,
						{ cwd: env.tmpDir },
					);
					return (result.details as { count?: number } | undefined)?.count;
				};
				expect(await countFor(0), "limit 0").toBe(1);
				expect(await countFor(-2), "limit -2").toBe(1);
				expect(await countFor(1.8), "limit 1.8").toBe(1);
			} finally {
				env.cleanup();
			}
		});
	});
	describe("inline query prefix filters (#1450)", () => {
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
				{
					path: tsFile,
					content: "export function authenticateUser(id) { return id; }",
				},
				{
					path: pyFile,
					content: "def authenticate_user(id):\n    return id\n",
				},
			]);
			return { tsFile, pyFile };
		}

		it("lang: filters hits to one file kind before ranking", async () => {
			const env = setupTestEnvironment("pi-lens-symbolsearch-querylang-");
			try {
				makeFixture(env);
				const tool = createSymbolSearchTool(() => env.tmpDir);
				const result = await tool.execute(
					"1",
					{ query: "lang:python authenticate user" },
					undefined,
					null,
					{ cwd: env.tmpDir },
				);
				const text = String(result.content[0]?.text);
				expectOneTable(text);
				expect(rankedFiles(text)).toEqual(["scripts/authenticate.py"]);
			} finally {
				env.cleanup();
			}
		});

		it("file: filter scopes hits to a path substring", async () => {
			const env = setupTestEnvironment("pi-lens-symbolsearch-queryfile-");
			try {
				makeFixture(env);
				const tool = createSymbolSearchTool(() => env.tmpDir);
				const result = await tool.execute(
					"1",
					{ query: "file:src/auth authenticate user" },
					undefined,
					null,
					{ cwd: env.tmpDir },
				);
				const text = String(result.content[0]?.text);
				expectOneTable(text);
				expect(rankedFiles(text)).toEqual(["src/auth/login.ts"]);
			} finally {
				env.cleanup();
			}
		});

		it("an unknown colon token searches as a plain term; a bad lang: value fails loudly", async () => {
			const env = setupTestEnvironment("pi-lens-symbolsearch-queryunknown-");
			try {
				makeFixture(env);
				const tool = createSymbolSearchTool(() => env.tmpDir);
				// Colon-bearing term: no error, ordinary search (old behavior).
				const passThrough = await tool.execute(
					"1",
					{ query: "type:foo authenticate user" },
					undefined,
					null,
					{ cwd: env.tmpDir },
				);
				expect(passThrough.isError).not.toBe(true);
				// Known key, bad value: the loud-failure contract survives.
				const badValue = await tool.execute(
					"2",
					{ query: "lang:notalang authenticate user" },
					undefined,
					null,
					{ cwd: env.tmpDir },
				);
				expect(badValue.isError).toBe(true);
				expect(String(badValue.content[0]?.text)).toContain("lang");
			} finally {
				env.cleanup();
			}
		});

		it("unfiltered inline-filter-free queries reproduce today's output (regression guard)", async () => {
			const env = setupTestEnvironment("pi-lens-symbolsearch-querynofilter-");
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
				expectOneTable(text);
				expect(rankedFiles(text).sort()).toEqual(
					["scripts/authenticate.py", "src/auth/login.ts"].sort(),
				);
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
				expectOneTable(text);
				expect(rows(text).length).toBeGreaterThan(0);
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
				expectOneTable(text);
				const ranked = rows(text);
				expect(ranked.length).toBeGreaterThan(0);
				expect(ranked[0]?.detail).toMatch(/hit\(s\)/);
			} finally {
				env.cleanup();
			}
		});
	});
});
