/**
 * #5041: `path` is the canonical single-file parameter, and one shared reader
 * in `tools/shared.ts` owns the `paths` entry rules.
 *
 * Before this change one parameter had three names across the tool surface and
 * `paths` was read five different ways: `ast_grep_search` refused a non-string
 * entry, `ast_grep_outline`, `lens_diagnostics` and MCP `symbol_search` dropped
 * it, and `ast_grep_replace` never looked — so a malformed call produced an
 * empty answer that read as "no match". These cases drive the production tool
 * `execute` of every tool that takes `paths`, one cell per rule per tool, plus
 * the single-file alias cells (a refusal or a scoped answer only happens if the
 * alias is actually read).
 *
 * Recurrence this prevents: `pilens_module_report {path}` refused and
 * `pilens_diagnostics {file}` ran on the default scope with only a warning
 * (#5041), and `symbol_search` ignoring a `paths` spelling its sibling accepts
 * (#5038).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import { createAstGrepOutlineTool } from "../../tools/ast-grep-outline.js";
import { createAstGrepReplaceTool } from "../../tools/ast-grep-replace.js";
import { createAstGrepSearchTool } from "../../tools/ast-grep-search.js";
import { createEffectiveConfigTool } from "../../tools/effective-config.js";
import { createLensDiagnosticMarkTool } from "../../tools/lens-diagnostic-mark.js";
import { createLensDiagnosticsTool } from "../../tools/lens-diagnostics.js";
import { createLspNavigationTool } from "../../tools/lsp-navigation.js";
import { createSymbolSearchTool } from "../../tools/symbol-search.js";
import { pinFixtureHome, setupTestEnvironment } from "../clients/test-utils.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";

type ToolResult = {
	isError?: boolean;
	content: { type: string; text: string }[];
	details?: Record<string, unknown>;
};

function text(result: ToolResult): string {
	return result.content.map((part) => part.text).join("\n");
}

function searchClient() {
	const search = vi.fn().mockResolvedValue({ matches: [] });
	const searchWithRule = vi
		.fn()
		.mockResolvedValue({ matches: [], totalMatches: 0 });
	const outline = vi.fn().mockResolvedValue({ output: [] });
	const replace = vi.fn().mockResolvedValue({ matches: [] });
	const replaceWithRule = vi
		.fn()
		.mockResolvedValue({ matches: [], totalMatches: 0, applied: false });
	return {
		search,
		searchWithRule,
		outline,
		replace,
		replaceWithRule,
		client: {
			ensureAvailable: async () => true,
			search,
			searchWithRule,
			validatePattern: vi.fn().mockResolvedValue({ valid: true }),
			validateRule: vi.fn().mockResolvedValue({ valid: true }),
			formatMatches: () => "",
			outline,
			replace,
			replaceWithRule,
		} as never,
	};
}

/** The four entry rules every tool now shares, with the text each refusal names. */
const PATH_RULES: {
	rule: string;
	entries: unknown;
	expects: string;
}[] = [
	{
		rule: "a non-string entry",
		entries: ["src/a.ts", 42],
		expects: "paths entry 2 must be a string, not number",
	},
	{
		rule: "a blank entry",
		entries: ["   "],
		expects: "paths entry 1 is blank",
	},
	{
		rule: "an empty list",
		entries: [],
		expects: "paths is empty",
	},
	{
		rule: "an over-cap list",
		entries: Array.from({ length: 101 }, (_, index) => `src/f${index}.ts`),
		expects: "paths must contain at most 100 string entries",
	},
	{
		rule: "a non-array value",
		entries: "src",
		expects: "paths must be an array of strings",
	},
];

async function run(
	tool: { execute: (...args: never[]) => Promise<unknown> },
	params: Record<string, unknown>,
	cwd: string,
): Promise<ToolResult> {
	return (await (
		tool.execute as unknown as (
			id: string,
			params: Record<string, unknown>,
			signal: AbortSignal | undefined,
			onUpdate: unknown,
			ctx: { cwd: string },
		) => Promise<ToolResult>
	)("5041", params, new AbortController().signal, null, { cwd })) as ToolResult;
}

/** Every tool that takes `paths`, with a call that would otherwise dispatch. */
function pathsTools(cwd: string) {
	const astGrep = searchClient();
	const readCache = vi.fn(() => undefined);
	return [
		{
			name: "ast_grep_search",
			tool: createAstGrepSearchTool(astGrep.client),
			params: { pattern: "foo($X)", lang: "typescript" },
			dispatched: () => astGrep.search.mock.calls.length > 0,
		},
		{
			name: "ast_grep_outline",
			tool: createAstGrepOutlineTool(astGrep.client),
			params: { lang: "typescript" },
			dispatched: () => astGrep.outline.mock.calls.length > 0,
		},
		{
			name: "ast_grep_replace",
			tool: createAstGrepReplaceTool(astGrep.client),
			params: {
				pattern: "var $X",
				rewrite: "let $X",
				lang: "typescript",
			},
			dispatched: () => astGrep.replace.mock.calls.length > 0,
		},
		{
			name: "symbol_search",
			tool: createSymbolSearchTool(() => cwd),
			params: { query: "authenticate user" },
			// Reaching the word index answers either "No files matched" or that the
			// index is building; a refusal does neither.
			dispatched: (result: ToolResult) =>
				/No files matched|Word index/.test(text(result)),
		},
		{
			name: "lens_diagnostics",
			tool: createLensDiagnosticsTool({ readCache } as never, () => cwd),
			params: {},
			dispatched: () => readCache.mock.calls.length > 0,
		},
	];
}

describe("#5041 the shared `paths` reader's entry rules", () => {
	for (const rule of PATH_RULES) {
		it(`refuses ${rule.rule} on every tool that takes \`paths\``, async () => {
			const env = setupTestEnvironment("pi-lens-5041-paths-");
			try {
				for (const subject of pathsTools(env.tmpDir)) {
					const result = await run(
						subject.tool,
						{ ...subject.params, paths: rule.entries },
						env.tmpDir,
					);
					expect(result.isError, subject.name).toBe(true);
					expect(text(result), subject.name).toContain(rule.expects);
					// A refused entry list never dispatches: the answer must not look
					// like a real (empty) search.
					expect(subject.dispatched(result), subject.name).toBe(false);
				}
			} finally {
				env.cleanup();
			}
		});
	}

	it("keeps admitting a glob, a relative directory and an absolute directory", async () => {
		const env = setupTestEnvironment("pi-lens-5041-paths-ok-");
		try {
			fs.mkdirSync(path.join(env.tmpDir, "src"), { recursive: true });
			fs.writeFileSync(
				path.join(env.tmpDir, "src", "a.ts"),
				"export const value = 1;\n",
			);
			const astGrep = searchClient();
			const tool = createAstGrepSearchTool(astGrep.client);
			for (const entry of [
				"src",
				"./src",
				"src/**/*.ts",
				path.join(env.tmpDir, "src"),
			]) {
				const result = await run(
					tool,
					{ pattern: "foo($X)", lang: "typescript", paths: [entry] },
					env.tmpDir,
				);
				expect(result.isError, entry).toBeFalsy();
			}
			// Every entry reached the child host-resolved, so a relative `src`,
			// `./src` and the absolute directory are one target.
			const targets = astGrep.search.mock.calls.map(
				(call) => (call[2] as string[])[0],
			);
			expect(targets).toEqual([
				path.join(env.tmpDir, "src"),
				path.join(env.tmpDir, "src"),
				path.join(env.tmpDir, "src", "**", "*.ts"),
				path.join(env.tmpDir, "src"),
			]);
		} finally {
			env.cleanup();
		}
	});

	// RECURRENCE GUARDED: the two seams #5043 (the shared defaulted-cwd home
	// ceiling) and #5041 (the shared `paths` reader) each decide on `paths`; an
	// order drift between them is the two-guard disagreement #5039 closed by
	// sharing one guard. Order, on both ast-grep tools that call both: the
	// reader runs first, so `paths: []` (not a defaulted cwd, an invalid list)
	// gets the reader's "paths is empty" refusal even at home, and only an
	// ABSENT `paths` reaches the home ceiling. Neither refusal dispatches.
	describe("the reader and the home ceiling compose (#5039 + #5041)", () => {
		const HOME_TOOLS = [
			{
				name: "ast_grep_search",
				params: { pattern: "foo($X)", lang: "typescript" },
				create: (client: never) => createAstGrepSearchTool(client),
				dispatched: (astGrep: ReturnType<typeof searchClient>) =>
					astGrep.search.mock.calls.length > 0,
			},
			{
				name: "ast_grep_replace",
				params: { pattern: "var $X", rewrite: "let $X", lang: "typescript" },
				create: (client: never) => createAstGrepReplaceTool(client),
				dispatched: (astGrep: ReturnType<typeof searchClient>) =>
					astGrep.replace.mock.calls.length +
						astGrep.replaceWithRule.mock.calls.length >
					0,
			},
		];
		const CASES: {
			paths: unknown;
			expects: string;
			dispatches: boolean;
		}[] = [
			{ paths: [], expects: "paths is empty", dispatches: false },
			{
				paths: undefined,
				expects: "Refused: no `paths` given",
				dispatches: false,
			},
			{ paths: null, expects: "Refused: no `paths` given", dispatches: false },
			{ paths: ["proj"], expects: "", dispatches: true },
		];
		for (const tool of HOME_TOOLS) {
			for (const entry of CASES) {
				it(`${tool.name} at home with paths ${JSON.stringify(entry.paths) ?? "omitted"}`, async () => {
					const pin = pinFixtureHome("sg-5041-home-order");
					try {
						const astGrep = searchClient();
						const params: Record<string, unknown> = { ...tool.params };
						if (entry.paths !== undefined) params.paths = entry.paths;
						const result = await run(
							tool.create(astGrep.client as never),
							params,
							pin.home,
						);
						if (entry.dispatches) {
							expect(result.isError).toBeFalsy();
						} else {
							expect(result.isError).toBe(true);
							expect(text(result)).toContain(entry.expects);
							// An empty list is the reader's refusal, not the home one.
							if (entry.expects === "paths is empty")
								expect(text(result)).not.toContain("Refused");
						}
						expect(tool.dispatched(astGrep)).toBe(entry.dispatches);
					} finally {
						pin.restore();
					}
				});
			}
		}
	});

	it("still defaults an omitted `paths` to the session cwd", async () => {
		const env = setupTestEnvironment("pi-lens-5041-paths-default-");
		try {
			const astGrep = searchClient();
			const tool = createAstGrepSearchTool(astGrep.client);
			const result = await run(
				tool,
				{ pattern: "foo($X)", lang: "typescript" },
				env.tmpDir,
			);
			expect(result.isError).toBeFalsy();
			expect(astGrep.search.mock.calls[0][2]).toEqual([
				path.resolve(env.tmpDir),
			]);
		} finally {
			env.cleanup();
		}
	});
});

describe("#5041 `path` is the canonical single-file parameter", () => {
	it("reads `path` on effective_config, and still reads the older `file`", async () => {
		const env = setupTestEnvironment("pi-lens-5041-effective-");
		try {
			const target = path.join(env.tmpDir, "app.ts");
			fs.writeFileSync(target, "export const value = 1;\n");
			const tool = createEffectiveConfigTool(() => env.tmpDir);
			const canonical = await run(tool, { path: "app.ts" }, env.tmpDir);
			const older = await run(tool, { file: "app.ts" }, env.tmpDir);
			expect(canonical.isError).toBeFalsy();
			expect(canonical.details?.file).toBe(target);
			expect(older.details?.file).toBe(target);
		} finally {
			env.cleanup();
		}
	});

	it("reads `path` on lens_diagnostic_mark, and still reads `filePath`", async () => {
		const env = setupTestEnvironment("pi-lens-5041-mark-");
		try {
			fs.mkdirSync(path.join(env.tmpDir, "src"), { recursive: true });
			fs.writeFileSync(
				path.join(env.tmpDir, "src", "app.ts"),
				"const value = 1;\n",
			);
			const tool = createLensDiagnosticMarkTool(() => env.tmpDir);
			const params = {
				line: 1,
				message: "unused value",
				rule: "no-unused-vars",
				disposition: "false-positive" as const,
			};
			const canonical = await run(
				tool,
				{ ...params, path: "src/app.ts" },
				env.tmpDir,
			);
			const older = await run(
				tool,
				{ ...params, filePath: "src/app.ts" },
				env.tmpDir,
			);
			expect(canonical.isError, text(canonical)).toBeFalsy();
			expect(older.isError, text(older)).toBeFalsy();
			expect(canonical.details?.filePath).toBe(older.details?.filePath);
		} finally {
			env.cleanup();
		}
	});

	it("refuses two spellings that name different files instead of guessing", async () => {
		const env = setupTestEnvironment("pi-lens-5041-conflict-");
		try {
			const tool = createEffectiveConfigTool(() => env.tmpDir);
			const result = await run(
				tool,
				{ path: "a.ts", file: "b.ts" },
				env.tmpDir,
			);
			expect(result.isError).toBe(true);
			expect(text(result)).toContain("name different files");
		} finally {
			env.cleanup();
		}
	});

	it("scopes a lens_diagnostics lsp probe through the `file` alias", async () => {
		const env = setupTestEnvironment("pi-lens-5041-lensdiag-");
		try {
			const bad = path.join(env.tmpDir, "bad.ts");
			fs.writeFileSync(bad, "const value: number = 'bad';\n");
			const service = makeLspServiceDouble({
				touchFile: vi.fn(async () => undefined),
				getDiagnostics: vi.fn(async (file: string) =>
					path.resolve(file) === path.resolve(bad)
						? [
								{
									severity: 1,
									message: "Type 'string' is not assignable to type 'number'.",
									range: {
										start: { line: 0, character: 0 },
										end: { line: 0, character: 1 },
									},
									source: "ts",
								},
							]
						: [],
				),
			});
			const tool = createLensDiagnosticsTool(
				{ readCache: vi.fn(() => undefined) } as never,
				() => env.tmpDir,
				() => service as never,
			);
			const canonical = await run(
				tool,
				{ source: "lsp", path: bad },
				env.tmpDir,
			);
			const aliased = await run(tool, { source: "lsp", file: bad }, env.tmpDir);
			expect(text(aliased)).not.toContain("path or paths is required");
			expect(aliased.details?.filePath).toBe(canonical.details?.filePath);
			expect(text(aliased)).toBe(text(canonical));
		} finally {
			env.cleanup();
		}
	});

	it("ignores a blank alias when another spelling names the file", async () => {
		const env = setupTestEnvironment("pi-lens-5041-blank-alias-");
		try {
			const target = path.join(env.tmpDir, "app.ts");
			fs.writeFileSync(target, "export const value = 1;\n");
			const tool = createEffectiveConfigTool(() => env.tmpDir);
			// Some clients fill every declared property with "": declaring the
			// aliases must not turn such a call into a refusal (#2418).
			const filled = await run(
				tool,
				{ path: "app.ts", file: "", filePath: "" },
				env.tmpDir,
			);
			expect(filled.isError, text(filled)).toBeFalsy();
			expect(filled.details?.file).toBe(target);
			// A lone blank still names nothing, and says so.
			const lone = await run(tool, { file: "  " }, env.tmpDir);
			expect(lone.isError).toBe(true);
			expect(text(lone)).toContain("`file` is blank");
		} finally {
			env.cleanup();
		}
	});

	it("scopes the cache routes to a single `path` too, so an accepted alias never widens", async () => {
		const env = setupTestEnvironment("pi-lens-5041-lensdiag-scope-");
		try {
			const tool = createLensDiagnosticsTool(
				{ readCache: vi.fn(() => undefined) } as never,
				() => env.tmpDir,
			);
			const scoped = await run(
				tool,
				{ source: "session", mode: "delta", file: "src/app.ts" },
				env.tmpDir,
			);
			const unscoped = await run(
				tool,
				{ source: "session", mode: "delta" },
				env.tmpDir,
			);
			// The scope note is the observable difference: without the accepted name
			// the call answers for the whole turn delta, which is what made an
			// ignored `file` read as a clean file.
			expect(text(scoped)).toContain("paths restricts this to cached findings");
			expect(text(unscoped)).not.toContain(
				"paths restricts this to cached findings",
			);
		} finally {
			env.cleanup();
		}
	});

	it("reads the `file`/`filePath` aliases on lsp_navigation", async () => {
		const env = setupTestEnvironment("pi-lens-5041-lspnav-");
		try {
			const tool = createLspNavigationTool(() => false);
			const read = await run(
				tool,
				{ operation: "hover", file: 42 },
				env.tmpDir,
			);
			expect(read.isError).toBe(true);
			expect(text(read)).toContain("`file` must be a string path");
			const conflict = await run(
				tool,
				{ operation: "hover", path: "a.ts", filePath: "b.ts" },
				env.tmpDir,
			);
			expect(conflict.isError).toBe(true);
			expect(text(conflict)).toContain("name different files");
			// An admitted alias must reach the operation's file, not only the
			// refusal: without the forwarding `hover` answers "path is required".
			const canonical = await run(
				tool,
				{ operation: "hover", path: "missing-5041.ts", view: "json" },
				env.tmpDir,
			);
			const aliased = await run(
				tool,
				{ operation: "hover", file: "missing-5041.ts", view: "json" },
				env.tmpDir,
			);
			// The envelope in `content` carries the resolved file; `details` keeps
			// the footer facts only.
			const resolvedFile = (result: ToolResult) =>
				(JSON.parse(text(result)) as { filePath?: string }).filePath;
			expect(resolvedFile(aliased)).toBe(resolvedFile(canonical));
			expect(resolvedFile(aliased)).toContain("missing-5041.ts");
			expect(text(aliased)).not.toContain("path is required");
		} finally {
			env.cleanup();
		}
	});

	// RECURRENCE GUARDED (#5047 r1 F6): the census accepted `path` OR `paths`
	// for every tool, so dropping `path` from `lens_diagnostics` (which still
	// declares `paths`) stayed green. Each tool is held to the one name it takes.
	it("declares `path` on every single-file tool schema and `paths` on every list tool", () => {
		const declared = (tool: { parameters: unknown }): string[] =>
			Object.keys(
				(tool.parameters as { properties?: Record<string, unknown> })
					.properties ?? {},
			);
		const diagnostics = createLensDiagnosticsTool(
			{ readCache: vi.fn(() => undefined) } as never,
			() => ".",
		);
		for (const tool of [
			diagnostics,
			createEffectiveConfigTool(() => "."),
			createLensDiagnosticMarkTool(() => "."),
			createLspNavigationTool(() => false),
		]) {
			expect(declared(tool), tool.name).toContain("path");
		}
		for (const tool of [
			createAstGrepSearchTool(searchClient().client),
			createAstGrepOutlineTool(searchClient().client),
			createAstGrepReplaceTool(searchClient().client),
			createSymbolSearchTool(() => "."),
			diagnostics,
		]) {
			expect(declared(tool), tool.name).toContain("paths");
		}
	});
});

// RECURRENCE GUARDED (#5047 r1 F1, F2): the reader resolves an entry against
// the session cwd, and a workspace directory name is data, not syntax. A
// `[`/`{` in the name was read as a glob by the symbol_search matcher (F1), and
// a U+00A0 in it made `lens_diagnostics source=lsp` resolve the already
// resolved entries a second time, which folded the space and named a sibling
// directory that does not exist (F2, the #4577 R2-2 shape). Each cell drives
// the production tool `execute` with the workspace as cwd; the plain name is
// the control that must answer the same.
describe("#5047 a workspace name is data on every tool that takes a path", () => {
	for (const workspaceName of ["plain", "app[1]", "app{a,b}", "proj a"]) {
		describe(`in a workspace named ${JSON.stringify(workspaceName)}`, () => {
			function makeWorkspace() {
				const env = setupTestEnvironment("pi-lens-5047-ws-");
				const workspace = path.join(env.tmpDir, workspaceName);
				const file = path.join(workspace, "src", "a.ts");
				fs.mkdirSync(path.dirname(file), { recursive: true });
				fs.writeFileSync(file, "export const value: number = 'bad';\n");
				return { env, workspace, file };
			}

			it("hands the ast-grep tools the exact resolved target once", async () => {
				const { env, workspace } = makeWorkspace();
				try {
					const astGrep = searchClient();
					for (const [tool, params, calls] of [
						[
							createAstGrepSearchTool(astGrep.client),
							{ pattern: "foo($X)", lang: "typescript" },
							astGrep.search,
						],
						[
							createAstGrepOutlineTool(astGrep.client),
							{ lang: "typescript" },
							astGrep.outline,
						],
						[
							createAstGrepReplaceTool(astGrep.client),
							{ pattern: "var $X", rewrite: "let $X", lang: "typescript" },
							astGrep.replace,
						],
					] as const) {
						const result = await run(
							tool,
							{ ...params, paths: ["src"] },
							workspace,
						);
						expect(result.isError, text(result)).toBeFalsy();
						const call = calls.mock.calls.at(-1) as unknown[];
						// The only array argument of each client call is its target list.
						const targets = call.find(Array.isArray) as string[];
						expect(targets, tool.name).toEqual([path.join(workspace, "src")]);
					}
				} finally {
					env.cleanup();
				}
			});

			it("answers `lens_diagnostics source=lsp` for `paths` exactly as for `path`", async () => {
				const { env, workspace, file } = makeWorkspace();
				try {
					const touched: string[] = [];
					const service = makeLspServiceDouble({
						touchFile: vi.fn(async (touchedFile: string) => {
							touched.push(touchedFile);
							return undefined;
						}),
						getDiagnostics: vi.fn(() => []),
					});
					const tool = createLensDiagnosticsTool(
						new CacheManager(false),
						() => workspace,
						() => service as never,
					);
					const single = await run(
						tool,
						{ source: "lsp", path: "src/a.ts" },
						workspace,
					);
					const list = await run(
						tool,
						{ source: "lsp", paths: ["src/a.ts"] },
						workspace,
					);
					expect(text(list)).not.toContain("path not found");
					expect(text(single)).not.toContain("path not found");
					expect(list.isError, text(list)).toBe(single.isError);
					// Every spelling checked the real file, never a folded sibling.
					expect(touched.length).toBeGreaterThanOrEqual(2);
					for (const touchedFile of touched) {
						expect(path.resolve(touchedFile)).toBe(path.resolve(file));
					}
				} finally {
					env.cleanup();
				}
			});

			it("scopes the cache routes of `lens_diagnostics` to the resolved entry", async () => {
				const { env, workspace } = makeWorkspace();
				try {
					const tool = createLensDiagnosticsTool(
						new CacheManager(false),
						() => workspace,
					);
					const result = await run(
						tool,
						{ source: "session", mode: "delta", paths: ["src/a.ts"] },
						workspace,
					);
					expect(text(result)).toContain(
						"paths restricts this to cached findings",
					);
					expect(text(result)).not.toContain("path not found");
				} finally {
					env.cleanup();
				}
			});

			it("resolves an `lsp_navigation` path once", async () => {
				const { env, workspace, file } = makeWorkspace();
				try {
					const tool = createLspNavigationTool(() => false);
					const result = await run(
						tool,
						{ operation: "hover", path: "src/a.ts", view: "json" },
						workspace,
					);
					const resolved = (JSON.parse(text(result)) as { filePath?: string })
						.filePath;
					expect(resolved).toBe(file);
				} finally {
					env.cleanup();
				}
			});
		});
	}
});
