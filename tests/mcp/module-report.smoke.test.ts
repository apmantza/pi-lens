// mutation-lane: exclude
/**
 * module_report / read_symbol MCP smoke (#245, #256).
 *
 * Drives the real stdio JSON-RPC transport against a tiny synthetic TS project so
 * the review-graph lookup is instant (targeting the whole repo would be heavier).
 * module_report is read-only — it never builds a graph and never calls an LSP
 * server (#256), so `semantic.source` is always "none" here. Live-LSP enrichment
 * is re-homed to #236 (LSP writes graph edges); its module lives on at
 * clients/module-report-lsp.ts.
 *
 * Requires `npm run build` first (resolves mcp/server.js next to its source).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpHarness } from "./harness.js";
import { createModuleReportTool } from "../../tools/module-report.js";

interface ModuleReportShape {
	available: boolean;
	semantic: { source: string; references: boolean; implementations: boolean };
	api: Array<{ name: string }>;
}

function textOf(res: Record<string, unknown>): string {
	return (res.result as { content: { text: string }[] }).content[0].text;
}

function parseReport(res: Record<string, unknown>): ModuleReportShape {
	const text = textOf(res);
	return JSON.parse(
		text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1),
	) as ModuleReportShape;
}

function makeTinyProject(prefix: string): string {
	const dir = mkdtempSync(path.join(tmpdir(), prefix));
	writeFileSync(
		path.join(dir, "tsconfig.json"),
		JSON.stringify({ compilerOptions: { strict: true } }, null, 2),
	);
	writeFileSync(
		path.join(dir, "a.ts"),
		[
			"export function foo(): number {",
			"  return 1;",
			"}",
			"",
			"export function useFoo(): number {",
			"  return foo() + foo();",
			"}",
			"",
		].join("\n"),
	);
	return dir;
}

describe("module_report + read_symbol over MCP (tiny project)", () => {
	let projectDir: string;
	let harness: McpHarness;

	beforeAll(async () => {
		projectDir = makeTinyProject("pi-lens-modreport-mcp-");
		harness = new McpHarness({ cwd: projectDir });
		const init = await harness.request(1, "initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "modreport-smoke", version: "0" },
		});
		expect((init.result as { protocolVersion: string }).protocolVersion).toBe(
			"2025-06-18",
		);
		harness.notify("notifications/initialized");
	});

	afterAll(() => {
		harness.dispose();
		try {
			rmSync(projectDir, {
				recursive: true,
				force: true,
				maxRetries: 5,
				retryDelay: 200,
			});
		} catch {
			// OS reclaims the temp dir eventually.
		}
	});

	it("answers pilens_module_report with a navigable report (read-only, source none)", async () => {
		const res = await harness.request(10, "tools/call", {
			name: "pilens_module_report",
			arguments: { file: path.join(projectDir, "a.ts"), view: "full-json" },
		});
		const report = parseReport(res);
		expect(report.available).toBe(true);
		expect(report.api.some((e) => e.name === "foo")).toBe(true);
		// Read path never calls LSP → always "none".
		expect(report.semantic.source).toBe("none");
	}, 30_000);

	it("MCP default text matches pi byte for byte (no JSON fence)", async () => {
		const res = await harness.request(15, "tools/call", {
			name: "pilens_module_report",
			arguments: { file: path.join(projectDir, "a.ts") },
		});
		const mcpText = textOf(res);
		expect(mcpText).not.toContain("```json");
		// The stdio harness appends a `result ok` + usage trailer to every tool
		// payload; strip it so the comparison is payload to payload.
		const trailerAt = mcpText.indexOf("\n\nresult ok");
		const mcpPayload = trailerAt >= 0 ? mcpText.slice(0, trailerAt) : mcpText;
		const tool = createModuleReportTool(() => projectDir);
		const result = await tool.execute(
			"mcp-parity",
			{ path: path.join(projectDir, "a.ts") },
			undefined,
			null,
			{ cwd: projectDir },
		);
		expect(result.isError).toBeFalsy();
		expect(String(result.content[0]?.text)).toBe(mcpPayload);
	}, 30_000);
	it("answers pilens_read_symbol with the verbatim body", async () => {
		const res = await harness.request(11, "tools/call", {
			name: "pilens_read_symbol",
			arguments: { file: path.join(projectDir, "a.ts"), symbol: "foo" },
		});
		expect((res.result as { isError?: boolean }).isError).toBeFalsy();
		const text = textOf(res);
		expect(text).toContain("export function foo");
		expect(text).toContain("return 1;");
	}, 30_000);

	it("embeds did-you-mean suggestions on a near-miss (#523)", async () => {
		const res = await harness.request(12, "tools/call", {
			name: "pilens_read_symbol",
			arguments: { file: path.join(projectDir, "a.ts"), symbol: "fooo" },
		});
		expect((res.result as { isError?: boolean }).isError).toBe(true);
		expect(textOf(res)).toContain("foo");
	}, 30_000);

	// #4949: the pi tool appended extraction warnings on a miss but the MCP twin
	// dropped them, so a recovered-parse miss read as absence over MCP.
	it("pilens_read_symbol miss on a syntax-error file carries the warning (#4949)", async () => {
		writeFileSync(
			path.join(projectDir, "bad.py"),
			"def good():\n    return 1\n\ndef broken(:\n    x = [1,\n\ndef after():\n    pass\n",
		);
		const miss = await harness.request(13, "tools/call", {
			name: "pilens_read_symbol",
			arguments: { file: path.join(projectDir, "bad.py"), symbol: "after" },
		});
		expect(textOf(miss)).toContain(
			"tree-sitter could not parse part of this file",
		);
		const hit = await harness.request(14, "tools/call", {
			name: "pilens_read_symbol",
			arguments: { file: path.join(projectDir, "bad.py"), symbol: "good" },
		});
		expect(textOf(hit)).not.toContain("could not parse part");
	}, 30_000);
});
