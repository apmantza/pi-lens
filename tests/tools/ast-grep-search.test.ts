import { describe, expect, it, vi } from "vitest";
import { createAstGrepSearchTool } from "../../tools/ast-grep-search.js";

describe("ast_grep_search tool", () => {
	it("rejects plain text or rule-yaml-like patterns before search", async () => {
		const search = vi.fn();
		const astGrepClient = {
			ensureAvailable: async () => true,
			search,
			formatMatches: () => "",
		};

		const tool = createAstGrepSearchTool(astGrepClient as never);
		const result = await tool.execute(
			"1",
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
		const astGrepClient = {
			ensureAvailable: async () => true,
			search,
			formatMatches: () => "1 match",
		};

		const tool = createAstGrepSearchTool(astGrepClient as never);
		const result = await tool.execute(
			"2",
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
