/**
 * #5371 r2: the shared `paths` reader decides literal-vs-glob and where a glob
 * walks, and r1 decided both by enumerating spellings. These cases drive the
 * production reader (`readPathsArgument`, the one function every `paths` tool
 * and the MCP mirror call) over real trees, one row per input class of the r2
 * state table:
 *
 * - F1  a glob whose LAST segment is literal (`src/**\/index.ts`) walks from the
 *       directory before its FIRST magic segment, not from a path that does not
 *       exist;
 * - F2  an entry that exists on disk is a literal whatever characters it has
 *       (`app/[id]`, `src/[id].ts`, `src/b{1,2}.ts`);
 * - F4  an ignored, gitignored or excluded directory is never returned for a
 *       glob that matches its name;
 * - F5  lives in path-glob-5371-tracked-index.test.ts (it needs a real Git index);
 * - F6  literals and expanded entries are counted against ONE cap, in any order;
 * - F7  a filter-only caller (`symbol_search`) has no file-list cap;
 * - F8  the walk is bounded by visited entries, honours an abort signal, and a
 *       glob never roots outside the workspace (a literal outside is unchanged).
 *
 * RECURRENCE GUARDED (#5393 review, F1-F9): a path reader that decided
 * literal-vs-glob and the walk scope by listing cases shipped nine defects
 * behind 24 green checks, because no test named a case it had not designed for.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { _resetTrackedFilesCacheForTests } from "../../clients/git-tracked-ignore.js";
import { expandPathsEntry } from "../../clients/path-globs.js";
import {
	clearWidgetState,
	recordDiagnostics,
} from "../../clients/widget-state.js";
import { createAstGrepOutlineTool } from "../../tools/ast-grep-outline.js";
import { createAstGrepReplaceTool } from "../../tools/ast-grep-replace.js";
import { createAstGrepSearchTool } from "../../tools/ast-grep-search.js";
import { createLensDiagnosticsTool } from "../../tools/lens-diagnostics.js";
import { MAX_PATHS_ENTRIES, readPathsArgument } from "../../tools/shared.js";
import { createSymbolSearchTool } from "../../tools/symbol-search.js";
import { setupTestEnvironment } from "../clients/test-utils.js";

function mk(ws: string, files: readonly string[]): void {
	for (const relative of files) {
		const file = path.join(ws, relative);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "export const value = 1;\n");
	}
}

function posix(ws: string, entries: readonly string[]): string[] {
	return entries.map((entry) =>
		path.relative(ws, entry).split(path.sep).join("/"),
	);
}

async function names(
	ws: string,
	raw: string[],
	extra: { filterOnly?: boolean } = {},
): Promise<string[] | { refusal: string }> {
	const read = await readPathsArgument(raw, { cwd: ws, ...extra });
	if (read.refusal) return { refusal: read.refusal };
	return posix(ws, read.entries).sort();
}

describe("#5371 r2 the reader decides literal-vs-glob and the walk root by rule", () => {
	beforeEach(() => {
		clearWidgetState();
		_resetTrackedFilesCacheForTests();
	});

	// F1. Before: `src/**/index.ts` walked from the nonexistent path
	// `<ws>/src/**/index.ts` and was refused as "no file matches".
	it("walks a glob whose last segment is literal from the directory before its first magic segment (F1)", async () => {
		const env = setupTestEnvironment("pi-lens-5371r2-prefix-", {
			rootMarker: false,
		});
		try {
			mk(env.tmpDir, [
				"src/a.ts",
				"src/sub/index.ts",
				"src/sub/deep/index.ts",
				"other/index.ts",
			]);
			const deep = ["src/sub/deep/index.ts", "src/sub/index.ts"];
			expect(await names(env.tmpDir, ["src/**/index.ts"])).toEqual(deep);
			expect(await names(env.tmpDir, ["src/*/index.ts"])).toEqual([
				"src/sub/index.ts",
			]);
			expect(await names(env.tmpDir, ["**/index.ts"])).toEqual([
				"other/index.ts",
				...deep,
			]);
			expect(await names(env.tmpDir, ["src/**/a.ts"])).toEqual(["src/a.ts"]);
			expect(await names(env.tmpDir, ["src/s*/index.ts"])).toEqual([
				"src/sub/index.ts",
			]);
		} finally {
			env.cleanup();
		}
	});

	// F2. Before: `hasGlobMagic` read the spelling, so a Next.js dynamic route
	// that exists was handed to minimatch (`[id]` is a class) and refused.
	it("reads an entry that exists on disk as a literal, whatever characters it has (F2)", async () => {
		const env = setupTestEnvironment("pi-lens-5371r2-exists-", {
			rootMarker: false,
		});
		try {
			mk(env.tmpDir, [
				"app/[id]/page.tsx",
				"src/[id].ts",
				"src/b{1,2}.ts",
				"src/i.ts",
				"src/b1.ts",
			]);
			const only = async (entry: string, expected: string[]) =>
				expect(await names(env.tmpDir, [entry]), entry).toEqual(expected);
			await only("app/[id]", ["app/[id]"]);
			await only("src/[id].ts", ["src/[id].ts"]);
			await only("src/b{1,2}.ts", ["src/b{1,2}.ts"]);
			await only(path.join(env.tmpDir, "app", "[id]", "page.tsx"), [
				"app/[id]/page.tsx",
			]);
			// The SAME spelling absent is still a glob that matches nothing.
			const absent = await names(env.tmpDir, ["src/[zz].ts"]);
			expect(absent).toEqual({
				refusal: expect.stringContaining("no file matches"),
			});
			// A genuine glob next to those names keeps expanding.
			expect(await names(env.tmpDir, ["src/b*.ts"])).toEqual([
				"src/b1.ts",
				"src/b{1,2}.ts",
			]);
		} finally {
			env.cleanup();
		}
	});

	// F2, the other half: the glob character test reads the part of the entry
	// BELOW cwd. A workspace directory named `ws[1]` is a directory; a missing
	// file under it is a missing LITERAL (its own `path not found` downstream),
	// not a glob that "matches no file".
	it("never reads the workspace's own name as glob syntax (F2)", async () => {
		const env = setupTestEnvironment("pi-lens-5371r2-wsname-", {
			rootMarker: false,
		});
		try {
			const cwd = path.join(env.tmpDir, "ws[1]");
			mk(cwd, ["src/a.ts"]);
			expect(await names(cwd, ["gone.ts"])).toEqual(["gone.ts"]);
			expect(await names(cwd, [path.join(cwd, "gone.ts")])).toEqual([
				"gone.ts",
			]);
			expect(await names(cwd, ["src/*.ts"])).toEqual(["src/a.ts"]);
		} finally {
			env.cleanup();
		}
	});

	// F2, the probe's three answers: `ENOENT`/`ENOTDIR` mean absent (a glob);
	// any other refusal means "cannot prove absent", which stays a literal.
	it("treats ENOTDIR as absent and any other refusal as a literal (F2)", async () => {
		const env = setupTestEnvironment("pi-lens-5371r2-probe-", {
			rootMarker: false,
		});
		try {
			mk(env.tmpDir, ["afile.ts"]);
			// `afile.ts` is a file, so `afile.ts/[x]` answers ENOTDIR: absent.
			expect(await names(env.tmpDir, ["afile.ts/[x]"])).toEqual({
				refusal: expect.stringContaining("no file matches"),
			});
			if (process.platform !== "win32") {
				// A self-referential link answers ELOOP for anything beneath it: the
				// kernel refused, nothing proves the entry absent.
				fs.symlinkSync("loop", path.join(env.tmpDir, "loop"));
				expect(await names(env.tmpDir, ["loop/[x]"])).toEqual(["loop/[x]"]);
			}
		} finally {
			env.cleanup();
		}
	});

	// F4. Before: the directory test came BEFORE the ignore decision, so a glob
	// that matched a directory name returned it, ignored or not, and
	// `ast_grep_replace` then received its whole subtree.
	it("never returns an ignored, gitignored or excluded directory a glob matches by name (F4)", async () => {
		const env = setupTestEnvironment("pi-lens-5371r2-dirs-", {
			rootMarker: false,
		});
		try {
			mk(env.tmpDir, [
				"src/a.ts",
				"src/generated/g.ts",
				"src/coverage/c.ts",
				"src/real/r.ts",
				"node_modules/p/i.js",
			]);
			fs.writeFileSync(
				path.join(env.tmpDir, ".gitignore"),
				"generated/\nnode_modules/\n",
			);
			expect(await names(env.tmpDir, ["src/*"])).toEqual([
				"src/a.ts",
				"src/real",
			]);
			expect(await names(env.tmpDir, ["*"])).toEqual([".gitignore", "src"]);
		} finally {
			env.cleanup();
		}
	});

	// F6. Before: only the literals BEFORE a glob were counted, so a two-file
	// glob followed by 99 literals returned 101 entries.
	it("counts literals and expanded entries against one cap, in either order (F6)", async () => {
		const env = setupTestEnvironment("pi-lens-5371r2-cap-", {
			rootMarker: false,
		});
		try {
			mk(env.tmpDir, ["few/a.ts", "few/b.ts"]);
			const literals = Array.from(
				{ length: MAX_PATHS_ENTRIES - 1 },
				(_, index) => `lit/f${index}.ts`,
			);
			const over = { refusal: expect.stringContaining("more than 100") };
			expect(await names(env.tmpDir, ["few/*.ts", ...literals])).toEqual(over);
			expect(await names(env.tmpDir, [...literals, "few/*.ts"])).toEqual(over);
			// The boundary: the cap itself is admitted.
			const fit = await names(env.tmpDir, [
				"few/*.ts",
				...literals.slice(0, MAX_PATHS_ENTRIES - 2),
			]);
			expect(Array.isArray(fit) && fit.length).toBe(MAX_PATHS_ENTRIES);
		} finally {
			env.cleanup();
		}
	});

	// F7. Before: `symbol_search paths:["many/**\/*.ts"]` matching 150 files was
	// refused at the 100-entry cap, which exists for tools that receive a file
	// list; `symbol_search` filters an index and hands no tool a list.
	it("lifts the file-list cap for a filter-only caller and keeps it for a target list (F7)", async () => {
		const env = setupTestEnvironment("pi-lens-5371r2-filter-", {
			rootMarker: false,
		});
		try {
			mk(
				env.tmpDir,
				Array.from({ length: 150 }, (_, index) => `many/f${index}.ts`),
			);
			expect(await names(env.tmpDir, ["many/**/*.ts"])).toEqual({
				refusal: expect.stringContaining("more than 100"),
			});
			const filtered = await names(env.tmpDir, ["many/**/*.ts"], {
				filterOnly: true,
			});
			expect(Array.isArray(filtered) && filtered.length).toBe(150);
		} finally {
			env.cleanup();
		}
	});

	// F8. Before: `../**` and an absolute glob rooted the walk above `cwd`, and a
	// sparse glob read the whole tree because only MATCHES were counted.
	it("refuses a glob rooted outside the workspace and leaves a literal outside unchanged (F8)", async () => {
		const env = setupTestEnvironment("pi-lens-5371r2-outside-", {
			rootMarker: false,
		});
		try {
			const cwd = path.join(env.tmpDir, "proj");
			mk(cwd, ["a.ts"]);
			mk(env.tmpDir, ["sibling/x.ts"]);
			const outside = {
				refusal: expect.stringContaining("outside the workspace"),
			};
			expect(await names(cwd, ["../**/*.ts"])).toEqual(outside);
			expect(await names(cwd, ["../sibling/*.ts"])).toEqual(outside);
			expect(
				await names(cwd, [path.join(env.tmpDir, "sibling", "*.ts")]),
			).toEqual(outside);
			expect(await names(cwd, [path.join(os.tmpdir(), "*zz-never")])).toEqual(
				outside,
			);
			// A LITERAL outside keeps reaching the tool, exactly as on master.
			expect(await names(cwd, ["../sibling/x.ts"])).toEqual([
				"../sibling/x.ts",
			]);
			// An absolute glob INSIDE the workspace is the relative glob.
			expect(await names(cwd, [path.join(cwd, "*.ts")])).toEqual(["a.ts"]);
		} finally {
			env.cleanup();
		}
	});

	it("stops the walk at the visited bound and refuses instead of reporting no match (F8)", async () => {
		const env = setupTestEnvironment("pi-lens-5371r2-visited-", {
			rootMarker: false,
		});
		try {
			mk(
				env.tmpDir,
				Array.from({ length: 40 }, (_, index) => `d${index % 4}/f${index}.ts`),
			);
			const bounded = await expandPathsEntry(
				path.join(env.tmpDir, "**", "*.zzz"),
				env.tmpDir,
				MAX_PATHS_ENTRIES,
				{ maxVisited: 10 },
			);
			expect(bounded.refusal).toBe("over-walk");
			// The same walk under a bound it fits is the honest "no match".
			const fits = await expandPathsEntry(
				path.join(env.tmpDir, "**", "*.zzz"),
				env.tmpDir,
				MAX_PATHS_ENTRIES,
				{ maxVisited: 1000 },
			);
			expect(fits.refusal).toBe("no-match");
		} finally {
			env.cleanup();
		}
	});

	// The reader hands its signal to the walk: a tool call the host aborted
	// (Esc) must not start reading a tree.
	it("hands the call's signal to the expansion (F8)", async () => {
		const env = setupTestEnvironment("pi-lens-5371r2-signal-", {
			rootMarker: false,
		});
		try {
			mk(env.tmpDir, ["a.ts"]);
			const controller = new AbortController();
			controller.abort();
			const read = await readPathsArgument(["*.ts"], {
				cwd: env.tmpDir,
				signal: controller.signal,
			});
			expect(read.refusal).toContain("aborted");
			expect(read.entries).toEqual([]);
		} finally {
			env.cleanup();
		}
	});

	// The walk itself stops: a signal that fires after the first directory read
	// must leave the other directories unread, not merely change the verdict.
	it("stops reading directories once the signal fires mid-walk (F8)", async () => {
		const env = setupTestEnvironment("pi-lens-5371r2-midwalk-", {
			rootMarker: false,
		});
		const controller = new AbortController();
		const real = fs.promises.readdir.bind(fs.promises);
		let reads = 0;
		const spy = vi.spyOn(fs.promises, "readdir").mockImplementation(((
			...args: Parameters<typeof real>
		) => {
			reads += 1;
			const answer = real(...args);
			controller.abort();
			return answer;
		}) as typeof fs.promises.readdir);
		try {
			mk(
				env.tmpDir,
				Array.from({ length: 12 }, (_, index) => `d${index}/f.zzz`),
			);
			const walked = await expandPathsEntry(
				path.join(env.tmpDir, "**", "*.ts"),
				env.tmpDir,
				MAX_PATHS_ENTRIES,
				{ signal: controller.signal },
			);
			expect(walked.refusal).toBe("aborted");
			// The root listing is the one read made before the first entry saw the
			// fired signal; twelve more would mean the walk went on.
			expect(reads).toBe(1);
		} finally {
			spy.mockRestore();
			env.cleanup();
		}
	});

	// The match budget ends the walk too: a glob that passes the cap is refused
	// after a handful of directory reads, not after the whole tree. (r1's
	// `shouldStop` carried this and a `() => false` mutation survived.)
	it("stops reading directories once the matches pass the budget (F8)", async () => {
		const env = setupTestEnvironment("pi-lens-5371r2-budget-", {
			rootMarker: false,
		});
		const real = fs.promises.readdir.bind(fs.promises);
		let reads = 0;
		const spy = vi.spyOn(fs.promises, "readdir").mockImplementation(((
			...args: Parameters<typeof real>
		) => {
			reads += 1;
			return real(...args);
		}) as typeof fs.promises.readdir);
		try {
			mk(
				env.tmpDir,
				Array.from({ length: 30 }, (_, index) => `d${index}/f.ts`),
			);
			const walked = await expandPathsEntry(
				path.join(env.tmpDir, "**", "*.ts"),
				env.tmpDir,
				2,
			);
			expect(walked.refusal).toBe("over-cap");
			// Root, then at most the directories holding the three matches.
			expect(reads).toBeLessThanOrEqual(5);
		} finally {
			spy.mockRestore();
			env.cleanup();
		}
	});

	it("does not walk once the call's signal has fired (F8)", async () => {
		const env = setupTestEnvironment("pi-lens-5371r2-abort-", {
			rootMarker: false,
		});
		try {
			mk(env.tmpDir, ["a.ts", "b.ts"]);
			const controller = new AbortController();
			controller.abort();
			const aborted = await expandPathsEntry(
				path.join(env.tmpDir, "*.ts"),
				env.tmpDir,
				MAX_PATHS_ENTRIES,
				{ signal: controller.signal },
			);
			expect(aborted.refusal).toBe("aborted");
			expect(aborted.entries).toEqual([]);
		} finally {
			env.cleanup();
		}
	});
});

// The tools that hold the call's abort signal hand it to the reader, so Esc ends
// a glob's directory walk. `ast_grep_replace` (its signal plumbing belongs to
// #5392) and the MCP mirror (no signal at `callTool`) are the named gaps.
describe("#5371 r2 the tools hand their abort signal to the paths reader (F8)", () => {
	it("refuses a glob once the signal fired, in every tool that holds one", async () => {
		const env = setupTestEnvironment("pi-lens-5371r2-toolsignal-", {
			rootMarker: false,
		});
		try {
			mk(env.tmpDir, ["src/a.ts"]);
			const client = {
				ensureAvailable: async () => true,
				search: vi.fn().mockResolvedValue({ matches: [], totalMatches: 0 }),
				outline: vi.fn().mockResolvedValue({ output: [] }),
				validatePattern: vi.fn().mockResolvedValue({ valid: true }),
				formatMatches: () => "",
			} as never;
			const subjects: Array<{
				name: string;
				tool: { execute: (...args: never[]) => Promise<unknown> };
				params: Record<string, unknown>;
			}> = [
				{
					name: "symbol_search",
					tool: createSymbolSearchTool(() => env.tmpDir),
					params: { query: "hello" },
				},
				{
					name: "ast_grep_search",
					tool: createAstGrepSearchTool(client),
					params: { pattern: "foo($X)", lang: "typescript" },
				},
				{
					name: "ast_grep_outline",
					tool: createAstGrepOutlineTool(client),
					params: { lang: "typescript" },
				},
				{
					name: "lens_diagnostics",
					tool: createLensDiagnosticsTool(
						{ readCache: () => undefined } as never,
						() => env.tmpDir,
					),
					params: { mode: "all" },
				},
			];
			for (const subject of subjects) {
				const controller = new AbortController();
				controller.abort();
				const result = (await (
					subject.tool.execute as unknown as (
						...args: unknown[]
					) => Promise<{ isError?: boolean; content: { text: string }[] }>
				)(
					"5371",
					{ ...subject.params, paths: ["src/*.ts"] },
					controller.signal,
					null,
					{ cwd: env.tmpDir },
				)) as { isError?: boolean; content: { text: string }[] };
				expect(result.isError, subject.name).toBe(true);
				expect(
					result.content.map((part) => part.text).join("\n"),
					subject.name,
				).toContain("aborted");
			}
		} finally {
			env.cleanup();
		}
	});
});

describe("#5371 r2 ast_grep_search's walk ends when the call is aborted mid-expansion (F8)", () => {
	// The pre-aborted case above cannot tell this tool's signal from the reader's
	// (the tool refuses an aborted call before it reads `paths`), so the signal
	// fires DURING the expansion: only a signal the tool handed to the walk can
	// stop the other eleven directory reads.
	it("hands its combined signal to the walk, not just to the child", async () => {
		const env = setupTestEnvironment("pi-lens-5371r2-searchsignal-", {
			rootMarker: false,
		});
		const controller = new AbortController();
		const real = fs.promises.readdir.bind(fs.promises);
		let reads = 0;
		const spy = vi.spyOn(fs.promises, "readdir").mockImplementation(((
			...args: Parameters<typeof real>
		) => {
			// Only the fixture tree's own listings count: the tool reads other
			// directories before it reaches the reader.
			if (String(args[0]).startsWith(env.tmpDir)) {
				reads += 1;
				controller.abort();
			}
			return real(...args);
		}) as typeof fs.promises.readdir);
		try {
			mk(
				env.tmpDir,
				Array.from({ length: 12 }, (_, index) => `d${index}/f.zzz`),
			);
			const client = {
				ensureAvailable: async () => true,
				search: vi.fn().mockResolvedValue({ matches: [], totalMatches: 0 }),
				validatePattern: vi.fn().mockResolvedValue({ valid: true }),
				formatMatches: () => "",
			} as never;
			const tool = createAstGrepSearchTool(client);
			await (
				tool.execute as unknown as (...args: unknown[]) => Promise<unknown>
			)(
				"5371",
				{ pattern: "foo($X)", lang: "typescript", paths: ["**/*.ts"] },
				undefined,
				null,
				{ cwd: env.tmpDir, signal: controller.signal },
			);
			expect(reads).toBe(1);
		} finally {
			spy.mockRestore();
			env.cleanup();
		}
	});
});

// N4 (#5393 verify r2). #5392 gave `ast_grep_replace` a call-scoped signal, and
// its paths read did not take it: a call aborted mid-walk read every directory
// of the tree. This is the ast_grep_search cell above, for replace.
// RECURRENCE GUARDED: a tool that holds a call signal and hands the paths
// reader none (the #5393 r2 N4 gap, the same seam as the search cell).
describe("#5371 r3 ast_grep_replace's walk ends when the call is aborted mid-expansion (N4)", () => {
	it("hands its combined signal to the walk, not just to the child", async () => {
		const env = setupTestEnvironment("pi-lens-5371r3-replacesignal-", {
			rootMarker: false,
		});
		const controller = new AbortController();
		const real = fs.promises.readdir.bind(fs.promises);
		let reads = 0;
		const spy = vi.spyOn(fs.promises, "readdir").mockImplementation(((
			...args: Parameters<typeof real>
		) => {
			// Only the fixture tree's own listings count: the tool reads other
			// directories before it reaches the reader.
			if (String(args[0]).startsWith(env.tmpDir)) {
				reads += 1;
				controller.abort();
			}
			return real(...args);
		}) as typeof fs.promises.readdir);
		try {
			mk(
				env.tmpDir,
				Array.from({ length: 12 }, (_, index) => `d${index}/f.zzz`),
			);
			const client = {
				ensureAvailable: async () => true,
				replace: vi.fn().mockResolvedValue({ matches: [], totalMatches: 0 }),
				validatePattern: vi.fn().mockResolvedValue({ valid: true }),
				formatMatches: () => "",
			} as never;
			const tool = createAstGrepReplaceTool(client);
			await (
				tool.execute as unknown as (...args: unknown[]) => Promise<unknown>
			)(
				"5371",
				{
					pattern: "var $X",
					rewrite: "let $X",
					lang: "typescript",
					paths: ["**/*.ts"],
				},
				undefined,
				null,
				{ cwd: env.tmpDir, signal: controller.signal },
			);
			expect(reads).toBe(1);
		} finally {
			spy.mockRestore();
			env.cleanup();
		}
	});
});

// F3. Before: the single `path` read kept only `.entries`, so a refused read
// gave `[]` and `resolvePathsScope([])` is "no restriction": a glob `path`
// answered for every cached file, and an existing bracket path answered for its
// own file AND an unrelated one.
describe("#5371 r2 lens_diagnostics single `path` never widens to the whole cache (F3)", () => {
	beforeEach(() => {
		clearWidgetState();
	});

	it("surfaces the reader's refusal and scopes an existing bracket path to its own file", async () => {
		const env = setupTestEnvironment("pi-lens-5371r2-single-", {
			rootMarker: false,
		});
		try {
			const ws = env.tmpDir;
			mk(ws, ["app/[id]/page.tsx", "src/other.ts"]);
			for (const relative of ["app/[id]/page.tsx", "src/other.ts"]) {
				recordDiagnostics(path.join(ws, relative), [
					{
						tool: "oxlint",
						rule: "r",
						message: `unused in ${path.basename(relative)}`,
						line: 1,
						severity: "warning",
					} as never,
				]);
			}
			const tool = createLensDiagnosticsTool(
				{ readCache: () => undefined } as never,
				() => ws,
			);
			const call = async (params: Record<string, unknown>) => {
				const result = (await (
					tool.execute as unknown as (...args: unknown[]) => Promise<{
						isError?: boolean;
						content: { text: string }[];
					}>
				)("5371", params, new AbortController().signal, null, { cwd: ws })) as {
					isError?: boolean;
					content: { text: string }[];
				};
				return {
					isError: result.isError === true,
					text: result.content.map((part) => part.text).join("\n"),
				};
			};
			const glob = await call({ mode: "all", path: "src/**/*.rs" });
			expect(glob.isError).toBe(true);
			expect(glob.text).toContain("no file matches");
			expect(glob.text).not.toContain("other.ts");
			const negated = await call({ mode: "all", path: "!src/a.ts" });
			expect(negated.isError).toBe(true);
			expect(negated.text).not.toContain("other.ts");
			const bracket = await call({ mode: "all", path: "app/[id]/page.tsx" });
			expect(bracket.text).toContain("page.tsx");
			expect(bracket.text).not.toContain("other.ts");
		} finally {
			env.cleanup();
		}
	});
});
