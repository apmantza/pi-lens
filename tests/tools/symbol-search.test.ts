// flake-shape: ungoverned-wait-for — the cold build is fire-and-forget (triggerBackgroundWordIndexBuild exposes no awaitable), so a real-time vi.waitFor is the only join on the snapshot it publishes.
/**
 * symbol_search pi tool (#348) — cold (available:false + hint + background
 * build kicked once) and warm (ranked results) paths, per the #517-slimmed
 * payload (startLine/endLine, no per-hit `read` block, no repeated path array).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { stripSource } from "../support/sweep-kit.js";
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
	collectWordIndexDocs,
	getWordIndexBuildStatus,
	serializeWordIndex,
	triggerBackgroundWordIndexBuild,
	_resetWordIndexBuildGuardForTests,
} from "../../clients/word-index.js";
import {
	renderCompactSymbolSearch,
	symbolSearch,
	SYMBOL_SEARCH_EMPTY_QUERY_REFUSAL,
	type SymbolSearchResult,
} from "../../clients/lens-engine.js";
import {
	createSymbolSearchTool,
	SYMBOL_SEARCH_DESCRIPTION,
	SYMBOL_SEARCH_QUERY_DESCRIPTION,
} from "../../tools/symbol-search.js";
import { createTempFile, setupTestEnvironment } from "../clients/test-utils.js";

/** One rendered ranked row: `  1. <path>[ <line>] (score ...)`. */
/** One rendered row. A `symbol` row is `  1. <path> <line> (score ...)`; a
 * `file` listing row (#5135) is `  1. <path>`. A line that begins as a row but
 * matches neither shape is unrecognised: throw rather than drop it, so a
 * renderer regression cannot pass as a smaller result set. */
const ROW_PREFIX = /^ {2}\d+\. (.*)$/;
const SYMBOL_ROW = /^(.*) (\d+) \((score .*)\)$/;

function rows(
	text: string,
): Array<{ file: string; line?: number; detail?: string }> {
	return text.split("\n").flatMap((line) => {
		const prefix = ROW_PREFIX.exec(line);
		if (prefix === null) return [];
		const rest = prefix[1];
		const symbol = SYMBOL_ROW.exec(rest);
		if (symbol) {
			return [
				{
					file: toPosix(symbol[1]),
					line: Number(symbol[2]),
					detail: symbol[3],
				},
			];
		}
		if (/ \(score /.test(rest)) {
			throw new Error(`unrecognised symbol_search row: ${line}`);
		}
		return [{ file: toPosix(rest) }];
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
	it("describes the compound-suffix ext: contract, and the tool owns the sentence (#5136)", () => {
		const tool = createSymbolSearchTool(() => "/tmp");
		expect(tool.description).toBe(SYMBOL_SEARCH_DESCRIPTION);
		expect(tool.description).toContain("ext:test.ts");
		expect(tool.description).toMatch(/path suffix/i);
	});

	it("the MCP pilens_symbol_search description is the imported pi constant (#5136)", () => {
		const serverSource = readFileSync(
			new URL("../../mcp/server.ts", import.meta.url),
			"utf8",
		);
		// Comment-blanked code, string contents kept: the specifier is itself a
		// string literal. A commented-out import or call must not pass (Greptile,
		// #5282: the raw-source regex accepted `// import { ... }`).
		const serverCode = stripSource(serverSource, { strings: "keep" });
		expect(serverCode).toMatch(
			/import \{[^}]*SYMBOL_SEARCH_DESCRIPTION[^}]*\} from "\.\.\/tools\/symbol-search\.js";/,
		);
		// The MCP description is the pi constant routed through the MCP name
		// translator, so it names pilens_* tools (#5136 F1).
		expect(serverCode).toMatch(
			/translateGuidanceToolNames\(\s*SYMBOL_SEARCH_DESCRIPTION\s*,\s*"mcp"\s*\)/,
		);
		// No second literal of the sentence: the MCP surface resolves to the same
		// exported constant the pi tool uses, so the two cannot drift.
		expect(serverSource).not.toContain(
			"Find relevant files by ranked identifier search.",
		);
	});

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

	it("an index built by the real walk holds named files, so lang:groovy returns a Jenkinsfile and build.gradle (#5273)", async () => {
		// Recurrence: the source walk admitted by extension only, so a file whose
		// kind comes from its name never entered the index and #5238's lang:groovy
		// filter had nothing to return for it.
		const env = setupTestEnvironment("pi-lens-symbolsearch-named-");
		try {
			createTempFile(
				env.tmpDir,
				"Jenkinsfile",
				"def deployStage() { echo 'deploy' }\n",
			);
			createTempFile(
				env.tmpDir,
				"build.gradle",
				"task packageArtifacts { doLast { println 'pack' } }\n",
			);
			createTempFile(
				env.tmpDir,
				"src/deploy.ts",
				"export function deployStage() { return 1; }\n",
			);
			// The index comes from the real walk (collectWordIndexDocs), then the
			// real tool answers from it; no build to wait on.
			warmWordIndexSnapshot(env.tmpDir, await collectWordIndexDocs(env.tmpDir));
			const tool = createSymbolSearchTool(() => env.tmpDir);
			const inline = await tool.execute(
				"2",
				{ query: "lang:groovy deploy stage" },
				undefined,
				null,
				{ cwd: env.tmpDir },
			);
			expect(rankedFiles(String(inline.content[0]?.text))).toEqual([
				"Jenkinsfile",
			]);
			const param = await tool.execute(
				"3",
				{ query: "package artifacts", lang: "groovy" },
				undefined,
				null,
				{ cwd: env.tmpDir },
			);
			expect(rankedFiles(String(param.content[0]?.text))).toEqual([
				"build.gradle",
			]);
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
			expect(ranked[0]?.line).toBeGreaterThan(0);
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
				// The footer names the TOP-ranked hit, through the pi tool spelling.
				expect(text).toContain(`Next: module_report ${rankedFiles(text)[0]}`);
				expect(text).not.toContain("pilens_module_report");
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

		it("ext: matches a compound suffix end to end, and -ext: subtracts it (#5136)", async () => {
			const env = setupTestEnvironment("pi-lens-symbolsearch-queryext-");
			try {
				const content = "export function authenticateUser(id) { return id; }";
				const testFile = createTempFile(
					env.tmpDir,
					"src/auth/login.test.ts",
					content,
				);
				const sourceFile = createTempFile(
					env.tmpDir,
					"src/auth/login.ts",
					content,
				);
				warmWordIndexSnapshot(env.tmpDir, [
					{ path: testFile, content },
					{ path: sourceFile, content },
				]);
				const tool = createSymbolSearchTool(() => env.tmpDir);
				const positive = await tool.execute(
					"1",
					{ query: "ext:test.ts authenticate user" },
					undefined,
					null,
					{ cwd: env.tmpDir },
				);
				expect(rankedFiles(String(positive.content[0]?.text))).toEqual([
					"src/auth/login.test.ts",
				]);
				const negative = await tool.execute(
					"1",
					{ query: "-ext:test.ts authenticate user" },
					undefined,
					null,
					{ cwd: env.tmpDir },
				);
				expect(rankedFiles(String(negative.content[0]?.text))).toEqual([
					"src/auth/login.ts",
				]);
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
				const ranked = rows(text);
				expect(ranked.length).toBeGreaterThan(0);
				for (const hit of ranked) {
					expect(hit.detail).not.toMatch(/fanIn|complexity/);
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
				expectOneTable(text);
				const ranked = rows(text);
				expect(ranked.length).toBeGreaterThan(0);
				expect(ranked[0]?.detail).toMatch(/, fanIn \d+/);
			} finally {
				env.cleanup();
			}
		});
	});

	// #5104 commit 2: one row shape, and a footer that names the top-ranked hit.
	// The renderer is driven directly so the annotations are exact — the review
	// graph annotates every hit it sees, so a tool-level fixture cannot produce
	// "one annotated hit".
	describe("renderCompactSymbolSearch row and footer shape (#5104)", () => {
		const cwd = path.resolve("pi-lens-symbolsearch-golden");
		const hit = (
			relPath: string,
			line: number,
			score: number,
			hits: number,
			annotations?: { fanIn: number; complexity?: number },
		) => ({
			file: path.join(cwd, ...relPath.split("/")),
			score,
			kind: "symbol" as const,
			hits,
			startLine: line,
			endLine: line,
			...(annotations ? { annotations } : {}),
		});
		const fileRow = (relPath: string, score = 1) => ({
			file: path.join(cwd, ...relPath.split("/")),
			score,
			kind: "file" as const,
		});
		const result = (
			results: SymbolSearchResult["results"],
			truncated = false,
		): SymbolSearchResult => ({
			available: true,
			query: "authenticate user",
			results,
			coverage: { files: 12, truncated },
		});
		const first = path.relative(
			cwd,
			hit("src/auth/login.ts", 12, 0.82, 3).file,
		);
		const second = path.relative(
			cwd,
			hit("scripts/authenticate.py", 3, 0.51, 2).file,
		);

		it("renders the exact 2-hit golden with one annotated hit", () => {
			const text = renderCompactSymbolSearch(
				result([
					hit("src/auth/login.ts", 12, 0.82, 3, { fanIn: 4, complexity: 7 }),
					hit("scripts/authenticate.py", 3, 0.51, 2),
				]),
				{ cwd },
			);
			expect(text).toBe(
				[
					'Top 2 file(s) for "authenticate user":',
					`  1. ${first} 12 (score 0.82, 3 hit(s), fanIn 4, complexity 7)`,
					`  2. ${second} 3 (score 0.51, 2 hit(s))`,
					"",
					"Index covers 12 files.",
					`Next: module_report ${first}`,
				].join("\n"),
			);
		});

		it("names the adapter's own outline tool in the next-step line", () => {
			const results = [
				hit("src/auth/login.ts", 12, 0.82, 3),
				hit("scripts/authenticate.py", 3, 0.51, 2),
			];
			const pi = renderCompactSymbolSearch(result(results), { cwd });
			const mcp = renderCompactSymbolSearch(result(results), {
				cwd,
				reportTool: "pilens_module_report",
			});
			expect(pi).toContain(`Next: module_report ${first}`);
			expect(mcp).toContain(`Next: pilens_module_report ${first}`);
			expect(mcp).not.toMatch(/^Next: module_report /m);
		});

		it("renders fanIn 0, which means no known importers", () => {
			const text = renderCompactSymbolSearch(
				result([hit("src/auth/login.ts", 12, 0.5, 1, { fanIn: 0 })]),
				{ cwd },
			);
			expect(text).toContain("(score 0.50, 1 hit(s), fanIn 0)");
		});

		it("renders a complexity of 0 rather than dropping a present annotation", () => {
			const text = renderCompactSymbolSearch(
				result([
					hit("src/auth/login.ts", 12, 0.5, 1, { fanIn: 2, complexity: 0 }),
				]),
				{ cwd },
			);
			expect(text).toContain("(score 0.50, 1 hit(s), fanIn 2, complexity 0)");
		});

		it("prints coverage before the next step, and no next step on an empty answer", () => {
			const capped = renderCompactSymbolSearch(result([], true), { cwd });
			expect(capped).toBe(
				[
					'No files matched "authenticate user".',
					"",
					"Index covers 12 files (capped — results may be incomplete).",
				].join("\n"),
			);
		});

		// #5135: a `file` listing row is the path ALONE. The producer set `kind`;
		// the renderer neither infers it nor fabricates a line.
		it("renders a `file` row as a bare path, with the top path in the footer", () => {
			const text = renderCompactSymbolSearch(
				result([fileRow("src/auth/login.ts")]),
				{ cwd },
			);
			expect(text.split("\n")[1]).toBe("  1. src/auth/login.ts");
			expect(text).not.toContain("score");
			expect(text).not.toContain("hit(s)");
			expect(text).toContain("Next: module_report src/auth/login.ts");
			expect(rows(text)).toEqual([{ file: "src/auth/login.ts" }]);
		});

		it("throws on an unrecognised row instead of dropping it", () => {
			expect(() =>
				rows("  1. src/auth/login.ts (score 0.50, 1 hit(s))"),
			).toThrow(/unrecognised symbol_search row/);
		});
	});
});

// #5135: no terms AND no scope is a refusal; a term-less call that carries a
// scope is a listing. Both entry paths (inline filters and structured
// `paths`/`lang`) must agree, and the refusal sentence is the one shared with
// the MCP mirror.
describe("symbol_search term-less calls (#5135)", () => {
	const source = "export function authenticateUser(id) { return id; }";
	const python = "def authenticate_user(id):\n    return id\n";

	function listingFixture(env: { tmpDir: string }): void {
		const tsFile = createTempFile(env.tmpDir, "src/auth/login.ts", source);
		const pyFile = createTempFile(
			env.tmpDir,
			"scripts/authenticate.py",
			python,
		);
		warmWordIndexSnapshot(env.tmpDir, [
			{ path: tsFile, content: source },
			{ path: pyFile, content: python },
		]);
	}

	async function run(
		env: { tmpDir: string },
		params: { query: string; paths?: string[]; lang?: string },
	) {
		const tool = createSymbolSearchTool(() => env.tmpDir);
		return tool.execute("1", params, undefined, null, { cwd: env.tmpDir });
	}

	it("refuses a query with neither terms nor scope as an isError", async () => {
		const env = setupTestEnvironment("pi-lens-symbolsearch-empty-");
		try {
			listingFixture(env);
			const result = await run(env, { query: "" });
			expect(result.isError).toBe(true);
			expect(String(result.content[0]?.text)).toBe(
				SYMBOL_SEARCH_EMPTY_QUERY_REFUSAL,
			);
		} finally {
			env.cleanup();
		}
	});

	it("lists the scoped files for an empty query with structured paths", async () => {
		const env = setupTestEnvironment("pi-lens-symbolsearch-empty-paths-");
		try {
			listingFixture(env);
			const result = await run(env, { query: "", paths: ["src"] });
			expect(result.isError).toBeFalsy();
			expect(rankedFiles(String(result.content[0]?.text))).toEqual([
				"src/auth/login.ts",
			]);
		} finally {
			env.cleanup();
		}
	});

	it("treats a negation-only query as a scope, not a refusal", async () => {
		const env = setupTestEnvironment("pi-lens-symbolsearch-negation-");
		try {
			listingFixture(env);
			const result = await run(env, { query: "-file:test" });
			expect(result.isError).toBeFalsy();
			expect(rankedFiles(String(result.content[0]?.text)).sort()).toEqual([
				"scripts/authenticate.py",
				"src/auth/login.ts",
			]);
		} finally {
			env.cleanup();
		}
	});

	// #5135 r2: inline `file:` and structured `paths` are NOT interchangeable.
	// `file:` is a SUBSTRING match on the index's display path
	// (`resolveWordIndexFilter` in clients/word-index.ts); `paths` is a SUBTREE
	// GLOB matched relative to `cwd` (`fileMatchesPathGlobs` in
	// clients/lens-engine.ts). So `file:clients/` also matches a nested
	// `tests/clients/...`, while `paths: ["clients/"]` scopes only the root
	// `clients/` subtree. This pins the difference as documentation, not a bug.
	it("documents `file:` (substring) vs `paths` (subtree glob)", async () => {
		const env = setupTestEnvironment("pi-lens-symbolsearch-file-paths-");
		try {
			const root = createTempFile(env.tmpDir, "clients/word-index.ts", source);
			const nested = createTempFile(
				env.tmpDir,
				"tests/clients/word-index.test.ts",
				source,
			);
			warmWordIndexSnapshot(env.tmpDir, [
				{ path: root, content: source },
				{ path: nested, content: source },
			]);
			const inline = await run(env, { query: "file:clients/" });
			const structured = await run(env, { query: "", paths: ["clients/"] });
			const inlineFiles = rankedFiles(String(inline.content[0]?.text));
			const structuredFiles = rankedFiles(String(structured.content[0]?.text));
			expect(inlineFiles.sort()).toEqual([
				"clients/word-index.ts",
				"tests/clients/word-index.test.ts",
			]);
			expect(structuredFiles).toEqual(["clients/word-index.ts"]);
			expect(inlineFiles).not.toEqual(structuredFiles);
		} finally {
			env.cleanup();
		}
	});

	it("resolves a lang kind and a language id to the same listing", async () => {
		const env = setupTestEnvironment("pi-lens-symbolsearch-lang-parity-");
		try {
			listingFixture(env);
			const inlineJsts = await run(env, { query: "lang:jsts" });
			const structuredJsts = await run(env, { query: "", lang: "jsts" });
			const inlineTs = await run(env, { query: "lang:typescript" });
			const structuredTs = await run(env, { query: "", lang: "typescript" });
			const expected = ["src/auth/login.ts"];
			expect(rankedFiles(String(inlineJsts.content[0]?.text))).toEqual(
				expected,
			);
			expect(rankedFiles(String(structuredJsts.content[0]?.text))).toEqual(
				expected,
			);
			expect(rankedFiles(String(inlineTs.content[0]?.text))).toEqual(expected);
			expect(rankedFiles(String(structuredTs.content[0]?.text))).toEqual(
				expected,
			);
		} finally {
			env.cleanup();
		}
	});

	it("refuses an unknown lang, naming both vocabularies", async () => {
		const env = setupTestEnvironment("pi-lens-symbolsearch-lang-unknown-");
		try {
			listingFixture(env);
			for (const params of [
				{ query: "lang:klingon" },
				{ query: "", lang: "klingon" },
			]) {
				const result = await run(env, params);
				expect(result.isError, JSON.stringify(params)).toBe(true);
				const text = String(result.content[0]?.text);
				expect(text).toContain("accepted file kinds:");
				expect(text).toContain("accepted language ids:");
				// The engine's refusal sentence, not the wrapped generic failure.
				expect(text).not.toContain("Symbol search failed");
			}
		} finally {
			env.cleanup();
		}
	});

	// #5135 r2 (F2): inline `lang:<id>` and structured `lang` are ONE predicate
	// (clients/language-registry.ts `resolveLanguageScope`). Recurrence guarded:
	// PR #5373 r1 found inline `lang:dockerfile` empty and `lang:bash` missing
	// Makefile while structured `lang` found both — two copies of one question.
	it("inline lang: and structured lang list the same files for named files", async () => {
		const env = setupTestEnvironment("pi-lens-symbolsearch-lang-named-");
		try {
			const body = "zzfoo = 1";
			const names = [
				"Dockerfile",
				"Makefile",
				"Jenkinsfile",
				"src/run.sh",
				"src/app.ts",
			];
			warmWordIndexSnapshot(
				env.tmpDir,
				names.map((name) => ({
					path: createTempFile(env.tmpDir, name, body),
					content: body,
				})),
			);
			const listed = async (params: { query: string; lang?: string }) =>
				rankedFiles(String((await run(env, params)).content[0]?.text)).sort();
			for (const token of ["dockerfile", "docker", "bash", "groovy"]) {
				const inline = await listed({ query: `lang:${token}` });
				const structured = await listed({ query: "", lang: token });
				expect(inline, token).toEqual(structured);
				expect(inline.length, token).toBeGreaterThan(0);
			}
			expect(await listed({ query: "lang:dockerfile" })).toEqual([
				"Dockerfile",
			]);
			expect(await listed({ query: "lang:bash" })).toEqual([
				"Makefile",
				"src/run.sh",
			]);
		} finally {
			env.cleanup();
		}
	});

	// #5135 r2 (F1, maintainer decision): an inline token that is both a FileKind
	// and a registry id matches the UNION, as on master; the structured `lang`
	// keeps the registry-only decision the drift test pins (`app.scss` is not
	// `css`). The two differ here ON PURPOSE.
	it("inline lang:css keeps .scss; structured lang css does not", async () => {
		const env = setupTestEnvironment("pi-lens-symbolsearch-lang-union-");
		try {
			const body = "zzfoo = 1";
			warmWordIndexSnapshot(
				env.tmpDir,
				["src/x.css", "src/y.scss"].map((name) => ({
					path: createTempFile(env.tmpDir, name, body),
					content: body,
				})),
			);
			const listed = async (params: { query: string; lang?: string }) =>
				rankedFiles(String((await run(env, params)).content[0]?.text)).sort();
			expect(await listed({ query: "lang:css" })).toEqual([
				"src/x.css",
				"src/y.scss",
			]);
			expect(await listed({ query: "", lang: "css" })).toEqual(["src/x.css"]);
		} finally {
			env.cleanup();
		}
	});

	// #5135 r2 (F3): the refusal must not depend on data. Recurrence guarded: PR
	// #5373 r1 found `{query:"zzzznomatch",lang:"klingon"}` and a paths-excluded
	// call answering empty, because a structured `lang` was only validated inside
	// the per-file predicate.
	it("refuses an unknown lang on a term with no postings and on a paths filter that excludes everything", async () => {
		const env = setupTestEnvironment("pi-lens-symbolsearch-lang-data-");
		try {
			listingFixture(env);
			for (const params of [
				{ query: "zzzznomatch", lang: "klingon" },
				{ query: "authenticate", paths: ["nonexistent/"], lang: "klingon" },
				{ query: "", paths: ["nonexistent/"], lang: "klingon" },
				{ query: "zzzznomatch lang:klingon" },
				{ query: "authenticate lang:klingon", paths: ["nonexistent/"] },
			]) {
				const result = await run(env, params);
				expect(result.isError, JSON.stringify(params)).toBe(true);
				expect(
					String(result.content[0]?.text),
					JSON.stringify(params),
				).toContain("accepted file kinds:");
			}
		} finally {
			env.cleanup();
		}
	});

	it("refuses an unknown lang on a cold index without starting a build", async () => {
		const env = setupTestEnvironment("pi-lens-symbolsearch-lang-cold-");
		try {
			createTempFile(env.tmpDir, "src/auth.ts", source);
			for (const params of [
				{ query: "lang:klingon" },
				{ query: "authenticate", lang: "klingon" },
			]) {
				const result = await run(env, params);
				expect(result.isError, JSON.stringify(params)).toBe(true);
				const text = String(result.content[0]?.text);
				expect(text, JSON.stringify(params)).toContain("accepted file kinds:");
				expect(text).not.toMatch(/building|retry/i);
			}
			expect(getWordIndexBuildStatus(env.tmpDir)).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	// #5135 r2 (F6): `constructor` / `__proto__` are prototype members, not
	// vocabulary. They refuse like any unknown token instead of throwing a
	// TypeError out of `extensions.includes`.
	it.each(["constructor", "__proto__"])(
		"refuses lang %s as unknown, on both forms",
		async (token) => {
			const env = setupTestEnvironment("pi-lens-symbolsearch-lang-proto-");
			try {
				listingFixture(env);
				for (const params of [
					{ query: `lang:${token}` },
					{ query: "", lang: token },
				]) {
					const result = await run(env, params);
					expect(result.isError, JSON.stringify(params)).toBe(true);
					expect(String(result.content[0]?.text)).toContain(
						"accepted file kinds:",
					);
					expect(String(result.content[0]?.text)).not.toContain(
						"is not a function",
					);
				}
			} finally {
				env.cleanup();
			}
		},
	);

	// #5135 r2 (F5): the engine returns a refusal ONLY for the lang vocabulary;
	// any other error out of the search propagates. Recurrence guarded: a catch
	// that swallowed every error stayed green across 188 tests in PR #5373 r1.
	// A `paths` entry past minimatch's 64 KiB pattern bound throws a TypeError
	// from inside the search.
	it("lets an unexpected search error propagate instead of reporting a refusal", async () => {
		const env = setupTestEnvironment("pi-lens-symbolsearch-rethrow-");
		try {
			listingFixture(env);
			await expect(
				symbolSearch("authenticate", env.tmpDir, 20, {
					paths: ["a".repeat(70_000)],
				}),
			).rejects.toThrow(/too long/i);
		} finally {
			env.cleanup();
		}
	});

	// #5135 r2 (F4): independent literals, not a comparison of the constant with
	// itself. Recurrence guarded: PR #5373 r1 deleted the policy sentence and only
	// the tool-roster byte baseline reddened, which a re-pin silences.
	it("the query description states the three keys, the literal-prefix rule and the listing rule", () => {
		for (const needle of [
			"lang:<kind|id>",
			"file:<substr>",
			"ext:<ext>",
			"An unknown key: prefix is a literal search term, not an error",
			"an unknown lang value refuses with the supported list",
			"A scope with no terms lists the scoped files.",
		]) {
			expect(SYMBOL_SEARCH_QUERY_DESCRIPTION).toContain(needle);
		}
	});

	it("the tool's own description is the exported constant", () => {
		const tool = createSymbolSearchTool(() => ".");
		expect(tool.description).toBe(SYMBOL_SEARCH_DESCRIPTION);
		const querySchema = tool.parameters.properties.query as unknown as {
			description?: string;
		};
		expect(querySchema.description).toBe(SYMBOL_SEARCH_QUERY_DESCRIPTION);
	});
});
