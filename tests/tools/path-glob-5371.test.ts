/**
 * #5371: a glob entry in `paths` means the same thing in every tool that takes
 * `paths`, because the ONE shared reader expands it.
 *
 * Before this change `paths: ["src/**\/*.ts"]` found the files in
 * `symbol_search` and silently matched nothing everywhere else: the ast-grep
 * tools handed the glob to the CLI as a literal target ("No matches found"),
 * `ast_grep_outline` answered "No outline items found", and
 * `lens_diagnostics source=lsp` answered `<glob>: path not found` — a wrong
 * clean an agent reads as a real answer. Each consumer interpreted the same
 * entries itself: minimatch, literal argv, or `statSync`.
 *
 * These cases drive the production `execute` of every tool that takes `paths`
 * (and the MCP mirror of one of them) over one real tree, and pin the four
 * rules the shared reader now owns: a glob expands against the tool's own root;
 * an entry with no glob characters passes through unchanged; a glob that
 * matches nothing refuses with "no file matches", never "path not found"; the
 * expansion is bounded by the reader's own entry cap and honours the shared
 * project-ignore rules.
 *
 * RECURRENCE GUARDED (#5371): the alignment routine's family 5 — one parameter,
 * three meanings, and a parameter description that claimed an equivalence only
 * one tool honoured (#771 asked for globs, #5038 kept them on `symbol_search`,
 * #5041 unified the READER but not the MEANING).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearWidgetState,
	recordDiagnostics,
} from "../../clients/widget-state.js";
import { createAstGrepOutlineTool } from "../../tools/ast-grep-outline.js";
import { createAstGrepReplaceTool } from "../../tools/ast-grep-replace.js";
import { createAstGrepSearchTool } from "../../tools/ast-grep-search.js";
import { createLensDiagnosticsTool } from "../../tools/lens-diagnostics.js";
import { MAX_PATHS_ENTRIES } from "../../tools/shared.js";
import { setupTestEnvironment } from "../clients/test-utils.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";

type ToolResult = {
	isError?: boolean;
	content: { type: string; text: string }[];
	details?: Record<string, unknown>;
};

function text(result: ToolResult): string {
	return result.content.map((part) => part.text).join("\n");
}

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
	)("5371", params, new AbortController().signal, null, { cwd })) as ToolResult;
}

/**
 * The issue's fixture: two `.ts` files at two depths (a `**` must cross the
 * boundary), one `.js` sibling the pattern must not pull in, one markdown file
 * (a glob is not restricted to code), and a gitignored directory the expansion
 * must leave out the way every project walker does.
 */
function makeTree(ws: string): { inScope: string[]; outside: string } {
	const files: Array<[string, string]> = [
		["src/a.ts", "export function hello() { return 1; }\n"],
		["src/sub/b.ts", "export function hello() { return 2; }\n"],
		["src/a.js", "export function hello() { return 3; }\n"],
		["src/notes.md", "# hello\n"],
		["src/generated/skip.ts", "export function hello() { return 4; }\n"],
		["outside.ts", "export function hello() { return 5; }\n"],
	];
	for (const [relative, content] of files) {
		const file = path.join(ws, relative);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, content);
	}
	fs.writeFileSync(path.join(ws, ".gitignore"), "generated/\n");
	return {
		inScope: [
			path.join(ws, "src", "a.ts"),
			path.join(ws, "src", "sub", "b.ts"),
		],
		outside: path.join(ws, "outside.ts"),
	};
}

/** A stubbed ast-grep client that records the targets each verb received. */
function astGrepDouble() {
	const search = vi.fn().mockResolvedValue({ matches: [], totalMatches: 0 });
	const replace = vi
		.fn()
		.mockResolvedValue({ matches: [], totalMatches: 0, applied: false });
	const outline = vi.fn().mockResolvedValue({ output: [] });
	return {
		search,
		replace,
		outline,
		client: {
			ensureAvailable: async () => true,
			search,
			searchWithRule: vi
				.fn()
				.mockResolvedValue({ matches: [], totalMatches: 0 }),
			outline,
			replace,
			replaceWithRule: vi
				.fn()
				.mockResolvedValue({ matches: [], totalMatches: 0, applied: false }),
			validatePattern: vi.fn().mockResolvedValue({ valid: true }),
			validateRule: vi.fn().mockResolvedValue({ valid: true }),
			formatMatches: () => "",
		} as never,
	};
}

function lspDouble() {
	return makeLspServiceDouble({
		touchFile: vi.fn(async () => undefined),
		getDiagnostics: vi.fn(async () => []),
		getDiagnosticsHealth: vi.fn(() => undefined),
		getCapabilitySnapshots: vi.fn(async () => []),
	});
}

function pathsDescription(tool: { parameters: unknown }): string {
	const schema = tool.parameters as {
		properties: { paths?: { description?: string } };
	};
	return schema.properties.paths?.description ?? "";
}

describe("#5371 the shared `paths` reader expands a glob once for every tool", () => {
	beforeEach(() => {
		clearWidgetState();
	});

	it("expands `src/**/*.ts` into the matching files for the three ast-grep tools", async () => {
		const env = setupTestEnvironment("pi-lens-5371-astgrep-");
		try {
			const { inScope } = makeTree(env.tmpDir);
			const astGrep = astGrepDouble();
			const search = createAstGrepSearchTool(astGrep.client);
			const replace = createAstGrepReplaceTool(astGrep.client);
			const outline = createAstGrepOutlineTool(astGrep.client);

			const s = await run(
				search,
				{
					pattern: "function hello($$$A) { $$$B }",
					lang: "typescript",
					paths: ["src/**/*.ts"],
				},
				env.tmpDir,
			);
			expect(s.isError, text(s)).toBeFalsy();
			const r = await run(
				replace,
				{
					pattern: "function hello($$$A) { $$$B }",
					rewrite: "function hi() {}",
					lang: "typescript",
					paths: ["src/**/*.ts"],
				},
				env.tmpDir,
			);
			expect(r.isError, text(r)).toBeFalsy();
			const o = await run(
				outline,
				{ lang: "typescript", paths: ["src/**/*.ts"] },
				env.tmpDir,
			);
			expect(o.isError, text(o)).toBeFalsy();

			const sorted = (entries: unknown) =>
				(entries as string[]).slice().sort().join("|");
			const expected = sorted(inScope);
			expect(sorted(astGrep.search.mock.calls[0][2]), "search").toBe(expected);
			expect(sorted(astGrep.replace.mock.calls[0][3]), "replace").toBe(
				expected,
			);
			expect(sorted(astGrep.outline.mock.calls[0][0]), "outline").toBe(
				expected,
			);
		} finally {
			env.cleanup();
		}
	});

	it("expands a non-code glob and keeps the ignore rules of the project walkers", async () => {
		const env = setupTestEnvironment("pi-lens-5371-ignore-");
		try {
			makeTree(env.tmpDir);
			const astGrep = astGrepDouble();
			const md = await run(
				createAstGrepOutlineTool(astGrep.client),
				{ lang: "typescript", paths: ["src/*.md"] },
				env.tmpDir,
			);
			expect(md.isError, text(md)).toBeFalsy();
			expect(astGrep.outline.mock.calls[0][0]).toEqual([
				path.join(env.tmpDir, "src", "notes.md"),
			]);

			// A `**` glob must not reach the gitignored directory, the same way the
			// word-index walk and every scan walker prune it.
			astGrep.outline.mockClear();
			const all = await run(
				createAstGrepOutlineTool(astGrep.client),
				{ lang: "typescript", paths: ["**/*.ts"] },
				env.tmpDir,
			);
			expect(all.isError, text(all)).toBeFalsy();
			const targets = astGrep.outline.mock.calls[0][0] as string[];
			expect(targets).toContain(path.join(env.tmpDir, "outside.ts"));
			expect(targets.some((target) => target.includes("generated"))).toBe(
				false,
			);
		} finally {
			env.cleanup();
		}
	});

	it("scopes `lens_diagnostics mode=all` to the files the glob names", async () => {
		const env = setupTestEnvironment("pi-lens-5371-cache-");
		try {
			const { inScope, outside } = makeTree(env.tmpDir);
			for (const file of [...inScope, outside]) {
				recordDiagnostics(file, [
					{
						tool: "oxlint",
						rule: "no-unused",
						message: `unused in ${path.basename(file)}`,
						line: 1,
						severity: "warning",
					},
				]);
			}
			const tool = createLensDiagnosticsTool(
				{ readCache: vi.fn(() => undefined) } as never,
				() => env.tmpDir,
			);
			const result = await run(
				tool,
				{ mode: "all", paths: ["src/**/*.ts"] },
				env.tmpDir,
			);
			const answer = text(result);
			expect(result.isError, answer).toBeFalsy();
			expect(answer).toContain(path.join("src", "a.ts"));
			expect(answer).toContain(path.join("src", "sub", "b.ts"));
			expect(answer).not.toContain("outside.ts");
		} finally {
			env.cleanup();
		}
	});

	it("checks exactly the glob's files on the `source=lsp` route", async () => {
		const env = setupTestEnvironment("pi-lens-5371-lsp-");
		try {
			const { outside } = makeTree(env.tmpDir);
			const tool = createLensDiagnosticsTool(
				{ readCache: vi.fn(() => undefined) } as never,
				() => env.tmpDir,
				() => lspDouble() as never,
			);
			const result = await run(
				tool,
				{
					source: "lsp",
					mode: "full",
					paths: ["src/**/*.ts"],
					severity: "all",
				},
				env.tmpDir,
			);
			const answer = text(result);
			expect(result.isError, answer).toBeFalsy();
			expect(answer).not.toContain("path not found");
			expect(result.details?.filesChecked).toBe(2);
			expect(answer).not.toContain(path.basename(outside));
		} finally {
			env.cleanup();
		}
	});

	it("refuses a glob that matches nothing with a glob-specific message, never `path not found`", async () => {
		const env = setupTestEnvironment("pi-lens-5371-nomatch-");
		try {
			makeTree(env.tmpDir);
			const astGrep = astGrepDouble();
			const cases: Array<{
				name: string;
				tool: never;
				params: Record<string, unknown>;
			}> = [
				{
					name: "ast_grep_search",
					tool: createAstGrepSearchTool(astGrep.client) as never,
					params: { pattern: "foo($X)", lang: "typescript" },
				},
				{
					name: "ast_grep_replace",
					tool: createAstGrepReplaceTool(astGrep.client) as never,
					params: { pattern: "var $X", rewrite: "let $X", lang: "typescript" },
				},
				{
					name: "ast_grep_outline",
					tool: createAstGrepOutlineTool(astGrep.client) as never,
					params: { lang: "typescript" },
				},
				{
					name: "lens_diagnostics",
					tool: createLensDiagnosticsTool(
						{ readCache: vi.fn(() => undefined) } as never,
						() => env.tmpDir,
					) as never,
					params: { mode: "all" },
				},
			];
			for (const subject of cases) {
				const result = await run(
					subject.tool,
					{ ...subject.params, paths: ["src/**/*.rs"] },
					env.tmpDir,
				);
				const answer = text(result);
				expect(result.isError, subject.name).toBe(true);
				expect(answer, subject.name).toContain("no file matches");
				expect(answer, subject.name).toContain("src/**/*.rs");
				expect(answer, subject.name).not.toContain("path not found");
				expect(answer, subject.name).not.toMatch(
					/No matches found|No outline items/,
				);
			}
			expect(astGrep.search.mock.calls.length, "no child dispatch").toBe(0);
		} finally {
			env.cleanup();
		}
	});

	it("keeps a missing LITERAL entry a missing file, the pre-existing answer", async () => {
		const env = setupTestEnvironment("pi-lens-5371-literal-");
		try {
			makeTree(env.tmpDir);
			const tool = createLensDiagnosticsTool(
				{ readCache: vi.fn(() => undefined) } as never,
				() => env.tmpDir,
				() => lspDouble() as never,
			);
			const result = await run(
				tool,
				{
					source: "lsp",
					mode: "full",
					paths: ["src/gone.ts"],
					severity: "all",
				},
				env.tmpDir,
			);
			const answer = text(result);
			// A caller that names a path must still hear the file is absent; only a
			// GLOB entry gets the "no file matches" wording.
			expect(answer).toContain("path not found");
			expect(answer).not.toContain("no file matches");
		} finally {
			env.cleanup();
		}
	});

	it("bounds the expansion by the shared `paths` cap and names the cap", async () => {
		const env = setupTestEnvironment("pi-lens-5371-cap-");
		try {
			for (let index = 0; index <= MAX_PATHS_ENTRIES; index += 1) {
				const file = path.join(env.tmpDir, "src", `f${index}.ts`);
				fs.mkdirSync(path.dirname(file), { recursive: true });
				fs.writeFileSync(file, "export const value = 1;\n");
			}
			const astGrep = astGrepDouble();
			const result = await run(
				createAstGrepSearchTool(astGrep.client),
				{ pattern: "foo($X)", lang: "typescript", paths: ["src/**/*.ts"] },
				env.tmpDir,
			);
			const answer = text(result);
			expect(result.isError).toBe(true);
			expect(answer).toContain(String(MAX_PATHS_ENTRIES));
			expect(answer).toContain("src/**/*.ts");
			expect(astGrep.search.mock.calls.length).toBe(0);
		} finally {
			env.cleanup();
		}
	});

	it("expands an absolute glob entry to the same files as the relative one", async () => {
		const env = setupTestEnvironment("pi-lens-5371-abs-");
		try {
			const { inScope } = makeTree(env.tmpDir);
			const relative = astGrepDouble();
			const absolute = astGrepDouble();
			await run(
				createAstGrepSearchTool(relative.client),
				{ pattern: "foo($X)", lang: "typescript", paths: ["src/**/*.ts"] },
				env.tmpDir,
			);
			await run(
				createAstGrepSearchTool(absolute.client),
				{
					pattern: "foo($X)",
					lang: "typescript",
					paths: [path.join(env.tmpDir, "src", "**", "*.ts")],
				},
				env.tmpDir,
			);
			const sorted = (entries: unknown) =>
				(entries as string[]).slice().sort().join("|");
			expect(sorted(absolute.search.mock.calls[0][2])).toBe(
				sorted(relative.search.mock.calls[0][2]),
			);
			expect(sorted(absolute.search.mock.calls[0][2])).toBe(sorted(inScope));
		} finally {
			env.cleanup();
		}
	});

	it("states the shared `paths` contract in every tool's own description", () => {
		const astGrep = astGrepDouble();
		const described: Array<[string, string]> = [
			[
				"ast_grep_search",
				pathsDescription(createAstGrepSearchTool(astGrep.client)),
			],
			[
				"ast_grep_replace",
				pathsDescription(createAstGrepReplaceTool(astGrep.client)),
			],
			[
				"ast_grep_outline",
				pathsDescription(createAstGrepOutlineTool(astGrep.client)),
			],
			[
				"lens_diagnostics",
				pathsDescription(
					createLensDiagnosticsTool(
						{ readCache: vi.fn(() => undefined) } as never,
						() => "/tmp",
					),
				),
			],
		];
		for (const [name, description] of described) {
			expect(description, name).toMatch(/glob/i);
			expect(description, name).toMatch(
				/no file matches|matched no file|matches no file/i,
			);
		}
	});
});
