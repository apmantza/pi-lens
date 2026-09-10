import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TOOL_REGISTRY } from "../../clients/tool-config.js";
import { McpHarness } from "../mcp/harness.js";
import { createPiMock } from "../support/pi-mock.js";

type ToolResult = {
	content?: { type: string; text?: string }[];
	isError?: boolean;
};

function stableRenderedText(
	toolName: string,
	text: string | undefined,
): string {
	if (toolName !== "project_report") return text ?? "";
	// Each host starts its own cold graph build. The timestamp is runtime metadata,
	// not rendered result content, so compare every other byte of the full text.
	return (text ?? "").replace(/("when":\s*")[^"]+(")/, "$1<build-time>$2");
}

const EXACT_PARITY_TOOLS = new Set([
	"ast_grep_search",
	"ast_grep_replace",
	"lsp_navigation",
	"lsp_diagnostics",
	"lens_diagnostics",
	"module_report",
]);

describe("result contract across registered tool surfaces", () => {
	let cwd: string;
	const originalCwd = process.cwd();
	let mcp: McpHarness;
	let pi: ReturnType<typeof createPiMock>;

	beforeAll(async () => {
		cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-result-contract-"));
		const fixtureRoot = path.resolve("tests/fixtures");
		fs.copyFileSync(
			path.join(fixtureRoot, "tool-smoke/ast-grep-baseline/bad.ts"),
			path.join(cwd, "bad.ts"),
		);
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
			ast_grep_search: {
				pattern: "$A.sort()",
				lang: "typescript",
				paths: ["bad.ts"],
			},
			ast_grep_replace: {
				pattern: "$A.sort()",
				rewrite: "$A.sort((a, b) => a - b)",
				lang: "typescript",
				paths: ["bad.ts"],
				apply: false,
			},
			lsp_navigation: { operation: "documentSymbol", path: "fixture.ts" },
			lsp_diagnostics: { path: "bad.ts" },
			lens_diagnostics: {
				mode: "full",
				paths: ["bad.ts"],
				refreshRunners: "none",
			},
			symbol_search: { query: "fixture", paths: ["fixture.ts"] },
			module_report: { path: "fixture.ts", view: "compact" },
			project_report: { view: "compact", limit: 1 },
			read_symbol: { path: path.join(cwd, "fixture.ts"), symbol: "enclosing" },
			read_enclosing: { path: path.join(cwd, "fixture.ts"), line: 2 },
			effective_config: { file: "fixture.ts" },
		};

		for (const entry of TOOL_REGISTRY) {
			if (!entry.piName || !entry.mcpName) continue;
			const args = fixtures[entry.name];
			expect(args, `${entry.name}: missing real fixture`).toBeDefined();
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
			const piText = piResult?.content?.[0]?.text;
			if (EXACT_PARITY_TOOLS.has(entry.name)) {
				expect(
					stableRenderedText(entry.name, mcpText),
					`${entry.name}: complete rendered text`,
				).toBe(stableRenderedText(entry.name, piText));
			}
			expect(mcpText, `${entry.name}: MCP result`).toContain("result ");
			expect(mcpText, `${entry.name}: MCP usage`).toMatch(
				/usage tokens=\d+ elapsed-ms=\d+/,
			);
			expect(piText, `${entry.name}: pi result`).toContain("result ");
			expect(piText, `${entry.name}: pi usage`).toMatch(
				/usage tokens=\d+ elapsed-ms=\d+/,
			);
		}
	});

	it("covers every pi-only registry tool through pi and proves MCP absence", async () => {
		const piOnlyFixtures: Record<string, Record<string, unknown>> = {
			ast_grep_outline: { paths: ["fixture.ts"], lang: "typescript" },
			ast_grep_dump: {
				source: "function fixture() { return 1; }",
				lang: "typescript",
			},
			lens_diagnostic_mark: {
				filePath: "bad.ts",
				line: 4,
				message: "a real fixture disposition",
				disposition: "defer",
			},
			pi_lens_activate_tools: { tools: ["ast_grep_outline"] },
		};
		const listed = (await mcp.request(2, "tools/list", {})).result as {
			tools?: { name?: string }[];
		};
		const mcpNames = new Set(listed.tools?.map((tool) => tool.name));
		for (const entry of TOOL_REGISTRY) {
			if (!entry.piName || entry.mcpName) continue;
			const args = piOnlyFixtures[entry.name];
			expect(
				args,
				`${entry.name}: untested pi-only registry row`,
			).toBeDefined();
			expect(
				mcpNames.has(`pilens_${entry.name}`),
				`${entry.name}: MCP side is absent`,
			).toBe(false);
			const piTool = pi.getTool(entry.piName) as {
				execute?: (...args: unknown[]) => Promise<ToolResult>;
			};
			expect(piTool?.execute, `${entry.name}: missing pi handler`).toBeTypeOf(
				"function",
			);
			const result = await piTool.execute?.(
				"governance",
				args,
				new AbortController().signal,
				undefined,
				{ cwd },
			);
			const text = result?.content?.[0]?.text;
			expect(text, `${entry.name}: pi rendering`).toMatch(
				/result (?:ok|error)\n(?:diag severity=.*\n)?usage tokens=\d+ elapsed-ms=\d+$/,
			);
		}
	});
});
