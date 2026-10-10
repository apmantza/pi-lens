import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createAstGrepReplaceTool } from "../../tools/ast-grep-replace.js";
import { setupTestEnvironment } from "../clients/test-utils.js";

function makeClient(
	overrides: Partial<Parameters<typeof createAstGrepReplaceTool>[0]> = {},
) {
	return {
		ensureAvailable: async () => true,
		replace: vi.fn().mockResolvedValue({ matches: [] }),
		replaceWithRule: vi
			.fn()
			.mockResolvedValue({ matches: [], totalMatches: 0, applied: false }),
		formatMatches: () => "",
		...overrides,
	} as Parameters<typeof createAstGrepReplaceTool>[0];
}

describe("ast_grep_replace tool", () => {
	describe("relative paths resolve against ctx.cwd (#4233 V3-HIGH-01)", () => {
		it("passes an absolute target to the pattern replace", async () => {
			const env = setupTestEnvironment("pi-lens-sg-replace-rel-");
			try {
				const replace = vi
					.fn()
					.mockResolvedValue({ matches: [], totalMatches: 0, applied: false });
				const tool = createAstGrepReplaceTool(makeClient({ replace }));
				await tool.execute(
					"rel-1",
					{
						pattern: "var $X",
						rewrite: "let $X",
						lang: "typescript",
						paths: ["src/a.ts"],
					},
					new AbortController().signal,
					null,
					{ cwd: env.tmpDir },
				);
				// The ast-grep child runs from a pi-lens-owned neutral cwd when its npx
				// fallback wins (#4193), so every target must be absolute before dispatch.
				expect(replace).toHaveBeenCalledWith(
					"var $X",
					"let $X",
					"typescript",
					[path.join(env.tmpDir, "src", "a.ts")],
					false,
					expect.anything(),
				);
			} finally {
				env.cleanup();
			}
		});

		it("passes an absolute target to a structural rule replace", async () => {
			const env = setupTestEnvironment("pi-lens-sg-replace-rule-rel-");
			try {
				const replaceWithRule = vi.fn().mockResolvedValue({
					matches: [],
					totalMatches: 0,
					applied: false,
				});
				const tool = createAstGrepReplaceTool(makeClient({ replaceWithRule }));
				await tool.execute(
					"rel-2",
					{
						pattern: "var $X",
						rewrite: "let $X",
						lang: "typescript",
						paths: ["src/a.ts"],
						insideKind: "function_declaration",
					},
					new AbortController().signal,
					null,
					{ cwd: env.tmpDir },
				);
				expect(replaceWithRule).toHaveBeenCalledWith(
					expect.any(String),
					[path.join(env.tmpDir, "src", "a.ts")],
					false,
					expect.anything(),
				);
			} finally {
				env.cleanup();
			}
		});
	});

	describe("schema shape", () => {
		it("lang uses enum not anyOf/const so LLMs do not double-quote it", () => {
			const tool = createAstGrepReplaceTool(makeClient());
			const langSchema = (
				tool.parameters as { properties: Record<string, unknown> }
			).properties.lang as Record<string, unknown>;
			expect(langSchema.type).toBe("string");
			expect(Array.isArray(langSchema.enum)).toBe(true);
			expect(langSchema.anyOf).toBeUndefined();
			expect(langSchema.const).toBeUndefined();
		});

		it("lang enum includes common languages", () => {
			const tool = createAstGrepReplaceTool(makeClient());
			const langSchema = (
				tool.parameters as { properties: Record<string, unknown> }
			).properties.lang as { enum: string[] };
			expect(langSchema.enum).toContain("typescript");
			expect(langSchema.enum).toContain("python");
			expect(langSchema.enum).toContain("rust");
		});

		it("hasKind description describes immediate-child semantics, not descendant (#1423)", () => {
			const tool = createAstGrepReplaceTool(makeClient());
			const properties = (
				tool.parameters as { properties: Record<string, unknown> }
			).properties;
			const hasKindSchema = properties.hasKind as { description: string };
			expect(hasKindSchema.description).not.toContain("descendant");
			expect(hasKindSchema.description.toLowerCase()).toContain(
				"immediate child",
			);
		});

		it("advertises hasDescendantKind alongside hasKind (#1423)", () => {
			const tool = createAstGrepReplaceTool(makeClient());
			const properties = (
				tool.parameters as { properties: Record<string, unknown> }
			).properties;
			expect(properties).toHaveProperty("hasDescendantKind");
			const hasDescendantKindSchema = properties.hasDescendantKind as {
				description: string;
			};
			expect(hasDescendantKindSchema.description.toLowerCase()).toContain(
				"descendant",
			);
		});
	});

	describe("lang double-quote stripping", () => {
		it("handles LLM-over-quoted lang like '\"typescript\"'", async () => {
			const replace = vi.fn().mockResolvedValue({ matches: [] });
			const tool = createAstGrepReplaceTool(makeClient({ replace }));
			await tool.execute(
				"1",
				{ pattern: "var $X", rewrite: "let $X", lang: '"typescript"' },
				new AbortController().signal,
				null,
				{ cwd: "." },
			);
			expect(replace).toHaveBeenCalledWith(
				"var $X",
				"let $X",
				"typescript",
				expect.anything(),
				expect.anything(),
				expect.anything(),
			);
		});

		it("passes unquoted lang through unchanged", async () => {
			const replace = vi.fn().mockResolvedValue({ matches: [] });
			const tool = createAstGrepReplaceTool(makeClient({ replace }));
			await tool.execute(
				"2",
				{ pattern: "var $X", rewrite: "let $X", lang: "javascript" },
				new AbortController().signal,
				null,
				{ cwd: "." },
			);
			expect(replace).toHaveBeenCalledWith(
				"var $X",
				"let $X",
				"javascript",
				expect.anything(),
				expect.anything(),
				expect.anything(),
			);
		});
	});

	it("dry-runs by default (apply not passed)", async () => {
		const replace = vi.fn().mockResolvedValue({ matches: [] });
		const tool = createAstGrepReplaceTool(makeClient({ replace }));
		await tool.execute(
			"3",
			{ pattern: "var $X", rewrite: "let $X", lang: "typescript" },
			new AbortController().signal,
			null,
			{ cwd: "." },
		);
		expect(replace).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.anything(),
			false,
			expect.anything(),
		);
	});

	describe("structural-intent parameters (Phase 3)", () => {
		it("routes to replaceWithRule when insideKind is set", async () => {
			const replaceWithRule = vi
				.fn()
				.mockResolvedValue({ matches: [], totalMatches: 0, applied: false });
			const replace = vi.fn();
			const tool = createAstGrepReplaceTool(
				makeClient({ replaceWithRule, replace }),
			);
			await tool.execute(
				"r1",
				{
					pattern: "var $X",
					rewrite: "let $X",
					lang: "typescript",
					insideKind: "function_declaration",
				},
				new AbortController().signal,
				null,
				{ cwd: "." },
			);
			expect(replaceWithRule).toHaveBeenCalledOnce();
			expect(replace).not.toHaveBeenCalled();
		});

		it("synthesized YAML includes fix field", async () => {
			const replaceWithRule = vi
				.fn()
				.mockResolvedValue({ matches: [], totalMatches: 0, applied: false });
			const tool = createAstGrepReplaceTool(makeClient({ replaceWithRule }));
			await tool.execute(
				"r2",
				{
					pattern: "var $X",
					rewrite: "let $X",
					lang: "javascript",
					insideKind: "function_declaration",
				},
				new AbortController().signal,
				null,
				{ cwd: "." },
			);
			const calledYaml = replaceWithRule.mock.calls[0][0] as string;
			expect(calledYaml).toContain("fix:");
			expect(calledYaml).toContain("let $X");
			expect(calledYaml).toContain("inside:");
		});

		it("routes to normal replace when no structural params", async () => {
			const replaceWithRule = vi.fn();
			const replace = vi.fn().mockResolvedValue({ matches: [] });
			const tool = createAstGrepReplaceTool(
				makeClient({ replaceWithRule, replace }),
			);
			await tool.execute(
				"r3",
				{ pattern: "var $X", rewrite: "let $X", lang: "typescript" },
				new AbortController().signal,
				null,
				{ cwd: "." },
			);
			expect(replace).toHaveBeenCalledOnce();
			expect(replaceWithRule).not.toHaveBeenCalled();
		});

		it("routes to replaceWithRule when hasDescendantKind is set, producing stopBy: end (#1423)", async () => {
			const replaceWithRule = vi
				.fn()
				.mockResolvedValue({ matches: [], totalMatches: 0, applied: false });
			const replace = vi.fn();
			const tool = createAstGrepReplaceTool(
				makeClient({ replaceWithRule, replace }),
			);
			await tool.execute(
				"r4",
				{
					pattern: "var $X",
					rewrite: "let $X",
					lang: "typescript",
					hasDescendantKind: "await_expression",
				},
				new AbortController().signal,
				null,
				{ cwd: "." },
			);
			expect(replaceWithRule).toHaveBeenCalledOnce();
			expect(replace).not.toHaveBeenCalled();
			const calledYaml = replaceWithRule.mock.calls[0][0] as string;
			expect(calledYaml).toContain("has:");
			expect(calledYaml).toContain("kind: await_expression");
			expect(calledYaml).toContain("stopBy: end");
			expect(calledYaml).toContain("fix:");
		});

		it("errors clearly when hasKind and hasDescendantKind are combined (#1423)", async () => {
			const replaceWithRule = vi.fn();
			const tool = createAstGrepReplaceTool(makeClient({ replaceWithRule }));
			const result = await tool.execute(
				"r5",
				{
					pattern: "var $X",
					rewrite: "let $X",
					lang: "typescript",
					hasKind: "identifier",
					hasDescendantKind: "await_expression",
				},
				new AbortController().signal,
				null,
				{ cwd: "." },
			);
			expect(replaceWithRule).not.toHaveBeenCalled();
			expect(result.isError).toBe(true);
			const text = String(result.content[0].text);
			expect(text).toContain("mutually exclusive");
		});
	});

	it("applies changes when apply=true", async () => {
		const replace = vi.fn().mockResolvedValue({ matches: [] });
		const tool = createAstGrepReplaceTool(makeClient({ replace }));
		await tool.execute(
			"4",
			{ pattern: "var $X", rewrite: "let $X", lang: "typescript", apply: true },
			new AbortController().signal,
			null,
			{ cwd: "." },
		);
		expect(replace).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.anything(),
			true,
			expect.anything(),
		);
	});

	describe("error-path remediation hints", () => {
		it("appends a hint for an uncurated (raw stderr) replace error", async () => {
			const tool = createAstGrepReplaceTool(
				makeClient({
					replace: vi.fn().mockResolvedValue({
						matches: [],
						error: "error: a value is required for '--rewrite <FIX>'",
					}),
				}),
			);
			const result = await tool.execute(
				"e1",
				{ pattern: "var $X", rewrite: "", lang: "typescript" },
				new AbortController().signal,
				null,
				{ cwd: "." },
			);
			expect(result.isError).toBe(true);
			const text = String(result.content[0].text);
			expect(text).toContain("error: a value is required");
			expect(text).toContain("Hint:");
		});

		it("does not double up when the error is already curated", async () => {
			const curated =
				"Invalid AST pattern: ...\nOriginal error: Multiple AST nodes are detected";
			const tool = createAstGrepReplaceTool(
				makeClient({
					replace: vi.fn().mockResolvedValue({ matches: [], error: curated }),
				}),
			);
			const result = await tool.execute(
				"e2",
				{ pattern: "var $X", rewrite: "let $X", lang: "typescript" },
				new AbortController().signal,
				null,
				{ cwd: "." },
			);
			expect(result.isError).toBe(true);
			const text = String(result.content[0].text);
			expect(text).toContain("Multiple AST nodes are detected");
			expect(text).not.toContain("Hint:");
		});
	});
});
