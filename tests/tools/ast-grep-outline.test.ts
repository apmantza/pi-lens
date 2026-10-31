import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AstGrepClient,
	type AstGrepOutlineFile,
	type AstGrepOutlineItem,
} from "../../clients/ast-grep-client.js";
import { createAstGrepOutlineTool } from "../../tools/ast-grep-outline.js";
import {
	finalizeToolResultWithDelivery,
	RESULT_PAYLOAD_BUDGET_BYTES,
} from "../../tools/render-compact.js";

function makeClient(overrides: Partial<AstGrepClient> = {}): AstGrepClient {
	return {
		ensureAvailable: async () => true,
		outline: vi.fn().mockResolvedValue({ output: [] }),
		...overrides,
	} as unknown as AstGrepClient;
}

function item(
	symbolType: string,
	name: string,
	startLine: number,
	endLine: number,
	extra: Partial<AstGrepOutlineItem> = {},
): AstGrepOutlineItem {
	return {
		role: "item",
		symbolType,
		name,
		range: {
			start: { line: startLine, column: 0 },
			end: { line: endLine, column: 1 },
		},
		signature: "",
		astKind: "node",
		...extra,
	};
}

// 0-based CLI ranges: import on line 1, class Svc on lines 3-10, members inside.
const SAMPLE: AstGrepOutlineFile[] = [
	{
		path: "/proj/a.ts",
		language: "TypeScript",
		items: [
			item("module", "fs", 0, 0, { isImport: true }),
			item("class", "Svc", 2, 9, {
				signature: "class Svc<T>",
				isExported: true,
				members: [
					item("method", "foo", 3, 3, { role: "member", isPublic: true }),
					item("method", "bar", 4, 4, {
						role: "member",
						signature: "bar",
					}),
					item("method", "baz", 5, 8, {
						role: "member",
						signature: "baz(x: number): void",
					}),
				],
			}),
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
	return tool.execute("1", params as never, undefined, null, {
		cwd,
	}) as Promise<ToolOut>;
}

describe("ast_grep_outline tool", () => {
	it("registers as ast_grep_outline", () => {
		expect(createAstGrepOutlineTool(makeClient()).name).toBe(
			"ast_grep_outline",
		);
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

	it("renders a range-first text tree, not JSON (#5071)", async () => {
		const tool = createAstGrepOutlineTool(
			makeClient({ outline: vi.fn().mockResolvedValue({ output: SAMPLE }) }),
		);
		const res = await run(tool, { paths: ["a.ts"], view: "expanded" });
		const text = String(res.content[0].text);
		// Recurrence: the JSON envelope was 10-14x the tree (31% `read` handles,
		// 10% byteOffset, 7% astKind, empty signatures) and was cut in the middle
		// on directories. Pins the line shape: `start-end [import|export ]kind name
		// [ - signature]`, two spaces per nesting level, 1-based inclusive ranges.
		expect(() => JSON.parse(text)).toThrow();
		expect(text.split("\n")).toEqual([
			"/proj/a.ts",
			"1-1 import module fs",
			"3-10 export class Svc \u2014 class Svc<T>",
			"  4-4 method foo",
			"  5-5 method bar",
			"  6-9 method baz \u2014 baz(x: number): void",
		]);
		expect(res.details).toMatchObject({ files: 1, items: 2, syntaxOnly: true });
	});

	it("drops read handles and CLI-only fields from the text (#5071)", async () => {
		const tool = createAstGrepOutlineTool(
			makeClient({ outline: vi.fn().mockResolvedValue({ output: SAMPLE }) }),
		);
		const text = String((await run(tool, { paths: ["a.ts"] })).content[0].text);
		// Recurrence: `read{path,offset,limit}` objects and `astKind`/`byteOffset`
		// were 48% of the payload and carried nothing the range does not.
		for (const gone of ["offset", "limit", "astKind", "byteOffset", "node"]) {
			expect(text).not.toContain(gone);
		}
	});

	it("documents how to read a listed range (#5071)", () => {
		const { description } = createAstGrepOutlineTool(makeClient());
		// Recurrence: the removed `read` handles were how the model learned the
		// offset/limit derivation; the description now carries it (#512).
		expect(description).toContain("offset=start");
		expect(description).toContain("limit=end-start+1");
		expect(description).toContain(
			"does not satisfy read-before-edit; use read_symbol or read_enclosing for body coverage.",
		);
	});

	it("sorts files by path before the 50-file cap and says what was cut (#5071)", async () => {
		// 55 files in a non-path order, as the ast-grep walker yields them.
		const names = Array.from({ length: 55 }, (_, i) =>
			String(i).padStart(2, "0"),
		);
		const shuffled = [...names].sort(
			(a, b) => ((Number(a) * 37) % 55) - ((Number(b) * 37) % 55),
		);
		expect(shuffled).not.toEqual(names);
		const output = shuffled.map((n) => ({
			path: `/proj/f${n}.ts`,
			language: "TypeScript",
			items: [item("function", `fn${n}`, 0, 1)],
		}));
		const tool = createAstGrepOutlineTool(
			makeClient({ outline: vi.fn().mockResolvedValue({ output }) }),
		);
		const res = await run(tool, { paths: ["."] });
		const lines = String(res.content[0].text).split("\n");
		// Recurrence: three runs over `clients/` kept three different 50-file
		// sets, and `truncatedFiles` rode in `details` only.
		const headers = lines.filter((l) => l.startsWith("/proj/"));
		expect(headers).toEqual(names.slice(0, 50).map((n) => `/proj/f${n}.ts`));
		expect(lines.at(-1)).toBe("... 5 more files not shown (cap 50)");
		expect(res.details).toMatchObject({ files: 50, truncatedFiles: true });
	});

	it("says when a file's items were cut at the per-file cap (#5071)", async () => {
		const output: AstGrepOutlineFile[] = [
			{
				path: "/proj/big.ts",
				language: "TypeScript",
				items: Array.from({ length: 205 }, (_, i) =>
					item("function", `f${i}`, i, i),
				),
			},
		];
		const tool = createAstGrepOutlineTool(
			makeClient({ outline: vi.fn().mockResolvedValue({ output }) }),
		);
		const lines = String(
			(await run(tool, { paths: ["big.ts"] })).content[0].text,
		).split("\n");
		// Recurrence: `truncatedItems` was a JSON key; the tree states the cut as
		// a line the model reads.
		expect(lines).toHaveLength(1 + 200 + 1);
		expect(lines.at(-1)).toBe("... 5 more items not shown (cap 200)");
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

describe("ast_grep_outline over a directory, real ast-grep (#5071)", () => {
	let dir: string | undefined;
	afterEach(() => {
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	it("fits the delivery bound and names the files it dropped", async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-outline-5071-"));
		// 60 files x 4 exported functions: the pre-fix JSON for 50 of them is
		// about 90 KB. Real CLI required: the ordering and the byte ratio are
		// properties of its output, not of a hand-shaped input.
		for (let i = 0; i < 60; i++) {
			const body = Array.from(
				{ length: 4 },
				(_, j) =>
					`export function handler${i}x${j}(a: number, b: string): string {\n\treturn b + a;\n}\n`,
			).join("\n");
			fs.writeFileSync(
				path.join(dir, `file${String(i).padStart(2, "0")}.ts`),
				body,
			);
		}
		const client = new AstGrepClient();
		expect(await client.ensureAvailable()).toBe(true);
		const tool = createAstGrepOutlineTool(client);
		const res = await run(tool, { paths: [dir] }, dir);
		expect(res.isError).toBeUndefined();
		const text = String(res.content[0].text);
		// Recurrence: `outline clients/` was 183,604 B of JSON, delivered as
		// 39,824 B with the middle cut out and most files gone.
		expect(Buffer.byteLength(text)).toBeLessThan(RESULT_PAYLOAD_BUDGET_BYTES);
		const delivered = finalizeToolResultWithDelivery(res as never);
		expect(delivered.truncated).toBe(false);
		const headers = text.split("\n").filter((l) => l.startsWith(dir as string));
		expect(headers).toHaveLength(50);
		expect([...headers].sort()).toEqual(headers);
		expect(headers[0]).toBe(path.join(dir, "file00.ts"));
		expect(text.split("\n").at(-1)).toBe(
			"... 10 more files not shown (cap 50)",
		);
		expect(text).toContain("1-3 export function handler0x0");
	});
});
