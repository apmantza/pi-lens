import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TOOL_REGISTRY } from "../../clients/tool-config.js";
import { McpHarness } from "../mcp/harness.js";
import { createPiMock } from "../support/pi-mock.js";

type ToolResult = { content?: { type: string; text?: string }[] };

function contractLines(text: string | undefined): string {
	return (text ?? "")
		.split("\n")
		.filter(
			(line) =>
				line.startsWith("result ") ||
				line.startsWith("diag severity=") ||
				line.startsWith("usage tokens="),
		)
		.join("\n")
		.replace(/result (?:ok|error)/, "result")
		.replace(/usage tokens=\d+ elapsed-ms=\d+/, "usage");
}

describe("result contract across registered tool surfaces", () => {
	let cwd: string;
	const originalCwd = process.cwd();
	let mcp: McpHarness;
	let pi: ReturnType<typeof createPiMock>;

	beforeAll(async () => {
		cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-result-contract-"));
		fs.writeFileSync(
			path.join(cwd, "fixture.ts"),
			"export const fixture = 1;\nfunction enclosing() { return fixture; }\n",
		);
		process.chdir(cwd);
		pi = createPiMock();
		const { default: extension } = await import("../../index.js");
		extension(pi.asExtensionAPI());
		mcp = new McpHarness({ cwd });
		await mcp.request(1, "initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "result-contract", version: "0" },
		});
	});

	afterAll(() => {
		mcp?.dispose();
		process.chdir(originalCwd);
		fs.rmSync(cwd, { recursive: true, force: true });
	});

	it("keeps every paired registry tool's real rendered text identical", async () => {
		const fixtures: Record<string, Record<string, unknown>> = {
			ast_grep_search: {},
			ast_grep_replace: {},
			lsp_navigation: {},
			lsp_diagnostics: {},
			lens_diagnostics: {},
			symbol_search: { query: "__missing_fixture_symbol__" },
			module_report: { path: path.join(cwd, "fixture.ts") },
			project_report: {},
			read_symbol: { path: path.join(cwd, "fixture.ts"), symbol: "fixture" },
			read_enclosing: { path: path.join(cwd, "fixture.ts"), line: 2 },
			effective_config: {},
		};

		for (const entry of TOOL_REGISTRY) {
			if (!entry.piName || !entry.mcpName) continue;
			const args = fixtures[entry.name] ?? {};
			const piTool = pi.getTool(entry.piName) as {
				execute?: (...args: unknown[]) => Promise<ToolResult>;
			};
			expect(
				piTool?.execute,
				`missing pi handler for ${entry.name}`,
			).toBeTypeOf("function");
			const piResult = await piTool.execute?.(
				"governance",
				args,
				new AbortController().signal,
				undefined,
				{ cwd },
			);
			const mcpResult = await mcp.request(
				100 + entry.name.length,
				"tools/call",
				{
					name: entry.mcpName,
					arguments: { ...args, ...(args.path ? { file: args.path } : {}) },
				},
			);
			const mcpText = (mcpResult.result as ToolResult).content?.[0]?.text;
			expect(contractLines(mcpText), `${entry.name}: MCP contract`).toBe(
				contractLines(piResult?.content?.[0]?.text),
			);
			expect(mcpText, `${entry.name}: MCP result`).toContain("result ");
			expect(mcpText, `${entry.name}: MCP usage`).toMatch(
				/usage tokens=\d+ elapsed-ms=\d+/,
			);
		}
	});
});
