import { describe, expect, it, vi } from "vitest";
import {
	createAstDumpTool,
	createAstGrepDumpTool,
} from "../../tools/ast-dump.js";

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
	it("registers ast_grep_dump as the preferred name and ast_dump as an alias", () => {
		expect(createAstGrepDumpTool(makeClient()).name).toBe("ast_grep_dump");
		expect(createAstDumpTool(makeClient()).name).toBe("ast_dump");
	});

	it("lang uses same enum shape as ast-grep tools", () => {
		const tool = createAstDumpTool(makeClient());
		const langSchema = (
			tool.parameters as { properties: Record<string, unknown> }
		).properties.lang as { type?: string; enum?: string[] };
		expect(langSchema.type).toBe("string");
		expect(langSchema.enum).toContain("typescript");
		expect(langSchema.enum).toContain("python");
	});

	it("returns a clear error for empty source input", async () => {
		const dumpAst = vi.fn();
		const tool = createAstDumpTool(makeClient({ dumpAst }));

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

	it("returns a tool error when the dump client throws", async () => {
		const tool = createAstDumpTool(
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
		const tool = createAstDumpTool(makeClient({ dumpAst }));

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
		const tool = createAstDumpTool(
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
