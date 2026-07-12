import { describe, expect, it, vi } from "vitest";
import { createAstGrepDumpTool } from "../../tools/ast-dump.js";

function makeClient(
	overrides: Partial<Parameters<typeof createAstGrepDumpTool>[0]> = {},
) {
	return {
		ensureAvailable: async () => true,
		dumpAst: vi.fn().mockResolvedValue({ output: 'program [1,1] - [1,2] "x"' }),
		...overrides,
	} as Parameters<typeof createAstGrepDumpTool>[0];
}

describe("ast_grep_dump tool", () => {
	it("registers ast_grep_dump as the tool name", () => {
		// #ast_dump-dedup: the compatibility-alias registration (formerly
		// createAstDumpTool / name "ast_dump") was dropped — it wrapped the same
		// underlying implementation as createAstGrepDumpTool, so keeping both was
		// redundant tool-list weight for zero functional benefit.
		expect(createAstGrepDumpTool(makeClient()).name).toBe("ast_grep_dump");
	});

	it("lang uses same enum shape as ast-grep tools", () => {
		const tool = createAstGrepDumpTool(makeClient());
		const langSchema = (
			tool.parameters as { properties: Record<string, unknown> }
		).properties.lang as { type?: string; enum?: string[] };
		expect(langSchema.type).toBe("string");
		expect(langSchema.enum).toContain("typescript");
		expect(langSchema.enum).toContain("python");
	});

	it("returns a clear error for empty source input", async () => {
		const dumpAst = vi.fn();
		const tool = createAstGrepDumpTool(makeClient({ dumpAst }));

		const result = await tool.execute(
			"empty",
			{ source: "   ", lang: "typescript" },
			new AbortController().signal,
			null,
		);

		expect(result.isError).toBe(true);
		expect(String(result.content[0]?.text)).toContain("source is required");
		expect(dumpAst).not.toHaveBeenCalled();
	});

	it("dumps named AST nodes by default", async () => {
		const dumpAst = vi.fn().mockResolvedValue({
			output: 'program [1,1] - [1,28] "function foo() { return 1; }"',
		});
		const tool = createAstGrepDumpTool(makeClient({ dumpAst }));

		const result = await tool.execute(
			"1",
			{ source: "function foo() { return 1; }", lang: '"typescript"' },
			new AbortController().signal,
			null,
		);

		expect(result.isError).toBeUndefined();
		expect(dumpAst).toHaveBeenCalledWith(
			"function foo() { return 1; }",
			"typescript",
			{ includeAnonymous: false },
		);
		expect(String(result.content[0]?.text)).toContain("program [1,1]");
	});

	it("passes includeAnonymous through for CST dumps", async () => {
		const dumpAst = vi
			.fn()
			.mockResolvedValue({ output: 'function [1,1] - [1,9] "function"' });
		const tool = createAstGrepDumpTool(makeClient({ dumpAst }));

		await tool.execute(
			"2",
			{
				source: "function foo() {}",
				lang: "typescript",
				includeAnonymous: true,
			},
			new AbortController().signal,
			null,
		);

		expect(dumpAst).toHaveBeenCalledWith("function foo() {}", "typescript", {
			includeAnonymous: true,
		});
	});

	it("returns CLI errors clearly", async () => {
		const tool = createAstGrepDumpTool(
			makeClient({
				dumpAst: vi.fn().mockResolvedValue({ error: "invalid language" }),
			}),
		);

		const result = await tool.execute(
			"3",
			{ source: "x", lang: "madeup" },
			new AbortController().signal,
			null,
		);

		expect(result.isError).toBe(true);
		expect(String(result.content[0]?.text)).toContain("invalid language");
	});

	it("returns a tool error when the dump client throws", async () => {
		const tool = createAstGrepDumpTool(
			makeClient({ dumpAst: vi.fn().mockRejectedValue(new Error("boom")) }),
		);

		const result = await tool.execute(
			"4",
			{ source: "x", lang: "typescript" },
			new AbortController().signal,
			null,
		);

		expect(result.isError).toBe(true);
		expect(String(result.content[0]?.text)).toContain("boom");
	});

	it("returns a tool error when aborted before dump", async () => {
		const dumpAst = vi.fn();
		const controller = new AbortController();
		controller.abort();
		const tool = createAstGrepDumpTool(makeClient({ dumpAst }));

		const result = await tool.execute(
			"5",
			{ source: "x", lang: "typescript" },
			controller.signal,
			null,
		);

		expect(result.isError).toBe(true);
		expect(String(result.content[0]?.text)).toContain("aborted");
		expect(dumpAst).not.toHaveBeenCalled();
	});

	it("returns a tool error when aborted after availability check", async () => {
		const dumpAst = vi.fn();
		const controller = new AbortController();
		const tool = createAstGrepDumpTool(
			makeClient({
				dumpAst,
				ensureAvailable: vi.fn().mockImplementation(async () => {
					controller.abort();
					return true;
				}),
			}),
		);

		const result = await tool.execute(
			"6",
			{ source: "x", lang: "typescript" },
			controller.signal,
			null,
		);

		expect(result.isError).toBe(true);
		expect(String(result.content[0]?.text)).toContain("aborted");
		expect(dumpAst).not.toHaveBeenCalled();
	});
});
