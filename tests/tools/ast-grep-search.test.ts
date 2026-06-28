import { describe, expect, it, vi } from "vitest";
import {
	_telemetryClassificationErrorForTest,
	_telemetryErrorForTest,
	createAstGrepSearchTool,
} from "../../tools/ast-grep-search.js";

function makeClient(
	overrides: Partial<Parameters<typeof createAstGrepSearchTool>[0]> = {},
) {
	return {
		ensureAvailable: async () => true,
		search: vi.fn().mockResolvedValue({ matches: [] }),
		searchWithRule: vi.fn().mockResolvedValue({ matches: [], totalMatches: 0 }),
		validatePattern: vi.fn().mockResolvedValue({ valid: true }),
		validateRule: vi.fn().mockResolvedValue({ valid: true }),
		formatMatches: () => "",
		...overrides,
	} as Parameters<typeof createAstGrepSearchTool>[0];
}

describe("ast_grep_search tool", () => {
	describe("telemetry sanitization", () => {
		it("escapes NUL bytes and truncates long subprocess errors", () => {
			expect(_telemetryErrorForTest(undefined)).toBeUndefined();
			expect(_telemetryErrorForTest("bad\0error")).toBe("bad\\0error");
			const long = "x".repeat(2_100);
			expect(_telemetryErrorForTest(long)).toHaveLength(2_000);
		});

		it("removes NUL bytes before error classification", () => {
			expect(_telemetryClassificationErrorForTest("cannot\0 parse query")).toBe(
				"cannot parse query",
			);
		});
	});

	describe("schema shape", () => {
		it("lang uses enum not anyOf/const so LLMs do not double-quote it", () => {
			const tool = createAstGrepSearchTool(makeClient());
			const langSchema = (
				tool.parameters as { properties: Record<string, unknown> }
			).properties.lang as Record<string, unknown>;
			expect(langSchema.type).toBe("string");
			expect(Array.isArray(langSchema.enum)).toBe(true);
			expect(langSchema.anyOf).toBeUndefined();
			expect(langSchema.const).toBeUndefined();
		});

		it("lang enum includes common languages", () => {
			const tool = createAstGrepSearchTool(makeClient());
			const langSchema = (
				tool.parameters as { properties: Record<string, unknown> }
			).properties.lang as { enum: string[] };
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
			const searchWithRule = vi
				.fn()
				.mockResolvedValue({ matches: [], totalMatches: 0 });
			const search = vi.fn();
			const tool = createAstGrepSearchTool(
				makeClient({ searchWithRule, search }),
			);
			await tool.execute(
				"s1",
				{
					pattern: "console.log($MSG)",
					lang: "typescript",
					insideKind: "function_declaration",
				},
				new AbortController().signal,
				null,
				{ cwd: "." },
			);
			expect(searchWithRule).toHaveBeenCalledOnce();
			expect(search).not.toHaveBeenCalled();
		});

		it("synthesized YAML contains insideKind", async () => {
			const searchWithRule = vi
				.fn()
				.mockResolvedValue({ matches: [], totalMatches: 0 });
			const tool = createAstGrepSearchTool(makeClient({ searchWithRule }));
			await tool.execute(
				"s2",
				{
					pattern: "foo($X)",
					lang: "typescript",
					insideKind: "method_definition",
				},
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
			const tool = createAstGrepSearchTool(
				makeClient({ searchWithRule, search }),
			);
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

		it("returns a graceful error when structural rule synthesis fails", async () => {
			const searchWithRule = vi.fn();
			const tool = createAstGrepSearchTool(makeClient({ searchWithRule }));
			const result = await tool.execute(
				"s4",
				{
					pattern: "foo($X)",
					lang: "typescript",
					insideKind: "function_declaration\nutils:",
				},
				new AbortController().signal,
				null,
				{ cwd: "." },
			);

			expect(result.isError).toBe(true);
			expect(String(result.content[0].text)).toContain(
				"Error synthesizing rule",
			);
			expect(searchWithRule).not.toHaveBeenCalled();
		});
	});

	describe("validateOnly", () => {
		it("validates a pattern without scanning project paths", async () => {
			const validatePattern = vi.fn().mockResolvedValue({ valid: true });
			const search = vi.fn();
			const searchWithRule = vi.fn();
			const tool = createAstGrepSearchTool(
				makeClient({ validatePattern, search, searchWithRule }),
			);

			const result = await tool.execute(
				"validate-pattern",
				{
					pattern: "console.log($MSG)",
					lang: "typescript",
					validateOnly: true,
					strictness: "relaxed",
				},
				new AbortController().signal,
				null,
				{ cwd: "." },
			);

			expect(result.isError).toBeUndefined();
			expect(String(result.content[0].text)).toContain(
				"Valid ast-grep pattern",
			);
			expect(result.details).toMatchObject({
				valid: true,
				validateOnly: true,
				mode: "pattern",
			});
			expect(validatePattern).toHaveBeenCalledWith(
				"console.log($MSG)",
				"typescript",
				expect.objectContaining({ strictness: "relaxed" }),
			);
			expect(search).not.toHaveBeenCalled();
			expect(searchWithRule).not.toHaveBeenCalled();
		});

		it("validates a raw rule without scanning requested paths", async () => {
			const validateRule = vi.fn().mockResolvedValue({ valid: true });
			const searchWithRule = vi.fn();
			const tool = createAstGrepSearchTool(
				makeClient({ validateRule, searchWithRule }),
			);
			const rule =
				"id: r\nlanguage: TypeScript\nrule:\n  kind: call_expression";

			const result = await tool.execute(
				"validate-rule",
				{ lang: "typescript", rule, validateOnly: true, paths: ["src"] },
				new AbortController().signal,
				null,
				{ cwd: "." },
			);

			expect(result.isError).toBeUndefined();
			expect(result.details).toMatchObject({ mode: "rule", valid: true });
			expect(validateRule).toHaveBeenCalledWith(rule);
			expect(searchWithRule).not.toHaveBeenCalled();
		});

		it("reports invalid validation results as tool errors", async () => {
			const validatePattern = vi
				.fn()
				.mockResolvedValue({ valid: false, error: "bad pattern" });
			const search = vi.fn();
			const tool = createAstGrepSearchTool(
				makeClient({ validatePattern, search }),
			);

			const result = await tool.execute(
				"validate-bad",
				{
					pattern: "console.log($MSG)",
					lang: "typescript",
					validateOnly: true,
				},
				new AbortController().signal,
				null,
				{ cwd: "." },
			);

			expect(result.isError).toBe(true);
			expect(String(result.content[0].text)).toContain("bad pattern");
			expect(result.details).toMatchObject({
				valid: false,
				validateOnly: true,
			});
			expect(search).not.toHaveBeenCalled();
		});
	});

	describe("rule parameter (Phase 4 YAML passthrough)", () => {
		it("routes to searchWithRule when rule is provided", async () => {
			const searchWithRule = vi
				.fn()
				.mockResolvedValue({ matches: [], totalMatches: 0 });
			const search = vi.fn();
			const tool = createAstGrepSearchTool(
				makeClient({ searchWithRule, search }),
			);
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
			const searchWithRule = vi
				.fn()
				.mockResolvedValue({ matches: [], totalMatches: 0 });
			const search = vi.fn();
			const tool = createAstGrepSearchTool(
				makeClient({ searchWithRule, search }),
			);
			await tool.execute(
				"r2",
				{
					pattern: "console.log($X)",
					lang: "typescript",
					rule: "id: r\nlanguage: TypeScript\nrule:\n  kind: call_expression",
				},
				new AbortController().signal,
				null,
				{ cwd: "." },
			);
			expect(searchWithRule).toHaveBeenCalledOnce();
			expect(search).not.toHaveBeenCalled();
		});

		it("allows rule-only invocation without a pattern", async () => {
			const searchWithRule = vi.fn().mockResolvedValue({
				matches: [],
				totalMatches: 0,
			});
			const tool = createAstGrepSearchTool(makeClient({ searchWithRule }));
			const result = await tool.execute(
				"rule-only",
				{
					lang: "typescript",
					rule: "id: r\nlanguage: TypeScript\nrule:\n  kind: call_expression",
				},
				new AbortController().signal,
				null,
				{ cwd: "." },
			);

			expect(result.isError).toBeUndefined();
			expect(searchWithRule).toHaveBeenCalledOnce();
		});

		it("rejects unsafe raw rules before invoking ast-grep", async () => {
			const searchWithRule = vi.fn();
			const tool = createAstGrepSearchTool(makeClient({ searchWithRule }));
			const nulRule = await tool.execute(
				"unsafe-rule-nul",
				{ lang: "typescript", rule: "id: r\0" },
				new AbortController().signal,
				null,
				{ cwd: "." },
			);
			const longRule = await tool.execute(
				"unsafe-rule-long",
				{ lang: "typescript", rule: "x".repeat(100_001) },
				new AbortController().signal,
				null,
				{ cwd: "." },
			);

			expect(nulRule.isError).toBe(true);
			expect(String(nulRule.content[0].text)).toContain("NUL");
			expect(longRule.isError).toBe(true);
			expect(String(longRule.content[0].text)).toContain("too long");
			expect(searchWithRule).not.toHaveBeenCalled();
		});

		it("skips the plain-text/YAML pattern guard when raw rule is provided", async () => {
			const searchWithRule = vi.fn().mockResolvedValue({
				matches: [],
				totalMatches: 0,
			});
			const tool = createAstGrepSearchTool(makeClient({ searchWithRule }));
			const result = await tool.execute(
				"guard-skip",
				{
					pattern: "kind: text",
					lang: "typescript",
					rule: "id: r\nlanguage: TypeScript\nrule:\n  kind: call_expression",
				},
				new AbortController().signal,
				null,
				{ cwd: "." },
			);

			expect(result.isError).toBeUndefined();
			expect(searchWithRule).toHaveBeenCalledOnce();
		});

		it("surfaces searchWithRule errors as isError result", async () => {
			const tool = createAstGrepSearchTool(
				makeClient({
					searchWithRule: vi.fn().mockResolvedValue({
						matches: [],
						totalMatches: 0,
						error: "invalid yaml",
					}),
				}),
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
			const text = String(result.content[0].text);
			expect(text).toContain("invalid yaml");
			expect(text).toContain("Hint:");
		});

		it("passes paths to searchWithRule", async () => {
			const searchWithRule = vi
				.fn()
				.mockResolvedValue({ matches: [], totalMatches: 0 });
			const tool = createAstGrepSearchTool(makeClient({ searchWithRule }));
			await tool.execute(
				"r4",
				{
					pattern: "foo($X)",
					lang: "typescript",
					rule: "id: r\nlanguage: TypeScript\nrule:\n  kind: call_expression",
					paths: ["src/"],
				},
				new AbortController().signal,
				null,
				{ cwd: "." },
			);
			expect(searchWithRule).toHaveBeenCalledWith(expect.any(String), ["src/"]);
		});

		it("returns read handles and no dump suggestion for YAML-rule matches", async () => {
			const searchWithRule = vi.fn().mockResolvedValue({
				matches: [
					{
						file: "src/rule.ts",
						range: {
							start: { line: 4, column: 0 },
							end: { line: 4, column: 8 },
						},
						text: "foo(x)",
					},
				],
				totalMatches: 1,
			});
			const tool = createAstGrepSearchTool(
				makeClient({ searchWithRule, formatMatches: () => "1 match" }),
			);
			const result = await tool.execute(
				"r5",
				{
					pattern: "foo($X)",
					lang: "typescript",
					rule: "id: r\nlanguage: TypeScript\nrule:\n  pattern: foo($X)",
				},
				new AbortController().signal,
				null,
				{ cwd: "." },
			);

			expect(result.details.matchLocations).toEqual([
				{
					file: "src/rule.ts",
					line: 5,
					endLine: 5,
					readSlice: { path: "src/rule.ts", offset: 2, limit: 7 },
				},
			]);
			expect(result.details.suggestedDump).toBeUndefined();
		});

		it("suggests ast_grep_dump for YAML-rule zero matches", async () => {
			const searchWithRule = vi.fn().mockResolvedValue({
				matches: [],
				totalMatches: 0,
			});
			const tool = createAstGrepSearchTool(makeClient({ searchWithRule }));
			const result = await tool.execute(
				"r6",
				{
					pattern: "foo($X)",
					lang: "typescript",
					rule: "id: r\nlanguage: TypeScript\nrule:\n  pattern: foo($X)",
				},
				new AbortController().signal,
				null,
				{ cwd: "." },
			);

			expect(result.details.matchLocations).toEqual([]);
			expect(result.details.suggestedDump).toMatchObject({
				tool: "ast_grep_dump",
				lang: "typescript",
			});
		});
	});

	it("runs ast-grep for valid AST patterns", async () => {
		const search = vi.fn().mockResolvedValue({
			matches: [{ file: "src/a.ts", line: 1, text: "function x() {}" }],
		});
		const tool = createAstGrepSearchTool(
			makeClient({ search, formatMatches: () => "1 match" }),
		);
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
		expect(result.details.suggestedDump).toBeUndefined();
	});

	it("returns read handles for matched locations", async () => {
		const search = vi.fn().mockResolvedValue({
			matches: [
				{
					file: "src/a.ts",
					range: {
						start: { line: 9, column: 2 },
						end: { line: 11, column: 3 },
					},
					text: "function x() {}",
				},
			],
		});
		const tool = createAstGrepSearchTool(
			makeClient({ search, formatMatches: () => "1 match" }),
		);
		const result = await tool.execute(
			"handles",
			{
				pattern: "function $NAME($$$ARGS) { $$$BODY }",
				lang: "typescript",
				context: 2,
			},
			new AbortController().signal,
			null,
			{ cwd: "." },
		);

		expect(result.details.matchLocations).toEqual([
			{
				file: "src/a.ts",
				line: 10,
				endLine: 12,
				readSlice: { path: "src/a.ts", offset: 8, limit: 7 },
			},
		]);
		expect(result.details.searchReads).toEqual([
			{ file: "src/a.ts", startLine: 10, endLine: 12 },
		]);
		expect(result.details.suggestedDump).toBeUndefined();
	});

	it("clamps and caps readSlice context", async () => {
		const search = vi.fn().mockResolvedValue({
			matches: [
				{
					file: "src/near-top.ts",
					range: {
						start: { line: 0, column: 0 },
						end: { line: 0, column: 5 },
					},
					text: "foo()",
				},
			],
		});
		const tool = createAstGrepSearchTool(makeClient({ search }));
		const result = await tool.execute(
			"context-cap",
			{ pattern: "foo()", lang: "typescript", context: 999 },
			new AbortController().signal,
			null,
			{ cwd: "." },
		);

		expect(result.details.matchLocations).toEqual([
			{
				file: "src/near-top.ts",
				line: 1,
				endLine: 1,
				readSlice: { path: "src/near-top.ts", offset: 1, limit: 21 },
			},
		]);
	});

	it("uses the default readSlice margin for invalid context values", async () => {
		const search = vi.fn().mockResolvedValue({
			matches: [
				{
					file: "src/default.ts",
					range: {
						start: { line: 9, column: 0 },
						end: { line: 9, column: 5 },
					},
					text: "foo()",
				},
			],
		});
		const tool = createAstGrepSearchTool(makeClient({ search }));
		const result = await tool.execute(
			"context-default",
			{
				pattern: "foo()",
				lang: "typescript",
				context: Number.POSITIVE_INFINITY,
			},
			new AbortController().signal,
			null,
			{ cwd: "." },
		);

		expect(result.details.matchLocations).toEqual([
			{
				file: "src/default.ts",
				line: 10,
				endLine: 10,
				readSlice: { path: "src/default.ts", offset: 7, limit: 7 },
			},
		]);
	});

	it("treats negative context as zero margin", async () => {
		const search = vi.fn().mockResolvedValue({
			matches: [
				{
					file: "src/no-margin.ts",
					range: {
						start: { line: 9, column: 0 },
						end: { line: 9, column: 5 },
					},
					text: "foo()",
				},
			],
		});
		const tool = createAstGrepSearchTool(makeClient({ search }));
		const result = await tool.execute(
			"context-negative",
			{ pattern: "foo()", lang: "typescript", context: -5 },
			new AbortController().signal,
			null,
			{ cwd: "." },
		);

		expect(result.details.matchLocations).toEqual([
			{
				file: "src/no-margin.ts",
				line: 10,
				endLine: 10,
				readSlice: { path: "src/no-margin.ts", offset: 10, limit: 1 },
			},
		]);
	});

	it("omits read handles when matches lack usable locations", async () => {
		const search = vi.fn().mockResolvedValue({
			matches: [
				{ file: "", text: "foo()" },
				{ file: "src/no-range.ts", text: "foo()" },
			],
		});
		const tool = createAstGrepSearchTool(makeClient({ search }));
		const result = await tool.execute(
			"bad-locations",
			{ pattern: "foo()", lang: "typescript" },
			new AbortController().signal,
			null,
			{ cwd: "." },
		);

		expect(result.details.matchLocations).toEqual([]);
		expect(result.details.searchReads).toEqual([]);
	});

	it("returns clear errors for missing or unsafe pattern/lang inputs", async () => {
		const search = vi.fn();
		const tool = createAstGrepSearchTool(makeClient({ search }));

		const missingPattern = await tool.execute(
			"missing-pattern",
			{ pattern: "", lang: "typescript" },
			new AbortController().signal,
			null,
			{ cwd: "." },
		);
		const missingLang = await tool.execute(
			"missing-lang",
			{ pattern: "foo()", lang: "" },
			new AbortController().signal,
			null,
			{ cwd: "." },
		);
		const nulPattern = await tool.execute(
			"nul-pattern",
			{ pattern: "foo()\0", lang: "typescript" },
			new AbortController().signal,
			null,
			{ cwd: "." },
		);
		const longPattern = await tool.execute(
			"long-pattern",
			{ pattern: "x".repeat(4_001), lang: "typescript" },
			new AbortController().signal,
			null,
			{ cwd: "." },
		);

		expect(missingPattern.isError).toBe(true);
		expect(String(missingPattern.content[0].text)).toContain(
			"pattern is required",
		);
		expect(missingLang.isError).toBe(true);
		expect(String(missingLang.content[0].text)).toContain("lang is required");
		expect(nulPattern.isError).toBe(true);
		expect(String(nulPattern.content[0].text)).toContain("NUL");
		expect(longPattern.isError).toBe(true);
		expect(String(longPattern.content[0].text)).toContain("too long");
		expect(search).not.toHaveBeenCalled();
	});

	it("returns a tool error when the search client throws", async () => {
		const tool = createAstGrepSearchTool(
			makeClient({ search: vi.fn().mockRejectedValue(new Error("boom")) }),
		);
		const result = await tool.execute(
			"throws",
			{ pattern: "foo()", lang: "typescript" },
			new AbortController().signal,
			null,
			{ cwd: "." },
		);

		expect(result.isError).toBe(true);
		expect(String(result.content[0].text)).toContain("boom");
	});

	it("returns a tool error when aborted before search", async () => {
		const search = vi.fn();
		const controller = new AbortController();
		controller.abort();
		const tool = createAstGrepSearchTool(makeClient({ search }));
		const result = await tool.execute(
			"aborted",
			{ pattern: "foo()", lang: "typescript" },
			controller.signal,
			null,
			{ cwd: "." },
		);

		expect(result.isError).toBe(true);
		expect(String(result.content[0].text)).toContain("aborted");
		expect(search).not.toHaveBeenCalled();
	});

	it("returns a tool error when aborted after availability check", async () => {
		const search = vi.fn();
		const controller = new AbortController();
		const tool = createAstGrepSearchTool(
			makeClient({
				search,
				ensureAvailable: vi.fn().mockImplementation(async () => {
					controller.abort();
					return true;
				}),
			}),
		);
		const result = await tool.execute(
			"aborted-after-availability",
			{ pattern: "foo()", lang: "typescript" },
			controller.signal,
			null,
			{ cwd: "." },
		);

		expect(result.isError).toBe(true);
		expect(String(result.content[0].text)).toContain("aborted");
		expect(search).not.toHaveBeenCalled();
	});

	it("suggests ast_grep_dump when no matches are found", async () => {
		const tool = createAstGrepSearchTool(makeClient());
		const result = await tool.execute(
			"no-match",
			{ pattern: "foo($X)", lang: "typescript" },
			new AbortController().signal,
			null,
			{ cwd: "." },
		);

		expect(String(result.content[0].text)).toContain("ast_grep_dump");
		expect(result.details.suggestedDump).toMatchObject({
			tool: "ast_grep_dump",
			lang: "typescript",
		});
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

	describe("maxMatches + groupByFile (refs #345)", () => {
		function matchAt(file: string, line: number, column = 0) {
			return {
				file,
				range: { start: { line, column }, end: { line, column: column + 3 } },
				text: "x",
				lines: "x",
			};
		}

		it("caps returned matches at maxMatches and pages by it", async () => {
			const matches = Array.from({ length: 5 }, (_, i) => matchAt("a.ts", i));
			const tool = createAstGrepSearchTool(
				makeClient({ search: vi.fn().mockResolvedValue({ matches }) }),
			);
			const result = await tool.execute(
				"m1",
				{ pattern: "foo($X)", lang: "typescript", maxMatches: 2 },
				new AbortController().signal,
				null,
				{ cwd: "." },
			);
			expect(result.details).toMatchObject({ matchCount: 2, hasMore: true });
			// pagination step follows maxMatches, not the default 50
			expect(String(result.content[0].text)).toContain("skip=2");
		});

		it("clamps maxMatches below 1 up to 1", async () => {
			const matches = Array.from({ length: 3 }, (_, i) => matchAt("a.ts", i));
			const tool = createAstGrepSearchTool(
				makeClient({ search: vi.fn().mockResolvedValue({ matches }) }),
			);
			const result = await tool.execute(
				"m2",
				{ pattern: "foo($X)", lang: "typescript", maxMatches: 0 },
				new AbortController().signal,
				null,
				{ cwd: "." },
			);
			expect(result.details).toMatchObject({ matchCount: 1, hasMore: true });
		});

		it("groupByFile renders one line per file with 1-based locations, not bodies", async () => {
			const matches = [
				matchAt("src/a.ts", 0, 4),
				matchAt("src/a.ts", 9, 2),
				matchAt("src/b.ts", 4, 0),
			];
			const formatMatches = vi.fn(() => "FULL-BODY-OUTPUT");
			const tool = createAstGrepSearchTool(
				makeClient({
					search: vi.fn().mockResolvedValue({ matches }),
					formatMatches,
				}),
			);
			const result = await tool.execute(
				"g1",
				{ pattern: "foo($X)", lang: "typescript", groupByFile: true },
				new AbortController().signal,
				null,
				{ cwd: "." },
			);
			const text = String(result.content[0].text);
			expect(text).toContain("2 files, 3 matches:");
			expect(text).toContain("src/a.ts (2): L1:5, L10:3");
			expect(text).toContain("src/b.ts (1): L5:1");
			expect(text).not.toContain("FULL-BODY-OUTPUT");
			expect(formatMatches).not.toHaveBeenCalled();
			expect(result.details).toMatchObject({ groupByFile: true });
		});

		it("reports groupByFile=false in details when not requested", async () => {
			const tool = createAstGrepSearchTool(
				makeClient({
					search: vi.fn().mockResolvedValue({ matches: [matchAt("a.ts", 0)] }),
					formatMatches: () => "body",
				}),
			);
			const result = await tool.execute(
				"g2",
				{ pattern: "foo($X)", lang: "typescript" },
				new AbortController().signal,
				null,
				{ cwd: "." },
			);
			expect(result.details).toMatchObject({ groupByFile: false });
		});
	});
});
