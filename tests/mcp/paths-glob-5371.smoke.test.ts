// flake-shape: real-process-spawn — the MCP stdio transport and the real ast-grep CLI are the surface under test; a stubbed client cannot show the glob reaching the child.
/**
 * #5371 over the MCP wire: one glob meaning for `paths`.
 *
 * `pilens_ast_grep_search` took `paths: ["src/**\/*.ts"]` as a literal target,
 * so it answered "No matches found" for a pattern that hits both files in the
 * same tree, while `pilens_symbol_search` — whose parameter description claimed
 * "the same shape/semantics as pilens_ast_grep_search's `paths`" — expanded it.
 * The shared reader now expands a glob once, so both surfaces agree, and a glob
 * that matches nothing says so instead of answering a false clean.
 *
 * Requires `npm run build` first (resolves mcp/server.js next to its source).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestEnvironment } from "../clients/test-utils.js";
import { McpHarness } from "./harness.js";

function textOf(res: Record<string, unknown>): string {
	return (res.result as { content: { text: string }[] }).content[0].text;
}

describe("pilens_ast_grep_search and pilens_symbol_search expand a `paths` glob (#5371)", () => {
	let projectDir: string;
	let harness: McpHarness;
	let nextId = 537_100;

	beforeAll(async () => {
		const env = setupTestEnvironment("pi-lens-5371-mcp-");
		projectDir = env.tmpDir;
		for (const [relative, body] of [
			["src/a.ts", "export function hello() { return 1; }\n"],
			["src/sub/b.ts", "export function hello() { return 2; }\n"],
			["outside.ts", "export function hello() { return 3; }\n"],
		] as const) {
			const file = path.join(projectDir, relative);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, body);
		}
		harness = new McpHarness({ cwd: projectDir });
		await harness.request(1, "initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "paths-glob", version: "0" },
		});
		harness.notify("notifications/initialized");
	});

	afterAll(() => {
		harness?.dispose();
	});

	it("finds the matches a glob scopes on the ast-grep surface", async () => {
		const scoped = textOf(
			await harness.request(nextId++, "tools/call", {
				name: "pilens_ast_grep_search",
				arguments: {
					pattern: "function hello($$$ARGS) { $$$BODY }",
					lang: "typescript",
					paths: ["src/**/*.ts"],
					cwd: projectDir,
				},
			}),
		);
		expect(scoped).not.toContain("No matches found");
		expect(scoped).toContain(path.join("src", "a.ts"));
		expect(scoped).toContain(path.join("src", "sub", "b.ts"));
		// The glob scopes, it does not widen: the sibling outside the pattern is
		// still absent.
		expect(scoped).not.toContain("outside.ts");
	}, 60_000);

	it("refuses a glob that matches nothing with a glob-specific message", async () => {
		const res = await harness.request(nextId++, "tools/call", {
			name: "pilens_symbol_search",
			arguments: { query: "hello", paths: ["src/**/*.rs"], cwd: projectDir },
		});
		const answer = textOf(res);
		expect((res.result as { isError?: boolean }).isError, answer).toBe(true);
		expect(answer).toContain("no file matches");
		expect(answer).toContain("src/**/*.rs");
		expect(answer).not.toContain("path not found");
	}, 60_000);

	it("publishes the expanded-`paths` contract on both schemas", async () => {
		const listed = (await harness.request(nextId++, "tools/list", {})) as {
			result: {
				tools: Array<{
					name: string;
					inputSchema: {
						properties: Record<
							string,
							{ description?: string; items?: { description?: string } }
						>;
					};
				}>;
			};
		};
		for (const toolName of ["pilens_symbol_search", "pilens_ast_grep_search"]) {
			const tool = listed.result.tools.find((t) => t.name === toolName);
			const description = tool?.inputSchema.properties.paths?.description ?? "";
			expect(description, toolName).toMatch(/glob/i);
			expect(description, toolName).not.toContain(
				"same shape/semantics as pilens_ast_grep_search",
			);
		}
	}, 30_000);
});
