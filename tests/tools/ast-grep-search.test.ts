import { describe, expect, it, vi } from "vitest";
import { createAstGrepSearchTool } from "../../tools/ast-grep-search.js";

function makeClient(overrides: Partial<Parameters<typeof createAstGrepSearchTool>[0]> = {}) {
	return {
		ensureAvailable: async () => true,
		search: vi.fn().mockResolvedValue({ matches: [] }),
		searchWithRule: vi.fn().mockResolvedValue({ matches: [], totalMatches: 0 }),
		formatMatches: () => "",
		...overrides,
	} as Parameters<typeof createAstGrepSearchTool>[0];
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

	describe("structural-intent parameters (Phase 3)", () => {
		it("routes to searchWithRule when insideKind is set", async () => {
			const searchWithRule = vi.fn().mockResolvedValue({ matches: [], totalMatches: 0 });
			const search = vi.fn();
			const tool = createAstGrepSearchTool(makeClient({ searchWithRule, search }));
			await tool.execute(
				"s1",
				{ pattern: "console.log($MSG)", lang: "typescript", insideKind: "function_declaration" },
				new AbortController().signal,
				null,
				{ cwd: "." },
			);
			expect(searchWithRule).toHaveBeenCalledOnce();
			expect(search).not.toHaveBeenCalled();
		});

		it("synthesized YAML contains insideKind", async () => {
			const searchWithRule = vi.fn().mockResolvedValue({ matches: [], totalMatches: 0 });
			const tool = createAstGrepSearchTool(makeClient({ searchWithRule }));
			await tool.execute(
				"s2",
				{ pattern: "foo($X)", lang: "typescript", insideKind: "method_definition" },
				new AbortController().signal,
				null,
				{ cwd: "." },
			);
			const calledYaml = searchWithRule.mock.calls[0][0] as string;
			expect(calledYaml).toContain("inside:");
			expect(calledYaml).toContain("method_definition");
			expect(calledYaml).toContain("stopBy: end");
		});

		it("routes to normal search when no structural params", async () => {
			const searchWithRule = vi.fn();
			const search = vi.fn().mockResolvedValue({ matches: [] });
			const tool = createAstGrepSearchTool(makeClient({ searchWithRule, search }));
			await tool.execute(
				"s3",
				{ pattern: "foo($X)", lang: "typescript" },
				new AbortController().signal,
				null,
				{ cwd: "." },
			);
			expect(search).toHaveBeenCalledOnce();
			expect(searchWithRule).not.toHaveBeenCalled();
		});
	});

	describe("rule parameter (Phase 4 YAML passthrough)", () => {
		it("routes to searchWithRule when rule is provided", async () => {
			const searchWithRule = vi.fn().mockResolvedValue({ matches: [], totalMatches: 0 });
			const search = vi.fn();
			const tool = createAstGrepSearchTool(makeClient({ searchWithRule, search }));
			await tool.execute(
				"r1",
				{
					pattern: "ignored",
					lang: "typescript",
					rule: "id: my-rule\nlanguage: TypeScript\nrule:\n  kind: call_expression",
				},
				new AbortController().signal,
				null,
				{ cwd: "." },
			);
			expect(searchWithRule).toHaveBeenCalledOnce();
			expect(search).not.toHaveBeenCalled();
		});

		it("rule takes precedence over pattern when both are supplied", async () => {
			const searchWithRule = vi.fn().mockResolvedValue({ matches: [], totalMatches: 0 });
			const search = vi.fn();
			const tool = createAstGrepSearchTool(makeClient({ searchWithRule, search }));
			await tool.execute(
				"r2",
				{ pattern: "console.log($X)", lang: "typescript", rule: "id: r\nlanguage: TypeScript\nrule:\n  kind: call_expression" },
				new AbortController().signal,
				null,
				{ cwd: "." },
			);
			expect(searchWithRule).toHaveBeenCalledOnce();
			expect(search).not.toHaveBeenCalled();
		});

		it("surfaces searchWithRule errors as isError result", async () => {
			const tool = createAstGrepSearchTool(
				makeClient({ searchWithRule: vi.fn().mockResolvedValue({ matches: [], totalMatches: 0, error: "invalid yaml" }) }),
			);
			const result = await tool.execute(
				"r3",
				// pattern must pass the YAML-guard; rule takes precedence afterward
				{ pattern: "foo($X)", lang: "typescript", rule: "bad yaml {{{" },
				new AbortController().signal,
				null,
				{ cwd: "." },
			);
			expect(result.isError).toBe(true);
			expect(String(result.content[0].text)).toContain("invalid yaml");
		});

		it("passes paths to searchWithRule", async () => {
			const searchWithRule = vi.fn().mockResolvedValue({ matches: [], totalMatches: 0 });
			const tool = createAstGrepSearchTool(makeClient({ searchWithRule }));
			await tool.execute(
				"r4",
				{ pattern: "foo($X)", lang: "typescript", rule: "id: r\nlanguage: TypeScript\nrule:\n  kind: call_expression", paths: ["src/"] },
				new AbortController().signal,
				null,
				{ cwd: "." },
			);
			expect(searchWithRule).toHaveBeenCalledWith(
				expect.any(String),
				["src/"],
			);
		});
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

	describe("error-path remediation hints", () => {
		it("appends a hint for an uncurated (raw stderr) search error", async () => {
			const tool = createAstGrepSearchTool(
				makeClient({
					search: vi.fn().mockResolvedValue({
						matches: [],
						error: "error: a value is required for '--rewrite <FIX>'",
					}),
				}),
			);
			const result = await tool.execute(
				"e1",
				{ pattern: "foo($X)", lang: "typescript" },
				new AbortController().signal,
				null,
				{ cwd: "." },
			);
			expect(result.isError).toBe(true);
			const text = String(result.content[0].text);
			expect(text).toContain("error: a value is required");
			expect(text).toContain("Hint:");
		});

		it("does not double up when the error is already curated (multiple AST nodes)", async () => {
			const curated =
				"Invalid AST pattern: ...\nOriginal error: Multiple AST nodes are detected";
			const tool = createAstGrepSearchTool(
				makeClient({
					search: vi.fn().mockResolvedValue({ matches: [], error: curated }),
				}),
			);
			const result = await tool.execute(
				"e2",
				{ pattern: "foo($X)", lang: "typescript" },
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
