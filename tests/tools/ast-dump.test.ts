import { describe, expect, it, vi } from "vitest";
import { createAstDumpTool } from "../../tools/ast-dump.js";

function makeClient(
	overrides: Partial<Parameters<typeof createAstDumpTool>[0]> = {},
) {
	return {
		ensureAvailable: async () => true,
		dumpAst: vi.fn().mockResolvedValue({ output: 'program [1,1] - [1,2] "x"' }),
		...overrides,
	} as Parameters<typeof createAstDumpTool>[0];
}

describe("ast_dump tool", () => {
	it("lang uses same enum shape as ast-grep tools", () => {
		const tool = createAstDumpTool(makeClient());
		const langSchema = (
			tool.parameters as { properties: Record<string, unknown> }
		).properties.lang as { type?: string; enum?: string[] };
		expect(langSchema.type).toBe("string");
		expect(langSchema.enum).toContain("typescript");
		expect(langSchema.enum).toContain("python");
	});

	it("dumps named AST nodes by default", async () => {
		const dumpAst = vi.fn().mockResolvedValue({
			output: 'program [1,1] - [1,28] "function foo() { return 1; }"',
		});
		const tool = createAstDumpTool(makeClient({ dumpAst }));

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
		const tool = createAstDumpTool(makeClient({ dumpAst }));

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
		const tool = createAstDumpTool(
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
});
