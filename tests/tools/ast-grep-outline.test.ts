import { describe, expect, it, vi } from "vitest";
import type {
	AstGrepClient,
	AstGrepOutlineFile,
} from "../../clients/ast-grep-client.js";
import { createAstGrepOutlineTool } from "../../tools/ast-grep-outline.js";

function makeClient(overrides: Partial<AstGrepClient> = {}): AstGrepClient {
	return {
		ensureAvailable: async () => true,
		outline: vi.fn().mockResolvedValue({ output: [] }),
		...overrides,
	} as unknown as AstGrepClient;
}

const SAMPLE: AstGrepOutlineFile[] = [
	{
		path: "/proj/a.ts",
		language: "TypeScript",
		items: [
			{
				role: "item",
				symbolType: "class",
				name: "Svc",
				range: {
					start: { line: 0, column: 0 },
					end: { line: 3, column: 1 },
				},
				signature: "export class Svc {",
				astKind: "export_statement",
				isExported: true,
				members: [
					{
						role: "member",
						symbolType: "method",
						name: "foo",
						range: {
							start: { line: 1, column: 2 },
							end: { line: 1, column: 30 },
						},
						signature: "",
						astKind: "method_definition",
						isPublic: true,
					},
				],
			},
		],
	},
];

type ToolOut = {
	content: { type: "text"; text: string }[];
	isError?: boolean;
	details?: Record<string, unknown>;
};

function run(
	tool: ReturnType<typeof createAstGrepOutlineTool>,
	params: Record<string, unknown>,
	cwd = "/proj",
): Promise<ToolOut> {
	return tool.execute(
		"1",
		params as never,
		undefined,
		null,
		{ cwd },
	) as Promise<ToolOut>;
}

function parse(text: string) {
	return JSON.parse(text) as {
		outline: Array<{
			path: string;
			items: Array<{
				name: string;
				read: { path: string; offset: number; limit: number };
				members?: Array<{
					name: string;
					read: { offset: number; limit: number };
				}>;
			}>;
		}>;
	};
}

describe("ast_grep_outline tool", () => {
	it("registers as ast_grep_outline", () => {
		expect(createAstGrepOutlineTool(makeClient()).name).toBe("ast_grep_outline");
	});

	it("requires at least one path", async () => {
		const outline = vi.fn();
		const tool = createAstGrepOutlineTool(makeClient({ outline }));
		const res = await run(tool, { paths: [] });
		expect(res.isError).toBe(true);
		expect(outline).not.toHaveBeenCalled();
	});

	it("resolves relative paths against cwd and forwards options", async () => {
		const outline = vi.fn().mockResolvedValue({ output: [] });
		const tool = createAstGrepOutlineTool(makeClient({ outline }));
		await run(tool, {
				paths: ["src/a.ts"],
				lang: "typescript",
				items: "all",
				view: "expanded",
				type: ["class", "function"],
				match: "Svc",
				pubMembers: true,
				globs: ["*.ts"],
			});
		const [paths, options] = outline.mock.calls[0];
		// Resolved against cwd to an absolute path (drive-prefixed on Windows).
		expect(paths[0].replace(/\\/g, "/")).toMatch(/\/proj\/src\/a\.ts$/);
		expect(options).toMatchObject({
			lang: "typescript",
			items: "all",
			view: "expanded",
			types: ["class", "function"],
			match: "Svc",
			pubMembers: true,
			globs: ["*.ts"],
		});
	});

	it("attaches 1-based read handles to items and nested members", async () => {
		const tool = createAstGrepOutlineTool(
			makeClient({ outline: vi.fn().mockResolvedValue({ output: SAMPLE }) }),
		);
		const res = await run(tool, { paths: ["a.ts"] });
		const { outline } = parse(String(res.content[0].text));
		const cls = outline[0].items[0];
		// class spans lines 0..3 (0-based) → offset 1, limit 4 (1-based inclusive)
		expect(cls.read).toMatchObject({ offset: 1, limit: 4 });
		expect(cls.members?.[0].read).toMatchObject({ offset: 2, limit: 1 });
		expect(res.details).toMatchObject({ files: 1, items: 1, syntaxOnly: true });
	});

	it("surfaces client errors", async () => {
		const tool = createAstGrepOutlineTool(
			makeClient({
				outline: vi.fn().mockResolvedValue({ error: "invalid language" }),
			}),
		);
		const res = await run(tool, { paths: ["a.ts"] });
		expect(res.isError).toBe(true);
		expect(String(res.content[0].text)).toContain("invalid language");
	});

	it("reports unavailable ast-grep CLI", async () => {
		const outline = vi.fn();
		const tool = createAstGrepOutlineTool(
			makeClient({ ensureAvailable: async () => false, outline }),
		);
		const res = await run(tool, { paths: ["a.ts"] });
		expect(res.isError).toBe(true);
		expect(String(res.content[0].text)).toContain("ast-grep CLI not found");
		expect(outline).not.toHaveBeenCalled();
	});
});
