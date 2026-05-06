import { describe, expect, it, vi } from "vitest";
import { createAstGrepReplaceTool } from "../../tools/ast-grep/ast-grep-replace.js";

async function makeClient(overrides: Partial<Awaited<Parameters<typeof createAstGrepReplaceTool>[0]>> = {}) {
	return {
		ensureAvailable: async () => true,
		replace: vi.fn().mockResolvedValue({ matches: [] }),
		formatMatches: () => "",
		...overrides,
	} as Awaited<Parameters<typeof createAstGrepReplaceTool>[0]>;
}

describe("ast_grep_replace tool", () => {
	describe("schema shape", () => {
		it("lang uses enum not anyOf/const so LLMs do not double-quote it", () => {
			const tool = createAstGrepReplaceTool(makeClient());
			const langSchema = (tool.parameters as { properties: Record<string, unknown> }).properties.lang as Record<string, unknown>;
			expect(langSchema.type).toBe("string");
			expect(Array.isArray(langSchema.enum)).toBe(true);
			expect(langSchema.anyOf).toBeUndefined();
			expect(langSchema.const).toBeUndefined();
		});

		it("lang enum includes common languages", () => {
			const tool = createAstGrepReplaceTool(makeClient());
			const langSchema = (tool.parameters as { properties: Record<string, unknown> }).properties.lang as { enum: string[] };
			expect(langSchema.enum).toContain("typescript");
			expect(langSchema.enum).toContain("python");
			expect(langSchema.enum).toContain("rust");
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
		);
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
		);
	});
});
