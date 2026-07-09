/**
 * MCP server stdio smoke test — spawns the in-place-compiled server and drives
 * the real newline-delimited JSON-RPC handshake (initialize → tools/list →
 * tools/call), asserting the transport works without needing an MCP client.
 *
 * Requires `npm run build` first (resolves mcp/server.js next to its source);
 * that is the project's standing build-before-vitest rule.
 */

import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpHarness, repoRoot } from "./harness.js";

// Spawns the MCP server as a real stdio subprocess; like analyze-cli, it can lose
// a CPU-starvation race in the full parallel suite (passes in isolation). retry: 2
// absorbs the transient spike (the established pattern for load-sensitive tests).
describe("pi-lens MCP server (stdio smoke)", { retry: 2 }, () => {
	let harness: McpHarness;

	beforeAll(() => {
		harness = new McpHarness();
	});

	afterAll(() => {
		harness.dispose();
	});

	it("completes the initialize handshake and mirrors the protocol version", async () => {
		const res = await harness.request(1, "initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "smoke-test", version: "0" },
		});
		const result = res.result as Record<string, unknown>;
		expect(result.protocolVersion).toBe("2025-06-18");
		expect((result.serverInfo as { name: string }).name).toBe("pi-lens-mcp");
		expect(result.capabilities).toHaveProperty("tools");
		harness.notify("notifications/initialized");
	}, 25_000);

	it("lists the pi-lens tools", async () => {
		const res = await harness.request(2, "tools/list");
		const tools = (
			res.result as { tools: { name: string; inputSchema: { type: string } }[] }
		).tools;
		const names = tools.map((t) => t.name);
		expect(names).toContain("pilens_analyze");
		expect(names).toContain("pilens_diagnostics");
		expect(names).toContain("pilens_latency");
		expect(names).toContain("pilens_rebuild");
		expect(names).toContain("pilens_project_scan");
		expect(names).toContain("pilens_health");
		expect(names).toContain("pilens_session_start");
		expect(names).toContain("pilens_turn_end");
		expect(names).toContain("pilens_ast_grep_search");
		expect(names).toContain("pilens_ast_grep_replace");
		expect(names).toContain("pilens_lsp_navigation");
		expect(names).toContain("pilens_lsp_diagnostics");
		expect(names).toContain("pilens_symbol_search");
		// pilens_impact was removed (#304) — its blast radius folded into
		// pilens_module_report's `blastRadius` option.
		expect(names).not.toContain("pilens_impact");
		expect(names).toContain("pilens_module_report");
		expect(names).toContain("pilens_read_symbol");
		// Each tool advertises an object input schema.
		for (const tool of tools) {
			expect(tool.inputSchema.type).toBe("object");
		}
		// pilens_diagnostics mirrors lens_diagnostics' typebox schema verbatim
		// (schemaWithCwd); `paths` (#461) must be present on the MCP side too, not
		// just the pi tool — this is the one guard that would catch schema drift
		// between the two if the mirror ever stopped being a direct passthrough.
		const diagnosticsTool = tools.find((t) => t.name === "pilens_diagnostics") as
			| { inputSchema: { properties?: Record<string, unknown> } }
			| undefined;
		expect(diagnosticsTool?.inputSchema.properties).toHaveProperty("paths");
	}, 25_000);

	it("answers tools/call pilens_health with LSP + dispatch state", async () => {
		const res = await harness.request(5, "tools/call", {
			name: "pilens_health",
			arguments: {},
		});
		const result = res.result as { content: { type: string; text: string }[] };
		expect(result.content[0].type).toBe("text");
		expect(result.content[0].text).toContain("LSP:");
	}, 25_000);

	it("answers tools/call pilens_diagnostics (lens_diagnostics, delta mode)", async () => {
		// Cache-only/instant — confirms the lens_diagnostics tool is wired through
		// the transport and returns a text content block.
		const res = await harness.request(6, "tools/call", {
			name: "pilens_diagnostics",
			arguments: { mode: "delta" },
		});
		const result = res.result as { content: { type: string; text: string }[] };
		expect(result.content[0].type).toBe("text");
		expect(typeof result.content[0].text).toBe("string");
	}, 25_000);

	it("answers tools/call pilens_analyze (warm) with a real dispatch result", async () => {
		// no-lsp keeps it fast (skips the cold LSP spawn) while still running the
		// real tree-sitter/ast-grep/oxlint pipeline on a clean repo file.
		const target = path.join(repoRoot, "clients", "mcp", "host-shim.ts");
		const res = await harness.request(7, "tools/call", {
			name: "pilens_analyze",
			arguments: { file: target, mode: "warm", flags: { "no-lsp": true } },
		});
		const result = res.result as {
			content: { type: string; text: string }[];
			isError?: boolean;
		};
		expect(result.isError).toBeFalsy();
		expect(result.content[0].text).toContain("[warm]");
		expect(result.content[0].text).toContain("host-shim.ts");
		// The structured JSON payload (fenced) carries the latency record.
		expect(result.content[0].text).toContain("\"latency\"");
	}, 60_000);

	// pilens_module_report + pilens_read_symbol execute against a tiny project in
	// module-report.smoke.test.ts — targeting the whole repo here cold-builds the
	// review graph and blocks the server. tools/list above asserts they're wired.

	it("answers tools/call pilens_ast_grep_search with content", async () => {
		const res = await harness.request(8, "tools/call", {
			name: "pilens_ast_grep_search",
			arguments: {
				pattern: "getLSPService()",
				lang: "ts",
				paths: [path.join(repoRoot, "clients", "mcp")],
			},
		});
		const result = res.result as { content: { type: string; text: string }[] };
		expect(result.content[0].type).toBe("text");
		expect(typeof result.content[0].text).toBe("string");
	}, 45_000);

	it("answers tools/call pilens_lsp_navigation (documentSymbol)", async () => {
		const res = await harness.request(9, "tools/call", {
			name: "pilens_lsp_navigation",
			arguments: {
				operation: "documentSymbol",
				filePath: path.join(repoRoot, "clients", "mcp", "host-shim.ts"),
			},
		});
		const result = res.result as { content: { type: string; text: string }[] };
		expect(result.content[0].type).toBe("text");
		expect(typeof result.content[0].text).toBe("string");
	}, 45_000);

	it("answers tools/call pilens_latency with a text content block", async () => {
		const res = await harness.request(3, "tools/call", {
			name: "pilens_latency",
			arguments: { limit: 3 },
		});
		const result = res.result as { content: { type: string; text: string }[] };
		expect(Array.isArray(result.content)).toBe(true);
		expect(result.content[0].type).toBe("text");
		expect(typeof result.content[0].text).toBe("string");
	}, 25_000);

	it("returns a JSON-RPC error for an unknown method", async () => {
		const res = await harness.request(4, "no/such/method");
		expect((res.error as { code: number }).code).toBe(-32601);
	}, 25_000);
});
