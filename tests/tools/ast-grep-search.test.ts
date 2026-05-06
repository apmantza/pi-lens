import { describe, expect, it, vi } from "vitest";
import { createAstGrepSearchTool } from "../../tools/ast-grep/ast-grep-search.js";

async function makeClient(overrides: Partial<Awaited<Parameters<typeof createAstGrepSearchTool>[0]>> = {}) {
	return {
		ensureAvailable: async () => true,
		search: vi.fn().mockResolvedValue({ matches: [] }),
		formatMatches: () => "",
		...overrides,
	} as Awaited<Parameters<typeof createAstGrepSearchTool>[0]>;
}

describe("ast_grep_search tool", () => {
	describe("schema shape", () => {
		it("lang uses enum not anyOf/const so LLMs do not double-quote it", () => {
			const tool = createAstGrepSearchTool(makeClient());
			const langSchema = (tool.parameters as { properties: Record<string, unknown> }).properties.lang as Record<string, unknown>;
			expect(langSchema.type).toBe("string");
			expect(Array.isArray(langSchema.enum)).toBe(true);
			expect(langSchema.anyOf).toBeUndefined();
			expect(langSchema.const).toBeUndefined();
		});

		it("lang enum includes common languages", () => {
			const tool = createAstGrepSearchTool(makeClient());
			const langSchema = (tool.parameters as { properties: Record<string, unknown> }).properties.lang as { enum: string[] };
			expect(langSchema.enum).toContain("typescript");
			expect(langSchema.enum).toContain("python");
			expect(langSchema.enum).toContain("rust");
		});
	});

	describe("lang double-quote stripping", () => {
		it("handles LLM-over-quoted lang like '\"typescript\"'", async () => {
			const search = vi.fn().mockResolvedValue({ matches: [] });
			const tool = createAstGrepSearchTool(makeClient({ search }));
			await tool.execute(
				"1",
				{ pattern: "console.log($MSG)", lang: '"typescript"' },
				new AbortController().signal,
				null,
				{ cwd: "." },
			);
			expect(search).toHaveBeenCalledWith(
				"console.log($MSG)",
				"typescript",
				expect.anything(),
				expect.anything(),
			);
		});

		it("passes unquoted lang through unchanged", async () => {
			const search = vi.fn().mockResolvedValue({ matches: [] });
			const tool = createAstGrepSearchTool(makeClient({ search }));
			await tool.execute(
				"2",
				{ pattern: "console.log($MSG)", lang: "python" },
				new AbortController().signal,
				null,
				{ cwd: "." },
			);
			expect(search).toHaveBeenCalledWith(
				"console.log($MSG)",
				"python",
				expect.anything(),
				expect.anything(),
			);
		});
	});

	it("rejects plain text or rule-yaml-like patterns before search", async () => {
		const search = vi.fn();
		const tool = createAstGrepSearchTool(makeClient({ search }));
		const result = await tool.execute(
			"3",
			{ pattern: "kind: text", lang: "typescript" },
			new AbortController().signal,
			null,
			{ cwd: "." },
		);

		expect(result.isError).toBe(true);
		expect(String(result.content[0].text)).toContain(
			"expects a valid AST code pattern",
		);
		expect(search).not.toHaveBeenCalled();
	});

	it("runs ast-grep for valid AST patterns", async () => {
		const search = vi.fn().mockResolvedValue({
			matches: [{ file: "src/a.ts", line: 1, text: "function x() {}" }],
		});
		const tool = createAstGrepSearchTool(makeClient({ search, formatMatches: () => "1 match" }));
		const result = await tool.execute(
			"4",
			{
				pattern: "function $NAME($$$ARGS) { $$$BODY }",
				lang: "typescript",
			},
			new AbortController().signal,
			null,
			{ cwd: "." },
		);

		expect(result.isError).toBeUndefined();
		expect(search).toHaveBeenCalledOnce();
		expect(String(result.content[0].text)).toContain("1 match");
	});
});
