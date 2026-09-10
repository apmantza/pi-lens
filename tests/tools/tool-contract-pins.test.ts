import { afterAll, beforeAll, describe, expect, it } from "vitest";
import extension from "../../index.js";
import { McpHarness } from "../mcp/harness.js";
import { createPiMock } from "../support/pi-mock.js";

type ListedTool = {
	name: string;
	description?: string;
};

const READ_CONTRACT =
	"An outline shows shape, not bodies, and does not satisfy read-before-edit; `read_symbol` and `read_enclosing` return body text and record read coverage.";
const AST_OUTLINE_CONTRACT =
	"An outline shows structure, not a symbol body, and does not satisfy read-before-edit; use read_symbol or read_enclosing for body coverage.";
const MARK_CONTRACT =
	"Exact reported identity is required; suppress re-anchors against live diagnostics and writes an inline ignore comment, apply multiple suppressions bottom-up, and defer is session-only.";
const CONFIG_REDACTION = "no environment values";
const CONFIG_ARGS = "no command arguments beyond the binary";
const CONFIG_DENY =
	"tier-denied LSP decision cannot be lifted by a nearer config";
const COLD_CACHE =
	"On a cold cache, project_report and symbol_search return available: false with a retry hint and start a non-blocking background build; module_report degrades to outline-only with cache freshness explicit.";
const CACHE_ONLY = "Empty cache is not proof of clean";

function byName(tools: ListedTool[], name: string): string {
	const tool = tools.find((candidate) => candidate.name === name);
	expect(tool, `missing ${name}`).toBeDefined();
	return tool?.description ?? "";
}

describe("model-facing tool contract pins (#2808)", () => {
	let piTools: ListedTool[];
	let mcp: McpHarness;
	let mcpTools: ListedTool[];

	beforeAll(async () => {
		// Reuse the roster-budget registration seam: real extension wiring for pi
		// and the real stdio tools/list roster for MCP, not hand-built metadata.
		const pi = createPiMock();
		extension(pi.asExtensionAPI());
		piTools = [...pi.tools.values()] as ListedTool[];

		mcp = new McpHarness();
		const listed = await mcp.request(1, "tools/list");
		mcpTools = (listed.result as { tools: ListedTool[] }).tools ?? [];
	});

	afterAll(() => mcp?.dispose());

	it("pins the read-before-edit contract independently on each surface", () => {
		for (const tools of [piTools, mcpTools]) {
			for (const name of ["module_report", "read_symbol", "read_enclosing"]) {
				const mcpName = `pilens_${name}`;
				const actualName = tools === piTools ? name : mcpName;
				expect(byName(tools, actualName)).toContain(READ_CONTRACT);
			}
		}
	});

	it("pins the AST outline read guard on the pi registration", () => {
		// ast_grep_outline is registered by pi only; no MCP literal exposes it.
		expect(byName(piTools, "ast_grep_outline")).toContain(AST_OUTLINE_CONTRACT);
	});

	it("pins diagnostic marking on pi", () => {
		expect(byName(piTools, "lens_diagnostic_mark")).toContain(MARK_CONTRACT);
	});

	it("pins effective-config safety independently on each surface", () => {
		for (const [tools, name] of [
			[piTools, "effective_config"],
			[mcpTools, "pilens_effective_config"],
		] as const) {
			const description = byName(tools, name);
			expect(description).toContain(CONFIG_REDACTION);
			expect(description).toContain(CONFIG_ARGS);
			expect(description).toContain(CONFIG_DENY);
		}
	});

	it("pins cold-cache interpretation independently on each surface", () => {
		for (const [tools, prefix] of [
			[piTools, ""],
			[mcpTools, "pilens_"],
		] as const) {
			for (const name of ["project_report", "symbol_search", "module_report"]) {
				expect(byName(tools, `${prefix}${name}`)).toContain(COLD_CACHE);
			}
		}
	});

	it("pins the cache-only diagnostics contract independently on each surface", () => {
		expect(byName(piTools, "lens_diagnostics")).toContain(CACHE_ONLY);
		expect(byName(mcpTools, "pilens_diagnostics")).toContain(CACHE_ONLY);
	});
});
